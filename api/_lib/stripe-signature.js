/*
 * ZA-902 / esfoobar/zeroagent#1265. Stripe webhook signature verification
 * with node:crypto, over the exact raw request bytes.
 *
 * The header is `t=<unix seconds>,v1=<hex>[,v1=<hex>...]` (older `v0`
 * entries are ignored). The signed payload is `<t>.<raw body>`, HMAC
 * SHA-256 keyed with the endpoint signing secret. A timestamp outside the
 * tolerance, in either direction, is refused so a captured request cannot
 * be replayed later. Comparison is constant time. Errors carry a short
 * code and never the header, the body or the secret.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_TOLERANCE_SECONDS = 300;

export class StripeSignatureError extends Error {
	constructor(code) {
		super(`stripe signature refused: ${code}`);
		this.name = 'StripeSignatureError';
		this.code = code;
	}
}

function parseHeader(header) {
	let timestamp = null;
	const signatures = [];
	for (const part of String(header).split(',')) {
		const index = part.indexOf('=');
		if (index < 0) continue;
		const name = part.slice(0, index).trim();
		const value = part.slice(index + 1).trim();
		if (name === 't') timestamp = value;
		else if (name === 'v1') signatures.push(value);
	}
	return { timestamp, signatures };
}

export function signStripePayload(rawBody, timestamp, secret) {
	return createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
}

// rawBody: Buffer or string, exactly as received. Returns { timestamp }.
export function verifyStripeSignature(
	rawBody,
	header,
	secret,
	{ now = new Date(), toleranceSeconds = SIGNATURE_TOLERANCE_SECONDS } = {}
) {
	if (typeof secret !== 'string' || secret === '') throw new StripeSignatureError('no_secret');
	if (typeof header !== 'string' || header === '') throw new StripeSignatureError('missing_header');
	const { timestamp, signatures } = parseHeader(header);
	if (!timestamp || !/^\d{1,12}$/.test(timestamp) || signatures.length === 0) {
		throw new StripeSignatureError('malformed_header');
	}
	const expected = Buffer.from(signStripePayload(rawBody, timestamp, secret), 'hex');
	const ok = signatures.some((candidate) => {
		if (!/^[0-9a-fA-F]{64}$/.test(candidate)) return false;
		return timingSafeEqual(Buffer.from(candidate, 'hex'), expected);
	});
	if (!ok) throw new StripeSignatureError('no_matching_signature');
	const skew = Math.abs(Math.floor(now.getTime() / 1000) - Number(timestamp));
	if (skew > toleranceSeconds) throw new StripeSignatureError('timestamp_outside_tolerance');
	return { timestamp: Number(timestamp) };
}
