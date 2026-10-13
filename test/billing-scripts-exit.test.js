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
