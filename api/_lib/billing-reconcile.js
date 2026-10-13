/*
 * ZA-902 / esfoobar/zeroagent#1265. Current-state reconciliation: the pure
 * step that turns what Stripe says NOW about one subscription (and the paid
 * invoices that belong to it) into the `billing` patch the fenced commit
 * writes. It reads no event payload for state, so the order events arrive
 * in and replays of them cannot corrupt anything: the same Stripe state
 * and the same stored record always give the same patch.
 *
 * What it decides, from docs/BILLING-ENTITLEMENT.md in the zeroagent repo:
 *  - paidThrough is the end of the service interval a settled invoice
 *    actually paid for, only ever advanced, never "one month from now".
 *    A failure, a retry, a voided or written-off invoice moves nothing.
 *  - Nothing paid (T14, an incomplete or trialing subscription) writes
 *    nothing: no grant and no grace.
 *  - past_due anchors paymentGraceUntil to paid-through once, at the first
 *    failure (T08); a retry keeps the stored value, a payment clears it
 *    (T09).
 *  - A terminated subscription is `ended` and is never revived by anything
 *    reconciled later (T07, T11, T12).
 *  - Entitlement never depends on a Price id, an amount or the active flag
 *    of a Price: the Premium Product association is the integrity check.
 *    priceId is stored for display only.
 */

import { BILLING_PARAMETERS, paymentGraceUntilFor } from './billing-config.js';

export function idOf(ref) {
	if (typeof ref === 'string') return ref;
	return ref && typeof ref.id === 'string' ? ref.id : null;
}

function isoFromSeconds(value) {
	return typeof value === 'number' && Number.isFinite(value) ? new Date(value * 1000).toISOString() : null;
}

function productOf(priceLike) {
	if (!priceLike || typeof priceLike !== 'object') return null;
	return idOf(priceLike.product);
}

// The subscription item(s) that belong to the Premium Product.
export function premiumItems(subscription, productId) {
	const items = subscription && subscription.items && Array.isArray(subscription.items.data) ? subscription.items.data : [];
	return items.filter((item) => productOf(item.price) === productId);
}

export function subscriptionIdOfInvoice(invoice) {
	if (!invoice) return null;
	const direct = idOf(invoice.subscription);
	if (direct) return direct;
	const parent = invoice.parent && invoice.parent.subscription_details;
	return parent ? idOf(parent.subscription) : null;
}

function lineProduct(line) {
	return (
		productOf(line.price) ||
		(line.pricing && line.pricing.price_details ? idOf(line.pricing.price_details.product) : null)
	);
}

function isSubscriptionLine(line) {
	if (line.type && line.type !== 'subscription') return false;
	if (line.parent && line.parent.type && line.parent.type !== 'subscription_item_details') return false;
	return true;
}

// The paid service interval of an invoice, or null when the invoice is not
// a settled Premium subscription invoice for this customer and subscription.
// A zero-due credit invoice that Stripe settled is settled; an invoice paid
// out of band, a manual invoice, a voided or open one is not.
export function paidInterval(invoice, { productId, customerId, subscriptionId }) {
	if (!invoice || invoice.status !== 'paid') return null;
	if (invoice.paid_out_of_band === true) return null;
	if (invoice.billing_reason === 'manual') return null;
	if (idOf(invoice.customer) !== customerId) return null;
	if (subscriptionIdOfInvoice(invoice) !== subscriptionId) return null;
	const lines = invoice.lines && Array.isArray(invoice.lines.data) ? invoice.lines.data : [];
	let qualifying = lines.filter((l) => lineProduct(l) === productId && isSubscriptionLine(l) && l.period);
	const regular = qualifying.filter((l) => l.proration !== true);
	if (regular.length > 0) qualifying = regular;
	let start = null;
	let end = null;
	for (const line of qualifying) {
		const s = line.period.start;
		const e = line.period.end;
		if (typeof s !== 'number' || typeof e !== 'number' || e <= s) continue;
		if (start === null || s < start) start = s;
		if (end === null || e > end) end = e;
	}
	if (end === null) return null;
	return { start: isoFromSeconds(start), end: isoFromSeconds(end), invoiceId: invoice.id };
}

