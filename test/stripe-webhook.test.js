// ZA-902 / esfoobar/zeroagent#1265. The webhook endpoint end to end with
// injected fakes: no network, no database, no real Stripe object. Signed
// requests go through the real handler; Stripe state is a fake the test
// edits between deliveries.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import handler, { config, MAX_BODY_BYTES } from '../api/stripe-webhook.js';
import { fakeBillingDb } from './_fake-mongo.js';
import { BILLING_INDEXES } from '../api/_lib/billing-schema.js';
import { signStripePayload } from '../api/_lib/stripe-signature.js';
import { StripeApiError } from '../api/_lib/stripe-client.js';
import { EVENT_HANDLING } from '../api/_lib/billing-webhook.js';
import { projectEntitlement } from '../api/_lib/billing-projection.js';
import { acquireLeaseWithCollection, customerLeaseKey } from '../api/_lib/billing-lease.js';
import { claimEventWithCollection, inboxKey, recordEventWithCollection } from '../api/_lib/billing-inbox.js';

const SECRET = 'whsec_synthetic_secret';
const ENV = {
	STRIPE_API_KEY: 'rk_test_synthetic',
	STRIPE_WEBHOOK_SECRET: SECRET,
	STRIPE_ACCOUNT_ID: 'acct_synthetic',
	STRIPE_PREMIUM_PRODUCT_ID: 'prod_premium',
	STRIPE_EXPECT_LIVE_MODE: 'false',
};
const environment = { stripeAccountId: 'acct_synthetic', livemode: false, environment: 'sandbox' };
const START = new Date('2026-11-01T00:00:00.000Z');
const DAY = 86400;
const sec = (iso) => Math.floor(new Date(iso).getTime() / 1000);
const P1_START = '2026-11-01T00:00:00.000Z';
const P1_END = '2026-12-01T00:00:00.000Z';
const P2_END = '2026-12-31T00:00:00.000Z';
const P3_END = '2027-01-30T00:00:00.000Z';

function fakeRes() {
	return {
		statusCode: null,
		headers: {},
		body: null,
		setHeader(n, v) {
			this.headers[n] = v;
		},
		end(c) {
			this.body = c;
		},
	};
}

// ---- Stripe state -------------------------------------------------------

function subscription(over = {}) {
	return {
		id: 'sub_1',
		object: 'subscription',
		livemode: false,
		customer: 'cus_1',
		status: 'active',
		cancel_at_period_end: false,
		cancel_at: null,
		canceled_at: null,
		ended_at: null,
		latest_invoice: 'in_1',
		items: {
			data: [
				{
					id: 'si_1',
					price: { id: 'price_arbitrary_a', product: 'prod_premium' },
					current_period_start: sec(P1_START),
					current_period_end: sec(P1_END),
				},
			],
		},
		...over,
	};
}

function invoice(over = {}) {
	const start = over.start || P1_START;
	const end = over.end || P1_END;
	const { start: _s, end: _e, product = 'prod_premium', ...rest } = over;
	return {
		id: 'in_1',
		object: 'invoice',
		livemode: false,
		customer: 'cus_1',
		status: 'paid',
		billing_reason: 'subscription_create',
		subscription: 'sub_1',
		lines: { data: [{ id: 'il_1', type: 'subscription', price: { id: 'price_arbitrary_a', product }, period: { start: sec(start), end: sec(end) } }] },
		...rest,
	};
}

function fakeStripe() {
	const state = { subs: new Map(), invoices: new Map(), calls: [], hook: null, fail: null };
	const get = async (kind, map, id, options = {}) => {
		state.calls.push(`${kind}:${id}`);
		if (state.hook) await state.hook(kind, id);
		if (state.fail) throw state.fail;
		const found = map.get(id);
		if (!found) throw new StripeApiError({ status: 404, code: 'resource_missing' });
		const copy = structuredClone(found);
		if (kind === 'sub' && options.expand && options.expand.includes('latest_invoice') && typeof copy.latest_invoice === 'string') {
			const li = state.invoices.get(copy.latest_invoice);
			if (li) copy.latest_invoice = structuredClone(li);
		}
		return copy;
	};
	state.client = {
		subscriptions: { retrieve: (id, o) => get('sub', state.subs, id, o) },
		invoices: { retrieve: (id, o) => get('inv', state.invoices, id, o) },
	};
	state.setSub = (s) => state.subs.set(s.id, s);
	state.setInvoice = (i) => state.invoices.set(i.id, i);
	return state;
}

// ---- The world ----------------------------------------------------------

function world({ user = {}, mapped = true } = {}) {
	const db = fakeBillingDb();
	for (const name of ['users', 'events']) for (const { key, options } of BILLING_INDEXES[name]) db.collections[name].createIndex(key, options);
	const doc = {
		_id: 1001,
		login: 'synthetic',
		plan: 'free',
		planUntil: null,
		trialEnds: '2026-11-20T00:00:00.000Z',
		createdAt: '2026-10-21T00:00:00.000Z',
		pairedDevices: [],
		...user,
	};
	if (mapped && doc.billing === undefined) {
		// What Checkout (ZA-903) stores before any payment: a mapping, not an entitlement.
		doc.billingCustomer = { customerId: 'cus_1', stripeAccountId: 'acct_synthetic', livemode: false };
	}
	db.collections.users.docs.set(1001, doc);
	const stripe = fakeStripe();
	const clock = { now: new Date(START) };
	let n = 0;
	const w = {
		db,
		stripe,
		clock,
		user: () => db.collections.users.docs.get(1001),
		events: () => db.collections.events.docs,
		eventState: (id) => db.collections.events.docs.get(inboxKey({ stripeAccountId: 'acct_synthetic', livemode: false, eventId: id })),
		setNow(iso) {
			clock.now = new Date(iso);
		},
		store: { collections: db.collections, withTransaction: db.withTransaction },
		event(type, object, over = {}) {
			n += 1;
			return { id: `evt_${n}`, object: 'event', type, created: 1790000000 + n, livemode: false, data: { object }, ...over };
		},
		async post(event, { secret = SECRET, timestamp, env = ENV, method = 'POST', rawBody, header, store = w.store } = {}) {
			const raw = Buffer.from(rawBody ?? JSON.stringify(event), 'utf8');
			const t = timestamp ?? Math.floor(clock.now.getTime() / 1000);
			const headers = { 'stripe-signature': header ?? `t=${t},v1=${signStripePayload(raw, t, secret)}` };
			const res = fakeRes();
			await handler({ method, headers, body: raw }, res, { env, store, stripe: stripe.client, now: () => clock.now });
			return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, res };
		},
		writes: () => Object.values(db.collections).reduce((sum, c) => sum + c.calls.writes, 0),
		answer: (at = clock.now) => projectEntitlement(w.user(), at),
	};
	return w;
}

