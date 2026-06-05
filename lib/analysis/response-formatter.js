'use strict';
// ─── RESPONSE FORMATTER ───────────────────────────────────────────────────────
// Builds the final structured JSON result from algorithm evaluation + AI text.
// Applies consensus gate, stale line penalty, and research override.

const { applyConsensusGate, conflictReason, parseJsonObject } = require('./consensus-gate');
const { getRecommendedAction } = require('./verdict-engine');

function fallbackReason(oddsDetected, score) {
  if (!oddsDetected) {
    return 'Odds were not detected, so EDGE cannot calculate a reliable value signal.';
  }
  if (score > 5) return 'The calculated EDGE score clears the BET threshold based on the projected probability versus the market price.';
  if (score > 1) return 'The calculated EDGE score shows a modest value signal. Small unit play if line holds.';
  return 'The calculated EDGE score does not show enough value over the implied market probability.';
}

function sideAlignedReason(evaluation) {
  const pick = evaluation.evaluating || evaluation.pick || 'the selected pick';
  if (evaluation.verdict === 'PASS') {
    return `EDGE evaluated ${pick} and does not show enough value over the implied market probability.`;
  }
  if (evaluation.verdict === 'BET') {
    return `EDGE evaluated ${pick} and the calculated score clears the BET threshold based on the projected probability versus the market price.`;
  }
  return `EDGE evaluated ${pick} and found a modest value signal. Consider a small unit play if the line holds.`;
}

function reasonConflictsWithSelectedSide(reason, evaluation) {
  if (!reason || evaluation.verdict === 'PASS') return false;
  const reasonLower = String(reason).toLowerCase();
  const opponent = String(evaluation.opponentTeam || '').toLowerCase();
  const selected = String(evaluation.selectedTeam || '').toLowerCase();

  // Check 1: opponent name appears alongside explicit betting action words
  if (opponent && reasonLower.includes(opponent) && /\b(bet|lean|recommend|pick|play|edge)\b/i.test(reasonLower)) {
    return true;
  }

  // Check 2: positive language about opponent AND negative language about selected team
  if (opponent && selected) {
    const POSITIVE = [/\bstronger\b/, /\badvantage\b/, /\bbetter\b/, /\bfavored\b/, /\bhot\b/, /\bvalue\b/, /\bsuperior\b/];
    const NEGATIVE = [/\bweaker\b/, /\bstruggling\b/, /\bpoor\b/, /\boverpriced\b/, /\bcold\b/, /\bslump\b/, /\bdisadvantage\b/];

    let opponentPositive = false;
    let selectedNegative = false;

    for (const sentence of reasonLower.split(/[.!?,;]+/).filter(Boolean)) {
      if (sentence.includes(opponent) && POSITIVE.some(p => p.test(sentence))) opponentPositive = true;
      if (sentence.includes(selected) && NEGATIVE.some(p => p.test(sentence))) selectedNegative = true;
    }

    if (opponentPositive && selectedNegative) return true;
  }

  return false;
}

function fallbackTopFactors(evaluation) {
  const factors = [
    `Market implied probability: ${percent(evaluation.impliedProb)}`,
    `Sharp-line true probability: ${percent(evaluation.projectedProb)}`,
    `Score threshold result: ${evaluation.verdict}`,
  ];
  if (evaluation.pinnacleUsed) factors.push('Pinnacle sharp-line baseline used for vig removal');
  if (evaluation.vigPct) factors.push(`Market vig: ${evaluation.vigPct.toFixed(1)}% (${evaluation.vigPct <= 104 ? 'sharp/liquid' : 'square/retail'})`);
  if (evaluation.lineMovement && evaluation.lineMovement !== 0) {
    factors.push(`Line movement: ${evaluation.lineMovement > 0 ? 'STEAM (sharp money agrees)' : 'FADE (sharp money opposing)'}`);
  }
  return factors.slice(0, 4);
}

