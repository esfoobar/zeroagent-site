/*
 * ZA-902 / esfoobar/zeroagent#1265. A small Stripe API client over fetch:
 * the same injected shape billing-catalog.js already uses
 * (`stripe.products.retrieve(id, { expand })`), plus the subscription and
 * invoice reads reconciliation needs. No SDK dependency.
 *
 * `request` is the general helper (method, path, query, expand, a
 * form-encoded body, an idempotency key) so other billing code extends the
 * client with its own methods rather than a second client. The webhook
 * only ever calls the GET reads below; it never creates anything.
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

	// Stripe form-encodes request bodies, nested keys as a[b]=c and arrays as
	// a[0]=x.
	function encodeForm(value, prefix, out) {
		if (value === null || value === undefined) return;
		if (Array.isArray(value)) {
			value.forEach((v, i) => encodeForm(v, `${prefix}[${i}]`, out));
		} else if (typeof value === 'object') {
			for (const [k, v] of Object.entries(value)) encodeForm(v, prefix ? `${prefix}[${k}]` : k, out);
		} else {
			out.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`);
		}
	}

	async function request({ method = 'GET', path, query = null, expand = [], form = null, idempotencyKey = null }) {
		const parts = [];
		if (query) encodeForm(query, '', parts);
		for (const e of expand) parts.push(`expand[]=${encodeURIComponent(e)}`);
		const headers = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };
		if (apiVersion) headers['Stripe-Version'] = apiVersion;
		if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
		const init = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
		if (form) {
			const body = [];
			encodeForm(form, '', body);
			headers['Content-Type'] = 'application/x-www-form-urlencoded';
			init.body = body.join('&');
		}
		let response;
		try {
			response = await fetchImpl(`${API_ORIGIN}${path}${parts.length ? `?${parts.join('&')}` : ''}`, init);
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

	const get = (path, options = {}) => request({ method: 'GET', path, expand: options.expand || [] });

	return {
		request,
		pathSegment,
		products: { retrieve: (id, options) => get(`/v1/products/${pathSegment(id)}`, options) },
		customers: {
			create: (form, options = {}) => request({ method: 'POST', path: '/v1/customers', form, idempotencyKey: options.idempotencyKey }),
			retrieve: (id) => get(`/v1/customers/${pathSegment(id)}`),
		},
		subscriptions: {
			retrieve: (id, options) => get(`/v1/subscriptions/${pathSegment(id)}`, options),
			list: (query) => request({ path: '/v1/subscriptions', query }),
		},
		invoices: { retrieve: (id, options) => get(`/v1/invoices/${pathSegment(id)}`, options) },
		checkout: { sessions: {
			create: (form, options = {}) => request({ method: 'POST', path: '/v1/checkout/sessions', form, idempotencyKey: options.idempotencyKey }),
			retrieve: (id) => get(`/v1/checkout/sessions/${pathSegment(id)}`),
			expire: (id) => request({ method: 'POST', path: `/v1/checkout/sessions/${pathSegment(id)}/expire` }),
		} },
		billingPortal: { sessions: { create: (form) => request({ method: 'POST', path: '/v1/billing_portal/sessions', form }) } },
	};
}
