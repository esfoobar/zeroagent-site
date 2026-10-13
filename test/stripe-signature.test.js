// ZA-902. Signature verification over raw bytes, and the read-only client.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StripeSignatureError, signStripePayload, verifyStripeSignature } from '../api/_lib/stripe-signature.js';
import { StripeApiError, createStripeClient } from '../api/_lib/stripe-client.js';

const SECRET = 'whsec_synthetic_secret';
const NOW = new Date('2026-11-01T00:00:00.000Z');
const T = Math.floor(NOW.getTime() / 1000);
const body = Buffer.from('{"id":"evt_1","note":"  spacing  matters "}', 'utf8');
const header = (t, sig) => `t=${t},v1=${sig}`;
const good = (t = T, secret = SECRET, raw = body) => header(t, signStripePayload(raw, t, secret));
const code = (fn) => {
	try {
		fn();
	} catch (err) {
		assert.ok(err instanceof StripeSignatureError);
		return err.code;
	}
	assert.fail('expected a signature error');
};

test('a correct signature verifies', () => {
	assert.equal(verifyStripeSignature(body, good(), SECRET, { now: NOW }).timestamp, T);
});

test('a bad signature is refused', () => {
	assert.equal(code(() => verifyStripeSignature(body, header(T, 'a'.repeat(64)), SECRET, { now: NOW })), 'no_matching_signature');
});

test('the wrong secret is refused', () => {
	assert.equal(code(() => verifyStripeSignature(body, good(T, 'whsec_other'), SECRET, { now: NOW })), 'no_matching_signature');
});

test('a body changed by one byte is refused (the bytes are what is signed)', () => {
	const header0 = good();
	const altered = Buffer.from(body.toString().replace('spacing  matters', 'spacing matters'), 'utf8');
	assert.equal(code(() => verifyStripeSignature(altered, header0, SECRET, { now: NOW })), 'no_matching_signature');
});

test('a stale timestamp is refused even with a valid signature', () => {
	const old = T - 301;
	assert.equal(code(() => verifyStripeSignature(body, good(old), SECRET, { now: NOW })), 'timestamp_outside_tolerance');
	assert.doesNotThrow(() => verifyStripeSignature(body, good(T - 299), SECRET, { now: NOW }));
});

test('a timestamp from the future is refused too', () => {
	assert.equal(code(() => verifyStripeSignature(body, good(T + 301), SECRET, { now: NOW })), 'timestamp_outside_tolerance');
});

test('a rotated signing secret sends two v1 entries and either may match', () => {
	const sig = signStripePayload(body, T, SECRET);
	const h = `t=${T},v1=${'b'.repeat(64)},v1=${sig},v0=ignored`;
	assert.doesNotThrow(() => verifyStripeSignature(body, h, SECRET, { now: NOW }));
});

test('missing, malformed and secretless inputs are refused', () => {
	assert.equal(code(() => verifyStripeSignature(body, undefined, SECRET, { now: NOW })), 'missing_header');
	assert.equal(code(() => verifyStripeSignature(body, 'garbage', SECRET, { now: NOW })), 'malformed_header');
	assert.equal(code(() => verifyStripeSignature(body, `t=abc,v1=${'a'.repeat(64)}`, SECRET, { now: NOW })), 'malformed_header');
	assert.equal(code(() => verifyStripeSignature(body, `t=${T}`, SECRET, { now: NOW })), 'malformed_header');
	assert.equal(code(() => verifyStripeSignature(body, good(), '', { now: NOW })), 'no_secret');
	assert.equal(code(() => verifyStripeSignature(body, header(T, 'short'), SECRET, { now: NOW })), 'no_matching_signature');
});

test('the error never carries the header, body or secret', () => {
	try {
		verifyStripeSignature(body, good(T, 'whsec_other'), SECRET, { now: NOW });
	} catch (err) {
		const text = `${err.message} ${JSON.stringify(err)}`;
		assert.ok(!text.includes(SECRET) && !text.includes('evt_1'));
	}
});

// The client.

function fakeFetch(responses) {
	const calls = [];
	const impl = async (url, init) => {
		calls.push({ url, init });
		const next = responses.shift();
		if (next instanceof Error) throw next;
		return { ok: next.status < 400, status: next.status, json: async () => next.body };
	};
	return { impl, calls };
}

