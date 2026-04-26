const express = require('express');
const router = express.Router();
const { getUser } = require('../lib/users');
const { verifySession } = require('../lib/auth');
const { ok, fail } = require('../lib/http');

router.get('/', async (req, res) => {
  const session = verifySession(req.cookies?.edge_session);
  const userId = session?.email || req.query.userId;
  if (!userId) return fail(res, 400, { text: 'Authentication required', error: 'Not authenticated' });
  const user = await getUser(userId);
  return ok(res, {
    text: 'User status fetched',
    data: { userId, isSubscriber: user.isSubscriber, credits: user.credits },
  });
});

module.exports = router;
