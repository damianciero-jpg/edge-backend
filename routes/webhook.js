const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { addCredits, setSubscriber } = require('../lib/users');

router.post('/', async (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const { userId, plan, credits } = session.metadata;

      if (!userId) {
        console.warn('Webhook: no userId in metadata, skipping');
        return res.json({ received: true });
      }

      if (plan === 'sub') {
        await setSubscriber(userId, true);
        console.log(`User ${userId} subscribed`);
      } else if (plan === 'credits_10' || plan === 'credits_50') {
        const amount = parseInt(credits, 10);
        await addCredits(userId, amount);
        console.log(`Added ${amount} credits to user ${userId}`);
      }
    } else if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      console.log(`Subscription cancelled: ${subscription.id} (customer: ${subscription.customer})`);
    }
  } catch (err) {
    console.error('Error handling webhook event:', err.message);
    return res.status(500).send('Internal error');
  }

  res.json({ received: true });
});

module.exports = router;
