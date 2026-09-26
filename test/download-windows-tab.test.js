import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const page = await readFile(new URL('../download/index.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../static/js/zeroagent-platform.js', import.meta.url), 'utf8');

const windowsPanel = page.match(/<div id="za-windows-panel"[\s\S]*?<\/div>/);
const selector = page.match(/<div class="za-os-selector"[\s\S]*?<\/div>/);

test('the selector offers Windows beside macOS and Linux beta', () => {
	assert.ok(selector, 'the OS selector is on the page');
	assert.match(selector[0], /<button type="button" id="za-select-mac" aria-pressed="true">macOS<\/button>/);
	assert.match(selector[0], /<button type="button" id="za-select-linux" aria-pressed="false" hidden>Linux beta<\/button>/);
	assert.match(selector[0], /<button type="button" id="za-select-windows" aria-pressed="false">Windows<\/button>/);
});

test('the Windows button is always visible, not gated on the release manifest', () => {
	const button = selector[0].match(/<button[^>]*id="za-select-windows"[^>]*>/);
	assert.ok(button, 'the Windows button exists');
	assert.doesNotMatch(button[0], /hidden/, 'the Windows button carries no hidden attribute');
	// The only un-hiding in the script belongs to Linux.
	const unhides = script.match(/\.hidden = false;/g) || [];
	assert.equal(unhides.length, 1);
	assert.match(script, /getElementById\('za-select-linux'\)\.hidden = false;/);
});

test('the Windows panel offers nothing to download', () => {
	assert.ok(windowsPanel, 'the Windows panel is on the page');
	assert.match(windowsPanel[0], /<p class="za-center za-empty">Windows version coming soon\.<\/p>/);
	assert.doesNotMatch(windowsPanel[0], /<a\s/, 'no link');
	assert.doesNotMatch(windowsPanel[0], /<button/, 'no button');
	assert.doesNotMatch(windowsPanel[0], /<form|<input/, 'no sign-up form');
});

test('the Windows tab has its own intro with no version and no notarized claim', () => {
	const intro = page.match(/<span id="za-windows-intro"[^>]*>([^<]*)<\/span>/);
	assert.ok(intro, 'the Windows intro span is on the page');
	assert.equal(intro[1], 'Free and yours to keep.');
	assert.doesNotMatch(intro[1], /notarized/);
	assert.doesNotMatch(windowsPanel[0], /notarized/);
	assert.match(page, /<p class="za-version-line" id="za-version-line">/);
});

test('the Mac homebrew and prerequisite sections stay macOS only', () => {
	assert.match(script, /getElementById\('za-mac-homebrew'\)\.hidden = os !== 'mac';/);
	assert.match(script, /getElementById\('za-mac-prerequisite'\)\.hidden = os !== 'mac';/);
	assert.match(page, /<section id="za-mac-prerequisite"/);
	assert.match(page, /<section id="za-mac-homebrew"/);
});

// A tiny DOM so the real selector script can be exercised rather than
// string-matched. fetch is stubbed: no manifest unless a test wants one.
const IDS = [
	'za-select-mac', 'za-select-linux', 'za-select-windows',
	'za-mac-panel', 'za-linux-panel', 'za-windows-panel',
	'za-mac-intro', 'za-linux-intro', 'za-windows-intro',
	'za-mac-homebrew', 'za-mac-prerequisite', 'za-version-line', 'za-release-detail',
	'za-agree', 'za-version',
];

function makeEl(id) {
	return {
		id,
		hidden: false,
		textContent: '',
		attrs: {},
		listeners: {},
		setAttribute(name, value) { this.attrs[name] = value; },
		getAttribute(name) { return this.attrs[name]; },
		addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
		click() { for (const fn of this.listeners.click || []) fn(); },
	};
}

