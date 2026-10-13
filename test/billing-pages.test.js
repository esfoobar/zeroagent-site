import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFile(join(root, path), 'utf8');
const pricingSource = await read('static/js/zeroagent-pricing.js');
const viewSource = await read('static/js/zeroagent-billing-view.js');
const controllerSource = await read('static/js/zeroagent-billing.js');

const NOW = new Date('2026-10-13T12:00:00.000Z');
const CTX = { now: NOW, timeZone: 'UTC' };

function load(extra = {}) {
	const context = { Intl, Date, URLSearchParams, JSON, Math, ...extra };
	context.window = context;
	vm.createContext(context);
	vm.runInContext(pricingSource, context);
	vm.runInContext(viewSource, context);
	return context;
}
const { ZeroAgentBillingView: View, ZeroAgentPricing: Pricing } = load();

const offerOf = (unitAmount, currency = 'usd', interval = 'month') => ({ status: 'available', priceId: 'price_x', unitAmount, currency, interval });
const base = { billingStatus: 'none', trialEnds: null, planUntil: null, accessUntil: null, paymentGraceUntil: null, cancelAtPeriodEnd: false, checkoutState: null, subscription: null, hasBillingHistory: false };
const text = (view) => [view.title, ...view.lines, view.notice || ''].join(' ');
const ids = (view) => Array.from(view.actions, (a) => a.id);

// Arbitrary amounts on purpose: nothing may privilege one.
test('price text comes from the data, for any amount, currency and interval', () => {
	assert.equal(Pricing.priceText({ unitAmount: 700, currency: 'usd', interval: 'month' }), '$7 a month');
	assert.equal(Pricing.priceText({ unitAmount: 1250, currency: 'usd', interval: 'month' }), '$12.50 a month');
	assert.equal(Pricing.priceText({ unitAmount: 90, currency: 'usd', interval: 'year' }), '$0.90 a year');
	assert.equal(Pricing.priceText({ unitAmount: 500, currency: 'jpy', interval: 'month' }), '¥500 a month');
	assert.equal(Pricing.priceText({ unitAmount: 300, currency: 'eur' }), '€3');
	assert.equal(Pricing.priceText({ unitAmount: null, currency: 'usd', interval: 'month' }), null);
	assert.equal(Pricing.priceText(null), null);
});

test('signed-in free account: current offer and Subscribe, no trial text', () => {
	const v = View.viewFor(base, offerOf(1100), { ...CTX, page: 'plan' });
	assert.equal(v.state, 'free');
	assert.match(text(v), /Premium is \$11 a month\./);
	assert.deepEqual(ids(v), ['subscribe']);
	assert.doesNotMatch(text(v), /trial/i);
});

test('trial: exact end, days left, card-free, immediate billing explained before Subscribe', () => {
	const status = { ...base, trialEnds: '2026-10-20T15:30:00.000Z' };
	const v = View.viewFor(status, offerOf(800), { ...CTX, page: 'plan' });
	assert.equal(v.state, 'trial');
	assert.match(text(v), /ends on October 20, 2026 at 3:30 PM UTC \(8 days left\)/);
	assert.match(text(v), /card-free/);
	assert.match(text(v), /nothing is charged automatically/);
	assert.match(text(v), /Subscribing starts billing immediately/);
	assert.deepEqual(ids(v), ['subscribe']);
	const b = View.viewFor(status, null, { ...CTX, page: 'billing' });
	assert.match(text(b), /card-free/);
	assert.deepEqual(ids(b), []);
});

test('trial expired: ended date, free desktop remains, Subscribe; billing links to Plan', () => {
	const status = { ...base, trialEnds: '2026-10-01T00:00:00.000Z' };
	const v = View.viewFor(status, offerOf(800), { ...CTX, page: 'plan' });
	assert.equal(v.state, 'trial_expired');
	assert.match(text(v), /ended on October 1, 2026/);
	assert.match(text(v), /free for local work/);
	assert.deepEqual(ids(v), ['subscribe']);
	const b = View.viewFor({ ...status, hasBillingHistory: true }, null, { ...CTX, page: 'billing' });
	assert.deepEqual(ids(b), ['plan-link', 'portal']);
	assert.match(text(b), /no active subscription/);
});

