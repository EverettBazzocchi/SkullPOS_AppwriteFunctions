# Item-SetEnabled

**Function ID:** `6a9c6aad6d4a29ab66ee`

Toggles one boolean visibility flag on one menu item. `field` is restricted to an
allowlist of exactly two values — `enabled_menu` and `enabled_pos` — and those
are the only fields this function will ever write.

The client has no write access to `pos_items` at all. A blanket update grant
would let any session, anonymous PIN sessions included, change *any* field on
*any* item: reprice a bottle to a cent and ring up unlimited cheap sales, or flip
the alcohol flag. Unlike `Transactions` or `giftcards` there is no natural
"creator" to scope a document permission to — items are shared catalogue rows a
cashier did not create — so a narrow single-purpose function is the whole
mechanism.

## Who may call it

Live `execute`: **`team:68e35aed00144b8cde9d` (admin) only**. Verified 2026-09-13
with `appwrite functions get --function-id 6a9c6aad6d4a29ab66ee`.

There is no in-code caller check here, so a project API key with
`execution.write` could invoke it directly. The blast radius is bounded by the
field allowlist: the worst such a caller can do is hide or show a menu item.

## Request body

```json
{ "itemId": "...", "enabled": false, "field": "enabled_menu" }
```

- `itemId` — required.
- `enabled` — required, must be a real boolean (a string `"false"` is a `400`).
- `field` — optional, `enabled_menu` (default) or `enabled_pos`. `enabled_menu`
  controls the public menu boards; `enabled_pos` controls whether the item
  appears on the register.

## Responses

| Status | Body | What it means operationally |
| --- | --- | --- |
| `200` | `{ ok: true, enabled }` | Written. |
| `400` | `{ error: "Invalid request body" }` | Unparseable JSON. |
| `400` | `{ error: "Missing itemId or enabled (boolean)" }` | Malformed call. |
| `400` | `{ error: "field must be one of: enabled_menu, enabled_pos" }` | Anything outside the allowlist. |
| `404` | `{ error: "Item not found or failed to update" }` | Covers both a bad `itemId` and a write rejected by Appwrite — the execution log has the real message. |

## Scopes

| Scope | Why |
| --- | --- |
| `documents.write` | `updateDocument` on `pos_items`. |

No `documents.read`: the function never reads the item first.

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

Deploy: `appwrite push function --function-id 6a9c6aad6d4a29ab66ee`

## Calling Appwrite's own API from inside a function

See the DNS-patch note in `functions/Giftcard-Lookup/README.md`.
