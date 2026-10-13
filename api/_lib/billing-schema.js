/*
 * ZA-901 / esfoobar/zeroagent#1264. The billing schema and index migration.
 *
 * What it does: creates the indexes the billing projection, the event inbox
 * and the audit trail depend on. createIndex with an identical spec is a
 * no-op, so it is safe to run twice.
 *
 * What it never does: write to an existing user. The `billing`,
 * `entitlementSource` and `legacyGrant` fields are absent on every account
 * that exists today and are derived on read (billing-projection.js), so
 * existing trials, plans and paired devices are preserved exactly. Marking a
 * legacy grant is a separate, deliberate step after the inventory below,
 * per docs/BILLING-ENTITLEMENT.md in the zeroagent repo ("Legacy-grant
 * migration"), and is not performed here.
 *
 * The unique indexes are partial on the string id being present, so the
 * accounts without a Stripe customer (all of them today) are not indexed
 * and never collide on null. They are scoped by Stripe account and mode, so
 * a sandbox customer id and a live one can never shadow each other.
 */

import { sha256Hex } from './hash.js';

export const BILLING_INDEXES = Object.freeze({
	users: [
		{
			key: { 'billing.stripeAccountId': 1, 'billing.livemode': 1, 'billing.customerId': 1 },
			options: {
				name: 'billing_customer_unique',
				unique: true,
				partialFilterExpression: { 'billing.customerId': { $type: 'string' } },
			},
		},
		{
			key: { 'billing.stripeAccountId': 1, 'billing.livemode': 1, 'billing.subscriptionId': 1 },
			options: {
				name: 'billing_subscription_unique',
				unique: true,
				partialFilterExpression: { 'billing.subscriptionId': { $type: 'string' } },
			},
		},
	],
	events: [
		{
			key: { stripeAccountId: 1, livemode: 1, eventId: 1 },
			options: { name: 'billing_event_unique', unique: true },
		},
		{
			key: { state: 1, leaseExpiresAt: 1 },
			options: { name: 'billing_event_redrive' },
		},
	],
	audit: [{ key: { at: 1 }, options: { name: 'billing_audit_at' } }],
});

export async function ensureBillingIndexes(collections) {
	const created = [];
	for (const [name, specs] of Object.entries(BILLING_INDEXES)) {
		for (const { key, options } of specs) {
			await collections[name].createIndex(key, options);
			created.push(`${name}.${options.name}`);
		}
	}
	return created;
}

// Read-only. Lists accounts whose paid plan was assigned by hand, with the
// contract's default disposition, and no customer data: a short hash
// reference, the plan and the date on record. Marking is not done here.
export async function inventoryLegacyGrants(users, now = new Date()) {
	const rows = await users
		.find(
			{
				plan: { $in: ['premium', 'platinum'] },
				billing: { $in: [null] },
				entitlementSource: { $ne: 'legacy_grant' },
			},
			{ projection: { plan: 1, planUntil: 1 } }
		)
		.toArray();
	return rows.map((row) => {
		let disposition;
		if (!row.planUntil) disposition = 'owner_decision_open_ended';
		else if (new Date(row.planUntil).getTime() > now.getTime()) disposition = 'mark_dated';
		else disposition = 'owner_decision_lapsed';
		return {
			ref: sha256Hex(String(row._id)).slice(0, 12),
			plan: row.plan,
			planUntil: row.planUntil ?? null,
			disposition,
		};
	});
}

export async function runBillingMigration({ collections, now = new Date(), dryRun = false }) {
	const indexes = dryRun ? [] : await ensureBillingIndexes(collections);
	const inventory = await inventoryLegacyGrants(collections.users, now);
	const summary = {};
	for (const row of inventory) summary[row.disposition] = (summary[row.disposition] || 0) + 1;
	return { dryRun, indexes, legacyGrants: inventory.length, summary, inventory };
}
