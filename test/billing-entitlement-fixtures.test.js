// ZA-901. Runs every case and every check of the shared entitlement
// fixtures through the site's projection and compares the exact expected
// fields. The fixtures file is a vendored copy, source commit named in its
// `_vendored` header.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BILLING_PARAMETERS } from '../api/_lib/billing-config.js';
import { answerFor, relayDecision, projectEntitlement, BILLING_STATUSES } from '../api/_lib/billing-projection.js';

const fixtures = JSON.parse(readFileSync(new URL('./billing-entitlement.fixtures.json', import.meta.url), 'utf8'));

const EXPECTED_FIELDS = ['plan', 'planUntil', 'relayAllowed', 'billingStatus', 'accessUntil', 'paymentGraceUntil', 'cancelAtPeriodEnd'];

test('fixtures header names the source commit', () => {
	assert.match(fixtures._vendored, /54cc57d/);
	assert.equal(fixtures.format, 1);
});

test('the parameters come from one configuration place and match the fixtures', () => {
	assert.equal(BILLING_PARAMETERS.paymentGraceSeconds, fixtures.parameters.paymentGraceSeconds.value);
	assert.equal(BILLING_PARAMETERS.renewalSettlementSeconds, fixtures.parameters.renewalSettlementSeconds.value);
});

for (const fixture of fixtures.cases) {
	for (const [i, check] of fixture.checks.entries()) {
		test(`${fixture.id} #${i + 1} at ${check.at}${check.device ? ` (${check.device})` : ''}`, () => {
			const answer = answerFor(fixture.account, new Date(check.at), { deviceId: check.device ?? null });
			assert.equal(answer.status, check.expect.meStatus);
			assert.equal(relayDecision(answer), check.expect.relay);
			if (check.expect.meStatus === 401) {
				assert.deepEqual(answer.body, { error: check.expect.error });
				return;
			}
			const got = Object.fromEntries(EXPECTED_FIELDS.map((f) => [f, answer.body[f]]));
			const want = Object.fromEntries(EXPECTED_FIELDS.map((f) => [f, check.expect[f]]));
			assert.deepEqual(got, want);
			assert.ok(BILLING_STATUSES.includes(answer.body.billingStatus));
			assert.equal(answer.body.checkedAt, check.at);
			assert.equal(typeof answer.body.entitlementVersion, 'number');
		});
	}
}

test('every fixture case is exercised and every check counted', () => {
	assert.equal(fixtures.cases.length, 19);
	assert.equal(fixtures.cases.reduce((n, c) => n + c.checks.length, 0), 36);
});

// The migrations block: a class of account answers identically before and
// after marking, except the one deliberate tightening for dated grants.
for (const m of fixtures.migrations) {
	test(`migration ${m.id}: same answer before and after`, () => {
		const resolve = (x) => (typeof x === 'string' ? fixtures.cases.find((c) => c.id === x).account : x);
		const before = resolve(m.before);
		const after = resolve(m.after);
		for (const field of m.mustEqual) assert.deepEqual(after[field], before[field], field);
		for (const at of m.sameAnswerAt) {
			const a = projectEntitlement(before, new Date(at));
			const b = projectEntitlement(after, new Date(at));
			assert.equal(b.relayAllowed, a.relayAllowed, at);
			assert.equal(b.billingStatus, a.billingStatus, at);
		}
		if (m.divergesAtOrAfter) {
			const at = new Date(m.divergesAtOrAfter);
			assert.equal(projectEntitlement(before, at).relayAllowed, true);
			assert.equal(projectEntitlement(after, at).relayAllowed, false);
		}
	});
}

test('transitions that are time only write nothing: the account is not mutated', () => {
	const account = structuredClone(fixtures.cases.find((c) => c.id === 'failed_renewal_in_grace').account);
	const before = JSON.stringify(account);
	projectEntitlement(account, new Date('2026-12-05T00:00:00.000Z'));
	assert.equal(JSON.stringify(account), before);
});
