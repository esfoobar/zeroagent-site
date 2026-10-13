// ZA-904. The Plan and Billing controller driven against a minimal fake DOM
// and a scripted fetch: Checkout and portal outcomes, the price-changed
// confirmation, the 60 second status poll, and the return hint. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');
const sources = [await read('static/js/zeroagent-pricing.js'), await read('static/js/zeroagent-billing-view.js'), await read('static/js/zeroagent-billing.js')];

const IDS = ['za-billing', 'za-billing-loading', 'za-billing-error', 'za-billing-error-text', 'za-billing-retry', 'za-billing-signedout', 'za-billing-signedout-text', 'za-billing-signin', 'za-billing-view', 'za-billing-title', 'za-billing-lines', 'za-billing-notice', 'za-billing-message', 'za-billing-confirm', 'za-billing-confirm-text', 'za-billing-confirm-yes', 'za-billing-confirm-no', 'za-billing-actions', 'za-billing-identity', 'za-billing-signout'];

function element(id, tag = 'div') {
	const node = {
		id, tag, hidden: false, disabled: false, attrs: {}, listeners: {}, children: [], _text: '', className: '', href: '',
		get textContent() { return this._text; },
		set textContent(v) { this._text = v; this.children = []; },
		setAttribute(k, v) { this.attrs[k] = v; if (k === 'href') this.href = v; },
		getAttribute(k) { return this.attrs[k]; },
		addEventListener(type, fn) { this.listeners[type] = fn; },
		appendChild(child) { this.children.push(child); return child; },
		querySelectorAll() { return this.children.filter((c) => c.tag === 'button'); },
		focus() {},
		click() { return this.listeners.click && this.listeners.click(); },
	};
	return node;
}

const offer = (priceId, unitAmount) => ({ status: 'available', priceId, unitAmount, currency: 'usd', interval: 'month' });
const session = { status: 200, body: { login: 'octo', csrfToken: 'csrf-token' } };
const FREE = { billingStatus: 'none', trialEnds: null, planUntil: null, accessUntil: null, checkoutState: null, subscription: null, hasBillingHistory: false };
const ACTIVE = { ...FREE, billingStatus: 'active', planUntil: '2027-01-01T00:00:00.000Z', subscription: { unitAmount: 500, currency: 'usd', interval: 'month' }, hasBillingHistory: true };

function boot({ page = 'plan', search = '', routes = {} } = {}) {
	const nodes = new Map(IDS.map((id) => [id, element(id, id.endsWith('-retry') || id.endsWith('-signout') || id.includes('confirm-yes') || id.includes('confirm-no') ? 'button' : 'div')]));
	nodes.get('za-billing-confirm').hidden = true;
	const requests = [];
	const assigned = [];
	const replaced = [];
	const timers = [];
	const clock = { t: 1_000_000 };
	class FakeDate extends Date { static now() { return clock.t; } }
	const queues = {};
	const context = {
		Intl, JSON, Math, URLSearchParams, Promise, Date: FakeDate,
		document: {
			body: { getAttribute: () => page },
			getElementById: (id) => nodes.get(id) || null,
			createElement: (tag) => element(null, tag),
			querySelector: () => null,
			querySelectorAll: () => [],
			addEventListener() {},
			readyState: 'complete',
		},
		location: { search, pathname: page === 'billing' ? '/billing' : '/account/plan', assign: (url) => assigned.push(url) },
		history: { replaceState: (...a) => replaced.push(a) },
		setTimeout: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; },
		clearTimeout: (timer) => { const i = timers.indexOf(timer); if (i !== -1) timers.splice(i, 1); },
		fetch: (url, init = {}) => {
			requests.push({ url, method: init.method || 'GET', headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null });
			const route = routes[url];
			let answer = typeof route === 'function' ? route(init) : route;
			if (Array.isArray(answer)) { queues[url] = queues[url] || [...answer]; answer = queues[url].length > 1 ? queues[url].shift() : queues[url][0]; }
			if (!answer) return Promise.reject(new Error('offline'));
			return Promise.resolve({ status: answer.status, json: () => Promise.resolve(answer.body) });
		},
	};
	context.window = context;
	vm.createContext(context);
	for (const source of sources) vm.runInContext(source, context);
	const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve)); };
	const actions = () => nodes.get('za-billing-actions').children;
	const by = (label) => actions().find((a) => a.textContent === label);
	return { nodes, requests, assigned, replaced, timers, clock, flush, actions, by, text: (id) => nodes.get(id).textContent };
}

const base = (extra = {}) => ({ '/api/account/session': session, '/api/billing/catalog': { status: 200, body: offer('price_a', 700) }, ...extra });

