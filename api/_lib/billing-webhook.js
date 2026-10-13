/*
 * ZA-902 / esfoobar/zeroagent#1265. Processing of one VERIFIED Stripe
 * event into paid entitlement. The endpoint (api/stripe-webhook.js) has
 * already checked the signature over the raw bytes, the livemode and the
 * Stripe account; this module takes it from there:
 *
 *   record in the inbox -> claim -> per-customer lease -> retrieve the
 *   current Stripe state -> derive the patch (billing-reconcile.js) ->
 *   fenced commit (billing-commit.js), the only writer of paid state.
 *
 * The answer is { status, body }: 2xx when the event is applied, already
 * applied, deliberately ignored or parked for an operator (the quarantine
 * is the alert, retrying would not help), 5xx when a retry can succeed
 * (lease or claim held, Stripe or the database unavailable, lease lost).
 * An event is never acknowledged and dropped: every 2xx is either a
 * committed projection or an inbox entry that says why nothing was written.
 */

import { randomToken } from './hash.js';
import { BillingModeMismatchError, assertLivemode } from './billing-config.js';
import {
	claimEventWithCollection,
	completeEventWithCollection,
	failEventWithCollection,
	inboxKey,
	quarantineEventWithCollection,
	recordEventWithCollection,
} from './billing-inbox.js';
import { acquireLeaseWithCollection, customerLeaseKey, releaseLeaseWithCollection, renewLeaseWithCollection } from './billing-lease.js';
import {
	AccountNotFoundError,
	EventNotOwnedError,
	LeaseLostError,
	LegacyGrantConflictError,
	commitProjection,
} from './billing-commit.js';
import { deriveBillingPatch, idOf, isTerminalSubscription, patchMatches, premiumItems, subscriptionIdOfInvoice } from './billing-reconcile.js';
import { StripeApiError } from './stripe-client.js';

// The exact initial subscription (docs/stripe-setup.manifest.json keeps the
// same list; a test holds the two equal).
//   reconcile    retrieve current state and project it
//   acknowledge  mapped customer only; grants and changes nothing (the
//                contract: Checkout completion never grants, the settled
//                invoice does)
//   operator     surfaces an operational billing issue by quarantine
export const EVENT_HANDLING = Object.freeze({
	'checkout.session.completed': 'acknowledge',
	'checkout.session.expired': 'acknowledge',
	'checkout.session.async_payment_succeeded': 'acknowledge',
	'checkout.session.async_payment_failed': 'acknowledge',
	'customer.subscription.created': 'reconcile',
	'customer.subscription.updated': 'reconcile',
	'customer.subscription.deleted': 'reconcile',
	'customer.subscription.paused': 'reconcile',
	'customer.subscription.resumed': 'reconcile',
	'invoice.paid': 'reconcile',
	'invoice.payment_failed': 'reconcile',
	'invoice.payment_action_required': 'reconcile',
	'invoice.finalization_failed': 'operator',
	'invoice.voided': 'reconcile',
	'invoice.marked_uncollectible': 'reconcile',
});

const ok = (outcome) => ({ status: 200, body: { received: true, outcome } });
const retry = (reason) => ({ status: 503, body: { error: 'retry', reason } });

function customerOf(object) {
	return object ? idOf(object.customer) : null;
}

// How a customer maps to an account. ZA-903 writes the mapping onto the
// account's billing record before it starts Checkout; a customer nobody
// mapped is never matched by email or login.
async function findAccountByCustomer(users, environment, customerId) {
	return users.findOne({
		'billing.stripeAccountId': environment.stripeAccountId,
		'billing.livemode': environment.livemode,
		'billing.customerId': customerId,
	});
}

function subscriptionIdFor(event) {
	const object = event.data.object;
	if (event.type.startsWith('customer.subscription.')) return idOf(object);
	if (event.type.startsWith('invoice.')) return subscriptionIdOfInvoice(object);
	return null;
}

