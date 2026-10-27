import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	baseClass,
	classifyRows,
	referrerAccepted,
	buildPathname,
	parsePathname,
	sanitizeSegment,
} from '../api/_lib/download-class.js';
import { parseUserAgent } from '../api/_lib/ua.js';

const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const EDGE_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0';
const PAGE = 'https://zeroagenthq.com/download';
const T0 = Date.parse('2026-10-22T18:00:00Z');

function row(over = {}) {
	return { tsMs: T0, country: 'US', city: 'Denver', arch: 'x64', platform: 'windows', format: 'exe', base: 'human', ...over };
}
function classify(rows) {
	return classifyRows(rows);
}

test('a known browser coming from the download page is a human', () => {
	assert.equal(baseClass({ browser: parseUserAgent(EDGE_WIN).browser, referrer: PAGE }), 'human');
});

test('Safari on macOS with no referrer (the KR, BR, ID, JP, HK pattern) is not a human', () => {
	assert.equal(baseClass({ browser: parseUserAgent(SAFARI).browser, referrer: null }), 'noreferrer');
});

test('named crawlers, curl and unrecognized agents keep their own class', () => {
	assert.equal(baseClass({ browser: 'Applebot', referrer: PAGE }), 'bot');
	assert.equal(baseClass({ browser: 'GPTBot', referrer: null }), 'bot');
	assert.equal(baseClass({ browser: 'curl', referrer: null }), 'cli');
	assert.equal(baseClass({ browser: 'unknown', referrer: null }), 'unrecognized');
	assert.equal(baseClass({ browser: null, referrer: PAGE }), 'unrecognized');
});

test('a browser event whose referrer could not be read is unverified, never human', () => {
	assert.equal(baseClass({ browser: 'Chrome', referrer: undefined }), 'unverified');
});

test('referrer must be one of our own pages, over https, and not a download route', () => {
	assert.equal(referrerAccepted('https://zeroagenthq.com/download'), true);
	assert.equal(referrerAccepted('https://zeroagenthq.com/'), true);
	assert.equal(referrerAccepted('https://mvplean.com/zeroagent/download/'), true);
	assert.equal(referrerAccepted('https://www.google.com/'), false);
	assert.equal(referrerAccepted('https://zeroagenthq.com.evil.example/download'), false);
	assert.equal(referrerAccepted('http://zeroagenthq.com/download'), false);
	assert.equal(referrerAccepted('https://zeroagenthq.com/download/arm64'), false);
	assert.equal(referrerAccepted('https://api.zeroagenthq.com/download/x64'), false);
	assert.equal(referrerAccepted('not a url'), false);
	assert.equal(referrerAccepted(null), false);
});

test('one lone human event stays human', () => {
	assert.deepEqual(classify([row()]), ['human']);
});

test('the same-minute arm64 and x64 fetch from one city (Paris, New York) is a burst', () => {
	const rows = [
		row({ city: 'Paris', country: 'FR', arch: 'x64', platform: 'mac', format: 'dmg', tsMs: T0, base: 'human' }),
		row({ city: 'Paris', country: 'FR', arch: 'arm64', platform: 'mac', format: 'dmg', tsMs: T0 + 15000, base: 'human' }),
	];
	assert.deepEqual(classify(rows), ['burst', 'burst']);
});

test('three events from one city inside ten minutes are a burst even for the same build', () => {
	const rows = [0, 200000, 400000].map((d) => row({ tsMs: T0 + d }));
	assert.deepEqual(classify(rows), ['burst', 'burst', 'burst']);
});

test('two events from one city a day apart are two humans', () => {
	const rows = [row(), row({ tsMs: T0 + 24 * 3600 * 1000 })];
	assert.deepEqual(classify(rows), ['human', 'human']);
});

test('the Shanghai pair, a day and a half apart, stays human', () => {
	const rows = [
		row({ city: 'Shanghai', country: 'CN', tsMs: Date.parse('2026-10-24T01:37:01Z') }),
		row({ city: 'Shanghai', country: 'CN', tsMs: Date.parse('2026-10-25T11:05:32Z') }),
	];
	assert.deepEqual(classify(rows), ['human', 'human']);
});

test('a dense sweep across different cities (the 43 events in two seconds) is a burst', () => {
	const cities = ['Secaucus', 'Washington', 'Newark', 'Kenmore', 'Ashburn'];
	const rows = cities.map((city, i) => row({ city, tsMs: T0 + i * 400, base: 'human' }));
	assert.deepEqual(classify(rows), ['burst', 'burst', 'burst', 'burst', 'burst']);
});

test('a lone human is not swept into a burst elsewhere', () => {
	const sweep = ['A', 'B', 'C', 'D'].map((city, i) => row({ city, tsMs: T0 + i * 400 }));
	const lone = row({ city: 'Lima', country: 'PE', tsMs: T0 + 3 * 3600 * 1000 });
	const out = classify([...sweep, lone]);
	assert.equal(out[4], 'human');
});

test('bots keep their class inside a burst and burst never upgrades a non-human', () => {
	const rows = [
		row({ city: 'Atlanta', base: 'bot' }),
		row({ city: 'Atlanta', arch: 'arm64', base: 'bot', tsMs: T0 + 300 }),
		row({ city: 'Atlanta', base: 'noreferrer', tsMs: T0 + 600 }),
	];
	assert.deepEqual(classify(rows), ['bot', 'bot', 'burst']);
});

test('events with no city or an unreadable timestamp never form a place burst', () => {
	const rows = [
		row({ city: null, arch: 'x64', tsMs: T0 }),
		row({ city: null, arch: 'arm64', tsMs: T0 + 5000 }),
		row({ city: 'unknown', arch: 'x64', platform: 'mac', tsMs: null }),
	];
	assert.deepEqual(classify(rows), ['human', 'human', 'human']);
});

test('the new pathname round-trips and old layouts still parse', () => {
	const pathname = buildPathname({
		date: '2026-10-27',
		tsMs: T0,
		arch: 'x64',
		platform: 'windows',
		format: 'exe',
		version: '0.27.1',
		country: 'CN',
		browser: 'Edge',
		os: 'Windows',
		base: 'human',
		city: 'São Paulo',
	});
	assert.match(pathname, /^downloads\/2026-10-27\/\d+-x64-windows-exe-0\.27\.1-CN-Edge-Windows-human-SoPaulo\.json$/);
	const parsed = parsePathname(pathname.replace('.json', '-Ab12Cd.json'));
	assert.equal(parsed.layout, 'classed');
	assert.equal(parsed.base, 'human');
	assert.equal(parsed.city, 'SoPaulo');
	assert.equal(parsed.version, '0.27.1');
	assert.equal(parsed.browser, 'Edge');
	assert.equal(parsed.tsMs, T0);

	const modern = parsePathname('downloads/2026-09-25/1790370000000-x64-linux-appimage-0.17.0-US-Chrome-Linux-abc123.json');
	assert.equal(modern.layout, 'modern');
	assert.equal(modern.base, undefined);
	const legacy = parsePathname('downloads/2026-09-25/1790370000000-arm64-0.16.0-US-Safari-macOS-abc123.json');
	assert.equal(legacy.layout, 'legacy');
	assert.equal(legacy.platform, 'mac');
});

test('sanitizeSegment keeps dashes out of pathname segments', () => {
	assert.equal(sanitizeSegment('Frankfurt am Main'), 'Frankfurtam' + 'Main');
	assert.equal(sanitizeSegment('a-b'), 'ab');
	assert.equal(sanitizeSegment(null), 'unknown');
});
