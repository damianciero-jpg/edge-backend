const express = require('express');
const router = express.Router();
const Anthropic = require('@anthropic-ai/sdk');
const { getUser, addCredits } = require('../lib/users');
const { getGlobalCount, incrementGlobalCount, getUserDailyCount, incrementUserDailyCount, getLimitConfig } = require('../lib/limits');
const { verifySession } = require('../lib/auth');
const { ok, fail } = require('../lib/http');

const anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const hasOpenAI = !!process.env.OPENAI_API_KEY;

const SYSTEM_PROMPT = [
  {
    type: 'text',
    text: 'You are an expert sports betting analyst specializing in expected value (EV) modeling. You have deep knowledge of major North American sports (NFL, NBA, MLB, NHL) and European football. When analyzing games, consider recent team form, injury reports, head-to-head records, home/away splits, and situational factors. CRITICAL: Always respond with ONLY the raw JSON object — no markdown, no backticks, no // comments, no preamble text, no citations, no explanations. Start your response with { and end with }. Never include anything outside the JSON object.',
    cache_control: { type: 'ephemeral' },
  },
];

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const FREE_DAILY_LIMIT = Number(process.env.FREE_DAILY_LIMIT || 5);

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

function extractTextFromAnthropic(response) {
  return (response?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

function sanitizeErrorMessage(err) {
  const status = err?.status || err?.statusCode || 500;
  if (status === 429) return 'AI service is rate-limited. Try again shortly.';
  if (status === 401 || status === 403) return 'AI service authentication failed. Contact support.';
  return 'AI analysis is temporarily unavailable.';
}

async function callAnthropic(prompt, useSearch) {
  const model = useSearch ? 'claude-sonnet-4-6' : 'claude-haiku-4-5-20251001';
  const apiTimeout = useSearch ? 180_000 : 25_000;

  const msgParams = {
    model,
    max_tokens: 1500,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
  };
  if (useSearch) msgParams.tools = [{ type: 'web_search_20250305', name: 'web_search' }];

  const response = await anthropicClient.messages.create(msgParams, { timeout: apiTimeout });
  return {
    provider: 'anthropic',
    model,
    raw: response,
    text: extractTextFromAnthropic(response),
  };
}

async function callOpenAIFallback(prompt) {
  if (!hasOpenAI) throw new Error('OPENAI_API_KEY is not configured');

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4.1-mini',
      temperature: 0.2,
      max_output_tokens: 1400,
      input: [
        { role: 'system', content: 'You are a second-pass reviewer for sports betting analysis. Return only a valid JSON object.' },
        { role: 'user', content: prompt },
      ],
    }),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error?.message || `OpenAI request failed (${response.status})`);
  }

  return {
    provider: 'openai',
    model: 'gpt-4.1-mini',
    raw: payload,
    text: payload.output_text || '',
  };
}

