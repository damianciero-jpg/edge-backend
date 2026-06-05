'use strict';
// ─── MLB SERVICE ──────────────────────────────────────────────────────────────
// Fetches real team records, home/away splits, and streaks from the free
// MLB Stats API (no key required). Used to enrich edge score with team form.

const { withTimeout } = require('./ai-service');
const { hasRedisConfig, createRedis } = require('../redis');

// ─── MLB STANDINGS CACHE ──────────────────────────────────────────────────────
// Cache standings for 5 minutes — standings change slowly and are fetched
// for every MLB game evaluation. One fetch per 5-min window saves many calls.
const MLB_CACHE_TTL = 300; // 5 minutes in seconds

async function getCachedStandings(season) {
  if (!hasRedisConfig()) return null;
  try {
    const redis = createRedis();
    const cached = await withTimeout(redis.get(`edge:mlb:standings:${season}`), 2000, 'mlb cache get');
    return cached || null;
  } catch { return null; }
}

async function setCachedStandings(season, data) {
  if (!hasRedisConfig()) return;
  try {
    const redis = createRedis();
    await withTimeout(
      redis.set(`edge:mlb:standings:${season}`, data, { ex: MLB_CACHE_TTL }),
      2000, 'mlb cache set'
    );
  } catch { /* non-fatal */ }
}

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

    // Check cache first — standings valid for 5 minutes
    let data = await getCachedStandings(season);
    if (!data) {
      const res = await withTimeout(
        fetch(`https://statsapi.mlb.com/api/v1/standings?leagueId=103,104&season=${season}&standingsTypes=regularSeason`),
        4000, 'mlb standings'
      );
      if (!res.ok) return null;
      data = await res.json();
      await setCachedStandings(season, data);
      console.log('[MLB] Standings fetched from API and cached');
    }

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

// ─── PROBABLE PITCHER CACHE ───────────────────────────────────────────────────
const PITCHER_CACHE_TTL = 1800; // 30 minutes — starters set by game time

async function getCachedPitchers(gameId) {
  if (!hasRedisConfig()) return null;
  try {
    const redis = createRedis();
    const cached = await withTimeout(redis.get(`edge:mlb:pitchers:${gameId}`), 2000, 'pitcher cache get');
    return cached || null;
  } catch { return null; }
}

async function setCachedPitchers(gameId, data) {
  if (!hasRedisConfig()) return;
  try {
    const redis = createRedis();
    await withTimeout(
      redis.set(`edge:mlb:pitchers:${gameId}`, data, { ex: PITCHER_CACHE_TTL }),
      2000, 'pitcher cache set'
    );
  } catch { /* non-fatal */ }
}

// ─── PITCHER STATS ────────────────────────────────────────────────────────────
// Fetches probable starters and their season stats from the free MLB Stats API.
// Endpoint: /api/v1/schedule with hydrations for probablePitcher and person stats.

async function fetchProbablePitchers(gameId) {
  if (!gameId) return null;

  // Check cache first
  const cached = await getCachedPitchers(gameId);
  if (cached) return cached;

  try {
    // Get today's schedule with probable pitchers
    const today = new Date().toISOString().slice(0, 10);
    const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${today}&hydrate=probablePitcher(note),linescore`;
    const res = await withTimeout(fetch(url), 4000, 'mlb schedule');
    if (!res.ok) return null;

    const data = await res.json();
    const dates = data.dates || [];

    for (const date of dates) {
      for (const game of (date.games || [])) {
        // Match by game ID if possible, otherwise by date
        const gamePk = String(game.gamePk || '');

        const homePitcher = game.teams?.home?.probablePitcher;
        const awayPitcher = game.teams?.away?.probablePitcher;

        if (!homePitcher && !awayPitcher) continue;

        // Fetch season stats for each pitcher
        const [homeStats, awayStats] = await Promise.all([
          homePitcher ? fetchPitcherStats(homePitcher.id) : Promise.resolve(null),
          awayPitcher ? fetchPitcherStats(awayPitcher.id) : Promise.resolve(null),
        ]);

        const result = {
          gamePk,
          home: homePitcher ? {
            name:     homePitcher.fullName || homePitcher.lastFirstName || 'TBD',
            id:       homePitcher.id,
            ...homeStats,
          } : null,
          away: awayPitcher ? {
            name:     awayPitcher.fullName || awayPitcher.lastFirstName || 'TBD',
            id:       awayPitcher.id,
            ...awayStats,
          } : null,
        };

        // Return the first game with pitchers (we'll refine matching below)
        await setCachedPitchers(gameId, result);
        return result;
      }
    }
  } catch (err) { console.warn('Probable pitchers fetch failed:', err.message); }
  return null;
}

async function fetchProbablePitchersByTeam(homeTeam, awayTeam) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${today}&hydrate=probablePitcher,linescore`;
    const res = await withTimeout(fetch(url), 4000, 'mlb schedule by team');
    if (!res.ok) return null;

    const data = await res.json();
    const dates = data.dates || [];

    for (const date of dates) {
      for (const game of (date.games || [])) {
        const gameHome = String(game.teams?.home?.team?.name || '').toLowerCase();
        const gameAway = String(game.teams?.away?.team?.name || '').toLowerCase();
        const homeL    = homeTeam.toLowerCase();
        const awayL    = awayTeam.toLowerCase();

        // Match by team name (partial ok — "Red Sox" matches "Boston Red Sox")
        const homeMatch = gameHome.includes(homeL) || homeL.split(' ').some(w => w.length > 3 && gameHome.includes(w));
        const awayMatch = gameAway.includes(awayL) || awayL.split(' ').some(w => w.length > 3 && gameAway.includes(w));

        if (!homeMatch || !awayMatch) continue;

        const homePitcher = game.teams?.home?.probablePitcher;
        const awayPitcher = game.teams?.away?.probablePitcher;

        const [homeStats, awayStats] = await Promise.all([
          homePitcher ? fetchPitcherStats(homePitcher.id) : Promise.resolve(null),
          awayPitcher ? fetchPitcherStats(awayPitcher.id) : Promise.resolve(null),
        ]);

        return {
          gamePk: String(game.gamePk || ''),
          home: homePitcher ? { name: homePitcher.fullName || 'TBD', id: homePitcher.id, ...homeStats } : { name: 'TBD', id: null },
          away: awayPitcher ? { name: awayPitcher.fullName || 'TBD', id: awayPitcher.id, ...awayStats } : { name: 'TBD', id: null },
        };
      }
    }
  } catch (err) { console.warn('Probable pitchers by team failed:', err.message); }
  return null;
}

