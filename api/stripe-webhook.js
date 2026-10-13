/*
 * ZA-902 / esfoobar/zeroagent#1265. POST /api/stripe/webhook (rewritten to
 * this file in vercel.json): the Stripe event destination. Function 11 of
 * the Hobby plan's 12. It is its own file because the signature is over the
 * exact request bytes and Vercel parses JSON bodies before a function runs
 * unless the body parser is switched off, which is not possible on the
 * shared api/web.js function.
 *
 * Order, and nothing touches storage before step 4:
 *   1. POST only.
 *   2. Billing configuration (names only in any error; 503 when unset).
 *   3. Raw body, size bounded; signature checked with a timestamp
 *      tolerance against STRIPE_WEBHOOK_SECRET.
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

// Vercel must hand over the unparsed stream.
export const config = { api: { bodyParser: false } };

export const MAX_BODY_BYTES = 1024 * 1024;

function send(res, status, payload) {
	res.statusCode = status;
	res.setHeader('Content-Type', 'application/json; charset=utf-8');
	res.setHeader('Cache-Control', 'no-store');
	res.end(JSON.stringify(payload));
}

class BodyTooLargeError extends Error {}

async function readRawBody(req, limit = MAX_BODY_BYTES) {
	if (Buffer.isBuffer(req.body)) return req.body;
	if (typeof req.body === 'string') return Buffer.from(req.body, 'utf8');
	if (req.body !== undefined && req.body !== null && typeof req.on !== 'function') return null;
	const declared = Number(req.headers && req.headers['content-length']);
	if (Number.isFinite(declared) && declared > limit) throw new BodyTooLargeError();
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buf.length;
		if (size > limit) throw new BodyTooLargeError();
		chunks.push(buf);
	}
	return Buffer.concat(chunks);
}

function header(req, name) {
	const value = req.headers && req.headers[name];
	return Array.isArray(value) ? value[0] : value;
}

export default async function handler(req, res, deps = {}) {
	const env = deps.env || process.env;
	const now = deps.now || (() => new Date());

	if (req.method !== 'POST') {
		res.setHeader('Allow', 'POST');
		send(res, 405, { error: 'method_not_allowed' });
		return;
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
		send(res, 503, { error: 'billing_unavailable' });
		return;
	}

	let raw;
	try {
		raw = await (deps.readBody || readRawBody)(req);
	} catch (err) {
		if (err instanceof BodyTooLargeError) {
			send(res, 413, { error: 'payload_too_large' });
			return;
		}
		send(res, 400, { error: 'body_unreadable' });
		return;
	}
	if (!raw) {
		send(res, 400, { error: 'body_unavailable' });
		return;
	}

	try {
		verifyStripeSignature(raw, header(req, 'stripe-signature'), secret.trim(), { now: now() });
	} catch (err) {
		if (err instanceof StripeSignatureError) {
			send(res, 400, { error: 'invalid_signature' });
			return;
		}
		throw err;
	}

	let event;
	try {
		event = JSON.parse(raw.toString('utf8'));
	} catch {
		send(res, 400, { error: 'invalid_payload' });
		return;
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
		send(res, 400, { error: 'invalid_payload' });
		return;
	}

	try {
		assertLivemode(environment, event, 'event');
	} catch (err) {
		if (err instanceof BillingModeMismatchError) {
			send(res, 400, { error: 'mode_mismatch' });
			return;
		}
		throw err;
	}
	// Events for this account carry no `account`; one that names another
	// account (a Connect event) is not ours.
	if (event.account !== undefined && event.account !== null && event.account !== environment.stripeAccountId) {
		send(res, 400, { error: 'account_mismatch' });
		return;
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
		send(res, 503, { error: 'retry', reason: 'store_unavailable' });
		return;
	}
	send(res, result.status, result.body);
}
