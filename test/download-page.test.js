import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const page = await readFile(new URL('../download/index.html', import.meta.url), 'utf8');

test('the Linux panel is the one-command installer and nothing else', () => {
	const panel = page.match(/<div id="za-linux-panel"[\s\S]*?\n\t\t\t<\/div>/);
	assert.ok(panel, 'the Linux panel is on the page');
	assert.match(panel[0], /Ubuntu 24\.04 or newer, 64-bit\. Requires <a href="https:\/\/claude\.com\/product\/claude-code">Claude Code<\/a>\./);
	assert.match(panel[0], /curl -fsSL https:\/\/zeroagenthq\.com\/install\.sh \| sh/);
	assert.match(panel[0], /Then open ZeroAgent from your app menu\. Run the same command to update\./);
	assert.match(panel[0], /Other Linux architectures are not available yet\./);
	assert.doesNotMatch(panel[0], /\| bash/);
	assert.doesNotMatch(panel[0], /gtk-launch/);
	assert.doesNotMatch(panel[0], /Node\.js/);
});

test('the page offers no installation method tabs and no deb or AppImage link', () => {
	assert.doesNotMatch(page, /za-method-tabs/);
	assert.doesNotMatch(page, /role="tab"/);
	assert.doesNotMatch(page, /<ol class="za-install-steps">/);
	assert.doesNotMatch(page, /href="\/download\/linux\/x64"/);
	assert.doesNotMatch(page, /href="\/download\/linux\/x64\/appimage"/);
});

test('the platform script carries no tab handling', async () => {
	const script = await readFile(new URL('../static/js/zeroagent-platform.js', import.meta.url), 'utf8');
	assert.doesNotMatch(script, /za-tab-/);
	assert.doesNotMatch(script, /za-method-/);
});