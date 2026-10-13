import { loadBillingEnvironment, BILLING_ENV_VARS } from '../api/_lib/billing-config.js';
import { getBillingStore } from '../api/_lib/billing-store.js';
import { prepareEventReplay } from '../api/_lib/billing-replay.js';

// Read the event id or short reference from stdin, not the process list.
try {
	const [actor, reason] = process.argv.slice(2);
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	const eventId = Buffer.concat(chunks).toString('utf8').trim();
	const environment = loadBillingEnvironment();
	const store = await getBillingStore();
	const result = await prepareEventReplay(store, { environment, eventId, referenceKey: process.env[BILLING_ENV_VARS.webhookSecret], actor, reason });
	await new Promise((resolve) => process.stdout.write(`${JSON.stringify(result)}\n`, resolve));
	process.exit(0);
} catch {
	await new Promise((resolve) => process.stderr.write('replay preparation failed\n', resolve));
	process.exit(1);
}
