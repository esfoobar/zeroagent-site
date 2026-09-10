/*
 * ZA-222 / esfoobar/zeroagent#363. Receives bug and feature feedback from
 * the desktop app (and, later, a form on the site itself, hence `source`)
 * and stores it. POST accepts one submission; GET, token-gated the same
 * way as /api/download-stats (Bearer header or ?token=, timing-safe
 * compare against DOWNLOAD_STATS_TOKEN), returns the newest 100 so they
 * can be read without a database client.
 *
 * Storage is api/_lib/feedback-store.js, on MongoDB Atlas; this file only
 * calls save() and listRecent() and never touches the database directly.
 *
 * Rate limiting below is a per-instance, in-memory best effort: a cold
 * start or a second concurrent instance resets or bypasses it, which a
 * serverless function has no way to fix on its own. The real limit is a
 * Vercel WAF rate-limit rule, a dashboard click for Jorge, not code.
 */

import { randomUUID, timingSafeEqual } from 'node:crypto';
import { firstForwardedIp } from './_lib/ga4.js';
import { save, listRecent } from './_lib/feedback-store.js';

const MAX_BODY_BYTES = 8 * 1024;
const MAX_TEXT_LENGTH = 4000;
const MAX_EMAIL_LENGTH = 320;
const MAX_META_LENGTH = 200;
const VALID_KINDS = new Set(['bug', 'feature']);
const VALID_SOURCES = new Set(['app', 'site']);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LIST_LIMIT = 100;
const CORS_ORIGIN = 'https://mvplean.com';

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX = 5;
// Module scope: survives across invocations on a warm instance, gone on a
// cold one. See the file docstring on why this is best-effort only.
const submissionsByIp = new Map();

function isRateLimited(ip) {
	if (!ip) return false;
	const now = Date.now();
	const timestamps = (submissionsByIp.get(ip) || []).filter(
		(t) => now - t < RATE_LIMIT_WINDOW_MS
	);
	if (timestamps.length >= RATE_LIMIT_MAX) {
		submissionsByIp.set(ip, timestamps);
		return true;
	}
	timestamps.push(now);
	submissionsByIp.set(ip, timestamps);
	return false;
}

function safeEqual(a, b) {
	const bufA = Buffer.from(String(a == null ? '' : a));
	const bufB = Buffer.from(String(b == null ? '' : b));
	if (bufA.length !== bufB.length) {
		// Compare the buffer against itself so a length mismatch takes
		// roughly the same time as a real comparison, rather than returning
		// early and leaking the length through timing.
		timingSafeEqual(bufA, bufA);
		return false;
	}
	return timingSafeEqual(bufA, bufB);
}

function extractToken(req) {
	const queryToken = req.query && req.query.token;
	if (queryToken) return Array.isArray(queryToken) ? queryToken[0] : queryToken;
	const auth = req.headers && req.headers.authorization;
	if (auth) {
		const match = String(auth).match(/^Bearer\s+(.+)$/i);
		if (match) return match[1];
	}
	return null;
}

function firstHeader(value) {
	return Array.isArray(value) ? value[0] : value;
}

function sendJson(res, status, payload) {
	res.statusCode = status;
	res.setHeader('Content-Type', 'application/json; charset=utf-8');
	res.setHeader('Cache-Control', 'private, no-store');
	res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
	res.end(JSON.stringify(payload));
}

function stripHtml(value) {
	return String(value).replace(/<[^>]*>/g, '');
}

function cleanOptionalString(value, maxLength) {
	if (value === undefined || value === null) return null;
	if (typeof value !== 'string') return null;
	const trimmed = stripHtml(value).trim();
	if (!trimmed) return null;
	return trimmed.slice(0, maxLength);
}

async function handleGet(req, res) {
	const expected = process.env.DOWNLOAD_STATS_TOKEN;
	const provided = extractToken(req);
	if (!expected || !provided || !safeEqual(provided, expected)) {
		sendJson(res, 401, { ok: false, error: 'unauthorized' });
		return;
	}

	let docs;
	try {
		docs = await listRecent(LIST_LIMIT);
	} catch (err) {
		sendJson(res, 502, { ok: false, error: 'could not read the feedback store' });
		return;
	}
	sendJson(res, 200, docs);
}

