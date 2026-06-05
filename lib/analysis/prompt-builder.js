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


// ─── SERVER-SIDE GAME PROMPT ──────────────────────────────────────────────────
// Builds the analysis prompt entirely server-side from a game object + mode.
// Replaces the frontend-constructed prompt — no more prompt drift or injection.

function buildGamePrompt(game, mode, selection) {
  const homeTeam = game.home_team;
  const awayTeam = game.away_team;
  const isBestMode = !selection || selection.side === 'best';

  // Extract best available odds from bookmakers
  let hBest = null, aBest = null;
  let oddsCtx = '';
  for (const bk of (game.bookmakers || []).slice(0, 5)) {
    const h2h = (bk.markets || []).find(m => m.key === 'h2h');
    if (!h2h) continue;
    const hOut = h2h.outcomes.find(o => o.name === homeTeam);
    const aOut = h2h.outcomes.find(o => o.name === awayTeam);
    if (hOut?.price && (!hBest || hOut.price > hBest)) hBest = hOut.price;
    if (aOut?.price && (!aBest || aOut.price > aBest)) aBest = aOut.price;
    const hFmt = hOut?.price ? (hOut.price > 0 ? `+${hOut.price}` : String(hOut.price)) : 'N/A';
    const aFmt = aOut?.price ? (aOut.price > 0 ? `+${aOut.price}` : String(aOut.price)) : 'N/A';
    oddsCtx += `${bk.title}: ${awayTeam} ${aFmt} / ${homeTeam} ${hFmt}\n`;
  }

  const toImplied = odds => {
    const n = Number(odds);
    if (!Number.isFinite(n) || n === 0) return 'N/A';
    const p = n > 0 ? 100 / (n + 100) : Math.abs(n) / (Math.abs(n) + 100);
    return (p * 100).toFixed(1);
  };

  const hFmt = hBest ? (hBest > 0 ? `+${hBest}` : String(hBest)) : 'N/A';
  const aFmt = aBest ? (aBest > 0 ? `+${aBest}` : String(aBest)) : 'N/A';

  const selectedTeam  = selection?.team  || (isBestMode ? null : homeTeam);
  const opponentTeam  = selection?.opponent || (isBestMode ? null : awayTeam);
  const selectedLabel = selection?.label || (isBestMode ? 'Best Available Edge' : `${homeTeam} ML`);
  const market        = selection?.market || 'h2h';

  return [
    'You are an expert sports betting analyst. Analyze this upcoming game for expected value.',
    '',
    `GAME: ${awayTeam} @ ${homeTeam}`,
    `GAME ID: ${game.id || ''}`,
    `DATE: ${new Date(game.commence_time).toDateString()}`,
    `SPORT: ${game.sport_title || game.sport_key}`,
    `ANALYSIS MODE: ${isBestMode ? 'FIND BEST EDGE — evaluate both sides independently' : 'SINGLE SIDE — evaluate selected pick only'}`,
    `SELECTED PICK: ${selectedLabel}`,
    `SELECTED SIDE: ${isBestMode ? 'best' : (selection?.side || 'home')}`,
    `SELECTED TEAM: ${isBestMode ? `${awayTeam} (away) OR ${homeTeam} (home) — find best edge` : selectedTeam}`,
    `OPPONENT: ${isBestMode ? 'Both sides being evaluated' : opponentTeam}`,
    `MARKET: ${market}`,
    '',
    'TEAMS AND BEST AVAILABLE ODDS:',
    `- ${awayTeam} (AWAY): ${aFmt} (implied: ${toImplied(aBest)}%)`,
    `- ${homeTeam} (HOME): ${hFmt} (implied: ${toImplied(hBest)}%)`,
    '',
    'ALL BOOKS ODDS:',
    oddsCtx.trim(),
    '',
    'INSTRUCTIONS:',
    '1. Use web_search to find: recent form (last 5 games), key injuries, starting pitchers/starters, head-to-head, home/away splits, and any sharp money signals for BOTH teams.',
    '2. Estimate the TRUE win probability for EACH team based on your research.',
    '3. Calculate EV for both sides: EV = (true_prob × decimal_odds) - 1',
    isBestMode
      ? '4. Identify the SINGLE BEST play across both sides, or PASS if neither has edge.'
      : '4. Give a clear BET/PASS/LEAN recommendation for the selected side.',
    '5. Your verdict must reflect the actual best value — do not default to the home team or favorite.',
  ].join('\n');
}


module.exports = { buildScoredPrompt, buildMultiCandidatePrompt, buildGamePrompt };
