const USE_KV = !!process.env.UPSTASH_REDIS_REST_URL;

// ─── FILE STORAGE (local dev) ─────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const DB_PATH = path.join(__dirname, '..', 'users.json');

function readFile() {
  if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, '{}');
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}
function writeFile(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// ─── KV STORAGE (Upstash Redis / Vercel production) ──────────────────────────
let redis;
if (USE_KV) {
  const { Redis } = require('@upstash/redis');
  redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
}

const KEY = id => `edge:user:${id}`;
const USERS_SET = 'edge:users';

// ─── UNIFIED ASYNC API ────────────────────────────────────────────────────────
async function readDB() {
  if (USE_KV) {
    const ids = (await redis.smembers(USERS_SET)) || [];
    const entries = await Promise.all(ids.map(async id => [id, await redis.get(KEY(id))]));
    return Object.fromEntries(entries.filter(([, v]) => v));
  }
  return readFile();
}

async function writeDB(db) {
  if (USE_KV) {
    await Promise.all(Object.entries(db).map(([id, data]) => Promise.all([
      redis.set(KEY(id), data),
      redis.sadd(USERS_SET, id),
    ])));
    return;
  }
  writeFile(db);
}

async function getUser(userId) {
  if (USE_KV) {
    let user = await redis.get(KEY(userId));
    if (!user) {
      user = { credits: 2, isSubscriber: false, subscribedAt: null };
      await redis.set(KEY(userId), user);
      await redis.sadd(USERS_SET, userId);
    }
    return user;
  }
  const db = readFile();
  if (!db[userId]) {
    db[userId] = { credits: 2, isSubscriber: false, subscribedAt: null };
    writeFile(db);
  }
  return db[userId];
}

async function saveUser(userId, data) {
  if (USE_KV) {
    const existing = (await redis.get(KEY(userId))) || {};
    const updated = { ...existing, ...data };
    await redis.set(KEY(userId), updated);
    await redis.sadd(USERS_SET, userId);
    return updated;
  }
  const db = readFile();
  db[userId] = { ...db[userId], ...data };
  writeFile(db);
  return db[userId];
}

async function addCredits(userId, amount) {
  const user = await getUser(userId);
  return saveUser(userId, { credits: (user.credits || 0) + amount });
}

async function setSubscriber(userId, isSubscriber) {
  return saveUser(userId, {
    isSubscriber,
    subscribedAt: isSubscriber ? new Date().toISOString() : null,
  });
}

module.exports = { getUser, saveUser, addCredits, setSubscriber, readDB, writeDB };
