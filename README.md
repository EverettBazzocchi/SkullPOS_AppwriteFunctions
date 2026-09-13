# SkullPOS Appwrite Functions

Every server-side function for the SkullSpace bar and door systems. **This
repository is the only source of these functions.** ShottyTicketing's
`appwrite-functions/` fork was deleted; if you find another copy, it is stale.

The functions back four clients — the POS register, the self-checkout kiosk, the
SkullAdminApp, and ShottyTicketing's door app — plus the public menu boards. They
exist because Appwrite permissions are per-collection, never per-field or
per-operation: every one of these is either a narrow write the client is not
trusted to make directly, or a filtered read of a collection the client cannot
open.

| | |
| --- | --- |
| Appwrite project | `68f2ac7b00002e7563a8` ("Skullbar") |
| Endpoint | `https://api.cloud.shotty.tech/v1` |
| Appwrite version | 1.9.0 |
| Runtime | `node-16.0` for all 24 functions — the only Node runtime this self-hosted instance offers |

---

## Databases

| Id | Name | Used by |
| --- | --- | --- |
| `67c9ffd9003d68236514` | Bar | **Every function here.** 18 collections. |
| `barData` | barData | **No function in this repo.** One collection, `config`. Verified by grep: the string `barData` appears nowhere in `functions/`. |

Collections in `67c9ffd9003d68236514` that the functions touch:

| Id | Name |
| --- | --- |
| `68e4cd3500179ce661c6` | Transactions |
| `68e400210008d19bb5c9` | Events |
| `67c9ffdd0039c4e09c9a` | Categories |
| `pos_items` | pos_items |
| `giftcards` | giftcards |
| `discounts` | discounts |
| `ingredients` | ingredients |
| `pins` | Pins |
| `bartenders` | Bartenders |
| `djs` | djs |
| `event_coordinators` | Event Coordinators |
| `rate_limits` | Rate Limits |
| `orders` | Orders |
| `tickets` | Tickets |
| `failed_webhooks` | Failed Webhooks |

(`67c9ffe6001c17071bb7` Items_old, `68e3ff08002deb5d5bf4` Inventory and
`menu_items` exist but no function in this repo reads or writes them.)

Storage: `voucher-barcodes`, written by `Admin-EmailDj`.

---

## Teams

These three ids appear in `execute` lists throughout. Read live 2026-09-13
(`appwrite teams list`).

