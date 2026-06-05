'use strict';
// ─── AI SERVICE ───────────────────────────────────────────────────────────────
// Handles all calls to Anthropic and OpenAI APIs.
// Extracts text, cleans JSON, manages timeouts and fallbacks.

const Anthropic = require('@anthropic-ai/sdk');

const MODELS = {
  quick: process.env.ANTHROPIC_QUICK_MODEL || 'claude-haiku-4-5-20251001',
  deep: process.env.ANTHROPIC_DEEP_MODEL || 'claude-sonnet-4-6',
};



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
    .replace(/,(\s*[}\]])/g, '$1');
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

module.exports = {
  withTimeout,
  extractAnthropicText,
  extractOpenAIText,
  cleanJsonText,
  callAnthropic,
  callOpenAI,
  analysisErrorMessage,
};
