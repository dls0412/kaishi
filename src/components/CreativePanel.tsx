import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useCanvas } from '../store';
import {
  DEFAULT_IMAGE_PARAMS,
  DEFAULT_VIDEO_PARAMS,
  TYPE_LABELS,
  nodeDisplayName,
  ROLE_KINDS,
  ROLE_LABELS,
  type ReferenceRole,
  type AssetKind,
  type AssetMeta,
  type CanvasNode,
  type ImageGenParams,
  type MediaNode,
  type NodeReference,
  type VideoGenParams,
} from '../types';
import {
  copySourceText,
  hasRefToken,
  imageReferenceLabels,
  insertPromptRef,
  insertPromptRefAt,
  refTokenId,
  removePromptRef,
  removePromptRefByNodeId,
  resolvePrompt,
  resolveReferences,
  h3ReferenceLabels,
  nodeModelOptions,
  capabilitiesOf,
  fitParamsToCapabilities,
  findBinding,
} from '../lib/models';
import { useAssetUrl } from './useAssetUrl';
import Icon from './Icon';
import { generateNode, generationConfig, useGeneration } from '../lib/generation';
import ReferencePicker from './ReferencePicker';
import { uid } from '../lib/utils';
import { H3_CAPABILITIES, QWEN_IMAGE_CAPABILITIES } from '../lib/modelCatalog';
import { CODEX_IMAGE, codexStatus, useCodexAccount } from '../lib/codexAccount';

interface Props {
  node: MediaNode;
  maxHeight: number;
  onOpenSettings: () => void;
  onNotice: (text: string, kind?: 'ok' | 'err' | 'info') => void;
}

function MiniThumb({ assetId, name, kind }: { assetId: string; name: string; kind?: AssetKind }) {
  const url = useAssetUrl(assetId);
  if (kind === 'image' || !kind) {
    return url ? <img src={url} alt={name} draggable={false} /> : <span className="mini-thumb-empty"><Icon name="image" size={13} /></span>;
  }
  return <span className="mini-thumb-empty"><Icon name={kind} size={13} /></span>;
}

const KIND_LABEL: Record<AssetKind | 'text', string> = { image: '图片', video: '视频', audio: '音频', text: '文字' };

/** 与 BeefTV 一致的「@查询」识别：光标前紧邻的 @ 后不出现空白与常见标点 */
const MENTION_RE = /@([^\s@,.;:!?，。；：！？、)\]}】）]*)$/;
const PROMPT_TOKEN_SPLIT = /(@\[[^\]\n]+\])/g;
const PROMPT_TOKEN_EXACT = /^@\[[^\]\n]+\]$/;

type PromptPiece =
  | { key: number; type: 'text'; text: string }
  | { key: number; type: 'chip'; raw: string; label: string; nodeId: string; kindLabel: string; broken: boolean };

interface MentionState { start: number; end: number; query: string }

interface MentionCandidate {
  source: CanvasNode | NodeReference;
  label: string;
  kindLabel: string;
  summary: string;
  referenced: boolean;
  fromLibrary?: boolean;
}

function roleForAsset(roles: ReferenceRole[], kind: AssetKind) {
  return roles.find(role => role === `reference-${kind}`) ?? roles.find(role => ROLE_KINDS[role] === kind);
}

/** 一条连线上游输入（分组框不作为参考输入） */
interface ConnectedInput {
  edgeId: string;
  node: Exclude<CanvasNode, { type: 'group' }>;
  ready: boolean;
  referenced: boolean;
}

