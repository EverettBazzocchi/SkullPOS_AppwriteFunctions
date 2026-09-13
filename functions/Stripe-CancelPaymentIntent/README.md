# Stripe-CancelPaymentIntent

**Function ID:** `68f6272500160b48ee44`

Cancels the PaymentIntent behind an aborted card sale so the amount stops sitting
on the reader's screen. Called by `handleCancelStripePayment` in
`POS/src/utils/stripe.js` when the cashier backs out of a charge.

Only works on an intent that has **not** been captured. A completed sale goes
through `Stripe-RefundPayment` instead.

## Who may call it

Live `execute` list, verified 2026-09-13
(`appwrite functions get --function-id 68f6272500160b48ee44`):

- `team:68e35aed00144b8cde9d` — admin
- `team:68ffcecc0026f78f0af8` — POS
- `team:6a9cbb1c95ea7d59dd8c` — PIN Payment Access

Plus an in-code refusal of any request with no `x-appwrite-user-id` (the
project-API-key invocation path, which Appwrite does not check `execute` for).

## Request body

```json
{ "intent": "pi_...", "transactionId": "...", "test": "test" }
```

- **`intent`** — required. Must be a real PaymentIntent id (`pi_…`).
  ShottyTicketing's synthetic `pi_tkt_…` placeholders, which were never created
  against the Stripe API, are refused up front rather than producing a confusing
  Stripe error.
- **`transactionId`** — optional, but enforced when present on both sides. If the
  intent carries `metadata.transactionId` (stamped by
  `Stripe-CreatePaymentIntent`) *and* the caller names one, the two must match —
  that is what stops one till cancelling another till's in-flight sale. A caller
  that names nothing is allowed through on caller identity alone, deliberately:
  a POS build predating the stamp sends only `{ test, intent }` on the abort
  path, and refusing those would strand the amount on the reader with the cashier
  unable to back out. Both unnamed cases are logged.
- **mode** — `test` / `isLive` / `environment`, same three spellings
  `Stripe-CreatePaymentIntent` accepts.

## Mode handling differs from Create — on purpose

A **malformed** mode is refused (`400`), so a typo'd `environment: "production"`
cannot quietly become "test". But an **absent** mode defaults to **live** here
rather than `400`ing, and logs loudly that it did.

The asymmetry is not a re-run of the drift these functions converged: Create
refuses an unnamed mode, so no intent can exist whose account was ever guessed —
there is nothing left here to guess about. And on this path refusing is the
strictly worse failure, because the alternative to cancelling an uncaptured
intent is leaving it live on the reader.

## Responses

| Status | Body | What it means operationally |
| --- | --- | --- |
| `200` | `{ data: <intent> }` | Cancelled. |
| `200` | `{ data: <intent>, alreadyCancelled: true }` | It was already cancelled. A double-tap or a retry is idempotent, not an error. |
| `400` | `{ error: "Invalid request body" }` | Unparseable JSON. |
| `400` | `{ error: "Not a cancelable Stripe payment intent id (got …)" }` | Missing id, or a `pi_tkt_…` placeholder. |
| `400` | `{ error: "Contradictory Stripe mode: …" }` etc. | Two spellings disagreeing, or a malformed one. |
| `400` | `{ error: "Payment intent … has already been captured — refund it instead of cancelling" }` | The money is gone. Use `Stripe-RefundPayment`. Cancelling here would silently do nothing for the customer. |
| `403` | `{ error: "Unauthorized" }` | No session user — an API-key invocation. |
| `403` | `{ error: "This payment intent belongs to a different transaction" }` | The caller named a transaction the intent is not stamped for. |
| `404` | `{ error: "No <mode>-mode payment intent found for …" }` | Stripe could not retrieve it. Most often the wrong mode: a live intent looked up with the test key. |
| `500` | `{ error: "Stripe <mode> key is not configured" }` | `prodKey`/`testKey` unset. |
| `500` | `{ error: "<stripe message>" }` | Stripe rejected the cancel. |

The intent is retrieved before it is touched. That one call is what makes the
`alreadyCancelled`, already-captured and ownership answers possible at all; the
old one-line cancel could tell none of them apart from a `500`.

## Scopes

**None.** This function talks only to Stripe.

## Environment variables

| Name | Purpose |
| --- | --- |
| `prodKey` | Stripe live secret key |
| `testKey` | Stripe test secret key |

## Configuration

| Setting | Value |
| --- | --- |
| Runtime | `node-16.0` |
| Entrypoint | `src/main.js` |
| Build command | `npm install` |
| Timeout | 15s |
| Schedule | none |

Deploy: `appwrite push function --function-id 68f6272500160b48ee44`
