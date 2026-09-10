/*
 * ZA-130 / esfoobar/zeroagent#229. HS256 sign and verify, factored out of
 * api/auth/github.js so api/app/me.js can verify the same JWT without a
 * second hand-rolled implementation. Still no jose dependency: see the
 * docstring history in auth/github.js for why.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

function base64url(input) {
	return Buffer.from(input).toString('base64url');
}

function safeEqual(a, b) {
	const bufA = Buffer.from(a);
	const bufB = Buffer.from(b);
	if (bufA.length !== bufB.length) {
		timingSafeEqual(bufA, bufA);
		return false;
	}
	return timingSafeEqual(bufA, bufB);
}

export function signHs256(claims, secret) {
	const header = { alg: 'HS256', typ: 'JWT' };
	const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
	const signature = createHmac('sha256', secret).update(signingInput).digest('base64url');
	return `${signingInput}.${signature}`;
}

// Returns the decoded payload for a signature that verifies and has not
// expired, or null for anything else: no throw on a malformed token, since
// every caller treats "not vouched for" as unauthorized rather than an error.
export function verifyHs256(token, secret) {
	if (typeof token !== 'string') return null;
	const parts = token.split('.');
	if (parts.length !== 3) return null;
	const [headerPart, payloadPart, signaturePart] = parts;

	const signingInput = `${headerPart}.${payloadPart}`;
	const expectedSignature = createHmac('sha256', secret).update(signingInput).digest('base64url');
	if (!safeEqual(signaturePart, expectedSignature)) return null;

	let payload;
	try {
		payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
	} catch (err) {
		return null;
	}
	if (!payload || typeof payload !== 'object') return null;

	if (typeof payload.exp === 'number' && Math.floor(Date.now() / 1000) >= payload.exp) {
		return null;
	}

	return payload;
}
