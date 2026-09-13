# `_scripts` — one-off maintenance scripts

**Nothing in here is an Appwrite function.** No entry in `appwrite.config.json`
points at this directory, so nothing here is ever deployed, scheduled, or
executed by Appwrite. These are scripts a human runs by hand, from a laptop, with
an API key in the environment.

It sits under `functions/` for one reason: the repo's jest config matches
`functions/**/*.test.js`, so the decision rules in these scripts are covered by
the same `npm test` run as everything else. The leading underscore is the marker
that it is not a function.

| Script | What it does |
| --- | --- |
| `backfill-ticket-event-ids.js` | Fills in `tickets.eventId` on ticket rows written before anything populated it, by resolving each ticket's `eventName` against `Events.name`. Dry run by default; exact matches only; never guesses; safe to run twice. Read its header before running it. |

## House rules for anything added here

- **Dry run is the default.** Writing takes an explicit `--apply`.
- **Never guess.** A row that cannot be resolved unambiguously is reported and
  skipped, not approximated.
- **Idempotent.** Re-running after a partial failure retries only what is still
  missing, and a second clean run does nothing.
- **Smallest possible write.** Set the one field; leave everything else, including
  whatever the new field is replacing, exactly as it was.
- **Credentials come from the environment**, never from an argument — the shell
  history is not the place for an API key.
- **The decision logic is pure and exported**, with a `*.test.js` beside it. What
  a script would write must be provable without a network.
