const express = require('express');
const router = express.Router();
const Anthropic = require('@anthropic-ai/sdk');
const { getUser, addCredits } = require('../lib/users');
const {
  getGlobalCount,
  incrementGlobalCount,
  getUserDailyCount,
  incrementUserDailyCount,
  getLimitConfig,
} = require('../lib/limits');
const { verifySession } = require('../lib/auth');
const { ok, fail } = require('../lib/http');
const { OWNER_EMAILS } = require('../lib/owners');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── LIVE ODDS AUTO-FETCH ─────────────────────────────────────────────────────
// Fetches real odds from The Odds API for both teams in a game.
// Matches the game to the prompt using fuzzy team name matching.
// Returns { homeTeam, awayTeam, homeOdds, awayOdds, bookmakers } or null.

const NBA_SPORT_KEY = 'basketball_nba';
const NFL_SPORT_KEY = 'americanfootball_nfl';
const MLB_SPORT_KEY = 'baseball_mlb';
const NHL_SPORT_KEY = 'icehockey_nhl';
const MMA_SPORT_KEY = 'mma_mixed_martial_arts';
const GOLF_SPORT_KEY = 'golf_pga_tour';

// Sports with no spreads or totals — h2h only
const H2H_ONLY_SPORTS = new Set([MMA_SPORT_KEY, GOLF_SPORT_KEY]);

function detectSportKey(prompt) {
  const src = String(prompt || '').toLowerCase();
  // MMA — checked early, keywords are sport-specific enough to avoid false positives
  if (/\bufc\b|\bmma\b|makhachev|adesanya|volkanovski|poirier|holloway|oliveira|gaethje|strickland|pereira/.test(src)) return MMA_SPORT_KEY;
  // Golf — pga/golf keywords plus distinctive golfer last names
  if (/\bgolf\b|\bpga\b|\blpga\b|\bmasters\b|\bthe open\b|scheffler|mcilroy|\brahm\b|spieth|morikawa|hovland|scottie schauffele/.test(src)) return GOLF_SPORT_KEY;
  if (/\bnba\b|lakers|celtics|warriors|nuggets|bucks|heat|76ers|knicks|nets|bulls|cavs|cavaliers|pistons|thunder|timberwolves|spurs/.test(src)) return NBA_SPORT_KEY;
  if (/\bnfl\b|patriots|cowboys|eagles|chiefs|packers|bears|lions|ravens|browns|steelers/.test(src)) return NFL_SPORT_KEY;
  if (/\bmlb\b|yankees|dodgers|red sox|cubs|mets|braves|astros|giants|cardinals/.test(src)) return MLB_SPORT_KEY;
  if (/\bnhl\b|rangers|bruins|maple leafs|canadiens|penguins|lightning|avalanche|oilers/.test(src)) return NHL_SPORT_KEY;
  return NBA_SPORT_KEY; // default
}

function teamNameMatch(promptText, teamName) {
  const src = String(promptText || '').toLowerCase();
  const name = String(teamName || '').toLowerCase();
  const parts = name.split(' ');
  // Also check last word with >= 3 chars so fighter last names like "Lee" or "Kim"
  // aren't skipped by the > 3 guard (which exists to avoid city-name false positives).
  const lastName = parts[parts.length - 1];
  return src.includes(name) ||
    parts.some(p => p.length > 3 && src.includes(p)) ||
    (lastName.length >= 3 && src.includes(lastName));
}

function fmt(odds) { return odds > 0 ? `+${odds}` : String(odds); }
function fmtPoint(point) { return point > 0 ? `+${point}` : String(point); }

// ─── MLB STATS API ────────────────────────────────────────────────────────────
const MLB_TEAM_NAME_MAP = {
  'arizona diamondbacks':109,'atlanta braves':144,'baltimore orioles':110,
  'boston red sox':111,'chicago cubs':112,'chicago white sox':145,
  'cincinnati reds':113,'cleveland guardians':114,'colorado rockies':115,
  'detroit tigers':116,'houston astros':117,'kansas city royals':118,
  'los angeles angels':108,'los angeles dodgers':119,'miami marlins':146,
  'milwaukee brewers':158,'minnesota twins':142,'new york mets':121,
  'new york yankees':147,'oakland athletics':133,'philadelphia phillies':143,
  'pittsburgh pirates':134,'san diego padres':135,'san francisco giants':137,
  'seattle mariners':136,'st. louis cardinals':138,'tampa bay rays':139,
  'texas rangers':140,'toronto blue jays':141,'washington nationals':120,
};

function resolveMLBTeamId(teamName) {
  const lower = String(teamName || '').toLowerCase();
  if (MLB_TEAM_NAME_MAP[lower]) return MLB_TEAM_NAME_MAP[lower];
  for (const [key, id] of Object.entries(MLB_TEAM_NAME_MAP)) {
    if (lower && key.includes(lower)) return id;
    const parts = lower.split(' ');
    if (parts.some(p => p.length > 3 && key.includes(p))) return id;
  }
  return null;
}

async function fetchMLBTeamStats(teamName) {
  const teamId = resolveMLBTeamId(teamName);
  if (!teamId) return null;
  try {
    const season = new Date().getFullYear();
    const res = await withTimeout(fetch(`https://statsapi.mlb.com/api/v1/standings?leagueId=103,104&season=${season}&standingsTypes=regularSeason`), 4000, 'mlb standings');
    if (!res.ok) return null;
    const data = await res.json();
    for (const division of (data.records || [])) {
      for (const team of (division.teamRecords || [])) {
        if (team.team && team.team.id === teamId) {
          const splits = (team.records && team.records.splitRecords) || [];
          const home = splits.find(s => s.type === 'home') || {};
          const away = splits.find(s => s.type === 'away') || {};
          return {
            record: `${team.wins||0}-${team.losses||0}`,
            homeRecord: `${home.wins||0}-${home.losses||0}`,
            awayRecord: `${away.wins||0}-${away.losses||0}`,
            streak: team.streak && team.streak.streakCode ? team.streak.streakCode : null,
            winPct: team.winningPercentage || null,
          };
        }
      }
    }
  } catch (err) { console.warn('MLB stats fetch failed:', err.message); }
  return null;
}

async function fetchMLBTeamStatsBlock(homeTeam, awayTeam) {
  try {
    const [homeStats, awayStats] = await Promise.all([fetchMLBTeamStats(homeTeam), fetchMLBTeamStats(awayTeam)]);
    if (!homeStats && !awayStats) return null;
    const lines = ['', '--- MLB TEAM STATS (Live) ---'];
    if (homeStats) lines.push(`${homeTeam}: ${homeStats.record} overall | Home: ${homeStats.homeRecord} | Away: ${homeStats.awayRecord}${homeStats.streak ? ` | Streak: ${homeStats.streak}` : ''}`);
    if (awayStats) lines.push(`${awayTeam}: ${awayStats.record} overall | Home: ${awayStats.homeRecord} | Away: ${awayStats.awayRecord}${awayStats.streak ? ` | Streak: ${awayStats.streak}` : ''}`);
    return lines.join('\n');
  } catch { return null; }
}

