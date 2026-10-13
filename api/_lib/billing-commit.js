/*
 * ZA-901 / esfoobar/zeroagent#1264. The fenced commit: the one write path
 * for paid state. In a single transaction it re-checks that the caller
 * still holds the customer lease with the fence it was issued, writes the
 * billing projection with plan fields derived from it, and completes the
 * inbox entry. A lease lost during a slow Stripe call cannot commit, and a
 * fence older than the one already on the projection cannot overwrite it.
 *
 * ZA-902's event handlers decide the `patch`; nothing else here knows what a
 * Stripe event is. No read path calls this.
 */

import { assertLivemode } from './billing-config.js';

export class LeaseLostError extends Error {
	constructor(message = 'customer lease lost') {
		super(message);
		this.name = 'LeaseLostError';
	}
}

export class AccountNotFoundError extends Error {
	constructor() {
		super('account not found');
		this.name = 'AccountNotFoundError';
	}
}

export class LegacyGrantConflictError extends Error {
	constructor() {
		super('account holds a legacy grant');
		this.name = 'LegacyGrantConflictError';
	}
}

export class EventNotOwnedError extends Error {
	constructor() {
		super('inbox entry is not held by this owner');
		this.name = 'EventNotOwnedError';
	}
}

// The stored plan label and paid-through mirror (contract, "Compatibility"):
// a terminal subscription is free with its historical date; any record with
// a paid period is premium with planUntil equal to paid-through, even when
// that date is already past (grace). A record that never paid grants none.
export function planFieldsFor(billing) {
	if (billing.status === 'ended') return { plan: 'free', planUntil: billing.paidThrough ?? null };
	if (billing.paidThrough) return { plan: 'premium', planUntil: billing.paidThrough };
	return { plan: 'free', planUntil: null };
}

function isUnmarkedHandGrant(user) {
	return !user.billing && (user.plan === 'premium' || user.plan === 'platinum') && user.entitlementSource !== 'stripe';
}

// deps: { collections: { users, leases, events }, withTransaction }
// args: { environment, lease, githubId, patch, eventKey, owner, now,
//         acknowledgeLegacy }
export async function commitProjection(deps, args) {
	const { environment, lease, githubId, patch, eventKey, owner, now = new Date(), acknowledgeLegacy = false } = args;
	const { users, leases, events } = deps.collections;
	const nowIso = now.toISOString();

	return deps.withTransaction(async ({ session } = {}) => {
		const options = session ? { session } : {};

		// Touching the lease document inside the transaction also makes a
		// concurrent acquirer conflict with this commit rather than slip past.
		const held = await leases.findOneAndUpdate(
			{ _id: lease.key, owner: lease.owner, fence: lease.fence, expiresAt: { $gt: nowIso } },
			{ $set: { lastCommitAt: nowIso } },
			{ returnDocument: 'after', ...options }
		);
		if (!(held && 'value' in held ? held.value : held)) throw new LeaseLostError();

		const user = await users.findOne({ _id: githubId }, options);
		if (!user) throw new AccountNotFoundError();
		if ((user.entitlementSource === 'legacy_grant' || isUnmarkedHandGrant(user)) && !acknowledgeLegacy) {
			throw new LegacyGrantConflictError();
		}

		const previous = user.billing && typeof user.billing === 'object' ? user.billing : null;
		if (previous && previous.provider === 'stripe') {
			assertLivemode(environment, previous, 'stored billing record');
			if (previous.stripeAccountId && previous.stripeAccountId !== environment.stripeAccountId) {
				throw new Error('stored billing record belongs to another Stripe account');
			}
		}

		const billing = {
			...(previous || {}),
			...patch,
			provider: 'stripe',
			stripeAccountId: environment.stripeAccountId,
			livemode: environment.livemode,
			revision: (previous && Number.isInteger(previous.revision) ? previous.revision : 0) + 1,
			fence: lease.fence,
			updatedAt: nowIso,
		};
		const fields = planFieldsFor(billing);

		const written = await users.updateOne(
			{
				_id: githubId,
				$or: [{ 'billing.fence': { $exists: false } }, { 'billing.fence': { $lte: lease.fence } }],
			},
			{ $set: { billing, plan: fields.plan, planUntil: fields.planUntil, entitlementSource: 'stripe' } },
			options
		);
		if (!written || written.matchedCount === 0) throw new LeaseLostError('stale fence');

		const completed = await events.updateOne(
			{ _id: eventKey, state: 'processing', leaseOwner: owner },
			{ $set: { state: 'completed', completedAt: nowIso, leaseOwner: null, leaseExpiresAt: null, lastError: null } },
			options
		);
		if (!completed || completed.matchedCount === 0) throw new EventNotOwnedError();

		return { billing, plan: fields.plan, planUntil: fields.planUntil };
	});
}
