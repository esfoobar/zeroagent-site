/*
 * ZA-901 / esfoobar/zeroagent#1264. The per-customer lease with a fencing
 * token. Reconciliation for one customer is serialized by this lease; the
 * fence is what makes a slow call safe: a holder whose lease lapsed during
 * a slow Stripe retrieval carries an old fence, and the commit
 * (billing-commit.js) refuses it.
 *
 * The lease document is never deleted. Its `fence` only ever increases, so
 * a token can never be reissued. Release clears the owner and expires the
 * lease; acquisition increments the fence atomically with taking it.
 */

import { isDuplicateKeyError } from './mongo-errors.js';

export const LEASE_DEFAULTS = Object.freeze({ ttlMs: 30_000 });

const NEVER = '1970-01-01T00:00:00.000Z';

export function customerLeaseKey({ stripeAccountId, livemode, customerId }) {
	if (!stripeAccountId || typeof livemode !== 'boolean' || !customerId) {
		throw new Error('lease key needs stripeAccountId, livemode and customerId');
	}
	return `${stripeAccountId}:${livemode ? 'live' : 'test'}:${customerId}`;
}

function unwrap(result) {
	return result && 'value' in result ? result.value : result;
}

// Returns { key, owner, fence, expiresAt } or null when another holder's
// lease is still live. A duplicate-key error from the upsert is that same
// "held" answer: the filter did not match the live document, so the insert
// collided with it.
export async function acquireLeaseWithCollection(collection, { key, owner, now = new Date(), ttlMs = LEASE_DEFAULTS.ttlMs }) {
	const nowIso = now.toISOString();
	const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
	try {
		const doc = unwrap(
			await collection.findOneAndUpdate(
				{ _id: key, expiresAt: { $lte: nowIso } },
				{ $set: { owner, expiresAt, acquiredAt: nowIso }, $inc: { fence: 1 } },
				{ upsert: true, returnDocument: 'after' }
			)
		);
		if (!doc) return null;
		return { key, owner, fence: doc.fence, expiresAt: doc.expiresAt };
	} catch (err) {
		if (isDuplicateKeyError(err)) return null;
		throw err;
	}
}

// Extends a lease the caller still holds. False when it was lost.
export async function renewLeaseWithCollection(collection, { lease, now = new Date(), ttlMs = LEASE_DEFAULTS.ttlMs }) {
	const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
	const doc = unwrap(
		await collection.findOneAndUpdate(
			{ _id: lease.key, owner: lease.owner, fence: lease.fence, expiresAt: { $gt: now.toISOString() } },
			{ $set: { expiresAt } },
			{ returnDocument: 'after' }
		)
	);
	return doc ? { ...lease, expiresAt } : null;
}

export async function releaseLeaseWithCollection(collection, { lease }) {
	await collection.findOneAndUpdate(
		{ _id: lease.key, owner: lease.owner, fence: lease.fence },
		{ $set: { owner: null, expiresAt: NEVER } },
		{ returnDocument: 'after' }
	);
}
