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
 *    silently acknowledged as done: by fail when its holder reports, and by
 *    the next claim when the holder died without reporting.
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

// Atomically takes the entry for `owner`. Always answers { status, entry }
// so the caller never has to guess why it did not get the entry:
//
//   claimed      the caller holds it now (entry.attempts is this attempt):
//                process it, then commit or fail it.
//   held         another holder's lease is still live: answer 5xx so Stripe
//                retries later.
//   completed    already applied: answer 2xx, nothing to do.
//   quarantined  parked for an operator (attempt budget spent, or sent
//                there by a handler): answer 2xx so Stripe stops retrying;
//                the quarantine is the alert, not a retry loop.
//   missing      never recorded: record it first.
//
// An entry at the attempt budget whose holder died without calling fail
// (lease expired in `processing`, or still `failed`) is moved to
// `quarantined` here, by a conditional update, so concurrent claimants
// agree and an exhausted entry can never be stranded.
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
	if (claimed) return { status: 'claimed', entry: claimed };

	const exhausted = unwrap(
		await collection.findOneAndUpdate(
			{
				_id: key,
				attempts: { $gte: maxAttempts },
				$or: [{ state: 'failed' }, { state: 'processing', leaseExpiresAt: { $lte: nowIso } }],
			},
			{
				$set: {
					state: 'quarantined',
					leaseOwner: null,
					leaseExpiresAt: null,
					lastError: 'attempts_exhausted',
					failedAt: nowIso,
				},
			},
			{ returnDocument: 'after' }
		)
	);
	if (exhausted) return { status: 'quarantined', entry: exhausted };

	const entry = await collection.findOne({ _id: key });
	if (!entry) return { status: 'missing', entry: null };
	if (entry.state === 'completed') return { status: 'completed', entry };
	if (entry.state === 'quarantined') return { status: 'quarantined', entry };
	return { status: 'held', entry };
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

// Completes an entry that needs no paid-state write: an event the table
// acknowledges without acting on (checkout completion, an unsupported
// type), a replay whose reconciled state equals what is stored, or a late
// event bound to a subscription that is no longer current. `outcome` is a
// short code kept for the audit trail. The paid-state commit completes its
// own entry (billing-commit.js); this one writes nothing but the inbox.
export async function completeEventWithCollection(collection, { key, owner, outcome, now = new Date() }) {
	const updated = unwrap(
		await collection.findOneAndUpdate(
			{ _id: key, state: 'processing', leaseOwner: owner },
			{
				$set: {
					state: 'completed',
					leaseOwner: null,
					leaseExpiresAt: null,
					lastError: null,
					outcome: String(outcome || 'completed').slice(0, 64),
					completedAt: now.toISOString(),
				},
			},
			{ returnDocument: 'after' }
		)
	);
	return updated || null;
}
