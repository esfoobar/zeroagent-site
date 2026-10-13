import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	BILLING_ENV_VARS,
	BILLING_PARAMETERS,
	BillingConfigError,
	BillingModeMismatchError,
	assertLivemode,
	loadBillingEnvironment,
	paymentGraceUntilFor,
} from '../api/_lib/billing-config.js';

// Synthetic values assembled at run time so no key-shaped literal is committed.
const key = (mode) => ['rk', mode, 'synthetic'].join('_');

function env(over = {}) {
	return {
		STRIPE_API_KEY: key('test'),
		STRIPE_ACCOUNT_ID: 'acct_synthetic',
		STRIPE_PREMIUM_PRODUCT_ID: 'prod_synthetic',
		STRIPE_EXPECT_LIVE_MODE: 'false',
		...over,
	};
}

test('loads a sandbox environment', () => {
	const e = loadBillingEnvironment(env());
	assert.equal(e.livemode, false);
	assert.equal(e.environment, 'sandbox');
	assert.equal(e.productId, 'prod_synthetic');
	assert.equal(e.baseUrl, 'https://zeroagenthq.com');
});

test('loads a live environment', () => {
	const e = loadBillingEnvironment(env({ STRIPE_API_KEY: key('live'), STRIPE_EXPECT_LIVE_MODE: 'true' }));
	assert.equal(e.livemode, true);
	assert.equal(e.environment, 'live');
});

test('the mode is never defaulted', () => {
	for (const bad of [undefined, '', 'yes', '1', 'TRUE']) {
		assert.throws(() => loadBillingEnvironment(env({ STRIPE_EXPECT_LIVE_MODE: bad })), BillingConfigError);
	}
});

test('a key of the other mode is refused, and the error carries no value', () => {
	const secret = key('live');
	try {
		loadBillingEnvironment(env({ STRIPE_API_KEY: secret, STRIPE_EXPECT_LIVE_MODE: 'false' }));
		assert.fail('should throw');
	} catch (err) {
		assert.ok(err instanceof BillingConfigError);
		assert.ok(!err.message.includes(secret));
	}
	assert.throws(() => loadBillingEnvironment(env({ STRIPE_API_KEY: 'not-a-key' })), BillingConfigError);
});

test('every required variable is named when missing', () => {
	for (const name of ['STRIPE_ACCOUNT_ID', 'STRIPE_PREMIUM_PRODUCT_ID', 'STRIPE_API_KEY']) {
		const e = env();
		delete e[name];
		assert.throws(() => loadBillingEnvironment(e), (err) => err.message.includes(name));
	}
});

test('assertLivemode refuses a mismatched or missing mode', () => {
	const sandbox = loadBillingEnvironment(env());
	assertLivemode(sandbox, { livemode: false });
	assert.throws(() => assertLivemode(sandbox, { livemode: true }), BillingModeMismatchError);
	assert.throws(() => assertLivemode(sandbox, {}), BillingModeMismatchError);
	assert.throws(() => assertLivemode(sandbox, null), BillingModeMismatchError);
	const live = loadBillingEnvironment(env({ STRIPE_API_KEY: key('live'), STRIPE_EXPECT_LIVE_MODE: 'true' }));
	assert.throws(() => assertLivemode(live, { livemode: false }), BillingModeMismatchError);
});

test('variables are named, the manifest names match the config', () => {
	assert.equal(BILLING_ENV_VARS.productId, 'STRIPE_PREMIUM_PRODUCT_ID');
	assert.equal(BILLING_ENV_VARS.expectLiveMode, 'STRIPE_EXPECT_LIVE_MODE');
	assert.equal(BILLING_ENV_VARS.apiVersion, 'STRIPE_API_VERSION');
});

test('payment grace is paid-through plus the parameter', () => {
	assert.equal(paymentGraceUntilFor('2026-12-01T00:00:00.000Z'), '2026-12-04T00:00:00.000Z');
	assert.equal(paymentGraceUntilFor('2026-12-01T00:00:00.000Z', { ...BILLING_PARAMETERS, paymentGraceSeconds: 60 }), '2026-12-01T00:01:00.000Z');
	assert.equal(paymentGraceUntilFor(null), null);
});

test('only a fully absent billing environment is marked not configured', () => {
	assert.throws(() => loadBillingEnvironment({}), (error) => error instanceof BillingConfigError && error.notConfigured === true);
	for (const partial of [
		{ STRIPE_API_KEY: key('test') },
		{ STRIPE_API_KEY: 'not-a-key', STRIPE_EXPECT_LIVE_MODE: 'false' },
		{ ...env(), STRIPE_API_KEY: key('live') },
		{ ...env(), STRIPE_EXPECT_LIVE_MODE: 'invalid' },
		{ ...env(), STRIPE_ACCOUNT_ID: undefined },
	]) assert.throws(() => loadBillingEnvironment(partial), (error) => error instanceof BillingConfigError && error.notConfigured === false);
});
