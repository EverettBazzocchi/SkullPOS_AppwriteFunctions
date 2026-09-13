# Admin-PurgeAnonymousUsers

**Function ID:** `admin-purge-anonymous-users`
**Schedule:** `0 3 * * 0` (weekly, Sundays 03:00 UTC)

Permanently deletes anonymous Appwrite accounts that have not been active in 90+
days.

POS and self-checkout create one anonymous account per device the first time its
PIN is used (`loginWithPin` in `POS/src/utils/api.js` — the device needs a
`users`-level session before it can create transactions), so these accumulate
indefinitely: retired kiosks, replaced tablets, a phone used once at the door.

> **This schedule does not fire on its own.** Async executions do not enqueue on
> this instance. To run it now:
> `appwrite functions create-execution --function-id admin-purge-anonymous-users`

## Who may call it

Live `execute`: **`team:68e35aed00144b8cde9d` (admin) only**. Verified 2026-09-13
with `appwrite functions get --function-id admin-purge-anonymous-users`. There is
no in-code caller check.

## What counts as anonymous

**No email AND no phone.** Every real login — Google-authenticated staff and
admin, the shared ticketing door-staff account — has an email, so this cannot
delete a named account no matter how long it has been idle.

Inactivity is measured from `accessedAt`, falling back to `$updatedAt` then
`$createdAt`.

## What deletion costs

Deleting an account also removes whatever it was a member of. A device that is
purged and then comes back has to re-enter its PIN to get a fresh anonymous
session and a fresh PIN Payment Access membership. That is normal; a
self-checkout kiosk is the one to watch, because it is designed never to re-enter
its PIN — but a kiosk in daily use is active and will never be 90 days stale.

This is also the only thing that ever prunes the PIN Payment Access team, whose
membership otherwise grows by one per device per PIN entry and is never revoked.

## Request body

None.

## Response

```json
{ "totalUsersChecked": 412, "staleAnonymousFound": 37, "deleted": 37, "failures": [] }
```

`500 { error: "Failed to list users" }` if the user listing fails; nothing was
deleted. Individual delete failures land in `failures` as
`{ userId, error }` and do not stop the run.

It lists **every** user in the project (100 at a time, cursor-paged) and filters
in JS. At 60 seconds of timeout, that listing plus one delete call per stale
account is the budget. If the project ever grows past what fits, the run will time
out part-way — which is safe (deletes already done stay done) but means the rest
waits for the next invocation.

## Scopes

| Scope | Why |
| --- | --- |
| `users.read` | `users.list` — enumerate accounts. |
| `users.write` | `users.delete`. |

These are the only two `users.write` grants in the project outside
`quick-access-login`.

## Environment variables

None.

## Configuration

| Setting | Value |
| --- | --- |
| Runtime | `node-16.0` |
| Entrypoint | `src/main.js` |
| Build command | `npm i` |
| Timeout | 60s |

Deploy: `appwrite push function --function-id admin-purge-anonymous-users`

## Calling Appwrite's own API from inside a function

See the DNS-patch note in `functions/Giftcard-Lookup/README.md`.
