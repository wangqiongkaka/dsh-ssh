import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SshManager } from '../src/manager.mjs';
import { SshBridge } from '../src/bridge.mjs';
import { quote } from '../src/ssh.mjs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// 仅使用回环地址、临时密钥和临时配置，不触碰用户的 ~/.ssh。
const root = await mkdtemp(join(tmpdir(), 'dsh-ssh-live-'));
const previousPath = process.env.PATH;
let sshd, manager, bridge, fiber;
try {
  execFileSync('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(root, 'host')]);
  execFileSync('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(root, 'identity')]);
  await writeFile(join(root, 'authorized_keys'), await readFile(join(root, 'identity.pub')), { mode: 0o600 });
  const portServer = createServer(); await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
  const port = portServer.address().port; await new Promise(resolve => portServer.close(resolve));
  await writeFile(join(root, 'sshd_config'), `Port ${port}\nListenAddress 127.0.0.1\nHostKey ${join(root, 'host')}\nAuthorizedKeysFile ${join(root, 'authorized_keys')}\nPidFile ${join(root, 'sshd.pid')}\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nStrictModes no\nLogLevel ERROR\n`);
  let logs = '';
  sshd = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', join(root, 'sshd_config')], { stdio: ['ignore', 'pipe', 'pipe'] });
  sshd.stderr.on('data', chunk => { logs += chunk; });
  sshd.on('error', error => { logs += error.message; });
  await delay(300);
  if (sshd.exitCode !== null) throw new Error(`临时 sshd 未能启动：${logs}`);
  const hostKey = (await readFile(join(root, 'host.pub'), 'utf8')).trim();
  await writeFile(join(root, 'known_hosts'), `[127.0.0.1]:${port} ${hostKey}\n`);
  await writeFile(join(root, 'config'), `Host ssh-fixture\n  HostName 127.0.0.1\n  Port ${port}\n  User ${userInfo().username}\n  IdentityFile ${join(root, 'identity')}\n  UserKnownHostsFile ${join(root, 'known_hosts')}\n  GlobalKnownHostsFile /dev/null\n`);
  await mkdir(join(root, 'bin'));
  await writeFile(join(root, 'bin', 'ssh'), `#!/bin/sh\nexec /usr/bin/ssh -F ${quote(join(root, 'config'))} "$@"\n`, { mode: 0o700 });
  process.env.PATH = `${join(root, 'bin')}:${previousPath}`;
  const reference = resolve(process.env.DSH_REFERENCE_ROOT ?? '../../deepseek-harness');
  const require = createRequire(join(reference, 'packages/subprocess/subprocess-local/package.json'));
  const { Context } = await import(require.resolve('@deepseek-ai/cordis'));
  const { default: LocalSubprocessRuntime } = await import(pathToFileURL(join(reference, 'packages/subprocess/subprocess-local/lib/index.js')));
  const ctx = new Context(); fiber = await ctx.plugin(LocalSubprocessRuntime);
  manager = new SshManager({ root, subprocess: ctx.subprocess });
  bridge = new SshBridge(manager); await bridge.start();
  const authorized = await manager.authorize('live-session', { host: 'ssh-fixture' });
  assert.equal(authorized.state, 'connected');
  const resources = await manager.resources({ host: 'ssh-fixture' });
  assert.equal(resources.os, process.platform === 'darwin' ? 'Darwin' : 'Linux');
  if (resources.os === 'Linux') assert.ok(resources.memory.totalBytes > 0);
  else assert.equal(resources.unsupported, true);
  assert.equal(manager.state('live-session').connection.host, 'ssh-fixture');
  const file = await manager.credential('live-session', bridge.endpoint);
  const cli = (action, input) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/ssh-cli.mjs', file, action, JSON.stringify(input)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject); child.once('close', code => code ? reject(new Error(stderr)) : resolve(JSON.parse(stdout)));
  });
  const result = await cli('exec', { command: "printf '真实 SSH 中文输出\\n'; exit 7", waitMs: 10000 });
  assert.equal(result.exitCode, 7); assert.match(result.output, /真实 SSH 中文输出/);
  const failedCwd = await manager.execute('live-session', { command: "printf 'SHOULD_NOT_RUN'; printf 'NEITHER'", cwd: join(root, 'does-not-exist'), waitMs: 10000 });
  assert.notEqual(failedCwd.exitCode, 0); assert.doesNotMatch(failedCwd.output, /SHOULD_NOT_RUN|NEITHER/);
  const marker = join(root, 'written-by-ssh');
  const write = await manager.execute('live-session', { command: `printf 'written' > ${quote(marker)} && cat ${quote(marker)}`, waitMs: 10000 });
  assert.equal(write.exitCode, 0); assert.equal(await readFile(marker, 'utf8'), 'written');
  await manager.openTerminal('live-session', { cols: 90, rows: 30 });
  await manager.terminalWrite('live-session', { data: "printf 'PTY_OK\\n'\r" });
  let terminalResult;
  for (let i = 0; i < 50; i++) {
    terminalResult = manager.terminalRead('live-session');
    if (terminalResult.output.includes('\r\nPTY_OK\r\n')) break;
    await delay(100);
  }
  assert.match(terminalResult.output, /\r\nPTY_OK\r\n/);
  await manager.terminalResize('live-session', { cols: 100, rows: 40 });
  await manager.terminalWrite('live-session', { data: 'sleep 30\r' });
  await delay(100); await manager.terminalWrite('live-session', { data: '\x03' });
  await manager.terminalWrite('live-session', { data: "printf 'AFTER_INTERRUPT\\n'\r" });
  for (let i = 0; i < 30; i++) {
    terminalResult = manager.terminalRead('live-session');
    if (terminalResult.output.includes('\r\nAFTER_INTERRUPT\r\n')) break;
    await delay(100);
  }
  assert.match(terminalResult.output, /\r\nAFTER_INTERRUPT\r\n/);
  const task = await manager.execute('live-session', { command: 'sleep 30', waitMs: 0 }); assert.ok(task.running);
  await manager.revoke('live-session');
  await assert.rejects(cli('status', {}), /授权已失效/);
  await assert.rejects(manager.execute('live-session', { command: 'pwd' }), /尚未授权/);
  process.stdout.write('真实 SSH 验证通过：宿主受管进程、密钥与主机校验、登录、CLI 执行、中文输出、退出码、远端文件写入、目录失败停止、PTY 输入输出/缩放/Ctrl+C 和撤销。\n');
} finally {
  process.env.PATH = previousPath;
  await manager?.close(); await bridge?.close();
  await fiber?.dispose();
  if (sshd && sshd.exitCode === null) { const exited = new Promise(resolve => sshd.once('exit', resolve)); sshd.kill('SIGTERM'); await exited; }
  await rm(root, { recursive: true, force: true });
}
