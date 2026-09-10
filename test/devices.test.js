// ZA-224 / esfoobar/zeroagent#365. GET /api/auth/devices: lists the phones
// paired to the caller's account. The store is injected.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/auth/devices.js';
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

function reqWithAuth(token) {
	return { method: 'GET', headers: token ? { authorization: `Bearer ${token}` } : {} };
}

test('200: lists the paired devices for the caller', async () => {
	const devices = [{ deviceId: 'dev_abc', name: 'iPhone', createdAt: '2026-09-08T00:00:00.000Z', revokedAt: null }];
	const req = reqWithAuth(desktopToken());
	const res = fakeRes();
	await handler(req, res, {
		listPairedDevices: async (githubId) => {
			assert.equal(githubId, 1234567);
			return devices;
		},
	});
	assert.equal(res.statusCode, 200);
	assert.deepEqual(JSON.parse(res.body), { devices });
});

test('401: no Authorization header is unauthorized', async () => {
	const req = reqWithAuth(null);
	const res = fakeRes();
	await handler(req, res, { listPairedDevices: async () => assert.fail('should not be called') });
	assert.equal(res.statusCode, 401);
	assert.deepEqual(JSON.parse(res.body), { error: 'unauthorized' });
});

test('403: a device token cannot list devices', async () => {
	const req = reqWithAuth(desktopToken({ device: 'dev_existing' }));
	const res = fakeRes();
	await handler(req, res, { listPairedDevices: async () => assert.fail('should not be called') });
	assert.equal(res.statusCode, 403);
	assert.deepEqual(JSON.parse(res.body), { error: 'device_token_not_allowed' });
});

test('404: the account has never signed in', async () => {
	const req = reqWithAuth(desktopToken());
	const res = fakeRes();
	await handler(req, res, { listPairedDevices: async () => null });
	assert.equal(res.statusCode, 404);
	assert.deepEqual(JSON.parse(res.body), { error: 'account_not_found' });
});

test('502: the store failing to read is account_store_unavailable', async () => {
	const req = reqWithAuth(desktopToken());
	const res = fakeRes();
	await handler(req, res, {
		listPairedDevices: async () => {
			throw new Error('connection refused');
		},
	});
	assert.equal(res.statusCode, 502);
	assert.deepEqual(JSON.parse(res.body), { error: 'account_store_unavailable' });
});

test('405: anything but GET is method_not_allowed', async () => {
	const req = { method: 'POST', headers: {} };
	const res = fakeRes();
	await handler(req, res, { listPairedDevices: async () => assert.fail('should not be called') });
	assert.equal(res.statusCode, 405);
	assert.deepEqual(JSON.parse(res.body), { error: 'method_not_allowed' });
});
