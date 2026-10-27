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

import { put, list } from '@vercel/blob';
import { waitUntil } from '@vercel/functions';
import { parseUserAgent } from './_lib/ua.js';
import { resolveDownloadRoute, releaseVersion } from './_lib/download-routes.js';
import { baseClass, classifyRows, buildPathname, parsePathname, sanitizeSegment } from './_lib/download-class.js';
import {
	extractClientId,
	randomClientId,
	extractSessionId,
	fallbackSessionId,
	firstForwardedIp,
	buildDownloadServedPayload,
	sendGa4Event,
} from './_lib/ga4.js';

const RELEASES_BASE = 'https://releases.zeroagenthq.com';
const VERSION_CACHE_MS = 5 * 60 * 1000;
const PUT_TIMEOUT_MS = 1500;
const NEIGHBOUR_TIMEOUT_MS = 800;

// Module-scope cache: this survives across invocations on a warm instance
// and costs nothing on a cold one beyond the first fetch.
let versionCache = { value: null, fetchedAt: 0 };
let macVersionCache = { value: null, fetchedAt: 0 };

async function currentVersions() {
	const now = Date.now();
	if (versionCache.fetchedAt && now - versionCache.fetchedAt < VERSION_CACHE_MS) {
		return versionCache.value;
	}
	try {
		const res = await fetch(`${RELEASES_BASE}/latest/release.json`, { signal: AbortSignal.timeout(3000) });
		if (!res.ok) throw new Error(`release.json responded ${res.status}`);
		const versions = await res.json();
		versionCache = { value: versions, fetchedAt: now };
		return versions;
	} catch (err) {
		versionCache.fetchedAt = now;
		return versionCache.value || null;
	}
}

async function macVersion() {
	const now = Date.now();
	if (macVersionCache.fetchedAt && now - macVersionCache.fetchedAt < VERSION_CACHE_MS) return macVersionCache.value;
	const manifest = await currentVersions();
	const version = releaseVersion(manifest, 'mac');
	if (version) {
		macVersionCache = { value: version, fetchedAt: now };
		return version;
	}
	// Existing macOS links must continue to work before release.json exists.
	try {
		const res = await fetch(`${RELEASES_BASE}/latest-mac.yml`, { signal: AbortSignal.timeout(3000) });
		if (res.ok) {
			const match = (await res.text()).match(/^version:\s*(.+?)\s*$/m);
			macVersionCache = { value: match ? match[1].replace(/^['"]|['"]$/g, '') : 'unknown', fetchedAt: now };
			return macVersionCache.value;
		}
	} catch { /* Keep the fallback for this cache window. */ }
	macVersionCache = { value: 'unknown', fetchedAt: now };
	return macVersionCache.value;
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
function reportToGa4(req, { arch, platform, format, version, ts, trafficClass }) {
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
		platform,
		format,
		version,
		ua,
		ip,
		referer,
		trafficClass,
		timestampMs: ts.getTime(),
	});

	return sendGa4Event({ payload, apiSecret }).catch((err) => {
		console.log(`[ga4] Measurement Protocol request failed: ${err && err.message}`);
	});
}

// Events already recorded today, read from their pathnames alone, so the
// burst rule can see the sweep this request may be part of. Best effort: a
// slow or failed list just means the burst check sees nothing, and the stats
// endpoint (which sees every event) still catches the burst when it reads.
async function recentNeighbours(date) {
	const result = await withTimeout(list({ prefix: `downloads/${date}/`, limit: 200 }), NEIGHBOUR_TIMEOUT_MS);
	if (!result || !Array.isArray(result.blobs)) return [];
	const rows = [];
	for (const blob of result.blobs) {
		const fields = parsePathname(blob.pathname);
		if (!fields || fields.tsMs == null) continue;
		rows.push({ ...fields, city: fields.city || null, base: fields.base || 'unverified' });
	}
	return rows;
}

export default async function handler(req, res) {
	const query = req.query || {};
	const scalar = (value) => Array.isArray(value) ? value[0] : value;
	const route = resolveDownloadRoute({ os: scalar(query.os), arch: scalar(query.arch), format: scalar(query.format) });

	if (!route) {
		res.statusCode = 404;
		res.setHeader('Content-Type', 'text/plain; charset=utf-8');
		res.setHeader('Cache-Control', 'no-store');
		res.end('not found: unsupported download\n');
		return;
	}

	const { arch, platform, format } = route;
	const version = platform === 'mac' ? await macVersion() : releaseVersion(await currentVersions(), platform);
	const targetUrl = `${RELEASES_BASE}/latest/${route.file}`;
	if (platform === 'linux' || platform === 'windows') {
		let published = false;
		if (version) {
			try { published = (await fetch(targetUrl, { method: 'HEAD', signal: AbortSignal.timeout(3000) })).ok; } catch { /* Keep the route closed. */ }
		}
		if (!published) {
			res.statusCode = 404;
			res.setHeader('Content-Type', 'text/plain; charset=utf-8');
			res.setHeader('Cache-Control', 'no-store');
			res.end('not found: not released yet\n');
			return;
		}
	}

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
			platform,
			format,
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

		const base = baseClass({ browser: parsed.browser, referrer: event.referrer });
		const neighbours = ['human', 'noreferrer', 'unverified'].includes(base) ? await recentNeighbours(date) : [];
		const self = {
			tsMs: ts.getTime(),
			country: sanitizeSegment(event.country),
			city: event.city ? sanitizeSegment(event.city) : null,
			arch,
			platform,
			format,
			base,
		};
		const verdicts = classifyRows([...neighbours, self]);
		const trafficClass = verdicts[verdicts.length - 1];
		event.baseClass = base;
		event.trafficClass = trafficClass;

		const pathname = buildPathname({
			date,
			tsMs: ts.getTime(),
			arch,
			platform,
			format,
			version,
			country: event.country,
			browser: event.browser,
			os: event.os,
			base,
			city: event.city,
		});

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
		waitUntil(reportToGa4(req, { arch, platform, format, version, ts, trafficClass }));

		await blobWrite;
	}

	res.statusCode = 302;
	res.setHeader('Cache-Control', 'no-store');
	res.setHeader('Location', targetUrl);
	res.end();
}
