# Admin-VerifyZeffyTickets

**Function ID:** `admin-verify-zeffy-tickets`
**Schedule:** `0 */12 * * *` (every 12 hours)

The safety net behind `Zeffy-Webhook`. Runs two phases, both through the exact
same idempotent write path (`src/zeffyPersist.js`) the live webhook uses, so a
payment recovered later can never diverge from what the webhook would have
written.

> **This schedule does not fire on its own.** Async executions do not enqueue on
> this instance. To run it now:
> `appwrite functions create-execution --function-id admin-verify-zeffy-tickets`

## Who may call it

Live `execute`: **`team:68e35aed00144b8cde9d` (admin) only**. Verified 2026-09-13
with `appwrite functions get --function-id admin-verify-zeffy-tickets`. There is
no in-code caller check.

## Phase 1 — retry the dead letters

Replays every `source: 'ZEFFY'` row in `failed_webhooks` (written by
`Zeffy-Webhook` when it could not persist an order) and deletes the row when the
replay succeeds.

Two kinds of row can never be replayed from their own stored payload:

- an **unparseable** payload, and
- a **truncation marker** — `failed_webhooks.payload` is a 5000-character column,
  and a payload that did not fit was stored as `{ truncated: true, transactionId,
  … }` instead. A raw slice of a JSON document is not JSON, so the old behaviour
  made exactly the payloads most worth recovering (large group orders)
  permanently unreplayable, re-failing on every run forever.

Both are stamped `UNREPLAYABLE: <reason>` into `errorMessage` and reported in
their own `unreplayable` bucket, so later runs report them once instead of
burying a genuinely retryable failure in noise. **The row is not deleted** —
phase 2 recovers the payment from Zeffy's own API, and the row is the only record
that it needs to.

## Phase 2 — reconcile against Zeffy's Payments API

Fetches every **succeeded** payment Zeffy has on record
(`GET /api/v1/payments`) and persists any that are missing. This is what actually
verifies every Zeffy ticket is in the database, independent of whether a webhook
ever fired — covering a Zeffy-side outage, a misconfigured or undelivered
webhook, or Zeffy's retry window expiring.

**Skipped entirely, with a log line and `skipped: true`, when `ZEFFY_API_KEY` is
unset.** That is the whole safety net gone; nothing else reports it.

The invariant this phase exists to enforce is *one ticket per line item*, not
just "the order row exists". An order and its tickets are written by separate
calls, so a run that died between them left an order with missing tickets — and
every later run then hit a 409 on the order and reported a clean sweep while the
buyer was refused at the door. Creating tickets against an **existing** order is
therefore counted and reported separately, as `repairedOrders`, and logged at
error level.

## Response

```json
{
  "failedWebhookRetry": {
    "retried": 4, "succeeded": 3,
    "stillFailing": [{ "id": "...", "error": "..." }],
    "unreplayable": [{ "id": "...", "transactionId": "...", "error": "UNREPLAYABLE: …" }]
  },
  "zeffyApiReconciliation": {
    "skipped": false, "checked": 218, "ordersCreated": 1, "ticketsSaved": 2,
    "repairedOrders": [{ "id": "...", "ticketsCreated": 1, "ticketsExpected": 3 }],
    "failures": [{ "id": "...", "error": "..." }]
  }
}
```

Always `200`. **The things to read are `repairedOrders` (a buyer was going to be
refused at the door), `unreplayable` (payments only phase 2 can recover), and
`skipped: true` (the reconciliation did not run at all).**

## Scopes

| Scope | Why |
| --- | --- |
| `documents.read` | Page `failed_webhooks`. |
| `documents.write` | Create `orders`/`tickets`; stamp and delete `failed_webhooks` rows. |

## Environment variables

| Name | Purpose |
| --- | --- |
| `ZEFFY_API_KEY` | Zeffy Payments API key. Without it phase 2 is skipped and only dead-lettered webhooks are retried. |

## Configuration

| Setting | Value |
| --- | --- |
| Runtime | `node-16.0` |
| Entrypoint | `src/main.js` |
| Build command | `npm i` |
| Timeout | 120s |

Deploy: `appwrite push function --function-id admin-verify-zeffy-tickets`

Phase 2 walks **every** succeeded payment Zeffy has ever recorded, not a recent
window, so its cost grows with the campaign's lifetime. If it starts timing out,
that is the thing to bound first.

`src/zeffyPersist.js` is kept in sync **by hand** with the identical file in
`functions/Zeffy-Webhook/src/`. Change one, change both — divergence means a
retried payload writes something different from what the live webhook wrote.

## Calling Appwrite's own API from inside a function

See the DNS-patch note in `functions/Giftcard-Lookup/README.md`.
