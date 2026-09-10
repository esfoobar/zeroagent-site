/*
 * ZA-204. GA4 Measurement Protocol reporting for the counted redirect.
 *
 * download.js is the count of record; this module is a second, additive
 * report of the same event to GA4 so Jorge can read location and browser
 * breakdowns there instead of only on /zeroagent/stats/. See
 * zeroagent/docs/DOWNLOADS.md for which request fields are used and why,
 * against developers.google.com/analytics/devguides/collection/protocol/ga4.
 *
 * Exports are split into pure functions (payload building, client_id
 * extraction) that a plain node --test file can exercise without a network,
 * and sendGa4Event, the one function that actually calls fetch.
 */

export const GA4_MEASUREMENT_ID = 'G-BTHHJB4E4T';
const GA4_COLLECT_URL = 'https://www.google-analytics.com/mp/collect';
const GA4_DEBUG_COLLECT_URL = 'https://www.google-analytics.com/debug/mp/collect';

/*
 * The gtag.js client_id lives in the _ga cookie as GA1.<domain-depth>.<id1>.<id2>;
 * the client_id value gtag itself sends is the last two dot-separated
 * segments joined back with a dot. Returns null when there is no cookie, no
 * _ga value, or the value doesn't have enough segments to be one.
 */
export function extractClientId(cookieHeader) {
	if (!cookieHeader) return null;
	const match = String(cookieHeader).match(/(?:^|;\s*)_ga=([^;]+)/);
	if (!match) return null;
	let value;
	try {
		value = decodeURIComponent(match[1]);
	} catch (err) {
		value = match[1];
	}
	const parts = value.split('.');
	if (parts.length < 4) return null;
	return parts.slice(-2).join('.');
}

/*
 * Used when there is no _ga cookie (an ad blocker, a curl, a first-ever
 * visit that lands straight on the download link). Any unique string is a
 * valid GA4 client_id; it does not need to look like a gtag one.
 */
export function randomClientId() {
	return globalThis.crypto.randomUUID();
}

/*
 * The gtag.js session lives in the _ga_<container-id> cookie, where
 * container-id is the measurement id without its leading "G-". Two on-the-
 * wire shapes exist: the older GS1.<n>.<session_id>.<session_number>... has
 * the session id as the whole third dot-separated segment, and the newer
 * GS2.<n>.s<session_id>$o<count>$g<engaged>$t<timestamp>$... has it after
 * the leading "s" in that segment, terminated by "$". Returns null when
 * there is no matching cookie or its value doesn't parse as either shape.
 */
export function extractSessionId(cookieHeader, measurementId = GA4_MEASUREMENT_ID) {
	if (!cookieHeader) return null;
	const containerId = String(measurementId).replace(/^G-/, '');
	const pattern = new RegExp(`(?:^|;\\s*)_ga_${containerId}=([^;]+)`);
	const match = String(cookieHeader).match(pattern);
	if (!match) return null;
	let value;
	try {
		value = decodeURIComponent(match[1]);
	} catch (err) {
		value = match[1];
	}
	const parts = value.split('.');
	if (parts.length < 3) return null;
	const segment = parts[2];
	if (/^\d+$/.test(segment)) return segment;
	const gs2Match = segment.match(/^s(\d+)/);
	return gs2Match ? gs2Match[1] : null;
}

/*
 * Used when there is no parseable session cookie (an ad blocker, a curl, a
 * first-ever visit). GA4's Measurement Protocol just needs session_id to
 * look like a session identifier tying this event to others nearby in
 * time; the request's own timestamp in seconds is a reasonable stand-in,
 * the same value gtag.js itself would seed a brand new session id from.
 */
export function fallbackSessionId(timestampMs) {
	return String(Math.floor(timestampMs / 1000));
}

/*
 * x-forwarded-for can carry a comma-separated chain when a request passed
 * through more than one proxy; the first entry is the original client as
 * Vercel's edge network saw it.
 */
export function firstForwardedIp(xForwardedFor, xRealIp) {
	if (xForwardedFor) {
		const first = String(xForwardedFor).split(',')[0].trim();
		if (first) return first;
	}
	if (xRealIp) {
		const value = String(xRealIp).trim();
		if (value) return value;
	}
	return null;
}

// GA4 params must be short strings; "direct" reads better than "unknown"
// for a param whose whole point is naming where the click came from.
export function refererHost(referer) {
	if (!referer) return 'direct';
	try {
		const host = new URL(referer).host;
		return host || 'direct';
	} catch (err) {
		return 'direct';
	}
}

/*
 * Builds the Measurement Protocol JSON body for one download_served event.
 * Pure: no I/O, no env reads, so it is what the node --test file targets
 * directly. ip and ua are optional so a caller that could not read either
 * header still gets a valid payload back.
 */
export function buildDownloadServedPayload({
	clientId,
	sessionId,
	arch,
	version,
	ua,
	ip,
	referer,
	timestampMs,
}) {
	if (!clientId) throw new Error('buildDownloadServedPayload requires clientId');
	if (!sessionId) throw new Error('buildDownloadServedPayload requires sessionId');
	if (!arch) throw new Error('buildDownloadServedPayload requires arch');

	const payload = {
		client_id: clientId,
		events: [
			{
				name: 'download_served',
				params: {
					// Required for the event to show up in standard reports,
					// Realtime included: developers.google.com/analytics/devguides/
					// collection/protocol/ga4/reference/events says activity without
					// both of these does not populate reports.
					session_id: sessionId,
					engagement_time_msec: '100',
					arch,
					version: version || 'unknown',
					source: 'redirect',
					referrer_host: refererHost(referer),
				},
			},
		],
	};

	if (Number.isFinite(timestampMs)) {
		payload.timestamp_micros = Math.round(timestampMs * 1000);
	}
	// A user_agent string lets GA4 derive browser/OS the same way it would
	// from a tagged pageview. Sending a structured `device` object instead
	// would make Measurement Protocol ignore user_agent, so this redirect
	// never sends both.
	if (ua) {
		payload.user_agent = ua;
	}
	// ip_override is what tells GA4 to derive geographic info from this IP;
	// user_location (if sent) would take precedence over it, so this
	// redirect never sends both. See zeroagent/docs/DOWNLOADS.md for why
	// ip_override was chosen over user_location.
	if (ip) {
		payload.ip_override = ip;
	}

	return payload;
}

export function ga4CollectUrl({ apiSecret, debug = false, measurementId = GA4_MEASUREMENT_ID }) {
	const base = debug ? GA4_DEBUG_COLLECT_URL : GA4_COLLECT_URL;
	const params = new URLSearchParams({ measurement_id: measurementId, api_secret: apiSecret });
	return `${base}?${params.toString()}`;
}

/*
 * POSTs one payload to the real collect endpoint (debug: true instead hits
 * the validation endpoint and returns its JSON body, used only from the
 * manual validation command in the runbook, never from the redirect).
 * Never throws for an HTTP-level non-2xx; the real collect endpoint answers
 * 204 with no body for both good and bad payloads, so there is nothing to
 * inspect there. A network failure (DNS, timeout, offline) does throw, and
 * callers are expected to catch it so a GA4 outage never surfaces to the
 * redirect's own response.
 */
export async function sendGa4Event({ payload, apiSecret, debug = false, measurementId }) {
	const url = ga4CollectUrl({ apiSecret, debug, measurementId });
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload),
	});
	if (debug) {
		return res.json();
	}
	return undefined;
}
