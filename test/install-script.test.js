import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('/install.sh is a Bash installer that uses apt for the counted deb', async () => {
	const script = await readFile(new URL('../install.sh', import.meta.url), 'utf8');
	assert.ok(script.startsWith('#!/usr/bin/env bash\n'));
	assert.match(script, /set -euo pipefail/);
	assert.match(script, /https:\/\/zeroagenthq\.com\/download\/linux\/x64/);
	assert.match(script, /sudo apt install -y/);
});
