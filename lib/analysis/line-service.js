'use strict';
// ─── LINE SERVICE ─────────────────────────────────────────────────────────────
// Thin wrapper around lib/line-tracker.js.
// Fetches line movement signal for a game/team pair with a timeout guard.

const { withTimeout } = require('./ai-service');
const { getLineMovementSignal } = require('../line-tracker');

async function fetchLineMovement(homeTeam, awayTeam, currentOdds) {
  if (!homeTeam) return { score: 0, direction: 'UNKNOWN', basisPoints: 0, openingOdds: null, currentOdds, team: homeTeam };
  try {
    const gameId = [homeTeam, awayTeam].sort().join('_').toLowerCase().replace(/\s+/g, '_')
      + '_' + new Date().toISOString().slice(0, 10);
    const oddsValue = currentOdds && typeof currentOdds === 'object' ? currentOdds.home : currentOdds;
    const lm = await withTimeout(getLineMovementSignal(gameId, homeTeam, oddsValue), 5000, 'line movement');
    return {
      score:        lm.score        || 0,
      direction:    lm.direction    || 'UNKNOWN',
      basisPoints:  lm.basisPoints  || 0,
      openingOdds:  lm.openingOdds  || null,
      currentOdds:  lm.currentOdds  || null,
      team: homeTeam,
    };
  } catch {
    return { score: 0, direction: 'UNKNOWN', basisPoints: 0, openingOdds: null, currentOdds, team: homeTeam };
  }
}

module.exports = { fetchLineMovement };
