const express = require('express');
const router = express.Router();
const { getCfg } = require('../lib/config');

const CREDITS_MAP = { sub: '0', credits_10: '10', credits_50: '50' };

router.post('/', async (req, res) => {
  const { plan, userId } = req.body;
  if (!plan || !userId) return res.status(400).json({ error: 'plan and userId are required' });

  const [stripeKey, subPrice, credits10Price, credits50Price, frontendUrl] = await Promise.all([
    getCfg('stripeSecretKey', 'STRIPE_SECRET_KEY'),
    getCfg('stripeSubPriceId', 'STRIPE_SUB_PRICE_ID'),
    getCfg('stripeCredits10PriceId', 'STRIPE_CREDITS_10_PRICE_ID'),
    getCfg('stripeCredits50PriceId', 'STRIPE_CREDITS_50_PRICE_ID'),
    getCfg('frontendUrl', 'FRONTEND_URL', 'https://edge-backend-rho.vercel.app'),
  ]);

  if (!stripeKey) return res.status(503).json({ error: 'Stripe not configured. Add keys in admin → Setup.' });

  const PRICE_MAP = { sub: subPrice, credits_10: credits10Price, credits_50: credits50Price };
  const priceId = PRICE_MAP[plan];
  if (!priceId) return res.status(400).json({ error: `Price ID not configured for plan "${plan}". Add it in admin → Setup.` });

  try {
    const stripe = require('stripe')(stripeKey);
    const session = await stripe.checkout.sessions.create({
      mode: plan === 'sub' ? 'subscription' : 'payment',
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { userId, plan, credits: CREDITS_MAP[plan] },
      success_url: `${frontendUrl}?session_id={CHECKOUT_SESSION_ID}&status=success`,
      cancel_url: `${frontendUrl}?status=cancelled`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
