# Admin-EmailCoordinator

**Function ID:** `admin-email-coordinator`

Sends an event coordinator a free-form message from the admin. That is all it
does — there is no automatic action here.

Coordinators already receive the automatic notices as a side effect of the other
two mailers: `Admin-EmailBartender` sends them their own PIN-free
bartender-assigned notice, and `Admin-EmailDj` CCs them on a voucher issue. This
function exists so the admin can reach one directly.

## Who may call it

Live `execute`: **`team:68e35aed00144b8cde9d` (admin) only**. Verified 2026-09-13
with `appwrite functions get --function-id admin-email-coordinator`. No in-code
caller check; the `execute` list is the whole control.

## Request body

```json
{ "coordinatorId": "...", "subject": "...", "message": "...", "testing": false }
```

`testing: true` redirects to `everett.bazzocchi@skullspace.ca`, so nothing reaches
a real coordinator. A live send goes to the coordinator, with
`everett.bazzocchi@skullspace.ca` set as **Reply-To** rather than CC'd — the owner
gets replies without a copy of every send.

`message` is HTML-escaped and rendered with `white-space: pre-wrap`, so line
breaks survive and markup does not.

## Responses

| Status | Body | What it means operationally |
| --- | --- | --- |
| `200` | `{ ok: true }` | Resend accepted it. |
| `400` | `{ error: "Invalid request body" }` | Unparseable JSON. |
| `400` | `{ error: "Missing coordinatorId" \| "Missing subject or message" }` | Malformed call. Both subject and message are required and are trimmed. |
| `400` | `{ error: "No email on file for this coordinator" }` | The `event_coordinators` row has no address, or one that fails the format check. |
| `404` | `{ error: "Coordinator not found" }` | Bad `coordinatorId`. |
| `500` | `{ error: "Failed to send email" }` | Resend returned non-2xx or was unreachable. The log carries Resend's own status and body. |

## Scopes

| Scope | Why |
| --- | --- |
| `documents.read` | Read the `event_coordinators` row. |

No write scope: this function only reads and mails.

## Environment variables

| Name | Purpose |
| --- | --- |
| `RESEND_API_KEY` | Resend key. Each function holds its own copy. |

## Configuration

| Setting | Value |
| --- | --- |
| Runtime | `node-16.0` |
| Entrypoint | `src/main.js` |
| Build command | `npm i` |
| Timeout | 15s |
| Schedule | none |

Deploy: `appwrite push function --function-id admin-email-coordinator`

This function's live deployment is older than the rest (2026-09-12 02:24 UTC,
versus the 2026-09-13 07:xx batch) — it was not part of the redeploy pass.

## Calling Appwrite's own API from inside a function

See the DNS-patch note in `functions/Giftcard-Lookup/README.md`.
