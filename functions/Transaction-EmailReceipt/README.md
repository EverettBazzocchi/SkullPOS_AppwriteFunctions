# Transaction-EmailReceipt

**Function ID:** `6a9cd1ed552967ba3560`

Emails an itemized receipt for a completed or refunded sale to a
customer-supplied address. Used by the POS transactions view and the
self-checkout kiosk's post-payment screen.

Sends through Resend's plain HTTP API (`POST https://api.resend.com/emails`),
not Appwrite's SMTP — Appwrite's mailer only handles its own built-in auth email
types (verification/recovery/magic-URL), and a receipt is arbitrary content.
Every send sets `everett.bazzocchi@skullspace.ca` as **Reply-To**. It is not CC'd,
so a customer replying to their receipt reaches the owner without the owner being
copied on every receipt the bar issues.

A receipt carries the whole sale: items, quantities, unit prices, discount, tip,
total and the per-leg payment breakdown. Three rules stand in front of it.

## 1. Who may call it

Live `execute` list, read from the project on 2026-09-13
(`appwrite functions get --function-id 6a9cd1ed552967ba3560`):

- `team:68e35aed00144b8cde9d` — admin
- `team:68ffcecc0026f78f0af8` — POS
- `team:6a9cbb1c95ea7d59dd8c` — PIN Payment Access

Appwrite checks that list at execution-creation time. `classifyCaller` adds one
check: no `x-appwrite-user-id` → `403`. That is the API-key-invocation case.

**No team lookup gates this function any more.** The `503`-on-unverifiable
membership check was removed in commit `02bee62`, alongside the same code in
`stripe-getConnectionToken` and `Giftcard-Lookup`.

## 2. Recipient binding

If the transaction carries a `member_email`, that is the **only** address it can
be receipted to — anything else is `403`. A membership purchase already names its
buyer, so there is no legitimate reason for a till to redirect that receipt. A
walk-up sale names nobody, so the address typed at the till is used, and rules 1
and 3 are what bound that path.

Admins are exempt (they can read the transaction directly anyway, and the admin
app resends receipts to corrected addresses).

## 3. Send quota

A non-admin caller may trigger **20 sends per 15 minutes** (`src/sendLimit.js`),
counted per `x-appwrite-user-id` as `rcp_<sha1>` documents in the shared
`rate_limits` collection.

- Checked **before** the transaction is read, so the quota cannot be used to
  probe which transaction ids exist.
- The slot is **reserved before the mail goes out**. Counting afterwards cannot
  cap anything — the mail is already gone by the time the write fails. The price
  is one wasted slot per Resend failure.
- Fails **closed** (`503`) when the counter cannot be read or written.

## Admin status is a privilege upgrade, not the authorization decision

`isAdminCaller` still calls `users.listMemberships()` — this is the one Users
lookup that remains, and it is why this function keeps `users.read` while the
other two lost it. It can only ever *grant* something extra (exemption from the
recipient binding and the send cap), so any answer other than a definitive "yes,
confirmed member of admin" degrades the caller to an ordinary till, which is the
path every POS device takes and which works end to end. It can never produce a
`503` and can never stop a receipt reaching the address the sale already names.

The one visible residual: while the Users API is failing, an admin cannot
*redirect* a member sale's receipt. That falls back to the address on the sale.

## Scopes

| Scope | Why |
| --- | --- |
| `documents.read` | Read the transaction; read the caller's `rate_limits` row. |
| `documents.write` | Write the send-quota counter. Without it the cap is decorative. |
| `users.read` | `isAdminCaller`'s `listMemberships` call. **Do not remove** — Appwrite injects the function's dynamic API key only for a function that declares scopes, and without the key this lookup cannot run at all. |

## Request body

```json
{ "transactionId": "...", "email": "customer@example.com" }
```

## Responses

| Status | Body | What it means operationally |
| --- | --- | --- |
| `200` | `{ ok: true }` | Resend accepted the message. |
| `400` | `{ error: "Invalid request body" \| "Missing transactionId" \| "A valid email address is required" }` | Malformed call. |
| `400` | `{ error: "Only a completed or refunded sale can be receipted (current status: …)" }` | The sale is `pending` or `cancelled`. There is nothing to receipt. |
| `403` | `{ error: "Unauthorized" }` | No session user — an API-key invocation. |
| `403` | `{ error: "This sale is attached to a member account…" }` | Recipient binding. Send it to the address on the sale, or do it from an admin account. |
| `404` | `{ error: "Transaction not found" }` | No such transaction id. |
| `429` | `{ error: "Too many receipts sent from this device…" }` | 20 sends in 15 minutes from this account. |
| `500` | `{ error: "Failed to send receipt email" }` | Resend returned non-2xx, or was unreachable. The execution log carries Resend's own status and body. |
| `503` | `{ error: "Receipts are temporarily unavailable — try again" }` | The send counter could not be read or written. Deliberate: an uncounted send is an uncapped mailer. |

## Environment variables

| Name | Purpose |
| --- | --- |
| `RESEND_API_KEY` | Resend API key (`sending_access`, scoped to `mail.shotty.tech`). Each function holds its own copy — Appwrite has no shared secret store. |

## Configuration

| Setting | Value |
| --- | --- |
| Runtime | `node-16.0` |
| Entrypoint | `src/main.js` |
| Build command | `npm i` |
| Timeout | 15s |
| Schedule | none |

Deploy: `appwrite push function --function-id 6a9cd1ed552967ba3560`

`node-16.0` predates global `fetch`, so `node-fetch` is a real dependency here
rather than a leftover.

## Calling Appwrite's own API from inside a function

See the DNS-patch note in `functions/Giftcard-Lookup/README.md`;
`src/appwriteClient.js` here is the same helper.
