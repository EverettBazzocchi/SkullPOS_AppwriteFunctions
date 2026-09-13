# Admin-GeneratePin

**Function ID:** `admin-generate-pin`

Creates, regenerates and revokes staff PINs for the three PIN-gated systems, all
stored as rows in the shared `pins` collection:

| `system` | Verified by | Used for |
| --- | --- | --- |
| `pos` | `Verify-Pin` | POS cashier mode |
| `self_checkout` | `Verify-Pin` | Self-checkout kiosk |
| `ticketing` | `quick-access-login` | ShottyTicketing door staff |

The 4-digit code is generated server-side with `crypto.randomInt` and is never
client-supplied.

## Who may call it

Live `execute`: **`team:68e35aed00144b8cde9d` (admin) only**. Verified 2026-09-13
with `appwrite functions get --function-id admin-generate-pin`.

Plus an in-code refusal of any request with no `x-appwrite-user-id`. That second
check is load-bearing here specifically because a successful call **returns a
working PIN in the response body** — and a project API key holding
`execution.write` invokes any function regardless of its `execute` list. The
admin app always has a session, so requiring one costs nothing.

## `pins` holds plaintext, not just hashes

`Verify-Pin` and `quick-access-login` only ever check the `hash` (sha256 of the
code), but the plaintext `pin` is deliberately persisted alongside it so the
admin app can re-display a code to staff after creation. **Treat the `pins`
collection as containing live credentials in the clear.** Its admin-team-only
read permission is what protects them.

Revocation writes `{ active: false, pin: null }` — it scrubs the plaintext as
well as flipping the flag. It used to write only the flag, so a code revoked
*because it leaked* stayed readable forever, and an accidental `active: true`
re-armed a credential whose plaintext was still on file. `hash` is
`required: true` so it must stay, which also keeps that code reserved against
reissue.

## Collision handling

A 4-digit code is only 10,000 values, and **two pools draw from it**: `pins` and
the separate `bartenders` collection, both verified by `Verify-Pin` against the
same namespace. `Verify-Pin` matches on `hash` alone (after a system/active
filter), so two rows sharing a hash means the wrong row wins — a bartender PIN
colliding with a `pos` PIN would authenticate as the `pos` one, losing her sales
attribution and skipping the event-window check entirely.

So every candidate is checked against **both** collections and re-rolled on a
collision, up to 12 attempts. The check deliberately ignores `active`: revocation
leaves `hash` in place, and an inactive row could be re-armed later and collide
retroactively.

## Request body

```json
{ "action": "create", "system": "pos", "label": "Bar 1" }
{ "action": "regenerate", "pinId": "..." }
{ "action": "revoke", "pinId": "..." }
```

## Responses

| Status | Body | What it means operationally |
| --- | --- | --- |
| `200` | `{ pinId, pin, label, system }` | create/regenerate. **The response carries the live code.** |
| `200` | `{ ok: true }` | revoke. Plaintext scrubbed. |
| `400` | `{ error: "Invalid request body" }` | Unparseable JSON. |
| `400` | `{ error: "Invalid action: …" }` | Not one of create/regenerate/revoke. |
| `400` | `{ error: "Invalid system: …" }` | Not one of pos/self_checkout/ticketing. |
| `400` | `{ error: "Missing label" \| "Missing pinId" }` | Malformed call. |
| `403` | `{ error: "Unauthorized" }` | No session user — an API-key invocation. |
| `404` | `{ error: "Pin not found" }` / `{ error: "Failed to revoke pin: …" }` | Bad `pinId`. |
| `500` | `{ error: "Failed to generate a unique pin" }` | 12 re-rolls all collided. At current volumes this is effectively impossible; if it ever happens, the namespace is near-full and the fix is longer PINs, not more retries. |
| `500` | `{ error: "Failed to create pin: …" }` / `{ error: "Failed to regenerate pin: …" }` | The write failed. On regenerate, the old code is still live. |

## Revoking does not end an existing session

Setting `active: false` stops **future** verifications. It does not revoke access
already handed out: `Verify-Pin` grants a durable PIN Payment Access membership,
and `quick-access-login` mints a session that outlives the token. Both are
documented in their own READMEs; the operational step is to remove the account
from the team's member list (POS) or delete the session (door) by hand.

## Scopes

| Scope | Why |
| --- | --- |
| `documents.read` | Collision checks against `pins` and `bartenders`; read the row being regenerated. |
| `documents.write` | Create, regenerate and revoke `pins` rows. |

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

Deploy: `appwrite push function --function-id admin-generate-pin`

`hashPin` is exported so a test can pin the exact digest convention against a
golden vector. `Verify-Pin`, `quick-access-login` and SkullAdminApp each hold
their own copy of that expression; if one drifts, every credential it issued
stops verifying with "Incorrect PIN" as the only symptom.