test('signed out: sign-in link keeps the page as the return path', async () => {
	const t = boot({ page: 'billing', routes: { '/api/account/session': { status: 401, body: { error: 'unauthorized' } } } });
	await t.flush();
	assert.equal(t.nodes.get('za-billing-signedout').hidden, false);
	assert.equal(t.nodes.get('za-billing-view').hidden, true);
	assert.equal(t.nodes.get('za-billing-signin').href, '/api/auth/github/start?return=/billing');
	assert.equal(t.nodes.get('za-billing').attrs['aria-busy'], 'false');
});

test('a billing outage shows an error with a retry, not a blank page', async () => {
	const t = boot({ routes: base({ '/api/billing/status': { status: 503, body: { error: 'billing_unavailable' } } }) });
	await t.flush();
	assert.equal(t.nodes.get('za-billing-error').hidden, false);
	assert.match(t.text('za-billing-error-text'), /unavailable/);
	assert.equal(t.nodes.get('za-billing-loading').hidden, true);
});

test('an unreadable catalog still renders the account and states no price', async () => {
	const t = boot({ routes: base({ '/api/billing/catalog': { status: 503, body: {} }, '/api/billing/status': { status: 200, body: FREE } }) });
	await t.flush();
	assert.equal(t.nodes.get('za-billing-view').hidden, false);
	assert.equal(t.actions().length, 0);
	assert.doesNotMatch(t.nodes.get('za-billing-lines').children.map((c) => c.textContent).join(' '), /\$/);
});

test('subscribe sends the shown Price and the CSRF token, then goes to Stripe', async () => {
	const t = boot({ routes: base({ '/api/billing/status': { status: 200, body: FREE }, '/api/billing/checkout': { status: 200, body: { url: 'https://checkout.stripe.com/c/pay/cs_1' } } }) });
	await t.flush();
	t.by('Subscribe').click();
	await t.flush();
	const post = t.requests.find((r) => r.url === '/api/billing/checkout');
	assert.deepEqual(post.body, { priceId: 'price_a' });
	assert.equal(post.method, 'POST');
	assert.equal(post.headers['X-CSRF-Token'], 'csrf-token');
	assert.deepEqual(t.assigned, ['https://checkout.stripe.com/c/pay/cs_1']);
});

test('409 price_changed shows the new offer and needs a fresh confirmation', async () => {
	const t = boot({ routes: base({
		'/api/billing/status': { status: 200, body: FREE },
		'/api/billing/checkout': (init) => JSON.parse(init.body).priceId === 'price_a'
			? { status: 409, body: { error: 'price_changed', offer: offer('price_b', 1900) } }
			: { status: 200, body: { url: 'https://checkout.stripe.com/c/pay/cs_2' } },
	}) });
	await t.flush();
	t.by('Subscribe').click();
	await t.flush();
	assert.equal(t.nodes.get('za-billing-confirm').hidden, false);
	assert.match(t.text('za-billing-confirm-text'), /\$19 a month/);
	assert.equal(t.text('za-billing-confirm-yes'), 'Continue at $19 a month');
	assert.deepEqual(t.assigned, [], 'nothing was charged or opened before confirmation');
	assert.match(t.nodes.get('za-billing-lines').children.map((c) => c.textContent).join(' '), /\$19 a month/);
	t.nodes.get('za-billing-confirm-yes').click();
	await t.flush();
	const posts = t.requests.filter((r) => r.url === '/api/billing/checkout');
	assert.deepEqual(posts.map((p) => p.body.priceId), ['price_a', 'price_b']);
	assert.deepEqual(t.assigned, ['https://checkout.stripe.com/c/pay/cs_2']);
});

test('declining a changed price opens nothing', async () => {
	const t = boot({ routes: base({ '/api/billing/status': { status: 200, body: FREE }, '/api/billing/checkout': { status: 409, body: { error: 'price_changed', offer: offer('price_b', 900) } } }) });
	await t.flush();
	t.by('Subscribe').click();
	await t.flush();
	t.nodes.get('za-billing-confirm-no').click();
	assert.equal(t.nodes.get('za-billing-confirm').hidden, true);
	assert.deepEqual(t.assigned, []);
});

for (const [label, response, expected] of [
	['409 already_subscribed', { status: 409, body: { error: 'already_subscribed' } }, /already have a subscription/],
	['409 sales_paused', { status: 409, body: { error: 'sales_paused' } }, /paused/],
	['202 checkout_pending', { status: 202, body: { status: 'checkout_pending' } }, /being prepared/],
	['503', { status: 503, body: { error: 'billing_unavailable' } }, /Nothing was charged/],
]) {
	test(`checkout ${label} is explained and never redirects`, async () => {
		const t = boot({ routes: base({ '/api/billing/status': { status: 200, body: FREE }, '/api/billing/checkout': response }) });
		await t.flush();
		t.by('Subscribe').click();
		await t.flush();
		assert.match(t.text('za-billing-message'), expected);
		assert.deepEqual(t.assigned, []);
	});
}

