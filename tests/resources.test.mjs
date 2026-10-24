import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { SshManager } from '../src/manager.mjs';
import { OutputBuffer } from '../src/ssh.mjs';
import { parseResources, resourceCommand } from '../src/resources.mjs';

const sample = `DSH_HOST_RESOURCES_V1
os Linux
hostname production-01
cores 2
cpu 12.5
memory 1073741824 805306368
disk 42949672960 10737418240 30064771072
uptime 12345`;

function job(output = sample, running = false, exitCode = 0) {
  const deferred = Promise.withResolvers(), buffer = new OutputBuffer(); buffer.append(output);
  const value = { buffer, exitCode, done: deferred.promise, stop: async () => { value.stopped = true; deferred.resolve(); } };
  value.finish = () => deferred.resolve(); if (!running) value.finish(); return value;
}

test('解析真实单位的资源数据，允许登录横幅和无法采样的 CPU', () => {
  const result = parseResources('Welcome\n' + sample);
  assert.equal(result.hostname, 'production-01'); assert.equal(result.cores, 2); assert.equal(result.cpuPercent, 12.5);
  assert.deepEqual(result.memory, { totalBytes: 1073741824, availableBytes: 805306368, usedBytes: 268435456 });
  assert.equal(result.disk.usedBytes, 10737418240); assert.equal(result.uptimeSeconds, 12345);
  assert.equal(parseResources(sample.replace('cpu 12.5', 'cpu -1')).cpuPercent, null);
  assert.deepEqual(parseResources('DSH_HOST_RESOURCES_V1\nos Darwin\nhostname mac\nunsupported 1'), { os: 'Darwin', hostname: 'mac', unsupported: true });
  for (const output of ['', sample.replace('cpu 12.5', 'cpu 101'), sample.replace('cores 2', 'cores 0'), sample.replace('cpu 12.5', 'cpu NaN'), sample.replace('memory 1073741824 805306368', 'memory 1024 2048'), sample.replace('disk 42949672960 10737418240 30064771072', 'disk 0 0 0'), sample.replace('uptime 12345', '')]) assert.throws(() => parseResources(output));
});

test('资源采集不要求或产生 AI 授权，也不改变已授权目标', async t => {
  const calls = [];
  const manager = new SshManager({ root: tmpdir(), spawn: (connection, command) => {
    calls.push({ connection, command });
    return job(command.includes('DSH_SSH_READY') ? 'DSH_SSH_READY\nu\nactive\n/\n' : sample);
  } });
  t.after(() => manager.close());
  const result = await manager.resources({ host: 'saved' });
  assert.equal(result.cpuPercent, 12.5); assert.ok(result.collectedAt > 0);
  assert.equal(calls[0].command, resourceCommand); assert.equal(manager.state('a').state, 'disconnected');
  await assert.rejects(manager.execute('a', { command: 'pwd' }), /尚未授权/);
  await manager.authorize('a', { host: 'active' });
  await manager.resources({ host: 'another' });
  assert.equal(manager.state('a').connection.host, 'active');
  await assert.rejects(manager.resources({ host: '-oProxyCommand=sh' }), /主机/);
});

test('同目标共享采集，并发有界，关闭插件会停止所有资源查询', async () => {
  const jobs = [];
  const manager = new SshManager({ root: tmpdir(), spawn: () => { const value = job(sample, true); jobs.push(value); return value; } });
  const requests = [manager.resources({ host: 'a' }), manager.resources({ host: 'a' }), ...['b', 'c', 'd'].map(host => manager.resources({ host }))];
  const settled = Promise.allSettled(requests);
  assert.equal(jobs.length, 4);
  await assert.rejects(manager.resources({ host: 'e' }), /采集中/);
  await manager.close();
  assert.ok(jobs.every(value => value.stopped));
  assert.ok((await settled).every(result => result.status === 'rejected' && /关闭/.test(result.reason.message)));
  assert.equal(manager.resourceChecks.size, 0);
});

test('资源查询失败不会残留查询或授权，允许用户重试', async t => {
  let fails = true;
  const manager = new SshManager({ root: tmpdir(), spawn: () => job(fails ? 'Permission denied' : sample, false, fails ? 255 : 0) });
  t.after(() => manager.close());
  await assert.rejects(manager.resources({ host: 'a' }), /Permission denied/);
  assert.equal(manager.resourceChecks.size, 0); assert.equal(manager.grants.size, 0);
  fails = false; assert.equal((await manager.resources({ host: 'a' })).os, 'Linux');
});

test('资源查询超时会停止进程并释放采集名额', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = job(sample, true), manager = new SshManager({ root: tmpdir(), spawn: () => pending });
  t.after(() => manager.close());
  const rejected = assert.rejects(manager.resources({ host: 'timeout' }), /查询超时/);
  t.mock.timers.tick(20000); await rejected;
  assert.equal(pending.stopped, true); assert.equal(manager.resourceChecks.size, 0);
});