| Id | Name | Who is in it |
| --- | --- | --- |
| `68e35aed00144b8cde9d` | admin | Real admin accounts. The only team that gets unclamped sales data and refunds. |
| `68ffcecc0026f78f0af8` | POS | Staff POS devices. **Not** admin — a POS member gets the same 24h report clamp as a PIN cashier. |
| `6a9cbb1c95ea7d59dd8c` | PIN Payment Access | Anonymous sessions that passed a PIN. `Verify-Pin` adds them; nothing removes them (see that README's known gap). Membership grows by one per device per PIN entry. |

Anonymous auth is **enabled** on this project, so `execute: ["users"]` admits any
anonymous session, not just a signed-in staff account. That is the difference
between `users` and the three-team lists below, and it is why it matters which
one a function carries.

---

## The 24 functions

### Taking money

| Function | Id | Execute |
| --- | --- | --- |
| [Stripe-CreatePaymentIntent](functions/Stripe-CreatePaymentIntent/README.md) | `68f3c860003da00f14d8` | `users` |
| [stripe-getConnectionToken](functions/stripe-getConnectionToken/README.md) | `68f2904a00171e8b0266` | admin, POS, PIN |
| [Stripe-CancelPaymentIntent](functions/Stripe-CancelPaymentIntent/README.md) | `68f6272500160b48ee44` | admin, POS, PIN |
| [Transaction-RecordPayment](functions/Transaction-RecordPayment/README.md) | `6a9c728a297df71f5919` | `users` |
| [Transaction-SetStatus](functions/Transaction-SetStatus/README.md) | `6a9c65091672e55d90b1` | `users` |
| [Stripe-RefundPayment](functions/Stripe-RefundPayment/README.md) | `6a9b7671df1f504a084e` | **admin only** |
| [Giftcard-Lookup](functions/Giftcard-Lookup/README.md) | `6a9c5c1acb643536564a` | admin, POS, PIN |

A card sale's path: `stripe-getConnectionToken` (reader connects) →
`Stripe-CreatePaymentIntent` (stamped with `transactionId`) → tap →
`Transaction-RecordPayment` (verifies against Stripe, appends the leg). A sale
cannot be charged without a `transactionId` on the intent, and a leg cannot be
recorded without that stamp matching — that pairing is load-bearing; do not
weaken either half.

### Reading the ledger

| Function | Id | Execute |
| --- | --- | --- |
| [Sales-Report](functions/Sales-Report/README.md) | `6a9c687535280f239b5f` | `users` |
| [Transactions-List](functions/Transactions-List/README.md) | `6a9c687ec05e99a6f1a8` | admin, POS, PIN |
| [Bartender-Sales](functions/Bartender-Sales/README.md) | `bartender-sales` | `users` |
| [Transaction-EmailReceipt](functions/Transaction-EmailReceipt/README.md) | `6a9cd1ed552967ba3560` | admin, POS, PIN |

`Sales-Report` and `Transactions-List` are where the "24 hours unless admin"
restriction actually lives. Both check admin membership through the Users API; a
failed check degrades the caller to non-admin, never refuses.

### Access control

| Function | Id | Execute |
| --- | --- | --- |
| [Verify-Pin](functions/Verify-Pin/README.md) | `6a9c4acd49bc458907e7` | **`any`** |
| [quick-access-login](functions/quick-access-login/README.md) | `quick-access-login` | **`any`** |
| [Admin-GeneratePin](functions/Admin-GeneratePin/README.md) | `admin-generate-pin` | admin only |

The two `any` functions are the project's only unauthenticated endpoints. Their
rate limiters are the control, and both fail closed when a failed attempt cannot
be counted.

### Floor and catalogue

| Function | Id | Execute |
| --- | --- | --- |
| [Ticketing-ActiveEvent](functions/Ticketing-ActiveEvent/README.md) | `ticketing-active-event` | `users` |
| [Item-SetEnabled](functions/Item-SetEnabled/README.md) | `6a9c6aad6d4a29ab66ee` | admin only |

`Ticketing-ActiveEvent` is now the single read path for the active event. The
door app, the register and the menu boards all go through it rather than reading
`Events` directly — it projects `sellsAlcohol` plus the bar window, as the
`barOpensAt`/`barClosesAt` instants and (still, until every client has shipped and
is confirmed on the device) the legacy `barOpenTime`/`barCloseTime` strings,
alongside the ticket fields — and keeps every financial column on the server.

### Ticketing intake

| Function | Id | Execute |
| --- | --- | --- |
| [Zeffy-Webhook](functions/Zeffy-Webhook/README.md) | `zeffy-webhook` | **`any`** (HMAC-authenticated) |
| [Admin-VerifyZeffyTickets](functions/Admin-VerifyZeffyTickets/README.md) | `admin-verify-zeffy-tickets` | admin only |

### Email

| Function | Id | Execute |
| --- | --- | --- |
| [Admin-EmailDj](functions/Admin-EmailDj/README.md) | `admin-email-dj` | admin only |
| [Admin-EmailBartender](functions/Admin-EmailBartender/README.md) | `admin-email-bartender` | admin only |
| [Admin-EmailCoordinator](functions/Admin-EmailCoordinator/README.md) | `admin-email-coordinator` | admin only |

All send through Resend's HTTP API (`api.resend.com/emails`), not Appwrite's
SMTP — Appwrite's mailer handles only its own built-in auth email types. Every
function carries its own copy of the `RESEND_API_KEY`; there is no shared secret
store.

### Scheduled maintenance

| Function | Id | Schedule | Execute |
| --- | --- | --- | --- |
| [Admin-CancelStaleTransactions](functions/Admin-CancelStaleTransactions/README.md) | `admin-cancel-stale-transactions` | `0 4 * * *` | admin only |
| [Admin-RollupEventSales](functions/Admin-RollupEventSales/README.md) | `admin-rollup-event-sales` | `0 6 * * *` | admin only |
| [Admin-VerifyZeffyTickets](functions/Admin-VerifyZeffyTickets/README.md) | `admin-verify-zeffy-tickets` | `0 */12 * * *` | admin only |
| [Admin-PurgeAnonymousUsers](functions/Admin-PurgeAnonymousUsers/README.md) | `admin-purge-anonymous-users` | `0 3 * * 0` | admin only |

**See the first gotcha below — these schedules do not fire.**

---

## Deploying

```bash
appwrite push function --function-id <id>
```

One function at a time, by id. `appwrite.config.json` in this directory is the
source of each function's `execute` list, `scopes`, runtime, timeout and
schedule, and a push writes all of them — so a stale local config silently
reverts live settings someone changed in the console. Read the live values before
pushing anything you did not just edit:

```bash
appwrite functions get --function-id <id> --json
```

### Scopes are real privilege

A declared scope is what makes Appwrite inject a dynamic API key carrying that
power into the execution. An unused scope is surplus privilege on a key that any
code in that function can reach, so remove one the moment its last caller goes —
and grep the source before removing it, because a function that needs a key and
does not get one usually fails in a way that looks like something else entirely.

Conversely: a function with **no** scopes gets **no** injected key at all. That
is why removing `users.read` from a function that still calls the Users API does
not produce a permission error — it produces a silently missing `x-appwrite-key`
and a check that can never run.

---

## Operational gotchas

### 1. Async executions never enqueue on this instance

The four cron functions above **do not run on their schedule**. Their `schedule`
fields are set correctly and the console shows them, but nothing fires. Confirmed
2026-09-13: across all four,
`appwrite functions list-executions --function-id <id>` returns only executions
with `trigger: "http"` and not one with `trigger: "schedule"`, going back to the
day each was created.

Invoke each one by hand:

```bash
appwrite functions create-execution --function-id admin-rollup-event-sales
appwrite functions create-execution --function-id admin-cancel-stale-transactions
appwrite functions create-execution --function-id admin-verify-zeffy-tickets
appwrite functions create-execution --function-id admin-purge-anonymous-users
```

`--async` defaults to `false`, so the command runs the function synchronously and
prints the response body — which is where every one of those functions reports
the rows a human has to act on (`needsManualReview`, `cancelledPossiblyCharged`,
`needsReview`, `repairedOrders`, `unreplayable`). Read it.

Consequences if you forget: stale pending sales accumulate and the possibly-
charged ones are never reconciled against Stripe; event revenue figures go stale;
Zeffy buyers whose webhook failed stay un-ticketed and are refused at the door.

### 2. A build hanging at "Build command execution started" means the runtimes network has lost egress

The build is stuck at `npm i` with no network. It will sit there until the build
times out. This is not a problem with your code, the function, or the config —
retrying the push produces the identical hang. Restore egress on the Appwrite
runtimes network, then push again.

### 3. Functions cannot resolve this instance's own hostname

The function sandbox cannot resolve `api.cloud.shotty.tech` through
`getaddrinfo`, which is what Node's `http`/`fetch` use internally — but
`dns.resolve4` (which talks to nameservers directly) works fine. Every ESM
function that calls Appwrite goes through `src/appwriteClient.js`, which patches
the global `dns.lookup` for that one hostname. The URL and Host header are
untouched; only the DNS step is bypassed. `quick-access-login` carries its own
copy because it talks raw HTTP rather than through the SDK.

A function that hangs and then times out on its first Appwrite call, with
`EAI_AGAIN` in the log, is a function that skipped this helper.

### 4. `node-16.0` bounds what the SDK can do

The only Node runtime available. It predates global `fetch`, so `node-fetch` is a
real dependency wherever an external API is called. It also caps `node-appwrite`
at 14.x — 17+ requires Node 18+ — which is why `Verify-Pin`'s rate limiter is
still a racy read-modify-write while `quick-access-login`, which talks raw HTTP,
uses Appwrite 1.9's atomic `.../{attribute}/increment` route.

### 5. `rate_limits` has exactly three attributes

`attempts`, `windowStart`, `lockedUntil`. Nothing else may appear in a write
payload — Appwrite's structure validator rejects the whole document, not just the
extra field. Passing the `justLocked` control flag through as a document field is
what made every rate-limit write 400 for the limiter's entire life, in both
`Verify-Pin` and `quick-access-login`, leaving two unauthenticated PIN endpoints
with no brute-force defence at all.

Four functions share this collection with distinct id prefixes: `pin_c_` /
`pin_ip_` (Verify-Pin), `qa_c_` / `qa_ip_` (quick-access-login), `gcl_`
(Giftcard-Lookup), `rcp_` (Transaction-EmailReceipt). Clearing a lockout means
deleting that one document.

### 6. `execute` is checked before your code runs — and skipped for API keys

Appwrite evaluates the `execute` list when the execution is created, so by the
time a handler runs, team membership is already proven; re-deriving it in code
can only agree or be wrong. On 2026-09-13 three functions did exactly that,
`503`'d when the Users API could not resolve a caller id, and took a live Terminal
reader and the bar's giftcard scanning offline mid-service. Those checks were
removed in commit `02bee62`.

The one thing the allowlist does **not** cover: a project API key holding
`execution.write` invokes any function directly, and Appwrite cancels permission
checks for API-key requests. Such an execution has no session user, so
`x-appwrite-user-id` arrives absent or empty. That is why several functions still
refuse a request with no caller id — it is a different check from re-proving team
membership, and it needs no network call.

### 7. Pending attributes some functions are waiting for

Two functions write a newer attribute best-effort, after their main write, so a
project where it does not exist yet still records everything else:

- `Transactions.refunded_at` / `refund_amount` / `refunded_by` —
  `Stripe-RefundPayment`. Until these exist, a refund's only durable trace is the
  status flip, and `Admin-RollupEventSales` silently rewrites that event's past
  figures on its next run.
- `Events.card_sales_incl_tips` — `Admin-RollupEventSales`. The log line carries
  the exact `databases create-integer-attribute` command.

Both start populating with no redeploy once the attributes exist.

---

## Tests

`npm test` at this directory runs Jest across every function's `*.test.js`. The
guards in `stripe-getConnectionToken`, `Giftcard-Lookup` and
`Transaction-EmailReceipt` have tests asserting both of their required
properties: an API-key-only invocation is refused, and **no external lookup can
turn a session caller away**. If you change those files, those tests are the
contract.
