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

    const upstream = await fetch(url.toString());
    if (!upstream.ok) {
      const body = await upstream.json().catch(() => ({}));
      console.warn(`Odds API error for ${sport}: ${upstream.status}`, body);
      return res.status(upstream.status).json({ error: body.message || 'Odds API request failed.' });
    }

    const games = await upstream.json();
    return res.json(Array.isArray(games) ? games : []);
  } catch (err) {
    console.error('Odds proxy error:', err?.stack || err);
    return res.status(500).json({ error: 'Could not fetch odds right now.' });
  }
});

module.exports = router;
