import { billingReference } from './billing-reference.js';
import { assertLivemode } from './billing-config.js';
import { deriveBillingPatch, idOf, patchMatches, premiumItems } from './billing-reconcile.js';

const ALERT_AFTER_SECONDS = 5 * 60;
const PURCHASE_SKIP_AFTER_SECONDS = 24 * 60 * 60;
export const MAX_AUDIT_STRIPE_READS = 100;
// A failed event whose recorded reason is transient is redelivered by Stripe
// on its own, so a recent one is lag, not a failure. Past this age it alerts.
export const RETRY_PENDING_BOUND_SECONDS = 60 * 60;
export const TRANSIENT_FAILURE_CODES = Object.freeze(['lease_held', 'lease_lost', 'stripe_unavailable']);
const ERROR_CODES = new Set(['stripe_unavailable', 'stripe_rejected', 'lease_held', 'lease_lost', 'processing_error', 'operator_attention', 'attempts_exhausted', 'unmapped_customer', 'no_customer', 'legacy_grant_conflict', 'multiple_subscriptions', 'customer_mismatch', 'mode_mismatch', 'stripe_object_missing', 'account_missing']);
const safeCode = (value) => ERROR_CODES.has(value) ? value : 'other';
const age = (date, now) => Math.max(0, Math.floor((now.getTime() - new Date(date).getTime()) / 1000));

// Output contains only short hashes, categories, counts and ages. No Stripe
// object, account id, session URL, customer data or exception text escapes.
export async function auditBilling({ collections, stripe, environment, referenceKey, now = new Date(), maxStripeReads = MAX_AUDIT_STRIPE_READS, retryPendingBoundSeconds = RETRY_PENDING_BOUND_SECONDS }) {
	if (!Number.isInteger(maxStripeReads) || maxStripeReads < 0) throw new Error('invalid_stripe_read_limit');
	billingReference('', referenceKey);
	let stripeReads = 0;
	let truncated = false;
	let skippedPurchases = 0;
	const alerts = [];
	let retryPending = null;
	const add = (kind, id, seconds, detail = null) => alerts.push({ kind, ref: billingReference(id, referenceKey), ageSeconds: seconds, ...(detail ? { detail } : {}) });
	const scope = { stripeAccountId: environment.stripeAccountId, livemode: environment.livemode };
	const events = await collections.events.find({ ...scope, state: { $in: ['received', 'processing', 'failed', 'quarantined'] } }).toArray();
	for (const event of events) {
		const seconds = age(event.replayPreparedAt || event.receivedAt, now);
		if (event.state === 'quarantined') add('webhook_quarantined', event.eventId, seconds, safeCode(event.lastError));
		else if (event.state === 'failed' && TRANSIENT_FAILURE_CODES.includes(event.lastError) && seconds < retryPendingBoundSeconds) {
			retryPending = { kind: 'webhook_retry_pending', count: (retryPending?.count || 0) + 1, oldestAgeSeconds: Math.max(retryPending?.oldestAgeSeconds || 0, seconds) };
		} else if (event.state === 'failed') add('webhook_failed', event.eventId, seconds, safeCode(event.lastError));
		else if (seconds >= ALERT_AFTER_SECONDS) add('webhook_lag', event.eventId, seconds, event.state);
	}
	const prefix = `${environment.stripeAccountId}:${environment.environment}:`;
	const purchases = await collections.purchases.find({ _id: { $gte: prefix, $lt: `${prefix}\uffff` } }).toArray();
	for (const purchase of purchases) {
		const seconds = age(purchase.createdAt, now);
		if (purchase.state === 'creating' && seconds >= ALERT_AFTER_SECONDS) add('checkout_creating', purchase._id, seconds);
		if (!purchase.sessionId) continue;
		const accountId = Number(purchase._id.slice(prefix.length));
		const account = Number.isSafeInteger(accountId) ? await collections.users.findOne({ _id: accountId }) : null;
		const projected = account?.billing?.stripeAccountId === environment.stripeAccountId && account.billing.livemode === environment.livemode ? account.billing : null;
		// A projected subscriber's old Checkout is no longer actionable. Recheck
		// it for one day to catch delayed completion, then rely on webhook and
		// projection drift monitoring instead of polling it forever.
		if (seconds > PURCHASE_SKIP_AFTER_SECONDS && projected?.subscriptionId) { skippedPurchases++; continue; }
		if (stripeReads >= maxStripeReads) { truncated = true; break; }
		try {
			stripeReads++;
			const session = await stripe.checkout.sessions.retrieve(purchase.sessionId);
			assertLivemode(environment, session, 'Checkout Session');
			if (session.customer !== purchase.customerId) throw new Error('ownership');
			if (session.status === 'complete') {
				if ((session.subscription ? projected?.subscriptionId !== idOf(session.subscription) : !projected?.subscriptionId) && seconds >= ALERT_AFTER_SECONDS) add('checkout_unprojected', purchase._id, seconds);
			}
		} catch { add('checkout_read_failure', purchase._id, seconds); }
	}
	const accounts = await collections.users.find({ 'billing.stripeAccountId': scope.stripeAccountId, 'billing.livemode': scope.livemode }).toArray();
	for (const account of accounts) {
		const stored = account.billing;
		if (!stored?.subscriptionId || !stored.customerId) continue;
		if (stripeReads >= maxStripeReads) { truncated = true; break; }
		try {
			stripeReads++;
			const subscription = await stripe.subscriptions.retrieve(stored.subscriptionId, { expand: ['latest_invoice'] });
			assertLivemode(environment, subscription, 'Subscription');
			if (idOf(subscription.customer) !== stored.customerId || !premiumItems(subscription, environment.productId).length) {
				add('projection_integrity', account._id, 0);
				continue;
			}
			const invoices = [];
			if (subscription.latest_invoice) {
				if (typeof subscription.latest_invoice === 'string' && stripeReads >= maxStripeReads) { truncated = true; break; }
				if (typeof subscription.latest_invoice === 'string') stripeReads++;
				const invoice = typeof subscription.latest_invoice === 'string' ? await stripe.invoices.retrieve(subscription.latest_invoice) : subscription.latest_invoice;
				assertLivemode(environment, invoice, 'Invoice');
				invoices.push(invoice);
			}
			const derived = deriveBillingPatch({ subscription, invoices, previous: stored, environment, customerId: stored.customerId });
			if (derived.action === 'write' && !patchMatches(stored, derived.patch)) {
				const candidates = events.filter((e) => e.customerId === stored.customerId && e.state !== 'completed').length;
				add('projection_drift', account._id, 0, candidates ? 'replay_candidate_in_inbox' : 'no_replay_candidate');
			}
		} catch { add('projection_read_failure', account._id, 0); }
	}
	return { checkedAt: now.toISOString(), truncated, counts: { events: events.length, purchases: purchases.length, accounts: accounts.length, skippedPurchases, stripeReads }, alerts, pending: retryPending ? [retryPending] : [] };
}
