const express = require('express');
const router = express.Router();
const Anthropic = require('@anthropic-ai/sdk');
const { getUser, addCredits } = require('../lib/users');
const { verifySession } = require('../lib/auth');
const { ok, fail } = require('../lib/http');
const { OWNER_EMAILS } = require('../lib/owners');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

const SALARY_CAPS = {
  draftkings: { nba: 50000, mlb: 50000 },
  fanduel:    { nba: 60000, mlb: 35000 },
};

const LINEUP_SLOTS = {
  nba: {
    draftkings: ['CPT', 'FLEX', 'FLEX', 'FLEX', 'FLEX', 'FLEX'],
    fanduel:    ['MVP', 'STAR', 'STAR', 'PRO', 'PRO', 'UTIL'],
  },
  mlb: {
    draftkings: ['P', 'P', 'C', '1B', '2B', '3B', 'SS', 'OF', 'OF', 'OF'],
    fanduel:    ['P', 'C/1B', '2B', '3B', 'SS', 'OF', 'OF', 'OF', 'UTIL'],
  },
};

async function fetchMlbTotals(apiKey) {
  if (!apiKey) return [];
  try {
    const url = `https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?apiKey=${apiKey}&regions=us&markets=totals&oddsFormat=american`;
    const res = await withTimeout(fetch(url), 5000, 'mlb totals');
    if (!res.ok) return [];
    const games = await res.json();
    if (!Array.isArray(games)) return [];
    return games.map(g => {
      const bk = (g.bookmakers || [])[0];
      const mkt = bk && (bk.markets || []).find(m => m.key === 'totals');
      const over = mkt && (mkt.outcomes || []).find(o => o.name === 'Over');
      return {
        homeTeam: g.home_team,
        awayTeam: g.away_team,
        total: over ? over.point : null,
        commenceTime: g.commence_time,
      };
    }).filter(g => g.total != null);
  } catch { return []; }
}

async function fetchNbaGames(apiKey) {
  if (!apiKey) return [];
  try {
    const url = `https://api.the-odds-api.com/v4/sports/basketball_nba/odds/?apiKey=${apiKey}&regions=us&markets=totals&oddsFormat=american`;
    const res = await withTimeout(fetch(url), 5000, 'nba games');
    if (!res.ok) return [];
    const games = await res.json();
    if (!Array.isArray(games)) return [];
    return games.map(g => {
      const bk = (g.bookmakers || [])[0];
      const mkt = bk && (bk.markets || []).find(m => m.key === 'totals');
      const over = mkt && (mkt.outcomes || []).find(o => o.name === 'Over');
      return {
        homeTeam: g.home_team,
        awayTeam: g.away_team,
        total: over ? over.point : null,
        commenceTime: g.commence_time,
      };
    });
  } catch { return []; }
}

