/**
 * EDGE Context Signals — Phase 3
 *
 * Computes injury and situational signals from prompt text and caches them
 * in Redis with the edge:context: prefix so repeated analyses of the same
 * game don't re-run the keyword scan on every request.
 *
 * Redis key: edge:context:<gameId>
 * TTL: 1 hour (signals are stable within a game day)
 */

const { hasRedisConfig, createRedis } = require('./redis');

const CACHE_PREFIX = 'edge:context:';
const TTL = 60 * 60; // 1 hour

function cacheKey(gameId) {
  return `${CACHE_PREFIX}${gameId}`;
}

function extractInjurySignal(text) {
  const src = String(text || '').toLowerCase();
  const neg = [
    /\binjur(?:y|ies|ed)\b/,
    /\bout\b(?!.*\bof\s+bounds)/,
    /\bdnp\b/,
    /\bquestionable\b/,
    /\bdoubtful\b/,
    /\bmissing\b/,
    /\blimited\b/,
    /\bday-?to-?day\b/,
    /\bscratched\b/,
    /\binjury.?report\b/,
  ];
  const pos = [
    /\bhealthy\b/,
    /\bfull.?strength\b/,
    /\bback.from.injur/,
    /\bcleared\b/,
    /\bno.?injur/,
    /\bfully.?fit\b/,
  ];
  const n = neg.filter(p => p.test(src)).length;
  const p = pos.filter(p => p.test(src)).length;
  return Math.max(-10, Math.min(10, (p - n) * 3));
}

function extractSituationalSignal(text) {
  const src = String(text || '').toLowerCase();
  const pos = [
    /\bhome.?(?:game|crowd|field|ice|court|advantage)\b/,
    /\brest.advantage\b/,
    /\bwinning.streak\b/,
    /\bback.to.back.*(?:opponent|away)\b/,
    /\bmomentum\b/,
    /\bmust.win\b/,
    /\bprime.time\b/,
    /\bclimate.advantage\b/,
    /\bdome.team\b/,
  ];
  const neg = [
    /\bback.to.back\b(?!.*(?:opponent|away))/,
    /\bfatigue\b/,
    /\blosing.streak\b/,
    /\blong.road.trip\b/,
    /\bshort.rest\b/,
    /\baway.game\b/,
    /\btravel.day\b/,
    /\bthird.in.four\b/,
  ];
  const p = pos.filter(p => p.test(src)).length;
  const n = neg.filter(p => p.test(src)).length;
  return Math.max(-10, Math.min(10, (p - n) * 2));
}

/**
 * Returns { injurySignal, situationalSignal }.
 * Checks Redis cache first (edge:context:<gameId>). On miss, computes from
 * prompt text and writes to cache. Redis errors are non-fatal — always returns
 * a valid signal object.
 *
 * @param {string|null} gameId - unique game identifier for cache key (may be null)
 * @param {string} prompt      - full analysis prompt text
 * @param {number} [timeoutMs] - Redis call timeout in ms (default 5000)
 */
async function getContextSignals(gameId, prompt, timeoutMs = 5000) {
  if (hasRedisConfig() && gameId) {
    try {
      const redis = createRedis();
      const cached = await Promise.race([
        redis.get(cacheKey(gameId)),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('context cache read timeout')), timeoutMs)
        ),
      ]);
      if (cached && typeof cached === 'object') return cached;
    } catch (err) {
      console.warn('context-signals cache read error:', err.message);
    }
  }

  const signals = {
    injurySignal: extractInjurySignal(prompt),
    situationalSignal: extractSituationalSignal(prompt),
  };

  if (hasRedisConfig() && gameId) {
    try {
      const redis = createRedis();
      await Promise.race([
        redis.set(cacheKey(gameId), signals, { ex: TTL }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('context cache write timeout')), timeoutMs)
        ),
      ]);
    } catch (err) {
      console.warn('context-signals cache write error:', err.message);
    }
  }

  return signals;
}

module.exports = { getContextSignals, extractInjurySignal, extractSituationalSignal };
