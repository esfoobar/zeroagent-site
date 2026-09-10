// ZA-224 / esfoobar/zeroagent#365. POST /api/auth/devices/revoke: sets
// revokedAt on one paired device. The store is injected.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/auth/devices/revoke.js';
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

function desktopToken(claims = {}) {
	const iat = Math.floor(Date.now() / 1000);
	return signHs256({ iss: 'https://mvplean.com', sub: 'acct_gh1234567', gh: 1234567, login: 'octocat', plan: 'free', iat, exp: iat + 60, ...claims }, SECRET);
}

function reqWithAuth(token, body) {
	return { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {}, body };
}

test('200: revokes the named device', async () => {
	const req = reqWithAuth(desktopToken(), { device_id: 'dev_abc' });
	const res = fakeRes();
	await handler(req, res, {
		revokePairedDevice: async ({ githubId, deviceId }) => {
			assert.equal(githubId, 1234567);
			assert.equal(deviceId, 'dev_abc');
			return { deviceId: 'dev_abc', revokedAt: '2026-09-08T21:10:00.000Z' };
		},
	});
	assert.equal(res.statusCode, 200);
	assert.deepEqual(JSON.parse(res.body), { device_id: 'dev_abc', revoked_at: '2026-09-08T21:10:00.000Z' });
});

test('401: no Authorization header is unauthorized', async () => {
	const req = reqWithAuth(null, { device_id: 'dev_abc' });
	const res = fakeRes();
	await handler(req, res, { revokePairedDevice: async () => assert.fail('should not be called') });
	assert.equal(res.statusCode, 401);
	assert.deepEqual(JSON.parse(res.body), { error: 'unauthorized' });
});

test('403: a device token cannot revoke devices', async () => {
	const req = reqWithAuth(desktopToken({ device: 'dev_existing' }), { device_id: 'dev_abc' });
	const res = fakeRes();
	await handler(req, res, { revokePairedDevice: async () => assert.fail('should not be called') });
	assert.equal(res.statusCode, 403);
	assert.deepEqual(JSON.parse(res.body), { error: 'device_token_not_allowed' });
});

test('400: missing device_id is bad_request', async () => {
	const req = reqWithAuth(desktopToken(), {});
	const res = fakeRes();
	await handler(req, res, { revokePairedDevice: async () => assert.fail('should not be called') });
	assert.equal(res.statusCode, 400);
	assert.deepEqual(JSON.parse(res.body), { error: 'bad_request' });
});

test('404: revoking a deviceId the account does not have', async () => {
	const req = reqWithAuth(desktopToken(), { device_id: 'dev_nope' });
	const res = fakeRes();
	await handler(req, res, { revokePairedDevice: async () => null });
	assert.equal(res.statusCode, 404);
	assert.deepEqual(JSON.parse(res.body), { error: 'device_not_found' });
});

test('502: the store failing to write is account_store_unavailable', async () => {
	const req = reqWithAuth(desktopToken(), { device_id: 'dev_abc' });
	const res = fakeRes();
	await handler(req, res, {
		revokePairedDevice: async () => {
			throw new Error('connection refused');
		},
	});
	assert.equal(res.statusCode, 502);
	assert.deepEqual(JSON.parse(res.body), { error: 'account_store_unavailable' });
});

test('405: anything but POST is method_not_allowed', async () => {
	const req = { method: 'GET', headers: {} };
	const res = fakeRes();
	await handler(req, res, { revokePairedDevice: async () => assert.fail('should not be called') });
	assert.equal(res.statusCode, 405);
	assert.deepEqual(JSON.parse(res.body), { error: 'method_not_allowed' });
});
