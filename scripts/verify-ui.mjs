import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium, webkit } from '@playwright/test';

await mkdir('.cache', { recursive: true }); await mkdir('docs', { recursive: true });
const themeCss = await readFile(resolve(process.env.DSH_REFERENCE_ROOT ?? '../../deepseek-harness', 'packages/client/ui-theme/src/styles/design-platform.css'), 'utf8');
await writeFile('.cache/ui-entry.jsx', "import React from 'react';\nimport {createRoot} from 'react-dom/client';\nimport {SshPanel,api} from '../src/client.jsx';\nimport panel from '../src/client.css';\nimport {fontCss} from '../src/fonts.mjs';\nwindow.sshApi=api;\nconst style=document.createElement('style');style.textContent=fontCss+'\\n'+panel;document.head.append(style);\ncreateRoot(document.getElementById('root')).render(<SshPanel sessionId=\"ui-test\" onNotify={async text=>{window.notified=text;}}/>);");
await build({ entryPoints: ['.cache/ui-entry.jsx'], outfile: '.cache/ui.js', bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', loader: { '.css': 'text', '.woff2': 'dataurl' } });

let connection = null, authorizations = 0, setup = { phase: 'idle', running: false }, setupCount = 0;
const calls = [], failingHosts = new Set(), trustedHosts = new Set();
const state = () => ({ state: connection ? 'connected' : 'disconnected', connection, jobs: [], terminal: null });
const resource = host => ({ os: 'Linux', hostname: host === 'prod.example.com' ? 'production-01' : 'staging-01', cores: 2, cpuPercent: 12.5,
  memory: { totalBytes: 1073741824, availableBytes: 805306368, usedBytes: 268435456 },
  disk: { totalBytes: 42949672960, usedBytes: 10737418240, availableBytes: 30064771072 }, uptimeSeconds: 12345, collectedAt: Date.now() });
const server = createServer(async (request, response) => {
  if (request.url === '/ui.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(await readFile('.cache/ui.js')); return; }
  if (request.url === '/theme.css') { response.setHeader('Content-Type', 'text/css'); response.end(themeCss); return; }
  if (!request.url.startsWith('/api/')) {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><html lang="zh" data-platform="darwin"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SSH 页面验证</title><link rel="stylesheet" href="/theme.css"><style>body{margin:0;background:#f3f5f8}#root{width:420px;height:900px;margin:16px auto;overflow:hidden;border:1px solid #ddd;border-radius:12px}@media(max-width:440px){#root{width:100vw;height:100dvh;margin:0;border:0;border-radius:0}}</style><div id="root"></div><script type="module" src="/ui.js"></script></html>');
    return;
  }
  try {
    let body = ''; for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body), method = request.url.split('/').at(-1);
    assert.equal(payload.sessionId, 'ui-test'); calls.push({ method, host: payload.host });
    let value;
    if (method === 'status') value = state();
    else if (method === 'resources') {
      if (failingHosts.has(payload.host)) throw new Error('无法连接主机，请检查密钥认证和网络');
      value = resource(payload.host);
    } else if (method === 'setup.state') {
      if (['checking', 'installing'].includes(setup.phase)) setup = { ...setup, phase: 'success', running: false, identityFile: setup.authMode === 'key' ? setup.connection.identityFile || '' : '/home/dsh/.ssh/dsh-ssh/id_ed25519_fixture' };
      value = setup;
    }
    else if (method === 'setup.start') {
      assert.ok(payload.authMode === 'key' ? payload.password === undefined : ['fixture-only-password', 'wrong-fixture-password'].includes(payload.password));
      const valid = payload.authMode === 'key' || payload.password === 'fixture-only-password';
      setup = { id: 'setup-' + ++setupCount, authMode: payload.authMode, phase: valid ? trustedHosts.has(payload.host) ? payload.authMode === 'key' ? 'checking' : 'installing' : 'host-key' : 'error', running: valid,
        connection: { host: payload.host, user: payload.user, port: payload.port, identityFile: payload.identityFile || '' }, fingerprint: 'SHA256:FixtureHostFingerprint123',
        hostPrompt: 'The authenticity of host cannot be established.\nED25519 key fingerprint is SHA256:FixtureHostFingerprint123.',
        error: valid ? undefined : '首次认证失败，请检查用户名、密码及远端是否允许密码认证' };
      value = setup;
    } else if (method === 'setup.confirm') {
      assert.equal(payload.fingerprint, setup.fingerprint);
      if (payload.trust) trustedHosts.add(setup.connection.host);
      setup = { ...setup, phase: payload.trust ? 'success' : 'error', running: false, error: payload.trust ? undefined : '未信任远端主机', hostPrompt: undefined, identityFile: setup.authMode === 'key' ? setup.connection.identityFile || '' : '/home/dsh/.ssh/dsh-ssh/id_ed25519_fixture', mayHaveInstalledKey: payload.trust && setup.authMode !== 'key' };
      value = { ok: true };
    } else if (method === 'setup.cancel') { setup = { ...setup, phase: 'cancelled', running: false }; value = { ok: true }; }
    else if (method === 'authorize') { assert.equal(connection, null); connection = { host: payload.host, user: payload.user, port: payload.port }; authorizations++; value = state(); }
    else if (method === 'instructions') { assert.ok(connection); value = { text: '当前会话已授权远程操作 ' + connection.host }; }
    else if (method === 'revoke') { connection = null; value = state(); }
    else throw new Error('不支持的操作：' + method);
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ ok: true, value }));
  } catch (error) { response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: false, error: error.message })); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

