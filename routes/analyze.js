const express = require('express');
const router = express.Router();
const Anthropic = require('@anthropic-ai/sdk');
const { getUser, addCredits } = require('../lib/users');
const { getGlobalCount, incrementGlobalCount, getUserDailyCount, incrementUserDailyCount, getLimitConfig } = require('../lib/limits');
const { verifySession } = require('../lib/auth');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = [
  {
    type: 'text',
    text: 'You are an expert sports betting analyst specializing in expected value (EV) modeling. You have deep knowledge of major North American sports (NFL, NBA, MLB, NHL) and European football. When analyzing games, consider recent team form, injury reports, head-to-head records, home/away splits, and situational factors. CRITICAL: Always respond with ONLY the raw JSON object — no markdown, no backticks, no // comments, no preamble text, no citations, no explanations. Start your response with { and end with }. Never include anything outside the JSON object.',
    cache_control: { type: 'ephemeral' },
  },
];

// Wraps any promise with a hard timeout so a stalled Redis call can't block the route
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

router.post('/', async (req, res) => {
  const { prompt, useSearch = false } = req.body;

  const session = verifySession(req.cookies?.edge_session);
  if (!session?.email) {
    return res.status(401).json({ error: 'Not logged in', authRequired: true });
  }
  const userId = session.email;

  if (!prompt) {
    return res.status(400).json({ error: 'prompt is required' });
  }

  // Fetch user + limits in parallel, each with a 5s cap
  let user, globalLimit, userLimit;
  try {
    [{ user, globalLimit, userLimit }] = await Promise.all([
      withTimeout(
        Promise.all([getUser(userId), getLimitConfig()]).then(([u, lim]) => ({ user: u, ...lim })),
        5000, 'user/limits fetch'
      ),
    ]);
  } catch (err) {
    console.error('Storage fetch error:', err.message);
    return res.status(503).json({ error: `Storage error: ${err.message}` });
  }

  // Credit / subscription gate
  if (!user.isSubscriber && user.credits <= 0) {
    return res.status(402).json({ error: 'No credits remaining', paywall: true });
  }

  // Global circuit breaker
  let globalCount = 0;
  try {
    globalCount = await withTimeout(getGlobalCount(), 3000, 'global count');
  } catch { /* non-fatal — allow request through if counter is slow */ }

  if (globalCount >= (globalLimit || 150)) {
    return res.status(503).json({
      error: `Daily analysis capacity reached (${globalLimit} max). Resets at midnight UTC.`,
      limitType: 'global',
    });
  }

  // Per-user daily limit (subscribers only)
  if (user.isSubscriber) {
    let userCount = 0;
    try {
      userCount = await withTimeout(getUserDailyCount(userId), 3000, 'user count');
    } catch { /* non-fatal */ }
    if (userCount >= (userLimit || 20)) {
      return res.status(429).json({
        error: `Daily limit of ${userLimit} analyses reached. Resets at midnight UTC.`,
        limitType: 'user',
        used: userCount,
        limit: userLimit,
      });
    }
  }

  try {
    const model = useSearch ? 'claude-sonnet-4-6' : 'claude-haiku-4-5-20251001';
    const apiTimeout = useSearch ? 180_000 : 30_000;

    const msgParams = {
      model,
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    };
    if (useSearch) msgParams.tools = [{ type: 'web_search_20250305', name: 'web_search' }];

    const response = await client.messages.create(msgParams, { timeout: apiTimeout });

    // Deduct credit and increment counters only after a successful response — fire-and-forget
    Promise.all([
      !user.isSubscriber
        ? withTimeout(addCredits(userId, -1), 3000, 'credit deduct').catch(e => console.error(e.message))
        : Promise.resolve(),
      withTimeout(incrementGlobalCount(), 3000, 'incr global').catch(e => console.error(e.message)),
      withTimeout(incrementUserDailyCount(userId), 3000, 'incr user').catch(e => console.error(e.message)),
    ]);

    res.json(response);
  } catch (err) {
    const status = err.status || err.statusCode || 'unknown';
    console.error(`Anthropic API error [${status}] model=${useSearch ? 'sonnet' : 'haiku'}:`, err.message);
    const userMsg = status === 429
      ? 'API rate limit hit — wait a minute and try again'
      : status === 401
      ? 'Invalid API key — check admin config'
      : status === 403
      ? 'API key does not have access to this model'
      : err.message;
    res.status(500).json({ error: userMsg, detail: err.message });
  }
});

module.exports = router;
