/*
 * ZA-902 / esfoobar/zeroagent#1265. A small read-only Stripe API client
 * over fetch: the same injected shape billing-catalog.js already uses
 * (`stripe.products.retrieve(id, { expand })`), plus the subscription and
 * invoice reads reconciliation needs. No SDK dependency; only GET.
 *
 * Errors carry the HTTP status and Stripe's error type and code, never the
 * response body, the key or a message that could echo either. `retriable`
 * is true for network failures, timeouts, 429 and 5xx.
 */

const API_ORIGIN = 'https://api.stripe.com';

export class StripeApiError extends Error {
	constructor({ status = null, type = null, code = null, retriable = false }) {
		super(`stripe api error${status ? ` ${status}` : ''}${code ? ` ${code}` : ''}`);
		this.name = 'StripeApiError';
		this.status = status;
		this.type = type;
		this.code = code;
		this.retriable = retriable;
	}
}

function pathSegment(id) {
	if (typeof id !== 'string' || !/^[A-Za-z0-9_]+$/.test(id)) throw new Error('invalid stripe object id');
	return id;
}

export function createStripeClient({ apiKey, apiVersion = null, fetchImpl = globalThis.fetch, timeoutMs = 8000 }) {
	if (!apiKey) throw new Error('a Stripe key is required');

	async function get(path, { expand = [] } = {}) {
		const query = expand.map((e) => `expand[]=${encodeURIComponent(e)}`).join('&');
		const headers = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };
		if (apiVersion) headers['Stripe-Version'] = apiVersion;
		let response;
		try {
			response = await fetchImpl(`${API_ORIGIN}${path}${query ? `?${query}` : ''}`, {
				method: 'GET',
				headers,
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch {
			throw new StripeApiError({ retriable: true, code: 'network_error' });
		}
		let body = null;
		try {
			body = await response.json();
		} catch {
			body = null;
		}
		if (!response.ok) {
			const detail = body && body.error ? body.error : {};
			throw new StripeApiError({
				status: response.status,
				type: typeof detail.type === 'string' ? detail.type : null,
				code: typeof detail.code === 'string' ? detail.code : null,
				retriable: response.status === 429 || response.status >= 500,
			});
		}
		if (!body || typeof body !== 'object') throw new StripeApiError({ status: response.status, code: 'bad_body', retriable: true });
		return body;
	}

	return {
		products: { retrieve: (id, options) => get(`/v1/products/${pathSegment(id)}`, options) },
		subscriptions: { retrieve: (id, options) => get(`/v1/subscriptions/${pathSegment(id)}`, options) },
		invoices: { retrieve: (id, options) => get(`/v1/invoices/${pathSegment(id)}`, options) },
	};
}
