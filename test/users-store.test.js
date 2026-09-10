// ZA-130 / esfoobar/zeroagent#229. The upsert semantics against a fake
// MongoDB collection: no Atlas connection, no MONGODB_URI needed. Mimics the
// mongodb 7.x driver, where findOneAndUpdate returns the document itself
// (not wrapped in { value }).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	upsertOnSignInWithCollection,
	getUserWithCollection,
	addPairedDeviceWithCollection,
	listPairedDevicesWithCollection,
	revokePairedDeviceWithCollection,
} from '../api/_lib/users-store.js';
import { trialEndsFrom } from '../api/_lib/entitlement.js';

function fakeCollection(seed = []) {
	const docs = new Map(seed.map((doc) => [doc._id, { ...doc }]));
	return {
		async findOneAndUpdate(filter, update, options) {
			assert.equal(options.returnDocument, 'after');
			let doc = docs.get(filter._id);
			if (!doc) {
				if (!options.upsert) return null;
				doc = { _id: filter._id, ...(update.$setOnInsert || {}) };
			}
			const deviceRevoke = update.$set && update.$set['pairedDevices.$.revokedAt'];
			if (deviceRevoke !== undefined) {
				const entry = (doc.pairedDevices || []).find((d) => d.deviceId === filter['pairedDevices.deviceId']);
				if (!entry) return null;
				entry.revokedAt = deviceRevoke;
			} else {
				Object.assign(doc, update.$set || {});
			}
			docs.set(filter._id, doc);
			return { ...doc };
		},
		async findOne(filter, options) {
			const doc = docs.get(filter._id);
			if (!doc) return null;
			if (options && options.projection && options.projection.pairedDevices) {
				return { pairedDevices: doc.pairedDevices };
			}
			return { ...doc };
		},
		async updateOne(filter, update) {
			const doc = docs.get(filter._id);
			if (!doc) return;
			if (update.$push && update.$push.pairedDevices) {
				doc.pairedDevices = [...(doc.pairedDevices || []), update.$push.pairedDevices];
			}
		},
	};
}

test('upsertOnSignInWithCollection creates a free account with a thirty-day trial on first sign-in', async () => {
	const now = new Date('2026-09-08T12:00:00.000Z');
	const collection = fakeCollection();
	const user = await upsertOnSignInWithCollection(collection, { githubId: 1234567, login: 'octocat', now });

	assert.deepEqual(user, {
		githubId: 1234567,
		login: 'octocat',
		plan: 'free',
		createdAt: now.toISOString(),
		trialEnds: trialEndsFrom(now),
		planUntil: null,
		pairedDevices: [],
	});
});

test('upsertOnSignInWithCollection on a returning user refreshes login without resetting plan or trialEnds', async () => {
	const collection = fakeCollection([
		{
			_id: 1234567,
			login: 'old-login',
			plan: 'premium',
			createdAt: '2026-01-01T00:00:00.000Z',
			trialEnds: '2026-01-31T00:00:00.000Z',
			planUntil: '2027-01-01T00:00:00.000Z',
			pairedDevices: [],
		},
	]);

	const secondSignIn = new Date('2026-09-08T12:00:00.000Z');
	const user = await upsertOnSignInWithCollection(collection, {
		githubId: 1234567,
		login: 'new-login',
		now: secondSignIn,
	});

	assert.equal(user.login, 'new-login');
	assert.equal(user.plan, 'premium');
	assert.equal(user.createdAt, '2026-01-01T00:00:00.000Z');
	assert.equal(user.trialEnds, '2026-01-31T00:00:00.000Z');
	assert.equal(user.planUntil, '2027-01-01T00:00:00.000Z');
});

test('upsertOnSignInWithCollection renaming on GitHub is reflected on the next sign-in', async () => {
	const collection = fakeCollection([
		{ _id: 42, login: 'first-name', plan: 'free', createdAt: 'x', trialEnds: 'y', planUntil: null, pairedDevices: [] },
	]);
	const user = await upsertOnSignInWithCollection(collection, { githubId: 42, login: 'renamed', now: new Date() });
	assert.equal(user.login, 'renamed');
});

