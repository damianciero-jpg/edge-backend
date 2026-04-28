const express = require('express');
const router = express.Router();
const Anthropic = require('@anthropic-ai/sdk');
const { getUser, addCredits } = require('../lib/users');
const {
  getGlobalCount,
  incrementGlobalCount,
  getUserDailyCount,
  incrementUserDailyCount,
  getLimitConfig,
} = require('../lib/limits');
const { verifySession } = require('../lib/auth');
const { ok, fail } = require('../lib/http');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const OWNER_EMAILS = [
  'damianciero@gmail.com',
  'ffanning@comcast.net',
  'afelt1991@yahoo.com',
];

const MODELS = {
  quick: process.env.ANTHROPIC_QUICK_MODEL || 'claude-haiku-4-5',
  deep: process.env.ANTHROPIC_DEEP_MODEL || 'claude-sonnet-4-5',
};

const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.4-mini';

const SYSTEM_TEXT = [
  'You are an expert sports betting analyst specializing in expected value modeling.',
  'Return ONLY a raw JSON object. No markdown, no code fences, no comments, no preamble.',
  'Start with { and end with }.',
].join(' ');

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

function extractAnthropicText(response) {
  try {
    if (!response || !Array.isArray(response.content)) {
      return '';
    }

    return response.content
      .filter(block => block && block.type === 'text' && block.text)
      .map(block => block.text)
      .join('\n')
      .trim();
  } catch (err) {
    console.error('extractAnthropicText error:', err.message);
    return '';
  }
}

function extractOpenAIText(response) {
  if (response && response.output_text) return response.output_text.trim();
  return (response && response.output ? response.output : [])
    .flatMap(item => item && item.content ? item.content : [])
    .map(part => part.text || part.content || '')
    .filter(Boolean)
    .join('\n')
    .trim();
}

function cleanJsonText(text) {
  const match = String(text || '').match(/\{[\s\S]*\}/);
  if (!match) return String(text || '').trim();
  return match[0]
    .replace(/\/\/[^\n]*/g, '')
    .replace(/,(\s*[}\]])/g, '$1')
    .trim();
}

function impliedProb(odds) {
  return odds > 0
    ? 100 / (odds + 100)
    : Math.abs(odds) / (Math.abs(odds) + 100);
}

function computeEdgeScore({ implied, projected, form = 0, matchup = 0, market = 0 }) {
  let score = 0;

  score += (projected - implied) * 100 * 0.5;
  score += form * 0.2;
  score += matchup * 0.15;
  score += market * 0.15;

  return score;
}

function getVerdict(score) {
  if (score > 8) return 'BET';
  if (score > 3) return 'LEAN';
  return 'PASS';
}

function getConfidence(score) {
  if (score > 10) return 'HIGH';
  if (score > 5) return 'MEDIUM';
  return 'LOW';
}

function clampProbability(value) {
  return Math.min(0.99, Math.max(0.01, value));
}

function roundNumber(value, digits = 4) {
  return Number(value.toFixed(digits));
}

function extractAmericanOdds(text) {
  const source = String(text || '');
  const contextualMatch = source.match(/\b(?:odds|price|line|moneyline|ml|@)\s*:?\s*([+-]\d{2,4})\b/i);
  const fallbackMatch = source.match(/\b([+-]\d{2,4})\b/);
  const odds = Number((contextualMatch || fallbackMatch || [])[1]);

  return Number.isFinite(odds) && odds !== 0 ? odds : null;
}

function buildEdgeEvaluation(prompt) {
  const odds = extractAmericanOdds(prompt);
  const implied = odds == null ? 0.5 : impliedProb(odds);
  const projected = clampProbability(implied + 0.075);
  const edgeScore = computeEdgeScore({ implied, projected });
  const verdict = getVerdict(edgeScore);
  const confidence = getConfidence(edgeScore);

  return {
    odds,
    impliedProb: roundNumber(implied),
    projectedProb: roundNumber(projected),
    edgeScore: roundNumber(edgeScore, 2),
    verdict,
    confidence,
  };
}

