const jwt = require('jsonwebtoken');

const USE_KV = !!process.env.UPSTASH_REDIS_REST_URL;
const JWT_SECRET = process.env.JWT_SECRET || 'edge-dev-secret-changeme';
const OTP_TTL_SEC = 15 * 60;

const localOtpStore = new Map();

function redisClient() {
  const { Redis } = require('@upstash/redis');
  return new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
}

function generateOTP() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function storeOTP(email, otp) {
  const key = `edge:otp:${email}`;
  if (USE_KV) {
    await redisClient().set(key, otp, { ex: OTP_TTL_SEC });
  } else {
    localOtpStore.set(key, { otp, expires: Date.now() + OTP_TTL_SEC * 1000 });
  }
}

async function validateOTP(email, otp) {
  const key = `edge:otp:${email}`;
  if (USE_KV) {
    const redis = redisClient();
    const stored = await redis.get(key);
    if (stored !== otp) return false;
    await redis.del(key);
    return true;
  }
  const entry = localOtpStore.get(key);
  if (!entry || entry.otp !== otp || entry.expires < Date.now()) return false;
  localOtpStore.delete(key);
  return true;
}

function createSession(email) {
  return jwt.sign({ email }, JWT_SECRET, { expiresIn: '30d' });
}

function verifySession(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

async function sendOTPEmail(email, otp) {
  if (!process.env.RESEND_API_KEY) {
    console.log(`\n[DEV] OTP for ${email}: ${otp}\n`);
    return;
  }
  const { Resend } = require('resend');
  const resend = new Resend(process.env.RESEND_API_KEY);
  const from = process.env.FROM_EMAIL || 'EDGE <onboarding@resend.dev>';
  await resend.emails.send({
    from,
    to: email,
    subject: `${otp} — your EDGE login code`,
    html: `
      <div style="font-family:'Courier New',monospace;background:#080c10;color:#e8f4f8;padding:40px 32px;max-width:440px;margin:0 auto;">
        <div style="font-size:22px;font-weight:900;letter-spacing:8px;color:#00e5ff;margin-bottom:6px;">EDGE</div>
        <div style="font-size:10px;color:#5a7a8a;letter-spacing:3px;margin-bottom:32px;">AI BETTING ANALYTICS</div>
        <div style="font-size:13px;color:#b0ccd8;margin-bottom:20px;">Your login code is:</div>
        <div style="font-size:42px;font-weight:700;color:#00e5ff;letter-spacing:12px;padding:24px;background:#0d1219;border:1px solid #1e2d3d;text-align:center;margin-bottom:24px;">${otp}</div>
        <div style="font-size:11px;color:#5a7a8a;line-height:1.8;">
          Expires in <strong style="color:#b0ccd8">15 minutes</strong>. Do not share this code.
        </div>
      </div>
    `,
  });
}

module.exports = { generateOTP, storeOTP, validateOTP, createSession, verifySession, sendOTPEmail };
