// ZA-902 / esfoobar/zeroagent#1265, "No other paid-state writer". A static
// check over the function and library sources: the only code that sets
// plan, planUntil, billing, entitlementSource or legacyGrant on an account
// is the fenced commit (api/_lib/billing-commit.js). The sign-in upsert may
// create a free account once (users-store.js, $setOnInsert) and nothing
// else may touch the fields.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function sources(dir) {
	const out = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) out.push(...sources(path));
		else if (/\.(js|mjs)$/.test(name)) out.push(path);
	}
	return out;
}

const PAID = ['plan', 'planUntil', 'billing', 'entitlementSource', 'legacyGrant'];
const files = [...sources('api'), ...sources('scripts')];

// Every update-operator block in a file: `$set: { ... }` and friends, up to
// the matching brace, with a dotted-path key (`'billing.status'`) counted.
function operatorBlocks(text) {
	const blocks = [];
	const re = /\$(set|setOnInsert|unset|inc|push|pull|addToSet|rename|mul|min|max)\s*:\s*\{/g;
	let m;
	while ((m = re.exec(text))) {
		let depth = 1;
		let i = re.lastIndex;
		while (i < text.length && depth > 0) {
			if (text[i] === '{') depth++;
			else if (text[i] === '}') depth--;
			i++;
		}
		blocks.push({ op: m[1], body: text.slice(re.lastIndex, i - 1) });
	}
	return blocks;
}

function touchesPaid(body) {
	return PAID.some((f) => new RegExp(`(^|[\\s,{'"])${f}(\\.[A-Za-z]+)?['"]?\\s*[:,}]|(^|[\\s,{])${f}\\s*$`, 'm').test(body));
}

test('only billing-commit.js writes paid state on an account', () => {
	const offenders = [];
	for (const file of files) {
		if (file.endsWith('api/_lib/billing-commit.js') || file.endsWith('api/_lib/users-store.js')) continue;
		for (const block of operatorBlocks(readFileSync(file, 'utf8'))) {
			if (touchesPaid(block.body)) offenders.push(`${file}: $${block.op}`);
		}
	}
	assert.deepEqual(offenders, []);
});

test('the fenced commit is the one place that sets them', () => {
	const text = readFileSync('api/_lib/billing-commit.js', 'utf8');
	const sets = operatorBlocks(text).filter((b) => b.op === 'set' && touchesPaid(b.body));
	assert.equal(sets.length, 1);
	assert.match(sets[0].body, /billing,\s*plan: fields\.plan,\s*planUntil: fields\.planUntil,\s*entitlementSource: 'stripe'/);
});

test('the sign-in upsert creates a free account once and never rewrites a paid field', () => {
	const text = readFileSync('api/_lib/users-store.js', 'utf8');
	for (const block of operatorBlocks(text)) {
		if (block.op === 'setOnInsert') continue;
		assert.ok(!touchesPaid(block.body), `$${block.op} touches a paid field`);
	}
	const insert = operatorBlocks(text).find((b) => b.op === 'setOnInsert');
	assert.match(insert.body, /plan: 'free'/);
	assert.match(insert.body, /planUntil: null/);
	assert.ok(!/billing|entitlementSource|legacyGrant/.test(insert.body));
});

test('the webhook modules never write the users collection themselves', () => {
	for (const file of ['api/_lib/billing-webhook.js', 'api/_lib/billing-reconcile.js', 'api/stripe-webhook.js']) {
		const text = readFileSync(file, 'utf8');
		assert.ok(!/users\.(updateOne|findOneAndUpdate|insertOne|replaceOne|bulkWrite|deleteOne|updateMany)/.test(text), file);
		assert.equal(operatorBlocks(text).length, 0, file);
	}
	assert.match(readFileSync('api/_lib/billing-webhook.js', 'utf8'), /commitProjection\(/);
});

test('no read path writes: /me and the entitlement modules import no store writer', () => {
	for (const file of ['api/app/me.js', 'api/_lib/billing-projection.js', 'api/_lib/entitlement.js']) {
		const text = readFileSync(file, 'utf8');
		assert.ok(!/commitProjection|updateOne|findOneAndUpdate|insertOne/.test(text), file);
	}
});

test('operations audit and sandbox proof cannot write paid state or call the commit', () => {
	for (const file of ['api/_lib/billing-operations.js', 'api/_lib/billing-sandbox.js', 'api/_lib/billing-replay.js', 'scripts/billing-audit.mjs', 'scripts/billing-sandbox-proof.mjs', 'scripts/billing-prepare-replay.mjs']) {
		const source = readFileSync(file, 'utf8');
		assert.ok(!/commitProjection|processWebhookEvent|users\.(updateOne|findOneAndUpdate|insertOne|replaceOne|bulkWrite|updateMany)/.test(source), file);
		if (file.endsWith('billing-replay.js')) {
			for (const block of operatorBlocks(source)) assert.ok(!touchesPaid(block.body), file);
		} else assert.equal(operatorBlocks(source).length, 0, file);
	}
});
