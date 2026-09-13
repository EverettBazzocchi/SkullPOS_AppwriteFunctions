# Admin-EmailBartender

**Function ID:** `admin-email-bartender`

Emails a bartender either an automatic event-assignment notice — carrying the
event, the exact window her PIN will work in, and **the PIN itself** — or a
free-form message from the admin.

## Who may call it

Live `execute`: **`team:68e35aed00144b8cde9d` (admin) only**. Verified 2026-09-13
with `appwrite functions get --function-id admin-email-bartender`. No in-code
caller check; the `execute` list is the whole control, same as `Admin-EmailDj`
and `Admin-EmailCoordinator`.

## Coordinators get a separate, PIN-free email

Coordinators assigned to the event are notified that a bartender was assigned —
but as their **own** email, never as a CC on hers. One HTML body goes to `to` and
every `cc`, and her copy carries a live till credential; CC'ing a coordinator on
it would hand a working POS PIN to a role that is never meant to hold one.

`event_coordinators.events` is a many-to-many relationship and Appwrite rejects
`Query.equal` on a relationship attribute ("Cannot query on virtual relationship
attribute"), so the list can only be read from the **event's** own reverse
`coordinators` attribute via `Query.select(['*', 'coordinators.*'])`.

If the coordinator notice fails, the call still returns `200` with
`coordinatorNoticeSent: false` — the bartender, who actually needs the PIN,
already has hers, and a retry must not re-send her PIN over a failed notice.

## The PIN window shown in the email

Computed by `src/eventWindow.js`, the same module `Verify-Pin` uses, so the email
cannot promise hours the PIN will not honour:

- the **union** of `barOpensAt`/`barClosesAt` and `startsAt`/`endsAt`, all four
  absolute instants;
- padded by **1 hour on each side** (`PIN_VALID_WINDOW_MS`, matching Verify-Pin
  exactly);
- with no end instant on the row, the window collapses to the start and the email
  falls back to the flat "1 hour on either side of the event's start time"
  wording -- which is exactly what Verify-Pin will honour for that row, so the
  email cannot over-promise.

`date` is the one legacy field still read, and only as a start anchor for a row
carrying none of the four instants. The `barOpenTime`/`barCloseTime` duration
this section used to describe is gone with those attributes.

Times render in `America/Winnipeg`. That is hardcoded, not inferred:
`event.date` is an absolute UTC instant, and without an explicit `timeZone`,
`toLocaleString` renders it in whatever zone the function's server happens to run
in — which is how a 10pm Winnipeg start once showed up as a different hour.
SkullSpace is a single fixed venue.

## Request body

```json
{ "action": "event_assigned", "bartenderId": "...", "eventId": "...", "testing": false }
{ "action": "custom", "bartenderId": "...", "subject": "...", "message": "...", "testing": false }
```

**`testing: true` redirects everything** to `everett.bazzocchi@skullspace.ca` and
skips the coordinator notice entirely, so nothing reaches a real bartender or
coordinator.

A live send goes to the bartender, with `everett.bazzocchi@skullspace.ca` set as
**Reply-To** rather than CC'd — the owner gets replies without a copy of every
send. The coordinator notice is a separate email addressed to the coordinators
themselves, so they are still told who is booked.

## Responses

| Status | Body | What it means operationally |
| --- | --- | --- |
| `200` | `{ ok: true }` | Sent. |
| `200` | `{ ok: true, coordinatorNoticeSent: false }` | Bartender emailed; the coordinator notice failed. Do not re-run `event_assigned` to fix it — that re-sends her PIN. |
| `400` | `{ error: "action must be one of: event_assigned, custom" }` | Bad action. |
| `400` | `{ error: "Missing bartenderId or eventId" \| "Missing subject or message" }` | Malformed call. |
| `400` | `{ error: "This bartender has no pin generated yet" }` | Generate one first. |
| `400` | `{ error: "No email on file for this bartender" }` | Missing or malformed address on the `bartenders` row. |
| `400` | `{ error: "This event has no date set, so a pin-valid-window can't be shown" }` | Set the event's date. |
| `404` | `{ error: "Bartender not found" \| "Event not found" }` | Bad id. |
| `500` | `{ error: "Failed to send email" }` | Resend returned non-2xx or was unreachable. The log carries Resend's own status and body. |

## Scopes

| Scope | Why |
| --- | --- |
| `documents.read` | Read the `bartenders` row and the `Events` row with `coordinators.*` selected. |

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

Deploy: `appwrite push function --function-id admin-email-bartender`

Sender is `SkullPOS <SkullPOS@mail.shotty.tech>` and every body ends with the
same `admin@skullspace.ca` footer — the same constants appear in
`Transaction-RecordPayment`, `Transaction-EmailReceipt`, `Admin-EmailDj` and
`Admin-EmailCoordinator`. Each function stays self-contained; there is no shared
email module.

## Calling Appwrite's own API from inside a function

See the DNS-patch note in `functions/Giftcard-Lookup/README.md`.
