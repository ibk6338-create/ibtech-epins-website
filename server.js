/* ==========================================================================
   IB-TECH backend — HTTP layer
   --------------------------------------------------------------------------
   This file only knows about HTTP: parsing requests, checking who's
   allowed to do what, and calling into db.js for anything that touches
   storage. See db.js for the SQLite schema and server/README.md for the
   endpoint list and a Node-version note (this needs a fairly recent Node
   for the built-in `node:sqlite` module).
   ========================================================================== */
"use strict";

const http = require("http");
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const db = require("./db");
const { hashPassword, verifyPassword, unitPrice, genId } = require("./lib");

// ---- optional .env loader (no dependency — just reads KEY=VALUE lines) ----
(function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  fs.readFileSync(envPath, "utf8").split("\n").forEach(line => {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = (m[2] || "").trim();
  });
})();

const PORT = process.env.PORT || 3000;
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY || "";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
// Must be on a domain you've verified in Resend, e.g. "IB-TECH <noreply@yourdomain.com>".
// Resend's shared "onboarding@resend.dev" sender only delivers to your own
// Resend account email, so it's fine for a first smoke test but not for
// real users — verify a domain before going live.
const RESEND_FROM = process.env.RESEND_FROM_EMAIL || "IB-TECH ePINs <onboarding@resend.dev>";
const ALLOWED_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:3000";
const MAX_BODY_BYTES = 2 * 1024 * 1024;
// Phone-only signups still need *some* value in the email column (it's
// unique/required in the schema), so we store an unguessable placeholder on
// a domain nobody actually owns. isPlaceholderEmail() lets every other part
// of the app (publicUser, password-reset-by-email) treat that the same as
// "this account has no real email" instead of accidentally emailing it.
const PLACEHOLDER_EMAIL_DOMAIN = "@phone.ibtech.local";
function isPlaceholderEmail(email) {
  return typeof email === "string" && email.endsWith(PLACEHOLDER_EMAIL_DOMAIN);
}
const { NETWORKS, DENOMS } = db;
const ROLES = { USER: "user", ADMIN: "admin", SUPERADMIN: "superadmin" };

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------
function isAdmin(user) { return !!user && user.role !== ROLES.USER; }
function isSuperAdmin(user) { return !!user && user.role === ROLES.SUPERADMIN; }

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, name: u.name, business: u.business,
    email: isPlaceholderEmail(u.email) ? null : u.email,
    phone: u.phone,
    role: u.role, wallet: Number(u.wallet_kobo ?? Math.round(Number(u.wallet || 0) * 100)) / 100, avatar: u.avatar || null, createdAt: u.created_at,
    dedicatedAccount: u.dva_status === "active" ? {
      accountNumber: u.dva_account_number, bankName: u.dva_bank_name, accountName: u.dva_account_name
    } : null,
    dedicatedAccountStatus: u.dva_status || "none"
  };
}

function getAuthUser(req) {
  const header = req.headers["authorization"] || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return null;
  const userId = db.userIdForSession(token);
  if (!userId) return null;
  return db.findUserById(userId);
}

