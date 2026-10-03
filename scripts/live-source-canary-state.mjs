import assert from 'node:assert/strict';
/** A Worker-only ledger must never acquire ownership from a matching name alone. */
export function validateLiveSourceCanary(state, account) {
    assert.ok(state && state.schema === 1, 'Invalid live source ledger');
    assert.match(account, /^[a-f0-9]{32}$/);
    assert.equal(state.account, account, 'Live source account mismatch');
    assert.match(state.nonce, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    assert.equal(state.name, `logtura-canary-${state.nonce.replaceAll('-', '')}`);
    for (const key of ['worker', 'container', 'image']) {
        const phases = {
            worker: ['absent', 'uploading', 'uploaded', 'deleted'],
            container: ['absent', 'starting', 'started', 'deleted'],
            image: ['absent', 'building', 'built', 'deleted'],
        };
        assert.ok(phases[key].includes(state[key]), `Invalid ${key} phase`);
    }
    assert.ok(state.childPid == null || Number.isSafeInteger(state.childPid) && state.childPid > 1);
    assert.equal(typeof state.freshNamesVerified, 'boolean');
    return state;
}
export function assertLiveSourceOwnership(kind, state, resource) {
    validateLiveSourceCanary(state, state.account);
    assert.equal(state.freshNamesVerified, true, 'Fresh resource names were not proved');
    assert.notEqual(state[kind], 'absent', 'Undispatched resource is not owned');
    if (kind === 'worker') {
        assert.ok(resource.bindings?.some(binding => binding.name === 'LOGT_CANARY_OWNER' &&
            binding.type === 'plain_text' && binding.text === state.nonce), 'Worker ownership mismatch; deletion refused');
    }
    else if (kind === 'container') {
        assert.equal(resource.Name, `/${state.name}`, 'Container name mismatch');
        assert.equal(resource.Config?.Labels?.['logtura-canary'], state.nonce, 'Container ownership mismatch');
    }
    else if (kind === 'image') {
        assert.ok(resource.RepoTags?.includes(`${state.name}:latest`), 'Image name mismatch');
        assert.equal(resource.Config?.Labels?.['logtura-canary'], state.nonce, 'Image ownership mismatch');
    }
    else {
        throw new Error('Unsupported canary ownership check');
    }
}
export function assertLiveSourceAbsence(kind, state) {
    validateLiveSourceCanary(state, state.account);
    const pending = { worker: 'uploading', container: 'starting', image: 'building' };
    assert.ok(Object.hasOwn(pending, kind), 'Unsupported absence check');
    assert.notEqual(state[kind], pending[kind], `Unresolved ${kind} dispatch; retain the ledger for investigation`);
}
