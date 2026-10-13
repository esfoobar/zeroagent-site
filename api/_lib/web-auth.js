/*
 * ZA-900 / esfoobar/zeroagent#1263. Browser sign-in primitives and the
 * helper every later browser-authenticated route (billing, the plan page)
 * calls: requireBrowserSession, requireCsrf, requireRecentAuth.
 *
 * Browser authority is deliberately separate from the app and device JWTs
 * (api/_lib/jwt.js). A browser session is an opaque random token in a
 * `__Host-` cookie, checked by hash against the `webSessions` collection.
 * Nothing here accepts a JWT, and nothing mints a session from one: a
 * request that carries an Authorization header at all is refused, so a
 * stolen account or device JWT, with or without a cookie, is never browser
 * authority.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { sha256Hex, randomToken } from './hash.js';
import { getActiveSession as defaultGetActiveSession } from './web-session-store.js';

export const SESSION_COOKIE = '__Host-za_session';
export const OAUTH_COOKIE = '__Host-za_oauth';
export const SESSION_TTL_SECONDS = 14 * 24 * 60 * 60;
export const OAUTH_STATE_TTL_SECONDS = 10 * 60;
export const RECENT_AUTH_SECONDS = 15 * 60;
export const DEFAULT_BASE_URL = 'https://zeroagenthq.com';
export const RETURN_PATHS = ['/account', '/account/plan', '/billing'];
export const DEFAULT_RETURN_PATH = '/account';

// 32 random bytes as base64url is exactly 43 characters. A JWT (dots) or
// anything else never reaches the database lookup.
const SESSION_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function sendJson(res, status, payload) {
	res.statusCode = status;
	res.setHeader('Content-Type', 'application/json; charset=utf-8');
	res.setHeader('Cache-Control', 'private, no-store');
	res.end(JSON.stringify(payload));
}

// The fixed origin everything is anchored to: the callback URL, the Origin
// check and the cookie's Secure flag. Never derived from request headers.
export function baseUrl(env = process.env) {
	const raw = (env.BILLING_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
	try {
		const url = new URL(raw);
		if (url.protocol !== 'https:' && url.protocol !== 'http:') return DEFAULT_BASE_URL;
		return url.origin;
	} catch (err) {
		return DEFAULT_BASE_URL;
	}
}

export function callbackUrl(env = process.env) {
	return `${baseUrl(env)}/api/auth/github/callback`;
}

// Returns { clientId, clientSecret } or null when either variable is unset.
export function webOAuthConfig(env = process.env) {
	const clientId = env.GITHUB_WEB_CLIENT_ID;
	const clientSecret = env.GITHUB_WEB_CLIENT_SECRET;
	if (!clientId || !clientSecret) return null;
	return { clientId, clientSecret };
}

// Exact match against the small allowlist. Anything else, including absolute
// URLs, protocol relative `//host`, backslashes, encoded tricks and paths
// with a query or fragment, falls back to the default.
export function safeReturnPath(value) {
	if (typeof value === 'string' && RETURN_PATHS.includes(value)) return value;
	return DEFAULT_RETURN_PATH;
}

export function parseCookies(header) {
	const out = {};
	if (typeof header !== 'string') return out;
	for (const part of header.split(';')) {
		const index = part.indexOf('=');
		if (index < 0) continue;
		const name = part.slice(0, index).trim();
		const value = part.slice(index + 1).trim();
		if (name && !(name in out)) out[name] = value;
	}
	return out;
}

export function buildCookie(name, value, maxAgeSeconds) {
	return `${name}=${value}; Max-Age=${maxAgeSeconds}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

export function clearCookie(name) {
	return buildCookie(name, '', 0);
}

export function pkceChallenge(verifier) {
	return createHash('sha256').update(verifier).digest('base64url');
}

export function newOAuthSecrets() {
	const state = randomToken(32);
	const codeVerifier = randomToken(48);
	return { state, stateHash: sha256Hex(state), codeVerifier, codeChallenge: pkceChallenge(codeVerifier) };
}

export function newSessionToken() {
	const token = randomToken(32);
	return { token, tokenHash: sha256Hex(token) };
}

// Derived from the session's stored hash, so it is stable for the life of
// the session, needs no extra storage or secret, and is unknown to anyone
// without the session itself (the hash alone is not the cookie).
export function csrfTokenFor(tokenHash) {
	return createHmac('sha256', tokenHash).update('za-csrf-v1').digest('base64url');
}

function safeEqual(a, b) {
	const bufA = Buffer.from(String(a));
	const bufB = Buffer.from(String(b));
	if (bufA.length !== bufB.length) return false;
	return timingSafeEqual(bufA, bufB);
}

export function hasExactOrigin(req, env = process.env) {
	const origin = req.headers && req.headers.origin;
	return typeof origin === 'string' && origin === baseUrl(env);
}

/*
 * Resolves the browser session for a request. Result is either
 * { ok: true, session, tokenHash } or { ok: false, status, error }.
 * 401 `unauthorized` for no or unknown, expired or revoked session.
 */
export async function requireBrowserSession(req, deps = {}) {
	const getActiveSession = deps.getActiveSession || defaultGetActiveSession;
	const now = deps.now || new Date();

	if (req.headers && req.headers.authorization) {
		return { ok: false, status: 401, error: 'unauthorized' };
	}
	const token = parseCookies(req.headers && req.headers.cookie)[SESSION_COOKIE];
	if (typeof token !== 'string' || !SESSION_TOKEN_RE.test(token)) {
		return { ok: false, status: 401, error: 'unauthorized' };
	}
	const tokenHash = sha256Hex(token);
	let session;
	try {
		session = await getActiveSession({ tokenHash, now });
	} catch (err) {
		return { ok: false, status: 502, error: 'session_store_unavailable' };
	}
	if (!session) return { ok: false, status: 401, error: 'unauthorized' };
	return { ok: true, session, tokenHash };
}

/*
 * For mutating routes: exact Origin match and the CSRF token header.
 * `auth` is the ok result of requireBrowserSession.
 */
export function requireCsrf(req, auth, env = process.env) {
	if (!hasExactOrigin(req, env)) return { ok: false, status: 403, error: 'bad_origin' };
	const supplied = req.headers && req.headers['x-csrf-token'];
	if (typeof supplied !== 'string' || !safeEqual(supplied, csrfTokenFor(auth.tokenHash))) {
		return { ok: false, status: 403, error: 'bad_csrf' };
	}
	return { ok: true };
}

// Step-up for sensitive actions (the billing portal): the session must have
// been established by a GitHub sign-in within `maxAgeSeconds`.
export function requireRecentAuth(session, { now = new Date(), maxAgeSeconds = RECENT_AUTH_SECONDS } = {}) {
	const authTime = new Date(session.authTime).getTime();
	if (!Number.isFinite(authTime) || now.getTime() - authTime > maxAgeSeconds * 1000) {
		return { ok: false, status: 401, error: 'recent_auth_required' };
	}
	return { ok: true };
}

export function isRecentAuth(session, now = new Date()) {
	return requireRecentAuth(session, { now }).ok;
}
