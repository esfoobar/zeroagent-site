// ZA-900 / esfoobar/zeroagent#1263. Store semantics against an in-memory
// collection: single-use state, expiry, revocation, hash-only keys.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeCollection } from './_fake-collection.js';
import {
	consumeAuthStateWithCollection,
	createAuthStateWithCollection,
	createSessionWithCollection,
	getActiveSessionWithCollection,
	revokeSessionWithCollection,
} from '../api/_lib/web-session-store.js';

const NOW = new Date('2026-10-13T12:00:00Z');
const later = (seconds) => new Date(NOW.getTime() + seconds * 1000);

test('auth state is consumed once, and only before expiry', async () => {
	const states = fakeCollection();
	await createAuthStateWithCollection(states, {
		stateHash: 'h1',
		codeVerifier: 'verifier',
		returnPath: '/billing',
		now: NOW,
		expiresAt: later(600),
	});
	const first = await consumeAuthStateWithCollection(states, { stateHash: 'h1', now: later(5) });
	assert.equal(first.codeVerifier, 'verifier');
	assert.equal(first.returnPath, '/billing');
	assert.equal(await consumeAuthStateWithCollection(states, { stateHash: 'h1', now: later(6) }), null);

	await createAuthStateWithCollection(states, { stateHash: 'h2', codeVerifier: 'v', returnPath: '/account', now: NOW, expiresAt: later(600) });
	assert.equal(await consumeAuthStateWithCollection(states, { stateHash: 'h2', now: later(601) }), null);
	assert.equal(await consumeAuthStateWithCollection(states, { stateHash: 'unknown', now: NOW }), null);
});

test('sessions: active until expiry or revocation, authTime recorded', async () => {
	const sessions = fakeCollection();
	await createSessionWithCollection(sessions, { tokenHash: 's1', githubId: 7, login: 'octo', now: NOW, expiresAt: later(1000) });
	const active = await getActiveSessionWithCollection(sessions, { tokenHash: 's1', now: later(10) });
	assert.equal(active.githubId, 7);
	assert.equal(active.authTime, NOW.toISOString());
	assert.equal(active.revokedAt, null);

	assert.equal(await getActiveSessionWithCollection(sessions, { tokenHash: 's1', now: later(1001) }), null);

	await revokeSessionWithCollection(sessions, { tokenHash: 's1', now: later(20) });
	assert.equal(await getActiveSessionWithCollection(sessions, { tokenHash: 's1', now: later(21) }), null);
	assert.equal(sessions.docs.get('s1').revokedAt, later(20).toISOString());
});