test('active: the subscriber sees their own price, never the current offer', () => {
	const status = { ...base, billingStatus: 'active', planUntil: '2026-11-13T00:00:00.000Z', subscription: { unitAmount: 500, currency: 'usd', interval: 'month' } };
	const v = View.viewFor(status, offerOf(900), { ...CTX, page: 'plan' });
	assert.equal(v.state, 'active');
	assert.match(text(v), /Your subscription is \$5 a month\./);
	assert.doesNotMatch(text(v), /\$9/);
	assert.match(text(v), /renews on November 13, 2026/);
	assert.deepEqual(ids(v), ['portal']);
	assert.equal(v.actions[0].label, 'Manage billing');
	const b = View.viewFor(status, offerOf(900), { ...CTX, page: 'billing' });
	assert.deepEqual(ids(b), ['portal']);
	assert.match(text(b), /payment method, view invoices and cancel/);
});

test('active with an unreadable subscription price states no number', () => {
	const status = { ...base, billingStatus: 'active', planUntil: '2026-11-13T00:00:00.000Z' };
	const v = View.viewFor(status, offerOf(900), { ...CTX, page: 'plan' });
	assert.doesNotMatch(text(v), /\d+ a month|\$/);
});

test('past due: payment issue, exact deadline, no second Subscribe', () => {
	const status = { ...base, billingStatus: 'past_due', planUntil: '2026-10-10T00:00:00.000Z', accessUntil: '2026-10-17T00:00:00.000Z', paymentGraceUntil: '2026-10-17T00:00:00.000Z', subscription: { unitAmount: 500, currency: 'usd', interval: 'month' } };
	for (const page of ['plan', 'billing']) {
		const v = View.viewFor(status, offerOf(900), { ...CTX, page });
		assert.equal(v.state, 'past_due');
		assert.match(text(v), /could not collect/);
		assert.match(text(v), /until October 17, 2026/);
		assert.deepEqual(ids(v), ['portal']);
		assert.ok(!ids(v).includes('subscribe'));
	}
});

test('cancelled but paid through: ends on the date, no renewal, access remains', () => {
	const status = { ...base, billingStatus: 'cancel_scheduled', cancelAtPeriodEnd: true, planUntil: '2026-11-13T00:00:00.000Z', subscription: { unitAmount: 500, currency: 'usd', interval: 'month' } };
	const v = View.viewFor(status, offerOf(900), { ...CTX, page: 'plan' });
	assert.equal(v.state, 'cancel_scheduled');
	assert.match(text(v), /Ends on November 13, 2026\./);
	assert.match(text(v), /will not renew/);
	assert.match(text(v), /stays available until then/);
	assert.match(text(v), /your current price/);
	assert.doesNotMatch(text(v), /renews on/);
	assert.deepEqual(ids(v), ['portal']);
});

test('fully ended: free, paid-through date, subscribe again at the current price', () => {
	const status = { ...base, billingStatus: 'ended', plan: 'free', planUntil: '2026-09-30T00:00:00.000Z', hasBillingHistory: true };
	const v = View.viewFor(status, offerOf(1000), { ...CTX, page: 'plan' });
	assert.equal(v.state, 'ended');
	assert.match(text(v), /paid through September 30, 2026/);
	assert.match(text(v), /new subscription at the current price/);
	assert.match(text(v), /Premium is \$10 a month/);
	assert.deepEqual(ids(v), ['subscribe']);
	assert.equal(v.actions[0].label, 'Subscribe again');
	const b = View.viewFor(status, null, { ...CTX, page: 'billing' });
	assert.deepEqual(ids(b), ['plan-link', 'portal']);
});

