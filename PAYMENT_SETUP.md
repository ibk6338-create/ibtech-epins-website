# Connecting a real wallet + managing admin access

This site ships as a **front-end demo**: wallets, users and stock all live in
your browser's `localStorage` (see `js/app.js`). That's fine for showing the
flow, but two things need real backend work before you take money or hand
out admin accounts to real people. This file covers both — and there's now
a working backend in `server/` that already does it, so you can run it and
try it rather than just read about it.

---

## 0. The runnable backend (`server/`)

`server/server.js` is a real, tested Node backend — zero npm dependencies,
runs with just `node server.js`. It already implements everything below:
signup/login with hashed passwords and real sessions, printing that debits
a wallet server-side, ledger-only credits/refunds, role-based access
control, and Paystack wallet funding + payouts once you add a secret key.

```bash
cd server
cp .env.example .env
node server.js
```

See `server/README.md` for the full endpoint list and curl examples. The
rest of this file explains *why* it's built the way it is.

---

## 1. Merging in a real wallet (Paystack)

Paystack is the standard choice for Naira wallets and integrates in two
parts: a **public key** in the browser (safe to expose) and a **secret key**
on a server (never expose this).

### Step 1 — Get your keys
Create a Paystack account, then grab your test keys from
Settings → API Keys & Webhooks. Start with `pk_test_...` / `sk_test_...`.

### Step 2 — Turn on the front-end popup
In `js/app.js`, set:
```js
const CONFIG = {
  paystackPublicKey: "pk_test_xxxxxxxxxxxxxxxxxxxxxxxx"
};
```
The "Fund wallet" button on `user-dashboard.html` already checks for this —
once it's set, clicking it opens the real Paystack checkout instead of the
demo instant-fund buttons. No other front-end change is needed.

### Step 3 — Server-side verification is what actually matters
This is the step a lot of guides skip, and it's the one that stops people
from crediting their own wallet for free. **Never credit a wallet just
because the browser says the popup succeeded** — the browser can be edited
by anyone. `server/server.js` already does this correctly:
`/api/wallet/verify` calls Paystack's Verify Transaction API with the
secret key before crediting anything, and `/api/paystack/webhook` handles
Paystack's server-to-server event as the actual source of truth — see
`server/README.md` for both.

### Step 4 — The database is already real
`server/db.js` stores everything in SQLite (`server/ibtech.db`), not a JSON
file — every wallet/stock update runs inside a real transaction, so two
requests at the same instant can't corrupt each other's data. This was
tested directly: 50 simultaneous print requests against 47 available pins
succeeded exactly 47 times and left stock at precisely 0. For very large
scale you'd eventually move to Postgres/MySQL, but SQLite comfortably
handles far more than a small-to-medium operation throws at it.

### Withdrawals / refunds
Both are already built:
- `/api/admin/refund` — ledger-only, credits a user's in-app wallet back (no bank transfer, instant).
- `/api/admin/payout` — real money out via Paystack's Transfer API, restricted to the super admin, gated behind an actual wallet-balance check so the same balance can't be paid out twice.

See `server/README.md` for the request shape of each.

---

## 2. Admin access control (already built in)

The admin dashboard now has an **Access Control** panel (`#access`) with
three access levels:

| Role | Can print cards | Can manage stock/users | Can grant/revoke admin access |
|---|---|---|---|
| **User** | ✅ | ❌ | ❌ |
| **Admin** | ❌ | ✅ | ❌ |
| **Super Admin** | ❌ | ✅ | ✅ |

Only the **super admin** account sees "Grant admin" / "Revoke admin"
buttons next to other users — this is enforced twice: the buttons are
hidden from regular admins, and `IBT.setUserRole()` itself refuses the
change if the person calling it isn't a super admin. That second check
matters more than it looks — it's what stops someone from granting
themselves access by calling the function directly from the browser
console, bypassing the UI entirely.

A few built-in safety rules:
- Nobody can change their own access level (stops accidental self-lockout).
- The last remaining super admin can't be demoted, so the account never
  ends up with zero people able to manage access.

**The default super admin** is the seeded `admin@ibtech.com` account — in
the front-end demo that's `freshDB()` in `js/app.js`; in the real backend
it's the `seed()` function in `server/db.js`. To change who that is before
first launch, edit that seed. For a site that's already live, update the
`role` column for that user directly in `server/ibtech.db` (or run an
`/api/admin/access` call as the existing super admin).
