// ZA-129 / esfoobar/zeroagent#228. Plain node --test, no runner dependency.
// Every test mocks global.fetch: GitHub is never called for real.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import handler from '../api/auth/github.js';

const REAL_FETCH = globalThis.fetch;
const REAL_SECRET = process.env.ZEROAGENT_JWT_SECRET;

beforeEach(() => {
	process.env.ZEROAGENT_JWT_SECRET = 'test-secret-do-not-use-in-prod';
});

afterEach(() => {
	globalThis.fetch = REAL_FETCH;
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

function reqWithBadJson() {
	return {
		method: 'POST',
		get body() {
			throw new SyntaxError('Unexpected token in JSON');
		},
	};
}

function jsonFetchResponse(status, payload) {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => payload,
	};
}

// A fake users-store.upsertOnSignIn: this test file is only responsible for
// the sign-in route's own contract, not the store's upsert semantics (that's
// test/users-store.test.js), so every test that reaches the store injects
// this instead of hitting a real MongoDB connection.
function fakeUpsertOnSignIn(plan = 'free') {
	return async ({ githubId, login }) => ({
		githubId,
		login,
		plan,
		createdAt: '2026-09-08T00:00:00.000Z',
		trialEnds: '2026-10-08T00:00:00.000Z',
		planUntil: null,
		pairedDevices: [],
	});
}

function base64urlDecode(segment) {
	return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

function decodeJwt(token) {
	const [headerPart, payloadPart, signaturePart] = token.split('.');
	return {
		header: base64urlDecode(headerPart),
		payload: base64urlDecode(payloadPart),
		signingInput: `${headerPart}.${payloadPart}`,
		signature: signaturePart,
	};
}

test('200: valid GitHub token mints a JWT matching the contract claims', async () => {
	const before = Math.floor(Date.now() / 1000);
	globalThis.fetch = async (url, options) => {
		assert.equal(url, 'https://api.github.com/user');
		assert.equal(options.headers.Authorization, 'Bearer good-token');
		assert.equal(options.headers.Accept, 'application/vnd.github+json');
		assert.equal(options.headers['X-GitHub-Api-Version'], '2022-11-28');
		assert.match(options.headers['User-Agent'], /ZeroAgent/);
		return jsonFetchResponse(200, { id: 1234567, login: 'octocat' });
	};

	const req = reqWithBody({ github_token: 'good-token' });
	const res = fakeRes();
	await handler(req, res, { upsertOnSignIn: fakeUpsertOnSignIn('free') });

	assert.equal(res.statusCode, 200);
	const parsed = JSON.parse(res.body);
	assert.equal(parsed.account, 'acct_gh1234567');
	assert.equal(parsed.login, 'octocat');
	assert.equal(parsed.plan, 'free');
	assert.equal(typeof parsed.token, 'string');

	const after = Math.floor(Date.now() / 1000);
	const { header, payload, signingInput, signature } = decodeJwt(parsed.token);
	assert.equal(header.alg, 'HS256');
	assert.equal(header.typ, 'JWT');
	assert.deepEqual(Object.keys(payload).sort(), ['exp', 'gh', 'iat', 'iss', 'login', 'plan', 'sub'].sort());
	assert.equal(payload.iss, 'https://mvplean.com');
	assert.equal(payload.sub, 'acct_gh1234567');
	assert.equal(payload.gh, 1234567);
	assert.equal(typeof payload.gh, 'number');
	assert.equal(payload.login, 'octocat');
	assert.equal(payload.plan, 'free');
	assert.ok(payload.iat >= before && payload.iat <= after);
	assert.equal(payload.exp, payload.iat + 30 * 24 * 60 * 60);

	const expectedSignature = createHmac('sha256', 'test-secret-do-not-use-in-prod')
		.update(signingInput)
		.digest('base64url');
	assert.equal(signature, expectedSignature);

	assert.equal(parsed.expires_at, new Date(payload.exp * 1000).toISOString());
});

test('200: a returning user gets the plan the store has for them, not a hardcoded free', async () => {
	globalThis.fetch = async () => jsonFetchResponse(200, { id: 999, login: 'octocat' });
	const req = reqWithBody({ github_token: 'good-token' });
	const res = fakeRes();
	await handler(req, res, { upsertOnSignIn: fakeUpsertOnSignIn('premium') });

	assert.equal(res.statusCode, 200);
	const parsed = JSON.parse(res.body);
	assert.equal(parsed.plan, 'premium');
	const { payload } = decodeJwt(parsed.token);
	assert.equal(payload.plan, 'premium');
});

test('502: the store failing to upsert is account_store_unavailable', async () => {
	globalThis.fetch = async () => jsonFetchResponse(200, { id: 999, login: 'octocat' });
	const req = reqWithBody({ github_token: 'good-token' });
	const res = fakeRes();
	await handler(req, res, {
		upsertOnSignIn: async () => {
			throw new Error('connection refused');
		},
	});

	assert.equal(res.statusCode, 502);
	assert.deepEqual(JSON.parse(res.body), { error: 'account_store_unavailable' });
});

test('405: anything but POST is method_not_allowed', async () => {
	const req = { method: 'GET' };
	const res = fakeRes();
	await handler(req, res);
	assert.equal(res.statusCode, 405);
	assert.deepEqual(JSON.parse(res.body), { error: 'method_not_allowed' });
});

test('400: missing github_token is bad_request', async () => {
	const req = reqWithBody({});
	const res = fakeRes();
	await handler(req, res);
	assert.equal(res.statusCode, 400);
	assert.deepEqual(JSON.parse(res.body), { error: 'bad_request' });
});

test('400: an empty body (no Content-Type, body undefined) is bad_request', async () => {
	const req = reqWithBody(undefined);
	const res = fakeRes();
	await handler(req, res);
	assert.equal(res.statusCode, 400);
	assert.deepEqual(JSON.parse(res.body), { error: 'bad_request' });
});

test('400: a non-string github_token is bad_request', async () => {
	const req = reqWithBody({ github_token: 12345 });
	const res = fakeRes();
	await handler(req, res);
	assert.equal(res.statusCode, 400);
	assert.deepEqual(JSON.parse(res.body), { error: 'bad_request' });
});

test('400: malformed JSON (req.body throws) is bad_request', async () => {
	const req = reqWithBadJson();
	const res = fakeRes();
	await handler(req, res);
	assert.equal(res.statusCode, 400);
	assert.deepEqual(JSON.parse(res.body), { error: 'bad_request' });
});

test('401: GitHub answers 401 is github_token_invalid', async () => {
	globalThis.fetch = async () => jsonFetchResponse(401, { message: 'Bad credentials' });
	const req = reqWithBody({ github_token: 'bad-token' });
	const res = fakeRes();
	await handler(req, res);
	assert.equal(res.statusCode, 401);
	assert.deepEqual(JSON.parse(res.body), { error: 'github_token_invalid' });
});

test('401: GitHub answers 403 is github_token_invalid', async () => {
	globalThis.fetch = async () => jsonFetchResponse(403, { message: 'Forbidden' });
	const req = reqWithBody({ github_token: 'bad-token' });
	const res = fakeRes();
	await handler(req, res);
	assert.equal(res.statusCode, 401);
	assert.deepEqual(JSON.parse(res.body), { error: 'github_token_invalid' });
});

test('502: GitHub 5xx is github_unavailable', async () => {
	globalThis.fetch = async () => jsonFetchResponse(503, { message: 'Service unavailable' });
	const req = reqWithBody({ github_token: 'some-token' });
	const res = fakeRes();
	await handler(req, res);
	assert.equal(res.statusCode, 502);
	assert.deepEqual(JSON.parse(res.body), { error: 'github_unavailable' });
});

test('502: a network error talking to GitHub is github_unavailable', async () => {
	globalThis.fetch = async () => {
		throw new Error('getaddrinfo ENOTFOUND api.github.com');
	};
	const req = reqWithBody({ github_token: 'some-token' });
	const res = fakeRes();
	await handler(req, res);
	assert.equal(res.statusCode, 502);
	assert.deepEqual(JSON.parse(res.body), { error: 'github_unavailable' });
});

test('502: a timeout talking to GitHub is github_unavailable', async (t) => {
	// Mocks the timer instead of waiting out the real 10s, so the suite stays fast.
	t.mock.timers.enable({ apis: ['setTimeout'] });
	globalThis.fetch = (url, options) =>
		new Promise((resolve, reject) => {
			options.signal.addEventListener('abort', () => {
				const err = new Error('The operation was aborted');
				err.name = 'AbortError';
				reject(err);
			});
		});
	const req = reqWithBody({ github_token: 'some-token' });
	const res = fakeRes();
	const pending = handler(req, res);
	t.mock.timers.tick(10_000);
	await pending;
	assert.equal(res.statusCode, 502);
	assert.deepEqual(JSON.parse(res.body), { error: 'github_unavailable' });
});

test('502: a 200 from GitHub missing a usable identity is github_unavailable', async () => {
	globalThis.fetch = async () => jsonFetchResponse(200, { login: 'octocat' });
	const req = reqWithBody({ github_token: 'some-token' });
	const res = fakeRes();
	await handler(req, res);
	assert.equal(res.statusCode, 502);
	assert.deepEqual(JSON.parse(res.body), { error: 'github_unavailable' });
});

test('never logs or echoes the GitHub token back', async () => {
	const originalLog = console.log;
	const originalError = console.error;
	const originalWarn = console.warn;
	const logged = [];
	console.log = (...args) => logged.push(args.join(' '));
	console.error = (...args) => logged.push(args.join(' '));
	console.warn = (...args) => logged.push(args.join(' '));

	try {
		globalThis.fetch = async () => jsonFetchResponse(200, { id: 42, login: 'octocat' });
		const req = reqWithBody({ github_token: 'super-secret-token-value' });
		const res = fakeRes();
		await handler(req, res, { upsertOnSignIn: fakeUpsertOnSignIn('free') });

		assert.equal(res.body.includes('super-secret-token-value'), false);
		for (const line of logged) {
			assert.equal(line.includes('super-secret-token-value'), false);
		}

		// Also cover the error paths, where a token is most tempting to log.
		globalThis.fetch = async () => jsonFetchResponse(401, { message: 'Bad credentials' });
		const req2 = reqWithBody({ github_token: 'super-secret-token-value' });
		const res2 = fakeRes();
		await handler(req2, res2);
		assert.equal(res2.body.includes('super-secret-token-value'), false);
		for (const line of logged) {
			assert.equal(line.includes('super-secret-token-value'), false);
		}
	} finally {
		console.log = originalLog;
		console.error = originalError;
		console.warn = originalWarn;
	}
});
