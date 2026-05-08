/**
 * EDGE Pick-of-the-Day Engine
 * 
 * Replaces the naive "pick the favorite" approach with a proper
 * value-betting algorithm:
 *  1. Remove vig to get true market probabilities
 *  2. Compare best available price against true probability
 *  3. Calculate expected value (EV%)
 *  4. Score multi-book consensus and line spread as confidence signal
 *  5. Select the play with highest positive EV, not just highest implied prob
 */

const { getLineMovementSignal } = require('./line-tracker');

const SHARP_BOOK_KEYS = ['pinnacle', 'pinnaclesports'];
const SQUARE_BOOK_KEYS = ['draftkings', 'fanduel', 'betmgm', 'caesars', 'pointsbet', 'williamhill_us', 'betrivers'];

// Get price from Pinnacle specifically
function getPinnaclePrice(game, teamName) {
  for (const bk of game.bookmakers || []) {
    const key = String(bk.key || '').toLowerCase();
    const title = String(bk.title || '').toLowerCase();
    if (!SHARP_BOOK_KEYS.some(s => key.includes(s) || title.includes(s))) continue;
    const h2h = (bk.markets || []).find(m => m.key === 'h2h');
    const outcome = (h2h?.outcomes || []).find(o => o.name === teamName);
    if (outcome?.price != null) return outcome.price;
  }
  return null;
}

// Get best square book price
function getBestSquarePrice(game, teamName) {
  let best = -Infinity;
  for (const bk of game.bookmakers || []) {
    const key = String(bk.key || '').toLowerCase();
    const title = String(bk.title || '').toLowerCase();
    if (!SQUARE_BOOK_KEYS.some(s => key.includes(s) || title.includes(s))) continue;
    const h2h = (bk.markets || []).find(m => m.key === 'h2h');
    const outcome = (h2h?.outcomes || []).find(o => o.name === teamName);
    if (outcome?.price != null && outcome.price > best) best = outcome.price;
  }
  return best === -Infinity ? null : best;
}

const PICK_SPORTS = [
  'americanfootball_nfl',
  'basketball_nba',
  'baseball_mlb',
  'icehockey_nhl',
  'soccer_epl',
  'soccer_usa_mls',
];

function todayUtcKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function secondsUntilMidnightUtc(date = new Date()) {
  const nextMidnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
  return Math.max(60, Math.floor((nextMidnight - date.getTime()) / 1000));
}

// Convert American odds to decimal
function toDecimal(american) {
  const n = Number(american);
  if (!Number.isFinite(n) || n === 0) return null;
  return n > 0 ? n / 100 + 1 : 100 / Math.abs(n) + 1;
}

// Raw implied probability from American odds (includes vig)
function rawImplied(american) {
  const dec = toDecimal(american);
  if (!dec) return null;
  return 1 / dec;
}

// Given two raw implied probs, remove vig to get true market probability
function vigAdjusted(rawA, rawB) {
  const total = rawA + rawB;
  if (!total) return null;
  return rawA / total;
}

// Expected value % given true probability and offered odds
function calcEV(trueProbability, american) {
  const dec = toDecimal(american);
  if (!dec || !trueProbability) return null;
  // EV% = (trueProbability * (dec - 1) - (1 - trueProbability)) * 100
  return ((trueProbability * (dec - 1)) - (1 - trueProbability)) * 100;
}

// Get the best available price for a team across all books
function getBestPrice(game, teamName) {
  let best = -Infinity;
  for (const bk of game.bookmakers || []) {
    const h2h = (bk.markets || []).find(m => m.key === 'h2h');
    const outcome = (h2h?.outcomes || []).find(o => o.name === teamName);
    if (outcome?.price != null && outcome.price > best) best = outcome.price;
  }
  return best === -Infinity ? null : best;
}

// Count how many books have a line for this team
function bookCount(game, teamName) {
  let count = 0;
  for (const bk of game.bookmakers || []) {
    const h2h = (bk.markets || []).find(m => m.key === 'h2h');
    if ((h2h?.outcomes || []).some(o => o.name === teamName && o.price != null)) count++;
  }
  return count;
}

// Calculate line spread (max - min) as a market disagreement signal
function lineSpread(game, teamName) {
  const prices = [];
  for (const bk of game.bookmakers || []) {
    const h2h = (bk.markets || []).find(m => m.key === 'h2h');
    const outcome = (h2h?.outcomes || []).find(o => o.name === teamName);
    if (outcome?.price != null) prices.push(outcome.price);
  }
  if (prices.length < 2) return 0;
  return Math.max(...prices) - Math.min(...prices);
}

// Find the book with the best line (for attribution)
function bestBook(game, teamName) {
  let best = -Infinity;
  let bookName = 'market';
  for (const bk of game.bookmakers || []) {
    const h2h = (bk.markets || []).find(m => m.key === 'h2h');
    const outcome = (h2h?.outcomes || []).find(o => o.name === teamName);
    if (outcome?.price != null && outcome.price > best) {
      best = outcome.price;
      bookName = bk.title || bk.key || 'sportsbook';
    }
  }
  return bookName;
}

