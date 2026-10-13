import { getBillingStore } from '../api/_lib/billing-store.js';
import { loadBillingEnvironment, BILLING_ENV_VARS } from '../api/_lib/billing-config.js';
import { createStripeClient } from '../api/_lib/stripe-client.js';
import { auditBilling } from '../api/_lib/billing-operations.js';

try {
	const environment = loadBillingEnvironment();
	const store = await getBillingStore();
	const stripe = createStripeClient({ apiKey: process.env[BILLING_ENV_VARS.apiKey], apiVersion: process.env[BILLING_ENV_VARS.apiVersion] || null });
	const result = await auditBilling({ collections: store.collections, stripe, environment, referenceKey: process.env[BILLING_ENV_VARS.webhookSecret] });
	await new Promise((resolve) => process.stdout.write(`${JSON.stringify(result)}\n`, resolve));
	process.exit(result.alerts.length || result.truncated ? 2 : 0);
} catch {
	await new Promise((resolve) => process.stderr.write('billing audit unavailable\n', resolve));
	process.exit(1);
}
