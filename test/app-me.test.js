// ZA-130 / esfoobar/zeroagent#229. GET /api/app/me: reads the JWT
// api/auth/github.js mints and answers with the entitlement. The store is
// injected (test/users-store.test.js covers its own semantics), so no
// MongoDB connection is needed here.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/app/me.js';
import { signHs256 } from '../api/_lib/jwt.js';

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

function validToken(claims = {}) {
	const iat = Math.floor(Date.now() / 1000);
	return signHs256(
		{
			iss: 'https://mvplean.com',
			sub: 'acct_gh1234567',
			gh: 1234567,
			login: 'octocat',
			plan: 'free',
			iat,
			exp: iat + 60,
			...claims,
		},
		SECRET
	);
}

function reqWithAuth(token) {
	return { method: 'GET', headers: token ? { authorization: `Bearer ${token}` } : {} };
}

test('200: a valid token returns the entitlement from the store', async () => {
	const req = reqWithAuth(validToken());
	const res = fakeRes();
	await handler(req, res, {
		getUser: async (githubId) => {
			assert.equal(githubId, 1234567);
			return {
				githubId,
				login: 'octocat',
				plan: 'free',
				trialEnds: '2026-10-08T00:00:00.000Z',
				planUntil: null,
				createdAt: '2026-09-08T00:00:00.000Z',
				pairedDevices: [],
			};
		},
	});

	assert.equal(res.statusCode, 200);
	assert.deepEqual(JSON.parse(res.body), {
		plan: 'free',
		trialEnds: '2026-10-08T00:00:00.000Z',
		planUntil: null,
		relayAllowed: true,
	});
});

test('401: no Authorization header is unauthorized', async () => {
	const req = reqWithAuth(null);
	const res = fakeRes();
	await handler(req, res, { getUser: async () => assert.fail('getUser should not be called') });
	assert.equal(res.statusCode, 401);
	assert.deepEqual(JSON.parse(res.body), { error: 'unauthorized' });
});

test('401: a token signed with the wrong secret is unauthorized', async () => {
	const token = signHs256({ gh: 1234567, exp: Math.floor(Date.now() / 1000) + 60 }, 'wrong-secret');
	const req = reqWithAuth(token);
	const res = fakeRes();
	await handler(req, res, { getUser: async () => assert.fail('getUser should not be called') });
	assert.equal(res.statusCode, 401);
	assert.deepEqual(JSON.parse(res.body), { error: 'unauthorized' });
});

test('401: an expired token is unauthorized', async () => {
	const iat = Math.floor(Date.now() / 1000) - 120;
	const token = signHs256({ gh: 1234567, iat, exp: iat + 60 }, SECRET);
	const req = reqWithAuth(token);
	const res = fakeRes();
	await handler(req, res, { getUser: async () => assert.fail('getUser should not be called') });
	assert.equal(res.statusCode, 401);
	assert.deepEqual(JSON.parse(res.body), { error: 'unauthorized' });
});

test('404: a token for an account the store has never seen is account_not_found', async () => {
	const req = reqWithAuth(validToken());
	const res = fakeRes();
	await handler(req, res, { getUser: async () => null });
	assert.equal(res.statusCode, 404);
	assert.deepEqual(JSON.parse(res.body), { error: 'account_not_found' });
});

test('502: the store failing to read is account_store_unavailable', async () => {
	const req = reqWithAuth(validToken());
	const res = fakeRes();
	await handler(req, res, {
		getUser: async () => {
			throw new Error('connection refused');
		},
	});
	assert.equal(res.statusCode, 502);
	assert.deepEqual(JSON.parse(res.body), { error: 'account_store_unavailable' });
});

test('405: anything but GET is method_not_allowed', async () => {
	const req = { method: 'POST', headers: {} };
	const res = fakeRes();
	await handler(req, res, { getUser: async () => assert.fail('getUser should not be called') });
	assert.equal(res.statusCode, 405);
	assert.deepEqual(JSON.parse(res.body), { error: 'method_not_allowed' });
});

// ZA-224 / esfoobar/zeroagent#365. A device token (a `device` claim, minted
// by api/auth/pair/claim.js) is read back here too: this is the one place
// that checks the matching pairedDevices entry for revokedAt.

test('200: a device token for an unrevoked device gets the entitlement, same as a desktop token', async () => {
	const req = reqWithAuth(validToken({ device: 'dev_abc' }));
	const res = fakeRes();
	await handler(req, res, {
		getUser: async () => ({
			githubId: 1234567,
			login: 'octocat',
			plan: 'free',
			trialEnds: '2026-10-08T00:00:00.000Z',
			planUntil: null,
			pairedDevices: [{ deviceId: 'dev_abc', tokenHash: 'h', name: 'iPhone', createdAt: 'x', revokedAt: null }],
		}),
	});
	assert.equal(res.statusCode, 200);
	assert.deepEqual(JSON.parse(res.body), { plan: 'free', trialEnds: '2026-10-08T00:00:00.000Z', planUntil: null, relayAllowed: true });
});

test('401: a device token whose entry has been revoked is unauthorized', async () => {
	const req = reqWithAuth(validToken({ device: 'dev_abc' }));
	const res = fakeRes();
	await handler(req, res, {
		getUser: async () => ({
			githubId: 1234567,
			login: 'octocat',
			plan: 'free',
			trialEnds: '2026-10-08T00:00:00.000Z',
			planUntil: null,
			pairedDevices: [{ deviceId: 'dev_abc', tokenHash: 'h', name: 'iPhone', createdAt: 'x', revokedAt: '2026-09-08T21:10:00.000Z' }],
		}),
	});
	assert.equal(res.statusCode, 401);
	assert.deepEqual(JSON.parse(res.body), { error: 'unauthorized' });
});

test('401: a device token whose deviceId is not in pairedDevices at all is unauthorized', async () => {
	const req = reqWithAuth(validToken({ device: 'dev_gone' }));
	const res = fakeRes();
	await handler(req, res, {
		getUser: async () => ({
			githubId: 1234567,
			login: 'octocat',
			plan: 'free',
			trialEnds: '2026-10-08T00:00:00.000Z',
			planUntil: null,
			pairedDevices: [{ deviceId: 'dev_abc', tokenHash: 'h', name: 'iPhone', createdAt: 'x', revokedAt: null }],
		}),
	});
	assert.equal(res.statusCode, 401);
	assert.deepEqual(JSON.parse(res.body), { error: 'unauthorized' });
});
