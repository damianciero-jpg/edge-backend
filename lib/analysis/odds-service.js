'use strict';
// ─── ODDS SERVICE ─────────────────────────────────────────────────────────────
// Fetches and parses live odds from The Odds API.
// Returns structured candidates (ML, spread, total) for all games.
// Enriches with MLB team stats when sport is baseball_mlb.

const { getCfg } = require('../config');
const { withTimeout } = require('./ai-service');
const { fetchMLBTeamStatsBlock,
        fetchProbablePitchersByTeam,
        formatPitcherBlock } = require('./mlb-service');
const { hasRedisConfig, createRedis } = require('../redis');
const { recordGameLines } = require('../line-tracker');
const { fetchSoccerEnrichment } = require('./soccer-service');

// ─── ODDS CACHE ───────────────────────────────────────────────────────────────
// Cache odds per sport key for 30 seconds — one API call serves all users
// hitting the same sport in the same window. Massive reduction in Odds API usage.
const ODDS_CACHE_TTL = 30; // seconds

async function getCachedOdds(sportKey) {
  if (!hasRedisConfig()) return null;
  try {
    const redis = createRedis();
    const cached = await withTimeout(redis.get(`edge:odds:${sportKey}`), 2000, 'odds cache get');
    return cached || null;
  } catch { return null; }
}

async function setCachedOdds(sportKey, games) {
  if (!hasRedisConfig()) return;
  try {
    const redis = createRedis();
    await withTimeout(
      redis.set(`edge:odds:${sportKey}`, games, { ex: ODDS_CACHE_TTL }),
      2000, 'odds cache set'
    );
  } catch { /* non-fatal */ }
}

const MLB_SPORT_KEY  = 'baseball_mlb';
const NBA_SPORT_KEY  = 'basketball_nba';
const NFL_SPORT_KEY  = 'americanfootball_nfl';
const NHL_SPORT_KEY  = 'icehockey_nhl';
const MMA_SPORT_KEY  = 'mma_mixed_martial_arts';
const GOLF_SPORT_KEY = 'golf_pga_tour';
const EPL_SPORT_KEY  = 'soccer_epl';
const MLS_SPORT_KEY  = 'soccer_usa_mls';
const WC_SPORT_KEY   = 'soccer_fifa_world_cup';
const SOCCER_SPORTS  = new Set([EPL_SPORT_KEY, MLS_SPORT_KEY, WC_SPORT_KEY]);
const SHARP_BOOK_KEYS = ['lowvig', 'pinnacle'];
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
  // Soccer — World Cup first (most specific), then EPL clubs, then MLS clubs
  if (/world cup|\bfifa\b/.test(src)) return WC_SPORT_KEY;
  if (/\bepl\b|premier league|arsenal|liverpool|manchester|chelsea|tottenham|newcastle|aston villa|everton|west ham|brighton|wolves|fulham|brentford|crystal palace|bournemouth|nottingham forest/.test(src)) return EPL_SPORT_KEY;
  if (/\bmls\b|inter miami|la galaxy|lafc|atlanta united|seattle sounders|portland timbers|austin fc|fc cincinnati|columbus crew|philadelphia union|nycfc|new york red bulls|orlando city|charlotte fc|st\. louis city/.test(src)) return MLS_SPORT_KEY;
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