export default function NodeCreativeControls({ node, maxHeight, onOpenSettings, onNotice }: Props) {
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [refsOpen, setRefsOpen] = useState(false);
  const [mention, setMention] = useState<MentionState | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const mentionCaret = useRef<number | null>(null);

  const assets = useCanvas((s) => s.assets);
  const settings = useCanvas((s) => s.settings);
  const codexAccount = useCodexAccount(s => s.status?.account);
  useEffect(() => { if (node.type === 'image') void codexStatus().catch(() => {}); }, [node.type]);
  const nodes = useCanvas((s) => s.nodes);
  const edges = useCanvas((s) => s.edges);
  const updateNodeParams = useCanvas((s) => s.updateNodeParams);
  const deleteEdge = useCanvas((s) => s.deleteEdge);
  const beginGesture = useCanvas((s) => s.beginGesture);
  const endGesture = useCanvas((s) => s.endGesture);

  const isVideo = node.type === 'video';
  const config = generationConfig(node, settings);
  const modelKey = (isVideo ? node.videoParams?.modelKey : node.imageParams?.modelKey) ?? '';
  const modelOptions = nodeModelOptions(settings, isVideo ? 'video' : 'image', modelKey === CODEX_IMAGE ? '' : modelKey).filter(option => {
    if (option.key === modelKey) return true;
    const binding = findBinding(settings, option.key);
    return Boolean(binding?.service.baseUrl.trim() && binding.service.apiKey.trim()
      && (binding.service.protocol === 'openai' || binding.service.protocol === (isVideo ? 'compshare-h3' : 'compshare-image')));
  });
  const prepared = config?.node ?? node;
  const params: ImageGenParams | VideoGenParams = isVideo
    ? (prepared.videoParams ?? DEFAULT_VIDEO_PARAMS)
    : (prepared.imageParams ?? DEFAULT_IMAGE_PARAMS);
  const caps = config?.caps;
  const protocol = config?.binding.service.protocol;
  const roles = useMemo<ReferenceRole[]>(() => protocol === 'openai'
    ? [isVideo ? 'first-frame' : 'reference-image']
    : caps?.roles.length ? caps.roles : isVideo ? ['reference-image', 'reference-video', 'reference-audio'] : ['reference-image'], [caps, isVideo, protocol]);
  const generating = useGeneration(s => s.tasks.some(t => t.nodeId === node.id && t.status === 'running'));
  const attachments = useMemo(() => params.references.filter(reference => assets.some(asset => asset.id === reference.assetId)), [assets, params.references]);
  const rows = protocol === 'compshare-h3' || protocol === 'compshare-image'
    ? resolveReferences(prepared, nodes, edges, caps ?? null, assets).mediaInputs : [];
  const mediaLabels = protocol === 'compshare-h3' ? h3ReferenceLabels(rows)
    : protocol === 'compshare-image' ? imageReferenceLabels(rows) : undefined;
  const resolved = resolvePrompt(params.prompt, params.promptRefs, nodes, mediaLabels, attachments);
  const vp = isVideo ? (params as VideoGenParams) : null;
  const ip = isVideo ? null : (params as ImageGenParams);

  const ratios = config ? (caps?.ratios ?? []) : (isVideo ? H3_CAPABILITIES.ratios : QWEN_IMAGE_CAPABILITIES.ratios);
  const resolutions = config ? (caps?.resolutions ?? []) : (isVideo ? H3_CAPABILITIES.resolutions : QWEN_IMAGE_CAPABILITIES.resolutions);
  const durations = config ? (caps?.durations ?? []) : H3_CAPABILITIES.durations;
  const audioOptions = caps?.audioOptions ?? [];
  const visibleAdvanced = (caps?.advancedFields ?? []).filter(field => field.key !== 'skillId');

  const patch = (p: Parameters<typeof updateNodeParams>[1]) => updateNodeParams(node.id, p);
  const patchLive = (p: Parameters<typeof updateNodeParams>[1]) => updateNodeParams(node.id, p, true);

  useLayoutEffect(() => {
    if (mentionCaret.current === null || !promptRef.current) return;
    promptRef.current.focus();
    promptRef.current.setSelectionRange(mentionCaret.current, mentionCaret.current);
    mentionCaret.current = null;
  }, [params.prompt]);
  useLayoutEffect(() => {
    const field = promptRef.current;
    if (!field) return;
    const limit = Math.max(88, Math.min(260, maxHeight - 85));
    field.style.height = 'auto';
    field.style.height = `${Math.min(limit, Math.max(promptExpanded ? Math.min(200, limit) : 88, field.scrollHeight))}px`;
  }, [params.prompt, promptExpanded, maxHeight]);

  /** 从连线收集上游节点和文字引用。 */
  const connectedInputs = useMemo<ConnectedInput[]>(() => {
    const out: ConnectedInput[] = [];
    edges.filter((e) => e.to === node.id).forEach((e) => {
      const source = nodes.find((n) => n.id === e.from);
      if (!source || source.type === 'group') return;
      out.push({
        edgeId: e.id,
        node: source,
        ready: source.type === 'text' ? !!source.text.trim() : !!source.assetId,
        referenced: params.promptRefs.some((r) => r.nodeId === source.id),
      });
    });
    return out;
  }, [edges, nodes, node.id, params.promptRefs]);

  const connectedNodes = useMemo(() => connectedInputs.map((x) => x.node), [connectedInputs]);

  /** 把纯文本提示词切成「普通文字 / inline 引用 chip」两段流，供镜像层渲染 */
  const promptPieces = useMemo<PromptPiece[]>(() => (
    params.prompt.split(PROMPT_TOKEN_SPLIT).map((part, key) => {
      if (!PROMPT_TOKEN_EXACT.test(part)) return { key, type: 'text', text: part };
      const nodeId = refTokenId(part);
      const source = nodes.find((n) => n.id === nodeId);
      const ref = params.promptRefs.find((r) => r.nodeId === nodeId || r.id === nodeId);
      const attachment = attachments.find(reference => reference.id === (ref?.nodeId ?? nodeId));
      return {
        key,
        type: 'chip',
        raw: part,
        nodeId,
        label: source ? (source.name || nodeDisplayName(source)) : (attachment?.name || ref?.label || '来源已移除'),
        kindLabel: source ? TYPE_LABELS[source.type] : attachment ? KIND_LABEL[attachment.kind] : '失效',
        broken: !source && !attachment,
      };
    })
  ), [params.prompt, params.promptRefs, nodes, attachments]);

  const mentionCandidates = useMemo<MentionCandidate[]>(() => {
    if (!mention) return [];
    const list: MentionCandidate[] = connectedNodes.filter(n =>
      n.type === 'text' ? !!n.text.trim() : !!n.assetId && assets.some(asset => asset.id === n.assetId),
    ).map((n) => ({
      source: n,
      label: nodeDisplayName(n),
      kindLabel: TYPE_LABELS[n.type],
      summary: n.type === 'text' ? (n.text || '').trim().slice(0, 40) || '（空文本）' : nodeDisplayName(n),
      referenced: params.promptRefs.some((r) => r.nodeId === n.id),
    }));
    for (const reference of attachments) {
      list.push({
        source: reference, label: reference.name, kindLabel: KIND_LABEL[reference.kind],
        summary: '已添加的参考素材', referenced: params.promptRefs.some(r => r.nodeId === reference.id),
      });
    }
    const linkedAssets = new Set(connectedNodes.flatMap(n => 'assetId' in n ? [n.assetId] : []));
    attachments.forEach(reference => linkedAssets.add(reference.assetId));
    for (const asset of assets) {
      const role = roleForAsset(roles, asset.kind);
      if (!role || linkedAssets.has(asset.id)) continue;
      list.push({
        source: { id: asset.id, assetId: asset.id, name: asset.name, kind: asset.kind, role },
        label: asset.name, kindLabel: KIND_LABEL[asset.kind], summary: '素材库',
        referenced: false, fromLibrary: true,
      });
    }
    const q = mention.query.trim().toLowerCase();
    return list.filter(c => !q || `${c.label} ${c.summary} ${c.kindLabel}`.toLowerCase().includes(q)).slice(0, 8);
  }, [connectedNodes, assets, attachments, params.promptRefs, mention, roles]);

  const syncMention = (value: string, caret: number) => {
    const match = MENTION_RE.exec(value.slice(0, caret));
    if (!match) { setMention(null); return; }
    setMention({ start: caret - match[0].length, end: caret, query: match[1] });
    setMentionIndex(0);
  };

  const chooseMention = (candidate: MentionCandidate) => {
    if (!mention) return;
    const attachment = candidate.fromLibrary && 'role' in candidate.source
      ? { ...candidate.source, id: uid('ref') } : null;
    const result = insertPromptRefAt(params.prompt, params.promptRefs, attachment ?? candidate.source, mention.start, mention.end);
    mentionCaret.current = result.caret;
    patch({
      prompt: result.prompt, promptRefs: result.promptRefs,
      ...(attachment && result.inserted ? { references: [...params.references, attachment] } : {}),
    });
    setMention(null);
    if (!result.inserted) onNotice(result.reason, 'info');
  };

  const onPromptKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229 || !mention) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setMention(null);
      return;
    }
    if (!mentionCandidates.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setMentionIndex((i) => (e.key === 'ArrowDown'
        ? Math.min(mentionCandidates.length - 1, i + 1)
        : Math.max(0, i - 1)));
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      chooseMention(mentionCandidates[Math.min(mentionIndex, mentionCandidates.length - 1)]);
    }
  };

  /* 引用 = 绑定来源身份；复制 = 一次性粘贴原文，两者分开 */
  const quoteSource = (source: CanvasNode) => {
    const result = insertPromptRef(params.prompt, params.promptRefs, source);
    if (result.inserted) patch({ prompt: result.prompt, promptRefs: result.promptRefs });
    else onNotice(result.reason, 'info');
  };

  const copyText = (source: CanvasNode) => {
    const next = copySourceText(params.prompt, source);
    if (next === params.prompt) { onNotice('来源文本为空', 'info'); return; }
    patch({ prompt: next.slice(0, 4000) });
  };

  const dropRefToken = (refId: string) => {
    const result = removePromptRef(params.prompt, params.promptRefs, refId);
    patch({ prompt: result.prompt, promptRefs: result.promptRefs });
  };

  const readyCount = connectedInputs.filter((x) => x.ready).length;
  const hasGenerationInput = !!resolved.text.trim() || connectedInputs.some(input => input.node.type === 'text' && input.ready)
    || (protocol === 'compshare-h3' && rows.some(row => row.ready && !row.duplicate));
  const addReference = (asset: AssetMeta) => {
    const role = roleForAsset(roles, asset.kind);
    if (!role) return;
    patch({ references: [...params.references, { id: uid('ref'), assetId: asset.id, kind: asset.kind, name: asset.name, role }] });
    setRefsOpen(false);
  };

  return (
    <div className="cc-body creative-panel" style={{ maxHeight }}>
      {/* 1. 提示词 */}
      <div className="cc-block">
        <div className="cc-prompt-wrap">
          <div className="prompt-input-shell">
            <div className="prompt-mirror" ref={mirrorRef} aria-hidden="true" data-testid="prompt-mirror">
              {promptPieces.map((piece) => (piece.type === 'text'
                ? <span key={piece.key}>{piece.text}</span>
                : (
                  <span key={piece.key}
                    className={`prompt-chip${piece.broken ? ' broken' : ''}`}
                    data-prompt-chip={piece.nodeId}
                    data-prompt-chip-kind={piece.kindLabel}
                    title={piece.broken ? '来源节点已删除' : `引用 · ${piece.kindLabel} · ${piece.label}（按最新内容解析）`}>
                    <span className="chip-ghost">{piece.raw}</span>
                    <span className="chip-label">@{piece.label}</span>
                  </span>
                )))}
              {'\u200b'}
            </div>
            <textarea
              ref={promptRef}
              className="cc-prompt creative-textarea has-mirror"
              data-testid="node-prompt"
              rows={2}
              value={params.prompt}
              placeholder={isVideo ? '描述要生成的视频，输入 @ 引用素材' : '描述要生成的图片，输入 @ 引用素材'}
              spellCheck={false}
              onFocus={() => beginGesture()}
              onChange={(e) => {
                const next = e.target.value;
                const promptRefs = params.promptRefs.filter(ref => hasRefToken(next, ref.nodeId) || hasRefToken(next, ref.id));
                patchLive({ prompt: next, promptRefs });
                syncMention(next, e.target.selectionStart ?? next.length);
              }}
              onScroll={(e) => {
                if (mirrorRef.current) mirrorRef.current.scrollTop = e.currentTarget.scrollTop;
              }}
              onKeyDown={onPromptKeyDown}
              onBlur={() => { setMention(null); endGesture(); }}
            />
            <button type="button" className="prompt-expand" aria-label={promptExpanded ? '收起输入框' : '展开输入框'}
              title={promptExpanded ? '收起输入框' : '展开输入框'} onClick={() => setPromptExpanded(value => !value)}>
              <Icon name={promptExpanded ? 'zoomOut' : 'zoomIn'} size={14} />
            </button>
          </div>
          {mention && (
            <div className="mention-menu" data-testid="mention-menu" onMouseDown={(e) => e.preventDefault()}>
              <div className="mention-head"><span>引用素材</span><em>↑↓ 选择 · Enter 插入 · Esc 关闭</em></div>
              {mentionCandidates.length === 0
                ? <div className="mention-empty">{mention.query ? '没有匹配的素材' : '先添加参考素材，或连入画布节点'}</div>
                : mentionCandidates.map((c, i) => (
                  <button key={c.source.id} type="button"
                    className={`mention-item${i === mentionIndex ? ' active' : ''}${c.referenced ? ' referenced' : ''}`}
                    data-mention-node={c.source.id}
                    onMouseEnter={() => setMentionIndex(i)}
                    onClick={() => chooseMention(c)}>
                    <span className="mention-kind">{c.kindLabel}</span>
                    <span className="mention-main"><strong>{c.label}</strong><em>{c.summary}</em></span>
                    {c.referenced && <span className="mention-tag off">已引用</span>}
                  </button>
                ))}
            </div>
          )}
        </div>

        {/* 2. 参考输入 */}
        {!!connectedInputs.length && <div className="reference-strip" data-testid="prompt-refs">
          <div className="ref-strip-head" data-testid="refs-toggle">
            <span>参考输入 · {connectedInputs.length}</span>
            <em>{readyCount === connectedInputs.length ? '' : `${connectedInputs.length - readyCount} 项未就绪`}</em>
          </div>
          <div className="ref-chips" data-testid="refs-panel">
            <div className="ref-inputs-wrap" data-testid="text-inputs">
              {connectedInputs.map((input, index) => {
                const src = input.node;
                const kind: AssetKind | 'text' = src.type === 'text' ? 'text' : src.type;
                const assetId = src.type === 'text' ? '' : src.assetId;
                return (
                  <span key={input.edgeId}
                    className={`prompt-ref-chip ref-chip${src.type === 'text' ? ' text-input-row' : ''}${input.ready ? '' : ' not-ready'}${input.referenced ? ' quoted' : ''}`}
                    data-ref-row={`edge:${input.edgeId}`}
                    data-text-input={src.id}
                    title={`${KIND_LABEL[kind]} · ${src.name || nodeDisplayName(src)}${input.ready ? '' : '（空节点，未就绪）'}`}>
                    <button className="ref-chip-main" data-testid="quote-source"
                      title="引用：把来源节点的最新内容绑定到提示词" onClick={() => quoteSource(src)}>
                      <span className="ref-index">{index + 1}</span>
                      <span className="ref-thumb"><MiniThumb assetId={assetId} name={src.name} kind={kind === 'text' ? undefined : kind} /></span>
                      <em>{KIND_LABEL[kind]}</em>
                      <strong>{src.name || nodeDisplayName(src)}</strong>
                    </button>
                    <span className="chip-ops">
                      {src.type !== 'text' && !!caps?.roles.length && <select aria-label={`参考用途 ${src.name}`} className="ref-role-select" value={params.edgeRoles[input.edgeId] || `reference-${src.type}`} onChange={e => patch({ edgeRoles: { ...params.edgeRoles, [input.edgeId]: e.target.value as ReferenceRole } })}>
                        {caps.roles.filter(role => ROLE_KINDS[role] === src.type).map(role => <option key={role} value={role}>{ROLE_LABELS[role]}</option>)}
                      </select>}
                      {src.type === 'text' && (
                        <button className="ref-chip-op" data-testid="copy-source"
                          title="复制：一次性粘贴原文，不建立绑定" onClick={() => copyText(src)}>复制</button>
                      )}
                      <button className="ref-chip-op close" data-testid="drop-input"
                        title="断开连线，移除该输入" onClick={() => deleteEdge(input.edgeId)}><Icon name="close" size={10} /></button>
                    </span>
                  </span>
                );
              })}
            </div>
          </div>
        </div>}

        {/* 引用按来源最新内容解析；只在这一行显示结果，不做成另一个面板 */}
        {params.promptRefs.length > 0 && (
          <div className="resolved-line" data-testid="resolved-preview-line">
            <span>解析预览</span>
            <em data-testid="resolved-preview">{resolved.text || '（空）'}</em>
          </div>
        )}

        {/* 提示词里的失效引用：只显示问题，不堆状态 */}
        {resolved.issues.length > 0 && (
          <div className="cc-issues" data-testid="prompt-issues">{resolved.issues.map((x) => <div key={x}>⚠ {x}</div>)}</div>
        )}
        {params.promptRefs.some(r => !nodes.some(n => n.id === r.nodeId) && !attachments.some(a => a.id === r.nodeId)) && (
          <div className="ref-broken-row" data-testid="ref-broken">
            {params.promptRefs.filter(r => !nodes.some(n => n.id === r.nodeId) && !attachments.some(a => a.id === r.nodeId)).map((r) => (
              <span key={r.id} className="prompt-ref-chip broken">
                引用失效 · 来源已移除
                <button onClick={() => dropRefToken(r.id)} title="移除引用"><Icon name="close" size={10} /></button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* 生成操作 */}
      <div className="cc-reference-row">
        {params.references.map(reference => <span className="direct-reference" key={reference.id}>
          <span className="ref-thumb"><MiniThumb assetId={reference.assetId} name={reference.name} kind={reference.kind} /></span>
          <span title={reference.name}>{reference.name}</span>
          {roles.filter(role => ROLE_KINDS[role] === reference.kind).length > 1 && <select
            aria-label={`${reference.name}的参考用途`} value={reference.role}
            onChange={event => patch({ references: params.references.map(item => item.id === reference.id ? { ...item, role: event.target.value as ReferenceRole } : item) })}>
            {roles.filter(role => ROLE_KINDS[role] === reference.kind).map(role => <option key={role} value={role}>{ROLE_LABELS[role]}</option>)}
          </select>}
          <button aria-label={`移除参考 ${reference.name}`} onClick={() => {
            const promptPatch = params.promptRefs.some(ref => ref.nodeId === reference.id)
              ? removePromptRefByNodeId(params.prompt, params.promptRefs, reference.id) : {};
            patch({ ...promptPatch, references: params.references.filter(item => item.id !== reference.id) });
          }}><Icon name="close" size={12} /></button>
        </span>)}
      </div>
      <div className="cc-row generation-toolbar" aria-label={`${isVideo ? '视频' : '图片'}生成参数`}>
        <select className="node-model-choice" data-testid="node-model-select" aria-label={`${isVideo ? '视频' : '图片'}模型`} value={modelKey}
          onChange={event => {
            const key = event.target.value;
            const capability = capabilitiesOf(settings, key);
            if (key && capability) patch(fitParamsToCapabilities({ ...params, modelKey: key }, capability, isVideo ? 'video' : 'image').params);
            else patch({ modelKey: key });
          }}>
          <option value="">{config && !modelKey ? `默认 · ${config.binding.model.name}` : '选择模型'}</option>
          {!isVideo && (codexAccount || modelKey === CODEX_IMAGE) && <option value={CODEX_IMAGE} disabled={!codexAccount}>{codexAccount ? 'GPT 生图（Codex 账号）' : 'GPT 生图（请连接 Codex）'}</option>}
          {modelOptions.map(option => <option key={option.key} value={option.key} disabled={option.unavailable}>{option.unavailable ? option.label : option.modelName}</option>)}
        </select>
        <button className="cc-param-trigger" onClick={() => setRefsOpen(true)}><Icon name="plus" size={13} /> 参考素材</button>
        {resolutions.length > 0 && <select data-testid="param-resolution" aria-label="分辨率" title="分辨率" value={resolutions.includes(params.resolution) ? params.resolution : resolutions[0]}
          onChange={e => patch({ resolution: e.target.value })}>{resolutions.map(value => <option key={value} value={value}>{value}</option>)}</select>}
        <label className="creative-field"><span>比例</span>
          <select data-testid="param-ratio" aria-label="比例" value={ratios.includes(params.aspectRatio) ? params.aspectRatio : ratios[0] ?? ''} disabled={!ratios.length}
            onChange={e => patch({ aspectRatio: e.target.value })}>
            {!ratios.length ? <option value="">模型不提供</option> : ratios.map(r => <option key={r} value={r}>{r === 'adaptive' ? '自适应' : r}</option>)}
          </select>
        </label>
        {vp && <>
          <label className="creative-field"><span>时长</span>
            <select data-testid="param-duration" aria-label="时长" value={durations.includes(vp.duration) ? vp.duration : durations[0] ?? ''} disabled={!durations.length}
              onChange={e => patch({ duration: Number(e.target.value) })}>
              {!durations.length ? <option value="">模型不提供</option> : durations.map(d => <option key={d} value={d}>{d} 秒</option>)}
            </select>
          </label>
          <label className="creative-field"><span>声音</span>
            {(!config || protocol === 'compshare-h3') ? <input type="checkbox" data-testid="param-audio" aria-label="保留声音" checked={vp.audio !== 'mute'} onChange={e => patch({ audio: e.target.checked ? 'keep' : 'mute' })} />
              : <select data-testid="param-audio" aria-label="声音" value={audioOptions.some(a => a.id === vp.audio) ? vp.audio : ''} disabled={!config || !audioOptions.length} onChange={e => patch({ audio: e.target.value })}>
                {!audioOptions.length ? <option value="">模型不提供</option> : audioOptions.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
              </select>}
          </label>
        </>}
        {!vp && (caps?.maxCount ?? 1) > 1 && <label className="creative-field"><span>张数</span>
          <select aria-label="张数" value={ip?.count ?? 1} onChange={e => patch({ count: Number(e.target.value) })}>
            {Array.from({ length: Math.max(1, caps?.maxCount ?? 1) }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1} 张</option>)}
          </select>
        </label>}
        {visibleAdvanced.filter(f => f.kind === 'boolean').map(f => <label className="creative-field toolbar-toggle" key={f.key}>
          <span>{f.key === 'useContextIr' ? '优化' : f.key === 'aigcWatermark' ? '水印' : f.label}</span>
          <input aria-label={f.key === 'useContextIr' ? '智能优化提示词' : f.key === 'aigcWatermark' ? '添加水印' : f.label}
            type="checkbox" checked={Boolean(params.advanced?.[f.key] ?? f.defaultValue)}
            onChange={e => patch({ advanced: { ...(params.advanced ?? {}), [f.key]: e.target.checked } })} />
        </label>)}
        {visibleAdvanced.filter(f => f.kind === 'text').map(f => <label className="creative-field" key={f.key}><span>{f.label}</span>
          <input className="toolbar-text-param" value={String(params.advanced?.[f.key] ?? f.defaultValue)}
            onChange={e => patch({ advanced: { ...(params.advanced ?? {}), [f.key]: e.target.value } })} />
        </label>)}
        {config
          ? <button className="cc-generate" data-testid="generate-btn" disabled={generating || !hasGenerationInput}
            onClick={() => void generateNode(node.id).then(() => onNotice('生成完成，素材已保存', 'ok')).catch(err => onNotice(err.message, 'err'))}>
            <Icon name={generating ? 'refresh' : 'sparkles'} size={15} /> {generating ? '生成中…' : `生成${TYPE_LABELS[node.type]}`}
          </button>
          : <button className="cc-generate" data-testid="generate-btn" onClick={() => { onNotice(`请先在设置中连接${TYPE_LABELS[node.type]}模型`, 'info'); onOpenSettings(); }}>
            <Icon name="sparkles" size={15} /> 生成{TYPE_LABELS[node.type]}
          </button>}
      </div>
      {refsOpen && <ReferencePicker roles={roles} onClose={() => setRefsOpen(false)} onSelect={addReference}
        attached={[...params.references.map(reference => reference.assetId), ...connectedNodes.flatMap(source => 'assetId' in source ? [source.assetId] : [])]} />}
    </div>
  );
}
