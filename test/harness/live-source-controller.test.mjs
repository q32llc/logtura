import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
for (const version of ['0.3.0', '0.3.1']) test(`a killed Docker child fails before provider dispatch for release ${version}`, async () => {
    const temporary = mkdtempSync(join(tmpdir(), 'logtura-live-controller-'));
    let ledger;
    try {
        const packages = {
            core: 'export const generateBundle=()=>({envVars:[],vectorYaml:"fixture"}); export const selfDeployFiles=()=>[];',
            'driver-cloudflare-worker-tail': 'export const cloudflareWorkerTailDriver={id:"cloudflare-worker-tail"};',
            'destination-webhook': 'export const webhookDriver={id:"webhook"};',
        };
        for (const [name, source] of Object.entries(packages)) {
            const directory = join(temporary, 'node_modules/@logtura', name);
            mkdirSync(join(directory, 'dist'), { recursive: true });
            writeFileSync(join(directory, 'package.json'), JSON.stringify({
                name: `@logtura/${name}`, version, type: 'module'
            }));
            writeFileSync(join(directory, 'dist/index.js'), source);
        }
        const marker = join(temporary, 'docker-started'), network = join(temporary, 'network-dispatch');
        writeFileSync(join(temporary, 'docker'), '#!/bin/sh\nif [ ! -f "$LOGT_TEST_MARKER" ]; then touch "$LOGT_TEST_MARKER"; kill -KILL "$PPID"; fi\nexit 0\n', { mode: 0o700 });
        const guard = join(temporary, 'no-network.mjs');
        writeFileSync(guard, 'import {writeFileSync} from "node:fs"; globalThis.fetch=async()=>{writeFileSync(process.env.LOGT_TEST_NETWORK,"unexpected");throw new Error("Forbidden provider dispatch");};');
        const child = spawn(process.execPath, ['--import', 'tsx', resolve('scripts/e2e-live-source.mjs')], { env: {
                ...process.env, PATH: `${temporary}:${process.env.PATH}`, NODE_OPTIONS: `--import=${pathToFileURL(guard).href}`, LOGT_E2E_ALLOW_CLOUDFLARE: '1', LOGT_E2E_LIVE_CONSUMER: temporary, LOGT_E2E_LIVE_VERSION: version, BOOTSTRAP_CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), BOOTSTRAP_CLOUDFLARE_API_TOKEN: 'fixture-not-a-credential', LOGT_TEST_MARKER: marker, LOGT_TEST_NETWORK: network
            }, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        child.stdout.on('data', chunk => output += chunk);
        child.stderr.on('data', chunk => output += chunk);
        const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
        const code = await new Promise((accept, reject) => {
            child.once('error', reject);
            child.once('close', accept);
        });
        clearTimeout(timer);
        const match = /Live source private ledger: (.+)/.exec(output);
        assert.ok(match);
        ledger = match[1];
        assert.ok(ledger.startsWith(resolve('.tmp/live-source-canary') + '/run-'));
        assert.equal(code, 1);
        assert.match(output, /preflight-container failed/);
        assert.equal(existsSync(network), false);
        const state = JSON.parse(readFileSync(join(ledger, 'run.json'), 'utf8'));
        assert.equal(state.outcome, 'failed');
        assert.equal(state.version, version);
        assert.equal(state.requests, 0);
        assert.equal(state.worker, 'absent');
        assert.equal(state.childPid, null);
        assert.equal(state.container, 'deleted');
        assert.equal(state.image, 'deleted');
    }
    finally {
        rmSync(temporary, { recursive: true, force: true });
        if (ledger?.startsWith(resolve('.tmp/live-source-canary') + '/run-'))
            rmSync(ledger, { recursive: true, force: true });
    }
});

for (const scenario of ['malformed', 'mixed']) test(`${scenario} release selection fails before any Docker or provider dispatch`, async () => {
    const temporary = mkdtempSync(join(tmpdir(), 'logtura-live-version-'));
    try {
        const marker = join(temporary, 'unexpected-dispatch');
        const guard = join(temporary, 'no-network.mjs');
        writeFileSync(guard, 'import {writeFileSync} from "node:fs"; globalThis.fetch=async()=>{writeFileSync(process.env.LOGT_TEST_NETWORK,"unexpected");throw new Error("Forbidden provider dispatch");};');
        writeFileSync(join(temporary, 'docker'), '#!/bin/sh\ntouch "$LOGT_TEST_NETWORK"\nexit 1\n', { mode: 0o700 });
        for (const name of ['core', 'driver-cloudflare-worker-tail', 'destination-webhook']) {
            const directory = join(temporary, 'node_modules/@logtura', name);
            mkdirSync(directory, { recursive: true });
            writeFileSync(join(directory, 'package.json'), JSON.stringify({name: `@logtura/${name}`, version: '0.3.0'}));
        }
        const child = spawn(process.execPath, ['--import', 'tsx', resolve('scripts/e2e-live-source.mjs')], { env: {
            ...process.env, PATH: `${temporary}:${process.env.PATH}`, NODE_OPTIONS: `--import=${pathToFileURL(guard).href}`,
            LOGT_E2E_ALLOW_CLOUDFLARE: '1', LOGT_E2E_LIVE_CONSUMER: temporary,
            LOGT_E2E_LIVE_VERSION: scenario === 'malformed' ? 'latest' : '0.3.1', LOGT_TEST_NETWORK: marker
        }, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        child.stdout.on('data', chunk => output += chunk);
        child.stderr.on('data', chunk => output += chunk);
        const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
        const code = await new Promise((accept, reject) => {child.once('error', reject);child.once('close', accept);});
        clearTimeout(timer);
        assert.equal(code, 1);
        assert.match(output, scenario === 'malformed' ? /stable release/ : /match the selected release/);
        assert.doesNotMatch(output, /Live source private ledger:/);
        assert.equal(existsSync(marker), false);
    } finally { rmSync(temporary, {recursive: true, force: true}); }
});
