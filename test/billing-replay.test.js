import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareEventReplay } from '../api/_lib/billing-replay.js';

const environment = { stripeAccountId: 'acct_test', livemode: false, environment: 'sandbox' };
function fixture(state = 'quarantined') {
	const event = { _id: 'acct_test:test:evt_sample', state, attempts: 8, lastError: 'attempts_exhausted' };
	const audit = [];
	const collections = {
		events: { findOne: async () => event, updateOne: async (filter, update) => {
			if (filter.state !== event.state || filter.attempts !== event.attempts) return { modifiedCount: 0 };
			Object.assign(event, update.$set);
			return { modifiedCount: 1 };
		} },
		audit: { insertOne: async (record) => { audit.push(record); } },
		users: { updateOne: () => { throw Error('paid state write'); } },
	};
	return { collections, withTransaction: async (fn) => fn({}), event, audit };
}

test('replay preparation resets only inbox retry state and records redacted audit', async () => {
	const store = fixture();
	const result = await prepareEventReplay(store, { environment, eventId: 'evt_sample', actor: 'operator', reason: 'cause fixed' });
	assert.equal(result.status, 'awaiting_verified_redelivery');
	assert.equal(store.event.state, 'received');
	assert.equal(store.event.attempts, 0);
	assert.equal(store.audit.length, 1);
	assert.equal(store.audit[0].kind, 'event_replay_prepared');
	assert.ok(!JSON.stringify(result).includes('evt_sample'));
});

test('completed events and missing accountability cannot be reset', async () => {
	await assert.rejects(() => prepareEventReplay(fixture('completed'), { environment, eventId: 'evt_sample', actor: 'operator', reason: 'cause fixed' }), /event_not_replayable/);
	await assert.rejects(() => prepareEventReplay(fixture(), { environment, eventId: 'evt_sample', actor: '', reason: 'cause fixed' }), /actor_required/);
});
