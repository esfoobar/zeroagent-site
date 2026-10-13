import { randomUUID } from 'node:crypto';
import { assertLivemode } from './billing-config.js';

const currentStatuses = new Set(['trialing', 'active', 'past_due', 'unpaid', 'incomplete', 'paused']);
const unwrap = (value) => value && 'value' in value ? value.value : value;
const customerIdFor = (account, environment) => {
	const owner = account.billingCustomer;
	if (owner && owner.stripeAccountId === environment.stripeAccountId && owner.livemode === environment.livemode) return owner.customerId;
	const billing = account.billing;
	if (billing && billing.stripeAccountId === environment.stripeAccountId && billing.livemode === environment.livemode) return billing.customerId;
	return null;
};

export async function ownedCustomer({ stripe, account, environment }) {
	const customerId = customerIdFor(account, environment);
	if (!customerId) return null;
	const customer = await stripe.customers.retrieve(customerId);
	assertLivemode(environment, customer, 'Customer');
	if (customer.deleted || customer.metadata?.githubId !== String(account.githubId)) throw new Error('customer_owner_mismatch');
	return customer;
}

export async function hasCurrentSubscription({ stripe, customerId, environment }) {
	if (!customerId) return false;
	let startingAfter;
	do {
		const page = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) });
		for (const subscription of page.data || []) {
			assertLivemode(environment, subscription, 'Subscription');
			if (subscription.customer !== customerId) throw new Error('subscription_customer_mismatch');
			if (currentStatuses.has(subscription.status)) return true;
		}
		if (!page.has_more) return false;
		startingAfter = page.data.at(-1)?.id;
	} while (startingAfter);
	return false;
}

export async function ensureCustomer({ stripe, users, account, environment }) {
	const existing = await ownedCustomer({ stripe, account, environment });
	if (existing) return existing;
	const created = await stripe.customers.create({ metadata: { githubId: String(account.githubId) } }, { idempotencyKey: `billing-customer-${environment.stripeAccountId}-${environment.environment}-${account.githubId}` });
	assertLivemode(environment, created, 'Customer');
	if (created.metadata?.githubId !== String(account.githubId)) throw new Error('customer_owner_mismatch');
	const value = { customerId: created.id, stripeAccountId: environment.stripeAccountId, livemode: environment.livemode };
	await users.updateOne({ _id: account.githubId, billingCustomer: null }, { $set: { billingCustomer: value } });
	const latest = await users.findOne({ _id: account.githubId });
	if (latest?.billingCustomer?.customerId !== created.id) throw new Error('customer_owner_mismatch');
	return created;
}

// The unique _id is a per-account serialization point. A pending operation
// retains its Stripe idempotency key across a crashed request and later retry.
export async function createCheckout({ stripe, users, purchases, account, environment, offer, now = new Date(), baseUrl }) {
	const customer = await ensureCustomer({ stripe, users, account, environment });
	if (await hasCurrentSubscription({ stripe, customerId: customer.id, environment })) return { status: 'already_subscribed' };
	const key = `${environment.stripeAccountId}:${environment.environment}:${account.githubId}`;
	let attempt = await purchases.findOne({ _id: key });
	if (attempt?.priceId !== offer.priceId && attempt?.sessionId) {
		const previous = await stripe.checkout.sessions.retrieve(attempt.sessionId);
		assertLivemode(environment, previous, 'Checkout Session');
		if (previous.customer !== customer.id) throw new Error('customer_owner_mismatch');
		if (previous.status === 'complete') return { status: 'pending' };
		if (previous.status === 'open') await stripe.checkout.sessions.expire(previous.id);
	}
	if (attempt?.sessionId && attempt.priceId === offer.priceId) {
		const previous = await stripe.checkout.sessions.retrieve(attempt.sessionId);
		assertLivemode(environment, previous, 'Checkout Session');
		if (previous.customer !== customer.id) throw new Error('customer_owner_mismatch');
		if (previous.status === 'complete') return { status: 'pending' };
		if (previous.status === 'open' && previous.expires_at * 1000 > now.getTime()) return { status: 'open', url: previous.url };
	}
	const operationId = attempt && !attempt.sessionId && attempt.priceId === offer.priceId ? attempt.operationId : randomUUID();
	let claimedCreation = false;
	if (!attempt) {
		try {
			await purchases.insertOne({ _id: key, operationId, priceId: offer.priceId, customerId: customer.id, sessionId: null, state: 'creating', createdAt: now.toISOString() });
			claimedCreation = true;
		} catch (error) { if (error.code !== 11000 && !/duplicate/i.test(error.message)) throw error; }
	} else if (attempt.sessionId) {
		const claimed = unwrap(await purchases.findOneAndUpdate({ _id: key, operationId: attempt.operationId }, { $set: { operationId, priceId: offer.priceId, customerId: customer.id, sessionId: null, state: 'creating', createdAt: now.toISOString() } }, { returnDocument: 'after' }));
		if (!claimed) return { status: 'pending' };
		claimedCreation = true;
	}
	attempt = await purchases.findOne({ _id: key });
	if (attempt.operationId !== operationId || attempt.priceId !== offer.priceId || attempt.customerId !== customer.id) return { status: 'pending' };
	if (!claimedCreation && !attempt.sessionId) {
		// Recover a crashed creation after a short lease. The operation id is
		// unchanged, so Stripe's idempotency key remains unchanged too.
		if (now.getTime() - new Date(attempt.createdAt).getTime() < 15000) return { status: 'pending' };
		const recovered = unwrap(await purchases.findOneAndUpdate(
			{ _id: key, operationId, sessionId: null, createdAt: attempt.createdAt },
			{ $set: { createdAt: now.toISOString() } }, { returnDocument: 'after' }
		));
		if (!recovered) return { status: 'pending' };
	}
	// Concurrent calls use the same operation id. Stripe creates at most one session.
	const session = await stripe.checkout.sessions.create({
		mode: 'subscription', customer: customer.id, line_items: [{ price: offer.priceId, quantity: 1 }],
		client_reference_id: String(account.githubId),
		metadata: { githubId: String(account.githubId) },
		subscription_data: { metadata: { githubId: String(account.githubId) } },
		success_url: `${baseUrl}/billing?checkout=return`, cancel_url: `${baseUrl}/account/plan?checkout=cancel`,
	}, { idempotencyKey: `checkout-${operationId}` });
	assertLivemode(environment, session, 'Checkout Session');
	if (session.customer !== customer.id || session.status !== 'open') throw new Error('invalid_checkout_session');
	await purchases.updateOne({ _id: key, operationId }, { $set: { sessionId: session.id, state: 'open', expiresAt: new Date(session.expires_at * 1000).toISOString() } });
	return { status: 'open', url: session.url };
}

export { customerIdFor };
