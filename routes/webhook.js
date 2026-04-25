const express = require('express');
const router = express.Router();
const { addCredits, setSubscriber } = require('../lib/users');
const { getCfg } = require('../lib/config');

router.post('/', async (req, res) => {
  const sig = req.headers['stripe-signature'];

  const [stripeKey, webhookSecret] = await Promise.all([
    getCfg('stripeSecretKey', 'STRIPE_SECRET_KEY'),
    getCfg('stripeWebhookSecret', 'STRIPE_WEBHOOK_SECRET'),
  ]);

  if (!stripeKey || !webhookSecret) {
    return res.status(503).json({ error: 'Stripe not configured' });
  }

  const stripe = require('stripe')(stripeKey);

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const { userId, plan, credits } = session.metadata;
      if (!userId) { console.warn('Webhook: no userId in metadata'); return res.json({ received: true }); }
      if (plan === 'sub') {
        await setSubscriber(userId, true);
        console.log(`User ${userId} subscribed`);
      } else if (credits) {
        const amount = parseInt(credits, 10);
        await addCredits(userId, amount);
        console.log(`Added ${amount} credits to user ${userId}`);
      }
    } else if (event.type === 'customer.subscription.deleted') {
      console.log(`Subscription cancelled: ${event.data.object.id}`);
    }
  } catch (err) {
    console.error('Webhook handler error:', err.message);
    return res.status(500).send('Internal error');
  }

  res.json({ received: true });
});

module.exports = router;
