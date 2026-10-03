import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
test('Docker waits for the durable parent gate and propagates the real child exit', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'logtura-docker-gate-'));
    const marker = join(directory, 'dispatched');
    writeFileSync(join(directory, 'docker'), '#!/bin/sh\nprintf "%s" "$1" > "$LOGT_TEST_MARKER"\nexit 7\n', { mode: 0o700 });
    const child = spawn(process.execPath, ['--import', resolve('scripts/rehearsal-child-gate.mjs'), resolve('scripts/live-source-docker-child.mjs')], { env: { ...process.env, PATH: directory, LOGT_TEST_MARKER: marker, LOGT_CANARY_DOCKER_ARGS: JSON.stringify(['inspect', 'fixture']), LOGT_CANARY_DOCKER_TIMEOUT: '30000' }, stdio: ['pipe', 'ignore', 'pipe'] });
    const completed = new Promise((accept, reject) => { child.once('error', reject); child.once('close', accept); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
        await new Promise(resolve => setTimeout(resolve, 150));
        assert.equal(existsSync(marker), false);
        child.stdin.end('go\n');
        assert.equal(await completed, 7);
        assert.equal(readFileSync(marker, 'utf8'), 'inspect');
    }
    finally {
        clearTimeout(timer);
        child.kill('SIGKILL');
        rmSync(directory, { recursive: true, force: true });
    }
});
