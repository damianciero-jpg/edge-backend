'use strict';
// ─── SOCCER SERVICE ───────────────────────────────────────────────────────────
// Fetches team form, injuries, and standings from API-Football (free tier).
// Mirrors the MLB service pattern: structured context block for the AI prompt
// plus a numeric form signal feeding into the edge score.
//
// Env: API_FOOTBALL_KEY (from https://www.api-football.com — free tier 100 req/day)

const { withTimeout } = require('./ai-service');
const { hasRedisConfig, createRedis } = require('../redis');

const API_BASE = 'https://v3.football.api-sports.io';

// Cache aggressively — free tier is 100 requests/day
const TEAM_SEARCH_TTL = 7 * 24 * 60 * 60; // team ID lookups: 7 days (never change)
const FORM_TTL        = 30 * 60;          // form/fixtures: 30 minutes
const INJURY_TTL      = 60 * 60;          // injuries: 1 hour

function apiKey() {
  return process.env.API_FOOTBALL_KEY || null;
}

async function cacheGet(key) {
  if (!hasRedisConfig()) return null;
  try {
    const redis = createRedis();
    return await withTimeout(redis.get(key), 2000, 'soccer cache get') || null;
  } catch { return null; }
}

async function cacheSet(key, value, ttl) {
  if (!hasRedisConfig()) return;
  try {
    const redis = createRedis();
    await withTimeout(redis.set(key, value, { ex: ttl }), 2000, 'soccer cache set');
  } catch { /* non-fatal */ }
}

