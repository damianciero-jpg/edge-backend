'use strict';
// ─── VERDICT ENGINE ──────────────────────────────────────────────────────────
// Pure scoring functions: thresholds, confidence, risk, recommended action.
// No I/O, no external dependencies.

function clampProbability(value) {
  return Math.min(0.99, Math.max(0.01, value));
}

function roundNumber(value, digits = 4) {
  return Number(value.toFixed(digits));
}

function percent(value) {
  return `${roundNumber(value * 100, 1)}%`;
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

function getVerdict(score) {
  // Require meaningful positive score for any recommendation.
  // score > 0 but < 1 is noise — too small to act on.
  if (score > 5)   return 'BET';
  if (score > 1.5) return 'LEAN';
  return 'PASS';
}

function getConfidence(score) {
  if (score > 7) return 'HIGH';
  if (score > 3) return 'MEDIUM';
  if (score > 0) return 'LOW';
  return 'VERY LOW';
}

module.exports = {
  clampProbability,
  roundNumber,
  percent,
  getRisk,
  getEdgeStrength,
  getRecommendedAction,
  getVerdict,
  getConfidence,
};