function latest(a, b) {
	if (!a) return b;
	if (!b) return a;
	return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

const TERMINAL = new Set(['canceled', 'incomplete_expired']);

export function isTerminalSubscription(subscription) {
	return TERMINAL.has(subscription.status);
}

// previous: the stored billing record when it is for THIS subscription,
// otherwise null (a replacement starts from nothing).
// invoices: Stripe invoice objects retrieved just now (the event's invoice
// and the subscription's latest invoice); only settled ones count.
// fromStatus: the stored record being replaced, label only.
// Returns { action: 'write', patch, from, to } or { action: 'skip', reason }.
export function deriveBillingPatch({
	subscription,
	invoices = [],
	previous = null,
	environment,
	customerId,
	parameters = BILLING_PARAMETERS,
	fromStatus = null,
}) {
	const items = premiumItems(subscription, environment.productId);
	const scope = { productId: environment.productId, customerId, subscriptionId: subscription.id };

	let best = null;
	for (const invoice of invoices) {
		const interval = paidInterval(invoice, scope);
		if (interval && (!best || new Date(interval.end).getTime() > new Date(best.end).getTime())) best = interval;
	}

	const storedPaidThrough = previous ? previous.paidThrough ?? null : null;
	const paidThrough = latest(storedPaidThrough, best ? best.end : null);
	// The label of where the account was, for the outcome code and the audit
	// trail. A replacement (previous is null) reports the replaced record's.
	const stored = previous || fromStatus;
	const from =
		stored && stored.status
			? stored.status === 'active' && stored.cancelAtPeriodEnd
				? 'cancel_scheduled'
				: stored.status
			: 'none';

	if (!paidThrough) return { action: 'skip', reason: 'nothing_paid' };

	let status;
	switch (subscription.status) {
		case 'active':
			status = 'active';
			break;
		case 'past_due':
		case 'unpaid':
		case 'paused':
			status = 'past_due';
			break;
		case 'canceled':
			status = 'ended';
			break;
		default:
			// trialing, incomplete, incomplete_expired: no settled coverage to
			// project beyond what is already stored.
			return { action: 'skip', reason: 'not_settled' };
	}

	if (previous && previous.status === 'ended' && status !== 'ended') {
		return { action: 'skip', reason: 'terminal_not_revivable' };
	}

	let paymentGraceUntil = null;
	if (status === 'past_due') {
		if (subscription.status === 'paused') {
			// A pause grants no grace of its own; coverage runs to paid-through.
			paymentGraceUntil = previous && previous.status === 'past_due' ? previous.paymentGraceUntil ?? null : null;
		} else if (previous && previous.status === 'past_due' && previous.paymentGraceUntil) {
			// Set once at the first failure; a retry never moves it.
			paymentGraceUntil = previous.paymentGraceUntil;
		} else {
			paymentGraceUntil = paymentGraceUntilFor(paidThrough, parameters);
		}
	}

	const periodEnds = items
		.map((i) => i.current_period_end ?? subscription.current_period_end)
		.filter((v) => typeof v === 'number');
	const periodStarts = items
		.map((i) => i.current_period_start ?? subscription.current_period_start)
		.filter((v) => typeof v === 'number');
	const currentPeriodEnd = periodEnds.length ? isoFromSeconds(Math.max(...periodEnds)) : best ? best.end : previous ? previous.currentPeriodEnd ?? null : null;
	const currentPeriodStart = periodStarts.length ? isoFromSeconds(Math.max(...periodStarts)) : best ? best.start : previous ? previous.currentPeriodStart ?? null : null;

	const scheduled = status === 'active' && (subscription.cancel_at_period_end === true || typeof subscription.cancel_at === 'number');
	const endedAt =
		status === 'ended'
			? isoFromSeconds(subscription.ended_at) || isoFromSeconds(subscription.canceled_at) || (previous ? previous.endedAt ?? null : null)
			: null;

	const priceItem = items[0];
	const patch = {
		customerId,
		subscriptionId: subscription.id,
		priceId: priceItem && priceItem.price ? priceItem.price.id ?? null : previous ? previous.priceId ?? null : null,
		status,
		currentPeriodStart,
		currentPeriodEnd,
		paidThrough,
		cancelAtPeriodEnd: scheduled,
		cancelAt: scheduled ? isoFromSeconds(subscription.cancel_at) : null,
		endedAt,
		paymentGraceUntil,
		lastPaidInvoiceId: best && (!storedPaidThrough || new Date(best.end).getTime() >= new Date(storedPaidThrough).getTime())
			? best.invoiceId
			: previous
				? previous.lastPaidInvoiceId ?? null
				: null,
	};
	const to = status === 'active' && scheduled ? 'cancel_scheduled' : status;
	return { action: 'write', patch, from, to };
}

// True when the stored record already says exactly this: a replay or a
// second event for the same state, which must not churn entitlementVersion.
export function patchMatches(previous, patch) {
	if (!previous) return false;
	return Object.entries(patch).every(([key, value]) => JSON.stringify(previous[key] ?? null) === JSON.stringify(value ?? null));
}
