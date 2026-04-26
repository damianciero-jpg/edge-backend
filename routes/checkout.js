const express = require('express');
const router = express.Router();
const { getCfg } = require('../lib/config');
const { verifySession } = require('../lib/auth');
const { ok, fail } = require('../lib/http');

const CREDITS_MAP = { sub: '0', credits_10: '10', credits_50: '50' };
const DEFAULT_SUB_PRODUCT_ID = 'prod_UOy3vrbxmo601V';

async function resolveSubscriptionPrice(stripe, configuredPrice, configuredProduct) {
  const product = configuredProduct || DEFAULT_SUB_PRODUCT_ID;
  let prices = { data: [] };

  if (product) {
    prices = await stripe.prices.list({
      product,
      active: true,
      type: 'recurring',
      limit: 100,
    });
  }

  const monthlyUsd20 = prices.data.find(price =>
    price.currency === 'usd' &&
    price.unit_amount === 2000 &&
    price.recurring &&
    price.recurring.interval === 'month'
  );
  if (monthlyUsd20) return monthlyUsd20.id;

  const monthly = prices.data.find(price =>
    price.currency === 'usd' &&
    price.recurring &&
    price.recurring.interval === 'month'
  );
  if (monthly) return monthly.id;
  if (configuredPrice && configuredPrice.startsWith('price_')) return configuredPrice;

  throw new Error(`No active monthly subscription price found for product ${product}`);
}

router.post('/', async (req, res) => {
  const { plan } = req.body;
  const session = verifySession(req.cookies && req.cookies.edge_session);
  const userId = session && session.email;
  if (!plan || !userId) {
    return fail(res, 400, { text: 'Plan and login are required', error: 'plan required and must be logged in' });
  }

  const [stripeKey, subPrice, subProduct, credits10Price, credits50Price, frontendUrl] = await Promise.all([
    getCfg('stripeSecretKey', 'STRIPE_SECRET_KEY'),
    getCfg('stripeSubPriceId', 'STRIPE_SUB_PRICE_ID'),
    getCfg('stripeSubProductId', 'STRIPE_SUB_PRODUCT_ID', DEFAULT_SUB_PRODUCT_ID),
    getCfg('stripeCredits10PriceId', 'STRIPE_CREDITS_10_PRICE_ID'),
    getCfg('stripeCredits50PriceId', 'STRIPE_CREDITS_50_PRICE_ID'),
    getCfg('frontendUrl', 'FRONTEND_URL', 'https://edge-backend-rho.vercel.app'),
  ]);

  if (!stripeKey) {
    return fail(res, 503, { text: 'Stripe is not configured', error: 'Stripe not configured. Add keys in admin Setup.' });
  }

  try {
    const stripe = require('stripe')(stripeKey);
    const priceId = plan === 'sub'
      ? await resolveSubscriptionPrice(stripe, subPrice, subProduct)
      : { credits_10: credits10Price, credits_50: credits50Price }[plan];

    if (!priceId) {
      return fail(res, 400, { text: 'Requested plan is unavailable', error: `Price ID not configured for plan "${plan}". Add it in admin Setup.` });
    }

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
