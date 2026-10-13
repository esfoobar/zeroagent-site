import { getBillingStore } from '../api/_lib/billing-store.js';
import { loadBillingEnvironment, BILLING_ENV_VARS } from '../api/_lib/billing-config.js';
import { createStripeClient } from '../api/_lib/stripe-client.js';
import { auditBilling } from '../api/_lib/billing-operations.js';

try {
	const environment = loadBillingEnvironment();
	const store = await getBillingStore();
	const stripe = createStripeClient({ apiKey: process.env[BILLING_ENV_VARS.apiKey], apiVersion: process.env[BILLING_ENV_VARS.apiVersion] || null });
	const result = await auditBilling({ collections: store.collections, stripe, environment });
	console.log(JSON.stringify(result));
	if (result.alerts.length) process.exitCode = 2;
} catch {
	console.error('billing audit unavailable');
	process.exitCode = 1;
}
