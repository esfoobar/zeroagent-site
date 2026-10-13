import { loadBillingEnvironment, BILLING_ENV_VARS } from '../api/_lib/billing-config.js';
import { createStripeClient } from '../api/_lib/stripe-client.js';
import { getBillingStore } from '../api/_lib/billing-store.js';
import { verifySandboxScenario } from '../api/_lib/billing-sandbox.js';

// Scenario arguments are passed as --camelCase=value. Never print them.
try {
	const args = Object.fromEntries(process.argv.slice(2).map((value) => {
		const match = /^--([A-Za-z]+)=(.+)$/.exec(value);
		if (!match) throw new Error('invalid_argument');
		return [match[1], match[2]];
	}));
	const environment = loadBillingEnvironment();
	if (environment.livemode || !process.env[BILLING_ENV_VARS.apiKey].startsWith('rk_test_')) throw new Error('sandbox_restricted_key_required');
	const stripe = createStripeClient({ apiKey: process.env[BILLING_ENV_VARS.apiKey], apiVersion: process.env[BILLING_ENV_VARS.apiVersion] || null });
	const { collections } = await getBillingStore();
	const result = await verifySandboxScenario({ scenario: args.scenario, stripe, environment, args: { ...args, apiKey: process.env[BILLING_ENV_VARS.apiKey], database: process.env.MONGODB_DB }, collections });
	await new Promise((resolve) => process.stdout.write(`${JSON.stringify({ status: 'PASS', ...result })}\n`, resolve));
	process.exit(0);
} catch (error) {
	await new Promise((resolve) => process.stderr.write(`sandbox proof failed: ${/^[a-z_]+$/.test(error.message) ? error.message : 'check_failed'}\n`, resolve));
	process.exit(1);
}
