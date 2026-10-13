/*
 * ZA-901 / esfoobar/zeroagent#1264. The runtime catalog: which Stripe
 * Product is Premium (STRIPE_PREMIUM_PRODUCT_ID), what its default Price is
 * right now, and the auditable sales-pause control.
 *
 * No amount and no current Price id lives in code, pages, env or tests as
 * a constant. The Price is read from Stripe at request time through an
 * injected client (`stripe.products.retrieve`), and a price change is a
 * change of the Product's default_price in Stripe. Entitlement never
 * consults any of this.
 *
 * salesPaused is catalog configuration, not paid entitlement: it blocks new
 * Checkout creation (ZA-903) and nothing else. Existing subscribers, the
 * portal and webhooks are unaffected. Every change is recorded in an
 * append-only audit collection with who, when and why.
 */

import { assertLivemode } from './billing-config.js';

function catalogId(environment) {
	return `catalog:${environment.environment}`;
}

export async function getCatalogStateWithCollection(collection, { environment }) {
	const doc = await collection.findOne({ _id: catalogId(environment) });
	return {
		salesPaused: Boolean(doc && doc.salesPaused),
		changedBy: doc ? doc.changedBy ?? null : null,
		changedAt: doc ? doc.changedAt ?? null : null,
		reason: doc ? doc.reason ?? null : null,
		revision: doc && Number.isInteger(doc.revision) ? doc.revision : 0,
	};
}

// deps: { collections: { catalog, audit }, withTransaction }. `actor` and
// `reason` are required for both pausing and resuming: an unexplained
// change is refused, so the audit record is never empty.
export async function setSalesPaused(deps, { environment, paused, actor, reason, now = new Date() }) {
	if (typeof paused !== 'boolean') throw new Error('paused must be a boolean');
	if (typeof actor !== 'string' || actor.trim() === '') throw new Error('an actor is required');
	if (typeof reason !== 'string' || reason.trim() === '') throw new Error('a reason is required');
	const { catalog, audit } = deps.collections;
	const nowIso = now.toISOString();
	return deps.withTransaction(async ({ session } = {}) => {
		const options = session ? { session } : {};
		const before = await catalog.findOne({ _id: catalogId(environment) }, options);
		const revision = (before && Number.isInteger(before.revision) ? before.revision : 0) + 1;
		const state = {
			salesPaused: paused,
			changedBy: actor.trim(),
			changedAt: nowIso,
			reason: reason.trim(),
			environment: environment.environment,
			revision,
		};
		await catalog.findOneAndUpdate({ _id: catalogId(environment) }, { $set: state }, { upsert: true, returnDocument: 'after', ...options });
		await audit.insertOne(
			{
				_id: `${catalogId(environment)}:${String(revision).padStart(8, '0')}`,
				kind: 'sales_paused_changed',
				environment: environment.environment,
				from: Boolean(before && before.salesPaused),
				to: paused,
				actor: state.changedBy,
				reason: state.reason,
				at: nowIso,
				revision,
			},
			options
		);
		return state;
	});
}

function idOf(ref) {
	if (typeof ref === 'string') return ref;
	return ref && typeof ref.id === 'string' ? ref.id : null;
}

// Resolves the current-sale Price for the configured Product. `stripe` is
// an injected client exposing products.retrieve(id, { expand }). Refuses a
// Product or Price whose mode is not this environment's, an inactive
// Product or Price, and a Price that does not belong to the Product.
// Returns the display facts Stripe holds; none of it is stored.
export async function resolveCurrentSalePrice({ stripe, environment }) {
	const product = await stripe.products.retrieve(environment.productId, { expand: ['default_price'] });
	assertLivemode(environment, product, 'Premium Product');
	if (!product.active) return { available: false, reason: 'product_inactive' };
	const price = product.default_price;
	if (!price || typeof price !== 'object') return { available: false, reason: 'no_default_price' };
	assertLivemode(environment, price, 'default Price');
	if (!price.active) return { available: false, reason: 'price_inactive' };
	if (idOf(price.product) !== environment.productId) return { available: false, reason: 'price_product_mismatch' };
	return {
		available: true,
		productId: environment.productId,
		priceId: price.id,
		unitAmount: price.unit_amount ?? null,
		currency: price.currency ?? null,
		interval: price.recurring ? price.recurring.interval : null,
	};
}

// The public offer: paused wins over everything and no Stripe call is made.
export async function getCurrentOffer({ stripe, environment, catalog }) {
	const state = await getCatalogStateWithCollection(catalog, { environment });
	if (state.salesPaused) return { status: 'paused' };
	const resolved = await resolveCurrentSalePrice({ stripe, environment });
	if (!resolved.available) return { status: 'unavailable', reason: resolved.reason };
	return { status: 'available', ...resolved };
}
