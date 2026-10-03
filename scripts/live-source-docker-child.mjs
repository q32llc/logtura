import { spawnSync } from 'node:child_process';
// Started with rehearsal-child-gate.mjs: the parent saves this PID before
// releasing stdin. Credentials are inherited in env, never command arguments.
const args = JSON.parse(process.env.LOGT_CANARY_DOCKER_ARGS ?? 'null');
if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string'))
    throw new Error('Invalid Docker canary arguments');
const timeout = Number(process.env.LOGT_CANARY_DOCKER_TIMEOUT ?? 30000);
if (![30000, 240000].includes(timeout))
    throw new Error('Invalid Docker canary timeout');
delete process.env.LOGT_CANARY_DOCKER_ARGS;
delete process.env.LOGT_CANARY_DOCKER_TIMEOUT;
const result = spawnSync('docker', args, { stdio: 'inherit', timeout });
process.exitCode = result.status ?? 1;
