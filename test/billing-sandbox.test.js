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