test('client: GET with bearer auth, expand encoding and an optional pinned version', async () => {
	const f = fakeFetch([{ status: 200, body: { id: 'sub_1' } }]);
	const client = createStripeClient({ apiKey: 'rk_test_synthetic', apiVersion: '2000-01-01.synthetic', fetchImpl: f.impl });
	assert.deepEqual(await client.subscriptions.retrieve('sub_1', { expand: ['latest_invoice'] }), { id: 'sub_1' });
	assert.equal(f.calls[0].url, 'https://api.stripe.com/v1/subscriptions/sub_1?expand[]=latest_invoice');
	assert.equal(f.calls[0].init.method, 'GET');
	assert.equal(f.calls[0].init.headers.Authorization, 'Bearer rk_test_synthetic');
	assert.equal(f.calls[0].init.headers['Stripe-Version'], '2000-01-01.synthetic');
});

test('client: ids are validated before a path is built', async () => {
	const client = createStripeClient({ apiKey: 'rk_test_synthetic', fetchImpl: async () => assert.fail('no call') });
	assert.throws(() => client.invoices.retrieve('in_1/../customers'));
	assert.throws(() => client.invoices.retrieve(''));
});

test('client: errors keep status, type and code, mark retriable, and never the body', async () => {
	const f = fakeFetch([
		{ status: 404, body: { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such sub rk_test_leak' } } },
		{ status: 503, body: {} },
		{ status: 429, body: {} },
		new Error('socket hang up rk_test_leak'),
	]);
	const client = createStripeClient({ apiKey: 'rk_test_leak', fetchImpl: f.impl });
	const errors = [];
	for (let i = 0; i < 4; i++) errors.push(await client.invoices.retrieve('in_1').catch((e) => e));
	for (const err of errors) {
		assert.ok(err instanceof StripeApiError);
		assert.ok(!`${err.message}${JSON.stringify(err)}`.includes('rk_test_leak'));
	}
	assert.deepEqual(errors.map((e) => [e.status, e.code, e.retriable]), [
		[404, 'resource_missing', false],
		[503, null, true],
		[429, null, true],
		[null, 'network_error', true],
	]);
});

test('client: the general request helper form-encodes a POST and carries an idempotency key', async () => {
	const f = fakeFetch([{ status: 200, body: { id: 'cs_1' } }]);
	const client = createStripeClient({ apiKey: 'rk_test_synthetic', fetchImpl: f.impl });
	await client.request({
		method: 'POST',
		path: '/v1/checkout/sessions',
		form: { mode: 'subscription', line_items: [{ quantity: 1 }], metadata: { a: 'b c' } },
		idempotencyKey: 'op_1',
	});
	const { init } = f.calls[0];
	assert.equal(init.method, 'POST');
	assert.equal(init.headers['Idempotency-Key'], 'op_1');
	assert.equal(init.headers['Content-Type'], 'application/x-www-form-urlencoded');
	assert.equal(init.body, 'mode=subscription&line_items%5B0%5D%5Bquantity%5D=1&metadata%5Ba%5D=b%20c');
});

test('client: billing session methods retain the pinned version and request helper', async () => {
 const f = fakeFetch(Array.from({ length: 7 }, () => ({ status: 200, body: { id: 'object_1' } })));
 const client = createStripeClient({ apiKey: 'rk_test_synthetic', apiVersion: '2000-01-01.synthetic', fetchImpl: f.impl });
 await client.customers.create({ metadata: { zeroagent_github_id: '42' } }, { idempotencyKey: 'customer-operation' });
 await client.customers.retrieve('cus_1');
 await client.subscriptions.list({ customer: 'cus_1', status: 'all' });
 await client.checkout.sessions.create({ customer: 'cus_1', line_items: [{ price: 'price_1', quantity: 1 }] }, { idempotencyKey: 'checkout-operation' });
 await client.checkout.sessions.retrieve('cs_1');
 await client.checkout.sessions.expire('cs_1');
 await client.billingPortal.sessions.create({ customer: 'cus_1' });
 assert.deepEqual(f.calls.map((c) => [c.init.method, new URL(c.url).pathname]), [
  ['POST','/v1/customers'], ['GET','/v1/customers/cus_1'], ['GET','/v1/subscriptions'],
  ['POST','/v1/checkout/sessions'], ['GET','/v1/checkout/sessions/cs_1'],
  ['POST','/v1/checkout/sessions/cs_1/expire'], ['POST','/v1/billing_portal/sessions'],
 ]);
 assert.ok(f.calls.every((c) => c.init.headers['Stripe-Version'] === '2000-01-01.synthetic'));
 assert.equal(f.calls[0].init.headers['Idempotency-Key'], 'customer-operation');
 assert.equal(f.calls[3].init.headers['Idempotency-Key'], 'checkout-operation');
 assert.match(f.calls[3].init.body, /line_items%5B0%5D%5Bquantity%5D=1/);
 assert.equal(new URL(f.calls[2].url).searchParams.get('customer'),'cus_1');
});
