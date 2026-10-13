/*
 * ZA-900 / esfoobar/zeroagent#1263. GET /api/auth/github/callback: finishes
 * the browser sign-in. Checks the state against the cookie that started the
 * attempt, consumes it exactly once, exchanges the code (with the PKCE
 * verifier) server side, asks GitHub who the token belongs to, then drops
 * the GitHub token: it is never stored, logged or returned.
 *
 * The account is the numeric GitHub id, upserted with the same users-store
 * call as the desktop sign-in, so an existing plan and trial are untouched.
 * A fresh opaque session is created (any session the browser already held is
 * revoked: rotation at sign-in) and set as a `__Host-` cookie. No session
 * value or JWT appears in the redirect URL.
 *
 * Every failure redirects to the account landing with a coarse
 * `signin_error` code; details go to the server log only.
 */

import { sha256Hex } from '../../_lib/hash.js';
import {
	DEFAULT_RETURN_PATH,
	OAUTH_COOKIE,
	SESSION_COOKIE,
	SESSION_TTL_SECONDS,
	buildCookie,
	callbackUrl,
	clearCookie,
	newSessionToken,
	parseCookies,
	safeReturnPath,
	sendJson,
	webOAuthConfig,
} from '../../_lib/web-auth.js';
import { upsertOnSignIn as defaultUpsertOnSignIn } from '../../_lib/users-store.js';
import {
	consumeAuthState as defaultConsumeAuthState,
	createSession as defaultCreateSession,
	revokeSession as defaultRevokeSession,
} from '../../_lib/web-session-store.js';

const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const USER_URL = 'https://api.github.com/user';
const GITHUB_TIMEOUT_MS = 10_000;
const USER_AGENT = 'ZeroAgent-WebSignIn (+https://zeroagenthq.com)';
const STATE_RE = /^[A-Za-z0-9_-]{43}$/;

function queryParam(req, name) {
	let value;
	if (req.query && name in req.query) value = req.query[name];
	else {
		try {
			value = new URL(req.url, 'http://localhost').searchParams.get(name);
		} catch (err) {
			value = null;
		}
	}
	return typeof value === 'string' ? value : null;
}

async function githubFetch(url, init) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), GITHUB_TIMEOUT_MS);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}

function redirect(res, location, cookies) {
	res.statusCode = 302;
	res.setHeader('Cache-Control', 'private, no-store');
	res.setHeader('Referrer-Policy', 'no-referrer');
	res.setHeader('Set-Cookie', cookies);
	res.setHeader('Location', location);
	res.end();
}

function fail(res, path, code) {
	redirect(res, `${path}?signin_error=${code}`, [clearCookie(OAUTH_COOKIE)]);
}

async function exchangeCode(config, code, codeVerifier) {
	const response = await githubFetch(TOKEN_URL, {
		method: 'POST',
		headers: {
			Accept: 'application/json',
			'Content-Type': 'application/json',
			'User-Agent': USER_AGENT,
		},
		body: JSON.stringify({
			client_id: config.clientId,
			client_secret: config.clientSecret,
			code,
			redirect_uri: callbackUrl(),
			code_verifier: codeVerifier,
		}),
	});
	if (!response.ok) return null;
	const body = await response.json();
	return body && typeof body.access_token === 'string' && body.access_token ? body.access_token : null;
}

async function fetchIdentity(accessToken) {
	const response = await githubFetch(USER_URL, {
		headers: {
			Authorization: `Bearer ${accessToken}`,
			Accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28',
			'User-Agent': USER_AGENT,
		},
	});
	if (!response.ok) return null;
	const user = await response.json();
	if (!user || typeof user.id !== 'number' || typeof user.login !== 'string') return null;
	return { id: user.id, login: user.login };
}

export default async function handler(req, res, deps = {}) {
	const consumeAuthState = deps.consumeAuthState || defaultConsumeAuthState;
	const createSession = deps.createSession || defaultCreateSession;
	const revokeSession = deps.revokeSession || defaultRevokeSession;
	const upsertOnSignIn = deps.upsertOnSignIn || defaultUpsertOnSignIn;
	const now = deps.now || new Date();

	if (req.method !== 'GET') {
		sendJson(res, 405, { error: 'method_not_allowed' });
		return;
	}

	const config = webOAuthConfig();
	if (!config) {
		console.error('web sign-in unavailable: GITHUB_WEB_CLIENT_ID or GITHUB_WEB_CLIENT_SECRET is not set');
		sendJson(res, 503, { error: 'sign_in_unavailable' });
		return;
	}

	const cookies = parseCookies(req.headers && req.headers.cookie);
	const state = queryParam(req, 'state');
	// The state must be the one this browser was given at /start, so a
	// callback link planted on another browser (login CSRF) cannot complete.
	if (!state || !STATE_RE.test(state) || cookies[OAUTH_COOKIE] !== state) {
		fail(res, DEFAULT_RETURN_PATH, 'invalid_state');
		return;
	}

	let record;
	try {
		record = await consumeAuthState({ stateHash: sha256Hex(state), now });
	} catch (err) {
		console.error('web sign-in: auth state store unavailable');
		fail(res, DEFAULT_RETURN_PATH, 'unavailable');
		return;
	}
	if (!record) {
		fail(res, DEFAULT_RETURN_PATH, 'invalid_state');
		return;
	}
	const returnPath = safeReturnPath(record.returnPath);

	if (queryParam(req, 'error')) {
		fail(res, returnPath, queryParam(req, 'error') === 'access_denied' ? 'access_denied' : 'github_error');
		return;
	}
	const code = queryParam(req, 'code');
	if (!code) {
		fail(res, returnPath, 'invalid_request');
		return;
	}

	let identity;
	try {
		const accessToken = await exchangeCode(config, code, record.codeVerifier);
		if (!accessToken) {
			fail(res, returnPath, 'github_rejected');
			return;
		}
		identity = await fetchIdentity(accessToken);
	} catch (err) {
		fail(res, returnPath, 'github_unavailable');
		return;
	}
	if (!identity) {
		fail(res, returnPath, 'github_unavailable');
		return;
	}

	try {
		await upsertOnSignIn({ githubId: identity.id, login: identity.login, now });
	} catch (err) {
		console.error('web sign-in: account store unavailable');
		fail(res, returnPath, 'unavailable');
		return;
	}

	const { token, tokenHash } = newSessionToken();
	try {
		const previous = cookies[SESSION_COOKIE];
		if (typeof previous === 'string' && previous) {
			await revokeSession({ tokenHash: sha256Hex(previous), now });
		}
		await createSession({
			tokenHash,
			githubId: identity.id,
			login: identity.login,
			now,
			expiresAt: new Date(now.getTime() + SESSION_TTL_SECONDS * 1000),
		});
	} catch (err) {
		console.error('web sign-in: session store unavailable');
		fail(res, returnPath, 'unavailable');
		return;
	}

	redirect(res, returnPath, [buildCookie(SESSION_COOKIE, token, SESSION_TTL_SECONDS), clearCookie(OAUTH_COOKIE)]);
}
