import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDownloadRoute, releaseVersion } from '../api/_lib/download-routes.js';
import config from '../vercel.json' with { type: 'json' };
import handler from '../api/download.js';

test('canonical routes and permanent macOS aliases resolve to stable names', () => {
	const rows = [
		[{}, 'arm64', undefined, 'mac', 'dmg', 'ZeroAgent-arm64.dmg'],
		[{}, 'x64', undefined, 'mac', 'dmg', 'ZeroAgent-x64.dmg'],
		[{ os: 'mac' }, 'arm64', undefined, 'mac', 'dmg', 'ZeroAgent-arm64.dmg'],
		[{ os: 'mac' }, 'x64', undefined, 'mac', 'dmg', 'ZeroAgent-x64.dmg'],
		[{ os: 'linux' }, 'x64', undefined, 'linux', 'deb', 'ZeroAgent-linux-x64.deb'],
		[{ os: 'linux' }, 'x64', 'deb', 'linux', 'deb', 'ZeroAgent-linux-x64.deb'],
		[{ os: 'linux' }, 'x64', 'appimage', 'linux', 'appimage', 'ZeroAgent-linux-x64.AppImage'],
	];
	for (const [input, arch, format, platform, expectedFormat, file] of rows) {
		assert.deepEqual(resolveDownloadRoute({ ...input, arch, format }), { platform, arch, format: expectedFormat, file });
	}
});

test('unsupported combinations have no redirect', () => {
	for (const route of [
		{ os: 'linux', arch: 'arm64' }, { os: 'mac', arch: 'x64', format: 'deb' },
		{ os: 'windows', arch: 'x64' }, { os: 'linux', arch: 'x64', format: 'rpm' },
	]) assert.equal(resolveDownloadRoute(route), null);
});

test('Linux stays unreleased until release.json names a version', () => {
	assert.equal(releaseVersion(null, 'linux'), null);
	assert.equal(releaseVersion({ mac: { version: '0.16.0' } }, 'linux'), null);
	assert.equal(releaseVersion({ linux: { version: '0.17.0' } }, 'linux'), '0.17.0');
});

test('Vercel rewrites preserve legacy and canonical route parameters', () => {
	assert.deepEqual(config.rewrites.slice(0, 3).map(({ source, destination }) => [source, destination]), [
		['/download/:arch(arm64|x64)', '/api/download?arch=:arch'],
		['/download/:os/:arch/:format', '/api/download?os=:os&arch=:arch&format=:format'],
		['/download/:os/:arch', '/api/download?os=:os&arch=:arch'],
	]);
});

function response() {
	return { headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(body) { this.body = body; } };
}

test('Linux returns 404 before publication; macOS aliases still redirect', async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (url) => {
		if (String(url).endsWith('release.json')) return { ok: false, status: 403 };
		return { ok: true, text: async () => 'version: 0.16.0\n' };
	};
	try {
		const linux = response();
		await handler({ method: 'HEAD', query: { os: 'linux', arch: 'x64' }, headers: {} }, linux);
		assert.equal(linux.statusCode, 404);
		assert.equal(linux.body, 'not found: not released yet\n');
		const mac = response();
		await handler({ method: 'HEAD', query: { arch: 'arm64' }, headers: {} }, mac);
		assert.equal(mac.statusCode, 302);
		assert.equal(mac.headers.Location, 'https://releases.zeroagenthq.com/latest/ZeroAgent-arm64.dmg');
	} finally { globalThis.fetch = originalFetch; }
});

test('Linux requires the stable object even when the manifest has a version', async () => {
	const originalFetch = globalThis.fetch;
	let objectExists = false;
	globalThis.fetch = async (url, options) => {
		if (String(url).endsWith('release.json')) return { ok: true, json: async () => ({ linux: { version: '0.17.0' } }) };
		if (options && options.method === 'HEAD') return { ok: objectExists };
		throw new Error('unexpected request');
	};
	try {
		const missing = response();
		await handler({ method: 'HEAD', query: { os: 'linux', arch: 'x64', format: 'appimage' }, headers: {} }, missing);
		assert.equal(missing.statusCode, 404);
		objectExists = true;
		const published = response();
		await handler({ method: 'HEAD', query: { os: 'linux', arch: 'x64', format: 'appimage' }, headers: {} }, published);
		assert.equal(published.statusCode, 302);
		assert.equal(published.headers.Location, 'https://releases.zeroagenthq.com/latest/ZeroAgent-linux-x64.AppImage');
	} finally { globalThis.fetch = originalFetch; }
});
