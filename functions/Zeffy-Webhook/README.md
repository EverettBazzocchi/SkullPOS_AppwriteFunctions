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
| `200` | `{ success: true, transactionId, orderCreated, ticketsSaved, ticketsAlreadyPresent, ticketsExpected }` | Written (or already present). On a healthy run `ticketsSaved + ticketsAlreadyPresent === ticketsExpected`. |
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

`documents.read` used to be declared here too. It was dropped in `db2c453` and
that removal is live: nothing in `src/` calls `getDocument` or `listDocuments` —
the only occurrence of `listDocuments` in this function's source is inside a
comment explaining the choice. Every write is a `createDocument`, and duplicate
detection is the 409 from Appwrite's uniqueness constraint on a deterministic id,
not a read.

That removal is the one in `db2c453` the audit did not call for, so it is the
first thing to re-check if a Zeffy purchase ever fails to appear: the payload
lands in `failed_webhooks` and the 12-hourly `Admin-VerifyZeffyTickets` job
reconciles it, so a ticket is recoverable rather than lost. Note that job does
not currently fire on its own — see the root README on scheduled functions.

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

`src/zeffyPersist.js` is kept in sync **by hand** with the identical file in
`functions/Admin-VerifyZeffyTickets/src/`. Change one, change both.

## Calling Appwrite's own API from inside a function

See the DNS-patch note in `functions/Giftcard-Lookup/README.md`.
