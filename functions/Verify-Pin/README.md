# Verify-Pin

Verifies a quick-access PIN for the POS's restricted "cashier mode" (no
refunds, sales reports capped at 24 hours).

PINs live in the `PINS_JSON` **secret** environment variable, not a
database collection -- reading one here would mean a network round trip to
this instance's own API just to check a handful of PINs, when an env var
needs no network call at all and gets the same write-only protection as
the Stripe keys. PINs are stored as `sha256(pin)`, never in plaintext, and
the variable is secret (write-only) so no one -- including this codebase's
own tooling -- can read the value back out once set.

On a successful match, this function DOES make one network call to this
instance's own API (via `appwriteClient.js`'s DNS-patch workaround for a
self-hosted quirk where the public hostname doesn't resolve from inside a
function) -- see "Payment-team membership" below.

## Request body

```json
{ "pin": "1234" }
```

## Response

`{ "ok": true, "label": "Bartender", "selfCheckout": false }` or
`{ "ok": false }`. Never reveals whether a PIN exists, how many are
configured, or any hash -- just whether this one matched. `selfCheckout`
is `true` only for a PIN flagged as kiosk-only (see below) -- the client
uses it to route a self-checkout PIN to `/self-checkout` instead of the
staff `/pos` screen, so getting this flag right is what keeps a kiosk PIN
from ever opening the full staff UI.

## Payment-team membership

Every PIN-based session (staff cashier or self-checkout kiosk) is anonymous
and deliberately NOT a member of `STAFF_TEAM_IDS` (that's what keeps the
24h report clamp and no-refunds restriction real -- see Sales-Report/
Transactions-List). But the Stripe functions (Terminal connection token,
create/cancel PaymentIntent) need *some* team membership to satisfy their
`execute` permission. On a successful match, this function adds the
caller (`req.headers['x-appwrite-user-id']`) to a separate, narrower team
-- `PIN Payment Access` (`6a9cbb1c95ea7d59dd8c`) -- that's listed in those
functions' `execute` permissions alongside `STAFF_TEAM_IDS`, but nowhere
that checks `isStaff()`.

This requires the caller's session to already exist by the time this
function runs -- the client (`POS/src/utils/api.js`'s `loginWithPin`)
creates the anonymous session first, then calls Verify-Pin, in that order.
If somehow there's no caller id on the request, or granting the membership
fails, the PIN check itself still succeeds -- the session just won't be
able to charge a card until that's resolved (logged as an error, not
surfaced to the caller).

**Known gap:** this grant has no expiry and nothing deletes it, so setting a
PIN row to `active: false` does not revoke access already handed out to a
device that used it. It can't simply be given a TTL here -- a self-checkout
kiosk is designed never to re-enter its PIN, so expiring the membership
server-side would strand it mid-shift. The durable fix is to replace the
team grant with a short-lived claim the Stripe functions validate. Until
then, every grant is logged as `PIN-GRANT user=<id> label=<pin label>` so a
revoke can be carried out by hand against the team's member list.

## Rate limiting

Failed attempts are counted in the shared `rate_limits` collection, which
has exactly three attributes -- `attempts`, `windowStart`, `lockedUntil`.
Nothing else may appear in a document payload (Appwrite's structure
validator 400s the whole write), so every write goes through
`toPersistedState()`; `justLocked` is a return value only, never a field.

Two buckets are counted per failed attempt:

| bucket | key | ceiling | why |
| --- | --- | --- | --- |
| caller | `pin_c_<sha1>` of `x-appwrite-user-id`, else the IP | 5 | per device, so one till's typos don't lock out the venue |
| IP | `pin_ip_<sha1>` of the trusted IP | 30 | a caller can mint a fresh session for a fresh caller bucket, so this is the ceiling that can't be walked away from |

The IP is the **rightmost** element of `x-forwarded-for` -- the one the
trusted proxy appended. Everything to its left is caller-supplied, and
Appwrite's `createExecution` lets a caller set headers outright. This
assumes exactly one trusted proxy in front of the runtime; add another and
the trusted element moves.

Reads fail **open** (a database hiccup must not lock staff out of the till)
but writes fail **closed**: if a failed attempt cannot be recorded, the
request is answered `503` rather than with a normal wrong-PIN response,
because an attempt that isn't counted is an attempt that doesn't exist.

A correct bartender PIN presented outside its event window is **not** a
failed attempt -- the credential was right, only the timing was wrong.

## Configuration

| Setting     | Value                                               |
| ----------- | ---------------------------------------------------- |
| Runtime     | Node (16.0), matching the other functions             |
| Entrypoint  | `src/main.js`                                         |
| Build       | `npm i`                                               |
| Execute     | `any` (must be callable before any session exists)   |
| API key scopes | `teams.write`, `teams.read` (to grant payment-team membership) |

## Managing PINs

`PINS_JSON` is a JSON array of
`{ "hash": "<sha256>", "label": "...", "active": true, "selfCheckout": false }`.
There's no admin UI yet -- to add/rotate PINs, build the full array
(there's no partial-update for a single env var) and set it:

```bash
node -e "console.log(require('crypto').createHash('sha256').update('1234').digest('hex'))"

appwrite functions update-variable --function-id <id> --variable-id <id> \
  --key PINS_JSON --secret \
  --value '[{"hash":"<hash1>","label":"Bartender","active":true},{"hash":"<hash2>","label":"Manager","active":true}]'
```

Set `"active": false` to disable a PIN without removing it from the list.

Set `"selfCheckout": true` on a PIN record to make it a **kiosk-only** PIN
instead of a staff-cashier PIN -- entering it signs the device into the
self-checkout screen (`/self-checkout`: click/scan to add, card-only
payment, no refunds/history/reporting) rather than the regular staff POS.
Omit the field (or leave it `false`) for every ordinary staff PIN:

```bash
appwrite functions update-variable --function-id <id> --variable-id <id> \
  --key PINS_JSON --secret \
  --value '[{"hash":"<hash1>","label":"Bartender","active":true},{"hash":"<hash2>","label":"Self-Checkout Kiosk 1","active":true,"selfCheckout":true}]'
```
