const express = require('express');
const router = express.Router();
const { generateOTP, storeOTP, validateOTP, createSession, verifySession, sendOTPEmail } = require('../lib/auth');
const { getUser } = require('../lib/users');
const { ok, fail } = require('../lib/http');

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
    return fail(res, 400, { text: 'A valid email is required', error: 'Valid email required' });
  }
  try {
    const otp = generateOTP();
    await storeOTP(email, otp);
    await sendOTPEmail(email, otp);
    return ok(res, { text: 'OTP sent' });
  } catch (err) {
    console.error(`[${req.id}] send-otp error:`, err.message);
    return fail(res, 500, { text: 'Could not send code', error: 'Failed to send code — try again.' });
  }
});

router.post('/verify-otp', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const otp = (req.body.otp || '').trim();
  if (!email || !otp) return fail(res, 400, { text: 'Email and OTP required', error: 'email and otp required' });

  const valid = await validateOTP(email, otp);
  if (!valid) return fail(res, 401, { text: 'Invalid or expired code', error: 'Invalid or expired code' });

  await getUser(email);

  const token = createSession(email);
  res.cookie('edge_session', token, COOKIE_OPTS);
  return ok(res, { text: 'Authenticated', data: { email } });
});

router.post('/logout', (_req, res) => {
  res.clearCookie('edge_session', { path: '/' });
  return ok(res, { text: 'Logged out' });
});

router.get('/me', (req, res) => {
  const token = req.cookies?.edge_session;
  const session = token ? verifySession(token) : null;
  return ok(res, { text: 'Session lookup complete', data: { email: session?.email || null } });
});

module.exports = router;
