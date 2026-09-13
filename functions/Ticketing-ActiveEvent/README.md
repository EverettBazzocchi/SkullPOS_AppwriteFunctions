# Ticketing-ActiveEvent

**Function ID:** `ticketing-active-event`

Returns the currently-active event, reduced to the handful of fields a
front-of-house client legitimately needs. This is the single read path every
floor surface uses for "what's on tonight": the door app, the POS register, and
the menu boards.

## Why it exists

The `Events` collection (`68e400210008d19bb5c9`) is read-restricted to the admin
team, while every front-of-house surface authenticates as an anonymous or shared
session belonging to no team — so the client's own read `401`s. When it did, the
door app silently fell back to a generic "Standard Entry Pass" label, and the
register and menu boards silently treated the alcohol gate as closed and dropped
every alcohol item.

The obvious shortcut — granting those sessions read on `Events` — would hand a
device sitting on the bar, or a screen facing the room, full read access to every
event's sales rollup: revenue, profit, COGS, tips, cash/card splits. Appwrite
permissions are per-collection, never per-field. **This function is the field
filter Appwrite cannot express.** It reads as the server and returns only what
the floor needs.

## Who may call it

Live `execute`: `users` — any signed-in session, including anonymous ones.
Verified 2026-09-13 with
`appwrite functions get --function-id ticketing-active-event`. That is the point:
the floor devices are exactly the no-team sessions this serves.

## Request body

None. Any body is ignored.

## Response

```json
{
  "event": {
    "$id": "...",
    "eventId": null,
    "name": "...",
    "description": null,
    "date": "2026-09-13T22:00:00.000Z",
    "location": null,
    "standardTicketPrice": 3000,
    "currency": "CAD",
    "isActive": true,
    "sellsAlcohol": true,
    "barOpenTime": "22:00",
    "barCloseTime": "02:00"
  }
}
```

`toPublicEvent` is deliberately an **allowlist**, not a denylist — a financial
column added to `Events` later must not start leaking because nobody remembered
to exclude it.

- **`standardTicketPrice`** falls back to 3000 cents only when the stored value
  is not a usable number. A plain `|| DEFAULT` would have rewritten a
  legitimately free (0-cent) event into a CA$30 charge. Matches the door client's
  own fallback so the two cannot disagree about what a ticket costs.
- **`sellsAlcohol` / `barOpenTime` / `barCloseTime`** are the alcohol gate.
  `sellsAlcohol` mirrors the column's own `false` default; the two window strings
  stay raw `"HH:mm"` because the clients already own the parsing (POS's
  `isWithinBarHours`) and all of them fail closed on `null` — an unset window
  hides alcohol rather than opening the bar. None of the three carries financial
  meaning.

## Responses

| Status | Body | What it means operationally |
| --- | --- | --- |
| `200` | `{ event: {...} }` | The active event. |
| `200` | `{ event: null }` | **Not an error** — nothing is running right now. The client shows its own generic entry-pass label, which is correct, and which is distinguishable from the `401` this function exists to fix. |
| `500` | `{ error: "Failed to load the active event" }` | The `Events` query failed. Every floor surface degrades: the door shows its generic label and the bar hides alcohol. |

Only the first document with `isActive: true` is returned. Two events flagged
active at once means whichever Appwrite returns first wins.

## Scopes

| Scope | Why |
| --- | --- |
| `documents.read` | Query `Events`. |

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

Deploy: `appwrite push function --function-id ticketing-active-event`

## Calling Appwrite's own API from inside a function

See the DNS-patch note in `functions/Giftcard-Lookup/README.md`.
