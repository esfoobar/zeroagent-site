// ZA-224 / esfoobar/zeroagent#365. POST /api/auth/pair: issues a short-lived,
// single-use pairing token for the caller's own account. The store is
// injected (test/pairing-store.test.js covers its own semantics).

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/auth/pair.js';
import { signHs256 } from '../api/_lib/jwt.js';
import { sha256Hex } from '../api/_lib/hash.js';

const SECRET = 'test-secret-do-not-use-in-prod';
const REAL_SECRET = process.env.ZEROAGENT_JWT_SECRET;

beforeEach(() => {
	process.env.ZEROAGENT_JWT_SECRET = SECRET;
});

afterEach(() => {
	if (REAL_SECRET === undefined) {
		delete process.env.ZEROAGENT_JWT_SECRET;
	} else {
		process.env.ZEROAGENT_JWT_SECRET = REAL_SECRET;
	}
});

function fakeRes() {
	return {
		statusCode: null,
		headers: {},
		body: null,
		setHeader(name, value) {
			this.headers[name] = value;
		},
		end(chunk) {
			this.body = chunk;
		},
	};
}

function desktopToken(claims = {}) {
	const iat = Math.floor(Date.now() / 1000);
	return signHs256({ iss: 'https://mvplean.com', sub: 'acct_gh1234567', gh: 1234567, login: 'octocat', plan: 'free', iat, exp: iat + 60, ...claims }, SECRET);
}

function reqWithAuth(token) {
	return { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {} };
}

test('200: a valid desktop token gets a pairing token good for five minutes', async () => {
	const before = Date.now();
	let stored;
	const req = reqWithAuth(desktopToken());
	const res = fakeRes();
	await handler(req, res, {
		createPairingToken: async (args) => {
			stored = args;
		},
	});

	assert.equal(res.statusCode, 200);
	const parsed = JSON.parse(res.body);
	assert.equal(typeof parsed.token, 'string');
	assert.ok(parsed.token.length >= 32);
	assert.equal(stored.githubId, 1234567);
	assert.equal(stored.tokenHash, sha256Hex(parsed.token));
	assert.equal(parsed.expires_at, stored.expiresAt.toISOString());

	const ttlMs = stored.expiresAt.getTime() - before;
	assert.ok(ttlMs > 4 * 60 * 1000 && ttlMs <= 5 * 60 * 1000 + 1000, `expected ~5 minutes, got ${ttlMs}ms`);
});

test('two calls mint two different tokens', async () => {
	const tokens = [];
	const req1 = reqWithAuth(desktopToken());
	const res1 = fakeRes();
	await handler(req1, res1, { createPairingToken: async () => {} });
	tokens.push(JSON.parse(res1.body).token);

	const req2 = reqWithAuth(desktopToken());
	const res2 = fakeRes();
	await handler(req2, res2, { createPairingToken: async () => {} });
	tokens.push(JSON.parse(res2.body).token);

	assert.notEqual(tokens[0], tokens[1]);
});

test('401: no Authorization header is unauthorized', async () => {
	const req = reqWithAuth(null);
	const res = fakeRes();
	await handler(req, res, { createPairingToken: async () => assert.fail('should not be called') });
	assert.equal(res.statusCode, 401);
	assert.deepEqual(JSON.parse(res.body), { error: 'unauthorized' });
});

test('401: an expired desktop token is unauthorized', async () => {
	const iat = Math.floor(Date.now() / 1000) - 120;
	const token = signHs256({ gh: 1234567, iat, exp: iat + 60 }, SECRET);
	const req = reqWithAuth(token);
	const res = fakeRes();
	await handler(req, res, { createPairingToken: async () => assert.fail('should not be called') });
	assert.equal(res.statusCode, 401);
	assert.deepEqual(JSON.parse(res.body), { error: 'unauthorized' });
});

test('403: a device token cannot mint a pairing token', async () => {
	const req = reqWithAuth(desktopToken({ device: 'dev_existing' }));
	const res = fakeRes();
	await handler(req, res, { createPairingToken: async () => assert.fail('should not be called') });
	assert.equal(res.statusCode, 403);
	assert.deepEqual(JSON.parse(res.body), { error: 'device_token_not_allowed' });
});

test('502: the store failing to write is account_store_unavailable', async () => {
	const req = reqWithAuth(desktopToken());
	const res = fakeRes();
	await handler(req, res, {
		createPairingToken: async () => {
			throw new Error('connection refused');
		},
	});
	assert.equal(res.statusCode, 502);
	assert.deepEqual(JSON.parse(res.body), { error: 'account_store_unavailable' });
});

test('405: anything but POST is method_not_allowed', async () => {
	const req = { method: 'GET', headers: {} };
	const res = fakeRes();
	await handler(req, res, { createPairingToken: async () => assert.fail('should not be called') });
	assert.equal(res.statusCode, 405);
	assert.deepEqual(JSON.parse(res.body), { error: 'method_not_allowed' });
});
