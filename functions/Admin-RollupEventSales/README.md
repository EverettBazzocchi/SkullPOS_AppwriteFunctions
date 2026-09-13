# Admin-RollupEventSales

**Function ID:** `admin-rollup-event-sales`
**Schedule:** `0 6 * * *` (daily, 06:00 UTC)

For every event whose sales window has already ended, recomputes that event's
figures from live, complete `Transactions` created inside the window, plus its
ticket sales, and writes them back onto the `Events` document.

> **This schedule does not fire on its own.** Async executions do not enqueue on
> this instance. To run it now:
> `appwrite functions create-execution --function-id admin-rollup-event-sales`

## Who may call it

Live `execute`: **`team:68e35aed00144b8cde9d` (admin) only**. Verified 2026-09-13
with `appwrite functions get --function-id admin-rollup-event-sales`. There is no
in-code caller check.

## What it writes onto `Events`

From `buildEventSales()` (POS-only): `alcohol_sales`, `food_sales`,
`drink_sales`, `discount_amount`, `gift_card_amount`, `tips_earned`,
`cash_sales`, `card_sales`, `cogs`.

Derived:

- `pos_revenue` — POS-only revenue.
- `revenue` — `pos_revenue` + ticket sales. The event's actual total take.
- `profit` — combined `revenue` − `cogs` (tickets have no COGS concept here).
- `card_sales_incl_tips` — `card_sales` plus the card-reader tips taken with it,
  i.e. **what Stripe actually deposited**. Written as a separate, best-effort
  second update, because it is a newer attribute: until it is created the write
  is rejected and the figures that already exist must still land. Once it exists
  this starts populating on the next run with no redeploy. The rejection is
  logged once per run, not once per event, and the log line carries the exact
  `databases create-integer-attribute` command to create it.

`inventory`, `sales` and `djs` are deliberately left untouched.

## Idempotent overwrite

Every past event is recomputed on **every** run rather than tracked with an
"already rolled up" flag. At this data volume, correctness — a late-arriving
transaction, a refund, a ticket recorded after the fact — is worth more than the
cost of re-aggregating.

The consequence to know about: **a refund silently rewrites history.** Refunding
a September sale in November flips its status off `complete`, and the next run
recomputes September without it. `Stripe-RefundPayment` writes `refunded_at` /
`refund_amount` / `refunded_by` to make that traceable, but only once those three
attributes exist on `Transactions`.

## The sales window

`eventSalesWindow()` derives the window from the event's `date` plus the bar's
open-to-close duration. An event is **due** when its window end is in the past.

- **No date at all** — a draft that was never scheduled. Skipped silently.
- **A date but no usable window** (bar open and close identical, or unparseable)
  — reported in `skipped` and **not** rolled up. Rolling it up would match no
  transactions and overwrite the event's already-correct figures with zeroes
  while reporting success.

## Two exclusions worth knowing

**Membership dues are not bar revenue.** They are rung at the same terminal
during the same hours, so the window catches them, but the Sales Report already
treats `channel === 'membership'` as a separable non-sales channel — counting
them here made the two consumers disagree about the same $40. Filtered in JS, not
as a `Query.notEqual`, because `channel` is NULL on ~986 pre-attribute rows and a
server-side inequality would drop every one of those legacy POS sales with it.

**Ticket revenue is joined by free-text event NAME**, because tickets carry no
event foreign key. An admin can rename an event at any time while its already-
written tickets keep the old string. So if a run finds **zero** matching tickets
for an event that currently records ticket revenue, it **refuses the write** and
reports the event in `needsReview` — that signature is exactly what a rename
looks like, and the write is an unconditional overwrite, so going ahead would
erase real banked revenue with nothing logged. A genuine full-refund of every
ticket produces the same signature and is rare enough to be worth a human
confirming.

For a **repeating** event name, `buildTicketBoundsByEventId` splits the timeline
at the midpoint between one occurrence's end and the next one's start, so each
occurrence claims only its own tickets. A name that occurs once gets no bounds at
all — an unbounded match is what keeps a late-written ticket (a door sale rung
after close, or a payment recovered days later by `Admin-VerifyZeffyTickets`)
counted.

## Response

```json
{
  "processed": 3,
  "updated": ["68e4..."],
  "failures": [{ "id": "...", "name": "...", "error": "..." }],
  "skipped": [{ "id": "...", "name": "...", "reason": "no usable sales window …" }],
  "needsReview": [{ "id": "...", "name": "...", "reason": "rollup found no tickets matching the name …" }]
}
```

`500 { error: "Failed to list events" }` if the event listing fails.

Category and ingredient listings are best-effort: a failure there is logged and
the run continues with less accurate alcohol/food classification and incomplete
COGS, rather than producing nothing.

## Scopes

| Scope | Why |
| --- | --- |
| `documents.read` | Page `Events`, `Transactions`, `Categories`, `ingredients`, `tickets`. |
| `documents.write` | Write the rollup onto `Events`. |

## Environment variables

None.

## Configuration

| Setting | Value |
| --- | --- |
| Runtime | `node-16.0` |
| Entrypoint | `src/main.js` |
| Build command | `npm i` |
| Timeout | 120s |

Deploy: `appwrite push function --function-id admin-rollup-event-sales`

120 seconds covers every due event × (its transactions + its tickets), plus the
full category and ingredient catalogues once. A first run after a long gap is the
one most likely to hit that ceiling; it is safe to re-invoke, since each event's
write is independent and the whole thing is an idempotent overwrite.

## Calling Appwrite's own API from inside a function

See the DNS-patch note in `functions/Giftcard-Lookup/README.md`.
