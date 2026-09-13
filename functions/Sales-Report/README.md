# Sales-Report

**Function ID:** `6a9c687535280f239b5f`

Aggregates the sales report server-side: items sold, revenue, COGS,
alcohol/food/non-alcoholic/other category splits, and a per-payment-method
breakdown. The client has no read access to `Transactions`, so every report
request — admin or not — goes through here.

## Who may call it

Live `execute`: `users` — any signed-in session, including anonymous PIN
sessions. Verified 2026-09-13 with
`appwrite functions get --function-id 6a9c687535280f239b5f`.

The restriction is **per-caller, not per-execute-permission**: the date range is
clamped to the last 24 hours unless the caller is a confirmed member of the admin
team (`68e35aed00144b8cde9d`), checked with `users.listMemberships()` against
`x-appwrite-user-id` — a header Appwrite sets from the verified session and the
client cannot spoof.

**Only the admin team counts as unrestricted.** A POS-team member gets the same
24h clamp as a quick-access PIN cashier or a no-team Google account. POS
membership still grants other things (it is on the `execute` list of the Stripe
functions and `Transactions-List`), just not this.

If the membership check fails for any reason the caller is treated as
**non-admin** — a degradation, never a refusal. There is no `403` path here.

## Admin-only extras

- Unclamped date range (`startDate` omitted means all time).
- A `previous` field: the same-shape aggregate for the immediately preceding
  period of equal length, for the UI's comparison deltas. Withheld from everyone
  else, because a delta against a period further back than 24h would leak exactly
  the aggregate the clamp exists to hide. Only produced when the request had a
  bounded start — an "all time" request has no equal-length prior period.

## Request body

```json
{ "startDate": "2026-01-01T00:00:00.000Z", "endDate": "2026-01-02T00:00:00.000Z", "test": false, "channel": "pos" }
```

- `startDate` — omit for all time (honoured for admin only; clamped to
  `endDate − 24h` otherwise).
- `endDate` — defaults to now.
- `test` — `true` selects `testing: true` rows, `false` everything else.
- `channel` — optional, `"pos"` or `"self_checkout"`, to compare kiosk sales
  against register sales. Omitted means no filter at all, every channel combined.

## Response

`200` with the aggregate plus `previous` (admin only, else `null`) and
`restricted` (`true` when the 24h clamp applied). Fields:

`ItemsSold[]` (`name`, `quantity`, `revenue`, `cogs`), `totalSales`, `tips`,
`giftcardAmount`, `cashAmount`, `cardAmount`, `cardAmountInclTips`,
`discountAmount`, `amountPaid`, `amountPaidInclTips`, `cogs`, `alcoholAmount`,
`foodAmount`, `nonAlcoholicDrinksAmount`, `otherAmountSold`.

`400 { error: "Invalid request body" }` for unparseable JSON.

### Tip-inclusive vs tip-exclusive

`cardAmount` and `amountPaid` are what was paid toward the **cart**, exclusive of
tips — the right numbers for item and category revenue, which must keep summing
to them, but they reconcile against nothing: a Stripe payout and the customer's
statement both include the tip.

So two extra fields exist rather than redefining the originals:

- **`cardAmountInclTips`** — `cardAmount` plus only the tips attributable to a
  card leg. This is the Stripe-payout figure.
- **`amountPaidInclTips`** — `amountPaid` plus every recorded tip, answering "how
  much money changed hands".

Tips are only ever taken on the reader, so `Transaction-RecordPayment` keeps
`leg.amount` tip-exclusive and carries the tip as `leg.tip`. Legacy rows predate
the per-leg field and carry only `transaction.tip`; that tip is attributed to the
card leg when the sale had one, and to nothing at all when it did not, rather
than inventing card money that was never deposited.

Only `status: 'complete'` transactions are counted. Every page of
`Transactions`, `Categories` and `ingredients` is fetched via cursor paging, so
there is no silent 100-row cap.

## Scopes

| Scope | Why |
| --- | --- |
| `documents.read` | Read `Transactions`, `Categories` (`67c9ffdd0039c4e09c9a`) and `ingredients`. |
| `users.read` | The admin-team `listMemberships` check. Without it every caller is clamped to 24h. |

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

Deploy: `appwrite push function --function-id 6a9c687535280f239b5f`

15 seconds is the whole budget for paging every matching transaction plus the
full category and ingredient catalogues, twice over for an admin request that
also builds `previous`. A very wide date range is the thing that will time this
out first.

## Calling Appwrite's own API from inside a function

See the DNS-patch note in `functions/Giftcard-Lookup/README.md`.
