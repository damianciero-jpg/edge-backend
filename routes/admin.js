const express = require('express');
const router = express.Router();
const { getUser, saveUser, readDB } = require('../lib/users');

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
