# Stripe-CreatePaymentIntent

**Function ID:** `68f3c860003da00f14d8`

Creates the Stripe PaymentIntent a card-present sale is charged against. Shared
by SkullPOS and ShottyTicketing (same Stripe account), which send different
request shapes for the same operation; the function branches on which fields the
body carries.

This is the only function in the family that mints money-moving state, so it is
the strictest about its inputs.

## Who may call it

Live `execute`: `users` — any signed-in Appwrite session, **including anonymous
ones** (anonymous auth is enabled on this project). Verified 2026-09-13 with
`appwrite functions get --function-id 68f3c860003da00f14d8`.

That is wider than the other three Stripe functions, which are restricted to the
admin / POS / PIN Payment Access teams. There is no in-code caller check here
either. What actually bounds the damage is that an intent is worthless without a
reader to tap it against, and that the SkullPOS path below cannot mint an intent
that is not already bound to a real Transactions row.

## Two hard refusals

**1. The Stripe mode must be named.** `resolveStripeMode` accepts three
spellings and treats anything else as an error rather than a default:

| Sent | Meaning |
| --- | --- |
| `{ "test": "test" }` | test |
| `{ "test": "" }` (POS's live spelling) | live |
| `{ "isLive": true \| false }` | as stated; a non-boolean is a `400` |
| `{ "environment": "live" \| "test" }` | as stated; anything else, `"production"` included, is a `400` |

Two spellings that contradict each other in one body are a `400`. **No signal at
all is also a `400`** — refusing costs nothing here (no intent exists yet, so
nothing can have been captured against the wrong account) and it means no
function downstream has to guess which Stripe account a given intent belongs to.
Both real callers already name it: `POS/src/utils/stripe.js` always sends `test`,
ShottyTicketing's `stripeService.ts` always sends `isLive`.

**2. The SkullPOS path requires `transactionId`.** `Transaction-RecordPayment`
hard-rejects any card leg whose intent does not carry
`metadata.transactionId` matching the sale, and these intents are created with
`capture_method: 'automatic'` — so an intent minted without the stamp can still
be tapped, captures immediately, and can then never be recorded against the sale.
That was the worst bug in the system (money taken, sale unrecordable, on every
card sale). Refusing here is the only thing that keeps the two halves from
drifting apart again.

ShottyTicketing door sales are exempt: they have no Transactions row to point at.

## Request / response by client

**SkullPOS** — detected by the absence of `isLive`/`environment`/`currency`:

```json
{ "test": "", "amount": 1250, "transactionId": "68e4cd35..." }
```

→ `200 { "intent": { …the raw Stripe PaymentIntent… } }`

The raw nesting under `intent` is load-bearing: `getChargeID()` in
`POS/src/utils/stripe.js` reads `data.intent.id` and `data.intent.client_secret`.

**ShottyTicketing** — detected by any of `isLive`, `environment`, `currency`:

```json
{ "amount": 3000, "currency": "cad", "isLive": true }
```

→ `200 { "clientSecret": "pi_…_secret_…", "amount": 3000, "currency": "cad", "mode": "live" }`

`amount` defaults to 3000 cents (the door price) and `currency` to `cad`.

Both paths create the intent with
`payment_method_types: ['card_present', 'interac_present']` and
`capture_method: 'automatic'`.

## Responses

| Status | Body | What it means operationally |
| --- | --- | --- |
| `200` | see above | Intent created. |
| `400` | `{ error: "Invalid request body" }` | Unparseable JSON. |
| `400` | `{ error: "No Stripe mode given: …" }` or a mode-validation message | The caller did not name test/live, or named it two contradictory ways. Fix the client; do not add a default. |
| `400` | `{ error: "transactionId is required to create a payment intent" }` | SkullPOS path with no transaction. The sale must exist before the charge. |
| `500` | `{ error: "Stripe <mode> key is not configured" }` | `prodKey`/`testKey` unset. Card sales are down. |
| `500` | `{ error: "<stripe message>" }` | Stripe rejected the create. |

## Environment variables

| Name | Purpose |
| --- | --- |
| `prodKey` | Stripe live secret key |
| `testKey` | Stripe test secret key |

## Scopes

**None.** This function talks only to Stripe. (`src/main.js` still has an unused
`import { Client, Users } from 'node-appwrite'` at the top — dead, and harmless;
no scope is declared, so no dynamic key is injected.)

## Configuration

| Setting | Value |
| --- | --- |
| Runtime | `node-16.0` |
| Entrypoint | `src/main.js` |
| Build command | `npm install` |
| Timeout | 15s |
| Schedule | none |

Deploy: `appwrite push function --function-id 68f3c860003da00f14d8`

`resolveStripeMode` is carried character-for-character by
`Stripe-CancelPaymentIntent`, and both test files carry the identical table of
cases. Change one, change both.
