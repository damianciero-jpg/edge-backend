const USE_KV = !!process.env.UPSTASH_REDIS_REST_URL;
const fs = require('fs');
const path = require('path');
const DAILY_PATH = process.env.VERCEL
  ? '/tmp/daily.json'
  : path.join(__dirname, '..', 'daily.json');

function today() {
  return new Date().toISOString().slice(0, 10);
}

// ─── GLOBAL DAILY COUNTER ────────────────────────────────────────────────────

async function getGlobalCount() {
  const key = `edge:daily:${today()}`;
  if (USE_KV) {
    const { Redis } = require('@upstash/redis');
    const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
    return (await redis.get(key)) || 0;
  }
  if (!fs.existsSync(DAILY_PATH)) return 0;
  const data = JSON.parse(fs.readFileSync(DAILY_PATH, 'utf8'));
  return data[today()] || 0;
}

async function incrementGlobalCount() {
  const key = `edge:daily:${today()}`;
  if (USE_KV) {
    const { Redis } = require('@upstash/redis');
    const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
    await redis.incr(key);
    await redis.expire(key, 172800); // auto-expire after 48h
    return;
  }
  const data = fs.existsSync(DAILY_PATH) ? JSON.parse(fs.readFileSync(DAILY_PATH, 'utf8')) : {};
  data[today()] = (data[today()] || 0) + 1;
  // prune old days
  Object.keys(data).forEach(d => { if (d < today()) delete data[d]; });
  fs.writeFileSync(DAILY_PATH, JSON.stringify(data, null, 2));
}

// ─── PER-USER DAILY COUNTER ──────────────────────────────────────────────────

async function getUserDailyCount(userId) {
  const key = `edge:user-daily:${today()}:${userId}`;
  if (USE_KV) {
    const { Redis } = require('@upstash/redis');
    const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
    return (await redis.get(key)) || 0;
  }
  if (!fs.existsSync(DAILY_PATH)) return 0;
  const data = JSON.parse(fs.readFileSync(DAILY_PATH, 'utf8'));
  return (data[`users`]?.[today()]?.[userId]) || 0;
}

async function incrementUserDailyCount(userId) {
  const key = `edge:user-daily:${today()}:${userId}`;
  if (USE_KV) {
    const { Redis } = require('@upstash/redis');
    const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
    await redis.incr(key);
    await redis.expire(key, 172800);
    return;
  }
  const data = fs.existsSync(DAILY_PATH) ? JSON.parse(fs.readFileSync(DAILY_PATH, 'utf8')) : {};
  if (!data.users) data.users = {};
  if (!data.users[today()]) data.users[today()] = {};
  data.users[today()][userId] = (data.users[today()][userId] || 0) + 1;
  fs.writeFileSync(DAILY_PATH, JSON.stringify(data, null, 2));
}

// ─── LIMIT CONFIG (admin-adjustable, stored in KV or daily.json) ─────────────

async function getLimitConfig() {
  const defaults = {
    globalLimit: parseInt(process.env.GLOBAL_DAILY_LIMIT || '150'),
    userLimit: parseInt(process.env.MAX_DAILY_ANALYSES || '20'),
  };
  if (USE_KV) {
    const { Redis } = require('@upstash/redis');
    const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
    const stored = await redis.get('edge:config:limits');
    return stored ? { ...defaults, ...stored } : defaults;
  }
  if (fs.existsSync(DAILY_PATH)) {
    const data = JSON.parse(fs.readFileSync(DAILY_PATH, 'utf8'));
    if (data.limits) return { ...defaults, ...data.limits };
  }
  return defaults;
}

async function setLimitConfig(updates) {
  if (USE_KV) {
    const { Redis } = require('@upstash/redis');
    const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
    const existing = (await redis.get('edge:config:limits')) || {};
    const merged = { ...existing, ...updates };
    await redis.set('edge:config:limits', merged);
    return merged;
  }
  const data = fs.existsSync(DAILY_PATH) ? JSON.parse(fs.readFileSync(DAILY_PATH, 'utf8')) : {};
  data.limits = { ...(data.limits || {}), ...updates };
  fs.writeFileSync(DAILY_PATH, JSON.stringify(data, null, 2));
  return data.limits;
}

module.exports = { getGlobalCount, incrementGlobalCount, getUserDailyCount, incrementUserDailyCount, getLimitConfig, setLimitConfig, today };
