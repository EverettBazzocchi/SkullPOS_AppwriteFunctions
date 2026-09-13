# stripe-getConnectionToken

Mints a Stripe **Terminal connection token** — the credential the Terminal JS/SDK
needs before it can discover or connect to a card reader. Shared by SkullPOS
(`POS/src/utils/stripe.js`) and ShottyTicketing, which run against the same
Stripe account.

A live connection token is enough to discover and connect to the venue's own
readers, so **who may call this is the whole security story**. Two layers:

1. The function's `execute` allowlist. It should name only `team:admin`,
   `team:POS` and `team:PIN Payment Access`; it still carries `users`, which
   means any session, anonymous ones included.
2. A server-side check of the same allowlist in `src/main.js`, via the Users
   API. While layer 1 still says `users`, **this is the control**, so it fails
   closed: a caller whose membership cannot be checked — no injected
   `x-appwrite-key`, or a Users API failure — gets `503` and no token. It
   needs the `users.read` scope to run at all; with no scopes declared,
   Appwrite injects no key and the check could never run, which is how it came
   to allow every caller it was written to refuse.

The ShottyTicketing door account (`6aa201ecd741fa3bb794`) is allowed by id
because it belongs to no team — drop that constant once it is a POS-team member.

## Request body

```json
{ "test": "test" }
```

`"test"` selects the test key; anything else (including an omitted field or an
empty body) selects the live key. `{ "isLive": true|false }` and
`{ "environment": "live" }` are accepted as equivalents so ShottyTicketing does
not need a call shape of its own.

## Responses

| Status | When |
| --- | --- |
| `200 { secret, mode }` | Token minted. `mode` is the mode it was actually minted in. |
| `403` | No Appwrite user session, or a session in none of the allowed teams. |
| `500` | The mode's key is unset, holds a key for the *other* mode, or Stripe rejected the request. |

A key that declares the opposite mode is refused rather than used: minting a
test token while the response says `live` puts the reader in one mode and the
PaymentIntent in the other, which fails at tap time with no useful message.
A key whose format declares no mode at all is passed through untouched.

## Configuration

| Setting | Value |
| --- | --- |
| Runtime | Node (16.0) |
| Entrypoint | `src/main.js` |
| Build Commands | `npm i` |
| Execute | should be `team:admin`, `team:POS`, `team:PIN Payment Access` -- **still carries `users` in `appwrite.config.json`; the in-function team check is what holds the line until it is narrowed, and narrowing it needs the door account in the POS team first** |
| Scopes | `users.read` (for the server-side team check) -- set in `appwrite.config.json`, **must be pushed (`appwrite push functions`) or this function refuses every request** |
| Timeout (Seconds) | 15 |

## Environment Variables

| Name | Purpose |
| --- | --- |
| `prodKey` | Stripe live secret key |
| `testKey` | Stripe test secret key |
