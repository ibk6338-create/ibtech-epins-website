# IB-TECH ePINs backend (reference implementation)

A real server for the IB-TECH ePINs portal — no framework, and the only
dependency is Node itself. It replaces the browser's `localStorage` with
real SQLite storage, issues real login sessions, and (once you add a
Paystack secret key) handles real wallet funding, refunds, and payouts.

**Storage: SQLite**, via Node's built-in `node:sqlite` module — so there's
still nothing to `npm install`. Every write that matters (drawing pins for
a print, adjusting a wallet) runs inside a real database transaction, so
two requests landing at the same instant can't corrupt each other's data
or oversell stock. This was tested directly: 50 simultaneous print
requests against 47 available pins correctly succeeded exactly 47 times,
failed exactly 3 times, and left stock at precisely 0 — never negative,
never double-counted.

This is still a **reference implementation**, not a full production
deployment: it's a single SQLite file on one machine's disk, and session
tokens live in that same file. That's genuinely fine for a small-to-medium
operation — SQLite handles far more load than people expect — but if you
outgrow a single server, that's the point to move to Postgres/MySQL and a
proper session store (Redis, or signed JWTs). The request/response shape
won't need to change either way.

## Node version note

`node:sqlite` is a fairly new addition. This was built and tested against
**Node v22.22**. If you're on an older Node 22.x (22.5–22.11), you may need
to run it as `node --experimental-sqlite server.js`. Node 18/20 don't have
this module at all — upgrade first (`node --version` to check).

## Quick start

```bash
cd server
cp .env.example .env      # then edit .env if you have a Paystack secret key
node server.js
```

No `npm install` needed. You should see:
```
IB-TECH ePINs backend listening on http://localhost:3000
Storage: SQLite (server/ibtech.db)
No PAYSTACK_SECRET_KEY set — wallet/payout routes will return a clear error until you add one.
```

`server/ibtech.db` is created automatically on first run. On a production
fresh database, set `ADMIN_EMAIL` and `ADMIN_PASSWORD` (minimum 12 characters)
before starting the server; insecure default admin credentials are refused.

Delete `ibtech.db` (and the `-wal`/`-shm` files next to it, if present) only
when you intentionally want to reset the database.

## Code layout

- `lib.js` — pure helpers (password hashing, ID/pin generation, pricing). No I/O.
- `db.js` — every SQL statement lives here. Exposes plain functions like `db.drawPins(...)`; nothing outside this file writes SQL.
- `server.js` — HTTP only: routing, auth checks, request/response shaping, and the Paystack calls.

## Try it with curl

```bash
# Sign up a reseller
curl -s -X POST http://localhost:3000/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"name":"Ibrahim Kankia","business":"Kankia Recharge Stores","email":"demo@ibtech.com","phone":"08011112222","password":"StrongPass123!"}'
# -> { "ok": true, "token": "tok_...", "user": {...} }

# Log in as the super admin (use the ADMIN_EMAIL / ADMIN_PASSWORD you configured)
curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"identifier":"YOUR_ADMIN_EMAIL","password":"YOUR_ADMIN_PASSWORD"}'
# -> save the returned token as ADMIN_TOKEN

# Grant a user admin access (super admin only)
curl -s -X POST http://localhost:3000/api/admin/access \
  -H "Authorization: Bearer ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"userId":"u_...","role":"admin"}'

# Credit a wallet manually (ledger only, no real money)
curl -s -X POST http://localhost:3000/api/admin/credit \
  -H "Authorization: Bearer ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"userId":"u_...","amount":5000}'

# Print a batch of cards as that user
curl -s -X POST http://localhost:3000/api/print \
  -H "Authorization: Bearer USER_TOKEN" -H "Content-Type: application/json" \
  -d '{"network":"MTN","denom":500,"qty":2}'
```

## Endpoints

| Method | Path | Auth | What it does |
|---|---|---|---|
| POST | `/api/auth/signup` | — | Create a reseller account (email, phone, or both — see below) |
| POST | `/api/auth/login` | — | Get a session token — `identifier` can be an email or a phone number |
| POST | `/api/auth/logout` | token | Invalidate the token |
| GET | `/api/me` | token | Current user |
| GET | `/api/stock` | — | Stock counts per network/denomination |
| POST | `/api/print` | token | Debit wallet, atomically draw pins, log a transaction |
| GET | `/api/transactions` | token | Own transactions (`?all=1` for admins) |
| POST | `/api/wallet/initiate` | token | Start a real Paystack payment |
| POST | `/api/wallet/verify` | token | Confirm a payment and credit the wallet |
| POST | `/api/paystack/webhook` | signature | Source-of-truth events from Paystack |
| POST | `/api/admin/stock` | admin | Add e-pins to stock |
| GET | `/api/admin/users` | admin | List all users |
| POST | `/api/admin/credit` | admin | Ledger-only wallet top-up |
| POST | `/api/admin/refund` | admin | Ledger-only refund back into a wallet |
| POST | `/api/admin/access` | **super admin** | Grant or revoke admin access |
| POST | `/api/admin/payout` | **super admin** | Send real money to a bank account (Paystack Transfer) |
| GET | `/api/admin/banks` | **super admin** | List banks, for a payout form's dropdown |

The front end (`js/api.js`, one folder up) already speaks this exact
contract — the dashboards work against this server as-is.

## Signing up with email, phone, or both

A user only needs to give **one** of email or phone at signup — not both.
If they skip email, the server stores an internal placeholder
(`<digits>@phone.ibtech.local`) in the (required, unique) email column so
the schema doesn't need to change, but `publicUser()` always reports that
account's `email` as `null` — the placeholder never reaches the client or
gets emailed anything. Login, in turn, accepts either an email or a phone
number in the same `identifier` field.

