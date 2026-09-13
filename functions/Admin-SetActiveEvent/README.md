# Admin-SetActiveEvent

**Function ID:** `admin-set-active-event`
**Schedule:** `*/15 * * * *` (every 15 minutes, UTC — the expression has no wall-clock anchor, so DST never moves it)

Maintains `Events.isActive` so that exactly one event carries it and it is the
right one. That flag is the single choke point the whole floor reads through:
the register, both wall-mounted menu boards and the door app all resolve the
active event through `Ticketing-ActiveEvent`, which serves whichever row has it.

Before this existed, **nothing on the server ever wrote that flag.** The only
writers were a human ticking "Active event" in the admin app's event form and
the `deactivateOtherEvents()` sweep that runs immediately after that save. So
somebody had to remember — and when they didn't, the floor kept pointing at
whatever was ticked last. It was pointing at a test event whose bar window had
closed three days earlier when this was written.

> **Read this before deploying:** the first run is a **visible change on the
> floor**. See [What this takes away](#what-this-takes-away).

## The shape of it

| File | What's in it |
| --- | --- |
| `src/main.js` | I/O and reporting only. Reads the collection, dispatches the writes, logs. |
| `src/decideActiveEvent.js` | **Every rule**, as a pure function of `(rows, nowMs)`. Start here. |
| `src/activeEventWindow.js` | Strict instant parsing and the union window. |
| `src/appwriteClient.js` / `src/dnsPatch.js` | Copied verbatim from its siblings — this instance's sandbox cannot resolve its own public hostname and hangs on `EAI_AGAIN` without them. |

`decideActiveEvent(rows, nowMs)` returns the intended writes and never performs
one, which is why every rule below is table-tested with no SDK in sight.

## The rules

### The timeline

Each row's **floor window** is the union of the bar's hours and the event's own:
`start = min(startsAt, barOpensAt)`, `end = max(endsAt, barClosesAt)`. Every row
is then put in exactly one class against a single `now` captured once per run
(half-open throughout, so no instant lands in two classes):

| Class | When |
| --- | --- |
| `UNSCHEDULED` | no usable window at all |
| `FUTURE` | `now < start − 6h` |
| `LEAD_IN` | `start − 6h ≤ now < start` |
| `LIVE` | `start ≤ now < end` |
| `GRACE` | `end ≤ now < end + 4h` |
| `ENDED` | `now ≥ end + 4h` |

**No local time is ever constructed, no timezone is ever named, no calendar day
is ever computed.** `America/Winnipeg` appears nowhere in the code — a test
greps the sources to keep it that way. That is what makes DST a non-event, and
what makes a 22:00→02:00 local window one contiguous instant pair with no
midnight special case.

### Activation

- **Candidates** are non-`testing` rows classified `LIVE` or `LEAD_IN`.
  `GRACE` is deliberately *not* a candidate class.
- **Exactly one candidate is already active** → that row is the answer and the
  comparator is never consulted. Zero writes. This is the operator override and
  the anti-flap rule at once.
- **More than one** → nothing is activated; both are named at `error()`.
- **A blocker exists** (an active row that is neither a candidate nor provably
  `ENDED`) → **refuse**: nothing is activated, reported loudly.
- **Otherwise** → the comparator picks: `LIVE` before `LEAD_IN`, then earliest
  `end`, then earliest `start`, then `$id` ascending. Total, so two runs can
  never disagree and flap the floor.

The write is `{ isActive: true }` and nothing else — never an echo of other
fields, so a concurrent admin-app save cannot be clobbered — and it is skipped
entirely when the row is already active (Appwrite bumps `$updatedAt` even on an
unchanged write, and a needless bump reshuffles `Ticketing-ActiveEvent`'s
tiebreak for nothing).

### Deactivation

An active row is touched **only** when its own end instant is provably in the
past, and then only via one of two branches:

1. **Sweep** — the row is `ENDED`. Runs unconditionally, whether or not anything
   was activated and whether or not the run refused. This is the branch that
   fixes the reported incident.
2. **Handover** — a `LIVE` winner is taking the floor, so an active row still
   inside its wind-down has its grace cut short in the same run. A live event
   taking the floor is a better reason to end a wind-down than the clock is.

Nothing classified `FUTURE`, `LEAD_IN`, `LIVE` or `UNSCHEDULED` can ever appear
in the write plan. **An operator who ticks an event active on the afternoon
before is `LEAD_IN`, then `LIVE`, then `GRACE` — never `ENDED` — so there is no
move available on that row at all.** Unreadable is not ended: a row whose window
cannot be parsed is never swept, no matter how old it looks.

**The sweep guard**, and it is the only guard: if a run's own writes would leave
the floor with no *real* (non-test) active event, one row is held back, for
either of two independent reasons.

1. **Something might be running** — a row classified `LIVE` (including a
   `testing` one, which is never activatable but is certainly running) or
   `UNSCHEDULED`, so the function cannot tell. This is property D: a dark floor
   mid-event hides every alcohol item and drops the door to CA$30.
2. **A test row would be left holding the floor.** This is property B, and it
   does *not* depend on anything being `LIVE` — a test event merely in its
   `LEAD_IN` or its `GRACE` is not "possibly running", so reason 1 is blind to
   it. Without this, the sweep subtracts the last non-test active row out from
   under it and `Ticketing-ActiveEvent` — which falls back to serving a test
   event rather than returning `null` — puts the test record on the door, at the
   test price, without this function ever having written `isActive: true` to it.

The row held back is a **non-test** one in preference to a test one, then the
most recently finished, then `$id`. Holding back a test row would leave the
floor on a test event anyway, which is the outcome the guard exists to prevent.
Reported at `error()`.

The guard is deliberately narrower than "any bad row freezes all cleanup", which
would let one draft event disable stale cleanup for everything else indefinitely
— a symptom indistinguishable from the function not running. On a quiet night
with nothing active afterwards there is no test row to promote and nothing that
might be running, so the sweep goes to zero active exactly as intended.

### Ordering is load-bearing

**Activate first, deactivate second**, one `updateDocument` per row. The
transient between the two writes is "two rows active", never "zero rows active".
Zero active mid-event is the dark floor: the register hides every alcohol item,
both boards go generic, and the door drops to the CA$30 default.

Two active is survivable downstream — but **only because of a behaviour this
function does not own**: `Ticketing-ActiveEvent` orders active rows
`orderDesc('$updatedAt')`, so the row written here is by definition the one
served, and its `pickActiveEvent` independently steps past `testing === true`.
That coupling is commented in both files. Anyone who "tidies up" that order
clause silently breaks the safety of this ordering.

**If the activation write throws, the deactivation phase is skipped entirely**,
the run returns `500` with `abortedAfterActivationFailure` and the incumbent
still holds the floor. Switching the old event off after failing to install its
replacement is the one path that walks straight into a dark floor, so it is
closed by construction rather than by ordering luck. A failed *individual*
deactivation is logged into `failures`, the rest still run, and the residue is
one stale active row the next run retries.

## Why 6 hours of lead and 4 hours of grace

**A generous lead is almost free.** The register's `isWithinBarHours` (and
skullmenu's copy) gates alcohol on the active event's own
`barOpensAt`/`barClosesAt`, **independently of `isActive`**, and fails closed on
anything missing or inverted. Activating the Afterparty at 16:00 local does not
put drinks on the board at 16:00 — the bar still opens at 22:00 because
`barOpensAt` says so. What flips early is the door app's ticket name and price
and the boards' event header, and at 16:00 on the day of the event those are
simply correct.

**Deactivation is the asymmetric one.** No active event hides *all* alcohol
regardless of window and drops the door to CA$30. Activate generously;
deactivate reluctantly.

Six hours is chosen to **pre-empt** the operator rather than merely tolerate
them: the Afterparty's union start is `2026-09-27T03:00Z`, so the lead opens at
`2026-09-26T21:00Z` = 16:00 local — the exact "afternoon before, to set up and
test" moment. They arrive, find the till already on the right event, and their
tick is a no-op. A 4h lead leaves a two-hour window where an early tick
classifies `FUTURE`, becomes a blocker, and suspends the automation for no
reason. It is anchored on `min(startsAt, barOpensAt)`, so a doors-20:00/bar-22:00
event leads from 14:00 — the door needs the right price from door-open.

Four hours of grace is not about alcohol (`isWithinBarHours` closes the bar on
its own at `barClosesAt`). It exists so the event is not yanked out from under
the closing shift: last-call ring-ups, the cash-out, `Bartender-Sales`,
`Sales-Report`, and the operator reconciling with last night's event on screen.
A 02:00 local close clears at 06:00 local, after everyone has gone home.

**The grace is asymmetric, and that asymmetry is the point.** It shields a
finished event from deactivation but is never a reason to activate anything, so
an operator who unticks an event at 02:05 after close does **not** get it
switched back on at 02:15. The symmetric version is tidier on paper and was
rejected for exactly that fight, at exactly that hour.

## Operator override

Four layers, in the order you'd reach for them. None needs a schema change or a
redeploy.

1. **Early activation is permanent and free.** A row that has not ended is never
   deactivated, so ticking "Active event" the afternoon before survives every
   run until that event's own window ends plus grace.
2. **Incumbency beats the comparator.** Your pick between two simultaneously
   qualifying events is re-picked by every subsequent run, with zero writes.
3. **A blocker suspends the automation rather than overruling it.** An active row
   the function cannot prove has ended stops it activating anything at all.
4. **`ACTIVE_EVENT_AUTOPILOT`** — the kill switch, read fresh every run.
   **Default is apply**: unset, blank, or any value nobody deliberately chose
   means it runs normally. A config typo must never silently disable the
   automation on the night of a paying event. Set it to `report` in the Appwrite
   console and the run computes the full decision, logs what it *would* have
   done, returns `wouldActivate`/`wouldDeactivate`, and writes nothing. The mode
   is echoed on every run's log line so a suspended autopilot is visible rather
   than mistaken for a working one.
   *Verify on this install that changing a function variable takes effect
   without a redeploy **before** relying on it under pressure.*

> **The supported way to pin the floor to a finished event is to edit `endsAt` /
> `barClosesAt` forward in the admin app.** "This event is still on" is what you
> actually mean and that is the field that means it. **Ticking the box is no
> longer how you hold the floor on an event that ended hours ago** — that is a
> real change to the escape hatch.

> **And the inverse, which is the one that bites at 11pm: unticking a RUNNING
> event does not hold.** A non-test event inside its own window with nothing else
> active is precisely what this function exists to switch on, so the next run puts
> it straight back — within fifteen minutes, every fifteen minutes, for as long as
> the operator keeps unticking it. Nothing in the design protects this case: the
> asymmetric grace only stops a re-activation *after* the window has closed (an
> untick at 02:05 stays unticked), and early activation is only ever made
> permanent in the other direction. If an event is cancelled mid-night and the
> floor has to come off it, the supported move is again the instants, not the
> checkbox:
>
> **Move `endsAt` AND `barClosesAt` back to now, then untick.** Both of them —
> this is the trap. The window this function steers by is the UNION of the event's
> hours and the bar's, so the end it tests against is `max(endsAt, barClosesAt)`.
> Pulling `endsAt` back on its own leaves the row LIVE on the strength of a
> `barClosesAt` nobody thought to touch, and the untick is overturned exactly as
> before, with nothing in any log to say why. With both moved the row is in its
> grace: never a candidate, so it is never switched back on, and the sweep clears
> the flag on its own four hours later.
>
> In a genuine hurry, `ACTIVE_EVENT_AUTOPILOT=report` suspends the whole
> autopilot in twenty seconds with no redeploy, and then the checkbox behaves the
> way it always used to. That is the one to reach for over the phone.

## What this takes away

Read this to the operator **before** deploying, not after.

- **Between deploy and `2026-09-26T21:00Z` — thirteen days — the floor has ZERO
  active events, by design.** Today an unlisted walk-in night "works" because a
  stale active row happens to be sitting there. From the first run after deploy
  that row is gone, and an ad-hoc night has no active event: alcohol hidden, door
  at the CA$30 default instead of the test row's $1.00. Correct by the rules and
  still a regression in practice.
- **An ad-hoc night now needs an Events row** with real `startsAt`/`endsAt` or
  `barOpensAt`/`barClosesAt`.

## Failure modes

1. **The refusal can itself darken the floor**, and this is the sharpest edge in
   the design. If an operator ticks a `FUTURE` event active (or leaves an
   unreadable row active) while a different event is genuinely live, property A
   forbids deactivating the blocker and property F forbids adding a second active
   row — so the function writes nothing and only reports. The floor keeps serving
   the wrong event all night. There is no automatic fix that does not violate A.
   The entire mitigation is the escalated `error()` wording, which names the row
   to untick and the money it is costing. The window is narrow in practice: the
   6h lead means a realistic early tick classifies `LEAD_IN` and is handled
   correctly, so this needs events on consecutive days to bite.
2. **A wrong end instant produces a confidently wrong answer.** An event whose
   `endsAt`/`barClosesAt` was entered a day or a year early is swept at end + 4h
   — mid-event, on a live floor, correct by the rule and disastrous in fact.
   Grace absorbs a 30–60 minute pessimistic close and nothing more. Inverted
   pairs are excluded from both halves, which catches the most common shape of
   the typo; a wholesale wrong-year pair is internally consistent and passes
   every check. The real fix is validation at entry in the admin app, which does
   not exist today.
3. **A fifth consumer of `isActive` reads it unordered.**
   `functions/Transaction-RecordPayment/src/main.js` validates DJ vouchers with
   `Query.equal('isActive', true) + Query.limit(1)` and **no order clause** —
   which `Ticketing-ActiveEvent`'s own verified comment documents as returning
   the *oldest-created* row. The three live rows were created within one second
   of each other and `Everetts Test event ignopre` is the oldest (`$sequence` 1).
   So during this function's activate-then-deactivate transient, or after a crash
   between the two writes, a DJ voucher for the real event is checked against the
   stale row and the bartender gets "This voucher is only valid during its own
   event". Sub-second normally, up to 15 minutes after a partial failure.
   **Recommended follow-up, one line:** give that query the same
   `orderDesc('$updatedAt')` and non-test step-past. It wants fixing on its own
   merits regardless of this function.
4. **The two-active transient is safe only because of another function's
   tiebreak** (see *Ordering is load-bearing*). There is also a nasty
   once-a-day corner: `Admin-RollupEventSales` at `0 6 * * *` writes to every
   `ENDED` event and bumps its `$updatedAt`, which would promote a stale row back
   over a freshly-activated one under that very tiebreak. Collision window under
   15 minutes, once a day, but it exists.
5. **The `testing` flag is not the guard it looks like.** The live stale row is
   literally named "Everetts Test event ignopre" and carries `testing: false` —
   verified, not assumed, on all three rows. Had its hours been current, this
   function would have promoted it to the live floor and been entirely correct by
   its own rules. Property B blocks a row somebody remembered to flag; nothing
   blocks a junk row with tonight's hours and a truthful-looking `testing: false`.
   The name is not machine-readable and this function will not start regexing
   event names.
6. **Strict parsing and the absent `date` fallback make a data regression silent
   rather than loud.** Any row that predates the instant backfill, or that a
   future admin-app regression saves without instants, is `UNSCHEDULED`: never
   activated even if it is genuinely tonight's event, only named in the
   `unscheduled`/`unreadable` report. It presents as the autopilot quietly
   switching itself off. It is also a real inconsistency with the two sibling
   window helpers — `Verify-Pin` would still issue a pin for such a row and
   `Admin-RollupEventSales` would call it "scheduled". Each of the three headers
   says why it decides the shared shape differently.
7. **A row with a good event pair but a broken bar pair is activatable and then
   sells nothing.** The union window comes out usable, so this function gives it
   the floor — and then the register's own `instantWindow` rejects the inverted
   `barOpensAt`/`barClosesAt` and hides alcohol all night. The function warns on
   exactly this shape (`sellsAlcohol` true, bar pair unusable) but cannot fix it,
   and a warning nobody reads is a dark bar.
8. **The clock is only half-defended.** The `$updatedAt` sanity check catches a
   container clock running *behind* reality, which is the harmless direction
   (nothing activates, nothing sweeps). A clock running *ahead* is the dangerous
   one — it classifies a live event as `ENDED` and sweeps it mid-event — and
   there is no cheap internal defence without an external time source. The strict
   ISO parser defends against bad data in the rows; nothing defends against a bad
   `now`.
9. **The whole design rests on a scheduler that had never fired on this install
   before 2026-09-13, and it fails invisibly.** No run means no write, no log,
   and a symptom identical to the bug being fixed. See *Verifying the cron*.
10. **96 executions a day of mostly-silent log noise**, crowding the Executions
    view where the rollup's `needsReview` and the Zeffy verifier's
    `needsManualReview` reports live.

## Why `*/15`

Cadence buys exactly one thing: how long the floor can point at the wrong event
after a boundary. It does **not** affect correctness — the function is a pure
function of (collection state, `now`), with no cursor, no "last run" marker and
no memory, so every run makes the same decision from the same facts and a missed
boundary is superseded rather than replayed.

At a same-night handover an hourly cron leaves the boards on a finished event for
up to 59 minutes; `*/15` caps that at 15 minutes plus the clients' own 60-second
poll (`ACTIVE_EVENT_POLL_MS = 60000`), so ≤ 16 minutes — and that lag always
lands inside a lead or a grace, never at an open door.

**Not `*/5`**, because of what the newly-working scheduler actually did on
2026-09-13: at 22:01:47, inside a single second, 1.9.6 replayed every missed slot
concurrently (7× the Zeffy verifier, 4× the rollup, 4× the stale-transaction
sweep). A backlog arrives as a **concurrent burst**, not a drip. At `*/15` a
six-hour outage replays as ~24 executions; at `*/5` it is ~72. The burst is
harmless either way — every copy reads the same rows and computes the same
winner, so they issue identical idempotent writes and all but the first find the
row already active — but there is no reason to hand a host that had never run a
scheduled execution before that day three times the load for single-digit minutes
of benefit.

If the top of the hour ever gets crowded (the rollup, the stale-transaction sweep
and the Zeffy verifier all fire at minute 0), `5,20,35,50 * * * *` is a drop-in
alternative.

## Verifying the cron

This project's own infra notes say **crons only register on redeploy**, and a
schedule that never registered is indistinguishable from a schedule that
correctly decided nothing needed changing.

```
appwrite push function --function-id admin-set-active-event
# wait a quarter of an hour
appwrite functions list-executions --function-id admin-set-active-event
```

Look for `"trigger":"schedule"` rows. **Do that before the 26th, not on it.**
The 2026-09-13 replay burst also produced a majority of
`connect ECONNREFUSED 127.0.0.1:80` failures (the SDK resolving
`APPWRITE_FUNCTION_API_ENDPOINT` to localhost inside the runtime container);
those executions predate the 22:05:05 redeploy so the fault may already be gone,
but **until a scheduled run of this function is observed completing 200, the cron
is a hope and manual invocation is the actual mechanism.** That is why `execute`
includes the admin team:

```
appwrite functions create-execution --function-id admin-set-active-event
```

Running it by hand is also how you preview a night: set
`ACTIVE_EVENT_AUTOPILOT=report` first and read `wouldActivate`/`wouldDeactivate`.

## Who may call it

`execute`: **`team:68e35aed00144b8cde9d` (admin) only**. There is no in-code
caller check. Given this install's scheduler history, the cron is a convenience
and the manual invocation is the guarantee.

## Response

```json
{
  "mode": "apply",
  "now": "2026-09-27T05:00:00.000Z",
  "leadHours": 6,
  "graceHours": 4,
  "eventsRead": 3,
  "activated": "6aa08566ea9606801071",
  "deactivated": ["6a9a44984028f75b0052"],
  "failures": [],
  "incumbents": [],
  "blockers": [],
  "candidates": [{ "id": "...", "name": "...", "state": "LIVE" }],
  "unscheduled": [{ "id": "...", "name": "...", "reason": "no readable end instant …" }],
  "unreadable": [],
  "ambiguous": false,
  "heldBack": null
}
```

- `500 { error: "Failed to list events" }` — the listing failed; **nothing was
  changed**, whatever is on the floor stays on the floor.
- `500 { …, abortedAfterActivationFailure: true }` — the activation write failed,
  so no deactivation was attempted.
- In `report` mode the body carries `wouldActivate` / `wouldDeactivate` instead
  of performing anything.

Everything worth a human's attention is reported on **both** channels the estate
already uses: `error()` for the Errors view, and structured keys in the body for
the admin app or a `curl`.

## Scopes

| Scope | Why |
| --- | --- |
| `documents.read` | Page the whole `Events` collection. |
| `documents.write` | Write `isActive` — one key, one row at a time. |

## Environment variables

| Name | Default | Effect |
| --- | --- | --- |
| `ACTIVE_EVENT_AUTOPILOT` | *(unset = apply)* | `report` computes and logs the decision but writes nothing. Anything else applies. |

## Configuration

| Setting | Value |
| --- | --- |
| Runtime | `node-16.0` |
| Entrypoint | `src/main.js` |
| Build command | `npm i` |
| Timeout | 30s |
| Specification | `s-0.5vcpu-512mb` |

30 seconds is generous for one paged read of a three-row collection and at most
a handful of single-key writes.

## Calling Appwrite's own API from inside a function

See the DNS-patch note in `functions/Giftcard-Lookup/README.md`.