export async function processWebhookEvent({
	event,
	environment,
	store,
	stripe,
	now = () => new Date(),
	owner = randomToken(12),
	log = () => {},
}) {
	const { users, events, leases } = store.collections;
	const key = inboxKey({ stripeAccountId: environment.stripeAccountId, livemode: event.livemode, eventId: event.id });

	await recordEventWithCollection(events, { environment, event, now: now() });
	const claim = await claimEventWithCollection(events, { key, owner, now: now() });
	if (claim.status === 'completed') return ok('already_processed');
	if (claim.status === 'quarantined') return ok('quarantined');
	if (claim.status === 'held') return retry('event_held');
	if (claim.status === 'missing') return retry('event_not_recorded');

	const fail = async (code) => {
		await failEventWithCollection(events, { key, owner, errorCode: code, now: now() });
		log({ eventId: event.id, type: event.type, code });
		return retry(code);
	};
	const quarantine = async (reason) => {
		await quarantineEventWithCollection(events, { key, owner, reason, now: now() });
		log({ eventId: event.id, type: event.type, code: `quarantined:${reason}` });
		return ok('quarantined');
	};
	const complete = async (outcome) => {
		const done = await completeEventWithCollection(events, { key, owner, outcome, now: now() });
		return done ? ok(outcome) : retry('event_not_owned');
	};

	let lease = null;
	try {
		const handling = Object.hasOwn(EVENT_HANDLING, event.type) ? EVENT_HANDLING[event.type] : null;
		if (!handling) return await complete('unsupported_type');
		if (handling === 'operator') return await quarantine('operator_attention');

		const customerId = customerOf(event.data.object);
		if (!customerId) return await quarantine('no_customer');

		const mapped = await findAccountByCustomer(users, environment, customerId);
		if (!mapped) return await quarantine('unmapped_customer');
		if (handling === 'acknowledge') return await complete('no_grant_from_checkout');

		const subscriptionId = subscriptionIdFor(event);
		if (!subscriptionId) return await complete('ignored_no_subscription');

		lease = await acquireLeaseWithCollection(leases, {
			key: customerLeaseKey({ stripeAccountId: environment.stripeAccountId, livemode: environment.livemode, customerId }),
			owner,
			now: now(),
		});
		if (!lease) return await fail('lease_held');

		// Everything below runs inside the lease and reads current state.
		const user = await users.findOne({ _id: mapped._id });
		if (!user) return await quarantine('account_missing');
		const stored = user.billing && typeof user.billing === 'object' && user.billing.provider === 'stripe' ? user.billing : null;

		const subscription = await stripe.subscriptions.retrieve(subscriptionId, { expand: ['latest_invoice'] });
		assertLivemode(environment, subscription, 'subscription');
		if (idOf(subscription.customer) !== customerId) return await quarantine('customer_mismatch');
		if (premiumItems(subscription, environment.productId).length === 0) return await complete('not_premium');

		let previous = stored;
		if (stored && stored.subscriptionId && stored.subscriptionId !== subscription.id) {
			// A different subscription from the account's current one. A late
			// event of a terminated one never downgrades anything.
			if (isTerminalSubscription(subscription)) return await complete('stale_subscription');
			let currentIsOver = stored.status === 'ended';
			if (!currentIsOver) {
				const current = await stripe.subscriptions.retrieve(stored.subscriptionId);
				assertLivemode(environment, current, 'current subscription');
				currentIsOver = isTerminalSubscription(current);
			}
			// Two live subscriptions on one account is an anomaly to alert on,
			// not something to resolve by picking the latest.
			if (!currentIsOver) return await quarantine('multiple_subscriptions');
			previous = null;
		}

		const invoices = [];
		if (event.type.startsWith('invoice.')) {
			const invoice = await stripe.invoices.retrieve(event.data.object.id);
			assertLivemode(environment, invoice, 'invoice');
			invoices.push(invoice);
		}
		const latestInvoice = subscription.latest_invoice;
		if (latestInvoice && typeof latestInvoice === 'object') {
			assertLivemode(environment, latestInvoice, 'latest invoice');
			invoices.push(latestInvoice);
		} else if (typeof latestInvoice === 'string' && !invoices.some((i) => i.id === latestInvoice)) {
			const invoice = await stripe.invoices.retrieve(latestInvoice);
			assertLivemode(environment, invoice, 'latest invoice');
			invoices.push(invoice);
		}

		const derived = deriveBillingPatch({ subscription, invoices, previous, environment, customerId });
		if (derived.action === 'skip') return await complete(derived.reason);
		if (patchMatches(previous, derived.patch)) return await complete('no_change');

		// The Stripe calls above may have been slow: keep the lease, or lose
		// the commit rather than write from stale state.
		const renewed = await renewLeaseWithCollection(leases, { lease, now: now() });
		if (!renewed) return await fail('lease_lost');
		lease = renewed;

		await commitProjection(
			{ collections: store.collections, withTransaction: store.withTransaction },
			{ environment, lease, githubId: user._id, patch: derived.patch, eventKey: key, owner, now: now(), acknowledgeLegacy: false }
		);
		return ok(`${derived.from}->${derived.to}`);
	} catch (err) {
		if (err instanceof LeaseLostError) return fail('lease_lost');
		if (err instanceof EventNotOwnedError) return retry('event_not_owned');
		// Fail closed: a legacy grant is never auto-acknowledged.
		if (err instanceof LegacyGrantConflictError) return quarantine('legacy_grant_conflict');
		if (err instanceof AccountNotFoundError) return quarantine('account_missing');
		if (err instanceof BillingModeMismatchError) return quarantine('mode_mismatch');
		if (err instanceof StripeApiError) {
			if (err.status === 404 && err.code === 'resource_missing') return quarantine('stripe_object_missing');
			return fail(err.retriable ? 'stripe_unavailable' : 'stripe_rejected');
		}
		return fail('processing_error');
	} finally {
		if (lease) {
			try {
				await releaseLeaseWithCollection(leases, { lease });
			} catch {
				// The lease expires on its own; nothing to add.
			}
		}
	}
}
