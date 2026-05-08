/**
 * EDGE Line Tracker
 *
 * Approximates Closing Line Value (CLV) methodology from Billy Walters:
 * - When a game is first seen, store the opening line in Redis
 * - At analysis time, compare current price to opening price
 * - Line movement TOWARD your side = sharp money agreement (positive signal)
 * - Line movement AWAY from your side = sharp money fading (negative signal)
 *
 * Keys expire 48 hours after game commence time.
 */

const { hasRedisConfig, createRedis } = require('./redis');

const KEY = (gameId, team) => `edge:line:${gameId}:${team.toLowerCase().replace(/\s+/g, '_')}`;
const TTL = 48 * 60 * 60; // 48 hours

/**
 * Record opening line for a team if not already stored.
 * Call this when odds data first arrives (e.g. in the /api/odds proxy).
 */
async function recordOpeningLine(gameId, team, americanOdds) {
  if (!hasRedisConfig()) return;
  if (!gameId || !team || americanOdds == null) return;

  try {
    const redis = createRedis();
    const key = KEY(gameId, team);
    const existing = await redis.get(key);
    if (!existing) {
      await redis.set(key, { odds: americanOdds, recordedAt: new Date().toISOString() }, { ex: TTL });
    }
  } catch (err) {
    console.warn('Line tracker recordOpeningLine error:', err.message);
  }
}

/**
 * Get opening line for a team.
 * Returns null if not stored (no Redis, or first time seeing this game).
 */
async function getOpeningLine(gameId, team) {
  if (!hasRedisConfig()) return null;
  if (!gameId || !team) return null;

  try {
    const redis = createRedis();
    const data = await redis.get(KEY(gameId, team));
    return data ? data.odds : null;
  } catch (err) {
    console.warn('Line tracker getOpeningLine error:', err.message);
    return null;
  }
}

/**
 * Calculate CLV signal from opening to current line.
 *
 * Positive = line moved in your favor (sharp money agrees)
 * Negative = line moved against you (sharp money fading)
 * Zero = no movement or no history
 *
 * Returns a score between -10 and +10.
 */
function calcLineMovementScore(openingOdds, currentOdds) {
  if (openingOdds == null || currentOdds == null) return 0;

  const opening = Number(openingOdds);
  const current = Number(currentOdds);
  if (!Number.isFinite(opening) || !Number.isFinite(current)) return 0;

  // Convert to implied probability to measure movement direction
  function toImplied(american) {
    if (american > 0) return 100 / (american + 100);
    return Math.abs(american) / (Math.abs(american) + 100);
  }

  const openingImplied = toImplied(opening);
  const currentImplied = toImplied(current);

  // Movement in implied probability
  // Positive delta = books moved price AGAINST this team (they got shorter)
  // We want to bet when price moves IN OUR FAVOR (longer = more value)
  const delta = openingImplied - currentImplied; // positive = price got longer = value
  const deltaPoints = current - opening; // American odds movement

  // Scale to -10/+10 score
  // A 10-point American odds move = ~1 score point
  const raw = deltaPoints / 10;
  return Math.max(-10, Math.min(10, raw));
}

/**
 * Full CLV analysis for a team in a game.
 * Returns { score, openingOdds, currentOdds, direction, basisPoints }
 */
async function getLineMovementSignal(gameId, team, currentOdds) {
  const openingOdds = await getOpeningLine(gameId, team);

  if (openingOdds == null) {
    // First time seeing this — record it as the opening line
    await recordOpeningLine(gameId, team, currentOdds);
    return { score: 0, openingOdds: null, currentOdds, direction: 'UNKNOWN', basisPoints: 0 };
  }

  const score = calcLineMovementScore(openingOdds, currentOdds);
  const basisPoints = Number(currentOdds) - Number(openingOdds);

  let direction = 'FLAT';
  if (basisPoints > 5) direction = 'STEAM'; // line moved in your favor — sharp action
  else if (basisPoints < -5) direction = 'FADE'; // line moved against you
  else direction = 'STABLE';

  return { score, openingOdds, currentOdds, direction, basisPoints };
}

module.exports = {
  recordOpeningLine,
  getOpeningLine,
  getLineMovementSignal,
  calcLineMovementScore,
};
