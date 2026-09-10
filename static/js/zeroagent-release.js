/*
 * Release feed addresses for the /zeroagent/download/ page.
 *
 * ZA-172: the branded hostname for the zeroagent release feed, a CloudFront
 * alias in front of the zeroagent-releases bucket. See the URL scheme in
 * zeroagent's docs/RELEASE.md.
 */
var RELEASE_FEED = {
	baseUrl: 'https://releases.zeroagent.mvplean.com',
	latestManifestPath: '/latest-mac.yml',
	stable: {
		arm64: '/latest/ZeroAgent-arm64.dmg',
		x64: '/latest/ZeroAgent-x64.dmg'
	}
};

(function () {
	'use strict';

	function setText(id, text) {
		var el = document.getElementById(id);
		if (el) el.textContent = text;
	}

	// Minimal reader for electron-builder's latest-mac.yml shape: flat
	// top-level "key: value" pairs plus one "files:" list of "- url" blocks
	// each followed by indented "sha512:" / "sha256:" / "size:" fields. This
	// is not a general YAML parser and is not meant to be one; it returns
	// null on anything it does not recognize so the caller can degrade.
	function parseLatestMacYml(text) {
		try {
			var lines = text.split('\n');
			var result = { files: [] };
			var currentFile = null;

			for (var i = 0; i < lines.length; i++) {
				var line = lines[i];
				if (!line.trim() || line.trim().indexOf('#') === 0) continue;

				var fileItemMatch = line.match(/^\s*-\s+url:\s*(.+?)\s*$/);
				if (fileItemMatch) {
					currentFile = { url: fileItemMatch[1] };
					result.files.push(currentFile);
					continue;
				}

				var fileFieldMatch = line.match(/^\s{4,}(\w+):\s*(.+?)\s*$/);
				if (fileFieldMatch && currentFile) {
					currentFile[fileFieldMatch[1]] = fileFieldMatch[2];
					continue;
				}

				var topMatch = line.match(/^(\w+):\s*(.+?)\s*$/);
				if (topMatch) {
					currentFile = null;
					result[topMatch[1]] = topMatch[2].replace(/^['"]|['"]$/g, '');
				}
			}

			return result.version ? result : null;
		} catch (err) {
			return null;
		}
	}

	function findArchFile(files, arch, ext) {
		if (!files) return null;
		for (var i = 0; i < files.length; i++) {
			var url = files[i].url || '';
			if (url.indexOf('-' + arch + '.' + ext) !== -1) return files[i];
		}
		return null;
	}

	function formatDate(iso) {
		try {
			var d = new Date(iso);
			if (isNaN(d.getTime())) return null;
			return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
		} catch (err) {
			return null;
		}
	}

	function applyHash(idPrefix, file) {
		if (file && file.sha512) {
			setText(idPrefix + '-hash', 'SHA-512: ' + file.sha512);
		} else if (file && file.sha256) {
			setText(idPrefix + '-hash', 'SHA-256: ' + file.sha256);
		} else {
			setText(idPrefix + '-hash', 'Checksum unavailable.');
		}
	}

	function init() {
		// The buttons' hrefs are static in the HTML (ZA-165): the counted
		// redirect at /zeroagent/download/arm64 and /zeroagent/download/x64,
		// so the link works with JavaScript off and a copied link is
		// counted too. This script only reads the feed for the version text
		// and the checksums now; it never rewrites a button's href.
		var manifestUrl = RELEASE_FEED.baseUrl + RELEASE_FEED.latestManifestPath;
		var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
		var timeoutId = controller ? setTimeout(function () { controller.abort(); }, 6000) : null;

		fetch(manifestUrl, controller ? { signal: controller.signal } : {})
			.then(function (res) {
				if (!res.ok) throw new Error('release feed returned ' + res.status);
				return res.text();
			})
			.then(function (text) {
				var manifest = parseLatestMacYml(text);
				if (!manifest) throw new Error('unrecognized release feed format');

				setText('za-version', 'v' + manifest.version);
				window.ZA_RELEASE_VERSION = manifest.version;
				var releaseDate = formatDate(manifest.releaseDate);
				setText('za-release-date', releaseDate || 'unknown');

				var arm64Dmg = findArchFile(manifest.files, 'arm64', 'dmg');
				var x64Dmg = findArchFile(manifest.files, 'x64', 'dmg');

				applyHash('za-arm64', arm64Dmg);
				applyHash('za-x64', x64Dmg);
			})
			.catch(function () {
				setText('za-version', 'Version unavailable');
				setText('za-release-date', 'unavailable');
				setText('za-arm64-hash', 'Checksum unavailable.');
				setText('za-x64-hash', 'Checksum unavailable.');
			})
			.then(function () {
				if (timeoutId) clearTimeout(timeoutId);
			});
	}

	document.addEventListener('DOMContentLoaded', function () {
		init();
	});
})();
