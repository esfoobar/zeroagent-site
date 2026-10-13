// ZA-900. The single function behind the browser-account URLs, the rewrites
// that reach it, and the function count the Hobby plan allows.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import handler, { ROUTES } from '../api/web.js';

const HOBBY_FUNCTION_LIMIT = 12;

function fakeRes() {
	return {
		statusCode: null,
		headers: {},
		body: null,
		setHeader(name, value) {
			this.headers[name] = value;
		},
		end(chunk) {
			this.body = chunk;
		},
	};
}

function functionFiles(dir) {
	const out = [];
	for (const name of readdirSync(dir)) {
		if (name.startsWith('_')) continue;
		const path = join(dir, name);
		if (statSync(path).isDirectory()) out.push(...functionFiles(path));
		else if (name.endsWith('.js')) out.push(path);
	}
	return out;
}

test('unknown or missing route is a 404, including prototype names', async () => {
	for (const query of [{}, { __route: 'nope' }, { __route: 'constructor' }, { __route: '__proto__' }]) {
		const res = fakeRes();
		await handler({ method: 'GET', headers: {}, url: '/api/web', query }, res);
		assert.equal(res.statusCode, 404);
	}
});

test('a known route reaches its handler', async () => {
	const res = fakeRes();
	await handler({ method: 'POST', headers: {}, url: '/api/web', query: { __route: 'account/session' } }, res);
	assert.equal(res.statusCode, 405);
});

test('vercel.json rewrites every public URL to a route in the table', () => {
	const { rewrites } = JSON.parse(readFileSync('vercel.json', 'utf8'));
	const web = rewrites.filter((r) => r.destination.startsWith('/api/web?__route='));
	const publicUrls = web.map((r) => r.source).sort();
	assert.deepEqual(publicUrls, [
		'/api/account/session',
		'/api/auth/github/callback',
		'/api/auth/github/start',
		'/api/auth/logout',
		'/api/billing/catalog',
		'/api/billing/checkout',
		'/api/billing/portal',
		'/api/billing/status',
	]);
	for (const r of web) {
		const route = r.destination.split('=')[1];
		assert.equal(r.source, `/api/${route}`);
		assert.ok(Object.hasOwn(ROUTES, route));
	}
});

test('function count stays within the Hobby plan limit', () => {
	const files = functionFiles('api');
	assert.ok(files.length <= HOBBY_FUNCTION_LIMIT, `${files.length} functions: ${files.join(', ')}`);
});
