# Transactions-List

**Function ID:** `6a9c687ec05e99a6f1a8`

Returns one page of transaction documents — every status, not just `complete` —
newest first, for the POS transactions/refund view and the admin app's
transaction browser. The client has no read access to the `Transactions`
collection at all, so this is the only way to see the list.

## Who may call it

Live `execute` list, verified 2026-09-13
(`appwrite functions get --function-id 6a9c687ec05e99a6f1a8`):

- `team:68e35aed00144b8cde9d` — admin
- `team:68ffcecc0026f78f0af8` — POS
- `team:6a9cbb1c95ea7d59dd8c` — PIN Payment Access

On top of that, `resolveCaller` makes **one** Users API call and answers two
questions from it: is this caller in one of those teams, and are they in the
admin team specifically.

Its failure behaviour is deliberately asymmetric:

- **No `x-appwrite-user-id`** → refused. That is the project-API-key invocation
  path, which bypasses the `execute` list.
- **The membership check cannot run** (no injected key, or a transient Users
  failure) → logged loudly, then served at the **non-admin** level rather than
  refused. Neither state is attacker-reachable — an anonymous caller cannot make
  `listMemberships` fail — and taking the refund view down mid-event is the worse
  outcome.
- **The API positively places the caller outside every allowed team** → `403`.

## Who sees what

| | admin team | everyone else |
| --- | --- | --- |
| Date range | exactly what the request asks for (defaults to the last 24h) | always the last 24 hours of **server** time |
| Fields | the raw document | an allowlist (`NON_ADMIN_FIELDS`) |

The non-admin field allowlist is `$id`, `$createdAt`, `$updatedAt`, `status`,
`payment_method`, `channel`, `testing`, `total`, `tip`, `discount`,
`payment_due`, `giftcard_amount`, `cart`, `payments`, `CreatedBy`. Deliberately
an allowlist, so `member_name`/`member_email` (membership PII), `stripe_id`, the
encrypted `transaction_data` blob and `bartenderId` stay out — and so an
attribute added to the collection later is private by default instead of
appearing in this response on the next deploy.

The restricted window is **absolute**, derived from `Date.now()`, not relative to
anything the caller sent. It used to be computed as `endDate − 24h` from the
caller's own `endDate`, which made it a sliding window rather than a limit: one
request per day of history walked the entire ledger. A requested `endDate` can
now only narrow the window (the admin app passes one while paging); a requested
`startDate` is ignored outright for a non-admin.

## Request body

```json
{ "test": false, "limit": 30, "cursor": null, "startDate": null, "endDate": null }
```

- `test` — `true` selects `testing: true` rows, `false` selects everything else.
- `limit` — default 30, clamped to 1–100.
- `cursor` — the `nextCursor` from the previous page.

## Responses

| Status | Body | What it means operationally |
| --- | --- | --- |
| `200` | `{ documents, restricted, hasMore, nextCursor }` | `restricted: true` means both the 24h window and the field allowlist are in effect. |
| `400` | `{ error: "Invalid request body" }` | Unparseable JSON. |
| `400` | `{ error: "Invalid startDate or endDate" }` | An unparseable date. It used to surface as an unhandled `500`. |
| `403` | `{ error: "Unauthorized" }` | No session user, or the Users API positively placed this caller outside all three teams. |
| `500` | `{ error: "Failed to list transactions" }` | The query failed. |

Pagination fetches one document beyond the page size; its presence is what sets
`hasMore`, avoiding a separate count query.

## Scopes

| Scope | Why |
| --- | --- |
| `documents.read` | List `Transactions`. |
| `users.read` | `resolveCaller`'s `listMemberships` call. Without it Appwrite injects no dynamic key and every caller is served the restricted view. |

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

Deploy: `appwrite push function --function-id 6a9c687ec05e99a6f1a8`

## Calling Appwrite's own API from inside a function

See the DNS-patch note in `functions/Giftcard-Lookup/README.md`.
