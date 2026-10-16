// ZA-224 / esfoobar/zeroagent#365. The pairingTokens single-use semantics
// against a fake in-memory collection: no Atlas connection needed. The
// atomic filter-and-set in claimPairingTokenWithCollection is exercised
// directly against a fake that only matches when the filter's usedAt/expiresAt
// conditions hold, the same guarantee MongoDB's own findOneAndUpdate gives.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	createPairingTokenWithCollection,
	claimPairingTokenWithCollection,
	getPairingTokenWithCollection,
	createReviewPairingTokenWithCollection,
	renewReviewPairingTokenWithCollection,
	revokeReviewPairingTokenWithCollection,
} from '../api/_lib/pairing-store.js';

function fakeCollection(seed = []) {
	const docs = new Map(seed.map((doc) => [doc._id, { ...doc }]));
	return {
		async insertOne(doc) {
			docs.set(doc._id, { ...doc });
		},
		async findOneAndUpdate(filter, update, options) {
			assert.equal(options.returnDocument, 'after');
			const doc = docs.get(filter._id);
			if (!doc) return null;
			if ('usedAt' in filter && doc.usedAt !== filter.usedAt) return null;
			if (filter.kind?.$ne && doc.kind === filter.kind.$ne) return null;
			if (filter.expiresAt && '$gt' in filter.expiresAt && !(doc.expiresAt > filter.expiresAt.$gt)) return null;
			Object.assign(doc, update.$set || {});
			docs.set(filter._id, doc);
			return { ...doc };
		},
		async findOne(filter) {
			const doc = docs.get(filter._id);
			if (filter.kind && doc?.kind !== filter.kind) return null;
			if (filter.githubId && doc?.githubId !== filter.githubId) return null;
			if ('revokedAt' in filter && doc?.revokedAt !== filter.revokedAt) return null;
			if (filter.expiresAt?.$gt && !(doc?.expiresAt > filter.expiresAt.$gt)) return null;
			return doc ? { ...doc } : null;
		},
		async updateOne(filter, update) {
			const doc = docs.get(filter._id);
			if (!doc || doc.kind !== filter.kind || doc.githubId !== filter.githubId || doc.revokedAt !== filter.revokedAt) return { modifiedCount: 0 };
			Object.assign(doc, update.$set);
			return { modifiedCount: 1 };
		},
	};
}

test('createPairingTokenWithCollection stores the hash, not any token', async () => {
	const collection = fakeCollection();
	const now = new Date('2026-09-08T21:00:00.000Z');
	const expiresAt = new Date('2026-09-08T21:05:00.000Z');
	await createPairingTokenWithCollection(collection, { tokenHash: 'abc123', githubId: 42, now, expiresAt });

	const doc = await getPairingTokenWithCollection(collection, 'abc123');
	assert.deepEqual(doc, {
		_id: 'abc123',
		githubId: 42,
		createdAt: now.toISOString(),
		expiresAt: expiresAt.toISOString(),
		usedAt: null,
	});
});

test('review token can be claimed repeatedly, renewed, then revoked', async () => {
	const oldId = process.env.ZEROAGENT_REVIEW_DEMO_GITHUB_ID;
	process.env.ZEROAGENT_REVIEW_DEMO_GITHUB_ID = '42';
	try {
		const collection = fakeCollection();
		const now = new Date('2026-09-08T21:00:00.000Z');
		const expiry = new Date('2026-12-07T21:00:00.000Z');
		await createReviewPairingTokenWithCollection(collection, { tokenHash: 'reviewhash', githubId: 42, now, expiresAt: expiry });
		const claim = { tokenHash: 'reviewhash', now: new Date('2026-10-01T00:00:00.000Z') };
		assert.ok(await claimPairingTokenWithCollection(collection, claim));
		assert.ok(await claimPairingTokenWithCollection(collection, claim));
		assert.equal((await getPairingTokenWithCollection(collection, 'reviewhash')).usedAt, undefined);
		assert.equal(await claimPairingTokenWithCollection(collection, { ...claim, now: expiry }), null);
		const renewed = new Date('2027-01-01T00:00:00.000Z');
		assert.equal((await renewReviewPairingTokenWithCollection(collection, { tokenHash: 'reviewhash', githubId: 42, now: claim.now, expiresAt: renewed })).modifiedCount, 1);
		assert.ok(await claimPairingTokenWithCollection(collection, { ...claim, now: expiry }));
		assert.equal((await revokeReviewPairingTokenWithCollection(collection, { tokenHash: 'reviewhash', githubId: 42, now: claim.now })).modifiedCount, 1);
		assert.equal(await claimPairingTokenWithCollection(collection, claim), null);
	} finally {
		if (oldId === undefined) delete process.env.ZEROAGENT_REVIEW_DEMO_GITHUB_ID;
		else process.env.ZEROAGENT_REVIEW_DEMO_GITHUB_ID = oldId;
	}
});

