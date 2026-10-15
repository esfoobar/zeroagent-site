# Stripe setup and price-change runbook

ZA-901 (esfoobar/zeroagent#1264), part of ZA-154. This page is the manifest in prose and the runbook for the Stripe side of ZeroAgent billing. The machine-readable form is `docs/stripe-setup.manifest.json`; a test keeps its variable names equal to the ones the code reads (`api/_lib/billing-config.js`).

Nothing here is a value. No amount, no Price id, no key, no signing secret and no object id is written in this repo. The Stripe account is provisioned outside this repo and only when the owner authorizes it.

## Environments

There are two, and they never mix.

| | Sandbox | Live |
| --- | --- | --- |
| Where it runs | Vercel Preview and staging, dedicated staging database | Vercel Production |
| `STRIPE_EXPECT_LIVE_MODE` | `false` | `true` |
| Keys, signing secret, Product, portal configuration | its own | its own |

A deployment is configured for one mode. `loadBillingEnvironment` refuses a key whose own marker (`rk_test_`, `sk_live_`, ...) disagrees with `STRIPE_EXPECT_LIVE_MODE`, and `assertLivemode` refuses any event or API object whose `livemode` is not exactly the configured one, a missing flag included. The mode is never defaulted: an unset or malformed `STRIPE_EXPECT_LIVE_MODE` fails closed.

## Objects per environment

1. **Product** `ZeroAgent Premium`, one. Its id goes in `STRIPE_PREMIUM_PRODUCT_ID`.
2. **Price**, recurring monthly, quantity 1, set as the Product's `default_price`. The runtime reads `default_price` (`resolveCurrentSalePrice` in `api/_lib/billing-catalog.js`), so no Price id is configured. The amount and currency are entered only in Stripe, at creation, as the owner approves.
3. **Portal configuration**: allow payment-method update, invoice history and cancellation at period end. Disable plan switching, quantity updates, subscription-update flows, retention offers, promotion codes and scheduled price changes. Id in `STRIPE_PORTAL_CONFIGURATION_ID`.
4. **Webhook destination** at `/api/stripe/webhook` (`api/stripe-webhook.js`, ZA-902; `vercel.json` rewrites the path to it), one per environment, with exactly the event list in the manifest (a test holds the code's table equal to it). Subscribe to no other event: refunds and disputes are acknowledged and change nothing, and `payment_intent.*` and `charge.*` never write a plan. It must not redirect or sit behind preview protection. Its signing secret goes in `STRIPE_WEBHOOK_SECRET`.

Checkout requests automatic tax: `stripe.checkout.sessions.create` passes `automatic_tax: { enabled: true }`, `billing_address_collection: 'required'` and `customer_update: { address: 'auto' }` so Stripe Tax can calculate tax from the collected billing address. The head office address and Product tax code `txcd_10000000` are configured in Stripe.

Variables, by name: `STRIPE_API_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PREMIUM_PRODUCT_ID`, `STRIPE_PORTAL_CONFIGURATION_ID`, `STRIPE_ACCOUNT_ID`, `STRIPE_EXPECT_LIVE_MODE`, `BILLING_BASE_URL`, and optionally `STRIPE_API_VERSION` (pinned on every runtime request; set it once the sandbox has proved the object shapes, since period dates sit on subscription items in current API versions and the reconciliation reads both shapes). Secrets go in with `printf '%s' "$value" | vercel env add NAME <environment> --sensitive`, never `echo`. The runtime key is restricted: customers, Checkout and portal sessions, and subscription and invoice reads (the webhook needs only the last two, read only). Catalog, webhook configuration, refunds, payouts and bank administration stay out of it. Verify the exact permission set in sandbox rather than falling back to a full key.

The relay, the desktop app and the phone receive no Stripe credential.

## Database

Run once per environment, against that environment's database:

```
MONGODB_URI=... MONGODB_DB=... npm run billing:migrate            # create indexes, print inventory
MONGODB_URI=... MONGODB_DB=... npm run billing:migrate -- --dry-run   # inventory only
```

It creates the unique partial indexes on `users` (customer and subscription id, scoped by Stripe account and mode), the event inbox unique index (account, mode, event id) and the audit index. It is idempotent and writes no user document: existing trials, plans, paid-through dates and paired devices are untouched, and `billing`, `entitlementSource` and `legacyGrant` stay absent until the webhook writer or the legacy marking step sets them. The inventory lists hand-assigned paid plans by hash reference with the contract's default disposition and no customer data. Marking is a separate, deliberate step.

## Operating the webhook

Before the Stripe destination exists, prove the endpoint reads the exact request bytes on a deployment: `STRIPE_WEBHOOK_SECRET=<the environment's signing secret> node scripts/send-test-webhook.mjs https://<host>/api/stripe/webhook`. It sends a synthetic, unsupported-type event signed with that secret (recorded as ignored, no account changes) and the same body with a corrupted signature; it expects 200 then 400 and prints PASS. A signed request answered 400 means the function did not get the raw bytes; 503 `body_unavailable` means it could not read the body.

The inbox is the `billingEvents` collection. An event is `completed` (applied, or deliberately ignored: the `outcome` field says which), `failed` (will be retried by Stripe), or `quarantined` (parked, answered 2xx so Stripe stops retrying; `lastError` is the reason). The reasons and what to do:

| `lastError` | Meaning | Repair |
| --- | --- | --- |
| `unmapped_customer`, `no_customer` | No account carries this customer | Find the account out of band, write the customer mapping, then replay the event from the Stripe dashboard. Never match by email. |
| `legacy_grant_conflict` | The account holds a hand-assigned or marked grant | Owner decision at inventory time. Nothing is changed until it is made. |
| `multiple_subscriptions` | A second live subscription on one account | Cancel the surplus one at Stripe, then replay. |
| `customer_mismatch`, `mode_mismatch`, `stripe_object_missing`, `account_missing` | Configuration or data anomaly | Investigate; do not replay until understood. |
| `operator_attention` | `invoice.finalization_failed` | A billing problem at Stripe, no entitlement implied. |
| `attempts_exhausted` | Eight failed attempts | Fix the cause (Stripe or database availability), then replay. |

A replay of a quarantined event is a redelivery from Stripe with the same event id after the entry is reset to `received` by an operator; there is no script and no second write path, so it goes through the same signature check, lease and fenced commit. Alert on `quarantined` entries and on events older than a few minutes still `received` or `failed`.

## Changing the price

An increase or a decrease is the same procedure. Existing subscriptions keep their original Price; a subscriber whose subscription actually ended pays the then-current Price on return; reversing a scheduled cancellation keeps the subscription and its Price.

1. Prove it in sandbox first. Record the old and new Price ids, the Product id and the approved amount, currency and tax behavior in the operational audit, never in a user record.
2. Add a new recurring monthly Price to the existing Product (Dashboard, or `POST /v1/prices` with an idempotency key). Do not create a new Product and do not edit any subscription item.
3. For a clean cutover, pause sales: `setSalesPaused` in `api/_lib/billing-catalog.js` with an actor and a reason (both required). It sets `salesPaused` in the environment's `billingCatalog` document and appends to `billingAudit`. It blocks new Checkout creation only; subscribers, the portal and webhooks carry on.
4. Expire tracked open unpaid Checkout Sessions (`POST /v1/checkout/sessions/{id}/expire`). A session that completed first keeps its accepted Price and is reconciled normally. Do not rely on archiving to invalidate sessions.
5. Set the new Price as the Product's `default_price`. This is the whole change: no environment variable, no deployment. Verify with the Product retrieved with `default_price` expanded, then let the 60-second offer cache lapse or invalidate it.
6. Archive the previous Price (`active=false`). Never archive the Product. Resume sales with `setSalesPaused` (again with actor and reason).
7. Verify: a new checkout uses the new Price, the public offer changed without a deploy, and an existing subscriber still renews on the original Price.

Rollback changes only the current-sale pointer: reactivate the prior Price if needed and retire the mistaken one. Never rewrite subscriptions already created.

## Provisioning the sandbox (authorized work only)

Not done by this ticket. When the owner authorizes it: create the sandbox under the ZeroAgent Stripe account, create the Product, Price, portal configuration and event destination with the CLI or API, record object ids (never key values) in deployment notes, put the secrets in Vercel's protected settings for Preview only, then run the migration against the staging database. Live is reproduced the same way after sandbox acceptance and merchant activation, and the first live payment is a coordinated, authorized proof.

## ZA-908 operations audit and replay

Run `npm run billing:audit` with the environment's protected Stripe and database variables. The command reads the inbox, purchase attempts, Stripe subscriptions, invoices and stored projections. It prints one JSON line with counts, age in seconds, keyed short references and alert categories. References use HMAC-SHA256 keyed by the already configured `STRIPE_WEBHOOK_SECRET`, so an account's numeric id cannot be guessed from its reference. It caps Stripe reads at 100 per run and reports `truncated: true` with the observed counts when it reaches the cap. A partial result is never clear. Checkout Sessions older than 24 hours are skipped once their account has a stored subscription; later changes remain covered by webhook alerts and subscription drift checks. It exits 0 when clear, 2 when it finds an alert or truncates, and 1 when the audit cannot run. Capture that exit code in the operator's monitoring system and page on 1 or 2. The repository's `Billing audit` GitHub Actions workflow (`.github/workflows/billing-audit.yml`) runs it weekly, Mondays 06:17 UTC, and on manual dispatch, on `ubuntu-latest`; a superseded run is cancelled, and a run that exits 1 or 2 fails, which sends the repository's failed-run email. The workflow needs these repository secrets, names only: `STRIPE_API_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PREMIUM_PRODUCT_ID`, `STRIPE_ACCOUNT_ID`, `STRIPE_EXPECT_LIVE_MODE`, `MONGODB_URI`, `MONGODB_DB`, and optionally `STRIPE_API_VERSION`. While all of the required ones are unset it ends successfully with one line saying the audit is not configured; with only some set it fails. A weekly run is a floor, not a monitor: run it by hand, or from an operator schedule, after any change and when a customer reports a problem. No Vercel cron or function is added. The script writes no database field.

`webhook_lag` means a received or processing event is at least five minutes old. `webhook_failed` and `webhook_quarantined` are immediate alerts. `webhook_failed` is reported for a failed event whose recorded reason is not transient, and for a transient one (`lease_held`, `lease_lost`, `stripe_unavailable`) once it is an hour old (`RETRY_PENDING_BOUND_SECONDS` in `api/_lib/billing-operations.js`). A transient failure younger than that is Stripe's own retry in progress: it appears under `pending` as `webhook_retry_pending` with `count` and `oldestAgeSeconds`, is not an alert, and does not change the exit code. Age is measured from first receipt, so an event that keeps failing is alerted an hour after it arrived. `checkout_creating` means a purchase creation is at least five minutes old; `checkout_unprojected` means a completed Checkout Session has no matching stored subscription after five minutes. `checkout_read_failure`, `projection_read_failure` and `projection_integrity` require investigation. `projection_drift` means current Stripe state derives a different projection. `no_replay_candidate` means the inbox has no pending event for that customer and an operator must locate a usable Stripe event. Counts and short references are diagnostic only. Do not publish the raw Stripe or database records.

For repair, pass the reported 12 character reference directly to the replay preparation command, or pass a full event id. It resolves a reference only among failed and quarantined events in the configured Stripe account and mode, and refuses zero or multiple matches. Check the Stripe subscription, customer mapping, account mode and the reason for quarantine. Correct only the underlying cause. If the event is failed or quarantined, run `printf '%s' '<event-reference-or-id>' | npm run billing:prepare-replay -- '<operator>' '<reason>'` in the protected environment. This atomically resets only the inbox retry state and attempt count, preserves the original `receivedAt`, records `replayPreparedAt` for new lag measurement, and appends an audit entry with the operator, reason, previous state and short event reference. Find the full event id privately in the matched inbox record when requesting Stripe redelivery. It does not project anything. Ask Stripe to resend that same event to `/api/stripe/webhook`, or use Stripe's Dashboard resend. The webhook must verify its signature and pass through the same inbox claim, customer lease and fenced `commitProjection` transaction. Run the audit again and verify the alert clears. If no usable event exists, do not edit `users.plan`, `users.billing`, paid dates or entitlement fields. Escalate the missing-event case and keep sales paused if new purchases cannot be fulfilled. Never repair by copying Stripe state directly into a user record.

## Sandbox lifecycle proof commands

No sandbox or Stripe account exists for this ticket. These checks are ready to run once the owner provisions a dedicated sandbox, staging database, restricted test key and webhook. Set `STRIPE_EXPECT_LIVE_MODE=false` and the other variables listed above in a protected shell. The runner refuses live mode, live objects and non-restricted keys; it prints only scenario names and check names. All commands below use `npm run billing:sandbox-proof --` and replace the angle-bracket placeholders with sandbox object ids. Never put a key in command arguments. Perform the stated action through hosted Checkout, portal or the sandbox Dashboard first, then run the matching proof command. Each command verifies the current Stripe objects and the stored webhook projection, not merely a local fixture.

- Increase: after changing the Product default to the higher Price, `npm run billing:sandbox-proof -- --scenario=price-increase --oldPrice=<old> --newPrice=<new> --subscription=<continuous> --account=<account-id>`.
- Decrease: after changing the Product default to the lower Price, `npm run billing:sandbox-proof -- --scenario=price-decrease --oldPrice=<old> --newPrice=<new> --subscription=<continuous> --account=<account-id>`.
- Archived Price renewal: archive the old Price, renew the existing subscription, wait for its paid invoice webhook, then `npm run billing:sandbox-proof -- --scenario=archived-renewal --oldPrice=<old> --subscription=<continuous> --invoice=<paid-invoice> --account=<account-id>`.
- Portal preservation: open and return from the hosted portal, then `npm run billing:sandbox-proof -- --scenario=portal-preservation --oldPrice=<old> --subscription=<continuous> --account=<account-id>`. This checks that subscription switching is disabled in the portal configuration and the original Price remains on Stripe and in the projection.
- Return after cancellation: let the old subscription end, complete a new Checkout, wait for projection, then `npm run billing:sandbox-proof -- --scenario=return-after-cancellation --oldSubscription=<ended> --subscription=<new> --account=<account-id>`.
- Reverse scheduled cancellation: reverse it in the portal before the paid period ends, then `npm run billing:sandbox-proof -- --scenario=reverse-cancellation --oldPrice=<old> --subscription=<continuous> --account=<account-id>`.
- Test-clock renewal: advance a clock-bound customer through a renewal, wait until the clock is ready and the invoice webhook projects, then `npm run billing:sandbox-proof -- --scenario=test-clock-renewal --clock=<clock> --subscription=<continuous> --invoice=<paid-invoice> --previousPaidThrough=<ISO-date> --account=<account-id>`. Advancing the Stripe clock does not advance application time; verify grace and expiry with an injected application clock separately.
- Payment failure: use a sandbox failure method on renewal, wait for the webhook, then `npm run billing:sandbox-proof -- --scenario=payment-failure --subscription=<continuous> --invoice=<unpaid-invoice> --account=<account-id>`. After grace exhaustion, verify `/api/app/me` with an injected application clock. The runner checks the stored grace anchor, not a wall-clock expiry claim.
- Cancel: schedule cancellation through the portal and wait for the webhook, then `npm run billing:sandbox-proof -- --scenario=cancel --subscription=<continuous> --account=<account-id>`. For terminal cancellation, also run the return case above.
- Restricted key: `npm run billing:sandbox-proof -- --scenario=restricted-key`. It proves subscription read is allowed and balance read is denied with 403. The runner itself requires an `rk_test_` key.
- Staging boundary: with a separate staging database and reachable staging URL, `npm run billing:sandbox-proof -- --scenario=staging-boundary --stagingUrl=<https-staging-url> --productionDb=<production-db-name>`. This checks sandbox mode, separate database name, nonproduction host and catalog reachability. Also manually inspect Vercel Preview secret scoping and verify production requests cannot access the staging database; this script alone cannot prove deployment secret boundaries.

Record the sandbox object ids, timestamps, event ids, observed `/api/app/me` states and test-clock transitions in the private operational evidence. Keep keys, webhook bodies, customer details and portal URLs out of the record. These commands have not been run against Stripe or staging in ZA-908.
