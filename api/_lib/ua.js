/*
 * Hand-written user agent parser. No dependency: this whole file is the
 * parser, kept deliberately small rather than pulling in a UA database that
 * needs updating forever.
 *
 * Exports parseUserAgent(ua) -> { browser, browserVersion, os, osVersion,
 * device, bot }. Anything not recognized comes back null rather than guessed.
 */

// Browsers this parser treats as a real human browser session. Everything
// else that answers a name (curl, wget, a crawler) is not one of these, and
// that is the whole rule the stats endpoint uses to split humans from bots
// without needing anything more than this list.
export const HUMAN_BROWSERS = [
	'Chrome',
	'Edge',
	'Safari',
	'Firefox',
	'Arc',
	'Brave',
	'Opera',
];

// Common crawlers and link-preview bots, matched case-insensitively against
// a substring of the UA. Not exhaustive; new ones get added here as they
// show up in the data.
const BOT_PATTERNS = [
	[/googlebot/i, 'Googlebot'],
	[/bingpreview/i, 'BingPreview'],
	[/bingbot/i, 'Bingbot'],
	[/slurp/i, 'Slurp'],
	[/duckduckbot/i, 'DuckDuckBot'],
	[/baiduspider/i, 'Baiduspider'],
	[/yandexbot/i, 'YandexBot'],
	[/facebookexternalhit/i, 'FacebookBot'],
	[/facebot/i, 'FacebookBot'],
	[/twitterbot/i, 'Twitterbot'],
	[/linkedinbot/i, 'LinkedInBot'],
	[/whatsapp/i, 'WhatsApp'],
	[/telegrambot/i, 'TelegramBot'],
	[/discordbot/i, 'Discordbot'],
	[/slackbot/i, 'Slackbot'],
	[/applebot/i, 'Applebot'],
	[/ahrefsbot/i, 'AhrefsBot'],
	[/semrushbot/i, 'SemrushBot'],
	[/mj12bot/i, 'MJ12bot'],
	[/dotbot/i, 'DotBot'],
	[/petalbot/i, 'PetalBot'],
	[/bytespider/i, 'Bytespider'],
	[/gptbot/i, 'GPTBot'],
	[/chatgpt-user/i, 'ChatGPT-User'],
	[/ccbot/i, 'CCBot'],
	[/claudebot/i, 'ClaudeBot'],
	[/anthropic-ai/i, 'Anthropic-AI'],
	[/perplexitybot/i, 'PerplexityBot'],
	[/ia_archiver/i, 'ia_archiver'],
	[/uptimerobot/i, 'UptimeRobot'],
	[/pingdom/i, 'Pingdom'],
	[/seznambot/i, 'SeznamBot'],
];

function detectBot(ua) {
	for (const [pattern, name] of BOT_PATTERNS) {
		if (pattern.test(ua)) return name;
	}
	return null;
}

function versionAfter(ua, token) {
	const idx = ua.indexOf(token);
	if (idx === -1) return null;
	const rest = ua.slice(idx + token.length);
	const match = rest.match(/^([0-9][0-9.]*)/);
	return match ? match[1] : null;
}

function detectOs(ua) {
	let match = ua.match(/Mac OS X ([0-9_.]+)/);
	if (match) {
		return { os: 'macOS', osVersion: match[1].replace(/_/g, '.') };
	}
	if (/Macintosh|Mac OS X/.test(ua)) {
		return { os: 'macOS', osVersion: null };
	}

	match = ua.match(/(?:iPhone OS|CPU OS|CPU iPhone OS) ([0-9_]+)/);
	if (match) {
		return { os: 'iOS', osVersion: match[1].replace(/_/g, '.') };
	}
	if (/iPhone|iPad|iPod/.test(ua)) {
		return { os: 'iOS', osVersion: null };
	}

	match = ua.match(/Android ([0-9.]+)/);
	if (match) {
		return { os: 'Android', osVersion: match[1] };
	}
	if (/Android/.test(ua)) {
		return { os: 'Android', osVersion: null };
	}

	match = ua.match(/Windows NT ([0-9.]+)/);
	if (match) {
		const NT_VERSIONS = {
			'10.0': '10',
			'6.3': '8.1',
			'6.2': '8',
			'6.1': '7',
			'6.0': 'Vista',
			'5.1': 'XP',
		};
		return { os: 'Windows', osVersion: NT_VERSIONS[match[1]] || match[1] };
	}
	if (/Windows/.test(ua)) {
		return { os: 'Windows', osVersion: null };
	}

	if (/Linux/.test(ua)) {
		return { os: 'Linux', osVersion: null };
	}

	return { os: null, osVersion: null };
}

