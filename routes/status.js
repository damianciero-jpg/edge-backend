const express = require('express');
const router = express.Router();
const { getUser } = require('../lib/users');
const { verifySession } = require('../lib/auth');
const { ok, fail } = require('../lib/http');

const OWNER_EMAILS = [
  'damianciero@gmail.com',
  'ffanning@comcast.net',
  'afelt1991@yahoo.com',
];

router.get('/', async (req, res) => {
  const session = verifySession(req.cookies?.edge_session);
  const userId = session?.email || req.query.userId;
  if (!userId) return fail(res, 400, { text: 'Authentication required', error: 'Not authenticated' });
  let user = await getUser(userId);
  const isOwner = OWNER_EMAILS.includes(String(userId || '').toLowerCase());

  if (isOwner) {
    user = {
      ...user,
      isSubscriber: true,
      credits: 9999,
    };
  }

  return ok(res, {
    text: 'User status fetched',
    data: { userId, isSubscriber: user.isSubscriber, credits: user.credits },
  });
});

module.exports = router;
