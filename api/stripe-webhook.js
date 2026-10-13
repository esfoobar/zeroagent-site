/*
 * ZA-902 / esfoobar/zeroagent#1265. POST /api/stripe/webhook (rewritten to
 * this file in vercel.json): the Stripe event destination. Function 11 of
 * the Hobby plan's 12.
 *
 * Why the raw bytes come from a Web-standard `POST(request)` export. The
 * signature is over the exact request bytes, so this function must never see
 * a parsed body. What was read (checked, not assumed):
 *   - @vercel/node 23.0.1 (dist/dev-server.mjs, helpers.ts and
 *     serverless-handler): for a plain `(req, res)` function the runtime
 *     calls addHelpers(), which, whenever a content-type is present, reads
 *     the whole stream first and installs `req.body` as a lazy parser
 *     (application/json becomes an object). The stream is replayed through a
 *     patched `req.on`/`req.read`, which an async iterator does not use, so
 *     a `for await` over `req` can come back empty. Nothing in the package
 *     reads `config.api.bodyParser` (that is the Next.js pages-router
 *     convention) and the only opt-out is project-wide (`NODEJS_HELPERS=0`
 *     or build config `helpers: false`), which the other functions cannot
 *     take because they rely on `req.query` and `req.body`.
 *   - The same file: when the module exports an HTTP method (`POST`) or
 *     `fetch`, the web-handler branch is taken instead and addHelpers() is
 *     never called; the request is adapted to a Web Request over the
 *     untouched stream, so `await request.arrayBuffer()` is the raw bytes.
 *   - Vercel's Node.js runtime and Functions API reference (fetched
 *     2026-10-13) document the Web-standard `export function POST(request:
 *     Request)` form for functions in api/.
 * The production launcher itself is not in the npm packages; the dev
 * server mirrors it, so scripts/send-test-webhook.mjs exists to prove the
 * path on a deployment before any Stripe account does.
 *
 * Do not add a default export: the runtime unwraps `default` before it
 * looks for method exports and would fall back to the helpers path.
 *
 * Order, and nothing touches storage before step 4:
 *   1. POST only (other methods 405 by the runtime).
 *   2. Billing configuration (names only in any error; 503 when unset).
 *   3. Raw body, size bounded, never empty when content-length says
 *      otherwise (that is body_unavailable, a 5xx, not a forgery); then the
 *      signature with a timestamp tolerance against STRIPE_WEBHOOK_SECRET.
 *   4. Parse, then livemode and Stripe account against the environment.
 *   5. billing-webhook.js: inbox, lease, current-state reconciliation,
 *      fenced commit.
 * The response never echoes the payload, and nothing here logs one.
 */

import { BILLING_ENV_VARS, BillingConfigError, BillingModeMismatchError, assertLivemode, loadBillingEnvironment } from './_lib/billing-config.js';
import { processWebhookEvent } from './_lib/billing-webhook.js';
import { StripeSignatureError, verifyStripeSignature } from './_lib/stripe-signature.js';
import { createStripeClient } from './_lib/stripe-client.js';
import { getBillingStore } from './_lib/billing-store.js';

export const MAX_BODY_BYTES = 1024 * 1024;

function reply(status, payload) {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
	});
}

// The deps object is for tests: { env, store, stripe, now }.
export async function handleStripeWebhook(request, deps = {}) {
	const env = deps.env || process.env;
	const now = deps.now || (() => new Date());

	if (request.method !== 'POST') {
		const res = reply(405, { error: 'method_not_allowed' });
		res.headers.set('Allow', 'POST');
		return res;
	}

	let environment;
	let secret;
	try {
		environment = loadBillingEnvironment(env);
		secret = env[BILLING_ENV_VARS.webhookSecret];
		if (typeof secret !== 'string' || secret.trim() === '') {
			throw new BillingConfigError(`${BILLING_ENV_VARS.webhookSecret} is not set`);
		}
	} catch (err) {
		// Variable names only; never a value.
		console.error('stripe-webhook: billing not configured:', err instanceof BillingConfigError ? err.message : 'unexpected');
		return reply(503, { error: 'billing_unavailable' });
	}

	const declared = Number(request.headers.get('content-length'));
	if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return reply(413, { error: 'payload_too_large' });

	let raw;
	try {
		raw = Buffer.from(await request.arrayBuffer());
	} catch {
		// A consumed or unreadable stream is our fault, not a forged request:
		// 5xx so Stripe retries and the cause is visible in the logs.
		console.error('stripe-webhook: body_unavailable: request body could not be read');
		return reply(503, { error: 'body_unavailable' });
	}
	if (raw.length > MAX_BODY_BYTES) return reply(413, { error: 'payload_too_large' });
	if (raw.length === 0 && Number.isFinite(declared) && declared > 0) {
		console.error('stripe-webhook: body_unavailable: zero bytes read but content-length is', declared);
		return reply(503, { error: 'body_unavailable' });
	}

	try {
		verifyStripeSignature(raw, request.headers.get('stripe-signature'), secret.trim(), { now: now() });
	} catch (err) {
		if (err instanceof StripeSignatureError) return reply(400, { error: 'invalid_signature' });
		throw err;
	}

	let event;
	try {
		event = JSON.parse(raw.toString('utf8'));
	} catch {
		return reply(400, { error: 'invalid_payload' });
	}
	if (
		!event ||
		typeof event !== 'object' ||
		typeof event.id !== 'string' ||
		typeof event.type !== 'string' ||
		!event.data ||
		typeof event.data.object !== 'object' ||
		event.data.object === null
	) {
		return reply(400, { error: 'invalid_payload' });
	}

	try {
		assertLivemode(environment, event, 'event');
	} catch (err) {
		if (err instanceof BillingModeMismatchError) return reply(400, { error: 'mode_mismatch' });
		throw err;
	}
	// Events for this account carry no `account`; one that names another
	// account (a Connect event) is not ours.
	if (event.account !== undefined && event.account !== null && event.account !== environment.stripeAccountId) {
		return reply(400, { error: 'account_mismatch' });
	}

	let result;
	try {
		const store = deps.store || (await getBillingStore());
		const stripe =
			deps.stripe ||
			createStripeClient({ apiKey: env[BILLING_ENV_VARS.apiKey], apiVersion: env[BILLING_ENV_VARS.apiVersion] || null });
		result = await processWebhookEvent({
			event,
			environment,
			store,
			stripe,
			now,
			log: (entry) => console.error('stripe-webhook:', JSON.stringify(entry)),
		});
	} catch {
		console.error('stripe-webhook: processing failed before the inbox');
		return reply(503, { error: 'retry', reason: 'store_unavailable' });
	}
	return reply(result.status, result.body);
}

// The Web-standard method export the runtime looks for. No default export.
export async function POST(request) {
	return handleStripeWebhook(request);
}
