/*
 * Best-effort Mac architecture detection for the /zeroagent/download/ page.
 * Badges the Apple Silicon or Intel card as recommended; both download
 * buttons stay visible and working regardless of whether detection succeeds.
 */
(function () {
	'use strict';

	function detectArch() {
		try {
			var canvas = document.createElement('canvas');
			var gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
			if (!gl) return null;

			var ext = gl.getExtension('WEBGL_debug_renderer_info');
			if (!ext) return null;

			var renderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '';
			if (/Apple M\d/i.test(renderer) || /Apple GPU/i.test(renderer)) return 'arm64';
			if (/Intel/i.test(renderer) || /AMD/i.test(renderer) || /Radeon/i.test(renderer)) return 'x64';
			return null;
		} catch (err) {
			return null;
		}
	}

	document.addEventListener('DOMContentLoaded', function () {
		if (!/Mac/i.test(navigator.platform || '')) return;

		var arch = detectArch();
		if (!arch) return;

		var cardId = arch === 'arm64' ? 'za-card-arm64' : 'za-card-x64';
		var card = document.getElementById(cardId);
		if (!card) return;

		card.classList.add('za-recommended');

		var badge = document.createElement('span');
		badge.className = 'za-badge-recommended';
		badge.textContent = 'Recommended for your Mac';

		var heading = card.querySelector('h4');
		if (heading) heading.insertAdjacentElement('afterend', badge);
	});
})();
