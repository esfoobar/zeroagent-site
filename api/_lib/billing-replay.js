import { inboxKey } from './billing-inbox.js';
import { sha256Hex } from './hash.js';

// Operator preparation only. It resets an inbox retry budget and records
// who requested it. The event must still be resent by Stripe through the
// verified webhook to reach the sole paid-state writer.
export async function prepareEventReplay({ collections, withTransaction }, { environment, eventId, actor, reason, now = new Date() }) {
	if (!/^evt_[A-Za-z0-9_]+$/.test(eventId || '')) throw new Error('event_id_required');
	if (typeof actor !== 'string' || !actor.trim()) throw new Error('actor_required');
	if (typeof reason !== 'string' || !reason.trim()) throw new Error('reason_required');
	const key = inboxKey({ stripeAccountId: environment.stripeAccountId, livemode: environment.livemode, eventId });
	return withTransaction(async ({ session } = {}) => {
		const options = session ? { session } : {};
		const before = await collections.events.findOne({ _id: key }, options);
		if (!before || !['failed', 'quarantined'].includes(before.state)) throw new Error('event_not_replayable');
		const updated = await collections.events.updateOne(
			{ _id: key, state: before.state, attempts: before.attempts },
			{ $set: { state: 'received', attempts: 0, leaseOwner: null, leaseExpiresAt: null, lastError: null, receivedAt: now.toISOString(), failedAt: null } },
			options
		);
		if (updated.modifiedCount !== 1) throw new Error('event_changed');
		const reference = sha256Hex(eventId).slice(0, 12);
		await collections.audit.insertOne({ kind: 'event_replay_prepared', environment: environment.environment, eventRef: reference, previousState: before.state, actor: actor.trim(), reason: reason.trim(), at: now.toISOString() }, options);
		return { eventRef: reference, status: 'awaiting_verified_redelivery' };
	});
}
