/*
 * ZA-165 / esfoobar/zeroagent#287. Reads the download events api/download.js
 * writes to Vercel Blob and answers one JSON summary: totals, a humans
 * versus bots split, and breakdowns by day, arch, version, country, browser
 * and OS. Those come from list()'s pathnames alone (the pathname layout was
 * chosen for exactly this), except the 25 newest events in "last", which
 * need their bodies for city and referrer.
 *
 * ZA-223: "humans" is the strict count from api/_lib/download-class.js (a
 * known browser, arriving from our own download page, not part of a burst);
 * "browserUa" keeps the old loose number. Events written before ZA-223 have no
 * referrer in their pathname, so the bodies of the browser-looking ones are
 * read once to judge them the same way. Each pathname's
 * own leading epoch-ms segment gives every event a timestamp too, so "last"
 * carries an ISO "ts" (the body's own when the body fetch succeeds, else
 * derived from that epoch ms) and is sorted newest first by it.
 *
 * Token-gated: this is download telemetry, not something to leave open.
 */

import { timingSafeEqual } from 'node:crypto';
import { list, get } from '@vercel/blob';
import { HUMAN_BROWSERS } from './_lib/ua.js';
import { CLASSES, baseClass, classifyRows, parsePathname as parseEventPathname, sanitizeSegment } from './_lib/download-class.js';

const DEFAULT_DAYS = 90;
const MIN_DAYS = 1;
const MAX_DAYS = 3650;
const LAST_N = 25;
const BODY_CONCURRENCY = 8;

// Old events (before ZA-223) carry no referrer or city in their pathname. Their
// bodies never change, so a warm instance keeps what it read.
const legacyBodies = new Map();

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

export const parsePathname = parseEventPathname;

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
	if (legacyBodies.has(pathname)) return legacyBodies.get(pathname);
	try {
		const result = await get(pathname, { access: 'private' });
		if (!result || result.statusCode !== 200) return null;
		const text = await new Response(result.stream).text();
		const body = JSON.parse(text);
		legacyBodies.set(pathname, body);
		return body;
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

	// Judge every event once, with the same rule the redirect uses. A new-layout
	// pathname already carries its single-event verdict and city. An old one
	// needs its body for the referrer and city, but only when its browser looks
	// human: a named bot, curl or an unrecognized agent is settled by name.
	const needsBody = parsed.filter((r) => r.layout !== 'classed' && HUMAN_BROWSERS.includes(r.browser));
	const bodies = new Map();
	for (let i = 0; i < needsBody.length; i += BODY_CONCURRENCY) {
		await Promise.all(
			needsBody.slice(i, i + BODY_CONCURRENCY).map(async (r) => {
				bodies.set(r.blob.pathname, await readEventBody(r.blob.pathname));
			})
		);
	}
	for (const row of parsed) {
		if (row.layout === 'classed') {
			row.base = row.base || 'unverified';
			continue;
		}
		const body = bodies.get(row.blob.pathname);
		row.city = body && body.city ? sanitizeSegment(body.city) : null;
		row.base = baseClass({ browser: row.browser, referrer: HUMAN_BROWSERS.includes(row.browser) ? (body ? body.referrer || null : undefined) : null });
	}
	const verdicts = classifyRows(parsed);
	parsed.forEach((row, i) => { row.cls = verdicts[i]; });

	let total = 0;
	let humans = 0;
	let browserUa = 0;
	const byClass = Object.fromEntries(CLASSES.map((c) => [c, 0]));
	const byDayMap = {};
	const humansByDayMap = {};
	const byArch = {};
	const byPlatform = {};
	const byFormat = {};
	const byVersion = {};
	const byCountry = {};
	const byBrowser = {};
	const byOs = {};

	for (const row of parsed) {
		total += 1;
		byClass[row.cls] += 1;
		if (isHuman(row.browser)) browserUa += 1;
		if (row.cls === 'human') {
			humans += 1;
			bump(humansByDayMap, row.date);
		}
		bump(byDayMap, row.date);
		bump(byArch, row.arch);
		bump(byPlatform, row.platform);
		bump(byFormat, row.format);
		bump(byVersion, row.version);
		bump(byCountry, row.country);
		bump(byBrowser, row.browser);
		bump(byOs, row.os);
	}
	const bots = total - humans;

	const byDay = Object.keys(byDayMap)
		.sort()
		.map((date) => ({ date, count: byDayMap[date] }));

	const humansByDay = Object.keys(humansByDayMap)
		.sort()
		.map((date) => ({ date, count: humansByDayMap[date] }));

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
			platform: row.platform,
			format: row.format,
			version: row.version,
			country: (body && body.country) || row.country,
			city: body ? body.city : null,
			browser: row.browser,
			os: row.os,
			referrer: body ? body.referrer : null,
			class: row.cls,
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
			browserUa,
			byClass,
			byDay,
			humansByDay,
			byArch,
			byPlatform,
			byFormat,
			byVersion,
			byCountry,
			byBrowser,
			byOs,
			last,
		})
	);
}
