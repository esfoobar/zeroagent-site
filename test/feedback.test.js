// ZA-289. api/feedback.js CORS: the site now calls this API from
// https://zeroagenthq.com, so CORS_ORIGIN moved off mvplean.com and OPTIONS
// gets a real preflight answer instead of falling through to 405.
//
// handler() here takes no deps injection and reaches api/_lib/feedback-store.js
// (MongoDB) directly on a real POST or GET, so only the paths that answer
// before touching the store are covered: OPTIONS, an unsupported method, and
// the honeypot branch, which responds success without calling save().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/feedback.js';

const CORS_ORIGIN = 'https://zeroagenthq.com';

function fakeRes() {
	return {
		statusCode: null,
		headers: {},
		body: null,
		setHeader(name, value) {
			this.headers[name] = value;
		},
		end(chunk) {
			this.body = chunk === undefined ? null : chunk;
		},
	};
}

test('OPTIONS: 204 with the CORS preflight headers', async () => {
	const req = { method: 'OPTIONS', headers: {} };
	const res = fakeRes();
	await handler(req, res);

	assert.equal(res.statusCode, 204);
	assert.equal(res.headers['Access-Control-Allow-Origin'], CORS_ORIGIN);
	assert.equal(res.headers['Access-Control-Allow-Methods'], 'GET, POST, OPTIONS');
	assert.equal(res.headers['Access-Control-Allow-Headers'], 'Content-Type, Authorization');
	assert.equal(res.headers['Access-Control-Max-Age'], '86400');
	assert.equal(res.headers['Vary'], 'Origin');
	assert.equal(res.body, null);
});

test('405: an unsupported method still carries the CORS origin header', async () => {
	const req = { method: 'PUT', headers: {} };
	const res = fakeRes();
	await handler(req, res);

	assert.equal(res.statusCode, 405);
	assert.equal(res.headers['Access-Control-Allow-Origin'], CORS_ORIGIN);
	assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'method not allowed' });
});

test('201: a POST response (honeypot branch, no store call) carries the CORS origin header', async () => {
	const req = {
		method: 'POST',
		headers: {},
		body: { website: 'a bot filled this hidden field' },
	};
	const res = fakeRes();
	await handler(req, res);

	assert.equal(res.statusCode, 201);
	assert.equal(res.headers['Access-Control-Allow-Origin'], CORS_ORIGIN);
	const parsed = JSON.parse(res.body);
	assert.equal(parsed.ok, true);
	assert.equal(typeof parsed.id, 'string');
});
