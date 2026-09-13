# Verify-Pin

**Function ID:** `6a9c4acd49bc458907e7`

Verifies a quick-access PIN and, on success, grants the calling session the team
membership it needs to charge a card. Three kinds of PIN resolve through here:

- **POS cashier** — `pins` rows with `system: 'pos'`. Restricted mode: no
  refunds, sales reports capped at 24 hours.
- **Self-checkout kiosk** — `pins` rows with `system: 'self_checkout'`. Returns
  `selfCheckout: true` so the client routes to `/self-checkout` instead of the
  staff `/pos` screen. Getting that flag right is what keeps a kiosk PIN from
  opening the full staff UI.
- **Bartender** — rows in the separate `bartenders` collection. These carry an
  extra rule none of the others do (valid only near one of the bartender's
  assigned events) and resolve to a real `bartenderId`, so POS can attribute
  every sale back to that person.

## PINs live in the database, not an environment variable

PINs are `sha256(pin)` rows in the shared `pins` collection, managed from the
admin app through `Admin-GeneratePin` (create / regenerate / revoke). Bartender
PINs are hashed the same way in `bartenders`.

The `PINS_JSON` secret variable this function was originally built around is
**gone from the code** — `src/main.js` never reads `process.env.PINS_JSON`. It is
still set on the live function; it does nothing, and editing it changes nothing.

## Who may call it

Live `execute`: **`any`**. Verified 2026-09-13 with
`appwrite functions get --function-id 6a9c4acd49bc458907e7`. It has to be — the
caller has no credentials yet; that is the point.

That makes the rate limiter, not an allowlist, the real control.

## Rate limiting

Two buckets are checked and written on **every** failed attempt, both in the
shared `rate_limits` collection:

| Bucket | Document id | Ceiling | Why |
| --- | --- | --- | --- |
| caller | `pin_c_<sha1>` of `x-appwrite-user-id` (else the IP) | 5 | Per device, so one till's typos do not lock out every other device on the venue's egress. |
| IP | `pin_ip_<sha1>` of the trusted IP | 30 | A caller can mint a fresh anonymous session for a fresh caller bucket, so this is the ceiling that cannot be walked away from. |

Window and lockout are both 15 minutes.

The IP is the **rightmost** element of `x-forwarded-for` — the one the trusted
proxy appended. Everything to its left is caller-authored, because Appwrite's own
`createExecution` lets a caller supply an arbitrary header map. This assumes
exactly one trusted proxy in front of the runtime (which is what the deployment
behind `api.cloud.shotty.tech` is); add another and the trusted element moves to
Nth-from-last.

**Reads fail open, writes fail closed.** A rate-limit storage hiccup must never
lock staff out of the till, so an unreadable counter just proceeds. But a failed
attempt that could not be *recorded* leaves no trace and the next attempt starts
from zero — i.e. the endpoint is running with no brute-force defence at all — so
that is answered `503`, turning a silent permanent hole into a visible outage.

`rate_limits` has exactly three attributes: `attempts`, `windowStart`,
`lockedUntil`. Nothing else may appear in a write payload (Appwrite's structure
validator rejects the whole document), so every write goes through
`toPersistedState()`. `justLocked` is a return value, never a field — passing it
through as one is what made every single write 400 for the limiter's entire life.

**Known gap:** the counter is a read-modify-write, not an atomic increment, so a
concurrent burst all reads the same `attempts` and all writes back the same
successor. Appwrite 1.9.0 serves `PATCH .../documents/{id}/{attribute}/increment`,
but reaching it needs `Databases.incrementDocumentAttribute` from node-appwrite
17+, which needs Node 18+ — and this runtime is `node-16.0`. Closing it is a
runtime bump plus an SDK major, not an edit to this file. `quick-access-login`
talks raw HTTP and so already calls that endpoint directly; see
`recordFailureForBucket` there for the shape this should take.

## Bartender event window

A bartender PIN works only within **1 hour either side** of any of that
bartender's assigned events' windows. The window (`src/eventWindow.js`) is the
**union** of the bar's own hours and the event's, read straight off the
`barOpensAt`/`barClosesAt` and `startsAt`/`endsAt` instants — so a bartender
rostered before doors, or kept on past last call, is never cut off by whichever
pair is narrower. Nothing is recombined from a calendar day and a wall clock,
and no timezone is inferred anywhere on the server.

