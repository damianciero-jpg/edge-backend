const express = require('express');
const router = express.Router();
const { getUser } = require('../lib/users');
const { verifySession } = require('../lib/auth');

router.get('/', async (req, res) => {
  const session = verifySession(req.cookies?.edge_session);
  const userId = session?.email || req.query.userId;
  if (!userId) return res.status(400).json({ error: 'Not authenticated' });
  const user = await getUser(userId);
  res.json({ userId, isSubscriber: user.isSubscriber, credits: user.credits });
});

module.exports = router;
