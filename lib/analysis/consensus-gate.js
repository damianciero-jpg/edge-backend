'use strict';
const { cleanJsonText } = require('./ai-service');
// ─── CONSENSUS GATE ──────────────────────────────────────────────────────────
// Compares algorithm verdict vs AI verdict and applies consensus rules.
// Research Mode override allows AI to upgrade PASS to LEAN when score > -3.

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

function applyConsensusGate(algoVerdict, aiVerdict, edgeScore, mode, forceRecommendation) {
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

  let result;
  if (algo === 'PASS')                        result = { verdict: 'PASS', conflicted: false };
  else if (algo === 'BET' && ai === 'BET')    result = { verdict: 'BET',  conflicted: false };
  else if (algo === 'BET' && ai === 'LEAN')   result = { verdict: 'LEAN', conflicted: false };
  else if (algo === 'BET' && ai === 'PASS')   result = { verdict: 'PASS', conflicted: true  };
  else if (algo === 'LEAN' && ai === 'BET')   result = { verdict: 'LEAN', conflicted: false };
  else if (algo === 'LEAN' && ai === 'LEAN')  result = { verdict: 'LEAN', conflicted: false };
  else if (algo === 'LEAN' && ai === 'PASS')  result = { verdict: 'PASS', conflicted: true  };
  else                                         result = { verdict: algo,   conflicted: false };

  // FORCED RECOMMENDATION: after 4+ consecutive PASSes, override any PASS to LEAN.
  // The AI prompt also instructed BET/LEAN only, so this catches algorithm-driven PASSes.
  // Capped at LEAN regardless of signals — forced picks carry inherent uncertainty.
  if (forceRecommendation && result.verdict === 'PASS') {
    return { verdict: 'LEAN', conflicted: false, forcedPick: true };
  }

  return result;
}

function conflictReason(evaluation, aiVerdict) {
  return `Algorithm identified a ${evaluation.edgeScore > 0 ? '+' : ''}${evaluation.edgeScore.toFixed(1)} edge score on ${evaluation.evaluating || evaluation.pick}, but AI analysis returned ${aiVerdict} after reviewing team context, injuries, and matchup data. When algorithm and AI signals conflict, EDGE defaults to PASS — no bet until signals align.`;
}


function parseJsonObject(text) {
  try {
    return JSON.parse(cleanJsonText(text));
  } catch {
    return null;
  }
}

module.exports = {
  parseJsonObject,
  applyConsensusGate,
  conflictReason,
};
