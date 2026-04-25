const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const PRICE_MAP = {
  sub: process.env.STRIPE_SUB_PRICE_ID,
  credits_10: process.env.STRIPE_CREDITS_10_PRICE_ID,
  credits_50: process.env.STRIPE_CREDITS_50_PRICE_ID,
};

const CREDITS_MAP = {
  sub: '0',
  credits_10: '10',
  credits_50: '50',
};

router.post('/', async (req, res) => {
  const { plan, userId } = req.body;

  if (!plan || !userId) {
    return res.status(400).json({ error: 'plan and userId are required' });
  }

  const priceId = PRICE_MAP[plan];
  if (!priceId) {
    return res.status(400).json({ error: 'Invalid plan' });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: plan === 'sub' ? 'subscription' : 'payment',
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { userId, plan, credits: CREDITS_MAP[plan] },
      success_url: `${process.env.FRONTEND_URL}?session_id={CHECKOUT_SESSION_ID}&status=success`,
      cancel_url: `${process.env.FRONTEND_URL}?status=cancelled`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

module.exports = router;
