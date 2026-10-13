import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditBilling } from '../api/_lib/billing-operations.js';

const now = new Date('2026-10-13T12:00:00.000Z');
const old = '2026-10-13T11:50:00.000Z';
const environment = { stripeAccountId: 'acct_test', environment: 'sandbox', livemode: false, productId: 'prod_test' };
const rows = (data) => ({ find: () => ({ toArray: async () => data }) });

test('audit reports lag, failed events, pending checkout and drift with redacted references', async () => {
	const collections = {
		events: rows([{ eventId: 'evt_private', stripeAccountId: 'acct_test', livemode: false, customerId: 'cus_private', state: 'failed', lastError: 'stripe_unavailable', receivedAt: old }]),
		purchases: rows([{ _id: 'acct_test:sandbox:42', state: 'open', sessionId: 'cs_private', customerId: 'cus_private', createdAt: old }]),
		users: { find: () => ({ toArray: async () => [{ _id: 42, billing: { stripeAccountId: 'acct_test', livemode: false, customerId: 'cus_private', subscriptionId: 'sub_old', status: 'active', paidThrough: '2026-10-01T00:00:00.000Z' } }] }), findOne: async () => ({ billing: { subscriptionId: 'sub_old' } }) },
	};
	const subscription = { id: 'sub_old', customer: 'cus_private', livemode: false, status: 'canceled', ended_at: 1790841600, items: { data: [{ price: { id: 'price_private', product: 'prod_test' } }] }, latest_invoice: null };
	const stripe = { checkout: { sessions: { retrieve: async () => ({ livemode: false, customer: 'cus_private', status: 'complete', subscription: 'sub_new' }) } }, subscriptions: { retrieve: async () => subscription }, invoices: { retrieve: async () => { throw Error('unexpected'); } } };
	const result = await auditBilling({ collections, stripe, environment, now });
	assert.deepEqual(result.alerts.map((a) => a.kind), ['webhook_failed', 'checkout_unprojected', 'projection_drift']);
	assert.equal(result.alerts[2].detail, 'replay_candidate_in_inbox');
	const serialized = JSON.stringify(result);
	for (const sensitive of ['evt_private', 'cus_private', 'cs_private', 'sub_old', 'sub_new', 'price_private', '42']) assert.ok(!serialized.includes(sensitive));
});

test('audit refuses wrong mode and does not write any collection', async () => {
	const deny = () => { throw Error('audit attempted a write'); };
	const collections = { events: rows([]), purchases: rows([{ _id: 'acct_test:sandbox:42', state: 'open', sessionId: 'cs_private', customerId: 'cus_private', createdAt: old }]), users: { ...rows([]), findOne: async () => null } };
	for (const collection of Object.values(collections)) for (const method of ['updateOne', 'findOneAndUpdate', 'insertOne', 'deleteOne', 'bulkWrite']) collection[method] = deny;
	const result = await auditBilling({ collections, environment, now, stripe: { checkout: { sessions: { retrieve: async () => ({ livemode: true }) } } } });
	assert.equal(result.alerts[0].kind, 'checkout_read_failure');
});

test('webhook failure logs use a short reference, not the event id', async () => {
	const source = (await import('node:fs')).readFileSync('api/_lib/billing-webhook.js', 'utf8');
	assert.match(source, /eventRef: sha256Hex\(event\.id\)\.slice\(0, 12\)/);
	assert.ok(!source.includes('log({ eventId:'));
});