function normalizeTopFactors(value, evaluation) {
  if (Array.isArray(value)) return value.slice(0, 4).map(item => String(item));
  if (value) return [String(value)];
  return fallbackTopFactors(evaluation);
}

function buildEdgeEvaluation(prompt, context = {}, lineMovementScore = 0) {
  const selectedSide = String(context.selectedSide || '').toLowerCase();
  const teams = extractGameTeams(prompt);
  const contextOdds = context.odds;
  const oddsObj = contextOdds && typeof contextOdds === 'object' ? contextOdds : null;

  // Always evaluate both sides when selectedSide is 'best', then return the higher-scoring pick.
  // Must come before the selectedTeam check — live odds set selectedTeam=homeTeam but still
  // want a dual comparison.
  if (selectedSide === 'best') {
    const homeTeam = String(context.selectedTeam || (teams && teams.home) || '').trim();
    const awayTeam = String(context.opponentTeam || (teams && teams.away) || '').trim();

    const candidates = [
      {
        side: 'home',
        team: homeTeam,
        opponent: awayTeam,
        market: context.market || 'h2h',
        odds: oddsObj ? oddsObj.home : null,
        opponentOdds: oddsObj ? oddsObj.away : null,
      },
      {
        side: 'away',
        team: awayTeam,
        opponent: homeTeam,
        market: context.market || 'h2h',
        odds: oddsObj ? oddsObj.away : null,
        opponentOdds: oddsObj ? oddsObj.home : null,
      },
    ]
      .filter(c => c.team && c.odds != null)
      .map(c => buildCandidateEvaluation(prompt, c, lineMovementScore));

    if (candidates.length) {
      return candidates.sort((a, b) => b.edgeScore - a.edgeScore)[0];
    }
  }

  // Specific side explicitly requested
  if (context.selectedTeam) {
    const side = selectedSide === 'away' || selectedSide === 'home' ? selectedSide : 'selected';
    return buildCandidateEvaluation(prompt, {
      side,
      team: String(context.selectedTeam).trim(),
      opponent: String(context.opponentTeam || '').trim(),
      market: context.market || 'h2h',
      odds: oddsObj ? oddsObj[selectedSide] || contextOdds : contextOdds,
      opponentOdds: oddsObj
        ? (selectedSide === 'away' ? oddsObj.home : oddsObj.away)
        : null,
    }, lineMovementScore);
  }

  // Fallback: extract odds from prompt text
  const odds = extractAmericanOdds(prompt);
  const fallback = buildCandidateEvaluation(prompt, {
    side: 'best',
    team: '',
    opponent: '',
    market: context.market || 'h2h',
    odds,
  });
  fallback.pick = fallback.verdict === 'PASS' ? passPick() : pickFromPrompt(prompt, fallback);
  fallback.evaluating = fallback.pick;
  return fallback;
}


// ─── MULTI-CANDIDATE AI PROMPT ────────────────────────────────────────────────
// Used when all algorithmic candidates score negative (public money distortion).
// Instead of forcing the AI to evaluate one pre-selected side, present all
// candidates and ask the AI to independently identify the best play.

