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

module.exports = {
  fetchMLBTeamStats,
  fetchMLBTeamStatsBlock,
  resolveMLBTeamId,
};
