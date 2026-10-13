import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareEventReplay } from '../api/_lib/billing-replay.js';
import { billingReference } from '../api/_lib/billing-reference.js';
import { claimEventWithCollection } from '../api/_lib/billing-inbox.js';
import { fakeBillingDb } from './_fake-mongo.js';

const environment = { stripeAccountId: 'acct_test', livemode: false, environment: 'sandbox' };
const referenceKey = 'whsec_fake_test';
const receivedAt = '2026-10-01T00:00:00.000Z';
const preparedAt = new Date('2026-10-13T12:00:00.000Z');
const key = 'acct_test:test:evt_sample';
function fixture(state = 'quarantined') {
	const store = fakeBillingDb(['events', 'audit']);
	store.collections.events.docs.set(key, { _id: key, stripeAccountId: 'acct_test', livemode: false, eventId: 'evt_sample', state, attempts: 8, lastError: 'attempts_exhausted', receivedAt });
	return store;
}
const args = (eventId) => ({ environment, eventId, referenceKey, actor: 'operator', reason: 'cause fixed', now: preparedAt });

test('replay preparation preserves original receipt, records audit, then real inbox claim succeeds', async () => {
	const store = fixture();
	const result = await prepareEventReplay(store, args('evt_sample'));
	const entry = store.collections.events.docs.get(key);
	assert.equal(result.status, 'awaiting_verified_redelivery');
	assert.equal(entry.receivedAt, receivedAt);
	assert.equal(entry.replayPreparedAt, preparedAt.toISOString());
	assert.equal(entry.state, 'received');
	assert.equal(entry.attempts, 0);
	assert.equal(store.collections.audit.docs.size, 1);
	assert.ok(!JSON.stringify(result).includes('evt_sample'));
	const claim = await claimEventWithCollection(store.collections.events, { key, owner: 'worker', now: new Date(preparedAt.getTime() + 1000) });
	assert.equal(claim.status, 'claimed');
	assert.equal(claim.entry.attempts, 1);
});

test('short reference resolves only a unique failed or quarantined event in this environment', async () => {
	const ref = billingReference('evt_sample', referenceKey);
	const store = fixture('failed');
	assert.equal((await prepareEventReplay(store, args(ref))).eventRef, ref);
	await assert.rejects(() => prepareEventReplay(fixture(), args('000000000000')), /event_reference_not_found/);
	const ambiguous = fixture();
	ambiguous.collections.events.docs.set('other_key', { ...ambiguous.collections.events.docs.get(key), _id: 'other_key' });
	await assert.rejects(() => prepareEventReplay(ambiguous, args(ref)), /ambiguous_event_reference/);
	const otherEnvironment = fixture();
	otherEnvironment.collections.events.docs.get(key).stripeAccountId = 'other_account';
	await assert.rejects(() => prepareEventReplay(otherEnvironment, args(ref)), /event_reference_not_found/);
});

test('completed events and missing accountability cannot be reset', async () => {
	await assert.rejects(() => prepareEventReplay(fixture('completed'), args('evt_sample')), /event_not_replayable/);
	await assert.rejects(() => prepareEventReplay(fixture(), { ...args('evt_sample'), actor: '' }), /actor_required/);
});