// ---------------------------------------------------------------------------
// tiny HTTP plumbing (no Express) — a router table + JSON body parsing
// ---------------------------------------------------------------------------
function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    ...(reqProtocolIsHttps(res) ? { "Strict-Transport-Security": "max-age=31536000; includeSubDomains" } : {})
  });
  res.end(payload);
}
function reqProtocolIsHttps(res) { return res.req?.headers?.["x-forwarded-proto"] === "https"; }

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on("data", c => {
      total += c.length;
      if (total > MAX_BODY_BYTES) { reject(new Error("Request body too large.")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const rateBuckets = new Map();
function rateLimit(req, key, limit, windowMs) {
  const now = Date.now();
  const forwarded = req.headers["x-forwarded-for"];
  const ip = (forwarded ? String(forwarded).split(",")[0].trim() : req.socket.remoteAddress) || "unknown";
  const bucketKey = `${key}:${ip}`;
  const bucket = rateBuckets.get(bucketKey);
  if (!bucket || now >= bucket.resetAt) {
    rateBuckets.set(bucketKey, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (bucket.count >= limit) return false;
  bucket.count++;
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) if (bucket.resetAt <= now) rateBuckets.delete(key);
}, 60_000).unref();
async function readJSON(req) {
  const raw = await readRawBody(req);
  if (!raw.length) return {};
  try { return JSON.parse(raw.toString("utf8")); } catch { return {}; }
}

// ---------------------------------------------------------------------------
// Paystack calls — all server-side, using the secret key. Never send this
// key to the browser.
// ---------------------------------------------------------------------------
function paystackRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    if (!PAYSTACK_SECRET) return reject(new Error("PAYSTACK_SECRET_KEY is not configured on the server."));
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: "api.paystack.co",
      path: urlPath,
      method,
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET}`,
        "Content-Type": "application/json",
        ...(data ? { "Content-Length": Buffer.byteLength(data) } : {})
      }
    }, (res) => {
      let out = "";
      res.on("data", c => out += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(out) }); }
        catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Resend calls — sends the password-reset code by email. Falls back to
// returning the token directly in the API response when RESEND_API_KEY
// isn't set, so local/dev testing still works with zero setup.
// ---------------------------------------------------------------------------
function resendRequest(body) {
  return new Promise((resolve, reject) => {
    if (!RESEND_API_KEY) return reject(new Error("RESEND_API_KEY is not configured on the server."));
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: "api.resend.com",
      path: "/emails",
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data)
      }
    }, (res) => {
      let out = "";
      res.on("data", c => out += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(out) }); }
        catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function escapeHtmlServer(value) {
  return String(value ?? "").replace(/[&<>\"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;", "'":"&#39;"}[ch]));
}

async function sendResetEmail(user, token) {
  const html = `
    <p>Hi ${escapeHtmlServer(user.name || "there")},</p>
    <p>Use this code to reset your IB-TECH password. It expires in 30 minutes.</p>
    <p style="font-size:22px;font-weight:700;letter-spacing:2px;">${token}</p>
    <p>Go back to the reset page and paste this code in if it isn't filled in already.</p>
    <p>If you didn't request this, you can ignore this email.</p>
  `;
  const r = await resendRequest({
    from: RESEND_FROM,
    to: [user.email],
    subject: "Your IB-TECH ePINs password reset code",
    html
  });
  if (r.status >= 400) {
    throw new Error(r.body?.message || "Resend rejected the email.");
  }
}

// ---------------------------------------------------------------------------
// route handlers
// ---------------------------------------------------------------------------
const routes = [];
function route(method, pattern, handler) { routes.push({ method, pattern, handler }); }

// ---- auth ----
route("POST", "/api/auth/signup", async (req, res) => {
  if (!rateLimit(req, "signup", 10, 15 * 60 * 1000)) return send(res, 429, { ok: false, error: "Too many signup attempts. Try again later." });
  const body = await readJSON(req);
  const { name, business, phone, password } = body;
  let { email } = body;
  email = (email || "").trim();
  const cleanPhone = (phone || "").trim();
  if (!name || !password || password.length < 6) {
    return send(res, 400, { ok: false, error: "Name and a password of at least 6 characters are required." });
  }
  if (!email && !cleanPhone) {
    return send(res, 400, { ok: false, error: "Enter an email address or a phone number to sign up." });
  }
  if (email && db.findUserByEmail(email)) {
    return send(res, 409, { ok: false, error: "An account with that email already exists." });
  }
  if (cleanPhone && db.findUserByPhone(cleanPhone)) {
    return send(res, 409, { ok: false, error: "An account with that phone number already exists." });
  }
  // No email given — store a placeholder so the (unique, required) email
  // column still has something in it. Never shown to the user or emailed
  // to; see isPlaceholderEmail() above.
  if (!email) email = `${cleanPhone.replace(/\D/g, "")}${PLACEHOLDER_EMAIL_DOMAIN}`;
  const user = db.createUser({ name, business, email, phone: cleanPhone, passwordHash: hashPassword(password) });
  const token = db.createSession(user.id);
  send(res, 201, { ok: true, token, user: publicUser(user) });
});

route("POST", "/api/auth/login", async (req, res) => {
  if (!rateLimit(req, "login", 10, 15 * 60 * 1000)) return send(res, 429, { ok: false, error: "Too many login attempts. Try again later." });
  // `identifier` can be an email address or a phone number; `email` is kept
  // as a fallback so older clients that only ever sent { email } still work.
  const { identifier, email, password } = await readJSON(req);
  const login = (identifier || email || "").trim();
  const user = db.findUserByEmail(login) || db.findUserByPhone(login);
  if (!user || !verifyPassword(password || "", user.password_hash)) {
    return send(res, 401, { ok: false, error: "Incorrect email/phone or password." });
  }
  const token = db.createSession(user.id);
  send(res, 200, { ok: true, token, user: publicUser(user) });
});

route("POST", "/api/auth/logout", async (req, res) => {
  const header = req.headers["authorization"] || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (token) db.deleteSession(token);
  send(res, 200, { ok: true });
});

route("GET", "/api/me", async (req, res) => {
  const user = getAuthUser(req);
  if (!user) return send(res, 401, { ok: false, error: "Not logged in." });
  send(res, 200, { ok: true, user: publicUser(user) });
});

// Profile photo — stored as a data URL directly on the user row so no file
// storage / static hosting is needed. Capped well under the DB's comfort
// zone for a TEXT column (a few hundred KB of base64 is plenty for an
// avatar-sized image once the client has resized it).
const MAX_AVATAR_CHARS = 900000; // ~650KB of image data once decoded
route("POST", "/api/me/avatar", async (req, res) => {
  const user = getAuthUser(req);
  if (!user) return send(res, 401, { ok: false, error: "Not logged in." });
  const { image } = await readJSON(req);
  if (image !== null && (!image || !/^data:image\/(png|jpe?g|webp);base64,/.test(image))) {
    return send(res, 400, { ok: false, error: "Expected a base64 image data URL (png, jpg or webp)." });
  }
  if (image && image.length > MAX_AVATAR_CHARS) {
    return send(res, 413, { ok: false, error: "That image is too large — please use a smaller photo." });
  }
  const updated = db.setUserAvatar(user.id, image); // image === null clears it
  send(res, 200, { ok: true, avatar: updated.avatar });
});

// ---- password reset ----
// There's no email/SMS sending wired up in this project (see
// server/README.md), so — same spirit as the Paystack key being blank until
// you configure it — the reset link is handed straight back in the response
// instead of being emailed/texted. Swap this for a real mailer/SMS provider
// before using this in production; don't ship a token in an API response.
route("POST", "/api/auth/forgot", async (req, res) => {
  if (!rateLimit(req, "forgot", 5, 15 * 60 * 1000)) return send(res, 429, { ok: false, error: "Too many password-reset requests. Try again later." });
  const { identifier } = await readJSON(req);
  const login = (identifier || "").trim();
  const user = db.findUserByEmail(login) || db.findUserByPhone(login);
  if (!user) {
    return send(res, 200, { ok: true, sent: false, expiresInMinutes: 30, note: "If an account matches, reset instructions will be sent." });
  }
  const token = db.createPasswordReset(user.id);

  // Email it if Resend is configured AND this account actually has an email
  // (phone-only accounts fall back to the on-page token — there's no SMS
  // provider wired up yet).
  if (RESEND_API_KEY && user.email && !isPlaceholderEmail(user.email)) {
    try {
      await sendResetEmail(user, token);
      return send(res, 200, {
        ok: true,
        sent: true,
        expiresInMinutes: 30,
        note: `A reset code was emailed to ${user.email}.`
      });
    } catch (e) {
      // Don't silently fall through to exposing the token on a
      // misconfigured live server — surface the real problem instead.
      return send(res, 502, { ok: false, error: `Could not send the reset email: ${e.message}` });
    }
  }

  return send(res, 503, { ok: false, error: "Password reset delivery is not configured. Contact support." });
});

route("POST", "/api/auth/reset", async (req, res) => {
  const { token, password } = await readJSON(req);
  if (!password || password.length < 6) {
    return send(res, 400, { ok: false, error: "Enter a new password of at least 6 characters." });
  }
  const reset = db.findPasswordReset(token || "");
  if (!reset) {
    return send(res, 400, { ok: false, error: "That reset link is invalid or has expired — request a new one." });
  }
  db.setUserPassword(reset.user_id, hashPassword(password));
  db.deletePasswordReset(token);
  db.deleteAllSessionsForUser(reset.user_id);
  send(res, 200, { ok: true });
});

// ---- catalog ----
route("GET", "/api/stock", async (req, res) => {
  send(res, 200, { ok: true, networks: NETWORKS, denoms: DENOMS, stock: db.stockSnapshot() });
});

// ---- printing ----
route("POST", "/api/print", async (req, res) => {
  const user = getAuthUser(req);
  if (!user) return send(res, 401, { ok: false, error: "Not logged in." });
  const { network, denom, qty } = await readJSON(req);
  const q = Number(qty);
  const d = Number(denom);
  if (!Number.isInteger(q) || q < 1 || q > 100) return send(res, 400, { ok: false, error: "Quantity must be a whole number between 1 and 100." });
  if (!NETWORKS.includes(network) || !DENOMS.includes(d)) {
    return send(res, 400, { ok: false, error: "Unknown network or denomination." });
  }
  const costKobo = unitPrice(d) * q * 100;
  const cost = costKobo / 100;
  const txId = genId("tx");
  const purchase = db.purchasePins(user.id, network, d, q, costKobo, txId);
  if (!purchase.ok) {
    if (purchase.reason === "out_of_stock") return send(res, 409, { ok: false, error: `Only ${purchase.stock} ${network} ₦${d} pin(s) left in stock.` });
    return send(res, 402, { ok: false, error: `Insufficient wallet balance. Needs ₦${cost}, wallet holds ₦${purchase.wallet}.` });
  }
  send(res, 200, { ok: true, tx: { id: txId, network, denom: d, qty: q, cards: purchase.cards, total: cost, date: Date.now() }, wallet: purchase.wallet });
});

route("GET", "/api/transactions", async (req, res, query) => {
  const user = getAuthUser(req);
  if (!user) return send(res, 401, { ok: false, error: "Not logged in." });
  if (query.all === "1" && isAdmin(user)) return send(res, 200, { ok: true, transactions: db.allTransactions() });
  send(res, 200, { ok: true, transactions: db.transactionsForUser(user.id) });
});

// Users may hide their own history entries. Financial ledger records remain
// immutable; administrators cannot delete them.
route("POST", "/api/transactions/delete", async (req, res) => {
  const user = getAuthUser(req);
  if (!user) return send(res, 401, { ok: false, error: "Not logged in." });
  const { id } = await readJSON(req);
  if (!id) return send(res, 400, { ok: false, error: "Missing transaction id." });
  if (isAdmin(user)) return send(res, 403, { ok: false, error: "Financial ledger entries cannot be deleted by administrators." });
  const hidden = db.hideTransactionForUser(id, user.id);
  if (!hidden) return send(res, 404, { ok: false, error: "Transaction not found." });
  send(res, 200, { ok: true });
});

// ---- wallet funding (real money, via Paystack) ----
route("POST", "/api/wallet/initiate", async (req, res) => {
  const user = getAuthUser(req);
  if (!user) return send(res, 401, { ok: false, error: "Not logged in." });
  const { amount } = await readJSON(req);
  const naira = Number(amount);
  const kobo = Math.round(naira * 100);
  if (!Number.isFinite(naira) || naira <= 0 || kobo < 100) return send(res, 400, { ok: false, error: "Enter a valid amount of at least ₦1." });
  if (kobo > 50_000_000) return send(res, 400, { ok: false, error: "Maximum wallet funding per transaction is ₦500,000." });
  try {
    const reference = genId("pay");
    db.createPaymentIntent(reference, user.id, kobo);
    const r = await paystackRequest("POST", "/transaction/initialize", {
      email: user.email,
      amount: kobo, // kobo
      reference
    });
    if (r.status >= 400 || !r.body.status) return send(res, 502, { ok: false, error: r.body.message || "Paystack rejected the request." });
    send(res, 200, { ok: true, authorization_url: r.body.data.authorization_url, reference });
  } catch (e) {
    send(res, 500, { ok: false, error: "The payment service is temporarily unavailable." });
  }
});

route("POST", "/api/wallet/verify", async (req, res) => {
  const user = getAuthUser(req);
  if (!user) return send(res, 401, { ok: false, error: "Not logged in." });
  if (!rateLimit(req, "wallet-verify", 30, 15 * 60 * 1000)) return send(res, 429, { ok: false, error: "Too many verification attempts. Try again later." });
  const { reference } = await readJSON(req);
  if (!reference || typeof reference !== "string" || reference.length > 100) return send(res, 400, { ok: false, error: "Missing or invalid reference." });
  const intent = db.findPaymentIntent(reference);
  if (!intent || intent.user_id !== user.id) return send(res, 403, { ok: false, error: "That payment reference does not belong to this account." });
  if (intent.status === "success") return send(res, 200, { ok: true, alreadyProcessed: true, wallet: Number(db.findUserById(user.id).wallet_kobo) / 100 });
  try {
    const r = await paystackRequest("GET", `/transaction/verify/${encodeURIComponent(reference)}`);
    if (r.status >= 400 || r.body.data?.status !== "success") return send(res, 402, { ok: false, error: "Payment was not successful." });
    const data = r.body.data;
    if (Number(data.amount) !== Number(intent.amount_kobo)) return send(res, 400, { ok: false, error: "Payment amount does not match the requested amount." });
    const settled = db.settlePaymentIntent(reference, data.amount, "checkout");
    if (!settled.ok) return send(res, 409, { ok: false, error: settled.reason === "amount_mismatch" ? "Payment amount does not match." : "Payment could not be settled safely." });
    send(res, 200, { ok: true, credited: settled.amount, wallet: settled.wallet });
  } catch (e) {
    send(res, 500, { ok: false, error: "Payment verification failed." });
  }
});

// ---- wallet funding (permanent bank transfer account, via Paystack Dedicated Virtual Accounts) ----
// Gives each user their own real bank account number to transfer into at
// any time. IMPORTANT: this only works once Paystack has approved your
// business for DVAs (Nigeria-registered business + completed KYC) — see
// server/README.md. Test mode still creates fake DVAs so you can build and
// test this flow before going live.
route("GET", "/api/wallet/dedicated-account", async (req, res) => {
  const user = getAuthUser(req);
  if (!user) return send(res, 401, { ok: false, error: "Not logged in." });
  const fresh = db.findUserById(user.id);
  send(res, 200, {
    ok: true,
    status: fresh.dva_status || "none",
    account: fresh.dva_status === "active"
      ? { accountNumber: fresh.dva_account_number, bankName: fresh.dva_bank_name, accountName: fresh.dva_account_name }
      : null
  });
});

route("POST", "/api/wallet/dedicated-account", async (req, res) => {
  const user = getAuthUser(req);
  if (!user) return send(res, 401, { ok: false, error: "Not logged in." });
  let fresh = db.findUserById(user.id);

  if (fresh.dva_status === "active") {
    return send(res, 200, {
      ok: true, status: "active",
      account: { accountNumber: fresh.dva_account_number, bankName: fresh.dva_bank_name, accountName: fresh.dva_account_name }
    });
  }
  if (fresh.dva_status === "pending") {
    return send(res, 200, { ok: true, status: "pending", account: null });
  }
  if (!db.claimDvaCreation(user.id)) {
    return send(res, 200, { ok: true, status: "pending", account: null });
  }
  fresh = db.findUserById(user.id);

  try {
    // Step 1 — make sure this user has a Paystack customer record.
    let customerCode = fresh.paystack_customer_code;
    if (!customerCode) {
      const [firstName, ...rest] = (fresh.name || "Reseller").trim().split(/\s+/);
      const lastName = rest.join(" ") || firstName;
      const custRes = await paystackRequest("POST", "/customer", {
        email: fresh.email, first_name: firstName, last_name: lastName, phone: fresh.phone || undefined
      });
      if (custRes.status >= 400 || !custRes.body.status) {
        return send(res, 502, { ok: false, error: custRes.body.message || "Could not create a Paystack customer record." });
      }
      customerCode = custRes.body.data.customer_code;
      fresh = db.setCustomerCode(user.id, customerCode);
    }

    // Step 2 — request a dedicated account for that customer.
    const dvaRes = await paystackRequest("POST", "/dedicated_account", {
      customer: customerCode,
      preferred_bank: process.env.DVA_PREFERRED_BANK || "wema-bank"
    });
    if (dvaRes.status >= 400 || !dvaRes.body.status) {
      db.setDvaFailed(user.id);
      const msg = dvaRes.body?.message || "Could not create a dedicated account.";
      return send(res, 502, {
        ok: false,
        error: `${msg} (Dedicated Virtual Accounts need your Paystack business to be KYC-approved for this feature — see server/README.md.)`
      });
    }

    const data = dvaRes.body.data || {};
    if (data.account_number) {
      // Some providers assign synchronously — we already have everything.
      db.setDvaActive(user.id, {
        accountNumber: data.account_number,
        bankName: data.bank?.name || "",
        accountName: data.account_name || ""
      });
      return send(res, 200, {
        ok: true, status: "active",
        account: { accountNumber: data.account_number, bankName: data.bank?.name || "", accountName: data.account_name || "" }
      });
    }
    // Otherwise it's assigned asynchronously — Paystack notifies us via the
    // dedicatedaccount.assign.success webhook once it's ready.
    db.setDvaPending(user.id);
    send(res, 200, { ok: true, status: "pending", account: null });
  } catch (e) {
    db.setDvaFailed(user.id);
    send(res, 500, { ok: false, error: e.message });
  }
});

// Paystack calls this directly — it's the source of truth, independent of
// whether the customer's browser stayed open long enough to call /verify.
route("POST", "/api/paystack/webhook", async (req, res) => {
  const raw = await readRawBody(req);
  const signature = req.headers["x-paystack-signature"];
  if (!PAYSTACK_SECRET) return send(res, 500, { ok: false, error: "Webhook secret not configured." });
  const expected = crypto.createHmac("sha512", PAYSTACK_SECRET).update(raw).digest("hex");
  const supplied = typeof signature === "string" ? signature : "";
  const validSignature = supplied.length === expected.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
  if (!validSignature) return send(res, 401, { ok: false, error: "Invalid signature." });

  let event;
  try { event = JSON.parse(raw.toString("utf8")); } catch { return send(res, 400, { ok: false, error: "Invalid JSON." }); }
  if (event.event === "charge.success") {
    const { reference, amount, customer } = event.data || {};
    if (reference && !db.isReferenceProcessed(reference)) {
      const intent = db.findPaymentIntent(reference);
      if (intent) {
        if (Number(amount) === Number(intent.amount_kobo)) db.settlePaymentIntent(reference, amount, "webhook");
      } else {
        const user = customer?.customer_code ? db.findUserByCustomerCode(customer.customer_code) : null;
        if (user && Number.isSafeInteger(Number(amount)) && Number(amount) > 0) {
          db.adjustWalletKobo(user.id, Number(amount), { kind: "wallet-fund", reference });
          db.markReferenceProcessed(reference);
          db.insertTransaction({ id: genId("tx"), userId: user.id, type: "wallet-fund", amountKobo: Number(amount), reference, date: Date.now(), via: "webhook" });
        }
      }
    }
  }
  if (event.event === "dedicatedaccount.assign.success") {
    const { customer, dedicated_account } = event.data;
    const user = customer?.customer_code ? db.findUserByCustomerCode(customer.customer_code) : null;
    if (user && dedicated_account) {
      db.setDvaActive(user.id, {
        accountNumber: dedicated_account.account_number,
        bankName: dedicated_account.bank?.name || "",
        accountName: dedicated_account.account_name || ""
      });
    }
  }
  if (event.event === "dedicatedaccount.assign.failed") {
    const { customer } = event.data;
    const user = customer?.customer_code ? db.findUserByCustomerCode(customer.customer_code) : null;
    if (user) db.setDvaFailed(user.id);
  }
  if (event.event === "transfer.failed" || event.event === "transfer.reversed") {
    // A payout we already debited from the wallet didn't go through — refund it.
    const { reference, amount } = event.data;
    const tx = db.findPendingPayout(reference);
    if (tx) {
      db.failPayoutAndRefund(tx.id);
    }
  }
  if (event.event === "transfer.success") {
    const tx = db.findPendingPayout(event.data.reference);
    if (tx) db.setTransactionStatus(tx.id, "success");
  }
  send(res, 200, { ok: true });
});

// ---- admin: stock ----
route("POST", "/api/admin/stock", async (req, res) => {
  const user = getAuthUser(req);
  if (!isAdmin(user)) return send(res, 403, { ok: false, error: "Admin access required." });
  const { network, denom, qty } = await readJSON(req);
  const d = Number(denom);
  const q = Number(qty);
  if (!Number.isInteger(q) || q < 1 || q > 5000) return send(res, 400, { ok: false, error: "Quantity must be a whole number between 1 and 5,000." });
  if (!NETWORKS.includes(network) || !DENOMS.includes(d)) {
    return send(res, 400, { ok: false, error: "Unknown network or denomination." });
  }
  const { pins, stock: newCount } = db.addPins(network, d, q);
  send(res, 200, { ok: true, stock: newCount, pins });
});

// ---- admin: users ----
route("GET", "/api/admin/users", async (req, res) => {
  const user = getAuthUser(req);
  if (!isAdmin(user)) return send(res, 403, { ok: false, error: "Admin access required." });
  send(res, 200, { ok: true, users: db.listUsers().map(publicUser) });
});

// Ledger-only wallet credit — no real money moves. Use for manual top-ups.
route("POST", "/api/admin/credit", async (req, res) => {
  const admin = getAuthUser(req);
  if (!isAdmin(admin)) return send(res, 403, { ok: false, error: "Admin access required." });
  const { userId, amount } = await readJSON(req);
  const target = db.findUserById(userId);
  if (!target) return send(res, 404, { ok: false, error: "User not found." });
  const amt = Number(amount);
  const amtKobo = Math.round(amt * 100);
  if (!Number.isFinite(amt) || !Number.isSafeInteger(amtKobo) || amtKobo < 100 || amtKobo > 50_000_000) return send(res, 400, { ok: false, error: "Credit must be between ₦1 and ₦500,000." });
  const updated = db.adjustWalletWithTransactionKobo(target.id, amtKobo, { id: genId("tx"), userId: target.id, type: "admin-credit", amountKobo: amtKobo, byUser: admin.id, date: Date.now() });
  send(res, 200, { ok: true, wallet: updated.wallet });
});

// Ledger-only refund — same mechanics as credit, tagged separately so it's
// distinguishable in reports from a manual top-up.
route("POST", "/api/admin/refund", async (req, res) => {
  const admin = getAuthUser(req);
  if (!isAdmin(admin)) return send(res, 403, { ok: false, error: "Admin access required." });
  const { userId, amount, reason } = await readJSON(req);
  const target = db.findUserById(userId);
  if (!target) return send(res, 404, { ok: false, error: "User not found." });
  const amt = Number(amount);
  const amtKobo = Math.round(amt * 100);
  if (!Number.isFinite(amt) || !Number.isSafeInteger(amtKobo) || amtKobo < 100 || amtKobo > 50_000_000) return send(res, 400, { ok: false, error: "Refund must be between ₦1 and ₦500,000." });
  const updated = db.adjustWalletWithTransactionKobo(target.id, amtKobo, { id: genId("tx"), userId: target.id, type: "refund", amountKobo: amtKobo, reason: String(reason || "").slice(0, 500), byUser: admin.id, date: Date.now() });
  send(res, 200, { ok: true, wallet: updated.wallet });
});

// ---- super admin: access control ----
route("POST", "/api/admin/access", async (req, res) => {
  const actor = getAuthUser(req);
  if (!isSuperAdmin(actor)) return send(res, 403, { ok: false, error: "Only the super admin can change access levels." });
  const { userId, role } = await readJSON(req);
  const target = db.findUserById(userId);
  if (!target) return send(res, 404, { ok: false, error: "User not found." });
  if (target.id === actor.id) return send(res, 400, { ok: false, error: "You can't change your own access level." });
  if (!Object.values(ROLES).includes(role)) return send(res, 400, { ok: false, error: "Unknown role." });
  if (target.role === ROLES.SUPERADMIN && role !== ROLES.SUPERADMIN) {
    if (db.countSuperAdmins(target.id) === 0) return send(res, 400, { ok: false, error: "At least one super admin must remain." });
  }
  const updated = db.setUserRole(target.id, role);
  send(res, 200, { ok: true, user: publicUser(updated) });
});

// ---- super admin: real payouts (money leaving the platform) ----
route("POST", "/api/admin/payout", async (req, res) => {
  const actor = getAuthUser(req);
  if (!isSuperAdmin(actor)) return send(res, 403, { ok: false, error: "Only the super admin can send payouts." });
  const { userId, amount, accountNumber, bankCode, accountName } = await readJSON(req);
  const target = db.findUserById(userId);
  if (!target) return send(res, 404, { ok: false, error: "User not found." });
  const amt = Number(amount);
  const amtKobo = Math.round(amt * 100);
  if (!Number.isFinite(amt) || !Number.isSafeInteger(amtKobo) || amtKobo < 100 || amtKobo > 50_000_000) return send(res, 400, { ok: false, error: "Payout amount must be between ₦1 and ₦500,000." });
  if (!accountNumber || !/^\d{10}$/.test(String(accountNumber)) || !bankCode) return send(res, 400, { ok: false, error: "A valid 10-digit account number and bank code are required." });

  const reference = genId("payout");
  const txId = genId("tx");
  const reserved = db.createPayoutReservation(target.id, amtKobo, { id: txId, userId: target.id, type: "payout", reference, status: "pending", byUser: actor.id, date: Date.now() });
  if (!reserved) return send(res, 402, { ok: false, error: "User's wallet balance is lower than the payout amount." });
  const payoutTx = db.findPendingPayout(reference);
  try {
    const recipient = await paystackRequest("POST", "/transferrecipient", {
      type: "nuban", name: accountName || target.name,
      account_number: accountNumber, bank_code: bankCode, currency: "NGN"
    });
    if (recipient.status >= 400 || !recipient.body.status) {
      db.failPayoutAndRefund(payoutTx.id);
      return send(res, 502, { ok: false, error: recipient.body.message || "Could not create transfer recipient." });
    }
    const transfer = await paystackRequest("POST", "/transfer", {
      source: "balance", amount: amtKobo,
      recipient: recipient.body.data.recipient_code,
      reason: `IB-TECH payout to ${target.name}`, reference
    });
    if (transfer.status >= 400 || !transfer.body.status) {
      db.failPayoutAndRefund(payoutTx.id);
      return send(res, 502, { ok: false, error: transfer.body.message || "Paystack rejected the transfer." });
    }
    const updated = db.findUserById(target.id);
    send(res, 200, { ok: true, reference, wallet: Number(updated.wallet_kobo) / 100, paystackStatus: transfer.body.data.status });
  } catch (e) {
    send(res, 500, { ok: false, error: e.message });
  }
});

// Optional helper for building a bank picker in the admin UI.
route("GET", "/api/admin/banks", async (req, res) => {
  const user = getAuthUser(req);
  if (!isSuperAdmin(user)) return send(res, 403, { ok: false, error: "Only the super admin can view this." });
  try {
    const r = await paystackRequest("GET", "/bank?currency=NGN");
    send(res, 200, { ok: true, banks: r.body.data || [] });
  } catch (e) {
    send(res, 500, { ok: false, error: e.message });
  }
});

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, {});
  const [pathname, qs] = req.url.split("?");
  const query = Object.fromEntries(new URLSearchParams(qs || ""));
  const match = routes.find(r => r.method === req.method && r.pattern === pathname);
  if (!match) return send(res, 404, { ok: false, error: "No such route." });

  try {
    await match.handler(req, res, query);
  } catch (e) {
    console.error(e);
    send(res, 500, { ok: false, error: "Internal server error." });
  }
});

server.listen(PORT, () => {
  console.log(`IB-TECH backend listening on http://localhost:${PORT}`);
  console.log("Storage: SQLite (server/ibtech.db)");
  console.log(PAYSTACK_SECRET ? "Paystack secret key detected — real payments enabled." : "No PAYSTACK_SECRET_KEY set — wallet/payout routes will return a clear error until you add one.");
});
