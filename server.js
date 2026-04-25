require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');

const checkoutRouter = require('./routes/checkout');
const webhookRouter = require('./routes/webhook');
const statusRouter = require('./routes/status');
const verifyRouter = require('./routes/verify');
const analyzeRouter = require('./routes/analyze');
const adminRouter = require('./routes/admin');
const authRouter = require('./routes/auth');

const app = express();

app.use(cors({ origin: process.env.FRONTEND_URL, credentials: true }));

// Webhook route must use raw body before any JSON middleware
app.use('/api/webhook', express.raw({ type: 'application/json' }), webhookRouter);

app.use(express.json());
app.use(cookieParser());

app.use('/api/auth', authRouter);
app.use('/api/create-checkout-session', checkoutRouter);
app.use('/api/user-status', statusRouter);
app.use('/api/verify-session', verifyRouter);
app.use('/api/analyze', analyzeRouter);

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
app.use('/api/admin', adminRouter);

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`EDGE backend running on port ${PORT}`));

module.exports = app;
