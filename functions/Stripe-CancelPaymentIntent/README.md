# Stripe-CancelPaymentIntent

Cancels the PaymentIntent behind an aborted card sale so the amount stops
sitting on the reader's screen. Called by `POS/src/utils/stripe.js`'s
`handleCancelStripePayment` when the cashier backs out of a charge.

Only works on an intent that has **not** been captured yet — a completed sale
goes through `Stripe-RefundPayment` instead.

## Request body

```json
{ "intent": "pi_...", "transactionId": "...", "test": "test" }
```

- `intent` — required. Must be a real Stripe PaymentIntent id (`pi_…`);
  ShottyTicketing's synthetic `pi_tkt_…` placeholders are refused up front.
- `transactionId` — required *whenever the intent carries
  `metadata.transactionId`* (stamped by `Stripe-CreatePaymentIntent` when its
  caller passes one). It must name the same transaction, which is what stops
  one till cancelling another till's in-flight sale. Intents created without
  that stamp — the shape POS still sends today — are cancelled on caller
  identity alone.
- `test` — `"test"` selects the test key, anything else (including an omitted
  field) selects the live key. `{ "isLive": true }` / `{ "environment": "live" }`
  are accepted as equivalents, matching the other three Stripe functions.

## Responses

| Status | When |
| --- | --- |
| `200 { data }` | Cancelled. `{ data, alreadyCancelled: true }` if it was already cancelled — a double-tap is idempotent, not an error. |
| `400` | Unparseable/empty body, missing or non-cancelable intent id, or the intent has already been captured (refund it instead). |
| `403` | No Appwrite user session, or the intent belongs to a different transaction. |
| `404` | No intent with that id exists in the requested test/live mode. |
| `500` | The mode's key is unconfigured, or Stripe rejected the cancel. |

## Configuration

| Setting | Value |
| --- | --- |
| Runtime | Node (16.0) |
| Entrypoint | `src/main.js` |
| Build Commands | `npm install` |
| Execute | `team:admin`, `team:POS`, `team:PIN Payment Access` |
| Scopes | none needed — this function talks only to Stripe |
| Timeout (Seconds) | 15 |

## Environment Variables

| Name | Purpose |
| --- | --- |
| `prodKey` | Stripe live secret key |
| `testKey` | Stripe test secret key |
