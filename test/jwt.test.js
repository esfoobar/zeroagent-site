// ZA-289. api/_lib/jwt.js: verifyHs256 accepts either issuer this deployment
// recognizes (api/_lib/issuer.js) and rejects anything else, including a
// token with no iss claim at all, since every minter here always sets one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signHs256, verifyHs256 } from '../api/_lib/jwt.js';
import { LEGACY_ISSUER, NEW_ISSUER } from '../api/_lib/issuer.js';

const SECRET = 'test-secret-do-not-use-in-prod';

function claimsWithIss(iss) {
	const iat = Math.floor(Date.now() / 1000);
	const claims = { sub: 'acct_gh1', gh: 1, login: 'octocat', plan: 'free', iat, exp: iat + 60 };
	if (iss !== undefined) claims.iss = iss;
	return claims;
}

test('verifyHs256 accepts a token minted with the legacy issuer', () => {
	const token = signHs256(claimsWithIss(LEGACY_ISSUER), SECRET);
	const payload = verifyHs256(token, SECRET);
	assert.ok(payload);
	assert.equal(payload.iss, LEGACY_ISSUER);
});

test('verifyHs256 accepts a token minted with the new issuer', () => {
	const token = signHs256(claimsWithIss(NEW_ISSUER), SECRET);
	const payload = verifyHs256(token, SECRET);
	assert.ok(payload);
	assert.equal(payload.iss, NEW_ISSUER);
});

test('verifyHs256 rejects a token with an issuer that is neither of the accepted two', () => {
	const token = signHs256(claimsWithIss('https://evil.example'), SECRET);
	assert.equal(verifyHs256(token, SECRET), null);
});

test('verifyHs256 rejects a token with no iss claim at all', () => {
	const token = signHs256(claimsWithIss(undefined), SECRET);
	assert.equal(verifyHs256(token, SECRET), null);
});
