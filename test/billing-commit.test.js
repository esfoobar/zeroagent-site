// ZA-901. The fenced customer lease and the commit that depends on it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeBillingDb } from './_fake-mongo.js';
import { BILLING_INDEXES } from '../api/_lib/billing-schema.js';
import { acquireLeaseWithCollection, customerLeaseKey, releaseLeaseWithCollection, renewLeaseWithCollection } from '../api/_lib/billing-lease.js';
import { claimEventWithCollection, recordEventWithCollection } from '../api/_lib/billing-inbox.js';
import {
	AccountNotFoundError,
	EventNotOwnedError,
	LeaseLostError,
	LegacyGrantConflictError,
	commitProjection,
	planFieldsFor,
} from '../api/_lib/billing-commit.js';
import { BillingModeMismatchError } from '../api/_lib/billing-config.js';

const environment = { stripeAccountId: 'acct_synthetic', livemode: false, environment: 'sandbox' };
const NOW = new Date('2026-11-01T00:00:00.000Z');
const at = (ms) => new Date(NOW.getTime() + ms);
const key = customerLeaseKey({ stripeAccountId: 'acct_synthetic', livemode: false, customerId: 'cus_synthetic' });

function setup({ user } = {}) {
	const db = fakeBillingDb();
	for (const name of ['users', 'events']) {
		for (const { key: k, options } of BILLING_INDEXES[name]) db.collections[name].createIndex(k, options);
	}
	db.collections.users.docs.set(1001, {
		_id: 1001,
		login: 'synthetic',
		plan: 'free',
		planUntil: null,
		trialEnds: '2026-11-20T00:00:00.000Z',
		createdAt: '2026-10-21T00:00:00.000Z',
		pairedDevices: [{ deviceId: 'dev_1', tokenHash: 'h', name: 'Phone', createdAt: '2026-10-22T00:00:00.000Z', revokedAt: null }],
		...user,
	});
	return db;
}

async function claimed(db, id = 'evt_1') {
	const { entry } = await recordEventWithCollection(db.collections.events, {
		environment,
		event: { id, type: 'invoice.paid', created: 1, livemode: false, data: { object: { id: 'in_1', customer: 'cus_synthetic' } } },
		now: NOW,
	});
	await claimEventWithCollection(db.collections.events, { key: entry._id, owner: 'w1', now: NOW });
	return entry._id;
}

const PATCH = {
	customerId: 'cus_synthetic',
	subscriptionId: 'sub_synthetic_1',
	priceId: 'price_arbitrary_9',
	status: 'active',
	currentPeriodStart: '2026-11-01T00:00:00.000Z',
	currentPeriodEnd: '2026-12-01T00:00:00.000Z',
	paidThrough: '2026-12-01T00:00:00.000Z',
	cancelAtPeriodEnd: false,
	cancelAt: null,
	endedAt: null,
	paymentGraceUntil: null,
	lastPaidInvoiceId: 'in_1',
};

function deps(db) {
	return { collections: db.collections, withTransaction: db.withTransaction };
}

test('lease: one holder at a time, fence only increases', async () => {
	const { leases } = setup().collections;
	const a = await acquireLeaseWithCollection(leases, { key, owner: 'a', now: NOW, ttlMs: 1000 });
	assert.equal(a.fence, 1);
	assert.equal(await acquireLeaseWithCollection(leases, { key, owner: 'b', now: at(999), ttlMs: 1000 }), null);
	const b = await acquireLeaseWithCollection(leases, { key, owner: 'b', now: at(1000), ttlMs: 1000 });
	assert.equal(b.fence, 2);
	await releaseLeaseWithCollection(leases, { lease: b });
	const c = await acquireLeaseWithCollection(leases, { key, owner: 'c', now: at(1001), ttlMs: 1000 });
	assert.equal(c.fence, 3);
});

test('lease: a different customer or mode has its own lease', async () => {
	const { leases } = setup().collections;
	await acquireLeaseWithCollection(leases, { key, owner: 'a', now: NOW });
	const other = customerLeaseKey({ stripeAccountId: 'acct_synthetic', livemode: true, customerId: 'cus_synthetic' });
	assert.ok(await acquireLeaseWithCollection(leases, { key: other, owner: 'a', now: NOW }));
});

