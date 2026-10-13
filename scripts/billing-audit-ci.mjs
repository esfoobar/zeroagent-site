// Entry point for the scheduled audit workflow. When none of the variables the
// audit needs is set (the live environment is not provisioned yet) it ends
// with exit 0 and one line. A partial set is a misconfiguration and runs the
// audit, which exits 1. Prints names only, never a value.
import { BILLING_ENV_VARS } from '../api/_lib/billing-config.js';

const REQUIRED = [BILLING_ENV_VARS.apiKey, BILLING_ENV_VARS.webhookSecret, BILLING_ENV_VARS.productId, BILLING_ENV_VARS.accountId, BILLING_ENV_VARS.expectLiveMode, 'MONGODB_URI', 'MONGODB_DB'];

if (REQUIRED.every((name) => !String(process.env[name] ?? '').trim())) {
	process.stdout.write('billing audit is not configured: required secrets are unset, nothing was checked\n');
	process.exit(0);
}
await import('./billing-audit.mjs');
