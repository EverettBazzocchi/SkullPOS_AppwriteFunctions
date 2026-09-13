# Transaction-SetStatus

**Function ID:** `6a9c65091672e55d90b1`

Sets a **pending** transaction to `cancelled` — staff backing out of an
in-progress sale. That is the only transition it performs.

- `complete` is no longer reachable here. A sale is completed by
  `Transaction-RecordPayment` once its `payment_due` reaches 0.
- `refunded` is never accepted; that belongs exclusively to
  `Stripe-RefundPayment`, which is admin-team-only.
- Only transitions out of `pending`, so it cannot be replayed against an
  already-finalized transaction.

The client has no write access to `Transactions` at all, which is what makes "no
refunds in quick-access PIN mode" a real restriction rather than a client-side
flag.

## Who may call it

Live `execute`: `users` — any signed-in session, anonymous PIN sessions included.
Verified 2026-09-13 with
`appwrite functions get --function-id 6a9c65091672e55d90b1`. Checkout needs this;
there is no in-code caller check.

## What it refuses to cancel

A split-tender sale can already carry recorded legs while still `pending` (a gift
card covered part of the total, the card portion never finished). Cancelling
outright would strand whatever those legs moved.

- **A `stripe` leg is a hard refusal (`409`).** Real money was captured;
  reversing it is a refund, not a ledger fix, and must not happen as a side
  effect of a status change. Use `Stripe-RefundPayment`.
- **Gift-card legs are credited back** after the status flip.
- **Cash legs need no code-level reversal** — staff hand the notes back.

Only the modern `payments` array is read here. Transactions predating the
split-payment migration never supported partial tender, so there is nothing
legacy to derive (contrast `Stripe-RefundPayment`'s `derivePaymentLegs`, which
also synthesizes a leg from the legacy columns — relevant only for
already-`complete` rows).

Status is flipped **before** any gift card is credited. That is the idempotency
guard: if a reversal fails and the call is retried, the `status !== 'pending'`
check stops it from crediting the same card twice.

## Request body

```json
{ "transactionId": "...", "status": "cancelled" }
```

## Responses

| Status | Body | What it means operationally |
| --- | --- | --- |
| `200` | `{ ok: true, status: "cancelled" }` | Cancelled. Includes `reversedGiftcards: [{ giftcardId, amount }]` when gift-card legs were credited back. |
| `400` | `{ error: "Invalid request body" }` | Unparseable JSON. |
| `400` | `{ error: "status must be one of: cancelled" }` | Missing `transactionId`, or any status other than `cancelled`. |
| `400` | `{ error: "Transaction is not pending (status: …)" }` | Already finished. Nothing happened. |
| `404` | `{ error: "Transaction not found" }` | Bad id. |
| `409` | `{ error: "This transaction already has a captured card payment on it — refund it first (Stripe-RefundPayment) instead of cancelling." }` | Do not retry. Refund it. |
| `500` | `{ error: "Failed to update transaction status" }` | Nothing changed. Safe to retry. |
| `500` | `{ error: "Transaction cancelled, but failed to restore giftcard …'s balance — please handle manually: …" }` | **The sale is cancelled and the customer's gift-card balance is short.** Retrying will not help (the guard now blocks it); credit it by hand. |

## Scopes

| Scope | Why |
| --- | --- |
| `documents.read` | Read the transaction and the gift-card rows. |
| `documents.write` | Flip status; credit gift-card balances back. |

## Environment variables

None.

## Configuration

| Setting | Value |
| --- | --- |
| Runtime | `node-16.0` |
| Entrypoint | `src/main.js` |
| Build command | `npm i` |
| Timeout | 15s |
| Schedule | none |

Deploy: `appwrite push function --function-id 6a9c65091672e55d90b1`

## Calling Appwrite's own API from inside a function

See the DNS-patch note in `functions/Giftcard-Lookup/README.md`.
