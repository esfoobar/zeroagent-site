import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeMongoCollection } from './_fake-mongo.js';
import { BILLING_INDEXES } from '../api/_lib/billing-schema.js';
import {
	claimEventWithCollection,
	failEventWithCollection,
	inboxKey,
	quarantineEventWithCollection,
	recordEventWithCollection,
} from '../api/_lib/billing-inbox.js';

const environment = { stripeAccountId: 'acct_synthetic', livemode: false, environment: 'sandbox' };
const NOW = new Date('2026-11-01T00:00:00.000Z');
const later = (ms) => new Date(NOW.getTime() + ms);

function event(over = {}) {
	return {
		id: 'evt_synthetic_1',
		type: 'invoice.paid',
		created: 1790000000,
		livemode: false,
		data: { object: { id: 'in_synthetic', customer: 'cus_synthetic', card: { number: 'never stored' }, hosted_invoice_url: 'https://never.stored' } },
		...over,
	};
}

function inbox() {
	const c = fakeMongoCollection('events');
	for (const { key, options } of BILLING_INDEXES.events) c.createIndex(key, options);
	return c;
}

test('key is scoped by account, mode and event id', () => {
	const a = inboxKey({ stripeAccountId: 'acct_a', livemode: false, eventId: 'evt_1' });
	assert.notEqual(a, inboxKey({ stripeAccountId: 'acct_a', livemode: true, eventId: 'evt_1' }));
	assert.notEqual(a, inboxKey({ stripeAccountId: 'acct_b', livemode: false, eventId: 'evt_1' }));
	assert.throws(() => inboxKey({ stripeAccountId: 'acct_a', livemode: undefined, eventId: 'evt_1' }));
});

test('records an event once and keeps only minimal identifiers', async () => {
	const c = inbox();
	const first = await recordEventWithCollection(c, { environment, event: event(), now: NOW });
	assert.equal(first.created, true);
	const second = await recordEventWithCollection(c, { environment, event: event(), now: later(1000) });
	assert.equal(second.created, false);
	assert.equal(c.docs.size, 1);
	const stored = JSON.stringify([...c.docs.values()][0]);
	assert.ok(!stored.includes('never stored'));
	assert.ok(!stored.includes('never.stored'));
	assert.equal(first.entry.state, 'received');
	assert.equal(first.entry.customerId, 'cus_synthetic');
});

test('the same event id in the other mode is a different entry', async () => {
	const c = inbox();
	await recordEventWithCollection(c, { environment, event: event(), now: NOW });
	const live = { ...environment, livemode: true, environment: 'live' };
	const r = await recordEventWithCollection(c, { environment: live, event: event({ livemode: true }), now: NOW });
	assert.equal(r.created, true);
	assert.equal(c.docs.size, 2);
});

test('claim: only one concurrent claimant wins, attempts count, lease expires', async () => {
	const c = inbox();
	const { entry } = await recordEventWithCollection(c, { environment, event: event(), now: NOW });
	const a = await claimEventWithCollection(c, { key: entry._id, owner: 'worker-a', now: NOW, leaseMs: 1000 });
	assert.equal(a.state, 'processing');
	assert.equal(a.attempts, 1);
	assert.equal(await claimEventWithCollection(c, { key: entry._id, owner: 'worker-b', now: later(500), leaseMs: 1000 }), null);
	const b = await claimEventWithCollection(c, { key: entry._id, owner: 'worker-b', now: later(1000), leaseMs: 1000 });
	assert.equal(b.leaseOwner, 'worker-b');
	assert.equal(b.attempts, 2);
});

test('failed is retriable, never complete; the budget ends in quarantine', async () => {
	const c = inbox();
	const { entry } = await recordEventWithCollection(c, { environment, event: event(), now: NOW });
	const key = entry._id;
	let t = 0;
	for (let i = 1; i <= 3; i++) {
		const claimed = await claimEventWithCollection(c, { key, owner: 'w', now: later((t += 10)), maxAttempts: 3 });
		assert.ok(claimed, `attempt ${i}`);
		const failed = await failEventWithCollection(c, { key, owner: 'w', errorCode: 'stripe_timeout', now: later(t), maxAttempts: 3 });
		assert.equal(failed.state, i < 3 ? 'failed' : 'quarantined');
	}
	assert.equal(await claimEventWithCollection(c, { key, owner: 'w', now: later(t + 10), maxAttempts: 3 }), null);
	assert.equal(c.docs.get(key).state, 'quarantined');
});

test('only the owner can fail or quarantine an entry', async () => {
	const c = inbox();
	const { entry } = await recordEventWithCollection(c, { environment, event: event(), now: NOW });
	await claimEventWithCollection(c, { key: entry._id, owner: 'w1', now: NOW });
	assert.equal(await failEventWithCollection(c, { key: entry._id, owner: 'w2', errorCode: 'x' }), null);
	assert.equal(await quarantineEventWithCollection(c, { key: entry._id, owner: 'w2', reason: 'x' }), null);
	const q = await quarantineEventWithCollection(c, { key: entry._id, owner: 'w1', reason: 'unmapped_customer' });
	assert.equal(q.state, 'quarantined');
	assert.equal(q.lastError, 'unmapped_customer');
});

test('a completed entry cannot be claimed again', async () => {
	const c = inbox();
	const { entry } = await recordEventWithCollection(c, { environment, event: event(), now: NOW });
	c.docs.get(entry._id).state = 'completed';
	assert.equal(await claimEventWithCollection(c, { key: entry._id, owner: 'w', now: NOW }), null);
});
