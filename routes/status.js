const express = require('express');
const router = express.Router();
const { getUser } = require('../lib/users');

router.get('/', async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId is required' });
  const user = await getUser(userId);
  res.json({ userId, isSubscriber: user.isSubscriber, credits: user.credits });
});

module.exports = router;