function boot({ userAgent = '', manifest = null } = {}) {
	const elements = new Map(IDS.map((id) => [id, makeEl(id)]));
	// The hidden and aria-pressed state the markup ships with.
	for (const id of ['za-linux-panel', 'za-windows-panel', 'za-linux-intro', 'za-windows-intro', 'za-select-linux']) {
		elements.get(id).hidden = true;
	}
	for (const [, id, pressed] of page.matchAll(/<button[^>]*id="(za-select-\w+)"[^>]*aria-pressed="(\w+)"/g)) {
		elements.get(id).setAttribute('aria-pressed', pressed);
	}
	const ready = [];
	const context = {
		document: {
			getElementById: (id) => elements.get(id) || null,
			addEventListener: (type, fn) => { if (type === 'DOMContentLoaded') ready.push(fn); },
		},
		navigator: { userAgent },
		fetch: manifest
			? (url) => String(url).endsWith('release.json')
				? Promise.resolve({ ok: true, json: () => Promise.resolve(manifest) })
				: Promise.resolve({ ok: true })
			: () => new Promise(() => {}),
	};
	context.window = context;
	vm.createContext(context);
	vm.runInContext(script, context);
	for (const fn of ready) fn();
	return { elements, flush: () => new Promise((resolve) => setImmediate(resolve)) };
}

function shown(elements) {
	return IDS.filter((id) => id.endsWith('-panel')).filter((id) => !elements.get(id).hidden);
}

test('macOS is the default tab and the Windows panel starts hidden', () => {
	const { elements } = boot();
	assert.deepEqual(shown(elements), ['za-mac-panel']);
	assert.equal(elements.get('za-select-mac').getAttribute('aria-pressed'), 'true');
	assert.equal(elements.get('za-select-windows').getAttribute('aria-pressed'), 'false');
});

test('a Windows user agent opens the Windows tab by default', () => {
	const { elements } = boot({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' });
	assert.deepEqual(shown(elements), ['za-windows-panel']);
	assert.equal(elements.get('za-select-windows').getAttribute('aria-pressed'), 'true');
	assert.equal(elements.get('za-select-mac').getAttribute('aria-pressed'), 'false');
	assert.equal(elements.get('za-mac-homebrew').hidden, true, 'the homebrew section stays macOS only');
	assert.equal(elements.get('za-mac-prerequisite').hidden, true);
});

test('the Windows tab shows no version number and no agree line', () => {
	const { elements } = boot({ userAgent: 'Windows NT 10.0' });
	assert.equal(elements.get('za-version-line').hidden, true);
	assert.equal(elements.get('za-agree').hidden, true);
	assert.equal(elements.get('za-windows-intro').hidden, false);
	assert.equal(elements.get('za-mac-intro').hidden, true);
	assert.equal(elements.get('za-version').textContent, '', 'no version text is written');
});

test('clicking Windows and back to macOS restores the macOS chrome', () => {
	const { elements } = boot();
	elements.get('za-select-windows').click();
	assert.deepEqual(shown(elements), ['za-windows-panel']);
	assert.equal(elements.get('za-version-line').hidden, true);
	assert.equal(elements.get('za-select-windows').getAttribute('aria-pressed'), 'true');

	elements.get('za-select-mac').click();
	assert.deepEqual(shown(elements), ['za-mac-panel']);
	assert.equal(elements.get('za-version-line').hidden, false);
	assert.equal(elements.get('za-agree').hidden, false);
	assert.equal(elements.get('za-mac-homebrew').hidden, false);
	assert.equal(elements.get('za-mac-prerequisite').hidden, false);
});

test('clicking macOS after the Windows default labels the tab with the version', async () => {
	const { elements, flush } = boot({
		userAgent: 'Windows NT 10.0',
		manifest: { mac: { version: '0.16.0' }, linux: { version: '0.16.0' } },
	});
	await flush();
	await flush();
	elements.get('za-select-mac').click();
	assert.equal(elements.get('za-version-line').hidden, false);
	assert.equal(elements.get('za-agree').hidden, false);
	assert.equal(elements.get('za-version').textContent, 'v0.16.0');
});

test('a Linux user agent still auto-selects the Linux tab once the build is confirmed', async () => {
	const { elements, flush } = boot({
		userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
		manifest: { mac: { version: '0.16.0' }, linux: { version: '0.16.0' } },
	});
	await flush();
	await flush();
	assert.equal(elements.get('za-select-linux').hidden, false, 'the Linux button appears');
	assert.deepEqual(shown(elements), ['za-linux-panel']);
	assert.equal(elements.get('za-windows-panel').hidden, true);
	assert.match(elements.get('za-version').textContent, /beta$/);
});
