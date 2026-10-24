import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionOf, sshArgs, OutputBuffer, quote, sshEnvironment, jobView } from '../src/ssh.mjs';
import { dimensions } from '../src/manager.mjs';
import { readJson, requireSameOrigin } from '../src/wire.mjs';

test('连接参数拒绝选项、命令注入、错误端口和相对私钥路径', () => {
  for (const host of ['-oProxyCommand=sh', 'host;touch /tmp/x', 'root@host', 'foo\nbar', '']) assert.throws(() => connectionOf({ host }));
  for (const port of [0, 65536, 'x', 1.5]) assert.throws(() => connectionOf({ host: 'prod', port }));
  assert.throws(() => connectionOf({ host: 'prod', user: '-oProxyCommand' }));
  assert.throws(() => connectionOf({ host: 'prod', identityFile: './key' }));
  const connection = connectionOf({ host: '2001:db8::1', port: '2222', user: 'deploy', identityFile: '/tmp/key with spaces' });
  assert.equal(connection.port, 2222);
  const args = sshArgs(connection);
  assert.deepEqual(args.slice(-3), ['IdentitiesOnly=yes', '--', '2001:db8::1']);
  for (const flag of ['StrictHostKeyChecking=yes', 'BatchMode=yes', 'ForwardAgent=no', 'PermitLocalCommand=no', 'ControlPath=none', 'SendEnv=-*']) assert.ok(args.includes(flag));
  assert.ok(args.includes('/tmp/key with spaces'));
  assert.ok(sshArgs(connection, true).includes('-tt'));
  assert.equal(connectionOf({ host: '::1' }).host, '::1');
  assert.equal(connectionOf({ host: 'fe80::1%en0' }).host, 'fe80::1%en0');
  assert.throws(() => connectionOf({ host: 'host:22' }));
});

test('输出游标在截断后不重复或漏读保留内容', () => {
  const buffer = new OutputBuffer(6);
  buffer.append('abcd'); assert.deepEqual(buffer.read(), { output: 'abcd', offset: 4, truncated: false });
  buffer.append('efgh'); assert.deepEqual(buffer.read(4), { output: 'efgh', offset: 8, truncated: false });
  assert.deepEqual(buffer.read(0), { output: 'cdefgh', offset: 8, truncated: true });
  assert.deepEqual(buffer.read(8), { output: '', offset: 8, truncated: false });
  for (const offset of [-1, 9, NaN, '0', 1.5]) assert.throws(() => buffer.read(offset));
  const job = { buffer, running: false, exitCode: null, error: null };
  assert.equal(jobView(job).outcomeUnknown, true);
  assert.equal(jobView({ ...job, exitCode: 255 }).outcomeUnknown, true);
  assert.equal(jobView({ ...job, exitCode: 0 }).outcomeUnknown, false);
  assert.equal(jobView({ ...job, running: true }).outcomeUnknown, false);
});

test('Shell 引号保留单引号；终端尺寸必须有界', () => {
  assert.equal(quote("a'b"), "'a'\\''b'");
  assert.deepEqual(dimensions({}), { cols: 80, rows: 24 });
  for (const input of [{ cols: 0 }, { cols: '80' }, { rows: 9999 }, { cols: 2.5 }]) assert.throws(() => dimensions(input));
});

test('SSH 子进程环境不会携带宿主 API 凭据', () => {
  process.env.DSH_SSH_TEST_SECRET = 'test-only';
  process.env.OPENAI_API_KEY = 'test-only';
  const env = sshEnvironment();
  assert.equal(env.DSH_SSH_TEST_SECRET, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.PATH, process.env.PATH);
  delete process.env.DSH_SSH_TEST_SECRET; delete process.env.OPENAI_API_KEY;
});

test('拒绝跨站请求、非 JSON、超大正文和非对象正文', async () => {
  const request = (body, headers = {}) => new Request('http://localhost:1234/api/dsh-ssh/exec', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  assert.doesNotThrow(() => requireSameOrigin(request('{}', { origin: 'http://localhost:1234' })));
  assert.throws(() => requireSameOrigin(request('{}', { origin: 'http://evil.invalid' })));
  assert.throws(() => requireSameOrigin(request('{}', { 'sec-fetch-site': 'cross-site' })));
  assert.throws(() => requireSameOrigin(request('{}', { 'content-type': 'text/plain' })));
  await assert.rejects(readJson(request('"hello"')));
  await assert.rejects(readJson(request('[]')));
  await assert.rejects(readJson(request('{broken')));
  await assert.rejects(readJson(request('{"long":"123456"}'), 5));
  assert.deepEqual(await readJson(request('{"command":"pwd"}')), { command: 'pwd' });
});

test('宿主桥接使用内部 URL 时，按已验证的 Host 校验 Origin', () => {
  const request = (origin, host = '127.0.0.1:52525', extra = {}) => new Request('http://dsh.internal/api/dsh-ssh/status', {
    method: 'POST', headers: { host, origin, 'content-type': 'application/json', ...extra }, body: '{}',
  });
  assert.doesNotThrow(() => requireSameOrigin(request('http://127.0.0.1:52525')));
  assert.doesNotThrow(() => requireSameOrigin(request('https://dsh.example.com', 'dsh.example.com')));
  for (const origin of ['http://evil.invalid', 'http://127.0.0.1:52526', 'null', 'file://127.0.0.1:52525', 'http://127.0.0.1:52525/path']) {
    assert.throws(() => requireSameOrigin(request(origin)));
  }
  assert.throws(() => requireSameOrigin(request('http://127.0.0.1:52525', undefined, { 'sec-fetch-site': 'cross-site' })));
});
