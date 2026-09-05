# Verify-Pin

Verifies a quick-access PIN for the POS's restricted "cashier mode" (no
refunds, sales reports capped at 24 hours).

PINs live in the `PINS_JSON` **secret** environment variable, not a
database collection -- this function's execution sandbox has no network
route back to this Appwrite instance's own API (a self-hosted quirk: the
public hostname doesn't resolve from inside a function), so an
env-var-only design was the reliable option. PINs are stored as
`sha256(pin)`, never in plaintext, and the variable is secret (write-only)
so no one -- including this codebase's own tooling -- can read the value
back out once set.

## Request body

```json
{ "pin": "1234" }
```

## Response

`{ "ok": true, "label": "Bartender" }` or `{ "ok": false }`. Never reveals
whether a PIN exists, how many are configured, or any hash -- just whether
this one matched.

## Configuration

| Setting     | Value                                               |
| ----------- | ---------------------------------------------------- |
| Runtime     | Node (16.0), matching the other functions             |
| Entrypoint  | `src/main.js`                                         |
| Build       | `npm i`                                               |
| Execute     | `any` (must be callable before any session exists)   |

## Managing PINs

`PINS_JSON` is a JSON array of `{ "hash": "<sha256>", "label": "...", "active": true }`.
There's no admin UI yet -- to add/rotate PINs, build the full array
(there's no partial-update for a single env var) and set it:

```bash
node -e "console.log(require('crypto').createHash('sha256').update('1234').digest('hex'))"

appwrite functions update-variable --function-id <id> --variable-id <id> \
  --key PINS_JSON --secret \
  --value '[{"hash":"<hash1>","label":"Bartender","active":true},{"hash":"<hash2>","label":"Manager","active":true}]'
```

Set `"active": false` to disable a PIN without removing it from the list.
