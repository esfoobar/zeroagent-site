#!/usr/bin/env node
// Operator-only pairing credential management. Never pass a token as an argument.
import { randomToken, sha256Hex } from '../api/_lib/hash.js';
import { getUser } from '../api/_lib/users-store.js';
import { createReviewPairingToken, renewReviewPairingToken, revokeReviewPairingToken } from '../api/_lib/pairing-store.js';

const action = process.argv[2];
if (!['mint', 'renew', 'revoke'].includes(action) || process.argv.length !== 3) {
	console.error('Usage: npm run review:pairing -- mint|renew|revoke');
	process.exit(2);
}
const githubId = Number(process.env.ZEROAGENT_REVIEW_DEMO_GITHUB_ID);
if (!process.env.ZEROAGENT_JWT_SECRET || !process.env.MONGODB_URI || !process.env.MONGODB_DB ||
	!Number.isSafeInteger(githubId) || githubId <= 0) {
	console.error('ZEROAGENT_JWT_SECRET, MONGODB_URI, MONGODB_DB and ZEROAGENT_REVIEW_DEMO_GITHUB_ID are required');
	process.exit(2);
}
const user = await getUser(githubId);
if (!user) {
	console.error('Configured demo account has no user row');
	process.exit(2);
}
const now = new Date();
const expiresAt = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
if (action === 'mint') {
	const token = randomToken();
	await createReviewPairingToken({ tokenHash: sha256Hex(token), githubId, now, expiresAt });
	process.stdout.write(`${token}\n`);
} else {
	let token = '';
	for await (const chunk of process.stdin) token += chunk;
	token = token.trim();
	if (!token || token.length > 256) {
		console.error('Read one review pairing token from stdin');
		process.exit(2);
	}
	const args = { tokenHash: sha256Hex(token), githubId, now, expiresAt };
	const result = action === 'renew' ? await renewReviewPairingToken(args) : await revokeReviewPairingToken(args);
	if (result.modifiedCount !== 1) {
		console.error('No active review pairing token matched');
		process.exit(1);
	}
	console.error(action === 'renew' ? `Renewed until ${expiresAt.toISOString()}` : 'Revoked');
}
process.exit(0);
