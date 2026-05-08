const express = require('express');
const router = express.Router();
const { verifySession } = require('../lib/auth');
const { getUser, saveUser } = require('../lib/users');
const { ok, fail } = require('../lib/http');
const { OWNER_EMAILS } = require('../lib/owners');

router.post('/', async (req, res) => {
  const session = verifySession(req.cookies?.edge_session);
  const userId = session?.email;
  if (!userId) return fail(res, 401, { text: 'Not authenticated', error: 'Not authenticated' });

  // Owners never consume credits
  if (OWNER_EMAILS.includes(String(userId).toLowerCase())) {
    return ok(res, { text: 'Owner access', data: { credits: 9999 } });
  }

  const user = await getUser(userId);

  // Subscribers don't consume credits
  if (user.isSubscriber) {
    return ok(res, { text: 'Subscriber access', data: { credits: null } });
  }

  if ((user.credits || 0) <= 0) {
    return fail(res, 402, { text: 'No credits remaining', error: 'No credits remaining' });
  }

  const updated = await saveUser(userId, { credits: user.credits - 1 });
  return ok(res, { text: 'Credit used', data: { credits: updated.credits } });
});

module.exports = router;
