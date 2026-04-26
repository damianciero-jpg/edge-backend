const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { ok, fail } = require('../lib/http');

router.post('/', async (req, res) => {
  const { sessionId } = req.body;

  if (!sessionId) {
    return fail(res, 400, { text: 'Missing session id', error: 'sessionId is required' });
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status !== 'paid') {
      return ok(res, { text: 'Payment not completed', data: { success: false } });
    }

    const { plan, credits } = session.metadata || {};
    return ok(res, { text: 'Payment verified', data: { success: true, plan, credits } });
  } catch (err) {
    console.error(`[${req.id}] Session verification error:`, err.message);
    return fail(res, 500, { text: 'Failed to verify session', error: 'Session verification failed' });
  }
});

module.exports = router;
