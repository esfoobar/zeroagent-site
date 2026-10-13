import { requireBrowserSession, requireCsrf, requireRecentAuth, sendJson, baseUrl } from '../web-auth.js';
import { loadBillingEnvironment, assertLivemode } from '../billing-config.js';
import { getCurrentOffer, resolveCurrentSalePrice, getCatalogStateWithCollection } from '../billing-catalog.js';
import { projectEntitlement } from '../billing-projection.js';
import { getBillingStore } from '../billing-store.js';
import { createStripeClient } from '../stripe-client.js';
import { createCheckout, ownedCustomer, customerIdFor } from '../billing-purchase.js';

async function context(deps) {
	const environment = deps.environment || loadBillingEnvironment();
	const store = deps.store || await getBillingStore();
	const stripe = deps.stripe || createStripeClient({ apiKey: process.env.STRIPE_API_KEY });
	return { environment, store, stripe };
}

function failure(res, error = 'billing_unavailable') {
	sendJson(res, 503, { error });
}

export async function catalog(req, res, deps = {}) {
	if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' });
	try {
		const { environment, store, stripe } = await context(deps);
		const offer = await getCurrentOffer({ stripe, environment, catalog: store.collections.catalog });
		res.setHeader('Cache-Control', 'public, max-age=60');
		sendJson(res, 200, offer);
		res.setHeader('Cache-Control', 'public, max-age=60');
	} catch { failure(res); }
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

export async function status(req, res, deps = {}) {
	if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' });
	const auth = await authenticated(req, res, deps);
	if (!auth) return;
	try {
		const { environment, store } = await context(deps);
		const account = await store.collections.users.findOne({ _id: auth.session.githubId });
		if (!account) return sendJson(res, 404, { error: 'account_not_found' });
		const entitlement = projectEntitlement(account, deps.now || new Date());
		const key = `${environment.stripeAccountId}:${environment.environment}:${account._id}`;
		const attempt = await store.collections.purchases.findOne({ _id: key });
		let checkoutState = null;
		if (attempt && attempt.state === 'creating') checkoutState = 'checkout_pending';
		else if (attempt && attempt.state === 'open' && new Date(attempt.expiresAt).getTime() > (deps.now || new Date()).getTime()) checkoutState = 'checkout_pending';
		else if (attempt && attempt.state === 'open' && entitlement.billingStatus === 'none') checkoutState = 'confirming_payment';
		sendJson(res, 200, { account: `acct_gh${account._id}`, ...entitlement, checkoutState });
	} catch { failure(res); }
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
	} catch { failure(res); }
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
		const session = await stripe.billingPortal.sessions.create({ customer: customer.id, configuration: environment.portalConfigurationId, return_url: `${baseUrl()}/billing?portal=return` });
		assertLivemode(environment, session, 'Portal Session');
		if (!session.url) throw new Error('missing portal URL');
		sendJson(res, 200, { url: session.url });
	} catch { failure(res); }
}
