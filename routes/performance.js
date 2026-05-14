const express = require('express');
const router = express.Router();
const { verifySession } = require('../lib/auth');
const { ok, fail } = require('../lib/http');
const {
  recordPrediction,
  recordOutcome,
  getPredictions,
  getCalibrationReport,
} = require('../lib/calibration');

// GET /api/performance — calibration report (null / insufficient if < 20 resolved)
router.get('/', async (req, res) => {
  const session = verifySession(req.cookies && req.cookies.edge_session);
  if (!session || !session.email) {
    return fail(res, 401, { error: 'Not logged in', data: { authRequired: true } });
  }
  const report = await getCalibrationReport(session.email);
  return ok(res, { data: { report } });
});

// GET /api/performance/predictions — list stored predictions
router.get('/predictions', async (req, res) => {
  const session = verifySession(req.cookies && req.cookies.edge_session);
  if (!session || !session.email) {
    return fail(res, 401, { error: 'Not logged in', data: { authRequired: true } });
  }
  const predictions = await getPredictions(session.email);
  return ok(res, { data: { predictions } });
});

// POST /api/performance/predict — store a new prediction after analysis
router.post('/predict', async (req, res) => {
  const session = verifySession(req.cookies && req.cookies.edge_session);
  if (!session || !session.email) {
    return fail(res, 401, { error: 'Not logged in', data: { authRequired: true } });
  }
  const { id, pick, verdict, edgeScore, consensusProb, noVigProb, priceEdge, odds } = req.body || {};
  if (!pick || !verdict) {
    return fail(res, 400, { error: 'pick and verdict are required' });
  }
  await recordPrediction(session.email, { id: id || Date.now(), pick, verdict, edgeScore, consensusProb, noVigProb, priceEdge, odds });
  return ok(res, { data: { recorded: true } });
});

// POST /api/performance/outcome — mark a prediction as win/loss/push
router.post('/outcome', async (req, res) => {
  const session = verifySession(req.cookies && req.cookies.edge_session);
  if (!session || !session.email) {
    return fail(res, 401, { error: 'Not logged in', data: { authRequired: true } });
  }
  const { predictionId, result } = req.body || {};
  if (!predictionId || !['win', 'loss', 'push'].includes(result)) {
    return fail(res, 400, { error: 'predictionId and result (win/loss/push) are required' });
  }
  const updated = await recordOutcome(session.email, predictionId, result);
  if (!updated) return fail(res, 404, { error: 'Prediction not found' });
  return ok(res, { data: { updated: true } });
});

module.exports = router;