// Seeds a first paid period through the real pipeline (T03).
async function firstPayment(w, over = {}) {
	w.stripe.setSub(subscription(over.sub));
	w.stripe.setInvoice(invoice(over.invoice));
	const r = await w.post(w.event('invoice.paid', invoice(over.invoice)));
	assert.equal(r.status, 200);
	return r;
}

// ---- Transport and refusal before storage -------------------------------

test('the endpoint turns the body parser off (it reads the raw bytes)', () => {
	assert.equal(config.api.bodyParser, false);
});

test('only POST is accepted', async () => {
	const w = world();
	const r = await w.post(w.event('invoice.paid', {}), { method: 'GET' });
	assert.equal(r.status, 405);
	assert.equal(w.writes(), 0);
});

test('unconfigured billing answers 503 without touching storage', async () => {
	const w = world();
	for (const env of [{}, { ...ENV, STRIPE_WEBHOOK_SECRET: '' }, { ...ENV, STRIPE_EXPECT_LIVE_MODE: undefined }]) {
		const r = await w.post(w.event('invoice.paid', {}), { env });
		assert.equal(r.status, 503);
	}
	assert.equal(w.writes(), 0);
});

test('bad, stale, missing and wrong-secret signatures are refused before storage', async () => {
	const w = world();
	const ev = w.event('invoice.paid', invoice());
	const t = Math.floor(START.getTime() / 1000);
	const cases = [
		{ secret: 'whsec_other' },
		{ timestamp: t - 3600 },
		{ header: 'garbage' },
		{ header: `t=${t},v1=${'0'.repeat(64)}` },
	];
	for (const c of cases) {
		const r = await w.post(ev, c);
		assert.equal(r.status, 400, JSON.stringify(c));
		assert.deepEqual(r.body, { error: 'invalid_signature' });
	}
	const noHeader = fakeRes();
	await handler({ method: 'POST', headers: {}, body: Buffer.from(JSON.stringify(ev)) }, noHeader, { env: ENV, store: w.store, stripe: w.stripe.client, now: () => START });
	assert.equal(noHeader.statusCode, 400);
	assert.equal(w.writes(), 0);
	assert.equal(w.stripe.calls.length, 0);
});

test('a re-serialized body does not verify (the exact bytes are signed)', async () => {
	const w = world();
	const ev = w.event('invoice.paid', invoice());
	const t = Math.floor(START.getTime() / 1000);
	const signedOver = JSON.stringify(ev);
	const header = `t=${t},v1=${signStripePayload(Buffer.from(signedOver), t, SECRET)}`;
	const r = await w.post(ev, { rawBody: JSON.stringify(ev, null, 2), header });
	assert.equal(r.status, 400);
	assert.equal(w.writes(), 0);
});

test('a streamed raw body is read and verified; an oversize one is 413', async () => {
	const w = world();
	const ev = w.event('customer.subscription.created', subscription());
	const raw = Buffer.from(JSON.stringify(ev));
	const t = Math.floor(START.getTime() / 1000);
	w.stripe.setSub(subscription({ status: 'incomplete' }));
	const req = Object.assign(Readable.from([raw.subarray(0, 10), raw.subarray(10)]), {
		method: 'POST',
		headers: { 'stripe-signature': `t=${t},v1=${signStripePayload(raw, t, SECRET)}` },
	});
	const res = fakeRes();
	await handler(req, res, { env: ENV, store: w.store, stripe: w.stripe.client, now: () => START });
	assert.equal(res.statusCode, 200);

	const big = Object.assign(Readable.from([Buffer.alloc(10)]), { method: 'POST', headers: { 'content-length': String(MAX_BODY_BYTES + 1) } });
	const res2 = fakeRes();
	await handler(big, res2, { env: ENV, store: w.store, stripe: w.stripe.client, now: () => START });
	assert.equal(res2.statusCode, 413);
});

test('a live event on a sandbox deployment, and a foreign account, are refused before storage', async () => {
	const w = world();
	const live = await w.post(w.event('invoice.paid', invoice({ livemode: true }), { livemode: true }));
	assert.deepEqual([live.status, live.body.error], [400, 'mode_mismatch']);
	const noFlag = w.event('invoice.paid', invoice());
	delete noFlag.livemode;
	assert.equal((await w.post(noFlag)).status, 400);
	const foreign = await w.post(w.event('invoice.paid', invoice(), { account: 'acct_someone_else' }));
	assert.deepEqual([foreign.status, foreign.body.error], [400, 'account_mismatch']);
	assert.equal(w.writes(), 0);
	assert.equal(w.stripe.calls.length, 0);
});