async function contrastChecks(page, engine, dark, width) {
  const results = await page.locator('.ssh-primary,.ssh-error,.ssh-host-error,.ssh-connection-status.is-error').evaluateAll(buttons => {
    const canvas = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    const color = value => {
      canvas.clearRect(0, 0, 1, 1); canvas.fillStyle = value; canvas.fillRect(0, 0, 1, 1);
      const rgba = [...canvas.getImageData(0, 0, 1, 1).data]; rgba[3] /= 255; return rgba;
    };
    const over = (front, back) => front.slice(0, 3).map((channel, index) => channel * (front[3] ?? 1) + back[index] * (1 - (front[3] ?? 1)));
    const luminance = rgb => rgb.map(value => { const channel = value / 255; return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4; }).reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
    return buttons.flatMap(button => {
      const original = button.disabled;
      try { return ('disabled' in button ? [false, true] : [false]).map(disabled => {
        button.disabled = disabled;
        const ancestors = []; for (let node = button; node; node = node.parentElement) ancestors.unshift(node);
        const background = ancestors.reduce((back, node) => over(color(getComputedStyle(node).backgroundColor), back), [255, 255, 255]);
        const foreground = over(color(getComputedStyle(button).color), background);
        const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
        return { label: button.textContent, disabled, ratio: (values[0] + .05) / (values[1] + .05) };
      }); } finally { button.disabled = original; }
    });
  });
  assert.ok(results.length > 0);
  for (const result of results) assert.ok(result.ratio >= 4.5, engine.name() + ' ' + (dark ? '深色' : '浅色') + ' ' + width + 'px ' + JSON.stringify(result));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth || [...document.querySelectorAll('.ssh-card')].some(node => node.scrollWidth > node.clientWidth)), false);
}

