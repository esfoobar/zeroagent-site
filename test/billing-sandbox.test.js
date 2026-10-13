import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifySandboxScenario } from '../api/_lib/billing-sandbox.js';

const environment = { environment: 'sandbox', livemode: false, stripeAccountId: 'acct_test', productId: 'prod_test', portalConfigurationId: 'bpc_test' };
const oldPrice = { id: 'price_old', product: 'prod_test', unit_amount: 500, active: false, livemode: false };
const newPrice = { id: 'price_new', product: 'prod_test', unit_amount: 700, active: true, livemode: false };
const subscription = { id: 'sub_test', customer: 'cus_test', status: 'active', livemode: false, cancel_at_period_end: false, test_clock: 'clock_test', items: { data: [{ price: oldPrice }] } };
const billing = { stripeAccountId: 'acct_test', livemode: false, subscriptionId: 'sub_test', priceId: 'price_old', status: 'active', cancelAtPeriodEnd: false, lastPaidInvoiceId: 'in_test', paidThrough: '2026-11-01T00:00:00.000Z' };
function fixture(overrides = {}) {
	const sub = { ...subscription, ...overrides.subscription };
	const projected = { ...billing, ...overrides.billing };
	const stripe = {
		products: { retrieve: async () => ({ id: 'prod_test', livemode: false, default_price: newPrice }) },
		prices: { retrieve: async (id) => id === oldPrice.id ? oldPrice : newPrice },
		subscriptions: { retrieve: async (id) => id === 'sub_ended' ? { ...sub, id, status: 'canceled' } : sub, list: async () => ({ data: [] }) },
		invoices: { retrieve: async () => ({ id: 'in_test', subscription: 'sub_test', status: 'paid', livemode: false }) },
		billingPortal: { configurations: { retrieve: async () => ({ livemode: false, features: { subscription_update: { enabled: false } } }) } },
		testClocks: { retrieve: async () => ({ id: 'clock_test', livemode: false, status: 'ready' }) },
		request: async () => { throw Object.assign(new Error('forbidden'), { status: 403 }); },
	};
	const collections = { users: { findOne: async () => ({ billing: projected }) } };
	return { stripe, collections };
}
async function run(scenario, args, overrides = {}) {
	const deps = fixture(overrides);
	return verifySandboxScenario({ scenario, environment, args: { account: '42', subscription: 'sub_test', oldPrice: 'price_old', newPrice: 'price_new', invoice: 'in_test', clock: 'clock_test', apiKey: 'rk_test_fake', ...args }, ...deps });
}

test('price increases and decreases preserve old subscriber price', async () => {
	assert.equal((await run('price-increase')).scenario, 'price-increase');
	const deps = fixture();
	deps.stripe.products.retrieve = async () => ({ livemode: false, default_price: oldPrice });
	deps.stripe.prices.retrieve = async (id) => id === 'price_old' ? { ...oldPrice, unit_amount: 700 } : { ...newPrice, unit_amount: 500 };
	await assert.rejects(() => verifySandboxScenario({ scenario: 'price-decrease', environment, args: { oldPrice: 'price_old', newPrice: 'price_new', subscription: 'sub_test', account: '42' }, ...deps }), /default_price_not_changed/);
	deps.stripe.products.retrieve = async () => ({ livemode: false, default_price: newPrice });
	assert.equal((await verifySandboxScenario({ scenario: 'price-decrease', environment, args: { oldPrice: 'price_old', newPrice: 'price_new', subscription: 'sub_test', account: '42' }, ...deps })).scenario, 'price-decrease');
});

test('archived renewal and portal preservation read subscriber price', async () => {
	assert.equal((await run('archived-renewal')).verified.length, 3);
	assert.equal((await run('portal-preservation')).verified.length, 3);
});

