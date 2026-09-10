/*
 * ZA-224 / esfoobar/zeroagent#365. The phone's half of pairing: it posts the
 * token scanned off the desktop's QR code and gets back its own long-lived
 * device token for the same account, no sign-in screen of its own at any
 * point.
 *
 * The device token is the same JWT shape api/auth/github.js mints
 * (iss/sub/gh/login/plan/iat/exp) plus one more claim, `device`, the id of
 * the pairedDevices entry this token belongs to. GET /api/app/me is the one
 * place both a desktop and a device token are read back (ZA-209 already
 * calls it at relay connect for the plan): a token carrying `device` is
 * checked there against that entry's revokedAt, so revoking a device is
 * enough to refuse its next relay connection with no relay-side storage of
 * its own. See docs/PAIRING.md here and
 * /Users/jorescobar/Projects/zeroagent/docs/ACCOUNT.md for the decision.
 */

import { signHs256 } from '../../_lib/jwt.js';
import { sha256Hex, randomToken } from '../../_lib/hash.js';
import { claimPairingToken as defaultClaimPairingToken, getPairingToken as defaultGetPairingToken } from '../../_lib/pairing-store.js';
import { getUser as defaultGetUser, addPairedDevice as defaultAddPairedDevice } from '../../_lib/users-store.js';

const DEVICE_JWT_TTL_SECONDS = 365 * 24 * 60 * 60;
const ISSUER = 'https://mvplean.com';
const DEFAULT_DEVICE_NAME = 'Device';
const MAX_DEVICE_NAME_LENGTH = 60;

function sendJson(res, status, payload) {
	res.statusCode = status;
	res.setHeader('Content-Type', 'application/json; charset=utf-8');
	res.setHeader('Cache-Control', 'no-store');
	res.end(JSON.stringify(payload));
}

function normalizeDeviceName(name) {
	if (typeof name !== 'string') return DEFAULT_DEVICE_NAME;
	const trimmed = name.trim();
	return trimmed ? trimmed.slice(0, MAX_DEVICE_NAME_LENGTH) : DEFAULT_DEVICE_NAME;
}

export default async function handler(req, res, deps = {}) {
	const claimPairingToken = deps.claimPairingToken || defaultClaimPairingToken;
	const getPairingToken = deps.getPairingToken || defaultGetPairingToken;
	const getUser = deps.getUser || defaultGetUser;
	const addPairedDevice = deps.addPairedDevice || defaultAddPairedDevice;

	if (req.method !== 'POST') {
		sendJson(res, 405, { error: 'method_not_allowed' });
		return;
	}

	let body;
	try {
		body = req.body;
	} catch (err) {
		sendJson(res, 400, { error: 'bad_request' });
		return;
	}

	const pairingToken = body && typeof body === 'object' ? body.token : undefined;
	if (typeof pairingToken !== 'string' || pairingToken.length === 0) {
		sendJson(res, 400, { error: 'bad_request' });
		return;
	}
	const deviceName = normalizeDeviceName(body.device_name);

	const tokenHash = sha256Hex(pairingToken);
	const now = new Date();

	let claimed;
	try {
		claimed = await claimPairingToken({ tokenHash, now });
	} catch (err) {
		sendJson(res, 502, { error: 'account_store_unavailable' });
		return;
	}

	if (!claimed) {
		let existing = null;
		try {
			existing = await getPairingToken(tokenHash);
		} catch (err) {
			existing = null;
		}
		if (existing && existing.usedAt) {
			sendJson(res, 401, { error: 'pairing_token_used' });
		} else if (existing && Date.parse(existing.expiresAt) <= now.getTime()) {
			sendJson(res, 401, { error: 'pairing_token_expired' });
		} else {
			sendJson(res, 401, { error: 'pairing_token_invalid' });
		}
		return;
	}

	let user;
	try {
		user = await getUser(claimed.githubId);
	} catch (err) {
		sendJson(res, 502, { error: 'account_store_unavailable' });
		return;
	}
	if (!user) {
		sendJson(res, 404, { error: 'account_not_found' });
		return;
	}

	const secret = process.env.ZEROAGENT_JWT_SECRET;
	if (!secret) {
		sendJson(res, 502, { error: 'account_store_unavailable' });
		return;
	}

	const deviceId = `dev_${randomToken(9)}`;
	const account = `acct_gh${user.githubId}`;
	const iat = Math.floor(now.getTime() / 1000);
	const exp = iat + DEVICE_JWT_TTL_SECONDS;

	const deviceToken = signHs256(
		{
			iss: ISSUER,
			sub: account,
			gh: user.githubId,
			login: user.login,
			plan: user.plan,
			device: deviceId,
			iat,
			exp,
		},
		secret
	);

	try {
		await addPairedDevice({
			githubId: user.githubId,
			deviceId,
			tokenHash: sha256Hex(deviceToken),
			name: deviceName,
			now,
		});
	} catch (err) {
		sendJson(res, 502, { error: 'account_store_unavailable' });
		return;
	}

	sendJson(res, 200, {
		token: deviceToken,
		account,
		login: user.login,
		plan: user.plan,
		device_id: deviceId,
		expires_at: new Date(exp * 1000).toISOString(),
	});
}