function extractGameTeams(prompt) {
  const match = String(prompt || '').match(/\bGAME:\s*([^\n@]+?)\s+@\s+([^\n]+)/i);
  if (!match) return null;
  return {
    away: match[1].trim(),
    home: match[2].trim(),
  };
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

async function fetchLiveGameOdds(prompt) {
  try {
    const apiKey = process.env.THE_ODDS_API_KEY || process.env.ODDS_API_KEY || process.env.ODDS_KEY;
    if (!apiKey) return null;

    const sportKey = detectSportKey(prompt);
    const markets = H2H_ONLY_SPORTS.has(sportKey) ? 'h2h' : 'h2h,spreads,totals';

    // Check cache first — 30s TTL means one API call per sport per window
    let games = await getCachedOdds(sportKey);
    let cacheHit = !!games;

    if (!games) {
      const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds/?apiKey=${apiKey}&regions=us&markets=${markets}&oddsFormat=american`;
      const res = await withTimeout(fetch(url), 5000, 'odds api fetch');
      if (!res.ok) return null;
      games = await res.json();
      if (!Array.isArray(games)) return null;
      await setCachedOdds(sportKey, games);
    }

    console.log(`[Odds] sport=${sportKey} games=${games.length} cache=${cacheHit ? 'HIT' : 'MISS'}`);

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

    // Fetch MLB enrichment in parallel — team stats + probable pitchers
    let mlbStatsBlock  = null;
    let pitcherBlock   = null;
    let pitcherData    = null;

    if (sportKey === MLB_SPORT_KEY) {
      try {
        [mlbStatsBlock, pitcherData] = await Promise.all([
          withTimeout(fetchMLBTeamStatsBlock(homeTeam, awayTeam), 4000, 'mlb stats'),
          withTimeout(fetchProbablePitchersByTeam(homeTeam, awayTeam), 4000, 'mlb pitchers'),
        ]);
        if (pitcherData) {
          pitcherBlock = formatPitcherBlock(pitcherData, homeTeam, awayTeam);
        }
      } catch { mlbStatsBlock = null; pitcherBlock = null; }
    }

    // Fetch soccer enrichment if this is a soccer game (API-Football)
    let soccerBlock = null;
    let soccerData  = null;
    if (SOCCER_SPORTS.has(sportKey)) {
      try {
        soccerData = await withTimeout(fetchSoccerEnrichment(homeTeam, awayTeam), 6000, 'soccer enrichment');
        if (soccerData) soccerBlock = soccerData.block;
      } catch { soccerData = null; }
    }

    const enrichedOddsBlock = [oddsBlock, mlbStatsBlock, pitcherBlock, soccerBlock].filter(Boolean).join('');

    // Record opening lines for both teams (fire-and-forget)
    // This ensures we have a baseline for RLM calculation on next analysis
    if (matchedGame.id) {
      recordGameLines(matchedGame.id, homeTeam, awayTeam, h2hHome, h2hAway).catch(() => {});
    }

    return {
      homeTeam,
      awayTeam,
      homeOdds: h2hHome,
      awayOdds: h2hAway,
      oddsBlock: enrichedOddsBlock,
      candidates,
      mlbStats: mlbStatsBlock,
      pitchers:  pitcherData,
      soccer:    soccerData,
      fetchedAt: Date.now(),
    };
  } catch (err) {
    console.warn('fetchLiveGameOdds failed:', err.message);
    return null;
  }
}

// ─── FETCH BY GAME ID ─────────────────────────────────────────────────────────
// Used by server-side prompt generation — fetches the specific game by ID
// rather than relying on a frontend-constructed prompt for game matching.

async function fetchGameById(gameId, sportKey, apiKey) {
  if (!gameId || !sportKey || !apiKey) return null;
  try {
    // Check cache first
    let games = await getCachedOdds(sportKey);
    if (!games) {
      const markets = H2H_ONLY_SPORTS.has(sportKey) ? 'h2h' : 'h2h,spreads,totals';
      const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds/?apiKey=${apiKey}&regions=us&markets=${markets}&oddsFormat=american`;
      const res = await withTimeout(fetch(url), 5000, 'odds api fetch by id');
      if (!res.ok) return null;
      games = await res.json();
      if (!Array.isArray(games)) return null;
      await setCachedOdds(sportKey, games);
    }
    return games.find(g => g.id === gameId) || null;
  } catch (err) {
    console.warn('fetchGameById failed:', err.message);
    return null;
  }
}


module.exports = {
  fetchLiveGameOdds,
  fetchGameById,
  detectSportKey,
  teamNameMatch,
  extractGameTeams,
  fmt,
  fmtPoint,
};
