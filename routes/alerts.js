const express = require('express');
const router = express.Router();

router.post('/test', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ ok:false, error:'email required' });

  if (!process.env.RESEND_API_KEY) {
    return res.json({ ok:true, message:'RESEND not configured, skipping send' });
  }

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method:'POST',
      headers:{
        'Authorization':`Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type':'application/json'
      },
      body:JSON.stringify({
        from: process.env.FROM_EMAIL || 'onboarding@resend.dev',
        to: email,
        subject: 'EDGE Alert',
        html: '<strong>Your EDGE alert is working 🚀</strong>'
      })
    });

    const data = await r.json();
    res.json({ ok:true, data });
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});

module.exports = router;