test('review token refuses any configured account other than its owner', async () => {
	const oldId = process.env.ZEROAGENT_REVIEW_DEMO_GITHUB_ID;
	process.env.ZEROAGENT_REVIEW_DEMO_GITHUB_ID = '99';
	try {
		const collection = fakeCollection();
		await createReviewPairingTokenWithCollection(collection, { tokenHash: 'reviewhash', githubId: 42, now: new Date('2026-09-08'), expiresAt: new Date('2027-01-01') });
		assert.equal(await claimPairingTokenWithCollection(collection, { tokenHash: 'reviewhash', now: new Date('2026-10-01') }), null);
	} finally {
		if (oldId === undefined) delete process.env.ZEROAGENT_REVIEW_DEMO_GITHUB_ID;
		else process.env.ZEROAGENT_REVIEW_DEMO_GITHUB_ID = oldId;
	}
});

test('claimPairingTokenWithCollection marks an unused, unexpired token used and returns it', async () => {
	const collection = fakeCollection();
	const now = new Date('2026-09-08T21:00:00.000Z');
	const expiresAt = new Date('2026-09-08T21:05:00.000Z');
	await createPairingTokenWithCollection(collection, { tokenHash: 'abc123', githubId: 42, now, expiresAt });

	const claimAt = new Date('2026-09-08T21:01:00.000Z');
	const claimed = await claimPairingTokenWithCollection(collection, { tokenHash: 'abc123', now: claimAt });
	assert.equal(claimed.githubId, 42);
	assert.equal(claimed.usedAt, claimAt.toISOString());
});

test('claimPairingTokenWithCollection refuses a second claim of the same token', async () => {
	const collection = fakeCollection();
	const now = new Date('2026-09-08T21:00:00.000Z');
	const expiresAt = new Date('2026-09-08T21:05:00.000Z');
	await createPairingTokenWithCollection(collection, { tokenHash: 'abc123', githubId: 42, now, expiresAt });

	const first = await claimPairingTokenWithCollection(collection, { tokenHash: 'abc123', now: new Date('2026-09-08T21:01:00.000Z') });
	assert.ok(first);
	const second = await claimPairingTokenWithCollection(collection, { tokenHash: 'abc123', now: new Date('2026-09-08T21:02:00.000Z') });
	assert.equal(second, null);
});

test('claimPairingTokenWithCollection refuses two concurrent claims: only one wins', async () => {
	const collection = fakeCollection();
	const now = new Date('2026-09-08T21:00:00.000Z');
	const expiresAt = new Date('2026-09-08T21:05:00.000Z');
	await createPairingTokenWithCollection(collection, { tokenHash: 'abc123', githubId: 42, now, expiresAt });

	const claimAt = new Date('2026-09-08T21:01:00.000Z');
	const [a, b] = await Promise.all([
		claimPairingTokenWithCollection(collection, { tokenHash: 'abc123', now: claimAt }),
		claimPairingTokenWithCollection(collection, { tokenHash: 'abc123', now: claimAt }),
	]);
	const winners = [a, b].filter(Boolean);
	assert.equal(winners.length, 1);
});

test('claimPairingTokenWithCollection refuses an expired token', async () => {
	const collection = fakeCollection();
	const now = new Date('2026-09-08T21:00:00.000Z');
	const expiresAt = new Date('2026-09-08T21:05:00.000Z');
	await createPairingTokenWithCollection(collection, { tokenHash: 'abc123', githubId: 42, now, expiresAt });

	const claimed = await claimPairingTokenWithCollection(collection, { tokenHash: 'abc123', now: new Date('2026-09-08T21:06:00.000Z') });
	assert.equal(claimed, null);
});

test('claimPairingTokenWithCollection refuses a token that was never minted', async () => {
	const collection = fakeCollection();
	const claimed = await claimPairingTokenWithCollection(collection, { tokenHash: 'nope', now: new Date() });
	assert.equal(claimed, null);
});
