const express = require('express');
const router = express.Router();
const { getCfg } = require('../lib/config');
const { verifySession } = require('../lib/auth');
const { ok, fail } = require('../lib/http');

const CREDITS_MAP = { sub: '0', credits_10: '10', credits_50: '50' };

router.post('/', async (req, res) => {
  const { plan } = req.body;
  const session = verifySession(req.cookies?.edge_session);
  const userId = session?.email;
  if (!plan || !userId) {
    return fail(res, 400, { text: 'Plan and login are required', error: 'plan required and must be logged in' });
  }

  const [stripeKey, subPrice, credits10Price, credits50Price, frontendUrl] = await Promise.all([
    getCfg('stripeSecretKey', 'STRIPE_SECRET_KEY'),
    getCfg('stripeSubPriceId', 'STRIPE_SUB_PRICE_ID'),
    getCfg('stripeCredits10PriceId', 'STRIPE_CREDITS_10_PRICE_ID'),
    getCfg('stripeCredits50PriceId', 'STRIPE_CREDITS_50_PRICE_ID'),
    getCfg('frontendUrl', 'FRONTEND_URL', 'https://edge-backend-rho.vercel.app'),
  ]);

  if (!stripeKey) {
    return fail(res, 503, { text: 'Stripe is not configured', error: 'Stripe not configured. Add keys in admin → Setup.' });
  }

  const PRICE_MAP = { sub: subPrice, credits_10: credits10Price, credits_50: credits50Price };
  const priceId = PRICE_MAP[plan];
  if (!priceId) {
    return fail(res, 400, { text: 'Requested plan is unavailable', error: `Price ID not configured for plan "${plan}". Add it in admin → Setup.` });
  }

  try {
    const stripe = require('stripe')(stripeKey);
    const checkoutSession = await stripe.checkout.sessions.create({
      mode: plan === 'sub' ? 'subscription' : 'payment',
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { userId, plan, credits: CREDITS_MAP[plan] },
      success_url: `${frontendUrl}?session_id={CHECKOUT_SESSION_ID}&status=success`,
      cancel_url: `${frontendUrl}?status=cancelled`,
    });
    return ok(res, { text: 'Checkout session created', data: { url: checkoutSession.url } });
  } catch (err) {
    console.error(`[${req.id}] Stripe checkout error:`, err.message);
    return fail(res, 500, { text: 'Checkout could not be created', error: 'Stripe checkout failed' });
  }
});

module.exports = router;