test('payment processing: Confirming payment, Refresh, no duplicate purchase on either page', () => {
	for (const checkoutState of ['confirming_payment']) {
		for (const page of ['plan', 'billing']) {
			const v = View.viewFor({ ...base, checkoutState }, offerOf(700), { ...CTX, page });
			assert.equal(v.state, 'confirming');
			assert.equal(v.title, 'Confirming payment');
			assert.deepEqual(ids(v), ['refresh']);
			assert.equal(v.polling, true);
			assert.doesNotMatch(text(v), /thank you|you are subscribed|payment received/i);
		}
	}
});

test('an open checkout elsewhere offers to continue it, and says nothing is charged yet', () => {
	const v = View.viewFor({ ...base, checkoutState: 'checkout_pending' }, offerOf(700), { ...CTX, page: 'plan' });
	assert.equal(v.state, 'checkout_open');
	assert.match(text(v), /Nothing is charged until you complete it/);
	assert.deepEqual(ids(v), ['subscribe']);
	assert.equal(v.actions[0].label, 'Continue to checkout');
	assert.equal(v.polling, false);
});

test('?checkout=returned is only a hint: it polls, hides Subscribe, and never says paid', () => {
	const v = View.viewFor(base, offerOf(700), { ...CTX, page: 'plan', returned: true });
	assert.equal(v.polling, true);
	assert.equal(v.awaiting, true);
	assert.ok(!ids(v).includes('subscribe'));
	assert.ok(ids(v).includes('refresh'));
	assert.match(v.notice, /Checking for your payment/);
	assert.doesNotMatch(text(v), /subscribed|thank you|paid/i);
	const late = View.viewFor(base, offerOf(700), { ...CTX, page: 'plan', returned: true, timedOut: true });
	assert.equal(late.polling, false);
	assert.match(late.notice, /have not confirmed a payment yet/);
	assert.ok(ids(late).includes('refresh'));
});

test('the return hint changes nothing once the server says active', () => {
	const status = { ...base, billingStatus: 'active', planUntil: '2026-11-13T00:00:00.000Z', subscription: { unitAmount: 500, currency: 'usd', interval: 'month' } };
	const v = View.viewFor(status, offerOf(700), { ...CTX, page: 'plan', returned: true });
	assert.equal(v.state, 'active');
	assert.equal(v.polling, false);
	assert.equal(v.notice, null);
});

test('paused sales and an unreadable catalog state no number and offer no Subscribe', () => {
	for (const offer of [{ status: 'paused' }, { status: 'unavailable', reason: 'no_default_price' }, null]) {
		const v = View.viewFor(base, offer, { ...CTX, page: 'plan' });
		assert.deepEqual(ids(v), []);
		assert.doesNotMatch(text(v), /\$|\d+ a month/);
	}
});

test('a legacy grant has no subscription to manage and no Subscribe', () => {
	const v = View.viewFor({ ...base, billingStatus: 'legacy_grant' }, offerOf(700), { ...CTX, page: 'plan' });
	assert.equal(v.state, 'legacy');
	assert.deepEqual(ids(v), []);
});

test('Checkout answers: redirect, price changed, already subscribed, paused, pending, 401, 503', () => {
	const ok = View.interpretCheckout(200, { url: 'https://checkout.stripe.com/c/pay/cs_1' });
	assert.deepEqual({ ...ok }, { kind: 'redirect', url: 'https://checkout.stripe.com/c/pay/cs_1' });
	assert.equal(View.interpretCheckout(200, { url: 'https://evil.example/stripe.com' }).kind, 'unavailable');
	assert.equal(View.interpretCheckout(200, { url: 'http://checkout.stripe.com/x' }).kind, 'unavailable');
	const changed = View.interpretCheckout(409, { error: 'price_changed', offer: offerOf(1300) });
	assert.equal(changed.kind, 'price_changed');
	assert.equal(changed.priceText, '$13 a month');
	assert.equal(View.interpretCheckout(409, { error: 'price_changed', offer: { status: 'unavailable' } }).kind, 'unavailable');
	assert.equal(View.interpretCheckout(409, { error: 'already_subscribed' }).kind, 'already_subscribed');
	assert.equal(View.interpretCheckout(409, { error: 'sales_paused' }).kind, 'sales_paused');
	assert.equal(View.interpretCheckout(202, { status: 'checkout_pending' }).kind, 'pending');
	assert.equal(View.interpretCheckout(401, { error: 'unauthorized' }).kind, 'sign_in');
	assert.equal(View.interpretCheckout(403, { error: 'bad_csrf' }).kind, 'session_stale');
	assert.equal(View.interpretCheckout(503, { error: 'billing_unavailable' }).kind, 'unavailable');
	assert.equal(View.interpretCheckout(500, null).kind, 'unavailable');
});

