(function () {
	'use strict';
	var base = 'https://releases.zeroagenthq.com/latest/';
	var selected = 'mac';
	var linuxVersion = null;
	var macVersion = null;
	function show(os) {
		if (os === 'linux' && !linuxVersion) return;
		selected = os;
		['mac', 'linux'].forEach(function (name) {
			document.getElementById('za-' + name + '-panel').hidden = name !== os;
			document.getElementById('za-select-' + name).setAttribute('aria-pressed', String(name === os));
		});
		document.getElementById('za-mac-homebrew').hidden = os !== 'mac';
		document.getElementById('za-mac-prerequisite').hidden = os !== 'mac';
		document.getElementById('za-mac-intro').hidden = os !== 'mac';
		document.getElementById('za-linux-intro').hidden = os !== 'linux';
		document.getElementById('za-release-detail').hidden = os !== 'mac';
		if (os === 'linux') {
			document.getElementById('za-version').textContent = 'v' + linuxVersion + ' beta';
			window.ZA_RELEASE_VERSION = linuxVersion;
		} else {
			if (macVersion) document.getElementById('za-version').textContent = 'v' + macVersion;
			window.ZA_RELEASE_VERSION = macVersion || 'unknown';
		}
	}
	document.addEventListener('DOMContentLoaded', function () {
		document.getElementById('za-select-mac').addEventListener('click', function () { show('mac'); });
		document.getElementById('za-select-linux').addEventListener('click', function () { show('linux'); });
		fetch(base + 'release.json').then(function (res) {
			if (!res.ok) throw new Error('manifest unavailable');
			return res.json();
		}).then(function (manifest) {
			macVersion = manifest.mac && manifest.mac.version;
			var version = manifest.linux && manifest.linux.version;
			if (!version) return;
			return Promise.all([
				fetch(base + 'ZeroAgent-linux-x64.deb', { method: 'HEAD' }),
				fetch(base + 'ZeroAgent-linux-x64.AppImage', { method: 'HEAD' })
			]).then(function (responses) {
				if (!responses[0].ok || !responses[1].ok) return;
				linuxVersion = version;
				document.getElementById('za-select-linux').hidden = false;
				if (/Linux/i.test(navigator.userAgent || '') && !/Android|CrOS/i.test(navigator.userAgent || '')) show('linux');
			});
		}).catch(function () { /* macOS remains available. */ });
	});
})();
