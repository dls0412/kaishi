import { useEffect, useState } from 'react';
import { useCanvas } from '../store';
import { listAssets, putAsset } from '../lib/db';
import { modelFetch } from '../lib/modelTransport';
import { uid } from '../lib/utils';
import { availableModels, findBinding } from '../lib/models';

type Voice = { voice_id: string; name: string; kind: 'preset' | 'custom' };
type Pending = { key: string; text: string; voice: Voice; serviceId: string; speed?: number; language?: string; taskId?: string };
const activeSpeech = new Set<string>();

export default function AudioGenerator({ nodeId, onClose }: { nodeId: string; onClose: () => void }) {
  const settings = useCanvas(s => s.settings);
  const projectId = useCanvas(s => s.projectId);
  const node = useCanvas(s => s.nodes.find(item => item.id === nodeId));
  const storageKey = `kaishi:speech:${projectId}:${nodeId}`;
  const [pending, setPending] = useState<Pending | null>(() => {
    try { return JSON.parse(localStorage.getItem(storageKey) || 'null'); } catch { return null; }
  });
  const services = settings.services.filter(item => item.enabled && item.protocol.startsWith('compshare-')
    && item.baseUrl.trim() && item.apiKey.trim());
  const builtinService = services.find(item => item.id === pending?.serviceId) ?? services[0];
  const audioModelKey = node?.type === 'audio' ? node.audioModelKey : undefined;
  const effectiveKey = pending ? 'builtin:indextts' : audioModelKey || settings.defaults.audio || 'builtin:indextts';
  const isBuiltin = effectiveKey === 'builtin:indextts';
  const binding = isBuiltin ? null : findBinding(settings, effectiveKey);
  const customService = binding?.model.type === 'audio' && binding.model.enabled && binding.service.enabled && binding.service.protocol === 'openai'
    && binding.service.baseUrl.trim() && binding.service.apiKey.trim() ? binding.service : undefined;
  const service = isBuiltin ? builtinService : customService;
  const audioModels = availableModels(settings, 'audio');
  const [text, setText] = useState('');
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voiceId, setVoiceId] = useState('');
  const [speed, setSpeed] = useState(1);
  const [language, setLanguage] = useState('ZH');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setError('');
    if (!service) return;
    if (!isBuiltin) {
      const items = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar']
        .map(value => ({ voice_id: value, name: value, kind: 'preset' as const }));
      setVoices(items); setVoiceId(items[0].voice_id); return;
    }
    const controller = new AbortController();
    void modelFetch(service.baseUrl.replace(/\/+$/, '') + '/audio/v1/voices?kind=preset', {
      headers: { Authorization: `Bearer ${service.apiKey}` }, signal: controller.signal,
    }).then(async response => {
      if (!response.ok) throw new Error(`读取音色失败（HTTP ${response.status}）`);
      const data = await response.json();
      const items: Voice[] = (data.items || []).filter((item: Voice) => item.voice_id && item.name);
      setVoices(items); setVoiceId(items[0]?.voice_id || '');
    }).catch(err => { if (!controller.signal.aborted) setError(err.message); });
    return () => controller.abort();
  }, [service?.id, service?.apiKey, service?.baseUrl, effectiveKey]);

  const submit = async () => {
    if (busy) return;
    if (activeSpeech.has(storageKey)) { setError('任务正在生成，请稍候'); return; }
    const selected = voices.find(voice => voice.voice_id === voiceId);
    if (!service) { setError(!isBuiltin ? '该语音模型当前不可用，或尚未支持其接口协议' : '请先在设置中配置语音服务'); return; }
    if (pending && pending.serviceId !== service.id) { setError('原任务使用的服务已变更，请恢复原服务后查询'); return; }
    if (!pending && (!text.trim() || !selected)) { setError('请输入配音文字并选择音色'); return; }
    const record: Pending = pending ?? { key: crypto.randomUUID(), text: text.trim(), voice: selected!, serviceId: service.id, speed, language };
    if (isBuiltin) { localStorage.setItem(storageKey, JSON.stringify(record)); setPending(record); }
    activeSpeech.add(storageKey);
    setBusy(true); setError('');
    const base = service.baseUrl.replace(/\/+$/, '');
    const headers = { Authorization: `Bearer ${service.apiKey}`, 'Content-Type': 'application/json' };
    try {
      let blob: Blob;
      if (!isBuiltin) {
        const response = await modelFetch(base + '/audio/speech', { method: 'POST', headers,
          body: JSON.stringify({ model: binding!.model.id, input: record.text, voice: record.voice.voice_id, speed: record.speed, response_format: 'wav' }) });
        if (!response.ok) throw new Error(`语音生成失败（HTTP ${response.status}）`);
        blob = await response.blob();
      } else {
      if (!record.taskId) {
        const response = await modelFetch(base + '/audio/v1/speech/jobs', {
          method: 'POST', headers: { ...headers, 'Idempotency-Key': record.key },
          body: JSON.stringify({ text: record.text, voice: { source: record.voice.kind || 'preset', voice_id: record.voice.voice_id }, speed: record.speed ?? 1, language: record.language ?? 'ZH' }),
        });
        if (!response.ok) {
          if ([400, 401, 403, 422].includes(response.status)) { localStorage.removeItem(storageKey); setPending(null); }
          throw new Error(`提交失败（HTTP ${response.status}）`);
        }
        const data = await response.json();
        if (!data.task_id) throw new Error('服务未返回任务编号，可再次点击恢复同一任务');
        record.taskId = data.task_id;
        localStorage.setItem(storageKey, JSON.stringify(record)); setPending({ ...record });
      }
      let output = '';
      for (let attempt = 0; attempt < 200; attempt++) {
        const response = await modelFetch(base + '/audio/v1/speech/jobs/' + encodeURIComponent(record.taskId!), { headers });
        if (!response.ok) throw new Error(`查询失败（HTTP ${response.status}），可继续查询`);
        const task = (await response.json()).task;
        if (task?.status === 'failed' || task?.status === 'cancelled') {
          localStorage.removeItem(storageKey); setPending(null);
          throw new Error(task.error_message || '语音任务未完成');
        }
        if (task?.status === 'succeeded' && task.output_url) { output = task.output_url; break; }
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
      if (!output) throw new Error('任务仍在处理中，可稍后继续查询');
      const response = await modelFetch(output);
      if (!response.ok) throw new Error('音频下载失败，可继续查询');
      blob = await response.blob();
      }
      if (!blob.size) throw new Error('音频文件为空，可继续查询');
      const id = uid('asset');
      const name = `配音-${Date.now()}.wav`;
      await putAsset({ meta: { id, name, mime: blob.type || 'audio/wav', size: blob.size, kind: 'audio', createdAt: Date.now() }, blob });
      const current = useCanvas.getState();
      current.setAssets(await listAssets());
      if (current.projectId === projectId) {
        const target = current.nodes.find(node => node.id === nodeId);
        if (target?.type === 'audio') current.updateNode(nodeId, { assetId: id, fileName: name });
        await useCanvas.getState().persist();
        if (useCanvas.getState().saveStatus === 'error') throw new Error('音频已保存到素材库，画布保存失败，请继续查询');
      }
      localStorage.removeItem(storageKey); setPending(null); onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message.replaceAll(service.apiKey, '[已隐藏]') : '语音生成失败');
      setBusy(false);
    } finally {
      activeSpeech.delete(storageKey);
    }
  };

  return <div className="cc-body text-generator audio-generator">
    <textarea className="cc-prompt creative-textarea" aria-label="配音文字" value={text} maxLength={2000}
      disabled={busy || !!pending} onChange={event => setText(event.target.value)} placeholder="输入要朗读的文字" />
    {!service && <p className="chat-error">{!isBuiltin ? '该语音模型不可用或接口协议暂不支持。' : '请先在设置中配置语音服务。'}</p>}
    {error && <p className="chat-error" role="alert">{error}</p>}
    <div className="cc-row">
      <select aria-label="语音模型" value={effectiveKey} disabled={busy || !!pending} onChange={event => {
        useCanvas.getState().updateNode(nodeId, { audioModelKey: event.target.value });
      }}>
        <option value="builtin:indextts">{builtinService ? 'IndexTTS 2.5' : 'IndexTTS · 未配置'}</option>
        {!isBuiltin && !audioModels.some(option => option.key === effectiveKey) && <option value={effectiveKey}>当前模型不可用</option>}
        {audioModels.map(option => <option key={option.key} value={option.key}>{option.modelName} · {option.serviceName}</option>)}
      </select>
      <select aria-label="配音音色" value={voiceId} disabled={busy || !!pending} onChange={event => setVoiceId(event.target.value)}>
        {!voices.length && <option value="">暂无可用音色</option>}
        {voices.map(voice => <option key={voice.voice_id} value={voice.voice_id}>{voice.name}</option>)}
      </select>
      <select aria-label="配音语言" value={language} disabled={busy || !!pending} onChange={event => setLanguage(event.target.value)}>
        <option value="ZH">中文</option><option value="EN">英语</option><option value="JA">日语</option><option value="ES">西班牙语</option><option value="AR">阿拉伯语</option>
      </select>
      <select aria-label="配音语速" value={speed} disabled={busy || !!pending} onChange={event => setSpeed(Number(event.target.value))}>
        {[0.5, 0.75, 1, 1.25, 1.5, 2].map(value => <option key={value} value={value}>{value}×</option>)}
      </select>
      <button className="ghost-btn" disabled={busy} onClick={onClose}>关闭</button>
      <button className="cc-generate" disabled={busy || (!pending && (!text.trim() || !voiceId))} onClick={() => void submit()}>
        {busy ? '生成中…' : pending ? '继续查询' : '生成配音'}
      </button>
    </div>
  </div>;
}