test('portal answers: redirect, recent-auth step-up, signed out, no customer, 503', () => {
	assert.equal(View.interpretPortal(200, { url: 'https://billing.stripe.com/p/session/x' }).kind, 'redirect');
	assert.equal(View.interpretPortal(401, { error: 'recent_auth_required' }).kind, 'reauth');
	assert.equal(View.interpretPortal(401, { error: 'unauthorized' }).kind, 'sign_in');
	assert.equal(View.interpretPortal(404, { error: 'customer_not_found' }).kind, 'no_customer');
	assert.equal(View.interpretPortal(503, { error: 'billing_unavailable' }).kind, 'unavailable');
});

// ---- marketing copy -------------------------------------------------------

function fakeNodes(count) {
	return Array.from({ length: count }, () => ({ textContent: 'a monthly subscription' }));
}
function copyRun(routes) {
	const nodes = fakeNodes(2);
	const calls = [];
	const context = load({
		document: {
			readyState: 'complete',
			querySelector: () => nodes[0],
			querySelectorAll: () => nodes,
			addEventListener() {},
		},
		fetch: (url, init) => {
			calls.push({ url, init });
			const r = routes[url];
			return r ? Promise.resolve({ ok: r.ok, json: () => Promise.resolve(r.body) }) : Promise.reject(new Error('offline'));
		},
	});
	return { nodes, calls, flush: () => new Promise((resolve) => setTimeout(resolve, 5)), context };
}

test('copy shows the catalog offer to a visitor', async () => {
	const t = copyRun({
		'/api/billing/status': { ok: false, body: { error: 'unauthorized' } },
		'/api/billing/catalog': { ok: true, body: offerOf(1700) },
	});
	await t.flush();
	assert.deepEqual(t.nodes.map((n) => n.textContent), ['$17 a month', '$17 a month']);
});

test('copy shows an existing subscriber their own price, not the current offer', async () => {
	const t = copyRun({
		'/api/billing/status': { ok: true, body: { subscription: { unitAmount: 400, currency: 'usd', interval: 'month' } } },
		'/api/billing/catalog': { ok: true, body: offerOf(1700) },
	});
	await t.flush();
	assert.deepEqual(t.nodes.map((n) => n.textContent), ['$4 a month', '$4 a month']);
});

test('copy keeps its no-number fallback when nothing can be read or the catalog is paused', async () => {
	const down = copyRun({});
	await down.flush();
	assert.deepEqual(down.nodes.map((n) => n.textContent), ['a monthly subscription', 'a monthly subscription']);
	const paused = copyRun({ '/api/billing/status': { ok: false, body: {} }, '/api/billing/catalog': { ok: true, body: { status: 'paused' } } });
	await paused.flush();
	assert.equal(paused.nodes[0].textContent, 'a monthly subscription');
});

// ---- page and repository rules --------------------------------------------

async function served(dir = root) {
	const out = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		if (['node_modules', '.zeroagent', '.git', 'test', 'docs', 'scripts', 'api'].includes(entry.name)) continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await served(full)));
		else if (/\.(html|js|css|xml|json|webmanifest)$/.test(entry.name) && entry.name !== 'package-lock.json') out.push(full);
	}
	return out;
}

