(function () {
	'use strict';
	var base = 'https://releases.zeroagenthq.com/latest/';
	var selected = 'mac';
	var linuxVersion = null;
	var macVersion = null;
	// Read by zeroagent-release.js so the version line is only written while
	// the macOS tab is the one on screen. The Linux and Windows tabs show no
	// macOS version number.
	window.ZA_PLATFORM = { selected: selected };
	function show(os) {
		if (os === 'linux' && !linuxVersion) return;
		selected = os;
		window.ZA_PLATFORM.selected = os;
		['mac', 'linux', 'windows'].forEach(function (name) {
			document.getElementById('za-' + name + '-panel').hidden = name !== os;
			document.getElementById('za-' + name + '-intro').hidden = name !== os;
			document.getElementById('za-select-' + name).setAttribute('aria-pressed', String(name === os));
		});
		document.getElementById('za-mac-homebrew').hidden = os !== 'mac';
		document.getElementById('za-mac-prerequisite').hidden = os !== 'mac';
		document.getElementById('za-version-line').hidden = os === 'windows';
		document.getElementById('za-release-detail').hidden = os !== 'mac';
		document.getElementById('za-agree').hidden = os === 'windows';
		if (os === 'linux') {
			document.getElementById('za-version').textContent = 'v' + linuxVersion + ' beta';
			window.ZA_RELEASE_VERSION = linuxVersion;
		} else if (os === 'windows') {
			window.ZA_RELEASE_VERSION = 'unknown';
		} else {
			// release.json and latest-mac.yml both carry the macOS version;
			// either one is enough to label the tab.
			var mac = macVersion || (window.ZA_PLATFORM && window.ZA_PLATFORM.macVersion);
			if (mac) document.getElementById('za-version').textContent = 'v' + mac;
			window.ZA_RELEASE_VERSION = mac || 'unknown';
		}
	}
	document.addEventListener('DOMContentLoaded', function () {
		document.getElementById('za-select-mac').addEventListener('click', function () { show('mac'); });
		document.getElementById('za-select-linux').addEventListener('click', function () { show('linux'); });
		document.getElementById('za-select-windows').addEventListener('click', function () { show('windows'); });
		// The Windows tab is always offered, so it is chosen from the user
		// agent alone rather than from the release manifest.
		if (/Windows/i.test(navigator.userAgent || '')) show('windows');
		fetch(base + 'release.json').then(function (res) {
			if (!res.ok) throw new Error('manifest unavailable');
			return res.json();
		}).then(function (manifest) {
			macVersion = manifest.mac && manifest.mac.version;
			var version = manifest.linux && manifest.linux.version;
			if (!version) return;
			return fetch(base + 'ZeroAgent-linux-x64.deb', { method: 'HEAD' }).then(function (res) {
				if (!res.ok) return;
				linuxVersion = version;
				document.getElementById('za-select-linux').hidden = false;
				if (/Linux/i.test(navigator.userAgent || '') && !/Android|CrOS/i.test(navigator.userAgent || '')) show('linux');
			});
		}).catch(function () { /* macOS remains available. */ });
	});
})();
