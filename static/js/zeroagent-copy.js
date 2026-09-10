/*
 * Click-to-copy for any element carrying data-copy-target: clicking it
 * copies the target element's text (a code snippet, usually itself) to the
 * clipboard and shows "Copied" briefly. Shared by the /zeroagent/ landing
 * hero's cask line and the /zeroagent/download/ Homebrew snippet.
 */
(function () {
	'use strict';

	function copyToClipboard(text, el) {
		if (!navigator.clipboard) return;
		navigator.clipboard.writeText(text).then(function () {
			var original = el.textContent;
			el.textContent = 'Copied';
			setTimeout(function () { el.textContent = original; }, 1500);
		});
	}

	document.addEventListener('DOMContentLoaded', function () {
		var copyButtons = document.querySelectorAll('[data-copy-target]');
		for (var i = 0; i < copyButtons.length; i++) {
			(function (btn) {
				btn.addEventListener('click', function () {
					var targetEl = document.getElementById(btn.getAttribute('data-copy-target'));
					if (targetEl) copyToClipboard(targetEl.textContent, btn);
				});
			})(copyButtons[i]);
		}
	});
})();
