// ZA-902 / esfoobar/zeroagent#1265. GET /api/app/me now answers from the
// contract's projection. Every account that exists before billing (a
// running or expired trial, a hand-assigned premium or platinum with no
// billing record) must get exactly the answer the previous rule gave; this
// file proves it class by class, through the real handler, and pins the
// additive fields and the unchanged errors.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/app/me.js';
import { signHs256 } from '../api/_lib/jwt.js';
import { entitlementFor } from '../api/_lib/entitlement.js';

const SECRET = 'test-secret-do-not-use-in-prod';
const REAL_SECRET = process.env.ZEROAGENT_JWT_SECRET;
const DAY = 24 * 60 * 60 * 1000;
const future = (days) => new Date(Date.now() + days * DAY).toISOString();
const past = (days) => new Date(Date.now() - days * DAY).toISOString();

beforeEach(() => {
	process.env.ZEROAGENT_JWT_SECRET = SECRET;
});
afterEach(() => {
	if (REAL_SECRET === undefined) delete process.env.ZEROAGENT_JWT_SECRET;
	else process.env.ZEROAGENT_JWT_SECRET = REAL_SECRET;
});

function fakeRes() {
	return {
		statusCode: null,
		headers: {},
		body: null,
		setHeader(n, v) {
			this.headers[n] = v;
		},
		end(c) {
			this.body = c;
		},
	};
}

function token(claims = {}) {
	const iat = Math.floor(Date.now() / 1000);
	return signHs256({ iss: 'https://zeroagenthq.com', sub: 'acct_gh7', gh: 7, login: 'synthetic', iat, exp: iat + 60, ...claims }, SECRET);
}

async function ask(user, claims) {
	const res = fakeRes();
	await handler({ method: 'GET', headers: { authorization: `Bearer ${token(claims)}` } }, res, { getUser: async () => ({ githubId: 7, ...user }) });
	return { res, body: JSON.parse(res.body) };
}

const base = { login: 'synthetic', createdAt: past(40), pairedDevices: [] };

// Every class of account that exists today. None has a billing record.
const CLASSES = {
	'trial running': { plan: 'free', trialEnds: future(10), planUntil: null },
	'trial running, last day': { plan: 'free', trialEnds: future(0.01), planUntil: null },
	'trial expired': { plan: 'free', trialEnds: past(1), planUntil: null },
	'trial expired a long time ago': { plan: 'free', trialEnds: past(400), planUntil: null },
	'free, no trial date': { plan: 'free', planUntil: null },
	'free, null trial date': { plan: 'free', trialEnds: null, planUntil: null },
	'free with a future planUntil': { plan: 'free', trialEnds: past(2), planUntil: future(30) },
	'hand-assigned premium, no date': { plan: 'premium', trialEnds: past(5), planUntil: null },
	'hand-assigned premium, future date': { plan: 'premium', trialEnds: past(5), planUntil: future(20) },
	'hand-assigned premium, lapsed date': { plan: 'premium', trialEnds: past(5), planUntil: past(20) },
	'hand-assigned premium, trial running': { plan: 'premium', trialEnds: future(5), planUntil: null },
	'hand-assigned platinum, no date': { plan: 'platinum', trialEnds: past(5), planUntil: null },
	'hand-assigned platinum, lapsed date': { plan: 'platinum', trialEnds: past(50), planUntil: past(3) },
	'premium with billing explicitly null': { plan: 'premium', trialEnds: past(5), planUntil: null, billing: null },
	'unknown plan label, trial expired': { plan: 'enterprise', trialEnds: past(5), planUntil: null },
	'unknown plan label, trial running': { plan: 'enterprise', trialEnds: future(5), planUntil: null },
	'unparseable trial date': { plan: 'free', trialEnds: 'not a date', planUntil: null },
};

