/*
 * ZA-165 / esfoobar/zeroagent#287. The counted redirect: the one URL a real
 * download (a click, a copied link, a curl) always goes through, and the
 * count of record for how many downloads actually happened.
 *
 * /zeroagent/download/arm64 and /zeroagent/download/x64 rewrite here with
 * the arch already in the query string (see vercel.json). This function
 * records one event to Vercel Blob and then answers a 302 straight to the
 * CDN file. Recording never blocks the download for long: the blob put has
 * a hard timeout, and a version lookup that fails just says "unknown".
 *
 * ZA-204 adds a second, additive report of the same event to GA4 via the
 * Measurement Protocol (see api/_lib/ga4.js and zeroagent/docs/DOWNLOADS.md),
 * so it never affects the Blob write or the 302: it is dispatched in
 * parallel with the Blob put, never awaited on the response path, and kept
 * alive past the response with waitUntil so it can still finish once the
 * redirect has already gone out.
 */

import { put } from '@vercel/blob';
import { waitUntil } from '@vercel/functions';
import { parseUserAgent } from './_lib/ua.js';
import {
	extractClientId,
	randomClientId,
	extractSessionId,
	fallbackSessionId,
	firstForwardedIp,
	buildDownloadServedPayload,
	sendGa4Event,
} from './_lib/ga4.js';

const VALID_ARCHES = new Set(['arm64', 'x64']);
const RELEASES_BASE = 'https://releases.zeroagent.mvplean.com';
const VERSION_CACHE_MS = 5 * 60 * 1000;
const PUT_TIMEOUT_MS = 1500;

// Module-scope cache: this survives across invocations on a warm instance
// and costs nothing on a cold one beyond the first fetch.
let versionCache = { value: null, fetchedAt: 0 };

async function currentVersion() {
	const now = Date.now();
	if (versionCache.value && now - versionCache.fetchedAt < VERSION_CACHE_MS) {
		return versionCache.value;
	}
	try {
		const res = await fetch(`${RELEASES_BASE}/latest-mac.yml`);
		if (!res.ok) throw new Error(`latest-mac.yml responded ${res.status}`);
		const text = await res.text();
		const match = text.match(/^version:\s*(.+?)\s*$/m);
		const version = match ? match[1].replace(/^['"]|['"]$/g, '') : 'unknown';
		versionCache = { value: version, fetchedAt: now };
		return version;
	} catch (err) {
		// Never block the redirect on a slow or failing feed. Fall back to
		// the last known good value, or "unknown" if there has never been one.
		return versionCache.value || 'unknown';
	}
}

function sanitizeSegment(value) {
	const cleaned = String(value == null ? '' : value).replace(/[^A-Za-z0-9._]/g, '');
	return cleaned || 'unknown';
}

function withTimeout(promise, ms) {
	return new Promise((resolve) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (!settled) {
				settled = true;
				resolve(undefined);
			}
		}, ms);
		promise.then(
			(value) => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					resolve(value);
				}
			},
			() => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					resolve(undefined);
				}
			}
		);
	});
}

function firstHeader(value) {
	if (Array.isArray(value)) return value[0];
	return value;
}

// Fire-and-forget: builds and sends the GA4 event, catching everything
// internally so a caller never needs to await or catch this. Returns the
// in-flight promise only so it can be handed to waitUntil.
function reportToGa4(req, { arch, version, ts }) {
	const apiSecret = process.env.GA4_API_SECRET;
	if (!apiSecret) {
		console.log('[ga4] GA4_API_SECRET is not set; skipping the Measurement Protocol event');
		return Promise.resolve();
	}

	const cookie = firstHeader(req.headers['cookie']);
	const clientId = extractClientId(cookie) || randomClientId();
	const sessionId = extractSessionId(cookie) || fallbackSessionId(ts.getTime());
	const ua = firstHeader(req.headers['user-agent']) || '';
	const ip = firstForwardedIp(firstHeader(req.headers['x-forwarded-for']), firstHeader(req.headers['x-real-ip']));
	const referer = firstHeader(req.headers['referer']) || null;

	const payload = buildDownloadServedPayload({
		clientId,
		sessionId,
		arch,
		version,
		ua,
		ip,
		referer,
		timestampMs: ts.getTime(),
	});

	return sendGa4Event({ payload, apiSecret }).catch((err) => {
		console.log(`[ga4] Measurement Protocol request failed: ${err && err.message}`);
	});
}

export default async function handler(req, res) {
	const rawArch = req.query && req.query.arch;
	const arch = String(Array.isArray(rawArch) ? rawArch[0] : rawArch || '');

	if (!VALID_ARCHES.has(arch)) {
		res.statusCode = 404;
		res.setHeader('Content-Type', 'text/plain; charset=utf-8');
		res.setHeader('Cache-Control', 'no-store');
		res.end('not found: unknown architecture\n');
		return;
	}

	const version = await currentVersion();
	const targetUrl = `${RELEASES_BASE}/latest/ZeroAgent-${arch}.dmg`;

	if (req.method !== 'HEAD') {
		const ts = new Date();
		const date = ts.toISOString().slice(0, 10);
		const ua = firstHeader(req.headers['user-agent']) || '';
		const parsed = parseUserAgent(ua);
		const rawCity = firstHeader(req.headers['x-vercel-ip-city']);

		const event = {
			ts: ts.toISOString(),
			date,
			arch,
			version,
			country: firstHeader(req.headers['x-vercel-ip-country']) || null,
			region: firstHeader(req.headers['x-vercel-ip-country-region']) || null,
			city: rawCity ? decodeURIComponent(rawCity) : null,
			latitude: firstHeader(req.headers['x-vercel-ip-latitude']) || null,
			longitude: firstHeader(req.headers['x-vercel-ip-longitude']) || null,
			timezone: firstHeader(req.headers['x-vercel-ip-timezone']) || null,
			browser: parsed.browser,
			browserVersion: parsed.browserVersion,
			os: parsed.os,
			osVersion: parsed.osVersion,
			device: parsed.device,
			bot: parsed.bot,
			referrer: firstHeader(req.headers['referer']) || null,
			ua,
			lang: firstHeader(req.headers['accept-language']) || null,
		};

		const pathname = [
			'downloads',
			date,
			[
				ts.getTime(),
				sanitizeSegment(arch),
				sanitizeSegment(version),
				sanitizeSegment(event.country),
				sanitizeSegment(event.browser),
				sanitizeSegment(event.os),
			].join('-') + '.json',
		].join('/');

		const blobWrite = withTimeout(
			put(pathname, JSON.stringify(event), {
				access: 'private',
				addRandomSuffix: true,
				contentType: 'application/json',
			}),
			PUT_TIMEOUT_MS
		).catch(() => {
			// A store failure never blocks the download.
		});

		// Dispatched in parallel with the Blob write above, never awaited on
		// the response path; waitUntil keeps it alive past the 302 that
		// follows below.
		waitUntil(reportToGa4(req, { arch, version, ts }));

		await blobWrite;
	}

	res.statusCode = 302;
	res.setHeader('Cache-Control', 'no-store');
	res.setHeader('Location', targetUrl);
	res.end();
}
