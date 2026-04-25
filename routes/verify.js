const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

router.post('/', async (req, res) => {
  const { sessionId } = req.body;

  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status !== 'paid') {
      return res.json({ success: false });
    }

    const { plan, credits } = session.metadata;
    res.json({ success: true, plan, credits });
  } catch (err) {
    console.error('Session verification error:', err.message);
    res.status(500).json({ error: 'Failed to verify session' });
  }
});

module.exports = router;
