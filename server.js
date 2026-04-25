require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');
const { ok, fail } = require('./lib/http');

const checkoutRouter = require('./routes/checkout');
const webhookRouter = require('./routes/webhook');
const statusRouter = require('./routes/status');
const verifyRouter = require('./routes/verify');
const analyzeRouter = require('./routes/analyze');
const adminRouter = require('./routes/admin');
const authRouter = require('./routes/auth');

const app = express();

function createCorsOptions() {
  const origins = [
    process.env.FRONTEND_URL,
    process.env.FRONTEND_URL_ALT,
    'http://localhost:3000',
    'http://localhost:3001',
  ].filter(Boolean);

  return {
    credentials: true,
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (origins.includes(origin)) return cb(null, true);
      return cb(new Error('Origin not allowed by CORS'));
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  };
}

app.set('trust proxy', true);
app.use((req, _res, next) => {
  req.id = req.headers['x-request-id'] || crypto.randomUUID();
  req.startedAt = Date.now();
  next();
});

app.use(cors(createCorsOptions()));
app.options('*', cors(createCorsOptions()));

// Webhook route must use raw body before any JSON middleware
app.use('/api/webhook', express.raw({ type: 'application/json' }), webhookRouter);

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

app.use('/api/auth', authRouter);
app.use('/api/create-checkout-session', checkoutRouter);
app.use('/api/user-status', statusRouter);
app.use('/api/verify-session', verifyRouter);
app.use('/api/analyze', analyzeRouter);
app.use('/api/admin', adminRouter);

app.get('/api/health', (req, res) => ok(res, { text: 'healthy', meta: { uptimeSec: Math.round(process.uptime()) }, data: { status: 'ok' } }));

app.use(express.static(path.join(__dirname, 'public')));

app.use((err, req, res, _next) => {
  const isCors = err?.message && err.message.includes('CORS');
  const status = isCors ? 403 : 500;
  console.error(`[${req.id}] ${req.method} ${req.originalUrl} failed:`, err.message);
  return fail(res, status, {
    text: 'Request could not be completed',
    error: isCors ? 'CORS blocked this origin' : 'Internal server error',
  });
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`EDGE backend running on port ${PORT}`));
}

module.exports = app;
