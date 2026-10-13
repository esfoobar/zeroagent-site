// ZA-900 / esfoobar/zeroagent#1263. The four routes end to end against fake
// stores. GitHub is faked by replacing global fetch; nothing touches the
// network or MongoDB.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fakeCollection } from './_fake-collection.js';
import startHandler from '../api/_lib/web-routes/start.js';
import callbackHandler from '../api/_lib/web-routes/callback.js';
import sessionHandler from '../api/_lib/web-routes/session.js';
import logoutHandler from '../api/_lib/web-routes/logout.js';
import {
	consumeAuthStateWithCollection,
	createAuthStateWithCollection,
	createSessionWithCollection,
	getActiveSessionWithCollection,
	revokeSessionWithCollection,
} from '../api/_lib/web-session-store.js';
import { upsertOnSignInWithCollection } from '../api/_lib/users-store.js';

const REAL_FETCH = globalThis.fetch;
const ENV_KEYS = ['GITHUB_WEB_CLIENT_ID', 'GITHUB_WEB_CLIENT_SECRET', 'BILLING_BASE_URL'];
const REAL_ENV = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const ORIGIN = 'https://zeroagenthq.com';
const NOW = new Date('2026-10-13T12:00:00Z');

let states;
let sessions;
let users;
let deps;
let fetchCalls;

beforeEach(() => {
	process.env.GITHUB_WEB_CLIENT_ID = 'web-client-id';
	process.env.GITHUB_WEB_CLIENT_SECRET = 'web-client-secret';
	delete process.env.BILLING_BASE_URL;
	states = fakeCollection();
	sessions = fakeCollection();
	users = fakeCollection();
	fetchCalls = [];
	deps = {
		now: NOW,
		createAuthState: (a) => createAuthStateWithCollection(states, a),
		consumeAuthState: (a) => consumeAuthStateWithCollection(states, a),
		createSession: (a) => createSessionWithCollection(sessions, a),
		getActiveSession: (a) => getActiveSessionWithCollection(sessions, a),
		revokeSession: (a) => revokeSessionWithCollection(sessions, a),
		upsertOnSignIn: (a) => upsertOnSignInWithCollection(users, a),
	};
});

