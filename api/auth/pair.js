/*
 * ZA-224 / esfoobar/zeroagent#365. The desktop, already signed in (ZA-129),
 * asks for a short-lived, single-use pairing token to render as a QR code.
 * POST /api/auth/pair/claim is the phone's other half. See docs/PAIRING.md
 * for the contract and /Users/jorescobar/Projects/zeroagent/docs/ACCOUNT.md
 * for the design decision behind it.
 *
 * Bearer-authenticated with the same account JWT api/auth/github.js mints.
 * A device token (one already carrying a `device` claim) is refused: a
 * paired phone cannot mint a pairing token for another phone, only the
 * desktop that owns the account can.
 */

import { verifyHs256 } from '../_lib/jwt.js';
import { sha256Hex, randomToken } from '../_lib/hash.js';
import { createPairingToken as defaultCreatePairingToken } from '../_lib/pairing-store.js';

const PAIR_TOKEN_TTL_SECONDS = 5 * 60;

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
	const createPairingToken = deps.createPairingToken || defaultCreatePairingToken;

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

	const now = new Date();
	const expiresAt = new Date(now.getTime() + PAIR_TOKEN_TTL_SECONDS * 1000);
	const pairingToken = randomToken();

	try {
		await createPairingToken({ tokenHash: sha256Hex(pairingToken), githubId: payload.gh, now, expiresAt });
	} catch (err) {
		sendJson(res, 502, { error: 'account_store_unavailable' });
		return;
	}

	sendJson(res, 200, { token: pairingToken, expires_at: expiresAt.toISOString() });
}
