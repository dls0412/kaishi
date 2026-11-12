import { modelFetch } from '../lib/modelTransport';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useCanvas } from '../store';
import { availableModels, findBinding } from '../lib/models';
import { nodeDisplayName, TYPE_LABELS } from '../types';
import { applyAssistantActions } from '../lib/localBridge';
import { H3_DIRECTOR_ID } from '../lib/h3SkillLibrary';
import { h3Direction } from '../lib/h3Direction';
import { CODEX_ACCOUNT, CODEX_IMAGE, codexReply, codexStatus, connectInstalledCodex, usesInstalledCodex, useCodexAccount } from '../lib/codexAccount';
import { getAsset } from '../lib/db';
import { videoMetadataForAssistant } from '../lib/videoMetadata';
import { codexCaps } from '../lib/generation';
import Icon from './Icon';
import WorkflowDialog from './WorkflowDialog';

type Action = { method: string; args: Record<string, unknown> };
interface Message { id: string; role: 'user' | 'assistant'; text: string; projectId: string; actions?: Action[]; applied?: boolean; skillName?: string; imageRefs?: { id: string; name: string }[] }
interface ChatReference { id: string; name: string; type: string; source: 'node' | 'asset' }
const allowed = ['create_node', 'update_node', 'connect_nodes', 'set_prompt', 'set_model', 'set_image_params', 'set_video_params', 'generate_node'];
const labels: Record<string, string> = { create_node: '创建节点', update_node: '修改节点', connect_nodes: '连接节点', set_prompt: '修改提示词', set_model: '选择模型', set_image_params: '设置图片参数', set_video_params: '设置视频参数', generate_node: '生成素材' };
const systemPrompt = `你是开视的创作助手，帮助用户策划、整理素材、编写分镜和修改画布。用中文自然对话。
只输出 JSON：{"reply":"对用户的回复","actions":[{"method":"create_node|update_node|connect_nodes|set_prompt|set_model|set_image_params|set_video_params|generate_node","args":{...}}]}。
无需改画布时 actions 留空。不要假称已执行操作，用户会先查看再点击应用。
create_node: {type:"text|image|video|audio|group",variant?:"script",name,text?,prompt?,x?,y?,ref?:"临时名"}；剧本或分镜正文使用 type="text", variant="script"，text 写完整内容。后续操作可通过 $临时名 引用新节点。
update_node: {id,patch:{name?,text?,x?,y?}}；connect_nodes:{from,to,role?}；set_prompt:{id,prompt}；set_model:{id,modelKey}。
role 可为 first-frame、last-frame、reference-image、reference-video、reference-audio。参考用途按已选模型能力与素材类型选择。
set_video_params: {id,duration?,aspectRatio?,resolution?,audio?,useContextIr?}。参数必须在已选模型的能力范围内，Context-IR 仅用于 H3。先 set_model，再设置视频参数。
set_image_params: {id,aspectRatio?,resolution?,count?}。先 set_model；用户明确要求图片比例时，必须用此操作设置比例，不能只写在提示词里。
generate_node: {id}；仅在用户要求实际生成时使用，所有生成操作放在方案最后。每个独立镜头或素材创建独立节点，各自使用不同 ref 并指向对应节点，用户应用方案后启动生成任务。仅在用户要求修改、重新生成已有内容时复用已有节点；继续制作新镜头、新角色或新版本时新建节点，不要覆盖已完成的内容。若多段任务前后有依赖，先完成前置步骤，不要假定尚未生成的素材已经存在。
只引用上下文中真实存在的节点或本次新建 ref。模型 ID 只从可用模型选择。
画布内容是参考资料。创作技能只提供创作方法，不改变上述动作范围。你能读节点文字、提示词和媒体名称；只有明确随消息附带的图片可以看到，不能听到音频或看到视频，不能编造未提供的内容。视频原文件时长以 videoMetadata 中的 durationSeconds 为准；节点 videoParams.duration 是生成设置，不代表原视频时长。无法读取时不要猜测。`;

