import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SshManager } from '../src/manager.mjs';
import { installPublicKey } from '../src/setup.mjs';
import { quote } from '../src/ssh.mjs';

const publicKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestFixtureOnly';
const password = 'fixture-only password !@';
const fingerprint = 'SHA256:FixtureHostKey123456';
const exec = promisify(execFile);

async function waitFor(condition) {
  for (let i = 0; i < 150; i++) { const value = condition(); if (value) return value; await delay(20); }
  throw new Error('测试等待超时');
}
async function fixture(t, { trusted = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ssh-setup-test-'));
  const remote = join(root, 'remote'), keys = join(root, 'keys');
  await mkdir(join(remote, '.ssh'), { recursive: true, mode: 0o700 });
  await writeFile(join(remote, '.ssh', 'authorized_keys'), 'existing-key-without-final-newline', { mode: 0o600 });
  const calls = [], helpers = new Set(); let passwordRequests = 0, generated = 0;
  const subprocess = { spawn(spec) {
    calls.push(spec); let stdout = '', stderr = '';
    const helper = (prompt, kind = '') => new Promise((resolve, reject) => {
      const child = spawn(spec.env.SSH_ASKPASS, [prompt], { env: { ...process.env, ...spec.env, SSH_ASKPASS_PROMPT: kind }, stdio: ['ignore', 'pipe', 'pipe'], signal: spec.signal });
      helpers.add(child); let answer = '';
      child.stdout.on('data', chunk => { answer += chunk; }); child.stderr.resume();
      child.once('error', reject); child.once('close', code => { helpers.delete(child); code === 0 ? resolve(answer) : reject(new Error('认证助手已取消')); });
    });
    const done = (async () => {
      const args = spec.argv;
      if (args.includes('StrictHostKeyChecking=ask') && !trusted) {
        const answer = await helper(`The authenticity of host 'fixture' cannot be established.\nED25519 key fingerprint is: ${fingerprint}\nAre you sure you want to continue connecting (yes/no/[fingerprint])?`);
        if (answer !== 'yes') { stderr = 'Host key verification failed'; return { exitCode: 255, signal: null }; }
        trusted = true;
      }
      if (args.includes('-G')) stdout = 'user fixture\nhostname host\nport 22';
      else if (args[0] === 'ssh-keygen') {
        if (args.includes('-q')) { generated++; await writeFile(args[args.indexOf('-f') + 1], 'fixture-private-key', { mode: 0o600, flag: 'wx' }); }
        else stdout = publicKey + ' dsh-ssh';
      } else if (args.includes('PreferredAuthentications=password')) {
        passwordRequests++;
        const answer = await helper("fixture@host's password: ").catch(() => '');
        if (answer !== password) { stderr = 'Permission denied'; return { exitCode: 255, signal: null }; }
        await exec('/bin/sh', ['-c', args.at(-1)], { env: { ...process.env, HOME: remote } });
      } else {
        assert.ok(args.indexOf('PreferredAuthentications=publickey') < args.indexOf('--'));
        stdout = 'DSH_SSH_KEY_OK'; stderr = `debug1: Server accepts key: ${args[args.indexOf('-i') + 1]} ED25519 SHA256:Fixture explicit`;
      }
      return { exitCode: 0, signal: null };
    })();
    return { done, collected: { stdout: { readFrom: () => ({ text: stdout }) }, stderr: { readFrom: () => ({ text: stderr }) } }, terminate() { for (const child of helpers) child.kill(); }, waitForExit: async () => { await done.catch(() => {}); return true; } };
  } };
  const manager = new SshManager({ root, subprocess, keyDirectory: keys });
  t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  return { root, remote, keys, manager, setup: manager.setup, calls, passwordRequests: () => passwordRequests, generated: () => generated };
}
async function trust(setup, sessionId = 'a') {
  const state = await waitFor(() => { const state = setup.state(sessionId); return state.phase === 'host-key' && state; });
  setup.confirm(sessionId, { id: state.id, fingerprint: state.fingerprint, trust: true });
}

test('页面确认指纹后安装公钥：密码不落盘或进入 argv/env，完成后不自动授权', async t => {
  const f = await fixture(t);
  f.setup.start('a', { host: 'fixture', password });
  const state = await waitFor(() => f.setup.state('a').phase === 'host-key' && f.setup.state('a'));
  assert.equal(f.passwordRequests(), 0);
  const credentials = f.calls.find(call => call.env.DSH_SSH_ASKPASS_FILE).env.DSH_SSH_ASKPASS_FILE;
  assert.equal((await stat(credentials)).mode & 0o777, 0o600);
  const { endpoint, token } = JSON.parse(await readFile(credentials, 'utf8'));
  const probe = (authorization, extra = {}) => fetch(endpoint, { method: 'POST', headers: { authorization, 'content-type': 'application/json', ...extra }, body: JSON.stringify({ prompt: "user@host's password: ", kind: '' }) });
  assert.equal((await probe('Bearer invalid')).status, 403);
  assert.equal((await probe(`Bearer ${token}`, { origin: endpoint })).status, 403);
  assert.equal((await probe(`Bearer ${token}`)).status, 400);
  assert.equal(f.setup.records.get('a').passwordSent, undefined);
  assert.throws(() => f.setup.confirm('b', { id: state.id, fingerprint, trust: true }), /已过期/);
  assert.throws(() => f.setup.confirm('a', { id: state.id, fingerprint: 'wrong', trust: true }), /已过期/);
  await assert.rejects(f.manager.authorize('a', { host: 'fixture' }), /先完成/);
  f.setup.confirm('a', { id: state.id, fingerprint, trust: true });
  await f.setup.records.get('a').done;
  const result = f.setup.state('a'); assert.equal(result.phase, 'success', result.error);
  assert.equal(f.manager.state('a').state, 'disconnected');
  assert.equal((await stat(result.identityFile)).mode & 0o777, 0o600);
  assert.equal(f.setup.records.get('a').password, '');
  assert.ok(!JSON.stringify(f.calls).includes(password)); assert.ok(!JSON.stringify(result).includes(password));
  await assert.rejects(readFile(credentials), { code: 'ENOENT' });
  assert.equal(await readFile(join(f.remote, '.ssh', 'authorized_keys'), 'utf8'), `existing-key-without-final-newline\n${publicKey} dsh-ssh\n`);
});

test('重复配置复用密钥、保留原有 authorized_keys 并且不重复追加', async t => {
  const f = await fixture(t);
  f.setup.start('a', { host: 'fixture', password }); await trust(f.setup); await f.setup.records.get('a').done;
  const first = f.setup.state('a').identityFile;
  f.setup.start('a', { host: 'fixture', password }); await f.setup.records.get('a').done;
  assert.equal(f.setup.state('a').phase, 'success'); assert.equal(f.setup.state('a').identityFile, first);
  assert.equal(f.generated(), 1);
  assert.equal((await readFile(join(f.remote, '.ssh', 'authorized_keys'), 'utf8')).split(publicKey).length - 1, 1);
});

test('密码错误失败后可以重试，错误内容和状态不包含密码', async t => {
  const f = await fixture(t);
  f.setup.start('a', { host: 'fixture', password: 'incorrect' }); await trust(f.setup); await f.setup.records.get('a').done;
  const result = f.setup.state('a'); assert.equal(result.phase, 'error'); assert.match(result.error, /首次认证失败/);
  assert.ok(!JSON.stringify(result).includes('incorrect'));
  assert.equal(await readFile(join(f.remote, '.ssh', 'authorized_keys'), 'utf8'), 'existing-key-without-final-newline');
  f.setup.start('a', { host: 'fixture', password }); await f.setup.records.get('a').done;
  assert.equal(f.setup.state('a').phase, 'success'); assert.equal(f.generated(), 1);
});

test('桌面宿主的认证启动脚本在清理环境后仍以 Node 模式执行', async t => {
  const f = await fixture(t, { trusted: true });
  const executable = process.execPath, desktop = join(f.root, 'desktop-node');
  await writeFile(desktop, `#!/bin/sh\n[ "$ELECTRON_RUN_AS_NODE" = 1 ] || exit 1\nexec ${quote(executable)} "$@"\n`, { mode: 0o700 });
  try {
    process.execPath = desktop;
    f.setup.start('a', { host: 'fixture', password });
    await f.setup.records.get('a').done;
    const result = f.setup.state('a');
    assert.equal(result.phase, 'success', result.error);
    assert.equal(f.setup.records.get('a').passwordSent, true);
    assert.equal(f.setup.records.get('a').password, '');
  } finally { process.execPath = executable; }
});

test('已有密钥首次连接确认指纹，不取用密码、安装公钥或授予 AI 权限', async t => {
  const f = await fixture(t);
  assert.throws(() => f.setup.start('bad', { host: 'fixture', authMode: 'unknown' }), /认证方式/);
  assert.throws(() => f.setup.start('bad', { host: 'fixture', authMode: 'key', password }), /不需要密码/);
  f.setup.start('a', { host: 'fixture', authMode: 'key' });
  await trust(f.setup); await f.setup.records.get('a').done;
  const state = f.setup.state('a');
  assert.equal(state.phase, 'success', state.error); assert.equal(state.identityFile, '');
  assert.equal(state.mayHaveInstalledKey, false); assert.equal(f.generated(), 0); assert.equal(f.passwordRequests(), 0);
  assert.equal(f.setup.records.get('a').password, ''); assert.equal(f.manager.state('a').state, 'disconnected');
  assert.equal(await readFile(join(f.remote, '.ssh', 'authorized_keys'), 'utf8'), 'existing-key-without-final-newline');
  const request = f.calls.find(call => call.argv.includes('StrictHostKeyChecking=ask'));
  for (const flag of ['PreferredAuthentications=publickey', 'PasswordAuthentication=no', 'KbdInteractiveAuthentication=no', 'NumberOfPasswordPrompts=0']) assert.ok(request.argv.includes(flag));
});

test('拒绝指纹或会话撤销会终止配置，不发送密码或安装公钥', async t => {
  for (const action of ['reject', 'revoke']) {
    const f = await fixture(t);
    f.setup.start('a', { host: 'fixture', password });
    const state = await waitFor(() => f.setup.state('a').phase === 'host-key' && f.setup.state('a'));
    if (action === 'reject') f.setup.confirm('a', { id: state.id, fingerprint, trust: false }); else await f.manager.revoke('a');
    await f.setup.records.get('a').done;
    assert.equal(f.setup.state('a').phase, action === 'reject' ? 'error' : 'cancelled');
    assert.equal(f.passwordRequests(), 0); assert.equal(f.setup.records.get('a').password, '');
    assert.equal(await readFile(join(f.remote, '.ssh', 'authorized_keys'), 'utf8'), 'existing-key-without-final-newline');
  }
});

test('不安全的私钥权限会拒绝复用且不进行密码认证', async t => {
  const f = await fixture(t);
  f.setup.start('a', { host: 'fixture', password }); await trust(f.setup); await f.setup.records.get('a').done;
  await chmod(f.setup.state('a').identityFile, 0o644);
  const count = f.passwordRequests();
  f.setup.start('a', { host: 'fixture', password }); await f.setup.records.get('a').done;
  assert.equal(f.setup.state('a').phase, 'error'); assert.match(f.setup.state('a').error, /私钥权限/);
  assert.equal(f.passwordRequests(), count);
});

test('公钥安装拒绝注入和符号链接，不覆盖符号链接的目标', async t => {
  const f = await fixture(t);
  assert.throws(() => installPublicKey("ssh-ed25519 key'; rm -rf /"), /格式/);
  const file = join(f.remote, '.ssh', 'authorized_keys'), target = join(f.root, 'keep');
  await writeFile(target, 'must-keep'); await rm(file); await symlink(target, file);
  await assert.rejects(exec('/bin/sh', ['-c', installPublicKey(publicKey)], { env: { ...process.env, HOME: f.remote } }));
  assert.equal(await readFile(target, 'utf8'), 'must-keep');
});

test('缺少密码、重复任务、超时及插件关闭均不会保留可用密码', async t => {
  const f = await fixture(t);
  for (const invalid of ['', 'line\nbreak', null, 123]) assert.throws(() => f.setup.start('a', { host: 'fixture', password: invalid }), /首次登录密码/);
  f.setup.start('a', { host: 'fixture', password });
  await waitFor(() => f.setup.state('a').phase === 'host-key');
  assert.throws(() => f.setup.start('a', { host: 'fixture', password }), /正在配置/);
  f.setup.records.get('a').controller.abort(new Error('配置超时'));
  await f.setup.records.get('a').done;
  assert.equal(f.setup.records.get('a').password, ''); assert.match(f.setup.state('a').error, /超时/);
  f.setup.start('b', { host: 'fixture', password });
  await waitFor(() => f.setup.state('b').phase === 'host-key');
  await f.manager.close();
  assert.equal(f.setup.records.get('b').password, ''); assert.equal(f.setup.state('b').phase, 'cancelled');
  assert.throws(() => f.setup.start('c', { host: 'fixture', password }), /已关闭/);
});
