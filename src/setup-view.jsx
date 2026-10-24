import { useEffect, useRef, useState } from 'react';
import { Icon } from './icons.jsx';

const labels = { preparing: '正在准备认证…', checking: '正在验证密钥连接…', installing: '正在登录并安装公钥…', 'host-key': '请确认远端主机指纹', verifying: '正在验证免密登录…', success: '主机认证已验证', error: '认证失败', cancelled: '认证已取消' };

export function PasswordlessSetupView({ sessionId, connection, authMode = 'password', disabled, onConfigured, onRunning, onConnection, onIdentityFile, onAuthMode, api }) {
  const [password, setPassword] = useState(''), [showPassword, setShowPassword] = useState(false);
  const [state, setState] = useState({ phase: 'idle', running: false }), [error, setError] = useState(''), [pollError, setPollError] = useState('');
  const [sending, setSending] = useState(false);
  const applied = useRef(''), active = useRef(''), alive = useRef(false);
  const callbacks = useRef({}); callbacks.current = { onConfigured, onRunning, onConnection, onAuthMode, connection, authMode };
  const isPassword = authMode === 'password';
  const targetKey = JSON.stringify([connection.host, connection.user || '', String(connection.port || ''), isPassword ? '' : connection.identityFile]);
  const accept = value => {
    const target = callbacks.current.connection;
    const oldSuccess = value.phase === 'success' && active.current !== value.id;
    const differentTarget = value.connection && (value.connection.host !== target.host
      || (value.connection.user || '') !== (target.user || '') || String(value.connection.port || '') !== String(target.port || '')
      || (value.authMode || 'password') !== callbacks.current.authMode
      || value.authMode === 'key' && (value.connection.identityFile || '') !== (target.identityFile || ''));
    if (!value.running && (oldSuccess || differentTarget)) {
      setState({ phase: 'idle', running: false }); callbacks.current.onRunning(false); return;
    }
    setState(value); callbacks.current.onRunning(value.running);
    if (value.running && active.current !== value.id) {
      active.current = value.id; callbacks.current.onConnection?.(value.connection); callbacks.current.onAuthMode?.(value.authMode || 'password');
    }
    if (value.phase === 'success' && applied.current !== value.id && active.current === value.id) {
      applied.current = value.id; callbacks.current.onConfigured(value.connection, value.identityFile);
    }
  };
  useEffect(() => {
    setPassword(''); setShowPassword(false); setError(''); setPollError('');
    if (!state.running) { setState({ phase: 'idle', running: false }); active.current = ''; applied.current = ''; }
  }, [targetKey]);
  useEffect(() => {
    alive.current = true; const controller = new AbortController(); let timer;
    const poll = async () => {
      try { const value = await api(sessionId, 'setup.state', {}, controller.signal); if (!controller.signal.aborted) { accept(value); setPollError(''); } }
      catch (error) { if (!controller.signal.aborted) setPollError(error.message); }
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
  return <section className="ssh-password-setup" aria-label={isPassword ? '密码配置免密登录' : '已有密钥认证'}>
    <div className="ssh-card">
      {!state.running && (isPassword ? <>
        <label className="ssh-field">登录密码<div className="ssh-password-input"><input type={showPassword ? 'text' : 'password'} autoComplete="new-password" value={password} disabled={disabled || sending} onChange={event => setPassword(event.target.value)} />
          <button type="button" className="ssh-icon-button" aria-label={showPassword ? '隐藏密码' : '显示密码'} disabled={disabled || sending} onClick={() => setShowPassword(!showPassword)}><Icon name={showPassword ? 'eye-off' : 'eye'} size={16} /></button></div></label>
        <p className="ssh-hint ssh-icon-hint"><Icon name="lock" size={14} /><span>密码只用于本次配置，不保存。在运行 DSH 的机器生成专用密钥，并将公钥追加到目标主机。</span></p>
      </> : <>
        <label className="ssh-field">私钥路径<span className="ssh-optional">可选</span><input autoComplete="off" spellCheck={false} placeholder="~/.ssh/id_ed25519" value={connection.identityFile} disabled={disabled || sending} onChange={event => onIdentityFile(event.target.value)} /></label>
        <p className="ssh-hint ssh-icon-hint"><Icon name="lock" size={14} /><span>留空使用宿主 SSH 配置和 SSH Agent。加密私钥请先通过 ssh-add 解锁。</span></p>
      </>)}
      {state.phase !== 'idle' && <p role="status" className="ssh-setup-progress">{labels[state.phase]}</p>}
      {state.phase === 'host-key' && <div className="ssh-host-confirm" role="alertdialog" aria-label="确认远端主机指纹">
        <div className="ssh-icon-hint"><Icon name="shield-alert" size={18} /><strong>首次连接，请确认主机指纹</strong></div>
        <code className="ssh-fingerprint">{state.fingerprint}</code>
        <p className="ssh-hint">请通过服务器控制台或管理员核实后信任。</p>
        <details className="ssh-prompt-details"><summary>查看完整指纹提示</summary><pre>{state.hostPrompt}</pre></details>
        <div className="ssh-actions"><button type="button" className="ssh-secondary" disabled={sending} onClick={() => void call('setup.confirm', { id: state.id, fingerprint: state.fingerprint, trust: false })}>拒绝</button><button type="button" className="ssh-primary" disabled={sending} onClick={() => void call('setup.confirm', { id: state.id, fingerprint: state.fingerprint, trust: true })}>信任并继续</button></div>
      </div>}
      {state.running && <button className="ssh-text-button" type="button" disabled={sending} onClick={() => void call('setup.cancel')}>取消配置</button>}
      {isPassword && (state.running || state.mayHaveInstalledKey) && <p className="ssh-hint">取消配置不会移除已经安装的公钥；专用私钥保留在 DSH 机器上。</p>}
    </div>
    {(error || pollError || state.error) && <div role="alert" className="ssh-message ssh-error"><Icon name="circle-alert" /><span>{error || pollError || state.error}</span></div>}
    {!state.running && (state.phase === 'success' ? <button className="ssh-primary ssh-submit" type="button" disabled={disabled || sending} onClick={() => callbacks.current.onConfigured(state.connection, state.identityFile)}>保存已验证主机</button>
      : <button className="ssh-primary ssh-submit" type="submit" disabled={disabled || sending || (isPassword && !password) || !connection.host.trim()} onClick={event => {
        if (!event.currentTarget.form.reportValidity()) return;
        const secret = password; setPassword(''); setShowPassword(false); void call('setup.start', { ...connection, authMode, ...(isPassword ? { password: secret } : {}) });
      }}><Icon name="badge-check" />{sending ? '正在提交…' : '验证并保存主机'}</button>)}
  </section>;
}
