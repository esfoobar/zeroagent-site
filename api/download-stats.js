/*
 * ZA-165 / esfoobar/zeroagent#287. Reads the download events api/download.js
 * writes to Vercel Blob and answers one JSON summary: totals, a humans
 * versus bots split, and breakdowns by day, arch, version, country, browser
 * and OS. Every one of those comes from list()'s pathnames alone (the
 * pathname layout was chosen for exactly this), except the 25 newest events
 * in "last", which need their bodies for city and referrer. Each pathname's
 * own leading epoch-ms segment gives every event a timestamp too, so "last"
 * carries an ISO "ts" (the body's own when the body fetch succeeds, else
 * derived from that epoch ms) and is sorted newest first by it.
 *
 * Token-gated: this is download telemetry, not something to leave open.
 */

import { timingSafeEqual } from 'node:crypto';
import { list, get } from '@vercel/blob';
import { HUMAN_BROWSERS } from './_lib/ua.js';

const DEFAULT_DAYS = 90;
const MIN_DAYS = 1;
const MAX_DAYS = 3650;
const LAST_N = 25;

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

function parsePathname(pathname) {
	// downloads/<YYYY-MM-DD>/<ts>-<arch>-<version>-<country>-<browser>-<os>-<randomSuffix>.json
	const parts = pathname.split('/');
	if (parts.length !== 3 || parts[0] !== 'downloads') return null;
	const date = parts[1];
	const basename = parts[2].replace(/\.json$/, '');
	const fields = basename.split('-');
	if (fields.length < 6) return null;
	const [epochMs, arch, version, country, browser, os] = fields;
	const tsMs = Number(epochMs);
	return { date, arch, version, country, browser, os, tsMs: Number.isFinite(tsMs) ? tsMs : null };
}

function isHuman(browser) {
	return HUMAN_BROWSERS.includes(browser);
}

function bump(map, key) {
	const k = key || 'unknown';
	map[k] = (map[k] || 0) + 1;
}

async function listAll(prefix) {
	const blobs = [];
	let cursor;
	do {
		const result = await list({ prefix, cursor, limit: 1000 });
		blobs.push(...result.blobs);
		cursor = result.hasMore ? result.cursor : undefined;
	} while (cursor);
	return blobs;
}

async function readEventBody(pathname) {
	try {
		const result = await get(pathname, { access: 'private' });
		if (!result || result.statusCode !== 200) return null;
		const text = await new Response(result.stream).text();
		return JSON.parse(text);
	} catch (err) {
		return null;
	}
}

export default async function handler(req, res) {
	if (req.method !== 'GET' && req.method !== 'HEAD') {
		res.statusCode = 405;
		res.setHeader('Content-Type', 'text/plain; charset=utf-8');
		res.end('method not allowed\n');
		return;
	}

	const expected = process.env.DOWNLOAD_STATS_TOKEN;
	const provided = extractToken(req);
	if (!expected || !provided || !safeEqual(provided, expected)) {
		res.statusCode = 401;
		res.setHeader('Content-Type', 'text/plain; charset=utf-8');
		res.setHeader('Cache-Control', 'private, no-store');
		res.end('unauthorized\n');
		return;
	}

	let days = parseInt(req.query && req.query.days, 10);
	if (!Number.isFinite(days)) days = DEFAULT_DAYS;
	days = Math.min(MAX_DAYS, Math.max(MIN_DAYS, days));
	const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
		.toISOString()
		.slice(0, 10);

	let blobs;
	try {
		blobs = await listAll('downloads/');
	} catch (err) {
		res.statusCode = 502;
		res.setHeader('Content-Type', 'text/plain; charset=utf-8');
		res.end('could not list the download store\n');
		return;
	}

	const parsed = [];
	for (const blob of blobs) {
		const fields = parsePathname(blob.pathname);
		if (!fields) continue;
		if (fields.date < cutoffDate) continue;
		parsed.push({ ...fields, blob });
	}

	let total = 0;
	let humans = 0;
	let bots = 0;
	const byDayMap = {};
	const byArch = {};
	const byVersion = {};
	const byCountry = {};
	const byBrowser = {};
	const byOs = {};

	for (const row of parsed) {
		total += 1;
		if (isHuman(row.browser)) {
			humans += 1;
		} else {
			bots += 1;
		}
		bump(byDayMap, row.date);
		bump(byArch, row.arch);
		bump(byVersion, row.version);
		bump(byCountry, row.country);
		bump(byBrowser, row.browser);
		bump(byOs, row.os);
	}

	const byDay = Object.keys(byDayMap)
		.sort()
		.map((date) => ({ date, count: byDayMap[date] }));

	const newest = [...parsed]
		.sort((a, b) => b.blob.uploadedAt - a.blob.uploadedAt)
		.slice(0, LAST_N);

	const last = [];
	for (const row of newest) {
		const body = await readEventBody(row.blob.pathname);
		const ts = (body && body.ts) || (row.tsMs != null ? new Date(row.tsMs).toISOString() : null);
		last.push({
			date: row.date,
			ts,
			arch: row.arch,
			version: row.version,
			country: (body && body.country) || row.country,
			city: body ? body.city : null,
			browser: row.browser,
			os: row.os,
			referrer: body ? body.referrer : null,
		});
	}
	last.sort((a, b) => {
		const at = a.ts ? Date.parse(a.ts) : 0;
		const bt = b.ts ? Date.parse(b.ts) : 0;
		return bt - at;
	});

	res.statusCode = 200;
	res.setHeader('Content-Type', 'application/json; charset=utf-8');
	res.setHeader('Cache-Control', 'private, no-store');
	res.end(
		JSON.stringify({
			total,
			humans,
			bots,
			byDay,
			byArch,
			byVersion,
			byCountry,
			byBrowser,
			byOs,
			last,
		})
	);
}
