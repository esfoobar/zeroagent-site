/*
 * ZA-129 / esfoobar/zeroagent#228. The desktop's GitHub device flow ends with
 * a GitHub access token, not a ZeroAgent account. This route verifies that
 * token against GitHub's own API, looks the account up (or creates it) in
 * the users store (ZA-130 / esfoobar/zeroagent#229), and mints the ZeroAgent
 * account JWT the relay protocol expects at connect (ZA-209 reads it back).
 *
 * The account id is deterministic from GitHub's numeric id (acct_gh<id>).
 * Plan comes from the users store now rather than being hardcoded: free on
 * first sign-in, whatever an admin has since set it to on every one after.
 *
 * HS256 is hand-rolled with node:crypto (api/_lib/jwt.js) rather than
 * pulling in a JWT library: jose only reaches this project today as a
 * transitive dependency of @vercel/oidc, and a signer this small is not
 * worth an explicit dependency.
 */

import { signHs256 } from '../_lib/jwt.js';
import { upsertOnSignIn as defaultUpsertOnSignIn } from '../_lib/users-store.js';

const GITHUB_USER_URL = 'https://api.github.com/user';
const GITHUB_TIMEOUT_MS = 10_000;
const JWT_TTL_SECONDS = 30 * 24 * 60 * 60;
const ISSUER = 'https://mvplean.com';

function sendError(res, status, error) {
	res.statusCode = status;
	res.setHeader('Content-Type', 'application/json; charset=utf-8');
	res.setHeader('Cache-Control', 'no-store');
	res.end(JSON.stringify({ error }));
}

async function fetchGithubUser(githubToken) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), GITHUB_TIMEOUT_MS);
	try {
		return await fetch(GITHUB_USER_URL, {
			headers: {
				Authorization: `Bearer ${githubToken}`,
				Accept: 'application/vnd.github+json',
				'X-GitHub-Api-Version': '2022-11-28',
				'User-Agent': 'ZeroAgent-SignIn (+https://mvplean.com)',
			},
			signal: controller.signal,
		});
	} finally {
		clearTimeout(timer);
	}
}

export default async function handler(req, res, deps = {}) {
	const upsertOnSignIn = deps.upsertOnSignIn || defaultUpsertOnSignIn;

	if (req.method !== 'POST') {
		sendError(res, 405, 'method_not_allowed');
		return;
	}

	// req.body is a Vercel getter: absent Content-Type it is undefined, and
	// malformed JSON throws when the getter runs rather than returning null.
	let body;
	try {
		body = req.body;
	} catch (err) {
		sendError(res, 400, 'bad_request');
		return;
	}

	const githubToken = body && typeof body === 'object' ? body.github_token : undefined;
	if (typeof githubToken !== 'string' || githubToken.length === 0) {
		sendError(res, 400, 'bad_request');
		return;
	}

	let githubRes;
	try {
		githubRes = await fetchGithubUser(githubToken);
	} catch (err) {
		// Network error, DNS failure, or the 10s timeout aborting the request.
		sendError(res, 502, 'github_unavailable');
		return;
	}

	if (!githubRes.ok) {
		if (githubRes.status === 401 || githubRes.status === 403) {
			sendError(res, 401, 'github_token_invalid');
		} else {
			sendError(res, 502, 'github_unavailable');
		}
		return;
	}

	let user;
	try {
		user = await githubRes.json();
	} catch (err) {
		sendError(res, 502, 'github_unavailable');
		return;
	}

	if (!user || typeof user.id !== 'number' || typeof user.login !== 'string') {
		sendError(res, 502, 'github_unavailable');
		return;
	}

	const secret = process.env.ZEROAGENT_JWT_SECRET;
	if (!secret) {
		sendError(res, 502, 'github_unavailable');
		return;
	}

	let userRecord;
	try {
		userRecord = await upsertOnSignIn({ githubId: user.id, login: user.login });
	} catch (err) {
		sendError(res, 502, 'account_store_unavailable');
		return;
	}

	const account = `acct_gh${user.id}`;
	const plan = userRecord.plan;
	const iat = Math.floor(Date.now() / 1000);
	const exp = iat + JWT_TTL_SECONDS;

	const token = signHs256(
		{
			iss: ISSUER,
			sub: account,
			gh: user.id,
			login: user.login,
			plan,
			iat,
			exp,
		},
		secret
	);

	res.statusCode = 200;
	res.setHeader('Content-Type', 'application/json; charset=utf-8');
	res.setHeader('Cache-Control', 'no-store');
	res.end(
		JSON.stringify({
			token,
			account,
			login: user.login,
			plan,
			expires_at: new Date(exp * 1000).toISOString(),
		})
	);
}
