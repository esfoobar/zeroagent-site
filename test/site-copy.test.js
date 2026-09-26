import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

// Every page the site serves. A page that carries the nav carries the CTA, so
// the rule is checked against the whole tree rather than a hand-kept list.
async function htmlFiles(dir = root) {
	const found = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		if (entry.name === 'node_modules' || entry.name === '.zeroagent' || entry.name === '.git') continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...(await htmlFiles(full)));
		else if (entry.name.endsWith('.html')) found.push(full);
	}
	return found;
}

const pages = await htmlFiles();
const homepage = await readFile(join(root, 'index.html'), 'utf8');
const terms = await readFile(join(root, 'terms/index.html'), 'utf8');
const privacy = await readFile(join(root, 'privacy/index.html'), 'utf8');

test('no page ships a Download for Mac button', async () => {
	assert.ok(pages.length >= 6, `expected the served pages, found ${pages.length}`);
	for (const page of pages) {
		const html = await readFile(page, 'utf8');
		assert.doesNotMatch(html, /Download for Mac/, `${page} still labels a button Download for Mac`);
	}
});

test('the nav CTA on every page that has one reads exactly Download', async () => {
	for (const page of pages) {
		const html = await readFile(page, 'utf8');
		const ctas = html.match(/class="za-btn za-btn--primary za-btn--small za-nav-cta">([^<]*)</g) || [];
		for (const cta of ctas) assert.match(cta, />Download</, `${page} has a nav CTA that is not "Download"`);
	}
});

test('the homepage hero button reads exactly Download', () => {
	assert.match(homepage, /class="za-btn za-btn--primary za-btn--large">Download<\/a>/);
});

test('every homepage description ends Free for Mac and Linux', () => {
	const described = homepage.match(/Free for Mac\.(?! and Linux)/g) || [];
	assert.equal(described.length, 0, 'a homepage description still says "Free for Mac" alone');
	const linux = homepage.match(/Free for Mac and Linux\./g) || [];
	assert.equal(linux.length, 4, 'the meta, og, twitter and JSON-LD descriptions all carry the new line');
	assert.match(homepage, /"description": "[^"]*Free for Mac and Linux\."/);
});

test('the homepage hero carries the Windows caption under the Download button', () => {
	const row = homepage.match(/<div class="za-btn-row">[\s\S]*?<\/div>\s*\n\s*<p class="za-hero-req">([^<]*)<\/p>/);
	assert.ok(row, 'a hero meta line follows the button row');
	assert.equal(row[1], 'Mac and Linux beta. Windows coming soon.');
});

test('the legal pages cover macOS and Linux rather than macOS alone', () => {
	assert.doesNotMatch(terms, /a free macOS\s+desktop application/);
	assert.doesNotMatch(terms, /a free desktop application for macOS\./);
	assert.doesNotMatch(privacy, /a free macOS\s+desktop application/);
	assert.match(terms, /govern your use of ZeroAgent, a free desktop\s+application for macOS and Linux/);
	assert.match(terms, /ZeroAgent is a free desktop application for macOS and Linux \(Linux beta\)\./);
	assert.match(privacy, /publishes ZeroAgent, a free desktop\s+application for macOS and Linux;/);
});

test('the homepage OS requirement line and the download band no longer assume a Mac', () => {
	assert.doesNotMatch(homepage, /Workers run on your Mac/);
	assert.doesNotMatch(homepage, /already installed on your Mac/);
	assert.doesNotMatch(homepage, /Free for local work on your own Mac,/);
	assert.match(homepage, /Workers run on your computer and use your model providers\./);
});

test('the download page keeps its own Mac and Linux titles', async () => {
	const download = await readFile(join(root, 'download/index.html'), 'utf8');
	assert.match(download, /<title>Download ZeroAgent for Mac and Linux beta<\/title>/);
	assert.match(download, /id="za-select-mac"[^>]*>macOS</);
});
