const express = require('express');
const router = express.Router();
const Anthropic = require('@anthropic-ai/sdk');
const { jsonrepair } = require('jsonrepair');
const { getUser, addCredits } = require('../lib/users');
const { verifySession } = require('../lib/auth');
const { ok, fail } = require('../lib/http');
const { OWNER_EMAILS } = require('../lib/owners');
const { hasRedisConfig, createRedis } = require('../lib/redis');
const { getConfig, isShowdownSlots } = require('../src/sports/sportConfigs');
const { generateOptimalLineup, isMlbPitcher: isMlbPitcherFD } = require('../src/components/dfsSolver');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Prevent Vercel edge caching on all DFS routes — responses are always dynamic
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  next();
});

const memoryWeatherCache = new Map();
const WEATHER_TTL_SEC = 30 * 60;

// ── Odds API props + credits cache (Redis in prod, in-memory in dev) ──────────
const memoryPropsCache  = new Map();
const PROPS_CACHE_TTL   = 2 * 60 * 60 * 1000; // 2 hours in ms
const CREDITS_REDIS_KEY = 'edge:dfs:credits';

// ── Odds API player-prop enrichment constants ─────────────────────────────────
const PROP_SPORT_KEY = {
  nba: 'basketball_nba',
  nfl: 'americanfootball_nfl',
  mlb: 'baseball_mlb',
};
const PROP_MARKETS = {
  nba: ['player_fantasy_points', 'player_points'],
  nfl: ['player_fantasy_points', 'player_pass_yds', 'player_rush_yds', 'player_reception_yds'],
  mlb: ['player_fantasy_points', 'player_strikeouts', 'player_hits_runs_rbis'],
};
const PROP_STD_DEV     = { mlb: 0.35, nfl: 0.22, golf: 0.22, nba: 0.15 };
const PROP_DEFAULT_OWN = 15.0;

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

// ── Props cache helpers ───────────────────────────────────────────────────────

async function getCachedProps(key) {
  if (hasRedisConfig()) {
    try {
      const redis = createRedis();
      const val = await withTimeout(redis.get(key), 3000, 'props-cache-get');
      if (!val) return null;
      const parsed = JSON.parse(val);
      // Empty array = previous failed fetch was cached; treat as miss and evict
      if (Array.isArray(parsed) && parsed.length === 0) {
        redis.del(key).catch(() => {});
        return null;
      }
      return parsed;
    } catch { return null; }
  }
  const entry = memoryPropsCache.get(key);
  if (!entry || entry.expiresAt <= Date.now()) return null;
  // Empty array = stale failed fetch; evict from memory cache
  if (Array.isArray(entry.value) && entry.value.length === 0) {
    memoryPropsCache.delete(key);
    return null;
  }
  return entry.value;
}

async function setCachedProps(key, value) {
  const ttlSec = Math.round(PROPS_CACHE_TTL / 1000);
  if (hasRedisConfig()) {
    try {
      const redis = createRedis();
      await withTimeout(redis.set(key, JSON.stringify(value), { ex: ttlSec }), 3000, 'props-cache-set');
    } catch { /* non-fatal */ }
  } else {
    memoryPropsCache.set(key, { value, expiresAt: Date.now() + PROPS_CACHE_TTL });
  }
}

async function storeOddsCredits(remaining, used) {
  const payload = JSON.stringify({
    remaining: Number(remaining),
    used:      Number(used) || null,
    updatedAt: new Date().toISOString(),
  });
  if (hasRedisConfig()) {
    try {
      const redis = createRedis();
      await withTimeout(redis.set(CREDITS_REDIS_KEY, payload, { ex: 86400 }), 3000, 'credits-store');
    } catch { /* non-fatal */ }
  } else {
    memoryPropsCache.set(CREDITS_REDIS_KEY, {
      value: JSON.parse(payload),
      expiresAt: Date.now() + 86400 * 1000,
    });
  }
}

async function getOddsCredits() {
  if (hasRedisConfig()) {
    try {
      const redis = createRedis();
      const val = await withTimeout(redis.get(CREDITS_REDIS_KEY), 3000, 'credits-get');
      return val ? JSON.parse(val) : null;
    } catch { return null; }
  }
  const entry = memoryPropsCache.get(CREDITS_REDIS_KEY);
  return (entry && entry.expiresAt > Date.now()) ? entry.value : null;
}

// ── NBA defensive stat cache (blk/stl per game) ───────────────────────────────

function _defKey(normalizedName) {
  return `edge:dfs:defstats:nba:${normalizedName.replace(/[^a-z0-9]/g, '-')}`;
}

async function _getDefCache(normalizedName) {
  const key = _defKey(normalizedName);
  if (hasRedisConfig()) {
    try {
      const redis = createRedis();
      const val = await withTimeout(redis.get(key), 2000, 'defstats-get');
      return val ? JSON.parse(val) : null;
    } catch { return null; }
  }
  const entry = memoryPropsCache.get(key);
  return (entry && entry.expiresAt > Date.now()) ? entry.value : null;
}

async function _setDefCache(normalizedName, stats, ttlSec = 86400) {
  const key = _defKey(normalizedName);
  if (hasRedisConfig()) {
    try {
      const redis = createRedis();
      await withTimeout(redis.set(key, JSON.stringify(stats), { ex: ttlSec }), 2000, 'defstats-set');
    } catch { /* non-fatal */ }
  } else {
    memoryPropsCache.set(key, { value: stats, expiresAt: Date.now() + ttlSec * 1000 });
  }
}

/**
 * Fetches 2025-26 NBA blocks/steals per game for the given players via
 * Anthropic web search. Results are cached in Redis for 24 hours per player.
 * Returns a Map of normalizedName → { blk, stl }.
 * Non-fatal: any failure returns an empty map.
 */
async function fetchNbaDefStats(players) {
  const result  = new Map();
  const uncached = [];

  // Check cache in parallel — avoid repeated Redis round-trips
  await Promise.all(players.map(async p => {
    const nkey   = normalizeName(p.name);
    const cached = await _getDefCache(nkey);
    if (cached) result.set(nkey, cached);
    else uncached.push(p);
  }));

  if (!uncached.length) return result;

  // Cap at the 25 highest-salary uncached players to bound search time
  const toFetch = [...uncached]
    .sort((a, b) => (b.salary || 0) - (a.salary || 0))
    .slice(0, 25);

  const nameList = toFetch.map(p => p.name).join(', ');

  const prompt =
    `Search for the 2025-26 NBA regular-season averages for each of these players ` +
    `and return ONLY raw JSON — no markdown, no comments.\n` +
    `Format: { "Exact Player Name": { "blk": 1.4, "stl": 0.8 }, ... }\n` +
    `Use web_search for each player to find blocks per game (blk) and steals per game (stl).\n` +
    `Players: ${nameList}\n` +
    `Start response with { and end with }.`;

  let response;
  try {
    response = await anthropic.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      system:     'Return NBA blocks/steals stats as raw JSON only. Use web_search per player.',
      messages:   [{ role: 'user', content: prompt }],
      tools:      [{ type: 'web_search_20250305', name: 'web_search' }],
    }, { timeout: 25000 });
  } catch (err) {
    console.log('[DEF] Anthropic call failed:', err.message);
    return result;
  }

  const rawText = (response.content || [])
    .filter(b => b.type === 'text' && b.text)
    .map(b => b.text)
    .join('\n')
    .trim();

  let statsMap;
  try {
    const match = rawText.match(/\{[\s\S]*\}/);
    if (match) {
      const clean = cleanJson(match[0]);
      try { statsMap = JSON.parse(clean); }
      catch { statsMap = JSON.parse(jsonrepair(clean)); }
    }
  } catch { /* non-fatal — falls through to position proxy */ }

  await Promise.all(toFetch.map(async p => {
    const nkey = normalizeName(p.name);

    // Match response key to player (case/accent insensitive)
    let raw = null;
    if (statsMap) {
      const found = Object.entries(statsMap).find(([k]) => normalizeName(k) === nkey);
      if (found) raw = found[1];
    }

    const blk   = raw ? +(Number(raw.blk) || 0).toFixed(1) : 0;
    const stl   = raw ? +(Number(raw.stl) || 0).toFixed(1) : 0;
    const noData = !raw;
    const entry = { blk, stl, noData };

    result.set(nkey, entry);
    // Cache found stats 24 h; "not found" entries only 1 h so a retry fires sooner
    await _setDefCache(nkey, entry, noData ? 3600 : 86400);

    if (!noData) {
      const bonus = blk > 1.5 || stl > 1.0 ? '→ ×1.15' : '';
      console.log(`[DEF] ${p.name}: blk=${blk} stl=${stl} ${bonus}`);
    }
  }));

  return result;
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
  fanduel: { nba: 60000, nfl: 60000, mlb: 35000 },
};