test('no served page or script hard-codes a price', async () => {
	const files = await served();
	assert.ok(files.length > 15);
	for (const file of files) {
		const body = await readFile(file, 'utf8');
		assert.doesNotMatch(body, /\$\s?\d/, `${file} carries a dollar amount`);
		assert.doesNotMatch(body, /\b\d+(\.\d+)?\s*(USD|dollars?)\b/i, `${file} carries a priced amount`);
		assert.doesNotMatch(body, /\b\d+\s*(a|per|\/)\s*(month|mo|year)\b/i, `${file} carries a per-interval price`);
	}
});

test('every price phrase on the homepage is a dynamic element with a no-number fallback', async () => {
	const home = await read('index.html');
	const spans = home.match(/<span data-za-price>[^<]*<\/span>/g) || [];
	assert.equal(spans.length, 3);
	for (const span of spans) assert.doesNotMatch(span, /\d/);
	assert.match(home, /zeroagent-pricing\.js/);
});

for (const [path, key] of [['account/plan/index.html', 'plan'], ['billing/index.html', 'billing']]) {
	test(`${path}: private, no card fields, no analytics, accessible states`, async () => {
		const html = await read(path);
		assert.match(html, /<meta name="robots" content="noindex, nofollow"/);
		assert.doesNotMatch(html, /<input|<form|<select|<textarea/i);
		assert.doesNotMatch(html, /googletagmanager|gtag|zeroagent-ga\.js|google-analytics/i);
		assert.doesNotMatch(html, /js\.stripe\.com|Elements/);
		assert.match(html, /id="za-billing-loading" role="status"/);
		assert.match(html, /id="za-billing-error" class="za-billing-error" role="alert"/);
		assert.match(html, /id="za-billing-message" role="status"/);
		assert.match(html, /<noscript>/);
		assert.match(html, /aria-current="page"/);
		assert.match(html, new RegExp(`<body data-za-page="${key}">`));
		assert.match(html, new RegExp(`start\\?return=${key === 'plan' ? '/account/plan' : '/billing'}"`));
		for (const script of ['zeroagent-pricing.js', 'zeroagent-billing-view.js', 'zeroagent-billing.js']) assert.match(html, new RegExp(script));
	});
}

test('the new pages stay out of the sitemap and robots.txt like /account', async () => {
	const sitemap = await read('sitemap.xml');
	const robots = await read('robots.txt');
	for (const path of ['/account', '/billing']) {
		assert.doesNotMatch(sitemap, new RegExp(`${path}<`));
		assert.doesNotMatch(robots, new RegExp(path));
	}
});

test('the billing scripts send no analytics event and keep the CSRF token in memory', () => {
	assert.doesNotMatch(controllerSource, /gtag|dataLayer|localStorage|sessionStorage|document\.cookie/);
	assert.doesNotMatch(viewSource + pricingSource, /gtag|dataLayer|localStorage|sessionStorage|document\.cookie/);
});

test('the homepage script fetches the catalog cacheable and credential free, and status uncached', async () => {
	const t = copyRun({
		'/api/billing/status': { ok: false, body: {} },
		'/api/billing/catalog': { ok: true, body: offerOf(700) },
	});
	await t.flush();
	const catalog = t.calls.find((c) => c.url === '/api/billing/catalog');
	const status = t.calls.find((c) => c.url === '/api/billing/status');
	assert.ok(catalog && status);
	assert.equal(catalog.init.cache, undefined, 'default caching');
	assert.equal(catalog.init.credentials, 'omit');
	assert.equal(status.init.cache, 'no-store');
	assert.equal(status.init.credentials, 'same-origin');
});

test('an unconfigured catalog answer is the no-number fallback in copy and pages', async () => {
	const body = { status: 'unavailable', reason: 'not_configured' };
	const t = copyRun({ '/api/billing/status': { ok: false, body: {} }, '/api/billing/catalog': { ok: true, body } });
	await t.flush();
	assert.equal(t.nodes[0].textContent, 'a monthly subscription');
	const v = View.viewFor(base, body, { ...CTX, page: 'plan' });
	assert.deepEqual(ids(v), []);
	assert.doesNotMatch(text(v), /\$|\d+ a month/);
});
