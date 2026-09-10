/*
 * ZA-224 / esfoobar/zeroagent#365. GET /api/auth/devices: the desktop lists
 * the phones paired to its account (each with its name and dates, never a
 * token or its hash) so it can offer to revoke one
 * (POST /api/auth/devices/revoke). Bearer-authenticated the same way
 * GET /api/app/me is; a device token is refused, since only the desktop
 * manages the devices paired to its own account.
 */

import { verifyHs256 } from '../_lib/jwt.js';
import { listPairedDevices as defaultListPairedDevices } from '../_lib/users-store.js';

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
	const listPairedDevices = deps.listPairedDevices || defaultListPairedDevices;

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
	if (payload.device) {
		sendJson(res, 403, { error: 'device_token_not_allowed' });
		return;
	}

	let devices;
	try {
		devices = await listPairedDevices(payload.gh);
	} catch (err) {
		sendJson(res, 502, { error: 'account_store_unavailable' });
		return;
	}
	if (devices === null) {
		sendJson(res, 404, { error: 'account_not_found' });
		return;
	}

	sendJson(res, 200, { devices });
}