function buildScoredPrompt(prompt, evaluation) {
  return [
    prompt,
    '',
    'PROPRIETARY EDGE SCORE:',
    `- American odds used: ${evaluation.odds == null ? 'not supplied; default baseline used' : evaluation.odds}`,
    `- Implied probability: ${evaluation.impliedProb}`,
    `- Projected probability: ${evaluation.projectedProb}`,
    `- Edge score: ${evaluation.edgeScore}`,
    `- Verdict: ${evaluation.verdict}`,
    '',
    'Explain the reasoning for this pick based on the calculated edge score.',
    '',
    'Include these calculated fields in the returned JSON exactly:',
    '"verdict", "confidence", "edgeScore", "impliedProb", "projectedProb", "reason"',
  ].join('\n');
}

function parseJsonObject(text) {
  try {
    return JSON.parse(cleanJsonText(text));
  } catch {
    return null;
  }
}

async function callAnthropic(prompt, mode) {
  const model = MODELS[mode];
  const params = {
    model,
    max_tokens: 1500,
    system: SYSTEM_TEXT,
    messages: [{ role: 'user', content: prompt }],
  };

  if (mode === 'deep') {
    params.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
  }

  try {
    const response = await anthropic.messages.create(params, { timeout: mode === 'deep' ? 180000 : 30000 });
    const text = cleanJsonText(extractAnthropicText(response));
    if (!text) {
      throw new Error('Research returned no readable text. Try Quick AI or retry Research.');
    }

    return {
      provider: 'anthropic',
      model,
      text,
      usage: response.usage,
    };
  } catch (err) {
    console.error('Anthropic call failed:', {
      provider: 'anthropic',
      mode,
      model,
      status: err.status || err.statusCode || 'unknown',
      message: err.message,
    });
    throw err;
  }
}

async function callOpenAI(prompt, mode, candidateText) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OpenAI fallback not configured');

  const input = candidateText
    ? `Original request:\n${prompt}\n\nReview and repair this JSON/text. Return only raw JSON:\n${candidateText}`
    : prompt;

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      instructions: SYSTEM_TEXT,
      input,
      max_output_tokens: candidateText ? 900 : 1500,
    }),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error((body.error && body.error.message) || `OpenAI request failed with ${response.status}`);
    err.status = response.status;
    throw err;
  }

  return {
    provider: candidateText ? 'openai-reviewer' : 'openai',
    model: OPENAI_MODEL,
    text: cleanJsonText(extractOpenAIText(body)),
    usage: body.usage,
  };
}

function analysisErrorMessage(err) {
  const status = err.status || err.statusCode;
  if (status === 429) return 'AI API rate limit hit. Wait a minute and try again.';
  if (status === 401) return 'AI provider authentication failed. Check server API key configuration.';
  if (status === 403) return 'AI provider key does not have access to the requested model.';
  return err.message || 'Analysis failed.';
}

