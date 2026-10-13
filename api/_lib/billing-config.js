/*
 * ZA-901 / esfoobar/zeroagent#1264. The one place billing is configured:
 * the two timing parameters the entitlement contract defines, the names of
 * the environment variables, and the environment guard that keeps sandbox
 * and live apart.
 *
 * Nothing here is a price. The Product is named by STRIPE_PREMIUM_PRODUCT_ID
 * and its default Price is resolved at runtime (billing-catalog.js), so a
 * price change is a change in Stripe with no deployment.
 */

// docs/BILLING-ENTITLEMENT.md, "Timing". Read by billing-projection.js and
// by the webhook writer (paymentGraceUntilFor) from here and nowhere else.
export const BILLING_PARAMETERS = Object.freeze({
	paymentGraceSeconds: 259200,
	renewalSettlementSeconds: 21600,
});

// Variable names only; values live in the Vercel project's protected
// settings, sandbox values in Preview and live values in Production.
export const BILLING_ENV_VARS = Object.freeze({
	apiKey: 'STRIPE_API_KEY',
	webhookSecret: 'STRIPE_WEBHOOK_SECRET',
	productId: 'STRIPE_PREMIUM_PRODUCT_ID',
	portalConfigurationId: 'STRIPE_PORTAL_CONFIGURATION_ID',
	accountId: 'STRIPE_ACCOUNT_ID',
	expectLiveMode: 'STRIPE_EXPECT_LIVE_MODE',
	baseUrl: 'BILLING_BASE_URL',
});

export class BillingConfigError extends Error {
	constructor(message) {
		super(message);
		this.name = 'BillingConfigError';
	}
}

export class BillingModeMismatchError extends Error {
	constructor(message) {
		super(message);
		this.name = 'BillingModeMismatchError';
	}
}

function required(env, name) {
	const value = env[name];
	if (typeof value !== 'string' || value.trim() === '') {
		throw new BillingConfigError(`${name} is not set`);
	}
	return value.trim();
}

// The mode is spelled out, never defaulted: a deployment that forgot it
// must fail closed rather than guess live or sandbox.
function parseExpectLiveMode(raw) {
	if (raw === 'true') return true;
	if (raw === 'false') return false;
	throw new BillingConfigError(`${BILLING_ENV_VARS.expectLiveMode} must be "true" or "false"`);
}

// Reads and validates the environment. Error messages carry variable names
// only, never a value. A key whose own mode marker disagrees with
// STRIPE_EXPECT_LIVE_MODE is refused here, before any call is made with it.
export function loadBillingEnvironment(env = process.env) {
	const livemode = parseExpectLiveMode(env[BILLING_ENV_VARS.expectLiveMode]);
	const apiKey = required(env, BILLING_ENV_VARS.apiKey);
	const keyMode = /^(?:sk|rk)_(live|test)_/.exec(apiKey);
	if (!keyMode) {
		throw new BillingConfigError(`${BILLING_ENV_VARS.apiKey} is not a recognizable Stripe key`);
	}
	if ((keyMode[1] === 'live') !== livemode) {
		throw new BillingConfigError(`${BILLING_ENV_VARS.apiKey} does not match ${BILLING_ENV_VARS.expectLiveMode}`);
	}
	return Object.freeze({
		livemode,
		environment: livemode ? 'live' : 'sandbox',
		stripeAccountId: required(env, BILLING_ENV_VARS.accountId),
		productId: required(env, BILLING_ENV_VARS.productId),
		portalConfigurationId: env[BILLING_ENV_VARS.portalConfigurationId] || null,
		baseUrl: env[BILLING_ENV_VARS.baseUrl] || 'https://zeroagenthq.com',
	});
}

// An event or API object carries its own `livemode`. Anything that is not
// exactly the configured mode is refused, a missing flag included.
export function assertLivemode(environment, object, what = 'object') {
	if (!object || typeof object.livemode !== 'boolean') {
		throw new BillingModeMismatchError(`${what} has no livemode flag`);
	}
	if (object.livemode !== environment.livemode) {
		throw new BillingModeMismatchError(
			`${what} is ${object.livemode ? 'live' : 'sandbox'} but this deployment is ${environment.environment}`
		);
	}
}

// The grace deadline is anchored to the end of the earlier paid period and
// never moved by a retry: the writer sets it once, at the first failure.
export function paymentGraceUntilFor(paidThrough, parameters = BILLING_PARAMETERS) {
	if (paidThrough === null || paidThrough === undefined) return null;
	const base = new Date(paidThrough).getTime();
	if (!Number.isFinite(base)) return null;
	return new Date(base + parameters.paymentGraceSeconds * 1000).toISOString();
}
