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
| Execute     | `users` (any authenticated session -- staff or a self-checkout kiosk session; not a privileged action, unlike a refund) |
| Scopes      | `documents.read`                                   |

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
