import { readFile } from 'node:fs/promises';
try {
  const { endpoint, token } = JSON.parse(await readFile(process.env.DSH_SSH_ASKPASS_FILE, 'utf8'));
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint) || !/^[a-f0-9]{64}$/.test(token)) throw new Error('无效认证通道');
  const response = await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: process.argv[2] ?? '', kind: process.env.SSH_ASKPASS_PROMPT ?? '' }), signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error('认证请求已拒绝');
  process.stdout.write(await response.text());
} catch { process.exitCode = 1; }
