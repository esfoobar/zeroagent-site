/*
 * ZA-224 / esfoobar/zeroagent#365. Storage for the `pairingTokens`
 * collection: short-lived, single-use tokens the desktop mints
 * (POST /api/auth/pair) so a phone can claim its own long-lived device
 * token for the same account (POST /api/auth/pair/claim). Keyed by the
 * token's sha256 hash, never the token itself, same "hash, not the secret"
 * rule as `pairedDevices` (docs/DATABASE.md). Same cached-connection and
 * *WithCollection split as api/_lib/users-store.js, for the same reason:
 * test/pairing-store.test.js exercises the claim semantics, including the
 * single-use race, against a fake in-memory collection.
 */

import { MongoClient } from 'mongodb';

const COLLECTION = 'pairingTokens';

let clientPromise;

function getClientPromise() {
	if (!clientPromise) {
		const uri = process.env.MONGODB_URI;
		if (!uri) {
			throw new Error('MONGODB_URI is not set');
		}
		clientPromise = new MongoClient(uri).connect();
	}
	return clientPromise;
}

async function getCollection() {
	const dbName = process.env.MONGODB_DB;
	if (!dbName) {
		throw new Error('MONGODB_DB is not set');
	}
	const client = await getClientPromise();
	return client.db(dbName).collection(COLLECTION);
}

export async function createPairingTokenWithCollection(collection, { tokenHash, githubId, now, expiresAt }) {
	await collection.insertOne({
		_id: tokenHash,
		githubId,
		createdAt: now.toISOString(),
		expiresAt: expiresAt.toISOString(),
		usedAt: null,
	});
}

// The one place single use is actually enforced: filter and set run as one
// atomic operation, so two concurrent claims of the same token cannot both
// match. The loser gets null back, never a second device token.
export async function claimPairingTokenWithCollection(collection, { tokenHash, now }) {
	const result = await collection.findOneAndUpdate(
		{ _id: tokenHash, usedAt: null, expiresAt: { $gt: now.toISOString() } },
		{ $set: { usedAt: now.toISOString() } },
		{ returnDocument: 'after' }
	);
	return result && 'value' in result ? result.value : result;
}

// Read-only, used only to pick an error code (invalid vs. expired vs.
// already used) after claimPairingTokenWithCollection has already refused.
export async function getPairingTokenWithCollection(collection, tokenHash) {
	return collection.findOne({ _id: tokenHash });
}

export async function createPairingToken(args) {
	const collection = await getCollection();
	return createPairingTokenWithCollection(collection, args);
}

export async function claimPairingToken(args) {
	const collection = await getCollection();
	return claimPairingTokenWithCollection(collection, args);
}

export async function getPairingToken(tokenHash) {
	const collection = await getCollection();
	return getPairingTokenWithCollection(collection, tokenHash);
}
