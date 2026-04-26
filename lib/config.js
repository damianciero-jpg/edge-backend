const { hasRedisConfig, createRedis } = require('./redis');
const USE_KV = hasRedisConfig();
const fs = require('fs');
const path = require('path');
const CONFIG_PATH = process.env.VERCEL
  ? '/tmp/config.json'
  : path.join(__dirname, '..', 'config.json');
const CONFIG_KEY = 'edge:config:app';

async function getAppConfig() {
  if (USE_KV) {
    const redis = createRedis();
    return (await redis.get(CONFIG_KEY)) || {};
  }
  if (fs.existsSync(CONFIG_PATH)) return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  return {};
}

async function setAppConfig(updates) {
  if (USE_KV) {
    const redis = createRedis();
    const existing = (await redis.get(CONFIG_KEY)) || {};
    const merged = { ...existing, ...updates };
    await redis.set(CONFIG_KEY, merged);
    return merged;
  }
  const existing = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : {};
  const merged = { ...existing, ...updates };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
  return merged;
}

// Read a single value: Redis config first, then env var, then fallback
async function getCfg(key, envVar = null, fallback = null) {
  const config = await getAppConfig();
  return config[key] || (envVar ? process.env[envVar] : null) || fallback;
}

module.exports = { getAppConfig, setAppConfig, getCfg };
