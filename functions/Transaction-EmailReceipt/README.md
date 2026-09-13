# Transaction-EmailReceipt

Emails an itemized receipt for a completed (or refunded) sale to a
customer-supplied email address. Used by the POS Transactions view and the
self-checkout kiosk's post-payment screen.

Separate from Appwrite's own auth-email SMTP (configured for
verification/recovery/magic-URL emails only) -- a receipt is arbitrary
custom content, so this calls Resend's plain HTTP API directly
(`POST https://api.resend.com/emails`) rather than going through Appwrite's
SMTP/Messaging subsystem. No SDK/nodemailer dependency needed, just `fetch`,
matching how every other function here calls an external API (e.g. Stripe).

## Why it is gated

A receipt carries the whole sale -- items, quantities, unit prices, discount,
tip, total and the per-leg payment breakdown -- and CCs the venue owner on
every send. Both inputs used to come straight off the request with nothing
else checked, which made this a read primitive for the entire ledger: anyone
who knew (or harvested) a transaction id could have its receipt mailed
wherever they liked. Three rules now stand in front of it:

1. **Caller identity.** The caller must hold a confirmed membership in the
   admin team, the POS team, or the `PIN Payment Access` team `Verify-Pin`
   joins a device to once a PIN is accepted. A bare anonymous session --
   which is what `execute: ["users"]` actually admits -- belongs to none of
   them and gets a 403.
2. **Recipient binding.** If the sale carries a `member_email`, that is the
   only address it can be receipted to (403 otherwise). A walk-up sale names
   nobody, so the address typed at the till is still used. Admins are exempt:
   they can read the transaction directly anyway, and the admin app resends to
   corrected addresses.
3. **Send quota.** A non-admin caller may trigger 20 sends per 15 minutes,
   counted per Appwrite user id in the shared `rate_limits` collection
   (`rcp_...` docs). Checked before the transaction is read, so the quota
   cannot be used to probe which ids exist, and the send is **reserved before
   the mail goes out** -- counting afterwards cannot cap anything, since the
   mail is already gone by the time the counter fails. The cost of that is one
   slot per Resend failure.

While `execute` is still `users`, rules 1 and 3 **are** the access control, not
a second copy of one -- so both fail closed:

- a caller whose team membership cannot be checked (no injected
  `x-appwrite-key`, or a Users API outage) gets `503`, not a pass at non-admin
  level;
- a send that cannot be counted -- either counter unreadable or unwritable --
  gets `503` and no mail.

**This requires the `users.read` and `documents.write` scopes to be granted.**
Without them the function now refuses rather than -- as it did before -- mailing
any sale's receipt anywhere with a log line. Both checks were previously dead:
with no declared scopes Appwrite injects no key, so the membership check could
never run, and with no `documents.write` every quota write threw and was
swallowed.

## Request body

```json
{ "transactionId": "...", "email": "customer@example.com" }
```

## Response

Success: `{ "ok": true }`
Failure: `{ "error": "<message>" }` with a 4xx/5xx status.

Only a transaction with `status: "complete"` or `status: "refunded"` can be
receipted -- `"pending"`/`"cancelled"` are rejected (400), since there's
nothing to receipt for those.

## Configuration

| Setting     | Value                                            |
| ----------- | ------------------------------------------------- |
| Runtime     | Node (16.0), matching the other functions          |
| Entrypoint  | `src/main.js`                                      |
| Build       | `npm i`                                            |
| Execute     | `team:68e35aed00144b8cde9d` (admin), `team:68ffcecc0026f78f0af8` (POS), `team:6a9cbb1c95ea7d59dd8c` (PIN Payment Access) -- narrowed off `users` in `appwrite.config.json`, **live until pushed**. Exactly the same three teams the in-function check enforces, so no caller the function would serve loses access. |
| Scopes      | `documents.read`, `users.read` (team check), `documents.write` (send-quota counters) -- set in `appwrite.config.json`, **must be pushed (`appwrite push functions`) or this function refuses every receipt** |

## Environment Variables

- `RESEND_API_KEY` - Resend API key (`sending_access`, scoped to the
  `mail.shotty.tech` domain). Each Appwrite function has its own secret
  vars -- this is a separate copy of the same key used for Appwrite's SMTP
  configuration, not a shared reference.

## Note on calling Appwrite's own API from within a function

This self-hosted instance's function-execution sandbox can't resolve its
own public hostname via the normal `getaddrinfo` path (used internally by
`fetch`/`http`) -- `dns.resolve4` (talks to nameservers directly, bypassing
`getaddrinfo`) works fine though. `src/appwriteClient.js` patches the
global `dns.lookup` so any HTTP client resolving this hostname gets the
known-good IP instead of hanging/`EAI_AGAIN`; the URL/Host header is
untouched, only the DNS step is bypassed. Every function that needs to call
Databases/Teams uses this same helper.
