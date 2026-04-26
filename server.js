require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');

const checkoutRouter = require('./routes/checkout');
const webhookRouter = require('./routes/webhook');
const statusRouter = require('./routes/status');
const verifyRouter = require('./routes/verify');
const analyzeRouter = require('./routes/analyze');
const adminRouter = require('./routes/admin');
const authRouter = require('./routes/auth');
const alertsRouter = require('./routes/alerts');

const app = express();

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
