import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeMongoCollection } from './_fake-mongo.js';
import { BILLING_INDEXES } from '../api/_lib/billing-schema.js';
import {
	claimEventWithCollection,
	completeEventWithCollection,
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
	assert.equal(a.status, 'claimed');
	assert.equal(a.entry.state, 'processing');
	assert.equal(a.entry.attempts, 1);
	const held = await claimEventWithCollection(c, { key: entry._id, owner: 'worker-b', now: later(500), leaseMs: 1000 });
	assert.equal(held.status, 'held');
	const b = await claimEventWithCollection(c, { key: entry._id, owner: 'worker-b', now: later(1000), leaseMs: 1000 });
	assert.equal(b.status, 'claimed');
	assert.equal(b.entry.leaseOwner, 'worker-b');
	assert.equal(b.entry.attempts, 2);
});

test('failed is retriable, never complete; the budget ends in quarantine', async () => {
	const c = inbox();
	const { entry } = await recordEventWithCollection(c, { environment, event: event(), now: NOW });
	const key = entry._id;
	let t = 0;
	for (let i = 1; i <= 3; i++) {
		const claimed = await claimEventWithCollection(c, { key, owner: 'w', now: later((t += 10)), maxAttempts: 3 });
		assert.equal(claimed.status, 'claimed', `attempt ${i}`);
		const failed = await failEventWithCollection(c, { key, owner: 'w', errorCode: 'stripe_timeout', now: later(t), maxAttempts: 3 });
		assert.equal(failed.state, i < 3 ? 'failed' : 'quarantined');
	}
	const again = await claimEventWithCollection(c, { key, owner: 'w', now: later(t + 10), maxAttempts: 3 });
	assert.equal(again.status, 'quarantined');
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
	const r = await claimEventWithCollection(c, { key: entry._id, owner: 'w', now: NOW });
	assert.equal(r.status, 'completed');
});

test('a holder that dies on the last attempt is quarantined by the next claim, not stranded', async () => {
	const c = inbox();
	const { entry } = await recordEventWithCollection(c, { environment, event: event(), now: NOW });
	const key = entry._id;
	let t = 0;
	for (let i = 1; i <= 2; i++) {
		assert.equal((await claimEventWithCollection(c, { key, owner: 'w', now: later((t += 10)), leaseMs: 1000, maxAttempts: 2 })).status, 'claimed');
		if (i < 2) await failEventWithCollection(c, { key, owner: 'w', errorCode: 'stripe_timeout', now: later(t), maxAttempts: 2 });
	}
	// The last allowed attempt is held and its owner crashes: no fail call.
	assert.equal((await claimEventWithCollection(c, { key, owner: 'x', now: later(t + 500), maxAttempts: 2 })).status, 'held');
	const next = await claimEventWithCollection(c, { key, owner: 'x', now: later(t + 1000), maxAttempts: 2 });
	assert.equal(next.status, 'quarantined');
	const stored = c.docs.get(key);
	assert.equal(stored.state, 'quarantined');
	assert.equal(stored.leaseOwner, null);
	assert.equal(stored.leaseExpiresAt, null);
	assert.equal(stored.lastError, 'attempts_exhausted');
	assert.ok(stored.failedAt);
	for (const dt of [2000, 10_000_000]) {
		const r = await claimEventWithCollection(c, { key, owner: 'y', now: later(t + dt), maxAttempts: 2 });
		assert.equal(r.status, 'quarantined');
		assert.equal(c.docs.get(key).attempts, 2);
	}
});

test('a failed entry already at the budget is quarantined by claim', async () => {
	const c = inbox();
	const { entry } = await recordEventWithCollection(c, { environment, event: event(), now: NOW });
	const key = entry._id;
	// Reachable when the budget is lowered between deploys.
	await claimEventWithCollection(c, { key, owner: 'w', now: NOW, maxAttempts: 5 });
	await claimEventWithCollection(c, { key, owner: 'w', now: later(2_000_000), maxAttempts: 5 });
	await failEventWithCollection(c, { key, owner: 'w', errorCode: 'x', now: later(2_000_001), maxAttempts: 5 });
	assert.equal(c.docs.get(key).state, 'failed');
	const r = await claimEventWithCollection(c, { key, owner: 'w', now: later(2_000_002), maxAttempts: 2 });
	assert.equal(r.status, 'quarantined');
	assert.equal(c.docs.get(key).state, 'quarantined');
});

test('claiming an unknown entry says missing', async () => {
	const r = await claimEventWithCollection(inbox(), { key: 'nope', owner: 'w', now: NOW });
	assert.deepEqual(r, { status: 'missing', entry: null });
});

test('completeEvent: only the owner of a processing entry completes it, with an outcome code', async () => {
	const c = inbox();
	const { entry } = await recordEventWithCollection(c, { environment, event: event(), now: NOW });
	assert.equal(await completeEventWithCollection(c, { key: entry._id, owner: 'w1', outcome: 'no_change', now: NOW }), null);
	await claimEventWithCollection(c, { key: entry._id, owner: 'w1', now: NOW });
	assert.equal(await completeEventWithCollection(c, { key: entry._id, owner: 'w2', outcome: 'no_change', now: NOW }), null);
	const done = await completeEventWithCollection(c, { key: entry._id, owner: 'w1', outcome: 'no_change', now: later(5) });
	assert.equal(done.state, 'completed');
	assert.equal(done.outcome, 'no_change');
	assert.equal((await claimEventWithCollection(c, { key: entry._id, owner: 'w3', now: later(10) })).status, 'completed');
});