async function handlePost(req, res) {
	const contentLength = parseInt(firstHeader(req.headers['content-length']), 10);
	if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
		sendJson(res, 413, { ok: false, error: 'body too large' });
		return;
	}

	// req.body is a Vercel getter: absent Content-Type it is undefined, and
	// malformed JSON throws when the getter runs rather than returning null.
	let body;
	try {
		body = req.body;
	} catch (err) {
		sendJson(res, 400, { ok: false, error: 'invalid JSON' });
		return;
	}
	if (typeof body === 'string') {
		try {
			body = JSON.parse(body);
		} catch (err) {
			sendJson(res, 400, { ok: false, error: 'invalid JSON' });
			return;
		}
	}
	if (!body || typeof body !== 'object') {
		sendJson(res, 400, { ok: false, error: 'invalid JSON' });
		return;
	}
	// Defense in depth beyond the Content-Length header above, which a
	// client can lie about or omit: reject on the parsed body's own size too.
	if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_BODY_BYTES) {
		sendJson(res, 413, { ok: false, error: 'body too large' });
		return;
	}

	const ip = firstForwardedIp(
		firstHeader(req.headers['x-forwarded-for']),
		firstHeader(req.headers['x-real-ip'])
	);

	// Honeypot: a real form never fills this hidden field. Report success
	// without validating anything else, so a bot that fills it learns
	// nothing about which other field would have tripped it.
	if (typeof body.website === 'string' && body.website.trim() !== '') {
		sendJson(res, 201, { ok: true, id: randomUUID() });
		return;
	}

	if (isRateLimited(ip)) {
		sendJson(res, 429, { ok: false, error: 'too many submissions' });
		return;
	}

	const kind = typeof body.kind === 'string' ? body.kind.trim() : '';
	if (!VALID_KINDS.has(kind)) {
		sendJson(res, 400, { ok: false, error: 'kind must be "bug" or "feature"' });
		return;
	}

	const text = typeof body.text === 'string' ? stripHtml(body.text).trim() : '';
	if (text.length < 1 || text.length > MAX_TEXT_LENGTH) {
		sendJson(res, 400, {
			ok: false,
			error: 'text is required and must be 1 to 4000 characters',
		});
		return;
	}

	const source = typeof body.source === 'string' ? body.source.trim() : '';
	if (!VALID_SOURCES.has(source)) {
		sendJson(res, 400, { ok: false, error: 'source must be "app" or "site"' });
		return;
	}

	let email = null;
	if (body.email !== undefined && body.email !== null && body.email !== '') {
		const trimmedEmail =
			typeof body.email === 'string' ? stripHtml(body.email).trim() : '';
		if (
			!trimmedEmail ||
			trimmedEmail.length > MAX_EMAIL_LENGTH ||
			!EMAIL_PATTERN.test(trimmedEmail)
		) {
			sendJson(res, 400, { ok: false, error: 'email is not a plausible address' });
			return;
		}
		email = trimmedEmail;
	}

	const doc = {
		id: randomUUID(),
		kind,
		text,
		createdAt: new Date().toISOString(),
		email,
		userId: null,
		source,
		appVersion: cleanOptionalString(body.appVersion, MAX_META_LENGTH),
		platform: cleanOptionalString(body.platform, MAX_META_LENGTH),
		arch: cleanOptionalString(body.arch, MAX_META_LENGTH),
		country: firstHeader(req.headers['x-vercel-ip-country']) || null,
		status: 'new',
		themes: [],
	};

	try {
		await save(doc);
	} catch (err) {
		sendJson(res, 502, { ok: false, error: 'could not store the submission' });
		return;
	}

	sendJson(res, 201, { ok: true, id: doc.id });
}

export default async function handler(req, res) {
	if (req.method === 'POST') {
		await handlePost(req, res);
		return;
	}
	if (req.method === 'GET' || req.method === 'HEAD') {
		await handleGet(req, res);
		return;
	}
	sendJson(res, 405, { ok: false, error: 'method not allowed' });
}
