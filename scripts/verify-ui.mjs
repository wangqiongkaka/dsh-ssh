import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

await mkdir('.cache', { recursive: true }); await mkdir('docs', { recursive: true });
await writeFile('.cache/ui-entry.jsx', `import React from 'react';
import {createRoot} from 'react-dom/client';
import {SshPanel} from '../src/client.jsx';
import panel from '../src/client.css';
import xterm from '@xterm/xterm/css/xterm.css';
const style=document.createElement('style');style.textContent=panel+'\\n'+xterm;document.head.append(style);
createRoot(document.getElementById('root')).render(<SshPanel sessionId="ui-test" onNotify={async text=>{window.notified=text;}}/>);`);
await build({ entryPoints: ['.cache/ui-entry.jsx'], outfile: '.cache/ui.js', bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', loader: { '.css': 'text' } });
let connected = false, output = '', input = '', terminalRunning = false, authorizations = 0;
let setup = { phase: 'idle', running: false }, setupCount = 0;
const state = () => ({ state: connected ? 'connected' : 'disconnected', connection: { host: 'prod.example.com', user: 'deploy', port: 2222 }, identity: 'deploy\nproduction-01\n/home/deploy', jobs: [], terminal: terminalRunning ? { running: true } : null });
const server = createServer(async (request, response) => {
  if (request.url === '/ui.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(await readFile('.cache/ui.js')); return; }
  if (!request.url.startsWith('/api/')) { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><html lang="zh"><meta charset="utf-8"><title>SSH 侧边栏验证</title><style>body{margin:0;background:#f3f5f8}#root{width:390px;height:880px;margin:24px auto;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;background:white}@media(max-width:400px){#root{width:100vw;height:100vh;margin:0;border:0;border-radius:0}}</style><div id="root"></div><script type="module" src="/ui.js"></script></html>'); return; }
  try {
    let body = ''; for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body), method = request.url.split('/').at(-1);
    assert.equal(payload.sessionId, 'ui-test');
    let value;
    if (method === 'status') value = state();
    else if (method === 'setup.state') value = setup;
    else if (method === 'setup.start') {
      assert.equal(payload.password, 'fixture-only-password');
      setup = { id: `setup-${++setupCount}`, phase: 'host-key', running: true, connection: { host: payload.host, user: payload.user, port: payload.port }, fingerprint: 'SHA256:FixtureHostFingerprint123', hostPrompt: 'The authenticity of host prod.example.com cannot be established.\nED25519 key fingerprint is SHA256:FixtureHostFingerprint123.\nAre you sure you want to continue connecting (yes/no)?' };
      value = setup;
    }
    else if (method === 'setup.confirm') {
      assert.equal(payload.fingerprint, setup.fingerprint);
      setup = { ...setup, phase: payload.trust ? 'success' : 'cancelled', running: false, hostPrompt: undefined,
        identityFile: '/home/dsh/.ssh/dsh-ssh/id_ed25519_fixture', mayHaveInstalledKey: payload.trust };
      value = { ok: true };
    }
    else if (method === 'setup.cancel') { setup = { ...setup, phase: 'cancelled', running: false }; value = { ok: true }; }
    else if (method === 'authorize') { assert.equal(payload.host, 'prod.example.com'); connected = true; authorizations++; value = state(); }
    else if (method === 'instructions') value = { text: '当前会话已授权远程操作 prod.example.com' };
    else if (method === 'revoke') { connected = false; terminalRunning = false; value = state(); }
    else if (!connected) throw new Error('未授权');
    else if (method === 'terminal.open') { terminalRunning = true; output = '\x1b[32mdeploy@production-01\x1b[0m:~$ '; value = { output, offset: output.length, running: true }; }
    else if (method === 'terminal.read') value = { output: output.slice(payload.offset), offset: output.length, running: terminalRunning, truncated: false };
    else if (method === 'terminal.write') {
      input += payload.data;
      if (input.includes('\r')) { const command = input.replaceAll('\r', '').trim(); output += `${command}\r\nLinux production-01 6.8.0 x86_64 GNU/Linux\r\n\x1b[32mdeploy@production-01\x1b[0m:~$ `; input = ''; }
      value = { ok: true };
    } else if (method === 'terminal.close') { terminalRunning = false; value = { ok: true }; }
    else if (method === 'terminal.resize') value = { ok: true };
    else throw new Error(method);
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ ok: true, value }));
  } catch (error) { response.writeHead(400).end(JSON.stringify({ ok: false, error: error.message })); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 740, height: 930 }, deviceScaleFactor: 1 });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByText('未连接', { exact: true }).waitFor();
  await page.getByLabel('主机 / SSH 别名').fill('prod.example.com');
  await page.getByLabel('用户名', { exact: true }).fill('deploy');
  await page.getByLabel('端口', { exact: true }).fill('2222');
  await page.getByRole('button', { name: '保存连接信息', exact: true }).click();
  assert.equal(authorizations, 0);
  await page.screenshot({ path: 'docs/ssh-connect.png', fullPage: true });
  await page.getByRole('button', { name: '配置免密登录', exact: true }).click();
  await page.getByLabel('首次登录密码', { exact: true }).fill('fixture-only-password');
  await page.locator('.ssh-setup').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'docs/ssh-setup-password.png', fullPage: true });
  await page.getByRole('button', { name: '生成密钥并配置免密', exact: true }).click();
  await page.getByRole('alertdialog', { name: '确认远端主机指纹' }).waitFor();
  assert.equal(await page.getByLabel('主机 / SSH 别名').isDisabled(), true);
  assert.equal(authorizations, 0);
  await page.locator('.ssh-setup').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'docs/ssh-setup-fingerprint.png', fullPage: true });
  await page.getByRole('button', { name: '不信任并取消', exact: true }).click();
  await page.getByText('配置已取消', { exact: true }).waitFor();
  await page.getByLabel('首次登录密码', { exact: true }).fill('fixture-only-password');
  await page.getByRole('button', { name: '生成密钥并配置免密', exact: true }).click();
  await page.getByRole('alertdialog', { name: '确认远端主机指纹' }).waitFor();
  await page.getByRole('button', { name: '指纹正确，信任此主机', exact: true }).click();
  await page.getByText('免密登录已验证', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('首次登录密码', { exact: true }).inputValue(), '');
  assert.equal(await page.getByLabel('私钥路径', { exact: false }).inputValue(), '/home/dsh/.ssh/dsh-ssh/id_ed25519_fixture');
  assert.equal(authorizations, 0);
  assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes('fixture-only-password')), false);
  await page.getByRole('button', { name: '保存连接信息', exact: true }).click();
  await page.locator('.ssh-setup').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'docs/ssh-setup-success.png', fullPage: true });
  await page.setViewportSize({ width: 320, height: 850 });
  await page.locator('.ssh-setup').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'docs/ssh-setup-narrow.png', fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.setViewportSize({ width: 740, height: 930 });
  await page.getByRole('button', { name: '连接并授权当前会话' }).click();
  await page.locator('.xterm-screen').waitFor();
  await page.getByRole('button', { name: '通知当前会话 AI' }).click();
  await page.waitForFunction(() => window.notified?.includes('prod.example.com'));
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('uname -a'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.xterm-screen')?.textContent.includes('Linux production-01'));
  await page.screenshot({ path: 'docs/ssh-connected.png', fullPage: true });
  await page.setViewportSize({ width: 320, height: 850 });
  await page.screenshot({ path: 'docs/ssh-narrow.png', fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.getByRole('button', { name: '撤销授权并断开' }).click();
  await page.getByText('未连接', { exact: true }).waitFor();
  assert.equal(terminalRunning, false);
  await page.reload(); await page.getByText('未连接', { exact: true }).waitFor();
  assert.equal(authorizations, 1);
  assert.equal(await page.getByLabel('主机 / SSH 别名').inputValue(), 'prod.example.com');
  assert.deepEqual(errors, []);
  process.stdout.write('界面验证通过：免密配置、拒绝和确认指纹、密码清空且不保存、密钥路径回填、配置不自动授权，以及连接、终端、撤销、重载和 320px 布局。\n');
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
