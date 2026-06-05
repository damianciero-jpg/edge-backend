'use strict';
// ─── ANALYZE ROUTE — CONTROLLER ──────────────────────────────────────────────
// Orchestrates the full analysis pipeline.
// All heavy logic lives in lib/analysis/* services.
// This file is auth + orchestration only.

const express = require('express');
const router  = express.Router();

const { verifySession }          = require('../lib/auth');
const { getUser }                = require('../lib/users');
const { getLimitConfig,
        getGlobalCount,
        incrementGlobalCount,
        getUserDailyCount,
        incrementUserDailyCount } = require('../lib/limits');
const { getCfg }                 = require('../lib/config');
const { OWNER_EMAILS }           = require('../lib/owners');

const { fetchLiveGameOdds,
        fetchGameById }          = require('../lib/analysis/odds-service');
const { fetchLineMovement }      = require('../lib/analysis/line-service');
const { buildCandidateEvaluation,
        buildEdgeEvaluation }    = require('../lib/analysis/evaluation-engine');
const { buildScoredPrompt,
        buildMultiCandidatePrompt,
        buildGamePrompt }        = require('../lib/analysis/prompt-builder');
const { callAnthropic,
        callOpenAI,
        cleanJsonText,
        withTimeout,
        analysisErrorMessage }   = require('../lib/analysis/ai-service');
const { buildStructuredResult }  = require('../lib/analysis/response-formatter');

// ─── STRUCTURED LOGGER ───────────────────────────────────────────────────────
// All EDGE logs use this format for easy filtering in Vercel dashboard.
// Filter by "[EDGE]" to see only analysis pipeline logs.

function log(event, data = {}) {
  console.log(JSON.stringify({
    _edge: true,
    event,
    ts: new Date().toISOString(),
    ...data,
  }));
}

// ─── STALE LINE CONSTANTS ─────────────────────────────────────────────────────
const STALE_WARN_MS = 15 * 60 * 1000;
const STALE_HARD_MS = 30 * 60 * 1000;

function checkStale(fetchedAt) {
  if (!fetchedAt) return { stale: false, hard: false, ageMinutes: 0 };
  const age = Date.now() - fetchedAt;
  return { stale: age > STALE_WARN_MS, hard: age > STALE_HARD_MS, ageMinutes: Math.round(age / 60000) };
}

function buildStaleWarning(ageMinutes, hard) {
  if (hard) return `⚠️ LINE AGE WARNING: Odds data is ${ageMinutes} minutes old. This edge may no longer exist — the line has likely moved. Analysis capped at LEAN. Refresh and re-run for a current read.`;
  return `⚠️ Line data is ${ageMinutes} minutes old. Verify the current price before betting — value gaps close fast.`;
}

