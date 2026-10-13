import { createHmac } from 'node:crypto';

// STRIPE_WEBHOOK_SECRET is already configured for the webhook and operator
// scripts. Domain separation keeps these references distinct from signatures.
export function billingReference(value, secret) {
	if (typeof secret !== 'string' || !secret) throw new Error('billing_reference_secret_required');
	return createHmac('sha256', secret).update('billing-reference:').update(String(value)).digest('hex').slice(0, 12);
}
