import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { SshManager } from '../src/manager.mjs';
import { SshBridge } from '../src/bridge.mjs';
import { OutputBuffer } from '../src/ssh.mjs';

function fakeJob(text = '', complete = true, exitCode = 0) {
  const deferred = Promise.withResolvers();
  const job = { id: randomUUID(), running: true, exitCode: null, error: null, buffer: new OutputBuffer(), done: deferred.promise };
  job.buffer.append(text);
  job.finish = () => { job.running = false; job.exitCode = exitCode; deferred.resolve(job); };
  job.stop = async () => { job.stopped = true; job.finish(); };
  if (complete) job.finish();
  return job;
}
async function fixture(t, spawn) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ssh-test-'));
  const terminal = { output: new PassThrough(), done: Promise.withResolvers().promise, write: async text => { terminal.input = text; }, resize: async (cols, rows) => { terminal.dimensions = { cols, rows }; }, terminate: async () => { terminal.stopped = true; terminal.output.end(); } };
  const manager = new SshManager({ root, subprocess: { resolveExecutable: async () => '/usr/bin/ssh', spawnTerminal: async spec => { terminal.spec = spec; return terminal; } },
    spawn: spawn ?? ((_connection, command) => fakeJob(command.includes('DSH_SSH_READY') ? 'DSH_SSH_READY\ndeploy\nprod\n/home/deploy\n' : 'ok')) });
  t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  return { manager, root, terminal };
}

test('仅当前会话可用，重复授权拒绝，失败登录不残留授权', async t => {
  const { manager } = await fixture(t);
  await assert.rejects(manager.execute('a', { command: 'pwd' }), /尚未授权/);
  assert.equal((await manager.authorize('a', { host: 'prod' })).state, 'connected');
  await assert.rejects(manager.execute('b', { command: 'pwd' }), /尚未授权/);
  await assert.rejects(manager.authorize('a', { host: 'elsewhere' }), /先撤销/);
  const result = await manager.execute('a', { command: 'pwd' });
  assert.equal(result.output, 'ok'); assert.equal(result.exitCode, 0);
  assert.throws(() => manager.read('b', { id: result.id }), /尚未授权/);
  await manager.authorize('b', { host: 'other' });
  assert.throws(() => manager.read('b', { id: result.id }), /没有该命令/);
  const failed = await fixture(t, () => fakeJob('Permission denied', true, 255));
  await assert.rejects(failed.manager.authorize('a', { host: 'prod' }), /Permission denied/);
  assert.equal(failed.manager.state('a').state, 'disconnected');
});

test('撤销登录中的授权不会被迟到的连接恢复', async t => {
  const probe = fakeJob('DSH_SSH_READY\nu\nh\n/\n', false);
  const { manager } = await fixture(t, () => probe);
  const connected = manager.authorize('a', { host: 'prod' });
  const rejection = assert.rejects(connected, /取消/);
  await manager.revoke('a'); await rejection;
  assert.ok(probe.stopped); assert.equal(manager.state('a').state, 'disconnected');
});

test('长命令读取、远端目录转义、并发上限与撤销终止', async t => {
  const commands = [], jobs = [];
  const { manager } = await fixture(t, (_connection, command) => {
    commands.push(command);
    if (command.includes('DSH_SSH_READY')) return fakeJob('DSH_SSH_READY\nu\nh\n/\n');
    const job = fakeJob('running', false); jobs.push(job); return job;
  });
  await manager.authorize('a', { host: 'prod' });
  const first = await manager.execute('a', { command: 'pwd', cwd: "/tmp/a'b", waitMs: 0 });
  assert.equal(commands.at(-1), "cd -- '/tmp/a'\\''b' || exit $?\npwd"); assert.equal(first.running, true);
  jobs[0].buffer.append('more'); assert.equal(manager.read('a', { id: first.id, offset: first.offset }).output, 'more');
  for (let i = 1; i < 8; i++) await manager.execute('a', { command: 'sleep 30', waitMs: 0 });
  await assert.rejects(manager.execute('a', { command: 'ninth', waitMs: 0 }), /8 个/);
  await assert.rejects(manager.execute('a', { command: 'pwd', waitMs: -1 }), /waitMs/);
  await manager.revoke('a'); assert.ok(jobs.every(job => job.stopped));
  await assert.rejects(manager.execute('a', { command: 'pwd' }), /尚未授权/);
});

