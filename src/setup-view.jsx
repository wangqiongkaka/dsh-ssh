import { useEffect, useRef, useState } from 'react';

const labels = { preparing: '正在准备专用密钥…', installing: '正在登录并安装公钥…', 'host-key': '请确认远端主机指纹', verifying: '正在验证免密登录…', success: '免密登录已验证', error: '配置失败', cancelled: '配置已取消' };

export function PasswordlessSetupView({ sessionId, connection, disabled, onConfigured, onRunning, api }) {
  const [open, setOpen] = useState(false), [password, setPassword] = useState('');
  const [state, setState] = useState({ phase: 'idle', running: false }), [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const applied = useRef(''), active = useRef(''), alive = useRef(false);
  const configured = useRef(onConfigured), running = useRef(onRunning);
  configured.current = onConfigured; running.current = onRunning;
  const accept = value => {
    setState(value); running.current(value.running);
    if (value.running) { active.current = value.id; setOpen(true); }
    if (value.phase === 'success' && applied.current !== value.id && active.current === value.id) {
      applied.current = value.id; configured.current(value.connection, value.identityFile);
    }
  };
  useEffect(() => {
    alive.current = true; const controller = new AbortController(); let timer;
    const poll = async () => {
      try { const value = await api(sessionId, 'setup.state', {}, controller.signal); if (!controller.signal.aborted) accept(value); }
      catch (error) { if (!controller.signal.aborted) setError(error.message); }
      if (!controller.signal.aborted) timer = setTimeout(poll, 700);
    };
    void poll();
    return () => { alive.current = false; controller.abort(); clearTimeout(timer); };
  }, [sessionId]);
  const call = async (method, input = {}) => {
    setSending(true); setError('');
    try { const result = await api(sessionId, method, input); const value = result.phase ? result : await api(sessionId, 'setup.state'); if (alive.current) accept(value); }
    catch (error) { if (alive.current) setError(error.message); }
    finally { if (alive.current) setSending(false); }
  };
  return <section className="ssh-setup ssh-card" aria-label="配置免密登录">
    <button className="ssh-setup-toggle" type="button" disabled={disabled || sending} aria-expanded={open} onClick={() => { setOpen(!open); setPassword(''); }}>配置免密登录<span aria-hidden="true">{open ? '−' : '+'}</span></button>
    {open && <>
      <p className="ssh-hint">使用上方主机、用户名和端口。在运行 DSH 的机器生成无口令专用密钥，并把公钥追加到远端账号；不会覆盖已有密钥。</p>
      {!state.running && <>
        <label className="ssh-field">首次登录密码<input type="password" autoComplete="new-password" value={password} disabled={disabled || sending} onChange={event => setPassword(event.target.value)} /></label>
        <p className="ssh-hint">密码仅用于本次配置，不保存、不发送给 AI。远端需要允许 SSH 密码认证。</p>
        <button className="ssh-primary" type="button" disabled={disabled || sending || !password || !connection.host.trim()} onClick={() => {
          const secret = password; setPassword(''); void call('setup.start', { ...connection, password: secret });
        }}>{sending ? '正在提交…' : '生成密钥并配置免密'}</button>
      </>}
      {state.phase !== 'idle' && <p role="status" className="ssh-setup-progress">{labels[state.phase]}</p>}
      {state.phase === 'host-key' && <div className="ssh-host-confirm" role="alertdialog" aria-label="确认远端主机指纹">
        <strong>首次连接，请先核对主机指纹</strong><pre>{state.hostPrompt}</pre>
        <p className="ssh-hint">请通过服务器控制台或管理员核实。确认后 OpenSSH 会记录该主机密钥。</p>
        <div className="ssh-actions"><button type="button" className="ssh-danger" disabled={sending} onClick={() => void call('setup.confirm', { id: state.id, fingerprint: state.fingerprint, trust: false })}>不信任并取消</button><button type="button" className="ssh-primary" disabled={sending} onClick={() => void call('setup.confirm', { id: state.id, fingerprint: state.fingerprint, trust: true })}>指纹正确，信任此主机</button></div>
      </div>}
      {(error || state.error) && <p role="alert" className="ssh-error ssh-setup-progress">{error || state.error}</p>}
      {state.phase === 'success' && <><code className="ssh-key-path">{state.identityFile}</code><p className="ssh-hint">此密钥已验证可用于 {state.connection.host}。保存连接信息后，再点击下方按钮授权当前会话。</p></>}
      {state.running && <button className="ssh-cancel" type="button" disabled={sending} onClick={() => void call('setup.cancel')}>取消配置</button>}
      {(state.running || state.mayHaveInstalledKey) && <p className="ssh-hint">取消、撤销会话授权不会移除已安装的公钥；专用私钥保留在 DSH 机器上。</p>}
    </>}
  </section>;
}
