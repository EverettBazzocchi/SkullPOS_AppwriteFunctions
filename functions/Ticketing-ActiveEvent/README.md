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
    "barCloseTime": "02:00",
    "startsAt": "2026-09-13T22:00:00.000Z",
    "endsAt": "2026-09-14T07:00:00.000Z",
    "barOpensAt": "2026-09-14T03:00:00.000Z",
    "barClosesAt": "2026-09-14T07:00:00.000Z"
  },
  "multipleActive": false,
  "activeCount": 1
}
```

`toPublicEvent` is deliberately an **allowlist**, not a denylist — a financial
column added to `Events` later must not start leaking because nobody remembered
to exclude it.

- **`standardTicketPrice`** falls back to 3000 cents only when the stored value
  is not a usable number. A plain `|| DEFAULT` would have rewritten a
  legitimately free (0-cent) event into a CA$30 charge. Matches the door client's
  own fallback so the two cannot disagree about what a ticket costs.
- **`sellsAlcohol` / `barOpensAt` / `barClosesAt`** are the alcohol gate.
  `sellsAlcohol` mirrors the column's own `false` default; the two instants are
  normalized to ISO or `null`, and every client fails the gate closed on `null` —
  an unset window hides alcohol rather than opening the bar. None of these
  carries financial meaning.
- **`barOpenTime` / `barCloseTime`** are the legacy `"HH:mm"` form of that same
  window and are **still projected on purpose**, even though the attributes are
  being retired from `Events`. The register and both menu boards still read them
  as their fallback, and each runs on its own deploy cycle: a build sitting on the
  bar or facing the room does not update because this function did. They stay
  until every client has shipped *and* is confirmed on the device. An extra
  projected field costs nothing; a missing one closes the alcohol gate on a floor
  that is open. `doc.<field> ?? null` already survives the attribute's deletion —
  a missing attribute simply reads as `undefined` — so this projection needs no
  further edit when the schema drops them, only the eventual removal of these two
  keys once the clients are done.
- **`startsAt` / `endsAt`** are the event's own window, projected alongside, so a
  client can gate on a real timestamp instead of recombining `date`'s calendar day
  with a wall-clock string — the recombination that let the menu board (which
  accepts a bare `"1800"`) and the register (which does not) disagree about the
  very same event.

## Responses

| Status | Body | What it means operationally |
| --- | --- | --- |
| `200` | `{ event: {...}, multipleActive, activeCount }` | The active event. |
| `200` | `{ event: null }` | **Not an error** — nothing is running right now. The client shows its own generic entry-pass label, which is correct, and which is distinguishable from the `401` this function exists to fix. Deliberately carries no `multipleActive`/`activeCount`: this exact shape is what every client already fails closed on, and there is nothing to warn about when nothing is active. |
| `500` | `{ error: "Failed to load the active event" }` | The `Events` query failed. Every floor surface degrades: the door shows its generic label and the bar hides alcohol. |

## Which event wins when more than one is active

Nothing in the schema or the admin app stops two events carrying `isActive`
(`Events.isActive` is a plain optional boolean and the admin app writes the
collection directly), so this function has to have an answer.

**The rule: the most recently updated active event wins** —
`orderDesc('$updatedAt')`, i.e. the one whoever is on shift just saved.

That replaces `Query.limit(1)` with no order clause at all. Verified read-only
against the live instance (Appwrite 1.9.0) rather than assumed: an unordered
`limit(3)` over the 95 tickets named `Everetts Test event ignopre` returns
sequences 1, 16, 17 — byte-identical to the same query with
`orderAsc('$createdAt')`, and the exact reverse of `orderDesc('$updatedAt')`,
which returns sequence 219 (created 2026-09-12T18:40, updated 18:46) first. So
the default order follows creation and ignores updates entirely: the **oldest**
active event won, and re-ticking a newer one did nothing. That is why the floor
could silently follow an event nobody meant.

Two more things follow from that:

- **More than one active event is reported, not hidden.** `activeCount` is the
  server-side `total` (accurate past the fetch limit), `multipleActive` is the
  flag, and the same sentence is written to the function's **Errors** view naming
  the event that won. Still a `200` with a usable event — this is a warning about
  the data, not a failed request.
- **An event left active with `testing: true` is stepped over** in favour of the
  first non-test active event. If *every* active event is a test event it is
  still served, loudly, because returning `null` would close the alcohol gate on
  the register and both menu boards and drop the door to its CA$30 default —
  strictly worse than today. `testing` is only honoured when explicitly `true`;
  it was added 2026-09-12 and is absent on two of the three live event rows, and
  a server-side `Query.notEqual('testing', true)` would drop those NULLs outright.

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