test('return uses current price only after old subscription ended', async () => {
	const deps = fixture({ subscription: { items: { data: [{ price: newPrice }] } }, billing: { priceId: 'price_new' } });
	assert.equal((await verifySandboxScenario({ scenario: 'return-after-cancellation', environment, args: { oldSubscription: 'sub_ended', subscription: 'sub_test', account: '42' }, ...deps })).scenario, 'return-after-cancellation');
	await assert.rejects(() => run('return-after-cancellation', { oldSubscription: 'sub_ended' }), /return_not_current_price/);
	assert.equal((await run('reverse-cancellation')).scenario, 'reverse-cancellation');
});

test('clock renewal, payment failure, and cancellation are checked against projection', async () => {
	assert.equal((await run('test-clock-renewal', { previousPaidThrough: '2026-10-01T00:00:00.000Z' })).scenario, 'test-clock-renewal');
	const failure = fixture({ subscription: { status: 'past_due' }, billing: { status: 'past_due', paymentGraceUntil: '2026-11-04T00:00:00.000Z' } });
	failure.stripe.invoices.retrieve = async () => ({ id: 'in_test', subscription: 'sub_test', status: 'open', livemode: false });
	assert.equal((await verifySandboxScenario({ scenario: 'payment-failure', environment, args: { subscription: 'sub_test', invoice: 'in_test', account: '42' }, ...failure })).scenario, 'payment-failure');
	assert.equal((await run('cancel', {}, { subscription: { cancel_at_period_end: true }, billing: { cancelAtPeriodEnd: true } })).scenario, 'cancel');
});

test('restricted key and live mode guards fail closed', async () => {
	assert.equal((await run('restricted-key')).scenario, 'restricted-key');
	await assert.rejects(() => verifySandboxScenario({ scenario: 'restricted-key', environment: { ...environment, livemode: true }, args: { apiKey: 'rk_live_fake' }, ...fixture() }), /sandbox_only/);
	await assert.rejects(() => run('restricted-key', { apiKey: 'sk_test_fake' }), /restricted_test_key_required/);
});

test('staging boundary verifies a distinct database and reaches only staging', async () => {
	const deps = fixture();
	const checked = [];
	const fetchImpl = async (url) => { checked.push(url.toString()); return { ok: true }; };
	const args = { stagingUrl: 'https://staging.example.test', database: 'sandbox_db', productionDb: 'production_db' };
	assert.equal((await verifySandboxScenario({ scenario: 'staging-boundary', environment, args, ...deps, fetchImpl })).scenario, 'staging-boundary');
	assert.deepEqual(checked, ['https://staging.example.test/api/billing/catalog']);
	await assert.rejects(() => verifySandboxScenario({ scenario: 'staging-boundary', environment, args: { ...args, database: 'production_db' }, ...deps, fetchImpl }), /database_not_isolated/);
	await assert.rejects(() => verifySandboxScenario({ scenario: 'staging-boundary', environment, args: { ...args, stagingUrl: 'https://zeroagenthq.com' }, ...deps, fetchImpl }), /production_host_refused/);
});

test('restricted-key proof uses the real client methods and needs balance to return 403', async () => {
	const { createStripeClient } = await import('../api/_lib/stripe-client.js');
	const requests = [];
	const fetchImpl = async (url) => {
		const path = new URL(url).pathname;
		requests.push(path);
		if (path === '/v1/products/prod_test') return new Response(JSON.stringify({ id: 'prod_test', livemode: false, default_price: 'price_new' }), { status: 200 });
		if (path === '/v1/subscriptions') return new Response(JSON.stringify({ data: [] }), { status: 200 });
		return new Response(JSON.stringify({ error: { type: 'invalid_request_error', code: 'permission_denied' } }), { status: 403 });
	};
	const stripe = createStripeClient({ apiKey: 'rk_test_fake', fetchImpl });
	const result = await verifySandboxScenario({ scenario: 'restricted-key', stripe, environment, args: { apiKey: 'rk_test_fake' }, collections: {} });
	assert.equal(result.scenario, 'restricted-key');
	assert.deepEqual(requests, ['/v1/products/prod_test', '/v1/subscriptions', '/v1/balance']);
	const permissive = createStripeClient({ apiKey: 'rk_test_fake', fetchImpl: async (url) => new Response(JSON.stringify(new URL(url).pathname === '/v1/products/prod_test' ? { id: 'prod_test', livemode: false } : { data: [], available: [] }), { status: 200 }) });
	await assert.rejects(() => verifySandboxScenario({ scenario: 'restricted-key', stripe: permissive, environment, args: { apiKey: 'rk_test_fake' }, collections: {} }), /forbidden_read_not_denied/);
});

