# Review pairing credential

The review pairing token belongs to one configured demo account. Claims use the normal `/api/auth/pair/claim` route. Each successful claim adds a separate paired device and returns its normal 365-day device JWT. The public `/api/auth/pair` route continues to mint single-use five-minute tokens.

First create a dedicated GitHub account, sign in through the desktop once so its `users` row exists, and give it a hand-assigned plan that allows the relay and does not lapse. A trial is insufficient. Record its numeric GitHub ID as `ZEROAGENT_REVIEW_DEMO_GITHUB_ID` on the site project for Production and Preview. The claim route refuses review tokens if this setting is missing or does not match the token's owner. Zero Agent must perform account, environment, and Atlas setup separately.

Run the operator script with `ZEROAGENT_JWT_SECRET`, `MONGODB_URI`, `MONGODB_DB`, and `ZEROAGENT_REVIEW_DEMO_GITHUB_ID` set for the same site environment. It refuses to operate without all four. The script is not deployed as a function. Keep shell tracing off and use a private terminal. Never put the credential in command arguments, logs, issue text, or this repository.

```sh
umask 077
npm run review:pairing -- mint > review-pairing-token.txt
```

The token is returned only on stdout by `mint`; store it in a protected secret location. Its lifetime is 90 days from minting. Renew the same credential for another 90 days from the renewal time before it expires:

```sh
npm run review:pairing -- renew < review-pairing-token.txt
```

An expired token can also be renewed if it has not been revoked. Revoke immediately when the credential is no longer needed:

```sh
npm run review:pairing -- revoke < review-pairing-token.txt
```

Revocation stops new claims. Existing paired devices remain independently revocable through the normal device flow. A revoked token cannot be renewed; mint a new one. The token's SHA-256 hash, account ID, dates, and state are stored in `pairingTokens`; the plaintext is never stored there.
