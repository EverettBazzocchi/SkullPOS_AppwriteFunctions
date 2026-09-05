# Item-SetEnabled

Toggles a menu item's `enabled_menu` flag, server-side. This is the
**only** field this function will ever touch.

The client has no write access to `pos_items` at all (removed alongside
the rest of the POS PIN-system security plan) -- a blanket update grant
would let any session, anonymous quick-access PIN sessions included,
change *any* field on *any* item directly (price, alcohol flag, POS
visibility, etc.), e.g. reprice a bottle to a cent and ring up unlimited
cheap sales. Unlike Transactions/giftcards there's no natural "creator" to
scope a document permission to (items are a shared, pre-existing catalog,
not something a cashier creates), so this is a narrow single-purpose
function instead: it only accepts `{itemId, enabled}` and only ever writes
`enabled_menu`.

## Request body

```json
{ "itemId": "...", "enabled": false }
```

## Response

`{ "ok": true, "enabled": false }` or `{ "error": "<message>" }` with a
4xx status.

## Configuration

| Setting     | Value                                        |
| ----------- | ----------------------------------------------- |
| Runtime     | Node (16.0)                                     |
| Entrypoint  | `src/main.js`                                   |
| Build       | `npm i`                                         |
| Execute     | `users` (any session -- matches today's behavior, no new restriction added) |
| Scopes      | `documents.write`                               |

## Note on calling Appwrite's own API from within a function

This self-hosted instance's function-execution sandbox can't resolve its
own public hostname via the normal `getaddrinfo` path (used internally by
`fetch`/`http`) -- `dns.resolve4` (talks to nameservers directly,
bypassing `getaddrinfo`) works fine though. `src/appwriteClient.js` patches
the global `dns.lookup` so any HTTP client resolving this hostname gets the
known-good IP instead of hanging/`EAI_AGAIN`; the URL/Host header is
untouched, only the DNS step is bypassed. Every function that needs to
call Databases/Teams/Users uses this same helper.
