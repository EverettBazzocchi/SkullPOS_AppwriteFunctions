# Admin-CancelStaleTransactions

**Function ID:** `admin-cancel-stale-transactions`
**Schedule:** `0 4 * * *` (daily, 04:00 UTC)

Cancels transactions stuck in `pending` for an hour or more. A real card payment
resolves in seconds, so a row that old is almost certainly abandoned — the
customer walked away, the terminal dropped, the tab was never closed out. It
performs the exact transition `Transaction-SetStatus` allows a staff member to
make by hand (`pending` → `cancelled`), just on staleness instead of a click.

> **This schedule does not fire on its own.** Async executions do not enqueue on
> this instance, so every scheduled function here has to be invoked manually.
> See the root `README.md`. To run it now:
> `appwrite functions create-execution --function-id admin-cancel-stale-transactions`

## Who may call it

Live `execute`: **`team:68e35aed00144b8cde9d` (admin) only**. Verified 2026-09-13
with `appwrite functions get --function-id admin-cancel-stale-transactions`.
There is no in-code caller check.

## What it will not touch

The sweep is unattended, so it only cancels what it can fully account for. The
one leg it knows how to reverse by itself is a **gift-card** leg — crediting a
balance back is a pure ledger fix with no external money movement.

`chargeEvidence` classifies each stale row:

- **Hard evidence — skipped entirely, reported in `needsManualReview`:**
  - it has a recorded payment leg that is not a gift card (a captured card that
    needs a real refund; cash already in the drawer that needs a payout or void
    decision), or
  - it carries a `stripe_id`.

  Note the shape of this test: it enumerates what is **safe** rather than what to
  skip. The previous version skipped only `method === 'stripe'`, so cash — and
  any method added later — fell through to a silent cancel with no reversal and
  no review entry, leaving money that corresponded to no recorded sale.

- **Soft evidence — cancelled, but reported in `cancelledPossiblyCharged` and
  logged at error level:** `payment_method` is one of `stripe`,
  `giftcard+stripe` or `split` (set at creation time by the register or kiosk,
  before the terminal was ever tapped) and no leg was ever recorded. That is
  usually an abandoned cart, but it is also the exact shape a card that *was*
  captured and then failed to record leaves behind. Cancelling is still right —
  leaving every abandoned tap pending forever helps nobody — but **each one needs
  checking against Stripe in the morning**, not at a chargeback.

- **No evidence** — cancelled quietly.

Status is flipped **before** any gift card is credited. That is the idempotency
guard: if a reversal fails, the row is no longer `pending` and a future run will
not re-select it.

## Request body

None.

## Response

```json
{
  "cutoff": "2026-09-13T03:00:00.000Z",
  "staleFound": 12,
  "cancelled": 9,
  "failures": [],
  "needsManualReview": [{ "transactionId": "...", "reason": "..." }],
  "cancelledPossiblyCharged": [{ "transactionId": "...", "paymentMethod": "stripe", "amount": 1250, "reason": "..." }]
}
```

**Read `needsManualReview` and `cancelledPossiblyCharged` on every run.** Those
are the two lists a human has to act on. `failures` holds rows whose status
update failed, plus rows that were cancelled but whose gift-card balance could
not be restored.

`500 { error: "Failed to list pending transactions" }` if the initial query
fails; nothing was changed.

## Scopes

| Scope | Why |
| --- | --- |
| `documents.read` | Page stale `pending` rows; read gift-card balances. |
| `documents.write` | Flip status; credit gift-card balances back. |

## Environment variables

None.

## Configuration

| Setting | Value |
| --- | --- |
| Runtime | `node-16.0` |
| Entrypoint | `src/main.js` |
| Build command | `npm i` |
| Timeout | 60s |

Deploy: `appwrite push function --function-id admin-cancel-stale-transactions`

## Calling Appwrite's own API from inside a function

See the DNS-patch note in `functions/Giftcard-Lookup/README.md`.
