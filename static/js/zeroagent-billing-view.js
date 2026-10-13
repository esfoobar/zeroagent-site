// ZA-904. What the Plan and Billing pages say, as pure functions of the
// answers /api/billing/status and /api/billing/catalog gave. No DOM, no
// fetch, no clock of its own, so every state in the plan's state table is
// testable. No amount lives here: prices arrive in `offer` (the current
// sale price, for a buyer) or `status.subscription` (a subscriber's own).
//
// Return parameters are never evidence of payment. `ctx.returned` only
// means "ask again until the server says"; the words "paid", "active" and
// "Premium" appear only when billingStatus says so.
(function (root) {
	'use strict';

	var DAY = 24 * 60 * 60 * 1000;
	var PRICE = function () { return root.ZeroAgentPricing; };

	function when(iso, ctx) {
		var t = new Date(iso);
		if (!iso || isNaN(t.getTime())) return null;
		var options = { year: 'numeric', month: 'long', day: 'numeric' };
		if (ctx && ctx.timeZone) options.timeZone = ctx.timeZone;
		return t.toLocaleDateString('en-US', options);
	}

	function whenWithTime(iso, ctx) {
		var t = new Date(iso);
		if (!iso || isNaN(t.getTime())) return null;
		var options = { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' };
		if (ctx && ctx.timeZone) options.timeZone = ctx.timeZone;
		return t.toLocaleString('en-US', options);
	}

	function daysLeft(iso, now) {
		var ms = new Date(iso).getTime() - now.getTime();
		return Math.max(1, Math.ceil(ms / DAY));
	}

	function stateOf(status, now) {
		if (status.checkoutState === 'confirming_payment') return 'confirming';
		if (status.checkoutState === 'checkout_pending') return 'checkout_open';
		switch (status.billingStatus) {
			case 'active': return 'active';
			case 'cancel_scheduled': return 'cancel_scheduled';
			case 'past_due': return 'past_due';
			case 'ended': return 'ended';
			case 'legacy_grant': return 'legacy';
		}
		if (status.trialEnds) {
			var end = new Date(status.trialEnds).getTime();
			if (!isNaN(end)) return now.getTime() < end ? 'trial' : 'trial_expired';
		}
		return 'free';
	}

	// The line stating what a new buyer would pay. Never states a number it
	// was not given: an unreadable or missing offer says so in words.
	function offerLine(offer) {
		if (offer && offer.status === 'paused') {
			return { text: 'New subscriptions are paused for a moment. Please check back shortly.', subscribable: false };
		}
		var text = offer && offer.status === 'available' && PRICE() ? PRICE().priceText(offer) : null;
		if (!text) return { text: 'The current price is not available right now. Please try again shortly.', subscribable: false };
		return { text: 'Premium is ' + text + '.', subscribable: true, price: text };
	}

	function ownPriceLine(status) {
		var text = status.subscription && PRICE() ? PRICE().priceText(status.subscription) : null;
		if (text) return 'Your subscription is ' + text + '.';
		return 'Your subscription price is on your invoices in the billing portal.';
	}

	var SUBSCRIBE = { id: 'subscribe', label: 'Subscribe' };
	var PORTAL = { id: 'portal', label: 'Manage billing' };

	// status: the /api/billing/status body. offer: the /api/billing/catalog
	// body or null when it could not be read. ctx: { now, page, returned,
	// timedOut, timeZone }. page is 'plan' or 'billing'.
	function viewFor(status, offer, ctx) {
		var now = ctx.now || new Date();
		var page = ctx.page === 'billing' ? 'billing' : 'plan';
		var state = stateOf(status, now);
		var view = { state: state, title: '', lines: [], notice: null, actions: [], polling: false, awaiting: false };
		var plan = page === 'plan';
		var sale = offerLine(offer);
		var through = when(status.planUntil || status.accessUntil, ctx);

		// A Checkout return, or a payment still settling, awaits the server.
		var settling = state === 'confirming';
		var returned = Boolean(ctx.returned) && ['free', 'trial', 'trial_expired', 'ended'].indexOf(state) !== -1;
		if (settling || returned) {
			view.awaiting = true;
			view.polling = !ctx.timedOut;
		}

		switch (state) {
			case 'confirming':
				view.title = 'Confirming payment';
				view.lines.push('We are confirming your payment. This can take a minute, and this page updates when it is confirmed.');
				view.lines.push('Please do not subscribe again while this is pending.');
				view.actions.push({ id: 'refresh', label: 'Refresh status' });
				break;

			case 'checkout_open':
				view.title = 'Checkout in progress';
				view.lines.push('You have a checkout open, possibly in another tab. Nothing is charged until you complete it.');
				if (plan) {
					view.lines.push(sale.text);
					view.actions.push({ id: 'subscribe', label: 'Continue to checkout' });
				} else {
					view.actions.push({ id: 'plan-link', label: 'Go to Plan', href: '/account/plan' });
				}
				break;

			case 'trial':
				view.title = 'Trial';
				var end = whenWithTime(status.trialEnds, ctx);
				var left = daysLeft(status.trialEnds, now);
				view.lines.push('Your trial ends on ' + end + ' (' + left + (left === 1 ? ' day' : ' days') + ' left).');
				view.lines.push('The trial is card-free, and nothing is charged automatically when it ends.');
				if (plan) {
					view.lines.push(sale.text);
					view.lines.push('Subscribing starts billing immediately.');
					if (sale.subscribable) view.actions.push(SUBSCRIBE);
				} else if (status.hasBillingHistory) {
					view.actions.push({ id: 'portal', label: 'View invoices' });
				}
				break;

			case 'trial_expired':
				view.title = 'Trial ended';
				view.lines.push('Your trial ended on ' + when(status.trialEnds, ctx) + '. ZeroAgent stays free for local work on your own computer.');
				if (plan) {
					view.lines.push(sale.text);
					if (sale.subscribable) view.actions.push(SUBSCRIBE);
				} else {
					view.lines.push('You have no active subscription.');
					view.actions.push({ id: 'plan-link', label: 'Go to Plan', href: '/account/plan' });
					if (status.hasBillingHistory) view.actions.push({ id: 'portal', label: 'View invoices' });
				}
				break;

			case 'free':
				view.title = 'Free';
				if (plan) {
					view.lines.push('ZeroAgent is free for local work on your own computer, with no account.');
					view.lines.push(sale.text);
					if (sale.subscribable) view.actions.push(SUBSCRIBE);
				} else {
					view.lines.push('You have no subscription and no invoices yet.');
					view.actions.push({ id: 'plan-link', label: 'Go to Plan', href: '/account/plan' });
					if (status.hasBillingHistory) view.actions.push({ id: 'portal', label: 'View invoices' });
				}
				break;

			case 'active':
				view.title = 'Premium';
				view.lines.push(ownPriceLine(status));
				if (through) view.lines.push('Your subscription renews on ' + through + '.');
				view.actions.push(plan ? PORTAL : { id: 'portal', label: 'Open billing portal' });
				if (!plan) view.lines.push('In the billing portal you can update your payment method, view invoices and cancel.');
				break;

			case 'past_due':
				var deadline = when(status.paymentGraceUntil || status.accessUntil, ctx);
				view.title = 'Payment issue';
				view.lines.push('We could not collect your latest payment.');
				if (deadline) view.lines.push('Premium stays available until ' + deadline + '. Resolve the payment before then to keep it.');
				view.lines.push(ownPriceLine(status));
				view.actions.push({ id: 'portal', label: 'Resolve payment' });
				if (!plan) view.lines.push('After you return, this page confirms the result. It never assumes the payment went through.');
				break;

			case 'cancel_scheduled':
				view.title = 'Premium, ending';
				if (through) view.lines.push('Ends on ' + through + '.');
				view.lines.push('Your subscription will not renew. Premium stays available until then.');
				view.lines.push(ownPriceLine(status));
				view.lines.push('If the billing portal offers it, you can keep your subscription before that date, at your current price.');
				view.actions.push(plan ? PORTAL : { id: 'portal', label: 'Open billing portal' });
				break;

			case 'ended':
				view.title = 'Free';
				view.lines.push('Your subscription has ended.' + (through ? ' It was paid through ' + through + '.' : ''));
				view.lines.push('ZeroAgent stays free for local work on your own computer.');
				if (plan) {
					view.lines.push('Subscribing again starts a new subscription at the current price.');
					view.lines.push(sale.text);
					if (sale.subscribable) view.actions.push({ id: 'subscribe', label: 'Subscribe again' });
				} else {
					view.actions.push({ id: 'plan-link', label: 'Go to Plan', href: '/account/plan' });
					if (status.hasBillingHistory) view.actions.push({ id: 'portal', label: 'View invoices' });
				}
				break;

			case 'legacy':
				view.title = 'Premium';
				view.lines.push('Premium is included with your account. There is no subscription to manage.');
				break;
		}

		if (returned || (settling && ctx.returned)) {
			view.notice = ctx.timedOut
				? 'We have not confirmed a payment yet. It can take a little longer, and nothing is lost. Retry the status check, or come back in a few minutes.'
				: 'Checking for your payment. This page updates as soon as it is confirmed.';
		}
		if (view.awaiting) {
			// No duplicate purchase while a payment is settling.
			view.actions = view.actions.filter(function (a) { return a.id !== 'subscribe'; });
			if (!view.actions.some(function (a) { return a.id === 'refresh'; })) view.actions.push({ id: 'refresh', label: 'Refresh status' });
		}
		return view;
	}

	// Only a Stripe-hosted https page is ever navigated to.
	function safeRedirect(url) {
		if (typeof url !== 'string') return null;
		var match = /^https:\/\/([a-z0-9-]+\.)*stripe\.com(\/|$)/i.exec(url);
		return match ? url : null;
	}

	// What a Checkout answer means. `body` may be null (unparseable).
	function interpretCheckout(httpStatus, body) {
		var error = body && body.error;
		if (httpStatus === 200) {
			var url = safeRedirect(body && body.url);
			return url ? { kind: 'redirect', url: url } : { kind: 'unavailable' };
		}
		if (httpStatus === 202) return { kind: 'pending' };
		if (httpStatus === 409 && error === 'price_changed') {
			var offer = body.offer;
			var text = offer && offer.status === 'available' && PRICE() ? PRICE().priceText(offer) : null;
			return text ? { kind: 'price_changed', offer: offer, priceText: text } : { kind: 'unavailable' };
		}
		if (httpStatus === 409 && error === 'already_subscribed') return { kind: 'already_subscribed' };
		if (httpStatus === 409 && error === 'sales_paused') return { kind: 'sales_paused' };
		if (httpStatus === 401) return { kind: 'sign_in' };
		if (httpStatus === 403) return { kind: 'session_stale' };
		return { kind: 'unavailable' };
	}

	function interpretPortal(httpStatus, body) {
		var error = body && body.error;
		if (httpStatus === 200) {
			var url = safeRedirect(body && body.url);
			return url ? { kind: 'redirect', url: url } : { kind: 'unavailable' };
		}
		if (httpStatus === 401 && error === 'recent_auth_required') return { kind: 'reauth' };
		if (httpStatus === 401) return { kind: 'sign_in' };
		if (httpStatus === 403) return { kind: 'session_stale' };
		if (httpStatus === 404) return { kind: 'no_customer' };
		return { kind: 'unavailable' };
	}

	var MESSAGES = {
		pending: 'Your checkout is being prepared, possibly in another tab. Try again in a moment.',
		already_subscribed: 'You already have a subscription. Your plan is being refreshed.',
		sales_paused: 'New subscriptions are paused for a moment. Existing subscriptions and billing are not affected. Please check back shortly.',
		sign_in: 'Your sign-in has expired. Sign in again to continue.',
		reauth: 'For your security, sign in again to open billing. Then choose Manage billing once more.',
		session_stale: 'This page was out of date. It has been refreshed, so please try again.',
		no_customer: 'There is no billing history for this account yet.',
		unavailable: 'Billing is unavailable right now. Nothing was charged. Please try again shortly.'
	};

	root.ZeroAgentBillingView = {
		viewFor: viewFor,
		interpretCheckout: interpretCheckout,
		interpretPortal: interpretPortal,
		safeRedirect: safeRedirect,
		messages: MESSAGES,
		POLL_INTERVAL_MS: 2000,
		POLL_LIMIT_MS: 60000
	};
})(typeof window !== 'undefined' ? window : globalThis);
