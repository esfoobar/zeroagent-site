/*
 * ZA-130 / esfoobar/zeroagent#229. GET /api/app/me, named on the ticket
 * (comment, 2026-09-03): "the app side is unchanged in shape: GET
 * /api/app/me returns the signed entitlement". Reads the account off the
 * same JWT api/auth/github.js mints (Bearer header, HS256, ZEROAGENT_JWT_SECRET)
 * and answers with the plan, the trial and renewal dates, and whether the
 * relay is allowed today (ZA-209 reads this at connect; ZA-216 is the phone
 * calling this same route).
 *
 * ZA-224 / esfoobar/zeroagent#365 reuses this same route for a device token
 * (one carrying a `device` claim, minted by api/auth/pair/claim.js): this is
 * the one place both token kinds are read back, so it is also the one place
 * that checks a device's pairedDevices entry for revokedAt. A revoked or
 * unknown device answers 401 unauthorized, the same code ZA-209's relay
 * already treats as a refusal at connect, with no relay-side change needed.
 */

import { verifyHs256 } from '../_lib/jwt.js';
import { getUser as defaultGetUser } from '../_lib/users-store.js';
import { entitlementFor } from '../_lib/entitlement.js';

function sendJson(res, status, payload) {
	res.statusCode = status;
	res.setHeader('Content-Type', 'application/json; charset=utf-8');
	res.setHeader('Cache-Control', 'private, no-store');
	res.end(JSON.stringify(payload));
}

function extractBearerToken(req) {
	const auth = req.headers && req.headers.authorization;
	if (!auth) return null;
	const match = String(auth).match(/^Bearer\s+(.+)$/i);
	return match ? match[1] : null;
}

export default async function handler(req, res, deps = {}) {
	const getUser = deps.getUser || defaultGetUser;

	if (req.method !== 'GET') {
		sendJson(res, 405, { error: 'method_not_allowed' });
		return;
	}

	const secret = process.env.ZEROAGENT_JWT_SECRET;
	const token = extractBearerToken(req);
	const payload = secret && token ? verifyHs256(token, secret) : null;
	if (!payload || typeof payload.gh !== 'number') {
		sendJson(res, 401, { error: 'unauthorized' });
		return;
	}

	let user;
	try {
		user = await getUser(payload.gh);
	} catch (err) {
		sendJson(res, 502, { error: 'account_store_unavailable' });
		return;
	}

	if (!user) {
		sendJson(res, 404, { error: 'account_not_found' });
		return;
	}

	if (typeof payload.device === 'string') {
		const entry = (user.pairedDevices || []).find((d) => d.deviceId === payload.device);
		if (!entry || entry.revokedAt) {
			sendJson(res, 401, { error: 'unauthorized' });
			return;
		}
	}

	sendJson(res, 200, entitlementFor(user));
}
