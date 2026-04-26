const express = require('express');
const router = express.Router();
const Anthropic = require('@anthropic-ai/sdk');
const { getUser, addCredits } = require('../lib/users');
const { getGlobalCount, incrementGlobalCount, getUserDailyCount, incrementUserDailyCount, getLimitConfig } = require('../lib/limits');
const { verifySession } = require('../lib/auth');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function runOpenAISecondLayer(prompt, firstOutput) {
  if (!process.env.OPENAI_API_KEY) return firstOutput;

  try {
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
        input: `Improve this sports betting analysis and return only JSON:\n${firstOutput}`
      })
    });

    const data = await res.json();
    return data.output_text || firstOutput;
  } catch {
    return firstOutput;
  }
}

router.post('/', async (req, res) => {
  const { prompt, useSearch = false, secondLayer = false } = req.body;

  const session = verifySession(req.cookies?.edge_session);
  if (!session?.email) {
    return res.status(401).json({ ok: false, error: 'Not logged in', authRequired: true });
  }
  const userId = session.email;

  if (!prompt) {
    return res.status(400).json({ ok: false, error: 'prompt is required' });
  }

  let user, globalLimit, userLimit;
  try {
    [{ user, globalLimit, userLimit }] = await Promise.all([
      Promise.all([getUser(userId), getLimitConfig()]).then(([u, lim]) => ({ user: u, ...lim }))
    ]);
  } catch (err) {
    return res.status(503).json({ ok: false, error: err.message });
  }

  if (!user.isSubscriber && user.credits <= 0) {
    return res.status(402).json({ ok: false, error: 'No credits remaining', paywall: true });
  }

  try {
    const model = useSearch ? (process.env.ANTHROPIC_DEEP_MODEL || 'claude-sonnet-4-5') : (process.env.ANTHROPIC_QUICK_MODEL || 'claude-haiku-4-5');

    const response = await client.messages.create({
      model,
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }]
    }, { timeout: useSearch ? 60000 : 15000 });

    let text = response.content?.map(b => b.text).join('\n') || '';

    if (secondLayer) {
      text = await runOpenAISecondLayer(prompt, text);
    }

    Promise.all([
      !user.isSubscriber ? addCredits(userId, -1) : null,
      incrementGlobalCount(),
      incrementUserDailyCount(userId)
    ]).catch(() => {});

    res.json({
      ok: true,
      text,
      meta: {
        mode: useSearch ? 'deep' : 'quick'
      }
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
