/*
 * ZA-900 / esfoobar/zeroagent#1263. The one serverless function behind the
 * browser-account URLs. The Hobby plan allows 12 functions per deployment,
 * so these routes share a single file and vercel.json rewrites each public
 * URL here with a `__route` query value. The handlers themselves live in
 * api/_lib/web-routes/ (not a function directory) and stay plain
 * `handler(req, res, deps)` modules, unit-tested directly.
 *
 * Add a browser-session JSON route by adding a module there and one line to
 * ROUTES plus one rewrite in vercel.json. A route that needs the raw request
 * body (the Stripe webhook) must not go through here: it gets its own file
 * with the body parser disabled. See CLAUDE.md, "Function count".
 */

import start from './_lib/web-routes/start.js';
import callback from './_lib/web-routes/callback.js';
import session from './_lib/web-routes/session.js';
import logout from './_lib/web-routes/logout.js';
import { catalog, status, checkout, portal } from './_lib/web-routes/billing.js';
import { sendJson } from './_lib/web-auth.js';

export const ROUTES = {
	'auth/github/start': start,
	'auth/github/callback': callback,
	'account/session': session,
	'auth/logout': logout,
	'billing/catalog': catalog,
	'billing/status': status,
	'billing/checkout': checkout,
	'billing/portal': portal,
};

export default async function handler(req, res) {
	// Vercel exposes the rewrite's query on req.query; req.url is the fallback.
	let route = req.query && req.query.__route;
	if (route === undefined) {
		try {
			route = new URL(req.url, 'http://localhost').searchParams.get('__route');
		} catch (err) {
			route = null;
		}
	}
	if (typeof route !== 'string' || !Object.hasOwn(ROUTES, route)) {
		sendJson(res, 404, { error: 'not_found' });
		return;
	}
	return ROUTES[route](req, res);
}
