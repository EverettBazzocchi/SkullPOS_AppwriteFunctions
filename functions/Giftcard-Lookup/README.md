# Giftcard-Lookup

Looks up a giftcard by its UPC/code, server-side. Used by the POS when a
giftcard is scanned/entered at checkout.

The client has no read access to the giftcards collection (removed as part
of the POS PIN-system security plan -- see `AppwriteFunctions`'s
repo-level notes and `POS/src/utils/giftcard.js`), since a blanket read
grant would let any session, anonymous quick-access PIN sessions included,
list every giftcard code and balance in the system. This function only
ever returns the single card matching the exact code it was asked about.

## Why it is gated

The `{id, balance}` it returns is exactly the pair `Transaction-RecordPayment`
accepts as `giftcardId` to debit a card, and every live UPC shares a fixed
`75855` prefix -- so the real search space is the five digits after it, a
100,000-wide keyspace one caller could walk end to end in an afternoon. Two
controls sit in front of the lookup:

1. **Caller identity.** The caller must hold a confirmed membership in the
   admin team, the POS team, or the `PIN Payment Access` team `Verify-Pin`
   joins a device to once a PIN is accepted. A bare anonymous session --
   which is what `execute: ["users"]` actually admits -- belongs to none of
   them and gets a 403.
2. **Enumeration throttle.** Lookups that match nothing are counted per
   caller IP in the shared `rate_limits` collection (`gcl_...` docs, the same
   collection `Verify-Pin` and `quick-access-login` use). Ten misses inside 15
   minutes lock that IP out for 15 minutes. The lockout is checked *before*
   the collection is queried, so a locked-out caller gets an identical 429 for
   a code that exists and one that does not.

While `execute` is still `users`, these two **are** the access control, not a
second copy of one -- so both fail closed:

- a caller whose team membership cannot be checked (no injected
  `x-appwrite-key`, or a Users API outage) gets `503`, not a pass;
- a miss whose counter cannot be written -- or a counter that cannot be read --
  gets `503`, because a miss that isn't counted is a free guess and this
  endpoint is an enumeration oracle the moment it stops counting. (A write
  failure while *clearing* the counter after a real card is found stays
  non-fatal: it can only leave stale misses, never grant a guess.)

**This requires the `users.read` and `documents.write` scopes to be granted.**
Without them the function now refuses every lookup rather than -- as it did
before -- allowing every lookup with a log line. Both checks were previously
dead: with no declared scopes Appwrite injects no key, so the membership check
could never run, and with no `documents.write` every counter write threw and
was swallowed.

## Request body

```json
{ "code": "ABCD1234" }
```

## Response

`{ "found": true, "id": "...", "balance": 1500 }` or `{ "found": false }`.
Never reveals more than the one matched card. `403 {"error":"Unauthorized"}`
for a caller outside the allowed teams; `429 {"found": false, "error": ...}`
while throttled.

## Configuration

| Setting     | Value                          |
| ----------- | -------------------------------- |
| Runtime     | Node (16.0)                      |
| Entrypoint  | `src/main.js`                    |
| Build       | `npm i`                          |
| Execute     | `team:68e35aed00144b8cde9d` (admin), `team:68ffcecc0026f78f0af8` (POS), `team:6a9cbb1c95ea7d59dd8c` (PIN Payment Access) -- narrowed off `users` in `appwrite.config.json`, **live until pushed**. Exactly the same three teams the in-function check enforces, so no caller the function would serve loses access. |
| Scopes      | `documents.read`, `users.read` (team check), `documents.write` (throttle counters) -- set in `appwrite.config.json`, **must be pushed (`appwrite push functions`) or this function refuses every lookup** |

## Note on calling Appwrite's own API from within a function

This self-hosted instance's function-execution sandbox can't resolve its
own public hostname via the normal `getaddrinfo` path (used internally by
`fetch`/`http`) -- `dns.resolve4` (talks to nameservers directly,
bypassing `getaddrinfo`) works fine though. `src/appwriteClient.js` patches
the global `dns.lookup` so any HTTP client resolving this hostname gets the
known-good IP instead of hanging/`EAI_AGAIN`; the URL/Host header is
untouched, only the DNS step is bypassed. Every function that needs to
call Databases/Teams uses this same helper.
