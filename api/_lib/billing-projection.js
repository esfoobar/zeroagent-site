/*
 * ZA-901 / esfoobar/zeroagent#1264. The pure entitlement projection from
 * docs/BILLING-ENTITLEMENT.md in the zeroagent repo: a stored account plus
 * an instant in, the /me entitlement answer out. No I/O, no clock of its
 * own, no write. Time-driven transitions (T02, T10, T10a, T16) happen here
 * at read time and write nothing.
 *
 * Every deadline is exclusive: access holds while now < deadline.
 * Entitlement never depends on a Price id, an amount or the current-sale
 * Price; billing.priceId is not read here.
 */

import { BILLING_PARAMETERS } from './billing-config.js';

export const BILLING_STATUSES = Object.freeze(['none', 'active', 'cancel_scheduled', 'past_due', 'ended', 'legacy_grant']);

function ms(value) {
	if (value === null || value === undefined) return null;
	const t = new Date(value).getTime();
	return Number.isFinite(t) ? t : null;
}

function iso(t) {
	return new Date(t).toISOString();
}

function isoOrNull(value) {
	const t = ms(value);
	return t === null ? null : iso(t);
}

// The legacy ground. Returns { open: true } for a grant with no known end,
// { until } for a dated one, or null when no grant holds right now.
function legacyGround(account, now) {
	const grant = account.legacyGrant;
	if (grant && typeof grant === 'object') {
		if (grant.openEnded) return { open: true };
		const until = ms(grant.until);
		return until !== null && now < until ? { until } : null;
	}
	// Unmarked: today's rule. A hand-assigned premium or platinum plan with
	// no billing record keeps the relay open and its date is not read.
	if (!account.billing && (account.plan === 'premium' || account.plan === 'platinum')) return { open: true };
	return null;
}

function paidGrounds(billing, now, parameters) {
	const at = now;
	const grounds = [];
	const paidThrough = ms(billing.paidThrough);
	const settlement = parameters.renewalSettlementSeconds * 1000;
	const hold = (deadline) => {
		if (deadline !== null && now < deadline) grounds.push(deadline);
	};
	switch (billing.status) {
		case 'ended': {
			// An ended record honors the interval already paid, cut short by
			// the termination time. It never grants grace.
			const endedAt = ms(billing.endedAt);
			if (paidThrough !== null) hold(endedAt === null ? paidThrough : Math.min(paidThrough, endedAt));
			break;
		}
		case 'active':
			// The settlement window is the fallback after the paid interval,
			// not an extension of it, and a scheduled cancel has none.
			if (paidThrough !== null && at < paidThrough) hold(paidThrough);
			else if (paidThrough !== null && !billing.cancelAtPeriodEnd) hold(paidThrough + settlement);
			break;
		case 'past_due':
			// Grace needs an earlier paid period to be anchored to (T14).
			if (paidThrough !== null) {
				hold(paidThrough);
				hold(ms(billing.paymentGraceUntil));
			}
			break;
		default:
			// incomplete, unknown and anything else: nothing was paid.
			break;
	}
	return grounds;
}

function statusFor(billing, legacy) {
	if (billing) {
		if (billing.status === 'active') return billing.cancelAtPeriodEnd ? 'cancel_scheduled' : 'active';
		if (billing.status === 'past_due') return 'past_due';
		if (billing.status === 'ended') return 'ended';
		return 'none';
	}
	return legacy ? 'legacy_grant' : 'none';
}

// account: the normalized users document (see users-store.js). `billing`
// may be absent, null or an object; `legacyGrant` likewise.
export function projectEntitlement(account, now = new Date(), parameters = BILLING_PARAMETERS) {
	const at = now instanceof Date ? now.getTime() : ms(now);
	const billing = account.billing && typeof account.billing === 'object' ? account.billing : null;
	const grounds = [];

	const trialEnds = ms(account.trialEnds);
	if (trialEnds !== null && at < trialEnds) grounds.push(trialEnds);

	const legacy = billing ? null : legacyGround(account, at);
	if (legacy && !legacy.open) grounds.push(legacy.until);
	if (billing) grounds.push(...paidGrounds(billing, at, parameters));

	const open = Boolean(legacy && legacy.open);
	const relayAllowed = open || grounds.length > 0;
	const accessUntil = open || grounds.length === 0 ? null : iso(Math.max(...grounds));

	// A marked grant whose end has passed is no longer a grant (T16).
	const status = statusFor(billing, Boolean(legacy));

	return {
		plan: account.plan,
		trialEnds: isoOrNull(account.trialEnds),
		planUntil: isoOrNull(account.planUntil),
		relayAllowed,
		billingStatus: status,
		accessUntil,
		paymentGraceUntil: billing ? isoOrNull(billing.paymentGraceUntil) : null,
		cancelAtPeriodEnd: Boolean(billing && billing.cancelAtPeriodEnd),
		entitlementVersion: billing && Number.isInteger(billing.revision) ? billing.revision : 0,
		checkedAt: iso(at),
	};
}

// The /me answer for a bearer, device tokens included: a revoked or unknown
// paired device is 401 unauthorized, never plan_required, exactly as
// api/app/me.js answers it today. Pure; the caller supplies the account.
export function answerFor(account, now, { deviceId = null, parameters = BILLING_PARAMETERS } = {}) {
	if (deviceId !== null) {
		const entry = (account.pairedDevices || []).find((d) => d.deviceId === deviceId);
		if (!entry || entry.revokedAt) return { status: 401, body: { error: 'unauthorized' } };
	}
	return { status: 200, body: projectEntitlement(account, now, parameters) };
}

// What the relay does with an answer: admit, or the neutral plan_required.
export function relayDecision(answer) {
	if (answer.status === 401) return 'unauthorized';
	return answer.body.relayAllowed ? 'admit' : 'plan_required';
}
