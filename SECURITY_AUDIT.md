# IB-TECH ePINs Security & Financial Integrity Audit — Final Patch

Date: 2026-09-01

## Implemented fixes

- Paystack checkout references are bound to the authenticated user and expected kobo amount.
- Wallet balances use integer kobo (`users.wallet_kobo`) instead of floating-point arithmetic.
- Wallet changes create immutable `wallet_ledger` entries with delta and resulting balance.
- Printing reserves/debits wallet funds and claims PIN inventory in one SQLite transaction.
- Payout reservation/debit and pending transaction creation happen atomically.
- Payout failure/reversal refunds the exact recorded kobo amount.
- Payment settlement credits the exact verified kobo amount once.
- Legacy `users.wallet` remains synchronized for frontend compatibility.
- Transaction records include `amountKobo`/`totalKobo` while retaining legacy naira fields.
- Stored XSS protections from the previous patch remain in place.
- Session TTL, rate limiting, reset protections, CORS restrictions, request-size limits, and security headers remain enabled.
- Old duplicate DVA creation helper was removed.

## Verification performed

- `node --check server/db.js`
- `node --check server/server.js`
- Fresh SQLite database startup with secure admin credentials.
- Signup/login API smoke test.
- Wallet credit test: ₦1,000 -> 100,000 kobo.
- Print test: 2 × ₦97 -> 19,400 kobo debit; exact remaining balance verified.
- Overspend test rejected without changing balance.
- Concurrent print test: 10 simultaneous purchases against a ₦100 balance; exactly one ₦97 purchase succeeded and nine were rejected, leaving ₦3.
- Wallet ledger entries were verified to match the resulting balances.

## Remaining production requirements

1. Configure Paystack live/test credentials and verify checkout + webhook flows in Paystack test mode.
2. Configure a verified Resend sender/domain for password reset email.
3. Put the service behind HTTPS and set `FRONTEND_ORIGIN` to the exact production origin.
4. Back up and monitor the SQLite database on persistent storage.
5. Reconcile Paystack settlements/transfers against the wallet ledger regularly.
6. Consider moving high-volume/mission-critical financial accounting to PostgreSQL before significant scale.
