# Bartender-Sales

**Function ID:** `bartender-sales`

Returns one bartender's own sales and tips, for the "my sales" view in POS
(`POS/src/components/pos/mySalesView.js`). Called from the bartender's own
logged-in session — an anonymous PIN session, like every other function a
bartender PIN can reach.

## Who may call it

Live `execute`: `users` — any signed-in session, including anonymous ones.
Verified 2026-09-13 with `appwrite functions get --function-id bartender-sales`.

**Be clear about what this does and does not prove.** The function filters by
`bartenderId` server-side rather than trusting the client to ask only for its
own, but there is no ownership proof beyond that: a bartender id is not a secret
(it reaches every POS client via `checkout.js`), and it cannot be resolved from
the session either, because a bartender signs in on a shared anonymous PIN
session with no user→bartender mapping to check against. This mirrors the
exposure posture `Giftcard-Lookup` and `Transactions-List` already accept for a
PIN session; it is not a stronger guarantee.

What would actually bound this is narrowing the `execute` list to the staff teams
— an Appwrite-side permission change, not a code one. It is currently `users`.

## Request body

```json
{ "bartenderId": "..." }
```

## Response

```json
{
  "salesTotal": 48250,
  "tipsTotal": 6100,
  "transactionCount": 37,
  "transactions": [
    { "id": "...", "createdAt": "...", "total": 1250, "tip": 200, "status": "complete", "paymentMethod": "stripe" }
  ],
  "listTruncated": false
}
```

- **Totals cover every matching row.** They are computed over the full paged
  result, not over the listed page. This used to reduce a single capped page into
  the headline figures, so past 200 lifetime sales the totals silently stopped
  being totals — while a tip-out is calculated from exactly those figures.
- **The list is capped at 200** most-recent rows. `listTruncated` says only that
  the *list* was cut short, so the client can show "showing the most recent 200"
  without implying the totals were.
- Rows with status `complete` and `refunded` are both listed; **only `complete`
  counts toward the totals** — a refunded sale is not money the bartender brought
  in.
- `testing: true` rows are excluded. Every other money report already excluded
  them and this one did not, so practice sales rung up on a staging build against
  a real `bartenderId` inflated a real person's earnings.

## Responses

| Status | Body | What it means operationally |
| --- | --- | --- |
| `200` | see above | |
| `400` | `{ error: "Invalid request body" \| "Missing bartenderId" }` | Malformed call. |
| `404` | `{ error: "Bartender not found" }` | The id does not resolve in `bartenders`. |
| `500` | `{ error: "Failed to load sales" }` | The `Transactions` query failed. |

## Scopes

| Scope | Why |
| --- | --- |
| `documents.read` | Read the `bartenders` row; page `Transactions` filtered by `bartenderId`. |

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

Deploy: `appwrite push function --function-id bartender-sales`

## Calling Appwrite's own API from inside a function

See the DNS-patch note in `functions/Giftcard-Lookup/README.md`.