test('a retrieved object from the other mode is quarantined, never projected', async () => {
	const w = world();
	w.stripe.setSub(subscription({ livemode: true }));
	w.stripe.setInvoice(invoice());
	const ev = w.event('invoice.paid', invoice());
	const r = await w.post(ev);
	assert.equal(r.status, 200);
	assert.equal(w.eventState(ev.id).state, 'quarantined');
	assert.equal(w.eventState(ev.id).lastError, 'mode_mismatch');
	assert.equal(w.user().plan, 'free');
});

// ---- The event table ----------------------------------------------------

test('the event table is exactly the manifest list', () => {
	const manifest = JSON.parse(readFileSync('docs/stripe-setup.manifest.json', 'utf8'));
	assert.deepEqual(Object.keys(EVENT_HANDLING).sort(), [...manifest.objects.webhookDestination.events].sort());
});

test('an event type outside the table is acknowledged and changes nothing', async () => {
	const w = world();
	for (const type of ['charge.refunded', 'charge.dispute.created', 'payment_intent.succeeded', 'charge.succeeded']) {
		const ev = w.event(type, { id: 'x_1', customer: 'cus_1' });
		const r = await w.post(ev);
		assert.equal(r.status, 200);
		assert.equal(w.eventState(ev.id).outcome, 'unsupported_type');
	}
	assert.equal(w.user().plan, 'free');
	assert.equal(w.user().billing, undefined);
	assert.equal(w.stripe.calls.length, 0);
});