router.post('/', async (req, res) => {
  const startedAt = Date.now();
  const { prompt, useSearch = false, secondLayer = false } = req.body || {};
  const mode = useSearch ? 'deep' : 'quick';

  const session = verifySession(req.cookies && req.cookies.edge_session);
  if (!session || !session.email) {
    return fail(res, 401, { text: 'Login required', error: 'Not logged in', data: { authRequired: true } });
  }

  if (!prompt || typeof prompt !== 'string') {
    return fail(res, 400, { text: 'Missing required prompt', error: 'prompt is required', meta: { mode } });
  }

  const userId = session.email;
  let user;
  let globalLimit;
  let userLimit;

  try {
    [user, { globalLimit, userLimit }] = await withTimeout(
      Promise.all([getUser(userId), getLimitConfig()]),
      5000,
      'user/limits fetch'
    );
  } catch (err) {
    console.error('Analyze storage fetch error:', err.message);
    return fail(res, 503, { text: 'Temporary storage issue', error: 'Storage unavailable', meta: { mode } });
  }

  const isOwner = OWNER_EMAILS.includes(String(userId || '').toLowerCase());

  if (isOwner) {
    user = {
      ...user,
      isSubscriber: true,
      credits: 9999,
    };
  }

  if (!user.isSubscriber && user.credits <= 0) {
    return fail(res, 402, {
      text: 'No credits remaining',
      error: 'No credits remaining',
      meta: { mode },
      data: { paywall: true, upgrade: true },
    });
  }

  let globalCount = 0;
  try {
    globalCount = await withTimeout(getGlobalCount(), 3000, 'global count');
  } catch {
    globalCount = 0;
  }

  if (globalCount >= (globalLimit || 150)) {
    return fail(res, 503, {
      text: 'Daily analysis capacity reached. Resets at midnight UTC.',
      error: 'Global daily limit reached',
      meta: { mode, limitType: 'global', used: globalCount, limit: globalLimit || 150 },
    });
  }

  if (user.isSubscriber) {
    let userCount = 0;
    try {
      userCount = await withTimeout(getUserDailyCount(userId), 3000, 'user count');
    } catch {
      userCount = 0;
    }

    if (userCount >= (userLimit || 20)) {
      return fail(res, 429, {
        text: `Daily limit of ${userLimit || 20} analyses reached. Resets at midnight UTC.`,
        error: 'User daily limit reached',
        meta: { mode, limitType: 'user', used: userCount, limit: userLimit || 20 },
      });
    }
  }

  try {
    let result;
    let fallbackUsed = false;
    let reviewed = false;
    const evaluation = buildEdgeEvaluation(prompt);
    const scoredPrompt = buildScoredPrompt(prompt, evaluation);

    try {
      result = await callAnthropic(scoredPrompt, mode);
    } catch (err) {
      if (!process.env.OPENAI_API_KEY) throw err;
      result = await withTimeout(callOpenAI(scoredPrompt, mode), mode === 'deep' ? 45000 : 20000, 'openai fallback');
      fallbackUsed = true;
    }

    if (!fallbackUsed && secondLayer && process.env.OPENAI_API_KEY) {
      try {
        const review = await withTimeout(callOpenAI(scoredPrompt, mode, result.text), 12000, 'openai reviewer');
        if (review.text) {
          result.text = review.text;
          reviewed = true;
        }
      } catch (err) {
        console.warn('OpenAI reviewer skipped:', err.message);
      }
    }

    Promise.all([
      !user.isSubscriber && !isOwner
        ? withTimeout(addCredits(userId, -1), 3000, 'credit deduct').catch(e => console.error(e.message))
        : Promise.resolve(),
      withTimeout(incrementGlobalCount(), 3000, 'incr global').catch(e => console.error(e.message)),
      withTimeout(incrementUserDailyCount(userId), 3000, 'incr user').catch(e => console.error(e.message)),
    ]).catch(e => console.error(e.message));

    const parsed = parseJsonObject(result.text) || {};
    const reason = parsed.reason || parsed.reasoning || result.text;
    const structured = {
      verdict: evaluation.verdict,
      confidence: evaluation.confidence,
      edgeScore: evaluation.edgeScore,
      impliedProb: evaluation.impliedProb,
      projectedProb: evaluation.projectedProb,
      reason,
    };
    result.text = JSON.stringify({ ...parsed, ...structured });

    return ok(res, {
      text: result.text,
      data: {
        content: [{ type: 'text', text: result.text }],
        ...structured,
      },
      meta: {
        mode,
        provider: result.provider,
        model: result.model,
        fallbackUsed,
        reviewed,
        elapsedMs: Date.now() - startedAt,
      },
    });
  } catch (err) {
    const status = err.status || err.statusCode || 500;
    console.error(`AI analysis error [${status}] mode=${mode}:`, err.message);
    return fail(res, 500, {
      text: 'Analysis failed',
      error: analysisErrorMessage(err),
      meta: { mode, status, elapsedMs: Date.now() - startedAt },
    });
  }
});

module.exports = router;
