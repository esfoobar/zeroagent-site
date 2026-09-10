/*
 * ZA-289. This API is moving from mvplean.com to api.zeroagenthq.com, but the
 * relay that verifies these same JWTs checks `iss` with an exact string
 * match and today only accepts the legacy issuer. Minting the new issuer
 * before the relay accepts both would lock every new token out at connect,
 * so this module keeps minting the legacy issuer by default and only
 * switches once ZEROAGENT_JWT_ISSUER=https://zeroagenthq.com is set on the
 * Vercel project, after the relay's own update lands under another ticket.
 * Verifiers here accept either issuer throughout the cutover, and the
 * legacy value stays accepted until the last token minted with it has
 * expired.
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