The one thing this doesn't give you for free: password-reset-by-email and
Paystack card-payment email receipts both need a real email, so
phone-only accounts fall back to the on-screen reset token and won't get
an email receipt from Paystack.

## Payouts need a live/test Paystack balance

`/api/admin/payout` calls Paystack's real Transfer API. In **test mode**
transfers always report success without moving real money — useful for
building the flow. In **live mode** it needs an actual balance in your
Paystack account and a verified recipient bank account. Rely on the
`/api/paystack/webhook` events (`transfer.success` / `transfer.failed`)
for the final word on whether a payout went through — the initial API
response only means the request was accepted, not that money has moved.

## Deploying

Any host that runs a persistent Node process works — this is a plain
`http.createServer`, not tied to any platform's serverless model (SQLite
needs a writable, persistent disk, which rules out most serverless
functions anyway). Reasonable starting points: a small VPS (systemd
service or `pm2 start server.js`), Railway, Render, or Fly.io. Whichever
you pick:

1. Set `PAYSTACK_SECRET_KEY` (and `RESEND_API_KEY`/`RESEND_FROM_EMAIL` if you want real reset emails) as environment variables — never a committed `.env` file.
2. Back up the SQLite file regularly — it's the entire database.
3. Point `js/api.js`'s `CONFIG.apiBase` (or the `window.IBT_API_BASE` global, set before `js/api.js` loads) at the deployed URL instead of the current default.
4. Set `FRONTEND_ORIGIN` to the exact browser origin that hosts the front end. CORS is restricted by default; do not change it back to `*`.
5. Set `ADMIN_EMAIL` and a strong `ADMIN_PASSWORD` before initializing a production database.
6. Use HTTPS at the public edge and keep the SQLite database on persistent storage with regular backups.

## Deploying to Railway

This repo already includes everything Railway needs to auto-detect and
build it correctly: `railway.json` (build/start/healthcheck config),
`nixpacks.toml` (pins the Node version so `node:sqlite` is guaranteed to
be available), and `.nvmrc` as a second signal for the same thing.

**The one thing that needs manual setup: a persistent volume.** Railway's
container filesystem is wiped on every redeploy — without a volume, your
whole database (users, wallets, stock, transaction history) would reset
every time you push a change. `db.js` already supports this via a
`DB_PATH` environment variable; you just need to create the volume once.

1. **Push this repo to GitHub** (or GitLab) — Railway deploys from a git repo, not a raw file upload.

2. **Create the project.** In the Railway dashboard: New Project → Deploy from GitHub repo → select this repo.

3. **Set the service's root directory to `server/`.** This project is a monorepo (static front end + backend in one repo) — under the service's Settings → Source, set **Root Directory** to `server`, so Railway builds only the backend and picks up `railway.json`/`nixpacks.toml` from the right place.

4. **Add a volume.** In the service's Settings → Volumes, click Add Volume. Mount path: `/data` (any path works, just be consistent with step 5).

5. **Set environment variables.** Under Variables, add:
   ```
   DB_PATH=/data/ibtech.db
   PAYSTACK_SECRET_KEY=sk_test_xxxxxxxxxxxx   (optional — leave unset to start)
   RESEND_API_KEY=                             (optional)
   RESEND_FROM_EMAIL=                          (optional)
   DVA_PREFERRED_BANK=                         (optional)
   ```
   Don't set `PORT` — Railway injects it automatically, and `server.js` already reads `process.env.PORT`.

6. **Deploy.** Railway builds via Nixpacks (using the pinned Node 22 from `nixpacks.toml`) and runs `node server.js` per `railway.json`. Watch the deploy logs for:
   ```
   IB-TECH ePINs backend listening on http://localhost:<port>
   Storage: SQLite (server/ibtech.db)
   ```
   (The path in that log line is cosmetic — it's actually reading/writing wherever `DB_PATH` points.)

7. **Get your public URL.** Settings → Networking → Generate Domain gives you something like `ibtech-backend-production.up.railway.app`. Test it: `curl https://<that-domain>/api/stock` should return the stock JSON.

8. **Point the front end at it.** Update `CONFIG.apiBase` in `js/api.js` (or set `window.IBT_API_BASE = "https://<that-domain>"` in a small `<script>` before `js/api.js` loads on each page) to that Railway URL, then redeploy/re-upload the static site wherever it's hosted.

9. **If you add a Paystack key later**, also set the webhook URL in your Paystack Dashboard (Settings → API Keys & Webhooks) to `https://<that-domain>/api/paystack/webhook` — that's what makes `/api/wallet/verify` and payout status updates reliable rather than dependent on the customer's browser staying open.

**Redeploys are safe.** Since the database lives on the volume (not in the container's own filesystem), pushing new code and letting Railway redeploy won't touch your users, wallets, or stock — only the volume's contents persist across the change, which is exactly the point of attaching it.


## Financial accounting hardening (September 2026)

Wallet balances are now calculated and persisted in **integer kobo** in `users.wallet_kobo`. The older `users.wallet` column remains synchronized only for backward compatibility with older readers.

Every wallet mutation also creates an immutable row in `wallet_ledger`, recording the kobo delta and resulting balance. Printing, wallet funding, admin credits/refunds, payout reservations, and payout refunds all use this ledger path.

Transaction records now also expose `amountKobo` and `totalKobo`. The legacy naira fields remain for frontend compatibility.

### Operational rules

- Never calculate money using the floating-point `users.wallet` field.
- Treat `wallet_kobo` as the authoritative balance.
- Do not delete or mutate `wallet_ledger` rows.
- Reconcile Paystack settlements and payout webhooks against references and ledger entries.
- Back up the SQLite database before migrations and before production upgrades.
