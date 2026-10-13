/*
 * ZA-900 / esfoobar/zeroagent#1263. GET /api/account/session: who the
 * browser is signed in as, plus the CSRF token its mutating requests must
 * echo in `X-CSRF-Token`. Browser session only: an app or device JWT, in an
 * Authorization header or anywhere else, is a 401. No session value or JWT
 * is ever returned.
 */

import { csrfTokenFor, isRecentAuth, requireBrowserSession, sendJson } from '../web-auth.js';

export default async function handler(req, res, deps = {}) {
	if (req.method !== 'GET') {
		sendJson(res, 405, { error: 'method_not_allowed' });
		return;
	}

	const auth = await requireBrowserSession(req, deps);
	if (!auth.ok) {
		sendJson(res, auth.status, { error: auth.error });
		return;
	}

	const { session, tokenHash } = auth;
	sendJson(res, 200, {
		account: `acct_gh${session.githubId}`,
		githubId: session.githubId,
		login: session.login,
		csrfToken: csrfTokenFor(tokenHash),
		authTime: session.authTime,
		expiresAt: session.expiresAt,
		recentAuth: isRecentAuth(session, deps.now || new Date()),
	});
}
