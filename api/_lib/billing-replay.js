import { inboxKey } from './billing-inbox.js';
import { billingReference } from './billing-reference.js';

// Operator preparation only. It resets an inbox retry budget and records
// who requested it. Stripe must still resend the event through the verified
// webhook to reach the sole paid-state writer.
export async function prepareEventReplay({ collections, withTransaction }, { environment, eventId, referenceKey, actor, reason, now = new Date() }) {
	if (!/^(?:evt_[A-Za-z0-9_]+|[a-f0-9]{12})$/.test(eventId || '')) throw new Error('event_id_or_reference_required');
	if (typeof actor !== 'string' || !actor.trim()) throw new Error('actor_required');
	if (typeof reason !== 'string' || !reason.trim()) throw new Error('reason_required');
	return withTransaction(async ({ session } = {}) => {
		const options = session ? { session } : {};
		let fullId = eventId;
		if (/^[a-f0-9]{12}$/.test(eventId)) {
			const candidates = await collections.events.find({ stripeAccountId: environment.stripeAccountId, livemode: environment.livemode, state: { $in: ['failed', 'quarantined'] } }, options).toArray();
			const matches = candidates.filter((entry) => billingReference(entry.eventId, referenceKey) === eventId);
			if (matches.length !== 1) throw new Error(matches.length ? 'ambiguous_event_reference' : 'event_reference_not_found');
			fullId = matches[0].eventId;
		}
		const key = inboxKey({ stripeAccountId: environment.stripeAccountId, livemode: environment.livemode, eventId: fullId });
		const before = await collections.events.findOne({ _id: key }, options);
		if (!before || !['failed', 'quarantined'].includes(before.state)) throw new Error('event_not_replayable');
		const updated = await collections.events.updateOne(
			{ _id: key, state: before.state, attempts: before.attempts },
			{ $set: { state: 'received', attempts: 0, leaseOwner: null, leaseExpiresAt: null, lastError: null, replayPreparedAt: now.toISOString(), failedAt: null } },
			options
		);
		if (updated.modifiedCount !== 1) throw new Error('event_changed');
		const reference = billingReference(fullId, referenceKey);
		await collections.audit.insertOne({ kind: 'event_replay_prepared', environment: environment.environment, eventRef: reference, previousState: before.state, actor: actor.trim(), reason: reason.trim(), at: now.toISOString() }, options);
		return { eventRef: reference, status: 'awaiting_verified_redelivery' };
	});
}
