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
const { OWNER_EMAILS } = require('../lib/owners');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODELS = {
  quick: process.env.ANTHROPIC_QUICK_MODEL || 'claude-haiku-4-5-20251001',
  deep: process.env.ANTHROPIC_DEEP_MODEL || 'claude-sonnet-4-6',
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

function percent(value) {
  return `${roundNumber(value * 100, 1)}%`;
}

function extractAmericanOdds(text) {
  const source = String(text || '');
  const contextualMatch = source.match(/\b(?:odds|price|line|moneyline|ml|@)\s*:?\s*([+-]\d{2,4})\b/i);
  const moneylineMatch = source.match(/\b[A-Z][A-Za-z .'-]{1,40}\s+([+-]\d{2,4})(?:\s|\/|$)/);
  const fallbackMatch = source.match(/\b([+-]\d{2,4})\b/);
  const odds = Number((contextualMatch || moneylineMatch || fallbackMatch || [])[1]);

  if (!Number.isFinite(odds) || odds === 0) return null;
  if (Math.abs(odds) < 100 || Math.abs(odds) > 2500) return null;

  return odds;
}

function promptBody(prompt) {
  return String(prompt || '').split(/\nINSTRUCTIONS:/i)[0];
}

function keywordScore(text, positivePatterns, negativePatterns) {
  const source = String(text || '').toLowerCase();
  const positives = positivePatterns.reduce((sum, pattern) => sum + (pattern.test(source) ? 1 : 0), 0);
  const negatives = negativePatterns.reduce((sum, pattern) => sum + (pattern.test(source) ? 1 : 0), 0);

  return Math.max(-10, Math.min(10, (positives - negatives) * 3));
}

function getRisk(confidence, score) {
  if (confidence === 'HIGH') return score > 12 ? 'LOW' : 'MEDIUM';
  if (confidence === 'MEDIUM') return 'MEDIUM';
  return 'HIGH';
}

function getEdgeStrength(score) {
  if (score > 8) return 'STRONG';
  if (score > 3) return 'MODERATE';
  if (score > 0) return 'WEAK';
  return 'NONE';
}

function getRecommendedAction(verdict, confidence) {
  if (verdict === 'BET') {
    return confidence === 'HIGH'
      ? 'Bet only if the current line is still available.'
      : 'Small bet only if the price has not moved against the projection.';
  }
  if (verdict === 'LEAN') return 'Track the line and only bet if the price improves.';
  return 'Pass unless new odds create a stronger EDGE score.';
}

function formatAmericanOdds(odds) {
  const value = Number(odds);
  if (!Number.isFinite(value)) return '';
  return value > 0 ? `+${value}` : String(value);
}

function extractGameTeams(prompt) {
  const match = String(prompt || '').match(/\bGAME:\s*([^\n@]+?)\s+@\s+([^\n]+)/i);
  if (!match) return null;
  return {
    away: match[1].trim(),
    home: match[2].trim(),
  };
}

function extractPromptPlay(prompt) {
  const source = promptBody(prompt);
  const labeled = source.match(/\b(?:pick|play|bet|side)\s*:?\s*([A-Z][A-Za-z0-9 .'-]{1,60}?(?:\s+(?:ML|moneyline|spread|over|under))?(?:\s+[+-]\d{2,4})?)\b/i);
  if (labeled && !/\bprompt\b/i.test(labeled[1])) return labeled[1].replace(/\s+/g, ' ').trim();

  const moneyline = source.match(/\b([A-Z][A-Za-z .'-]{1,40}\s+(?:ML|moneyline)\s+[+-]\d{2,4})\b/i);
  if (moneyline) return moneyline[1].replace(/\s+/g, ' ').trim();

  return '';
}

function extractBookOdds(prompt) {
  const teams = extractGameTeams(prompt);
  if (!teams) return [];

  const rows = [];
  const lines = String(prompt || '').split(/\r?\n/);
  const awayPattern = new RegExp(`${escapeRegExp(teams.away)}\\s+([+-]\\d{2,4})`, 'i');
  const homePattern = new RegExp(`${escapeRegExp(teams.home)}\\s+([+-]\\d{2,4})`, 'i');

  lines.forEach(line => {
    const away = line.match(awayPattern);
    const home = line.match(homePattern);
    if (away) rows.push({ team: teams.away, odds: Number(away[1]) });
    if (home) rows.push({ team: teams.home, odds: Number(home[1]) });
  });

  return rows.filter(row => Number.isFinite(row.odds));
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pickFromPrompt(prompt, evaluation) {
  if (evaluation.verdict === 'PASS') return 'No clear edge';

  const explicit = extractPromptPlay(prompt);
  if (explicit) return explicit;

  const bookOdds = extractBookOdds(prompt);
  const plusMoney = bookOdds
    .filter(row => row.odds > 0)
    .sort((a, b) => b.odds - a.odds)[0];
  if (plusMoney && ['BET', 'LEAN'].includes(evaluation.verdict)) {
    return `${plusMoney.team} ML ${formatAmericanOdds(plusMoney.odds)}`;
  }

  const best = bookOdds.sort((a, b) => b.odds - a.odds)[0];
  if (best && ['BET', 'LEAN'].includes(evaluation.verdict)) {
    return `${best.team} ML ${formatAmericanOdds(best.odds)}`;
  }

  const teams = extractGameTeams(prompt);
  if (teams && ['BET', 'LEAN'].includes(evaluation.verdict)) {
    return `${teams.home} ML`;
  }

  return 'Best available play';
}

function getSignalFactors(prompt, odds) {
  const source = promptBody(prompt);
  const form = keywordScore(
    source,
    [/\bhot\b/, /\bstrong form\b/, /\bwon\b/, /\bwinning streak\b/, /\brest advantage\b/],
    [/\bcold\b/, /\bslump\b/, /\blost\b/, /\blosing streak\b/, /\bfatigue\b/]
  );
  const matchup = keywordScore(
    source,
    [/\bmatchup advantage\b/, /\bfavorable matchup\b/, /\bhome advantage\b/, /\bhealthy\b/],
    [/\bbad matchup\b/, /\bunfavorable matchup\b/, /\binjur(?:y|ies|ed)\b/, /\bquestionable\b/]
  );
  const market = odds > 0 ? Math.min(20, Math.max(0, (odds - 100) / 20)) : 0;

  return { form, matchup, market: roundNumber(market, 2) };
}

function fallbackReason(oddsDetected, score) {
  if (!oddsDetected) {
    return 'Odds were not detected, so EDGE cannot calculate a reliable value signal.';
  }
  if (score > 8) return 'The calculated EDGE score clears the BET threshold based on the projected probability versus the market price.';
  if (score > 3) return 'The calculated EDGE score shows a modest value signal, but it does not clear the strongest betting threshold.';
  return 'The calculated EDGE score does not show enough value over the implied market probability.';
}

function fallbackTopFactors(evaluation) {
  return [
    `Market implied probability: ${percent(evaluation.impliedProb)}`,
    `EDGE projection: ${percent(evaluation.projectedProb)}`,
    `Score threshold result: ${evaluation.verdict}`,
  ];
}

function normalizeTopFactors(value, evaluation) {
  if (Array.isArray(value)) return value.slice(0, 4).map(item => String(item));
  if (value) return [String(value)];
  return fallbackTopFactors(evaluation);
}

function buildEdgeEvaluation(prompt) {
  const odds = extractAmericanOdds(prompt);
  const oddsDetected = odds != null;
  const implied = oddsDetected ? impliedProb(odds) : 0.5;
  const projected = oddsDetected ? clampProbability(implied + 0.03) : 0.5;
  const factors = oddsDetected ? getSignalFactors(prompt, odds) : { form: 0, matchup: 0, market: 0 };
  const edgeScore = oddsDetected ? computeEdgeScore({ implied, projected, ...factors }) : 0;
  const verdict = getVerdict(edgeScore);
  const confidence = getConfidence(edgeScore);
  const risk = getRisk(confidence, edgeScore);
  const edgeStrength = getEdgeStrength(edgeScore);
  const recommendedAction = getRecommendedAction(verdict, confidence);

  const evaluation = {
    odds,
    oddsDetected,
    impliedProb: roundNumber(implied),
    projectedProb: roundNumber(projected),
    edgeScore: roundNumber(edgeScore, 2),
    verdict,
    confidence,
    risk,
    edgeStrength,
    recommendedAction,
  };

  evaluation.pick = pickFromPrompt(prompt, evaluation);
  return evaluation;
}

function buildScoredPrompt(prompt, evaluation) {
  return [
    'Game / bet prompt:',
    prompt,
    '',
    'Algorithm values:',
    `- Implied Probability: ${evaluation.impliedProb}`,
    `- Projected Probability: ${evaluation.projectedProb}`,
    `- Edge Score: ${evaluation.edgeScore}`,
    `- Verdict: ${evaluation.verdict}`,
    `- Confidence: ${evaluation.confidence}`,
    `- Risk: ${evaluation.risk}`,
    `- Edge Strength: ${evaluation.edgeStrength}`,
    '',
    'Instruction:',
    'Explain the reasoning for this pick based on the calculated EDGE score. Do not change the verdict. Return strict JSON only.',
    '',
    'Return this JSON shape only:',
    '{"reason":"2-3 sentence explanation","topFactors":["factor 1","factor 2","factor 3"]}',
  ].join('\n');
}

function parseJsonObject(text) {
  try {
    return JSON.parse(cleanJsonText(text));
  } catch {
    return null;
  }
}

function buildStructuredResult(evaluation, aiText) {
  const parsed = parseJsonObject(aiText) || {};
  const reason = parsed.reason || parsed.reasoning || fallbackReason(evaluation.oddsDetected, evaluation.edgeScore);

  return {
    verdict: evaluation.verdict,
    pick: parsed.pick || parsed.exactPlay || parsed.recommendedPlay || parsed.bet_on || parsed.betOn || parsed.team || parsed.play || parsed.side || evaluation.pick,
    confidence: evaluation.confidence,
    risk: evaluation.risk,
    edgeStrength: evaluation.edgeStrength,
    edgeScore: evaluation.edgeScore,
    impliedProb: evaluation.impliedProb,
    projectedProb: evaluation.projectedProb,
    reason,
    topFactors: normalizeTopFactors(parsed.topFactors || parsed.key_factors || parsed.keyFactors, evaluation),
    recommendedAction: evaluation.recommendedAction,
  };
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

    if (evaluation.oddsDetected) {
      try {
        result = await callAnthropic(scoredPrompt, mode);
      } catch (err) {
        if (!process.env.OPENAI_API_KEY) throw err;
        result = await withTimeout(callOpenAI(scoredPrompt, mode), mode === 'deep' ? 45000 : 20000, 'openai fallback');
        fallbackUsed = true;
      }
    } else {
      result = {
        provider: 'edge-scoring',
        model: 'deterministic-fallback',
        text: JSON.stringify(buildStructuredResult(evaluation, '')),
      };
    }

    if (evaluation.oddsDetected && !fallbackUsed && secondLayer && process.env.OPENAI_API_KEY) {
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

    const structured = buildStructuredResult(evaluation, result.text);
    result.text = JSON.stringify(structured);

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