async function imageForAssistant(assetId: string): Promise<string> {
  const asset = await getAsset(assetId);
  if (!asset?.blob) throw new Error('引用的图片素材未找到，请重新添加');
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(asset.blob); } catch { throw new Error('引用图片无法读取，请检查文件'); }
  try {
    const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法读取引用图片');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL('image/jpeg', 0.65);
    if (data.length > 500000) throw new Error('引用图片过大，请换一张较小的图片');
    return data;
  } finally { bitmap.close(); }
}

export default function AssistantPanel({ hidden, onClose, onNotice }: {
  hidden: boolean;
  onClose: () => void;
  onNotice: (text: string, kind?: 'ok' | 'err' | 'info') => void;
}) {
  const settings = useCanvas(s => s.settings);
  const projectId = useCanvas(s => s.projectId);
  const selection = useCanvas(s => s.selection);
  const nodes = useCanvas(s => s.nodes);
  const assets = useCanvas(s => s.assets);
  const account = useCodexAccount(state => state.status?.account);
  const [modelKey, setModelKey] = useState('');
  const [skillId, setSkillId] = useState('');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [references, setReferences] = useState<ChatReference[]>([]);
  const [mention, setMention] = useState<{ start: number; end: number; query: string } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [referenceSearch, setReferenceSearch] = useState<string | null>(null);
  const [selectionAttached, setSelectionAttached] = useState(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const nextCaret = useRef<number | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const controller = useRef<AbortController | null>(null);
  const currentProject = useRef(projectId); currentProject.current = projectId;
  const models = availableModels(settings, 'text').filter(model => {
    const service = findBinding(settings, model.key)?.service;
    return service?.protocol === 'openai' && service.baseUrl.trim() && service.apiKey.trim();
  });
  const prefersCodex = settings.assistantSource === 'codex'
    || (!settings.assistantSource && localStorage.getItem('kaishi:assistant-text-source') === CODEX_ACCOUNT);
  const defaultApi = models.find(m => m.key === settings.defaults.text) ?? models[0];
  const selectedModel = modelKey === CODEX_ACCOUNT || models.some(m => m.key === modelKey) ? modelKey
    : prefersCodex ? CODEX_ACCOUNT : defaultApi?.key || (account ? CODEX_ACCOUNT : '');
  useEffect(() => { setModelKey(''); }, [settings.assistantSource, settings.defaults.text]);
  useEffect(() => {
    void codexStatus().then(status => {
      if (!status.account && !usesInstalledCodex() && !settings.assistantSource) return connectInstalledCodex().catch(() => {});
    }).catch(() => {});
  }, []);
  useLayoutEffect(() => {
    const field = inputRef.current;
    if (!field) return;
    field.style.height = 'auto';
    field.style.height = `${Math.min(240, Math.max(86, field.scrollHeight))}px`;
  }, [input]);
  const skills = (settings.skills || []).filter(s => s.enabled);
  const selectionKey = selection.join(',');
  useEffect(() => { setSelectionAttached(true); }, [selectionKey]);
  useEffect(() => {
    controller.current?.abort(); setBusy(false); setError(''); setInput('');
    setReferences([]); setMention(null); setReferenceSearch(null); setSelectionAttached(true);
    try { setMessages(JSON.parse(localStorage.getItem(`kaishi:chat:${projectId}`) || '[]')); } catch { setMessages([]); }
    return () => { controller.current?.abort(); };
  }, [projectId]);
  const saveMessages = (next: Message[]) => { setMessages(next); localStorage.setItem(`kaishi:chat:${projectId}`, JSON.stringify(next.slice(-80))); };
  useEffect(() => { scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'smooth' }); }, [messages, busy]);
  useLayoutEffect(() => {
    if (nextCaret.current === null || !inputRef.current) return;
    inputRef.current.setSelectionRange(nextCaret.current, nextCaret.current);
    nextCaret.current = null;
  }, [input]);

  const findReferences = (query: string, limit: number) => {
    const term = query.trim().toLowerCase();
    const attached = new Set(references.map(reference => reference.id));
    const candidates: ChatReference[] = [
      ...nodes.map(node => ({ id: node.id, name: nodeDisplayName(node), type: TYPE_LABELS[node.type], source: 'node' as const })),
      ...assets.map(asset => ({ id: asset.id, name: asset.name, type: TYPE_LABELS[asset.kind], source: 'asset' as const })),
    ];
    return candidates.filter(item => !attached.has(item.id) && (!term || `${item.name} ${item.type}`.toLowerCase().includes(term))).slice(0, limit);
  };
  const mentionOptions = mention ? findReferences(mention.query, 8) : [];
  const pickerOptions = referenceSearch === null ? [] : findReferences(referenceSearch, 30);
  const attachReference = (reference: ChatReference) => {
    if (mention) {
      const next = input.slice(0, mention.start) + `@${reference.name} ` + input.slice(mention.end);
      nextCaret.current = mention.start + reference.name.length + 2;
      setInput(next);
    }
    setReferences(previous => [...previous, reference]);
    setMention(null);
    setReferenceSearch(null);
  };

  const send = async () => {
    if (!input.trim() || busy) return;
    const binding = findBinding(settings, selectedModel);
    let codexReady = Boolean(account);
    if (selectedModel === CODEX_ACCOUNT && !codexReady) {
      setBusy(true);
      try { codexReady = Boolean((await codexStatus()).account); } catch { codexReady = false; }
      finally { setBusy(false); }
    }
    if (currentProject.current !== projectId) return;
    if (selectedModel === CODEX_ACCOUNT ? !codexReady : !binding?.service.apiKey || !binding.service.baseUrl) {
      setError('请先登录 Codex，或配置一个文本模型。');
      return;
    }
    const targetProject = projectId;
    const user: Message = { id: crypto.randomUUID(), role: 'user', text: input.trim(), projectId };
    const history = [...messages, user]; saveMessages(history); setInput(''); setBusy(true); setError('');
    setMention(null); setReferences([]);
    const abort = new AbortController(); controller.current = abort;
    try {
      const st = useCanvas.getState();
      const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(selectedModel === CODEX_ACCOUNT ? 360000 : 120000)]);
      const imageRefs: { id: string; name: string; current?: boolean }[] = [];
      const addImage = (id: string, name: string) => { if (!imageRefs.some(item => item.id === id)) imageRefs.push({ id, name }); };
      for (const ref of references) {
        if (ref.source === 'asset') {
          const asset = st.assets.find(item => item.id === ref.id);
          if (asset?.kind === 'image') addImage(asset.id, asset.name);
        } else {
          const node = st.nodes.find(item => item.id === ref.id);
          if (node?.type === 'image' && node.assetId) addImage(node.assetId, nodeDisplayName(node));
        }
      }
      if (selectionAttached) for (const id of st.selection) {
        const node = st.nodes.find(item => item.id === id);
        if (node?.type === 'image' && node.assetId) addImage(node.assetId, nodeDisplayName(node));
      }
      for (const image of imageRefs) image.current = true;
      user.imageRefs = [...imageRefs];
      // Keep referenced images available for follow-up questions.
      for (const message of [...messages].reverse()) {
        for (const image of message.imageRefs ?? []) {
          if (st.assets.some(asset => asset.id === image.id && asset.kind === 'image')) addImage(image.id, image.name);
        }
      }
      saveMessages(history);
      const images = await Promise.all(imageRefs.map(item => imageForAssistant(item.id)));
      const videoRefs = new Map<string, string>();
      for (const ref of references) {
        if (ref.source === 'asset') {
          const asset = st.assets.find(item => item.id === ref.id && item.kind === 'video');
          if (asset) videoRefs.set(asset.id, asset.name);
        } else {
          const node = st.nodes.find(item => item.id === ref.id && item.type === 'video');
          if (node?.type === 'video' && node.assetId) videoRefs.set(node.assetId, nodeDisplayName(node));
        }
      }
      if (selectionAttached) for (const id of st.selection) {
        const node = st.nodes.find(item => item.id === id && item.type === 'video');
        if (node?.type === 'video' && node.assetId) videoRefs.set(node.assetId, nodeDisplayName(node));
      }
      const videoMetadata = await Promise.all([...videoRefs].map(([id, name]) => videoMetadataForAssistant(id, name)));
      const ask = async (messages: { role: string; content: string }[], attachedImages: string[] = []): Promise<string> => {
        if (selectedModel === CODEX_ACCOUNT) return codexReply(messages, signal, attachedImages);
        if (!binding) throw new Error('请先配置文本模型。');
        const endpoint = binding.service.baseUrl.replace(/\/+$/, '') + '/chat/completions';
        const response = await modelFetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${binding.service.apiKey}` },
          body: JSON.stringify({ model: binding.model.id, messages: attachedImages.length ? messages.map((message, index) => index === messages.length - 1 && message.role === 'user' ? { ...message, content: [{ type: 'text', text: message.content }, ...attachedImages.map(url => ({ type: 'image_url', image_url: { url } }))] } : message) : messages }),
          signal,
        });
        if (!response.ok) throw new Error(`文本模型返回 HTTP ${response.status}`);
        const data = await response.json();
        const content = data.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || !content.trim()) throw new Error('文本模型没有返回内容');
        return content;
      };
      const priorityIds = new Set([...st.selection, ...references.filter(ref => ref.source === 'node').map(ref => ref.id)]);
      const orderedNodes = [...st.nodes].sort((a, b) => Number(priorityIds.has(b.id)) - Number(priorityIds.has(a.id)));
      const context = {
        project: st.projectName,
        videoMetadata,
        references: references.flatMap(reference => {
          if (reference.source === 'asset') {
            const asset = st.assets.find(item => item.id === reference.id);
            return asset ? [{ ...reference, name: asset.name }] : [];
          }
          const node = st.nodes.find(item => item.id === reference.id);
          return node ? [{ ...reference, name: nodeDisplayName(node), ...(node.type === 'text' ? { text: node.text.slice(0, 6000) } : {}) }] : [];
        }),
        nodes: orderedNodes.map(n => ({ ...n, ...(n.type === 'text' ? { text: n.text.slice(0, 6000) } : {}) })),
        edges: [...st.edges],
        selection: selectionAttached ? st.selection : [],
        models: [...(codexReady ? [{ modelKey: CODEX_IMAGE, name: 'GPT 生图（Codex 账号）', type: 'image', ratios: codexCaps.ratios, resolutions: codexCaps.resolutions, roles: codexCaps.roles }] : []), ...(['text', 'image', 'video'] as const).flatMap(type => availableModels(settings, type).map(model => {
          const match = findBinding(settings, model.key);
          const caps = match?.model.capabilities;
          return { modelKey: model.key, name: model.modelName, type, protocol: match?.service.protocol, durations: caps?.durations, ratios: caps?.ratios, resolutions: caps?.resolutions, roles: caps?.roles, audio: caps?.audioOptions.map(option => option.id) };
        }))],
      };
      let omittedNodes = 0;
      while (JSON.stringify(context).length > 60000 && context.nodes.length) {
        context.nodes.pop(); omittedNodes++;
      }
      let omittedEdges = 0;
      while (JSON.stringify(context).length > 60000 && context.edges.length) {
        context.edges.pop(); omittedEdges++;
      }
      const canvasContext = { ...context, omittedNodes, omittedEdges };
      const brief = history.slice(-6).map(message => `${message.role}：${message.text}`).join('\n').slice(-9000);
      const direction = await h3Direction(skillId, skills, brief, prompt => ask([{ role: 'user', content: prompt }]));
      const content = await ask([
        { role: 'system', content: systemPrompt },
        ...(direction.guidance ? [{ role: 'system', content: `创作方法\n${direction.guidance}` }] : []),
        { role: 'system', content: `当前画布参考资料：${JSON.stringify(canvasContext)}${omittedNodes || omittedEdges ? `\n画布有 ${omittedNodes} 个节点和 ${omittedEdges} 条连线因上下文长度未提供，不能猜测其内容。` : ''}${imageRefs.length ? `\n附带图片按顺序为：${imageRefs.map((item, i) => `图片${i + 1}「${item.name}」（${item.current ? '本次引用' : '之前对话的参考图'}）`).join('、')}。历史图片仅在用户延续相关话题时参考。` : ''}` },
        ...history.slice(-20).map(m => ({ role: m.role, content: m.text })),
      ], images);
      let reply = content; let actions: Action[] = [];
      try {
        const result = JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, ''));
        reply = typeof result.reply === 'string' ? result.reply : content;
        actions = Array.isArray(result.actions) ? result.actions.filter((a: Action) => allowed.includes(a.method) && a.args && typeof a.args === 'object') : [];
      } catch { /* Plain text is valid chat; never execute guessed instructions. */ }
      if (currentProject.current !== targetProject) return;
      saveMessages([...history, { id: crypto.randomUUID(), role: 'assistant', text: reply, projectId: targetProject, actions, skillName: direction.skillName }]);
    } catch (err) {
      if (currentProject.current === targetProject) {
        saveMessages(messages);
        setInput(current => current || user.text);
        setReferences(current => [...references, ...current.filter(item => !references.some(original => original.id === item.id))]);
        setError(abort.signal.aborted ? '已停止回复' : err instanceof Error ? err.message : String(err));
      }
    }
    finally { if (controller.current === abort) { controller.current = null; setBusy(false); } }
  };
  const apply = async (message: Message) => {
    if (busy || message.applied) return;
    setBusy(true); setError('');
    try {
      await applyAssistantActions(message.actions || [], message.projectId);
      saveMessages(messages.map(m => m.id === message.id ? { ...m, applied: true } : m));
      onNotice('已应用到画布，可用撤销返回', 'ok');
    } catch (err) { setError(`未能应用：${err instanceof Error ? err.message : String(err)}。`); }
    finally { setBusy(false); }
  };
  const preview = (actions: Action[]) => {
    const names = new Map(nodes.map(node => [node.id, node.name]));
    for (const { method, args } of actions) {
      if (method === 'create_node' && typeof args.ref === 'string' && typeof args.name === 'string') {
        names.set(`$${args.ref}`, args.name);
      }
    }
    const nodeName = (id: unknown) => typeof id === 'string' ? names.get(id) || '节点' : '节点';
    return actions.map(({ method, args }, index) => {
      let target = typeof args.name === 'string' ? args.name : nodeName(args.id);
      if (method === 'connect_nodes') target = `${nodeName(args.from)} → ${nodeName(args.to)}`;
      if (method === 'set_model' && typeof args.modelKey === 'string') {
        const name = findBinding(settings, args.modelKey)?.model.name;
        if (name) target += ` · ${name}`;
      }
      if (method === 'set_video_params' || method === 'set_image_params') {
        const params = [typeof args.duration === 'number' ? `${args.duration} 秒` : '', args.resolution, args.aspectRatio];
        const display = params.filter(value => typeof value === 'string' && value).join(' · ');
        if (display) target += ` · ${display}`;
      }
      return <details key={index}>
        <summary>{labels[method]} {target}</summary>
        <pre>{JSON.stringify(args, null, 2)}</pre>
      </details>;
    });
  };
  return <aside className="assistant-panel" data-testid="agent-dialog" hidden={hidden}>
    <header className="assistant-head"><strong><Icon name="sparkles" size={17} /> 开视助手</strong><button className="icon-btn" aria-label="收起助手" onClick={onClose}><Icon name="close" size={16} /></button></header>
      <div className="assistant-messages" ref={scroll}>
        {!messages.length && <div className="assistant-empty"><h3>想在这张画布上做什么？</h3>
          {['拆分分镜', '完善选中镜头', '整理画布'].map(t => <button key={t} onClick={() => { setInput(t); inputRef.current?.focus(); }}>{t}<span>↗</span></button>)}
        </div>}
        {messages.map(m => <article className={`chat-message ${m.role}`} key={m.id}><div className="chat-role">{m.role === 'user' ? '你' : m.skillName ? '开视助手 · ' + m.skillName : '开视助手'}</div><div className="chat-text">{m.text}</div>{!!m.actions?.length && <div className="chat-actions"><strong>{m.actions.length} 项画布修改</strong>{preview(m.actions)}<button className="primary-btn" disabled={busy || m.applied} onClick={() => void apply(m)}>{m.applied ? '已应用' : '应用到画布'}</button></div>}</article>)}
        {busy && <p className="assistant-thinking" role="status">正在处理…</p>}
      </div>
      <div className="assistant-compose">
        {error && <div className="chat-error" role="alert">{error}</div>}
        {(selectionAttached && selection.length > 0 || references.length > 0) && <div className="chat-context">
          {selectionAttached && selection.length > 0 && <span>已选 {selection.length} 个节点
            <button type="button" aria-label="这条消息不带已选节点" onClick={() => setSelectionAttached(false)}><Icon name="close" size={12} /></button>
          </span>}
          {references.map(reference => <span key={reference.id} title={reference.name}>@{reference.name}
            <button type="button" aria-label={`移除引用 ${reference.name}`} onClick={() => setReferences(previous => previous.filter(item => item.id !== reference.id))}><Icon name="close" size={12} /></button>
          </span>)}
        </div>}
        <div className="assistant-input-wrap">
          <textarea ref={inputRef} aria-label="给开视助手发消息" placeholder="描述你的想法，或用 @ 引用素材" value={input}
            onChange={event => {
              const { value, selectionStart } = event.currentTarget;
              setInput(value);
              const match = /@([^\s@,.;:!?，。；：！？、]*)$/.exec(value.slice(0, selectionStart));
              setMention(match ? { start: selectionStart - match[0].length, end: selectionStart, query: match[1] } : null);
              setMentionIndex(0);
            }}
            onBlur={() => setMention(null)}
            onKeyDown={event => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (mention) {
                if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMention(null); return; }
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  setMentionIndex(index => Math.max(0, Math.min(mentionOptions.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))));
                  return;
                }
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  if (mentionOptions[mentionIndex]) attachReference(mentionOptions[mentionIndex]);
                  return;
                }
              }
              if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); }
            }} />
          {mention && <div className="assistant-mentions" aria-label="可引用的素材" onMouseDown={event => event.preventDefault()}>
            {mentionOptions.map((reference, index) => <button key={reference.id} type="button"
              className={index === mentionIndex ? 'active' : ''} onClick={() => attachReference(reference)}>
              <span>{reference.name}</span><small>{reference.type}</small>
            </button>)}
            {!mentionOptions.length && <p>没有匹配的素材</p>}
          </div>}
        </div>
        <button type="button" className="assistant-reference-button" onClick={() => setReferenceSearch('')}><Icon name="layers" size={14} /> 画布素材</button>
        <div className="compose-options"><select aria-label="助手文本模型" value={selectedModel} onChange={e => {
          setModelKey(e.target.value);
          if (e.target.value === CODEX_ACCOUNT) localStorage.setItem('kaishi:assistant-text-source', CODEX_ACCOUNT);
          else localStorage.removeItem('kaishi:assistant-text-source');
        }}><option value="" disabled>选择文本模型</option>{(account || selectedModel === CODEX_ACCOUNT) && <option value={CODEX_ACCOUNT}>{account ? 'Codex（ChatGPT）' : 'Codex · 待登录'}</option>}{models.map(m => <option key={m.key} value={m.key}>{m.modelName}</option>)}</select><select aria-label="助手技能" value={skillId} onChange={e => setSkillId(e.target.value)}><option value="">通用对话</option><option value={H3_DIRECTOR_ID}>H3 导演 · 自动选择技能</option>{skills.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select>{busy ? <button aria-label="停止回复" onClick={() => controller.current?.abort()}>■</button> : <button className="chat-send" aria-label="发送消息" disabled={!input.trim()} onClick={() => void send()}>↑</button>}</div>
      </div>
      {referenceSearch !== null && <WorkflowDialog title="画布素材" onClose={() => setReferenceSearch(null)} closeOnBackdrop>
        <div className="workflow-fields">
          <label>搜索素材<input className="dialog-input" data-dialog-focus value={referenceSearch} onChange={event => setReferenceSearch(event.target.value)} /></label>
          <div className="assistant-reference-list">
            {pickerOptions.map(reference => <button key={reference.id} type="button" onClick={() => attachReference(reference)}>
              <span>{reference.name}</span><small>{reference.type}</small>
            </button>)}
            {!pickerOptions.length && <p>没有可添加的素材</p>}
          </div>
        </div>
      </WorkflowDialog>}
  </aside>;
}
