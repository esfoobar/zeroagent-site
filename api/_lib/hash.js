/*
 * ZA-224 / esfoobar/zeroagent#365. Two small primitives pairing needs:
 * a random opaque token for the QR code and the pairing-token store, and a
 * one-way hash so neither the pairing token nor a device token is ever
 * stored in Mongo, only what proves a caller had it.
 */

import { createHash, randomBytes } from 'node:crypto';

export function sha256Hex(value) {
	return createHash('sha256').update(value).digest('hex');
}

export function randomToken(bytes = 32) {
	return randomBytes(bytes).toString('base64url');
}
