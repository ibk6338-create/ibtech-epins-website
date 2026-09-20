/* ==========================================================================
   IB-TECH front-end API client
   --------------------------------------------------------------------------
   Talks to the real backend in /server over fetch(), instead of the
   legacy client-side implementation. Same global name (IBT) so the
   dashboards' markup doesn't need to change — only their <script src="...">
   and a handful of calls that are now async.

   Change API_BASE below once your backend is deployed somewhere other than
   your own machine.
   ========================================================================== */
const IBT = (() => {
  const CONFIG = {
    apiBase: window.IBT_API_BASE || "https://ibtech-epins.onrender.com",
    paystackPublicKey: "" // e.g. "pk_test_xxxxxxxxxxxxxxxxxxxxxxxx" — see PAYMENT_SETUP.md
  };

  const NETWORKS = ["MTN", "GLO", "AIRTEL", "9MOBILE"];
  const DENOMS = [100, 200, 500, 1000, 1500];
  const ROLES = { USER: "user", ADMIN: "admin", SUPERADMIN: "superadmin" };
  // Logo files live in images/networks/ — add airtel.png there and reference
  // it below once you have that logo file.
  const NETWORK_LOGOS = {
    MTN: "images/networks/mtn.png",
    GLO: "images/networks/glo.jpeg",
    AIRTEL: "images/networks/airtel.jpg",
    "9MOBILE": "images/networks/9mobile.jpeg"
  };

  const TOKEN_KEY = "ibtech_token";
  const USER_KEY = "ibtech_user";
  const REMEMBER_KEY = "ibtech_remember_identifier";

  // "Remember me" only ever stores the email/phone the person logged in
  // with, in localStorage (which survives closing the tab) — never the
  // password. It just saves re-typing the identifier next time.
  function rememberIdentifier(identifier) { localStorage.setItem(REMEMBER_KEY, identifier); }
  function forgetIdentifier() { localStorage.removeItem(REMEMBER_KEY); }
  function getRememberedIdentifier() { return localStorage.getItem(REMEMBER_KEY) || ""; }

  function getToken() { return sessionStorage.getItem(TOKEN_KEY); }
  function setSession(token, user) {
    sessionStorage.setItem(TOKEN_KEY, token);
    sessionStorage.setItem(USER_KEY, JSON.stringify(user));
  }
  function clearSession() {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(USER_KEY);
  }
  function cachedUser() {
    try { return JSON.parse(sessionStorage.getItem(USER_KEY)); } catch { return null; }
  }

  async function request(method, path, body, { auth = true } = {}) {
    const headers = { "Content-Type": "application/json" };
    if (auth) {
      const t = getToken();
      if (t) headers["Authorization"] = "Bearer " + t;
    }
    try {
      const res = await fetch(CONFIG.apiBase + path, {
        method, headers,
        body: body !== undefined ? JSON.stringify(body) : undefined
      });
      const data = await res.json().catch(() => ({}));
      if (data.ok === undefined) return { ok: false, error: `Unexpected response (${res.status}).` };
      return data;
    } catch (e) {
      return { ok: false, error: `Could not reach the server at ${CONFIG.apiBase}. Is it running? (server/README.md)` };
    }
  }

  // ---- auth ----
  // `identifier` can be an email address or a phone number.
  async function login(identifier, password) {
    const r = await request("POST", "/api/auth/login", { identifier, password }, { auth: false });
    if (r.ok) setSession(r.token, r.user);
    return r;
  }
  async function forgotPassword(identifier) {
    return request("POST", "/api/auth/forgot", { identifier }, { auth: false });
  }
  async function resetPassword(token, password) {
    return request("POST", "/api/auth/reset", { token, password }, { auth: false });
  }
  async function signup(data) {
    const r = await request("POST", "/api/auth/signup", data, { auth: false });
    if (r.ok) setSession(r.token, r.user);
    return r;
  }
  async function logout() {
    await request("POST", "/api/auth/logout", {});
    clearSession();
  }

  // Verifies the session against the server (not just "is there a token
  // lying around") and redirects if it doesn't hold the right role.
  async function requireAuth({ admin = false, loginPage = "login.html" } = {}) {
    if (!getToken()) { window.location.href = loginPage; return null; }
    const r = await request("GET", "/api/me");
    if (!r.ok) { clearSession(); window.location.href = loginPage; return null; }
    const user = r.user;
    sessionStorage.setItem(USER_KEY, JSON.stringify(user));
    const admin_ = user.role !== ROLES.USER;
    if (admin && !admin_) { window.location.href = "user-dashboard.html"; return null; }
    if (!admin && admin_) { window.location.href = "admin-dashboard.html"; return null; }
    return user;
  }

  function isSuperAdmin(user) { return !!user && user.role === ROLES.SUPERADMIN; }

  // Pass a data URL (e.g. from a <canvas>/<input type=file>) to set the
  // profile photo, or null to remove it.
  async function updateAvatar(dataUrl) {
    const r = await request("POST", "/api/me/avatar", { image: dataUrl });
    if (r.ok) {
      const u = cachedUser();
      if (u) { u.avatar = r.avatar; sessionStorage.setItem(USER_KEY, JSON.stringify(u)); }
    }
    return r;
  }

  // ---- catalog / stock ----
  async function getStock() {
    const r = await request("GET", "/api/stock", undefined, { auth: false });
    return r.ok ? r.stock : {};
  }
  function stockCount(stock, net, denom) { return stock?.[net]?.[denom] || 0; }

  // ---- printing & transactions ----
  async function printCards({ network, denom, qty }) {
    const r = await request("POST", "/api/print", { network, denom, qty });
    if (r.ok) {
      const u = cachedUser(); if (u) { u.wallet = r.wallet; sessionStorage.setItem(USER_KEY, JSON.stringify(u)); }
    }
    return r;
  }
  async function myTransactions() {
    const r = await request("GET", "/api/transactions");
    return r.ok ? r.transactions : [];
  }
  async function allTransactions() {
    const r = await request("GET", "/api/transactions?all=1");
    return r.ok ? r.transactions : [];
  }
  async function deleteTransaction(id) {
    return request("POST", "/api/transactions/delete", { id });
  }

  // ---- wallet funding (real Paystack flow) ----
  async function walletInitiate(amount) { return request("POST", "/api/wallet/initiate", { amount }); }
  async function walletVerify(reference) {
    const r = await request("POST", "/api/wallet/verify", { reference });
    if (r.ok) {
      const u = cachedUser(); if (u) { u.wallet = r.wallet; sessionStorage.setItem(USER_KEY, JSON.stringify(u)); }
    }
    return r;
  }

  function loadPaystackScript() {
    return new Promise((resolve) => {
      if (window.PaystackPop) return resolve();
      const s = document.createElement("script");
      s.src = "https://js.paystack.co/v1/inline.js";
      s.onload = resolve;
      document.head.appendChild(s);
    });
  }

  // Real flow: ask our server to start a transaction (so it can track the
  // reference), open Paystack's popup for that same reference, then ask
  // our server to verify it — the server is the only thing that ever
  // credits the wallet.
  async function payWithPaystack({ amount, onSuccess, onClose, onError }) {
    if (!CONFIG.paystackPublicKey) {
      return { ok: false, error: "No Paystack public key configured yet — see PAYMENT_SETUP.md." };
    }
    const init = await walletInitiate(amount);
    if (!init.ok) { onError && onError(init.error); return init; }

    await loadPaystackScript();
    const user = cachedUser();
    // Phone-only accounts have no real email — fall back to the exact same
    // placeholder format the server generates at signup (see
    // PLACEHOLDER_EMAIL_DOMAIN in server.js) so this still matches the
    // account Paystack's webhook looks up by email.
    const checkoutEmail = user?.email || (user?.phone ? `${user.phone.replace(/\D/g, "")}@phone.ibtech.local` : undefined);
    const handler = window.PaystackPop.setup({
      key: CONFIG.paystackPublicKey,
      email: checkoutEmail,
      amount: Math.round(amount * 100),
      ref: init.reference,
      callback: async () => {
        const v = await walletVerify(init.reference);
        if (v.ok) onSuccess && onSuccess(v);
        else onError && onError(v.error);
      },
      onClose: () => onClose && onClose()
    });
    handler.openIframe();
    return { ok: true };
  }

  // ---- wallet funding via a permanent bank transfer account (Paystack Dedicated Virtual Account) ----
  async function getDedicatedAccount() { return request("GET", "/api/wallet/dedicated-account"); }
  async function createDedicatedAccount() { return request("POST", "/api/wallet/dedicated-account"); }

  // ---- admin ----
  // Response includes `pins` — the actual e-pins just generated in this
  // batch (not the whole stock) — so the admin panel can display/print/
  // export exactly what was created.
  async function adminAddStock({ network, denom, qty }) { return request("POST", "/api/admin/stock", { network, denom, qty }); }
  async function adminCreditWallet(userId, amount) { return request("POST", "/api/admin/credit", { userId, amount }); }
  async function adminRefund(userId, amount, reason) { return request("POST", "/api/admin/refund", { userId, amount, reason }); }
  async function adminUsers() {
    const r = await request("GET", "/api/admin/users");
    return r.ok ? r.users : [];
  }
  // Signature is (targetUserId, role) — unlike the localStorage version,
  // the acting user no longer needs to be passed in: the server reads it
  // from the session token, so it can't be spoofed from the browser.
  async function setUserRole(targetUserId, role) { return request("POST", "/api/admin/access", { userId: targetUserId, role }); }
  async function adminPayout({ userId, amount, accountNumber, bankCode, accountName }) {
    return request("POST", "/api/admin/payout", { userId, amount, accountNumber, bankCode, accountName });
  }

  // ---- formatting ----
  function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>\"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;", "'":"&#39;"}[ch]));
  }
  function fmtNaira(n) { return "₦" + Number(n).toLocaleString("en-NG", { maximumFractionDigits: 0 }); }
  function fmtDate(ts) { return new Date(ts).toLocaleString("en-NG", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }); }
  function unitPrice(denom) { return Math.round(denom * 0.97); } // mirrors the server — for display estimates only; the server is authoritative

  function toast(msg, isError = false) {
    let el = document.getElementById("ibt-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "ibt-toast";
      el.className = "toast";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.toggle("err", isError);
    el.classList.add("show");
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove("show"), 3200);
  }

  return {
    CONFIG, NETWORKS, DENOMS, ROLES, NETWORK_LOGOS,
    login, signup, logout, requireAuth, cachedUser, isSuperAdmin,
    forgotPassword, resetPassword, updateAvatar,
    rememberIdentifier, forgetIdentifier, getRememberedIdentifier,
    getStock, stockCount,
    printCards, myTransactions, allTransactions, deleteTransaction,
    walletInitiate, walletVerify, payWithPaystack,
    getDedicatedAccount, createDedicatedAccount,
    adminAddStock, adminCreditWallet, adminRefund, adminUsers, setUserRole, adminPayout,
    escapeHTML, fmtNaira, fmtDate, unitPrice, toast
  };
})();
