'use strict';
// ─── LINE SERVICE ─────────────────────────────────────────────────────────────
// Wraps lib/line-tracker.js with timeout guards.
// Returns line movement + RLM signals for both teams in a game.

const { withTimeout } = require('./ai-service');
const { getGameLineSignals, getLineMovementSignal, recordGameLines } = require('../line-tracker');

async function fetchLineMovement(homeTeam, awayTeam, homeOdds, awayOdds, gameId) {
  if (!homeTeam) return buildEmptySignal(homeTeam);

  try {
    // Use real game ID if available, fall back to generated key
    const id = gameId || [homeTeam, awayTeam].sort().join('_').toLowerCase().replace(/\s+/g, '_')
      + '_' + new Date().toISOString().slice(0, 10);

    const homeOddsVal = homeOdds && typeof homeOdds === 'object' ? homeOdds.home : homeOdds;
    const awayOddsVal = awayOdds && typeof awayOdds === 'object' ? awayOdds.away : awayOdds;

    if (awayOddsVal) {
      // Full two-sided signal with RLM
      const signals = await withTimeout(
        getGameLineSignals(id, homeTeam, awayTeam, homeOddsVal, awayOddsVal),
        5000, 'line movement'
      );
      return {
        // Home team signal (backward compatible with existing fields)
        score:        signals.home.score,
        direction:    signals.home.direction,
        basisPoints:  signals.home.basisPoints,
        openingOdds:  signals.home.openingOdds,
        currentOdds:  signals.home.currentOdds,
        team:         homeTeam,
        // New: full game signals
        home:         signals.home,
        away:         signals.away,
        rlmScore:     signals.rlmScore,
        rlmDirection: signals.rlmDirection,
        hasHistory:   signals.hasHistory,
        gameId:       id,
      };
    } else {
      // Single-side fallback
      const lm = await withTimeout(
        getLineMovementSignal(id, homeTeam, homeOddsVal),
        5000, 'line movement'
      );
      return {
        score:        lm.score || 0,
        direction:    lm.direction || 'UNKNOWN',
        basisPoints:  lm.basisPoints || 0,
        openingOdds:  lm.openingOdds || null,
        currentOdds:  lm.currentOdds || null,
        team:         homeTeam,
        rlmScore:     0,
        rlmDirection: 'NEUTRAL',
        hasHistory:   lm.openingOdds != null,
        gameId:       id,
      };
    }
  } catch {
    return buildEmptySignal(homeTeam);
  }
}

function buildEmptySignal(team) {
  return {
    score: 0, direction: 'UNKNOWN', basisPoints: 0,
    openingOdds: null, currentOdds: null, team,
    rlmScore: 0, rlmDirection: 'NEUTRAL', hasHistory: false,
  };
}

module.exports = { fetchLineMovement };