// Score a candidate play — higher is better
function scoreCandidate(ev, bookCnt, spread, trueProbability) {
  // EV is the primary signal
  let score = ev * 2;
  // Reward multi-book consensus (more books = more liquid market = more reliable price)
  score += Math.min(bookCnt, 8) * 0.5;
  // Penalize high line spread (disagreement between books = uncertain market)
  score -= Math.min(spread, 20) * 0.3;
  // Slight bonus for plays in the 45–60% true probability range (value zone)
  if (trueProbability >= 0.45 && trueProbability <= 0.60) score += 2;
  return score;
}

function buildPickFromGame(game) {
  const { home_team, away_team } = game;
  const bookmakers = game.bookmakers || [];
  if (bookmakers.length < 1) return null;

  const hBest = getBestPrice(game, home_team);
  const aBest = getBestPrice(game, away_team);
  if (hBest == null || aBest == null) return null;

  // Pinnacle-anchored true probability (sharp-line methodology)
  const hPinn = getPinnaclePrice(game, home_team);
  const aPinn = getPinnaclePrice(game, away_team);

  let hTrue, aTrue;
  if (hPinn != null && aPinn != null) {
    // Gold standard: Pinnacle both sides — vig-remove their lines
    const hRaw = rawImplied(hPinn);
    const aRaw = rawImplied(aPinn);
    hTrue = vigAdjusted(hRaw, aRaw);
    aTrue = vigAdjusted(aRaw, hRaw);
  } else {
    // Fallback: use best available market prices
    const hRaw = rawImplied(hBest);
    const aRaw = rawImplied(aBest);
    hTrue = vigAdjusted(hRaw, aRaw);
    aTrue = vigAdjusted(aRaw, hRaw);
  }

  // EV measured against true probability at best available price
  const hEV = calcEV(hTrue, hBest);
  const aEV = calcEV(aTrue, aBest);

  // Sharp/square spread — Pinnacle vs best square book
  const hSquare = getBestSquarePrice(game, home_team);
  const aSquare = getBestSquarePrice(game, away_team);
  const hSharpSpread = hPinn != null && hSquare != null ? hPinn - hSquare : 0;
  const aSharpSpread = aPinn != null && aSquare != null ? aPinn - aSquare : 0;

  // Book metrics
  const hBooks = bookCount(game, home_team);
  const aBooks = bookCount(game, away_team);
  const hSpread = lineSpread(game, home_team);
  const aSpread = lineSpread(game, away_team);

  // Vig quality
  const vigPct = hPinn && aPinn
    ? (rawImplied(hPinn) + rawImplied(aPinn)) * 100
    : (rawImplied(hBest) + rawImplied(aBest)) * 100;

  const vigBonus = vigPct <= 102 ? 4 : vigPct <= 104 ? 2 : vigPct <= 106 ? 0 : -2;

  const hScore = scoreCandidate(hEV, hBooks, hSpread, hTrue) + hSharpSpread * 0.2 + vigBonus;
  const aScore = scoreCandidate(aEV, aBooks, aSpread, aTrue) + aSharpSpread * 0.2 + vigBonus;

  const useHome = hScore >= aScore;
  const selected = {
    team: useHome ? home_team : away_team,
    price: useHome ? hBest : aBest,
    pinnaclePrice: useHome ? hPinn : aPinn,
    ev: useHome ? hEV : aEV,
    trueProb: useHome ? hTrue : aTrue,
    books: useHome ? hBooks : aBooks,
    spread: useHome ? hSpread : aSpread,
    sharpSpread: useHome ? hSharpSpread : aSharpSpread,
    score: useHome ? hScore : aScore,
    book: bestBook(game, useHome ? home_team : away_team),
    pinnacleUsed: hPinn != null && aPinn != null,
  };

  const opponent = {
    team: useHome ? away_team : home_team,
    ev: useHome ? aEV : hEV,
    trueProb: useHome ? aTrue : hTrue,
  };

  if (selected.ev < -3) return null;

  return { game, selected, opponent, hEV, aEV, bookCount: bookmakers.length, vigPct };
}

function formatOdds(price) {
  const n = Number(price);
  if (!Number.isFinite(n)) return 'N/A';
  return n > 0 ? `+${n}` : `${n}`;
}

