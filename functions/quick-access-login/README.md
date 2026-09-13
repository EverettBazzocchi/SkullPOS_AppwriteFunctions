# quick-access-login

**Function ID:** `quick-access-login`

Lets ShottyTicketing door staff sign in with a short PIN instead of a password
baked into the client app. On a correct PIN it mints a short-lived custom token
for the **shared door-staff account** and returns `{ userId, secret }`; the
client exchanges that for a real session via `POST /account/sessions/token`.

This is the door-side counterpart to `Verify-Pin`. Both read the same `pins`
collection, managed by `Admin-GeneratePin`; this one matches
`system: 'ticketing'` rows, `Verify-Pin` matches `pos` and `self_checkout`.

## PINs live in the database, not environment variables

The original `QUICK_ACCESS_PIN`, plus an optional `QUICK_ACCESS_REVIEWER_PIN`
(a permanently-valid code for Stripe's Apps-on-Devices reviewer), were replaced
by `pins` rows so multiple named door codes can be generated, rotated and revoked
from the admin app, and so the PIN is hashed at rest rather than stored in
plaintext. The reviewer's code is now just another permanently-active row.

**Both variables are still set on the live function and neither is read** —
`index.js` references only `QUICK_ACCESS_USER_ID` and `APPWRITE_API_KEY`. Editing
them changes nothing.

## Who may call it

Live `execute`: **`any`**. Verified 2026-09-13 with
`appwrite functions get --function-id quick-access-login`. It has to be — the
caller has no credentials yet. The rate limiter is the real control.

## Rate limiting

Two buckets per failed attempt, in the shared `rate_limits` collection:

| Bucket | Document id | Ceiling |
| --- | --- | --- |
| caller | `qa_c_<sha1>` of `x-appwrite-user-id` (else the trusted IP) | 5 |
| IP | `qa_ip_<sha1>` of the trusted IP | 30 |

Window and lockout are both 15 minutes. The IP is the **rightmost**
`x-forwarded-for` element (see the same note in `Verify-Pin`'s README).

**The counter is incremented server-side**, via
`PATCH .../documents/{id}/attempts/increment` (served by Appwrite 1.7+; this
instance runs 1.9.0). This function talks raw HTTP rather than through the SDK,
so it is not bound by the node-appwrite version that blocks the same fix in
`Verify-Pin`. It matters: with a read-modify-write, 200 parallel requests each
read `attempts: 0`, each pass the lockout check, each try a candidate PIN, and
each write back `1` — the whole 4-digit space falls while the persisted counter
never exceeds 1. With a server-side increment, N concurrent failures persist as N.

Two paths are still plain writes because there is nothing to add to yet: opening
a bucket that has no row (a concurrent creator wins the 409 and this attempt
hands off to the increment), and a window that has aged out. An Appwrite older
than 1.7 answers the increment route with 404/405/501, and the code falls back to
the racy read-modify-write rather than failing every wrong PIN closed.

**A correct PIN is honoured even when the rate-limit collection is unreachable**
— a database hiccup must never lock real door staff out. **An incorrect one that
cannot be counted is refused (`503`)** — an attempt that is not counted is an
attempt that does not exist, and this endpoint mints a session token for a shared
account on a 4-digit code.

## Endpoint fallback and the DNS patch

This function talks to Appwrite over raw `http`/`https` rather than the SDK, so
it carries its own copy of the DNS workaround: the sandbox cannot resolve the
instance's own public hostname through `getaddrinfo`, so `dns.lookup` is patched
with the address from `dns.resolve4`.

It also tries a list of candidate endpoints (`_shared/appwriteEndpoints.js`) and
threads the first one that answered through the later calls. Without that, every
internal candidate that 404s or times out gets retried from scratch on each call
and the combined latency can blow past the 30s timeout before reaching the real
endpoint.

## Request body

```json
{ "pin": "1234" }
```

## Responses

| Status | Body | What it means operationally |
| --- | --- | --- |
| `200` | `{ userId, secret }` | Exchange the secret for a session within 60 seconds; it is single-use. |
| `401` | `{ error: "Incorrect PIN" }` | No matching active `ticketing` row (also returned for an empty PIN). |
| `429` | `{ error: "Too many incorrect PIN attempts…", retryAfterSeconds }` | A bucket is locked. Wait, or clear the `qa_c_*` / `qa_ip_*` row. |
| `500` | `{ error: "Quick access is not configured on the server (missing QUICK_ACCESS_USER_ID)." }` | The door cannot sign in at all until that variable is set. |
| `500` | `{ error: "APPWRITE_API_KEY environment variable is required." }` | No key and no injected `x-appwrite-key` — check the function's scopes are pushed. |
| `500` | `{ error: "Failed to verify PIN across all available endpoints." }` | The `pins` lookup failed everywhere. Deliberately **not** treated as a wrong PIN. |
| `500` | `{ error: "Failed to issue quick-access session token across all available endpoints." }` | The PIN was correct but the token call failed on every endpoint. |
| `503` | `{ error: "Quick access is temporarily unavailable. Please try again shortly." }` | A failed attempt could not be recorded. Deliberate fail-closed; the log carries `RATE-LIMIT-WRITE-FAILED` or `RATE-LIMIT-INCREMENT-FAILED`. |

## Audit trail

Every ticketing PIN resolves to the same shared door-staff account, so the
session itself carries no attribution. The log line
`Issued quick-access session token via <endpoint> for pin=<id> label=<label>` is
the only per-credential trail there is — and the only handle for revocation after
the fact, because marking a row `active: false` does not end a session it already
granted. The 60-second expiry bounds the *token*, not the session exchanged for
it.

## Scopes

| Scope | Why |
| --- | --- |
| `users.write` | `POST /users/{id}/tokens` — minting the custom token. |
| `documents.read` | Read the `pins` and `rate_limits` rows. |
| `documents.write` | Create/update/increment the rate-limit counters. |

## Environment variables

| Name | Read? | Purpose |
| --- | --- | --- |
| `QUICK_ACCESS_USER_ID` | yes | Appwrite user id of the shared door-staff account. |
| `APPWRITE_API_KEY` | yes | Optional; falls back to the injected `x-appwrite-key`. |
| `QUICK_ACCESS_PIN` | **no** | Superseded by the `pins` collection. Still set on the live function; inert. |
| `QUICK_ACCESS_REVIEWER_PIN` | **no** | Same. |

## Configuration

| Setting | Value |
| --- | --- |
| Runtime | `node-16.0` |
| Entrypoint | `index.js` (not `src/main.js` — this one is CommonJS) |
| Build command | `npm i` |
| Timeout | 30s |
| Schedule | none |

Deploy: `appwrite push function --function-id quick-access-login`

Appwrite user ids are project-scoped, so ShottyTicketing's old standalone
door-staff account id does not carry over — `QUICK_ACCESS_USER_ID` names an
account created directly in this project.
