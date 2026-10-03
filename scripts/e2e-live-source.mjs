import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, renameSync, openSync, fsyncSync, closeSync, lstatSync, realpathSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { validateLiveSourceCanary, assertLiveSourceOwnership, assertLiveSourceAbsence } from './live-source-canary-state.mjs';
import { withPrivateDirectoryLock } from '../packages/cli/src/private-lock.ts';
if (process.env.LOGT_E2E_ALLOW_CLOUDFLARE !== '1')
    throw new Error('Set LOGT_E2E_ALLOW_CLOUDFLARE=1 for the live source canary');
const cleanupOnly = process.argv.includes('--cleanup');
if (process.argv.slice(2).some(arg => arg !== '--cleanup'))
    throw new Error('Usage: e2e-live-source.mjs [--cleanup]');
const root = process.cwd(), consumer = resolve(process.env.LOGT_E2E_LIVE_CONSUMER ?? '.tmp/live-source-canary');
const load = name => import(pathToFileURL(join(consumer, 'node_modules/@logtura', name, 'dist/index.js')));
let generateBundle, selfDeployFiles, cloudflareWorkerTailDriver, webhookDriver;
if (!cleanupOnly) {
    for (const name of ['core', 'driver-cloudflare-worker-tail', 'destination-webhook']) {
        const p = join(consumer, 'node_modules/@logtura', name);
        assert.ok(!lstatSync(p).isSymbolicLink(), 'Use registry-installed packages, not workspace links');
        assert.equal(JSON.parse(readFileSync(join(p, 'package.json'), 'utf8')).version, '0.3.0');
    }
    ({ generateBundle, selfDeployFiles } = await load('core'));
    ({ cloudflareWorkerTailDriver } = await load('driver-cloudflare-worker-tail'));
    ({ webhookDriver } = await load('destination-webhook'));
}
const values = { BOOTSTRAP_CLOUDFLARE_ACCOUNT_ID: process.env.BOOTSTRAP_CLOUDFLARE_ACCOUNT_ID, BOOTSTRAP_CLOUDFLARE_API_TOKEN: process.env.BOOTSTRAP_CLOUDFLARE_API_TOKEN };
for (const line of (existsSync('.env') ? readFileSync('.env', 'utf8') : '').split('\n')) {
    const m = line.match(/^\s*(BOOTSTRAP_CLOUDFLARE_ACCOUNT_ID|BOOTSTRAP_CLOUDFLARE_API_TOKEN)\s*=\s*(.*?)\s*$/);
    if (m && !values[m[1]])
        values[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
}
const account = values.BOOTSTRAP_CLOUDFLARE_ACCOUNT_ID, token = values.BOOTSTRAP_CLOUDFLARE_API_TOKEN;
assert.match(account, /^[a-f0-9]{32}$/);
assert.ok(token);
const parent = resolve('.tmp/live-source-canary');
mkdirSync(parent, { recursive: true, mode: 0o700 });
if (cleanupOnly && !process.env.LOGT_E2E_LIVE_LEDGER)
    throw new Error('Cleanup requires LOGT_E2E_LIVE_LEDGER pointing to the private run directory');
const directory = cleanupOnly ? realpathSync(process.env.LOGT_E2E_LIVE_LEDGER) : mkdtempSync(join(parent, 'run-'));
const stat = lstatSync(directory);
assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0 && stat.uid === process.getuid(), 'Ledger requires an owned private directory');
let state;
const save = () => {
    validateLiveSourceCanary(state, account);
    const p = join(directory, 'run.json');
    writeFileSync(p + '.stage', JSON.stringify(state, null, 2), { mode: 0o600 });
    const fd = openSync(p + '.stage', 'r');
    fsyncSync(fd);
    closeSync(fd);
    renameSync(p + '.stage', p);
    const dirFd = openSync(directory, 'r');
    fsyncSync(dirFd);
    closeSync(dirFd);
};
await withPrivateDirectoryLock(join(directory, 'run.lock'), async () => {
    if (cleanupOnly) {
        const file = lstatSync(join(directory, 'run.json'));
        assert.ok(file.isFile() && !file.isSymbolicLink() && (file.mode & 0o077) === 0 && file.uid === process.getuid());
        state = JSON.parse(readFileSync(join(directory, 'run.json'), 'utf8'));
        validateLiveSourceCanary(state, account);
        if (state.childPid) {
            try {
                process.kill(state.childPid, 0);
                throw new Error('Canary child is still running; cleanup refused');
            }
            catch (error) {
                if (error.code !== 'ESRCH')
                    throw error;
            }
            state.childPid = null;
        }
    }
    else {
        const nonce = randomUUID();
        state = {
            schema: 1, account, name: 'logtura-canary-' + nonce.replaceAll('-', ''), nonce, version: '0.3.0', startedAt: new Date().toISOString(), worker: 'absent', container: 'absent', image: 'absent', outcome: 'running', freshNamesVerified: false
        };
        save();
    }
    const { name, nonce } = state;
    console.log(`Live source private ledger: ${directory}`);
    const base = `https://api.cloudflare.com/client/v4/accounts/${account}`;
    let requests = 0;
    const apiDeadline = Date.now() + 10 * 60 * 1000;
    async function api(path, init = {}, optional = false) {
        if (++requests > 150 || Date.now() > apiDeadline)
            throw new Error('API budget exhausted');
        const response = await fetch(base + path, {
            ...init, headers: { authorization: `Bearer ${token}`, ...init.headers }, redirect: 'error', signal: AbortSignal.timeout(30000)
        });
        if (optional && response.status === 404) {
            await response.body?.cancel();
            return null;
        }
        if (!response.ok)
            throw new Error(`Owned canary API failed (${response.status})`);
        const body = await response.json();
        if (!body.success)
            throw new Error('Owned canary API rejected');
        return body.result;
    }
    async function command(label, args, allowFailure = false) {
        const child = spawn(process.execPath, ['--import', resolve('scripts/rehearsal-child-gate.mjs'), resolve('scripts/live-source-docker-child.mjs')], { env: {
                ...process.env, LOGT_CANARY_DOCKER_ARGS: JSON.stringify(args), LOGT_CANARY_DOCKER_TIMEOUT: String(label === 'build' ? 240000 : 30000)
            }, stdio: ['pipe', 'pipe', 'pipe'] });
        state.childPid = child.pid;
        state.childOperation = label;
        save();
        child.stdin.on('error', () => {
        });
        child.stdin.end('go\n');
        let out = '';
        child.stdout.on('data', b => out += b);
        child.stderr.on('data', b => out += b);
        const timer = setTimeout(() => child.kill('SIGKILL'), label === 'build' ? 245000 : 35000);
        const result = await new Promise((accept, reject) => {
            child.once('error', reject);
            child.once('close', (code, signal) => accept({ code, signal }));
        });
        clearTimeout(timer);
        state.childPid = null;
        save();
        writeFileSync(join(directory, label + '.log'), out.replaceAll(token, '[redacted]').slice(-60000), { mode: 0o600 });
        if (result.code !== 0 && !allowFailure)
            throw new Error(`${label} failed; private diagnostic retained`);
        return { out, code: result.code };
    }
    const deliveries = [];
    const server = createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) {
            body += chunk;
            if (body.length > 1048576) {
                res.writeHead(413);
                res.end();
                return;
            }
        }
        try {
            const decoded = JSON.parse(body);
            deliveries.push(...(Array.isArray(decoded) ? decoded : [decoded]));
            res.writeHead(200);
            res.end('ok');
        }
        catch {
            res.writeHead(400);
            res.end();
        }
    });
    let failure;
    try {
        if (!cleanupOnly) {
            await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
            const bundle = generateBundle({
                providers: [cloudflareWorkerTailDriver], destinations: [webhookDriver], connections: [{
                        connection: {
                            id: 'con_canary', provider: cloudflareWorkerTailDriver.id, displayName: 'Owned canary', externalAccountId: account
                        }, credentials: { apiToken: token }, selectedSources: [{
                                id: 'src_canary', externalId: name, displayName: name, sourceKind: 'cf_worker', metadata: null
                            }]
                    }], monitors: [{ monitor: {
                            id: 'mon_canary', connectionId: 'con_canary', displayName: 'Owned logs', filterSteps: [], enabled: true
                        }, sinks: [{
                                sink: { id: 'sink_canary', filterSteps: [] }, destination: {
                                    id: 'dest_canary', kind: 'webhook', displayName: 'Owned receiver'
                                }, destinationConfig: { url: `http://127.0.0.1:${server.address().port}/events` }
                            }] }]
            });
            const context = join(directory, 'context');
            mkdirSync(context, { mode: 0o700 });
            for (const file of selfDeployFiles(bundle)) {
                const p = join(context, file.name);
                mkdirSync(resolve(p, '..'), { recursive: true, mode: 0o700 });
                writeFileSync(p, file.content, { mode: file.mode ?? 0o600 });
            }
            for (const variable of bundle.envVars) {
                if (typeof variable.value === 'string')
                    process.env[variable.name] = String(variable.value);
            }
            assert.ok(!bundle.vectorYaml.includes(token), 'Generated configuration must reference environment credentials');
            assert.equal((await command('preflight-container', ['container', 'ls', '--all', '--filter', `name=^/${name}$`, '--format', '{{.Names}}'])).out.trim(), '');
            assert.equal((await command('preflight-image', ['image', 'ls', '--filter', `reference=${name}:latest`, '--format', '{{.ID}}'])).out.trim(), '');
            assert.equal(await api(`/workers/scripts/${name}/settings`, {}, true), null);
            state.freshNamesVerified = true;
            save();
            state.image = 'building';
            save();
            await command('build', ['build', '--quiet', '--label', `logtura-canary=${nonce}`, '--tag', name, context]);
            state.image = 'built';
            save();
            assert.equal(await api(`/workers/scripts/${name}/settings`, {}, true), null);
            const source = `export default {fetch(request,env){const u=new URL(request.url);if(u.pathname!=='/'+env.LOGT_CANARY_OWNER)return new Response('not found',{status:404});console.error('logtura-owned-live-event',env.LOGT_CANARY_OWNER);return new Response('owned canary event');}};`;
            state.sourceDigest = createHash('sha256').update(source).digest('hex');
            const form = new FormData();
            form.set('metadata', JSON.stringify({
                main_module: 'index.js', compatibility_date: '2025-05-01', bindings: [{
                        type: 'plain_text', name: 'LOGT_CANARY_OWNER', text: nonce
                    }], tags: ['logtura-owned-canary', nonce]
            }));
            form.set('index.js', new Blob([source], { type: 'application/javascript+module' }), 'index.js');
            state.worker = 'uploading';
            save();
            await api(`/workers/scripts/${name}`, { method: 'PUT', body: form });
            state.worker = 'uploaded';
            save();
            const settings = await api(`/workers/scripts/${name}/settings`);
            assertLiveSourceOwnership('worker', state, settings);
            const subdomain = await api('/workers/subdomain');
            assert.match(subdomain.subdomain, /^[a-z0-9-]+$/);
            state.subdomain = 'enabling';
            save();
            await api(`/workers/scripts/${name}/subdomain`, {
                method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true })
            });
            state.subdomain = 'enabled';
            save();
            const args = ['run', '--detach', '--name', name, '--label', `logtura-canary=${nonce}`, '--network', 'host', ...bundle.envVars.flatMap(e => ['--env', e.name]), name];
            state.container = 'starting';
            save();
            await command('start', args);
            state.container = 'started';
            save();
            const url = `https://${name}.${subdomain.subdomain}.workers.dev/${nonce}`;
            let invoked = 0;
            const deadline = Date.now() + 120000;
            while (Date.now() < deadline && !deliveries.some(e => JSON.stringify(e).includes(nonce))) {
                try {
                    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10000) });
                    await response.body?.cancel();
                    if (response.status === 200)
                        invoked++;
                }
                catch {
                }
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
            state.invoked = invoked;
            state.matchedDeliveries = deliveries.filter(e => JSON.stringify(e).includes(nonce)).length;
            save();
            await command('runtime-logs', ['logs', name], true);
            if (!state.matchedDeliveries)
                throw new Error('Real Worker event was not delivered within the canary budget');
            const matched = deliveries.filter(e => JSON.stringify(e).includes(nonce));
            for (const event of matched) {
                assert.equal(event.script, name);
                assert.equal(event.level, 'error');
                assert.equal(event.error, true);
                assert.ok(event.message.includes(nonce));
            }
            state.normalizedEventsVerified = matched.length;
            save();
            state.outcome = 'passed';
            save();
            console.log('Published standalone packages delivered a real owned Cloudflare Worker event through Vector to the owned webhook receiver');
        }
    }
    catch (error) {
        failure = error;
        state.outcome = 'failed';
        state.failure = error.message.replaceAll(token, '[redacted]');
        save();
    }
    finally {
        try {
            const containers = await command('cleanup-container-list', ['container', 'ls', '--all', '--filter', `name=^/${name}$`, '--format', '{{.Names}}']);
            if (containers.out.trim()) {
                const inspected = await command('inspect', ['inspect', name]);
                assertLiveSourceOwnership('container', state, JSON.parse(inspected.out)[0]);
                await command('stop', ['stop', '--time', '10', name]);
                await command('remove', ['rm', name]);
            }
            else
                assertLiveSourceAbsence('container', state);
            assert.equal((await command('verify-container-absent', ['container', 'ls', '--all', '--filter', `name=^/${name}$`, '--format', '{{.Names}}'])).out.trim(), '');
            state.container = 'deleted';
            save();
            if (state.worker !== 'absent') {
                const settings = await api(`/workers/scripts/${name}/settings`, {}, true);
                if (settings) {
                    assertLiveSourceOwnership('worker', state, settings);
                    await api(`/workers/scripts/${name}`, { method: 'DELETE' });
                }
                else
                    assertLiveSourceAbsence('worker', state);
                assert.equal(await api(`/workers/scripts/${name}/settings`, {}, true), null);
                state.worker = 'deleted';
                save();
            }
            const images = await command('cleanup-image-list', ['image', 'ls', '--filter', `reference=${name}:latest`, '--format', '{{.ID}}']);
            if (images.out.trim()) {
                const inspected = await command('image-inspect', ['image', 'inspect', name]);
                assertLiveSourceOwnership('image', state, JSON.parse(inspected.out)[0]);
                await command('image-remove', ['image', 'rm', name]);
            }
            else
                assertLiveSourceAbsence('image', state);
            assert.equal((await command('verify-image-absent', ['image', 'ls', '--filter', `reference=${name}:latest`, '--format', '{{.ID}}'])).out.trim(), '');
            state.image = 'deleted';
            save();
            state.cleanedAt = new Date().toISOString();
            state.requests = requests;
            save();
            console.log('Owned canary Worker and Docker resources removed; private receipt retained');
        }
        catch (error) {
            state.cleanupFailure = error.message;
            save();
            failure = new Error('Owned canary cleanup incomplete; retain the private ledger');
        }
        if (server.listening)
            await new Promise(resolve => server.close(resolve));
    }
    if (failure)
        throw failure;
}, 'Live source canary').catch(error => {
    console.error(error.message.replaceAll(token, '[redacted]'));
    process.exitCode = 1;
});
