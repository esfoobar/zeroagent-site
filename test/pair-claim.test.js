// ZA-224 / esfoobar/zeroagent#365. POST /api/auth/pair/claim: exchanges a
// pairing token for the phone's own long-lived device token. Stores are
// injected (test/pairing-store.test.js and test/users-store.test.js cover
// their own semantics), so no MongoDB connection is needed here.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/auth/pair/claim.js';
import { verifyHs256 } from '../api/_lib/jwt.js';
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

function reqWithBody(body) {
	return { method: 'POST', body };
}

const USER = { githubId: 1234567, login: 'octocat', plan: 'free' };

function depsWithClaim(claimResult, overrides = {}) {
	return {
		claimPairingToken: async () => claimResult,
		getPairingToken: async () => assert.fail('getPairingToken should not be called after a successful claim'),
		getUser: async (githubId) => {
			assert.equal(githubId, claimResult.githubId);
			return USER;
		},
		addPairedDevice: async () => {},
		...overrides,
	};
}

test('200: a valid pairing token mints a device token and records the paired device', async () => {
	let recorded;
	const req = reqWithBody({ token: 'the-pairing-token', device_name: "Jorge's iPhone" });
	const res = fakeRes();
	await handler(
		req,
		res,
		depsWithClaim(
			{ githubId: 1234567, usedAt: '2026-09-08T21:01:00.000Z' },
			{
				addPairedDevice: async (args) => {
					recorded = args;
				},
			}
		)
	);

	assert.equal(res.statusCode, 200);
	const parsed = JSON.parse(res.body);
	assert.equal(parsed.account, 'acct_gh1234567');
	assert.equal(parsed.login, 'octocat');
	assert.equal(parsed.plan, 'free');
	assert.equal(typeof parsed.device_id, 'string');
	assert.ok(parsed.device_id.startsWith('dev_'));

	const payload = verifyHs256(parsed.token, SECRET);
	assert.deepEqual(Object.keys(payload).sort(), ['device', 'exp', 'gh', 'iat', 'iss', 'login', 'plan', 'sub'].sort());
	assert.equal(payload.iss, 'https://mvplean.com');
	assert.equal(payload.sub, 'acct_gh1234567');
	assert.equal(payload.gh, 1234567);
	assert.equal(payload.login, 'octocat');
	assert.equal(payload.plan, 'free');
	assert.equal(payload.device, parsed.device_id);
	assert.equal(payload.exp, payload.iat + 365 * 24 * 60 * 60);

	assert.equal(recorded.githubId, 1234567);
	assert.equal(recorded.deviceId, parsed.device_id);
	assert.equal(recorded.name, "Jorge's iPhone");
	assert.equal(recorded.tokenHash, sha256Hex(parsed.token));
});

test('200: a missing or blank device_name falls back to a default', async () => {
	const req = reqWithBody({ token: 'the-pairing-token' });
	const res = fakeRes();
	let recorded;
	await handler(
		req,
		res,
		depsWithClaim({ githubId: 1234567 }, { addPairedDevice: async (args) => (recorded = args) })
	);
	assert.equal(res.statusCode, 200);
	assert.equal(recorded.name, 'Device');
});

test('401: claiming an already-used token is refused, and the second claim never mints a device token', async () => {
	const req = reqWithBody({ token: 'used-token' });
	const res = fakeRes();
	await handler(req, res, {
		claimPairingToken: async () => null,
		getPairingToken: async () => ({ githubId: 1234567, usedAt: '2026-09-08T21:00:00.000Z', expiresAt: '2026-09-08T21:05:00.000Z' }),
		getUser: async () => assert.fail('should not be called'),
		addPairedDevice: async () => assert.fail('should not be called'),
	});
	assert.equal(res.statusCode, 401);
	assert.deepEqual(JSON.parse(res.body), { error: 'pairing_token_used' });
});

test('401: an expired token is refused with a distinct error', async () => {
	const req = reqWithBody({ token: 'expired-token' });
	const res = fakeRes();
	await handler(req, res, {
		claimPairingToken: async () => null,
		getPairingToken: async () => ({ githubId: 1234567, usedAt: null, expiresAt: '2020-01-01T00:00:00.000Z' }),
		getUser: async () => assert.fail('should not be called'),
		addPairedDevice: async () => assert.fail('should not be called'),
	});
	assert.equal(res.statusCode, 401);
	assert.deepEqual(JSON.parse(res.body), { error: 'pairing_token_expired' });
});

test('401: a token that was never minted is pairing_token_invalid', async () => {
	const req = reqWithBody({ token: 'nonsense' });
	const res = fakeRes();
	await handler(req, res, {
		claimPairingToken: async () => null,
		getPairingToken: async () => null,
		getUser: async () => assert.fail('should not be called'),
		addPairedDevice: async () => assert.fail('should not be called'),
	});
	assert.equal(res.statusCode, 401);
	assert.deepEqual(JSON.parse(res.body), { error: 'pairing_token_invalid' });
});

test('404: the claimed token points at an account the store has never seen', async () => {
	const req = reqWithBody({ token: 'the-pairing-token' });
	const res = fakeRes();
	await handler(req, res, {
		claimPairingToken: async () => ({ githubId: 999 }),
		getUser: async () => null,
		addPairedDevice: async () => assert.fail('should not be called'),
	});
	assert.equal(res.statusCode, 404);
	assert.deepEqual(JSON.parse(res.body), { error: 'account_not_found' });
});

test('502: the pairing store failing to claim is account_store_unavailable', async () => {
	const req = reqWithBody({ token: 'the-pairing-token' });
	const res = fakeRes();
	await handler(req, res, {
		claimPairingToken: async () => {
			throw new Error('connection refused');
		},
	});
	assert.equal(res.statusCode, 502);
	assert.deepEqual(JSON.parse(res.body), { error: 'account_store_unavailable' });
});

test('502: the users store failing to record the device is account_store_unavailable', async () => {
	const req = reqWithBody({ token: 'the-pairing-token' });
	const res = fakeRes();
	await handler(
		req,
		res,
		depsWithClaim(
			{ githubId: 1234567 },
			{
				addPairedDevice: async () => {
					throw new Error('connection refused');
				},
			}
		)
	);
	assert.equal(res.statusCode, 502);
	assert.deepEqual(JSON.parse(res.body), { error: 'account_store_unavailable' });
});

test('400: missing token is bad_request', async () => {
	const req = reqWithBody({});
	const res = fakeRes();
	await handler(req, res, { claimPairingToken: async () => assert.fail('should not be called') });
	assert.equal(res.statusCode, 400);
	assert.deepEqual(JSON.parse(res.body), { error: 'bad_request' });
});

test('400: malformed JSON (req.body throws) is bad_request', async () => {
	const req = {
		method: 'POST',
		get body() {
			throw new SyntaxError('bad json');
		},
	};
	const res = fakeRes();
	await handler(req, res, { claimPairingToken: async () => assert.fail('should not be called') });
	assert.equal(res.statusCode, 400);
	assert.deepEqual(JSON.parse(res.body), { error: 'bad_request' });
});

test('405: anything but POST is method_not_allowed', async () => {
	const req = { method: 'GET' };
	const res = fakeRes();
	await handler(req, res, { claimPairingToken: async () => assert.fail('should not be called') });
	assert.equal(res.statusCode, 405);
	assert.deepEqual(JSON.parse(res.body), { error: 'method_not_allowed' });
});
