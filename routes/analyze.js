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

function detectSportKey(prompt) {
  const src = String(prompt || '').toLowerCase();
  if (/\bnba\b|lakers|celtics|warriors|nuggets|bucks|heat|76ers|knicks|nets|bulls|cavs|cavaliers|pistons|thunder|timberwolves|spurs/.test(src)) return NBA_SPORT_KEY;
  if (/\bnfl\b|patriots|cowboys|eagles|chiefs|packers|bears|lions|ravens|browns|steelers/.test(src)) return NFL_SPORT_KEY;
  if (/\bmlb\b|yankees|dodgers|red sox|cubs|mets|braves|astros|giants|cardinals/.test(src)) return MLB_SPORT_KEY;
  if (/\bnhl\b|rangers|bruins|maple leafs|canadiens|penguins|lightning|avalanche|oilers/.test(src)) return NHL_SPORT_KEY;
  return NBA_SPORT_KEY; // default
}

function teamNameMatch(promptText, teamName) {
  const src = String(promptText || '').toLowerCase();
  const name = String(teamName || '').toLowerCase();
  // Match full name or last word (city vs nickname)
  const parts = name.split(' ');
  return src.includes(name) || parts.some(p => p.length > 3 && src.includes(p));
}

function fmt(odds) { return odds > 0 ? `+${odds}` : String(odds); }