test('lease: renew works while held and fails once lost', async () => {
	const { leases } = setup().collections;
	const a = await acquireLeaseWithCollection(leases, { key, owner: 'a', now: NOW, ttlMs: 1000 });
	assert.ok(await renewLeaseWithCollection(leases, { lease: a, now: at(500), ttlMs: 1000 }));
	await acquireLeaseWithCollection(leases, { key, owner: 'b', now: at(2000), ttlMs: 1000 });
	assert.equal(await renewLeaseWithCollection(leases, { lease: a, now: at(2001), ttlMs: 1000 }), null);
});

test('commit writes the projection, derived plan fields and completes the event', async () => {
	const db = setup();
	const lease = await acquireLeaseWithCollection(db.collections.leases, { key, owner: 'w1', now: NOW });
	const eventKey = await claimed(db);
	const result = await commitProjection(deps(db), { environment, lease, githubId: 1001, patch: PATCH, eventKey, owner: 'w1', now: at(10) });
	const user = db.collections.users.docs.get(1001);
	assert.equal(user.plan, 'premium');
	assert.equal(user.planUntil, '2026-12-01T00:00:00.000Z');
	assert.equal(user.entitlementSource, 'stripe');
	assert.equal(user.billing.revision, 1);
	assert.equal(user.billing.fence, lease.fence);
	assert.equal(user.billing.livemode, false);
	assert.equal(result.plan, 'premium');
	assert.equal(db.collections.events.docs.get(eventKey).state, 'completed');
	// existing fields untouched
	assert.equal(user.trialEnds, '2026-11-20T00:00:00.000Z');
	assert.equal(user.createdAt, '2026-10-21T00:00:00.000Z');
	assert.equal(user.pairedDevices.length, 1);
	assert.equal(user.pairedDevices[0].tokenHash, 'h');
});

test('a lease lost during a slow call cannot commit, and nothing is written', async () => {
	const db = setup();
	const slow = await acquireLeaseWithCollection(db.collections.leases, { key, owner: 'w1', now: NOW, ttlMs: 1000 });
	const eventKey = await claimed(db);
	// The slow Stripe call outlives the lease; another worker takes it.
	await acquireLeaseWithCollection(db.collections.leases, { key, owner: 'w2', now: at(1500), ttlMs: 1000 });
	const before = JSON.stringify([...db.collections.users.docs]);
	await assert.rejects(
		commitProjection(deps(db), { environment, lease: slow, githubId: 1001, patch: PATCH, eventKey, owner: 'w1', now: at(2000) }),
		LeaseLostError
	);
	assert.equal(JSON.stringify([...db.collections.users.docs]), before);
	assert.equal(db.collections.events.docs.get(eventKey).state, 'processing');
});

test('an expired lease nobody else took also cannot commit', async () => {
	const db = setup();
	const lease = await acquireLeaseWithCollection(db.collections.leases, { key, owner: 'w1', now: NOW, ttlMs: 1000 });
	const eventKey = await claimed(db);
	await assert.rejects(
		commitProjection(deps(db), { environment, lease, githubId: 1001, patch: PATCH, eventKey, owner: 'w1', now: at(1000) }),
		LeaseLostError
	);
});

test('a stale fence cannot overwrite a newer committed projection', async () => {
	const db = setup();
	const old = await acquireLeaseWithCollection(db.collections.leases, { key, owner: 'w1', now: NOW, ttlMs: 1000 });
	const newer = await acquireLeaseWithCollection(db.collections.leases, { key, owner: 'w2', now: at(1000), ttlMs: 1000 });
	const e2 = await claimed(db, 'evt_2');
	await commitProjection(deps(db), { environment, lease: newer, githubId: 1001, patch: PATCH, eventKey: e2, owner: 'w1', now: at(1100) });
	// Simulate the lease document being rewound so only the fence guard remains.
	db.collections.leases.docs.set(key, { _id: key, owner: 'w1', fence: old.fence, expiresAt: at(5000).toISOString() });
	const e3 = await claimed(db, 'evt_3');
	await assert.rejects(
		commitProjection(deps(db), { environment, lease: old, githubId: 1001, patch: { ...PATCH, status: 'ended' }, eventKey: e3, owner: 'w1', now: at(1200) }),
		LeaseLostError
	);
	assert.equal(db.collections.users.docs.get(1001).billing.status, 'active');
});