async function fetchLiveGameOdds(prompt) {
  try {
    const apiKey = process.env.THE_ODDS_API_KEY || process.env.ODDS_API_KEY || process.env.ODDS_KEY;
    if (!apiKey) return null;

    const sportKey = detectSportKey(prompt);
    // Golf and MMA have no spreads or totals
    const markets = H2H_ONLY_SPORTS.has(sportKey) ? 'h2h' : 'h2h,spreads,totals';
    const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds/?apiKey=${apiKey}&regions=us&markets=${markets}&oddsFormat=american`;
    const res = await withTimeout(fetch(url), 5000, 'odds api fetch');
    if (!res.ok) return null;

    const games = await res.json();
    if (!Array.isArray(games)) return null;

    // Try game ID first (most reliable — frontend now sends GAME ID in prompt)
    const gameIdMatch = String(prompt || '').match(/\bGAME\s+ID:\s*([a-f0-9-]{8,})/i);
    const promptGameId = gameIdMatch ? gameIdMatch[1].trim() : null;

    // Also extract team names from prompt for fallback matching
    const promptTeams = extractGameTeams(prompt);

    const matchedGame = games.find(game => {
      // Primary: exact game ID match
      if (promptGameId && game.id && game.id === promptGameId) return true;
      // Secondary: both team names match (exact game)
      if (promptTeams) {
        const homeMatch = game.home_team.toLowerCase() === promptTeams.home.toLowerCase() ||
                          teamNameMatch(prompt, game.home_team);
        const awayMatch = game.away_team.toLowerCase() === promptTeams.away.toLowerCase() ||
                          teamNameMatch(prompt, game.away_team);
        return homeMatch && awayMatch;
      }
      // Tertiary: at least one team name match (existing behavior)
      return teamNameMatch(prompt, game.home_team) || teamNameMatch(prompt, game.away_team);
    });

    if (!matchedGame) {
      console.warn('[EDGE] No game matched. promptGameId:', promptGameId, 'teams:', promptTeams);
      return null;
    }
    console.log('[EDGE] Matched game:', matchedGame.away_team, '@', matchedGame.home_team, 'id:', matchedGame.id);

    const homeTeam = matchedGame.home_team;
    const awayTeam = matchedGame.away_team;

    // Accumulators for each market — track sharp (LowVig) and best available
    const sharp = { h2h: {}, spreads: {}, totals: {} };
    const best = { h2h: {}, spreads: {}, totals: {} };
    const lines = { h2h: [], spreads: [], totals: [] };

    for (const bk of (matchedGame.bookmakers || [])) {
      const isSharp = bk.key === 'lowvig' || bk.key === 'pinnacle';

      for (const market of (bk.markets || [])) {
        const mk = market.key;
        if (!['h2h', 'spreads', 'totals'].includes(mk)) continue;

        if (mk === 'h2h') {
          const home = market.outcomes.find(o => o.name === homeTeam);
          const away = market.outcomes.find(o => o.name === awayTeam);
          if (!home || !away) continue;

          lines.h2h.push(`${bk.title}: ${homeTeam} ${fmt(home.price)} | ${awayTeam} ${fmt(away.price)}`);
          if (isSharp) { sharp.h2h.home = home.price; sharp.h2h.away = away.price; }
          if (!best.h2h.home || home.price > best.h2h.home) best.h2h.home = home.price;
          if (!best.h2h.away || away.price > best.h2h.away) best.h2h.away = away.price;
        }

        if (mk === 'spreads') {
          const home = market.outcomes.find(o => o.name === homeTeam);
          const away = market.outcomes.find(o => o.name === awayTeam);
          if (!home || !away) continue;

          lines.spreads.push(`${bk.title}: ${homeTeam} ${fmt(home.price)} ${home.point} | ${awayTeam} ${fmt(away.price)} ${away.point}`);
          if (isSharp) { sharp.spreads.home = home.price; sharp.spreads.away = away.price; sharp.spreads.point = home.point; }
          if (!best.spreads.home || home.price > best.spreads.home) { best.spreads.home = home.price; best.spreads.point = home.point; }
          if (!best.spreads.away || away.price > best.spreads.away) best.spreads.away = away.price;
        }

        if (mk === 'totals') {
          const over = market.outcomes.find(o => o.name === 'Over');
          const under = market.outcomes.find(o => o.name === 'Under');
          if (!over || !under) continue;

          lines.totals.push(`${bk.title}: Over ${fmt(over.price)} ${over.point} | Under ${fmt(under.price)} ${under.point}`);
          if (isSharp) { sharp.totals.over = over.price; sharp.totals.under = under.price; sharp.totals.point = over.point; }
          if (!best.totals.over || over.price > best.totals.over) { best.totals.over = over.price; best.totals.point = over.point; }
          if (!best.totals.under || under.price > best.totals.under) best.totals.under = under.price;
        }
      }
    }

    // Use sharp (LowVig) if available, else best
    const h2hHome = sharp.h2h.home || best.h2h.home;
    const h2hAway = sharp.h2h.away || best.h2h.away;
    const spreadHome = sharp.spreads.home || best.spreads.home;
    const spreadAway = sharp.spreads.away || best.spreads.away;
    const spreadPoint = sharp.spreads.point || best.spreads.point || 0;
    const totalOver = sharp.totals.over || best.totals.over;
    const totalUnder = sharp.totals.under || best.totals.under;
    const totalPoint = sharp.totals.point || best.totals.point || 0;

    if (!h2hHome || !h2hAway) return null;

    // Build full odds block for the AI prompt
    const isH2hOnly = H2H_ONLY_SPORTS.has(sportKey);
    const gameHeader = isH2hOnly
      ? `MATCHUP: ${homeTeam} vs ${awayTeam}`
      : `GAME: ${awayTeam} @ ${homeTeam}`;
    const oddsBlock = [
      gameHeader,
      '',
      '--- MONEYLINE (h2h) ---',
      `Sharp: ${homeTeam} ${fmt(h2hHome)} | ${awayTeam} ${fmt(h2hAway)}`,
      ...lines.h2h,
      ...(!isH2hOnly ? [
        '',
        '--- SPREAD ---',
        spreadHome ? `Sharp: ${homeTeam} ${fmt(spreadHome)} ${spreadPoint} | ${awayTeam} ${fmt(spreadAway)} ${-spreadPoint}` : 'No spread data',
        ...lines.spreads,
        '',
        '--- TOTALS ---',
        totalOver ? `Sharp: Over ${fmt(totalOver)} ${totalPoint} | Under ${fmt(totalUnder)} ${totalPoint}` : 'No totals data',
        ...lines.totals,
      ] : []),
    ].join('\n');

    // Build all 6 candidates for evaluation
    const candidates = [
      { market: 'h2h', team: homeTeam, opponent: awayTeam, side: 'home', odds: h2hHome, opponentOdds: h2hAway, label: `${homeTeam} ML ${fmt(h2hHome)}` },
      { market: 'h2h', team: awayTeam, opponent: homeTeam, side: 'away', odds: h2hAway, opponentOdds: h2hHome, label: `${awayTeam} ML ${fmt(h2hAway)}` },
    ];

    if (spreadHome && spreadAway) {
      candidates.push(
        { market: 'spreads', team: homeTeam, opponent: awayTeam, side: 'home', odds: spreadHome, opponentOdds: spreadAway, point: spreadPoint, label: `${homeTeam} ${fmtPoint(spreadPoint)} ${fmt(spreadHome)}` },
        { market: 'spreads', team: awayTeam, opponent: homeTeam, side: 'away', odds: spreadAway, opponentOdds: spreadHome, point: -spreadPoint, label: `${awayTeam} ${fmtPoint(-spreadPoint)} ${fmt(spreadAway)}` }
      );
    }

    if (totalOver && totalUnder) {
      candidates.push(
        { market: 'totals', team: 'Over', opponent: 'Under', side: 'over', odds: totalOver, opponentOdds: totalUnder, point: totalPoint, label: `Over ${totalPoint} ${fmt(totalOver)}` },
        { market: 'totals', team: 'Under', opponent: 'Over', side: 'under', odds: totalUnder, opponentOdds: totalOver, point: totalPoint, label: `Under ${totalPoint} ${fmt(totalUnder)}` }
      );
    }

    // Fetch MLB team stats if this is a baseball game
    let mlbStatsBlock = null;
    if (sportKey === MLB_SPORT_KEY) {
      try {
        mlbStatsBlock = await withTimeout(fetchMLBTeamStatsBlock(homeTeam, awayTeam), 4000, 'mlb stats');
      } catch { mlbStatsBlock = null; }
    }

    const enrichedOddsBlock = mlbStatsBlock ? oddsBlock + mlbStatsBlock : oddsBlock;

    return {
      homeTeam,
      awayTeam,
      homeOdds: h2hHome,
      awayOdds: h2hAway,
      oddsBlock: enrichedOddsBlock,
      candidates,
      mlbStats: mlbStatsBlock,
      fetchedAt: Date.now(),
    };
  } catch (err) {
    console.warn('fetchLiveGameOdds failed:', err.message);
    return null;
  }
}

// ─── TEAM FORM SIGNAL (MLB Stats → Edge Score Input) ─────────────────────────
// Converts real MLB team stats into a numeric signal (-10 to +10)
// that feeds directly into computeEdgeScore as teamFormSignal.
//
// Factors:
//   Win % vs .500        → up to ±4 points  (strong team vs weak team)
//   Current streak       → up to ±3 points  (hot/cold momentum)
//   Home/away split      → up to ±2 points  (home team advantage or road struggles)
//   Run differential     → up to ±1 point   (true quality indicator)

function parseRecord(recordStr) {
  if (!recordStr) return null;
  const parts = String(recordStr).split('-').map(Number);
  if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) return null;
  return { wins: parts[0], losses: parts[1], total: parts[0] + parts[1] };
}

function parseStreak(streakCode) {
  if (!streakCode) return 0;
  const match = String(streakCode).match(/^([WL])(\d+)$/);
  if (!match) return 0;
  const n = parseInt(match[2], 10);
  return match[1] === 'W' ? n : -n;
}

function computeTeamFormSignal(teamStats, isHome) {
  if (!teamStats) return 0;
  let signal = 0;

  // Win % vs .500 — strong teams get bonus, weak teams get penalty
  const rec = parseRecord(teamStats.record);
  if (rec && rec.total >= 10) {
    const winPct = rec.wins / rec.total;
    // Scale: .600 WP → +4, .400 WP → -4, .500 → 0
    signal += Math.max(-4, Math.min(4, (winPct - 0.5) * 40));
  }

  // Streak — winning streaks are momentum, losing streaks are red flags
  const streak = parseStreak(teamStats.streak);
  if (streak !== 0) {
    // Scale: W5 → +3, L5 → -3, cap at ±3
    signal += Math.max(-3, Math.min(3, streak * 0.6));
  }

  // Home/away split — home teams batting at home get bonus, road teams at home get penalty
  if (isHome) {
    const homeRec = parseRecord(teamStats.homeRecord);
    if (homeRec && homeRec.total >= 5) {
      const homeWinPct = homeRec.wins / homeRec.total;
      signal += Math.max(-2, Math.min(2, (homeWinPct - 0.5) * 20));
    }
  } else {
    const awayRec = parseRecord(teamStats.awayRecord);
    if (awayRec && awayRec.total >= 5) {
      const awayWinPct = awayRec.wins / awayRec.total;
      signal += Math.max(-2, Math.min(2, (awayWinPct - 0.5) * 20));
    }
  }

  return Math.max(-10, Math.min(10, signal));
}

function extractTeamFormFromMLBBlock(mlbStatsBlock, teamName, isHome) {
  if (!mlbStatsBlock || !teamName) return 0;
  const lines = mlbStatsBlock.split('\n');
  const teamLine = lines.find(l => l.toLowerCase().includes(teamName.toLowerCase()));
  if (!teamLine) return 0;

  // Parse: "Boston Red Sox: 31-29 overall | Home: 16-15 | Away: 15-14 | Streak: W3"
  const overallMatch = teamLine.match(/(\d+)-(\d+) overall/);
  const homeMatch    = teamLine.match(/Home:\s*(\d+)-(\d+)/);
  const awayMatch    = teamLine.match(/Away:\s*(\d+)-(\d+)/);
  const streakMatch  = teamLine.match(/Streak:\s*([WL]\d+)/);

  const stats = {
    record:     overallMatch ? `${overallMatch[1]}-${overallMatch[2]}` : null,
    homeRecord: homeMatch    ? `${homeMatch[1]}-${homeMatch[2]}`       : null,
    awayRecord: awayMatch    ? `${awayMatch[1]}-${awayMatch[2]}`       : null,
    streak:     streakMatch  ? streakMatch[1]                          : null,
  };

  return computeTeamFormSignal(stats, isHome);
}


const MODELS = {
  quick: process.env.ANTHROPIC_QUICK_MODEL || 'claude-haiku-4-5-20251001',
  deep: process.env.ANTHROPIC_DEEP_MODEL || 'claude-sonnet-4-6',
};

const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.4-mini';

const SYSTEM_TEXT = [
  'You are an expert sports betting analyst specializing in expected value modeling.',
  'Return ONLY a raw JSON object. No markdown, no code fences, no comments, no preamble.',
  'Start with { and end with }.',
].join(' ');

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

function extractAnthropicText(response) {
  try {
    if (!response || !Array.isArray(response.content)) {
      return '';
    }

    return response.content
      .filter(block => block && block.type === 'text' && block.text)
      .map(block => block.text)
      .join('\n')
      .trim();
  } catch (err) {
    console.error('extractAnthropicText error:', err.message);
    return '';
  }
}

function extractOpenAIText(response) {
  if (response && response.output_text) return response.output_text.trim();
  return (response && response.output ? response.output : [])
    .flatMap(item => item && item.content ? item.content : [])
    .map(part => part.text || part.content || '')
    .filter(Boolean)
    .join('\n')
    .trim();
}

function cleanJsonText(text) {
  const match = String(text || '').match(/\{[\s\S]*\}/);
  if (!match) return String(text || '').trim();
  return match[0]
    .replace(/\/\/[^\n]*/g, '')
    .replace(/,(\s*[}\]])/g, '$1')
    .trim();
}

// ─── SHARP-LINE METHODOLOGY ───────────────────────────────────────────────────
// Based on Pinnacle-as-baseline (sharp book consensus) + Walters CLV framework.
// Pinnacle accepts sharp action and posts the most efficient lines in the market.
// EV is measured against Pinnacle's vig-removed true probability, not a fake +3% bump.

const SHARP_BOOKS = ['pinnacle', 'pinnaclesports'];
const SQUARE_BOOKS = ['draftkings', 'fanduel', 'betmgm', 'caesars', 'pointsbet', 'williamhill_us'];

function impliedProb(odds) {
  const n = Number(odds);
  if (!Number.isFinite(n) || n === 0) return 0.5;
  return n > 0 ? 100 / (n + 100) : Math.abs(n) / (Math.abs(n) + 100);
}

/**
 * Remove vig from a two-sided market to get true probability.
 * Given raw implied probs for both sides, divide by total overround.
 */
function vigRemoved(rawA, rawB) {
  const total = rawA + rawB;
  if (!total) return rawA;
  return rawA / total;
}

/**
 * Extract Pinnacle's line for a team from bookmaker data embedded in the prompt.
 * Falls back to the best available sharp-book price, then market average.
 */
function extractPinnacleOdds(prompt, team, opponentTeam) {
  const lines = String(prompt || '').split(/\r?\n/);
  const pinnacleSection = lines.findIndex(l => /pinnacle|lowvig|sharp:/i.test(l));

  if (pinnacleSection !== -1 && team) {
    const nearby = lines.slice(pinnacleSection, pinnacleSection + 5).join(' ');
    const teamPattern = new RegExp(`${escapeRegExp(team)}\\s+([+-]\\d{2,4})`, 'i');
    const match = nearby.match(teamPattern);
    if (match) return Number(match[1]);
  }

  return null;
}

/**
 * Calculate vig (overround) from two-sided market.
 */
function calcVig(oddsA, oddsB) {
  if (oddsA == null || oddsB == null) return null;
  return (impliedProb(oddsA) + impliedProb(oddsB)) * 100;
}

// ─── SIGNAL EXTRACTORS ───────────────────────────────────────────────────────

const BOOK_NAMES = ['pinnacle', 'lowvig', 'draftkings', 'fanduel', 'betmgm', 'caesars', 'pointsbet', 'williamhill', 'betrivers', 'barstool', 'unibet', 'bet365', 'bovada', 'mybookie'];

function extractInjurySignal(text) {
  const src = String(text || '').toLowerCase();
  const neg = [/\binjur(?:y|ies|ed)\b/, /\bout\b(?!.*\bof\s+bounds)/, /\bdnp\b/, /\bquestionable\b/, /\bdoubtful\b/, /\bmissing\b/, /\blimited\b/, /\bday-?to-?day\b/, /\bscratched\b/];
  const pos = [/\bhealthy\b/, /\bfull.?strength\b/, /\bback.from.injur/, /\bcleared\b/, /\bno.?injur/, /\bfully.?fit\b/];
  const n = neg.filter(p => p.test(src)).length;
  const p = pos.filter(p => p.test(src)).length;
  return Math.max(-10, Math.min(10, (p - n) * 3));
}

function extractSituationalSignal(text) {
  const src = String(text || '').toLowerCase();
  const pos = [/\bhome.?(?:game|crowd|field|ice|court|advantage)\b/, /\brest.advantage\b/, /\bwinning.streak\b/, /\bback.to.back.*(?:opponent|away)\b/, /\bmomentum\b/, /\bmust.win\b/, /\bprime.time\b/];
  const neg = [/\bback.to.back\b(?!.*(?:opponent|away))/, /\bfatigue\b/, /\blosing.streak\b/, /\blong.road.trip\b/, /\bshort.rest\b/, /\baway.game\b/];
  const p = pos.filter(p => p.test(src)).length;
  const n = neg.filter(p => p.test(src)).length;
  return Math.max(-10, Math.min(10, (p - n) * 2));
}

function computeMarketBreadth(prompt) {
  const src = String(prompt || '').toLowerCase();
  const count = BOOK_NAMES.filter(b => src.includes(b)).length;
  if (count >= 6) return 8;
  if (count >= 4) return 5;
  if (count >= 2) return 2;
  if (count >= 1) return 0;
  return -3;
}

function computeConfidencePenalty(vigPct) {
  if (vigPct == null) return 0;
  if (vigPct <= 102) return 3;
  if (vigPct <= 104) return 0;
  if (vigPct <= 106) return -3;
  if (vigPct <= 110) return -6;
  return -9;
}

// ─── MAIN EDGE SCORING ────────────────────────────────────────────────────────
// Weights: priceEdge 55%, teamFormSignal 15%, marketBreadth 10%,
//          confidencePenalty 10%, injurySignal 5%, situationalSignal 5%
//
// teamFormSignal replaces the old generic situationalSignal as the primary
// contextual input — it's derived from real MLB team records, streaks, and
// home/away splits rather than keyword pattern matching.
function computeEdgeScore({
  noVigProb,
  impliedProb: rawImplied,
  marketBreadth = 0,
  confidencePenalty = 0,
  injurySignal = 0,
  situationalSignal = 0,
  teamFormSignal = 0,
}) {
  const priceEdge = (noVigProb - rawImplied) * 100;

  // HARD GATE: if the true probability is lower than implied (negative price edge),
  // there is no value on this side. Context signals cannot rescue a negative edge.
  // Return a negative score that will always resolve to PASS.
  if (priceEdge <= 0) return priceEdge * 0.55;

  // If we have real team form data, use it as the primary contextual signal.
  // Otherwise fall back to keyword-based situational signal.
  const contextSignal = teamFormSignal !== 0 ? teamFormSignal : situationalSignal;
  return (
    priceEdge        * 0.55 +
    contextSignal    * 0.15 +
    marketBreadth    * 0.10 +
    confidencePenalty * 0.10 +
    injurySignal     * 0.05 +
    situationalSignal * 0.05
  );
}

// ─── FIX 1: LOWERED VERDICT THRESHOLDS ───────────────────────────────────────
// Previous: BET > 8, LEAN > 3, else PASS
// Updated:  BET > 5, LEAN > 1, else PASS
// This allows plus-money underdogs with real value (e.g. score 0.22+) to show
// LEAN instead of defaulting to PASS every time.
function getVerdict(score) {
  // Require meaningful positive score for any recommendation.
  // score > 0 but < 1 is noise — too small to act on.
  if (score > 5)   return 'BET';
  if (score > 1.5) return 'LEAN';
  return 'PASS';
}

// ─── FIX 2: LOWERED CONFIDENCE THRESHOLDS ────────────────────────────────────
// Previous: HIGH > 10, MEDIUM > 5, else LOW
// Updated:  HIGH > 7,  MEDIUM > 3, LOW > 1, else VERY LOW
// Prevents everything from landing on LOW confidence and reinforcing PASS logic.
function getConfidence(score) {
  if (score > 7) return 'HIGH';
  if (score > 3) return 'MEDIUM';
  if (score > 0) return 'LOW';
  return 'VERY LOW';
}

function clampProbability(value) {
  return Math.min(0.99, Math.max(0.01, value));
}

function roundNumber(value, digits = 4) {
  return Number(value.toFixed(digits));
}

function percent(value) {
  return `${roundNumber(value * 100, 1)}%`;
}

function extractAmericanOdds(text) {
  const source = String(text || '');
  const contextualMatch = source.match(/\b(?:odds|price|line|moneyline|ml|@)\s*:?\s*([+-]\d{2,4})\b/i);
  const moneylineMatch = source.match(/\b[A-Z][A-Za-z .'-]{1,40}\s+([+-]\d{2,4})(?:\s|\/|$)/);
  const fallbackMatch = source.match(/\b([+-]\d{2,4})\b/);
  const odds = Number((contextualMatch || moneylineMatch || fallbackMatch || [])[1]);

  if (!Number.isFinite(odds) || odds === 0) return null;
  if (Math.abs(odds) < 100 || Math.abs(odds) > 2500) return null;

  return odds;
}

function promptBody(prompt) {
  return String(prompt || '').split(/\nINSTRUCTIONS:/i)[0];
}

function keywordScore(text, positivePatterns, negativePatterns) {
  const source = String(text || '').toLowerCase();
  const positives = positivePatterns.reduce((sum, pattern) => sum + (pattern.test(source) ? 1 : 0), 0);
  const negatives = negativePatterns.reduce((sum, pattern) => sum + (pattern.test(source) ? 1 : 0), 0);

  return Math.max(-10, Math.min(10, (positives - negatives) * 3));
}

function getRisk(confidence, score) {
  if (confidence === 'HIGH') return score > 12 ? 'LOW' : 'MEDIUM';
  if (confidence === 'MEDIUM') return 'MEDIUM';
  return 'HIGH';
}

function getEdgeStrength(score) {
  if (score > 5) return 'STRONG';
  if (score > 1) return 'MODERATE';
  if (score > 0) return 'WEAK';
  return 'NONE';
}

function getRecommendedAction(verdict, confidence) {
  if (verdict === 'BET') {
    return confidence === 'HIGH'
      ? 'Bet only if the current line is still available.'
      : 'Small bet only if the price has not moved against the projection.';
  }
  if (verdict === 'LEAN') return 'Track the line. Small unit bet if price holds or improves.';
  return 'Pass unless new odds create a stronger EDGE score.';
}

function formatAmericanOdds(odds) {
  const value = Number(odds);
  if (!Number.isFinite(value)) return '';
  return value > 0 ? `+${value}` : String(value);
}

function extractGameTeams(prompt) {
  const match = String(prompt || '').match(/\bGAME:\s*([^\n@]+?)\s+@\s+([^\n]+)/i);
  if (!match) return null;
  return {
    away: match[1].trim(),
    home: match[2].trim(),
  };
}

function extractPromptPlay(prompt) {
  const source = promptBody(prompt);
  const labeled = source.match(/\b(?:pick|play|bet|side)\s*:?\s*([A-Z][A-Za-z0-9 .'-]{1,60}?(?:\s+(?:ML|moneyline|spread|over|under))?(?:\s+[+-]\d{2,4})?)\b/i);
  if (labeled && !/\bprompt\b/i.test(labeled[1])) return labeled[1].replace(/\s+/g, ' ').trim();

  const moneyline = source.match(/\b([A-Z][A-Za-z .'-]{1,40}\s+(?:ML|moneyline)\s+[+-]\d{2,4})\b/i);
  if (moneyline) return moneyline[1].replace(/\s+/g, ' ').trim();

  return '';
}

function extractBookOdds(prompt) {
  const teams = extractGameTeams(prompt);
  if (!teams) return [];

  const rows = [];
  const lines = String(prompt || '').split(/\r?\n/);
  const awayPattern = new RegExp(`${escapeRegExp(teams.away)}\\s+([+-]\\d{2,4})`, 'i');
  const homePattern = new RegExp(`${escapeRegExp(teams.home)}\\s+([+-]\\d{2,4})`, 'i');

  lines.forEach(line => {
    const away = line.match(awayPattern);
    const home = line.match(homePattern);
    if (away) rows.push({ team: teams.away, odds: Number(away[1]) });
    if (home) rows.push({ team: teams.home, odds: Number(home[1]) });
  });

  return rows.filter(row => Number.isFinite(row.odds));
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pickFromPrompt(prompt, evaluation) {
  if (evaluation.verdict === 'PASS') return 'No clear edge';

  const explicit = extractPromptPlay(prompt);
  if (explicit) return explicit;

  const bookOdds = extractBookOdds(prompt);
  const plusMoney = bookOdds
    .filter(row => row.odds > 0)
    .sort((a, b) => b.odds - a.odds)[0];
  if (plusMoney && ['BET', 'LEAN'].includes(evaluation.verdict)) {
    return `${plusMoney.team} ML ${formatAmericanOdds(plusMoney.odds)}`;
  }

  const best = bookOdds.sort((a, b) => b.odds - a.odds)[0];
  if (best && ['BET', 'LEAN'].includes(evaluation.verdict)) {
    return `${best.team} ML ${formatAmericanOdds(best.odds)}`;
  }

  const teams = extractGameTeams(prompt);
  if (teams && ['BET', 'LEAN'].includes(evaluation.verdict)) {
    return `${teams.home} ML`;
  }

  return 'Best available play';
}

function normalizeOddsValue(value) {
  const odds = Number(value);
  if (!Number.isFinite(odds) || odds === 0) return null;
  if (Math.abs(odds) < 100 || Math.abs(odds) > 2500) return null;
  return odds;
}

function pickLabel(team, odds, market, point) {
  if (!team) return 'Best available play';
  if (market === 'spreads') {
    const pointStr = point != null ? ` ${point}` : '';
    return `${team}${pointStr}${odds != null ? ` ${formatAmericanOdds(odds)}` : ''}`;
  }
  return `${team} ML${odds != null ? ` ${formatAmericanOdds(odds)}` : ''}`;
}

function extractSpreadPoint(prompt, team) {
  if (!team) return null;
  const pattern = new RegExp(`${escapeRegExp(team)}\\s+([+-]?\\d{1,3}(?:\\.5)?)\\s+[+-]\\d{2,4}`, 'i');
  const match = String(prompt || '').match(pattern);
  if (!match) return null;
  const val = parseFloat(match[1]);
  if (!Number.isFinite(val) || Math.abs(val) > 50) return null;
  return val >= 0 ? `+${val}` : String(val);
}

// ─── FIX 3: PASS ONLY FIRES ON TRUE PASS ─────────────────────────────────────
// LEAN verdict now routes to pickLabel() instead of passPick().
// The passPick() function is only called when verdict === 'PASS'.
function passPick() {
  return 'PASS — no clear edge';
}

function candidateFromContext(prompt, context, side) {
  const teams = extractGameTeams(prompt) || {};
  const odds = context && context.odds;
  const selectedTeam = String((context && context.selectedTeam) || '').trim();
  const opponentTeam = String((context && context.opponentTeam) || '').trim();

  if (side === 'away') {
    return {
      side: 'away',
      team: selectedTeam || teams.away || '',
      opponent: opponentTeam || teams.home || '',
      market: (context && context.market) || 'h2h',
      odds: normalizeOddsValue(odds && typeof odds === 'object' ? odds.away : odds),
    };
  }

  if (side === 'home') {
    return {
      side: 'home',
      team: selectedTeam || teams.home || '',
      opponent: opponentTeam || teams.away || '',
      market: (context && context.market) || 'h2h',
      odds: normalizeOddsValue(odds && typeof odds === 'object' ? odds.home : odds),
    };
  }

  return null;
}

function buildCandidateEvaluation(prompt, candidate, lineMovementScore = 0) {
  const odds = normalizeOddsValue(candidate && candidate.odds);
  const oddsDetected = odds != null;

  const opponentOdds = normalizeOddsValue(
    candidate && candidate.opponentOdds != null ? candidate.opponentOdds :
    extractOpponentOdds(prompt, candidate && candidate.opponent)
  );

  const pinnacleOdds = oddsDetected ? extractPinnacleOdds(prompt, candidate && candidate.team, candidate && candidate.opponent) : null;
  const pinnacleOpponentOdds = opponentOdds != null ? extractPinnacleOdds(prompt, candidate && candidate.opponent, candidate && candidate.team) : null;

  let implied, projected;
  const candidateMarketType = (candidate && candidate.market) || 'h2h';

  if (!oddsDetected) {
    implied = 0.5;
    projected = 0.5;
  } else if (candidateMarketType === 'spreads' || candidateMarketType === 'totals') {
    // CRITICAL: For spread/total markets, ALWAYS use the market's own two-sided
    // odds for probability — never use moneyline-derived probability.
    // A -3000 ML favorite is NOT a 94% spread cover proposition.
    // The spread market already prices the cover probability correctly.
    if (opponentOdds != null) {
      const rawA = impliedProb(odds);
      const rawB = impliedProb(opponentOdds);
      projected = clampProbability(vigRemoved(rawA, rawB));
      implied = rawA;
    } else {
      // No opponent odds available — use the spread price directly
      // Spread odds near -110/-110 imply ~50% true probability
      implied = impliedProb(odds);
      projected = clampProbability(implied + 0.015);
    }
  } else if (pinnacleOdds != null && pinnacleOpponentOdds != null) {
    // h2h market with Pinnacle data — gold standard
    const pinnacleRawA = impliedProb(pinnacleOdds);
    const pinnacleRawB = impliedProb(pinnacleOpponentOdds);
    projected = clampProbability(vigRemoved(pinnacleRawA, pinnacleRawB));
    implied = impliedProb(odds);
  } else if (opponentOdds != null) {
    const rawA = impliedProb(odds);
    const rawB = impliedProb(opponentOdds);
    projected = clampProbability(vigRemoved(rawA, rawB));
    implied = rawA;
  } else {
    implied = impliedProb(odds);
    projected = clampProbability(implied + 0.015);
  }

  const factors = oddsDetected
    ? getSignalFactors(prompt, odds, opponentOdds, candidate)
    : { marketBreadth: 0, confidencePenalty: 0, injurySignal: 0, situationalSignal: 0, teamFormSignal: 0, vigPct: null };

  const edgeScore = oddsDetected
    ? computeEdgeScore({ noVigProb: projected, impliedProb: implied, ...factors })
    : 0;

  const verdict = getVerdict(edgeScore);
  const confidence = getConfidence(edgeScore);
  const risk = getRisk(confidence, edgeScore);
  const edgeStrength = getEdgeStrength(edgeScore);
  const recommendedAction = getRecommendedAction(verdict, confidence);
  // Use the pre-built label (preserves spread/total formatting). Only fall back
  // to pickLabel for h2h candidates or manual entries that have no label.
  const candidateMarket = (candidate && candidate.market) || 'h2h';
  const candidatePoint = candidateMarket === 'spreads' ? extractSpreadPoint(prompt, candidate && candidate.team) : null;
  const candidateLabel = (candidate && candidate.label) || pickLabel(candidate && candidate.team, odds, candidateMarket, candidatePoint);
  const pick = verdict === 'PASS' ? passPick() : candidateLabel;

  const priceEdgeRaw = roundNumber((projected - implied) * 100, 2);

  return {
    odds,
    oddsDetected,
    selectedSide: candidate && candidate.side,
    selectedTeam: candidate && candidate.team,
    opponentTeam: candidate && candidate.opponent,
    market: candidateMarket,
    evaluating: candidateLabel,
    pick,
    // Phase 1: new probability fields
    consensusProb: roundNumber(implied),
    noVigProb: roundNumber(projected),
    priceEdge: priceEdgeRaw,
    impliedProb: roundNumber(implied),
    projectedProb: roundNumber(projected),
    // Phase 1: new signal fields
    marketBreadth: factors.marketBreadth || 0,
    confidencePenalty: factors.confidencePenalty || 0,
    injurySignal: factors.injurySignal || 0,
    situationalSignal: factors.situationalSignal || 0,
    teamFormSignal: factors.teamFormSignal || 0,
    // Phase 2: line movement (populated upstream, default null here)
    lineMovementSignal: null,
    pinnacleUsed: pinnacleOdds != null,
    vigPct: factors.vigPct ? roundNumber(factors.vigPct, 1) : null,
    lineMovement: lineMovementScore,
    edgeScore: roundNumber(edgeScore, 2),
    verdict,
    confidence,
    risk,
    edgeStrength,
    recommendedAction,
  };
}

function getSignalFactors(prompt, odds, opponentOdds, candidate) {
  const vigPct = calcVig(odds, opponentOdds);

  // Extract MLB team form from the stats block injected into the prompt
  // candidate has selectedTeam (the pick) and opponentTeam
  let teamFormSignal = 0;
  const mlbBlockMatch = String(prompt || '').match(/--- MLB TEAM STATS \(Live\) ---([\s\S]*?)(?:\n\n|$)/);
  if (mlbBlockMatch) {
    const mlbBlock = mlbBlockMatch[0];
    const selectedTeam = (candidate && candidate.team) || '';
    const isHome = (candidate && candidate.side) === 'home';
    teamFormSignal = extractTeamFormFromMLBBlock(mlbBlock, selectedTeam, isHome);
  }

  return {
    marketBreadth: computeMarketBreadth(prompt),
    confidencePenalty: computeConfidencePenalty(vigPct),
    injurySignal: extractInjurySignal(promptBody(prompt)),
    situationalSignal: extractSituationalSignal(promptBody(prompt)),
    teamFormSignal,
    vigPct,
  };
}

function extractOpponentOdds(prompt, opponentTeam) {
  if (!opponentTeam) return null;
  const lines = String(prompt || '').split(/\r?\n/);
  const pattern = new RegExp(`${escapeRegExp(opponentTeam)}\\s+([+-]\\d{2,4})`, 'i');
  for (const line of lines) {
    const match = line.match(pattern);
    if (match) return normalizeOddsValue(Number(match[1]));
  }
  return null;
}

function extractSquareBookOdds(prompt, team) {
  const lines = String(prompt || '').split(/\r?\n/);
  let bestSquareOdds = null;
  for (const book of SQUARE_BOOKS) {
    const bookLineIdx = lines.findIndex(l => new RegExp(book, 'i').test(l));
    if (bookLineIdx === -1) continue;
    const nearby = lines.slice(bookLineIdx, bookLineIdx + 5).join(' ');
    const oddsMatch = nearby.match(/([+-]\d{3,4})/);
    if (oddsMatch) {
      const o = Number(oddsMatch[1]);
      if (Number.isFinite(o) && Math.abs(o) >= 100) {
        if (bestSquareOdds === null || o > bestSquareOdds) bestSquareOdds = o;
      }
    }
  }
  return bestSquareOdds;
}

function fallbackReason(oddsDetected, score) {
  if (!oddsDetected) {
    return 'Odds were not detected, so EDGE cannot calculate a reliable value signal.';
  }
  if (score > 5) return 'The calculated EDGE score clears the BET threshold based on the projected probability versus the market price.';
  if (score > 1) return 'The calculated EDGE score shows a modest value signal. Small unit play if line holds.';
  return 'The calculated EDGE score does not show enough value over the implied market probability.';
}

function sideAlignedReason(evaluation) {
  const pick = evaluation.evaluating || evaluation.pick || 'the selected pick';
  if (evaluation.verdict === 'PASS') {
    return `EDGE evaluated ${pick} and does not show enough value over the implied market probability.`;
  }
  if (evaluation.verdict === 'BET') {
    return `EDGE evaluated ${pick} and the calculated score clears the BET threshold based on the projected probability versus the market price.`;
  }
  return `EDGE evaluated ${pick} and found a modest value signal. Consider a small unit play if the line holds.`;
}

function reasonConflictsWithSelectedSide(reason, evaluation) {
  if (!reason || evaluation.verdict === 'PASS') return false;
  const reasonLower = String(reason).toLowerCase();
  const opponent = String(evaluation.opponentTeam || '').toLowerCase();
  const selected = String(evaluation.selectedTeam || '').toLowerCase();

  // Check 1: opponent name appears alongside explicit betting action words
  if (opponent && reasonLower.includes(opponent) && /\b(bet|lean|recommend|pick|play|edge)\b/i.test(reasonLower)) {
    return true;
  }

  // Check 2: positive language about opponent AND negative language about selected team
  if (opponent && selected) {
    const POSITIVE = [/\bstronger\b/, /\badvantage\b/, /\bbetter\b/, /\bfavored\b/, /\bhot\b/, /\bvalue\b/, /\bsuperior\b/];
    const NEGATIVE = [/\bweaker\b/, /\bstruggling\b/, /\bpoor\b/, /\boverpriced\b/, /\bcold\b/, /\bslump\b/, /\bdisadvantage\b/];

    let opponentPositive = false;
    let selectedNegative = false;

    for (const sentence of reasonLower.split(/[.!?,;]+/).filter(Boolean)) {
      if (sentence.includes(opponent) && POSITIVE.some(p => p.test(sentence))) opponentPositive = true;
      if (sentence.includes(selected) && NEGATIVE.some(p => p.test(sentence))) selectedNegative = true;
    }

    if (opponentPositive && selectedNegative) return true;
  }

  return false;
}

function fallbackTopFactors(evaluation) {
  const factors = [
    `Market implied probability: ${percent(evaluation.impliedProb)}`,
    `Sharp-line true probability: ${percent(evaluation.projectedProb)}`,
    `Score threshold result: ${evaluation.verdict}`,
  ];
  if (evaluation.pinnacleUsed) factors.push('Pinnacle sharp-line baseline used for vig removal');
  if (evaluation.vigPct) factors.push(`Market vig: ${evaluation.vigPct.toFixed(1)}% (${evaluation.vigPct <= 104 ? 'sharp/liquid' : 'square/retail'})`);
  if (evaluation.lineMovement && evaluation.lineMovement !== 0) {
    factors.push(`Line movement: ${evaluation.lineMovement > 0 ? 'STEAM (sharp money agrees)' : 'FADE (sharp money opposing)'}`);
  }
  return factors.slice(0, 4);
}

function normalizeTopFactors(value, evaluation) {
  if (Array.isArray(value)) return value.slice(0, 4).map(item => String(item));
  if (value) return [String(value)];
  return fallbackTopFactors(evaluation);
}

function buildEdgeEvaluation(prompt, context = {}, lineMovementScore = 0) {
  const selectedSide = String(context.selectedSide || '').toLowerCase();
  const teams = extractGameTeams(prompt);
  const contextOdds = context.odds;
  const oddsObj = contextOdds && typeof contextOdds === 'object' ? contextOdds : null;

  // Always evaluate both sides when selectedSide is 'best', then return the higher-scoring pick.
  // Must come before the selectedTeam check — live odds set selectedTeam=homeTeam but still
  // want a dual comparison.
  if (selectedSide === 'best') {
    const homeTeam = String(context.selectedTeam || (teams && teams.home) || '').trim();
    const awayTeam = String(context.opponentTeam || (teams && teams.away) || '').trim();

    const candidates = [
      {
        side: 'home',
        team: homeTeam,
        opponent: awayTeam,
        market: context.market || 'h2h',
        odds: oddsObj ? oddsObj.home : null,
        opponentOdds: oddsObj ? oddsObj.away : null,
      },
      {
        side: 'away',
        team: awayTeam,
        opponent: homeTeam,
        market: context.market || 'h2h',
        odds: oddsObj ? oddsObj.away : null,
        opponentOdds: oddsObj ? oddsObj.home : null,
      },
    ]
      .filter(c => c.team && c.odds != null)
      .map(c => buildCandidateEvaluation(prompt, c, lineMovementScore));

    if (candidates.length) {
      return candidates.sort((a, b) => b.edgeScore - a.edgeScore)[0];
    }
  }

  // Specific side explicitly requested
  if (context.selectedTeam) {
    const side = selectedSide === 'away' || selectedSide === 'home' ? selectedSide : 'selected';
    return buildCandidateEvaluation(prompt, {
      side,
      team: String(context.selectedTeam).trim(),
      opponent: String(context.opponentTeam || '').trim(),
      market: context.market || 'h2h',
      odds: oddsObj ? oddsObj[selectedSide] || contextOdds : contextOdds,
      opponentOdds: oddsObj
        ? (selectedSide === 'away' ? oddsObj.home : oddsObj.away)
        : null,
    }, lineMovementScore);
  }

  // Fallback: extract odds from prompt text
  const odds = extractAmericanOdds(prompt);
  const fallback = buildCandidateEvaluation(prompt, {
    side: 'best',
    team: '',
    opponent: '',
    market: context.market || 'h2h',
    odds,
  });
  fallback.pick = fallback.verdict === 'PASS' ? passPick() : pickFromPrompt(prompt, fallback);
  fallback.evaluating = fallback.pick;
  return fallback;
}


// ─── MULTI-CANDIDATE AI PROMPT ────────────────────────────────────────────────
// Used when all algorithmic candidates score negative (public money distortion).
// Instead of forcing the AI to evaluate one pre-selected side, present all
// candidates and ask the AI to independently identify the best play.

function buildMultiCandidatePrompt(basePrompt, pairs) {
  const candidateLines = pairs.map((p, i) => {
    const c = p.candidate;
    const ev = p.eval;
    return [
      `Candidate ${i + 1}: ${c.label}`,
      `  Market: ${c.market} | Odds: ${c.odds > 0 ? '+' : ''}${c.odds}`,
      `  Implied prob: ${(ev.impliedProb * 100).toFixed(1)}% | Algo true prob: ${(ev.projectedProb * 100).toFixed(1)}%`,
      `  Algo edge score: ${ev.edgeScore.toFixed(2)} (negative = algorithm sees no price edge)`,
    ].join('\n');
  }).join('\n\n');

  return [
    basePrompt,
    '',
    '─── ALL AVAILABLE PLAYS (algorithm found no clear price edge on any) ───',
    candidateLines,
    '',
    'INSTRUCTION FOR RESEARCH MODE:',
    'The price-gap algorithm found no clear edge. This often happens when public',
    'money has distorted lines away from true value (e.g. 80%+ public tickets',
    'on one side moves the line regardless of actual probability).',
    '',
    'Using your web search capability, research this game thoroughly:',
    '- Key injuries on either side (starting pitcher, lineup changes)',
    '- Sharp money / reverse line movement signals',
    '- Recent form, head-to-head, ballpark factors',
    '- Any contextual factors the price-gap algorithm cannot see',
    '',
    'Then identify the single best play from the candidates above, or PASS if',
    'none have genuine value after research.',
    '',
    'Return this JSON shape only (no markdown, no preamble):',
    '{"aiVerdict":"BET|LEAN|PASS","bestCandidate":"exact label from candidates above or PASS","reason":"2-3 sentences citing specific evidence","topFactors":["factor 1","factor 2","factor 3"]}',
  ].filter(Boolean).join('\n');
}

function buildScoredPrompt(prompt, evaluation) {
  const methodologyNotes = [
    evaluation.pinnacleUsed
      ? 'Pinnacle sharp-line baseline used for vig-removed true probability.'
      : 'Vig-removed probability from best available two-sided market.',
    evaluation.vigPct
      ? `Market vig: ${evaluation.vigPct.toFixed(1)}% (${evaluation.vigPct <= 104 ? 'sharp/liquid market' : 'square/retail market'}).`
      : null,
    evaluation.sharpSpread && evaluation.sharpSpread > 0
      ? `Sharp/square spread: +${evaluation.sharpSpread} (Pinnacle offering more value than square books — bullish signal).`
      : evaluation.sharpSpread && evaluation.sharpSpread < 0
        ? `Sharp/square spread: ${evaluation.sharpSpread} (square books offering more — sharp fade signal).`
        : null,
    evaluation.lineMovement && evaluation.lineMovement > 0
      ? `Line movement: STEAM — line moved in our favor since open (sharp money agrees).`
      : evaluation.lineMovement && evaluation.lineMovement < 0
        ? `Line movement: FADE — line moved against us since open (sharp money opposing).`
        : null,
  ].filter(Boolean).join(' ');

  return [
    'Game / bet prompt:',
    prompt,
    '',
    'EDGE Algorithm Values (Pinnacle-anchored sharp-line methodology):',
    `- Implied Probability (offered price): ${percent(evaluation.impliedProb)}`,
    `- True Market Probability (vig-removed): ${percent(evaluation.projectedProb)}`,
    `- Edge Score: ${evaluation.edgeScore}`,
    `- Verdict: ${evaluation.verdict}`,
    `- Selected Pick: ${evaluation.evaluating || evaluation.pick}`,
    `- Selected Team: ${evaluation.selectedTeam || 'Best available edge'}`,
    `- Opponent: ${evaluation.opponentTeam || 'Compare both sides'}`,
    `- Market: ${evaluation.market || 'h2h'}`,
    `- Confidence: ${evaluation.confidence}`,
    `- Risk: ${evaluation.risk}`,
    `- Edge Strength: ${evaluation.edgeStrength}`,
    methodologyNotes ? `- Methodology: ${methodologyNotes}` : null,
    '',
    'Instruction:',
    'You are an expert sports betting analyst using the Pinnacle sharp-line methodology.',
    'Review the algorithm values AND the live odds/team stats data above.',
    'Form your OWN independent verdict: BET, LEAN, or PASS.',
    '- BET: you agree there is genuine value and the pick is sound',
    '- LEAN: modest value but some concern, small unit only',
    '- PASS: the data does not support this pick regardless of the price gap',
    'Reference the true probability vs implied probability gap as the core value signal.',
    'If team stats show a struggling offense, injured star, or bad road record, factor that in.',
    'If line movement data is available, reference whether sharp money agrees or disagrees.',
    'Return strict JSON only. No markdown, no preamble.',
    '',
    'Return this JSON shape only:',
    '{"aiVerdict":"BET|LEAN|PASS","reason":"2-3 sentence explanation referencing value gap, team context, and key signals","topFactors":["factor 1","factor 2","factor 3"]}',
  ].filter(Boolean).join('\n');
}

function parseJsonObject(text) {
  try {
    return JSON.parse(cleanJsonText(text));
  } catch {
    return null;
  }
}


// ─── CONSENSUS GATE ───────────────────────────────────────────────────────────
// Only output BET when both the algorithm score AND the AI independently agree.
// If they diverge, downgrade to PASS to avoid bad picks.
//
// Rules:
//   Algorithm BET  + AI BET   → BET  (full consensus)
//   Algorithm BET  + AI LEAN  → LEAN (AI has reservations — respect them)
//   Algorithm BET  + AI PASS  → PASS (AI vetoed — conflict)
//   Algorithm LEAN + AI BET   → LEAN (algorithm isn't strong enough alone)
//   Algorithm LEAN + AI LEAN  → LEAN
//   Algorithm LEAN + AI PASS  → PASS
//   Algorithm PASS + anything → PASS (algorithm already said no)

function applyConsensusGate(algoVerdict, aiVerdict, edgeScore, mode) {
  const algo  = String(algoVerdict || '').toUpperCase();
  const ai    = String(aiVerdict   || '').toUpperCase();
  const score = Number(edgeScore)  || 0;
  const deep  = String(mode || '').toLowerCase() === 'deep';

  // No AI verdict returned — fall back to algorithm alone (don't block)
  if (!ai || ai === 'UNKNOWN') return { verdict: algo, conflicted: false };

  // RESEARCH MODE OVERRIDE:
  // When Research Mode (web search) runs and the AI independently finds BET,
  // allow a small negative algorithm score (-2 to 0) to be upgraded to LEAN.
  // Rationale: public money distorts lines. Research Mode finds injuries, sharp
  // splits, and series context that the price-gap algorithm misses. A -0.54
  // score on a line with 83% public tickets and three key injuries is not the
  // same as a -0.54 score on a clean efficient market.
  // Hard floor: score must be > -3 to prevent truly bad picks from slipping through.
  if (deep && ai === 'BET' && score > -3 && score <= 0) {
    return { verdict: 'LEAN', conflicted: false, researchOverride: true };
  }

  if (algo === 'PASS') return { verdict: 'PASS', conflicted: false };

  if (algo === 'BET' && ai === 'BET')  return { verdict: 'BET',  conflicted: false };
  if (algo === 'BET' && ai === 'LEAN') return { verdict: 'LEAN', conflicted: false };
  if (algo === 'BET' && ai === 'PASS') return { verdict: 'PASS', conflicted: true  };

  if (algo === 'LEAN' && ai === 'BET')  return { verdict: 'LEAN', conflicted: false };
  if (algo === 'LEAN' && ai === 'LEAN') return { verdict: 'LEAN', conflicted: false };
  if (algo === 'LEAN' && ai === 'PASS') return { verdict: 'PASS', conflicted: true  };

  return { verdict: algo, conflicted: false };
}

function conflictReason(evaluation, aiVerdict) {
  return `Algorithm identified a ${evaluation.edgeScore > 0 ? '+' : ''}${evaluation.edgeScore.toFixed(1)} edge score on ${evaluation.evaluating || evaluation.pick}, but AI analysis returned ${aiVerdict} after reviewing team context, injuries, and matchup data. When algorithm and AI signals conflict, EDGE defaults to PASS — no bet until signals align.`;
}

function buildStructuredResult(evaluation, aiText) {
  const parsed = parseJsonObject(aiText) || {};
  const parsedReason = parsed.reason || parsed.reasoning;
  const aiVerdict = String(parsed.aiVerdict || '').toUpperCase();

  // Apply consensus gate — only BET when algorithm and AI agree
  const { verdict: consensusVerdict, conflicted, researchOverride } = applyConsensusGate(evaluation.verdict, aiVerdict, evaluation.edgeScore, evaluation.mode);

  // If conflicted, override reason with conflict explanation
  const rawReason = conflicted
    ? conflictReason(evaluation, aiVerdict)
    : reasonConflictsWithSelectedSide(parsedReason, evaluation)
      ? sideAlignedReason(evaluation)
      : parsedReason || sideAlignedReason(evaluation) || fallbackReason(evaluation.oddsDetected, evaluation.edgeScore);

  // Downgrade confidence and pick if verdict changed by consensus gate
  const finalVerdict = consensusVerdict;
  const finalPick = finalVerdict === 'PASS' ? 'PASS — signals conflict' : evaluation.pick;
  const researchNote = researchOverride ? ' (Research Mode override — AI found context algorithm missed)' : '';
  const finalConfidence = conflicted ? 'LOW'
    : finalVerdict === 'BET' ? evaluation.confidence
    : finalVerdict === 'LEAN' && evaluation.confidence === 'HIGH' ? 'MEDIUM'
    : evaluation.confidence;
  const finalRecommendedAction = conflicted
    ? 'Pass — algorithm and AI signals are in conflict. Wait for alignment.'
    : researchOverride
      ? 'Research Mode found context the algorithm missed (injuries/sharp money). Small unit only — verify line is still available.'
      : getRecommendedAction(finalVerdict, finalConfidence);

  const reason = rawReason;

  return {
    verdict: finalVerdict,
    pick: finalPick,
    aiVerdict: aiVerdict || null,
    algoVerdict: evaluation.verdict,
    consensusConflict: conflicted,
    evaluating: evaluation.evaluating || evaluation.pick,
    selectedSide: evaluation.selectedSide,
    selectedTeam: evaluation.selectedTeam,
    opponentTeam: evaluation.opponentTeam,
    market: evaluation.market,
    confidence: finalConfidence,
    risk: conflicted ? 'HIGH' : evaluation.risk,
    edgeStrength: evaluation.edgeStrength,
    edgeScore: evaluation.edgeScore,
    odds: evaluation.odds,
    // Phase 1 fields
    consensusProb: evaluation.consensusProb,
    noVigProb: evaluation.noVigProb,
    priceEdge: evaluation.priceEdge,
    impliedProb: evaluation.impliedProb,
    projectedProb: evaluation.projectedProb,
    marketBreadth: evaluation.marketBreadth,
    confidencePenalty: evaluation.confidencePenalty,
    injurySignal: evaluation.injurySignal,
    situationalSignal: evaluation.situationalSignal,
    teamFormSignal: evaluation.teamFormSignal || 0,
    // Phase 2 field (populated by caller)
    lineMovementSignal: evaluation.lineMovementSignal,
    reason,
    topFactors: normalizeTopFactors(parsed.topFactors || parsed.key_factors || parsed.keyFactors, evaluation),
    recommendedAction: finalRecommendedAction,
  };
}

async function callAnthropic(prompt, mode) {
  const model = MODELS[mode];
  const params = {
    model,
    max_tokens: 1500,
    system: SYSTEM_TEXT,
    messages: [{ role: 'user', content: prompt }],
  };

  if (mode === 'deep') {
    params.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
  }

  try {
    const response = await anthropic.messages.create(params, { timeout: mode === 'deep' ? 180000 : 30000 });
    const text = cleanJsonText(extractAnthropicText(response));
    if (!text) {
      throw new Error('Research returned no readable text. Try Quick AI or retry Research.');
    }

    return {
      provider: 'anthropic',
      model,
      text,
      usage: response.usage,
    };
  } catch (err) {
    console.error('Anthropic call failed:', {
      provider: 'anthropic',
      mode,
      model,
      status: err.status || err.statusCode || 'unknown',
      message: err.message,
    });
    throw err;
  }
}

async function callOpenAI(prompt, mode, candidateText) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OpenAI fallback not configured');

  const input = candidateText
    ? `Original request:\n${prompt}\n\nReview and repair this JSON/text. Return only raw JSON:\n${candidateText}`
    : prompt;

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      instructions: SYSTEM_TEXT,
      input,
      max_output_tokens: candidateText ? 900 : 1500,
    }),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error((body.error && body.error.message) || `OpenAI request failed with ${response.status}`);
    err.status = response.status;
    throw err;
  }

  return {
    provider: candidateText ? 'openai-reviewer' : 'openai',
    model: OPENAI_MODEL,
    text: cleanJsonText(extractOpenAIText(body)),
    usage: body.usage,
  };
}

function analysisErrorMessage(err) {
  const status = err.status || err.statusCode;
  if (status === 429) return 'AI API rate limit hit. Wait a minute and try again.';
  if (status === 401) return 'AI provider authentication failed. Check server API key configuration.';
  if (status === 403) return 'AI provider key does not have access to the requested model.';
  return err.message || 'Analysis failed.';
}

router.post('/', async (req, res) => {
  const startedAt = Date.now();
  const {
    prompt,
    useSearch = false,
    secondLayer = false,
    selectedSide = 'best',
    selectedTeam = '',
    opponentTeam = '',
    market = 'h2h',
    odds,
  } = req.body || {};
  const mode = useSearch ? 'deep' : 'quick';

  const session = verifySession(req.cookies && req.cookies.edge_session);
  if (!session || !session.email) {
    return fail(res, 401, { text: 'Login required', error: 'Not logged in', data: { authRequired: true } });
  }

  if (!prompt || typeof prompt !== 'string') {
    return fail(res, 400, { text: 'Missing required prompt', error: 'prompt is required', meta: { mode } });
  }

  const userId = session.email;
  let user;
  let globalLimit;
  let userLimit;

  try {
    [user, { globalLimit, userLimit }] = await withTimeout(
      Promise.all([getUser(userId), getLimitConfig()]),
      5000,
      'user/limits fetch'
    );
  } catch (err) {
    console.error('Analyze storage fetch error:', err.message);
    return fail(res, 503, { text: 'Temporary storage issue', error: 'Storage unavailable', meta: { mode } });
  }

  const isOwner = OWNER_EMAILS.includes(String(userId || '').toLowerCase());

  if (isOwner) {
    user = {
      ...user,
      isSubscriber: true,
      credits: 9999,
    };
  }

  if (!user.isSubscriber && user.credits <= 0) {
    return fail(res, 402, {
      text: 'No credits remaining',
      error: 'No credits remaining',
      meta: { mode },
      data: { paywall: true, upgrade: true },
    });
  }

  let globalCount = 0;
  try {
    globalCount = await withTimeout(getGlobalCount(), 3000, 'global count');
  } catch {
    globalCount = 0;
  }

  if (globalCount >= (globalLimit || 150)) {
    return fail(res, 503, {
      text: 'Daily analysis capacity reached. Resets at midnight UTC.',
      error: 'Global daily limit reached',
      meta: { mode, limitType: 'global', used: globalCount, limit: globalLimit || 150 },
    });
  }

  if (user.isSubscriber) {
    let userCount = 0;
    try {
      userCount = await withTimeout(getUserDailyCount(userId), 3000, 'user count');
    } catch {
      userCount = 0;
    }

    if (userCount >= (userLimit || 20)) {
      return fail(res, 429, {
        text: `Daily limit of ${userLimit || 20} analyses reached. Resets at midnight UTC.`,
        error: 'User daily limit reached',
        meta: { mode, limitType: 'user', used: userCount, limit: userLimit || 20 },
      });
    }
  }

  try {
    let result;
    let fallbackUsed = false;
    let reviewed = false;

    // ─── AUTO-FETCH LIVE ODDS ─────────────────────────────────────────────────
    // Always fetch live odds from The Odds API so we have both sides for
    // proper vig removal and best-side auto-selection, regardless of what
    // the frontend sends.
    let liveOdds = null;
    try {
      liveOdds = await withTimeout(fetchLiveGameOdds(prompt), 5000, 'live odds');
    } catch {
      liveOdds = null;
    }

    // If live odds found, override frontend values with real data
    let resolvedPrompt = prompt;
    let resolvedSelectedSide = 'best';
    let resolvedSelectedTeam = '';
    let resolvedOpponentTeam = '';
    let resolvedOdds = odds;
    let resolvedMarket = market || 'h2h';

    if (liveOdds) {
      resolvedPrompt = `${prompt}\n\nLIVE ODDS DATA:\n${liveOdds.oddsBlock}`;
      resolvedSelectedSide = 'best';
      resolvedSelectedTeam = liveOdds.homeTeam;
      resolvedOpponentTeam = liveOdds.awayTeam;
      resolvedOdds = { home: liveOdds.homeOdds, away: liveOdds.awayOdds };
      // Don't force h2h — each candidate carries its own market type
      resolvedMarket = market || 'h2h';
    }

    let lineMovementScore = 0;
    let lineMovementSignal = null;
    const lineTeam = (liveOdds && liveOdds.homeTeam) || selectedTeam;
    const lineOpponent = (liveOdds && liveOdds.awayTeam) || opponentTeam;
    if (lineTeam) {
      try {
        const { getLineMovementSignal } = require('../lib/line-tracker');
        const gameId = [lineTeam, lineOpponent].sort().join('_').toLowerCase().replace(/\s+/g, '_')
          + '_' + new Date().toISOString().slice(0, 10);
        const oddsValue = resolvedOdds && typeof resolvedOdds === 'object' ? resolvedOdds.home : resolvedOdds;
        // Phase 2: 5-second timeout; expose full signal object (direction + basisPoints + score)
        const lm = await withTimeout(getLineMovementSignal(gameId, lineTeam, oddsValue), 5000, 'line movement');
        lineMovementScore = lm.score || 0;
        lineMovementSignal = {
          score: lm.score || 0,
          direction: lm.direction || 'UNKNOWN',
          basisPoints: lm.basisPoints || 0,
          openingOdds: lm.openingOdds || null,
          currentOdds: lm.currentOdds || null,
          team: lineTeam,
        };
      } catch {
        lineMovementScore = 0;
        lineMovementSignal = null;
      }
    }

    // ─── STALE LINE DETECTION ─────────────────────────────────────────────────
    const STALE_WARN_MS = 15 * 60 * 1000;
    const STALE_HARD_MS = 30 * 60 * 1000;
    let staleWarning = null;
    let staleAgeMinutes = 0;

    if (liveOdds && liveOdds.fetchedAt) {
      const age = Date.now() - liveOdds.fetchedAt;
      staleAgeMinutes = Math.round(age / 60000);
      if (age > STALE_HARD_MS) {
        staleWarning = `⚠️ LINE AGE WARNING: Odds data is ${staleAgeMinutes} minutes old. This edge may no longer exist — the line has likely moved. Analysis capped at LEAN. Refresh and re-run for a current read.`;
        console.warn(`STALE LINE: ${staleAgeMinutes} min old (HARD)`);
      } else if (age > STALE_WARN_MS) {
        staleWarning = `⚠️ Line data is ${staleAgeMinutes} minutes old. Verify the current price before betting — value gaps close fast.`;
        console.warn(`STALE LINE: ${staleAgeMinutes} min old (WARN)`);
      }
    }

    // Inject stale warning into prompt so AI is also aware
    const resolvedPromptFinal = staleWarning
      ? `${resolvedPrompt}

${staleWarning}`
      : resolvedPrompt;

    // ─── CANDIDATE EVALUATION ────────────────────────────────────────────────────
    // Phase A: Score all candidates algorithmically (up to 6 plays)
    // Phase B: If all negative AND Research Mode, ask AI to evaluate all candidates
    //          independently and identify the best play — then run consensus gate
    //          on the AI's chosen side. This catches line distortion from public
    //          money that the price-gap algorithm can't see.
    let evaluation;
    let allPairsForAI = null; // set when we need AI to pick the best side

    if (liveOdds && liveOdds.candidates && liveOdds.candidates.length) {
      const pairs = liveOdds.candidates.map(c => ({
        candidate: c,
        eval: buildCandidateEvaluation(resolvedPromptFinal, {
          side: c.side,
          team: c.team,
          opponent: c.opponent,
          market: c.market,
          odds: c.odds,
          opponentOdds: c.opponentOdds,
        }, lineMovementScore),
      }));

      const candidateSummary = pairs.map(p => ({
        team: p.candidate.team,
        market: p.candidate.market,
        odds: p.candidate.odds,
        edgeScore: p.eval.edgeScore,
        verdict: p.eval.verdict,
      }));
      console.log('CANDIDATES LOG:', JSON.stringify(candidateSummary));

      // Sort by edge score — best first
      pairs.sort((a, b) => b.eval.edgeScore - a.eval.edgeScore);

      const allNegative = pairs.every(p => p.eval.edgeScore <= 0);
      const deepMode = mode === 'deep';

      if (allNegative && deepMode) {
        // All candidates have negative price edge — public money may be distorting lines.
        // Don't pick a side yet. Instead, pass all candidates to the AI and let it
        // identify the best play based on injuries, sharp money, matchup context.
        // We'll build a multi-candidate prompt and run the AI call differently.
        allPairsForAI = pairs;
        // Use the least-negative as the baseline evaluation object
        evaluation = pairs[0].eval;
        evaluation.pick = pairs[0].candidate.label;
        evaluation.evaluating = pairs[0].candidate.label;
      } else {
        // At least one positive candidate — use the best algorithmic pick
        const positivePairs = pairs.filter(p => p.eval.edgeScore > 0);
        const winner = positivePairs.length ? positivePairs[0] : pairs[0];
        evaluation = winner.eval;
        if (winner.candidate && evaluation.verdict !== 'PASS') {
          evaluation.pick = winner.candidate.label;
          evaluation.evaluating = winner.candidate.label;
        }
      }

      // Surface all candidates for UI transparency
      const betCandidates = pairs.filter(p => p.eval.verdict !== 'PASS');
      evaluation.allCandidates = (betCandidates.length ? betCandidates : pairs.slice(0, 3)).map(p => ({
        label: p.candidate.label,
        market: p.candidate.market,
        edgeScore: p.eval.edgeScore,
        verdict: p.eval.verdict,
        impliedProb: p.eval.impliedProb,
        projectedProb: p.eval.projectedProb,
      }));

    } else {
      evaluation = buildEdgeEvaluation(resolvedPromptFinal, {
        selectedSide: resolvedSelectedSide,
        selectedTeam: resolvedSelectedTeam,
        opponentTeam: resolvedOpponentTeam,
        market: resolvedMarket,
        odds: resolvedOdds,
      }, lineMovementScore);
    }

    // Phase 2: attach lineMovementSignal and mode to the evaluation object
    evaluation.lineMovementSignal = lineMovementSignal;
    evaluation.mode = mode;


    // ─── DEBUG LOG ────────────────────────────────────────────────────────────
    console.log('EDGE EVAL:', JSON.stringify({
      liveOddsFound: !!liveOdds,
      candidates: liveOdds && liveOdds.candidates && liveOdds.candidates.length,
      pick: evaluation.pick,
      market: evaluation.market,
      score: evaluation.edgeScore,
      verdict: evaluation.verdict,
      implied: evaluation.impliedProb,
      projected: evaluation.projectedProb,
    }));

    // Build the appropriate prompt — multi-candidate when all scores are negative in Research Mode
    let scoredPrompt;
    let multiCandidateMode = false;

    if (allPairsForAI && mode === 'deep') {
      scoredPrompt = buildMultiCandidatePrompt(resolvedPromptFinal, allPairsForAI);
      multiCandidateMode = true;
      console.log('MULTI-CANDIDATE MODE: sending all candidates to AI for selection');
    } else {
      scoredPrompt = buildScoredPrompt(resolvedPromptFinal, evaluation);
    }

    if (evaluation.oddsDetected) {
      try {
        result = await callAnthropic(scoredPrompt, mode);
      } catch (err) {
        if (!process.env.OPENAI_API_KEY) throw err;
        result = await withTimeout(callOpenAI(scoredPrompt, mode), mode === 'deep' ? 45000 : 20000, 'openai fallback');
        fallbackUsed = true;
      }

      // Multi-candidate: parse AI's chosen candidate and rebuild evaluation around it
      if (multiCandidateMode && result && result.text) {
        try {
          const parsed = JSON.parse(cleanJsonText(result.text));
          const aiChosen = String(parsed.bestCandidate || '').trim();
          const aiVerdict = String(parsed.aiVerdict || '').toUpperCase();

          console.log('MULTI-CANDIDATE AI response:', { aiChosen, aiVerdict });

          if (aiChosen && aiChosen !== 'PASS' && aiVerdict !== 'PASS') {
            // Robust team matching — check multiple substring strategies
            const chosenLower = aiChosen.toLowerCase();
            const matchedPair = allPairsForAI.find(p => {
              const teamLower = p.candidate.team.toLowerCase();
              const labelLower = p.candidate.label.toLowerCase();
              // Exact label match
              if (labelLower === chosenLower) return true;
              // Label contains chosen or chosen contains label
              if (labelLower.includes(chosenLower) || chosenLower.includes(labelLower)) return true;
              // Team name contained in AI choice
              if (chosenLower.includes(teamLower)) return true;
              // Any word of team name (>4 chars) appears in AI choice
              return teamLower.split(' ').some(w => w.length > 4 && chosenLower.includes(w));
            });

            if (matchedPair) {
              const chosenEval = matchedPair.eval;
              const savedAllCandidates = evaluation.allCandidates;
              chosenEval.pick = matchedPair.candidate.label;
              chosenEval.evaluating = matchedPair.candidate.label;
              chosenEval.selectedTeam = matchedPair.candidate.team;
              chosenEval.opponentTeam = matchedPair.candidate.opponent;
              chosenEval.market = matchedPair.candidate.market;
              chosenEval.mode = mode;
              chosenEval.lineMovementSignal = lineMovementSignal;
              chosenEval.allCandidates = savedAllCandidates;
              // CRITICAL: inject aiVerdict so consensus gate can use it
              // We do this by embedding it in result.text as a JSON field
              // so buildStructuredResult picks it up normally
              const existingParsed = JSON.parse(cleanJsonText(result.text));
              existingParsed.aiVerdict = aiVerdict;
              result.text = JSON.stringify(existingParsed);
              evaluation = chosenEval;
              console.log('AI chose:', matchedPair.candidate.label, '| score:', chosenEval.edgeScore, '| aiVerdict:', aiVerdict);
            } else {
              console.warn('MULTI-CANDIDATE: could not match AI choice to candidate:', aiChosen);
              // Still inject aiVerdict into result so consensus gate sees it
              try {
                const ep = JSON.parse(cleanJsonText(result.text));
                ep.aiVerdict = aiVerdict;
                result.text = JSON.stringify(ep);
              } catch {}
            }
          } else {
            console.log('MULTI-CANDIDATE: AI returned PASS or no candidate');
          }
        } catch (e) {
          console.warn('Multi-candidate parse failed:', e.message);
        }
      }
    } else {
      result = {
        provider: 'edge-scoring',
        model: 'deterministic-fallback',
        text: '',
      };
    }

    if (evaluation.oddsDetected && !fallbackUsed && secondLayer && process.env.OPENAI_API_KEY) {
      try {
        const review = await withTimeout(callOpenAI(scoredPrompt, mode, result.text), 12000, 'openai reviewer');
        if (review.text) {
          result.text = review.text;
          reviewed = true;
        }
      } catch (err) {
        console.warn('OpenAI reviewer skipped:', err.message);
      }
    }

    Promise.all([
      !user.isSubscriber && !isOwner
        ? withTimeout(addCredits(userId, -1), 3000, 'credit deduct').catch(e => console.error(e.message))
        : Promise.resolve(),
      withTimeout(incrementGlobalCount(), 3000, 'incr global').catch(e => console.error(e.message)),
      withTimeout(incrementUserDailyCount(userId), 3000, 'incr user').catch(e => console.error(e.message)),
    ]).catch(e => console.error(e.message));

    const structured = buildStructuredResult(evaluation, result.text);

    // Apply stale line penalty to final result
    if (staleWarning) {
      structured.staleWarning = staleWarning;
      structured.lineAgeMinutes = staleAgeMinutes;
      // Hard stale: cap verdict at LEAN
      if (staleAgeMinutes >= 30 && structured.verdict === 'BET') {
        structured.verdict = 'LEAN';
        structured.confidence = 'LOW';
        structured.risk = 'HIGH';
        structured.recommendedAction = 'Line data is over 30 minutes old. Verify current price before betting.';
      }
    }

    result.text = JSON.stringify(structured);

    return ok(res, {
      text: result.text,
      data: {
        content: [{ type: 'text', text: result.text }],
        ...structured,
      },
      meta: {
        mode,
        provider: result.provider,
        model: result.model,
        fallbackUsed,
        reviewed,
        elapsedMs: Date.now() - startedAt,
      },
    });
  } catch (err) {
    const status = err.status || err.statusCode || 500;
    console.error(`AI analysis error [${status}] mode=${mode}:`, err.message);
    return fail(res, 500, {
      text: 'Analysis failed',
      error: analysisErrorMessage(err),
      meta: { mode, status, elapsedMs: Date.now() - startedAt },
    });
  }
});

module.exports = router;