let browser;
try {
  for (const engine of [webkit, chromium]) {
    connection = null; authorizations = 0; setup = { phase: 'idle', running: false }; failingHosts.clear(); trustedHosts.clear(); calls.length = 0;
    browser = await engine.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error' && !message.text().includes('Failed to load resource')) errors.push(message.text()); });
    let statusFailure = true;
    await page.route('**/api/dsh-ssh/status', route => statusFailure ? route.fulfill({ status: 401, contentType: 'text/plain', body: 'unauthorized' }) : route.continue());
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.getByRole('alert').filter({ hasText: 'HTTP 401' }).waitFor();
    statusFailure = false; await page.waitForFunction(() => !document.querySelector('[role="alert"]'));
    await page.getByText('还没有主机', { exact: true }).waitFor();
    await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''));
    await page.evaluate(() => document.fonts.ready); await page.screenshot({ path: 'docs/ssh-empty-dark.png', fullPage: true });
    await page.locator('.ssh-session-section').screenshot({ path: 'docs/ssh-session-single-line.png' });
    for (const [status, body, expected] of [[403, 'forbidden', 'HTTP 403'], [404, 'not found', 'HTTP 404'], [502, '', 'HTTP 502'], [200, '<html>登录</html>', '不是有效 JSON'], [200, 'null', '格式无效'], [400, '{"ok":false,"error":"会话未加载"}', '会话未加载']]) {
      await page.route('**/api/dsh-ssh/diagnostic', route => route.fulfill({ status, body }));
      const message = await page.evaluate(async () => { try { await window.sshApi('ui-test', 'diagnostic'); return ''; } catch (error) { return error.message; } });
      assert.ok(message.includes(expected), message); await page.unroute('**/api/dsh-ssh/diagnostic');
    }
    await page.getByRole('button', { name: '新增主机', exact: true }).click();
    await page.getByRole('heading', { name: '主机认证', exact: true }).waitFor();
    await page.getByLabel('主机名称', { exact: false }).fill('生产环境');
    await page.getByLabel('主机地址', { exact: true }).fill('prod.example.com');
    await page.getByLabel('用户名', { exact: true }).fill('deploy');
    await page.getByLabel('端口', { exact: true }).fill('2222');
    await page.getByLabel('登录密码', { exact: true }).fill('fixture-only-password');
    await page.getByRole('button', { name: '显示密码', exact: true }).click();
    assert.equal(await page.getByLabel('登录密码', { exact: true }).getAttribute('type'), 'text');
    await page.getByRole('button', { name: '隐藏密码', exact: true }).click();
    await page.getByRole('button', { name: '已有密钥', exact: true }).click();
    assert.equal(await page.getByLabel('登录密码', { exact: true }).count(), 0);
    await page.getByRole('button', { name: '密码配置', exact: true }).click();
    assert.equal(await page.getByLabel('登录密码', { exact: true }).inputValue(), '');
    await page.getByLabel('登录密码', { exact: true }).fill('fixture-only-password');
    await page.getByLabel('登录密码', { exact: true }).press('Enter');
    await page.getByRole('alertdialog', { name: '确认远端主机指纹' }).waitFor();
    assert.equal(await page.getByLabel('主机地址', { exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '返回主机首页' }).isDisabled(), true);
    await page.getByRole('button', { name: '信任并继续' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'docs/ssh-auth-fingerprint-dark.png', fullPage: true });
    await page.getByRole('button', { name: '拒绝', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '未信任远端主机' }).waitFor(); assert.equal(authorizations, 0);
    await page.getByLabel('登录密码', { exact: true }).fill('wrong-fixture-password');
    await page.getByRole('button', { name: '验证并保存主机', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '首次认证失败' }).waitFor();
    assert.equal(await page.getByLabel('登录密码', { exact: true }).inputValue(), '');
    for (const dark of [false, true]) {
      await page.evaluate(dark => document.body.toggleAttribute('data-ds-dark-theme', dark), dark);
      await contrastChecks(page, engine, dark, 390);
    }
    await page.screenshot({ path: 'docs/ssh-auth-error-dark.png', fullPage: true });
    await page.getByLabel('登录密码', { exact: true }).fill('fixture-only-password');
    await page.getByRole('button', { name: '验证并保存主机', exact: true }).click();
    await page.getByRole('button', { name: '信任并继续' }).click();
    await page.getByRole('heading', { name: 'SSH 远程', exact: true }).waitFor();
    const prod = () => page.getByRole('article', { name: '主机 生产环境', exact: true });
    await prod().getByText('13%', { exact: true }).waitFor(); assert.equal(authorizations, 0);
    const savedNotice = page.getByRole('status').filter({ hasText: '已保存 生产环境' });
    await savedNotice.waitFor();
    await page.screenshot({ path: 'docs/ssh-notice-visible.png', fullPage: true });
    await savedNotice.waitFor({ state: 'hidden', timeout: 5000 });
    assert.equal(await prod().count(), 1); assert.equal(authorizations, 0);
    await page.screenshot({ path: 'docs/ssh-notice-dismissed.png', fullPage: true });
    assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes('fixture-only-password')), false);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('dsh-ssh.connections.v1'))[0].identityFile), '/home/dsh/.ssh/dsh-ssh/id_ed25519_fixture');
    await prod().getByRole('button', { name: '授权当前会话', exact: true }).click();
    await page.getByText('已授权：生产环境', { exact: true }).waitFor();
    await page.getByRole('button', { name: '通知当前会话 AI' }).click();
    await page.waitForFunction(() => window.notified?.includes('prod.example.com'));
    await page.getByRole('button', { name: '新增主机', exact: true }).click();
    await page.waitForResponse(response => response.url().endsWith('/api/dsh-ssh/setup.state'));
    await page.evaluate(() => new Promise(requestAnimationFrame));
    assert.equal(await page.getByRole('button', { name: '保存已验证主机' }).count(), 0);
    assert.equal(await page.getByLabel('登录密码', { exact: true }).inputValue(), '');
    await page.getByLabel('主机名称', { exact: false }).fill('测试环境');
    await page.getByLabel('主机地址', { exact: true }).fill('staging.example.com');
    await page.getByLabel('用户名', { exact: true }).fill('root');
    await page.getByRole('button', { name: '已有密钥', exact: true }).click();
    assert.equal(await page.getByLabel('私钥路径', { exact: false }).inputValue(), '');
    await page.getByRole('button', { name: '验证并保存主机', exact: true }).click();
    await page.getByRole('alertdialog', { name: '确认远端主机指纹' }).waitFor();
    assert.equal(await page.getByLabel('登录密码', { exact: true }).count(), 0);
    await page.getByRole('button', { name: '信任并继续' }).click();
    const staging = () => page.getByRole('article', { name: '主机 测试环境', exact: true });
    await staging().getByText('13%', { exact: true }).waitFor();
    assert.equal(authorizations, 1); assert.equal(connection.host, 'prod.example.com');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('dsh-ssh.connections.v1')).length), 2);
    assert.ok(calls.some(call => call.method === 'resources' && call.host === 'prod.example.com'));
    assert.ok(calls.some(call => call.method === 'resources' && call.host === 'staging.example.com'));
    failingHosts.add('staging.example.com');
    await page.getByRole('button', { name: '刷新资源' }).click();
    await staging().getByText('连接异常', { exact: true }).waitFor(); await prod().getByText('13%', { exact: true }).waitFor();
    for (const dark of [false, true]) {
      await page.evaluate(dark => document.body.toggleAttribute('data-ds-dark-theme', dark), dark);
      for (const width of [390, 320, 740]) {
        await page.setViewportSize({ width, height: 844 });
        await page.locator('#root').evaluate((node, width) => { node.style.width = width > 440 ? '700px' : ''; }, width);
        await contrastChecks(page, engine, dark, width);
        if (width === 390) {
          await page.locator('.ssh-list-caption').screenshot({ path: 'docs/ssh-home-footer-' + (dark ? 'dark' : 'light') + '.png' });
          await page.locator('.ssh-content').evaluate(node => { node.scrollTop = 0; });
          await page.screenshot({ path: 'docs/ssh-home-' + (dark ? 'dark' : 'light') + '.png', fullPage: true });
        }
        if (width === 320 && dark) await page.screenshot({ path: 'docs/ssh-home-narrow.png', fullPage: true });
      }
      await page.setViewportSize({ width: 390, height: 844 }); await page.locator('#root').evaluate(node => { node.style.width = ''; });
      await staging().getByRole('button', { name: '管理主机 测试环境' }).click();
      assert.equal(await page.getByLabel('主机地址', { exact: true }).inputValue(), 'staging.example.com');
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: 'docs/ssh-auth-key-' + (dark ? 'dark' : 'light') + '.png', fullPage: true });
      await page.getByRole('button', { name: '密码配置', exact: true }).click();
      await page.getByRole('button', { name: '验证并保存主机', exact: true }).waitFor();
      await contrastChecks(page, engine, dark, 390);
      await page.screenshot({ path: 'docs/ssh-auth-' + (dark ? 'dark' : 'light') + '.png', fullPage: true });
      for (const width of [320, 740]) {
        await page.setViewportSize({ width, height: 540 });
        await page.locator('#root').evaluate((node, width) => { node.style.width = width > 440 ? '700px' : ''; }, width);
        await contrastChecks(page, engine, dark, width);
        await page.getByRole('button', { name: '验证并保存主机', exact: true }).scrollIntoViewIfNeeded();
        if (dark && width === 320) await page.screenshot({ path: 'docs/ssh-auth-narrow.png', fullPage: true });
      }
      await page.setViewportSize({ width: 390, height: 844 }); await page.locator('#root').evaluate(node => { node.style.width = ''; });
      await page.getByRole('button', { name: '返回主机首页' }).click();
    }
    await page.reload(); await page.getByText('已授权：生产环境', { exact: true }).waitFor(); await prod().getByText('13%', { exact: true }).waitFor();
    await staging().getByRole('button', { name: '管理主机 测试环境' }).click();
    await page.getByRole('button', { name: '移除保存信息', exact: true }).click();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('dsh-ssh.connections.v1')).length), 1);
    await page.getByText('已授权：生产环境', { exact: true }).waitFor(); assert.equal(authorizations, 1);
    await page.getByRole('button', { name: '撤销授权', exact: true }).click();
    await page.getByText('当前会话尚未授权', { exact: true }).waitFor(); assert.equal(connection, null);
    await page.route('**/api/dsh-ssh/authorize', route => route.fulfill({ status: 400, contentType: 'application/json', body: '{"ok":false,"error":"SSH 测试连接失败"}' }));
    await prod().getByRole('button', { name: '授权当前会话', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'SSH 测试连接失败' }).waitFor();
    await page.waitForResponse(response => response.url().endsWith('/api/dsh-ssh/status')); await page.evaluate(() => new Promise(requestAnimationFrame));
    assert.equal(await page.getByRole('alert').filter({ hasText: 'SSH 测试连接失败' }).count(), 1);
    await prod().getByRole('button', { name: '管理主机 生产环境' }).click();
    await page.getByLabel('主机名称', { exact: false }).fill('不能保存的改动');
    await page.evaluate(() => { window.originalSetItem = Storage.prototype.setItem; Storage.prototype.setItem = () => { throw new Error('测试存储已满'); }; });
    await page.getByRole('button', { name: '验证并保存主机', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '无法保存' }).waitFor();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('dsh-ssh.connections.v1'))[0].name), '生产环境');
    await page.evaluate(() => { Storage.prototype.setItem = window.originalSetItem; delete window.originalSetItem; });
    await page.getByRole('button', { name: '返回主机首页' }).click();
    await page.evaluate(() => localStorage.setItem('dsh-ssh.connections.v1', JSON.stringify([{ host: 'legacy.example.com', user: 'deploy', port: '22', identityFile: '' }])));
    await page.reload(); await page.getByRole('article', { name: '主机 legacy.example.com', exact: true }).waitFor();
    await page.evaluate(() => localStorage.setItem('dsh-ssh.connections.v1', JSON.stringify(Array.from({ length: 50 }, (_, index) => ({ host: 'limit-' + index + '.example.com', user: 'deploy', port: '', identityFile: '' })))));
    await page.reload(); await page.getByRole('button', { name: '新增主机', exact: true }).click();
    await page.getByLabel('主机地址', { exact: true }).fill('limit-new.example.com');
    await page.getByRole('button', { name: '已有密钥', exact: true }).click();
    await page.getByRole('button', { name: '验证并保存主机', exact: true }).click();
    await page.getByRole('button', { name: '信任并继续' }).click();
    await page.getByRole('alert').filter({ hasText: '最多保存 50 台主机' }).waitFor();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('dsh-ssh.connections.v1')).length), 50);
    assert.equal(authorizations, 1); assert.equal(calls.some(call => call.method.startsWith('terminal.')), false);
    assert.equal(await page.getByRole('button', { name: /终端/ }).count(), 0); assert.deepEqual(errors, []);
    process.stdout.write(engine.name() + ' 验证通过：双页面导航、多主机资源与失败隔离、密码/密钥首次指纹确认、拒绝/重试、保存不授权、已有授权下新增主机、通知/撤销、旧资料兼容、存储失败和上限保护、深浅主题对比度与双页面 320/390/740px 布局，无终端请求。\n');
    await browser.close(); browser = undefined;
  }
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
