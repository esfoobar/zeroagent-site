import { assertLivemode } from './billing-config.js';
import { idOf } from './billing-reconcile.js';

const check = (condition, code) => { if (!condition) throw new Error(code); };
const priceOf = (subscription) => subscription.items?.data?.[0]?.price?.id;
const current = (product) => idOf(product.default_price);

// Each proof reads actual Stripe objects after the operator's sandbox action.
// The account projection is read as well when a customer is supplied.
export async function verifySandboxScenario({ scenario, stripe, environment, args, collections, fetchImpl = globalThis.fetch }) {
	check(environment.livemode === false && environment.environment === 'sandbox', 'sandbox_only');
	const product = await stripe.products.retrieve(environment.productId, { expand: ['default_price'] });
	assertLivemode(environment, product, 'Product');
	const get = async (id) => { check(id, 'subscription_required'); const value = await stripe.subscriptions.retrieve(id, { expand: ['latest_invoice'] }); assertLivemode(environment, value, 'Subscription'); return value; };
	const price = async (id) => { check(id, 'price_required'); const value = await stripe.prices.retrieve(id); assertLivemode(environment, value, 'Price'); check(idOf(value.product) === environment.productId, 'wrong_product'); return value; };
	const invoice = async (id) => { check(id, 'invoice_required'); const value = await stripe.invoices.retrieve(id); assertLivemode(environment, value, 'Invoice'); return value; };
	const projection = async (subscription) => {
		check(args.account, 'account_required');
		const account = await collections.users.findOne({ _id: Number(args.account) });
		check(account?.billing?.subscriptionId === subscription.id && account.billing.livemode === false && account.billing.stripeAccountId === environment.stripeAccountId, 'projection_not_current');
		return account.billing;
	};
	switch (scenario) {
		case 'price-increase':
		case 'price-decrease': {
			const oldPrice = await price(args.oldPrice);
			const newPrice = await price(args.newPrice);
			check(scenario === 'price-increase' ? newPrice.unit_amount > oldPrice.unit_amount : newPrice.unit_amount < oldPrice.unit_amount, 'wrong_price_direction');
			check(current(product) === newPrice.id, 'default_price_not_changed');
			const existing = await get(args.subscription);
			check(priceOf(existing) === oldPrice.id, 'existing_price_changed');
			const billing = await projection(existing);
			check(billing.priceId === oldPrice.id, 'projection_price_changed');
			return { scenario, verified: ['current_default_price', 'existing_subscription_price', 'stored_projection_price'] };
		}
		case 'archived-renewal': {
			const oldPrice = await price(args.oldPrice);
			check(oldPrice.active === false, 'old_price_not_archived');
			const subscription = await get(args.subscription);
			check(priceOf(subscription) === oldPrice.id, 'renewal_price_changed');
			const paid = await invoice(args.invoice);
			check(paid.status === 'paid' && idOf(paid.subscription) === subscription.id, 'renewal_not_paid');
			const billing = await projection(subscription);
			check(billing.lastPaidInvoiceId === paid.id, 'renewal_not_projected');
			return { scenario, verified: ['archived_price', 'paid_renewal', 'stored_projection'] };
		}
		case 'portal-preservation': {
			const subscription = await get(args.subscription);
			check(priceOf(subscription) === args.oldPrice, 'portal_changed_price');
			const billing = await projection(subscription);
			check(billing.priceId === args.oldPrice, 'projection_price_changed');
			const configuration = await stripe.billingPortal.configurations.retrieve(environment.portalConfigurationId);
			assertLivemode(environment, configuration, 'Portal configuration');
			check(configuration.features?.subscription_update?.enabled === false, 'portal_allows_switching');
			return { scenario, verified: ['portal_switching_disabled', 'subscription_price', 'stored_projection_price'] };
		}
		case 'return-after-cancellation': {
			const ended = await get(args.oldSubscription);
			const returned = await get(args.subscription);
			check(ended.status === 'canceled' && ended.id !== returned.id, 'old_subscription_not_ended');
			check(current(product) === priceOf(returned), 'return_not_current_price');
			const billing = await projection(returned);
			check(billing.priceId === current(product), 'return_not_projected');
			return { scenario, verified: ['old_subscription_ended', 'return_uses_current_price', 'stored_projection'] };
		}
		case 'reverse-cancellation': {
			const subscription = await get(args.subscription);
			check(subscription.cancel_at_period_end === false && subscription.status === 'active', 'cancellation_not_reversed');
			check(priceOf(subscription) === args.oldPrice, 'original_price_changed');
			const billing = await projection(subscription);
			check(billing.cancelAtPeriodEnd === false && billing.priceId === args.oldPrice, 'reverse_not_projected');
			return { scenario, verified: ['same_subscription_active', 'original_price', 'stored_projection'] };
		}
		case 'test-clock-renewal': {
			const clock = await stripe.testClocks.retrieve(args.clock);
			assertLivemode(environment, clock, 'Test clock');
			check(clock.status === 'ready', 'clock_not_ready');
			const subscription = await get(args.subscription);
			check(idOf(subscription.test_clock) === clock.id, 'subscription_clock_mismatch');
			const paid = await invoice(args.invoice);
			check(paid.status === 'paid' && idOf(paid.subscription) === subscription.id, 'renewal_not_paid');
			const billing = await projection(subscription);
			check(billing.lastPaidInvoiceId === paid.id && new Date(billing.paidThrough) > new Date(args.previousPaidThrough), 'renewal_not_projected');
			return { scenario, verified: ['test_clock_ready', 'renewal_paid', 'paid_through_advanced'] };
		}
		case 'payment-failure': {
			const subscription = await get(args.subscription);
			check(['past_due', 'unpaid'].includes(subscription.status), 'subscription_not_past_due');
			const failed = await invoice(args.invoice);
			check(failed.status !== 'paid' && idOf(failed.subscription) === subscription.id, 'invoice_not_failed');
			const billing = await projection(subscription);
			check(billing.status === 'past_due' && billing.paymentGraceUntil, 'failure_not_projected');
			return { scenario, verified: ['payment_failure', 'stored_grace'] };
		}
		case 'cancel': {
			const subscription = await get(args.subscription);
			const billing = await projection(subscription);
			check(subscription.cancel_at_period_end === true && billing.cancelAtPeriodEnd === true, 'cancellation_not_projected');
			return { scenario, verified: ['scheduled_cancellation', 'stored_projection'] };
		}
		case 'restricted-key': {
			check(args.apiKey?.startsWith('rk_test_'), 'restricted_test_key_required');
			await stripe.subscriptions.list({ limit: 1 });
			let denied = false;
			try { await stripe.request({ path: '/v1/balance' }); } catch (error) { denied = error.status === 403; }
			check(denied, 'forbidden_read_not_denied');
			return { scenario, verified: ['subscription_read_allowed', 'balance_read_denied'] };
		}
		case 'staging-boundary': {
			check(args.stagingUrl && new URL(args.stagingUrl).protocol === 'https:', 'staging_url_required');
			check(new URL(args.stagingUrl).hostname !== 'zeroagenthq.com', 'production_host_refused');
			check(args.productionDb && args.database !== args.productionDb, 'database_not_isolated');
			const response = await fetchImpl(new URL('/api/billing/catalog', args.stagingUrl));
			check(response.ok, 'staging_catalog_unavailable');
			return { scenario, verified: ['sandbox_key_and_product', 'separate_database_name', 'staging_catalog'] };
		}
		default: throw new Error('unknown_scenario');
	}
}
