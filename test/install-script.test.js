import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('/install.sh is a POSIX sh installer that uses apt for the counted deb', async () => {
	const script = await readFile(new URL('../install.sh', import.meta.url), 'utf8');
	assert.ok(script.startsWith('#!/bin/sh\n'));
	assert.match(script, /set -eu\n/);
	assert.doesNotMatch(script, /\[\[/);
	assert.doesNotMatch(script, /pipefail/);
	assert.match(script, /https:\/\/zeroagenthq\.com\/download\/linux\/x64/);
	assert.match(script, /apt install -y/);
});

test('/install.sh documents install, update and uninstall in its header', async () => {
	const script = await readFile(new URL('../install.sh', import.meta.url), 'utf8');
	assert.match(script, /curl -fsSL https:\/\/zeroagenthq\.com\/install\.sh \| sh/);
	assert.match(script, /sh -s -- --uninstall/);
});

test('/install.sh supports --uninstall and rejects unknown arguments', async () => {
	const script = await readFile(new URL('../install.sh', import.meta.url), 'utf8');
	assert.match(script, /--uninstall\)/);
	assert.match(script, /apt remove -y zeroagent/);
	assert.match(script, /Usage: install\.sh/);
});