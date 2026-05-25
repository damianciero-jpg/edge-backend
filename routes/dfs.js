const express = require('express');
const router = express.Router();
const Anthropic = require('@anthropic-ai/sdk');
const { jsonrepair } = require('jsonrepair');
const { getUser, addCredits } = require('../lib/users');
const { verifySession } = require('../lib/auth');
const { ok, fail } = require('../lib/http');
const { OWNER_EMAILS } = require('../lib/owners');
const { hasRedisConfig, createRedis } = require('../lib/redis');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const memoryWeatherCache = new Map();
const WEATHER_TTL_SEC = 30 * 60;

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

// Single-pass JSON cleaner: strips // comments, trailing commas, and unescaped control
// chars inside strings — all string-aware so // in URLs isn't eaten.
function cleanJson(raw) {
  let out = '';
  let inStr = false;
  let esc = false;

  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];

    if (esc) { out += c; esc = false; continue; }

    if (inStr) {
      if (c === '\\') { out += c; esc = true; continue; }
      if (c === '"')  { out += c; inStr = false; continue; }
      // fix unescaped control chars
      if (c === '\n') { out += '\\n'; continue; }
      if (c === '\r') { out += '\\r'; continue; }
      if (c === '\t') { out += '\\t'; continue; }
      if (c.charCodeAt(0) < 0x20) continue;
      out += c;
      continue;
    }

    // outside string —————————————————————
    if (c === '"') { out += c; inStr = true; continue; }

    // // comments: skip to end of line
    if (c === '/' && raw[i + 1] === '/') {
      while (i < raw.length && raw[i] !== '\n') i++;
      continue;
    }

    // trailing commas: , <ws> [}|]]
    if (c === ',') {
      let j = i + 1;
      while (j < raw.length && '\t\n\r '.includes(raw[j])) j++;
      if (raw[j] === '}' || raw[j] === ']') continue;
    }

    out += c;
  }
  return out;
}

function parseJsonFromText(rawText) {
  const match = String(rawText || '').match(/\{[\s\S]*\}/);
  if (!match) throw new Error('AI returned no structured JSON.');
  const clean = cleanJson(match[0]);
  try {
    return JSON.parse(clean);
  } catch {
    return JSON.parse(jsonrepair(clean));
  }
}

function normalizeStatus(status) {
  const s = String(status || '').trim().toUpperCase();
  if (/\b(IL|INJURED LIST|IR)\b/.test(s)) return 'IL';
  if (/\b(OUT|DNP|SUSP|SUSPENDED|INACTIVE)\b/.test(s)) return 'OUT';
  if (/\b(Q|QUES|QUESTIONABLE|DOUBTFUL|D)\b/.test(s)) return 'Q';
  if (/\b(PROBABLE|AVAILABLE|ACTIVE|OK|HEALTHY|NONE)\b/.test(s)) return 'OK';
  return s || 'OK';
}

function requireDfsSession(req, res) {
  const session = verifySession(req.cookies && req.cookies.edge_session);
  if (!session || !session.email) {
    fail(res, 401, { error: 'Login required', data: { authRequired: true } });
    return null;
  }
  return session;
}

function compactPlayers(players, limit = 90) {
  return (Array.isArray(players) ? players : [])
    .filter(p => p && p.name)
    .slice(0, limit)
    .map(p => ({
      name: String(p.name || '').slice(0, 80),
      team: String(p.team || '').slice(0, 20),
      opponent: String(p.opponent || '').slice(0, 20),
      position: String(p.position || '').slice(0, 20),
      currentStatus: String(p.injuryStatus || '').slice(0, 40),
    }));
}

async function getWeatherCache(location) {
  const key = `edge:dfs:weather:${String(location || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  if (hasRedisConfig()) {
    const redis = createRedis();
    const cached = await redis.get(key);
    return { key, redis, cached };
  }
  const entry = memoryWeatherCache.get(key);
  if (entry && entry.expiresAt > Date.now()) return { key, redis: null, cached: entry.value };
  return { key, redis: null, cached: null };
}

async function setWeatherCache(key, redis, value) {
  if (redis) {
    await redis.set(key, value, { ex: WEATHER_TTL_SEC });
  } else {
    memoryWeatherCache.set(key, { value, expiresAt: Date.now() + WEATHER_TTL_SEC * 1000 });
  }
}

async function fetchEspnInjurySnapshot(sport) {
  const sportPath = sport === 'nfl' ? 'football/nfl' : sport === 'mlb' ? 'baseball/mlb' : 'basketball/nba';
  try {
    const url = `https://site.api.espn.com/apis/site/v2/sports/${sportPath}/scoreboard`;
    const res = await withTimeout(fetch(url), 5000, 'ESPN injury API');
    if (!res.ok) return [];
    const json = await res.json();
    const injuries = [];
    (json.events || []).forEach(event => {
      (event.competitions || []).forEach(comp => {
        (comp.competitors || []).forEach(team => {
          const teamName = team.team && (team.team.abbreviation || team.team.displayName);
          (team.injuries || []).forEach(injury => {
            const athlete = injury.athlete || {};
            injuries.push({
              name: athlete.displayName || athlete.fullName || athlete.name || '',
              team: teamName || '',
              status: injury.status || injury.type || '',
              detail: injury.detail || injury.description || '',
            });
          });
        });
      });
    });
    return injuries.filter(i => i.name).slice(0, 120);
  } catch {
    return [];
  }
}

