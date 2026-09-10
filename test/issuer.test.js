// ZA-289. api/_lib/issuer.js: which issuer this deployment mints today, and
// which issuers a verifier here accepts, during the cutover from
// mvplean.com to api.zeroagenthq.com described in the file's own docstring.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { LEGACY_ISSUER, NEW_ISSUER, ACCEPTED_ISSUERS, mintingIssuer } from '../api/_lib/issuer.js';

const REAL_ISSUER_ENV = process.env.ZEROAGENT_JWT_ISSUER;

beforeEach(() => {
	delete process.env.ZEROAGENT_JWT_ISSUER;
});

afterEach(() => {
	if (REAL_ISSUER_ENV === undefined) {
		delete process.env.ZEROAGENT_JWT_ISSUER;
	} else {
		process.env.ZEROAGENT_JWT_ISSUER = REAL_ISSUER_ENV;
	}
});

test('ACCEPTED_ISSUERS lists exactly the legacy and new issuers', () => {
	assert.deepEqual(ACCEPTED_ISSUERS, [LEGACY_ISSUER, NEW_ISSUER]);
	assert.equal(LEGACY_ISSUER, 'https://mvplean.com');
	assert.equal(NEW_ISSUER, 'https://zeroagenthq.com');
});

test('mintingIssuer defaults to the legacy issuer when ZEROAGENT_JWT_ISSUER is unset', () => {
	assert.equal(mintingIssuer(), LEGACY_ISSUER);
});

test('mintingIssuer honours ZEROAGENT_JWT_ISSUER when it is the new issuer', () => {
	process.env.ZEROAGENT_JWT_ISSUER = NEW_ISSUER;
	assert.equal(mintingIssuer(), NEW_ISSUER);
});

test('mintingIssuer honours ZEROAGENT_JWT_ISSUER when it is the legacy issuer', () => {
	process.env.ZEROAGENT_JWT_ISSUER = LEGACY_ISSUER;
	assert.equal(mintingIssuer(), LEGACY_ISSUER);
});

test('mintingIssuer ignores a garbage value and falls back to the legacy issuer', () => {
	process.env.ZEROAGENT_JWT_ISSUER = 'https://evil.example';
	assert.equal(mintingIssuer(), LEGACY_ISSUER);
});
