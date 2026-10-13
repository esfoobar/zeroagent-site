// ZA-901. Projection behavior beyond the shared fixtures: parameters are
// injected not hard-coded, price identity never matters, boundaries are
// exclusive, and odd stored shapes fail closed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectEntitlement } from '../api/_lib/billing-projection.js';
import { BILLING_PARAMETERS } from '../api/_lib/billing-config.js';

const T = (s) => new Date(s);

function paid(over = {}, account = {}) {
	return {
		plan: 'premium',
		planUntil: '2026-12-01T00:00:00.000Z',
		trialEnds: '2026-10-01T00:00:00.000Z',
		entitlementSource: 'stripe',
		legacyGrant: null,
		billing: {
			provider: 'stripe',
			subscriptionId: 'sub_arbitrary',
			priceId: 'price_arbitrary',
			status: 'active',
			paidThrough: '2026-12-01T00:00:00.000Z',
			cancelAtPeriodEnd: false,
			paymentGraceUntil: null,
			endedAt: null,
			revision: 7,
			...over,
		},
		...account,
	};
}

test('entitlement ignores the Price id: several arbitrary ids answer the same', () => {
	const answers = ['price_x1', 'price_zz', 'price_', 'anything at all', null].map((priceId) =>
		projectEntitlement(paid({ priceId }), T('2026-11-15T00:00:00.000Z'))
	);
	for (const a of answers) {
		assert.equal(a.relayAllowed, true);
		assert.equal(a.accessUntil, '2026-12-01T00:00:00.000Z');
	}
});

test('settlement window comes from the injected parameter', () => {
	const account = paid();
	const after = T('2026-12-01T00:00:01.000Z');
	assert.equal(projectEntitlement(account, after).relayAllowed, true);
	assert.equal(projectEntitlement(account, after, { ...BILLING_PARAMETERS, renewalSettlementSeconds: 0 }).relayAllowed, false);
	const edge = T('2026-12-01T06:00:00.000Z');
	assert.equal(projectEntitlement(account, edge).relayAllowed, false);
	assert.equal(projectEntitlement(account, T('2026-12-01T05:59:59.999Z')).relayAllowed, true);
	const wide = { ...BILLING_PARAMETERS, renewalSettlementSeconds: 7200 };
	assert.equal(projectEntitlement(account, T('2026-12-01T03:00:00.000Z'), wide).relayAllowed, false);
	assert.equal(projectEntitlement(account, T('2026-12-01T01:59:59.999Z'), wide).accessUntil, '2026-12-01T02:00:00.000Z');
});

test('deadlines are exclusive', () => {
	const account = paid({ cancelAtPeriodEnd: true });
	assert.equal(projectEntitlement(account, T('2026-11-30T23:59:59.999Z')).relayAllowed, true);
	assert.equal(projectEntitlement(account, T('2026-12-01T00:00:00.000Z')).relayAllowed, false);
});

test('a scheduled cancel has no settlement window and is cancel_scheduled', () => {
	const a = projectEntitlement(paid({ cancelAtPeriodEnd: true }), T('2026-12-01T00:00:01.000Z'));
	assert.equal(a.billingStatus, 'cancel_scheduled');
	assert.equal(a.relayAllowed, false);
	assert.equal(a.cancelAtPeriodEnd, true);
});

test('past_due without an earlier paid period grants nothing', () => {
	const a = projectEntitlement(paid({ status: 'past_due', paidThrough: null, paymentGraceUntil: '2026-12-04T00:00:00.000Z' }), T('2026-12-02T00:00:00.000Z'));
	assert.equal(a.relayAllowed, false);
});

test('an unknown status fails closed', () => {
	for (const status of ['incomplete', 'incomplete_expired', 'unpaid', 'paused', 'weird', undefined]) {
		const a = projectEntitlement(paid({ status }), T('2026-11-15T00:00:00.000Z'), BILLING_PARAMETERS);
		assert.equal(a.relayAllowed, false, String(status));
		assert.equal(a.billingStatus, 'none');
	}
});

test('a purchase never extends the trial: access is the later ground', () => {
	const a = projectEntitlement(paid({}, { trialEnds: '2026-12-20T00:00:00.000Z' }), T('2026-11-15T00:00:00.000Z'));
	assert.equal(a.accessUntil, '2026-12-20T00:00:00.000Z');
	const b = projectEntitlement(paid({}, { trialEnds: '2026-12-20T00:00:00.000Z' }), T('2026-12-10T00:00:00.000Z'));
	assert.equal(b.relayAllowed, true);
	assert.equal(b.billingStatus, 'active');
});

test('an ended record is not revived by a stored grace date', () => {
	const a = projectEntitlement(
		paid({ status: 'ended', endedAt: '2026-12-04T00:00:00.000Z', paymentGraceUntil: '2026-12-04T00:00:00.000Z' }),
		T('2026-12-02T00:00:00.000Z')
	);
	assert.equal(a.relayAllowed, false);
});

test('entitlementVersion is the committed revision, zero when never billed', () => {
	assert.equal(projectEntitlement(paid(), T('2026-11-15T00:00:00.000Z')).entitlementVersion, 7);
	assert.equal(projectEntitlement({ plan: 'free', trialEnds: null }, T('2026-11-15T00:00:00.000Z')).entitlementVersion, 0);
});

test('an account with no billing fields at all projects from its trial', () => {
	const account = { plan: 'free', planUntil: null, trialEnds: '2026-11-01T00:00:00.000Z', pairedDevices: [] };
	assert.equal(projectEntitlement(account, T('2026-10-20T00:00:00.000Z')).relayAllowed, true);
	assert.equal(projectEntitlement(account, T('2026-11-01T00:00:00.000Z')).relayAllowed, false);
	assert.equal(projectEntitlement(account, T('2026-11-01T00:00:00.000Z')).billingStatus, 'none');
});