async function fetchLiveGameOdds(prompt) {
  try {
    const apiKey = process.env.THE_ODDS_API_KEY || process.env.ODDS_API_KEY || process.env.ODDS_KEY;
    if (!apiKey) return null;

    const sportKey = detectSportKey(prompt);
    const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds/?apiKey=${apiKey}&regions=us&markets=h2h,spreads,totals&oddsFormat=american`;
    const res = await withTimeout(fetch(url), 8000, 'odds api fetch');
    if (!res.ok) return null;

    const games = await res.json();
    if (!Array.isArray(games)) return null;

    const matchedGame = games.find(game =>
      teamNameMatch(prompt, game.home_team) || teamNameMatch(prompt, game.away_team)
    );
    if (!matchedGame) return null;

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
    const oddsBlock = [
      `GAME: ${awayTeam} @ ${homeTeam}`,
      '',
      '--- MONEYLINE (h2h) ---',
      `Sharp: ${homeTeam} ${fmt(h2hHome)} | ${awayTeam} ${fmt(h2hAway)}`,
      ...lines.h2h,
      '',
      '--- SPREAD ---',
      spreadHome ? `Sharp: ${homeTeam} ${fmt(spreadHome)} ${spreadPoint} | ${awayTeam} ${fmt(spreadAway)} ${-spreadPoint}` : 'No spread data',
      ...lines.spreads,
      '',
      '--- TOTALS ---',
      totalOver ? `Sharp: Over ${fmt(totalOver)} ${totalPoint} | Under ${fmt(totalUnder)} ${totalPoint}` : 'No totals data',
      ...lines.totals,
    ].join('\n');

    // Build all 6 candidates for evaluation
    const candidates = [
      { market: 'h2h', team: homeTeam, opponent: awayTeam, side: 'home', odds: h2hHome, opponentOdds: h2hAway, label: `${homeTeam} ML ${fmt(h2hHome)}` },
      { market: 'h2h', team: awayTeam, opponent: homeTeam, side: 'away', odds: h2hAway, opponentOdds: h2hHome, label: `${awayTeam} ML ${fmt(h2hAway)}` },
    ];

    if (spreadHome && spreadAway) {
      candidates.push(
        { market: 'spreads', team: homeTeam, opponent: awayTeam, side: 'home', odds: spreadHome, opponentOdds: spreadAway, point: spreadPoint, label: `${homeTeam} ${spreadPoint > 0 ? '+' : ''}${spreadPoint} ${fmt(spreadHome)}` },
        { market: 'spreads', team: awayTeam, opponent: homeTeam, side: 'away', odds: spreadAway, opponentOdds: spreadHome, point: -spreadPoint, label: `${awayTeam} ${-spreadPoint > 0 ? '+' : ''}${-spreadPoint} ${fmt(spreadAway)}` }
      );
    }

    if (totalOver && totalUnder) {
      candidates.push(
        { market: 'totals', team: 'Over', opponent: 'Under', side: 'over', odds: totalOver, opponentOdds: totalUnder, point: totalPoint, label: `Over ${totalPoint} ${fmt(totalOver)}` },
        { market: 'totals', team: 'Under', opponent: 'Over', side: 'under', odds: totalUnder, opponentOdds: totalOver, point: totalPoint, label: `Under ${totalPoint} ${fmt(totalUnder)}` }
      );
    }

    return {
      homeTeam,
      awayTeam,
      homeOdds: h2hHome,
      awayOdds: h2hAway,
      oddsBlock,
      candidates,
    };
  } catch (err) {
    console.warn('fetchLiveGameOdds failed:', err.message);
    return null;
  }
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

/**
 * Score the juice (vig) level.
 */
function vigScore(vigPct) {
  if (vigPct == null) return 0;
  if (vigPct <= 102) return 8;
  if (vigPct <= 104) return 4;
  if (vigPct <= 106) return 0;
  if (vigPct <= 109) return -3;
  return -6;
}

/**
 * Score the spread between sharp (Pinnacle) and square (DraftKings/FanDuel) books.
 */
function sharpSquareSpreadScore(pinnacleOdds, squareOdds) {
  if (pinnacleOdds == null || squareOdds == null) return 0;
  const spread = Number(pinnacleOdds) - Number(squareOdds);
  if (spread >= 15) return 8;
  if (spread >= 8) return 5;
  if (spread >= 3) return 2;
  if (spread >= -3) return 0;
  if (spread >= -8) return -3;
  return -6;
}

/**
 * Main edge scoring — Pinnacle-anchored methodology.
 *
 * Score components:
 * 1. EV against Pinnacle's vig-removed true probability (primary, 50% weight)
 * 2. Juice/vig level of the market (15% weight)
 * 3. Sharp vs square book spread (15% weight)
 * 4. Line movement / CLV signal (10% weight)
 * 5. Contextual keyword signals — form, matchup, injury (10% weight)
 */
function computeEdgeScore({
  implied,
  projected,
  form = 0,
  matchup = 0,
  market = 0,
  sharpSpread = 0,
  lineMovement = 0,
}) {
  let score = 0;

  score += (projected - implied) * 100 * 0.5;
  score += market * 0.15;
  score += sharpSpread * 0.15;
  score += lineMovement * 0.10;
  score += form * 0.05;
  score += matchup * 0.05;

  return score;
}

// ─── FIX 1: LOWERED VERDICT THRESHOLDS ───────────────────────────────────────
// Previous: BET > 8, LEAN > 3, else PASS
// Updated:  BET > 5, LEAN > 1, else PASS
// This allows plus-money underdogs with real value (e.g. score 0.22+) to show
// LEAN instead of defaulting to PASS every time.
function getVerdict(score) {
  if (score > 5) return 'BET';
  if (score > 0) return 'LEAN';
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

function pickLabel(team, odds) {
  return team ? `${team} ML${odds != null ? ` ${formatAmericanOdds(odds)}` : ''}` : 'Best available play';
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
  if (!oddsDetected) {
    implied = 0.5;
    projected = 0.5;
  } else if (pinnacleOdds != null && pinnacleOpponentOdds != null) {
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
    ? getSignalFactors(prompt, odds, opponentOdds, pinnacleOdds, pinnacleOpponentOdds)
    : { form: 0, matchup: 0, market: 0, sharpSpread: 0 };

  const edgeScore = oddsDetected
    ? computeEdgeScore({ implied, projected, ...factors, lineMovement: lineMovementScore })
    : 0;

  const verdict = getVerdict(edgeScore);
  const confidence = getConfidence(edgeScore);
  const risk = getRisk(confidence, edgeScore);
  const edgeStrength = getEdgeStrength(edgeScore);
  const recommendedAction = getRecommendedAction(verdict, confidence);
  const pick = verdict === 'PASS' ? passPick() : pickLabel(candidate && candidate.team, odds);

  return {
    odds,
    oddsDetected,
    selectedSide: candidate && candidate.side,
    selectedTeam: candidate && candidate.team,
    opponentTeam: candidate && candidate.opponent,
    market: (candidate && candidate.market) || 'h2h',
    evaluating: pickLabel(candidate && candidate.team, odds),
    pick,
    impliedProb: roundNumber(implied),
    projectedProb: roundNumber(projected),
    pinnacleUsed: pinnacleOdds != null,
    vigPct: factors.vigPct ? roundNumber(factors.vigPct, 1) : null,
    sharpSpread: factors.sharpSpread || 0,
    lineMovement: lineMovementScore,
    edgeScore: roundNumber(edgeScore, 2),
    verdict,
    confidence,
    risk,
    edgeStrength,
    recommendedAction,
  };
}

function getSignalFactors(prompt, odds, opponentOdds, pinnacleOdds, pinnacleOpponentOdds) {
  const source = promptBody(prompt);

  const form = keywordScore(
    source,
    [/\bhot\b/, /\bstrong form\b/, /\bwon\b/, /\bwinning streak\b/, /\brest advantage\b/, /\bback.to.back\b/],
    [/\bcold\b/, /\bslump\b/, /\blost\b/, /\blosing streak\b/, /\bfatigue\b/]
  );
  const matchup = keywordScore(
    source,
    [/\bmatchup advantage\b/, /\bfavorable matchup\b/, /\bhome advantage\b/, /\bhealthy\b/, /\bpace mismatch\b/],
    [/\bbad matchup\b/, /\bunfavorable matchup\b/, /\binjur(?:y|ies|ed)\b/, /\bquestionable\b/, /\bdoubtful\b/]
  );

  const vigPct = calcVig(odds, opponentOdds);
  const market = vigScore(vigPct);

  const squareOdds = extractSquareBookOdds(prompt, null);
  const sharpSpread = sharpSquareSpreadScore(pinnacleOdds, squareOdds || odds);

  return { form, matchup, market: roundNumber(market, 2), sharpSpread: roundNumber(sharpSpread, 2), vigPct };
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
  const opponent = String(evaluation.opponentTeam || '').toLowerCase();
  if (!opponent || !String(reason).toLowerCase().includes(opponent)) return false;
  return /\b(bet|lean|recommend|pick|play|edge)\b/i.test(reason);
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
    'Explain the reasoning for this pick using the algorithm values above.',
    'Reference the true probability vs implied probability gap as the core value signal.',
    'If line movement data is available, reference whether sharp money agrees or disagrees.',
    'Do not change the verdict. Return strict JSON only.',
    'Do not recommend a different side than the selected pick unless verdict is PASS.',
    '',
    'Return this JSON shape only:',
    '{"reason":"2-3 sentence explanation referencing the value gap and key signals","topFactors":["factor 1","factor 2","factor 3"]}',
  ].filter(Boolean).join('\n');
}

function parseJsonObject(text) {
  try {
    return JSON.parse(cleanJsonText(text));
  } catch {
    return null;
  }
}

function buildStructuredResult(evaluation, aiText) {
  const parsed = parseJsonObject(aiText) || {};
  const parsedReason = parsed.reason || parsed.reasoning;
  const reason = reasonConflictsWithSelectedSide(parsedReason, evaluation)
    ? sideAlignedReason(evaluation)
    : parsedReason || sideAlignedReason(evaluation) || fallbackReason(evaluation.oddsDetected, evaluation.edgeScore);

  return {
    verdict: evaluation.verdict,
    pick: evaluation.pick,
    evaluating: evaluation.evaluating || evaluation.pick,
    selectedSide: evaluation.selectedSide,
    selectedTeam: evaluation.selectedTeam,
    opponentTeam: evaluation.opponentTeam,
    market: evaluation.market,
    confidence: evaluation.confidence,
    risk: evaluation.risk,
    edgeStrength: evaluation.edgeStrength,
    edgeScore: evaluation.edgeScore,
    impliedProb: evaluation.impliedProb,
    projectedProb: evaluation.projectedProb,
    reason,
    topFactors: normalizeTopFactors(parsed.topFactors || parsed.key_factors || parsed.keyFactors, evaluation),
    recommendedAction: evaluation.recommendedAction,
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
      liveOdds = await withTimeout(fetchLiveGameOdds(prompt), 9000, 'live odds');
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
      resolvedMarket = 'h2h';
    }

    let lineMovementScore = 0;
    const lineTeam = (liveOdds && liveOdds.homeTeam) || selectedTeam;
    const lineOpponent = (liveOdds && liveOdds.awayTeam) || opponentTeam;
    if (lineTeam) {
      try {
        const { getLineMovementSignal } = require('../lib/line-tracker');
        const gameId = [lineTeam, lineOpponent].sort().join('_').toLowerCase().replace(/\s+/g, '_')
          + '_' + new Date().toISOString().slice(0, 10);
        const oddsValue = resolvedOdds && typeof resolvedOdds === 'object' ? resolvedOdds.home : resolvedOdds;
        const lm = await withTimeout(getLineMovementSignal(gameId, lineTeam, oddsValue), 2000, 'line movement');
        lineMovementScore = lm.score || 0;
      } catch {
        lineMovementScore = 0;
      }
    }

    // Evaluate all candidates (up to 6: home ML, away ML, home spread, away spread, over, under)
    let evaluation;
    if (liveOdds && liveOdds.candidates && liveOdds.candidates.length) {
      // Zip candidates with their evaluations so index stays stable after sort.
      // allEvals.sort() mutates in place — re-finding the index after sort always
      // returns 0 and maps to candidates[0] (home ML), ignoring the real winner.
      const pairs = liveOdds.candidates.map(c => ({
        candidate: c,
        eval: buildCandidateEvaluation(resolvedPrompt, {
          side: c.side,
          team: c.team,
          opponent: c.opponent,
          market: c.market,
          odds: c.odds,
          opponentOdds: c.opponentOdds,
        }, lineMovementScore),
      }));

      pairs.sort((a, b) => b.eval.edgeScore - a.eval.edgeScore);
      evaluation = pairs[0].eval;

      const bestCandidate = pairs[0].candidate;
      if (bestCandidate && evaluation.verdict !== 'PASS') {
        evaluation.pick = bestCandidate.label;
        evaluation.evaluating = bestCandidate.label;
      }
    } else {
      evaluation = buildEdgeEvaluation(resolvedPrompt, {
        selectedSide: resolvedSelectedSide,
        selectedTeam: resolvedSelectedTeam,
        opponentTeam: resolvedOpponentTeam,
        market: resolvedMarket,
        odds: resolvedOdds,
      }, lineMovementScore);
    }

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

    const scoredPrompt = buildScoredPrompt(resolvedPrompt, evaluation);

    if (evaluation.oddsDetected) {
      try {
        result = await callAnthropic(scoredPrompt, mode);
      } catch (err) {
        if (!process.env.OPENAI_API_KEY) throw err;
        result = await withTimeout(callOpenAI(scoredPrompt, mode), mode === 'deep' ? 45000 : 20000, 'openai fallback');
        fallbackUsed = true;
      }
    } else {
      result = {
        provider: 'edge-scoring',
        model: 'deterministic-fallback',
        text: JSON.stringify(buildStructuredResult(evaluation, '')),
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