test('checkout 401 sends the user through sign-in again', async () => {
	const t = boot({ routes: base({ '/api/billing/status': { status: 200, body: FREE }, '/api/billing/checkout': { status: 401, body: { error: 'unauthorized' } } }) });
	await t.flush();
	t.by('Subscribe').click();
	await t.flush();
	assert.equal(t.nodes.get('za-billing-signedout').hidden, false);
	assert.match(t.text('za-billing-signedout-text'), /Sign in again/);
	assert.equal(t.nodes.get('za-billing-signin').href, '/api/auth/github/start?return=/account/plan');
});

test('two tabs: a second Subscribe while a checkout is open reuses its URL', async () => {
	const t = boot({ routes: base({
		'/api/billing/status': { status: 200, body: { ...FREE, checkoutState: 'checkout_pending' } },
		'/api/billing/checkout': { status: 200, body: { url: 'https://checkout.stripe.com/c/pay/cs_open' } },
	}) });
	await t.flush();
	assert.equal(t.text('za-billing-title'), 'Checkout in progress');
	t.by('Continue to checkout').click();
	await t.flush();
	assert.deepEqual(t.assigned, ['https://checkout.stripe.com/c/pay/cs_open']);
});

test('portal: opens Stripe, and a stale sign-in is a step-up with a sign-in link', async () => {
	const ok = boot({ routes: base({ '/api/billing/status': { status: 200, body: ACTIVE }, '/api/billing/portal': { status: 200, body: { url: 'https://billing.stripe.com/p/session/x' } } }) });
	await ok.flush();
	assert.match(ok.nodes.get('za-billing-lines').children.map((c) => c.textContent).join(' '), /Your subscription is \$5 a month/);
	ok.by('Manage billing').click();
	await ok.flush();
	assert.equal(ok.requests.find((r) => r.url === '/api/billing/portal').headers['X-CSRF-Token'], 'csrf-token');
	assert.deepEqual(ok.assigned, ['https://billing.stripe.com/p/session/x']);

	const stale = boot({ page: 'billing', routes: base({ '/api/billing/status': { status: 200, body: ACTIVE }, '/api/billing/portal': { status: 401, body: { error: 'recent_auth_required' } } }) });
	await stale.flush();
	stale.by('Open billing portal').click();
	await stale.flush();
	assert.match(stale.text('za-billing-message'), /sign in again/);
	const again = stale.by('Sign in again');
	assert.equal(again.href, '/api/auth/github/start?return=/billing');
	assert.deepEqual(stale.assigned, []);
});

test('?checkout=returned polls every 2 seconds, never shows paid, and stops at 60 seconds', async () => {
	const t = boot({ search: '?checkout=returned', routes: base({ '/api/billing/status': { status: 200, body: FREE } }) });
	await t.flush();
	assert.deepEqual(t.replaced.map((r) => r[2]), ['/account/plan'], 'the parameter is dropped from the address');
	assert.match(t.text('za-billing-notice'), /Checking for your payment/);
	assert.equal(t.by('Subscribe'), undefined);
	assert.ok(t.by('Refresh status'));
	let polls = 0;
	while (t.timers.length && polls < 100) {
		const timer = t.timers.shift();
		assert.equal(timer.ms, 2000);
		t.clock.t += 2000;
		timer.fn();
		await t.flush();
		polls++;
	}
	assert.equal(polls, 30, 'a poll every 2 seconds for 60 seconds');
	assert.match(t.text('za-billing-notice'), /have not confirmed a payment yet/);
	assert.ok(t.by('Refresh status'));
	assert.equal(t.requests.filter((r) => r.url === '/api/billing/status').length, 31, 'the load plus 30 polls');
});

test('polling ends as soon as the server says active, and only then is Premium shown', async () => {
	const answers = [{ status: 200, body: FREE }, { status: 200, body: FREE }, { status: 200, body: ACTIVE }];
	const t = boot({ search: '?checkout=returned', routes: base({ '/api/billing/status': answers }) });
	await t.flush();
	assert.notEqual(t.text('za-billing-title'), 'Premium');
	for (let i = 0; i < 2 && t.timers.length; i++) { const timer = t.timers.shift(); t.clock.t += 2000; timer.fn(); await t.flush(); }
	assert.equal(t.text('za-billing-title'), 'Premium');
	assert.equal(t.timers.length, 0);
	assert.equal(t.nodes.get('za-billing-notice').hidden, true);
});

test('confirming payment polls and never offers a second purchase', async () => {
	const t = boot({ routes: base({ '/api/billing/status': { status: 200, body: { ...FREE, checkoutState: 'confirming_payment' } } }) });
	await t.flush();
	assert.equal(t.text('za-billing-title'), 'Confirming payment');
	assert.equal(t.by('Subscribe'), undefined);
	assert.equal(t.timers.length, 1);
});
