/*
 * ZA-223 / esfoobar/zeroagent#364. The one place a counted download is
 * judged. api/download.js calls it when an event is recorded (the pathname,
 * the Blob body and the GA4 hit all carry the verdict) and
 * api/download-stats.js calls it again when the numbers are read, so the two
 * can never disagree about what a "human" is. Pure functions, no I/O.
 *
 * Every event is recorded; this only labels it. The classes, most specific
 * cause first:
 *
 *   bot           a named crawler or link scanner (Applebot, GPTBot, ...)
 *   cli           curl or wget; real demand for the Linux installer, but not
 *                 a person on the download page, so not a "human"
 *   unrecognized  no User-Agent, or one that is not a known browser
 *   burst         a browser-looking event that is part of a sweep (below)
 *   noreferrer    a known browser but no referrer from this site's own pages
 *   unverified    a known browser on an old event whose body could not be read
 *   human         a known browser, arriving from our own download page, not
 *                 part of a burst
 *
 * A person clicking the button on zeroagenthq.com/download sends that page as
 * the referrer. Crawlers and link scanners that spoof a Safari or Edge UA
 * fetch the URL directly and send none, or fake the site's home page; the
 * second signal (burst) is what catches the faker.
 */

import { HUMAN_BROWSERS } from './ua.js';

export const CLASSES = ['human', 'bot', 'cli', 'unrecognized', 'burst', 'noreferrer', 'unverified'];

// Pages on our own hosts that carry the download buttons. mvplean.com is
// where the buttons lived before 2026-09-10, so a link still sitting on a
// page there is a normal source for older events.
export const REFERRER_HOSTS = [
	'zeroagenthq.com',
	'www.zeroagenthq.com',
	'api.zeroagenthq.com',
	'mvplean.com',
	'www.mvplean.com',
	'zeroagent-site.vercel.app',
];

// A referrer that is itself a counted download route means the request
// followed our own redirect (a scanner chasing the link), not a button click.
const DOWNLOAD_ROUTE = /^\/(?:zeroagent\/)?download\/(?:mac|linux|windows|arm64|x64)/i;

// A burst is a sweep, not a person.
//  - dense: this many events from anywhere inside the window, because the
//    2026-09-08 scanner rotated user agents and cities but landed 43 events
//    in two seconds;
//  - same place: three events from one city inside ten minutes, or two
//    different builds from one city inside a minute (the New York and Paris
//    scripts fetched arm64 and x64 together).
export const BURST = {
	denseWindowMs: 30 * 1000,
	denseCount: 4,
	placeWindowMs: 10 * 60 * 1000,
	placeCount: 3,
	pairWindowMs: 60 * 1000,
};

export function sanitizeSegment(value) {
	const cleaned = String(value == null ? '' : value).replace(/[^A-Za-z0-9._]/g, '');
	return cleaned || 'unknown';
}

export function referrerAccepted(referrer) {
	if (!referrer) return false;
	let url;
	try {
		url = new URL(referrer);
	} catch {
		return false;
	}
	if (url.protocol !== 'https:') return false;
	if (!REFERRER_HOSTS.includes(url.hostname.toLowerCase())) return false;
	return !DOWNLOAD_ROUTE.test(url.pathname);
}

/*
 * The single-event verdict. browser is the parsed name (or the pathname's
 * sanitized one: 'unknown' and null both mean unrecognized). referrer is the
 * raw header: a string, null when absent, undefined when it could not be read.
 */
export function baseClass({ browser, referrer }) {
	if (browser === 'curl' || browser === 'wget') return 'cli';
	if (!browser || browser === 'unknown') return 'unrecognized';
	if (!HUMAN_BROWSERS.includes(browser)) return 'bot';
	if (referrer === undefined) return 'unverified';
	return referrerAccepted(referrer) ? 'human' : 'noreferrer';
}

function placeKey(row) {
	const city = row.city && row.city !== 'unknown' ? row.city : null;
	const country = row.country && row.country !== 'unknown' ? row.country : null;
	return city && country ? `${country}|${city}` : null;
}

function artifact(row) {
	return `${row.platform}|${row.arch}|${row.format}`;
}

/*
 * rows: [{ tsMs, country, city, arch, platform, format, base }]. Returns the
 * final class of each row, same order. Named bots, curl and unrecognized
 * agents keep their own class; only browser-looking rows can become 'burst'.
 */
export function classifyRows(rows) {
	const order = rows.map((_, i) => i).sort((a, b) => rows[a].tsMs - rows[b].tsMs);
	const inBurst = new Array(rows.length).fill(false);

	for (const i of order) {
		const row = rows[i];
		if (!Number.isFinite(row.tsMs)) continue;
		let dense = 0;
		let samePlace = 0;
		let pair = false;
		const key = placeKey(row);
		for (const j of order) {
			const other = rows[j];
			if (!Number.isFinite(other.tsMs)) continue;
			const dt = Math.abs(other.tsMs - row.tsMs);
			if (dt <= BURST.denseWindowMs) dense += 1;
			if (key && i !== j && placeKey(other) === key) {
				if (dt <= BURST.placeWindowMs) samePlace += 1;
				if (dt <= BURST.pairWindowMs && artifact(other) !== artifact(row)) pair = true;
			}
		}
		if (dense >= BURST.denseCount || samePlace + 1 >= BURST.placeCount || pair) inBurst[i] = true;
	}

	return rows.map((row, i) => {
		if (['bot', 'cli', 'unrecognized'].includes(row.base)) return row.base;
		return inBurst[i] ? 'burst' : row.base;
	});
}

/*
 * Pathname layout. Newest (ZA-223):
 *   downloads/<date>/<ts>-<arch>-<platform>-<format>-<version>-<country>-<browser>-<os>-<class>-<city>-<suffix>.json
 * Previous: the same without <class>-<city> (9 fields with the random suffix).
 * Oldest: Mac only, without platform and format (7 fields). Segments are
 * sanitized so a dash only ever separates fields, which is what lets a split
 * recover them. The class here is the single-event verdict; a burst is
 * decided from neighbours, never baked into a name.
 */
export function buildPathname({ date, tsMs, arch, platform, format, version, country, browser, os, base, city }) {
	return [
		'downloads',
		date,
		[
			tsMs,
			arch,
			platform,
			format,
			version,
			country,
			browser,
			os,
			base,
			city,
		].map((v, i) => (i === 0 ? v : sanitizeSegment(v))).join('-') + '.json',
	].join('/');
}

export function parsePathname(pathname) {
	const parts = pathname.split('/');
	if (parts.length !== 3 || parts[0] !== 'downloads') return null;
	const date = parts[1];
	const fields = parts[2].replace(/\.json$/, '').split('-');
	if (fields.length < 6) return null;
	const layout = fields.length >= 11 ? 'classed' : fields.length >= 9 ? 'modern' : 'legacy';
	const [epochMs, arch] = fields;
	const platform = layout === 'legacy' ? 'mac' : fields[2];
	const format = layout === 'legacy' ? 'dmg' : fields[3];
	const [version, country, browser, os] = fields.slice(layout === 'legacy' ? 2 : 4);
	const tsMs = Number(epochMs);
	const out = { date, arch, platform, format, version, country, browser, os, tsMs: Number.isFinite(tsMs) ? tsMs : null, layout };
	if (layout === 'classed') {
		const cls = fields[8];
		out.base = CLASSES.includes(cls) ? cls : null;
		out.city = fields[9];
	}
	return out;
}
