import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import xtermCss from '@xterm/xterm/css/xterm.css';
import panelCss from './client.css';

export const inject = ['slots', 'sidebarRightTabs', 'sessions'];
export async function api(sessionId, method, input = {}, signal) {
  const response = await fetch(`/api/dsh-ssh/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...input, sessionId }), signal });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.error || `请求失败（HTTP ${response.status}）`);
  return result.value;
}

function SshIcon({ size = 20 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3" /><path d="m7 9 3 3-3 3m6 0h4" /></svg>;
}
const storageKey = 'dsh-ssh.connections.v1';
const emptyConnection = { host: '', user: '', port: '', identityFile: '' };
function loadConnections() {
  try { const value = JSON.parse(localStorage.getItem(storageKey) || '[]'); return Array.isArray(value) ? value.slice(0, 50).filter(row => row && typeof row.host === 'string') : []; }
  catch { return []; }
}

export function SshTerminal({ sessionId, onError, onClose }) {
  const host = useRef(null);
  useEffect(() => {
    const terminal = new Terminal({ cursorBlink: true, fontSize: 12, fontFamily: 'Menlo, Monaco, Consolas, monospace', scrollback: 3000, theme: { background: '#14171c', foreground: '#e5e9f0', cursor: '#85b9ff', selectionBackground: '#365477' } });
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(host.current);
    let disposed = false, timer, offset = 0, ready = false, writes = Promise.resolve();
    const controller = new AbortController();
    const call = (action, input) => api(sessionId, action, input, controller.signal);
    const report = error => { if (!disposed && error.name !== 'AbortError') onError(error.message); };
    const resize = () => {
      if (disposed || !host.current?.clientWidth || !host.current?.clientHeight) return;
      fit.fit();
      if (ready) void call('terminal.resize', { cols: terminal.cols, rows: terminal.rows }).catch(report);
    };
    const receive = async () => {
      try {
        const result = await call('terminal.read', { offset });
        if (disposed) return;
        if (result.truncated) terminal.writeln('\r\n[早期输出已超出缓存]\r\n');
        terminal.write(result.output); offset = result.offset;
        if (result.running) timer = setTimeout(receive, 200);
        else { terminal.writeln(`\r\n[连接已关闭，退出码：${result.exitCode ?? '未知'}${result.error ? `；${result.error}` : ''}]`); ready = false; }
      } catch (error) { ready = false; report(error); }
    };
    resize();
    void call('terminal.open', { cols: terminal.cols, rows: terminal.rows }).then(() => {
      if (disposed) return;
      ready = true; resize(); terminal.focus(); void receive();
    }).catch(report);
    const input = terminal.onData(data => {
      if (!ready || disposed) return;
      writes = writes.then(() => { if (!disposed) return call('terminal.write', { data }); }).catch(report);
    });
    const observer = new ResizeObserver(resize); observer.observe(host.current);
    return () => { disposed = true; ready = false; clearTimeout(timer); controller.abort(); observer.disconnect(); input.dispose(); terminal.dispose(); };
  }, [sessionId]);
  return <section className="ssh-terminal-section" aria-label="远程终端">
    <div className="ssh-section-heading"><span>远程终端</span><button type="button" onClick={onClose}>关闭终端</button></div>
    <div ref={host} className="ssh-terminal" />
    <p className="ssh-hint">支持 Ctrl+C、交互程序和窗口缩放。切换面板会保留连接。</p>
  </section>;
}

export function SshPanel({ sessionId, onNotify }) {
  const [profiles, setProfiles] = useState(loadConnections);
  const [form, setForm] = useState(() => ({ ...emptyConnection, ...loadConnections()[0] }));
  const [state, setState] = useState({ state: 'loading', jobs: [] });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [showTerminal, setShowTerminal] = useState(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true; const controller = new AbortController(); let timer;
    const refresh = async () => {
      try {
        const value = await api(sessionId, 'status', {}, controller.signal);
        if (!controller.signal.aborted) { setState(value); if (value.terminal?.running) setShowTerminal(true); }
      } catch (error) { if (!controller.signal.aborted) { setError(error.message); setState({ state: 'unavailable', jobs: [] }); } }
      if (!controller.signal.aborted) timer = setTimeout(refresh, 3000);
    };
    void refresh();
    return () => { mounted.current = false; controller.abort(); clearTimeout(timer); };
  }, [sessionId]);
  const connected = state.state === 'connected';
  const connecting = state.state === 'connecting';
  const act = async task => {
    setBusy(true); setError(''); setNotice('');
    try { await task(); } catch (error) { if (mounted.current) setError(error.message); }
    finally { if (mounted.current) setBusy(false); }
  };
  const save = () => {
    if (!form.host.trim()) { setError('请填写主机地址'); return; }
    const rows = [{ ...form, host: form.host.trim() }, ...profiles.filter(row => !(row.host === form.host.trim() && row.user === form.user && row.port === form.port))].slice(0, 50);
    try { localStorage.setItem(storageKey, JSON.stringify(rows)); setProfiles(rows); setNotice('连接信息已保存；授权不会保存'); }
    catch { setError('无法保存连接信息，请检查浏览器存储权限'); }
  };
  const removeProfile = () => {
    const rows = profiles.filter(row => !(row.host === form.host && row.user === form.user && row.port === form.port));
    try { localStorage.setItem(storageKey, JSON.stringify(rows)); setProfiles(rows); setForm({ ...emptyConnection }); }
    catch { setError('无法删除连接信息'); }
  };
  return <div className="dsh-ssh-panel">
    <header className="ssh-header"><span className="ssh-heading"><SshIcon /><strong>SSH 远程</strong></span><span className={`ssh-status ${connected ? 'is-connected' : ''}`}><i />{connected ? '已授权' : connecting ? '连接中' : state.state === 'loading' ? '加载中' : '未连接'}</span></header>
    <div className="ssh-content">
      {error && <div role="alert" className="ssh-message ssh-error">{error}</div>}
      {notice && <div role="status" className="ssh-message">{notice}</div>}
      {connected ? <>
        <section className="ssh-card"><div className="ssh-section-heading"><strong>当前远端</strong><span className="ssh-tag">仅当前会话</span></div>
          <div className="ssh-host">{state.connection.user ? `${state.connection.user}@` : ''}{state.connection.host}{state.connection.port ? `:${state.connection.port}` : ''}</div>
          <pre className="ssh-identity">{state.identity}</pre>
          <p className="ssh-hint">当前会话的 AI 可执行远端账号权限内的任意命令，包括修改文件、部署和删除数据。</p>
          <div className="ssh-actions"><button className="ssh-primary" type="button" disabled={busy} onClick={() => act(async () => { const result = await api(sessionId, 'instructions'); await onNotify(result.text); if (mounted.current) setNotice('已通知当前会话 AI'); })}>通知当前会话 AI</button>
            <button className="ssh-danger" type="button" disabled={busy} onClick={() => act(async () => { await api(sessionId, 'revoke'); if (mounted.current) { setState({ state: 'disconnected', jobs: [] }); setShowTerminal(false); } })}>撤销授权并断开</button></div>
        </section>
        {showTerminal ? <SshTerminal sessionId={sessionId} onError={setError} onClose={() => act(async () => { await api(sessionId, 'terminal.close'); if (mounted.current) setShowTerminal(false); })} />
          : <button className="ssh-open-terminal" type="button" onClick={() => setShowTerminal(true)}><SshIcon size={18} />打开远程终端</button>}
        <section className="ssh-card"><div className="ssh-section-heading"><strong>AI 远程任务</strong><span className="ssh-hint">{state.jobs.filter(job => job.running).length} 个运行中</span></div>
          {state.jobs.length === 0 ? <p className="ssh-hint">通知 AI 后，即可在会话中提出远程操作需求。</p> : state.jobs.slice(-8).reverse().map(job => <div className="ssh-job" key={job.id}><code title={job.id}>{job.id.slice(0, 8)}</code><span>{job.running ? '运行中' : `已结束 · ${job.exitCode ?? '未知'}`}</span>{job.running && <button type="button" disabled={busy} onClick={() => act(async () => { await api(sessionId, 'stop', { id: job.id }); if (mounted.current) setState(await api(sessionId, 'status')); })}>停止</button>}</div>)}
        </section>
      </> : <form onSubmit={event => { event.preventDefault(); void act(async () => {
        const result = await api(sessionId, 'authorize', form);
        if (mounted.current) { setState(result); setShowTerminal(true); }
      }); }}>
        <div className="ssh-intro"><SshIcon size={30} /><h2>连接你的远端机器</h2><p>使用本机 SSH 配置、密钥或 SSH Agent，授权当前会话进行远程操作。</p></div>
        {profiles.length > 0 && <label className="ssh-field">已保存的连接<select aria-label="已保存的连接" value="" disabled={busy || connecting} onChange={event => { const row = profiles[Number(event.target.value)]; if (row) setForm({ ...emptyConnection, ...row }); }}><option value="" disabled>选择一个连接</option>{profiles.map((row, index) => <option key={index} value={index}>{row.user ? `${row.user}@` : ''}{row.host}{row.port ? `:${row.port}` : ''}</option>)}</select></label>}
        <label className="ssh-field">主机 / SSH 别名<input required autoComplete="off" placeholder="例如 prod 或 192.168.1.10" value={form.host} disabled={busy || connecting} onChange={event => setForm({ ...form, host: event.target.value })} /></label>
        <div className="ssh-field-row"><label className="ssh-field">用户名<input autoComplete="off" placeholder="使用 SSH 配置" value={form.user} disabled={busy || connecting} onChange={event => setForm({ ...form, user: event.target.value })} /></label><label className="ssh-field">端口<input inputMode="numeric" type="number" min="1" max="65535" placeholder="SSH 配置 / 22" value={form.port} disabled={busy || connecting} onChange={event => setForm({ ...form, port: event.target.value })} /></label></div>
        <label className="ssh-field">私钥路径<span className="ssh-optional">可选</span><input autoComplete="off" placeholder="~/.ssh/id_ed25519" value={form.identityFile} disabled={busy || connecting} onChange={event => setForm({ ...form, identityFile: event.target.value })} /></label>
        <p className="ssh-hint">留空时使用本机 SSH 配置与 SSH Agent。加密私钥请先通过 ssh-add 加入 Agent。</p>
        <div className="ssh-auth-note"><strong>本次授权范围</strong><p>允许当前会话的 AI 和终端操作这台机器，权限与登录账号相同；撤销、会话卸载或宿主重启后失效。</p></div>
        <button className="ssh-primary ssh-connect" type="submit" disabled={busy || connecting || state.state === 'loading' || state.state === 'unavailable'}>{busy || connecting ? '正在连接…' : '连接并授权当前会话'}</button>
        <div className="ssh-save-actions"><button type="button" disabled={busy || connecting} onClick={save}>保存连接信息</button>{profiles.some(row => row.host === form.host && row.user === form.user && row.port === form.port) && <button type="button" disabled={busy || connecting} onClick={removeProfile}>删除已保存连接</button>}</div>
        {connecting && <button className="ssh-cancel" type="button" onClick={() => void api(sessionId, 'revoke').then(() => setState({ state: 'disconnected', jobs: [] })).catch(error => setError(error.message))}>取消连接</button>}
        <details className="ssh-help"><summary>首次连接或连接失败？</summary><p>先在系统终端运行 <code>ssh 主机别名</code>，核对并信任主机指纹。插件不接受未知或变更的主机密钥，也不会自动跳过校验。</p><p>使用跳板机时，请在 ~/.ssh/config 中配置 ProxyJump。远端需提供 POSIX Shell。</p></details>
      </form>}
    </div>
    <footer className="ssh-footer">OpenSSH · 严格主机校验 · 会话授权</footer>
  </div>;
}

export function apply(ctx) {
  ctx.effect(() => { const style = document.createElement('style'); style.textContent = xtermCss + '\n' + panelCss; document.head.append(style); return () => style.remove(); });
  ctx.effect(() => ctx.sidebarRightTabs.register({ id: 'dsh-ssh', kind: 'ssh', title: () => 'SSH 远程', guide: [{ id: 'ssh', order: 30, title: () => 'SSH 远程', description: () => '连接远端机器，授权当前会话与终端操作', icon: SshIcon }] }));
  function Body({ sessionId }) {
    const notify = async text => {
      const scope = ctx.sessions.scope(sessionId);
      const session = scope && ctx.sessions.sessionOf(scope);
      if (!session) throw new Error('当前会话不可用');
      const submission = session.beginSubmission({ mode: 'queue', text, attachments: [] });
      const result = await session.prompt([{ type: 'text', text }], 'queue', undefined, submission.requestId);
      if (!result.ok) throw new Error(result.error.message);
    };
    return <SshPanel key={sessionId} sessionId={sessionId} onNotify={notify} />;
  }
  function Guide({ kind, title, description, useTabInfo }) {
    const { tab } = useTabInfo();
    return <button className="ssh-guide" type="button" data-sidebar-right-guide-entry={kind} onClick={() => tab.actions.openTab(kind, { replaceTab: true })}><SshIcon size={26} /><span><strong>{title}</strong><small>{description}</small><small>由 dsh-ssh 插件提供</small></span></button>;
  }
  for (const [slot, component] of [['sidebar.right.pane.tab', Body], ['sidebar.right.pane.tab.title', () => <><SshIcon size={16} /> SSH 远程</>], ['sidebar.right.tab.guide.entry', Guide]]) {
    ctx.effect(() => ctx.slots.inject(slot, () => ctx.slots.register({ name: slot, key: 'dsh-ssh' }, component)));
  }
}
