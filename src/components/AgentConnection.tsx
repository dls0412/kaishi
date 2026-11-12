import { useState } from 'react';
import { useCanvas } from '../store';
import { activateBridge, useLocalBridge } from '../lib/localBridge';
import CodexAccountCard from './CodexAccountCard';

export default function AgentConnection() {
  const conn = useLocalBridge();
  const projectId = useCanvas(state => state.projectId);
  const active = conn.online && conn.active && conn.projectId === projectId;
  const verified = active && conn.clientSeen;
  const [format, setFormat] = useState('codex');
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;
  const config = format === 'codex' ? `codex mcp add kaishi -- ${quote(conn.node)} ${quote(conn.script)}`
    : format === 'claude' ? `claude mcp add --transport stdio kaishi -- ${quote(conn.node)} ${quote(conn.script)}`
    : JSON.stringify({ mcpServers: { kaishi: { ...(format === 'workbuddy' ? { type: 'stdio' } : {}), command: conn.node, args: [conn.script] } } }, null, 2);
  return <section className="connection-panel" data-testid="agent-connection">
    <p>登录后，可在助手中选择 Codex；图片节点也可使用 Codex 账号生图。视频使用已配置的视频模型。</p>
    <CodexAccountCard />
    <details className="external-mcp">
    <summary>让外部客户端操作开视画布（MCP）</summary>
    <div className="connection-checks" aria-live="polite">
      <div><span>本机服务</span><strong className={conn.online ? 'workflow-ok' : ''}>{conn.online ? '已就绪' : '未就绪'}</strong></div>
      <div><span>目标画布</span><strong>{active ? '当前画布' : '未选中当前画布'}</strong></div>
      <div><span>客户端验证</span><strong className={verified ? 'workflow-ok' : ''}>{verified ? '已成功调用当前画布' : '等待客户端首次调用'}</strong></div>
    </div>
    {conn.error && !conn.online && <p className="chat-error">{conn.error}</p>}
    {conn.online && !active && <button className="ghost-btn" onClick={() => void activateBridge()}>连接到此画布</button>}
    <label className="dialog-label" htmlFor="agent-client">选择客户端</label>
    <select id="agent-client" className="dialog-input" value={format} onChange={e => { setFormat(e.target.value); setCopied(false); }}><option value="codex">Codex · PowerShell 命令</option><option value="claude">Claude Code · PowerShell 命令</option><option value="workbuddy">WorkBuddy · 自定义连接器</option><option value="json">Claude Desktop / Cursor · JSON 配置</option></select>
    <pre className="connection-code">{conn.online ? config : '请使用“启动开视”打开应用后获取配置'}</pre>
    <button className="primary-btn" disabled={!conn.online} onClick={() => void navigator.clipboard.writeText(config).then(() => { setCopied(true); setCopyError(false); }).catch(() => setCopyError(true))}>{copied ? '已复制' : '复制连接配置'}</button>
    {copyError && <p className="chat-error" role="alert">复制失败，可以选中上方配置手动复制。</p>}
    <ol className="connection-steps">
      <li>{format === 'workbuddy' ? '在 WorkBuddy 的连接器管理中添加自定义 MCP，选择 stdio，使用上方配置。'
        : format === 'json' ? '将 JSON 合并到客户端的 MCP 设置。' : '在 PowerShell 运行上方命令。'}</li>
      <li>保持开视打开，在客户端新建聊天，发送「读取当前开视画布」。</li>
    </ol>
    </details>
  </section>;
}
