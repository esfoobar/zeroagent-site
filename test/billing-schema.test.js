import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fakeMongoCollection } from './_fake-mongo.js';
import { fakeBillingDb } from './_fake-mongo.js';
import { BILLING_INDEXES, ensureBillingIndexes, inventoryLegacyGrants, runBillingMigration } from '../api/_lib/billing-schema.js';
import { BILLING_ENV_VARS } from '../api/_lib/billing-config.js';

const NOW = new Date('2026-11-01T00:00:00.000Z');

function seededUsers() {
	const db = fakeBillingDb();
	const rows = [
		{ _id: 1, login: 'trial', plan: 'free', planUntil: null, trialEnds: '2026-11-20T00:00:00.000Z', createdAt: '2026-10-21T00:00:00.000Z', pairedDevices: [{ deviceId: 'd1', tokenHash: 'h1', name: 'Phone', createdAt: 'x', revokedAt: null }] },
		{ _id: 2, login: 'open', plan: 'premium', planUntil: null, trialEnds: '2026-10-01T00:00:00.000Z', createdAt: 'x', pairedDevices: [] },
		{ _id: 3, login: 'dated', plan: 'premium', planUntil: '2027-03-01T00:00:00.000Z', trialEnds: '2026-10-01T00:00:00.000Z', createdAt: 'x', pairedDevices: [] },
		{ _id: 4, login: 'lapsed', plan: 'platinum', planUntil: '2026-06-01T00:00:00.000Z', trialEnds: '2026-10-01T00:00:00.000Z', createdAt: 'x', pairedDevices: [] },
		{ _id: 5, login: 'paid', plan: 'premium', planUntil: '2026-12-01T00:00:00.000Z', billing: { provider: 'stripe', status: 'active' }, entitlementSource: 'stripe', pairedDevices: [] },
		{ _id: 6, login: 'marked', plan: 'premium', planUntil: null, entitlementSource: 'legacy_grant', legacyGrant: { until: null, openEnded: true }, pairedDevices: [] },
	];
	for (const r of rows) db.collections.users.docs.set(r._id, r);
	return db;
}

test('migration is idempotent: a second run changes nothing', async () => {
	const { collections } = fakeBillingDb();
	const first = await ensureBillingIndexes(collections);
	const snapshot = JSON.stringify(Object.values(collections).map((c) => c.indexes));
	const second = await ensureBillingIndexes(collections);
	assert.deepEqual(second, first);
	assert.equal(JSON.stringify(Object.values(collections).map((c) => c.indexes)), snapshot);
});

test('migration writes nothing to existing users and preserves trials, plans and devices', async () => {
	const db = seededUsers();
	const before = JSON.stringify([...db.collections.users.docs]);
	const writesBefore = db.collections.users.calls.writes;
	const report = await runBillingMigration({ collections: db.collections, now: NOW });
	await runBillingMigration({ collections: db.collections, now: NOW });
	assert.equal(JSON.stringify([...db.collections.users.docs]), before);
	assert.equal(db.collections.users.calls.writes, writesBefore);
	assert.equal(report.legacyGrants, 3);
	assert.deepEqual(report.summary, { owner_decision_open_ended: 1, mark_dated: 1, owner_decision_lapsed: 1 });
});

test('the inventory carries no customer data', async () => {
	const rows = await inventoryLegacyGrants(seededUsers().collections.users, NOW);
	for (const row of rows) {
		assert.deepEqual(Object.keys(row).sort(), ['disposition', 'plan', 'planUntil', 'ref']);
		assert.match(row.ref, /^[0-9a-f]{12}$/);
	}
	const text = JSON.stringify(rows);
	for (const leaked of ['"open"', '"dated"', '"lapsed"', 'trial']) assert.ok(!text.includes(leaked), leaked);
});

test('dry run creates no index', async () => {
	const db = seededUsers();
	const report = await runBillingMigration({ collections: db.collections, now: NOW, dryRun: true });
	assert.deepEqual(report.indexes, []);
	for (const c of Object.values(db.collections)) assert.equal(c.indexes.length, 0);
});

test('unique partial indexes ignore accounts with no Stripe ids and scope by environment', async () => {
	const users = fakeMongoCollection('users');
	for (const { key, options } of BILLING_INDEXES.users) await users.createIndex(key, options);
	// Many accounts without billing never collide.
	for (let i = 1; i <= 5; i++) await users.insertOne({ _id: i, plan: 'free' });
	const b = (over) => ({ provider: 'stripe', stripeAccountId: 'acct_synthetic', livemode: false, customerId: 'cus_1', subscriptionId: 'sub_1', ...over });
	await users.insertOne({ _id: 10, billing: b({}) });
	await assert.rejects(users.insertOne({ _id: 11, billing: b({ subscriptionId: 'sub_2' }) }), /duplicate key/);
	await assert.rejects(users.insertOne({ _id: 12, billing: b({ customerId: 'cus_2' }) }), /duplicate key/);
	// The same ids in the other mode, or another account, are a different scope.
	await users.insertOne({ _id: 13, billing: b({ livemode: true }) });
	await users.insertOne({ _id: 14, billing: b({ stripeAccountId: 'acct_other' }) });
	// Incomplete records with null ids do not collide.
	await users.insertOne({ _id: 15, billing: b({ customerId: 'cus_9', subscriptionId: null }) });
	await users.insertOne({ _id: 16, billing: b({ customerId: 'cus_8', subscriptionId: null }) });
});

test('the event inbox index is unique on account, mode and event id', () => {
	const spec = BILLING_INDEXES.events.find((i) => i.options.unique);
	assert.deepEqual(Object.keys(spec.key), ['stripeAccountId', 'livemode', 'eventId']);
});

test('the manifest names exactly the variables the code reads, and holds no secret or price', () => {
	const manifest = JSON.parse(readFileSync('docs/stripe-setup.manifest.json', 'utf8'));
	assert.deepEqual(Object.keys(manifest.variables).sort(), Object.values(BILLING_ENV_VARS).sort());
	const text = JSON.stringify(manifest);
	assert.ok(!/\b(?:price|prod|sub|cus|acct|whsec|evt)_[A-Za-z0-9]{8,}/.test(text), 'no Stripe object id');
	assert.ok(!/\b(?:sk|rk|pk)_(?:live|test)_/.test(text), 'no key');
	assert.ok(!/\b\d+\s?(?:USD|usd|dollars?)\b|\$\s?\d/.test(text), 'no amount');
	assert.equal(manifest.objects.price.idVariable, null);
});

function walk(dir, out = []) {
	for (const name of readdirSync(dir)) {
		if (name === 'node_modules' || name === '.git' || name === 'test' || name === 'docs' || name === '.zeroagent') continue;
		const path = join(dir, name);
		if (statSync(path).isDirectory()) walk(path, out);
		else if (/\.(?:js|mjs|html|json|css)$/.test(name) && name !== 'package-lock.json') out.push(path);
	}
	return out;
}

test('no Price id, amount or key literal is a constant in code or pages', () => {
	const offenders = [];
	for (const file of walk('.')) {
		const text = readFileSync(file, 'utf8');
		if (/\bprice_[A-Za-z0-9]{14,}\b/.test(text)) offenders.push([file, 'price id']);
		if (/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{6,}/.test(text)) offenders.push([file, 'key']);
		if (/\bwhsec_[A-Za-z0-9]{6,}/.test(text)) offenders.push([file, 'signing secret']);
		if (/unit_amount\s*[:=]\s*\d/.test(text)) offenders.push([file, 'amount']);
	}
	assert.deepEqual(offenders, []);
});