test('the inbox entry must be held by the committing owner', async () => {
	const db = setup();
	const lease = await acquireLeaseWithCollection(db.collections.leases, { key, owner: 'w1', now: NOW });
	const eventKey = await claimed(db);
	await assert.rejects(
		commitProjection(deps(db), { environment, lease, githubId: 1001, patch: PATCH, eventKey, owner: 'someone-else', now: at(10) }),
		EventNotOwnedError
	);
	assert.equal(db.collections.users.docs.get(1001).billing, undefined, 'rolled back');
});

test('unknown account, legacy grants and mode mismatch are refused', async () => {
	let db = setup();
	let lease = await acquireLeaseWithCollection(db.collections.leases, { key, owner: 'w1', now: NOW });
	let eventKey = await claimed(db);
	await assert.rejects(commitProjection(deps(db), { environment, lease, githubId: 9, patch: PATCH, eventKey, owner: 'w1', now: at(1) }), AccountNotFoundError);

	for (const user of [{ plan: 'premium', planUntil: null }, { plan: 'premium', entitlementSource: 'legacy_grant', legacyGrant: { until: null, openEnded: true } }]) {
		db = setup({ user });
		lease = await acquireLeaseWithCollection(db.collections.leases, { key, owner: 'w1', now: NOW });
		eventKey = await claimed(db);
		await assert.rejects(commitProjection(deps(db), { environment, lease, githubId: 1001, patch: PATCH, eventKey, owner: 'w1', now: at(1) }), LegacyGrantConflictError);
		await commitProjection(deps(db), { environment, lease, githubId: 1001, patch: PATCH, eventKey, owner: 'w1', now: at(1), acknowledgeLegacy: true });
	}

	db = setup({ user: { billing: { provider: 'stripe', livemode: true, stripeAccountId: 'acct_synthetic', revision: 1 }, entitlementSource: 'stripe' } });
	lease = await acquireLeaseWithCollection(db.collections.leases, { key, owner: 'w1', now: NOW });
	eventKey = await claimed(db);
	await assert.rejects(commitProjection(deps(db), { environment, lease, githubId: 1001, patch: PATCH, eventKey, owner: 'w1', now: at(1) }), BillingModeMismatchError);
});

test('a customer id cannot be bound to two accounts in one environment', async () => {
	const db = setup();
	db.collections.users.docs.set(1002, { _id: 1002, login: 'other', plan: 'free', trialEnds: null, pairedDevices: [] });
	const lease = await acquireLeaseWithCollection(db.collections.leases, { key, owner: 'w1', now: NOW });
	const e1 = await claimed(db, 'evt_a');
	await commitProjection(deps(db), { environment, lease, githubId: 1001, patch: PATCH, eventKey: e1, owner: 'w1', now: at(1) });
	const e2 = await claimed(db, 'evt_b');
	await assert.rejects(
		commitProjection(deps(db), { environment, lease, githubId: 1002, patch: { ...PATCH, subscriptionId: 'sub_other' }, eventKey: e2, owner: 'w1', now: at(2) }),
		/duplicate key/
	);
	assert.equal(db.collections.users.docs.get(1002).billing, undefined);
});

test('planFieldsFor matches the stored plan fields of every fixture account', async () => {
	const { readFileSync } = await import('node:fs');
	const fixtures = JSON.parse(readFileSync(new URL('./billing-entitlement.fixtures.json', import.meta.url), 'utf8'));
	for (const c of fixtures.cases) {
		if (!c.account.billing) continue;
		const f = planFieldsFor(c.account.billing);
		assert.equal(f.plan, c.account.plan, c.id);
		assert.equal(f.planUntil, c.account.planUntil, c.id);
	}
});
