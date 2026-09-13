# Admin-EmailDj

**Function ID:** `admin-email-dj`

Emails a DJ either their **voucher** — event name, a scannable barcode of the
gift-card code, the amount, and the usage rules — or a free-form message.

`voucher` fires automatically whenever the admin app issues a DJ a new voucher
(`djService.issueDjVoucher` in SkullAdminApp), and can be called again on demand
to resend, since a DJ can hold many vouchers (one per event).

## Who may call it

Live `execute`: **`team:68e35aed00144b8cde9d` (admin) only**. Verified 2026-09-13
with `appwrite functions get --function-id admin-email-dj`. No in-code caller
check.

## The barcode is a live bar credit, and its hosting has two rules

A base64 `data:` URI never renders in Gmail (and most clients) — they strip
inline images outright rather than prompting. So the barcode PNG is generated
with `bwip-js`, uploaded to the `voucher-barcodes` Storage bucket, and linked by
URL. Two rules govern that upload, and both are needed:

1. **The filename is never the gift-card code.** Appwrite serves list and read
   off the same bucket permission, so a bucket anyone can read is also a bucket
   anyone can *list* — and naming the file `<code>.png` turned that listing into a
   public plaintext index of every live voucher code ever emailed, growing by one
   per send, forever. The file is named by its random id instead.
2. **The read grant goes on the file, not the bucket.** A random file id is only
   a bearer token while the set of ids is secret, and a listable bucket hands
   that set out — from which every barcode is one GET away with the code printed
   underneath it (`includetext`). So the bucket must be `fileSecurity: true` with
   **no `read("any")` on the bucket itself**, and each file carries its own
   `read("any")`.

If the bucket's permissions are ever changed, check both of those before
assuming the barcodes are fine.

## Request body

```json
{ "action": "voucher", "giftcardId": "...", "testing": false }
{ "action": "custom",  "djId": "...", "subject": "...", "message": "...", "testing": false }
```

`testing: true` redirects everything to `everett.bazzocchi@skullspace.ca` and
sends no coordinator copies, so nothing reaches a real DJ or coordinator.

On a live voucher send, coordinators assigned to the event are **CC'd**;
`everett.bazzocchi@skullspace.ca` is set as **Reply-To** rather than CC'd, so the
owner gets replies without a copy of every send. Coordinators are a deliberate
exception — unlike `Admin-EmailBartender`, where the body carries a credential
and coordinators get a separate email. A voucher is a bar credit for their event,
which is exactly what a coordinator is meant to know about. The coordinator list
comes from the event's reverse `coordinators` attribute via
`Query.select(['*', 'coordinators.*'])` — Appwrite rejects `Query.equal` on the
many-to-many relationship from the other side.

## The voucher rules the email states

- valid **only during its own event**;
- **cannot be combined with any other discount**;
- spendable across as many purchases as the DJ likes.

All three are enforced for real at payment time in `Transaction-RecordPayment`,
not by this email. A DJ voucher is a `giftcards` row with an `events` link; a
revoked one (`active: false`) is refused there too.

## Responses

| Status | Body | What it means operationally |
| --- | --- | --- |
| `200` | `{ ok: true }` | Sent. |
| `400` | `{ error: "action must be one of: voucher, custom" }` | Bad action. |
| `400` | `{ error: "Missing giftcardId" \| "Missing djId" \| "Missing subject or message" }` | Malformed call. |
| `400` | `{ error: "This giftcard has no linked DJ" }` | The `giftcards` row has no `djs` relationship — it is a customer gift card, not a voucher. |
| `400` | `{ error: "No email on file for this DJ" }` | Missing or malformed address on the `djs` row. |
| `404` | `{ error: "Giftcard not found" \| "DJ not found" }` | Bad id. |
| `500` | `{ error: "Failed to generate voucher barcode" }` | `bwip-js` or the Storage upload failed. Nothing was sent. |
| `500` | `{ error: "Failed to send voucher email" \| "Failed to send email" }` | Resend returned non-2xx or was unreachable. **A barcode file was already uploaded** and is now orphaned in the bucket. |

Failing to read the **event** is not fatal: it is logged and the email goes out
naming "your event" instead, with no coordinator CCs.

## Scopes

| Scope | Why |
| --- | --- |
| `documents.read` | Read the `giftcards`, `djs` and `Events` rows. |
| `files.write` | `storage.createFile` — upload the barcode PNG. |

## Environment variables

| Name | Purpose |
| --- | --- |
| `RESEND_API_KEY` | Resend key. Each function holds its own copy. |

`APPWRITE_FUNCTION_API_ENDPOINT` and `APPWRITE_FUNCTION_PROJECT_ID` are injected
by Appwrite and are used to build the barcode's public URL.

## Configuration

| Setting | Value |
| --- | --- |
| Runtime | `node-16.0` |
| Entrypoint | `src/main.js` |
| Build command | `npm i` |
| Timeout | 30s |
| Schedule | none |

Deploy: `appwrite push function --function-id admin-email-dj`

30 seconds rather than 15 because barcode generation and a Storage upload sit in
front of the send.

## Calling Appwrite's own API from inside a function

See the DNS-patch note in `functions/Giftcard-Lookup/README.md`.
