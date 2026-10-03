import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { validateLiveSourceCanary, assertLiveSourceOwnership, assertLiveSourceAbsence } from '../../scripts/live-source-canary-state.mjs';
const account = 'a'.repeat(32);
const fixture = () => { const nonce = randomUUID(); return { schema: 1, account, nonce, name: `logtura-canary-${nonce.replaceAll('-', '')}`, worker: 'uploaded', container: 'started', image: 'built', childPid: null, freshNamesVerified: true }; };
test('cleanup rejects cross-account, renamed and malformed ledgers', () => {
    const state = fixture();
    assert.equal(validateLiveSourceCanary(state, account), state);
    assert.throws(() => validateLiveSourceCanary(state, 'b'.repeat(32)), /account mismatch/);
    for (const patch of [{ name: 'logtura' }, { nonce: 'not-a-run' }, { worker: 'unknown' }, { container: 'running' }, { image: 'lost' }, { childPid: 1 }])
        assert.throws(() => validateLiveSourceCanary({ ...state, ...patch }, account));
});
test('absence does not resolve an uncertain dispatched mutation', () => {
    const state = fixture();
    for (const [kind, phase] of Object.entries({ worker: 'uploading', container: 'starting', image: 'building' })) {
        assert.throws(() => assertLiveSourceAbsence(kind, { ...state, [kind]: phase }), /Unresolved/);
        for (const known of ['absent', 'deleted', state[kind]])
            assertLiveSourceAbsence(kind, { ...state, [kind]: known });
    }
    assert.throws(() => assertLiveSourceAbsence('database', state), /Unsupported/);
});
test('matching names alone never authorize cloud or Docker deletion', () => {
    const state = fixture();
    assert.throws(() => assertLiveSourceOwnership('worker', state, { bindings: [] }));
    assert.throws(() => assertLiveSourceOwnership('worker', state, { bindings: [{ name: 'LOGT_CANARY_OWNER', type: 'plain_text', text: randomUUID() }] }));
    assertLiveSourceOwnership('worker', state, { bindings: [{ name: 'LOGT_CANARY_OWNER', type: 'plain_text', text: state.nonce }] });
    assert.throws(() => assertLiveSourceOwnership('worker', { ...state, freshNamesVerified: false }, { bindings: [{ name: 'LOGT_CANARY_OWNER', type: 'plain_text', text: state.nonce }] }));
    assert.throws(() => assertLiveSourceOwnership('worker', { ...state, worker: 'absent' }, { bindings: [{ name: 'LOGT_CANARY_OWNER', type: 'plain_text', text: state.nonce }] }));
    for (const kind of ['container', 'image']) {
        const resource = kind === 'container' ? { Name: `/${state.name}` } : { RepoTags: [`${state.name}:latest`] };
        assert.throws(() => assertLiveSourceOwnership(kind, state, resource));
        assert.throws(() => assertLiveSourceOwnership(kind, state, { ...resource, Config: { Labels: { 'logtura-canary': randomUUID() } } }));
        assertLiveSourceOwnership(kind, state, { ...resource, Config: { Labels: { 'logtura-canary': state.nonce } } });
        assert.throws(() => assertLiveSourceOwnership(kind, state, { ...resource, Name: '/other', RepoTags: ['other:latest'], Config: { Labels: { 'logtura-canary': state.nonce } } }));
    }
    assert.throws(() => assertLiveSourceOwnership('database', state, {}), /Unsupported/);
});