function buildPrompt({ sport, platform, contestType, salaryCap, slots, liveData, injuryFilter, lockedPlayers, excludedPlayers }) {
  const today = new Date().toISOString().slice(0, 10);
  const isGpp = contestType === 'gpp';
  const isNba = sport === 'nba';
  const platformName = platform === 'draftkings' ? 'DraftKings' : 'FanDuel';
  const mvpSlot = slots[0];

  const gamesCtx = liveData.length
    ? `TODAY'S ${sport.toUpperCase()} SLATE (${today}):\n` +
      liveData.map(g => `- ${g.awayTeam} @ ${g.homeTeam}${g.total ? ` | Vegas O/U: ${g.total}` : ''}`).join('\n')
    : `No live slate data available. Use your knowledge of today's ${sport.toUpperCase()} schedule (${today}).`;

  const injuryInstruction = injuryFilter === 'q_and_out'
    ? 'EXCLUDE all players listed OUT or Questionable (Q). Do not include any injured players.'
    : injuryFilter === 'all'
    ? 'Include all players regardless of injury status. Flag all injuries clearly in injuryStatus.'
    : 'EXCLUDE players listed OUT only. Include Questionable (Q) players — they may offer GPP leverage when confirmed active.';

  const qHandling = injuryFilter !== 'q_and_out'
    ? `QUESTIONABLE PLAYER HANDLING (critical):
- Do NOT automatically exclude Q players. Check confirmation status via web search (ESPN injury report, team beat reporters).
- If Q player is CONFIRMED ACTIVE today: set confirmedActive=true, injuryNote="[Injury] — CONFIRMED ACTIVE", add to confirmedActivePlayers array. These are HIGH VALUE GPP plays — lower ownership = contrarian edge.
- If Q player confirmation is unknown: include if high upside; set confirmedActive=false, flag with injuryStatus="Q".
- PRIME MVP candidate (primeMvp=true): Q player confirmed active + high blocks/steals upside + projected ownership <20%.
- Add all confirmed Q players to confirmedActivePlayers array in the JSON response.`
    : 'All Q and OUT players excluded per filter setting.';

  const lockExclude = [
    lockedPlayers && lockedPlayers.length ? `LOCKED (MUST include these players in lineup): ${lockedPlayers.join(', ')}` : '',
    excludedPlayers && excludedPlayers.length ? `EXCLUDED (MUST NOT include these players): ${excludedPlayers.join(', ')}` : '',
  ].filter(Boolean).join('\n');

  const nbaAlgo = `
NBA ${isGpp ? 'GPP TOURNAMENT' : 'CASH GAME'} ALGORITHM:

PROJECTIONS:
- Floor projection = FPPG × 0.7 (conservative, use for cash game selection)
- Ceiling projection = FPPG × 1.3 for high-variance players (guards, wings); × 1.15 for bigs
- Blocks and steals weighted +40% in player value (DK: BLK=2pts, STL=2pts — top scoring categories)
- Prioritize players with 1.5+ combined BLK+STL per game for defensive value
- Value score = ceilingFppg / salary × 1000

${mvpSlot}/CAPTAIN SLOT LOGIC:
- ${mvpSlot} earns 1.5× points but costs 1.5× salary (same ratio, but highest raw ceiling wins)
- TRUE ${mvpSlot} VALUE: select player with highest raw ceiling output (ceilingFppg × 1.5 total points)
- PRIME MVP criteria: high BLK+STL upside + confirmed active (if Q) + projected ownership <20%
- NEVER select an OUT player as ${mvpSlot}
- Prioritize defensive playmakers as ${mvpSlot} — 1.5× multiplier amplifies their block/steal value

OWNERSHIP (estimate for GPP):
- Players with low salary + top matchup (facing 1st-5th OPRK at position) = high chalk risk (>30% owned)
- Q players confirmed active = low ownership (<15%) = prime GPP leverage
- Flag any player projected >30% owned as CHALK in ownershipPct field
- ${isGpp ? 'GPP: target 1-2 contrarian plays (<20% projected ownership). Avoid full chalk lineups.' : 'Cash: ignore ownership, prioritize floor/consistency.'}

STACKING (GPP):
${isGpp ? `- Include 2-3 players from the same team in the game with highest O/U
- Stack PG + SF/SG from same team, or C who benefits from high-assist PG
- Avoid stacking two centers/power forwards from same team (compete for same stats)
- Report stack in stackInfo field` : '- No stacking required for cash games.'}

MATCHUP PRIORITY:
- Best matchup: player facing team ranked 25th-30th in defensive efficiency at their position
- Verify opponent defensive rank via web search (NBA.com or Basketball Reference)
`;

  const mlbAlgo = `
MLB ${isGpp ? 'GPP TOURNAMENT' : 'CASH GAME'} ALGORITHM:

STARTING PITCHERS:
- Score by: K/9 rate (weight ×2), ERA inverse (lower is better), opposing team batting OPS
- ONLY include pitchers with CONFIRMED starts — verify via web search (beat reporters, MLB.com)
- ${isGpp ? 'High O/U (>8.5): avoid the SP from that game. Low O/U (<7.5): prioritize SP in pitcher\'s duel.' : 'Cash: elite SPs with easy matchups, no injury risk, confirmed start.'}

BATTERS:
- Build batting stacks: 3-4 consecutive batters from same team in games with O/U > 8.5
- Pair SP with batters from the OPPOSING team (correlated exposure)
- Platoon advantage: LHB vs RHP = edge; RHB vs LHP = edge
- Floor = FPPG × 0.7, Ceiling = FPPG × 1.3

BALLPARK FACTORS (apply as multiplier to ceiling):
- Coors Field (COL home games): +15% offensive boost — avoid pitching there in GPP
- Petco Park (SD), Oracle Park (SF), Dodger Stadium (LAD): -10% offensive — prefer SPs
- Report park factor in notes field

WEATHER (use web search):
- Wind out to CF at 10+ mph = +8% HR boost for batters in that game
- Rain delay risk = flag in weatherAlert
- Dome games = no weather factor

OWNERSHIP:
- Consensus chalk batters (>30% ownership) = avoid in GPP
- Contrarian SP in favorable home game = GPP leverage
${isGpp ? '- Target team stacks with <25% individual player ownership' : '- Cash: elite floor players, confirmed starts only'}
`;

  const algoBlock = isNba ? nbaAlgo : mlbAlgo;

  const playerSlotTemplate = (slot, i) => {
    const isFirst = i === 0;
    const pos = isNba ? (i < 2 ? 'PG' : 'SF') : (i < 2 ? 'SP' : '1B');
    return `    {
      "slot": "${slot}",
      "name": "Real Player Name",
      "team": "TEAM",
      "opponent": "OPP",
      "position": "${pos}",
      "salary": ${Math.floor(salaryCap / slots.length)},
      "projectedFppg": 38.5,
      "ceilingFppg": ${(38.5 * 1.3).toFixed(1)},
      "floorFppg": ${(38.5 * 0.7).toFixed(1)},
      "valueScore": 6.25,
      "ownershipPct": 18,
      "injuryStatus": null,
      "injuryNote": null,
      "confirmedActive": false,
      "primeMvp": ${isFirst ? 'true' : 'false'},
      "notes": "brief reason: matchup, ceiling, value, stack"
    }${i < slots.length - 1 ? ',' : ''}`;
  };

  const jsonTemplate = `{
  "lineup": [
${slots.map((slot, i) => playerSlotTemplate(slot, i)).join('\n')}
  ],
  "totalProjectedPoints": 280.0,
  "totalCeilingPoints": 350.0,
  "totalFloorPoints": 210.0,
  "totalSalary": ${salaryCap - 400},
  "salaryCap": ${salaryCap},
  "remainingSalary": 400,
  "stackInfo": ${isNba ? '"e.g. LAL 3-stack: LeBron, AD, Reaves (high O/U game)"' : '"e.g. LAD 4-stack: Freeman, Betts, Smith, Muncy"'},
  "weatherAlert": null,
  "ownershipWarning": null,
  "confirmedActivePlayers": [],
  "lateNewsItems": [],
  "summary": "2-3 sentence strategy explanation: why these players, what edge you have, key risk"
}`;

  return [
    `You are an expert DFS optimizer for ${platformName} ${sport.toUpperCase()} ${isGpp ? 'GPP tournaments' : 'cash games'}.`,
    `Today is ${today}. Salary cap: $${salaryCap.toLocaleString()}. Platform: ${platformName}.`,
    '',
    gamesCtx,
    '',
    algoBlock,
    'INJURY FILTER SETTING:',
    injuryInstruction,
    '',
    qHandling,
    '',
    lockExclude || '',
    '',
    'USE WEB SEARCH TO VERIFY (search before building lineup):',
    `  1. Today's ${sport.toUpperCase()} injury report — ESPN, ${isNba ? 'NBA.com' : 'MLB.com'}, team reporters`,
    `  2. Current ${platformName} ${sport.toUpperCase()} salaries and recent FPPG averages (last 5-10 games)`,
    isNba
      ? '  3. Tonight\'s defensive matchups: opponent OPRK per position (Basketball Reference or ESPN)'
      : '  3. Confirmed starting pitchers + weather/wind conditions for today\'s games',
    '  4. Late-breaking news from past 2 hours: scratches, confirmations, minutes restrictions',
    '',
    `LINEUP SLOTS (${slots.length} players total): ${slots.join(', ')}`,
    `HARD CONSTRAINT: Total salary MUST NOT exceed $${salaryCap.toLocaleString()}.`,
    'HARD CONSTRAINT: Use REAL player names. Realistic salaries and FPPG for today\'s slate.',
    'HARD CONSTRAINT: Populate lateNewsItems with any injury updates or lineup changes found.',
    'HARD CONSTRAINT: If no players are confirmed active from Q list, leave confirmedActivePlayers empty array.',
    '',
    'Return ONLY raw JSON. No markdown, no code fences, no // comments, no preamble. Start with { end with }.',
    '',
    'Required JSON format:',
    jsonTemplate,
  ].filter(l => l !== undefined).join('\n');
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
    lockedPlayers = [],
    excludedPlayers = [],
  } = req.body || {};

  if (!['nba', 'mlb'].includes(sport))              return fail(res, 400, { error: 'Invalid sport. Use nba or mlb.' });
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

  const salaryCap = SALARY_CAPS[platform][sport];
  const slots     = LINEUP_SLOTS[sport][platform];

  const apiKey = process.env.THE_ODDS_API_KEY || process.env.ODDS_API_KEY || process.env.ODDS_KEY;
  let liveData = [];
  try {
    liveData = sport === 'mlb' ? await fetchMlbTotals(apiKey) : await fetchNbaGames(apiKey);
  } catch { liveData = []; }

  const prompt = buildPrompt({
    sport, platform, contestType, salaryCap, slots, liveData,
    injuryFilter,
    lockedPlayers: Array.isArray(lockedPlayers) ? lockedPlayers : [],
    excludedPlayers: Array.isArray(excludedPlayers) ? excludedPlayers : [],
  });

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
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
    if (!match) throw new Error('Optimizer returned no structured lineup. Please try again.');

    const clean = match[0]
      .replace(/\/\/[^\n]*/g, '')
      .replace(/,(\s*[}\]])/g, '$1');

    const lineupData = JSON.parse(clean);

    if (!user.isSubscriber && !isOwner) {
      withTimeout(addCredits(userId, -1), 3000, 'credit deduct').catch(() => {});
    }

    return ok(res, { data: lineupData });
  } catch (err) {
    const status = err.status || err.statusCode;
    console.error('DFS optimize error:', err.message);
    if (status === 429) return fail(res, 429, { error: 'AI rate limit hit. Wait a moment and try again.' });
    if (status === 401 || status === 403) return fail(res, status, { error: 'AI API key issue.' });
    return fail(res, 500, { error: err.message || 'DFS optimization failed. Try again.' });
  }
});

module.exports = router;
