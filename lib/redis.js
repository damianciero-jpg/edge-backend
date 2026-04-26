function getRedisUrl() {
  return process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
}

function getRedisToken() {
  return process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
}

function hasRedisConfig() {
  return !!(getRedisUrl() && getRedisToken());
}

function createRedis() {
  const { Redis } = require('@upstash/redis');
  return new Redis({ url: getRedisUrl(), token: getRedisToken() });
}

module.exports = { getRedisUrl, getRedisToken, hasRedisConfig, createRedis };
