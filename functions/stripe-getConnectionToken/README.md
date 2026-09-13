# stripe-getConnectionToken

**Function ID:** `68f2904a00171e8b0266`

Mints a Stripe **Terminal connection token** — the credential the Stripe Terminal
SDK needs before it can discover or connect to a card reader. Shared by SkullPOS
(`POS/src/utils/stripe.js`) and ShottyTicketing; both run against the same Stripe
account, so this is the one place the logic lives.

A live connection token is enough to discover and connect to the venue's readers,
so **who may call this is the whole security story**.

## Who may call it

Live `execute` list, read from the project on 2026-09-13
(`appwrite functions get --function-id 68f2904a00171e8b0266`):

- `team:68e35aed00144b8cde9d` — admin
- `team:68ffcecc0026f78f0af8` — POS
- `team:6a9cbb1c95ea7d59dd8c` — PIN Payment Access (the team `Verify-Pin` joins a
  device to once a PIN is accepted)

Appwrite grants the `team:<id>` role only for a membership whose `confirm` is
true, and it checks that list when the execution is created — before this
module is loaded. A bare anonymous session belongs to none of the three and
never reaches the code.

`src/main.js` adds exactly one check on top, and it is not a second copy of the
allowlist: it refuses a request with no `x-appwrite-user-id`. That header is
absent only for a direct invocation with a project API key holding
`execution.write`, which is the one caller Appwrite does *not* check the
`execute` list for.

**There is no "could not verify" state and no outbound lookup on this path.** An
earlier version re-derived team membership through `users.listMemberships()` and
returned `503` whenever that call could not answer. On 2026-09-13 07:50 UTC it
could not answer (`User with the requested ID could not be found`) and a live
Terminal reader was refused its connection token. That check was removed in
commit `02bee62`. If you reinstate anything here, keep both properties: an
API-key-only invocation is refused, and no external lookup can turn a session
caller away. `src/main.test.js` covers both.

## Scopes

**None.** Live and in `appwrite.config.json`, verified 2026-09-13 —
`appwrite functions get --function-id 68f2904a00171e8b0266` reports
`"scopes": []`.

It needs none: since the in-code team check was removed this function makes no
Appwrite API calls at all. It reads two request headers, mints a Stripe Terminal
connection token, and returns it.

It previously declared `users.read`, for a `users.listMemberships()` call that no
longer exists. That matters because a declared scope is real privilege — it is
what makes Appwrite inject a dynamic API key carrying that power into every
execution. Carrying one a function never uses is standing privilege for nothing,
so if a change here ever needs the Users API again, add the scope deliberately
rather than assuming it is still there.

The scope is surplus either way: this function never calls the Appwrite API —
`src/main.js` imports `stripe` and nothing else. `users.read` was only ever
needed by the membership lookup that commit `02bee62` removed.

(`src/appwriteClient.js` is still on disk but is not imported by `main.js`.)

## Request body

```json
{ "test": "test" }
```

Three accepted spellings of one question, all normalised by `resolveIsLive`:

| Sent | Mode |
| --- | --- |
| `{ "test": "test" }` | test |
| `{ "test": "" }`, any other value, or no body at all | live |
| `{ "isLive": true \| false }` | as stated |
| `{ "environment": "live" }` | live; anything else is test |

An empty or unparseable body is **not** an error here — both clients send one
for the live default.

Note this differs from `Stripe-CreatePaymentIntent`, which refuses an unnamed
mode outright. That asymmetry is deliberate: a connection token moves no money.

## Responses

| Status | Body | What it means operationally |
| --- | --- | --- |
| `200` | `{ secret, mode }` | Token minted. `mode` is the mode it was actually minted in — pair it with a PaymentIntent from the same mode. |
| `403` | `{ error: "Unauthorized" }` | No session user. Someone invoked this with a project API key instead of a signed-in device. Not something a till can cause. |
| `500` | `{ error: "Stripe <mode> key is not configured" }` | `prodKey`/`testKey` is unset on the function. Card payments are down until it is set. |
| `500` | `{ error: "Stripe <mode> key is misconfigured" }` | The variable holds a key that declares the *other* mode (`sk_live_…` in `testKey`, or vice versa). Refused rather than used: minting a test token while the response says `live` puts the reader in one mode and the PaymentIntent in the other, which fails at tap time with no useful message. A key whose prefix declares no mode is passed through untouched. |
| `500` | `{ error: "<stripe message>" }` | Stripe rejected the request. The message is Stripe's own. |

## Environment variables

| Name | Purpose |
| --- | --- |
| `prodKey` | Stripe live secret key |
| `testKey` | Stripe test secret key |

## Configuration

| Setting | Value |
| --- | --- |
| Runtime | `node-16.0` |
| Entrypoint | `src/main.js` |
| Build command | `npm i` |
| Timeout | 15s |
| Schedule | none |

Deploy: `appwrite push function --function-id 68f2904a00171e8b0266`