for (const [name, fields] of Object.entries(CLASSES)) {
	test(`compat: ${name} gets the answer it got before`, async () => {
		const user = { ...base, ...fields };
		const before = entitlementFor(user);
		const { res, body } = await ask(user);
		assert.equal(res.statusCode, 200);
		assert.equal(body.relayAllowed, before.relayAllowed);
		assert.equal(body.plan, before.plan);
		assert.equal(body.trialEnds, before.trialEnds);
		assert.equal(body.planUntil, before.planUntil);
		assert.equal(body.billingStatus, name.includes('hand-assigned') || name.includes('billing explicitly null') ? 'legacy_grant' : 'none');
	});
}

test('compat: a device token for an unrevoked device agrees with the desktop answer', async () => {
	const user = { ...base, plan: 'premium', trialEnds: past(5), planUntil: null, pairedDevices: [{ deviceId: 'dev_1', tokenHash: 'h', name: 'Phone', createdAt: past(2), revokedAt: null }] };
	const desktop = await ask(user);
	const device = await ask(user, { device: 'dev_1' });
	assert.equal(device.res.statusCode, 200);
	assert.equal(device.body.relayAllowed, desktop.body.relayAllowed);
});

test('a revoked device is 401 unauthorized, never plan_required', async () => {
	const user = { ...base, plan: 'free', trialEnds: past(5), planUntil: null, pairedDevices: [{ deviceId: 'dev_1', tokenHash: 'h', name: 'Phone', createdAt: past(2), revokedAt: past(1) }] };
	const { res, body } = await ask(user, { device: 'dev_1' });
	assert.equal(res.statusCode, 401);
	assert.deepEqual(body, { error: 'unauthorized' });
});

test('the six additive fields are present, typed, and the answer is not cached', async () => {
	const { res, body } = await ask({ ...base, plan: 'free', trialEnds: future(3), planUntil: null });
	assert.match(res.headers['Cache-Control'], /no-store/);
	assert.deepEqual(Object.keys(body).sort(), [
		'accessUntil',
		'billingStatus',
		'cancelAtPeriodEnd',
		'checkedAt',
		'entitlementVersion',
		'paymentGraceUntil',
		'plan',
		'planUntil',
		'relayAllowed',
		'trialEnds',
	]);
	assert.equal(body.billingStatus, 'none');
	assert.equal(typeof body.accessUntil, 'string');
	assert.equal(body.paymentGraceUntil, null);
	assert.equal(body.cancelAtPeriodEnd, false);
	assert.equal(body.entitlementVersion, 0);
	assert.ok(Number.isFinite(Date.parse(body.checkedAt)));
	// No price, amount, currency, Stripe id or purchase path.
	assert.ok(!/price|amount|currency|stripe|cus_|sub_|checkout/i.test(res.body));
});

test('a Stripe-paid account answers from the projection: grace, expiry and ended', async () => {
	const paid = (billing, planFields) => ({ ...base, trialEnds: past(60), ...planFields, billing: { provider: 'stripe', ...billing } });
	const inGrace = await ask(
		paid({ status: 'past_due', paidThrough: past(1), paymentGraceUntil: future(2), revision: 4 }, { plan: 'premium', planUntil: past(1) })
	);
	assert.equal(inGrace.body.relayAllowed, true);
	assert.equal(inGrace.body.billingStatus, 'past_due');
	assert.equal(inGrace.body.entitlementVersion, 4);
	assert.equal(inGrace.body.plan, 'premium');

	// The webhook that would materialize the end is late: the read denies.
	const lapsedGrace = await ask(
		paid({ status: 'past_due', paidThrough: past(5), paymentGraceUntil: past(1), revision: 5 }, { plan: 'premium', planUntil: past(5) })
	);
	assert.equal(lapsedGrace.body.relayAllowed, false);
	assert.equal(lapsedGrace.body.accessUntil, null);

	const ended = await ask(
		paid({ status: 'ended', paidThrough: past(2), endedAt: past(2), revision: 6 }, { plan: 'free', planUntil: past(2) })
	);
	assert.equal(ended.body.relayAllowed, false);
	assert.equal(ended.body.billingStatus, 'ended');
	assert.equal(ended.body.plan, 'free');
});
