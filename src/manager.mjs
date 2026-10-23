import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { connectionOf, sshArgs, quote, OutputBuffer, spawnCommand, requireText, jobView } from './ssh.mjs';
import { PasswordlessSetup } from './setup.mjs';

export class SshManager {
  constructor({ root, subprocess, spawn, keyDirectory }) {
    this.root = root; this.subprocess = subprocess;
    this.spawn = spawn ?? ((connection, command) => spawnCommand(connection, command, subprocess, root));
    this.grants = new Map(); this.pending = new Set(); this.closed = false;
    this.setup = new PasswordlessSetup({ root, subprocess, keyDirectory });
  }
  current(sessionId, connected = true) {
    if (this.closed) throw new Error('插件已关闭');
    const grant = this.grants.get(sessionId);
    if (!grant || connected && grant.state !== 'connected') throw new Error('当前会话尚未授权 SSH 连接，请在侧边栏连接并授权');
    return grant;
  }
  state(sessionId) {
    const grant = this.grants.get(sessionId);
    return grant ? { state: grant.state, connection: grant.connection, identity: grant.identity, error: grant.error,
      terminal: grant.terminal ? { running: grant.terminal.running, exitCode: grant.terminal.exitCode } : null,
      jobs: [...grant.jobs.values()].map(job => ({ id: job.id, running: job.running, exitCode: job.exitCode })) }
      : { state: 'disconnected', jobs: [], terminal: null };
  }
  async authorize(sessionId, input) {
    if (this.closed) throw new Error('插件已关闭');
    if (this.setup.running(sessionId)) throw new Error('请先完成或取消免密登录配置');
    const connection = connectionOf(input);
    if (this.grants.has(sessionId)) throw new Error('请先撤销当前连接，再连接其他机器');
    const grant = { state: 'connecting', connection, jobs: new Map(), terminal: null, terminalEpoch: 0, pendingTerminals: new Set() };
    this.grants.set(sessionId, grant);
    const work = this.connect(sessionId, grant);
    this.pending.add(work);
    try { return await work; } finally { this.pending.delete(work); }
  }
  async connect(sessionId, grant) {
    let timer;
    try {
      const probe = this.spawn(grant.connection, "printf 'DSH_SSH_READY\\n'; id -un; hostname; pwd");
      grant.probe = probe;
      timer = setTimeout(() => { void probe.stop().catch(error => { probe.error = error.message; }); }, 20000);
      await probe.done;
      if (this.closed || this.grants.get(sessionId) !== grant) throw new Error('授权已取消');
      if (probe.exitCode !== 0 || !probe.buffer.text.includes('DSH_SSH_READY\n')) throw new Error(probe.error || probe.buffer.text || 'SSH 连接失败');
      grant.identity = probe.buffer.text.split('DSH_SSH_READY\n').at(-1).trim();
      grant.state = 'connected';
      return this.state(sessionId);
    } catch (error) {
      if (this.grants.get(sessionId) === grant) this.grants.delete(sessionId);
      throw error;
    } finally { clearTimeout(timer); }
  }
  async revoke(sessionId) {
    const grant = this.grants.get(sessionId);
    this.grants.delete(sessionId);
    const cancellation = this.setup.cancel(sessionId);
    if (!grant) { await cancellation; return { state: 'disconnected' }; }
    const results = await Promise.allSettled([
      cancellation,
      ...(grant.probe ? [grant.probe.stop()] : []), ...[...grant.jobs.values()].map(job => job.stop()),
      ...(grant.terminal ? [grant.terminal.handle.terminate()] : []), ...grant.pendingTerminals,
      ...(grant.credentialFile ? [rm(grant.credentialFile, { force: true })] : []),
    ]);
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), '授权已撤销，但部分连接清理失败；请检查远端进程');
    return { state: 'disconnected' };
  }
  async execute(sessionId, input) {
    const grant = this.current(sessionId);
    const command = requireText(input.command, '命令');
    const cwd = input.cwd === undefined || input.cwd === '' ? '' : requireText(input.cwd, '远端目录', 4096);
    const waitMs = input.waitMs ?? 1000;
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 10000) throw new Error('waitMs 必须在 0–10000 之间');
    if ([...grant.jobs.values()].filter(job => job.running).length >= 8) throw new Error('最多同时执行 8 个远程命令');
    for (const [id, job] of grant.jobs) if (grant.jobs.size >= 32 && !job.running) grant.jobs.delete(id);
    const job = this.spawn(grant.connection, cwd ? `cd -- ${quote(cwd)} || exit $?\n${command}` : command);
    grant.jobs.set(job.id, job);
    let timer;
    try { await Promise.race([job.done, new Promise(resolve => { timer = setTimeout(resolve, waitMs); })]); }
    finally { clearTimeout(timer); }
    return jobView(job);
  }
  read(sessionId, input) {
    const grant = this.current(sessionId);
    const job = grant.jobs.get(requireText(input.id, '命令 ID', 128));
    if (!job) throw new Error('当前会话中没有该命令，或输出已过期');
    return jobView(job, input.offset ?? 0);
  }
  async stop(sessionId, input) {
    const grant = this.current(sessionId);
    const job = grant.jobs.get(requireText(input.id, '命令 ID', 128));
    if (!job) throw new Error('当前会话中没有该命令');
    await job.stop(); return jobView(job);
  }
  async openTerminal(sessionId, input = {}) {
    const grant = this.current(sessionId);
    if (grant.terminal?.running) return this.terminalRead(sessionId, { offset: 0 });
    if (grant.pendingTerminals.size) throw new Error('终端正在打开');
    const work = this.allocateTerminal(sessionId, grant, input);
    const cleanup = work.catch(error => { if (error.code !== 'SSH_REVOKED') throw error; });
    void cleanup.catch(() => {});
    grant.pendingTerminals.add(cleanup);
    try { return await work; } finally { grant.pendingTerminals.delete(cleanup); }
  }
  async allocateTerminal(sessionId, grant, input) {
    const epoch = grant.terminalEpoch;
    const { cols, rows } = dimensions(input);
    if (grant.terminal) { await grant.terminal.handle.terminate(); grant.terminal = null; }
    const executable = await this.subprocess.resolveExecutable('ssh');
    if (this.grants.get(sessionId) !== grant || grant.terminalEpoch !== epoch) throw Object.assign(new Error('授权已撤销或终端已关闭'), { code: 'SSH_REVOKED' });
    const handle = await this.subprocess.spawnTerminal({ argv: [executable, ...sshArgs(grant.connection, true)], cwd: this.root,
      cols, rows, terminalType: 'xterm-256color', graceMs: 1500 });
    if (this.grants.get(sessionId) !== grant || grant.terminalEpoch !== epoch) { await handle.terminate(); throw Object.assign(new Error('授权已撤销或终端已关闭'), { code: 'SSH_REVOKED' }); }
    const terminal = { handle, buffer: new OutputBuffer(), running: true, exitCode: null, error: null };
    grant.terminal = terminal;
    const decoder = new StringDecoder('utf8');
    handle.output.on('data', chunk => terminal.buffer.append(decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))));
    handle.output.on('end', () => terminal.buffer.append(decoder.end()));
    handle.output.on('error', error => { terminal.error = error.message; });
    void handle.done.then(outcome => { terminal.running = false; terminal.exitCode = outcome.exitCode; }, error => { terminal.running = false; terminal.error = error.message; });
    return this.terminalRead(sessionId, { offset: 0 });
  }
  terminalRead(sessionId, input = {}) {
    const terminal = this.current(sessionId).terminal;
    if (!terminal) throw new Error('终端尚未打开');
    return { ...terminal.buffer.read(input.offset ?? 0), running: terminal.running, exitCode: terminal.exitCode, error: terminal.error };
  }
  async terminalWrite(sessionId, input) {
    const terminal = this.current(sessionId).terminal;
    if (!terminal?.running) throw new Error('终端未运行');
    const data = input.data;
    if (typeof data !== 'string' || data.length > 65536) throw new Error('终端输入无效或过长');
    await terminal.handle.write(data); return { ok: true };
  }
  async terminalResize(sessionId, input) {
    const terminal = this.current(sessionId).terminal;
    const { cols, rows } = dimensions(input);
    if (terminal?.running) await terminal.handle.resize(cols, rows);
    return { ok: true };
  }
  async terminalClose(sessionId) {
    const grant = this.current(sessionId);
    grant.terminalEpoch++;
    const terminal = grant.terminal;
    if (terminal) { await terminal.handle.terminate(); if (grant.terminal === terminal) grant.terminal = null; }
    await Promise.all(grant.pendingTerminals);
    return { ok: true };
  }
  async credential(sessionId, endpoint) {
    const grant = this.current(sessionId);
    if (grant.credentialFile) return grant.credentialFile;
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const token = randomBytes(32).toString('hex');
    const file = join(this.root, `${randomBytes(16).toString('hex')}.json`);
    await writeFile(file, JSON.stringify({ endpoint, token }), { mode: 0o600, flag: 'wx' });
    if (this.grants.get(sessionId) !== grant) { await rm(file, { force: true }); throw new Error('授权已撤销'); }
    if (grant.credentialFile) { await rm(file, { force: true }); return grant.credentialFile; }
    grant.token = token; grant.credentialFile = file;
    return file;
  }
  sessionForToken(token) {
    if (this.closed) return;
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return;
    for (const [sessionId, grant] of this.grants) if (grant.token === token && grant.state === 'connected') return sessionId;
  }
  async close() {
    this.closed = true;
    const results = await Promise.allSettled([this.setup.close(), ...[...this.grants.keys()].map(id => this.revoke(id))]);
    await Promise.allSettled(this.pending);
    if (results.some(result => result.status === 'rejected')) throw new Error('部分 SSH 连接未能清理，请检查远端进程');
  }
}

export function dimensions(input) {
  const cols = input.cols ?? 80, rows = input.rows ?? 24;
  if (!Number.isInteger(cols) || cols < 2 || cols > 500 || !Number.isInteger(rows) || rows < 1 || rows > 300) throw new Error('终端尺寸无效');
  return { cols, rows };
}
