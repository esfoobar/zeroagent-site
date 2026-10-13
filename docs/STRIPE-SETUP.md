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
