/*
 * ZA-130 / esfoobar/zeroagent#229. The plan and trial semantics from
 * docs/MONETIZATION.md, kept as pure functions so they are unit-testable
 * without a database: thirty days of everything from first connect, then
 * the trial expires into the free tier rather than a lock, and premium or
 * platinum always keep the relay open regardless of the trial clock.
 */

export const TRIAL_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
export const PLANS = ['free', 'premium', 'platinum'];

export function trialEndsFrom(now = new Date()) {
	return new Date(now.getTime() + TRIAL_DURATION_MS).toISOString();
}

function isInTrial(user, now) {
	return Boolean(user.trialEnds) && new Date(user.trialEnds).getTime() > now.getTime();
}

// True while in trial, or on premium or platinum, per the ticket's spec for
// what the relay checks at connect (ZA-209). planUntil is informational
// only here: a lapsed subscription is reflected by an admin changing `plan`
// back to free by hand, not by this function reading planUntil.
export function isRelayAllowed(user, now = new Date()) {
	if (user.plan === 'premium' || user.plan === 'platinum') return true;
	return isInTrial(user, now);
}

export function entitlementFor(user, now = new Date()) {
	return {
		plan: user.plan,
		trialEnds: user.trialEnds ?? null,
		planUntil: user.planUntil ?? null,
		relayAllowed: isRelayAllowed(user, now),
	};
}
