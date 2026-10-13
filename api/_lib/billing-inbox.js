/*
 * ZA-901 / esfoobar/zeroagent#1264. The webhook event inbox: one document
 * per (stripeAccountId, livemode, event.id), with processing state,
 * attempts and a lease expiry. ZA-902's webhook endpoint records an event
 * here, claims it, processes it, and completes it in the fenced commit
 * (billing-commit.js). Only minimal identifiers are kept: never a payload,
 * a signature or a payment object.
 *
 * States: received -> processing -> completed | failed | quarantined.
 *  - A claimed (processing) or failed entry is never "complete".
 *  - A processing entry whose lease expired can be claimed again.
 *  - After maxAttempts the entry is quarantined for an operator, never
 *    silently acknowledged as done.
 */

import { isDuplicateKeyError } from './mongo-errors.js';

export const INBOX_DEFAULTS = Object.freeze({
	leaseMs: 60_000,
	maxAttempts: 8,
});

export function inboxKey({ stripeAccountId, livemode, eventId }) {
	if (!stripeAccountId || typeof livemode !== 'boolean' || !eventId) {
		throw new Error('inbox key needs stripeAccountId, livemode and eventId');
	}
	return `${stripeAccountId}:${livemode ? 'live' : 'test'}:${eventId}`;
}

function unwrap(result) {
	return result && 'value' in result ? result.value : result;
}

// Inserts the entry or finds the existing one. Returns { created, entry }.
// `event` is the verified Stripe event; `environment` the loaded billing
// environment whose mode the caller already asserted.
export async function recordEventWithCollection(collection, { environment, event, now = new Date() }, options = {}) {
	const object = event && event.data && event.data.object ? event.data.object : {};
	const key = inboxKey({
		stripeAccountId: environment.stripeAccountId,
		livemode: event.livemode,
		eventId: event.id,
	});
	const entry = {
		_id: key,
		stripeAccountId: environment.stripeAccountId,
		livemode: event.livemode,
		eventId: event.id,
		type: event.type,
		eventCreated: Number.isFinite(event.created) ? event.created : null,
		objectId: typeof object.id === 'string' ? object.id : null,
		customerId: typeof object.customer === 'string' ? object.customer : null,
		state: 'received',
		attempts: 0,
		leaseOwner: null,
		leaseExpiresAt: null,
		lastError: null,
		receivedAt: now.toISOString(),
		completedAt: null,
	};
	try {
		await collection.insertOne(entry, options);
		return { created: true, entry };
	} catch (err) {
		if (!isDuplicateKeyError(err)) throw err;
		const existing = await collection.findOne({ _id: key }, options);
		return { created: false, entry: existing };
	}
}

// Atomically takes the entry for `owner`. Null when it is already complete,
// quarantined, or held by a live lease: the caller answers 5xx on a held
// lease so Stripe retries, and 2xx on a complete one.
export async function claimEventWithCollection(
	collection,
	{ key, owner, now = new Date(), leaseMs = INBOX_DEFAULTS.leaseMs, maxAttempts = INBOX_DEFAULTS.maxAttempts }
) {
	const nowIso = now.toISOString();
	const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
	const claimed = unwrap(
		await collection.findOneAndUpdate(
			{
				_id: key,
				attempts: { $lt: maxAttempts },
				$or: [
					{ state: { $in: ['received', 'failed'] } },
					{ state: 'processing', leaseExpiresAt: { $lte: nowIso } },
				],
			},
			{ $set: { state: 'processing', leaseOwner: owner, leaseExpiresAt }, $inc: { attempts: 1 } },
			{ returnDocument: 'after' }
		)
	);
	return claimed || null;
}

// The failure path. Only the current owner can record it. A retriable
// failure goes back to `failed` (claimable again); once the attempt budget
// is spent it becomes `quarantined`. `errorCode` is a short code, never a
// message that could carry a payload.
export async function failEventWithCollection(
	collection,
	{ key, owner, errorCode, now = new Date(), maxAttempts = INBOX_DEFAULTS.maxAttempts }
) {
	const entry = await collection.findOne({ _id: key });
	if (!entry || entry.state !== 'processing' || entry.leaseOwner !== owner) return null;
	const state = entry.attempts >= maxAttempts ? 'quarantined' : 'failed';
	const updated = unwrap(
		await collection.findOneAndUpdate(
			{ _id: key, state: 'processing', leaseOwner: owner },
			{
				$set: {
					state,
					leaseOwner: null,
					leaseExpiresAt: null,
					lastError: String(errorCode || 'error').slice(0, 64),
					failedAt: now.toISOString(),
				},
			},
			{ returnDocument: 'after' }
		)
	);
	return updated || null;
}

// Marks an entry that can never be applied (an unmapped customer, a legacy
// conflict) for operator repair. It is kept, with its reason, never dropped.
export async function quarantineEventWithCollection(collection, { key, owner, reason, now = new Date() }) {
	const updated = unwrap(
		await collection.findOneAndUpdate(
			{ _id: key, state: 'processing', leaseOwner: owner },
			{
				$set: {
					state: 'quarantined',
					leaseOwner: null,
					leaseExpiresAt: null,
					lastError: String(reason || 'quarantined').slice(0, 64),
					failedAt: now.toISOString(),
				},
			},
			{ returnDocument: 'after' }
		)
	);
	return updated || null;
}
