import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { isIP } from 'node:net';

export function requireText(value, label, max = 65536) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error(`${label}无效`);
  return value;
}

export function connectionOf(input) {
  if (!input || typeof input !== 'object') throw new Error('连接配置无效');
  const host = requireText(input.host, '主机', 253).trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(host) && isIP(host) !== 6) throw new Error('主机必须为 SSH 别名、域名或 IP 地址');
  const user = input.user ?? '';
  if (typeof user !== 'string' || user.length > 128 || user && !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*\$?$/.test(user)) throw new Error('用户名无效');
  if (input.port !== undefined && typeof input.port !== 'string' && typeof input.port !== 'number') throw new Error('端口无效');
  const port = input.port === '' || input.port === undefined ? undefined : Number(input.port);
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('端口必须在 1–65535 之间');
  let identityFile = input.identityFile ?? '';
  if (typeof identityFile !== 'string' || identityFile.length > 4096 || /[\x00-\x1f]/.test(identityFile)) throw new Error('私钥路径无效');
  if (identityFile.startsWith('~/')) identityFile = join(homedir(), identityFile.slice(2));
  if (identityFile && !isAbsolute(identityFile)) throw new Error('私钥路径必须是绝对路径或以 ~/ 开头');
  return { host, user, port, identityFile };
}

export function sshArgs(connection, terminal = false) {
  const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ForwardAgent=no',
    '-o', 'ClearAllForwardings=yes', '-o', 'PermitLocalCommand=no', '-o', 'EscapeChar=none',
    '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'RemoteCommand=none', '-o', 'ConnectTimeout=15',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', '-o', 'SendEnv=-*', terminal ? '-tt' : '-T'];
  if (connection.user) args.push('-l', connection.user);
  if (connection.port) args.push('-p', String(connection.port));
  if (connection.identityFile) args.push('-i', connection.identityFile, '-o', 'IdentitiesOnly=yes');
  args.push('--', connection.host);
  return args;
}

export const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

// 输出缓存使用字符偏移，截断后仍保留绝对游标，避免轮询漏读或重复。
export class OutputBuffer {
  constructor(limit = 256 * 1024) { this.limit = limit; this.text = ''; this.start = 0; }
  append(text) {
    this.text += text;
    if (this.text.length > this.limit) {
      const excess = this.text.length - this.limit;
      this.text = this.text.slice(excess); this.start += excess;
    }
  }
  read(offset = 0) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.start + this.text.length) throw new Error('输出游标无效');
    return { output: this.text.slice(Math.max(0, offset - this.start)), offset: this.start + this.text.length, truncated: offset < this.start };
  }
}

export function sshEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined
    && /^(PATH|HOME|USER|LOGNAME|LANG|LC_[A-Z_]+|SSH_AUTH_SOCK|TMPDIR|SYSTEMROOT)$/i.test(key)));
}

export function spawnCommand(connection, command, subprocess, cwd) {
  const env = Object.fromEntries(Object.keys(process.env).map(key => [key, undefined]));
  Object.assign(env, sshEnvironment());
  const child = subprocess.spawn({ argv: ['ssh', ...sshArgs(connection), command], cwd, env,
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }, graceMs: 1500 });
  const buffer = new OutputBuffer();
  const job = { id: randomUUID(), buffer, running: true, exitCode: null, error: null };
  const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')];
  for (const [index, stream] of [child.stdout, child.stderr].entries()) {
    stream.on('data', chunk => buffer.append(decoders[index].write(chunk)));
    stream.on('end', () => buffer.append(decoders[index].end()));
    stream.on('error', error => { job.error = error.message; });
  }
  job.done = child.done.then(({ exitCode, signal }) => {
    job.running = false; job.exitCode = exitCode;
    if (signal) job.error ??= `SSH 进程已收到 ${signal}，远端执行结果可能无法确认`;
    return job;
  }, error => {
    job.running = false; job.error = error.message; return job;
  });
  job.stop = async () => {
    child.terminate();
    await Promise.all([job.done, child.waitForExit()]);
  };
  return job;
}

export function jobView(job, offset = 0) {
  return { id: job.id, ...job.buffer.read(offset), running: job.running, exitCode: job.exitCode, error: job.error,
    outcomeUnknown: (!job.running && job.exitCode === null) || job.exitCode === 255 || !!job.error };
}
