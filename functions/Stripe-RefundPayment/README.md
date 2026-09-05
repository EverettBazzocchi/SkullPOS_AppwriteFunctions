# Stripe-RefundPayment

Refunds an already-captured Stripe PaymentIntent (a full or partial refund
via `stripe.refunds.create`). Used by the POS transactions/refund view for
completed card transactions.

Unlike `Stripe-CancelPaymentIntent` (which only works on an intent that
hasn't been captured yet), this works on a completed sale.

## Request body

```json
{
  "test": "test", // or "" for production key
  "intent": "pi_...", // the transaction's stored PaymentIntent id
  "amount": 500 // optional, cents; omit to refund the full captured amount
}
```

## Response

Success: `{ "data": <Stripe Refund object> }`
Failure: `{ "error": "<message>" }` with a 400 status.

## Configuration

| Setting     | Value                                |
| ----------- | ------------------------------------- |
| Runtime     | Node (16.0), matching the other Stripe functions |
| Entrypoint  | `src/main.js`                         |
| Build       | `npm i`                               |

## Environment Variables

- `testKey` - Stripe test-mode secret key
- `prodKey` - Stripe live-mode secret key
