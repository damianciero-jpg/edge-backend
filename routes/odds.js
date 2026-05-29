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

    const upstreamUrl = url.toString().replace(apiKey, '[KEY]');
    console.log(`[Odds] fetching sportKey="${sport}" url=${upstreamUrl}`);
    const upstream = await fetch(url.toString());
    if (!upstream.ok) {
      const body = await upstream.json().catch(() => ({}));
      console.warn(`[Odds] sportKey="${sport}" HTTP ${upstream.status} — url=${upstreamUrl}`, body);
      // 401/403 means the key doesn't cover this sport or has expired.
      // Return empty array so the frontend shows "NO UPCOMING GAMES" instead of an error page.
      if (upstream.status === 401 || upstream.status === 403) {
        return res.json([]);
      }
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
