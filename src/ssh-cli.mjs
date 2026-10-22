#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

try {
  const [credentialFile, action = 'status', raw = '{}'] = process.argv.slice(2);
  if (!credentialFile || !['status', 'exec', 'read', 'stop'].includes(action)) throw new Error('用法：ssh-cli.mjs <会话凭据文件> status|exec|read|stop [JSON 参数]');
  const { endpoint, token } = JSON.parse(await readFile(credentialFile, 'utf8'));
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint) || !/^[a-f0-9]{64}$/.test(token)) throw new Error('会话凭据无效，请在侧边栏重新授权');
  const input = JSON.parse(raw);
  const response = await fetch(`${endpoint}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(input), signal: AbortSignal.timeout(15000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  process.stdout.write(JSON.stringify(result) + '\n');
} catch (error) {
  process.stderr.write(`${error.code === 'ENOENT' ? '会话授权已失效，请在侧边栏重新连接' : error.message}\n`);
  process.exitCode = 1;
}
