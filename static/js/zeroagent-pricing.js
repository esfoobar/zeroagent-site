// ZA-904. The one place a price is turned into words. Nothing here, and
// nothing in any page, holds an amount: the number comes from the runtime
// catalog (GET /api/billing/catalog) for a new buyer, or from the
// subscriber's own subscription (GET /api/billing/status) for someone who
// already pays. When neither can be read the copy keeps its no-number
// fallback text. Elements marked data-za-price are filled in place.
(function (root) {
	'use strict';

	var INTERVALS = { day: 'a day', week: 'a week', month: 'a month', year: 'a year' };

	// price: { unitAmount (minor units), currency, interval } or an offer.
	// Returns "$5 a month" style text, or null when it cannot be stated.
	function priceText(price) {
		if (!price || typeof price.unitAmount !== 'number' || typeof price.currency !== 'string') return null;
		var amount;
		try {
			var probe = new Intl.NumberFormat('en-US', { style: 'currency', currency: price.currency.toUpperCase() });
			var digits = probe.resolvedOptions().maximumFractionDigits;
			var major = price.unitAmount / Math.pow(10, digits);
			var whole = Math.round(major) === major;
			amount = new Intl.NumberFormat('en-US', {
				style: 'currency',
				currency: price.currency.toUpperCase(),
				minimumFractionDigits: whole ? 0 : digits
			}).format(major);
		} catch (e) {
			return null;
		}
		var interval = INTERVALS[price.interval];
		return interval ? amount + ' ' + interval : amount;
	}

	function json(url, init) {
		return root.fetch(url, init || { credentials: 'same-origin', cache: 'no-store' }).then(function (res) {
			if (!res.ok) throw new Error('http_' + res.status);
			return res.json();
		});
	}

	// An existing subscriber sees their own price, everyone else the
	// catalog's current offer. Either failing leaves the fallback in place.
	function load() {
		var own = json('/api/billing/status').then(function (s) {
			return s && s.subscription ? priceText(s.subscription) : null;
		}, function () { return null; });
		return own.then(function (text) {
			if (text) return text;
			return json('/api/billing/catalog').then(function (offer) {
				return offer && offer.status === 'available' ? priceText(offer) : null;
			}, function () { return null; });
		});
	}

	function fill(text) {
		if (!text) return;
		var nodes = root.document.querySelectorAll('[data-za-price]');
		for (var i = 0; i < nodes.length; i++) nodes[i].textContent = text;
	}

	function run() {
		if (!root.document.querySelector('[data-za-price]')) return;
		load().then(fill, function () {});
	}

	root.ZeroAgentPricing = { priceText: priceText, load: load, fill: fill };
	if (root.document && root.document.addEventListener) {
		if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', run);
		else run();
	}
})(typeof window !== 'undefined' ? window : globalThis);
