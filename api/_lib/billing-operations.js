import { createHash } from 'node:crypto';
import { assertLivemode } from './billing-config.js';
import { deriveBillingPatch, idOf, patchMatches, premiumItems } from './billing-reconcile.js';

const ALERT_AFTER_MS = 5 * 60 * 1000;
const ref = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
const age = (date, now) => Math.max(0, Math.floor((now.getTime() - new Date(date).getTime()) / 1000));

// Output contains only short hashes, categories, counts and ages. No Stripe
// object, account id, session URL, customer data or exception text escapes.
export async function auditBilling({ collections, stripe, environment, now = new Date() }) {
	const alerts = [];
	const add = (kind, id, seconds, detail = null) => alerts.push({ kind, ref: ref(id), ageSeconds: seconds, ...(detail ? { detail } : {}) });
	const scope = { stripeAccountId: environment.stripeAccountId, livemode: environment.livemode };
	const events = await collections.events.find({ ...scope, state: { $in: ['received', 'processing', 'failed', 'quarantined'] } }).toArray();
	for (const event of events) {
		const seconds = age(event.receivedAt, now);
		if (event.state === 'quarantined') add('webhook_quarantined', event.eventId, seconds, event.lastError);
		else if (event.state === 'failed') add('webhook_failed', event.eventId, seconds, event.lastError);
		else if (seconds >= ALERT_AFTER_MS) add('webhook_lag', event.eventId, seconds, event.state);
	}
	const purchases = await collections.purchases.find({}).toArray();
	for (const purchase of purchases) {
		if (!purchase._id.startsWith(`${environment.stripeAccountId}:${environment.environment}:`)) continue;
		const seconds = age(purchase.createdAt, now);
		if (purchase.state === 'creating' && seconds >= ALERT_AFTER_MS) add('checkout_creating', purchase._id, seconds);
		if (!purchase.sessionId) continue;
		try {
			const session = await stripe.checkout.sessions.retrieve(purchase.sessionId);
			assertLivemode(environment, session, 'Checkout Session');
			if (session.customer !== purchase.customerId) throw new Error('ownership');
			if (session.status === 'complete') {
				const accountId = Number(purchase._id.split(':').at(-1));
				const account = Number.isSafeInteger(accountId) ? await collections.users.findOne({ _id: accountId }) : null;
				if (!account?.billing?.subscriptionId && seconds >= ALERT_AFTER_MS) add('checkout_unprojected', purchase._id, seconds);
			}
		} catch { add('checkout_read_failure', purchase._id, seconds); }
	}
	const accounts = await collections.users.find({ 'billing.stripeAccountId': scope.stripeAccountId, 'billing.livemode': scope.livemode }).toArray();
	for (const account of accounts) {
		const stored = account.billing;
		if (!stored?.subscriptionId || !stored.customerId) continue;
		try {
			const subscription = await stripe.subscriptions.retrieve(stored.subscriptionId, { expand: ['latest_invoice'] });
			assertLivemode(environment, subscription, 'Subscription');
			if (idOf(subscription.customer) !== stored.customerId || !premiumItems(subscription, environment.productId).length) {
				add('projection_integrity', account._id, 0);
				continue;
			}
			const invoices = [];
			if (subscription.latest_invoice) {
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
	return { checkedAt: now.toISOString(), counts: { events: events.length, purchases: purchases.length, accounts: accounts.length }, alerts };
}
