/*
 * ZA-165: a GA4 event on each download click. The count of record is
 * the server-side redirect at /download/<arch>; this is a
 * proxy for page-level intent, and undercounts by design (ad blockers,
 * auto-update and Homebrew installs never fire it).
 */
(function () {
	'use strict';

	function trackDownload(arch, platform, format) {
		if (typeof gtag !== 'function') return;
		var version = window.ZA_RELEASE_VERSION || 'unknown';
		gtag('event', 'download', { arch: arch, platform: platform, format: format, version: version, transport_type: 'beacon' });
	}

	document.addEventListener('DOMContentLoaded', function () {
		var arm64 = document.getElementById('za-download-arm64');
		var x64 = document.getElementById('za-download-x64');
		if (arm64) arm64.addEventListener('click', function () { trackDownload('arm64', 'mac', 'dmg'); });
		if (x64) x64.addEventListener('click', function () { trackDownload('x64', 'mac', 'dmg'); });
		var deb = document.getElementById('za-download-linux-deb');
		var appimage = document.getElementById('za-download-linux-appimage');
		if (deb) deb.addEventListener('click', function () { trackDownload('x64', 'linux', 'deb'); });
		if (appimage) appimage.addEventListener('click', function () { trackDownload('x64', 'linux', 'appimage'); });
	});
})();