async function apiFetch(path) {
  const key = apiKey();
  if (!key) return null;
  try {
    const res = await withTimeout(
      fetch(`${API_BASE}${path}`, { headers: { 'x-apisports-key': key } }),
      5000, 'api-football'
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.response || null;
  } catch (err) {
    console.warn('[Soccer] API fetch failed:', err.message);
    return null;
  }
}

// ─── TEAM RESOLUTION ──────────────────────────────────────────────────────────
// The Odds API uses names like "Manchester United" — resolve to API-Football IDs.

async function resolveTeamId(teamName) {
  if (!teamName) return null;
  const cacheKey = `edge:soccer:teamid:${teamName.toLowerCase().replace(/\s+/g, '_')}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;

  const results = await apiFetch(`/teams?search=${encodeURIComponent(teamName)}`);
  if (!results || !results.length) return null;

  // Prefer exact name match, else first result
  const lower = teamName.toLowerCase();
  const exact = results.find(r => r.team && r.team.name && r.team.name.toLowerCase() === lower);
  const teamId = (exact || results[0]).team?.id || null;

  if (teamId) await cacheSet(cacheKey, teamId, TEAM_SEARCH_TTL);
  return teamId;
}

// ─── TEAM FORM (last 5 fixtures) ─────────────────────────────────────────────

async function fetchTeamForm(teamName) {
  const teamId = await resolveTeamId(teamName);
  if (!teamId) return null;

  const cacheKey = `edge:soccer:form:${teamId}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;

  const fixtures = await apiFetch(`/fixtures?team=${teamId}&last=5`);
  if (!fixtures || !fixtures.length) return null;

  let wins = 0, draws = 0, losses = 0, goalsFor = 0, goalsAgainst = 0;
  const results = [];

  for (const fx of fixtures) {
    const isHome = fx.teams?.home?.id === teamId;
    const gf = isHome ? (fx.goals?.home ?? 0) : (fx.goals?.away ?? 0);
    const ga = isHome ? (fx.goals?.away ?? 0) : (fx.goals?.home ?? 0);
    goalsFor += gf; goalsAgainst += ga;

    const won  = isHome ? fx.teams?.home?.winner : fx.teams?.away?.winner;
    if (won === true)  { wins++;   results.push('W'); }
    else if (won === false) { losses++; results.push('L'); }
    else { draws++; results.push('D'); }
  }

  const form = {
    teamId,
    record: `${wins}W-${draws}D-${losses}L`,
    formString: results.join(''),
    goalsFor,
    goalsAgainst,
    goalDiff: goalsFor - goalsAgainst,
    last5Points: wins * 3 + draws,
  };

  await cacheSet(cacheKey, form, FORM_TTL);
  return form;
}

// ─── INJURIES / SUSPENSIONS ───────────────────────────────────────────────────

async function fetchTeamInjuries(teamName) {
  const teamId = await resolveTeamId(teamName);
  if (!teamId) return null;

  const cacheKey = `edge:soccer:injuries:${teamId}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;

  const season = new Date().getFullYear();
  const injuries = await apiFetch(`/injuries?team=${teamId}&season=${season}`);
  if (!injuries) return null;

  // Only current/recent — API returns season history; keep last 14 days
  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
  const current = injuries.filter(i => {
    const d = new Date(i.fixture?.date || 0).getTime();
    return d > cutoff;
  }).slice(0, 8).map(i => ({
    player: i.player?.name || 'Unknown',
    reason: i.player?.reason || i.player?.type || 'Injury',
  }));

  const result = { count: current.length, players: current };
  await cacheSet(cacheKey, result, INJURY_TTL);
  return result;
}

// ─── FORM SIGNAL (numeric, feeds edge score) ─────────────────────────────────
// Converts last-5 form differential into a -5..+5 signal for the selected side.
// Points diff is primary; goal diff is secondary tiebreaker.

function calcSoccerFormSignal(ourForm, theirForm) {
  if (!ourForm || !theirForm) return 0;

  // Last-5 points: max 15. A 6-point gap ≈ 2 form-class difference.
  const pointsDiff = (ourForm.last5Points || 0) - (theirForm.last5Points || 0);
  let signal = Math.max(-4, Math.min(4, pointsDiff * 0.5));

  // Goal difference adds at most ±1
  const gdDiff = (ourForm.goalDiff || 0) - (theirForm.goalDiff || 0);
  signal += Math.max(-1, Math.min(1, gdDiff * 0.15));

  return Math.max(-5, Math.min(5, signal));
}

// ─── PROMPT BLOCK ─────────────────────────────────────────────────────────────

function formatSoccerBlock(homeTeam, awayTeam, homeForm, awayForm, homeInj, awayInj) {
  if (!homeForm && !awayForm && !homeInj && !awayInj) return null;

  const lines = ['', '--- SOCCER TEAM DATA (Live) ---'];

  const formLine = (team, f) => f
    ? `${team}: Last 5: ${f.formString} (${f.record}) | GF ${f.goalsFor} GA ${f.goalsAgainst} | ${f.last5Points} pts`
    : `${team}: form unavailable`;

  lines.push(formLine(homeTeam, homeForm));
  lines.push(formLine(awayTeam, awayForm));

  const injLine = (team, inj) => {
    if (!inj || !inj.count) return null;
    const names = inj.players.map(p => `${p.player} (${p.reason})`).join(', ');
    return `${team} injuries/absences: ${names}`;
  };

  const hi = injLine(homeTeam, homeInj);
  const ai = injLine(awayTeam, awayInj);
  if (hi) lines.push(hi);
  if (ai) lines.push(ai);

  return lines.join('\n');
}

// ─── MAIN ENRICHMENT ENTRY ────────────────────────────────────────────────────
// Fetches everything for both teams in parallel. Returns block + signals.

async function fetchSoccerEnrichment(homeTeam, awayTeam) {
  if (!apiKey()) return null;
  try {
    const [homeForm, awayForm, homeInj, awayInj] = await Promise.all([
      fetchTeamForm(homeTeam),
      fetchTeamForm(awayTeam),
      fetchTeamInjuries(homeTeam),
      fetchTeamInjuries(awayTeam),
    ]);

    if (!homeForm && !awayForm) return null;

    return {
      block: formatSoccerBlock(homeTeam, awayTeam, homeForm, awayForm, homeInj, awayInj),
      homeForm,
      awayForm,
      homeInjuries: homeInj,
      awayInjuries: awayInj,
      // Signal from the HOME side's perspective; away side negates it
      homeFormSignal: calcSoccerFormSignal(homeForm, awayForm),
    };
  } catch (err) {
    console.warn('[Soccer] Enrichment failed:', err.message);
    return null;
  }
}

module.exports = {
  fetchSoccerEnrichment,
  fetchTeamForm,
  fetchTeamInjuries,
  calcSoccerFormSignal,
  formatSoccerBlock,
  resolveTeamId,
};
