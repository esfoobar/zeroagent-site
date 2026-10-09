import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

for (const file of ['index.html', 'download/index.html']) {
	test(`${file} breadcrumb structured data stays on zeroagenthq.com`, () => {
		const html = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
		const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
		const crumbs = blocks.find((b) => b['@type'] === 'BreadcrumbList');
		assert.ok(crumbs, 'has a BreadcrumbList');
		for (const item of crumbs.itemListElement) {
			assert.match(item.item, /^https:\/\/zeroagenthq\.com\//);
		}
	});
}