const SPORT_CONFIG = {
  NBA: {
    usageMetric: 'usage_rate',
    touchMetric: 'possessions_used',
    lineupSpot: 'minutes_per_game',
    paceMetric: 'possessions_per_48',
    defenseMetrics: ['steals_per_game', 'blocks_per_game'],
    defenseThreshold: 1.0,
    impliedTotalThreshold: 115,
    closeGameSpread: 6,
    closeGameML: -250,
    blowoutML: -300,
    positionGroups: {
      big: ['C', 'PF', 'C/PF'],
      wing: ['SF', 'SG', 'SF/PF', 'SF/SG'],
      guard: ['PG', 'SG', 'PG/SG', 'SG/PG'],
    },
    minutesReallocation: 0.15,
    usageReallocation: 0.20,
    paceTier: 0.25,
    paceMultiplier: 1.05,
    impliedMultiplierStarter: 1.10,
    impliedMultiplierBench: 1.05,
    defenseMultiplier: 1.15,
    maxMultiplier: 1.15,
    correlationCap: 4,
    correlationBonus: 0.05,
    antiCorrelationPenalty: 0.10,
    boomRateThreshold: 0.40,
    safeFloorSigma: 1.0,
    ceilingMultiplier: 1.5,
    floorMultiplier: 1.0,
  },
  NFL: {
    usageMetric: 'target_share_pct',
    touchMetric: 'targets_plus_carries',
    lineupSpot: 'snaps_per_game',
    paceMetric: 'plays_per_game',
    defenseMetrics: ['sacks_per_game', 'interceptions_per_game'],
    defenseThreshold: 0.5,
    impliedTotalThreshold: 48,
    closeGameSpread: 4,
    closeGameML: -175,
    blowoutML: -400,
    positionGroups: {
      big: ['RB', 'FB'],
      wing: ['WR', 'TE', 'WR/TE'],
      guard: ['QB'],
    },
    minutesReallocation: 0.20,
    usageReallocation: 0.25,
    paceTier: 0.25,
    paceMultiplier: 1.08,
    impliedMultiplierStarter: 1.12,
    impliedMultiplierBench: 1.05,
    defenseMultiplier: 1.10,
    maxMultiplier: 1.30,
    correlationCap: 4,
    correlationBonus: 0.06,
    antiCorrelationPenalty: 0.12,
    boomRateThreshold: 0.35,
    safeFloorSigma: 1.2,
    ceilingMultiplier: 1.5,
    floorMultiplier: 1.0,
  },
  MLB: {
    usageMetric: 'woba',
    touchMetric: 'plate_appearances_per_game',
    lineupSpot: 'batting_order_position',
    paceMetric: 'runs_per_inning',
    batterVsPitcherEraThreshold: 4.50,
    batterVsPitcherMultiplier: 1.15,
    highGameTotalThreshold: 9,
    highGameTotalMultiplier: 1.12,
    impliedTotalThreshold: 9,
    closeGameSpread: 1.5,
    closeGameML: -135,
    blowoutML: -250,
    positionGroups: {
      big: ['1B', '3B', 'C'],
      wing: ['OF', 'LF', 'CF', 'RF'],
      guard: ['SS', '2B', 'SP', 'P'],
    },
    minutesReallocation: 0.10,
    usageReallocation: 0.15,
    paceTier: 0.25,
    paceMultiplier: 1.08,
    impliedMultiplierStarter: 1.12,
    impliedMultiplierBench: 1.04,
    maxMultiplier: 1.15,
    correlationCap: 5,
    correlationBonus: 0.07,
    antiCorrelationPenalty: 0.08,
    boomRateThreshold: 0.38,
    safeFloorSigma: 1.0,
    ceilingMultiplier: 1.5,
    floorMultiplier: 1.0,
  },
};

const SALARY_CAPS = {
  draftkings: { nba: 50000, nfl: 50000, mlb: 50000 },
  fanduel:    { nba: 60000, nfl: 60000, mlb: 35000 },
};

const LINEUP_SLOTS = {
  nba: {
    draftkings: ['CPT', 'FLEX', 'FLEX', 'FLEX', 'FLEX', 'FLEX'],
    fanduel:    ['MVP', 'STAR', 'STAR', 'PRO', 'PRO', 'UTIL'],
  },
  nfl: {
    draftkings: ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'DST'],
    fanduel:    ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'K'],
  },
  mlb: {
    draftkings: ['P', 'P', 'C', '1B', '2B', '3B', 'SS', 'OF', 'OF', 'OF'],
    fanduel:    ['P', 'C/1B', '2B', '3B', 'SS', 'OF', 'OF', 'OF', 'UTIL'],
  },
};

function mlToProb(ml) {
  if (!ml) return 0.5;
  return ml < 0 ? Math.abs(ml) / (Math.abs(ml) + 100) : 100 / (ml + 100);
}
function calcImplied(total, hml, aml) {
  const hp = mlToProb(hml), ap = mlToProb(aml), s = (hp + ap) || 1;
  return { home: +(total * hp / s).toFixed(1), away: +(total * ap / s).toFixed(1) };
}
function detectGameScript(hml, aml, closeML = -250, bloutML = -300) {
  if (!hml || !aml) return 'unknown';
  const favML = Math.min(hml, aml);
  if (favML <= bloutML) return 'blowout';
  if (favML >= closeML) return 'close';
  return 'neutral';
}