function buildMultiCandidatePrompt(basePrompt, pairs) {
  const candidateLines = pairs.map((p, i) => {
    const c = p.candidate;
    const ev = p.eval;
    return [
      `Candidate ${i + 1}: ${c.label}`,
      `  Market: ${c.market} | Odds: ${c.odds > 0 ? '+' : ''}${c.odds}`,
      `  Implied prob: ${(ev.impliedProb * 100).toFixed(1)}% | Algo true prob: ${(ev.projectedProb * 100).toFixed(1)}%`,
      `  Algo edge score: ${ev.edgeScore.toFixed(2)} (negative = algorithm sees no price edge)`,
    ].join('\n');
  }).join('\n\n');

  return [
    basePrompt,
    '',
    '─── ALL AVAILABLE PLAYS (algorithm found no clear price edge on any) ───',
    candidateLines,
    '',
    'INSTRUCTION FOR RESEARCH MODE:',
    'The price-gap algorithm found no clear edge. This often happens when public',
    'money has distorted lines away from true value (e.g. 80%+ public tickets',
    'on one side moves the line regardless of actual probability).',
    '',
    'Using your web search capability, research this game thoroughly:',
    '- Key injuries on either side (starting pitcher, lineup changes)',
    '- Sharp money / reverse line movement signals',
    '- Recent form, head-to-head, ballpark factors',
    '- Any contextual factors the price-gap algorithm cannot see',
    '',
    'Then identify the single best play from the candidates above, or PASS if',
    'none have genuine value after research.',
    '',
    'Return this JSON shape only (no markdown, no preamble):',
    '{"aiVerdict":"BET|LEAN|PASS","bestCandidate":"exact label from candidates above or PASS","reason":"2-3 sentences citing specific evidence","topFactors":["factor 1","factor 2","factor 3"]}',
  ].filter(Boolean).join('\n');
}

function buildScoredPrompt(prompt, evaluation) {
  const methodologyNotes = [
    evaluation.pinnacleUsed
      ? 'Pinnacle sharp-line baseline used for vig-removed true probability.'
      : 'Vig-removed probability from best available two-sided market.',
    evaluation.vigPct
      ? `Market vig: ${evaluation.vigPct.toFixed(1)}% (${evaluation.vigPct <= 104 ? 'sharp/liquid market' : 'square/retail market'}).`
      : null,
    evaluation.sharpSpread && evaluation.sharpSpread > 0
      ? `Sharp/square spread: +${evaluation.sharpSpread} (Pinnacle offering more value than square books — bullish signal).`
      : evaluation.sharpSpread && evaluation.sharpSpread < 0
        ? `Sharp/square spread: ${evaluation.sharpSpread} (square books offering more — sharp fade signal).`
        : null,
    evaluation.lineMovement && evaluation.lineMovement > 0
      ? `Line movement: STEAM — line moved in our favor since open (sharp money agrees).`
      : evaluation.lineMovement && evaluation.lineMovement < 0
        ? `Line movement: FADE — line moved against us since open (sharp money opposing).`
        : null,
  ].filter(Boolean).join(' ');

  return [
    'Game / bet prompt:',
    prompt,
    '',
    'EDGE Algorithm Values (Pinnacle-anchored sharp-line methodology):',
    `- Implied Probability (offered price): ${percent(evaluation.impliedProb)}`,
    `- True Market Probability (vig-removed): ${percent(evaluation.projectedProb)}`,
    `- Edge Score: ${evaluation.edgeScore}`,
    `- Verdict: ${evaluation.verdict}`,
    `- Selected Pick: ${evaluation.evaluating || evaluation.pick}`,
    `- Selected Team: ${evaluation.selectedTeam || 'Best available edge'}`,
    `- Opponent: ${evaluation.opponentTeam || 'Compare both sides'}`,
    `- Market: ${evaluation.market || 'h2h'}`,
    `- Confidence: ${evaluation.confidence}`,
    `- Risk: ${evaluation.risk}`,
    `- Edge Strength: ${evaluation.edgeStrength}`,
    methodologyNotes ? `- Methodology: ${methodologyNotes}` : null,
    '',
    'Instruction:',
    'You are an expert sports betting analyst using the Pinnacle sharp-line methodology.',
    'Review the algorithm values AND the live odds/team stats data above.',
    'Form your OWN independent verdict: BET, LEAN, or PASS.',
    '- BET: you agree there is genuine value and the pick is sound',
    '- LEAN: modest value but some concern, small unit only',
    '- PASS: the data does not support this pick regardless of the price gap',
    'Reference the true probability vs implied probability gap as the core value signal.',
    'If team stats show a struggling offense, injured star, or bad road record, factor that in.',
    'If line movement data is available, reference whether sharp money agrees or disagrees.',
    'Return strict JSON only. No markdown, no preamble.',
    '',
    'Return this JSON shape only:',
    '{"aiVerdict":"BET|LEAN|PASS","reason":"2-3 sentence explanation referencing value gap, team context, and key signals","topFactors":["factor 1","factor 2","factor 3"]}',
  ].filter(Boolean).join('\n');
}


