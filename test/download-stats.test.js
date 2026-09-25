import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePathname } from '../api/download-stats.js';

test('download stats reads Linux platform and format from stored pathnames', () => {
	const row = parsePathname('downloads/2026-09-25/1790370000000-x64-linux-appimage-0.17.0-US-Chrome-Linux-abc123.json');
	assert.equal(row.platform, 'linux');
	assert.equal(row.format, 'appimage');
	assert.equal(row.arch, 'x64');
});

test('download stats keeps older Mac download events in both breakdowns', () => {
	const row = parsePathname('downloads/2026-09-25/1790370000000-arm64-0.16.0-US-Safari-macOS-abc123.json');
	assert.equal(row.platform, 'mac');
	assert.equal(row.format, 'dmg');
});