// ─── MAIN ROUTE ──────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  // ── Stage A: Auth & limits ────────────────────────────────────────────────
  const session = verifySession(req.cookies?.edge_session);
  const userId  = String(session?.email || req.body?.userId || '').toLowerCase().trim();
  const isOwner = OWNER_EMAILS.includes(userId);

  if (!userId) return res.status(401).json({ ok: false, authRequired: true });

  const reqStart = Date.now();
  const reqId = Math.random().toString(36).slice(2, 8);
  log('request_start', { reqId, userId: userId.split('@')[0] + '@...', mode: req.body?.useSearch ? 'deep' : 'quick', gameId: req.body?.gameId, sport: req.body?.sport });

  let user, limitCfg, globalCount, userDayCount;
  try {
    [user, limitCfg, globalCount, userDayCount] = await Promise.all([
      withTimeout(getUser(userId), 3000, 'getUser'),
      withTimeout(getLimitConfig(), 3000, 'getLimitConfig'),
      withTimeout(getGlobalCount(), 3000, 'getGlobalCount'),
      withTimeout(getUserDailyCount(userId), 3000, 'getUserDailyCount'),
    ]);
  } catch (err) {
    log('error', { reqId, stage: 'stage_a', error: err.message });
    return res.status(503).json({ ok: false, error: 'Service temporarily unavailable.' });
  }

  const hasAccess = isOwner || !!user?.isSubscriber;
  log('stage_a_complete', { reqId, duration_ms: Date.now() - reqStart, hasAccess, credits: user?.credits ?? 0 });

  if (!hasAccess && (user?.credits ?? 0) <= 0) {
    return res.status(402).json({ ok: false, paywall: true, error: 'No credits remaining.' });
  }
  if (!isOwner && globalCount >= (limitCfg.globalLimit ?? 150)) {
    return res.status(429).json({ ok: false, error: 'Daily analysis limit reached. Try again tomorrow.' });
  }
  if (!isOwner && hasAccess && userDayCount >= (limitCfg.userLimit ?? 20)) {
    return res.status(429).json({ ok: false, error: 'Daily limit reached for your account.' });
  }

  // ── Stage B: Parse request ────────────────────────────────────────────────
  const { prompt: rawPrompt, useSearch, secondLayer,
          gameId, sport, market, selection } = req.body;
  const mode = useSearch ? 'deep' : 'quick';

  const apiKey = await withTimeout(
    getCfg('oddsApiKey', 'ODDS_API_KEY', process.env.THE_ODDS_API_KEY || process.env.ODDS_KEY),
    3000, 'getCfg'
  ).catch(() => process.env.THE_ODDS_API_KEY || process.env.ODDS_KEY || null);

  // ── Stage B: Fetch live odds (root dependency) ────────────────────────────
  // NEW: if gameId + sport sent, fetch game directly (server-side prompt generation)
  // LEGACY: if prompt string sent, use existing flow for backward compatibility
  let liveOdds = null;
  let prompt   = rawPrompt || '';
  let serverSideMode = false;

  try {
    if (gameId && sport && apiKey) {
      // Server-side mode — fetch game by ID, build prompt internally
      const game = await withTimeout(fetchGameById(gameId, sport, apiKey), 8000, 'fetchGameById');
      if (game) {
        prompt         = buildGamePrompt(game, mode, selection || null);
        serverSideMode = true;
        console.log('[EDGE] Server-side prompt built for:', game.away_team, '@', game.home_team);
      }
    }

    if (!serverSideMode && !prompt) {
      return res.status(400).json({ ok: false, error: 'gameId+sport or prompt is required.' });
    }

    if (!serverSideMode && apiKey) {
      liveOdds = await withTimeout(fetchLiveGameOdds(prompt, apiKey), 8000, 'fetchLiveGameOdds');
    } else if (serverSideMode && apiKey) {
      liveOdds = await withTimeout(fetchLiveGameOdds(prompt, apiKey), 8000, 'fetchLiveGameOdds');
    }
  } catch (err) {
    console.warn('Odds/prompt setup failed:', err.message);
  }

  log('odds_complete', { reqId, duration_ms: Date.now() - reqStart, hasOdds: !!liveOdds, serverSide: serverSideMode, sport: req.body?.sport, candidateCount: liveOdds?.candidates?.length || 0 });

  // ── Stage C: Fan-out — line movement (depends on odds) ───────────────────
  let lineMovementSignal = null;
  let lineMovementScore  = 0;
  if (liveOdds) {
    try {
      // Pass both teams' odds and real game ID for RLM detection
      const lm = await fetchLineMovement(
        liveOdds.homeTeam, liveOdds.awayTeam,
        liveOdds.homeOdds, liveOdds.awayOdds,
        req.body?.gameId || null
      );
      lineMovementScore  = lm.score || 0;
      lineMovementSignal = lm;
    } catch (err) {
      console.warn('Line movement failed:', err.message);
    }
  }

  // ── Stage C: Stale line check ─────────────────────────────────────────────
  let staleWarning    = null;
  let staleAgeMinutes = 0;
  if (liveOdds?.fetchedAt) {
    const sc = checkStale(liveOdds.fetchedAt);
    staleAgeMinutes = sc.ageMinutes;
    if (sc.stale) {
      staleWarning = buildStaleWarning(sc.ageMinutes, sc.hard);
      console.warn(`STALE LINE: ${sc.ageMinutes} min old, hard=${sc.hard}`);
    }
  }

  const resolvedPrompt = staleWarning ? `${prompt}\n\n${staleWarning}` : prompt;

  // ── Stage C: Candidate evaluation ────────────────────────────────────────
  let evaluation;
  let allPairsForAI = null;

  if (liveOdds?.candidates?.length) {
    const pairs = liveOdds.candidates.map(c => {
      // Use side-specific RLM score
      const candidateRLM = lineMovementSignal
        ? (c.side === 'home'
            ? (lineMovementSignal.home?.score || 0) + (lineMovementSignal.rlmScore || 0)
            : (lineMovementSignal.away?.score || 0) - (lineMovementSignal.rlmScore || 0))
        : lineMovementScore;

      return {
        candidate: c,
        eval: buildCandidateEvaluation(resolvedPrompt, {
          side: c.side, team: c.team, opponent: c.opponent,
          market: c.market, odds: c.odds, opponentOdds: c.opponentOdds,
          // Attach pitcher data so evaluation-engine can compute pitcherSignal
          pitchers: liveOdds.pitchers || null,
        }, candidateRLM),
      };
    });

    console.log('CANDIDATES:', JSON.stringify(pairs.map(p => ({
      team: p.candidate.team, market: p.candidate.market,
      odds: p.candidate.odds, score: p.eval.edgeScore, verdict: p.eval.verdict,
    }))));

    pairs.sort((a, b) => b.eval.edgeScore - a.eval.edgeScore);

    const allNegative = pairs.every(p => p.eval.edgeScore <= 0);

    if (allNegative && mode === 'deep') {
      allPairsForAI = pairs;
      evaluation    = pairs[0].eval;
      evaluation.pick      = pairs[0].candidate.label;
      evaluation.evaluating = pairs[0].candidate.label;
    } else {
      const best = pairs.filter(p => p.eval.edgeScore > 0)[0] || pairs[0];
      evaluation  = best.eval;
      if (best.candidate && evaluation.verdict !== 'PASS') {
        evaluation.pick      = best.candidate.label;
        evaluation.evaluating = best.candidate.label;
      }
    }

    const betCandidates = pairs.filter(p => p.eval.verdict !== 'PASS');
    evaluation.allCandidates = (betCandidates.length ? betCandidates : pairs.slice(0, 3)).map(p => ({
      label: p.candidate.label, market: p.candidate.market,
      edgeScore: p.eval.edgeScore, verdict: p.eval.verdict,
      impliedProb: p.eval.impliedProb, projectedProb: p.eval.projectedProb,
    }));

  } else {
    // No live odds — evaluate from prompt text
    evaluation = buildEdgeEvaluation(resolvedPrompt, {}, lineMovementScore);
  }

  evaluation.lineMovementSignal = lineMovementSignal;
  evaluation.mode               = mode;

  // Apply hard stale penalty before AI call
  if (staleWarning && staleAgeMinutes >= 30 && evaluation.verdict === 'BET') {
    evaluation.verdict    = 'LEAN';
    evaluation.confidence = 'LOW';
    evaluation.risk       = 'HIGH';
  }

  // ── Stage D: AI call ──────────────────────────────────────────────────────
  let result, fallbackUsed = false, reviewed = false;
  let scoredPrompt;
  let multiCandidateMode = false;

  if (allPairsForAI && mode === 'deep') {
    scoredPrompt       = buildMultiCandidatePrompt(resolvedPrompt, allPairsForAI);
    multiCandidateMode = true;
    console.log('MULTI-CANDIDATE MODE: AI selecting best side');
  } else {
    scoredPrompt = buildScoredPrompt(resolvedPrompt, evaluation);
  }

  if (evaluation.oddsDetected) {
    try {
      result = await withTimeout(
        callAnthropic(scoredPrompt, mode),
        mode === 'deep' ? 185000 : 35000,
        'callAnthropic'
      );
    } catch (err) {
      if (!process.env.OPENAI_API_KEY) throw err;
      result = await withTimeout(callOpenAI(scoredPrompt, mode), mode === 'deep' ? 45000 : 20000, 'openai fallback');
      fallbackUsed = true;
    }

    // Multi-candidate: parse AI's chosen candidate and rebuild evaluation
    if (multiCandidateMode && result?.text) {
      try {
        const parsed    = JSON.parse(cleanJsonText(result.text));
        const aiChosen  = String(parsed.bestCandidate || '').trim();
        const aiVerdict = String(parsed.aiVerdict     || '').toUpperCase();
        console.log('MULTI-CANDIDATE AI response:', { aiChosen, aiVerdict });

        if (aiChosen && aiChosen !== 'PASS' && aiVerdict !== 'PASS') {
          const chosenLower = aiChosen.toLowerCase();
          const matchedPair = allPairsForAI.find(p => {
            const tl = p.candidate.team.toLowerCase();
            const ll = p.candidate.label.toLowerCase();
            return ll === chosenLower || ll.includes(chosenLower) || chosenLower.includes(tl) ||
              tl.split(' ').some(w => w.length > 4 && chosenLower.includes(w));
          });

          if (matchedPair) {
            const saved = evaluation.allCandidates;
            evaluation  = matchedPair.eval;
            evaluation.pick              = matchedPair.candidate.label;
            evaluation.evaluating        = matchedPair.candidate.label;
            evaluation.selectedTeam      = matchedPair.candidate.team;
            evaluation.opponentTeam      = matchedPair.candidate.opponent;
            evaluation.market            = matchedPair.candidate.market;
            evaluation.mode              = mode;
            evaluation.lineMovementSignal = lineMovementSignal;
            evaluation.allCandidates     = saved;
            // Inject aiVerdict so consensus gate sees it
            const ep = JSON.parse(cleanJsonText(result.text));
            ep.aiVerdict  = aiVerdict;
            result.text   = JSON.stringify(ep);
            console.log('AI chose:', matchedPair.candidate.label, 'score:', evaluation.edgeScore);
          }
        }
      } catch (e) {
        console.warn('Multi-candidate parse failed:', e.message);
      }
    }

    // Optional OpenAI review pass
    if (!fallbackUsed && secondLayer && process.env.OPENAI_API_KEY) {
      try {
        const review = await withTimeout(callOpenAI(scoredPrompt, mode, result.text), 12000, 'openai reviewer');
        if (review?.text) { result.text = review.text; reviewed = true; }
      } catch (err) {
        console.warn('OpenAI reviewer skipped:', err.message);
      }
    }
  } else {
    result = { provider: 'edge-scoring', model: 'deterministic-fallback', text: '' };
  }

  log('ai_complete', { reqId, duration_ms: Date.now() - reqStart, provider: result?.provider, model: result?.model, fallback: fallbackUsed, reviewed, oddsDetected: !!evaluation?.oddsDetected });

  // ── Stage D: Format response ──────────────────────────────────────────────
  const structured = buildStructuredResult(evaluation, result?.text || '');
  if (staleWarning) {
    structured.staleWarning   = staleWarning;
    structured.lineAgeMinutes = staleAgeMinutes;
    if (staleAgeMinutes >= 30 && structured.verdict === 'BET') {
      structured.verdict           = 'LEAN';
      structured.confidence        = 'LOW';
      structured.risk              = 'HIGH';
      structured.recommendedAction = 'Line data is over 30 minutes old. Verify current price before betting.';
    }
  }

  // ── Deduct credits (fire-and-forget) ─────────────────────────────────────
  Promise.all([
    !hasAccess ? withTimeout(getUser(userId), 3000, 'credit deduct')
      .then(u => u && u.credits > 0 ? withTimeout(
        require('../lib/users').saveUser(userId, { credits: Math.max(0, (u.credits || 0) - 1) }),
        3000, 'save credits'
      ) : null).catch(e => console.error('Credit deduct error:', e.message)) : Promise.resolve(),
    withTimeout(incrementGlobalCount(),       3000, 'incr global').catch(e => console.error(e.message)),
    withTimeout(incrementUserDailyCount(userId), 3000, 'incr user').catch(e => console.error(e.message)),
  ]).catch(e => console.error(e.message));

  const totalMs = Date.now() - reqStart;
  log('response', { reqId, total_ms: totalMs, verdict: structured.verdict, edgeScore: structured.edgeScore, pick: structured.pick, conflicted: structured.consensusConflict || false, stale: !!structured.staleWarning });

  return res.json({
    ok:          true,
    text:        JSON.stringify(structured),
    provider:    result?.provider    || 'edge-scoring',
    model:       result?.model       || 'unknown',
    fallback:    fallbackUsed,
    reviewed,
    edgeScore:   structured.edgeScore,
    verdict:     structured.verdict,
  });
});

module.exports = router;