function buildStructuredResult(evaluation, aiText) {
  const parsed = parseJsonObject(aiText) || {};
  const parsedReason = parsed.reason || parsed.reasoning;
  const aiVerdict = String(parsed.aiVerdict || '').toUpperCase();

  // Apply consensus gate — only BET when algorithm and AI agree
  const { verdict: consensusVerdict, conflicted, researchOverride } = applyConsensusGate(evaluation.verdict, aiVerdict, evaluation.edgeScore, evaluation.mode);

  // If conflicted, override reason with conflict explanation
  const rawReason = conflicted
    ? conflictReason(evaluation, aiVerdict)
    : reasonConflictsWithSelectedSide(parsedReason, evaluation)
      ? sideAlignedReason(evaluation)
      : parsedReason || sideAlignedReason(evaluation) || fallbackReason(evaluation.oddsDetected, evaluation.edgeScore);

  // Downgrade confidence and pick if verdict changed by consensus gate
  const finalVerdict = consensusVerdict;
  const finalPick = finalVerdict === 'PASS' ? 'PASS — signals conflict' : evaluation.pick;
  const researchNote = researchOverride ? ' (Research Mode override — AI found context algorithm missed)' : '';
  const finalConfidence = conflicted ? 'LOW'
    : finalVerdict === 'BET' ? evaluation.confidence
    : finalVerdict === 'LEAN' && evaluation.confidence === 'HIGH' ? 'MEDIUM'
    : evaluation.confidence;
  const finalRecommendedAction = conflicted
    ? 'Pass — algorithm and AI signals are in conflict. Wait for alignment.'
    : researchOverride
      ? 'Research Mode found context the algorithm missed (injuries/sharp money). Small unit only — verify line is still available.'
      : getRecommendedAction(finalVerdict, finalConfidence);

  const reason = rawReason;

  return {
    verdict: finalVerdict,
    pick: finalPick,
    aiVerdict: aiVerdict || null,
    algoVerdict: evaluation.verdict,
    consensusConflict: conflicted,
    evaluating: evaluation.evaluating || evaluation.pick,
    selectedSide: evaluation.selectedSide,
    selectedTeam: evaluation.selectedTeam,
    opponentTeam: evaluation.opponentTeam,
    market: evaluation.market,
    confidence: finalConfidence,
    risk: conflicted ? 'HIGH' : evaluation.risk,
    edgeStrength: evaluation.edgeStrength,
    edgeScore: evaluation.edgeScore,
    odds: evaluation.odds,
    // Phase 1 fields
    consensusProb: evaluation.consensusProb,
    noVigProb: evaluation.noVigProb,
    priceEdge: evaluation.priceEdge,
    impliedProb: evaluation.impliedProb,
    projectedProb: evaluation.projectedProb,
    marketBreadth: evaluation.marketBreadth,
    confidencePenalty: evaluation.confidencePenalty,
    injurySignal: evaluation.injurySignal,
    situationalSignal: evaluation.situationalSignal,
    teamFormSignal: evaluation.teamFormSignal || 0,
    // Phase 2 field (populated by caller)
    lineMovementSignal: evaluation.lineMovementSignal,
    reason,
    topFactors: normalizeTopFactors(parsed.topFactors || parsed.key_factors || parsed.keyFactors, evaluation),
    recommendedAction: finalRecommendedAction,
  };
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

function percent(value) {
  return `${roundNumber(value * 100, 1)}%`;
}

function passPick() {
  return 'PASS — no clear edge';
}

module.exports = { buildStructuredResult };