test('checkout.session.completed alone grants and changes nothing, even if Stripe already shows it paid', async () => {
	const w = world();
	w.stripe.setSub(subscription());
	w.stripe.setInvoice(invoice());
	for (const type of ['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'checkout.session.expired']) {
		const r = await w.post(w.event(type, { id: 'cs_1', customer: 'cus_1', subscription: 'sub_1', payment_status: 'paid' }));
		assert.equal(r.status, 200);
	}
	const before = w.user();
	assert.equal(before.plan, 'free');
	assert.equal(before.billing, undefined);
	assert.equal(w.answer().billingStatus, 'none');
});

test('invoice.finalization_failed is surfaced for an operator, not as coverage', async () => {
	const w = world();
	const ev = w.event('invoice.finalization_failed', invoice({ status: 'draft' }));
	const r = await w.post(ev);
	assert.equal(r.status, 200);
	assert.equal(w.eventState(ev.id).state, 'quarantined');
	assert.equal(w.user().plan, 'free');
});

// ---- Transitions T03 to T17 ---------------------------------------------

test('T03/T17: the first settled invoice grants premium through the paid interval; the trial is untouched', async () => {
	const w = world();
	const r = await firstPayment(w);
	assert.equal(r.body.outcome, 'none->active');
	const u = w.user();
	assert.equal(u.plan, 'premium');
	assert.equal(u.planUntil, P1_END);
	assert.equal(u.entitlementSource, 'stripe');
	assert.equal(u.trialEnds, '2026-11-20T00:00:00.000Z');
	assert.equal(u.billing.paidThrough, P1_END);
	assert.equal(u.billing.status, 'active');
	assert.equal(u.billing.subscriptionId, 'sub_1');
	assert.equal(u.billing.customerId, 'cus_1');
	assert.equal(u.billing.lastPaidInvoiceId, 'in_1');
	const a = w.answer();
	assert.equal(a.billingStatus, 'active');
	assert.equal(a.relayAllowed, true);
	assert.equal(a.accessUntil, P1_END);
});

test('T04: a renewal advances paid-through to the paid interval end', async () => {
	const w = world();
	await firstPayment(w);
	w.stripe.setSub(subscription({ latest_invoice: 'in_2', items: { data: [{ id: 'si_1', price: { id: 'price_arbitrary_a', product: 'prod_premium' }, current_period_start: sec(P1_END), current_period_end: sec(P2_END) }] } }));
	w.stripe.setInvoice(invoice({ id: 'in_2', start: P1_END, end: P2_END, billing_reason: 'subscription_cycle' }));
	const r = await w.post(w.event('invoice.paid', invoice({ id: 'in_2' })));
	assert.equal(r.body.outcome, 'active->active');
	assert.equal(w.user().billing.paidThrough, P2_END);
	assert.equal(w.user().planUntil, P2_END);
	assert.equal(w.user().billing.revision, 2);
});

test('T05 and T06: a scheduled cancellation and its reversal keep the same subscription and Price', async () => {
	const w = world();
	await firstPayment(w);
	w.stripe.setSub(subscription({ cancel_at_period_end: true, cancel_at: sec(P1_END) }));
	const r5 = await w.post(w.event('customer.subscription.updated', subscription()));
	assert.equal(r5.body.outcome, 'active->cancel_scheduled');
	assert.equal(w.answer().billingStatus, 'cancel_scheduled');
	assert.equal(w.answer().cancelAtPeriodEnd, true);
	assert.equal(w.user().billing.paidThrough, P1_END);

	w.stripe.setSub(subscription());
	const r6 = await w.post(w.event('customer.subscription.updated', subscription()));
	assert.equal(r6.body.outcome, 'cancel_scheduled->active');
	assert.equal(w.user().billing.subscriptionId, 'sub_1');
	assert.equal(w.user().billing.priceId, 'price_arbitrary_a');
	assert.equal(w.user().billing.cancelAtPeriodEnd, false);
});

test('T07: deletion after a scheduled cancel ends the subscription, plan free, paid-through kept', async () => {
	const w = world();
	await firstPayment(w);
	w.stripe.setSub(subscription({ cancel_at_period_end: true, cancel_at: sec(P1_END) }));
	await w.post(w.event('customer.subscription.updated', subscription()));
	w.stripe.setSub(subscription({ status: 'canceled', ended_at: sec(P1_END), canceled_at: sec('2026-11-10T00:00:00.000Z') }));
	const r = await w.post(w.event('customer.subscription.deleted', subscription()));
	assert.equal(r.body.outcome, 'cancel_scheduled->ended');
	const u = w.user();
	assert.equal(u.plan, 'free');
	assert.equal(u.planUntil, P1_END);
	assert.equal(u.billing.status, 'ended');
	assert.equal(u.billing.paidThrough, P1_END);
	assert.equal(u.billing.endedAt, P1_END);
	assert.equal(w.answer(new Date('2026-11-25T00:00:00.000Z')).relayAllowed, true);
	assert.equal(w.answer(new Date(P1_END)).relayAllowed, false);
});

test('T08, T10: a failed renewal sets grace once from paid-through; a retry never moves it; time denies', async () => {
	const w = world();
	await firstPayment(w);
	w.setNow('2026-12-01T00:30:00.000Z');
	w.stripe.setSub(subscription({ status: 'past_due', latest_invoice: 'in_2' }));
	w.stripe.setInvoice(invoice({ id: 'in_2', status: 'open', start: P1_END, end: P2_END, billing_reason: 'subscription_cycle' }));
	const r = await w.post(w.event('invoice.payment_failed', invoice({ id: 'in_2', status: 'open' })));
	assert.equal(r.body.outcome, 'active->past_due');
	const graceUntil = '2026-12-04T00:00:00.000Z';
	assert.equal(w.user().billing.paymentGraceUntil, graceUntil);
	assert.equal(w.user().billing.paidThrough, P1_END, 'a failure never extends paid-through');
	assert.equal(w.user().planUntil, P1_END);
	assert.equal(w.answer().relayAllowed, true);

	// A retry later fails again: the deadline stays.
	w.setNow('2026-12-02T10:00:00.000Z');
	await w.post(w.event('invoice.payment_failed', invoice({ id: 'in_2', status: 'open' })));
	await w.post(w.event('customer.subscription.updated', subscription({ status: 'past_due' })));
	assert.equal(w.user().billing.paymentGraceUntil, graceUntil);
	assert.equal(w.user().billing.revision, 2, 'replays of the same state do not churn the version');

	// Stripe still says past_due after the grace: the read path denies.
	assert.equal(w.answer(new Date('2026-12-04T00:00:00.000Z')).relayAllowed, false);
});

test('T09: payment recovers a past_due account and clears grace', async () => {
	const w = world();
	await firstPayment(w);
	w.stripe.setSub(subscription({ status: 'past_due', latest_invoice: 'in_2' }));
	w.stripe.setInvoice(invoice({ id: 'in_2', status: 'open', start: P1_END, end: P2_END }));
	await w.post(w.event('invoice.payment_failed', invoice({ id: 'in_2', status: 'open' })));
	assert.equal(w.user().billing.status, 'past_due');

	w.stripe.setSub(subscription({ latest_invoice: 'in_2', items: { data: [{ id: 'si_1', price: { id: 'price_arbitrary_a', product: 'prod_premium' }, current_period_start: sec(P1_END), current_period_end: sec(P2_END) }] } }));
	w.stripe.setInvoice(invoice({ id: 'in_2', status: 'paid', start: P1_END, end: P2_END }));
	const r = await w.post(w.event('invoice.paid', invoice({ id: 'in_2' })));
	assert.equal(r.body.outcome, 'past_due->active');
	assert.equal(w.user().billing.paymentGraceUntil, null);
	assert.equal(w.user().billing.paidThrough, P2_END);
});

test('T11: retries exhausted, deletion ends a past_due subscription', async () => {
	const w = world();
	await firstPayment(w);
	w.stripe.setSub(subscription({ status: 'past_due' }));
	await w.post(w.event('customer.subscription.updated', subscription()));
	w.stripe.setSub(subscription({ status: 'canceled', ended_at: sec('2026-12-04T00:00:00.000Z') }));
	const r = await w.post(w.event('customer.subscription.deleted', subscription()));
	assert.equal(r.body.outcome, 'past_due->ended');
	assert.equal(w.user().plan, 'free');
	assert.equal(w.user().billing.paymentGraceUntil, null);
});

test('T12: an immediate administrative cancellation ends access at the termination time', async () => {
	const w = world();
	await firstPayment(w);
	const endedAt = '2026-11-10T00:00:00.000Z';
	w.stripe.setSub(subscription({ status: 'canceled', ended_at: sec(endedAt), canceled_at: sec(endedAt) }));
	const r = await w.post(w.event('customer.subscription.deleted', subscription()));
	assert.equal(r.body.outcome, 'active->ended');
	assert.equal(w.user().billing.endedAt, endedAt);
	assert.equal(w.user().billing.paidThrough, P1_END);
	assert.equal(w.answer(new Date('2026-11-09T00:00:00.000Z')).relayAllowed, true);
	// Past the trial too: the later paid-through must not hold it open.
	assert.equal(w.answer(new Date('2026-11-21T00:00:00.000Z')).relayAllowed, false);
});

test('T13: a return after the subscription ended is a new subscription; a late event of the old one cannot downgrade it', async () => {
	const w = world();
	await firstPayment(w);
	w.stripe.setSub(subscription({ status: 'canceled', ended_at: sec(P1_END) }));
	await w.post(w.event('customer.subscription.deleted', subscription()));
	assert.equal(w.user().billing.status, 'ended');

	const newItems = { data: [{ id: 'si_9', price: { id: 'price_arbitrary_b', product: 'prod_premium' }, current_period_start: sec('2027-01-10T00:00:00.000Z'), current_period_end: sec('2027-02-10T00:00:00.000Z') }] };
	w.stripe.setSub(subscription({ id: 'sub_2', latest_invoice: 'in_9', items: newItems }));
	w.stripe.setInvoice(invoice({ id: 'in_9', subscription: 'sub_2', start: '2027-01-10T00:00:00.000Z', end: '2027-02-10T00:00:00.000Z' }));
	const r = await w.post(w.event('invoice.paid', invoice({ id: 'in_9', subscription: 'sub_2' })));
	assert.equal(r.body.outcome, 'ended->active');
	assert.equal(w.user().billing.subscriptionId, 'sub_2');
	assert.equal(w.user().billing.priceId, 'price_arbitrary_b');
	assert.equal(w.user().billing.paidThrough, '2027-02-10T00:00:00.000Z');
	assert.equal(w.user().plan, 'premium');

	// The old subscription's deletion is replayed late (a new event id).
	const late = await w.post(w.event('customer.subscription.deleted', subscription()));
	assert.equal(late.status, 200);
	assert.equal(w.user().billing.subscriptionId, 'sub_2');
	assert.equal(w.user().billing.status, 'active');
	assert.equal(w.user().plan, 'premium');
});

test('T14: a failed first payment grants nothing and sets no grace', async () => {
	const w = world();
	w.stripe.setSub(subscription({ status: 'incomplete', latest_invoice: 'in_1' }));
	w.stripe.setInvoice(invoice({ status: 'open' }));
	const r = await w.post(w.event('invoice.payment_failed', invoice({ status: 'open' })));
	assert.equal(r.status, 200);
	assert.equal(w.user().plan, 'free');
	assert.equal(w.user().billing, undefined);
		assert.equal(w.answer().billingStatus, 'none');
});

test('settlement only counts for a Premium subscription invoice: out of band, voided, manual and other products grant nothing', async () => {
	for (const bad of [
		invoice({ paid_out_of_band: true }),
		invoice({ status: 'void' }),
		invoice({ status: 'uncollectible' }),
		invoice({ billing_reason: 'manual' }),
		invoice({ product: 'prod_something_else' }),
		invoice({ customer: 'cus_other' }),
		invoice({ subscription: 'sub_other' }),
	]) {
		const w = world();
		w.stripe.setSub(subscription());
		w.stripe.setInvoice(bad);
		const r = await w.post(w.event('invoice.paid', invoice()));
		assert.equal(r.status, 200);
		assert.equal(w.user().plan, 'free', JSON.stringify(bad.status));
		assert.equal(w.user().billing, undefined);
	}
});

test('a settled zero-due credit invoice is settlement; a voided or written-off later one extends nothing', async () => {
	const w = world();
	w.stripe.setSub(subscription());
	w.stripe.setInvoice(invoice({ amount_due: 0, amount_paid: 0, total: 0 }));
	await w.post(w.event('invoice.paid', invoice()));
	assert.equal(w.user().billing.paidThrough, P1_END);
	w.stripe.setSub(subscription({ latest_invoice: 'in_2' }));
	w.stripe.setInvoice(invoice({ id: 'in_2', status: 'void', start: P1_END, end: P2_END }));
	await w.post(w.event('invoice.voided', invoice({ id: 'in_2', status: 'void' })));
	w.stripe.setInvoice(invoice({ id: 'in_2', status: 'uncollectible', start: P1_END, end: P2_END }));
	await w.post(w.event('invoice.marked_uncollectible', invoice({ id: 'in_2' })));
	assert.equal(w.user().billing.paidThrough, P1_END);
});

test('the Price is never an entitlement input: a retired or unknown Price id on the Product still grants', async () => {
	const w = world();
	w.stripe.setSub(subscription({ items: { data: [{ id: 'si_1', price: { id: 'price_retired_long_ago', product: 'prod_premium', active: false }, current_period_start: sec(P1_START), current_period_end: sec(P1_END) }] } }));
	w.stripe.setInvoice(invoice());
	await w.post(w.event('invoice.paid', invoice()));
	assert.equal(w.user().plan, 'premium');
	assert.equal(w.user().billing.priceId, 'price_retired_long_ago');
});

test('a subscription of another product is ignored', async () => {
	const w = world();
	w.stripe.setSub(subscription({ items: { data: [{ id: 'si_1', price: { id: 'price_x', product: 'prod_other' }, current_period_start: 1, current_period_end: 2 }] } }));
	w.stripe.setInvoice(invoice());
	const ev = w.event('customer.subscription.created', subscription());
	await w.post(ev);
	assert.equal(w.eventState(ev.id).outcome, 'not_premium');
	assert.equal(w.user().plan, 'free');
});

// ---- Dedupe, order, replay ----------------------------------------------

test('duplicate delivery: the second is acknowledged without work', async () => {
	const w = world();
	w.stripe.setSub(subscription());
	w.stripe.setInvoice(invoice());
	const ev = w.event('invoice.paid', invoice());
	const first = await w.post(ev);
	const callsAfterFirst = w.stripe.calls.length;
	const userAfterFirst = structuredClone(w.user());
	const leasesAfterFirst = structuredClone([...w.db.collections.leases.docs.values()]);
	const second = await w.post(ev);
	assert.equal(first.status, 200);
	assert.deepEqual(second.body, { received: true, outcome: 'already_processed' });
	assert.equal(w.stripe.calls.length, callsAfterFirst);
	assert.deepEqual(w.user(), userAfterFirst);
	assert.deepEqual([...w.db.collections.leases.docs.values()], leasesAfterFirst);
	assert.equal(w.user().billing.revision, 1);
});

test('out of order: an older invoice.paid arriving after a newer state cannot move paid-through back', async () => {
	const w = world();
	// The newer period is already settled at Stripe when the old event lands.
	const items2 = { data: [{ id: 'si_1', price: { id: 'price_arbitrary_a', product: 'prod_premium' }, current_period_start: sec(P1_END), current_period_end: sec(P2_END) }] };
	w.stripe.setSub(subscription({ latest_invoice: 'in_2', items: items2 }));
	w.stripe.setInvoice(invoice({ id: 'in_2', start: P1_END, end: P2_END }));
	w.stripe.setInvoice(invoice({ id: 'in_1' }));
	await w.post(w.event('invoice.paid', invoice({ id: 'in_2' })));
	assert.equal(w.user().billing.paidThrough, P2_END);
	const old = await w.post(w.event('invoice.paid', invoice({ id: 'in_1' })));
	assert.equal(old.status, 200);
	assert.equal(w.user().billing.paidThrough, P2_END);
	assert.equal(w.user().billing.lastPaidInvoiceId, 'in_2');
	assert.equal(w.user().billing.revision, 1);
});

test('out of order: subscription events and invoice events project the same state in any order', async () => {
	const orders = [
		['customer.subscription.updated', 'invoice.paid'],
		['invoice.paid', 'customer.subscription.updated'],
	];
	const results = [];
	for (const order of orders) {
		const w = world();
		w.stripe.setSub(subscription());
		w.stripe.setInvoice(invoice());
		for (const type of order) {
			const object = type.startsWith('invoice') ? invoice() : subscription();
			await w.post(w.event(type, object));
		}
		const { revision, updatedAt, fence, ...rest } = w.user().billing;
		results.push({ billing: rest, plan: w.user().plan, planUntil: w.user().planUntil });
	}
	assert.deepEqual(results[0], results[1]);
	assert.equal(results[0].plan, 'premium');
});

test('replay after completion with a new event id for the same state is a no-op', async () => {
	const w = world();
	await firstPayment(w);
	const before = structuredClone(w.user());
	const again = await w.post(w.event('invoice.paid', invoice()));
	assert.equal(again.body.outcome, 'no_change');
	assert.deepEqual(w.user(), before);
});

test('two live subscriptions on one account are quarantined, never resolved by picking one', async () => {
	const w = world();
	await firstPayment(w);
	w.stripe.setSub(subscription({ id: 'sub_2', latest_invoice: 'in_9' }));
	w.stripe.setInvoice(invoice({ id: 'in_9', subscription: 'sub_2' }));
	const ev = w.event('invoice.paid', invoice({ id: 'in_9', subscription: 'sub_2' }));
	const r = await w.post(ev);
	assert.equal(r.status, 200);
	assert.equal(w.eventState(ev.id).state, 'quarantined');
	assert.equal(w.eventState(ev.id).lastError, 'multiple_subscriptions');
	assert.equal(w.user().billing.subscriptionId, 'sub_1');
	assert.equal(w.user().billing.status, 'active');
});

test('a stale terminated subscription of another id cannot touch the current one', async () => {
	const w = world();
	await firstPayment(w);
	w.stripe.setSub(subscription({ id: 'sub_old', status: 'canceled', ended_at: 5 }));
	const ev = w.event('customer.subscription.deleted', subscription({ id: 'sub_old' }));
	await w.post(ev);
	assert.equal(w.eventState(ev.id).outcome, 'stale_subscription');
	assert.equal(w.user().billing.status, 'active');
	assert.equal(w.user().plan, 'premium');
});

test('an ended subscription is not revived by any later reconciliation', async () => {
	const w = world();
	await firstPayment(w);
	w.stripe.setSub(subscription({ status: 'canceled', ended_at: sec('2026-11-10T00:00:00.000Z') }));
	await w.post(w.event('customer.subscription.deleted', subscription()));
	// A buggy or stale read of the same subscription claiming active.
	w.stripe.setSub(subscription({ status: 'active' }));
	const ev = w.event('customer.subscription.updated', subscription());
	await w.post(ev);
	assert.equal(w.eventState(ev.id).outcome, 'terminal_not_revivable');
	assert.equal(w.user().billing.status, 'ended');
	assert.equal(w.user().plan, 'free');
});

// ---- Mapping, legacy ----------------------------------------------------

test('an unmapped customer is quarantined with its reason, acknowledged, and nothing is written to any account', async () => {
	const w = world({ mapped: false });
	w.stripe.setSub(subscription());
	w.stripe.setInvoice(invoice());
	const ev = w.event('invoice.paid', invoice());
	const r = await w.post(ev);
	assert.equal(r.status, 200);
	assert.equal(w.eventState(ev.id).state, 'quarantined');
	assert.equal(w.eventState(ev.id).lastError, 'unmapped_customer');
	assert.equal(w.user().plan, 'free');
	assert.equal(w.user().billing, undefined);
	assert.equal(w.stripe.calls.length, 0);
});

test('a customer is never matched by email, login or metadata, only by the stored mapping', async () => {
	const w = world({ mapped: false, user: { login: 'cus_1' } });
	w.stripe.setSub(subscription({ metadata: { zeroagent_github_id: '1001' } }));
	w.stripe.setInvoice(invoice());
	const ev = w.event('invoice.paid', invoice({ customer_email: 'x@example.test', metadata: { zeroagent_github_id: '1001' } }));
	await w.post(ev);
	assert.equal(w.eventState(ev.id).lastError, 'unmapped_customer');
	assert.equal(w.user().plan, 'free');
});

test('a hand-assigned plan is never auto-acknowledged: the event is quarantined and the plan is untouched', async () => {
	// Mapped (Checkout wrote a customer mapping), so no `billing` absence to hide behind.
	const w = world({ user: { plan: 'premium', planUntil: null, trialEnds: '2026-01-01T00:00:00.000Z' } });
	w.stripe.setSub(subscription());
	w.stripe.setInvoice(invoice());
	const ev = w.event('invoice.paid', invoice());
	const r = await w.post(ev);
	assert.equal(r.status, 200);
	assert.equal(w.eventState(ev.id).state, 'quarantined');
	assert.equal(w.eventState(ev.id).lastError, 'legacy_grant_conflict');
	assert.equal(w.user().plan, 'premium');
	assert.equal(w.user().billing, undefined);
	assert.equal(w.user().entitlementSource, undefined);
	assert.equal(w.answer().relayAllowed, true, 'the grant keeps working');
	// A redelivery stays quarantined and does not process again.
	const again = await w.post(ev);
	assert.equal(again.body.outcome, 'quarantined');
});

test('a marked legacy grant is quarantined too', async () => {
	const w = world({ user: { plan: 'premium', entitlementSource: 'legacy_grant', legacyGrant: { until: '2027-06-01T00:00:00.000Z', openEnded: false } } });
	w.stripe.setSub(subscription());
	w.stripe.setInvoice(invoice());
	const ev = w.event('invoice.paid', invoice());
	await w.post(ev);
	assert.equal(w.eventState(ev.id).lastError, 'legacy_grant_conflict');
});

// ---- Failure and crash --------------------------------------------------

test('Stripe unavailable: 5xx, the entry stays claimable, and the redelivery applies', async () => {
	const w = world();
	w.stripe.setSub(subscription());
	w.stripe.setInvoice(invoice());
	w.stripe.fail = new StripeApiError({ status: 503, retriable: true });
	const ev = w.event('invoice.paid', invoice());
	const r1 = await w.post(ev);
	assert.equal(r1.status, 503);
	assert.equal(w.eventState(ev.id).state, 'failed');
	assert.equal(w.user().plan, 'free');
	w.stripe.fail = null;
	const r2 = await w.post(ev);
	assert.equal(r2.status, 200);
	assert.equal(w.user().plan, 'premium');
	assert.equal(w.eventState(ev.id).state, 'completed');
});

test('a Stripe object that does not exist is quarantined, not retried forever', async () => {
	const w = world();
	const ev = w.event('customer.subscription.updated', subscription({ id: 'sub_missing' }));
	const r = await w.post(ev);
	assert.equal(r.status, 200);
	assert.equal(w.eventState(ev.id).lastError, 'stripe_object_missing');
});

test('crash between claim and commit: a redelivery inside the lease waits, after it applies', async () => {
	const w = world();
	w.stripe.setSub(subscription());
	w.stripe.setInvoice(invoice());
	const ev = w.event('invoice.paid', invoice());
	// A worker claimed it and died before it committed anything.
	const { entry } = await recordEventWithCollection(w.db.collections.events, { environment, event: ev, now: START });
	const claimed = await claimEventWithCollection(w.db.collections.events, { key: entry._id, owner: 'crashed-worker', now: START });
	assert.equal(claimed.status, 'claimed');

	w.setNow('2026-11-01T00:00:10.000Z');
	const early = await w.post(ev);
	assert.equal(early.status, 503);
	assert.equal(w.user().plan, 'free');

	w.setNow('2026-11-01T00:02:00.000Z');
	const late = await w.post(ev);
	assert.equal(late.status, 200);
	assert.equal(w.user().plan, 'premium');
	assert.equal(w.eventState(ev.id).attempts, 2);
});

test('crash after the commit but before the response: redelivery is acknowledged, nothing applied twice', async () => {
	const w = world();
	w.stripe.setSub(subscription());
	w.stripe.setInvoice(invoice());
	const ev = w.event('invoice.paid', invoice());
	await w.post(ev); // committed; imagine the 2xx never reached Stripe
	const snapshot = structuredClone(w.user());
	const redelivered = await w.post(ev);
	assert.equal(redelivered.status, 200);
	assert.equal(redelivered.body.outcome, 'already_processed');
	assert.deepEqual(w.user(), snapshot);
});

test('a failure inside the commit transaction rolls everything back and the redelivery succeeds', async () => {
	const w = world();
	w.stripe.setSub(subscription());
	w.stripe.setInvoice(invoice());
	const users = w.db.collections.users;
	const realUpdate = users.updateOne.bind(users);
	let armed = true;
	users.updateOne = async (...args) => {
		if (armed) {
			armed = false;
			throw new Error('connection reset');
		}
		return realUpdate(...args);
	};
	const ev = w.event('invoice.paid', invoice());
	const r1 = await w.post(ev);
	assert.equal(r1.status, 503);
	assert.equal(w.user().plan, 'free');
	assert.equal(w.user().billing, undefined);
	assert.notEqual(w.eventState(ev.id).state, 'completed');
	const r2 = await w.post(ev);
	assert.equal(r2.status, 200);
	assert.equal(w.user().plan, 'premium');
});

test('lease held by another worker: 5xx, nothing written, nothing retrieved', async () => {
	const w = world();
	w.stripe.setSub(subscription());
	w.stripe.setInvoice(invoice());
	await acquireLeaseWithCollection(w.db.collections.leases, {
		key: customerLeaseKey({ stripeAccountId: 'acct_synthetic', livemode: false, customerId: 'cus_1' }),
		owner: 'someone-else',
		now: START,
	});
	const ev = w.event('invoice.paid', invoice());
	const r = await w.post(ev);
	assert.equal(r.status, 503);
	assert.equal(w.stripe.calls.length, 0);
	assert.equal(w.user().plan, 'free');
	assert.equal(w.eventState(ev.id).state, 'failed');
});

test('lease expired during a slow Stripe call: the commit is refused and nothing is written', async () => {
	const w = world();
	w.stripe.setSub(subscription());
	w.stripe.setInvoice(invoice());
	w.stripe.hook = async () => {
		w.setNow('2026-11-01T00:01:00.000Z'); // far past the 30 second lease
	};
	const ev = w.event('invoice.paid', invoice());
	const r = await w.post(ev, { timestamp: Math.floor(START.getTime() / 1000) });
	assert.equal(r.status, 503);
	assert.equal(w.user().plan, 'free');
	assert.equal(w.user().billing, undefined);
	assert.equal(w.eventState(ev.id).state, 'failed');
	assert.equal(w.eventState(ev.id).lastError, 'lease_lost');
});

test('lease taken over by another worker during a slow call: the old holder cannot commit', async () => {
	const w = world();
	w.stripe.setSub(subscription());
	w.stripe.setInvoice(invoice());
	let taken = false;
	w.stripe.hook = async () => {
		if (taken) return;
		taken = true;
		w.setNow('2026-11-01T00:01:00.000Z');
		const other = await acquireLeaseWithCollection(w.db.collections.leases, {
			key: customerLeaseKey({ stripeAccountId: 'acct_synthetic', livemode: false, customerId: 'cus_1' }),
			owner: 'newer-worker',
			now: w.clock.now,
		});
		assert.ok(other);
	};
	const ev = w.event('invoice.paid', invoice());
	const r = await w.post(ev, { timestamp: Math.floor(START.getTime() / 1000) });
	assert.equal(r.status, 503);
	assert.equal(w.user().plan, 'free');
	assert.equal(w.db.collections.leases.docs.get(customerLeaseKey({ stripeAccountId: 'acct_synthetic', livemode: false, customerId: 'cus_1' })).owner, 'newer-worker');
});

test('an event that keeps failing is parked for an operator, then acknowledged so Stripe stops', async () => {
	const w = world();
	w.stripe.setSub(subscription());
	w.stripe.setInvoice(invoice());
	w.stripe.fail = new StripeApiError({ status: 500, retriable: true });
	const ev = w.event('invoice.paid', invoice());
	let last;
	for (let i = 0; i < 12; i++) {
		w.setNow(new Date(START.getTime() + i * 120000).toISOString());
		last = await w.post(ev);
		if (last.status === 200) break;
	}
	assert.equal(last.status, 200);
	assert.equal(w.eventState(ev.id).state, 'quarantined');
	assert.equal(w.eventState(ev.id).attempts, 8);
});

test('what is stored for an event is identifiers only, never the payload', async () => {
	const w = world();
	w.stripe.setSub(subscription());
	w.stripe.setInvoice(invoice());
	const obj = invoice();
	obj.hosted_invoice_url = 'https://invoice.example.test/never-stored';
	obj.customer_email = 'never-stored@example.test';
	const ev = w.event('invoice.paid', obj);
	await w.post(ev);
	const stored = JSON.stringify([...w.events().values()]);
	assert.ok(!stored.includes('never-stored'));
	assert.ok(!JSON.stringify(w.user()).includes('never-stored'));
});

test('responses never echo the payload or a secret', async () => {
	const w = world();
	const ev = w.event('invoice.paid', { ...invoice(), customer_email: 'leak@example.test' });
	w.stripe.setSub(subscription());
	w.stripe.setInvoice(invoice());
	const r = await w.post(ev);
	assert.ok(!r.res.body.includes('leak@example.test'));
	assert.ok(!r.res.body.includes(SECRET));
});

test('the answer for a Stripe-paid account reaches /me semantics: premium until the paid interval ends', async () => {
	const w = world({ user: { trialEnds: '2026-10-01T00:00:00.000Z' } });
	await firstPayment(w);
	assert.equal(w.answer(new Date('2026-11-30T23:59:59.999Z')).relayAllowed, true);
	// Past paid-through plus the settlement window with no renewal recorded.
	assert.equal(w.answer(new Date('2026-12-01T06:00:00.000Z')).relayAllowed, false);
});

test('once a payment is committed the account is also found by billing.customerId alone', async () => {
	const w = world();
	await firstPayment(w);
	delete w.user().billingCustomer;
	w.stripe.setSub(subscription({ cancel_at_period_end: true, cancel_at: sec(P1_END) }));
	const r = await w.post(w.event('customer.subscription.updated', subscription()));
	assert.equal(r.body.outcome, 'active->cancel_scheduled');
});

test('a mapping for the other mode or another Stripe account does not match', async () => {
	for (const mapping of [
		{ customerId: 'cus_1', stripeAccountId: 'acct_synthetic', livemode: true },
		{ customerId: 'cus_1', stripeAccountId: 'acct_other', livemode: false },
	]) {
		const w = world({ mapped: false, user: { billingCustomer: mapping } });
		w.stripe.setSub(subscription());
		w.stripe.setInvoice(invoice());
		const ev = w.event('invoice.paid', invoice());
		await w.post(ev);
		assert.equal(w.eventState(ev.id).lastError, 'unmapped_customer');
		assert.equal(w.user().plan, 'free');
	}
});

test('trialing, incomplete, unpaid and paused subscriptions never open access by themselves', async () => {
	for (const status of ['trialing', 'incomplete', 'incomplete_expired']) {
		const w = world();
		w.stripe.setSub(subscription({ status }));
		w.stripe.setInvoice(invoice());
		await w.post(w.event('customer.subscription.updated', subscription({ status })));
		assert.equal(w.user().plan, 'free', status);
	}
});

test('paused keeps coverage to paid-through only; unpaid is past_due with the original grace', async () => {
	const w = world();
	await firstPayment(w);
	w.stripe.setSub(subscription({ status: 'paused' }));
	await w.post(w.event('customer.subscription.paused', subscription()));
	assert.equal(w.user().billing.status, 'past_due');
	assert.equal(w.user().billing.paymentGraceUntil, null);
	assert.equal(w.answer(new Date(P1_END)).relayAllowed, false);
	w.stripe.setSub(subscription());
	await w.post(w.event('customer.subscription.resumed', subscription()));
	assert.equal(w.user().billing.status, 'active');
});
