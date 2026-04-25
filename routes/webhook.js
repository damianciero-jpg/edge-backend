const express = require('express');
const router = express.Router();
const { addCredits, setSubscriber } = require('../lib/users');
const { getCfg } = require('../lib/config');
const { ok, fail } = require('../lib/http');

router.post('/', async (req, res) => {
  const sig = req.headers['stripe-signature'];

  const [stripeKey, webhookSecret] = await Promise.all([
    getCfg('stripeSecretKey', 'STRIPE_SECRET_KEY'),
    getCfg('stripeWebhookSecret', 'STRIPE_WEBHOOK_SECRET'),
  ]);

  if (!stripeKey || !webhookSecret) {
    return fail(res, 503, { text: 'Stripe is not configured', error: 'Stripe not configured' });
  }

  const stripe = require('stripe')(stripeKey);

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error(`[${req.id}] Webhook signature verification failed:`, err.message);
    return fail(res, 400, { text: 'Invalid webhook signature', error: 'Invalid signature' });
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const { userId, plan, credits } = session.metadata || {};
      if (!userId) {
        console.warn(`[${req.id}] Webhook: no userId in metadata`);
        return ok(res, { text: 'Webhook received (missing user metadata)', data: { received: true } });
      }
      if (plan === 'sub') {
        await setSubscriber(userId, true);
        console.log(`[${req.id}] User subscribed: ${userId}`);
      } else if (credits) {
        const amount = parseInt(credits, 10);
        if (Number.isFinite(amount) && amount > 0) {
          await addCredits(userId, amount);
          console.log(`[${req.id}] Added ${amount} credits to ${userId}`);
        }
      }
    } else if (event.type === 'customer.subscription.deleted') {
      console.log(`[${req.id}] Subscription cancelled: ${event.data.object.id}`);
    }
  } catch (err) {
    console.error(`[${req.id}] Webhook handler error:`, err.message);
    return fail(res, 500, { text: 'Webhook processing failed', error: 'Internal webhook error' });
  }

  return ok(res, { text: 'Webhook received', data: { received: true } });
});

module.exports = router;
