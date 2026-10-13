// ZA-904. The Plan (/account/plan) and Billing (/billing) pages. What each
// state says lives in zeroagent-billing-view.js; this file fetches, renders
// and acts. The session is an HttpOnly cookie this script never sees; the
// CSRF token is held in memory only. No card is collected here (payment is
// Stripe-hosted Checkout and the Stripe customer portal), and nothing about
// the account, the price or the return parameters is sent to analytics:
// these pages load no analytics at all.
(function () {
	'use strict';

	var View = window.ZeroAgentBillingView;
	var Pricing = window.ZeroAgentPricing;
	var page = document.body.getAttribute('data-za-page') === 'billing' ? 'billing' : 'plan';
	var returnPath = page === 'billing' ? '/billing' : '/account/plan';
	var signInHref = '/api/auth/github/start?return=' + returnPath;

	var els = {
		root: document.getElementById('za-billing'),
		loading: document.getElementById('za-billing-loading'),
		error: document.getElementById('za-billing-error'),
		errorText: document.getElementById('za-billing-error-text'),
		retry: document.getElementById('za-billing-retry'),
		signedOut: document.getElementById('za-billing-signedout'),
		signedOutText: document.getElementById('za-billing-signedout-text'),
		view: document.getElementById('za-billing-view'),
		title: document.getElementById('za-billing-title'),
		lines: document.getElementById('za-billing-lines'),
		notice: document.getElementById('za-billing-notice'),
		message: document.getElementById('za-billing-message'),
		confirm: document.getElementById('za-billing-confirm'),
		confirmText: document.getElementById('za-billing-confirm-text'),
		confirmYes: document.getElementById('za-billing-confirm-yes'),
		confirmNo: document.getElementById('za-billing-confirm-no'),
		actions: document.getElementById('za-billing-actions'),
		identity: document.getElementById('za-billing-identity'),
		signOut: document.getElementById('za-billing-signout')
	};

	var model = {
		csrf: null,
		status: null,
		offer: null,
		returned: false,
		timedOut: false,
		pollStarted: null,
		pollTimer: null,
		busy: false
	};

	// A Checkout return is a hint to look again, never a result. The
	// parameter is dropped from the address so a reload does not repeat it.
	var params = new URLSearchParams(window.location.search);
	if (params.get('checkout') === 'returned') {
		model.returned = true;
		if (window.history && window.history.replaceState) window.history.replaceState(null, '', window.location.pathname);
	}

	function request(url, init) {
		init = init || {};
		init.credentials = 'same-origin';
		init.cache = 'no-store';
		return fetch(url, init).then(function (res) {
			return res.json().then(function (body) { return { status: res.status, body: body }; },
				function () { return { status: res.status, body: null }; });
		});
	}

	function post(url, body) {
		return request(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': model.csrf || '' },
			body: JSON.stringify(body || {})
		});
	}

	function show(which) {
		els.loading.hidden = which !== 'loading';
		els.error.hidden = which !== 'error';
		els.signedOut.hidden = which !== 'signedOut';
		els.view.hidden = which !== 'view';
		els.root.setAttribute('aria-busy', which === 'loading' ? 'true' : 'false');
	}

	function say(text) {
		els.message.textContent = text || '';
	}

	function showError(text) {
		els.errorText.textContent = text;
		show('error');
		els.retry.focus();
	}

	function showSignedOut(text) {
		stopPolling();
		model.csrf = null;
		els.identity.textContent = 'You are signed out.';
		els.signOut.hidden = true;
		els.signedOutText.textContent = text || 'Sign in with GitHub to see your plan and billing.';
		show('signedOut');
	}

	function stopPolling() {
		if (model.pollTimer) clearTimeout(model.pollTimer);
		model.pollTimer = null;
	}

	function button(label, className, onClick) {
		var b = document.createElement('button');
		b.type = 'button';
		b.className = className;
		b.textContent = label;
		b.addEventListener('click', onClick);
		return b;
	}

	function link(label, className, href) {
		var a = document.createElement('a');
		a.className = className;
		a.href = href;
		a.textContent = label;
		return a;
	}

	function render() {
		var view = View.viewFor(model.status, model.offer, {
			now: new Date(),
			page: page,
			returned: model.returned,
			timedOut: model.timedOut
		});
		els.title.textContent = view.title;
		els.lines.textContent = '';
		view.lines.forEach(function (line) {
			var p = document.createElement('p');
			p.textContent = line;
			els.lines.appendChild(p);
		});
		els.notice.hidden = !view.notice;
		els.notice.textContent = view.notice || '';
		els.actions.textContent = '';
		view.actions.forEach(function (action, i) {
			var cls = 'za-btn' + (i === 0 ? ' za-btn--primary' : '');
			if (action.href) els.actions.appendChild(link(action.label, cls, action.href));
			else els.actions.appendChild(button(action.label, cls, function () { act(action.id); }));
		});
		show('view');
		if (view.polling) schedulePoll(); else stopPolling();
	}

	// Polls the read endpoint every 2 seconds for up to 60, then stops and
	// offers a retry. The page never declares a payment on its own.
	function schedulePoll() {
		if (model.pollTimer) return;
		if (model.pollStarted === null) model.pollStarted = Date.now();
		model.pollTimer = setTimeout(function () {
			model.pollTimer = null;
			refreshStatus().then(function () {
				if (Date.now() - model.pollStarted >= View.POLL_LIMIT_MS) {
					model.timedOut = true;
					render();
				}
			});
		}, View.POLL_INTERVAL_MS);
	}

	function refreshStatus() {
		return request('/api/billing/status').then(function (res) {
			if (res.status === 401) return showSignedOut('Your sign-in has expired. Sign in again to continue.');
			if (res.status !== 200 || !res.body) return; // keep what is shown; polling retries
			model.status = res.body;
			render();
		}, function () {});
	}

	function load() {
		stopPolling();
		model.pollStarted = null;
		model.timedOut = false;
		show('loading');
		request('/api/account/session').then(function (session) {
			if (session.status === 401) return showSignedOut();
			if (session.status !== 200 || !session.body) return showError('We could not load your account right now. Please try again.');
			model.csrf = session.body.csrfToken;
			els.identity.textContent = 'Signed in as ' + session.body.login + '.';
			els.signOut.hidden = false;
			return Promise.all([
				request('/api/billing/status'),
				request('/api/billing/catalog').then(function (r) { return r.status === 200 ? r.body : null; }, function () { return null; })
			]).then(function (results) {
				var status = results[0];
				if (status.status === 401) return showSignedOut('Your sign-in has expired. Sign in again to continue.');
				if (status.status !== 200 || !status.body) return showError('Billing is unavailable right now. Please try again shortly.');
				model.status = status.body;
				model.offer = results[1];
				render();
			});
		}).catch(function () {
			showError('We could not reach ZeroAgent. Check your connection and try again.');
		});
	}

	function reloadSession() {
		return request('/api/account/session').then(function (s) {
			if (s.status === 200 && s.body) model.csrf = s.body.csrfToken;
			else if (s.status === 401) showSignedOut('Your sign-in has expired. Sign in again to continue.');
		}, function () {});
	}

	function setBusy(on) {
		model.busy = on;
		var all = els.actions.querySelectorAll('button');
		for (var i = 0; i < all.length; i++) all[i].disabled = on;
	}

	function act(id) {
		if (model.busy) return;
		if (id === 'refresh') {
			model.timedOut = false;
			model.pollStarted = null;
			stopPolling();
			say('Checking your status.');
			return refreshStatus().then(function () { say(''); });
		}
		if (id === 'subscribe') return subscribe(model.offer && model.offer.priceId);
		if (id === 'portal') return openPortal();
	}

	function subscribe(priceId) {
		if (!priceId) return say(View.messages.unavailable);
		setBusy(true);
		els.confirm.hidden = true;
		say('Opening checkout.');
		post('/api/billing/checkout', { priceId: priceId }).then(function (res) {
			var outcome = View.interpretCheckout(res.status, res.body);
			switch (outcome.kind) {
				case 'redirect':
					window.location.assign(outcome.url);
					return;
				case 'price_changed':
					// Show the new offer and require a fresh confirmation.
					model.offer = outcome.offer;
					say('');
					els.confirmText.textContent = 'The price changed to ' + outcome.priceText + '. Review it, and continue only if you agree.';
					els.confirmYes.textContent = 'Continue at ' + outcome.priceText;
					els.confirm.hidden = false;
					els.confirmYes.focus();
					break;
				case 'sales_paused':
					model.offer = { status: 'paused' };
					say(View.messages.sales_paused);
					break;
				case 'already_subscribed':
				case 'pending':
					say(View.messages[outcome.kind]);
					refreshStatus();
					break;
				case 'sign_in':
					showSignedOut(View.messages.sign_in);
					return;
				case 'session_stale':
					say(View.messages.session_stale);
					reloadSession();
					break;
				default:
					say(View.messages.unavailable);
			}
			setBusy(false);
			render();
		}, function () {
			say(View.messages.unavailable);
			setBusy(false);
		});
	}

	function openPortal() {
		setBusy(true);
		say('Opening the billing portal.');
		post('/api/billing/portal').then(function (res) {
			var outcome = View.interpretPortal(res.status, res.body);
			if (outcome.kind === 'redirect') {
				window.location.assign(outcome.url);
				return;
			}
			if (outcome.kind === 'sign_in') return showSignedOut(View.messages.sign_in);
			say(View.messages[outcome.kind] || View.messages.unavailable);
			if (outcome.kind === 'session_stale') reloadSession();
			setBusy(false);
			if (outcome.kind === 'reauth') {
				// The step-up is a fresh GitHub sign-in; offer it as a link.
				els.actions.appendChild(link('Sign in again', 'za-btn', signInHref));
			}
		}, function () {
			say(View.messages.unavailable);
			setBusy(false);
		});
	}

	els.retry.addEventListener('click', load);
	els.confirmYes.addEventListener('click', function () {
		subscribe(model.offer && model.offer.priceId);
	});
	els.confirmNo.addEventListener('click', function () {
		els.confirm.hidden = true;
		say('');
	});
	els.signOut.addEventListener('click', function () {
		els.signOut.disabled = true;
		post('/api/auth/logout').then(function () {
			els.signOut.disabled = false;
			showSignedOut('You have signed out.');
		}, function () { els.signOut.disabled = false; });
	});
	document.getElementById('za-billing-signin').setAttribute('href', signInHref);

	load();
})();