function detectDevice(ua, { bot, isCli }) {
	if (bot) return 'bot';
	if (isCli) return 'cli';
	if (/iPad|Tablet(?!.*Mobile)/.test(ua)) return 'tablet';
	if (/Android/.test(ua) && !/Mobile/.test(ua)) return 'tablet';
	if (/Mobi|iPhone|iPod|Android/.test(ua)) return 'mobile';
	return 'desktop';
}

/**
 * Parse a User-Agent header into { browser, browserVersion, os, osVersion,
 * device, bot }. Every field is null (bot is false) when nothing is
 * recognized; nothing here throws.
 */
export function parseUserAgent(ua) {
	const value = typeof ua === 'string' ? ua : '';

	if (!value) {
		return {
			browser: null,
			browserVersion: null,
			os: null,
			osVersion: null,
			device: 'unknown',
			bot: false,
		};
	}

	// Simple HTTP clients first: neither a browser nor a crawler, but not a
	// human browsing session either, so they read as bot for the humans
	// versus bots split.
	let curlMatch = value.match(/^curl\/([0-9.]+)/i) || value.match(/\bcurl\/([0-9.]+)/i);
	if (curlMatch) {
		return {
			browser: 'curl',
			browserVersion: curlMatch[1],
			os: null,
			osVersion: null,
			device: 'cli',
			bot: true,
		};
	}
	let wgetMatch = value.match(/\bWget\/([0-9.]+)/i);
	if (wgetMatch) {
		return {
			browser: 'wget',
			browserVersion: wgetMatch[1],
			os: null,
			osVersion: null,
			device: 'cli',
			bot: true,
		};
	}

	const botName = detectBot(value);
	if (botName) {
		const { os, osVersion } = detectOs(value);
		return {
			browser: botName,
			browserVersion: null,
			os,
			osVersion,
			device: 'bot',
			bot: true,
		};
	}

	const { os, osVersion } = detectOs(value);

	let browser = null;
	let browserVersion = null;

	if (value.includes('Edg/')) {
		browser = 'Edge';
		browserVersion = versionAfter(value, 'Edg/');
	} else if (value.includes('Edge/')) {
		browser = 'Edge';
		browserVersion = versionAfter(value, 'Edge/');
	} else if (value.includes('OPR/')) {
		browser = 'Opera';
		browserVersion = versionAfter(value, 'OPR/');
	} else if (value.includes('Opera/')) {
		browser = 'Opera';
		browserVersion = versionAfter(value, 'Opera/');
	} else if (value.includes('Brave/')) {
		browser = 'Brave';
		browserVersion = versionAfter(value, 'Brave/');
	} else if (value.includes('Arc/')) {
		browser = 'Arc';
		browserVersion = versionAfter(value, 'Arc/');
	} else if (value.includes('FxiOS/')) {
		browser = 'Firefox';
		browserVersion = versionAfter(value, 'FxiOS/');
	} else if (value.includes('Firefox/') && !/Seamonkey/i.test(value)) {
		browser = 'Firefox';
		browserVersion = versionAfter(value, 'Firefox/');
	} else if (value.includes('CriOS/')) {
		browser = 'Chrome';
		browserVersion = versionAfter(value, 'CriOS/');
	} else if (value.includes('Chrome/')) {
		browser = 'Chrome';
		browserVersion = versionAfter(value, 'Chrome/');
	} else if (value.includes('Safari/') && value.includes('Version/')) {
		browser = 'Safari';
		browserVersion = versionAfter(value, 'Version/');
	}

	return {
		browser,
		browserVersion,
		os,
		osVersion,
		device: detectDevice(value, { bot: false, isCli: false }),
		bot: false,
	};
}
