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

// Showdown (GPP) format for NBA (6 players), standard for MLB (9/10)
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

function buildPrompt({ sport, platform, contestType, salaryCap, slots, liveData }) {
  const today = new Date().toISOString().slice(0, 10);
  const isGpp = contestType === 'gpp';
  const isNba = sport === 'nba';
  const platformName = platform === 'draftkings' ? 'DraftKings' : 'FanDuel';

  const gamesCtx = liveData.length
    ? `TODAY'S ${sport.toUpperCase()} SLATE (${today}):\n` +
      liveData.map(g => `- ${g.awayTeam} @ ${g.homeTeam}${g.total ? ` | Vegas O/U: ${g.total}` : ''}`).join('\n')
    : `No live slate data fetched. Use your best knowledge of today's ${sport.toUpperCase()} schedule (${today}).`;

  const nbaAlgo = `
NBA SCORING ALGORITHM:
- Ceiling projection = FPPG × 1.25 for guards and wings (high variance). Use realistic FPPG from recent game logs.
- Blocks and steals weighted +40% in scoring (each worth 3 pts DK / 2 pts FD) — prioritize players who generate defensive stats.
- Value score = ceiling FPPG / salary × 1000.
- ${slots[0]} (captain/MVP) slot: AI should note this player earns 1.5× points, so project ceiling × 1.5 but salary is also 1.5× — still recalculate value.
- EXCLUDE any player listed Out or Doubtful from injury reports.
- EXCLUDE any player tagged HAMSTRING, ANKLE, or HIP unless confirmed active today.
- Include Questionable players ONLY with a clear injury note.
- Prioritize players facing teams ranked 25th–30th in defensive efficiency at their position (bottom-5 defense = best matchup).
- ${isGpp ? 'GPP: maximize ceiling. Include 1-2 low-ownership plays (<20% projected own%). Avoid chalk over 40%.' : 'Cash: maximize floor/safety. Prefer high-FPPG-per-game averages. Avoid injury risk.'}
`;

  const mlbAlgo = `
MLB SCORING ALGORITHM:
- Starting pitchers: score by K/9 rate (higher = better), ERA (lower = better), weak opposing lineup OPS.
- Batting stacks: select 3-4 consecutive batters from the same team when game O/U > 8.5.
- Ballpark modifiers:
    * Coors Field (COL): +15% offensive boost — avoid pitching SPs there in GPP.
    * Petco Park (SD), Oracle Park (SF), Dodger Stadium (LAD): -10% offensive — prefer SPs in these parks.
- Platoon splits: LHB vs RHP = advantage. RHB vs LHP = advantage.
- High O/U (>9.0): target offensive players; avoid SP from that game.
- Low O/U (<7.5): prioritize SP in a pitcher's duel.
- Check weather for today's games — note any wind carrying out to CF (scorer) or rain delays.
- Value = projected FPPG / salary × 1000.
- ${isGpp ? 'GPP: build stacks, target contrarian SP. Avoid consensus chalk (>35% ownership).' : 'Cash: safe batters (high floor), elite SPs with easy matchups. No risky stacks.'}
`;

  const algoBlock = isNba ? nbaAlgo : mlbAlgo;

  const jsonTemplate = [
    '{',
    '  "lineup": [',
    slots.map((slot, i) => [
      `    {`,
      `      "slot": "${slot}",`,
      `      "name": "Player Full Name",`,
      `      "team": "TEAM",`,
      `      "opponent": "OPP",`,
      `      "position": "${isNba ? 'PG' : (i < 2 ? 'SP' : '1B')}",`,
      `      "salary": ${Math.floor(salaryCap / slots.length)},`,
      `      "projectedFppg": 38.5,`,
      `      "ceilingFppg": 48.1,`,
      `      "valueScore": 6.25,`,
      `      "injuryStatus": null,`,
      `      "injuryNote": null,`,
      `      "ownershipPct": 18,`,
      `      "notes": "brief reason for selection"`,
      `    }${i < slots.length - 1 ? ',' : ''}`,
    ].join('\n')).join('\n'),
    '  ],',
    `  "totalProjectedPoints": 280.0,`,
    `  "totalCeilingPoints": 350.0,`,
    `  "totalSalary": ${salaryCap - 400},`,
    `  "salaryCap": ${salaryCap},`,
    `  "remainingSalary": 400,`,
    `  "stackInfo": ${isNba ? 'null' : '"e.g. Dodgers 3-stack: Freeman, Betts, Smith"'},`,
    `  "weatherAlert": null,`,
    `  "ownershipWarning": null,`,
    `  "summary": "2-3 sentence explanation of lineup construction strategy"`,
    '}',
  ].join('\n');

  return [
    `You are an expert DFS optimizer for ${platformName} ${sport.toUpperCase()} ${isGpp ? 'GPP tournaments' : 'cash games'}.`,
    `Today is ${today}. Salary cap: $${salaryCap.toLocaleString()}. Platform: ${platformName}.`,
    '',
    gamesCtx,
    '',
    algoBlock,
    '',
    'Use web search to verify:',
    '  1. Today\'s injury reports (ESPN, NBA.com, MLB.com)',
    isNba
      ? '  2. Current DraftKings/FanDuel NBA player salaries and recent FPPG averages'
      : '  2. Current DraftKings/FanDuel MLB player salaries and recent FPPG averages',
    isNba
      ? '  3. Tonight\'s defensive matchups (opponent defensive rank per position)'
      : '  3. Starting pitchers confirmed for today\'s games and weather conditions',
    '',
    `LINEUP SLOTS (${slots.length} players): ${slots.join(', ')}`,
    `CRITICAL: Total salary MUST be at or under $${salaryCap.toLocaleString()}.`,
    'CRITICAL: Use REAL player names and REALISTIC salaries/projections for today.',
    '',
    'Return ONLY raw JSON — no markdown, no code fences, no preamble. Start with { and end with }.',
    '',
    'JSON format:',
    jsonTemplate,
  ].join('\n');
}

router.post('/optimize', async (req, res) => {
  const session = verifySession(req.cookies && req.cookies.edge_session);
  if (!session || !session.email) {
    return fail(res, 401, { error: 'Login required', data: { authRequired: true } });
  }

  const { sport = 'nba', platform = 'draftkings', contestType = 'gpp' } = req.body || {};

  if (!['nba', 'mlb'].includes(sport))         return fail(res, 400, { error: 'Invalid sport. Use nba or mlb.' });
  if (!['draftkings', 'fanduel'].includes(platform)) return fail(res, 400, { error: 'Invalid platform.' });
  if (!['gpp', 'cash'].includes(contestType))  return fail(res, 400, { error: 'Invalid contestType. Use gpp or cash.' });

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

  const prompt = buildPrompt({ sport, platform, contestType, salaryCap, slots, liveData });

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      system: 'You are an expert DFS lineup optimizer. Use web search to get current data. Return ONLY raw JSON. Start with { and end with }. No markdown, no code fences.',
      messages: [{ role: 'user', content: prompt }],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    }, { timeout: 120000 });

    const rawText = (response.content || [])
      .filter(b => b.type === 'text' && b.text)
      .map(b => b.text)
      .join('\n')
      .trim();

    const match = rawText.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Optimizer returned no structured data. Try again.');

    const clean = match[0]
      .replace(/\/\/[^\n]*/g, '')
      .replace(/,(\s*[}\]])/g, '$1');

    const lineupData = JSON.parse(clean);

    // Deduct credit after success (fire-and-forget)
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
