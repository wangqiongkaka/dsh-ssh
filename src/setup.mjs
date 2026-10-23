import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { connectionOf, quote, sshArgs, sshEnvironment } from './ssh.mjs';
import { readJson } from './wire.mjs';

const finished = new Set(['success', 'error', 'cancelled']);

export function installPublicKey(publicKey) {
  if (!/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/.test(publicKey)) throw new Error('公钥格式无效');
  return `set -eu
umask 077
dir="$HOME/.ssh"
file="$dir/authorized_keys"
if [ -L "$dir" ] || [ -L "$file" ]; then printf 'SSH key path is a symlink' >&2; exit 1; fi
mkdir -p "$dir"
chmod 700 "$dir"
touch "$file"
chmod 600 "$file"
if ! grep -F -q -- ${quote(publicKey)} "$file"; then printf '\\n%s\\n' ${quote(publicKey + ' dsh-ssh')} >> "$file"; fi`;
}

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.mode & 0o022 || process.getuid && info.uid !== process.getuid()) throw new Error('密钥目录必须由当前用户拥有，且不能是符号链接或允许其他用户写入');
}

export class PasswordlessSetup {
  constructor({ root, subprocess, keyDirectory = join(homedir(), '.ssh', 'dsh-ssh') }) {
    this.root = root; this.subprocess = subprocess; this.keyDirectory = keyDirectory;
    this.records = new Map(); this.keyLocks = new Map(); this.closed = false;
  }
  running(sessionId) { const record = this.records.get(sessionId); return !!record && !finished.has(record.phase); }
  state(sessionId) {
    const record = this.records.get(sessionId);
    return record ? { id: record.id, phase: record.phase, running: this.running(sessionId), connection: record.connection,
      identityFile: record.identityFile, fingerprint: record.fingerprint, hostPrompt: record.hostPrompt,
      error: record.error, mayHaveInstalledKey: record.mayHaveInstalledKey } : { phase: 'idle', running: false };
  }
  start(sessionId, input) {
    if (this.closed) throw new Error('插件已关闭');
    if (process.platform !== 'darwin' && process.platform !== 'linux') throw new Error('一键免密配置目前需要运行在 macOS 或 Linux 的 DSH 宿主');
    if (this.running(sessionId)) throw new Error('当前会话正在配置免密登录');
    if ([...this.records.keys()].filter(id => this.running(id)).length >= 4) throw new Error('最多同时配置 4 台机器');
    const connection = connectionOf(input);
    if (typeof input.password !== 'string' || !input.password.length || input.password.length > 4096 || /[\0\r\n]/.test(input.password)) throw new Error('请输入有效的首次登录密码，密码不能包含换行');
    const record = { id: randomUUID(), phase: 'preparing', connection, password: input.password, controller: new AbortController(), mayHaveInstalledKey: false };
    this.records.set(sessionId, record);
    record.done = this.configure(record).catch(() => { record.password = ''; record.phase = 'error'; record.error = '配置可能已完成，但临时资源清理失败，请检查远端公钥和本机临时目录'; });
    return this.state(sessionId);
  }
  async run(record, argv, env = {}) {
    record.controller.signal.throwIfAborted();
    const environment = Object.fromEntries(Object.keys(process.env).map(key => [key, undefined]));
    Object.assign(environment, sshEnvironment(), env);
    const child = record.child = this.subprocess.spawn({ argv, cwd: this.root, env: environment, signal: record.controller.signal,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 8192 } }, graceMs: 1500 });
    try {
      const outcome = await child.done;
      record.controller.signal.throwIfAborted();
      const output = child.collected.stdout.readFrom(0).text.trim();
      const diagnostic = child.collected.stderr.readFrom(0).text;
      if (outcome.exitCode !== 0) {
        if (record.promptError) throw new Error(record.promptError);
        if (/Permission denied|Authentication failed/i.test(diagnostic)) throw new Error('首次认证失败，请检查用户名、密码及远端是否允许密码认证');
        if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(diagnostic)) throw new Error('主机密钥校验失败，请先核实远端主机身份');
        throw new Error(`${record.phase === 'verifying' ? '公钥已提交，但密钥登录验证失败，请检查服务器公钥认证配置' : '配置命令执行失败，请检查连接、密钥路径权限及远端 SSH 配置'}（退出码 ${outcome.exitCode ?? '未知'}）`);
      }
      if (record.phase === 'verifying' && (output !== 'DSH_SSH_KEY_OK' || !diagnostic.includes(`Server accepts key: ${record.identityFile} `))) throw new Error('服务器未使用本次专用密钥完成验证，请检查公钥认证限制');
      return output;
    } finally {
      child.terminate();
      await child.waitForExit();
      if (record.child === child) record.child = undefined;
    }
  }
  async key(record) {
    const hash = createHash('sha256').update(JSON.stringify([record.connection.host, record.connection.user, record.connection.port ?? null])).digest('hex').slice(0, 20);
    const previous = this.keyLocks.get(hash) ?? Promise.resolve();
    const work = previous.catch(() => {}).then(async () => {
      await privateDirectory(dirname(this.keyDirectory)); await privateDirectory(this.keyDirectory);
      const path = join(this.keyDirectory, `id_ed25519_${hash}`);
      const info = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (info && (!info.isFile() || info.mode & 0o077 || process.getuid && info.uid !== process.getuid())) throw new Error('已有专用私钥权限不安全，配置已停止');
      if (!info) await this.run(record, ['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', 'dsh-ssh', '-f', path]);
      const publicKey = (await this.run(record, ['ssh-keygen', '-y', '-P', '', '-f', path])).split(/\s+/).slice(0, 2).join(' ');
      installPublicKey(publicKey);
      return { path, publicKey };
    });
    this.keyLocks.set(hash, work);
    try { return await work; } finally { if (this.keyLocks.get(hash) === work) this.keyLocks.delete(hash); }
  }
  async askpass(record, request, response) {
    try {
      if (!record.token || !['installing', 'host-key'].includes(record.phase) || request.method !== 'POST' || request.url !== '/' || request.headers.authorization !== `Bearer ${record.token}`
        || request.headers.origin || request.headers['sec-fetch-site'] || request.headers.host !== new URL(record.endpoint).host || record.controller.signal.aborted) {
        response.writeHead(403).end(); return;
      }
      const body = new Request(record.endpoint, { method: 'POST', body: Readable.toWeb(request), duplex: 'half' });
      const { prompt, kind } = await readJson(body, 8192);
      if (typeof prompt !== 'string') throw new Error('无效认证请求');
      let answer;
      if (kind === 'confirm' || /key fingerprint is:?\s*SHA256:/i.test(prompt)) {
        if (record.confirmation || !/SHA256:[A-Za-z0-9+/]+/.test(prompt)) throw new Error('无法识别主机指纹，请在系统终端核实');
        record.phase = 'host-key'; record.hostPrompt = prompt;
        record.fingerprint = prompt.match(/SHA256:[A-Za-z0-9+/]+/)[0];
        record.confirmation = Promise.withResolvers();
        answer = await record.confirmation.promise;
        record.confirmation = undefined; record.hostPrompt = undefined;
        if (!record.controller.signal.aborted) record.phase = 'installing';
      } else {
        if (record.phase !== 'installing' || prompt.trim() !== record.passwordPrompt || !record.password || record.passwordSent) {
          record.promptError = '认证请求与目标用户或主机不匹配；跳板机请先配置密钥认证，或重新开始配置';
          throw new Error(record.promptError);
        }
        record.passwordSent = true; answer = record.password; record.password = '';
      }
      response.setHeader('Cache-Control', 'no-store'); response.end(answer);
    } catch { response.writeHead(400).end(); }
  }
  confirm(sessionId, input) {
    const record = this.records.get(sessionId);
    if (!record?.confirmation || input.id !== record.id || input.fingerprint !== record.fingerprint || typeof input.trust !== 'boolean') throw new Error('主机指纹确认已过期');
    record.confirmation.resolve(input.trust ? 'yes' : 'no');
    if (!input.trust) { record.password = ''; record.controller.abort(new Error('未信任远端主机')); }
    return { ok: true };
  }
  async configure(record) {
    let directory;
    const timer = setTimeout(() => record.controller.abort(new Error('配置超时，请重试；已安装的公钥不会自动撤回')), 120000);
    try {
      const config = await this.run(record, ['ssh', '-G', ...sshArgs(record.connection)]);
      const user = config.match(/^user (.+)$/m)?.[1]?.trim(), host = config.match(/^hostname (.+)$/m)?.[1]?.trim();
      if (!user || !host) throw new Error('无法解析目标 SSH 用户或主机，请检查 SSH 配置');
      record.passwordPrompt = `${user}@${host.slice(0, 100)}'s password:`;
      const { path, publicKey } = await this.key(record); record.identityFile = path;
      record.controller.signal.throwIfAborted();
      directory = await mkdtemp(join(this.root, 'setup-'));
      record.token = randomBytes(32).toString('hex');
      record.server = createServer((request, response) => { void this.askpass(record, request, response); });
      record.server.requestTimeout = 10000; record.server.headersTimeout = 10000;
      await new Promise((resolve, reject) => { record.server.once('error', reject); record.server.listen(0, '127.0.0.1', resolve); });
      record.endpoint = `http://127.0.0.1:${record.server.address().port}`;
      const credentials = join(directory, 'askpass.json');
      await writeFile(credentials, JSON.stringify({ endpoint: record.endpoint, token: record.token }), { mode: 0o600, flag: 'wx' });
      const helper = join(directory, 'askpass');
      await writeFile(helper, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fileURLToPath(new URL('./askpass.mjs', import.meta.url)))} "$@"\n`, { mode: 0o700, flag: 'wx' });
      const args = sshArgs(record.connection).map(arg => arg === 'BatchMode=yes' ? 'BatchMode=no' : arg === 'StrictHostKeyChecking=yes' ? 'StrictHostKeyChecking=ask' : arg);
      args.splice(args.indexOf('--'), 0, '-o', 'PreferredAuthentications=password', '-o', 'PubkeyAuthentication=no', '-o', 'KbdInteractiveAuthentication=no', '-o', 'NumberOfPasswordPrompts=1');
      record.phase = 'installing'; record.mayHaveInstalledKey = true;
      await this.run(record, ['ssh', ...args, installPublicKey(publicKey)], { SSH_ASKPASS: helper, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: 'dsh-ssh:0', DSH_SSH_ASKPASS_FILE: credentials });
      record.password = ''; record.phase = 'verifying';
      const verifyArgs = sshArgs({ ...record.connection, identityFile: path });
      verifyArgs.splice(verifyArgs.indexOf('--'), 0, '-v', '-o', 'PreferredAuthentications=publickey', '-o', 'IdentityAgent=none', '-o', 'CertificateFile=none');
      // shortcut: 使用 OpenSSH 的密钥接受诊断确认未回退其他密钥；诊断格式变化时需更新此验证。
      await this.run(record, ['ssh', ...verifyArgs, "printf 'DSH_SSH_KEY_OK'"]);
      record.phase = 'success';
    } catch (error) {
      record.phase = record.cancelled ? 'cancelled' : 'error';
      record.error = record.controller.signal.aborted ? record.controller.signal.reason?.message ?? '配置已取消' : error.message;
    } finally {
      clearTimeout(timer); record.password = ''; record.token = undefined;
      record.confirmation?.resolve('no'); record.confirmation = undefined; record.hostPrompt = undefined;
      if (record.server) await new Promise(resolve => { record.server.close(resolve); record.server.closeAllConnections(); });
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
  async cancel(sessionId) {
    const record = this.records.get(sessionId);
    if (!record) return { ok: true };
    if (finished.has(record.phase)) { await record.done; return { ok: true }; }
    record.cancelled = true; record.password = ''; record.controller.abort(new Error('配置已取消；已安装的公钥不会自动撤回'));
    record.confirmation?.resolve('no');
    await record.done; return { ok: true };
  }
  async close() { this.closed = true; await Promise.all([...this.records.keys()].map(id => this.cancel(id))); }
}