function buildPickOutput(candidate, lineMovement = null) {
  const { game, selected, opponent, bookCount: bkCount, vigPct } = candidate;

  const evPct = selected.ev.toFixed(1);
  const trueProb = (selected.trueProb * 100).toFixed(1);
  const impliedProb = (rawImplied(selected.price) * 100).toFixed(1);

  const confidence =
    selected.ev >= 6 && selected.books >= 5 ? 'HIGH' :
    selected.ev >= 2 && selected.books >= 3 ? 'MEDIUM' : 'LOW';

  const risk =
    selected.spread > 15 ? 'HIGH' :
    selected.books < 3 ? 'HIGH' :
    confidence === 'HIGH' ? 'LOW' : 'MEDIUM';

  const lmDirection = lineMovement?.direction || 'UNKNOWN';
  const lmBasisPoints = lineMovement?.basisPoints || 0;

  const reason = [
    selected.pinnacleUsed
      ? `EDGE identified ${selected.team} using Pinnacle sharp-line baseline (vig-removed true probability: ${trueProb}% vs. book implied ${impliedProb}%), generating estimated EV of ${evPct > 0 ? '+' : ''}${evPct}%.`
      : `EDGE identified ${selected.team} using vig-removed market pricing across ${bkCount} sportsbook${bkCount !== 1 ? 's' : ''} (true probability: ${trueProb}% vs. implied ${impliedProb}%, EV: ${evPct > 0 ? '+' : ''}${evPct}%).`,

    selected.sharpSpread > 5
      ? `Pinnacle is offering ${selected.sharpSpread} points more than square books — sharp/square divergence signals value on this side.`
      : selected.sharpSpread < -5
        ? `Square books are longer than Pinnacle by ${Math.abs(selected.sharpSpread)} points — sharp money is fading this side.`
        : null,

    lmDirection === 'STEAM'
      ? `Line has steamed ${lmBasisPoints > 0 ? '+' : ''}${lmBasisPoints} points since open — sharp money agrees with this side.`
      : lmDirection === 'FADE'
        ? `Line has moved ${lmBasisPoints} points against this side since open — monitor for further movement before betting.`
        : null,

    opponent.ev < -2
      ? `Opposing side (${opponent.team}) shows negative EV at ${opponent.ev.toFixed(1)}% — clear directional lean.`
      : `Both sides show competitive pricing; ${selected.team} holds the marginal edge.`,

    vigPct
      ? `Market vig: ${vigPct.toFixed(1)}% (${vigPct <= 102 ? 'Pinnacle-sharp' : vigPct <= 104 ? 'sharp/liquid' : 'square/retail'} market). Best line: ${selected.book}.`
      : `Best available line sourced from ${selected.book}.`,
  ].filter(Boolean).join(' ');

  return {
    date: todayUtcKey(),
    generatedAt: new Date().toISOString(),
    game: `${game.away_team} @ ${game.home_team}`,
    sport: game.sport_title || game.sport_key || 'Sports',
    commenceTime: game.commence_time || null,
    pick: selected.team,
    odds: selected.price,
    pinnacleOdds: selected.pinnaclePrice,
    oddsFormatted: formatOdds(selected.price),
    expectedValue: `${evPct > 0 ? '+' : ''}${evPct}%`,
    trueMarketProbability: `${trueProb}%`,
    impliedProbability: `${impliedProb}%`,
    pinnacleUsed: selected.pinnacleUsed,
    sharpSquareSpread: selected.sharpSpread,
    lineMovementDirection: lmDirection,
    lineMovementPoints: lmBasisPoints,
    marketVig: vigPct ? `${vigPct.toFixed(1)}%` : null,
    booksAgreeing: selected.books,
    totalBooksChecked: bkCount,
    confidence,
    risk,
    reason,
  };
}

async function fetchOddsForSport(sport, apiKey) {
  const url = new URL(`https://api.the-odds-api.com/v4/sports/${sport}/odds/`);
  url.searchParams.set('apiKey', apiKey);
  url.searchParams.set('regions', 'us');
  url.searchParams.set('markets', 'h2h');
  url.searchParams.set('oddsFormat', 'american');
  url.searchParams.set('dateFormat', 'iso');

  const response = await fetch(url.toString());
  if (!response.ok) {
    console.warn(`Pick-of-day odds fetch failed for ${sport}: ${response.status}`);
    return [];
  }
  const games = await response.json();
  return Array.isArray(games) ? games : [];
}

async function generatePickOfTheDay(apiKey) {
  if (!apiKey) throw new Error('Odds API key is not configured.');

  let bestCandidate = null;

  for (const sport of PICK_SPORTS) {
    const games = await fetchOddsForSport(sport, apiKey);
    for (const game of games) {
      const candidate = buildPickFromGame(game);
      if (!candidate) continue;
      if (!bestCandidate || candidate.selected.score > bestCandidate.selected.score) {
        bestCandidate = candidate;
      }
    }
  }

  if (!bestCandidate) throw new Error('No qualifying value play found in today\'s odds.');

  // Fetch line movement for the selected pick (CLV approximation)
  let lineMovement = null;
  try {
    const { selected, game } = bestCandidate;
    const gameId = [selected.team, game.home_team === selected.team ? game.away_team : game.home_team]
      .sort().join('_').toLowerCase().replace(/\s+/g, '_')
      + '_' + new Date().toISOString().slice(0, 10);
    lineMovement = await getLineMovementSignal(gameId, selected.team, selected.price);
  } catch {
    lineMovement = null;
  }

  return buildPickOutput(bestCandidate, lineMovement);
}

module.exports = {
  generatePickOfTheDay,
  PICK_SPORTS,
  todayUtcKey,
  secondsUntilMidnightUtc,
};
