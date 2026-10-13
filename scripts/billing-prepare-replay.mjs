import { loadBillingEnvironment } from '../api/_lib/billing-config.js';
import { getBillingStore } from '../api/_lib/billing-store.js';
import { prepareEventReplay } from '../api/_lib/billing-replay.js';

// Read the event id from stdin, so it does not appear in the process list.
try {
	const [actor, reason] = process.argv.slice(2);
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	const eventId = Buffer.concat(chunks).toString('utf8').trim();
	const environment = loadBillingEnvironment();
	const store = await getBillingStore();
	console.log(JSON.stringify(await prepareEventReplay(store, { environment, eventId, actor, reason })));
} catch {
	console.error('replay preparation failed');
	process.exitCode = 1;
}
