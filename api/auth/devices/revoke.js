/*
 * ZA-224 / esfoobar/zeroagent#365. POST /api/auth/devices/revoke: the
 * desktop revokes one of its paired devices. Sets revokedAt on that
 * pairedDevices entry; GET /api/app/me refuses a device token once its
 * entry is revoked (see api/app/me.js), which is what makes the relay
 * refuse that device's next connection attempt.
 */

import { verifyHs256 } from '../../_lib/jwt.js';
import { revokePairedDevice as defaultRevokePairedDevice } from '../../_lib/users-store.js';

function sendJson(res, status, payload) {
	res.statusCode = status;
	res.setHeader('Content-Type', 'application/json; charset=utf-8');
	res.setHeader('Cache-Control', 'no-store');
	res.end(JSON.stringify(payload));
}

function extractBearerToken(req) {
	const auth = req.headers && req.headers.authorization;
	if (!auth) return null;
	const match = String(auth).match(/^Bearer\s+(.+)$/i);
	return match ? match[1] : null;
}

export default async function handler(req, res, deps = {}) {
	const revokePairedDevice = deps.revokePairedDevice || defaultRevokePairedDevice;

	if (req.method !== 'POST') {
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

	let body;
	try {
		body = req.body;
	} catch (err) {
		sendJson(res, 400, { error: 'bad_request' });
		return;
	}
	const deviceId = body && typeof body === 'object' ? body.device_id : undefined;
	if (typeof deviceId !== 'string' || deviceId.length === 0) {
		sendJson(res, 400, { error: 'bad_request' });
		return;
	}

	let entry;
	try {
		entry = await revokePairedDevice({ githubId: payload.gh, deviceId, now: new Date() });
	} catch (err) {
		sendJson(res, 502, { error: 'account_store_unavailable' });
		return;
	}
	if (!entry) {
		sendJson(res, 404, { error: 'device_not_found' });
		return;
	}

	sendJson(res, 200, { device_id: entry.deviceId, revoked_at: entry.revokedAt });
}
