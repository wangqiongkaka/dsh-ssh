import { useEffect, useRef, useState } from 'react';
import panelCss from './client.css';
import { PasswordlessSetupView } from './setup-view.jsx';
import { Icon } from './icons.jsx';
import { fontCss } from './fonts.mjs';

export const inject = ['slots', 'sidebarRightTabs', 'sessions'];
export async function api(sessionId, method, input = {}, signal) {
  const response = await fetch('/api/dsh-ssh/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...input, sessionId }), signal });
  const failure = 'SSH 接口请求失败（HTTP ' + response.status + '）';
  let result;
  try { result = await response.json(); }
  catch (error) {
    if (error.name === 'AbortError') throw error;
    if (response.ok) throw new Error('SSH 接口响应不是有效 JSON（HTTP ' + response.status + '），请确认插件已启用并刷新页面');
    const hint = { 401: 'DSH 访问授权已失效，请刷新页面或重新扫码', 403: 'DSH 拒绝访问，请检查访问授权', 404: 'SSH 接口未就绪，请在宿主重新加载 SSH 插件后刷新页面' }[response.status];
    throw new Error(hint ? failure + '：' + hint : failure);
  }
  if (!result || typeof result.ok !== 'boolean' || (result.ok ? !Object.hasOwn(result, 'value') : typeof result.error !== 'string')) throw new Error('SSH 接口响应格式无效（HTTP ' + response.status + '），请重新加载 SSH 插件后刷新页面');
  if (!response.ok || !result.ok) throw new Error(result.error || failure);
  return result.value;
}

function SshIcon({ size = 20 }) { return <Icon name="server" size={size} />; }
const storageKey = 'dsh-ssh.connections.v1';
const emptyConnection = { name: '', host: '', user: '', port: '', identityFile: '' };
const hostKey = connection => JSON.stringify([connection.host, connection.user || '', String(connection.port || '')]);
const hostLabel = connection => connection.name?.trim() || connection.host;
const hostAddress = connection => (connection.user ? connection.user + '@' : '') + connection.host + (connection.port ? ':' + connection.port : '');
function loadConnections() {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) || '[]');
    return Array.isArray(value) ? value.filter(row => row && typeof row.host === 'string'
      && ['name', 'user', 'identityFile'].every(key => row[key] === undefined || typeof row[key] === 'string')
      && (row.port === undefined || typeof row.port === 'string' || typeof row.port === 'number')).slice(0, 50) : [];
  } catch { return []; }
}
function bytes(value) {
  if (!Number.isFinite(value) || value < 0) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'], index = value ? Math.min(4, Math.floor(Math.log(value) / Math.log(1024))) : 0;
  return (value / 1024 ** index).toFixed(index >= 3 ? 1 : 0) + ' ' + units[index];
}
function Metric({ label, percent, detail }) {
  const known = Number.isFinite(percent);
  return <div className="ssh-metric"><span>{label}</span><strong>{known ? Math.round(percent) + '%' : '—'}</strong><small>{detail || '暂不可用'}</small>
    <div className="ssh-meter" role="progressbar" aria-label={label + '使用率'} aria-valuemin={0} aria-valuemax={100} aria-valuenow={known ? Math.round(percent) : undefined} aria-valuetext={known ? undefined : '暂不可用'}><i style={{ width: known ? Math.max(0, Math.min(100, percent)) + '%' : '0%' }} /></div>
  </div>;
}
function HostCard({ profile, resource = {}, authorized, canAuthorize, busy, onAuthorize, onManage }) {
  const value = resource.error ? null : resource.value;
  const status = resource.error ? '连接异常' : value ? '在线' : resource.loading ? '采集中' : '待采集';
  return <article className="ssh-host-card ssh-card" aria-label={'主机 ' + hostLabel(profile)}>
    <div className="ssh-host-heading"><div className="ssh-host-title"><span className={'ssh-dot ' + (resource.error ? 'is-error' : value ? 'is-online' : '')} /><h3>{hostLabel(profile)}</h3></div>
      {authorized ? <span className="ssh-tag"><Icon name="check" size={12} />已授权</span> : <span className={'ssh-connection-status ' + (resource.error ? 'is-error' : '')}>{status}</span>}</div>
    <p className="ssh-host-address">{hostAddress(profile)}</p>
    <div className="ssh-metrics">
      <Metric label="CPU" percent={value?.cpuPercent} detail={value?.cores ? value.cores + ' 核' : ''} />
      <Metric label="内存" percent={value?.memory ? value.memory.usedBytes / value.memory.totalBytes * 100 : null} detail={value?.memory ? bytes(value.memory.usedBytes) + ' / ' + bytes(value.memory.totalBytes) : ''} />
      <Metric label="根磁盘" percent={value?.disk ? value.disk.usedBytes / value.disk.totalBytes * 100 : null} detail={value?.disk ? bytes(value.disk.usedBytes) + ' / ' + bytes(value.disk.totalBytes) : ''} />
    </div>
    {resource.error && <p className="ssh-host-error" role="status">{resource.error}</p>}
    {value?.unsupported && <p className="ssh-hint">{value.os} 已连接，资源指标暂仅支持 Linux。</p>}
    <div className="ssh-host-bottom"><span className="ssh-hint">{value ? value.os + (resource.loading ? ' · 更新中' : ' · 已采集') : '资源查看无需 AI 授权'}</span><div className="ssh-host-controls">
      <button className="ssh-text-button" type="button" disabled={busy} aria-label={'管理主机 ' + hostLabel(profile)} onClick={onManage}>{resource.error ? '重新认证' : '管理'}</button>
      {!authorized && <button className="ssh-secondary ssh-host-authorize" type="button" disabled={busy || !canAuthorize} onClick={onAuthorize}>授权当前会话</button>}
    </div></div>
  </article>;
}