async function fetchOddsData(apiKey, sport) {
  if (!apiKey) return [];
  const sportKey = sport === 'nfl' ? 'americanfootball_nfl'
                 : sport === 'mlb' ? 'baseball_mlb'
                 : 'basketball_nba';
  const cfg = SPORT_CONFIG[sport.toUpperCase()] || SPORT_CONFIG.NBA;
  try {
    const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds/?apiKey=${apiKey}&regions=us&markets=totals,h2h&oddsFormat=american`;
    const res = await withTimeout(fetch(url), 5000, `${sport} odds`);
    if (!res.ok) return [];
    const games = await res.json();
    if (!Array.isArray(games)) return [];
    return games.map(g => {
      const bk = (g.bookmakers || [])[0];
      if (!bk) return null;
      const mktT = (bk.markets || []).find(m => m.key === 'totals');
      const mktH = (bk.markets || []).find(m => m.key === 'h2h');
      const over  = mktT && (mktT.outcomes || []).find(o => o.name === 'Over');
      const homeO = mktH && (mktH.outcomes || []).find(o => o.name === g.home_team);
      const awayO = mktH && (mktH.outcomes || []).find(o => o.name === g.away_team);
      const total = over ? over.point : null;
      const hml = homeO ? homeO.price : null;
      const aml = awayO ? awayO.price : null;
      const imp = total ? calcImplied(total, hml, aml) : {};
      return {
        homeTeam: g.home_team, awayTeam: g.away_team,
        total, homeML: hml, awayML: aml,
        homeImplied: imp.home, awayImplied: imp.away,
        gameScript: detectGameScript(hml, aml, cfg.closeGameML, cfg.blowoutML),
        commenceTime: g.commence_time,
      };
    }).filter(g => g && g.total != null);
  } catch { return []; }
}

function buildPrompt({ sport, platform, contestType, salaryCap, slots, liveData, injuryFilter, excludeIlPlayers, lockedPlayers, excludedPlayers }) {
  const today = new Date().toISOString().slice(0, 10);
  const isGpp = contestType === 'gpp';
  const isNba = sport === 'nba';
  const isNfl = sport === 'nfl';
  const isMlb = sport === 'mlb';
  const platformName = platform === 'draftkings' ? 'DraftKings' : 'FanDuel';
  const mvpSlot = slots[0];
  const cfg = SPORT_CONFIG[sport.toUpperCase()] || SPORT_CONFIG.NBA;

  const spreadUnit = isMlb ? 'run' : 'pt';
  const gamesCtx = liveData.length
    ? `TODAY'S ${sport.toUpperCase()} SLATE (${today}):\n` +
      liveData.map(g => {
        const mlStr = (g.homeML && g.awayML)
          ? ` | ML: ${g.awayTeam.split(' ').pop()} ${g.awayML > 0 ? '+' : ''}${g.awayML} / ${g.homeTeam.split(' ').pop()} ${g.homeML > 0 ? '+' : ''}${g.homeML}`
          : '';
        const impStr = (g.homeImplied != null)
          ? ` | Implied: ${g.awayTeam.split(' ').pop()} ${g.awayImplied} / ${g.homeTeam.split(' ').pop()} ${g.homeImplied}`
          : '';
        const scriptStr = g.gameScript === 'blowout' ? ' | BLOWOUT RISK'
          : g.gameScript === 'close' ? ` | CLOSE GAME (<${cfg.closeGameSpread}${spreadUnit} spread)`
          : '';
        return `- ${g.awayTeam} @ ${g.homeTeam}${g.total ? ` | O/U: ${g.total}` : ''}${mlStr}${impStr}${scriptStr}`;
      }).join('\n')
    : `No live slate data available. Use your knowledge of today's ${sport.toUpperCase()} schedule (${today}).`;

  const injuryInstruction = injuryFilter === 'q_and_out'
    ? 'EXCLUDE all players listed OUT or Questionable (Q).'
    : injuryFilter === 'all'
    ? 'Include all players regardless of injury status. Flag all injuries in injuryStatus.'
    : 'EXCLUDE players listed OUT only. Include Q players — confirmed active Q players offer GPP leverage.';
  const ilInstruction = excludeIlPlayers
    ? 'EXCLUDE every player tagged IL or Injured List, even if otherwise lock-worthy.'
    : 'If a player is tagged IL or Injured List, only include them if explicitly locked or if no healthy alternative exists, and flag injuryStatus="IL".';

  const qHandling = injuryFilter !== 'q_and_out'
    ? `QUESTIONABLE PLAYER HANDLING — CONTRARIAN CONFIRMED ACTIVE BIAS (GPP Fix #4):
- Do NOT auto-exclude Q players. Search ESPN/team reporters for confirmation status within 2 hours of lock.
- CONFIRMED ACTIVE Q within 2 hours: apply +35% GPP value boost (mass market ownership suppressed = tournament leverage). Set confirmedActive=true, isContrarian=true, injuryNote="CONFIRMED ACTIVE — PRIME GPP PLAY". Add to confirmedActivePlayers.
- Confirmed active Q + high STL/BLK ceiling + projected own <20% = primeMvp=true.
- Unknown/unconfirmed Q: include if high upside, confirmedActive=false, flag with injuryStatus="Q".`
    : 'All Q and OUT players excluded.';

  const lockExclude = [
    lockedPlayers.length ? `LOCKED (must include): ${lockedPlayers.join(', ')}` : '',
    excludedPlayers.length ? `EXCLUDED (must not include): ${excludedPlayers.join(', ')}` : '',
  ].filter(Boolean).join('\n');

  // ── PROJECTION FACTOR CHAIN ─────────────────────────────────────────────
  const minSame = cfg.minutesReallocation.toFixed(2);
  const minAdj  = (cfg.minutesReallocation * 0.6).toFixed(2);
  const minDist = (cfg.minutesReallocation * 0.2).toFixed(2);
  const usgSame = cfg.usageReallocation.toFixed(2);
  const usgAdj  = (cfg.usageReallocation * 0.6).toFixed(2);
  const usgDist = (cfg.usageReallocation * 0.2).toFixed(2);
  const boomPct = Math.round(cfg.boomRateThreshold * 100);
  const corrBonusPct  = Math.round(cfg.correlationBonus * 100);
  const antiCorrPct   = Math.round(cfg.antiCorrelationPenalty * 100);
  const defenseBoostBlock = isMlb
    ? `  MLB GAME ENVIRONMENT:
    Batter vs pitcher advantage: if a batter faces a pitcher with ERA > ${cfg.batterVsPitcherEraThreshold.toFixed(2)}, boost that batter's ceilingFppg × ${cfg.batterVsPitcherMultiplier.toFixed(2)}.
    Game total importance: if Vegas game total is over ${cfg.highGameTotalThreshold} runs, boost all batters in that game × ${cfg.highGameTotalMultiplier.toFixed(2)}.
    Keep pitcher scoring unchanged; use FPPG/projection as-is for pitchers.`
    : `  STACKED CONDITION — Vegas × Close Game (tightest edge):
    If impliedTeamTotal >= ${cfg.impliedTotalThreshold} AND gameScript="close" (spread < ${cfg.closeGameSpread} ${spreadUnit}s):
      Apply ${cfg.defenseMultiplier.toFixed(2)}× SPECIFICALLY to defensive specialists (≥${cfg.defenseThreshold} ${cfg.defenseMetrics[0].replace(/_/g, '/')} OR ≥${cfg.defenseThreshold} ${cfg.defenseMetrics[1].replace(/_/g, '/')}) in that game.`;

  const closeGameBoostBlock = isMlb
    ? `  CLOSE GAME (gameScript="close", spread < ${cfg.closeGameSpread} ${spreadUnit}s):
    No defense-metric boost for MLB. Use game total, opposing pitcher ERA, ballpark, weather, and batting order for batter upside.`
    : `  CLOSE GAME (gameScript="close", spread < ${cfg.closeGameSpread} ${spreadUnit}s):
    Defensive specialists — any player averaging ≥${cfg.defenseThreshold} ${cfg.defenseMetrics[0].replace(/_/g, '/')} OR ≥${cfg.defenseThreshold} ${cfg.defenseMetrics[1].replace(/_/g, '/')}:
      ceilingFppg × 1.30  (full crunch-time volume, high-value stat accumulation)
    Other players: no adjustment`;

  const factorChain = `
PROJECTION FACTOR CHAIN — apply these steps in exact order:

STEP 1 — FPPM BASELINE (Advanced Layer 1):
  Search each player's L10 game log (minutes/snaps played + fantasy points each game).
  fppm = sum(FP over L10 games) / sum(minutes over L10 games)
  Initial projectedFppg = fppm × projectedMinutes
  recentFormFppg = average FP over L10 games (store this value)

STEP 2 — VACATED MINUTES REALLOCATION (Advanced Layer 1 — position-weighted):
  Position groups for ${sport.toUpperCase()}: big=[${cfg.positionGroups.big.join(',')}], wing=[${cfg.positionGroups.wing.join(',')}], guard=[${cfg.positionGroups.guard.join(',')}]
  For each player confirmed OUT today, distribute their avg minutes to active teammates
  using POSITION OVERLAP weighting:
    Same group: receives OUT_player_avg_minutes × ${minSame}
    Adjacent group: receives OUT_player_avg_minutes × ${minAdj}
    Distant group: receives OUT_player_avg_minutes × ${minDist}
  Apply same positional weight to usage redistribution (usage is more elastic):
    Same group:    OUT_player_avg_usage × ${usgSame}
    Adjacent:      OUT_player_avg_usage × ${usgAdj}
    Distant:       OUT_player_avg_usage × ${usgDist}
  Update: projectedMinutes += minutesReallocated, usageRate += usageReallocated
  Re-compute: projectedFppg = fppm × updated projectedMinutes

STEP 3 — STANDARD DEVIATION VARIANCE + BOOM RATE (Advanced Layer 2):
  Search each player's L15 game fantasy scores. Compute:
    mean_L15 = average of those 15 scores
    sigma = standard deviation of those 15 scores
  Apply by contest type:
    Cash game  → adjustedFloor   = mean_L15 - (${cfg.safeFloorSigma} × sigma) → use as floorFppg
    GPP        → adjustedCeiling = mean_L15 + (${cfg.ceilingMultiplier.toFixed(1)} × sigma) → use as ceilingFppg
  High sigma = volatile player. Low sigma = consistent floor player.
  BOOM RATE (GPP ceiling identifier):
    boomRate = (count of games in L15 where FP > mean_L15 + sigma) / 15 × 100
    boomRate > ${boomPct}%: isGppCeilingPlay=true — flag as "GPP CEILING PLAY"
    High sigma alone is not enough — boomRate confirms upside is repeatable, not random.

STEP 4 — RECENT FORM WEIGHT:
  trend: if recentFormFppg (L10) > season avg by 10%+ → "up"; if below season by 20%+ → "down"; else "neutral"
  Final projectedFppg = (recentFormFppg × 0.6) + (season_avg × 0.4)  [after FPPM and vacancy adjustments]

STEP 5 — PACE + VEGAS PACING MULTIPLIER (Advanced Layer 3):
  Search each team's pace rating. paceRating = avg of both teams.
    Fast pace (top-25% of league): paceImpact="fast", projectedFppg × ${cfg.paceMultiplier.toFixed(2)}
    Slow pace (bottom-25%):        paceImpact="slow", projectedFppg × ${(2 - cfg.paceMultiplier).toFixed(2)}
  VEGAS MULTIPLIER: if a team's impliedTeamTotal >= ${cfg.impliedTotalThreshold} OR pace is top-25%:
    Apply additional ${cfg.impliedMultiplierStarter.toFixed(2)}× to ALL starters/key rotators from that team.
    vegasPaceMultiplied=true for those players.
${defenseBoostBlock}
  MULTIPLIER CAP: combined multipliers for any starter must not exceed ${cfg.maxMultiplier.toFixed(2)}× total.

STEP 6 — USAGE ADJUSTMENT:
  High usage (28%+ for skill positions): ceilingFppg × ${cfg.impliedMultiplierStarter.toFixed(2)}
  Low usage (<15%):                      ceilingFppg × 0.85

STEP 7 — GAME SCRIPT (moneyline/spread from slate above):
  BLOWOUT RISK (gameScript="blowout", favML ≤ ${cfg.blowoutML}):
    Stars: projectedFppg × 0.90 (early rest/garbage-time risk)
    Cheap role players: projectedFppg × 1.15 (garbage time upside)
${closeGameBoostBlock}
  Set gameScript field on every player from that game.

STEP 8 — INJURY/CONFIRMATION BOOST:
  Confirmed active Q (within 2 hours of lock): +35% to GPP value score. isContrarian=true.

STEP 9 — OWNERSHIP PROJECTION:
  Estimate ownershipPct based on salary, matchup quality, news, salary trend.

STEP 10 — CORRELATION SCORING + ANTI-CORRELATION PENALTY (Advanced Layer 4):
  SAME-GAME CORRELATION BONUS:
    Count players in the lineup from each individual game.
    If 3 or more players come from the same game: apply +${corrBonusPct}% to totalCeilingPoints for the whole lineup.
    Hard cap: never exceed ${cfg.correlationCap} players from any single game (over-concentration risk).
    Set sameGameBonus=true in root JSON if the bonus was applied.
  ANTI-CORRELATION PENALTY:
    Identify players on the same team who compete for the same statistical pool.
    Apply -${antiCorrPct}% to ceilingFppg of the lower-projected player in each such pairing.
    Set antiCorrelationPenalty=true on that player.
    Set antiCorrelationWarning="[Team] [Pos] overlap: [Player A] vs [Player B] — downgraded [Player B] -${antiCorrPct}%"
  CORRELATION SCORE (0–100, show on full lineup):
    Start at 50. Adjust:
      +${corrBonusPct} per same-game player pair (max +${corrBonusPct * 4} for ${cfg.correlationCap}-player game stack)
      +10 if run-back player is in lineup
      +10 if all players are from different teams (diversified)
      -${antiCorrPct} per anti-correlation pair detected
      -15 if 5+ players from one team (overconcentrated)
    Report as integer correlationScore in root JSON.`;

  // ── NBA ALGORITHM ────────────────────────────────────────────────────────
  const nbaAlgo = `
NBA ${isGpp ? 'GPP TOURNAMENT' : 'CASH GAME'} ALGORITHM:
${factorChain}

${mvpSlot} SLOT — DEFENSIVE-UPSIDE MVP FORMULA:
  Do NOT rank MVP candidates by raw FPPG. Use this exact formula:
    MVP_Score = ((stealsPerGame × 4.5) + (blocksPerGame × 4.5)) × 1.5
  Sort all candidate players by MVP_Score descending. Select highest scorer for ${mvpSlot}.
  Rationale: DK scoring — BLK=2pts, STL=2pts. At 1.5× multiplier, defensive production dominates.
  stealsPerGame and blocksPerGame MUST appear on every player card.
  primeMvp=true for: confirmed active Q + highest MVP_Score + projected own <20%.

${isGpp ? `GPP RUN-BACK CONSTRAINT (Advanced Layer 4):
  After selecting the ${mvpSlot} player, identify their game. HARD RULE: include at least 1 player
  from the OPPOSING team in the same game as a run-back. This captures correlated scoring game scripts.
  Set runBackCandidate=true on that player. Report runBackGame and runBackPlayer in root JSON.` : ''}

SALARY ALLOCATION (KNAPSACK GUARDRAIL):
  Optimization goal is maximize TOTAL PROJECTED CEILING under the salary cap, not value per dollar.
  Fill every required roster slot.
  Never leave more than $500 unused salary if any legal lineup can spend it.
  If final salary is under 95% of the cap, regenerate with higher-salary players before returning JSON.
  Prefer mid-tier $5,000–$12,000 players over stacking $1,000–$3,000 value plays.
  Maximum 2 players with salary under $3,000 in any NBA lineup.
  VALUE OVERLOAD trigger: if the optimizer selects 3+ players under $3,000:
    → Discard the third (and any further) cheap asset
    → Reallocate that salary to 1-2 proven mid-tier producers ($5,000–$12,000 range)
    → Set salaryAlert="VALUE OVERLOAD — redistributed from min-salary overload to proven mid-tier producer(s)"
  If salary remains more than $500 below the cap after all legal upgrades, set salaryAlert="Salary not optimized — tap REGENERATE to fill remaining cap".

SALARY TRAJECTORY:
  Search current vs last week's ${platformName} salary for each player.
  Rising $500+: salaryTrajectory="rising", salaryTrajDelta=positive → HIGH OWNERSHIP (avoid in GPP).
  Falling $500+: salaryTrajectory="falling", salaryTrajDelta=negative → VALUE TARGET.
  Stable: salaryTrajectory="stable", salaryTrajDelta=0.

DOUBLE-DOUBLE UPSIDE:
  Centers/PFs averaging 8+ REB and 1+ BLK/game: estimate DD probability.
  Probability >40%: ddUpside=true (underpriced relative to ceiling).

OWNERSHIP:
  Flag >30% projected as CHALK. ${isGpp ? 'GPP: 1-2 contrarian plays (<20%). Avoid full chalk.' : 'Cash: maximize floor, ignore ownership.'}

STACKING (GPP): ${isGpp ? '2-3 players from team with highest implied total. PG + wing preferred.' : 'No stacking for cash.'}

MATCHUP: prioritize players facing teams ranked 25th-30th in defensive efficiency at their position.`;

  // ── NFL ALGORITHM ────────────────────────────────────────────────────────
  const nflAlgo = `
NFL ${isGpp ? 'GPP TOURNAMENT' : 'CASH GAME'} ALGORITHM:
${factorChain}

QB SELECTION — GAME ENVIRONMENT FIRST:
  Prioritize QBs in high-implied-total games (team implied ≥ ${cfg.impliedTotalThreshold} pts).
  Close game (spread < ${cfg.closeGameSpread} pts) = more passes throughout = QB/WR value elevated.
  BLOWOUT RISK: winning team QB loses volume late; trailing team QB gets inflated but risky garbage stats.
  stealsPerGame and blocksPerGame map to sacks_per_game and interceptions_per_game for NFL DST — populate those fields.
  primeMvp=true for: confirmed active Q + highest ceiling QB + projected own <20%.

QB-WR CORRELATION STACKING (core NFL GPP strategy):
  Always pair QB with at least 1 WR/TE from the same team — they share target volume.
  Optimal stack: QB + primary WR (target share > 25%) + high-usage TE or slot WR.
  ${isGpp ? `GPP RUN-BACK: After selecting QB, include at least 1 pass-catcher from the OPPOSING team.
  Set runBackCandidate=true on that player. Report runBackGame and runBackPlayer in root JSON.` : ''}

RB SELECTION — WORKHORSE ROLE:
  Solo RB (only RB on depth chart getting 15+ carries): snap count 60%+, red zone share.
  Committee RBs: require passing-game upside. Avoid thunder/lightning splits in GPP.
  Game script "blowout" favorite: lead-back RB +15% ceiling (clock-eating carries).
  Game script "close": pass-catching RBs +10% ceiling (check-downs, screens, third-down backs).

DST SELECTION:
  Oppose low-implied offenses (opposing team implied ≤ 18 pts for GPP, ≤ 21 for cash).
  Weather: wind ≥ 15 mph: +10% DST ceiling, -8% WR/QB ceiling. Set weatherAlert if wind ≥ 15 mph.
  High sack rate DST vs pass-heavy offense = prime GPP target.

SALARY ALLOCATION (KNAPSACK GUARDRAIL):
  Optimization goal is maximize TOTAL PROJECTED CEILING under the salary cap, not value per dollar.
  Fill every required roster slot. Never leave more than $500 unused salary if a legal upgrade exists.
  If final salary is under 95% of the cap, regenerate with higher-salary players before returning JSON.
  Maximum 2 players with salary under $3,500 in any lineup.
  VALUE OVERLOAD trigger at 3+ cheap assets — reallocate to $5,500–$7,500 mid-tier.
  Set salaryAlert="VALUE OVERLOAD" if triggered.
  If salary remains more than $500 below the cap after all legal upgrades, set salaryAlert="Salary not optimized — tap REGENERATE to fill remaining cap".

SALARY TRAJECTORY: Same approach — current vs last week's ${platformName} salary. Flag trajectory.

STACKING: ${isGpp ? `QB + 2 pass catchers from same team (game stack). Add 1 pass-catcher from opposing team (run-back).
  Avoid stacking QB with his own RB — negative correlation (rushing TDs steal passing TDs).` : 'Cash: floor-based plays. QB + top target. DST vs weak offense.'}

MATCHUP: prioritize players vs teams ranked 25th-30th in yards allowed at their position.`;

  // ── MLB ALGORITHM ────────────────────────────────────────────────────────
  const mlbAlgo = `
MLB ${isGpp ? 'GPP TOURNAMENT' : 'CASH GAME'} ALGORITHM:
${factorChain}

STARTING PITCHERS: Rank by K/9 (×2 weight) + ERA inverse + opposing OPS. CONFIRMED starts only.
  High O/U (>${cfg.impliedTotalThreshold + 0.5}): avoid that game's SP. Low O/U (<7.5): prioritize pitcher's duel SPs.
  Keep pitcher scoring unchanged when CSV/FPPG projections are provided.

BATTERS: Stack 3-4 consecutive batters from teams with implied total ≥ ${cfg.impliedTotalThreshold} or O/U >${cfg.impliedTotalThreshold}. Platoon advantage applies.
BATTER VS PITCHER ADVANTAGE: if opposing pitcher ERA > ${cfg.batterVsPitcherEraThreshold.toFixed(2)}, boost that batter's ceilingFppg × ${cfg.batterVsPitcherMultiplier.toFixed(2)}.
GAME TOTAL IMPORTANCE: if Vegas game total is over ${cfg.highGameTotalThreshold} runs, boost all batters in that game × ${cfg.highGameTotalMultiplier.toFixed(2)}. Do not apply this to pitchers.
BALLPARK: Coors Field +15% ceilingFppg; Petco/Oracle/Dodger -10% ceilingFppg.
WEATHER: Wind out to CF ≥10 mph = +8% ceilingFppg. Rain risk → weatherAlert.
SALARY/OWNERSHIP: Maximize total projected ceiling under the salary cap, fill every roster slot, and never leave more than $500 unused if a legal upgrade exists. If final salary is under 95% of the cap, regenerate with higher-salary players. Max 2 under $2,500, trajectory search, chalk avoidance. Set salaryAlert="Salary not optimized — tap REGENERATE to fill remaining cap" if more than $500 remains after legal upgrades.
STACKING: ${isGpp ? 'Team stacks with <25% individual ownership.' : 'Cash: elite floor plays, confirmed starts.'}`;

  const algoBlock = isNba ? nbaAlgo : isNfl ? nflAlgo : mlbAlgo;

  // ── JSON TEMPLATE ─────────────────────────────────────────────────────────
  const defaultPos = isNba ? (i => i < 2 ? 'PG' : 'SF')
                   : isNfl ? (i => i === 0 ? 'QB' : i < 3 ? 'RB' : i < 6 ? 'WR' : i === 6 ? 'TE' : i === 7 ? 'FLEX' : 'DST')
                   : (i => i < 2 ? 'SP' : '1B');
  const impliedExample = isNfl ? cfg.impliedTotalThreshold + 2 : cfg.impliedTotalThreshold + 3.5;
  const stackExample = isNba ? '"LAL 3-stack: LeBron, AD, Reaves (highest implied game)"'
                     : isNfl ? '"BUF 3-stack: Josh Allen + Diggs + Knox (highest implied total)"'
                     : '"LAD 4-stack: Freeman, Betts, Smith, Muncy"';
  const runBackExample = isNba ? `"e.g. LAL @ BOS — run-back from BOS in ${mvpSlot} game"`
                       : isNfl ? `"e.g. KC @ BUF — run-back WR from KC vs BUF QB stack"`
                       : `"e.g. LAL @ BOS — run-back from BOS in ${mvpSlot} game"`;

  const playerSlotTemplate = (slot, i) => {
    const pos = defaultPos(i);
    return `    {
      "slot": "${slot}", "name": "Real Player Name", "team": "TEAM", "opponent": "OPP",
      "position": "${pos}", "salary": ${Math.floor(salaryCap / slots.length)},
      "projectedFppg": 38.5, "ceilingFppg": ${(38.5 * cfg.ceilingMultiplier).toFixed(1)}, "floorFppg": ${(38.5 * 0.7).toFixed(1)},
      "fppm": 1.12,
      "sigma": 6.8, "adjustedFloor": 31.5, "adjustedCeiling": 52.7,
      "recentFormFppg": 41.2, "trend": "up", "trendPct": 7,
      "minutesReallocated": 0.0, "usageReallocated": 0.0,
      "paceRating": ${isNfl ? '68.5' : '101.5'}, "paceImpact": "fast", "vegasPaceMultiplied": false,
      "impliedTeamTotal": ${impliedExample}, "gameScript": "neutral",
      "usageRate": 29, "projectedMinutes": ${isNfl ? '60' : '36'},
      "salaryTrajectory": "stable", "salaryTrajDelta": 0,
      "boomRate": 46.7, "isGppCeilingPlay": false,
      "isContrarian": false, "ddUpside": false, "runBackCandidate": false,
      "antiCorrelationPenalty": false,
      "stealsPerGame": 1.2, "blocksPerGame": 0.5,
      "valueScore": 6.25, "ownershipPct": 18,
      "injuryStatus": null, "injuryNote": null,
      "confirmedActive": false, "primeMvp": ${i === 0 ? 'true' : 'false'},
      "notes": "brief reason: FPPM, sigma, boomRate, correlation, run-back logic"
    }${i < slots.length - 1 ? ',' : ''}`;
  };

  const jsonTemplate = `{
  "lineup": [
${slots.map((slot, i) => playerSlotTemplate(slot, i)).join('\n')}
  ],
  "totalProjectedPoints": 280.0, "totalCeilingPoints": 364.5, "totalFloorPoints": 198.0,
  "totalSalary": ${salaryCap - 400}, "salaryCap": ${salaryCap}, "remainingSalary": 400,
  "stackInfo": ${stackExample},
  "runBackGame": ${isGpp ? `"${runBackExample}"` : 'null'},
  "runBackPlayer": ${isGpp ? (isNba ? '"e.g. Jayson Tatum (BOS — run-back vs LAL MVP)"' : isNfl ? '"e.g. Travis Kelce (KC — run-back vs BUF stack)"' : 'null') : 'null'},
  "weatherAlert": null, "ownershipWarning": null, "salaryAlert": null,
  "correlationScore": 72,
  "sameGameBonus": false,
  "antiCorrelationWarning": null,
  "confirmedActivePlayers": [], "lateNewsItems": [],
  "summary": "2-3 sentence strategy: FPPM basis, sigma/boomRate profile, correlation score rationale, key risk"
}`;

  const searches = [
    `  1. Today's ${sport.toUpperCase()} injury report — ESPN, ${isNba ? 'NBA.com' : isNfl ? 'NFL.com' : 'MLB.com'}, beat reporters. Note all OUT and Q players.`,
    `  2. ${platformName} ${sport.toUpperCase()} salaries + L10 game logs (${isNfl ? 'snaps + fantasy points per game for FPPM' : 'minutes AND fantasy points per game for FPPM'})`,
    `  3. L15 fantasy scores per player (for sigma/standard deviation calculation)`,
    isNba ? `  4. Each team's pace rating (possessions/48min). Defensive efficiency by position (Basketball Reference).`
    : isNfl ? `  4. Each team's plays-per-game pace. Confirmed starters, snap count percentages, target shares.`
    : `  4. Confirmed SP starts + weather/wind/dome status for each game`,
    `  5. Current vs last week's ${platformName} salaries (for trajectory)`,
    `  6. Late-breaking news past 2 hours: scratches, confirmations, minute/snap restrictions`,
    isNba ? `  7. Usage rates, steal rates, block rates for all candidates (for MVP_Score and close-game boosts)`
    : isNfl ? `  7. Target share by WR/TE, red zone carry share by RB, DST sack rate and implied opposition offense total`
    : '',
  ].filter(Boolean);

  return [
    `You are an expert DFS lineup optimizer for ${platformName} ${sport.toUpperCase()} ${isGpp ? 'GPP tournaments' : 'cash games'}.`,
    `Today is ${today}. Salary cap: $${salaryCap.toLocaleString()}. Platform: ${platformName}.`,
    `Contest type: ${isGpp ? 'GPP TOURNAMENT (maximize ceiling, use sigma+1.5 ceiling, run-back correlation)' : 'CASH GAME (maximize floor, use mean-sigma floor, avoid variance)'}`,
    '', gamesCtx, '', algoBlock,
    'INJURY FILTER:', injuryInstruction, ilInstruction, '', qHandling, '', lockExclude || '',
    '', 'WEB SEARCHES — DO ALL BEFORE BUILDING LINEUP:', ...searches,
    '', `LINEUP SLOTS (${slots.length} players): ${slots.join(', ')}`,
    `HARD CONSTRAINT: Total salary ≤ $${salaryCap.toLocaleString()}.`,
    `HARD CONSTRAINT: Fill all ${slots.length} roster slots. Do not return a partial lineup.`,
    'HARD CONSTRAINT: Optimization goal is highest total projected ceiling under the salary cap, not best value per dollar.',
    'HARD CONSTRAINT: Never leave more than $500 unused salary if any legal lineup can spend it.',
    'HARD CONSTRAINT: If final salary is under 95% of cap, regenerate once with higher-salary players before returning JSON.',
    isNba ? 'HARD CONSTRAINT: NBA should prefer consistent mid-tier $5,000-$12,000 players over stacking $1,000-$3,000 punt plays.' : '',
    'HARD CONSTRAINT: If remainingSalary > 500, set salaryAlert="Salary not optimized — tap REGENERATE to fill remaining cap".',
    'HARD CONSTRAINT: Real player names only. Realistic salaries and FPPG for today.',
    isNfl ? 'HARD CONSTRAINT: Maximum 2 players under $3,500. VALUE OVERLOAD if exceeded — see algorithm.'
           : 'HARD CONSTRAINT: Maximum 2 players under $2,500. VALUE OVERLOAD if exceeded — see algorithm.',
    isGpp ? `HARD CONSTRAINT: ${isNba ? `${mvpSlot} game` : 'QB game'} must have a run-back player from opposing team in the lineup.` : '',
    'HARD CONSTRAINT: Populate lateNewsItems with any injury/lineup updates found.',
    excludeIlPlayers ? 'HARD CONSTRAINT: No IL/Injured List players in the lineup.' : '',
    isNfl ? 'HARD CONSTRAINT: stealsPerGame = sacks_per_game, blocksPerGame = interceptions_per_game for DST players. Required for all players.'
           : isMlb ? 'HARD CONSTRAINT: MLB has no stealsPerGame/blocksPerGame defense boost. Do not use BLK/STL or defenseMetrics for MLB scoring.'
           : 'HARD CONSTRAINT: stealsPerGame and blocksPerGame required for every player (used in MVP_Score).',
    'HARD CONSTRAINT: fppm, sigma, adjustedFloor, adjustedCeiling, boomRate required for every player.',
    `HARD CONSTRAINT: Never more than ${cfg.correlationCap} players from any single game (correlation cap).`,
    '', 'Return ONLY raw JSON. No markdown, no code fences, no // comments. Start with { end with }.',
    '', 'Required JSON format:', jsonTemplate,
  ].filter(l => l !== undefined && l !== '').join('\n');
}

router.post('/optimize', async (req, res) => {
  const session = verifySession(req.cookies && req.cookies.edge_session);
  if (!session || !session.email) {
    return fail(res, 401, { error: 'Login required', data: { authRequired: true } });
  }

  const {
    sport = 'nba',
    platform = 'draftkings',
    contestType = 'gpp',
    injuryFilter = 'out',
    excludeIlPlayers = false,
    lockedPlayers = [],
    excludedPlayers = [],
    salaryCap: customSalaryCap,
    rosterSize: customRosterSize,
    requireProbablePitcher = true,
    allowValuePunts = true,
    maxPuntPlayers = 1,
  } = req.body || {};

  if (!['nba', 'nfl', 'mlb'].includes(sport))       return fail(res, 400, { error: 'Invalid sport. Use nba, nfl, or mlb.' });
  if (!['draftkings', 'fanduel'].includes(platform)) return fail(res, 400, { error: 'Invalid platform.' });
  if (!['gpp', 'cash'].includes(contestType))        return fail(res, 400, { error: 'Invalid contestType. Use gpp or cash.' });
  if (!['all', 'out', 'q_and_out'].includes(injuryFilter)) return fail(res, 400, { error: 'Invalid injuryFilter.' });

  const userId = session.email;
  let user;
  try {
    user = await withTimeout(getUser(userId), 5000, 'user fetch');
  } catch {
    return fail(res, 503, { error: 'Storage unavailable' });
  }

  const isOwner = OWNER_EMAILS.includes(String(userId).toLowerCase());
  if (isOwner) user = { ...user, isSubscriber: true, credits: 9999 };

  if (!user.isSubscriber && user.credits <= 0) {
    return fail(res, 402, { error: 'No credits remaining', data: { paywall: true, upgrade: true } });
  }

  const defaultCap = SALARY_CAPS[platform] && SALARY_CAPS[platform][sport];
  const salaryCap = (customSalaryCap > 0) ? customSalaryCap : defaultCap;
  const defaultSlots = LINEUP_SLOTS[sport] && LINEUP_SLOTS[sport][platform];
  const slots = (customRosterSize > 0 && defaultSlots)
    ? (customRosterSize <= defaultSlots.length ? defaultSlots.slice(0, customRosterSize) : [...defaultSlots, ...Array(customRosterSize - defaultSlots.length).fill('UTIL')])
    : defaultSlots;

  const apiKey = process.env.THE_ODDS_API_KEY || process.env.ODDS_API_KEY || process.env.ODDS_KEY;
  let liveData = [];
  try {
    liveData = await fetchOddsData(apiKey, sport);
  } catch { liveData = []; }

  const prompt = buildPrompt({
    sport, platform, contestType, salaryCap, slots, liveData,
    injuryFilter,
    excludeIlPlayers: !!excludeIlPlayers,
    lockedPlayers: Array.isArray(lockedPlayers) ? lockedPlayers : [],
    excludedPlayers: Array.isArray(excludedPlayers) ? excludedPlayers : [],
  });

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8000,
      system: 'You are an expert DFS lineup optimizer. Always use web_search to get current injury reports, salaries, and player news before building a lineup. Return ONLY raw JSON. Start with { end with }. No markdown, no code fences, no comments.',
      messages: [{ role: 'user', content: prompt }],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    }, { timeout: 120000 });

    const rawText = (response.content || [])
      .filter(b => b.type === 'text' && b.text)
      .map(b => b.text)
      .join('\n')
      .trim();

    const match = rawText.match(/\{[\s\S]*\}/);
    if (!match) {
      const noGames = /no games|no slate|no matchups|off.season|not scheduled/i.test(rawText);
      throw new Error(noGames
        ? `No ${sport.toUpperCase()} games found for today's slate. Check back on a game day.`
        : 'Optimizer returned no structured lineup. Please try again.');
    }

    const clean = cleanJson(match[0]);

    let lineupData;
    try {
      lineupData = JSON.parse(clean);
    } catch {
      lineupData = JSON.parse(jsonrepair(clean));
    }

    if (!user.isSubscriber && !isOwner) {
      withTimeout(addCredits(userId, -1), 3000, 'credit deduct').catch(() => {});
    }

    return ok(res, {
      data: lineupData,
      debug: {
        salaryCapUsed: salaryCap,
        rosterSizeUsed: slots ? slots.length : null,
        platformUsed: platform,
        requireProbablePitcher,
        pitchersBeforeFilter: null,
        pitchersAfterFilter: null,
      },
    });
  } catch (err) {
    const status = err.status || err.statusCode;
    console.error('DFS optimize error:', err.message);
    if (status === 429) return fail(res, 429, { error: 'AI rate limit hit. Wait a moment and try again.' });
    if (status === 401 || status === 403) return fail(res, status, { error: 'AI API key issue.' });
    return fail(res, 500, { error: err.message || 'DFS optimization failed. Try again.' });
  }
});