const LINEUP_SLOTS = {
  nba: { fanduel: ['MVP', 'STAR', 'STAR', 'PRO', 'PRO', 'UTIL'] },
  nfl: { fanduel: ['QB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE', 'FLEX', 'K'] },
  mlb: { fanduel: ['P', 'C/1B', '2B', '3B', 'SS', 'OF', 'OF', 'OF', 'UTIL'] },
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
    if (!res.ok) {
      console.warn(`[Odds] fetchOddsData sportKey="${sportKey}" HTTP ${res.status} — returning empty`);
      return [];
    }
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

// ── Player-prop helper functions ──────────────────────────────────────────────

function normalizeName(raw) {
  return String(raw || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+(jr\.?|sr\.?|ii{1,3}|iv|v)$/i, '')
    .replace(/[\u2018\u2019\u201a\u201b\u0060\u00b4']/g, '')
    .replace(/\./g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+[a-z]\s+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function estimateFppgFromProp(line, market, position) {
  if (market === 'player_fantasy_points') return line;
  const pos = String(position || '').toUpperCase();
  if (market === 'player_pass_yds')       return +(line * 0.04 * 1.30).toFixed(1);
  if (market === 'player_rush_yds')       return +(line * 0.10 * (pos.includes('RB') ? 1.30 : 1.20)).toFixed(1);
  if (market === 'player_reception_yds')  return +(line * 0.10 * 1.20).toFixed(1);
  if (market === 'player_strikeouts')     return +(line * 3.0).toFixed(1);
  if (market === 'player_hits_runs_rbis') return +(line * 2.0).toFixed(1);
  if (market === 'player_points')         return +(line * 1.80).toFixed(1);
  return null;
}

function enrichPlayersWithProps(players, props, sport) {
  const stdDevMult = PROP_STD_DEV[sport] || 0.20;

  // Group all raw props: normalizedName → market → [{ line, bookmaker }]
  const byPlayer = new Map();
  for (const prop of props) {
    const key = normalizeName(prop.playerName);
    if (!byPlayer.has(key)) byPlayer.set(key, new Map());
    const byMarket = byPlayer.get(key);
    if (!byMarket.has(prop.market)) byMarket.set(prop.market, []);
    byMarket.get(prop.market).push({ line: prop.line, bookmaker: prop.bookmaker });
  }

  let matchedCount  = 0;
  let fallbackCount = 0;
  let wembyMatched  = false;

  const enriched = players.map(p => {
    const key      = normalizeName(p.name);
    let byMarket   = byPlayer.get(key);
    const isWemb   = p.name.toLowerCase().includes('wemb');

    // Last-name fallback: handles API name mismatches like "V. Wembanyama" vs "Victor Wembanyama".
    // Only fires when exactly ONE prop-map entry shares the surname (avoids Williams/Johnson collisions).
    if (!byMarket) {
      const nameParts = key.split(' ');
      const lastName  = nameParts[nameParts.length - 1];
      if (lastName && lastName.length > 3) {
        const lastNameMatches = [...byPlayer.entries()].filter(
          ([propKey]) => propKey.split(' ').pop() === lastName
        );
        if (lastNameMatches.length === 1) {
          byMarket = lastNameMatches[0][1];
          fallbackCount++;
        }
      }
    }

    if (isWemb && byMarket) wembyMatched = true;

    const csvBase = Number(p.fppg) || Number(p.FPPG) || Number(p.projection) || Number(p.Projection) || 0;

    let projection    = 0;
    let _projSource   = null;
    let _propEnriched = false;
    let _propMarket   = null;
    let floorFppg     = null;
    let ceilingFppg   = null;

    if (byMarket) {
      // Tier 1: player_fantasy_points — direct DFS line, no multiplier needed
      if (byMarket.has('player_fantasy_points')) {
        const entries = byMarket.get('player_fantasy_points');
        const fd = entries.find(e => e.bookmaker === 'fanduel');
        const dk = entries.find(e => e.bookmaker === 'draftkings');
        const e  = fd || dk || entries[0];   // guard: fall back to first entry if neither FD nor DK
        if (e) {
          let line, srcNote;
          if (fd && dk) {
            line    = +((fd.line + dk.line) / 2).toFixed(1);
            srcNote = `avg FD ${fd.line} / DK ${dk.line}`;
          } else {
            line    = e.line;
            srcNote = e.bookmaker;
          }
          projection    = line;
          _projSource   = `Proj: ${projection} (${srcNote} DFS pts)`;
          _propEnriched = true;
          _propMarket   = 'player_fantasy_points';
        }
      }
      // Tier 2: player_points × 1.8 DFS multiplier (pts + reb/ast/stl/blk)
      else if (byMarket.has('player_points')) {
        const entries = byMarket.get('player_points');
        const fd = entries.find(e => e.bookmaker === 'fanduel');
        const dk = entries.find(e => e.bookmaker === 'draftkings');
        const e  = fd || dk || entries[0];   // guard: fall back to first entry if neither FD nor DK
        if (e) {
          let rawLine, srcNote;
          if (fd && dk) {
            rawLine = +((fd.line + dk.line) / 2).toFixed(1);
            srcNote = `avg FD ${fd.line} / DK ${dk.line}`;
          } else {
            rawLine = e.line;
            srcNote = e.bookmaker;
          }
          projection    = +(rawLine * 1.8).toFixed(1);
          _projSource   = `Proj: ${projection} (${rawLine} pts × 1.8 DFS multiplier)`;
          _propEnriched = true;
          _propMarket   = 'player_points';
        }
      }
    }

    // Defensive bonus: player_points prop captures scoring only — blocks (2 pts) and
    // steals (2 pts) are invisible to it. Apply 1.15x for confirmed defensive anchors
    // (blk > 1.5 or stl > 1.0), or 1.10x for centers with no block/steal data in CSV.
    // Skipped for player_fantasy_points (already includes all defensive stats).
    if (_propMarket === 'player_points' && sport === 'nba' && projection > 0) {
      const hasDefData = p.blocksPerGame != null || p.stealsPerGame != null;
      const blk = Number(p.blocksPerGame) || 0;
      const stl = Number(p.stealsPerGame) || 0;
      if (blk > 1.5 || stl > 1.0) {
        projection    = +(projection * 1.15).toFixed(1);
        _projSource  += ' [+def ×1.15 blk/stl]';
        console.log(`[Props] Def bonus 1.15x: ${p.name} blk=${blk} stl=${stl} → ${projection}`);
      } else if (!hasDefData) {
        const pos = String(p.position || '').toUpperCase();
        if (pos.includes('C')) {
          projection   = +(projection * 1.10).toFixed(1);
          _projSource += ' [+def ×1.10 C-proxy]';
          console.log(`[Props] Def bonus 1.10x: ${p.name} (C proxy, no blk/stl data) → ${projection}`);
        }
      }
    }

    // Fall back to CSV FPPG when no Odds API prop line found
    if (projection <= 0) {
      projection = csvBase;
      if (csvBase > 0) {
        _projSource = `Proj: ${csvBase.toFixed(1)} (CSV FPPG — no Odds API prop line)`;
      } else {
        console.warn('[Props] zero projection:', p.name, p.salary);
      }
    }

    if (projection > 0) {
      floorFppg   = +(projection * 0.75).toFixed(1);
      ceilingFppg = +(projection * 1.35).toFixed(1);
    }

    const baseline = projection || csvBase;
    const stdDev   = p.stdDev != null ? p.stdDev : +(baseline * stdDevMult).toFixed(2);

    const projectedFppg = projection > 0 ? +projection.toFixed(1) : 0;
    const valueScore    = projectedFppg > 0 && p.salary > 0
      ? +(projectedFppg / (p.salary / 1000)).toFixed(2)
      : 0;

    return {
      ...p,
      projection,
      projectedFppg,
      floorFppg,
      ceilingFppg,
      valueScore,
      stdDev,
      ownershipPct: (p.ownershipPct != null && p.ownershipPct > 0) ? p.ownershipPct : PROP_DEFAULT_OWN,
      _propEnriched,
      _propMarket,
      _projSource,
    };
  });

  matchedCount = enriched.filter(p => p._propEnriched).length;
  console.log('[Props] Props matched:', matchedCount);
  console.log('[Props] CSV fallbacks:', fallbackCount);
  console.log('[Props] Wemby matched:', wembyMatched ? 'YES' : 'NO');
  return enriched;
}

async function fetchPlayerProps(apiKey, sport) {
  if (!apiKey || !PROP_SPORT_KEY[sport]) return [];
  const sportKey  = PROP_SPORT_KEY[sport];
  const marketStr = (PROP_MARKETS[sport] || []).join(',');

  let events;
  try {
    const evRes = await withTimeout(
      fetch(`https://api.the-odds-api.com/v4/sports/${sportKey}/events?apiKey=${apiKey}`),
      6000, 'odds-events'
    );
    if (!evRes.ok) return [];
    events = await evRes.json();
  } catch { return []; }

  if (!Array.isArray(events)) return [];
  const now = Date.now();
  const in72h = now + 72 * 60 * 60 * 1000;
  const todayEvents = events
    .filter(e => { const t = new Date(e.commence_time).getTime(); return t >= now && t <= in72h; })
    .slice(0, 8);

  const eventCount = todayEvents.length;
  console.log('[Props] Events found:', eventCount);
  if (!eventCount) {
    console.log('[Props] Window end:', new Date(in72h).toISOString());
    return [];
  }

  console.log('[Props] Starting fetch loop');
  const allProps = [];
  // Track latest credit headers from any real (non-cached) API call
  let latestRemaining = null;
  let latestUsed = null;

  await Promise.all(todayEvents.map(async (event) => {
    const cacheKey = `edge:dfs:props:${sport}:${event.id}`;

    // Check Redis / memory cache first — never fetch the same game twice within 2 hours
    const cached = await getCachedProps(cacheKey);
    if (cached) {
      console.log('[Props] Cache HIT — skipping fetch');
      cached.forEach(prop => allProps.push(prop));
      return;
    }

    try {
      const url =
        `https://api.the-odds-api.com/v4/sports/${sportKey}/events/${event.id}/odds` +
        `?apiKey=${apiKey}&regions=us&markets=${marketStr}` +
        `&bookmakers=fanduel,draftkings&oddsFormat=american`;
      const res = await withTimeout(fetch(url), 6000, `odds-props-${event.id}`);
      if (!res.ok) return;

      // Capture remaining credits from Odds API response headers
      const rem  = res.headers.get('x-requests-remaining');
      const used = res.headers.get('x-requests-used');
      if (rem  !== null) latestRemaining = rem;
      if (used !== null) latestUsed = used;

      const data = await res.json();
      const bk = (data.bookmakers || []).find(b => b.key === 'fanduel')
              || (data.bookmakers || [])[0];
      if (!bk) return;

      const eventProps = [];
      for (const mkt of (bk.markets || [])) {
        for (const outcome of (mkt.outcomes || [])) {
          if (outcome.name !== 'Over') continue;
          eventProps.push({
            playerName: outcome.description,
            market:     mkt.key,
            line:       outcome.point,
            bookmaker:  bk.key,
          });
        }
      }

      // Cache for 2 hours and push to merged array
      if (eventProps.length > 0) {
        setCachedProps(cacheKey, eventProps).catch(() => {});
        console.log(`[DFS Props Cache] MISS → cached ${eventProps.length} props for ${event.id} (${sport})`);
      }
      eventProps.forEach(prop => allProps.push(prop));
    } catch (err) { console.log('[Props] FETCH ERROR:', err.message); }
  }));

  // Persist credits after real API calls so the frontend can display them
  if (latestRemaining !== null) {
    storeOddsCredits(latestRemaining, latestUsed).catch(() => {});
    const rem   = Number(latestRemaining);
    const used  = Number(latestUsed) || 0;
    const total = rem + used;
    allProps.oddsCreditsRemaining = rem;
    allProps.oddsCreditsUsed      = used || null;
    console.log(`[DFS Props] Odds API credits — used: ${used}, remaining: ${rem}, total: ${total}`);
  }

  // Attach earliest game commence_time for frontend auto-refresh timer
  if (todayEvents.length > 0) {
    const sorted = todayEvents.slice().sort((a, b) =>
      String(a.commence_time || '').localeCompare(String(b.commence_time || ''))
    );
    allProps.commenceTime = sorted[0].commence_time || null;
  }
  return allProps;
}

// ── 60/40 ceiling weighting + GPP ownership fade ──────────────────────────────
// blended = 60% median + 40% ceiling, where ceiling = proj + stdDev × 1.2
// Ownership fade (GPP only): chalk (>25%) gets −10%, contrarian (<10%) gets +15%.
// Updates fppg in-place so the solver scores by the blended value.
function applyProjectionBlend(players, isGpp) {
  return players.map(p => {
    const proj = Number(p.projection || p.fppg) || 0;
    if (proj <= 0) return p;
    const stdDev = Number(p.stdDev) || 0;
    let blended = proj + stdDev * 0.48; // = proj*0.60 + (proj + stdDev*1.2)*0.40
    if (isGpp) {
      const own = Number(p.ownershipPct) || 0;
      if (own > 25)            blended *= 0.90;
      else if (own > 0 && own < 10) blended *= 1.15;
    }
    return { ...p, fppg: +blended.toFixed(2) };
  });
}

function playerGamesPlayed(player) {
  const raw = player && (player.gamesPlayed ?? player.gp ?? player.games);
  const n = parseInt(String(raw == null ? '' : raw).replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

function isQuestionableStatus(status) {
  return /\b(Q|QUES|QUESTIONABLE|DOUBTFUL|GTD)\b/.test(String(status || '').trim().toUpperCase());
}

function shouldExcludeQuestionablePlayer(player) {
  if (!isQuestionableStatus(player && player.injuryStatus)) return false;
  const gp = playerGamesPlayed(player);
  return gp != null && gp < 20;
}

function withQuestionableWarning(player) {
  if (!isQuestionableStatus(player && player.injuryStatus)) return player;
  const gp = playerGamesPlayed(player);
  if (gp != null && gp < 20) return player;
  return {
    ...player,
    qWarning: true,
    injuryNote: player.injuryNote || `Q tag retained in pool${gp != null ? ` (${gp} games played)` : ''}`,
  };
}

function ensureCasonWallace(players, sport) {
  if (sport !== 'nba' || !Array.isArray(players)) return players;
  const hasCason = players.some(p => normalizeName(p && p.name) === 'cason wallace');
  if (!hasCason) {
    players.push({
      name: 'Cason Wallace',
      team: 'OKC',
      opponent: '',
      position: 'PG/SG',
      salary: 5200,
      fppg: 24,
      projectedFppg: 24,
      floorFppg: 18,
      ceilingFppg: 32,
      injuryStatus: 'OK',
      injuryNote: 'Manual active-pool add',
      gamesPlayed: 30,
      ownershipPct: 0,
      manualPoolAdd: true,
    });
    console.log('[DFS Pool] Added Cason Wallace to NBA player pool');
  }
  return players;
}

function buildPrompt({ sport, platform, contestType, salaryCap, slots, liveData, injuryFilter, excludeIlPlayers, lockedPlayers, excludedPlayers, requireProbablePitcher = true }) {
  const today = new Date().toISOString().slice(0, 10);
  const isGpp = contestType === 'gpp';
  const isNba = sport === 'nba';
  const isNfl = sport === 'nfl';
  const isMlb = sport === 'mlb';
  const platformName = 'FanDuel';
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
    ? 'EXCLUDE players listed OUT. Only exclude Q players if they have played fewer than 20 games this season; Q players with 30+ games played stay in the pool with injuryStatus="Q" and a warning note.'
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
    : 'OUT players excluded. Q players are only excluded when they have fewer than 20 games played this season; Q players with 30+ games played stay eligible with a warning flag.';

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

STARTING PITCHERS: Rank by K/9 (×2 weight) + ERA inverse + opposing OPS.${requireProbablePitcher ? ' CONFIRMED PROBABLE STARTERS ONLY — do not use relief pitchers or any pitcher not confirmed to start. Blank/unknown start status = exclude.' : ' Include all active pitchers.'}
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
    isNba ? 'PLAYER POOL OVERRIDE: Cason Wallace is active and must remain eligible unless explicitly listed OUT.' : '',
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
    platform = 'fanduel',
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

  if (!['nba', 'nfl', 'mlb'].includes(sport)) return fail(res, 400, { error: 'Invalid sport. Use nba, nfl, or mlb.' });
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
    requireProbablePitcher: !!requireProbablePitcher,
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


// Sport-aware position matching used by the LP solver
function sportPositionMatches(playerPos, slot, sport) {
  if (sport === 'golf') return true; // all-flex: every player can fill any slot
  // Showdown/captain slots — any player eligible (pitchers excluded for MLB)
  if (slot === 'CPT' || slot === 'MVP' || slot === 'STAR' || slot === 'PRO') {
    return sport === 'mlb' ? !isMlbPitcherPos(playerPos) : true;
  }
  const parts = String(playerPos || '').toUpperCase().split(/[\/\s]+/).filter(Boolean);
  if (!parts.length) return false;

  if (sport === 'mlb') {
    if (slot === 'P')    return parts.some(p => /^(P|SP|RP)$/.test(p));
    if (slot === 'C/1B') return parts.some(p => p === 'C' || p === '1B');
    if (slot === 'C')    return parts.includes('C');
    if (slot === '1B')   return parts.includes('1B');
    if (slot === '2B')   return parts.includes('2B');
    if (slot === '3B')   return parts.includes('3B');
    if (slot === 'SS')   return parts.includes('SS');
    if (slot === 'OF')   return parts.some(p => ['OF', 'LF', 'CF', 'RF'].includes(p));
    if (slot === 'UTIL') return !parts.some(p => ['P', 'SP', 'RP', 'DST', 'K', 'G'].includes(p));
  }
  if (sport === 'nfl') {
    if (slot === 'QB')   return parts.includes('QB');
    if (slot === 'RB')   return parts.includes('RB');
    if (slot === 'WR')   return parts.includes('WR');
    if (slot === 'TE')   return parts.includes('TE');
    if (slot === 'FLEX') return parts.some(p => ['RB', 'WR', 'TE'].includes(p));
    if (slot === 'DST' || slot === 'D/ST') return parts.some(p => ['DST', 'DEF', 'D'].includes(p));
    if (slot === 'K')    return parts.includes('K');
    if (slot === 'UTIL') return true;
  }
  if (sport === 'nba') {
    if (slot === 'PG')   return parts.includes('PG');
    if (slot === 'SG')   return parts.includes('SG');
    if (slot === 'SF')   return parts.includes('SF');
    if (slot === 'PF')   return parts.includes('PF');
    if (slot === 'C')    return parts.includes('C');
    if (slot === 'G')    return parts.some(p => p === 'PG' || p === 'SG');
    if (slot === 'F')    return parts.some(p => p === 'SF' || p === 'PF');
    if (slot === 'UTIL') return true;
  }
  return false;
}

function isMlbPitcherPos(pos) {
  return String(pos || '').toUpperCase().split(/[\/\s]+/).some(p => /^(P|SP|RP)$/.test(p));
}

// LP-style beam search with suffix-min-salary feasibility pruning.
// All roster slots are evaluated simultaneously as co-equal variables.
// Infeasible salary states are pruned at O(1) per candidate via the pre-computed
// suffix-minimum array, preventing pitcher/hitter deadlocks.
function lpBeamSearch(players, slots, cap, opts = {}) {
  const {
    maxPunts       = 1,
    puntThreshold  = 2500,
    lockedNames    = new Set(),
    excludedNames  = new Set(),
    sport          = 'nba',
    maxTeamCount   = 99,
    antiCorrelationTeams = new Set(),
    maxOwnershipPct = 600,
    // NFL-specific
    nflStackQbTeam  = null,  // team to prefer for WR/TE sorting
    nflMinWrStack   = 0,     // minimum WR/TE from QB's team required
    // NBA-specific
    nbaInjuryFloor  = 4500,  // salary at or below which NBA team-cap is waived
    // Multi-lineup diversification
    previousLineups  = [],   // Array<Set<string>>: player name sets from prior lineups
    minUniquePlayers = 0,    // min players that must differ from EACH previous lineup
  } = opts;
  const BEAM_WIDTH = 32;

  // Pre-index which previous lineups contain each player name (for O(1) overlap lookup)
  const n = previousLineups.length;
  const maxOverlap = (n > 0 && minUniquePlayers > 0) ? slots.length - minUniquePlayers : Infinity;
  const playerPrevIdx = new Map(); // name → [lineupIdx, ...]
  if (n > 0 && minUniquePlayers > 0) {
    previousLineups.forEach((lineupSet, idx) => {
      for (const name of lineupSet) {
        let arr = playerPrevIdx.get(name);
        if (!arr) { arr = []; playerPrevIdx.set(name, arr); }
        arr.push(idx);
      }
    });
  }

  const filtered = players.filter(p => !excludedNames.has(p.name));

  // Sorted candidate lists per slot.
  // NBA gets a +15% value-efficiency weight in the sort score so the solver
  // prioritises point-per-dollar alongside raw projection.
  const slotCandidates = slots.map(slot =>
    filtered
      .filter(p => sportPositionMatches(p.position, slot, sport))
      .sort((a, b) => {
        const aStack = (nflStackQbTeam && ['WR', 'TE'].includes(a.position) && a.team === nflStackQbTeam) ? 1.5 : 0;
        const bStack = (nflStackQbTeam && ['WR', 'TE'].includes(b.position) && b.team === nflStackQbTeam) ? 1.5 : 0;
        const aVal   = (sport === 'nba' && a.salary > 0) ? (a.fppg / a.salary) * 1000 * 0.15 : 0;
        const bVal   = (sport === 'nba' && b.salary > 0) ? (b.fppg / b.salary) * 1000 * 0.15 : 0;
        return ((b.fppg || 0) + bStack + bVal) - ((a.fppg || 0) + aStack + aVal);
      })
  );

  // Minimum salary per slot (LP lower bound — ignores uniqueness, valid relaxation)
  const slotMinSal = slotCandidates.map(cands => {
    const sals = cands.map(p => p.salary).filter(s => s > 0);
    return sals.length ? Math.min(...sals) : Infinity;
  });

  // Suffix sum: suffixMin[i] = sum of slotMinSal[i..slots.length-1]
  const suffixMin = new Array(slots.length + 1).fill(0);
  for (let i = slots.length - 1; i >= 0; i--) {
    suffixMin[i] = suffixMin[i + 1] + slotMinSal[i];
  }

  if (suffixMin[0] > cap) return null; // globally infeasible before any selection

  const SKILL_SLOTS = new Set(['WR', 'TE', 'FLEX']); // NFL stacking slots

  const initial = {
    picked: [], salarySoFar: 0, fppgSoFar: 0, cheapCount: 0,
    teamCounts: {}, ownerSum: 0,
    qbTeam: null, qbTeamStack: 0,
    overlapCounts: n > 0 ? new Array(n).fill(0) : null,
  };
  let beam = [initial];

  for (let si = 0; si < slots.length; si++) {
    const slot = slots[si];
    const nextBeam = [];

    // Pre-compute remaining skill slots (including current) for NFL stack enforcement
    const remainingSkillSlots = sport === 'nfl'
      ? slots.slice(si).filter(s => SKILL_SLOTS.has(s)).length
      : 0;

    for (const state of beam) {
      const budgetLeft = cap - state.salarySoFar;
      if (budgetLeft < suffixMin[si]) continue; // LP feasibility prune

      const usedNames = new Set(state.picked.map(p => p.name));

      const eligible = slotCandidates[si].filter(p => {
        if (usedNames.has(p.name)) return false;
        if (antiCorrelationTeams.has(p.team)) return false;
        // LP prune: player salary + minimum cost of all remaining slots must fit
        if (p.salary + suffixMin[si + 1] > budgetLeft) return false;

        // MLB: hitter team-stacking cap (pitchers exempt)
        if (sport === 'mlb' && !isMlbPitcherPos(p.position)) {
          if ((state.teamCounts[p.team] || 0) >= maxTeamCount) return false;
        }

        // NBA: team cap = 2, but waived for injury-value floor players
        if (sport === 'nba') {
          const isInjuryVal = p.salary > 0 && p.salary <= nbaInjuryFloor;
          if (!isInjuryVal && (state.teamCounts[p.team] || 0) >= maxTeamCount) return false;
        }

        // NFL: D/ST anti-correlation — block any defense facing our offensive teams
        if (sport === 'nfl' && (slot === 'DST' || slot === 'D/ST')) {
          const ourTeams = new Set(state.picked.map(q => q.team).filter(Boolean));
          if (p.opponent && ourTeams.has(p.opponent)) return false;
        }

        // NFL: enforce minimum QB-WR/TE stack
        // When remaining skill slots == still-needed stack players, force QB-team picks
        if (sport === 'nfl' && nflMinWrStack > 0 && state.qbTeam && SKILL_SLOTS.has(slot)) {
          const stackStillNeeded = nflMinWrStack - state.qbTeamStack;
          if (stackStillNeeded > 0 && remainingSkillSlots <= stackStillNeeded) {
            if (!(p.team === state.qbTeam && (p.position === 'WR' || p.position === 'TE'))) return false;
          }
        }

        return true;
      });

      const locked = eligible.filter(p => lockedNames.has(p.name));
      const candidates = locked.length ? locked : eligible;
      const top = candidates.slice(0, BEAM_WIDTH * 2);

      for (const player of top) {
        const nextSal  = state.salarySoFar + player.salary;
        const nextFppg = state.fppgSoFar + (player.fppg || 0);

        // Punt cap: apply to non-pitcher positions only (avoids pitcher deadlocks)
        const isPunt   = player.salary > 0 && player.salary <= puntThreshold
                         && !isMlbPitcherPos(player.position);
        const nextPunt = state.cheapCount + (isPunt ? 1 : 0);
        if (nextPunt > maxPunts && !lockedNames.has(player.name)) continue;

        const nextOwn = state.ownerSum + (player.ownershipPct || 0);
        if (nextOwn > maxOwnershipPct && !lockedNames.has(player.name)) continue;

        // Team count — MLB: hitters only; all other sports: all players
        const nextTeam = { ...state.teamCounts };
        if (!(sport === 'mlb' && isMlbPitcherPos(player.position))) {
          nextTeam[player.team] = (nextTeam[player.team] || 0) + 1;
        }

        // NFL QB-stack tracking
        const nextQbTeam  = state.qbTeam || (player.position === 'QB' ? player.team : null);
        const nextQbStack = state.qbTeamStack +
          (state.qbTeam && ['WR', 'TE'].includes(player.position) && player.team === state.qbTeam ? 1 : 0);

        // Uniqueness: check overlap against every previous lineup.
        // Forward prune: if overlap[i] > maxOverlap the state can never satisfy uniqueness.
        let nextOverlap = state.overlapCounts;
        if (n > 0 && minUniquePlayers > 0 && !lockedNames.has(player.name)) {
          const prevIdxs = playerPrevIdx.get(player.name);
          if (prevIdxs && prevIdxs.length > 0) {
            let skip = false;
            nextOverlap = state.overlapCounts.slice();
            for (const idx of prevIdxs) {
              nextOverlap[idx]++;
              if (nextOverlap[idx] > maxOverlap) { skip = true; break; }
            }
            if (skip) continue;
          }
        }

        nextBeam.push({
          picked:        [...state.picked, player],
          salarySoFar:   nextSal,
          fppgSoFar:     nextFppg,
          cheapCount:    nextPunt,
          teamCounts:    nextTeam,
          ownerSum:      nextOwn,
          qbTeam:        nextQbTeam,
          qbTeamStack:   nextQbStack,
          overlapCounts: nextOverlap,
        });
      }
    }

    if (!nextBeam.length) return null;
    nextBeam.sort((a, b) => b.fppgSoFar - a.fppgSoFar);
    beam = nextBeam.slice(0, BEAM_WIDTH);
  }

  const valid = beam.filter(s => s.picked.length === slots.length && s.salarySoFar <= cap);
  if (!valid.length) return null;
  valid.sort((a, b) => b.fppgSoFar - a.fppgSoFar);
  return valid[0];
}

// ─── /optimize-csv ───────────────────────────────────────────────────────────
// Main CSV lineup-generation endpoint.
// Delegates all optimization to the modular dfsSolver + sportConfigs pipeline.
// Supports: single lineup, multi-lineup (up to 20), exposure capping,
//           showdown dual-pricing, MLB stacking, NFL QB stack, tournament upside.

router.post('/optimize-csv', async (req, res) => {
  const session = requireDfsSession(req, res);
  if (!session) return;

  try {

  const {
    players: rawPlayers = [],
    sport: rawSport = 'mlb',
    platform = 'fanduel',
    contestType = 'gpp',
    salaryCap: customCap,
    customSlots: rawCustomSlots,
    requireProbablePitcher = true,
    allowValuePunts = true,
    maxPuntPlayers = 1,
    maxHittersPerTeam = 4,
    secondaryStackSize = 2,
    maxOwnershipPct = 120,
    minWrStack = 1,
    enableStacking = true,
    useTournamentUpside = false,
    lineupCount = 1,
    lineupMode = 'standard',
    maxExposure = 0.6,
    minUniquePlayers = 3,
    lockedPlayers = [],
    excludedPlayers = [],
    minCapUsagePct = 95,
  } = req.body || {};

  const lineupN     = Math.max(1, Math.min(20, Number(lineupCount)      || 1));
  const exposurePct = Math.max(0.1, Math.min(1.0, Number(maxExposure)   || 0.6));
  const minUnique   = Math.max(0, Math.min(9, Number(minUniquePlayers)   || 3));

  // ── Resolve sport and slate type ────────────────────────────────────────────
  if (rawSport && !['nba', 'nfl', 'mlb', 'golf'].includes(rawSport)) {
    return fail(res, 400, { error: `Invalid sport "${rawSport}". Use nba, nfl, mlb, or golf.` });
  }
  const sport = rawSport || 'mlb';

  // customSlots from the frontend (includes MVP/UTIL for showdown, GLFR for PGA)
  const resolvedSlots = Array.isArray(rawCustomSlots) && rawCustomSlots.length > 0
    ? rawCustomSlots.map(s => String(s).toUpperCase().slice(0, 10))
    : null;

  const isShowdown = resolvedSlots
    ? isShowdownSlots(resolvedSlots)
    : false;

  // Load FanDuel sport config; fall back to best-match classic on unknown variant
  let config = getConfig(sport, isShowdown);
  if (!config) config = getConfig(sport, false);
  if (!config) return fail(res, 400, { error: `Unsupported sport: ${sport}` });

  // Override cap and slots when the frontend supplies them explicitly
  const effectiveCap   = (customCap > 0 ? customCap : null) || config.cap;
  const effectiveSlots = resolvedSlots || config.slots;
  const effectiveConfig = { ...config, cap: effectiveCap, slots: effectiveSlots };

  // MLB $35K: relax default [[5,3],[4,4]] to [[4,2],[3,3]] — more achievable under the lower cap
  let solveConfig = effectiveConfig;
  if (sport === 'mlb' && effectiveCap <= 35000 && effectiveConfig.stackingEnabled) {
    solveConfig = {
      ...effectiveConfig,
      stackingRules: { ...effectiveConfig.stackingRules, validCombos: [[4, 2], [3, 3]] },
    };
  }

  // ── Normalise player array ──────────────────────────────────────────────────
  let players = (Array.isArray(rawPlayers) ? rawPlayers : [])
    .filter(p => p && p.name && p.salary >= 0)
    .map(p => {
      let pos = String(p.position || '').toUpperCase().trim().slice(0, 30);
      // NFL: normalise defensive unit variants
      if (sport === 'nfl') pos = pos.replace(/^(DEF|D\/ST)$/i, 'DST');
      // MLB: normalise C/1B → C1B; dual-tag C and 1B for the unified slot
      if (sport === 'mlb') {
        if (pos === 'C/1B' || pos === '1B/C') pos = 'C1B';
        else if (pos === 'C')  pos = 'C/C1B';
        else if (pos === '1B') pos = '1B/C1B';
      }
      // NFL: dual-tag RB/WR/TE with FLEX eligibility for frontend display
      if (sport === 'nfl') {
        if (pos === 'RB' || pos === 'WR' || pos === 'TE') pos = `${pos}/FLEX`;
      }
      // Golf: normalise all golf variants → GLFR
      if (sport === 'golf') {
        if (/^(G|GOLF|PGA|PLAYER|GOLFER|GLFR)$/.test(pos)) pos = 'GLFR';
      }
      return {
        name:               String(p.name || '').slice(0, 80),
        team:               String(p.team || '').slice(0, 20),
        opponent:           String(p.opponent || '').slice(0, 20),
        position:           pos,
        salary:             Number(p.salary)  || Number(p.Salary)  || 0,
        fppg:               Number(p.fppg)    || Number(p.FPPG)    || 0,
        probablePitcher:    Boolean(p.probablePitcher),
        injuryStatus:       String(p.injuryStatus    || ''),
        injuryNote:         String(p.injuryNote      || ''),
        gamesPlayed:        p.gamesPlayed != null ? Number(p.gamesPlayed) : null,
        qWarning:           !!p.qWarning,
        manualPoolAdd:      !!p.manualPoolAdd,
        ownershipPct:       Number(p.ownershipPct)   || 0,
        // Optional upside-engine columns (forwarded from CSV if present)
        stdDev:             p.stdDev  != null ? Number(p.stdDev)  : null,
        plateAppearances:   p.plateAppearances  != null ? Number(p.plateAppearances)  : null,
        projectedMinutes:   p.projectedMinutes  != null ? Number(p.projectedMinutes)  : null,
        targets:            p.targets != null ? Number(p.targets) : null,
        blocksPerGame:      p.blocksPerGame  != null ? Number(p.blocksPerGame)  : null,
        stealsPerGame:      p.stealsPerGame  != null ? Number(p.stealsPerGame)  : null,
      };
    });

  players = ensureCasonWallace(players, sport);
  if (!players.length) return fail(res, 400, { error: 'No players provided.' });

  // ── NBA defensive stat pre-fetch (non-blocking) ───────────────────────────────
  // Populates blocksPerGame / stealsPerGame on each player before prop enrichment
  // so the defensive bonus in enrichPlayersWithProps fires with accurate data.
  // Hard timeout: lineup generation proceeds regardless of outcome.
  if (sport === 'nba') {
    try {
      const defStats = await withTimeout(fetchNbaDefStats(players), 15000, 'nba-def-stats');
      if (defStats.size > 0) {
        players = players.map(p => {
          const s = defStats.get(normalizeName(p.name));
          return (s && !s.noData)
            ? { ...p, blocksPerGame: s.blk, stealsPerGame: s.stl }
            : p;
        });
      }
    } catch (err) {
      console.log('[DEF] Skipped (non-fatal):', err.message);
    }
  }

  // ── Odds API player-prop enrichment ──────────────────────────────────────────
  // Injects projection, stdDev, and ownershipPct defaults into every player.
  // NBA/NFL/MLB: attempts live prop fetch; PGA/golf: skips live props but still
  // fills stdDev/ownershipPct defaults. Failure at any step is non-fatal.
  const oddsKey = process.env.THE_ODDS_API_KEY || process.env.ODDS_API_KEY || process.env.ODDS_KEY;
  const enrichDebug = { attempted: false, enrichedCount: 0, propSource: null, skippedReason: null };

  if (oddsKey && ['nba', 'nfl', 'mlb'].includes(sport)) {
    enrichDebug.attempted = true;
    try {
      const props = await withTimeout(fetchPlayerProps(oddsKey, sport), 14000, 'player-props');
      players     = enrichPlayersWithProps(players, props, sport);
      const n     = players.filter(p => p._propEnriched).length;
      enrichDebug.enrichedCount       = n;
      enrichDebug.commenceTime        = props.commenceTime || null;
      enrichDebug.oddsCreditsRemaining = typeof props.oddsCreditsRemaining === 'number'
        ? props.oddsCreditsRemaining : null;
      enrichDebug.oddsCreditsUsed      = typeof props.oddsCreditsUsed === 'number'
        ? props.oddsCreditsUsed : null;
      enrichDebug.propSource    = n > 0
        ? (players.find(p => p._propEnriched)?._propMarket ?? null)
        : null;
      if (n > 0) console.log(`[DFS] Props: enriched ${n}/${players.length} (${sport}, ${enrichDebug.propSource})`);
      else        console.log(`[DFS] Props: 0 matches for ${sport} — running on CSV projections`);
    } catch (err) {
      console.warn('[DFS] Props enrichment failed (non-fatal):', err.message);
      enrichDebug.skippedReason = err.message;
      players = enrichPlayersWithProps(players, [], sport);
    }
  } else {
    enrichDebug.skippedReason = oddsKey ? `sport=${sport} not supported for live props` : 'no API key';
    players = enrichPlayersWithProps(players, [], sport);
  }

  // Diagnostic sample — visible in Network tab debug.enrichment.sample
  enrichDebug.sample = players.slice(0, 3).map(p => ({
    name: p.name, fppg: p.fppg, projection: p.projection, salary: p.salary,
  }));
  const zeroFppg = players.filter(p => !p.fppg && !p.projection).length;
  if (zeroFppg > 0) console.warn(`[DFS] ${zeroFppg}/${players.length} players have fppg=0 AND projection=0`);

  // Apply 60/40 ceiling blend + GPP ownership fade before solver scoring
  const isGppMode = contestType === 'gpp';
  players = applyProjectionBlend(players, isGppMode);

  const lockedSet   = new Set((lockedPlayers  || []).map(n => String(n)));
  const excludedSet = new Set((excludedPlayers || []).map(n => String(n)));

  // GPP Q-player handling: keep experienced Q players in the pool with a warning.
  // Only exclude Q players with known low season participation (<20 games).
  if (isGppMode) {
    const qRemoved = [];
    const qKept = [];
    players = players.filter(p => {
      if (lockedSet.has(p.name)) return true;
      if (shouldExcludeQuestionablePlayer(p)) {
        qRemoved.push(p.name);
        return false;
      }
      if (isQuestionableStatus(p.injuryStatus)) qKept.push(p.name);
      return true;
    }).map(withQuestionableWarning);
    if (qRemoved.length) console.log('[DFS GPP Q] Excluded Q players with <20 GP:', qRemoved.join(', '));
    if (qKept.length) console.log('[DFS GPP Q] Kept Q players with warning:', qKept.join(', '));
  }

  // GPP Ownership Fade: in tournament mode, exclude low-ceiling players who are
  // too popular to provide leverage. Requires: proj < 15 pts AND ownership >= 5%.
  // Locked players are always preserved. Swap naturally happens — solver picks
  // higher-ceiling alternatives from whoever remains.
  let gppFadedCount = 0;
  if (isGppMode) {
    const gppFaded = [];
    players = players.filter(p => {
      if (lockedSet.has(p.name)) return true;
      const pts = Number(p.fppg || p.projection) || 0;
      const own = Number(p.ownershipPct) || 0;
      if (pts < 15 && own >= 5) {
        gppFaded.push(p.name);
        return false;
      }
      return true;
    });
    gppFadedCount = gppFaded.length;
    if (gppFadedCount > 0) {
      console.log(`[DFS GPP Fade] Excluded ${gppFadedCount} low-ceiling/high-ownership: ${gppFaded.slice(0, 8).join(', ')}`);
    }
  }

  // Feasibility check: cheapest N-player combo from the uploaded pool.
  const nSlots = effectiveSlots.length;
  const cheapestN = [...players].sort((a, b) => a.salary - b.salary).slice(0, nSlots);
  const cheapestComboSalary = cheapestN.reduce((s, p) => s + p.salary, 0);
  const cheapestComboDebug = {
    slots:       nSlots,
    totalSalary: cheapestComboSalary,
    cap:         effectiveCap,
    feasible:    cheapestComboSalary <= effectiveCap,
    players:     cheapestN.map(p => ({ name: p.name, salary: p.salary, position: p.position })),
  };

  // ── Soft-constraint relaxation stages ──────────────────────────────────────
  // Each stage cumulatively relaxes one more optional constraint.
  // Stage 0 = full user constraints; last stage = hard constraints only.
  // baseConfig overrides the sport config passed to generateOptimalLineup.
  // MLB-specific stages append further stack relaxations for the $35K cap.
  function buildRelaxedStages(base, baseConfig) {
    const cfg        = baseConfig || solveConfig;
    const mht        = Number(base.maxHittersPerTeam) || 4;
    const relaxedMht = Math.min(8, mht + 1);
    const stages = [
      { relaxed: null,
        opts: base },
      { relaxed: 'Minimum salary floor lowered to 85%',
        opts: { ...base, minCapUsagePct: 85 } },
      { relaxed: 'Probable pitcher filter disabled (no confirmed starter detected)',
        opts: { ...base, minCapUsagePct: 85, requireProbablePitcher: false } },
      { relaxed: 'Ownership cap disabled (ownership data sparse or unavailable)',
        opts: { ...base, minCapUsagePct: 85, requireProbablePitcher: false,
                maxOwnershipPct: 9999 } },
      { relaxed: 'Punt player limit relaxed (+2)',
        opts: { ...base, minCapUsagePct: 85, requireProbablePitcher: false,
                maxOwnershipPct: 9999,
                maxPunts: Math.min(99, (base.maxPunts || 1) + 2), allowValuePunts: true } },
      { relaxed: `Max hitters per team relaxed (${mht} → ${relaxedMht})`,
        opts: { ...base, minCapUsagePct: 85, requireProbablePitcher: false,
                maxOwnershipPct: 9999,
                maxPunts: Math.min(99, (base.maxPunts || 1) + 2), allowValuePunts: true,
                maxHittersPerTeam: relaxedMht } },
      { relaxed: 'Hard constraints only — all optional filters disabled',
        opts: { ...base, minCapUsagePct: 0, requireProbablePitcher: false,
                maxOwnershipPct: 9999, maxPunts: 99, allowValuePunts: true,
                maxHittersPerTeam: effectiveConfig.maxHittersPerTeam || 8,
                enableStacking: false } },
    ];
    // MLB-specific: further stack relaxation for small cap slates
    if (sport === 'mlb' && cfg.stackingEnabled) {
      const mlbRelaxOpts = { ...base, minCapUsagePct: 85, requireProbablePitcher: false,
                             maxOwnershipPct: 9999, maxPunts: 99, allowValuePunts: true,
                             maxHittersPerTeam: relaxedMht };
      stages.push({
        relaxed: 'MLB stack relaxed to 4-1 / 3-2',
        opts: mlbRelaxOpts,
        configOverride: { ...cfg, stackingRules: { ...cfg.stackingRules, validCombos: [[4,1],[3,2]] } },
      });
      stages.push({
        relaxed: 'MLB stack relaxed to 3-1 / 2-2',
        opts: { ...mlbRelaxOpts, minCapUsagePct: 0, maxHittersPerTeam: relaxedMht + 1 },
        configOverride: { ...cfg, stackingRules: { ...cfg.stackingRules, validCombos: [[3,1],[2,2]] } },
      });
    }
    return stages;
  }

  // ── Multi-lineup generation loop ────────────────────────────────────────────
  const solverOpts = {
    useTournamentUpside,
    allowValuePunts,
    maxPunts:            maxPuntPlayers,
    enableStacking,
    requireProbablePitcher,
    lockedNames:         lockedSet,
    excludedNames:       excludedSet,
    maxOwnershipPct:     Number(maxOwnershipPct) || 120,
    nflMinWrStack:       Number(minWrStack)       || 1,
    maxHittersPerTeam:   Number(maxHittersPerTeam) || effectiveConfig.maxHittersPerTeam || 5,
    minCapUsagePct:      Number(minCapUsagePct) || 95,
  };

  const results           = [];
  const appearances       = {};
  const prevSets          = [];
  let winningBaseOpts     = null;  // relaxed opts that succeeded on lineup 0
  let winningConfig       = null;  // configOverride (if any) that succeeded on lineup 0
  let constraintWarning   = null;
  const stagesDebug       = [];

  if (lineupMode === 'archetypes') {
    // ── 5-archetype mode: Chalk / Balanced 1 / Balanced 2 / Upside / Contrarian ─
    const ARCHETYPES = [
      { name: 'Chalk',      overrides: { useTournamentUpside: false, maxOwnershipPct: 600 } },
      { name: 'Balanced 1', overrides: {} },
      { name: 'Balanced 2', overrides: { minUniquePlayers: minUnique } },
      { name: 'Upside',     overrides: { useTournamentUpside: true, maxOwnershipPct: 80 } },
      { name: 'Contrarian', overrides: { useTournamentUpside: true, maxOwnershipPct: 35 } },
    ];
    for (const arch of ARCHETYPES) {
      const archOpts = {
        ...solverOpts, ...arch.overrides,
        excludedNames:    excludedSet,
        previousLineups:  prevSets,
        minUniquePlayers: prevSets.length > 0 ? (arch.overrides.minUniquePlayers || minUnique) : 0,
      };
      let archResult = null;
      for (const stage of buildRelaxedStages(archOpts, solveConfig)) {
        archResult = generateOptimalLineup(players, stage.configOverride || solveConfig, stage.opts);
        stagesDebug.push({ archetype: arch.name, stage: stage.relaxed || 'full constraints', succeeded: !!archResult });
        if (archResult) {
          if (stage.relaxed && !constraintWarning) constraintWarning = stage.relaxed;
          break;
        }
      }
      if (archResult) {
        archResult.archetype = arch.name;
        results.push(archResult);
        archResult.lineup.forEach(p => { appearances[p.name] = (appearances[p.name] || 0) + 1; });
        prevSets.push(new Set(archResult.lineup.map(p => p.name)));
      }
    }
  } else {
    // ── Standard multi-lineup loop ──────────────────────────────────────────────
    for (let li = 0; li < lineupN; li++) {
      // Apply exposure cap: exclude players who've hit their appearance ceiling
      const iterExcluded = new Set(excludedSet);
      if (li > 0 && exposurePct < 1.0) {
        const capCount = Math.max(1, Math.ceil(lineupN * exposurePct));
        for (const [name, cnt] of Object.entries(appearances)) {
          if (cnt >= capCount && !lockedSet.has(name)) iterExcluded.add(name);
        }
      }

      // Subsequent lineups inherit the relaxation level that worked on lineup 0
      const baseOpts = {
        ...(winningBaseOpts || solverOpts),
        excludedNames:    iterExcluded,
        previousLineups:  prevSets,
        minUniquePlayers: li === 0 ? 0 : minUnique,
      };

      let result = null;

      if (li === 0) {
        // First lineup: walk staged fallback until one succeeds
        for (const stage of buildRelaxedStages(baseOpts, solveConfig)) {
          result = generateOptimalLineup(players, stage.configOverride || solveConfig, stage.opts);
          stagesDebug.push({ stage: stage.relaxed || 'full constraints', succeeded: !!result });
          if (result) {
            if (stage.relaxed) {
              constraintWarning = stage.relaxed;
              winningBaseOpts = { ...stage.opts, excludedNames: excludedSet,
                                  previousLineups: [], minUniquePlayers: 0 };
              winningConfig   = stage.configOverride || null;
            }
            break;
          }
        }
      } else {
        result = generateOptimalLineup(players, winningConfig || solveConfig, baseOpts);
      }

      if (!result) break;

      results.push(result);
      result.lineup.forEach(p => { appearances[p.name] = (appearances[p.name] || 0) + 1; });
      prevSets.push(new Set(result.lineup.map(p => p.name)));
    }
  }

  if (!results.length) {
    // Per-slot eligibility counts for diagnosing hard-constraint failures
    const slotDebug = (effectiveSlots || []).map(slot => {
      const elig = players.filter(p => {
        const parts = String(p.position || '').toUpperCase().split(/[\/\s]+/).filter(Boolean);
        if (slot === 'UTIL') return parts.some(x => ['1B', 'C', 'C1B', '2B', '3B', 'SS', 'OF'].includes(x));
        return parts.some(x => x === slot || x.includes(slot));
      });
      const sals = elig.map(p => p.salary).filter(s => s > 0);
      return { slot, eligible: elig.length, count: elig.length, cheapest: sals.length ? Math.min(...sals) : null };
    });

    return fail(res, 400, {
      error: `No legal lineup exists for this CSV under the $${effectiveCap.toLocaleString()} cap. Try relaxing injury filters, adding more players, or lowering the minimum cap usage.`,
      debug: {
        sport, isShowdown, cap: effectiveCap, slots: effectiveSlots,
        totalPlayers: players.length,
        gppFadedCount,
        cheapestCombo: cheapestComboDebug,
        enrichment: enrichDebug,
        stages: stagesDebug,
        slotCoverage: slotDebug,
      },
    });
  }

  // Compute summary totals the frontend summary bar expects
  const primary = results[0];
  const summaryLineup = primary ? primary.lineup : [];
  const totalProjectedPoints = +summaryLineup.reduce((s, p) => s + (p.fppg || p.projectedFppg || 0), 0).toFixed(1);
  const totalFloorPoints     = +summaryLineup.reduce((s, p) => s + (p.floorFppg    || 0), 0).toFixed(1);
  const totalCeilingPoints   = +summaryLineup.reduce((s, p) => s + (p.ceilingFppg  || 0), 0).toFixed(1);

  // Bundle Odds API credit info (live from this request, or last stored value)
  const oddsApiCredits = enrichDebug.oddsCreditsRemaining != null
    ? {
        remaining: enrichDebug.oddsCreditsRemaining,
        used:      enrichDebug.oddsCreditsUsed,
        source:    'live',
        updatedAt: new Date().toISOString(),
      }
    : await getOddsCredits().catch(() => null);

  return ok(res, {
    data: {
      ...primary,
      totalProjectedPoints,
      totalFloorPoints,
      totalCeilingPoints,
      lineups:          results,
      exposure:         appearances,
      constraintWarning,
      lineupMode,
      commenceTime:     enrichDebug.commenceTime || null,
      oddsApiCredits,
    },
    debug: {
      sport, isShowdown, platform,
      cap:           effectiveCap,
      lineupCount:   results.length,
      lineupMode,
      cheapestCombo: cheapestComboDebug,
      enrichment:    enrichDebug,
      stages:        stagesDebug,
      relaxedStage:  constraintWarning,
    },
  });

  } catch (err) {
    console.log('[400 ERROR]', err.message, err.stack);
    return fail(res, 400, { error: err.message || 'Optimizer error — check server logs.' });
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

router.post('/slate-analysis', async (req, res) => {
  const session = requireDfsSession(req, res);
  if (!session) return;

  const { sport = 'nba', players = [] } = req.body || {};
  if (!['nba', 'nfl', 'mlb'].includes(sport)) return fail(res, 400, { error: 'Invalid sport.' });

  const apiKey = process.env.THE_ODDS_API_KEY || process.env.ODDS_API_KEY || process.env.ODDS_KEY;
  let games = [];
  try { games = await fetchOddsData(apiKey, sport); } catch { games = []; }

  const teams = [...new Set((Array.isArray(players) ? players : []).map(p => p.team).filter(Boolean))].slice(0, 20);
  const today = new Date().toISOString().slice(0, 10);

  const oddsBlock = games.length
    ? games.map(g => `${g.awayTeam} @ ${g.homeTeam}: O/U ${g.total}, away implied ${g.awayImplied} / home implied ${g.homeImplied} (${g.gameScript})`).join('\n')
    : 'No odds data available.';

  const prompt = `You are a DFS slate analyst. Today is ${today}. Sport: ${sport.toUpperCase()}.

Vegas game data:
${oddsBlock}

Teams on slate: ${teams.join(', ') || 'unknown'}

Use web_search to find:
1. Today's injury report — OUT and Q players
2. Pace ratings and matchup context for these teams
3. Key DFS slate narrative

Return ONLY raw JSON:
{
  "slateNarrative": "2-3 sentence strategic overview of this slate",
  "topStackTargets": ["TEAM1", "TEAM2"],
  "topFadeTargets": ["TEAM3"],
  "games": [
    {
      "teams": "AWAY @ HOME",
      "total": 220.5,
      "awayImplied": 108.0,
      "homeImplied": 112.5,
      "gameScript": "neutral",
      "paceRating": "fast",
      "stackValue": "HIGH",
      "keyInjuries": ["Player - Q (knee)"],
      "notes": "brief matchup note"
    }
  ],
  "keyInjuries": ["Player (TEAM) - Status: short note"],
  "paceNarrative": "1-2 sentence pace context"
}`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 3000,
      system: 'You are a DFS slate analyst. Always use web_search for current injury and pace data. Return only raw JSON.',
      messages: [{ role: 'user', content: prompt }],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    }, { timeout: 90000 });

    const rawText = (response.content || []).filter(b => b.type === 'text' && b.text).map(b => b.text).join('\n').trim();
    const parsed = parseJsonFromText(rawText);
    return ok(res, { data: { ...parsed, updatedAt: new Date().toISOString(), oddsGames: games } });
  } catch (err) {
    console.error('DFS slate-analysis error:', err.message);
    // Non-fatal: return odds-only fallback
    return ok(res, {
      data: {
        slateNarrative: 'Slate analysis unavailable — showing odds data only.',
        topStackTargets: [],
        topFadeTargets: [],
        games: games.map(g => ({
          teams: `${g.awayTeam} @ ${g.homeTeam}`,
          total: g.total,
          awayImplied: g.awayImplied,
          homeImplied: g.homeImplied,
          gameScript: g.gameScript,
          paceRating: 'neutral',
          stackValue: (g.homeImplied || 0) >= 115 || (g.awayImplied || 0) >= 115 ? 'HIGH' : 'MEDIUM',
          keyInjuries: [],
          notes: '',
        })),
        keyInjuries: [],
        paceNarrative: '',
        updatedAt: new Date().toISOString(),
        oddsGames: games,
      },
    });
  }
});

// ── /projections-debug ── Step 1 diagnostic: raw Odds API response for SGA ──────
router.get('/projections-debug', async (req, res) => {
  const adminPw = process.env.ADMIN_PASSWORD || 'edge-admin-2026';
  const qpw = req.query.pw || req.query.password || req.query.adminPassword;
  const session = verifySession(req.cookies && req.cookies.edge_session);
  if (!session && qpw !== adminPw) {
    return fail(res, 401, { error: 'Pass ?pw=<adminPassword> or a valid session cookie.' });
  }

  const logs = {
    log1_urlSearched: null,
    log2_rawEventsResponse: null,
    log3_rawPropsResponse: null,
    log4_error: null,
    sgaMatches: [],
    todayEventCount: 0,
    allEventCount: 0,
    testEvent: null,
  };

  const apiKey = process.env.THE_ODDS_API_KEY || process.env.ODDS_API_KEY || process.env.ODDS_KEY;
  const keySource = process.env.THE_ODDS_API_KEY ? 'THE_ODDS_API_KEY'
                  : process.env.ODDS_API_KEY     ? 'ODDS_API_KEY'
                  : process.env.ODDS_KEY         ? 'ODDS_KEY'
                  : 'none';
  console.log('API KEY PREFIX:', process.env.THE_ODDS_API_KEY?.slice(0, 8));
  console.log(`[projections-debug] key source=${keySource} prefix=${apiKey ? apiKey.slice(0, 8) : 'MISSING'}`);

  if (!apiKey) {
    logs.log4_error = 'No Odds API key configured — checked THE_ODDS_API_KEY, ODDS_API_KEY, ODDS_KEY';
    return ok(res, { data: logs });
  }

  const sportKey = 'basketball_nba';
  const eventsUrl = `https://api.the-odds-api.com/v4/sports/${sportKey}/events?apiKey=${apiKey}`;
  logs.log1_urlSearched = eventsUrl.replace(apiKey, '[REDACTED]');

  try {
    const evRes = await withTimeout(fetch(eventsUrl), 8000, 'nba-events-debug');
    const evText = await evRes.text();

    logs.log2_rawEventsResponse = {
      status: evRes.status,
      statusText: evRes.statusText,
      bodyPreview: evText.slice(0, 2000),
      bodyLength: evText.length,
    };

    if (!evRes.ok) {
      logs.log4_error = `Events fetch HTTP ${evRes.status}: ${evText.slice(0, 500)}`;
      return ok(res, { data: logs });
    }

    let events;
    try {
      events = JSON.parse(evText);
    } catch (parseErr) {
      logs.log4_error = `Events JSON parse failed: ${parseErr.message}. Raw start: ${evText.slice(0, 300)}`;
      return ok(res, { data: logs });
    }

    const now   = Date.now();
    const in72h = now + 72 * 60 * 60 * 1000;
    const today = new Date(now).toISOString().slice(0, 10);
    const todayEvents = Array.isArray(events)
      ? events.filter(e => { const t = new Date(e.commence_time).getTime(); return t >= now && t <= in72h; })
      : [];

    logs.todayEventCount = todayEvents.length;
    logs.allEventCount = Array.isArray(events) ? events.length : 0;

    if (!todayEvents.length) {
      logs.log4_error = `No NBA events in 72h window from ${today}. Total events: ${logs.allEventCount}. Sample commence_times: ${(Array.isArray(events) ? events : []).slice(0, 3).map(e => e.commence_time).join(', ')}`;
      return ok(res, { data: logs });
    }

    // Use first today event as test case
    const testEvent = todayEvents[0];
    logs.testEvent = {
      id: testEvent.id,
      homeTeam: testEvent.home_team,
      awayTeam: testEvent.away_team,
      commenceTime: testEvent.commence_time,
    };

    const marketStr = 'player_fantasy_points,player_points';
    const propsUrl = `https://api.the-odds-api.com/v4/sports/${sportKey}/events/${testEvent.id}/odds`
      + `?apiKey=${apiKey}&regions=us&markets=${marketStr}&bookmakers=fanduel,draftkings&oddsFormat=american`;

    logs.log1_propsUrlSearched = propsUrl.replace(apiKey, '[REDACTED]');

    try {
      const propsRes = await withTimeout(fetch(propsUrl), 8000, 'nba-props-debug');
      const propsText = await propsRes.text();

      logs.log3_rawPropsResponse = {
        status: propsRes.status,
        statusText: propsRes.statusText,
        bodyPreview: propsText.slice(0, 3000),
        bodyLength: propsText.length,
      };

      if (!propsRes.ok) {
        logs.log4_error = `Props fetch HTTP ${propsRes.status}: ${propsText.slice(0, 500)}`;
        return ok(res, { data: logs });
      }

      let propsData;
      try {
        propsData = JSON.parse(propsText);
      } catch (parseErr) {
        logs.log4_error = `Props JSON parse failed: ${parseErr.message}`;
        return ok(res, { data: logs });
      }

      // Search every bookmaker/market/outcome for SGA
      const sgaTokens = ['shai', 'gilgeous'];
      for (const bk of (propsData.bookmakers || [])) {
        for (const mkt of (bk.markets || [])) {
          for (const outcome of (mkt.outcomes || [])) {
            const desc = String(outcome.description || outcome.player || '').toLowerCase();
            if (sgaTokens.every(t => desc.includes(t))) {
              logs.sgaMatches.push({
                bookmaker: bk.key,
                market: mkt.key,
                description: outcome.description || outcome.player,
                name: outcome.name,
                point: outcome.point,
                price: outcome.price,
              });
            }
          }
        }
      }

      if (!logs.sgaMatches.length) {
        // Show first 5 player names we DID find so user can see the naming format
        const sampleNames = [];
        outer: for (const bk of (propsData.bookmakers || [])) {
          for (const mkt of (bk.markets || [])) {
            for (const outcome of (mkt.outcomes || [])) {
              const desc = outcome.description || outcome.player;
              if (desc && !sampleNames.includes(desc)) {
                sampleNames.push(desc);
                if (sampleNames.length >= 10) break outer;
              }
            }
          }
        }
        logs.sgaNotFoundSampleNames = sampleNames;
      }
    } catch (propsErr) {
      logs.log4_error = `Props fetch threw: ${propsErr.message}`;
    }
  } catch (err) {
    logs.log4_error = `Events fetch threw: ${err.message}`;
  }

  return ok(res, { data: logs });
});

module.exports = router;
