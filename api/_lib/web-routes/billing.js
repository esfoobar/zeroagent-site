import { requireBrowserSession, requireCsrf, requireRecentAuth, sendJson, baseUrl } from '../web-auth.js';
import { BILLING_ENV_VARS, loadBillingEnvironment, assertLivemode } from '../billing-config.js';
import { getCurrentOffer, resolveCurrentSalePrice, getCatalogStateWithCollection } from '../billing-catalog.js';
import { projectEntitlement } from '../billing-projection.js';
import { getBillingStore } from '../billing-store.js';
import { createStripeClient } from '../stripe-client.js';
import { BillingIntegrityError, createCheckout, ownedCustomer, customerIdFor } from '../billing-purchase.js';

async function context(deps) {
	const environment = deps.environment || loadBillingEnvironment();
	const store = deps.store || await getBillingStore();
	const stripe = deps.stripe || createStripeClient({
		apiKey: process.env[BILLING_ENV_VARS.apiKey],
		apiVersion: process.env[BILLING_ENV_VARS.apiVersion] || null,
	});
	return { environment, store, stripe };
}

function logFailure(error) {
	console.error('billing route failure', error.name || 'Error', error.code || 'unknown');
}

function failure(res, error = null) {
	if (error) logFailure(error);
	sendJson(res, 503, { error: 'billing_unavailable' });
}

export async function catalog(req, res, deps = {}) {
	if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' });
	try {
		const { environment, store, stripe } = await context(deps);
		const offer = await getCurrentOffer({ stripe, environment, catalog: store.collections.catalog });
		sendJson(res, 200, offer, { cacheControl: 'public, max-age=60' });
	} catch (error) { failure(res, error); }
}

async function authenticated(req, res, deps, mutation = false, recent = false) {
	const auth = await requireBrowserSession(req, deps);
	if (!auth.ok) { sendJson(res, auth.status, { error: auth.error }); return null; }
	if (mutation) {
		const csrf = requireCsrf(req, auth);
		if (!csrf.ok) { sendJson(res, csrf.status, { error: csrf.error }); return null; }
	}
	if (recent) {
		const check = requireRecentAuth(auth.session, { now: deps.now || new Date() });
		if (!check.ok) { sendJson(res, check.status, { error: check.error }); return null; }
	}
	return auth;
}

// The subscriber's own Price, for display only: what their subscription was
// bought at, which may be an archived Price and may differ from the current
// offer. Never falls back to the current offer: an unreadable Price is null
// and the page states no number. Entitlement never reads this.
async function subscriberPrice({ stripe, environment, billing }) {
	const priceId = billing && typeof billing.priceId === 'string' && billing.priceId ? billing.priceId : null;
	if (!priceId) return null;
	try {
		const price = await stripe.prices.retrieve(priceId);
		assertLivemode(environment, price, 'subscription Price');
		const product = typeof price.product === 'string' ? price.product : price.product && price.product.id;
		if (price.id !== priceId || product !== environment.productId) return null;
		return {
			unitAmount: Number.isInteger(price.unit_amount) ? price.unit_amount : null,
			currency: typeof price.currency === 'string' ? price.currency : null,
			interval: price.recurring ? price.recurring.interval : null,
		};
	} catch (error) {
		logFailure(error);
		return null;
	}
}

function hasCustomer(account, environment) {
	const mapped = account.billingCustomer;
	if (mapped && mapped.customerId && mapped.stripeAccountId === environment.stripeAccountId && mapped.livemode === environment.livemode) return true;
	const billing = account.billing;
	return Boolean(billing && billing.customerId && (!billing.stripeAccountId || billing.stripeAccountId === environment.stripeAccountId));
}