router.post('/refresh-injuries', async (req, res) => {
  const session = requireDfsSession(req, res);
  if (!session) return;

  const { sport = 'nba', players = [] } = req.body || {};
  if (!['nba', 'nfl', 'mlb'].includes(sport)) return fail(res, 400, { error: 'Invalid sport.' });

  const playerList = compactPlayers(players);
  if (!playerList.length) return fail(res, 400, { error: 'No players provided.' });

  const today = new Date().toISOString().slice(0, 10);
  const espnSnapshot = await fetchEspnInjurySnapshot(sport);
  const prompt = `Refresh DFS injury statuses for this ${sport.toUpperCase()} uploaded CSV.
Today is ${today}.
Use the ESPN API snapshot below first, then use web_search to fill gaps. Prioritize ESPN injury data, official league/team reports, and recent beat-reporter updates.
Return ONLY raw JSON with this shape:
{
  "updatedAt": "ISO timestamp",
  "players": [
    { "name": "exact input name", "status": "OK|Q|OUT|IL", "note": "short source note", "source": "ESPN/team/reporter if known" }
  ],
  "lateNewsItems": ["short important updates"]
}
Rules:
- Include every input player exactly once by name.
- Normalize Injured List/IR to IL, Out/Inactive/Suspended to OUT, Questionable/Doubtful to Q, no injury to OK.
- If unsure, keep currentStatus or return OK with note "No current injury found".

Players:
${JSON.stringify(playerList)}

ESPN API injury snapshot:
${JSON.stringify(espnSnapshot)}`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 5000,
      system: 'You refresh DFS injury statuses. Always use web_search, prioritize ESPN and official sources, and return only raw JSON.',
      messages: [{ role: 'user', content: prompt }],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    }, { timeout: 90000 });

    const rawText = (response.content || [])
      .filter(b => b.type === 'text' && b.text)
      .map(b => b.text)
      .join('\n')
      .trim();
    const parsed = parseJsonFromText(rawText);
    const statuses = (Array.isArray(parsed.players) ? parsed.players : []).map(p => ({
      name: String(p.name || ''),
      status: normalizeStatus(p.status),
      note: String(p.note || ''),
      source: String(p.source || ''),
    })).filter(p => p.name);
    return ok(res, {
      data: {
        updatedAt: parsed.updatedAt || new Date().toISOString(),
        players: statuses,
        lateNewsItems: Array.isArray(parsed.lateNewsItems) ? parsed.lateNewsItems : [],
      },
    });
  } catch (err) {
    console.error('DFS injury refresh error:', err.message);
    return fail(res, 500, { error: err.message || 'Could not refresh injuries.' });
  }
});

