const express = require('express');
const router = express.Router();
const { generateOTP, storeOTP, validateOTP, createSession, verifySession, sendOTPEmail } = require('../lib/auth');
const { getUser } = require('../lib/users');

const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV !== 'development',
  sameSite: 'lax',
  path: '/',
  maxAge: 30 * 24 * 60 * 60 * 1000,
};

router.post('/send-otp', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  if (!email || !email.includes('@') || !email.includes('.')) {
    return res.status(400).json({ error: 'Valid email required' });
  }
  try {
    const otp = generateOTP();
    await storeOTP(email, otp);
    await sendOTPEmail(email, otp);
    res.json({ ok: true });
  } catch (err) {
    console.error('send-otp error:', err.message);
    res.status(500).json({ error: 'Failed to send code — try again.' });
  }
});

router.post('/verify-otp', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const otp = (req.body.otp || '').trim();
  if (!email || !otp) return res.status(400).json({ error: 'email and otp required' });

  const valid = await validateOTP(email, otp);
  if (!valid) return res.status(401).json({ error: 'Invalid or expired code' });

  await getUser(email); // create user record if first login (2 free credits)

  const token = createSession(email);
  res.cookie('edge_session', token, COOKIE_OPTS);
  res.json({ ok: true, email });
});

router.post('/logout', (_req, res) => {
  res.clearCookie('edge_session', { path: '/' });
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  const token = req.cookies?.edge_session;
  const session = token ? verifySession(token) : null;
  res.json({ email: session?.email || null });
});

module.exports = router;
