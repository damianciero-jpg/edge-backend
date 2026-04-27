require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const { verifySession } = require('./lib/auth');
const { getUser } = require('./lib/users');
const { getCfg } = require('./lib/config');
const { hasRedisConfig, createRedis } = require('./lib/redis');

const checkoutRouter = require('./routes/checkout');
const webhookRouter = require('./routes/webhook');
const statusRouter = require('./routes/status');
const verifyRouter = require('./routes/verify');
const analyzeRouter = require('./routes/analyze');
const adminRouter = require('./routes/admin');
const authRouter = require('./routes/auth');
const alertsRouter = require('./routes/alerts');

const app = express();
const OWNER_EMAILS = [
  'damianciero@gmail.com',
  'ffanning@comcast.net',
  'afelt1991@yahoo.com',
];
const DEFAULT_ODDS_API_KEY = 'e37bbddd4d0947ae8c39052cf8d75b61';
const PICK_SPORTS = [
  'americanfootball_nfl',
  'basketball_nba',
  'baseball_mlb',
  'icehockey_nhl',
  'soccer_epl',
  'soccer_usa_mls',
];

process.on('uncaughtException', err => {
  console.error('Uncaught exception:', err && err.stack ? err.stack : err);
});

process.on('unhandledRejection', err => {
  console.error('Unhandled rejection:', err && err.stack ? err.stack : err);
});

const allowedOrigins = [
  process.env.FRONTEND_URL,
  process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null,
  'http://localhost:3000',
  'http://localhost:5173',
].filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`CORS blocked origin: ${origin}`));
  },
  credentials: true,
}));

app.use('/api/webhook', express.raw({ type: 'application/json' }), webhookRouter);

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

app.use('/api/auth', authRouter);
app.use('/api/create-checkout-session', checkoutRouter);
app.use('/api/user-status', statusRouter);
app.use('/api/verify-session', verifyRouter);
app.use('/api/analyze', analyzeRouter);
app.use('/api/alerts', alertsRouter);

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

function todayUtcKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function secondsUntilMidnightUtc(date = new Date()) {
  const nextMidnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
  return Math.max(60, Math.floor((nextMidnight - date.getTime()) / 1000));
}

function impliedProbability(price) {
  const odds = Number(price);
  if (!Number.isFinite(odds) || odds === 0) return null;
  return odds < 0 ? (-odds / (-odds + 100)) * 100 : (100 / (odds + 100)) * 100;
}

function findMoneyline(game) {
  for (const bookmaker of game.bookmakers || []) {
    const market = (bookmaker.markets || []).find(item => item.key === 'h2h');
    const outcomes = market?.outcomes || [];
    if (outcomes.length < 2) continue;

    const home = outcomes.find(outcome => outcome.name === game.home_team) || outcomes[0];
    const away = outcomes.find(outcome => outcome.name === game.away_team) || outcomes[1];
    if (home?.price != null && away?.price != null) {
      return { bookmaker: bookmaker.title || bookmaker.key || 'sportsbook', home, away };
    }
  }
  return null;
}

function buildPick(game, moneyline) {
  const candidates = [moneyline.home, moneyline.away]
    .map(outcome => ({
      name: outcome.name,
      price: outcome.price,
      probability: impliedProbability(outcome.price),
    }))
    .filter(outcome => outcome.probability != null);

  const selected = candidates.sort((a, b) => b.probability - a.probability)[0];
  if (!selected) throw new Error('No usable moneyline outcomes found.');

  const confidence = selected.probability >= 60 ? 'HIGH' : selected.probability >= 54 ? 'MEDIUM' : 'LOW';
  const risk = selected.probability >= 60 ? 'LOW' : selected.probability >= 54 ? 'MEDIUM' : 'HIGH';

  return {
    date: todayUtcKey(),
    generatedAt: new Date().toISOString(),
    game: `${game.away_team} @ ${game.home_team}`,
    sport: game.sport_title || game.sport_key || 'Sports',
    commenceTime: game.commence_time || null,
    pick: selected.name,
    odds: selected.price,
    confidence,
    risk,
    reason: `EDGE selected the strongest available moneyline side from ${moneyline.bookmaker} for the first available game with complete odds.`,
  };
}

async function fetchOddsForSport(sport, apiKey) {
  const url = new URL(`https://api.the-odds-api.com/v4/sports/${sport}/odds/`);
  url.searchParams.set('apiKey', apiKey);
  url.searchParams.set('regions', 'us');
  url.searchParams.set('markets', 'h2h');
  url.searchParams.set('oddsFormat', 'american');
  url.searchParams.set('dateFormat', 'iso');

  const response = await fetch(url);
  if (!response.ok) {
    console.warn(`Pick of the day odds fetch failed for ${sport}: ${response.status}`);
    return [];
  }

  const games = await response.json();
  return Array.isArray(games) ? games : [];
}

async function generatePickOfTheDay() {
  const apiKey = await getCfg('oddsApiKey', 'ODDS_API_KEY', process.env.THE_ODDS_API_KEY || process.env.ODDS_KEY || DEFAULT_ODDS_API_KEY);
  if (!apiKey) throw new Error('Odds API key is not configured.');

  for (const sport of PICK_SPORTS) {
    const games = await fetchOddsForSport(sport, apiKey);
    for (const game of games) {
      const moneyline = findMoneyline(game);
      if (moneyline) return buildPick(game, moneyline);
    }
  }

  throw new Error('No moneyline odds are available right now.');
}

app.get('/api/pick-of-the-day', async (req, res) => {
  try {
    const session = verifySession(req.cookies?.edge_session);
    const userId = String(session?.email || '').toLowerCase();
    const isOwner = OWNER_EMAILS.includes(userId);

    if (!userId) return res.json({ paywall: true });

    let hasAccess = isOwner;
    if (!hasAccess) {
      const user = await getUser(userId);
      hasAccess = !!user?.isSubscriber;
    }

    if (!hasAccess) return res.json({ paywall: true });

    const cacheKey = `edge:pick:${todayUtcKey()}`;
    let redis;
    if (hasRedisConfig()) {
      redis = createRedis();
      const cached = await redis.get(cacheKey);
      if (cached) return res.json({ pick: typeof cached === 'string' ? JSON.parse(cached) : cached });
    }

    const pick = await generatePickOfTheDay();
    if (redis) {
      await redis.set(cacheKey, pick, { ex: secondsUntilMidnightUtc() });
    }

    return res.json({ pick });
  } catch (err) {
    console.error('Pick of the day error:', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Could not load Pick of the Day right now.' });
  }
});

app.use('/api/admin', adminRouter);

app.get('/', (_req, res, next) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  fs.readFile(indexPath, 'utf8', (err, html) => {
    if (err) return next(err);

    const version = process.env.VERCEL_GIT_COMMIT_SHA || Date.now();
    const upgradeScript = `<script defer src="/home-upgrades.js?v=${version}"></script>`;
    const upgradedHtml = html
      .replace(/<script[^>]+src=["']\/home-upgrades\.js[^>]*><\/script>\s*/g, '')
      .replace('</body>', `${upgradeScript}\n</body>`);

    res.set('Cache-Control', 'no-store');
    res.type('html').send(upgradedHtml);
  });
});

app.use(express.static(path.join(__dirname, 'public')));

app.use((err, _req, res, _next) => {
  console.error('Server error:', err.message);
  res.status(err.status || 500).json({ ok:false, error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`EDGE backend running on port ${PORT}`));
}

module.exports = app;