router.post('/weather', async (req, res) => {
  try {
    const session = requireDfsSession(req, res);
    if (!session) return;

  const { sport = 'mlb', games = [] } = req.body || {};
  if (!['mlb', 'nfl'].includes(sport)) {
    return ok(res, { data: { updatedAt: new Date().toISOString(), games: [], banner: 'Weather impact applies only to MLB and NFL.' } });
  }

  const inputGames = (Array.isArray(games) ? games : [])
    .filter(g => g && g.location)
    .slice(0, 20)
    .map(g => ({
      key: String(g.key || g.location),
      location: String(g.location || '').slice(0, 80),
      label: String(g.label || g.key || g.location).slice(0, 120),
    }));
  if (!inputGames.length) return ok(res, { data: { updatedAt: new Date().toISOString(), games: [], banner: 'No game locations found in CSV.' } });

  const output = [];
  const uncached = [];
  for (const game of inputGames) {
    const cache = await getWeatherCache(game.location);
    if (cache.cached) {
      output.push({ ...game, ...(typeof cache.cached === 'string' ? JSON.parse(cache.cached) : cache.cached), cached: true });
    } else {
      uncached.push({ ...game, cacheKey: cache.key, redis: cache.redis });
    }
  }

  if (uncached.length) {
    const today = new Date().toISOString().slice(0, 10);
    const prompt = `Get today's outdoor game weather for DFS ${sport.toUpperCase()}.
For each location, use web_search with query "{city} weather today".
Return ONLY raw JSON:
{
  "games": [
    {
      "key": "same input key",
      "location": "city/stadium",
      "summary": "short weather summary",
      "temperatureF": 72,
      "windMph": 12,
      "windDirection": "out to center|out to left|in from right|crosswind|unknown",
      "precipitation": "none|rain|snow",
      "isDome": false,
      "conditions": ["wind", "rain", "cold"]
    }
  ]
}
If a venue is a dome/retractable roof expected closed, set isDome=true and neutral weather.
Locations:
${JSON.stringify(uncached.map(({ key, location, label }) => ({ key, location, label })))}`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      system: 'You return current sports-weather JSON. Always use web_search. Return only raw JSON.',
      messages: [{ role: 'user', content: prompt }],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    }, { timeout: 90000 });

    const rawText = (response.content || [])
      .filter(b => b.type === 'text' && b.text)
      .map(b => b.text)
      .join('\n')
      .trim();
    const parsed = parseJsonFromText(rawText);
    const byKey = new Map((Array.isArray(parsed.games) ? parsed.games : []).map(g => [String(g.key || ''), g]));
    for (const game of uncached) {
      const weather = byKey.get(game.key) || {
        location: game.location,
        summary: 'Weather unavailable',
        temperatureF: null,
        windMph: null,
        windDirection: 'unknown',
        precipitation: 'none',
        isDome: false,
        conditions: [],
      };
      const clean = {
        location: String(weather.location || game.location),
        summary: String(weather.summary || 'Weather unavailable'),
        temperatureF: weather.temperatureF == null ? null : Number(weather.temperatureF),
        windMph: weather.windMph == null ? null : Number(weather.windMph),
        windDirection: String(weather.windDirection || 'unknown').toLowerCase(),
        precipitation: String(weather.precipitation || 'none').toLowerCase(),
        isDome: !!weather.isDome,
        conditions: Array.isArray(weather.conditions) ? weather.conditions.map(String) : [],
      };
      await setWeatherCache(game.cacheKey, game.redis, clean);
      output.push({ key: game.key, label: game.label, ...clean, cached: false });
    }
  }

  output.sort((a, b) => String(a.label || a.location).localeCompare(String(b.label || b.location)));
    return ok(res, {
      data: {
        updatedAt: new Date().toISOString(),
        games: output,
        banner: output.map(g => `${g.label || g.location}: ${g.summary}`).join(' | '),
      },
    });
  } catch (err) {
    console.error('DFS weather error:', err.message);
    return fail(res, 500, { error: err.message || 'Could not refresh weather.' });
  }
});

module.exports = router;
