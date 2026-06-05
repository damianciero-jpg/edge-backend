'use strict';
// ─── EVALUATION ENGINE ────────────────────────────────────────────────────────
// Core EV math: implied probability, vig removal, edge scoring, candidate
// evaluation. Team form signal converts MLB stats into a scoring input.

const { clampProbability, getConfidence, getEdgeStrength, getRecommendedAction, getRisk, getVerdict, percent, roundNumber } = require('./verdict-engine');

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

function extractGameTeams(prompt) {
  const match = String(prompt || '').match(/\bGAME:\s*([^\n@]+?)\s+@\s+([^\n]+)/i);
  if (!match) return null;
  return {
    away: match[1].trim(),
    home: match[2].trim(),
  };
}
function promptBody(prompt) {
  return String(prompt || '').split(/\nINSTRUCTIONS:/i)[0];
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

function keywordScore(text, positivePatterns, negativePatterns) {
  const source = String(text || '').toLowerCase();
  const positives = positivePatterns.reduce((sum, pattern) => sum + (pattern.test(source) ? 1 : 0), 0);
  const negatives = negativePatterns.reduce((sum, pattern) => sum + (pattern.test(source) ? 1 : 0), 0);

  return Math.max(-10, Math.min(10, (positives - negatives) * 3));
}

function formatAmericanOdds(odds) {
  const value = Number(odds);
  if (!Number.isFinite(value)) return '';
  return value > 0 ? `+${value}` : String(value);
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

function extractPromptPlay(prompt) {
  const source = promptBody(prompt);
  const labeled = source.match(/\b(?:pick|play|bet|side)\s*:?\s*([A-Z][A-Za-z0-9 .'-]{1,60}?(?:\s+(?:ML|moneyline|spread|over|under))?(?:\s+[+-]\d{2,4})?)\b/i);
  if (labeled && !/\bprompt\b/i.test(labeled[1])) return labeled[1].replace(/\s+/g, ' ').trim();

  const moneyline = source.match(/\b([A-Z][A-Za-z .'-]{1,40}\s+(?:ML|moneyline)\s+[+-]\d{2,4})\b/i);
  if (moneyline) return moneyline[1].replace(/\s+/g, ' ').trim();

  return '';
}


function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

function computeTeamFormSignal(stats, isHome) {
  if (!stats) return 0;
  let signal = 0;

  if (stats.record) {
    const [w, l] = stats.record.split('-').map(Number);
    const total = (w || 0) + (l || 0);
    if (total > 0) {
      const pct = (w || 0) / total;
      signal += pct > 0.55 ? 3 : pct > 0.50 ? 1 : pct < 0.45 ? -3 : -1;
    }
  }

  const splitRecord = isHome ? stats.homeRecord : stats.awayRecord;
  if (splitRecord) {
    const [w, l] = splitRecord.split('-').map(Number);
    const total = (w || 0) + (l || 0);
    if (total > 0) {
      const pct = (w || 0) / total;
      signal += pct > 0.60 ? 4 : pct > 0.50 ? 1 : pct < 0.40 ? -4 : -1;
    }
  }

  if (stats.streak) {
    const m = stats.streak.match(/^([WL])(\d+)$/);
    if (m) {
      const n = Math.min(parseInt(m[2], 10), 5);
      signal += m[1] === 'W' ? n : -n;
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

module.exports = {
  impliedProb,
  vigRemoved,
  computeEdgeScore,
  buildCandidateEvaluation,
  buildEdgeEvaluation,
  extractPinnacleOdds,
  calcVig,
  passPick,
  extractGameTeams,
  promptBody,
  extractAmericanOdds,
  normalizeOddsValue,
};
