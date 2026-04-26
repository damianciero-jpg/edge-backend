const { hasRedisConfig, createRedis } = require('./redis');
const USE_KV = hasRedisConfig();
const IS_PRODUCTION = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;

// ─── FILE STORAGE (local dev only) ───────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const DB_PATH = path.join(__dirname, '..', 'users.json');

function normalizeUserId(userId) {
  return String(userId || '').trim().toLowerCase();
}

function assertPersistentStorage() {
  if (IS_PRODUCTION && !USE_KV) {
    throw new Error('Persistent user storage is not configured. Add UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN or KV_REST_API_URL/KV_REST_API_TOKEN in Vercel so free credits stay tied to email.');
  }
}

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
  redis = createRedis();
}

const KEY = id => `edge:user:${normalizeUserId(id)}`;
const USERS_SET = 'edge:users';

function newUserRecord() {
  const now = new Date().toISOString();
  return {
    credits: 2,
    isSubscriber: false,
    subscribedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

// ─── UNIFIED ASYNC API ────────────────────────────────────────────────────────
async function readDB() {
  assertPersistentStorage();
  if (USE_KV) {
    const ids = (await redis.smembers(USERS_SET)) || [];
    const entries = await Promise.all(ids.map(async id => [id, await redis.get(KEY(id))]));
    return Object.fromEntries(entries.filter(([, v]) => v));
  }
  return readFile();
}

async function writeDB(db) {
  assertPersistentStorage();
  if (USE_KV) {
    await Promise.all(Object.entries(db).map(([id, data]) => {
      const normalizedId = normalizeUserId(id);
      return Promise.all([
        redis.set(KEY(normalizedId), { ...data, updatedAt: new Date().toISOString() }),
        redis.sadd(USERS_SET, normalizedId),
      ]);
    }));
    return;
  }
  writeFile(db);
}

async function getUser(userId) {
  assertPersistentStorage();
  const id = normalizeUserId(userId);
  if (!id) throw new Error('userId is required');

  if (USE_KV) {
    let user = await redis.get(KEY(id));
    if (!user) {
      user = newUserRecord();
      await redis.set(KEY(id), user);
      await redis.sadd(USERS_SET, id);
    }
    return user;
  }

  const db = readFile();
  if (!db[id]) {
    db[id] = newUserRecord();
    writeFile(db);
  }
  return db[id];
}

async function saveUser(userId, data) {
  assertPersistentStorage();
  const id = normalizeUserId(userId);
  if (!id) throw new Error('userId is required');

  const updatedAt = new Date().toISOString();
  if (USE_KV) {
    const existing = (await redis.get(KEY(id))) || newUserRecord();
    const updated = { ...existing, ...data, updatedAt };
    await redis.set(KEY(id), updated);
    await redis.sadd(USERS_SET, id);
    return updated;
  }

  const db = readFile();
  db[id] = { ...(db[id] || newUserRecord()), ...data, updatedAt };
  writeFile(db);
  return db[id];
}

async function addCredits(userId, amount) {
  const user = await getUser(userId);
  return saveUser(userId, { credits: Math.max(0, (user.credits || 0) + amount) });
}

async function setSubscriber(userId, isSubscriber) {
  return saveUser(userId, {
    isSubscriber,
    subscribedAt: isSubscriber ? new Date().toISOString() : null,
  });
}

module.exports = { getUser, saveUser, addCredits, setSubscriber, readDB, writeDB, normalizeUserId };
