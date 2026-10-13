import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('STRIPE_') && name !== 'MONGODB_URI' && name !== 'MONGODB_DB' && name !== 'BILLING_BASE_URL'));

for (const script of ['billing-audit.mjs', 'billing-prepare-replay.mjs', 'billing-sandbox-proof.mjs']) {
	test(`${script} exits with code 1 when billing environment is absent`, () => {
		const result = spawnSync(process.execPath, [`scripts/${script}`], { env, input: 'evt_sample\n', encoding: 'utf8', timeout: 2000 });
		assert.equal(result.error, undefined);
		assert.equal(result.status, 1);
		assert.equal(result.signal, null);
	});
}

test('sandbox proof rejects malformed arguments without a stack trace', () => {
	const result = spawnSync(process.execPath, ['scripts/billing-sandbox-proof.mjs', '--bad'], { env, encoding: 'utf8', timeout: 2000 });
	assert.equal(result.error, undefined);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /invalid_argument/);
	assert.ok(!result.stderr.includes('at file:'));
});

test('scheduled audit entry point ends 0 with one line when its secrets are unset', () => {
	const result = spawnSync(process.execPath, ['scripts/billing-audit-ci.mjs'], { env, encoding: 'utf8', timeout: 5000 });
	assert.equal(result.error, undefined);
	assert.equal(result.status, 0);
	assert.equal(result.stdout.trim().split('\n').length, 1);
	assert.match(result.stdout, /not configured/);
});

test('scheduled audit entry point runs the audit, which exits 1, when only some secrets are set', () => {
	const result = spawnSync(process.execPath, ['scripts/billing-audit-ci.mjs'], { env: { ...env, MONGODB_DB: 'x' }, encoding: 'utf8', timeout: 5000 });
	assert.equal(result.status, 1);
});

test('billing audit workflow runs only on schedule and dispatch', async () => {
	const text = (await import('node:fs')).readFileSync('.github/workflows/billing-audit.yml', 'utf8');
	assert.match(text, /^on:\n {2}schedule:\n.*\n {2}workflow_dispatch:\n/m);
	assert.ok(!/^ {2}(push|pull_request)/m.test(text));
	assert.match(text, /cancel-in-progress: true/);
});