export async function status(req, res, deps = {}) {
	if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' });
	const auth = await authenticated(req, res, deps);
	if (!auth) return;
	try {
		const { environment, store, stripe } = await context(deps);
		const account = await store.collections.users.findOne({ _id: auth.session.githubId });
		if (!account) return sendJson(res, 404, { error: 'account_not_found' });
		const entitlement = projectEntitlement(account, deps.now || new Date());
		const key = `${environment.stripeAccountId}:${environment.environment}:${account._id}`;
		const attempt = await store.collections.purchases.findOne({ _id: key });
		let checkoutState = null;
		if (!['active', 'cancel_scheduled', 'past_due'].includes(entitlement.billingStatus) && attempt) {
			if (attempt.state === 'creating' && (deps.now || new Date()).getTime() - new Date(attempt.createdAt).getTime() < 60000) checkoutState = 'checkout_pending';
			else if (attempt.sessionId) {
				let session;
				try {
					session = await stripe.checkout.sessions.retrieve(attempt.sessionId);
				} catch (error) {
					logFailure(error);
				}
				if (session) {
					assertLivemode(environment, session, 'Checkout Session');
					if (session.customer !== attempt.customerId) throw new BillingIntegrityError('checkout_customer_mismatch');
					if (session.status === 'complete' && entitlement.billingStatus !== 'ended') checkoutState = 'confirming_payment';
					else if (session.status === 'open' && session.expires_at * 1000 > (deps.now || new Date()).getTime()) checkoutState = 'checkout_pending';
				}
			}
		}
		const subscription = ['active', 'cancel_scheduled', 'past_due'].includes(entitlement.billingStatus)
			? await subscriberPrice({ stripe, environment, billing: account.billing })
			: null;
		sendJson(res, 200, { account: `acct_gh${account._id}`, ...entitlement, checkoutState, subscription, hasBillingHistory: hasCustomer(account, environment) });
	} catch (error) { failure(res, error); }
}

export async function checkout(req, res, deps = {}) {
	if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });
	const auth = await authenticated(req, res, deps, true);
	if (!auth) return;
	try {
		const { environment, store, stripe } = await context(deps);
		const accountDoc = await store.collections.users.findOne({ _id: auth.session.githubId });
		if (!accountDoc) return sendJson(res, 404, { error: 'account_not_found' });
		const account = { ...accountDoc, githubId: accountDoc._id };
		const state = await getCatalogStateWithCollection(store.collections.catalog, { environment });
		if (state.salesPaused) return sendJson(res, 409, { error: 'sales_paused' });
		const offer = await resolveCurrentSalePrice({ stripe, environment });
		if (!offer.available) return sendJson(res, 503, { error: 'offer_unavailable' });
		const shown = req.body?.priceId;
		if (typeof shown !== 'string' || !shown) return sendJson(res, 400, { error: 'price_required' });
		if (shown !== offer.priceId) return sendJson(res, 409, { error: 'price_changed', offer: { status: 'available', ...offer } });
		const result = await createCheckout({ stripe, users: store.collections.users, purchases: store.collections.purchases, account, environment, offer, now: deps.now || new Date(), baseUrl: baseUrl() });
		if (result.status === 'already_subscribed') return sendJson(res, 409, { error: 'already_subscribed' });
		if (result.status === 'pending') return sendJson(res, 202, { status: 'checkout_pending' });
		sendJson(res, 200, { url: result.url });
	} catch (error) { failure(res, error); }
}

export async function portal(req, res, deps = {}) {
	if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });
	const auth = await authenticated(req, res, deps, true, true);
	if (!auth) return;
	try {
		const { environment, store, stripe } = await context(deps);
		if (!environment.portalConfigurationId) return failure(res);
		const accountDoc = await store.collections.users.findOne({ _id: auth.session.githubId });
		if (!accountDoc) return sendJson(res, 404, { error: 'account_not_found' });
		const account = { ...accountDoc, githubId: accountDoc._id };
		const customer = await ownedCustomer({ stripe, account, environment });
		if (!customer || customerIdFor(account, environment) !== customer.id) return sendJson(res, 404, { error: 'customer_not_found' });
		const session = await stripe.billingPortal.sessions.create({ customer: customer.id, configuration: environment.portalConfigurationId, return_url: `${baseUrl()}/account/plan` });
		assertLivemode(environment, session, 'Portal Session');
		if (!session.url) throw new Error('missing portal URL');
		sendJson(res, 200, { url: session.url });
	} catch (error) { failure(res, error); }
}
