const express = require('express');
const router = express.Router();
const Anthropic = require('@anthropic-ai/sdk');
const { getUser, addCredits } = require('../lib/users');
const { getGlobalCount, incrementGlobalCount, getUserDailyCount, incrementUserDailyCount, getLimitConfig } = require('../lib/limits');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = [
  {
    type: 'text',
    text: 'You are an expert sports betting analyst specializing in expected value (EV) modeling. You have deep knowledge of major North American sports (NFL, NBA, MLB, NHL) and European football. When analyzing games, you search for recent team form, injury reports, head-to-head records, home/away splits, and situational factors. Always respond in the exact JSON format the user requests — no markdown, no backticks, no extra text.',
    cache_control: { type: 'ephemeral' },
  },
];

router.post('/', async (req, res) => {
  const { prompt, userId } = req.body;

  if (!prompt || !userId) {
    return res.status(400).json({ error: 'prompt and userId are required' });
  }

  const [user, { globalLimit, userLimit }] = await Promise.all([getUser(userId), getLimitConfig()]);

  // Credit / subscription gate
  if (!user.isSubscriber && user.credits <= 0) {
    return res.status(402).json({ error: 'No credits remaining', paywall: true });
  }

  // Global circuit breaker — protects total daily spend
  const globalCount = await getGlobalCount();
  if (globalCount >= globalLimit) {
    return res.status(503).json({
      error: `Daily analysis capacity reached (${globalLimit} max). Resets at midnight UTC.`,
      limitType: 'global',
    });
  }

  // Per-user daily limit (subscribers only — free users are already credit-gated)
  if (user.isSubscriber) {
    const userCount = await getUserDailyCount(userId);
    if (userCount >= userLimit) {
      return res.status(429).json({
        error: `Daily limit of ${userLimit} analyses reached. Resets at midnight UTC.`,
        limitType: 'user',
        used: userCount,
        limit: userLimit,
      });
    }
  }

  // Deduct credit before the API call — refund on failure
  if (!user.isSubscriber) {
    await addCredits(userId, -1);
  }

  try {
    const response = await client.messages.create(
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        system: SYSTEM_PROMPT,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: prompt }],
      },
      { timeout: 90_000 }
    );

    // Increment counters only on success
    await incrementGlobalCount();
    await incrementUserDailyCount(userId);

    res.json(response);
  } catch (err) {
    if (!user.isSubscriber) await addCredits(userId, 1);
    console.error('Anthropic API error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
