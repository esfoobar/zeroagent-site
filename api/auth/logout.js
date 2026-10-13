/*
 * ZA-900 / esfoobar/zeroagent#1263. POST /api/auth/logout: revokes the
 * browser session server side and expires the cookie. Exact Origin is
 * required always; the CSRF token is required whenever a live session is
 * being ended. With no live session it just clears the cookie, so logout is
 * idempotent.
 */

import {
	SESSION_COOKIE,
	clearCookie,
	hasExactOrigin,
	requireBrowserSession,
	requireCsrf,
	sendJson,
} from '../_lib/web-auth.js';
import { revokeSession as defaultRevokeSession } from '../_lib/web-session-store.js';

export default async function handler(req, res, deps = {}) {
	const revokeSession = deps.revokeSession || defaultRevokeSession;
	const now = deps.now || new Date();

	if (req.method !== 'POST') {
		sendJson(res, 405, { error: 'method_not_allowed' });
		return;
	}
	if (!hasExactOrigin(req)) {
		sendJson(res, 403, { error: 'bad_origin' });
		return;
	}

	const auth = await requireBrowserSession(req, deps);
	if (auth.ok) {
		const csrf = requireCsrf(req, auth);
		if (!csrf.ok) {
			sendJson(res, csrf.status, { error: csrf.error });
			return;
		}
		try {
			await revokeSession({ tokenHash: auth.tokenHash, now });
		} catch (err) {
			sendJson(res, 502, { error: 'session_store_unavailable' });
			return;
		}
	} else if (auth.status === 502) {
		sendJson(res, 502, { error: auth.error });
		return;
	}

	res.setHeader('Set-Cookie', clearCookie(SESSION_COOKIE));
	sendJson(res, 200, { ok: true });
}
