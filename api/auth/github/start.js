/*
 * ZA-900 / esfoobar/zeroagent#1263. GET /api/auth/github/start: begins the
 * browser sign-in. Mints a random single-use state and a PKCE verifier,
 * stores them server side by hash of the state, binds the attempt to this
 * browser with a short-lived `__Host-` cookie, and redirects to GitHub's web
 * authorization endpoint with S256 PKCE and no scopes (identity only).
 *
 * Uses the dedicated web OAuth client (GITHUB_WEB_CLIENT_ID/_SECRET), never
 * the desktop device-flow client. Unset variables fail closed with a generic
 * 503 and a server-side log naming only the variable names.
 */

import {
	OAUTH_COOKIE,
	OAUTH_STATE_TTL_SECONDS,
	buildCookie,
	callbackUrl,
	newOAuthSecrets,
	safeReturnPath,
	sendJson,
	webOAuthConfig,
} from '../../_lib/web-auth.js';
import { createAuthState as defaultCreateAuthState } from '../../_lib/web-session-store.js';

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';

function queryParam(req, name) {
	if (req.query && typeof req.query[name] === 'string') return req.query[name];
	try {
		return new URL(req.url, 'http://localhost').searchParams.get(name);
	} catch (err) {
		return null;
	}
}

export default async function handler(req, res, deps = {}) {
	const createAuthState = deps.createAuthState || defaultCreateAuthState;
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

	const returnPath = safeReturnPath(queryParam(req, 'return'));
	const { state, stateHash, codeVerifier, codeChallenge } = newOAuthSecrets();

	try {
		await createAuthState({
			stateHash,
			codeVerifier,
			returnPath,
			now,
			expiresAt: new Date(now.getTime() + OAUTH_STATE_TTL_SECONDS * 1000),
		});
	} catch (err) {
		console.error('web sign-in: auth state store unavailable');
		sendJson(res, 503, { error: 'sign_in_unavailable' });
		return;
	}

	const params = new URLSearchParams({
		client_id: config.clientId,
		redirect_uri: callbackUrl(),
		state,
		code_challenge: codeChallenge,
		code_challenge_method: 'S256',
	});

	res.statusCode = 302;
	res.setHeader('Cache-Control', 'private, no-store');
	res.setHeader('Set-Cookie', buildCookie(OAUTH_COOKIE, state, OAUTH_STATE_TTL_SECONDS));
	res.setHeader('Location', `${AUTHORIZE_URL}?${params.toString()}`);
	res.end();
}
