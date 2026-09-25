const routes = {
	'mac/arm64': { platform: 'mac', arch: 'arm64', format: 'dmg', file: 'ZeroAgent-arm64.dmg' },
	'mac/x64': { platform: 'mac', arch: 'x64', format: 'dmg', file: 'ZeroAgent-x64.dmg' },
	'linux/x64': { platform: 'linux', arch: 'x64', format: 'deb', file: 'ZeroAgent-linux-x64.deb' },
	'linux/x64/deb': { platform: 'linux', arch: 'x64', format: 'deb', file: 'ZeroAgent-linux-x64.deb' },
	'linux/x64/appimage': { platform: 'linux', arch: 'x64', format: 'appimage', file: 'ZeroAgent-linux-x64.AppImage' },
};

export function resolveDownloadRoute({ os, arch, format }) {
	const key = [os || 'mac', arch, format].filter(Boolean).join('/');
	return routes[key] || null;
}

export function releaseVersion(manifest, platform) {
	const entry = manifest && manifest[platform];
	return entry && typeof entry.version === 'string' && /^\d+\.\d+\.\d+(?:[-.][\w.]+)?$/.test(entry.version)
		? entry.version : null;
}
