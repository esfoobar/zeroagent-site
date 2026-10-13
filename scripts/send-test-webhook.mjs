// ZA-902. Proves the raw-body path of the Stripe webhook endpoint on a
// deployment, before any Stripe account exists. It POSTs a synthetic event
// of an unsupported type (the endpoint verifies it, records it in the
// inbox as ignored, and changes no account), signed with the endpoint's
// signing secret, and then the same body with a corrupted signature.
//
//   STRIPE_WEBHOOK_SECRET=... node scripts/send-test-webhook.mjs <url> [--live]
//
// The secret is read only from the environment, never an argument, and is
// never printed. The body is serialized with unusual spacing and non-ASCII
// text on purpose: it verifies only if the function sees the exact bytes.
//
// Expected: signed request 200 with outcome `unsupported_type`, tampered
// request 400 `invalid_signature`. A signed request answered 400 means the
// function did not receive the raw bytes; 503 `body_unavailable` means the
// body could not be read at all.

import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { signStripePayload } from '../api/_lib/stripe-signature.js';

export function buildProbe({ secret, livemode = false, now = new Date(), id = `evt_probe_${randomBytes(6).toString('hex')}` }) {
	const event = {
		id,
		object: 'event',
		type: 'zeroagent.webhook_probe',
		created: Math.floor(now.getTime() / 1000),
		livemode,
		data: { object: { id: 'probe_1', note: 'spacing  and é中文 bytes' } },
	};
	// Deliberate formatting: re-serializing this would change the bytes.
	const body = JSON.stringify(event, null, 3).replace(':', ' :  ');
	const timestamp = Math.floor(now.getTime() / 1000);
	const signature = signStripePayload(Buffer.from(body, 'utf8'), timestamp, secret);
	return { body, timestamp, signature, eventId: id };
}

async function send(url, body, header) {
	const response = await fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json; charset=utf-8', 'stripe-signature': header },
		body,
	});
	let parsed = null;
	try {
		parsed = await response.json();
	} catch {
		parsed = null;
	}
	return { status: response.status, body: parsed };
}

async function main() {
	const [url, ...flags] = process.argv.slice(2);
	const secret = process.env.STRIPE_WEBHOOK_SECRET;
	if (!url || !/^https:\/\//.test(url)) {
		console.error('usage: STRIPE_WEBHOOK_SECRET=... node scripts/send-test-webhook.mjs https://<host>/api/stripe/webhook [--live]');
		process.exit(2);
	}
	if (!secret) {
		console.error('STRIPE_WEBHOOK_SECRET is not set');
		process.exit(2);
	}
	const probe = buildProbe({ secret, livemode: flags.includes('--live') });
	const good = await send(url, probe.body, `t=${probe.timestamp},v1=${probe.signature}`);
	const bad = await send(url, probe.body, `t=${probe.timestamp},v1=${'0'.repeat(64)}`);
	console.log(`event ${probe.eventId}`);
	console.log(`signed:   ${good.status} ${JSON.stringify(good.body)}`);
	console.log(`tampered: ${bad.status} ${JSON.stringify(bad.body)}`);
	const pass = good.status === 200 && good.body && good.body.received === true && bad.status === 400;
	console.log(pass ? 'PASS: the function verified the exact request bytes' : 'FAIL: see the notes at the top of this script');
	process.exit(pass ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