test('getUserWithCollection returns null for an account that has never signed in', async () => {
	const collection = fakeCollection();
	const user = await getUserWithCollection(collection, 999);
	assert.equal(user, null);
});

test('getUserWithCollection normalizes _id back to githubId', async () => {
	const collection = fakeCollection([
		{ _id: 7, login: 'octocat', plan: 'platinum', createdAt: 'x', trialEnds: null, planUntil: null, pairedDevices: [] },
	]);
	const user = await getUserWithCollection(collection, 7);
	assert.equal(user.githubId, 7);
	assert.equal('_id' in user, false);
	assert.equal(user.plan, 'platinum');
});

// ZA-224 / esfoobar/zeroagent#365. pairedDevices: append, list, revoke.

test('addPairedDeviceWithCollection appends an entry with revokedAt null', async () => {
	const collection = fakeCollection([{ _id: 42, login: 'octocat', plan: 'free', pairedDevices: [] }]);
	const now = new Date('2026-09-08T21:00:00.000Z');
	const entry = await addPairedDeviceWithCollection(collection, {
		githubId: 42,
		deviceId: 'dev_abc',
		tokenHash: 'hash-of-device-token',
		name: "Jorge's iPhone",
		now,
	});
	assert.deepEqual(entry, { deviceId: 'dev_abc', tokenHash: 'hash-of-device-token', name: "Jorge's iPhone", createdAt: now.toISOString(), revokedAt: null });

	const user = await getUserWithCollection(collection, 42);
	assert.deepEqual(user.pairedDevices, [entry]);
});

test('listPairedDevicesWithCollection never returns the token hash', async () => {
	const collection = fakeCollection([
		{
			_id: 42,
			login: 'octocat',
			plan: 'free',
			pairedDevices: [{ deviceId: 'dev_abc', tokenHash: 'secret-hash', name: 'iPhone', createdAt: 'x', revokedAt: null }],
		},
	]);
	const devices = await listPairedDevicesWithCollection(collection, 42);
	assert.deepEqual(devices, [{ deviceId: 'dev_abc', name: 'iPhone', createdAt: 'x', revokedAt: null }]);
});

test('listPairedDevicesWithCollection returns null for an account that does not exist', async () => {
	const collection = fakeCollection();
	const devices = await listPairedDevicesWithCollection(collection, 999);
	assert.equal(devices, null);
});

test('revokePairedDeviceWithCollection sets revokedAt on the matching entry only', async () => {
	const collection = fakeCollection([
		{
			_id: 42,
			login: 'octocat',
			plan: 'free',
			pairedDevices: [
				{ deviceId: 'dev_abc', tokenHash: 'h1', name: 'iPhone', createdAt: 'x', revokedAt: null },
				{ deviceId: 'dev_xyz', tokenHash: 'h2', name: 'iPad', createdAt: 'x', revokedAt: null },
			],
		},
	]);
	const now = new Date('2026-09-08T21:10:00.000Z');
	const entry = await revokePairedDeviceWithCollection(collection, { githubId: 42, deviceId: 'dev_abc', now });
	assert.equal(entry.deviceId, 'dev_abc');
	assert.equal(entry.revokedAt, now.toISOString());
	assert.equal('tokenHash' in entry, false);

	const devices = await listPairedDevicesWithCollection(collection, 42);
	assert.equal(devices.find((d) => d.deviceId === 'dev_abc').revokedAt, now.toISOString());
	assert.equal(devices.find((d) => d.deviceId === 'dev_xyz').revokedAt, null);
});

test('revokePairedDeviceWithCollection returns null for a deviceId that does not exist', async () => {
	const collection = fakeCollection([{ _id: 42, login: 'octocat', plan: 'free', pairedDevices: [] }]);
	const entry = await revokePairedDeviceWithCollection(collection, { githubId: 42, deviceId: 'dev_nope', now: new Date() });
	assert.equal(entry, null);
});
