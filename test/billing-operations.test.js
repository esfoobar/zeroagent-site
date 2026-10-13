import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditBilling } from '../api/_lib/billing-operations.js';
import { billingReference } from '../api/_lib/billing-reference.js';

const referenceKey = 'whsec_fake_test';
const now = new Date('2026-10-13T12:00:00.000Z');
const old = '2026-10-13T11:50:00.000Z';
const environment = { stripeAccountId: 'acct_test', environment: 'sandbox', livemode: false, productId: 'prod_test' };
const rows = (data) => ({ find: () => ({ toArray: async () => data }) });

test('audit reports lag, failed events, pending checkout and drift with redacted references', async () => {
	const collections = {
		events: rows([{ eventId: 'evt_private', stripeAccountId: 'acct_test', livemode: false, customerId: 'cus_private', state: 'failed', lastError: 'processing_error', receivedAt: old }]),
		purchases: rows([{ _id: 'acct_test:sandbox:42', state: 'open', sessionId: 'cs_private', customerId: 'cus_private', createdAt: old }]),
		users: { find: () => ({ toArray: async () => [{ _id: 42, billing: { stripeAccountId: 'acct_test', livemode: false, customerId: 'cus_private', subscriptionId: 'sub_old', status: 'active', paidThrough: '2026-10-01T00:00:00.000Z' } }] }), findOne: async () => ({ billing: { subscriptionId: 'sub_old' } }) },
	};
	const subscription = { id: 'sub_old', customer: 'cus_private', livemode: false, status: 'canceled', ended_at: 1790841600, items: { data: [{ price: { id: 'price_private', product: 'prod_test' } }] }, latest_invoice: null };
	const stripe = { checkout: { sessions: { retrieve: async () => ({ livemode: false, customer: 'cus_private', status: 'complete', subscription: 'sub_new' }) } }, subscriptions: { retrieve: async () => subscription }, invoices: { retrieve: async () => { throw Error('unexpected'); } } };
	const result = await auditBilling({ collections, stripe, environment, referenceKey, now });
	assert.deepEqual(result.alerts.map((a) => a.kind), ['webhook_failed', 'checkout_unprojected', 'projection_drift']);
	assert.equal(result.alerts[2].detail, 'replay_candidate_in_inbox');
	const serialized = JSON.stringify(result);
	for (const alert of result.alerts) {
		assert.ok(['ageSeconds,kind,ref', 'ageSeconds,detail,kind,ref'].includes(Object.keys(alert).sort().join(',')));
		for (const value of Object.values(alert)) for (const sensitive of ['evt_private', 'cus_private', 'cs_private', 'sub_old', 'sub_new', 'price_private', '42']) assert.ok(!String(value).includes(sensitive));
	}
	assert.equal(result.alerts[0].ref, billingReference('evt_private', referenceKey));
	assert.ok(!serialized.includes('cus_private'));
});

test('audit refuses wrong mode and does not write any collection', async () => {
	const deny = () => { throw Error('audit attempted a write'); };
	const collections = { events: rows([]), purchases: rows([{ _id: 'acct_test:sandbox:42', state: 'open', sessionId: 'cs_private', customerId: 'cus_private', createdAt: old }]), users: { ...rows([]), findOne: async () => null } };
	for (const collection of Object.values(collections)) for (const method of ['updateOne', 'findOneAndUpdate', 'insertOne', 'deleteOne', 'bulkWrite']) collection[method] = deny;
	const result = await auditBilling({ collections, environment, now, stripe: { checkout: { sessions: { retrieve: async () => ({ livemode: true }) } } }, referenceKey });
	assert.equal(result.alerts[0].kind, 'checkout_read_failure');
});

test('webhook failure logs use a short reference, not the event id', async () => {
	const source = (await import('node:fs')).readFileSync('api/_lib/billing-webhook.js', 'utf8');
	assert.match(source, /eventRef: billingReference\(event\.id, referenceKey\)/);
	assert.ok(!source.includes('log({ eventId:'));
});