async function fetchPitcherStats(pitcherId) {
  if (!pitcherId) return {};
  try {
    const season = new Date().getFullYear();
    const url = `https://statsapi.mlb.com/api/v1/people/${pitcherId}/stats?stats=season&group=pitching&season=${season}`;
    const res = await withTimeout(fetch(url), 3000, 'pitcher stats');
    if (!res.ok) return {};
    const data = await res.json();
    const stats = data.stats?.[0]?.splits?.[0]?.stat;
    if (!stats) return {};
    return {
      era:    stats.era    || null,
      whip:   stats.whip   || null,
      wins:   stats.wins   || 0,
      losses: stats.losses || 0,
      ip:     stats.inningsPitched || null,
      so:     stats.strikeOuts || null,
      bb:     stats.baseOnBalls || null,
      fip:    stats.fielding || null,
    };
  } catch { return {}; }
}

// ─── PITCHER QUALITY SIGNAL ───────────────────────────────────────────────────
// Converts pitcher stats into a -5 to +5 signal for the selected team's side.
// Positive = our starter has advantage, negative = opponent has advantage.
// ERA is the primary signal; WHIP is secondary.

function calcPitcherQualitySignal(ourPitcher, theirPitcher) {
  if (!ourPitcher || !theirPitcher) return 0;

  const ourERA   = parseFloat(ourPitcher.era);
  const theirERA = parseFloat(theirPitcher.era);
  if (!Number.isFinite(ourERA) || !Number.isFinite(theirERA)) return 0;

  // ERA differential — lower ERA is better
  // A 1.0 ERA difference ≈ 2 signal points, capped at ±5
  const eraDiff = theirERA - ourERA; // positive = we have the better pitcher
  let signal = Math.max(-5, Math.min(5, eraDiff * 2));

  // WHIP adjustment (secondary signal)
  const ourWHIP   = parseFloat(ourPitcher.whip);
  const theirWHIP = parseFloat(theirPitcher.whip);
  if (Number.isFinite(ourWHIP) && Number.isFinite(theirWHIP)) {
    const whipDiff = theirWHIP - ourWHIP;
    signal += Math.max(-1, Math.min(1, whipDiff * 2));
  }

  return Math.max(-5, Math.min(5, signal));
}

// Format pitcher info for the AI prompt block
function formatPitcherBlock(pitchers, homeTeam, awayTeam) {
  if (!pitchers) return null;
  const lines = ['', '--- PROBABLE STARTERS ---'];

  const fmt = (p, team) => {
    if (!p || p.name === 'TBD') return `${team}: TBD`;
    const record = (p.wins != null && p.losses != null) ? `${p.wins}-${p.losses}` : '?-?';
    const era    = p.era  ? `ERA ${p.era}`  : '';
    const whip   = p.whip ? `WHIP ${p.whip}` : '';
    const ip     = p.ip   ? `${p.ip} IP`   : '';
    const parts  = [record, era, whip, ip].filter(Boolean).join(' | ');
    return `${team}: ${p.name} (${parts})`;
  };

  lines.push(fmt(pitchers.home, homeTeam));
  lines.push(fmt(pitchers.away, awayTeam));
  return lines.join('\n');
}


module.exports = {
  fetchMLBTeamStats,
  fetchMLBTeamStatsBlock,
  fetchProbablePitchersByTeam,
  calcPitcherQualitySignal,
  formatPitcherBlock,
  resolveMLBTeamId,
};
