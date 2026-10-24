import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PassThrough } from 'node:stream';

const reference = resolve(process.env.DSH_REFERENCE_ROOT ?? '../../deepseek-harness');
const require = createRequire(join(reference, 'packages/core/tools/package.json'));
const tools = require.resolve('@deepseek-ai/dsh-tools');
await mkdir('.cache', { recursive: true });
await build({ entryPoints: ['src/index.mjs'], outfile: '.cache/host-probe.mjs', bundle: true, platform: 'node', format: 'esm', target: 'node22',
  plugins: [{ name: 'host-tools', setup(builder) { builder.onResolve({ filter: /^@deepseek-ai\/dsh-tools$/ }, () => ({ path: tools, external: true })); } }] });
const { apply } = await import(pathToFileURL(resolve('.cache/host-probe.mjs')));
const routes = new Map(), definitions = new Map(), disposers = [], events = new Map();
let terminations = 0;
const ctx = {
  effect: register => { const dispose = register(); if (dispose) disposers.push(dispose); },
  on: (name, callback) => events.set(name, callback),
  inject: (names, callback) => { assert.deepEqual(names, ['tools']); callback({ tools: { register: definition => definitions.set(definition.name, definition) } }); },
  connection: { fetch: { register: route => routes.set(route.path, route) } },
  sessions: { get: id => ['a', 'b'].includes(id) ? { id } : undefined },
  subprocess: { spawn: spec => {
    const stdout = new PassThrough(), stderr = new PassThrough(), deferred = Promise.withResolvers();
    queueMicrotask(() => {
      const command = spec.argv.at(-1);
      stdout.end(command.includes('DSH_SSH_READY') ? 'DSH_SSH_READY\ndeploy\nfixture\n/home/deploy\n'
        : command.includes('DSH_HOST_RESOURCES_V1') ? 'DSH_HOST_RESOURCES_V1\nos Linux\nhostname fixture\ncores 2\ncpu 10\nmemory 1024 768\ndisk 4096 1024 3000\nuptime 123\n' : 'host tool result\n');
      stderr.end(); deferred.resolve({ exitCode: 0, signal: null });
    });
    return { stdout, stderr, done: deferred.promise, terminate: () => { terminations++; }, waitForExit: async () => true };
  } },
};
try {
  await apply(ctx);
  assert.deepEqual([...definitions.keys()].sort(), ['ssh_exec', 'ssh_read', 'ssh_status', 'ssh_stop']);
  const request = (action, input, headers = {}) => routes.get(`/api/dsh-ssh/${action}`).fetch(new Request(`http://dsh.internal/api/dsh-ssh/${action}`, { method: 'POST', headers: { host: '127.0.0.1:1234', origin: 'http://127.0.0.1:1234', 'content-type': 'application/json', ...headers }, body: JSON.stringify(input) }));
  assert.equal((await request('authorize', { sessionId: 'missing', host: 'prod' })).status, 400);
  assert.equal((await request('authorize', { sessionId: 'a', host: 'prod' }, { origin: 'http://evil.invalid' })).status, 400);
  const resources = await (await request('resources', { sessionId: 'a', host: 'saved' })).json();
  assert.equal(resources.value.cores, 2);
  assert.equal((await (await request('status', { sessionId: 'a' })).json()).value.state, 'disconnected');
  assert.equal((await request('authorize', { sessionId: 'a', host: 'prod' })).status, 200);
  assert.equal((await request('setup.start', { sessionId: 'a', host: 'another', password: 'fixture-only' })).status, 200);
  assert.equal((await (await request('status', { sessionId: 'a' })).json()).value.connection.host, 'prod');
  await request('setup.cancel', { sessionId: 'a' });
  const execution = id => ({ agent: { id }, signal: new AbortController().signal });
  const output = JSON.parse(await definitions.get('ssh_exec').execute({ command: 'pwd', waitMs: 1000 }, execution('a')));
  assert.equal(output.output, 'host tool result\n');
  await assert.rejects(definitions.get('ssh_exec').execute({ command: 'pwd' }, execution('b')), /尚未授权/);
  await assert.rejects(definitions.get('ssh_exec').execute({ command: 'pwd' }, { signal: new AbortController().signal }), /当前会话/);
  assert.equal(JSON.parse(await definitions.get('ssh_read').execute({ id: output.id, offset: 0 }, execution('a'))).output, output.output);
  const instructions = await (await request('instructions', { sessionId: 'a' })).json();
  assert.ok(instructions.value.text.includes('ssh-cli.mjs'));
  assert.ok(instructions.value.text.includes('ELECTRON_RUN_AS_NODE=1'));
  assert.doesNotMatch(instructions.value.text, /[a-f0-9]{64}/);
  await events.get('session/disposed')({ id: 'a' });
  await assert.rejects(definitions.get('ssh_exec').execute({ command: 'pwd' }, execution('a')), /尚未授权/);
  assert.ok(terminations > 0);
  process.stdout.write('宿主接口验证通过：真实 defineTool、4 个原生工具、会话上下文隔离、HTTP 校验、CLI 通知与会话卸载撤销。\n');
} finally { for (const dispose of disposers.reverse()) await dispose(); }
