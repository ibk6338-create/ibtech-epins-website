/* ==========================================================================
   IB-TECH — SQLite data layer
   --------------------------------------------------------------------------
   Uses Node's built-in `node:sqlite` (no npm install, but it needs a fairly
   recent Node — see the version note in server/README.md). This replaces
   the earlier db.json file: real ACID transactions, an index on stock
   lookups, and no risk of two requests corrupting the file by writing at
   the same moment.

   Every exported function here does ONE thing to the database — the intent
   is that server.js never writes raw SQL, and this file never knows about
   HTTP.
   ========================================================================== */
"use strict";
const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");
const { genId, genPin, genSerial, hashPassword } = require("./lib");

const DB_FILE = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(__dirname, "ibtech.db");
const NETWORKS = ["MTN", "GLO", "AIRTEL", "9MOBILE"];
const DENOMS = [100, 200, 500, 1000, 1500];

const isNewDatabase = !fs.existsSync(DB_FILE);
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true }); // no-op if it already exists — matters when DB_PATH points at a mounted volume
const db = new DatabaseSync(DB_FILE);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    business      TEXT,
    email         TEXT NOT NULL UNIQUE,
    phone         TEXT,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'user',
    wallet        REAL NOT NULL DEFAULT 0,
    wallet_kobo   INTEGER NOT NULL DEFAULT 0,
    avatar        TEXT,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pins (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    network  TEXT NOT NULL,
    denom    INTEGER NOT NULL,
    pin      TEXT NOT NULL,
    serial   TEXT NOT NULL,
    used     INTEGER NOT NULL DEFAULT 0,
    used_by  TEXT,
    used_at  INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_pins_available ON pins(network, denom, used);
  CREATE INDEX IF NOT EXISTS idx_pins_used_by ON pins(used_by);

  CREATE TABLE IF NOT EXISTS transactions (
    id        TEXT PRIMARY KEY,
    user_id   TEXT NOT NULL,
    type      TEXT NOT NULL,
    network   TEXT,
    denom     INTEGER,
    qty       INTEGER,
    amount    REAL,
    total     REAL,
    amount_kobo INTEGER,
    total_kobo  INTEGER,
    reference TEXT,
    status    TEXT,
    reason    TEXT,
    by_user   TEXT,
    via       TEXT,
    date      INTEGER NOT NULL,
    hidden_for_user INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id);
  CREATE INDEX IF NOT EXISTS idx_tx_reference ON transactions(reference);

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS processed_references (
    reference TEXT PRIMARY KEY
  );

  CREATE TABLE IF NOT EXISTS payment_intents (
    reference   TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    amount_kobo INTEGER NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    created_at  INTEGER NOT NULL,
    settled_at  INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_payment_intents_user ON payment_intents(user_id);

  CREATE TABLE IF NOT EXISTS password_resets (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS wallet_ledger (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    kind        TEXT NOT NULL,
    delta_kobo  INTEGER NOT NULL,
    balance_kobo INTEGER NOT NULL,
    reference   TEXT,
    tx_id       TEXT,
    by_user     TEXT,
    created_at  INTEGER NOT NULL,
    metadata    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_wallet_ledger_user ON wallet_ledger(user_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_wallet_ledger_reference ON wallet_ledger(reference);
`);

// Migration for databases created before the "avatar" column existed —
// CREATE TABLE IF NOT EXISTS above only helps on a fresh DB_FILE.
try { db.exec("ALTER TABLE users ADD COLUMN avatar TEXT"); } catch (e) { /* column already exists */ }
try { db.exec("ALTER TABLE users ADD COLUMN wallet_kobo INTEGER NOT NULL DEFAULT 0"); } catch (e) { /* column already exists */ }
try { db.exec("ALTER TABLE transactions ADD COLUMN amount_kobo INTEGER"); } catch (e) { /* column already exists */ }
try { db.exec("ALTER TABLE transactions ADD COLUMN total_kobo INTEGER"); } catch (e) { /* column already exists */ }
// One-time migration from the old floating-point wallet column. All new
// financial mutations use integer kobo; `wallet` remains only as a legacy
// compatibility field for older database readers.
db.exec("UPDATE users SET wallet_kobo = ROUND(wallet * 100) WHERE wallet_kobo = 0 AND wallet <> 0");
db.exec("UPDATE transactions SET amount_kobo = ROUND(amount * 100) WHERE amount_kobo IS NULL AND amount IS NOT NULL");
db.exec("UPDATE transactions SET total_kobo = ROUND(total * 100) WHERE total_kobo IS NULL AND total IS NOT NULL");
try { db.exec("ALTER TABLE transactions ADD COLUMN hidden_for_user INTEGER NOT NULL DEFAULT 0"); } catch (e) { /* column already exists */ }

// Migration for databases created before dedicated virtual accounts existed.
try { db.exec("ALTER TABLE users ADD COLUMN paystack_customer_code TEXT"); } catch (e) { /* already exists */ }
try { db.exec("ALTER TABLE users ADD COLUMN dva_status TEXT NOT NULL DEFAULT 'none'"); } catch (e) { /* already exists */ }
try { db.exec("ALTER TABLE users ADD COLUMN dva_account_number TEXT"); } catch (e) { /* already exists */ }
try { db.exec("ALTER TABLE users ADD COLUMN dva_bank_name TEXT"); } catch (e) { /* already exists */ }
try { db.exec("ALTER TABLE users ADD COLUMN dva_account_name TEXT"); } catch (e) { /* already exists */ }

if (isNewDatabase) seed();

function seed() {
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminEmail || !adminPassword || adminPassword.length < 12) {
    if (process.env.NODE_ENV === "production") throw new Error("Fresh database requires ADMIN_EMAIL and ADMIN_PASSWORD (minimum 12 characters). Refusing insecure default admin credentials.");
    console.warn("WARNING: Fresh database has no secure ADMIN_EMAIL/ADMIN_PASSWORD. Set them in .env before using the admin account.");
    return;
  }
  db.prepare(`
    INSERT INTO users (id, name, business, email, phone, password_hash, role, wallet, wallet_kobo, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'superadmin', 0, 0, ?)
  `).run("u_admin", "IB-TECH Admin", "IB-TECH Head Office", adminEmail.trim().toLowerCase(), "", hashPassword(adminPassword), Date.now());

  const insertPin = db.prepare("INSERT INTO pins (network, denom, pin, serial) VALUES (?, ?, ?, ?)");
  db.exec("BEGIN");
  try {
    NETWORKS.forEach(net => DENOMS.forEach(denom => {
      for (let i = 0; i < 40; i++) insertPin.run(net, denom, genPin(), genSerial());
    }));
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------
function findUserByEmail(email) {
  return db.prepare("SELECT * FROM users WHERE lower(email) = lower(?)").get(email) || null;
}
function findUserById(id) {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) || null;
}
function findUserByPhone(phone) {
  if (!phone) return null;
  return db.prepare("SELECT * FROM users WHERE phone = ?").get(phone) || null;
}
function createUser({ name, business, email, phone, passwordHash }) {
  const id = genId("u");
  const createdAt = Date.now();
  db.prepare(`
    INSERT INTO users (id, name, business, email, phone, password_hash, role, wallet, wallet_kobo, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'user', 0, 0, ?)
  `).run(id, name, business || "—", email, phone || "", passwordHash, createdAt);
  return findUserById(id);
}
function listUsers() {
  return db.prepare("SELECT * FROM users ORDER BY created_at ASC").all();
}
// Financial balances are stored as integer kobo. The legacy `wallet` column is
// kept synchronized for compatibility with older data/tools, but must never be
// used for calculations. Every balance mutation also appends an immutable
// wallet_ledger row.
function walletNaira(kobo) { return Number(kobo) / 100; }
function syncLegacyWallet(userId, kobo) {
  db.prepare("UPDATE users SET wallet_kobo = ?, wallet = ? WHERE id = ?").run(kobo, walletNaira(kobo), userId);
}
function recordWalletLedger(userId, deltaKobo, balanceKobo, meta = {}) {
  db.prepare(`
    INSERT INTO wallet_ledger (id, user_id, kind, delta_kobo, balance_kobo, reference, tx_id, by_user, created_at, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    genId("led"), userId, meta.kind || "adjustment", Math.trunc(deltaKobo), Math.trunc(balanceKobo),
    meta.reference || null, meta.txId || null, meta.byUser || null, Date.now(),
    meta.metadata ? JSON.stringify(meta.metadata) : null
  );
}
function adjustWalletKobo(userId, deltaKobo, meta = {}) {
  const delta = Number(deltaKobo);
  if (!Number.isSafeInteger(delta) || delta === 0) throw new Error("Wallet delta must be a non-zero integer number of kobo.");
  const row = db.prepare("SELECT wallet_kobo FROM users WHERE id = ?").get(userId);
  if (!row) return null;
  const next = Number(row.wallet_kobo) + delta;
  if (!Number.isSafeInteger(next) || next < 0) return null;
  syncLegacyWallet(userId, next);
  recordWalletLedger(userId, delta, next, meta);
  return findUserById(userId);
}
function adjustWallet(userId, deltaNaira, meta = {}) {
  const deltaKobo = Math.round(Number(deltaNaira) * 100);
  if (!Number.isSafeInteger(deltaKobo)) throw new Error("Wallet amount is invalid.");
  return adjustWalletKobo(userId, deltaKobo, meta);
}
function debitWalletIfSufficientKobo(userId, amountKobo, meta = {}) {
  const amount = Number(amountKobo);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("Wallet debit must be a positive integer number of kobo.");
  const result = db.prepare(`
    UPDATE users SET wallet_kobo = wallet_kobo - ?, wallet = (wallet_kobo - ?) / 100.0
    WHERE id = ? AND wallet_kobo >= ?
  `).run(amount, amount, userId, amount);
  if (result.changes !== 1) return null;
  const row = findUserById(userId);
  recordWalletLedger(userId, -amount, row.wallet_kobo, meta);
  return row;
}
function debitWalletIfSufficient(userId, amountNaira, meta = {}) {
  return debitWalletIfSufficientKobo(userId, Math.round(Number(amountNaira) * 100), meta);
}

function setUserRole(userId, role) {
  db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, userId);
  return findUserById(userId);
}
function setUserAvatar(userId, dataUrl) {
  db.prepare("UPDATE users SET avatar = ? WHERE id = ?").run(dataUrl, userId);
  return findUserById(userId);
}
function setUserPassword(userId, passwordHash) {
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, userId);
  return findUserById(userId);
}
function countSuperAdmins(excludingId) {
  return db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'superadmin' AND id != ?").get(excludingId).n;
}

// ---------------------------------------------------------------------------
// dedicated virtual accounts (Paystack) — a permanent bank account number
// per user, so they can fund their wallet by transfer at any time.
// ---------------------------------------------------------------------------
function setCustomerCode(userId, customerCode) {
  db.prepare("UPDATE users SET paystack_customer_code = ? WHERE id = ?").run(customerCode, userId);
  return findUserById(userId);
}
function setDvaPending(userId) {
  db.prepare("UPDATE users SET dva_status = 'pending' WHERE id = ?").run(userId);
  return findUserById(userId);
}
function claimDvaCreation(userId) {
  const result = db.prepare("UPDATE users SET dva_status = 'pending' WHERE id = ? AND COALESCE(dva_status, 'none') = 'none'").run(userId);
  return result.changes === 1;
}
function setDvaActive(userId, { accountNumber, bankName, accountName }) {
  db.prepare(`
    UPDATE users SET dva_status = 'active', dva_account_number = ?, dva_bank_name = ?, dva_account_name = ?
    WHERE id = ?
  `).run(accountNumber, bankName, accountName, userId);
  return findUserById(userId);
}
function setDvaFailed(userId) {
  db.prepare("UPDATE users SET dva_status = 'failed' WHERE id = ?").run(userId);
  return findUserById(userId);
}
function findUserByCustomerCode(customerCode) {
  return db.prepare("SELECT * FROM users WHERE paystack_customer_code = ?").get(customerCode) || null;
}

// ---------------------------------------------------------------------------
// stock / pins
// ---------------------------------------------------------------------------
function stockCount(network, denom) {
  return db.prepare("SELECT COUNT(*) AS n FROM pins WHERE network = ? AND denom = ? AND used = 0").get(network, denom).n;
}
function stockSnapshot() {
  const out = {};
  NETWORKS.forEach(n => { out[n] = {}; DENOMS.forEach(d => out[n][d] = stockCount(n, d)); });
  return out;
}
// Returns both the freshly generated pins (so the caller can show/print/
// export exactly this batch) and the new total stock count.
function addPins(network, denom, qty) {
  const insert = db.prepare("INSERT INTO pins (network, denom, pin, serial) VALUES (?, ?, ?, ?)");
  const generated = [];
  db.exec("BEGIN");
  try {
    for (let i = 0; i < qty; i++) {
      const pin = genPin(), serial = genSerial();
      insert.run(network, denom, pin, serial);
      generated.push({ pin, serial });
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return { pins: generated, stock: stockCount(network, denom) };
}
// Atomically claims `qty` unused pins for a transaction, or claims nothing
// at all if there aren't enough — never hands out half a batch.
function purchasePins(userId, network, denom, qty, unitCostKobo, txId) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const user = findUserById(userId);
    const unit = Number(unitCostKobo);
    const total = unit * Number(qty);
    if (!user || !Number.isSafeInteger(unit) || !Number.isSafeInteger(total) || user.wallet_kobo < total) {
      db.exec("ROLLBACK");
      return { ok: false, reason: "insufficient_funds", wallet: user ? walletNaira(user.wallet_kobo) : 0 };
    }
    const rows = db.prepare("SELECT id, pin, serial FROM pins WHERE network = ? AND denom = ? AND used = 0 LIMIT ?").all(network, denom, qty);
    if (rows.length < qty) { db.exec("ROLLBACK"); return { ok: false, reason: "out_of_stock", stock: stockCount(network, denom) }; }
    const debit = db.prepare(`UPDATE users SET wallet_kobo = wallet_kobo - ?, wallet = (wallet_kobo - ?) / 100.0 WHERE id = ? AND wallet_kobo >= ?`).run(total, total, userId, total);
    if (debit.changes !== 1) { db.exec("ROLLBACK"); return { ok: false, reason: "insufficient_funds", wallet: walletNaira(findUserById(userId)?.wallet_kobo ?? 0) }; }
    const after = findUserById(userId);
    recordWalletLedger(userId, -total, after.wallet_kobo, { kind: "print", txId });
    const claim = db.prepare("UPDATE pins SET used = 1, used_by = ?, used_at = ? WHERE id = ?");
    const now = Date.now();
    rows.forEach(r => claim.run(txId, now, r.id));
    insertTransaction({ id: txId, userId, type: "print", network, denom, qty, totalKobo: total, date: now });
    db.exec("COMMIT");
    return { ok: true, cards: rows.map(r => ({ pin: r.pin, serial: r.serial })), wallet: walletNaira(after.wallet_kobo) };
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}

function drawPins(network, denom, qty, txId) {
  db.exec("BEGIN");
  try {
    const rows = db.prepare("SELECT id, pin, serial FROM pins WHERE network = ? AND denom = ? AND used = 0 LIMIT ?").all(network, denom, qty);
    if (rows.length < qty) { db.exec("ROLLBACK"); return null; }
    const claim = db.prepare("UPDATE pins SET used = 1, used_by = ?, used_at = ? WHERE id = ?");
    const now = Date.now();
    rows.forEach(r => claim.run(txId, now, r.id));
    db.exec("COMMIT");
    return rows.map(r => ({ pin: r.pin, serial: r.serial }));
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}
function cardsForTransaction(txId) {
  return db.prepare("SELECT pin, serial FROM pins WHERE used_by = ?").all(txId);
}

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
function createSession(userId) {
  const token = "tok_" + require("crypto").randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)").run(token, userId, Date.now());
  return token;
}
function userIdForSession(token) {
  const row = db.prepare("SELECT user_id, created_at FROM sessions WHERE token = ?").get(token);
  if (!row) return null;
  if (row.created_at + SESSION_TTL_MS < Date.now()) { deleteSession(token); return null; }
  return row.user_id;
}
function deleteAllSessionsForUser(userId) {
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}
function deleteSession(token) {
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

// ---------------------------------------------------------------------------
// password resets
// ---------------------------------------------------------------------------
const RESET_TTL_MS = 30 * 60 * 1000; // 30 minutes
function createPasswordReset(userId) {
  const token = "reset_" + require("crypto").randomBytes(32).toString("hex");
  db.prepare("INSERT INTO password_resets (token, user_id, expires_at) VALUES (?, ?, ?)")
    .run(token, userId, Date.now() + RESET_TTL_MS);
  return token;
}
// Returns the user_id for a still-valid token, or null if it's missing/expired.
function findPasswordReset(token) {
  const row = db.prepare("SELECT * FROM password_resets WHERE token = ?").get(token);
  if (!row) return null;
  if (row.expires_at < Date.now()) { deletePasswordReset(token); return null; }
  return row;
}
function deletePasswordReset(token) {
  db.prepare("DELETE FROM password_resets WHERE token = ?").run(token);
}

// ---------------------------------------------------------------------------
// payment intents — binds a Paystack checkout reference to its owner and
// expected amount before any real-money transaction can be settled.
// ---------------------------------------------------------------------------
function createPaymentIntent(reference, userId, amountKobo) {
  db.prepare(`INSERT INTO payment_intents (reference, user_id, amount_kobo, status, created_at) VALUES (?, ?, ?, 'pending', ?)` )
    .run(reference, userId, amountKobo, Date.now());
  return db.prepare("SELECT * FROM payment_intents WHERE reference = ?").get(reference);
}
function findPaymentIntent(reference) {
  return db.prepare("SELECT * FROM payment_intents WHERE reference = ?").get(reference) || null;
}
function settlePaymentIntent(reference, actualAmountKobo, via = "checkout") {
  db.exec("BEGIN");
  try {
    const intent = findPaymentIntent(reference);
    if (!intent || intent.status !== "pending") { db.exec("ROLLBACK"); return { ok: false, reason: "missing_or_settled" }; }
    if (Number(actualAmountKobo) !== Number(intent.amount_kobo)) { db.exec("ROLLBACK"); return { ok: false, reason: "amount_mismatch" }; }
    const amountKobo = Number(actualAmountKobo);
    if (!Number.isSafeInteger(amountKobo) || amountKobo <= 0) { db.exec("ROLLBACK"); return { ok: false, reason: "invalid_amount" }; }
    const updated = adjustWalletKobo(intent.user_id, amountKobo, { kind: "wallet-fund", reference });
    if (!updated) { db.exec("ROLLBACK"); return { ok: false, reason: "user_missing" }; }
    db.prepare("UPDATE payment_intents SET status = 'success', settled_at = ? WHERE reference = ? AND status = 'pending'").run(Date.now(), reference);
    markReferenceProcessed(reference);
    insertTransaction({ id: genId("tx"), userId: intent.user_id, type: "wallet-fund", amountKobo, reference, date: Date.now(), via });
    db.exec("COMMIT");
    return { ok: true, userId: intent.user_id, amount: walletNaira(amountKobo), wallet: walletNaira(updated.wallet_kobo) };
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}

// ---------------------------------------------------------------------------
// transactions
// ---------------------------------------------------------------------------
function insertTransaction(tx) {
  const amountKobo = tx.amountKobo != null ? Number(tx.amountKobo) : (tx.amount != null ? Math.round(Number(tx.amount) * 100) : null);
  const totalKobo = tx.totalKobo != null ? Number(tx.totalKobo) : (tx.total != null ? Math.round(Number(tx.total) * 100) : null);
  db.prepare(`
    INSERT INTO transactions (id, user_id, type, network, denom, qty, amount, total, amount_kobo, total_kobo, reference, status, reason, by_user, via, date)
    VALUES (@id, @userId, @type, @network, @denom, @qty, @amount, @total, @amountKobo, @totalKobo, @reference, @status, @reason, @byUser, @via, @date)
  `).run({
    id: tx.id, userId: tx.userId, type: tx.type, network: tx.network ?? null, denom: tx.denom ?? null, qty: tx.qty ?? null,
    amount: amountKobo == null ? null : walletNaira(amountKobo), total: totalKobo == null ? null : walletNaira(totalKobo),
    amountKobo, totalKobo, reference: tx.reference ?? null, status: tx.status ?? null, reason: tx.reason ?? null, byUser: tx.byUser ?? null,
    via: tx.via ?? null, date: tx.date
  });
  return tx.id;
}

function transactionsForUser(userId) {
  const rows = db.prepare("SELECT * FROM transactions WHERE user_id = ? AND hidden_for_user = 0 ORDER BY date DESC").all(userId);
  return rows.map(hydrateTransaction);
}
function allTransactions() {
  const rows = db.prepare("SELECT * FROM transactions ORDER BY date DESC").all();
  return rows.map(hydrateTransaction);
}
function hydrateTransaction(row) {
  const out = {
    id: row.id, userId: row.user_id, type: row.type,
    network: row.network, denom: row.denom, qty: row.qty,
    amount: row.amount_kobo == null ? row.amount : walletNaira(row.amount_kobo),
    total: row.total_kobo == null ? row.total : walletNaira(row.total_kobo),
    amountKobo: row.amount_kobo, totalKobo: row.total_kobo, reference: row.reference,
    status: row.status, reason: row.reason, byUser: row.by_user,
    via: row.via, date: row.date
  };
  if (row.type === "print") out.cards = cardsForTransaction(row.id);
  return out;
}
function findPendingPayout(reference) {
  return db.prepare("SELECT * FROM transactions WHERE type = 'payout' AND reference = ? AND status = 'pending'").get(reference) || null;
}
function setTransactionStatus(id, status) {
  db.prepare("UPDATE transactions SET status = ? WHERE id = ?").run(status, id);
}
function failPayoutAndRefund(id) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const tx = db.prepare("SELECT * FROM transactions WHERE id = ? AND type = 'payout'").get(id);
    if (!tx || tx.status !== "pending") { db.exec("ROLLBACK"); return false; }
    db.prepare("UPDATE transactions SET status = 'failed' WHERE id = ? AND status = 'pending'").run(id);
    adjustWalletKobo(tx.user_id, Number(tx.amount_kobo ?? Math.round(Number(tx.amount) * 100)), { kind: "payout-refund", reference: tx.reference, txId: tx.id });
    db.exec("COMMIT");
    return true;
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}
// Deletes a transaction record (history entry only — it does not restore
// wallet balance or un-claim any pins that were printed under it).
// Pass ownerId to scope the delete to that user's own rows (regular users);
// pass null to delete any transaction regardless of owner (admins).
function hideTransactionForUser(id, ownerId) {
  const result = db.prepare("UPDATE transactions SET hidden_for_user = 1 WHERE id = ? AND user_id = ? AND hidden_for_user = 0").run(id, ownerId);
  return result.changes > 0;
}
function adjustWalletWithTransaction(userId, deltaNaira, tx) {
  const deltaKobo = Math.round(Number(deltaNaira) * 100);
  return adjustWalletWithTransactionKobo(userId, deltaKobo, tx);
}
function adjustWalletWithTransactionKobo(userId, deltaKobo, tx) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const updated = adjustWalletKobo(userId, deltaKobo, { kind: tx.type || "adjustment", reference: tx.reference, txId: tx.id, byUser: tx.byUser });
    if (!updated) { db.exec("ROLLBACK"); return null; }
    insertTransaction({ ...tx, amountKobo: tx.amountKobo ?? Math.abs(deltaKobo) });
    db.exec("COMMIT");
    return updated;
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}
function createPayoutReservation(userId, amountKobo, tx) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const updated = debitWalletIfSufficientKobo(userId, amountKobo, { kind: "payout-reserve", reference: tx.reference, txId: tx.id, byUser: tx.byUser });
    if (!updated) { db.exec("ROLLBACK"); return null; }
    insertTransaction({ ...tx, amountKobo });
    db.exec("COMMIT");
    return updated;
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}
function walletLedgerForUser(userId) {
  return db.prepare("SELECT id, user_id AS userId, kind, delta_kobo AS deltaKobo, balance_kobo AS balanceKobo, reference, tx_id AS txId, by_user AS byUser, created_at AS createdAt, metadata FROM wallet_ledger WHERE user_id = ? ORDER BY created_at DESC").all(userId);
}

// ---------------------------------------------------------------------------
// idempotency guard for Paystack references
// ---------------------------------------------------------------------------
function isReferenceProcessed(reference) {
  return !!db.prepare("SELECT 1 FROM processed_references WHERE reference = ?").get(reference);
}
function markReferenceProcessed(reference) {
  db.prepare("INSERT OR IGNORE INTO processed_references (reference) VALUES (?)").run(reference);
}

module.exports = {
  NETWORKS, DENOMS,
  findUserByEmail, findUserByPhone, findUserById, createUser, listUsers, adjustWallet, adjustWalletKobo, debitWalletIfSufficient, debitWalletIfSufficientKobo, setUserRole, countSuperAdmins,
  setUserAvatar, setUserPassword,
  stockCount, stockSnapshot, addPins, drawPins, purchasePins, cardsForTransaction,
  createSession, userIdForSession, deleteSession, deleteAllSessionsForUser,
  createPasswordReset, findPasswordReset, deletePasswordReset,
  insertTransaction, transactionsForUser, allTransactions, findPendingPayout, setTransactionStatus, failPayoutAndRefund, hideTransactionForUser, adjustWalletWithTransaction, adjustWalletWithTransactionKobo, createPayoutReservation, walletLedgerForUser,
  isReferenceProcessed, markReferenceProcessed,
  createPaymentIntent, findPaymentIntent, settlePaymentIntent,
  setCustomerCode, setDvaPending, claimDvaCreation, setDvaActive, setDvaFailed, findUserByCustomerCode
};