export function SshPanel({ sessionId, onNotify }) {
  const [profiles, setProfiles] = useState(loadConnections);
  const [view, setView] = useState('home'), [editingKey, setEditingKey] = useState(null);
  const [form, setForm] = useState({ ...emptyConnection }), [authMode, setAuthMode] = useState('password');
  const [state, setState] = useState({ state: 'loading', jobs: [] });
  const [error, setError] = useState(''), [statusError, setStatusError] = useState(''), [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false), [setupRunning, setSetupRunning] = useState(false);
  const [resources, setResources] = useState({}), [refreshId, setRefreshId] = useState(0);
  const mounted = useRef(false), mutation = useRef(0);
  const connected = state.state === 'connected', connecting = state.state === 'connecting';
  const currentProfile = connected ? profiles.find(row => hostKey(row) === hostKey(state.connection)) || state.connection : null;
  const hosts = currentProfile ? [currentProfile, ...profiles.filter(row => hostKey(row) !== hostKey(currentProfile))] : profiles;
  const signature = JSON.stringify(hosts.map(row => [row.host, row.user, row.port, row.identityFile]));
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 3000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    mounted.current = true; const controller = new AbortController(); let timer;
    const refresh = async () => {
      const epoch = mutation.current;
      try {
        const value = await api(sessionId, 'status', {}, controller.signal);
        if (!controller.signal.aborted && epoch === mutation.current) { setState(value); setStatusError(''); }
      } catch (error) { if (!controller.signal.aborted && epoch === mutation.current) { setStatusError(error.message); setState({ state: 'unavailable', jobs: [] }); } }
      if (!controller.signal.aborted) timer = setTimeout(refresh, 3000);
    };
    void refresh();
    return () => { mounted.current = false; controller.abort(); clearTimeout(timer); };
  }, [sessionId]);
  useEffect(() => {
    if (view !== 'home' || !hosts.length) return;
    const controller = new AbortController(); let timer;
    const refresh = async () => {
      const queue = [...hosts];
      setResources(previous => Object.fromEntries(hosts.map(profile => [hostKey(profile), { ...previous[hostKey(profile)], loading: true }])));
      const worker = async () => {
        while (queue.length && !controller.signal.aborted) {
          const profile = queue.shift(), key = hostKey(profile);
          try {
            const value = await api(sessionId, 'resources', profile, controller.signal);
            if (!controller.signal.aborted) setResources(previous => ({ ...previous, [key]: { value, loading: false } }));
          } catch (error) { if (!controller.signal.aborted) setResources(previous => ({ ...previous, [key]: { ...previous[key], loading: false, error: error.message } })); }
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, hosts.length) }, worker));
      if (!controller.signal.aborted) timer = setTimeout(refresh, 15000);
    };
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [sessionId, view, signature, refreshId]);
  const act = async task => {
    mutation.current++; setBusy(true); setError(''); setNotice('');
    try { await task(); } catch (error) { if (mounted.current) setError(error.message); }
    finally { mutation.current++; if (mounted.current) setBusy(false); }
  };
  const openAuth = profile => {
    setEditingKey(profile ? hostKey(profile) : null); setForm({ ...emptyConnection, ...profile, port: profile?.port ?? '' });
    setAuthMode(profile ? 'key' : 'password'); setError(''); setNotice(''); setView('auth');
  };
  const saveHost = connection => {
    const profile = { ...emptyConnection, ...connection, name: form.name.trim(), host: connection.host.trim(), port: connection.port ?? '' };
    const others = profiles.filter(row => hostKey(row) !== editingKey && hostKey(row) !== hostKey(profile));
    if (others.length >= 50) { setError('最多保存 50 台主机，请先移除不需要的保存信息'); return; }
    const rows = [profile, ...others];
    try { localStorage.setItem(storageKey, JSON.stringify(rows)); setProfiles(rows); setView('home'); setError(''); setNotice('已保存 ' + hostLabel(profile) + '，资源查看与会话授权相互独立'); setSetupRunning(false); }
    catch { setError('主机已验证，但无法保存，请检查浏览器存储权限后重新保存'); }
  };
  const removeProfile = () => {
    const rows = profiles.filter(row => hostKey(row) !== editingKey);
    try { localStorage.setItem(storageKey, JSON.stringify(rows)); setProfiles(rows); setView('home'); setError(''); setNotice('已移除保存信息；现有会话授权和密钥保持有效'); }
    catch { setError('无法移除保存信息，请检查浏览器存储权限'); }
  };
  const authorize = profile => act(async () => { const value = await api(sessionId, 'authorize', profile); if (mounted.current) { setState(value); setNotice('已授权当前会话，可通知 AI 开始远程操作'); } });
  const canAuthorize = !connected && !connecting && !['loading', 'unavailable'].includes(state.state);
  const field = (key, value) => setForm(previous => ({ ...previous, [key]: value }));
  return <div className="dsh-ssh-panel">
    <header className="ssh-header">{view === 'auth' ? <div className="ssh-heading"><button className="ssh-icon-button ssh-back" type="button" disabled={busy || setupRunning} aria-label="返回主机首页" onClick={() => { setView('home'); setError(''); }}><Icon name="arrow-left" /></button><h1>主机认证</h1></div>
      : <><div className="ssh-heading"><SshIcon /><h1>SSH 远程</h1></div><button className="ssh-primary ssh-add-host" type="button" disabled={busy || connecting} onClick={() => openAuth()}><Icon name="plus" size={16} />新增主机</button></>}</header>
    <main className="ssh-content">
      {statusError && <div role="alert" className="ssh-message ssh-error"><Icon name="circle-alert" /><span>{statusError}</span></div>}
      {view === 'home' ? <>
        {error && <div role="alert" className="ssh-message ssh-error"><Icon name="circle-alert" /><span>{error}</span></div>}
        {notice && <div role="status" className="ssh-message ssh-notice"><Icon name="check" /><span>{notice}</span></div>}
        <section className="ssh-session-section" aria-label="当前会话授权"><h2 className="ssh-section-label">当前会话授权</h2>
          <div className="ssh-session-card ssh-card"><div className="ssh-session-intro"><div className="ssh-icon-tile"><Icon name="shield-check" size={20} /></div><div className="ssh-session-copy">
            <h3>{connected ? '已授权：' + hostLabel(currentProfile) : connecting ? '正在授权主机…' : state.state === 'loading' ? '正在检查会话授权…' : '当前会话尚未授权'}</h3>
            {connected && <p className="ssh-host-address">{hostAddress(state.connection)}</p>}
            <p className="ssh-hint">{connected ? '仅当前会话有效，AI 可执行远端账号权限内的命令。' : '资源查看与 AI 授权分开。选择下方主机，授权后 AI 才能操作。'}</p>
          </div></div>
          {connected && <div className="ssh-actions"><button className="ssh-primary" type="button" disabled={busy} onClick={() => void act(async () => { const result = await api(sessionId, 'instructions'); await onNotify(result.text); if (mounted.current) setNotice('已通知当前会话 AI'); })}><Icon name="message-square" size={16} />通知当前会话 AI</button>
            <button className="ssh-secondary" type="button" disabled={busy} onClick={() => void act(async () => { await api(sessionId, 'revoke'); if (mounted.current) setState({ state: 'disconnected', jobs: [] }); })}><Icon name="unlink" size={16} />撤销授权</button></div>}
          {connecting && <button className="ssh-secondary ssh-submit" type="button" onClick={() => void act(async () => { await api(sessionId, 'revoke'); if (mounted.current) setState({ state: 'disconnected', jobs: [] }); })}>取消授权</button>}
        </div></section>
        <section className="ssh-host-section" aria-label="主机资源"><div className="ssh-section-heading"><h2>主机资源</h2><div className="ssh-list-tools"><span>{profiles.length} 台已保存</span><button type="button" className="ssh-icon-button" aria-label="刷新资源" disabled={!hosts.length} onClick={() => setRefreshId(value => value + 1)}><Icon name="refresh-cw" size={16} /></button></div></div>
          {hosts.length ? <><div className="ssh-host-list">{hosts.map(profile => <HostCard key={hostKey(profile)} profile={profile} resource={resources[hostKey(profile)]} authorized={connected && hostKey(state.connection) === hostKey(profile)} canAuthorize={canAuthorize} busy={busy || connecting} onAuthorize={() => void authorize(profile)} onManage={() => openAuth(profile)} />)}</div><p className="ssh-list-caption"><span>自动更新 · 只读采集</span>{connected && <><span aria-hidden="true">|</span><span>切换主机前，请先撤销当前授权。</span></>}</p></>
            : <div className="ssh-empty ssh-card"><div className="ssh-icon-tile"><SshIcon size={26} /></div><h3>还没有主机</h3><p>验证并保存主机，即可在这里查看资源，按需授权给当前会话。</p><button className="ssh-primary" type="button" onClick={() => openAuth()}><Icon name="plus" size={16} />添加第一台主机</button></div>}
        </section>
        {connected && state.jobs.length > 0 && <section className="ssh-jobs ssh-card" aria-label="会话任务"><div className="ssh-section-heading"><h2>会话任务</h2><span>{state.jobs.filter(job => job.running).length} 个运行中</span></div>
          {state.jobs.slice(-8).reverse().map(job => <div className="ssh-job" key={job.id}><code title={job.id}>{job.id.slice(0, 8)}</code><span>{job.running ? '运行中' : '已结束 · ' + (job.exitCode ?? '未知')}</span>{job.running && <button className="ssh-text-button" type="button" disabled={busy} onClick={() => void act(async () => { await api(sessionId, 'stop', { id: job.id }); if (mounted.current) setState(await api(sessionId, 'status')); })}>停止</button>}</div>)}
        </section>}
      </> : <form className="ssh-auth-form" aria-label="主机认证表单" onSubmit={event => event.preventDefault()}>
        <section className="ssh-card ssh-basic-fields">
          <label className="ssh-field">主机名称<span className="ssh-optional">可选</span><input maxLength={64} autoComplete="off" placeholder="例如：生产环境" value={form.name} disabled={busy || setupRunning} onChange={event => field('name', event.target.value)} /></label>
          <label className="ssh-field">主机地址<input required autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="主机别名、域名或 IP 地址" value={form.host} disabled={busy || setupRunning} onChange={event => field('host', event.target.value)} /></label>
          <div className="ssh-field-row"><label className="ssh-field">用户名<input autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="使用 SSH 配置" value={form.user} disabled={busy || setupRunning} onChange={event => field('user', event.target.value)} /></label>
            <label className="ssh-field">端口<input type="number" inputMode="numeric" min="1" max="65535" placeholder="SSH 配置 / 22" value={form.port} disabled={busy || setupRunning} onChange={event => field('port', event.target.value)} /></label></div>
        </section>
        <div className="ssh-auth-method"><p className="ssh-section-label">认证方式</p><div className="ssh-segmented" role="group" aria-label="认证方式">
          <button type="button" aria-pressed={authMode === 'password'} disabled={busy || setupRunning} onClick={() => { setAuthMode('password'); setError(''); }}>密码配置</button><button type="button" aria-pressed={authMode === 'key'} disabled={busy || setupRunning} onClick={() => { setAuthMode('key'); setError(''); }}>已有密钥</button>
        </div></div>
        <PasswordlessSetupView key={authMode} api={api} sessionId={sessionId} connection={form} authMode={authMode} disabled={busy} onRunning={setSetupRunning}
          onIdentityFile={value => field('identityFile', value)} onAuthMode={setAuthMode}
          onConnection={connection => setForm(previous => ({ ...previous, ...connection, port: connection.port ?? '' }))}
          onConfigured={(connection, identityFile) => saveHost({ ...connection, identityFile })} />
        {error && <div role="alert" className="ssh-message ssh-error"><Icon name="circle-alert" /><span>{error}</span></div>}
        <p className="ssh-auth-caption">验证后返回首页并采集资源，不会自动授权给 AI。</p>
        {editingKey && profiles.some(row => hostKey(row) === editingKey) && <button className="ssh-text-button ssh-remove-host" type="button" disabled={busy || setupRunning} onClick={removeProfile}>移除保存信息</button>}
      </form>}
    </main>
  </div>;
}

