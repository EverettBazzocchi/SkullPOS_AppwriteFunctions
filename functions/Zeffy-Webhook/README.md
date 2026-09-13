# Zeffy-Webhook

**Function ID:** `zeffy-webhook`

Receives Zeffy's `payment.completed` webhook and writes the resulting order and
ticket(s) into the `orders` and `tickets` collections.

The webhook is relayed unmodified — raw body plus the `Zeffy-Signature` header —
by the Cloudflare Worker in `ShottyTicketing/cloudflare-worker` (see that repo's
`index.js`). Zeffy itself never talks to this function directly.

## Authentication is the HMAC, not Appwrite

Live `execute`: **`any`**. Verified 2026-09-13 with
`appwrite functions get --function-id zeffy-webhook`. It has to be — the relay
holds no Appwrite session.

So the `Zeffy-Signature` check (HMAC over the raw body,
`src/zeffySignature.js`) is the **only** authentication this endpoint has, and it
**fails closed**: a missing or unset `ZEFFY_WEBHOOK_SIGNING_SECRET` rejects every
request with a `500`. The previous behaviour — log a warning, then treat the
request as verified — meant that simply forgetting to set the variable turned
this into a fully open, unauthenticated endpoint able to write arbitrary orders
and tickets.

## Idempotency

Document ids are derived deterministically from the Zeffy transaction id
(`zfo_…` for the order) and ticket id (`zft_…` for each ticket), so a duplicate
delivery — which Zeffy's own retry policy can produce — fails atomically on
Appwrite's uniqueness constraint (409) and is treated as "already recorded",
rather than racing a separate existence check.

## Dead-lettering

If persistence fails, the parsed payload is written to `failed_webhooks` with
`source: 'ZEFFY'` and `Admin-VerifyZeffyTickets` (12h) replays it through the
same write path. `failed_webhooks.payload` is a 5000-character column; an
over-long payload is stored as a **marker object**
(`{ truncated: true, transactionId, … }`) rather than a raw slice, because a cut
JSON document is not JSON and could only ever throw on replay — which made large
group orders, exactly the ones worth recovering, permanently unreplayable. The
marker is valid JSON, carries the transaction id phase 2 of the verify job needs,
and is recognisable as "there is no payload here".

## Responses

| Status | Body | What it means operationally |
| --- | --- | --- |
| `200` | `{ success: true, transactionId, orderCreated, ticketsSaved, ticketsAlreadyPresent, ticketsExpected, eventId }` | Written (or already present). On a healthy run `ticketsSaved + ticketsAlreadyPresent === ticketsExpected`. `eventId` is the `Events.$id` the event name resolved to, or `null` if it did not resolve — reported so the join can be checked without reading logs. |
| `200` | `{ success: false, error: "Failed to persist order, recorded for retry" }` | **Deliberately `200`.** A 4xx/5xx would just make Zeffy redeliver the same payload with no better odds; the dead-letter row plus the 12h retry job is the recovery path now. Nothing is lost — but nothing is recorded yet either, so a buyer would be refused at the door until the retry lands. |
| `401` | `{ success: false, error: "Unauthorized" }` | Missing or invalid `Zeffy-Signature`. If real webhooks start failing this way, the secret on this function and the one in the Cloudflare Worker have diverged. |
| `500` | `{ success: false, error: "Webhook is not configured to verify requests" }` | `ZEFFY_WEBHOOK_SIGNING_SECRET` is unset. **Every ticket sale is being rejected.** |

An unparseable JSON body is not itself an error — it is parsed to `{}` and the
payload parser handles the empty shape. A non-`payment.completed` event type is
persisted as `{ skipped: true, reason }`.

## Scopes

Live scopes, read from the project on 2026-09-13
(`appwrite functions get --function-id zeffy-webhook`):

| Scope | Status | Why |
| --- | --- | --- |
| `documents.write` | live, needed | Create `orders`, `tickets`, and `failed_webhooks` rows. |
| `documents.read` | **needed, not yet live** | Look the event name up in `Events` once per payload so the ticket can carry `eventId` as well as `eventName` (see below). |

`documents.read` was dropped in `db2c453`, when nothing here read anything:
duplicate detection is the 409 from Appwrite's uniqueness constraint on a
deterministic id, not a read.

`src/eventLookup.js` reintroduces the need for it. Until it is added to this
function's `scopes` in `appwrite.config.json` and pushed, **every lookup here
returns a 403 and every ticket is written with its name only** — which is exactly
what was written before, so nothing regresses and no purchase is at risk. The
lookup fails soft by design, in every direction: a 403, a DB hiccup, a name that
matches nothing, or a name that matches two events all resolve to "no eventId,
write the name". A convenience join must never be able to lose a paid ticket.

Duplicate detection is still the 409, not the read, so nothing about idempotency
changes with the scope.

## `eventName` and `eventId` on a ticket

`tickets.eventName` is free text and every reader re-matches it against
`Events.name` on every read, so renaming an event orphans its tickets. Each
ticket is now also written with `eventId` — the matching **`Events.$id`**,
resolved **once, here, at write time** — so a later rename cannot break the join.

- The name is still written, unchanged, always. Every reader keys off it today
  and must keep working mid-migration.
- The id is written only on an exact, unambiguous, single name match. Zero matches
  or two matches leave the key **absent** (not `null`), so an unplaceable ticket
  looks exactly like the legacy rows the backfill script goes looking for.
- It is `Events.$id`, **not** `Events.eventId` — that column holds Zeffy's own
  occurrence UUID and is null for anything created in the admin app. So
  `tickets.eventId` holds an Appwrite `$id` while `Events.eventId` holds a Zeffy
  UUID. Ugly, but consistent with `Giftcard-Lookup`, which already returns an
  event `$id` under the name `eventId`.
- Be honest about the limit: resolution is still **by name**, it just happens once
  instead of on every read. Zeffy's payload carries no campaign or occurrence id
  at all (see `zeffyPayload.js`), so there is nothing better to key off.

Rows written before this shipped are filled in by
`functions/_scripts/backfill-ticket-event-ids.js`.

If a Zeffy purchase ever fails to appear, the scopes are still the first thing to
re-check: the payload lands in `failed_webhooks` and the 12-hourly
`Admin-VerifyZeffyTickets` job reconciles it, so a ticket is recoverable rather
than lost. Note that job does not currently fire on its own — see the root README
on scheduled functions.

## Environment variables

| Name | Purpose |
| --- | --- |
| `ZEFFY_WEBHOOK_SIGNING_SECRET` | HMAC secret shared with the Cloudflare Worker relay. Must match, or every request is a 401. |

## Configuration

| Setting | Value |
| --- | --- |
| Runtime | `node-16.0` |
| Entrypoint | `src/main.js` |
| Build command | `npm i` |
| Timeout | 30s |
| Schedule | none |

Deploy: `appwrite push function --function-id zeffy-webhook`

`src/zeffyPersist.js` and `src/eventLookup.js` are kept in sync **by hand** with
the identical files in `functions/Admin-VerifyZeffyTickets/src/`. Change one,
change both — `diff` the pair before pushing, they are byte-identical on purpose.

## Calling Appwrite's own API from inside a function

See the DNS-patch note in `functions/Giftcard-Lookup/README.md`.