router.post('/', async (req, res) => {
  const startedAt = Date.now();
  const { prompt, useSearch = false } = req.body;

  const session = verifySession(req.cookies?.edge_session);
  if (!session?.email) {
    return fail(res, 401, { text: 'Login required', error: 'Not logged in', data: { authRequired: true } });
  const { prompt, useSearch = false, secondLayer = false } = req.body;

  const session = verifySession(req.cookies?.edge_session);
  if (!session?.email) {
    return res.status(401).json({ ok: false, error: 'Not logged in', authRequired: true });
  }
  const userId = session.email;

  if (!prompt) {
    return fail(res, 400, { text: 'Missing required prompt', error: 'prompt is required' });
  }

  let user;
  let globalLimit;
  let userLimit;
  let globalCount = 0;

  try {
    const [userAndLimits, globalCountResult] = await Promise.all([
      withTimeout(Promise.all([getUser(userId), getLimitConfig()]).then(([u, lim]) => ({ user: u, ...lim })), 4500, 'user/limits fetch'),
      withTimeout(getGlobalCount(), 2500, 'global count').catch(() => 0),
    return res.status(400).json({ ok: false, error: 'prompt is required' });
  }

  let user, globalLimit, userLimit;
  try {
    [{ user, globalLimit, userLimit }] = await Promise.all([
      Promise.all([getUser(userId), getLimitConfig()]).then(([u, lim]) => ({ user: u, ...lim }))
    ]);

    user = userAndLimits.user;
    globalLimit = userAndLimits.globalLimit;
    userLimit = userAndLimits.userLimit;
    globalCount = globalCountResult || 0;
  } catch (err) {
    console.error(`[${req.id}] Storage fetch error:`, err.message);
    return fail(res, 503, { text: 'Temporary storage issue', error: 'Storage unavailable' });
  }

  if (!user.isSubscriber && user.credits <= 0) {
    return fail(res, 402, { text: 'No credits remaining', error: 'No credits remaining', data: { paywall: true } });
  }

  if (globalCount >= (globalLimit || 150)) {
    return fail(res, 503, {
      text: 'Daily analysis capacity reached. Resets at midnight UTC.',
      error: 'Global daily limit reached',
      data: { limitType: 'global', limit: globalLimit || 150, used: globalCount },
    return res.status(503).json({ ok: false, error: err.message });
  }

  if (useSearch && !user.isSubscriber) {
    return res.status(402).json({
      ok: false,
      error: 'Deep AI is a premium feature',
      paywall: true,
      upgrade: true,
      event: 'deep_ai_blocked'
    });
  }

  if (!user.isSubscriber) {
    const userCount = await getUserDailyCount(userId).catch(() => 0);
    if (userCount >= FREE_DAILY_LIMIT) {
      return res.status(429).json({
        ok: false,
        error: `Free limit reached (${FREE_DAILY_LIMIT}/day)`,
        paywall: true,
        upgrade: true,
        used: userCount,
        limit: FREE_DAILY_LIMIT,
        event: 'free_limit_reached'
      });
    }
  }

  if (!user.isSubscriber && user.credits <= 0) {
    return res.status(402).json({ ok: false, error: 'No credits remaining', paywall: true, upgrade: true });
  }

  let globalCount = 0;
  try {
    globalCount = await getGlobalCount();
  } catch {}

  if (globalCount >= (globalLimit || 150)) {
    return res.status(503).json({
      ok: false,
      error: `Daily analysis capacity reached (${globalLimit || 150} max). Resets at midnight UTC.`,
      limitType: 'global',
    });
  }

  if (user.isSubscriber) {
    let userCount = 0;
    try {
      userCount = await withTimeout(getUserDailyCount(userId), 2500, 'user count');
    } catch {
      userCount = 0;
    }

    if (userCount >= (userLimit || 20)) {
      return fail(res, 429, {
        text: `Daily limit reached (${userLimit || 20}). Resets at midnight UTC.`,
        error: 'User daily limit reached',
        data: { limitType: 'user', used: userCount, limit: userLimit || 20 },
    const userCount = await getUserDailyCount(userId).catch(() => 0);
    if (userCount >= (userLimit || 20)) {
      return res.status(429).json({
        ok: false,
        error: `Daily limit of ${userLimit || 20} analyses reached. Resets at midnight UTC.`,
        limitType: 'user',
        used: userCount,
        limit: userLimit || 20,
      });
    }
  }

  try {
    let result;
    let fallbackUsed = false;

    try {
      result = await callAnthropic(prompt, useSearch);
    } catch (anthropicErr) {
      console.error(`[${req.id}] Anthropic failed:`, anthropicErr.message);
      if (!hasOpenAI) throw anthropicErr;
      fallbackUsed = true;
      result = await withTimeout(callOpenAIFallback(prompt), 20_000, 'openai fallback');
    }

    // Best-effort second-layer reviewer (non-blocking for speed)
    let reviewer = null;
    if (hasOpenAI && result.provider === 'anthropic') {
      withTimeout(callOpenAIFallback(`Review this analysis JSON for consistency and risk flags:\n\n${result.text}`), 8_000, 'openai reviewer')
        .then((review) => {
          reviewer = { provider: review.provider, model: review.model, preview: review.text.slice(0, 300) };
        })
        .catch((err) => console.warn(`[${req.id}] reviewer skipped: ${err.message}`));
    }

    Promise.all([
      !user.isSubscriber
        ? withTimeout(addCredits(userId, -1), 3000, 'credit deduct').catch((e) => console.error(`[${req.id}] credit deduct: ${e.message}`))
        : Promise.resolve(),
      withTimeout(incrementGlobalCount(), 3000, 'incr global').catch((e) => console.error(`[${req.id}] incr global: ${e.message}`)),
      withTimeout(incrementUserDailyCount(userId), 3000, 'incr user').catch((e) => console.error(`[${req.id}] incr user: ${e.message}`)),
    ]);

    const elapsedMs = Date.now() - startedAt;
    console.log(`[${req.id}] /api/analyze success provider=${result.provider} fallback=${fallbackUsed} ms=${elapsedMs}`);

    return ok(res, {
      text: result.text,
      meta: {
        provider: result.provider,
        model: result.model,
        useSearch: !!useSearch,
        fallbackUsed,
        elapsedMs,
        reviewer,
      },
      data: {
        // compatibility for existing frontend parser
        content: result.provider === 'anthropic'
          ? result.raw.content
          : [{ type: 'text', text: result.text }],
      },
    });
  } catch (err) {
    const status = err.status || err.statusCode || 500;
    console.error(`[${req.id}] /api/analyze failed [${status}]:`, err.message);
    return fail(res, 500, {
      text: 'Analysis failed',
      error: sanitizeErrorMessage(err),
      meta: { provider: 'none', elapsedMs: Date.now() - startedAt },
    });
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

    const nextCredits = user.isSubscriber ? null : Math.max(0, (user.credits || 0) - 1);
    Promise.all([
      !user.isSubscriber ? addCredits(userId, -1) : null,
      incrementGlobalCount(),
      incrementUserDailyCount(userId)
    ]).catch(() => {});

    res.json({
      ok: true,
      text,
      meta: {
        mode: useSearch ? 'deep' : 'quick',
        isSubscriber: !!user.isSubscriber,
        creditsRemaining: nextCredits,
        freeDailyLimit: user.isSubscriber ? null : FREE_DAILY_LIMIT,
      }
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
