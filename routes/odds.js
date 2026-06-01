const express = require('express');
const router = express.Router();
const { getCfg } = require('../lib/config');

const DEFAULT_ODDS_API_KEY = process.env.THE_ODDS_API_KEY || process.env.ODDS_KEY;

const ALLOWED_SPORTS = new Set([
  'americanfootball_nfl',
  'basketball_nba',
  'baseball_mlb',
  'icehockey_nhl',
  'soccer_epl',
  'soccer_usa_mls',
  'mma_mixed_martial_arts',
  'golf_pga_tour',
]);

router.get('/', async (req, res) => {
  const sport = req.query.sport;

  if (!sport || !ALLOWED_SPORTS.has(sport)) {
    return res.status(400).json({ error: 'Invalid or missing sport parameter.' });
  }

  try {
    const apiKey = await getCfg('oddsApiKey', 'ODDS_API_KEY', DEFAULT_ODDS_API_KEY);
    if (!apiKey) {
      return res.status(503).json({ error: 'Odds API key is not configured.' });
    }

    const url = new URL(`https://api.the-odds-api.com/v4/sports/${sport}/odds/`);
    url.searchParams.set('apiKey', apiKey);
    url.searchParams.set('regions', 'us');
    url.searchParams.set('markets', 'h2h,spreads,totals');
    url.searchParams.set('oddsFormat', 'american');
    url.searchParams.set('dateFormat', 'iso');

    const keyPrefix = apiKey.slice(0, 8);
    console.log('[Odds] Fetching sport key:', sport);
    const upstream = await fetch(url.toString());
    const status   = upstream.status;
    const rawText  = await upstream.text();

    const creditsRemaining = upstream.headers.get('x-requests-remaining');
    const creditsUsed      = upstream.headers.get('x-requests-used');

    if (!upstream.ok) {
      console.warn(`[Odds] Key prefix: ${keyPrefix}, events returned: 0, status: ${status}`);
      console.warn('[Odds] Raw error body:', rawText.slice(0, 300));
      if (creditsRemaining !== null) console.log('[Odds] Credits remaining:', creditsRemaining, 'used:', creditsUsed);
      if (status === 401 || status === 403) return res.json([]);
      return res.status(status).json({ error: JSON.parse(rawText).message || 'Odds API request failed.' });
    }

    let games;
    try { games = JSON.parse(rawText); } catch { games = []; }
    const count = Array.isArray(games) ? games.length : 0;
    console.log(`[Odds] Key prefix: ${keyPrefix}, events returned: ${count}, status: ${status}`);
    if (creditsRemaining !== null) console.log('[Odds] Credits remaining:', creditsRemaining, 'used:', creditsUsed);
    if (count === 0) console.warn('[Odds] Zero games returned — raw response:', rawText.slice(0, 300));
    return res.json(Array.isArray(games) ? games : []);
  } catch (err) {
    console.error('Odds proxy error:', err?.stack || err);
    return res.status(500).json({ error: 'Could not fetch odds right now.' });
  }
});

module.exports = router;
