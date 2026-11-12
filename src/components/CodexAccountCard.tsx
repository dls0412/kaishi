import { useEffect, useState } from 'react';
import { codexAccountAction, codexQuota, codexStatus, connectInstalledCodex, startCodexLogin, useCodexAccount, usesInstalledCodex } from '../lib/codexAccount';

export default function CodexAccountCard() {
  const status = useCodexAccount(state => state.status);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [authUrl, setAuthUrl] = useState('');
  const [limits, setLimits] = useState<Awaited<ReturnType<typeof codexQuota>>['limits']>();

  const refresh = async () => {
    setError('');
    try { await codexStatus(); }
    catch (err) { setError((err as Error).message); }
  };

  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    if (!status?.pending || busy) return;
    const timeout = window.setTimeout(() => void refresh(), 1500);
    return () => window.clearTimeout(timeout);
  }, [status, busy]);

  const login = async () => {
    const popup = window.open('about:blank', '_blank');
    if (popup) popup.opener = null;
    setBusy('login');
    setError('');
    try {
      const { authUrl } = await startCodexLogin();
      setAuthUrl(authUrl);
      if (popup && !popup.closed) popup.location.replace(authUrl);
      await codexStatus();
    } catch (err) {
      popup?.close();
      setError((err as Error).message);
    } finally { setBusy(''); }
  };

  const accountAction = async (action: 'cancel' | 'logout') => {
    setBusy(action);
    setError('');
    try {
      await codexAccountAction(action);
      setAuthUrl('');
      setLimits(undefined);
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(''); }
  };

  const loadQuota = async () => {
    setBusy('quota');
    setError('');
    try { setLimits((await codexQuota()).limits); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(''); }
  };

  const connectLocal = async () => {
    setBusy('installed');
    setError('');
    try { await connectInstalledCodex(); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(''); }
  };

  return <section className="agent-account" aria-label="Codex 账号">
    <header>
      <div>
        <strong><i className={status?.account ? 'online' : ''} />Codex（ChatGPT）</strong>
        <p aria-live="polite">{status?.account ? usesInstalledCodex() ? '已连接本机 Codex' : '已登录' : status?.pending ? '等待浏览器授权' : status ? '未登录' : error ? '连接不可用' : '正在检查本机 Codex…'}</p>
      </div>
      {status?.account
        ? <button className="ghost-btn" disabled={Boolean(busy)} onClick={() => void accountAction('logout')}>{usesInstalledCodex() ? '断开连接' : '退出登录'}</button>
        : status?.pending
          ? <button className="ghost-btn" disabled={Boolean(busy)} onClick={() => void accountAction('cancel')}>取消授权</button>
          : status
            ? <button className="primary-btn" disabled={Boolean(busy)} onClick={() => void login()}>登录 ChatGPT</button>
            : error && <button className="ghost-btn" onClick={() => void refresh()}>重试</button>}
    </header>
    {!status?.account && !status?.pending && <button className="ghost-btn" disabled={Boolean(busy)} onClick={() => void connectLocal()}>使用本机已登录 Codex</button>}
    {status?.account && <div className="agent-account-details">
      <div className="agent-account-identity"><span>{status.account.email}</span>{status.account.plan && <span>{status.account.plan}</span>}</div>
      <div className="agent-account-quota">
        <span>订阅额度</span>
        <button className="ghost-btn" disabled={Boolean(busy)} onClick={() => void loadQuota()}>{busy === 'quota' ? '正在读取…' : '刷新额度'}</button>
      </div>
      {limits?.map((limit, i) => <div className="agent-account-window" key={i}>
        <span>{limit.minutes ? limit.minutes % 60 === 0 ? limit.minutes / 60 + ' 小时窗口' : limit.minutes + ' 分钟窗口' : '用量窗口'}</span>
        <span>已用 {limit.used}%{limit.resetsAt ? ' · ' + new Date(limit.resetsAt * 1000).toLocaleString('zh-CN', { hour12: false }) + ' 重置' : ''}</span>
      </div>)}
      {limits?.length === 0 && <p>当前账号未返回额度数据。</p>}
    </div>}
    {status?.pending && <p>在浏览器完成官方授权，再返回开视。{' '}
      {authUrl ? <a href={authUrl} target="_blank" rel="noreferrer">重新打开授权页</a>
        : <button className="ghost-btn" disabled={Boolean(busy)} onClick={() => void login()}>重新打开授权页</button>}
    </p>}
    {(error || status?.error) && <div className="chat-error" role="alert">{error || status?.error}</div>}
  </section>;
}