export function apply(ctx) {
  ctx.effect(() => { const style = document.createElement('style'); style.textContent = fontCss + '\n' + panelCss; document.head.append(style); return () => style.remove(); });
  ctx.effect(() => ctx.sidebarRightTabs.register({ id: 'dsh-ssh', kind: 'ssh', title: () => 'SSH 远程', guide: [{ id: 'ssh', order: 30, title: () => 'SSH 远程', description: () => '查看主机资源，管理当前会话的远程授权', icon: SshIcon }] }));
  function Body({ sessionId }) {
    const notify = async text => {
      const scope = ctx.sessions.scope(sessionId), session = scope && ctx.sessions.sessionOf(scope);
      if (!session) throw new Error('当前会话不可用');
      const submission = session.beginSubmission({ mode: 'queue', text, attachments: [] });
      const result = await session.prompt([{ type: 'text', text }], 'queue', undefined, submission.requestId);
      if (!result.ok) throw new Error(result.error.message);
    };
    return <SshPanel key={sessionId} sessionId={sessionId} onNotify={notify} />;
  }
  for (const [slot, component] of [['sidebar.right.pane.tab', Body], ['sidebar.right.pane.tab.title', () => <><SshIcon size={16} /> SSH 远程</>]]) {
    ctx.effect(() => ctx.slots.inject(slot, () => ctx.slots.register({ name: slot, key: 'dsh-ssh' }, component)));
  }
}
