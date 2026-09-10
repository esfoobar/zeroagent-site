// ZA-130 / esfoobar/zeroagent#229. Pure plan and trial logic, no database.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trialEndsFrom, isRelayAllowed, entitlementFor, TRIAL_DURATION_MS } from '../api/_lib/entitlement.js';

test('trialEndsFrom is thirty days after the given instant', () => {
	const now = new Date('2026-09-08T00:00:00.000Z');
	assert.equal(trialEndsFrom(now), new Date(now.getTime() + TRIAL_DURATION_MS).toISOString());
	assert.equal(trialEndsFrom(now), '2026-10-08T00:00:00.000Z');
});

test('isRelayAllowed: free plan within the trial window is allowed', () => {
	const now = new Date('2026-09-15T00:00:00.000Z');
	const user = { plan: 'free', trialEnds: '2026-10-08T00:00:00.000Z' };
	assert.equal(isRelayAllowed(user, now), true);
});

test('isRelayAllowed: free plan past the trial window is not allowed', () => {
	const now = new Date('2026-11-01T00:00:00.000Z');
	const user = { plan: 'free', trialEnds: '2026-10-08T00:00:00.000Z' };
	assert.equal(isRelayAllowed(user, now), false);
});

test('isRelayAllowed: free plan with no trialEnds at all is not allowed', () => {
	const now = new Date('2026-09-15T00:00:00.000Z');
	const user = { plan: 'free', trialEnds: null };
	assert.equal(isRelayAllowed(user, now), false);
});

test('isRelayAllowed: premium is always allowed, trial expired or not', () => {
	const now = new Date('2026-11-01T00:00:00.000Z');
	const user = { plan: 'premium', trialEnds: '2026-10-08T00:00:00.000Z' };
	assert.equal(isRelayAllowed(user, now), true);
});

test('isRelayAllowed: platinum is always allowed', () => {
	const now = new Date('2026-11-01T00:00:00.000Z');
	const user = { plan: 'platinum', trialEnds: null };
	assert.equal(isRelayAllowed(user, now), true);
});

test('isRelayAllowed: the trial boundary itself is not allowed (strictly after, not at)', () => {
	const trialEnds = '2026-10-08T00:00:00.000Z';
	const user = { plan: 'free', trialEnds };
	assert.equal(isRelayAllowed(user, new Date(trialEnds)), false);
});

test('entitlementFor shapes the full response the /api/app/me contract promises', () => {
	const now = new Date('2026-09-15T00:00:00.000Z');
	const user = {
		githubId: 1234567,
		login: 'octocat',
		plan: 'free',
		trialEnds: '2026-10-08T00:00:00.000Z',
		planUntil: null,
		createdAt: '2026-09-08T00:00:00.000Z',
		pairedDevices: [],
	};
	assert.deepEqual(entitlementFor(user, now), {
		plan: 'free',
		trialEnds: '2026-10-08T00:00:00.000Z',
		planUntil: null,
		relayAllowed: true,
	});
});

test('entitlementFor defaults trialEnds and planUntil to null rather than undefined', () => {
	const user = { plan: 'premium' };
	const result = entitlementFor(user, new Date());
	assert.equal(result.trialEnds, null);
	assert.equal(result.planUntil, null);
	assert.equal(result.relayAllowed, true);
});
