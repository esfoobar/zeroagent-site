/*
 * ZA-901 / esfoobar/zeroagent#1264. The shared connection for the billing
 * collections, same cached-promise shape as users-store.js, plus the
 * transaction helper the fenced commit uses. Everything that holds logic
 * (billing-inbox.js, billing-lease.js, billing-commit.js, billing-catalog.js,
 * billing-schema.js) takes collections as arguments, so tests inject fakes
 * and never reach this file.
 */

import { MongoClient } from 'mongodb';

export const BILLING_COLLECTIONS = Object.freeze({
	users: 'users',
	events: 'billingEvents',
	leases: 'billingLeases',
	catalog: 'billingCatalog',
	audit: 'billingAudit',
});

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

// Returns { collections: {users, events, leases, catalog, audit}, withTransaction }.
// withTransaction(fn) runs fn({ session }) in a MongoDB transaction; every
// collection call inside passes { session } through.
export async function getBillingStore() {
	const dbName = process.env.MONGODB_DB;
	if (!dbName) {
		throw new Error('MONGODB_DB is not set');
	}
	const client = await getClientPromise();
	const db = client.db(dbName);
	const collections = Object.fromEntries(
		Object.entries(BILLING_COLLECTIONS).map(([key, name]) => [key, db.collection(name)])
	);
	async function withTransaction(fn) {
		const session = client.startSession();
		try {
			let result;
			await session.withTransaction(async () => {
				result = await fn({ session });
			});
			return result;
		} finally {
			await session.endSession();
		}
	}
	return { collections, withTransaction };
}
