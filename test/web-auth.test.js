// ZA-900 / esfoobar/zeroagent#1263. The shared browser-session helper:
// cookie parsing, return-path allowlist, CSRF, Origin, recent auth, and
// rejection of app and device JWTs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	SESSION_COOKIE,
	baseUrl,
	buildCookie,
	clearCookie,
	csrfTokenFor,
	newSessionToken,
	parseCookies,
	pkceChallenge,
	requireBrowserSession,
	requireCsrf,
	requireRecentAuth,
	safeReturnPath,
} from '../api/_lib/web-auth.js';
import { signHs256 } from '../api/_lib/jwt.js';
import { NEW_ISSUER } from '../api/_lib/issuer.js';

const NOW = new Date('2026-10-13T12:00:00Z');

test('return path: only the exact allowlisted paths pass', () => {
	for (const ok of ['/account', '/account/plan', '/billing']) assert.equal(safeReturnPath(ok), ok);
	const attempts = [
		'https://evil.example/',
		'//evil.example',
		'/\\evil.example',
		'/account/plan?x=1',
		'/account/plan#frag',
		'/account/../admin',
		'/%2F%2Fevil.example',
		'javascript:alert(1)',
		'/billing/',
		'',
		undefined,
		null,
		['/billing'],
	];
	for (const attempt of attempts) assert.equal(safeReturnPath(attempt), '/account', String(attempt));
});

test('cookies: parsed, built with the required attributes, cleared', () => {
	assert.deepEqual(parseCookies('a=1; b=2'), { a: '1', b: '2' });
	assert.deepEqual(parseCookies(undefined), {});
	const cookie = buildCookie(SESSION_COOKIE, 'tok', 100);
	assert.match(cookie, /^__Host-za_session=tok;/);
	for (const attr of ['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=100']) {
		assert.ok(cookie.includes(attr), attr);
	}
	assert.ok(!/Domain=/i.test(cookie));
	assert.match(clearCookie(SESSION_COOKIE), /Max-Age=0/);
});

test('pkce challenge is the S256 of the verifier (RFC 7636 vector)', () => {
	assert.equal(
		pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
		'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
	);
});

test('base url falls back to the production origin and ignores paths', () => {
	assert.equal(baseUrl({}), 'https://zeroagenthq.com');
	assert.equal(baseUrl({ BILLING_BASE_URL: 'https://staging.example.test/x/' }), 'https://staging.example.test');
	assert.equal(baseUrl({ BILLING_BASE_URL: 'not a url' }), 'https://zeroagenthq.com');
	assert.equal(baseUrl({ BILLING_BASE_URL: 'javascript:1' }), 'https://zeroagenthq.com');
});

function sessionDeps(session) {
	return { now: NOW, getActiveSession: async () => session };
}

function reqWith(headers) {
	return { headers };
}

test('requireBrowserSession: valid cookie resolves the session', async () => {
	const { token, tokenHash } = newSessionToken();
	let looked;
	const auth = await requireBrowserSession(reqWith({ cookie: `${SESSION_COOKIE}=${token}` }), {
		now: NOW,
		getActiveSession: async (args) => {
			looked = args;
			return { githubId: 1, login: 'octo' };
		},
	});
	assert.equal(auth.ok, true);
	assert.equal(looked.tokenHash, tokenHash);
	assert.equal(auth.session.login, 'octo');
});

test('requireBrowserSession: no cookie, junk cookie and unknown session are 401', async () => {
	const { token } = newSessionToken();
	for (const headers of [{}, { cookie: `${SESSION_COOKIE}=short` }, { cookie: `${SESSION_COOKIE}=${token}` }]) {
		const auth = await requireBrowserSession(reqWith(headers), sessionDeps(null));
		assert.deepEqual([auth.ok, auth.status, auth.error], [false, 401, 'unauthorized']);
	}
});

test('requireBrowserSession: app and device JWTs are never browser authority', async () => {
	const jwt = (extra) => signHs256({ iss: NEW_ISSUER, sub: 'acct_gh1', gh: 1, login: 'octo', ...extra }, 'secret');
	const live = { githubId: 1, login: 'octo' };
	for (const token of [jwt({ plan: 'premium' }), jwt({ device: 'dev_1' })]) {
		// As a bearer header, alone and next to a perfectly good session cookie.
		const cookie = `${SESSION_COOKIE}=${newSessionToken().token}`;
		for (const headers of [{ authorization: `Bearer ${token}` }, { authorization: `Bearer ${token}`, cookie }]) {
			const auth = await requireBrowserSession(reqWith(headers), sessionDeps(live));
			assert.deepEqual([auth.ok, auth.status], [false, 401]);
		}
		// As the session cookie value itself.
		const asCookie = await requireBrowserSession(reqWith({ cookie: `${SESSION_COOKIE}=${token}` }), sessionDeps(live));
		assert.deepEqual([asCookie.ok, asCookie.status], [false, 401]);
	}
});

test('requireBrowserSession: store outage is 502, not a leak', async () => {
	const { token } = newSessionToken();
	const auth = await requireBrowserSession(reqWith({ cookie: `${SESSION_COOKIE}=${token}` }), {
		now: NOW,
		getActiveSession: async () => {
			throw new Error('mongodb://secret-host down');
		},
	});
	assert.deepEqual([auth.ok, auth.status, auth.error], [false, 502, 'session_store_unavailable']);
});

test('requireCsrf: needs the exact Origin and the session CSRF token', () => {
	const { tokenHash } = newSessionToken();
	const auth = { tokenHash };
	const csrf = csrfTokenFor(tokenHash);
	const good = { origin: 'https://zeroagenthq.com', 'x-csrf-token': csrf };
	assert.equal(requireCsrf({ headers: good }, auth, {}).ok, true);

	const badOrigins = [undefined, 'null', 'https://evil.example', 'http://zeroagenthq.com', 'https://zeroagenthq.com.evil.example', 'https://zeroagenthq.com/', 'https://www.zeroagenthq.com'];
	for (const origin of badOrigins) {
		const result = requireCsrf({ headers: { ...good, origin } }, auth, {});
		assert.deepEqual([result.ok, result.status, result.error], [false, 403, 'bad_origin'], String(origin));
	}
	for (const token of [undefined, '', 'nope', csrfTokenFor('another-session'), csrf + 'x']) {
		const result = requireCsrf({ headers: { ...good, 'x-csrf-token': token } }, auth, {});
		assert.deepEqual([result.ok, result.status, result.error], [false, 403, 'bad_csrf']);
	}
});

test('requireRecentAuth: fresh within 15 minutes, stale after', () => {
	const at = (minutes) => ({ authTime: new Date(NOW.getTime() - minutes * 60_000).toISOString() });
	assert.equal(requireRecentAuth(at(5), { now: NOW }).ok, true);
	assert.equal(requireRecentAuth(at(15), { now: NOW }).ok, true);
	const stale = requireRecentAuth(at(16), { now: NOW });
	assert.deepEqual([stale.ok, stale.status, stale.error], [false, 401, 'recent_auth_required']);
	assert.equal(requireRecentAuth({ authTime: 'garbage' }, { now: NOW }).ok, false);
	assert.equal(requireRecentAuth(at(20), { now: NOW, maxAgeSeconds: 3600 }).ok, true);
});
