# Stripe-RefundPayment

**Function ID:** `6a9b7671df1f504a084e`

Refunds a whole completed sale, end to end. Reads the transaction server-side
(never trusting the client for what to refund), reverses **every** payment leg —
any mix of cash, card and gift card, including multiple separate cards on a split
sale — and marks the transaction `refunded`.

This is the **only** place allowed to set a transaction's status to `refunded`.
The client has no write access to `Transactions` or `giftcards` at all, which is
what makes "no refunds in quick-access PIN mode" a real restriction rather than a
client-side flag — a cash-paid sale in particular has no external payment step
that could otherwise gate it.

Always a **full** refund. There is no partial-refund path, so the `refund_amount`
it records is always the whole paid amount. Supporting partials would mean
representing them (a refunded subtotal the reports can subtract), not just
passing a smaller number to Stripe.

Unlike `Stripe-CancelPaymentIntent` (uncaptured intents only), this works on a
completed sale.

## Who may call it

Live `execute`: **`team:68e35aed00144b8cde9d` (admin) only**. Verified
2026-09-13 with `appwrite functions get --function-id 6a9b7671df1f504a084e`. The
POS team and PIN Payment Access are *not* on this list.

Plus an in-code refusal of any request with no `x-appwrite-user-id`.

## Two request shapes

**SkullPOS** — the full-transaction path:

```json
{ "transactionId": "..." }
```

**ShottyTicketing** — door sales have no server-side transaction record (its
orders live client-side against Stripe alone), so it refunds by intent:

```json
{ "paymentIntentId": "pi_...", "isLive": true }
```

The ticketing branch is taken only when `paymentIntentId` is present and
`transactionId` is not. `pi_tkt_…` placeholders are refused. Note this branch
still uses the older mode spelling (`isLive === true || environment === 'live'`,
defaulting to **test**) rather than `Stripe-CreatePaymentIntent`'s
`resolveStripeMode`; a ticketing refund that omits the flag asks the *test*
account to refund a live PaymentIntent.

## Order of operations on the transaction path

1. Read the transaction. Refuse if already `refunded` (`400`) or not `complete`
   (`400`).
2. Derive the payment legs (`src/paymentLegs.js` — reads the modern `payments`
   array, falling back to synthesizing one leg from the legacy
   `stripe_id`/`giftcard_amount`/`payment_method` columns).
3. **Flip `status` to `refunded` first.** This is the idempotency guard: if a leg
   reversal then fails and the call is retried, the already-refunded check in
   step 1 stops a second run from re-crediting a gift card. A failure after this
   point means a human finishes the remaining legs by hand — safer than silently
   double-refunding on retry.
4. Best-effort, separately: write `refunded_at`, `refund_amount`, `refunded_by`.
   These are newer attributes; until they exist on the collection this update is
   rejected, and that must never turn a successful refund into a failed one. Once
   they exist it starts recording with no redeploy. **Until then the status flip
   is the only durable trace a refund leaves**, and it is destructive:
   `Admin-RollupEventSales` recomputes every past event from `status ===
   'complete'` on every run, so refunding a September sale in November silently
   rewrites September's figures with no record of when or by whom.
5. Reverse each leg. `stripe` → `stripe.refunds.create`, using the key matching
   the transaction's own `testing` flag (not a client-asserted one). `giftcard` →
   credit the balance back. `cash` → nothing; staff hand the notes back.

A gift-card leg with an amount but **no** `giftcardId` (the shape of every
pre-migration gift-card sale) is reported as a failed leg rather than falling
through to the cash branch. Handing real money over the bar for a payment that
came off a gift card is the one outcome that must not happen here.

## Responses

| Status | Body | What it means operationally |
| --- | --- | --- |
| `200` | `{ ok: true, legs: [...] }` | Every leg reversed. |
| `400` | `{ error: "Missing transactionId" }` | Neither id was sent. |
| `400` | `{ error: "Transaction has already been refunded" }` | Idempotency guard. Nothing further happened. |
| `400` | `{ error: "Only completed transactions can be refunded (current status: …)" }` | A `pending` sale is cancelled, not refunded. |
| `400` | `{ error: "No real Stripe payment intent on file…" }` | Ticketing path, `pi_tkt_…` or missing id. Refund it by hand in the Stripe dashboard. |
| `403` | `{ error: "Unauthorized" }` | No session user — an API-key invocation. |
| `404` | `{ error: "Transaction not found" }` | Bad id. |
| `500` | `{ error: "Failed to mark transaction refunded: …" }` | Nothing was reversed — the guard never landed. Safe to retry. |
| `500` | `{ error: "Transaction marked refunded, but some payment legs failed to reverse — please handle these manually: …", legs: [...] }` | **Read the message.** The sale is marked refunded but the customer has not been made whole on the listed legs. Retrying will not help (the guard now blocks it); finish those legs by hand. |

## Scopes

| Scope | Why |
| --- | --- |
| `documents.read` | Read the transaction and the gift-card rows. |
| `documents.write` | Flip status, write the refund record, credit gift-card balances. |

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
| Build command | `npm i` |
| Timeout | 15s |
| Schedule | none |

Deploy: `appwrite push function --function-id 6a9b7671df1f504a084e`

## Calling Appwrite's own API from inside a function

See the DNS-patch note in `functions/Giftcard-Lookup/README.md`.
