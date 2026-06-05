'use strict';
const { percent, roundNumber } = require('./verdict-engine');
// ─── PROMPT BUILDER ───────────────────────────────────────────────────────────
// Constructs prompts sent to the AI.
// buildScoredPrompt: single-candidate evaluation with algorithm context.
// buildMultiCandidatePrompt: all-negative candidates mode — AI picks best side.

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


module.exports = { buildScoredPrompt, buildMultiCandidatePrompt };