test('staging boundary rejects every production subdomain', async () => {
	const deps = fixture();
	for (const stagingUrl of ['https://zeroagenthq.com', 'https://api.zeroagenthq.com', 'https://deep.api.zeroagenthq.com', 'https://api.zeroagenthq.com.']) {
		await assert.rejects(() => verifySandboxScenario({ scenario: 'staging-boundary', environment, args: { stagingUrl, database: 'sandbox_db', productionDb: 'production_db' }, ...deps, fetchImpl: async () => { throw Error('network should not be used'); } }), /production_host_refused/);
	}
});

test('the real Stripe client exposes invoice retrieve for lifecycle proofs', async () => {
	const { createStripeClient } = await import('../api/_lib/stripe-client.js');
	const requests = [];
	const stripe = createStripeClient({ apiKey: 'rk_test_fake', fetchImpl: async (url) => {
		requests.push(new URL(url).pathname);
		return new Response(JSON.stringify({ id: 'in_test', livemode: false, status: 'paid' }), { status: 200 });
	} });
	const invoice = await stripe.invoices.retrieve('in_test');
	assert.equal(invoice.id, 'in_test');
	assert.deepEqual(requests, ['/v1/invoices/in_test']);
});

// Stripe API 2026-09-30.endive drops `invoice.subscription`; the id lives under
// `parent.subscription_details.subscription`. Both shapes must satisfy the proofs.
const invoiceShapes = {
	legacy: (subscriptionId, status) => ({ id: 'in_test', subscription: subscriptionId, status, livemode: false }),
	endive: (subscriptionId, status) => ({ id: 'in_test', status, livemode: false, parent: { subscription_details: { subscription: subscriptionId } } }),
};
const invoiceScenarios = [
	{ scenario: 'archived-renewal', status: 'paid', code: /renewal_not_paid/, args: {}, overrides: {} },
	{ scenario: 'test-clock-renewal', status: 'paid', code: /renewal_not_paid/, args: { previousPaidThrough: '2026-10-01T00:00:00.000Z' }, overrides: {} },
	{ scenario: 'payment-failure', status: 'open', code: /invoice_not_failed/, args: {}, overrides: { subscription: { status: 'past_due' }, billing: { status: 'past_due', paymentGraceUntil: '2026-11-04T00:00:00.000Z' } } },
];
for (const [shape, build] of Object.entries(invoiceShapes)) {
	for (const { scenario, status, code, args, overrides } of invoiceScenarios) {
		test(`${scenario} reads the ${shape} invoice shape`, async () => {
			const matching = fixture(overrides);
			matching.stripe.invoices.retrieve = async () => build('sub_test', status);
			const base = { account: '42', subscription: 'sub_test', oldPrice: 'price_old', invoice: 'in_test', clock: 'clock_test', ...args };
			assert.equal((await verifySandboxScenario({ scenario, environment, args: base, ...matching })).scenario, scenario);
			const wrong = fixture(overrides);
			wrong.stripe.invoices.retrieve = async () => build('sub_other', status);
			await assert.rejects(() => verifySandboxScenario({ scenario, environment, args: base, ...wrong }), code);
			const missing = fixture(overrides);
			missing.stripe.invoices.retrieve = async () => ({ id: 'in_test', status, livemode: false });
			await assert.rejects(() => verifySandboxScenario({ scenario, environment, args: base, ...missing }), code);
		});
	}
}
