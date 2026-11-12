import { useEffect, useState } from 'react';
import { useCanvas } from '../store';
import { availableModels, findBinding } from '../lib/models';
import { CODEX_ACCOUNT, codexReply, codexStatus, useCodexAccount } from '../lib/codexAccount';
import { modelFetch } from '../lib/modelTransport';

export default function TextGenerator({ nodeId, onClose }: { nodeId: string; onClose: () => void }) {
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const account = useCodexAccount(s => s.status?.account);
  useEffect(() => { void codexStatus().catch(() => {}); }, []);
  const submit = async () => {
    if (!prompt.trim() || busy) return;
    const st = useCanvas.getState();
    const original = st.nodes.find(node => node.id === nodeId);
    if (!original || original.type !== 'text') { setError('文字节点已不存在'); return; }
    const model = findBinding(st.settings, st.settings.defaults.text || '')
      ?? availableModels(st.settings, 'text').map(option => findBinding(st.settings, option.key))
        .find(item => item?.service.protocol === 'openai' && item.service.apiKey && item.service.baseUrl);
    const prefersCodex = st.settings.assistantSource === 'codex'
      || (!st.settings.assistantSource && localStorage.getItem('kaishi:assistant-text-source') === CODEX_ACCOUNT);
    const source = prefersCodex || (!st.settings.assistantSource && !model && !!account);
    if (source && !account) { setError('请先在设置里登录 Codex'); return; }
    if (!source && (!model || model.model.type !== 'text' || model.service.protocol !== 'openai'
      || !model.service.enabled || !model.model.enabled || !model.service.baseUrl.trim() || !model.service.apiKey.trim())) {
      setError('请先在设置里配置文本模型'); return;
    }
    setBusy(true); setError('');
    try {
      const messages = [{ role: 'user', content: prompt.trim() }];
      let text: string;
      if (source) text = await codexReply(messages, AbortSignal.timeout(360000));
      else {
        const response = await modelFetch(model!.service.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${model!.service.apiKey}` },
          body: JSON.stringify({ model: model!.model.id, messages }), signal: AbortSignal.timeout(120000),
        });
        if (!response.ok) throw new Error(`文本模型返回 HTTP ${response.status}`);
        const data = await response.json();
        text = data.choices?.[0]?.message?.content;
      }
      if (typeof text !== 'string' || !text.trim()) throw new Error('文本模型没有返回内容');
      const current = useCanvas.getState();
      if (current.projectId !== st.projectId) throw new Error('项目已切换，生成结果未写入画布');
      const target = current.nodes.find(node => node.id === nodeId);
      if (!target || target.type !== 'text') throw new Error('文字节点已删除，生成结果未写入画布');
      current.updateNode(nodeId, { text });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '文本生成失败');
      setBusy(false);
    }
  };
  return <div className="cc-body text-generator" onKeyDown={event => {
    if (event.key === 'Escape' && !busy && !event.nativeEvent.isComposing) { event.stopPropagation(); onClose(); }
  }}>
      <textarea className="cc-prompt creative-textarea" aria-label="描述想生成的文字" autoFocus value={prompt}
        disabled={busy} onChange={event => setPrompt(event.target.value)} placeholder="描述想生成的文字" />
      {error && <p className="chat-error" role="alert">{error}</p>}
    <div className="cc-row">
      <button className="ghost-btn" disabled={busy} onClick={onClose}>取消</button>
      <button className="cc-generate" disabled={busy || !prompt.trim()} onClick={() => void submit()}>{busy ? '生成中…' : '生成文字'}</button>
    </div>
  </div>;
}
