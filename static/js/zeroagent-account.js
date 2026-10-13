// ZA-900. Minimal signed-in landing: asks /api/account/session who the
// browser is, shows sign-in or sign-out. The session itself is an HttpOnly
// cookie this script never sees; only the CSRF token is held, in memory.
(function () {
	var status = document.getElementById('za-account-status');
	var errorEl = document.getElementById('za-account-error');
	var signIn = document.getElementById('za-account-signin');
	var signOut = document.getElementById('za-account-signout');
	var csrfToken = null;

	var messages = {
		access_denied: 'GitHub sign-in was cancelled.',
		invalid_state: 'That sign-in link is no longer valid. Please try again.',
		invalid_request: 'Sign-in did not complete. Please try again.',
		github_rejected: 'GitHub did not accept the sign-in. Please try again.',
		github_error: 'GitHub reported a problem. Please try again.',
		github_unavailable: 'GitHub is not reachable right now. Please try again shortly.',
		unavailable: 'Sign-in is unavailable right now. Please try again shortly.'
	};

	var code = new URLSearchParams(window.location.search).get('signin_error');
	if (code) {
		errorEl.textContent = messages[code] || 'Sign-in did not complete. Please try again.';
		errorEl.hidden = false;
	}

	function showSignedOut() {
		status.textContent = 'You are signed out.';
		signIn.hidden = false;
		signOut.hidden = true;
	}

	fetch('/api/account/session', { credentials: 'same-origin', cache: 'no-store' })
		.then(function (res) {
			if (!res.ok) throw new Error('signed_out');
			return res.json();
		})
		.then(function (data) {
			csrfToken = data.csrfToken;
			status.textContent = 'Signed in as ' + data.login + '.';
			signOut.hidden = false;
		})
		.catch(showSignedOut);

	signOut.addEventListener('click', function () {
		signOut.disabled = true;
		fetch('/api/auth/logout', {
			method: 'POST',
			credentials: 'same-origin',
			headers: { 'X-CSRF-Token': csrfToken || '' }
		}).then(function () {
			signOut.disabled = false;
			signOut.hidden = true;
			csrfToken = null;
			showSignedOut();
		});
	});
})();
