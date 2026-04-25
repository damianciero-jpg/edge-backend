const express = require('express');
const router = express.Router();
const { getUser, saveUser, readDB } = require('../lib/users');
const { getGlobalCount, getLimitConfig, setLimitConfig } = require('../lib/limits');
const { getAppConfig, setAppConfig } = require('../lib/config');

const EDITABLE_CONFIG_KEYS = [
  'stripeSecretKey', 'stripeWebhookSecret', 'stripePublishableKey',
  'stripeSubPriceId', 'stripeCredits10PriceId', 'stripeCredits50PriceId',
  'frontendUrl',
];

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!process.env.ADMIN_PASSWORD || token !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

router.use(auth);

router.get('/stats', async (req, res) => {
  const db = await readDB();
  const users = Object.values(db);
  res.json({
    totalUsers: users.length,
    subscribers: users.filter(u => u.isSubscriber).length,
    totalCredits: users.reduce((s, u) => s + (u.credits || 0), 0),
    totalAnalyses: users.reduce((s, u) => s + (u.analysesRun || 0), 0),
  });
});

router.get('/users', async (req, res) => {
  const db = await readDB();
  const users = Object.entries(db)
    .map(([userId, data]) => ({ userId, ...data }))
    .sort((a, b) => (b.isSubscriber ? 1 : 0) - (a.isSubscriber ? 1 : 0));
  res.json(users);
});

router.post('/users/:userId/credits', async (req, res) => {
  const { userId } = req.params;
  const { credits } = req.body;
  if (typeof credits !== 'number') return res.status(400).json({ error: 'credits must be a number' });
  const user = await getUser(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const updated = await saveUser(userId, { credits });
  res.json(updated);
});

router.post('/users/:userId/subscriber', async (req, res) => {
  const { userId } = req.params;
  const { isSubscriber } = req.body;
  const user = await getUser(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const updated = await saveUser(userId, {
    isSubscriber: !!isSubscriber,
    subscribedAt: isSubscriber ? new Date().toISOString() : null,
  });
  res.json(updated);
});

router.delete('/users/:userId', async (req, res) => {
  const { userId } = req.params;
  const db = await readDB();
  if (!db[userId]) return res.status(404).json({ error: 'User not found' });
  // For KV: remove from set + delete key; for file: delete from object
  if (process.env.UPSTASH_REDIS_REST_URL) {
    const { Redis } = require('@upstash/redis');
    const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
    await redis.del(`edge:user:${userId}`);
    await redis.srem('edge:users', userId);
  } else {
    const fs = require('fs'), path = require('path');
    const DB_PATH = path.join(__dirname, '..', 'users.json');
    const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    delete data[req.params.userId];
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
  }
  res.json({ ok: true });
});

router.get('/limits', async (req, res) => {
  const [globalUsed, { globalLimit, userLimit }] = await Promise.all([getGlobalCount(), getLimitConfig()]);
  res.json({ globalUsed, globalLimit, userLimit, estimatedCost: (globalUsed * 0.03).toFixed(2) });
});

router.post('/limits', async (req, res) => {
  const { globalLimit, userLimit } = req.body;
  const updates = {};
  if (typeof globalLimit === 'number' && globalLimit > 0) updates.globalLimit = globalLimit;
  if (typeof userLimit === 'number' && userLimit > 0) updates.userLimit = userLimit;
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'Provide globalLimit and/or userLimit as positive numbers' });
  const saved = await setLimitConfig(updates);
  res.json(saved);
});

router.get('/app-config', async (req, res) => {
  const config = await getAppConfig();
  const result = {};
  EDITABLE_CONFIG_KEYS.forEach(k => {
    const v = config[k];
    result[k] = { set: !!v, preview: v ? v.slice(0, 6) + '...' : '' };
  });
  res.json(result);
});

router.post('/app-config', async (req, res) => {
  const updates = {};
  EDITABLE_CONFIG_KEYS.forEach(k => {
    if (req.body[k] !== undefined && String(req.body[k]).trim() !== '') {
      updates[k] = String(req.body[k]).trim();
    }
  });
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields provided' });
  await setAppConfig(updates);
  res.json({ ok: true, updated: Object.keys(updates) });
});

router.get('/config', (req, res) => {
  const vars = [
    'ANTHROPIC_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET',
    'STRIPE_SUB_PRICE_ID', 'STRIPE_CREDITS_10_PRICE_ID', 'STRIPE_CREDITS_50_PRICE_ID',
    'FRONTEND_URL', 'ADMIN_PASSWORD', 'UPSTASH_REDIS_REST_URL',
  ];
  const config = {};
  vars.forEach(k => {
    const v = process.env[k];
    config[k] = v ? { set: true, preview: v.slice(0, 8) + '...' } : { set: false };
  });
  res.json(config);
});

module.exports = router;
