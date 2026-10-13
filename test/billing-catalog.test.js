import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeBillingDb } from './_fake-mongo.js';
import { BillingModeMismatchError } from '../api/_lib/billing-config.js';
import { getCatalogStateWithCollection, getCurrentOffer, resolveCurrentSalePrice, setSalesPaused } from '../api/_lib/billing-catalog.js';

const sandbox = { stripeAccountId: 'acct_synthetic', livemode: false, environment: 'sandbox', productId: 'prod_synthetic' };
const NOW = new Date('2026-11-01T00:00:00.000Z');

function stripeWith(defaultPrice, product = {}) {
	const calls = [];
	return {
		calls,
		products: {
			async retrieve(id, params) {
				calls.push({ id, params });
				return { id, livemode: false, active: true, default_price: defaultPrice, ...product };
			},
		},
	};
}

const price = (over = {}) => ({ id: 'price_x', object: 'price', livemode: false, active: true, product: 'prod_synthetic', unit_amount: 100, currency: 'usd', recurring: { interval: 'month' }, ...over });

test('the current Price is whatever the Product default is, for any id or amount', async () => {
	for (const [id, amount, currency] of [['price_a1', 1, 'usd'], ['price_b2', 99999, 'eur'], ['price_c3', 0, 'gbp'], ['p', 12345, 'jpy']]) {
		const stripe = stripeWith(price({ id, unit_amount: amount, currency }));
		const r = await resolveCurrentSalePrice({ stripe, environment: sandbox });
		assert.equal(r.available, true);
		assert.equal(r.priceId, id);
		assert.equal(r.unitAmount, amount);
		assert.equal(r.currency, currency);
		assert.deepEqual(stripe.calls, [{ id: 'prod_synthetic', params: { expand: ['default_price'] } }]);
	}
});

test('a price change is picked up on the next call with no configuration change', async () => {
	let current = price({ id: 'price_old', unit_amount: 500 });
	const stripe = { products: { retrieve: async () => ({ id: 'prod_synthetic', livemode: false, active: true, default_price: current }) } };
	assert.equal((await resolveCurrentSalePrice({ stripe, environment: sandbox })).priceId, 'price_old');
	current = price({ id: 'price_new', unit_amount: 300 });
	assert.equal((await resolveCurrentSalePrice({ stripe, environment: sandbox })).priceId, 'price_new');
});

test('refuses a live Product or live Price in a sandbox deployment', async () => {
	await assert.rejects(resolveCurrentSalePrice({ stripe: stripeWith(price(), { livemode: true }), environment: sandbox }), BillingModeMismatchError);
	await assert.rejects(resolveCurrentSalePrice({ stripe: stripeWith(price({ livemode: true })), environment: sandbox }), BillingModeMismatchError);
});

test('unavailable, never a numeric fallback', async () => {
	assert.deepEqual(await resolveCurrentSalePrice({ stripe: stripeWith(null), environment: sandbox }), { available: false, reason: 'no_default_price' });
	assert.deepEqual(await resolveCurrentSalePrice({ stripe: stripeWith('price_unexpanded'), environment: sandbox }), { available: false, reason: 'no_default_price' });
	assert.equal((await resolveCurrentSalePrice({ stripe: stripeWith(price({ active: false })), environment: sandbox })).reason, 'price_inactive');
	assert.equal((await resolveCurrentSalePrice({ stripe: stripeWith(price(), { active: false }), environment: sandbox })).reason, 'product_inactive');
	assert.equal((await resolveCurrentSalePrice({ stripe: stripeWith(price({ product: 'prod_other' })), environment: sandbox })).reason, 'price_product_mismatch');
	assert.equal((await resolveCurrentSalePrice({ stripe: stripeWith(price({ product: { id: 'prod_synthetic' } })), environment: sandbox })).available, true);
});

test('sales pause is audited with who, when and why', async () => {
	const db = fakeBillingDb();
	const deps = { collections: db.collections, withTransaction: db.withTransaction };
	assert.equal((await getCatalogStateWithCollection(db.collections.catalog, { environment: sandbox })).salesPaused, false);

	const paused = await setSalesPaused(deps, { environment: sandbox, paused: true, actor: 'operator-1', reason: 'price cutover', now: NOW });
	assert.equal(paused.salesPaused, true);
	const resumed = await setSalesPaused(deps, { environment: sandbox, paused: false, actor: 'operator-2', reason: 'cutover verified', now: new Date(NOW.getTime() + 60000) });
	assert.equal(resumed.revision, 2);

	const audit = [...db.collections.audit.docs.values()].sort((a, b) => a.revision - b.revision);
	assert.equal(audit.length, 2);
	assert.deepEqual(
		audit.map((a) => [a.from, a.to, a.actor, a.reason, a.at]),
		[
			[false, true, 'operator-1', 'price cutover', '2026-11-01T00:00:00.000Z'],
			[true, false, 'operator-2', 'cutover verified', '2026-11-01T00:01:00.000Z'],
		]
	);
	const state = await getCatalogStateWithCollection(db.collections.catalog, { environment: sandbox });
	assert.equal(state.salesPaused, false);
	assert.equal(state.changedBy, 'operator-2');
});

test('an unexplained or anonymous change is refused and nothing is written', async () => {
	const db = fakeBillingDb();
	const deps = { collections: db.collections, withTransaction: db.withTransaction };
	for (const bad of [{ actor: '', reason: 'x' }, { actor: 'a', reason: '  ' }, { actor: undefined, reason: 'x' }]) {
		await assert.rejects(setSalesPaused(deps, { environment: sandbox, paused: true, ...bad, now: NOW }));
	}
	await assert.rejects(setSalesPaused(deps, { environment: sandbox, paused: 'yes', actor: 'a', reason: 'b' }));
	assert.equal(db.collections.catalog.docs.size, 0);
	assert.equal(db.collections.audit.docs.size, 0);
});

test('a paused catalog offers nothing and makes no Stripe call', async () => {
	const db = fakeBillingDb();
	const deps = { collections: db.collections, withTransaction: db.withTransaction };
	const stripe = stripeWith(price());
	assert.equal((await getCurrentOffer({ stripe, environment: sandbox, catalog: db.collections.catalog })).status, 'available');
	await setSalesPaused(deps, { environment: sandbox, paused: true, actor: 'a', reason: 'r', now: NOW });
	const callsBefore = stripe.calls.length;
	assert.deepEqual(await getCurrentOffer({ stripe, environment: sandbox, catalog: db.collections.catalog }), { status: 'paused' });
	assert.equal(stripe.calls.length, callsBefore);
});

test('sandbox and live catalogs are separate documents', async () => {
	const db = fakeBillingDb();
	const deps = { collections: db.collections, withTransaction: db.withTransaction };
	const live = { ...sandbox, livemode: true, environment: 'live' };
	await setSalesPaused(deps, { environment: sandbox, paused: true, actor: 'a', reason: 'r', now: NOW });
	assert.equal((await getCatalogStateWithCollection(db.collections.catalog, { environment: live })).salesPaused, false);
});
