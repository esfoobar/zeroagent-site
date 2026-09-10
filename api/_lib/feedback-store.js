/*
 * ZA-222 / esfoobar/zeroagent#363. Storage for feedback submissions, kept
 * behind save() and listRecent() so api/feedback.js's POST and token-gated
 * GET never touch the database directly.
 *
 * Backed by the Atlas cluster `zeroagent` (MONGODB_URI, MONGODB_DB), database
 * `zeroagent`, collection `feedback`. The client connect promise is cached at
 * module scope so a warm invocation reuses the same connection instead of
 * reconnecting on every call.
 */

import { MongoClient } from 'mongodb';

const COLLECTION = 'feedback';

let clientPromise;
let indexesReady;

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
	const collection = client.db(dbName).collection(COLLECTION);
	if (!indexesReady) {
		indexesReady = collection.createIndex({ createdAt: -1 });
	}
	await indexesReady;
	return collection;
}

export async function save(doc) {
	const collection = await getCollection();
	const { id, ...rest } = doc;
	await collection.insertOne({ _id: id, ...rest });
}

export async function listRecent(limit) {
	const collection = await getCollection();
	const docs = await collection
		.find({})
		.sort({ createdAt: -1 })
		.limit(limit)
		.toArray();
	return docs.map(({ _id, ...rest }) => ({ id: _id, ...rest }));
}