`date` is the last legacy field still read, and only ever as a **start** anchor
for a row carrying none of the four instants. The `barOpenTime`/`barCloseTime`
`"HH:mm"` pair this module used to derive a *duration* from is gone with the
attributes themselves, so there is no legacy route to an **end** any more.

A row with a start but no end (no `barClosesAt`, no `endsAt`) collapses to the
start instant, making the effective window the flat ±1h — deliberately **not** a
refusal. Returning nothing would mean the PIN never verifies for that event, and
an out-of-window PIN gets a response byte-identical to a wrong one (below), so a
bartender at the till would get a flat "no" with no reason and no fix she can
make from the floor. `Admin-RollupEventSales` decides the same shape the other
way, on purpose: there a guessed window rewrites real revenue.

A correct bartender PIN presented **outside** its window gets a response that is
byte-for-byte identical to a no-match, and is **not** counted as a failed
attempt. The identical body matters: a distinguishable message made this endpoint
a PIN-existence oracle — walk the 10,000-code space at any hour, get that message
on exactly one code, and you have identified a live bartender PIN to replay at
the venue's next advertised event. The human-readable reason exists only in the
execution log.

## Payment-team membership

On success, the calling session is added to **PIN Payment Access**
(`6a9cbb1c95ea7d59dd8c`), which is on the `execute` list of
`stripe-getConnectionToken`, `Stripe-CreatePaymentIntent`,
`Stripe-CancelPaymentIntent`, `Giftcard-Lookup`, `Transactions-List` and
`Transaction-EmailReceipt`.

That team is deliberately **not** the admin team: a PIN session must be able to
charge a card without counting as admin for `Sales-Report`'s and
`Transactions-List`'s checks, which is what keeps the 24h clamp and the
no-refunds restriction real.

The session must already exist when this runs — `loginWithPin` in
`POS/src/utils/api.js` creates the anonymous session first, then calls this. If
the grant fails, the PIN is still valid; the device just cannot charge a card
until it is resolved (logged as an error, not surfaced to the caller).

**Known gap:** the grant has no expiry and nothing deletes it, so setting a PIN
row to `active: false` does **not** revoke access already handed to a device that
used it. It cannot simply be TTL'd here — a self-checkout kiosk is designed never
to re-enter its PIN, so expiring it server-side would strand the kiosk mid-shift.
Until a short-lived claim replaces the durable team, every grant is logged as
`PIN-GRANT user=<id> label=<label> bartenderId=<id>`, and a revoke is carried out
by hand against the team's member list in the console.

## Request body

```json
{ "pin": "1234" }
```

## Responses

| Status | Body | What it means operationally |
| --- | --- | --- |
| `200` | `{ ok: true, label, selfCheckout, bartenderId }` | Verified. `bartenderId` is non-null only for a bartender PIN. |
| `200` | `{ ok: false }` | No match — or a correct bartender PIN outside its event window. Deliberately indistinguishable. |
| `400` | `{ ok: false, error: "Invalid request body" \| "Missing pin" }` | Malformed call. |
| `429` | `{ ok: false, error: "Too many incorrect PIN attempts. Try again in N minute(s)." }` | A bucket is locked. Either wait, or clear the `pin_c_*` / `pin_ip_*` row in `rate_limits`. |
| `500` | `{ ok: false, error: "Server not configured" }` | The `pins` or `bartenders` query failed. |
| `503` | `{ ok: false, error: "PIN verification is temporarily unavailable. Please try again shortly." }` | A failed attempt could not be recorded. Deliberate fail-closed; the log carries `RATE-LIMIT-WRITE-FAILED` with Appwrite's own code and type. |

## Scopes

| Scope | Why |
| --- | --- |
| `documents.read` | Query `pins`, `bartenders` (with `events.*` selected), and the `rate_limits` rows. |
| `documents.write` | Persist the two rate-limit counters. |
| `teams.write` | `teams.createMembership` into PIN Payment Access. |

## Environment variables

`PINS_JSON` is set on the live function and **is not read**. See above.

## Configuration

| Setting | Value |
| --- | --- |
| Runtime | `node-16.0` |
| Entrypoint | `src/main.js` |
| Build command | `npm i` |
| Timeout | 15s |
| Schedule | none |

Deploy: `appwrite push function --function-id 6a9c4acd49bc458907e7`

## Calling Appwrite's own API from inside a function

See the DNS-patch note in `functions/Giftcard-Lookup/README.md`.