afterEach(() => {
	globalThis.fetch = REAL_FETCH;
	for (const key of ENV_KEYS) {
		if (REAL_ENV[key] === undefined) delete process.env[key];
		else process.env[key] = REAL_ENV[key];
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

async function call(handler, req) {
	const res = fakeRes();
	await handler({ headers: {}, ...req }, res, deps);
	return res;
}

function cookieList(res) {
	const raw = res.headers['Set-Cookie'];
	return Array.isArray(raw) ? raw : raw ? [raw] : [];
}

function cookieValue(res, name) {
	const hit = cookieList(res).find((c) => c.startsWith(`${name}=`));
	return hit ? hit.split(';')[0].slice(name.length + 1) : undefined;
}

// Fakes GitHub's token endpoint and user endpoint.
function fakeGithub({ token = { access_token: 'gho_secret_token' }, user = { id: 4242, login: 'octo' }, tokenStatus = 200, userStatus = 200 } = {}) {
	globalThis.fetch = async (url, init = {}) => {
		fetchCalls.push({ url: String(url), init });
		if (String(url).startsWith('https://github.com/login/oauth/access_token')) {
			return { ok: tokenStatus < 300, status: tokenStatus, json: async () => token };
		}
		if (String(url) === 'https://api.github.com/user') {
			return { ok: userStatus < 300, status: userStatus, json: async () => user };
		}
		throw new Error(`unexpected fetch ${url}`);
	};
}

async function begin(returnQuery = '/billing') {
	const res = await call(startHandler, { method: 'GET', query: { return: returnQuery } });
	const location = new URL(res.headers.Location);
	return { res, location, state: location.searchParams.get('state') };
}

function callbackReq(state, extra = {}, cookieState = state) {
	return {
		method: 'GET',
		query: { state, code: 'the-code', ...extra },
		headers: { cookie: `__Host-za_oauth=${cookieState}` },
	};
}

async function signIn() {
	fakeGithub();
	const { state } = await begin('/account/plan');
	const res = await call(callbackHandler, callbackReq(state));
	return { res, token: cookieValue(res, '__Host-za_session'), state };
}

function sessionReq(token, headers = {}) {
	return { method: 'GET', headers: { cookie: `__Host-za_session=${token}`, ...headers } };
}

// ---- start

test('start: redirects to GitHub with S256 PKCE, state, fixed callback and no scope', async () => {
	const { res, location, state } = await begin('/billing');
	assert.equal(res.statusCode, 302);
	assert.equal(location.origin + location.pathname, 'https://github.com/login/oauth/authorize');
	const p = location.searchParams;
	assert.equal(p.get('client_id'), 'web-client-id');
	assert.equal(p.get('redirect_uri'), `${ORIGIN}/api/auth/github/callback`);
	assert.equal(p.get('code_challenge_method'), 'S256');
	assert.equal(p.has('scope'), false);
	assert.equal(p.has('client_secret'), false);
	assert.ok(state.length >= 43);

	const stored = states.docs.get(createHash('sha256').update(state).digest('hex'));
	assert.ok(stored, 'state is stored by hash');
	assert.equal(stored.returnPath, '/billing');
	assert.equal(createHash('sha256').update(stored.codeVerifier).digest('base64url'), p.get('code_challenge'));
	assert.ok(!states.docs.has(state), 'the raw state is never a key');

	const cookie = cookieList(res)[0];
	assert.match(cookie, /^__Host-za_oauth=/);
	for (const attr of ['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/']) assert.ok(cookie.includes(attr));
	assert.equal(res.headers['Cache-Control'], 'private, no-store');
});

test('start: states and verifiers differ per attempt', async () => {
	const a = await begin();
	const b = await begin();
	assert.notEqual(a.state, b.state);
	assert.notEqual(a.location.searchParams.get('code_challenge'), b.location.searchParams.get('code_challenge'));
});

test('start: open redirect attempts fall back to the default landing', async () => {
	for (const attempt of ['https://evil.example', '//evil.example', '/account/plan/../..', '/other']) {
		const { state } = await begin(attempt);
		const stored = states.docs.get(createHash('sha256').update(state).digest('hex'));
		assert.equal(stored.returnPath, '/account', attempt);
	}
});

test('start: GET only, and missing OAuth variables fail closed without detail', async () => {
	const post = await call(startHandler, { method: 'POST' });
	assert.equal(post.statusCode, 405);

	delete process.env.GITHUB_WEB_CLIENT_SECRET;
	const errors = [];
	const realError = console.error;
	console.error = (...args) => errors.push(args.join(' '));
	try {
		const res = await call(startHandler, { method: 'GET', query: {} });
		assert.equal(res.statusCode, 503);
		assert.deepEqual(JSON.parse(res.body), { error: 'sign_in_unavailable' });
		assert.equal(res.headers['Set-Cookie'], undefined);
	} finally {
		console.error = realError;
	}
	assert.ok(errors.some((e) => e.includes('GITHUB_WEB_CLIENT_SECRET')));
});

test('start: a state store outage is a 503, not a crash', async () => {
	deps.createAuthState = async () => {
		throw new Error('mongodb://user:pw@host unreachable');
	};
	const realError = console.error;
	console.error = () => {};
	try {
		const res = await call(startHandler, { method: 'GET', query: {} });
		assert.equal(res.statusCode, 503);
		assert.ok(!res.body.includes('mongodb'));
	} finally {
		console.error = realError;
	}
});

// ---- callback

test('callback: success creates a hashed session, rotates cookies and redirects to the return path', async () => {
	const { res, token } = await signIn();
	assert.equal(res.statusCode, 302);
	assert.equal(res.headers.Location, '/account/plan');
	assert.ok(!res.headers.Location.includes(token), 'no session value in the URL');
	assert.match(token, /^[A-Za-z0-9_-]{43}$/);

	const sessionCookie = cookieList(res).find((c) => c.startsWith('__Host-za_session='));
	for (const attr of ['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=1209600']) {
		assert.ok(sessionCookie.includes(attr), attr);
	}
	assert.ok(!/Domain=/i.test(sessionCookie));
	assert.match(cookieList(res).find((c) => c.startsWith('__Host-za_oauth=')), /Max-Age=0/);

	const hash = createHash('sha256').update(token).digest('hex');
	assert.ok(sessions.docs.has(hash));
	assert.ok(!sessions.docs.has(token));
	const stored = sessions.docs.get(hash);
	assert.equal(stored.githubId, 4242);
	assert.equal(stored.authTime, NOW.toISOString());
	assert.equal(stored.revokedAt, null);
	assert.equal(res.headers['Cache-Control'], 'private, no-store');

	// The GitHub token is used for identity only and appears nowhere stored.
	const everything = JSON.stringify([...sessions.docs.values(), ...states.docs.values(), ...users.docs.values()]);
	assert.ok(!everything.includes('gho_secret_token'));
	assert.ok(!JSON.stringify(res.headers).includes('gho_secret_token'));
});

test('callback: exchanges the code with the stored PKCE verifier and the fixed redirect_uri', async () => {
	fakeGithub();
	const { state } = await begin();
	const verifier = states.docs.get(createHash('sha256').update(state).digest('hex')).codeVerifier;
	await call(callbackHandler, callbackReq(state));
	const exchange = fetchCalls.find((c) => c.url.includes('/login/oauth/access_token'));
	const body = JSON.parse(exchange.init.body);
	assert.equal(body.code, 'the-code');
	assert.equal(body.code_verifier, verifier);
	assert.equal(body.redirect_uri, `${ORIGIN}/api/auth/github/callback`);
	assert.equal(body.client_id, 'web-client-id');
	assert.equal(body.client_secret, 'web-client-secret');
});

test('callback: an existing user keeps plan and trial; login is refreshed', async () => {
	users.docs.set(4242, {
		_id: 4242,
		login: 'old-name',
		plan: 'premium',
		createdAt: '2025-12-01T00:00:00.000Z',
		trialEnds: '2026-01-01T00:00:00.000Z',
		planUntil: '2027-01-01T00:00:00.000Z',
		pairedDevices: [{ deviceId: 'dev_1' }],
	});
	await signIn();
	const user = users.docs.get(4242);
	assert.equal(user.login, 'octo');
	assert.equal(user.plan, 'premium');
	assert.equal(user.createdAt, '2025-12-01T00:00:00.000Z');
	assert.equal(user.trialEnds, '2026-01-01T00:00:00.000Z');
	assert.equal(user.planUntil, '2027-01-01T00:00:00.000Z');
	assert.deepEqual(user.pairedDevices, [{ deviceId: 'dev_1' }]);
});

test('callback: a first-ever browser sign-in creates the user on free with the 30 day trial', async () => {
	assert.equal(users.docs.size, 0);
	await signIn();
	const user = users.docs.get(4242);
	assert.equal(user.login, 'octo');
	assert.equal(user.plan, 'free');
	assert.equal(user.createdAt, NOW.toISOString());
	assert.equal(user.trialEnds, new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString());
	assert.equal(user.planUntil, null);
	assert.deepEqual(user.pairedDevices, []);
});

test('callback: a replayed callback is refused (state is single use)', async () => {
	fakeGithub();
	const { state } = await begin();
	const first = await call(callbackHandler, callbackReq(state));
	assert.equal(first.headers.Location, '/billing');
	const second = await call(callbackHandler, callbackReq(state));
	assert.equal(second.headers.Location, '/account?signin_error=invalid_state');
	assert.equal(cookieValue(second, '__Host-za_session'), undefined);
	assert.equal(sessions.docs.size, 1);
});

test('callback: state mismatch, missing state, foreign cookie and unknown state are refused', async () => {
	fakeGithub();
	const { state } = await begin();
	const other = await begin();
	const cases = [
		callbackReq(state, {}, other.state), // cookie from a different attempt
		callbackReq(state, {}, ''),
		{ method: 'GET', query: { code: 'c' }, headers: { cookie: `__Host-za_oauth=${state}` } },
		{ method: 'GET', query: { state, code: 'c' }, headers: {} },
		callbackReq('A'.repeat(43)), // well formed but never issued
		callbackReq("<script>alert(1)</script>"),
	];
	for (const req of cases) {
		const res = await call(callbackHandler, req);
		assert.equal(res.statusCode, 302);
		assert.equal(res.headers.Location, '/account?signin_error=invalid_state');
		assert.equal(cookieValue(res, '__Host-za_session'), undefined);
	}
	assert.equal(sessions.docs.size, 0);
	assert.equal(fetchCalls.length, 0, 'GitHub is never called for a bad state');
});

test('callback: expired state is refused', async () => {
	fakeGithub();
	const { state } = await begin();
	deps.now = new Date(NOW.getTime() + 11 * 60 * 1000);
	const res = await call(callbackHandler, callbackReq(state));
	assert.equal(res.headers.Location, '/account?signin_error=invalid_state');
	assert.equal(sessions.docs.size, 0);
});

test('callback: user cancelling at GitHub returns to the page with a coarse code', async () => {
	fakeGithub();
	const { state } = await begin('/billing');
	const res = await call(callbackHandler, {
		method: 'GET',
		query: { state, error: 'access_denied', error_description: 'x' },
		headers: { cookie: `__Host-za_oauth=${state}` },
	});
	assert.equal(res.headers.Location, '/billing?signin_error=access_denied');
	assert.equal(sessions.docs.size, 0);
	assert.equal(fetchCalls.length, 0);
});

test('callback: missing code, rejected exchange, identity failure and outage leave no session', async () => {
	const scenarios = [
		{ name: 'no code', extra: { code: undefined }, github: {}, expect: 'invalid_request' },
		{ name: 'bad verification code', extra: {}, github: { token: { error: 'bad_verification_code' } }, expect: 'github_rejected' },
		{ name: 'token http error', extra: {}, github: { tokenStatus: 500 }, expect: 'github_rejected' },
		{ name: 'user http error', extra: {}, github: { userStatus: 401 }, expect: 'github_unavailable' },
		{ name: 'user body malformed', extra: {}, github: { user: { login: 'x' } }, expect: 'github_unavailable' },
	];
	for (const s of scenarios) {
		fakeGithub(s.github);
		const { state } = await begin('/account');
		const res = await call(callbackHandler, callbackReq(state, s.extra));
		assert.equal(res.headers.Location, `/account?signin_error=${s.expect}`, s.name);
		assert.equal(cookieValue(res, '__Host-za_session'), undefined, s.name);
	}
	assert.equal(sessions.docs.size, 0);

	// Network failure
	globalThis.fetch = async () => {
		throw new Error('ECONNRESET');
	};
	const { state } = await begin('/account');
	const res = await call(callbackHandler, callbackReq(state));
	assert.equal(res.headers.Location, '/account?signin_error=github_unavailable');
	assert.equal(sessions.docs.size, 0);
});

test('callback: store failures redirect with a coarse code', async () => {
	fakeGithub();
	const realError = console.error;
	console.error = () => {};
	try {
		let { state } = await begin();
		deps.upsertOnSignIn = async () => {
			throw new Error('db down');
		};
		let res = await call(callbackHandler, callbackReq(state));
		assert.equal(res.headers.Location, '/billing?signin_error=unavailable');

		({ state } = await begin());
		deps.upsertOnSignIn = (a) => upsertOnSignInWithCollection(users, a);
		deps.createSession = async () => {
			throw new Error('db down');
		};
		res = await call(callbackHandler, callbackReq(state));
		assert.equal(res.headers.Location, '/billing?signin_error=unavailable');
		assert.equal(cookieValue(res, '__Host-za_session'), undefined);
	} finally {
		console.error = realError;
	}
});

test('callback: missing OAuth variables fail closed', async () => {
	delete process.env.GITHUB_WEB_CLIENT_ID;
	const realError = console.error;
	console.error = () => {};
	try {
		const res = await call(callbackHandler, callbackReq('A'.repeat(43)));
		assert.equal(res.statusCode, 503);
		assert.deepEqual(JSON.parse(res.body), { error: 'sign_in_unavailable' });
	} finally {
		console.error = realError;
	}
});

test('callback: signing in again rotates, revoking the prior session', async () => {
	const first = await signIn();
	fakeGithub();
	const { state } = await begin();
	const req = callbackReq(state);
	req.headers.cookie += `; __Host-za_session=${first.token}`;
	const res = await call(callbackHandler, req);
	const second = cookieValue(res, '__Host-za_session');
	assert.notEqual(second, first.token);
	const oldDoc = sessions.docs.get(createHash('sha256').update(first.token).digest('hex'));
	assert.equal(oldDoc.revokedAt, NOW.toISOString());
	const stale = await call(sessionHandler, sessionReq(first.token));
	assert.equal(stale.statusCode, 401);
	const fresh = await call(sessionHandler, sessionReq(second));
	assert.equal(fresh.statusCode, 200);
});

// ---- session

test('session: returns identity and CSRF token, private and no-store, never a token', async () => {
	const { token } = await signIn();
	const res = await call(sessionHandler, sessionReq(token));
	assert.equal(res.statusCode, 200);
	assert.equal(res.headers['Cache-Control'], 'private, no-store');
	const body = JSON.parse(res.body);
	assert.equal(body.login, 'octo');
	assert.equal(body.account, 'acct_gh4242');
	assert.equal(body.githubId, 4242);
	assert.equal(body.recentAuth, true);
	assert.ok(typeof body.csrfToken === 'string' && body.csrfToken.length > 20);
	assert.ok(!res.body.includes(token));
	assert.ok(!('token' in body));
});

test('session: signed out, expired and revoked sessions are 401', async () => {
	assert.equal((await call(sessionHandler, { method: 'GET' })).statusCode, 401);

	const { token } = await signIn();
	deps.now = new Date(NOW.getTime() + 15 * 24 * 60 * 60 * 1000);
	const expired = await call(sessionHandler, sessionReq(token));
	assert.equal(expired.statusCode, 401);

	deps.now = NOW;
	assert.equal((await call(sessionHandler, sessionReq(token))).statusCode, 200);
	sessions.docs.get(createHash('sha256').update(token).digest('hex')).revokedAt = NOW.toISOString();
	assert.equal((await call(sessionHandler, sessionReq(token))).statusCode, 401);
});

test('session: recentAuth goes false after the step-up window', async () => {
	const { token } = await signIn();
	deps.now = new Date(NOW.getTime() + 20 * 60 * 1000);
	const body = JSON.parse((await call(sessionHandler, sessionReq(token))).body);
	assert.equal(body.recentAuth, false);
});

test('session: rejects app and device JWTs presented as bearer or cookie', async () => {
	const { signHs256 } = await import('../api/_lib/jwt.js');
	const { NEW_ISSUER } = await import('../api/_lib/issuer.js');
	await signIn();
	const claims = { iss: NEW_ISSUER, sub: 'acct_gh4242', gh: 4242, login: 'octo', iat: 1, exp: 9999999999 };
	for (const jwt of [signHs256(claims, 's'), signHs256({ ...claims, device: 'dev_1' }, 's')]) {
		const bearer = await call(sessionHandler, { method: 'GET', headers: { authorization: `Bearer ${jwt}` } });
		assert.equal(bearer.statusCode, 401);
		const cookie = await call(sessionHandler, sessionReq(jwt));
		assert.equal(cookie.statusCode, 401);
	}
});

test('session: only GET', async () => {
	assert.equal((await call(sessionHandler, { method: 'POST' })).statusCode, 405);
});

// ---- logout

async function csrfFor(token) {
	return JSON.parse((await call(sessionHandler, sessionReq(token))).body).csrfToken;
}

test('logout: revokes the session server side and clears the cookie', async () => {
	const { token } = await signIn();
	const csrf = await csrfFor(token);
	const res = await call(logoutHandler, {
		method: 'POST',
		headers: { cookie: `__Host-za_session=${token}`, origin: ORIGIN, 'x-csrf-token': csrf },
	});
	assert.equal(res.statusCode, 200);
	assert.match(res.headers['Set-Cookie'], /^__Host-za_session=;.*Max-Age=0/);
	assert.equal(res.headers['Cache-Control'], 'private, no-store');
	assert.equal((await call(sessionHandler, sessionReq(token))).statusCode, 401);
});

test('logout: wrong or missing Origin and CSRF are 403 and leave the session alive', async () => {
	const { token } = await signIn();
	const csrf = await csrfFor(token);
	const cookie = `__Host-za_session=${token}`;
	const attempts = [
		{ cookie, 'x-csrf-token': csrf },
		{ cookie, origin: 'https://evil.example', 'x-csrf-token': csrf },
		{ cookie, origin: ORIGIN },
		{ cookie, origin: ORIGIN, 'x-csrf-token': 'wrong' },
	];
	for (const headers of attempts) {
		const res = await call(logoutHandler, { method: 'POST', headers });
		assert.equal(res.statusCode, 403);
		assert.equal(res.headers['Set-Cookie'], undefined);
	}
	assert.equal((await call(sessionHandler, sessionReq(token))).statusCode, 200);
});

test('logout: POST only, and idempotent with no session', async () => {
	assert.equal((await call(logoutHandler, { method: 'GET', headers: { origin: ORIGIN } })).statusCode, 405);
	const res = await call(logoutHandler, { method: 'POST', headers: { origin: ORIGIN } });
	assert.equal(res.statusCode, 200);
	assert.match(res.headers['Set-Cookie'], /Max-Age=0/);
});

test('callback: a previous session cookie that is not token shaped is ignored, not revoked', async () => {
	fakeGithub();
	let revoked = 0;
	deps.revokeSession = async () => {
		revoked += 1;
	};
	const junk = ['short', 'a.b.c', 'x'.repeat(44), '%00'];
	for (const value of junk) {
		const { state } = await begin();
		const req = callbackReq(state);
		req.headers.cookie += `; __Host-za_session=${value}`;
		const res = await call(callbackHandler, req);
		assert.equal(res.statusCode, 302);
		assert.ok(cookieValue(res, '__Host-za_session'));
	}
	assert.equal(revoked, 0);

	const { state } = await begin();
	const req = callbackReq(state);
	req.headers.cookie += `; __Host-za_session=${'A'.repeat(43)}`;
	await call(callbackHandler, req);
	assert.equal(revoked, 1);
});
