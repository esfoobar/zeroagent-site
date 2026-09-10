/*
 * ZA-289. This API moved from mvplean.com to api.zeroagenthq.com. The relay
 * that verifies these same JWTs used to accept only the legacy issuer, so
 * minting the new one first would have locked every new token out at
 * connect. This module therefore mints the legacy issuer by default and
 * switches only when ZEROAGENT_JWT_ISSUER=https://zeroagenthq.com is set on
 * the Vercel project, which it has been since 2026-09-10, after the relay was
 * deployed accepting both (ZA-291). Verifiers here accept either issuer, and
 * the legacy value stays accepted until the last token minted with it has
 * expired: as late as 2027-09-10, for a paired phone's 365-day device token.
 */

export const LEGACY_ISSUER = 'https://mvplean.com';
export const NEW_ISSUER = 'https://zeroagenthq.com';
export const ACCEPTED_ISSUERS = Object.freeze([LEGACY_ISSUER, NEW_ISSUER]);

// Read at call time, not module load, so a test can set ZEROAGENT_JWT_ISSUER
// and see the effect without re-importing this module.
export function mintingIssuer() {
	const configured = process.env.ZEROAGENT_JWT_ISSUER;
	return ACCEPTED_ISSUERS.includes(configured) ? configured : LEGACY_ISSUER;
}