test('audit scopes purchase query, skips an old projected checkout and caps Stripe reads', async () => {
	const queried = [];
	const purchases = [
		{ _id: 'acct_test:sandbox:42', state: 'open', sessionId: 'cs_old', customerId: 'cus_old', createdAt: '2026-10-10T00:00:00.000Z' },
		{ _id: 'acct_test:sandbox:43', state: 'open', sessionId: 'cs_new', customerId: 'cus_new', createdAt: old },
		{ _id: 'acct_test:sandbox:44', state: 'open', sessionId: 'cs_extra', customerId: 'cus_extra', createdAt: old },
	];
	const collections = {
		events: rows([]),
		purchases: { find: (query) => { queried.push(query); return { toArray: async () => purchases }; } },
		users: { findOne: async ({ _id }) => _id === 42 ? { billing: { stripeAccountId: 'acct_test', livemode: false, subscriptionId: 'sub_old' } } : null, ...rows([]) },
	};
	const calls = [];
	const stripe = { checkout: { sessions: { retrieve: async (id) => { calls.push(id); return { livemode: false, customer: 'cus_new', status: 'open' }; } } } };
	const result = await auditBilling({ collections, stripe, environment, referenceKey, now, maxStripeReads: 1 });
	assert.deepEqual(queried, [{ _id: { $gte: 'acct_test:sandbox:', $lt: 'acct_test:sandbox:\uffff' } }]);
	assert.deepEqual(calls, ['cs_new']);
	assert.equal(result.counts.skippedPurchases, 1);
	assert.equal(result.counts.stripeReads, 1);
	assert.equal(result.truncated, true);
});

test('replay lag starts at preparation time, not original receipt', async () => {
	const collections = { events: rows([{ eventId: 'evt_replayed', state: 'received', receivedAt: '2026-10-01T00:00:00.000Z', replayPreparedAt: '2026-10-13T11:59:00.000Z' }]), purchases: rows([]), users: rows([]) };
	const result = await auditBilling({ collections, stripe: {}, environment, referenceKey, now });
	assert.deepEqual(result.alerts, []);
	assert.equal(result.truncated, false);
});

test('subscription invoice retrieval also respects the Stripe read cap', async () => {
	const account = { _id: 42, billing: { stripeAccountId: 'acct_test', livemode: false, customerId: 'cus_one', subscriptionId: 'sub_one' } };
	const collections = { events: rows([]), purchases: rows([]), users: rows([account]) };
	let invoiceReads = 0;
	const stripe = { subscriptions: { retrieve: async () => ({ id: 'sub_one', customer: 'cus_one', livemode: false, items: { data: [{ price: { product: 'prod_test' } }] }, latest_invoice: 'in_one' }) }, invoices: { retrieve: async () => { invoiceReads++; throw Error('must not read'); } } };
	const result = await auditBilling({ collections, stripe, environment, referenceKey, now, maxStripeReads: 1 });
	assert.equal(invoiceReads, 0);
	assert.equal(result.counts.stripeReads, 1);
	assert.equal(result.truncated, true);
});

test('audit: a recent transient failure is retry pending and not an alert; an old one alerts', async () => {
	const fresh = '2026-10-13T11:30:00.000Z';
	const stale = '2026-10-13T10:30:00.000Z';
	const run = async (events, extra = {}) => auditBilling({
		collections: { events: rows(events), purchases: rows([]), users: { ...rows([]), findOne: async () => null } },
		stripe: {}, environment, referenceKey, now, ...extra,
	});
	const failed = (eventId, lastError, receivedAt) => ({ eventId, state: 'failed', lastError, receivedAt });

	const pending = await run([failed('evt_a', 'lease_held', fresh), failed('evt_b', 'stripe_unavailable', '2026-10-13T11:45:00.000Z')]);
	assert.deepEqual(pending.alerts, []);
	assert.deepEqual(pending.pending, [{ kind: 'webhook_retry_pending', count: 2, oldestAgeSeconds: 1800 }]);

	const old = await run([failed('evt_a', 'lease_held', stale)]);
	assert.deepEqual(old.alerts.map((a) => [a.kind, a.detail]), [['webhook_failed', 'lease_held']]);
	assert.deepEqual(old.pending, []);

	for (const code of ['processing_error', 'stripe_rejected']) {
		const result = await run([failed('evt_a', code, '2026-10-13T11:59:00.000Z')]);
		assert.deepEqual(result.alerts.map((a) => a.kind), ['webhook_failed']);
		assert.deepEqual(result.pending, []);
	}

	const quarantined = await run([{ eventId: 'evt_q', state: 'quarantined', lastError: 'lease_held', receivedAt: fresh }]);
	assert.deepEqual(quarantined.alerts.map((a) => a.kind), ['webhook_quarantined']);

	const injected = await run([failed('evt_a', 'lease_lost', fresh)], { retryPendingBoundSeconds: 60 });
	assert.deepEqual(injected.alerts.map((a) => a.kind), ['webhook_failed']);
});
