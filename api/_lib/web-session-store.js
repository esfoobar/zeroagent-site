/*
 * ZA-900 / esfoobar/zeroagent#1263. Storage for the browser sign-in:
 * `webAuthStates` (one short-lived, single-use record per OAuth attempt) and
 * `webSessions` (one record per signed-in browser). Both are keyed by the
 * sha256 hash of the random value the browser holds, never the value itself,
 * same "hash, not the secret" rule as pairingTokens and pairedDevices.
 *
 * Same cached-connection and *WithCollection split as users-store.js, so
 * test/web-session-store.test.js runs the single-use, expiry and revocation
 * rules against a fake in-memory collection.
 *
 * Expired and revoked documents are ignored by every read here. A TTL index
 * on `purgeAt` (expireAfterSeconds: 0) on both collections lets MongoDB
 * delete them; see docs/DATABASE.md in the zeroagent repo.
 */

import { MongoClient } from 'mongodb';

const STATES = 'webAuthStates';
const SESSIONS = 'webSessions';

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

async function getCollection(name) {
	const dbName = process.env.MONGODB_DB;
	if (!dbName) {
		throw new Error('MONGODB_DB is not set');
	}
	const client = await getClientPromise();
	return client.db(dbName).collection(name);
}

function unwrap(result) {
	return result && 'value' in result ? result.value : result;
}

export async function createAuthStateWithCollection(collection, { stateHash, codeVerifier, returnPath, now, expiresAt }) {
	await collection.insertOne({
		_id: stateHash,
		codeVerifier,
		returnPath,
		createdAt: now.toISOString(),
		expiresAt: expiresAt.toISOString(),
		purgeAt: expiresAt,
		usedAt: null,
	});
}

// The one place single use is enforced: filter and set are one atomic
// operation, so a replayed or concurrent callback gets null, never the
// verifier a second time.
export async function consumeAuthStateWithCollection(collection, { stateHash, now }) {
	const result = await collection.findOneAndUpdate(
		{ _id: stateHash, usedAt: null, expiresAt: { $gt: now.toISOString() } },
		{ $set: { usedAt: now.toISOString() } },
		{ returnDocument: 'before' }
	);
	return unwrap(result) || null;
}

export async function createSessionWithCollection(collection, { tokenHash, githubId, login, now, expiresAt }) {
	await collection.insertOne({
		_id: tokenHash,
		githubId,
		login,
		createdAt: now.toISOString(),
		authTime: now.toISOString(),
		expiresAt: expiresAt.toISOString(),
		purgeAt: expiresAt,
		revokedAt: null,
	});
}

export async function getActiveSessionWithCollection(collection, { tokenHash, now }) {
	const doc = await collection.findOne({
		_id: tokenHash,
		revokedAt: null,
		expiresAt: { $gt: now.toISOString() },
	});
	return doc || null;
}

export async function revokeSessionWithCollection(collection, { tokenHash, now }) {
	await collection.updateOne({ _id: tokenHash, revokedAt: null }, { $set: { revokedAt: now.toISOString() } });
}

export async function createAuthState(args) {
	return createAuthStateWithCollection(await getCollection(STATES), args);
}

export async function consumeAuthState(args) {
	return consumeAuthStateWithCollection(await getCollection(STATES), args);
}

export async function createSession(args) {
	return createSessionWithCollection(await getCollection(SESSIONS), args);
}

export async function getActiveSession(args) {
	return getActiveSessionWithCollection(await getCollection(SESSIONS), args);
}

export async function revokeSession(args) {
	return revokeSessionWithCollection(await getCollection(SESSIONS), args);
}
