# Sales-Report

Generates the sales report, server-side. The date range a caller can
request is clamped to the last 24 hours **unless** the caller is a member
of a staff team -- checked via the Users API against
`req.headers['x-appwrite-user-id']`, which Appwrite sets itself from the
verified session and can't be spoofed by the client.

This is what makes the "PIN mode capped to 24h" restriction real instead of
a client-forgeable flag: the client has no read access to the Transactions
collection at all (see the POS PIN-system security plan), so every report
request -- staff account or anonymous quick-access PIN session -- goes
through here. It also incidentally closes a related gap: a self-registered
`@skullspace.ca` account that was never added to a staff team gets the
same 24h cap as a PIN session, since team membership (not "has a
password") is what actually denotes trusted staff.

Ports the aggregation logic (COGS via ingredients, alcohol/food/other
categorization, payment-method breakdown) that used to live in the POS
client's `fetchSalesReport` (`POS/src/utils/api.js`).

## Request body

```json
{ "startDate": "2026-01-01T00:00:00.000Z", "endDate": "2026-01-02T00:00:00.000Z", "test": false }
```

`startDate` may be omitted/empty for "all time" (only honored for staff
callers -- clamped to 24h before `endDate` otherwise). `test` selects
dev-site (`testing: true`) vs live-site transactions, same convention the
client already used.

## Response

The same shape `fetchSalesReport` used to return (`ItemsSold`,
`totalSales`, `cogs`, etc.), plus `restricted: true|false` indicating
whether the 24h clamp was applied.

## Configuration

| Setting     | Value                                        |
| ----------- | ----------------------------------------------- |
| Runtime     | Node (16.0)                                     |
| Entrypoint  | `src/main.js`                                   |
| Build       | `npm i`                                         |
| Execute     | `users` (any session -- restriction is per-caller, not per-execute-permission) |
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
