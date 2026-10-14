// Sign-in: signed session tokens + password hashing. No external packages.
const crypto = require("crypto");

const ON_VERCEL = !!process.env.VERCEL;
const SECRET = process.env.AUTH_SECRET || (ON_VERCEL ? "" : "dev-only-secret-change-me");
const DEMO = !ON_VERCEL && process.env.DEMO_HINTS !== "0";    // show demo logins on the sign-in page
const SESSION_HOURS = 8;

const b64 = b => Buffer.from(b).toString("base64url");
const mac = data => crypto.createHmac("sha256", SECRET).update(data).digest("base64url");

function sign(user) {
  if (!SECRET) throw new Error("Server is missing AUTH_SECRET. Add it in your Vercel environment variables.");
  const body = b64(JSON.stringify({ ...user, exp: Date.now() + SESSION_HOURS * 3600e3 }));
  return `${body}.${mac(body)}`;
}

function verify(token) {
  if (!SECRET || typeof token !== "string") return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const good = Buffer.from(mac(body)), got = Buffer.from(sig);
  if (good.length !== got.length || !crypto.timingSafeEqual(good, got)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}

function userFrom(req) {
  const h = (req.headers && (req.headers.authorization || req.headers.Authorization)) || "";
  return verify(h.replace(/^Bearer\s+/i, ""));
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  return `${salt}:${crypto.scryptSync(pw, salt, 32).toString("hex")}`;
}
function checkPassword(pw, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  const a = Buffer.from(crypto.scryptSync(String(pw), salt, 32).toString("hex")), b = Buffer.from(hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// Best-effort brute-force guard (memory only, so it resets when a serverless instance restarts).
const tries = new Map();
function throttle(key, ok) {
  const now = Date.now(), t = tries.get(key) || { n: 0, until: 0 };
  if (t.until > now) throw new Error("Too many failed attempts. Please wait 10 minutes and try again.");
  if (ok === null) return;                       // check only
  if (ok) { tries.delete(key); return; }
  t.n += 1;
  if (t.n >= 5) { t.until = now + 10 * 60e3; t.n = 0; }
  tries.set(key, t);
}

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || (ON_VERCEL ? "" : "admin@school.edu")).toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || (ON_VERCEL ? "" : "admin123");

module.exports = { sign, verify, userFrom, hashPassword, checkPassword, same, throttle, ADMIN_EMAIL, ADMIN_PASSWORD, DEMO };
