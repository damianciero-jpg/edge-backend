/**
 * EDGE Calibration — Phase 4
 *
 * Tracks algorithm predictions vs. actual outcomes in Redis so users can see
 * how well the EDGE verdict system is calibrated over time.
 *
 * Redis key: edge:calibration:<userId>  (list of prediction objects)
 * Calibration report only returned when the user has >= 20 resolved predictions.
 */

const { hasRedisConfig, createRedis } = require('./redis');

const CALIBRATION_KEY = (userId) => `edge:calibration:${String(userId).toLowerCase()}`;
const TTL = 365 * 24 * 60 * 60; // 1 year
const MAX_PREDICTIONS = 500;
const MIN_RESOLVED = 20;

/**
 * Store a new prediction record (called at analysis time).
 * prediction: { id, pick, verdict, edgeScore, consensusProb, noVigProb, priceEdge, createdAt }
 */
async function recordPrediction(userId, prediction) {
  if (!hasRedisConfig() || !userId) return;
  try {
    const redis = createRedis();
    const key = CALIBRATION_KEY(userId);
    const existing = (await redis.get(key)) || [];
    const list = Array.isArray(existing) ? existing : [];
    list.push({ ...prediction, result: null, resolvedAt: null, createdAt: prediction.createdAt || new Date().toISOString() });
    await redis.set(key, list.slice(-MAX_PREDICTIONS), { ex: TTL });
  } catch (err) {
    console.warn('calibration recordPrediction error:', err.message);
  }
}

/**
 * Mark a prediction result (called when user reports outcome).
 * result: 'win' | 'loss' | 'push'
 */
async function recordOutcome(userId, predictionId, result) {
  if (!hasRedisConfig() || !userId) return false;
  try {
    const redis = createRedis();
    const key = CALIBRATION_KEY(userId);
    const existing = (await redis.get(key)) || [];
    const list = Array.isArray(existing) ? existing : [];
    const idx = list.findIndex(p => String(p.id) === String(predictionId));
    if (idx === -1) return false;
    list[idx] = { ...list[idx], result, resolvedAt: new Date().toISOString() };
    await redis.set(key, list, { ex: TTL });
    return true;
  } catch (err) {
    console.warn('calibration recordOutcome error:', err.message);
    return false;
  }
}

/**
 * Get all predictions for a user (for client display).
 */
async function getPredictions(userId) {
  if (!hasRedisConfig() || !userId) return [];
  try {
    const redis = createRedis();
    const data = (await redis.get(CALIBRATION_KEY(userId))) || [];
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.warn('calibration getPredictions error:', err.message);
    return [];
  }
}

/**
 * Compute the calibration report.
 * Returns null if < MIN_RESOLVED resolved predictions.
 * Returns { insufficient: true, count, required } if not enough data.
 */
async function getCalibrationReport(userId) {
  if (!hasRedisConfig() || !userId) return null;
  try {
    const predictions = await getPredictions(userId);
    const resolved = predictions.filter(p => p.result === 'win' || p.result === 'loss');

    if (resolved.length < MIN_RESOLVED) {
      return { insufficient: true, count: resolved.length, required: MIN_RESOLVED };
    }

    const wins = resolved.filter(p => p.result === 'win');
    const winRate = wins.length / resolved.length;

    // ROI: win pays back (implied by odds), loss costs 1 unit
    const roi = resolved.reduce((sum, p) => {
      if (p.result === 'win') {
        const o = Number(p.odds || 0);
        const payout = o > 0 ? o / 100 : (o !== 0 ? 100 / Math.abs(o) : 1);
        return sum + payout;
      }
      return sum - 1;
    }, 0) / resolved.length * 100;

    // Per-verdict calibration
    const byVerdict = {};
    for (const p of resolved) {
      const v = p.verdict || 'UNKNOWN';
      if (!byVerdict[v]) byVerdict[v] = { wins: 0, total: 0, totalEdgeScore: 0 };
      byVerdict[v].total++;
      byVerdict[v].totalEdgeScore += Number(p.edgeScore || 0);
      if (p.result === 'win') byVerdict[v].wins++;
    }
    const verdictCalibration = Object.entries(byVerdict).map(([verdict, d]) => ({
      verdict,
      winRate: (d.wins / d.total * 100).toFixed(1) + '%',
      sampleSize: d.total,
      avgEdgeScore: (d.totalEdgeScore / d.total).toFixed(2),
    }));

    // Probability calibration buckets (noVigProb ranges)
    const buckets = { '40-50': { wins: 0, total: 0 }, '50-55': { wins: 0, total: 0 }, '55-60': { wins: 0, total: 0 }, '60+': { wins: 0, total: 0 } };
    for (const p of resolved) {
      const prob = Number(p.noVigProb || 0) * 100;
      const bucket = prob >= 60 ? '60+' : prob >= 55 ? '55-60' : prob >= 50 ? '50-55' : '40-50';
      buckets[bucket].total++;
      if (p.result === 'win') buckets[bucket].wins++;
    }
    const probCalibration = Object.entries(buckets)
      .filter(([, d]) => d.total > 0)
      .map(([range, d]) => ({
        predictedRange: range + '%',
        actualWinRate: (d.wins / d.total * 100).toFixed(1) + '%',
        sampleSize: d.total,
      }));

    return {
      insufficient: false,
      totalPredictions: predictions.length,
      resolvedCount: resolved.length,
      winRate: (winRate * 100).toFixed(1) + '%',
      roi: roi.toFixed(1) + '%',
      verdictCalibration,
      probCalibration,
    };
  } catch (err) {
    console.warn('calibration getCalibrationReport error:', err.message);
    return null;
  }
}

module.exports = { recordPrediction, recordOutcome, getPredictions, getCalibrationReport };
