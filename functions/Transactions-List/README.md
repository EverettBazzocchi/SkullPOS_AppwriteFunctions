# Transactions-List

Returns transaction documents (every status, not just `"complete"`) for the
transactions/refund view, newest first, paginated by `limit`/`cursor`.

The client has no read access to the Transactions collection at all (see
the POS PIN-system security plan), so this is the only way to see this
list. Ports the logic that used to live in the POS client's
`fetchTransactions` (`POS/src/utils/api.js`).

## Who sees what

The caller must hold a confirmed membership in the admin team, the POS team,
or the `PIN Payment Access` team `Verify-Pin` joins a device to once a PIN is
accepted. A bare anonymous session -- which is what `execute: ["users"]`
actually admits -- belongs to none of them and gets a 403. If the membership
check cannot run at all (no injected key, or a Users API outage) the function
logs loudly and serves the *restricted* view rather than failing the refund
screen mid-event.

| | admin team | everyone else |
| --- | --- | --- |
| Date range | exactly what the request asks for | always the last 24 hours of **server** time |
| Fields | the raw document | an allowlist (see `NON_ADMIN_FIELDS`) -- no `member_name`/`member_email`, no `stripe_id`, no `transaction_data`, no `bartenderId` |

The restricted window is absolute, not relative to anything the caller sent.
It used to be computed as `endDate - 24h` from the caller's *own* `endDate`,
which made it a sliding window rather than a limit: one request per day of
history walked the entire ledger. A requested `endDate` can now only narrow
the window (the admin app passes one while paging); a requested `startDate` is
ignored outright. An unparseable date is a 400 rather than an unhandled throw.

## Request body

```json
{ "test": false, "limit": 30, "cursor": null, "startDate": null, "endDate": null }
```

`test` selects dev-site (`testing: true`) vs live-site transactions, same
convention the client already used.

## Response

`{ "documents": [...], "restricted": true, "hasMore": false, "nextCursor": null }`
-- newest first. `restricted` is true for every non-admin caller and means both
the 24h window and the field allowlist are in effect.
`403 {"error":"Unauthorized"}` for a caller outside the allowed teams.

## Configuration

| Setting     | Value                                        |
| ----------- | ----------------------------------------------- |
| Runtime     | Node (16.0)                                     |
| Entrypoint  | `src/main.js`                                   |
| Build       | `npm i`                                         |
| Execute     | should be `team:68e35aed00144b8cde9d` (admin), `team:68ffcecc0026f78f0af8` (POS), `team:6a9cbb1c95ea7d59dd8c` (PIN Payment Access) -- **currently still `users`** |
| Scopes      | `documents.read`, `users.read`                  |

## Note on calling Appwrite's own API from within a function

This self-hosted instance's function-execution sandbox can't resolve its
own public hostname via the normal `getaddrinfo` path (used internally by
`fetch`/`http`) -- `dns.resolve4` (talks to nameservers directly,
bypassing `getaddrinfo`) works fine though. `src/appwriteClient.js` patches
the global `dns.lookup` so any HTTP client resolving this hostname gets the
known-good IP instead of hanging/`EAI_AGAIN`; the URL/Host header is
untouched, only the DNS step is bypassed. Every function that needs to
call Databases/Teams/Users uses this same helper.
