# Giftcard-Lookup

**Function ID:** `6a9c5c1acb643536564a`

Looks up one gift card by its UPC/code, server-side. Called by the POS when a
card is scanned or typed at checkout.

The client has no read access to the `giftcards` collection, so this is the only
way to resolve a code. That matters because the `{ id, balance }` this returns is
exactly the pair `Transaction-RecordPayment` accepts as `giftcardId` to debit a
card — and every live UPC shares a fixed `75855` prefix, leaving a 100,000-wide
keyspace one caller could otherwise walk end to end in an afternoon.

## Who may call it

Live `execute` list, read from the project on 2026-09-13
(`appwrite functions get --function-id 6a9c5c1acb643536564a`):

- `team:68e35aed00144b8cde9d` — admin
- `team:68ffcecc0026f78f0af8` — POS
- `team:6a9cbb1c95ea7d59dd8c` — PIN Payment Access

Appwrite checks that list when the execution is created. `classifyCaller` in
`src/main.js` adds exactly one thing on top: a request with no
`x-appwrite-user-id` is refused `403`. That is the API-key-invocation case, the
only caller the `execute` list is not consulted for.

**No team lookup happens in this function any more.** It used to re-derive
membership through `users.listMemberships()` and `503` when that call failed; on
2026-09-13 07:51 UTC it failed and gift-card scanning at the bar stopped.
Removed in commit `02bee62`.

## The enumeration throttle

This is the control that guards the keyspace, and it is the one that still
**fails closed** — unlike the caller check above, nothing else enforces it, and
it can only break while the Appwrite Databases API is broken, at which point the
`giftcards` query cannot run either.

- Keyed on **`x-appwrite-user-id`**, not the client IP. It used to key on the
  leftmost `x-forwarded-for` element, which `createExecution` lets a caller set
  outright — so the bucket was choosable (rotate it for an unthrottled oracle, or
  pin it to another till's value to exhaust that till's budget). It was also
  wrong with honest callers: every till leaves the venue through one public IP,
  so all of them shared a single 10-attempt bucket and the eleventh legitimate
  scan of the night would have been refused venue-wide.
- 10 misses inside 15 minutes lock that **account** out for 15 minutes
  (`src/rateLimit.js`).
- Counters live in the shared `rate_limits` collection as `gcl_<sha1>` documents
  — distinct from `Verify-Pin`'s `pin_*`, `Transaction-EmailReceipt`'s `rcp_*`
  and `quick-access-login`'s `qa_*` rows in the same collection.
- The lockout is checked **before** the `giftcards` query runs, so a locked-out
  caller gets an identical answer for a code that exists and one that does not.
- A hit clears the caller's accumulated misses (only if there was state to
  clear). A failure while clearing is non-fatal — it can only leave stale misses,
  never grant a guess.

## Scopes

Live scopes, read from the project on 2026-09-13
(`appwrite functions get --function-id 6a9c5c1acb643536564a`):

| Scope | Status | Why |
| --- | --- | --- |
| `documents.read` | live, needed | Query `giftcards` by UPC; read the caller's `rate_limits` row. |
| `documents.write` | live, needed | Create/update the `rate_limits` counter. Without it every counter write throws, which is what once made the limiter decorative. |

`users.read` used to be declared here too, left over from the team-membership
lookup removed in commit `02bee62`. It was dropped in `db2c453` and that removal
is live — `src/` imports only `Databases`/`Query` from `node-appwrite` and never
touches the Users API, so the only remaining mention of `users.listMemberships`
is the comment in `main.js` explaining why it is gone.

A declared scope is real privilege: it is what makes Appwrite inject a dynamic
API key carrying that power into every execution. If a change here ever needs
the Users API again, add the scope deliberately rather than assuming it is still
there.

## Request body

```json
{ "code": "7585512345" }
```

## Responses

| Status | Body | What it means operationally |
| --- | --- | --- |
| `200` | `{ found: true, id, balance, eventId, active }` | Card resolved. `eventId` is non-null only for a DJ voucher; `active` is `false` for a deactivated card. Both are informational — the authoritative event/discount/revocation checks happen at payment time in `Transaction-RecordPayment`, so POS can show the right message before checkout is attempted. |
| `200` | `{ found: false }` | No card with that code. A miss was counted. |
| `400` | `{ error: "Invalid request body" }` / `{ error: "Missing code" }` | Malformed call from the client. |
| `403` | `{ error: "Unauthorized" }` | No session user — an API-key invocation. |
| `429` | `{ found: false, error: "Too many unrecognized giftcard codes…" }` | This device has burned 10 misses in 15 minutes. Wait it out, or clear its `gcl_*` row in `rate_limits`. |
| `500` | `{ error: "Lookup failed" }` | The `giftcards` query itself failed. |
| `503` | `{ error: "Giftcard lookup is temporarily unavailable — try again" }` | The throttle counter could not be read or written. **Scanning is down on purpose**: an uncounted miss is a free guess. Check the `rate_limits` collection and that `documents.write` is granted and pushed. |

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

Deploy: `appwrite push function --function-id 6a9c5c1acb643536564a`

## Calling Appwrite's own API from inside a function

This self-hosted instance's function sandbox cannot resolve its own public
hostname through `getaddrinfo` (which is what Node's `http`/`fetch` use), but
`dns.resolve4` works. `src/appwriteClient.js` patches the global `dns.lookup` so
any client resolving that hostname gets the known-good IP instead of hanging on
`EAI_AGAIN`. The URL and Host header are untouched — only the DNS step is
bypassed. Every function here that talks to Databases/Teams/Users/Storage uses
the same helper.
