(function () {
	'use strict';

	var TOKEN_KEY = 'zaDownloadStatsToken';
	var gate = document.getElementById('gate');
	var main = document.getElementById('main');
	var gateForm = document.getElementById('gate-form');
	var gateToken = document.getElementById('gate-token');
	var gateError = document.getElementById('gate-error');
	var statusLine = document.getElementById('status-line');
	var daysSelect = document.getElementById('days');
	var tooltip = document.getElementById('tooltip');

	function esc(s) {
		var d = document.createElement('div');
		d.textContent = s == null ? '' : String(s);
		return d.innerHTML;
	}

	function fmtInt(n) {
		return (n || 0).toLocaleString();
	}

	function fmtDateTime(ts, fallbackDate) {
		var d = ts ? new Date(ts) : null;
		if (!d || isNaN(d.getTime())) return fallbackDate || '—';
		var pad = function (n) { return n < 10 ? '0' + n : String(n); };
		return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) +
			' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
	}

	function getToken() {
		try { return sessionStorage.getItem(TOKEN_KEY); } catch (e) { return null; }
	}

	function setToken(t) {
		try { sessionStorage.setItem(TOKEN_KEY, t); } catch (e) { /* ignore */ }
	}

	function clearToken() {
		try { sessionStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ }
	}

	function showGate(message) {
		main.hidden = true;
		gate.hidden = false;
		gateError.textContent = message || '';
		gateToken.focus();
	}

	function showMain() {
		gate.hidden = true;
		main.hidden = false;
	}

	function renderTiles(data) {
		var tiles = document.getElementById('tiles');
		var pct = data.total ? Math.round((data.humans / data.total) * 100) : 0;
		tiles.innerHTML = [
			['Total downloads', fmtInt(data.total)],
			['Humans', fmtInt(data.humans) + (data.total ? ' (' + pct + '%)' : '')],
			['Bots & tools', fmtInt(data.bots)],
		].map(function (pair) {
			return '<div class="tile"><div class="n">' + esc(pair[1]) + '</div><div class="l">' + esc(pair[0]) + '</div></div>';
		}).join('');
	}

	function positionTooltip(evt, text) {
		tooltip.textContent = text;
		tooltip.style.display = 'block';
		var x = evt.clientX + 14;
		var y = evt.clientY + 14;
		tooltip.style.left = x + 'px';
		tooltip.style.top = y + 'px';
	}

	function hideTooltip() {
		tooltip.style.display = 'none';
	}

	// The endpoint only returns days that actually had events, so a window
	// with one day of data would draw one bar filling the whole chart. This
	// fills in the rest of the selected window, ending today (UTC), with
	// zero-count days so the width always reads as the window, not the data.
	function fillDayGaps(byDay, days) {
		var counts = {};
		(byDay || []).forEach(function (d) { counts[d.date] = d.count; });

		var n = parseInt(days, 10);
		if (!isFinite(n) || n < 1) n = (byDay && byDay.length) || 1;

		var end = new Date();
		end.setUTCHours(0, 0, 0, 0);

		var out = [];
		for (var i = n - 1; i >= 0; i--) {
			var key = new Date(end.getTime() - i * 86400000).toISOString().slice(0, 10);
			out.push({ date: key, count: counts[key] || 0 });
		}
		return out;
	}

	function renderDayChart(byDay) {
		var chart = document.getElementById('daychart');
		var axis = document.getElementById('day-axis');
		var empty = document.getElementById('daychart-empty');
		var wrap = document.getElementById('daychart-wrap');
		chart.innerHTML = '';
		axis.innerHTML = '';

		if (!byDay || !byDay.length) {
			wrap.hidden = true;
			empty.hidden = false;
			return;
		}
		wrap.hidden = false;
		empty.hidden = true;

		var filled = fillDayGaps(byDay, daysSelect.value);
		var max = filled.reduce(function (m, d) { return Math.max(m, d.count); }, 0) || 1;

		filled.forEach(function (d) {
			var col = document.createElement('div');
			col.className = 'col';
			var bar = document.createElement('div');
			bar.className = 'bar';
			bar.tabIndex = 0;
			bar.style.height = d.count ? (Math.max(2, Math.round((d.count / max) * 100)) + '%') : '0%';
			var label = d.date + ': ' + fmtInt(d.count) + (d.count === 1 ? ' download' : ' downloads');
			bar.setAttribute('aria-label', label);
			bar.addEventListener('mousemove', function (e) { positionTooltip(e, label); });
			bar.addEventListener('mouseleave', hideTooltip);
			bar.addEventListener('focus', function (e) {
				var r = bar.getBoundingClientRect();
				positionTooltip({ clientX: r.left, clientY: r.top }, label);
			});
			bar.addEventListener('blur', hideTooltip);
			col.appendChild(bar);
			chart.appendChild(col);
		});

		var first = filled[0].date;
		var last = filled[filled.length - 1].date;
		axis.innerHTML = '<span>' + esc(first) + '</span><span>' + esc(last) + '</span>';
	}

	function renderBarlist(containerId, counts) {
		var el = document.getElementById(containerId);
		var entries = Object.keys(counts || {}).map(function (k) {
			return [k, counts[k]];
		}).sort(function (a, b) { return b[1] - a[1]; });

		if (!entries.length) {
			el.innerHTML = '<div class="empty" style="padding:14px;">No data yet.</div>';
			return;
		}

		var max = entries[0][1] || 1;
		el.innerHTML = entries.map(function (pair) {
			var pct = Math.max(4, Math.round((pair[1] / max) * 100));
			return '<div class="barrow">' +
				'<div class="name" title="' + esc(pair[0]) + '">' + esc(pair[0]) + '</div>' +
				'<div class="track"><div class="fill" style="width:' + pct + '%"></div></div>' +
				'<div class="count">' + fmtInt(pair[1]) + '</div>' +
				'</div>';
		}).join('');
	}

	function renderLast(rows) {
		var body = document.getElementById('last-body');
		var empty = document.getElementById('last-empty');
		var wrap = document.querySelector('.table-wrap');

		if (!rows || !rows.length) {
			wrap.hidden = true;
			empty.hidden = false;
			return;
		}
		wrap.hidden = false;
		empty.hidden = true;

		body.innerHTML = rows.map(function (r) {
			return '<tr>' +
				'<td>' + esc(fmtDateTime(r.ts, r.date)) + '</td>' +
				'<td class="arch">' + esc(r.arch) + '</td>' +
				'<td>' + esc(r.version) + '</td>' +
				'<td>' + esc(r.country || 'unknown') + '</td>' +
				'<td>' + esc(r.city || '—') + '</td>' +
				'<td>' + esc(r.browser || 'unknown') + '</td>' +
				'<td>' + esc(r.os || 'unknown') + '</td>' +
				'<td>' + esc(r.referrer || 'direct') + '</td>' +
				'</tr>';
		}).join('');
	}

	function render(data) {
		renderTiles(data);
		renderDayChart(data.byDay);
		renderBarlist('by-arch', data.byArch);
		renderBarlist('by-version', data.byVersion);
		renderBarlist('by-country', data.byCountry);
		renderBarlist('by-browser', data.byBrowser);
		renderBarlist('by-os', data.byOs);
		renderLast(data.last);
		statusLine.textContent = fmtInt(data.total) + ' event' + (data.total === 1 ? '' : 's') +
			' in the last ' + daysSelect.value + ' days.';
	}

	function load() {
		var token = getToken();
		if (!token) { showGate(); return; }

		statusLine.textContent = 'Loading…';
		fetch('/api/download-stats?days=' + encodeURIComponent(daysSelect.value), {
			headers: { Authorization: 'Bearer ' + token },
		}).then(function (res) {
			if (res.status === 401) {
				clearToken();
				showGate('Token rejected. Try again.');
				return null;
			}
			if (!res.ok) throw new Error('stats endpoint returned ' + res.status);
			return res.json();
		}).then(function (data) {
			if (!data) return;
			showMain();
			render(data);
		}).catch(function (err) {
			statusLine.textContent = 'Could not load stats: ' + err.message;
		});
	}

	gateForm.addEventListener('submit', function (e) {
		e.preventDefault();
		var value = gateToken.value.trim();
		if (!value) return;
		setToken(value);
		load();
	});

	document.getElementById('refresh').addEventListener('click', load);
	document.getElementById('signout').addEventListener('click', function () {
		clearToken();
		showGate();
	});
	daysSelect.addEventListener('change', load);

	load();
})();