test('PTY 输入、输出、缩放与授权撤销清理', async t => {
  const { manager, terminal } = await fixture(t);
  await manager.authorize('a', { host: 'prod' });
  await manager.openTerminal('a', { cols: 90, rows: 30 });
  assert.ok(terminal.spec.argv.includes('-tt'));
  terminal.output.write(Buffer.from('你好'));
  assert.equal(manager.terminalRead('a').output, '你好');
  await manager.terminalWrite('a', { data: 'top\r\x03' }); assert.equal(terminal.input, 'top\r\x03');
  await manager.terminalResize('a', { cols: 100, rows: 40 }); assert.deepEqual(terminal.dimensions, { cols: 100, rows: 40 });
  await manager.revoke('a'); assert.ok(terminal.stopped);
  await assert.rejects(manager.terminalWrite('a', { data: 'pwd' }), /尚未授权/);
});

test('撤销发生在 PTY 分配期间时回收迟到的句柄', async t => {
  const { manager, terminal } = await fixture(t);
  await manager.authorize('a', { host: 'prod' });
  const allocation = Promise.withResolvers();
  manager.subprocess.spawnTerminal = () => allocation.promise;
  const opened = manager.openTerminal('a');
  const rejected = assert.rejects(opened, /已撤销/);
  await Promise.resolve(); await Promise.resolve();
  const revoked = manager.revoke('a');
  allocation.resolve(terminal);
  await rejected;
  await revoked;
  assert.ok(terminal.stopped); assert.equal(manager.state('a').state, 'disconnected');
});

test('CLI 凭据 0600，随机令牌绑定会话，不能伪造会话或调用授权接口', async t => {
  const { manager } = await fixture(t);
  const bridge = new SshBridge(manager); await bridge.start(); t.after(() => bridge.close());
  await manager.authorize('a', { host: 'prod' });
  const file = await manager.credential('a', bridge.endpoint);
  const credential = JSON.parse(await readFile(file, 'utf8'));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const request = (action, body = {}, token = credential.token, extra = {}) => fetch(`${bridge.endpoint}/${action}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) });
  assert.equal((await request('exec', { command: 'pwd' })).status, 200);
  assert.equal((await request('authorize', { host: 'hacked' })).status, 404);
  assert.equal((await request('exec', { command: 'pwd', sessionId: 'b' })).status, 400);
  assert.equal((await request('exec', { command: 'pwd' }, '0'.repeat(64))).status, 403);
  assert.equal((await request('status', {}, credential.token, { origin: bridge.endpoint })).status, 403);
  await manager.revoke('a');
  assert.equal((await request('exec', { command: 'pwd' })).status, 403);
  await assert.rejects(readFile(file), { code: 'ENOENT' });
});

test('关闭正在分配的终端会回收迟到句柄，但保留 AI 授权', async t => {
  const { manager, terminal } = await fixture(t);
  await manager.authorize('a', { host: 'prod' });
  const allocation = Promise.withResolvers();
  manager.subprocess.spawnTerminal = () => allocation.promise;
  const opened = manager.openTerminal('a');
  const rejected = assert.rejects(opened, /终端已关闭/);
  await Promise.resolve(); await Promise.resolve();
  const closed = manager.terminalClose('a');
  allocation.resolve(terminal);
  await rejected; await closed;
  assert.ok(terminal.stopped); assert.equal(manager.state('a').state, 'connected');
  assert.equal(manager.state('a').terminal, null);
});

test('同步启动错误也会移除连接中的授权', async t => {
  const { manager } = await fixture(t, () => { throw new Error('无法创建 SSH 进程'); });
  await assert.rejects(manager.authorize('a', { host: 'prod' }), /无法创建/);
  assert.equal(manager.state('a').state, 'disconnected');
});

test('终端分配失败可重试，不遗留未处理的 Promise 拒绝', async t => {
  const { manager } = await fixture(t);
  await manager.authorize('a', { host: 'prod' });
  manager.subprocess.spawnTerminal = async () => { throw new Error('PTY 分配失败'); };
  await assert.rejects(manager.openTerminal('a'), /PTY 分配失败/);
  await assert.rejects(manager.openTerminal('a'), /PTY 分配失败/);
  assert.equal(manager.state('a').terminal, null);
});
