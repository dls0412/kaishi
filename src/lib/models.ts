import { modelFetch } from './modelTransport';
import {
  DEFAULT_IMAGE_PARAMS,
  DEFAULT_VIDEO_PARAMS,
  isMediaNode,
  MODEL_TYPE_LABELS,
  ROLE_KINDS,
  ROLE_LABELS,
  type AppSettings,
  type CanvasNode,
  type ConnectionState,
  type Edge,
  type GenParams,
  type ImageGenParams,
  type MediaNode,
  type ModelCapabilities,
  type ModelService,
  type ModelType,
  type NodeReference,
  type PromptRef,
  type ReferenceKind,
  type ReferenceRole,
  type ServiceModel,
  type VideoGenParams,
  type AssetMeta,
} from '../types';
import { isResourceNode } from './nodeSemantics';
import { protocolSpec, QWEN_IMAGE_CAPABILITIES, qwenImageResolutions } from './modelCatalog';

/** 真实生成执行尚未接入。界面必须如实标注，不得伪装成可生成。 */
export const GENERATION_IMPLEMENTED = true;

/* ==================== 服务 + 模型绑定 ==================== */
export function makeModelKey(serviceId: string, modelId: string): string {
  return `${serviceId}::${modelId}`;
}

export function parseModelKey(key: string): { serviceId: string; modelId: string } | null {
  if (!key || typeof key !== 'string') return null;
  const i = key.indexOf('::');
  if (i <= 0) return null;
  return { serviceId: key.slice(0, i), modelId: key.slice(i + 2) };
}

export interface ModelBinding {
  key: string;
  service: ModelService;
  model: ServiceModel;
}

export interface ModelOption {
  key: string;
  label: string;
  serviceName: string;
  modelId: string;
  modelName: string;
  unavailable?: boolean;
}

/** 节点模型列表 = 设置里已启用服务下、已启用且类型匹配的模型 */
export function availableModels(settings: AppSettings, type: ModelType): ModelOption[] {
  const out: ModelOption[] = [];
  settings.services.forEach((service) => {
    if (!service.enabled) return;
    service.models.forEach((m) => {
      if (!m.enabled || m.type !== type) return;
      out.push({
        key: makeModelKey(service.id, m.id),
        label: `${service.name} / ${m.name}（${m.id}）`,
        serviceName: service.name,
        modelId: m.id,
        modelName: m.name,
      });
    });
  });
  return out;
}

/** 保留节点当前绑定，即使它已停用 / 被移除，也要作为「不可用」选项显示，不能悄悄换掉 */
export function nodeModelOptions(settings: AppSettings, type: ModelType, boundKey: string): ModelOption[] {
  const list = availableModels(settings, type);
  if (!boundKey) return list;
  if (list.some((o) => o.key === boundKey)) return list;
  const parsed = parseModelKey(boundKey);
  return [{
    key: boundKey,
    label: `⚠ 不可用：${parsed?.modelId ?? boundKey}`,
    serviceName: '原服务已停用或模型已移除',
    modelId: parsed?.modelId ?? '',
    modelName: '不可用',
    unavailable: true,
  }, ...list];
}

export function findBinding(settings: AppSettings, key: string): ModelBinding | null {
  const parsed = parseModelKey(key);
  if (!parsed) return null;
  const service = settings.services.find((s) => s.id === parsed.serviceId);
  if (!service) return null;
  const model = service.models.find((m) => m.id === parsed.modelId);
  if (!model) return null;
  return { key, service, model };
}

export function capabilitiesOf(settings: AppSettings, key: string): ModelCapabilities | null {
  const binding = findBinding(settings, key);
  if (!binding) return null;
  const caps = binding.model.capabilities;
  const tiers = binding.service.connection.imageResolutions;
  if (binding.service.protocol === 'compshare-image' && tiers?.length && caps.source === QWEN_IMAGE_CAPABILITIES.source
    && caps.resolutions.length === 1 && caps.resolutions[0] === '1K') return { ...caps, resolutions: tiers };
  return caps;
}

/* ==================== 节点状态 ==================== */
export type NodeStatusTone = 'none' | 'warn' | 'error' | 'ok' | 'muted';

export interface NodeModelStatus {
  tone: NodeStatusTone;
  title: string;
  hint: string;
  configured: boolean;
  connection: ConnectionState['status'] | 'none';
  modelAvailable: boolean;
  serviceName: string;
  capabilities: ModelCapabilities | null;
  generationImplemented: boolean;
}

/**
 * 状态只由「本节点绑定的服务 + 模型」决定。
 * 任何一个服务填了地址/Key，都不会让其它类型的节点变成已配置。
 */
export function nodeModelStatus(settings: AppSettings, node: MediaNode): NodeModelStatus {
  const type: ModelType = node.type === 'video' ? 'video' : 'image';
  const p = (node.videoParams ?? node.imageParams) as GenParams | undefined;
  const key = p?.modelKey ?? '';
  const base = {
    configured: false, connection: 'none' as const, modelAvailable: false,
    serviceName: '', capabilities: null as ModelCapabilities | null,
    generationImplemented: GENERATION_IMPLEMENTED,
  };

  if (!key) {
    return {
      ...base, tone: 'warn', title: '未绑定模型',
      hint: `这个节点还没有选择${MODEL_TYPE_LABELS[type]}模型（旧项目数据只会保留原内容与参数，不会自动换成列表第一项）。请到设置里启用模型，或在本节点下方选择。`,
    };
  }
  const parsed = parseModelKey(key);
  const service = parsed ? settings.services.find((s) => s.id === parsed.serviceId) : undefined;
  if (!service) {
    return { ...base, tone: 'error', title: '模型不可用 · 服务已移除', hint: '原绑定的模型服务已从设置中删除。节点内容与参数已保留，请重新选择模型。' };
  }
  const model = service.models.find((m) => m.id === parsed?.modelId);
  if (!model) {
    return { ...base, tone: 'error', title: '模型不可用 · 模型已移除', hint: `服务「${service.name}」下已没有这个模型。节点内容与参数已保留，请重新选择。` , serviceName: service.name };
  }
  if (!service.enabled) {
    return { ...base, tone: 'error', title: '模型不可用 · 服务已停用', hint: `服务「${service.name}」已被停用。只影响绑定该服务的节点，重新启用即可恢复。`, serviceName: service.name, capabilities: model.capabilities };
  }
  if (!model.enabled) {
    return { ...base, tone: 'error', title: '模型不可用 · 模型已停用', hint: `模型「${model.name}」在设置里被停用。节点内容与参数已保留。`, serviceName: service.name, capabilities: model.capabilities };
  }
  if (model.type !== type) {
    return { ...base, tone: 'error', title: '模型类型不匹配', hint: `该模型是${MODEL_TYPE_LABELS[model.type]}类型，不能用于${MODEL_TYPE_LABELS[type]}节点。`, serviceName: service.name, capabilities: model.capabilities };
  }

  const caps = model.capabilities;
  const serviceName = service.name;
  const suffix = ['openai', 'compshare-image', 'compshare-h3'].includes(service.protocol) ? '生成将调用你配置的模型服务。' : '此协议的生成适配尚未完成。';
  if (!service.baseUrl.trim() || !service.apiKey.trim()) {
    return { ...base, tone: 'warn', title: '配置未完整 · 地址或凭据为空', hint: `服务「${serviceName}」还没有保存接口地址或凭据。${suffix}`, modelAvailable: true, serviceName, capabilities: caps };
  }
  if (service.connection.status === 'failed') {
    return { ...base, tone: 'error', title: '连接验证失败', hint: `${service.connection.message || '上次验证未通过'}。${suffix}`, configured: true, connection: 'failed', modelAvailable: true, serviceName, capabilities: caps };
  }
  if (service.connection.status === 'unverified') {
    return { ...base, tone: 'warn', title: '配置已保存 · 连接未验证', hint: `尚未对「${serviceName}」按 ${service.protocol} 协议执行连接测试。${suffix}`, configured: true, connection: 'unverified', modelAvailable: true, serviceName, capabilities: caps };
  }
  return { ...base, tone: 'ok', title: '配置已保存 · 连接正常', hint: `${service.connection.message}。${suffix}`, configured: true, connection: 'ok', modelAvailable: true, serviceName, capabilities: caps };
}

/* ==================== 参数与能力对齐 ==================== */
export interface FitResult<T extends GenParams> {
  params: T;
  adjustments: string[];
  incompatibilities: string[];
}

export function fitParamsToCapabilities<T extends GenParams>(params: T, caps: ModelCapabilities, type: ModelType): FitResult<T> {
  const next = { ...params } as T & Record<string, unknown>;
  const adjustments: string[] = [];
  const incompatibilities: string[] = [];

  if (caps.ratios.length && !caps.ratios.includes(next.aspectRatio as string)) {
    adjustments.push(`比例「${next.aspectRatio || '空'}」不在该模型能力内，已调整为「${caps.ratios[0]}」`);
    next.aspectRatio = caps.ratios[0];
  } else if (!caps.ratios.length && next.aspectRatio) {
    incompatibilities.push('该模型未声明支持的宽高比，请按接口文档补全能力配置');
  }

  if (caps.resolutions.length && !caps.resolutions.includes(next.resolution as string)) {
    adjustments.push(`分辨率「${next.resolution || '空'}」不被支持，已调整为「${caps.resolutions[0]}」`);
    next.resolution = caps.resolutions[0];
  } else if (!caps.resolutions.length && next.resolution) {
    incompatibilities.push('该模型未声明支持的分辨率档位，请按接口文档补全能力配置');
  }

  if (type === 'video') {
    const p = next as unknown as VideoGenParams;
    if (caps.durations.length && !caps.durations.includes(p.duration)) {
      const closest = caps.durations.reduce((best, d) => Math.abs(d - p.duration) < Math.abs(best - p.duration) ? d : best, caps.durations[0]);
      adjustments.push(`时长「${p.duration} 秒」不被支持，已调整为「${closest} 秒」`);
      p.duration = closest;
    }
    if (caps.audioOptions.length) {
      if (!caps.audioOptions.some((o) => o.id === p.audio)) {
        adjustments.push(`声音选项「${p.audio || '空'}」不被支持，已调整为「${caps.audioOptions[0].label}」`);
        p.audio = caps.audioOptions[0].id;
      }
    } else if (p.audio) {
      p.audio = '';
      incompatibilities.push('该模型没有独立声音选项，声音通过参考音频 / 静音开关表达');
    }
  } else {
    const p = next as unknown as ImageGenParams;
    const max = Math.max(1, caps.maxCount || 1);
    if (p.count > max) {
      adjustments.push(`张数 ${p.count} 超过该模型上限，已调整为 ${max}`);
      p.count = max;
    }
    if (p.count < 1) p.count = 1;
  }

  const refs = (next.references as GenParams['references']) ?? [];
  refs.forEach((r) => {
    if (!caps.roles.includes(r.role)) {
      incompatibilities.push(`手选素材「${r.name}」的用途「${ROLE_LABELS[r.role]}」不被当前模型支持，请改用途或移除`);
    }
  });
  Object.entries((next.edgeRoles as GenParams['edgeRoles']) ?? {}).forEach(([, role]) => {
    if (!caps.roles.includes(role)) {
      incompatibilities.push(`连线输入的用途「${ROLE_LABELS[role]}」不被当前模型支持，请调整`);
    }
  });
  if (refs.length > caps.maxReferences && caps.maxReferences > 0) {
    incompatibilities.push(`手选素材 ${refs.length} 个超过该模型上限 ${caps.maxReferences} 个，请删减`);
  }

  const allowedAdvanced = new Set(caps.advancedFields.map((f) => f.key));
  const advanced = { ...((next.advanced as GenParams['advanced']) ?? {}) };
  Object.keys(advanced).forEach((k) => { if (!allowedAdvanced.has(k)) delete advanced[k]; });
  caps.advancedFields.forEach((f) => { if (advanced[f.key] === undefined) advanced[f.key] = f.defaultValue; });
  next.advanced = advanced;

  return { params: next as T, adjustments, incompatibilities };
}

export function defaultParamsFor(key: string, type: 'image', caps: ModelCapabilities | null): ImageGenParams;
export function defaultParamsFor(key: string, type: 'video', caps: ModelCapabilities | null): VideoGenParams;
export function defaultParamsFor(key: string, type: 'image' | 'video', caps: ModelCapabilities | null): ImageGenParams | VideoGenParams {
  const c = caps ?? { ratios: [], resolutions: [], durations: [], audioOptions: [], maxCount: 1, advancedFields: [], roles: [], roleLimits: {}, maxReferences: 0, source: '', note: '' };
  const common = {
    ...(type === 'image' ? DEFAULT_IMAGE_PARAMS : DEFAULT_VIDEO_PARAMS),
    prompt: '', promptRefs: [], references: [], edgeRoles: {}, refOrder: [],
    modelKey: key,
    aspectRatio: c.ratios[0] ?? '',
    resolution: c.resolutions[0] ?? '',
    advanced: Object.fromEntries(c.advancedFields.map((f) => [f.key, f.defaultValue])) as Record<string, boolean | string>,
  };
  if (type === 'image') return { ...common, count: 1 };
  return { ...common, duration: c.durations[0] ?? 5, audio: c.audioOptions[0]?.id ?? '' };
}

/* ==================== 提示词引用 ==================== */
/**
 * 引用身份 = 画布节点 ID，与 BeefTV 的 `@[node:<nodeId>]` 等价。
 * 为了在纯文本提示词里可读，写成 `@[显示名#nodeId]`；同时兼容解析
 * BeefTV 的 `@[node:nodeId]` 以及旧项目里的 `@[显示名#refId]`。
 */
const REF_TOKEN_RE = /@\[[^\]\n]+\]/g;
const NODE_TOKEN_RE = /^@\[node:([A-Za-z0-9_-]{2,64})\]$/;
const ID_IN_TOKEN_RE = /#([A-Za-z0-9_-]{2,64})\]$/;

function shortRefId(existing: PromptRef[]): string {
  const used = new Set(existing.map((r) => r.id));
  for (let i = 0; i < 40; i += 1) {
    const id = `r${Math.random().toString(36).slice(2, 7)}`;
    if (!used.has(id)) return id;
  }
  return `r${Date.now().toString(36)}`;
}

/** 从任意一种引用标记里取出身份 ID */
export function refTokenId(token: string): string {
  const nodeForm = NODE_TOKEN_RE.exec(token);
  if (nodeForm) return nodeForm[1];
  const hashForm = ID_IN_TOKEN_RE.exec(token);
  return hashForm ? hashForm[1] : '';
}

/** 引用标记的显示名一律从来源节点的当前名称推导，避免改名后留下旧称呼 */
function promptRefLabelOf(source: CanvasNode | NodeReference): string {
  const raw = source.name
    || ('type' in source ? (source.type === 'text' ? source.text : isMediaNode(source) ? source.fileName : '') : '')
    || '来源';
  return raw.replace(/[@#[\]\n]/g, '').slice(0, 10) || '来源';
}

export function refToken(ref: PromptRef): string {
  const clean = (ref.label || '来源').replace(/[@#[\]]/g, '').slice(0, 10) || '来源';
  return `@[${clean}#${ref.nodeId}]`;
}

/**
 * 对照 BeefTV 的 applyCanvasConnectionPromptSync()：
 * 连线集合或来源名称变化后，重写提示词里的引用标记。
 *
 * BeefTV 用「@图片1 / @文本1」这类按连线顺序编号的标签，所以连线增减
 * 必须整体重编号；本项目的标记身份直接是画布节点 ID（等价于 @[node:xxx]），
 * 编号不会漂移，断线移除由 removePromptRefByNodeId 负责、复制重绑由
 * remapPromptRefTokens 负责，这里只需把显示名刷成来源节点的最新名称。
 * 来源节点已删除时保留标记，由 resolvePrompt 明确报失效，不静默伪装有效。
 */
export function refreshPromptRefLabels(
  prompt: string,
  refs: PromptRef[],
  nodes: CanvasNode[],
): { prompt: string; promptRefs: PromptRef[]; changed: boolean } {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const nextRefs = refs.map((r) => {
    const source = byId.get(r.nodeId);
    if (!source) return r;
    const label = promptRefLabelOf(source);
    return label === r.label ? r : { ...r, label };
  });
  const nextPrompt = prompt.replace(REF_TOKEN_RE, (token) => {
    // @[node:xxx] 是纯身份标记，没有显示名，不需要改写
    if (NODE_TOKEN_RE.test(token)) return token;
    const id = refTokenId(token);
    const source = id ? byId.get(id) : null;
    if (!source) return token;
    const hash = token.lastIndexOf('#');
    if (hash <= 0) return token;
    const fresh = `@[${promptRefLabelOf(source)}#${id}]`;
    return fresh === token ? token : fresh;
  });
  return {
    prompt: nextPrompt,
    promptRefs: nextRefs,
    changed: nextPrompt !== prompt || nextRefs.some((r, i) => r !== refs[i]),
  };
}

/** 复制节点时把提示词里的引用标记一起重绑到新节点，避免指向旧的来源 */
export function remapPromptRefTokens(prompt: string, nodeMap: Map<string, string>): string {
  return prompt.replace(REF_TOKEN_RE, (token) => {
    const id = refTokenId(token);
    const next = nodeMap.get(id);
    if (!next) return token;
    if (NODE_TOKEN_RE.test(token)) return `@[node:${next}]`;
    const hash = token.lastIndexOf('#');
    return hash > 0 ? `${token.slice(0, hash + 1)}${next}]` : token;
  });
}

/** 提示词里是否仍存在指向某节点的引用标记 */
export function hasRefToken(prompt: string, nodeId: string): boolean {
  return [...prompt.matchAll(REF_TOKEN_RE)].some((m) => refTokenId(m[0]) === nodeId
    || (m[0].startsWith('@[') && m[0].endsWith(`#${nodeId}]`)));
}

/**
 * 连线是引用的唯一来源：取目标节点所有入边里真正有内容的资源节点。
 * 对应 BeefTV 的 getContextResourceNodes。
 */
export function connectedResourceNodes(nodeId: string, nodes: CanvasNode[], edges: Edge[]): CanvasNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const result: CanvasNode[] = [];
  edges.filter((e) => e.to === nodeId).forEach((edge) => {
    const source = byId.get(edge.from);
    if (!source || seen.has(source.id) || !isResourceNode(source)) return;
    seen.add(source.id);
    result.push(source);
  });
  return result;
}

export interface InsertRefResult {
  prompt: string;
  promptRefs: PromptRef[];
  inserted: boolean;
  reason: string;
}

/** 引用：保存来源身份，重复操作不插入第二份 */
export function insertPromptRef(prompt: string, refs: PromptRef[], source: CanvasNode): InsertRefResult {
  if (refs.some((r) => r.nodeId === source.id)) {
    return { prompt, promptRefs: refs, inserted: false, reason: '该来源已经在提示词里被引用，没有重复插入' };
  }
  const ref: PromptRef = {
    id: shortRefId(refs),
    nodeId: source.id,
    label: promptRefLabelOf(source),
  };
  const token = refToken(ref);
  const next = prompt.trim() ? `${prompt.trimEnd()}\n${token}` : token;
  return { prompt: next, promptRefs: [...refs, ref], inserted: true, reason: `已插入引用标记 ${token}` };
}

/**
 * 在光标处用 @ 提及插入引用：把 [start, end) 的「@查询」替换成绑定标记。
 * 与 insertPromptRef 共用同一套去重规则，同一来源不会被引用两次。
 * 借鉴 BeefTV 的 canvas-resource-mention-textarea：候选来自画布节点，插入的是引用身份而非复制原文。
 */
export function insertPromptRefAt(
  prompt: string,
  refs: PromptRef[],
  source: CanvasNode | NodeReference,
  start: number,
  end: number,
): InsertRefResult & { caret: number } {
  const lo = Math.max(0, Math.min(start, prompt.length));
  const hi = Math.max(lo, Math.min(end, prompt.length));
  const base = prompt.slice(0, lo) + prompt.slice(hi);
  const existing = refs.find((r) => r.nodeId === source.id);
  if (existing) {
    return {
      prompt: base, promptRefs: refs, inserted: false, caret: lo,
      reason: `「${existing.label}」已经在提示词里被引用，没有重复插入`,
    };
  }
  const ref: PromptRef = {
    id: shortRefId(refs),
    nodeId: source.id,
    label: promptRefLabelOf(source),
  };
  const token = refToken(ref);
  return {
    prompt: `${base.slice(0, lo)}${token}${base.slice(lo)}`,
    promptRefs: [...refs, ref],
    inserted: true,
    caret: lo + token.length,
    reason: `已插入引用标记 ${token}`,
  };
}

/** 一次性复制原文：纯文本，不建立绑定 */
export function copySourceText(prompt: string, source: CanvasNode): string {
  const text = source.type === 'text' ? source.text : isMediaNode(source) ? (source.fileName || '') : '';
  if (!text.trim()) return prompt;
  return prompt.trim() ? `${prompt.trimEnd()}\n${text.trim()}` : text.trim();
}

/** 断开连线或删除来源时，把指向该节点的所有引用标记一并清掉 */
export function removePromptRefByNodeId(
  prompt: string,
  refs: PromptRef[],
  nodeId: string,
): { prompt: string; promptRefs: PromptRef[] } {
  const nextPrompt = prompt
    .replace(REF_TOKEN_RE, (token) => (refTokenId(token) === nodeId ? '' : token))
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { prompt: nextPrompt, promptRefs: refs.filter((r) => r.nodeId !== nodeId && r.id !== nodeId) };
}

export function removePromptRef(prompt: string, refs: PromptRef[], refId: string): { prompt: string; promptRefs: PromptRef[] } {
  const target = refs.find((r) => r.id === refId);
  return target ? removePromptRefByNodeId(prompt, refs, target.nodeId) : { prompt, promptRefs: refs };
}

export interface ResolvedPrompt {
  text: string;
  issues: string[];
  rows: { ref: PromptRef; node: CanvasNode | null; content: string }[];
}

/**
 * 预览 / 执行输入时按引用标记里的节点身份直接读取最新内容。
 * 与 BeefTV 一样，标记本身就是绑定，不需要额外一份映射表来维持关系；
 * 兼容旧项目的 `@[显示名#refId]` 与 BeefTV 的 `@[node:nodeId]`。
 */
export function resolvePrompt(prompt: string, refs: PromptRef[], nodes: CanvasNode[],
  mediaLabels?: Map<string, string>, attachments: NodeReference[] = []): ResolvedPrompt {
  const byNode = new Map(nodes.map((n) => [n.id, n]));
  const byAttachment = new Map(attachments.map(reference => [reference.id, reference]));
  const refByNode = new Map(refs.map((r) => [r.nodeId, r]));
  const refByShortId = new Map(refs.map((r) => [r.id, r]));
  const issues: string[] = [];
  const rows: ResolvedPrompt['rows'] = [];
  const used = new Set<string>();
  let unknownTokens = 0;
  const text = prompt.replace(REF_TOKEN_RE, (token) => {
    const id = refTokenId(token);
    if (!id) return token;
    // 优先按节点 ID 直接命中，旧格式再退回短 ID 映射
    const nodeId = byNode.has(id) || byAttachment.has(id) ? id : (refByShortId.get(id)?.nodeId ?? id);
    const node = byNode.get(nodeId) ?? null;
    const attachment = byAttachment.get(nodeId);
    const ref = refByNode.get(nodeId) ?? refByShortId.get(id) ?? { id: nodeId, nodeId, label: node?.name || attachment?.name || '来源' };
    if (attachment) {
      used.add(nodeId);
      const content = mediaLabels?.get(attachment.assetId) ?? attachment.name;
      rows.push({ ref, node: null, content });
      return content;
    }
    if (!node) {
      unknownTokens += 1;
      issues.push(`引用「${ref.label}」的来源已移除，请重新引用`);
      rows.push({ ref, node: null, content: '' });
      return `⚠[来源已删除：${ref.label}]`;
    }
    used.add(nodeId);
    const content = node.type === 'text'
      ? node.text
      : isMediaNode(node)
        ? (mediaLabels?.get(node.assetId) ?? (node.assetId ? (node.fileName || '（素材节点）') : '（节点还没有内容）'))
        : node.name;
    rows.push({ ref, node, content });
    return content;
  });
  if (unknownTokens) issues.push(`提示词里有 ${unknownTokens} 个无法识别的引用标记`);
  refs.forEach((ref) => {
    if (!used.has(ref.nodeId)) issues.push(`引用「${ref.label}」的标记已被手动删除，可从列表里移除该引用`);
  });
  return { text, issues, rows };
}

/* ==================== 统一参考输入 ==================== */
export interface ReferenceRow {
  key: string;
  origin: 'edge' | 'manual';
  kind: ReferenceKind;
  role: ReferenceRole | null;
  name: string;
  sourceLabel: string;
  assetId: string;
  nodeId?: string;
  edgeId?: string;
  refId?: string;
  ready: boolean;
  readiness: string;
  supported: boolean;
  issues: string[];
  duplicate: boolean;
}

function defaultRoleFor(kind: ReferenceKind, caps: ModelCapabilities | null): ReferenceRole {
  if (!caps?.roles.length) return kind === 'video' ? 'reference-video' : kind === 'audio' ? 'reference-audio' : 'reference-image';
  const want: Record<ReferenceKind, ReferenceRole> = {
    image: 'reference-image', video: 'reference-video', audio: 'reference-audio', text: 'reference-image',
  };
  return caps.roles.includes(want[kind]) ? want[kind] : caps.roles[0];
}

/**
 * 连线输入与素材库手选统一呈现；连线的输入完全由 edges 派生，
 * 断线 / 删除来源后自动消失，手选素材独立保留。
 */
export function resolveReferences(
  node: MediaNode,
  nodes: CanvasNode[],
  edges: Edge[],
  caps: ModelCapabilities | null,
  assets: AssetMeta[],
): { rows: ReferenceRow[]; textInputs: ReferenceRow[]; mediaInputs: ReferenceRow[] } {
  const p = (node.videoParams ?? node.imageParams) as GenParams | undefined;
  const byNode = new Map(nodes.map((n) => [n.id, n]));
  const assetById = new Map(assets.map((a) => [a.id, a]));
  const textInputs: ReferenceRow[] = [];
  const mediaInputs: ReferenceRow[] = [];

  edges.filter((e) => e.to === node.id).forEach((edge) => {
    const src = byNode.get(edge.from);
    if (!src) return;
    if (src.type === 'text') {
      textInputs.push({
        key: `edge:${edge.id}`, origin: 'edge', kind: 'text', role: null,
        name: src.name || '文字节点', sourceLabel: `连线输入 · ${src.name || '文字节点'}`,
        assetId: '', nodeId: src.id, edgeId: edge.id,
        ready: !!src.text.trim(), readiness: src.text.trim() ? '文本输入就绪' : '来源文本为空，未就绪',
        supported: true, issues: [], duplicate: false,
      });
      return;
    }
    if (!isMediaNode(src)) return;
    const kind = src.type;
    const asset = assetById.get(src.assetId);
    const role = p?.edgeRoles?.[edge.id] ?? defaultRoleFor(kind, caps);
    const issues: string[] = [];
    if (caps && !caps.roles.includes(role)) issues.push(`当前模型不支持「${ROLE_LABELS[role]}」用途`);
    if (ROLE_KINDS[role] !== kind) issues.push(`用途「${ROLE_LABELS[role]}」需要${ROLE_KINDS[role]}类型素材，来源却是${kind}`);
    mediaInputs.push({
      key: `edge:${edge.id}`, origin: 'edge', kind, role,
      name: src.name || src.fileName || '未命名节点',
      sourceLabel: `连线输入 · ${src.name || '未命名节点'}`,
      assetId: src.assetId, nodeId: src.id, edgeId: edge.id,
      ready: !!src.assetId && !!asset && issues.length === 0,
      readiness: !src.assetId ? '来源节点还没有素材，未就绪' : !asset ? '素材文件已移除，未就绪' : issues.length ? '用途不兼容' : '就绪',
      supported: issues.length === 0, issues, duplicate: false,
    });
  });

  (p?.references ?? []).forEach((ref) => {
    const asset = assetById.get(ref.assetId);
    const issues: string[] = [];
    if (!asset) issues.push('素材已从素材库移除');
    if (caps && !caps.roles.includes(ref.role)) issues.push(`当前模型不支持「${ROLE_LABELS[ref.role]}」用途`);
    if (ROLE_KINDS[ref.role] !== ref.kind) issues.push('素材类型与用途不匹配');
    mediaInputs.push({
      key: `manual:${ref.id}`, origin: 'manual', kind: ref.kind, role: ref.role,
      name: ref.name || asset?.name || '未命名素材',
      sourceLabel: `旧版手选 · ${asset?.name ?? ref.name}`,
      assetId: ref.assetId, refId: ref.id,
      ready: !!asset && issues.length === 0,
      readiness: !asset ? '素材已移除，未就绪' : issues.length ? issues[0] : '就绪',
      supported: issues.length === 0, issues, duplicate: false,
    });
  });

  // 去重：同一素材文件被连线与手选同时提供时，后者标记重复，不作为有效输入
  const seen = new Map<string, ReferenceRow>();
  mediaInputs.forEach((r) => {
    if (!r.assetId) return;
    const prev = seen.get(r.assetId);
    if (prev && !r.duplicate) { r.duplicate = true; r.issues = [...r.issues, '与另一条输入指向同一素材，已去重']; r.ready = false; r.readiness = '重复输入（已去重）'; }
    else seen.set(r.assetId, r);
  });

  const order = p?.refOrder ?? [];
  const rank = (r: ReferenceRow) => {
    const i = order.indexOf(r.key);
    return i < 0 ? 1000 + mediaInputs.indexOf(r) : i;
  };
  mediaInputs.sort((a, b) => rank(a) - rank(b));

  // 用途数量上限按模型能力校验
  if (caps) {
    const counts = new Map<ReferenceRole, number>();
    mediaInputs.forEach((r) => {
      if (!r.role || r.duplicate) return;
      const n = (counts.get(r.role) ?? 0) + 1;
      counts.set(r.role, n);
      const limit = caps.roleLimits[r.role] ?? Infinity;
      if (n > limit) { r.supported = false; r.ready = false; r.readiness = `超出「${ROLE_LABELS[r.role]}」上限 ${limit} 个`; r.issues.push(`超出用途数量上限 ${limit}`); }
    });
    const total = mediaInputs.filter((r) => !r.duplicate).length;
    if (caps.maxReferences > 0 && total > caps.maxReferences) {
      mediaInputs.forEach((r) => { if (!r.duplicate) r.issues.push(`参考素材合计超过模型上限 ${caps.maxReferences} 个`); });
    }
    const frameRoles = mediaInputs.some((r) => r.role === 'first-frame' || r.role === 'last-frame');
    const refRoles = mediaInputs.some((r) => r.role === 'reference-image' || r.role === 'reference-video' || r.role === 'reference-audio');
    if (frameRoles && refRoles) {
      mediaInputs.forEach((r) => { if (!r.duplicate) r.issues.push('首尾帧不能与参考素材混用（H3 文档限制）'); });
    }
  }

  return { rows: [...textInputs, ...mediaInputs], textInputs, mediaInputs };
}

export function h3ReferenceLabels(rows: ReferenceRow[]): Map<string, string> {
  const labels = new Map<string, string>();
  const counts = { image: 0, video: 0, audio: 0 };
  const tokens = { image: 'Picture', video: 'Video', audio: 'Audio' };
  for (const row of rows) {
    if (!row.assetId || row.duplicate || row.kind === 'text') continue;
    const label = row.role === 'first-frame' ? '首帧' : row.role === 'last-frame' ? '尾帧'
      : `<${tokens[row.kind]} ${++counts[row.kind]}>`;
    labels.set(row.assetId, label);
  }
  return labels;
}

export function imageReferenceLabels(rows: ReferenceRow[]): Map<string, string> {
  return new Map(rows.filter(row => row.assetId && row.kind === 'image' && !row.duplicate)
    .map((row, index) => [row.assetId, `图 ${index + 1}`]));
}

/* ==================== 按协议读取模型列表 / 验证连接 ==================== */
function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`;
}

function authHeaders(service: ModelService): Record<string, string> {
  const spec = protocolSpec(service.protocol);
  if (service.protocol === 'anthropic') {
    return { 'x-api-key': service.apiKey.trim(), 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' };
  }
  if (service.protocol === 'custom') return { 'Content-Type': 'application/json' };
  return { Authorization: `Bearer ${service.apiKey.trim()}`, 'Content-Type': 'application/json', ...(spec.id === 'compshare-image' ? { Accept: 'application/json' } : {}) };
}

async function fetchJson(url: string, headers: Record<string, string>, timeout = 8000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await modelFetch(url, { headers, signal: controller.signal });
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 160);
      try { const j = JSON.parse(text) as { error?: { message?: string } | string; Message?: string }; detail = (typeof j.error === 'string' ? j.error : j.error?.message) || j.Message || detail; } catch { /* 保留原文 */ }
      throw new Error(`HTTP ${res.status}${detail ? ` · ${detail}` : ''}`);
    }
    try { return JSON.parse(text) as unknown; } catch { throw new Error('接口返回的不是 JSON，请检查地址与协议'); }
  } finally {
    clearTimeout(timer);
  }
}

export interface RemoteModel { id: string; name?: string }

/** 读取模型列表：按服务真实协议执行，不支持的协议明确拒绝而不是硬请求 /models */
export async function listRemoteModels(service: ModelService): Promise<{ models: RemoteModel[]; endpoint: string; error?: string }> {
  const spec = protocolSpec(service.protocol);
  if (!spec.supportsListModels || !spec.listEndpoint) {
    return { models: [], endpoint: '', error: spec.noListReason };
  }
  if (!service.baseUrl.trim()) return { models: [], endpoint: '', error: '请先填写接口地址' };
  const url = joinUrl(service.baseUrl, spec.listEndpoint);
  try {
    const data = await fetchJson(url, authHeaders(service)) as { data?: { id?: string; display_name?: string; name?: string }[] };
    const models = (Array.isArray(data?.data) ? data.data : [])
      .map((m) => ({ id: String(m.id ?? ''), name: m.display_name || m.name }))
      .filter((m) => !!m.id);
    return { models, endpoint: url };
  } catch (err) {
    return { models: [], endpoint: url, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 连接测试：按协议走文档定义的端点；custom 不猜测接口 */
export async function testServiceConnection(service: ModelService): Promise<ConnectionState> {
  const spec = protocolSpec(service.protocol);
  if (service.baseUrl.replace(/\/+$/, '') === 'https://api.minimax.cn/v1' && service.models.some(model => model.id === 'MiniMax-H3-Image')) {
    return { status: 'unverified', checkedAt: Date.now(), endpoint: '', message: 'MiniMax 官方图片接口尚无已确认的免费验证方式，请通过生成图片验证。' };
  }
  if (!spec.testEndpoint) {
    return {
      status: 'unverified', checkedAt: Date.now(), endpoint: '',
      message: `${spec.label}未适配自动验证接口，需按自己的服务协议手动确认连通性`,
    };
  }
  if (!service.baseUrl.trim() || !service.apiKey.trim()) {
    return { status: 'failed', checkedAt: Date.now(), endpoint: '', message: '接口地址或凭据未填写，无法验证' };
  }
  const url = joinUrl(service.baseUrl, spec.testEndpoint);
  try {
    const data = await fetchJson(url, authHeaders(service)) as Record<string, unknown>;
    let message = `${spec.testLabel}成功`;
    if (service.protocol === 'openai' || service.protocol === 'anthropic') {
      const count = Array.isArray(data?.data) ? (data.data as unknown[]).length : 0;
      message = `接口返回 ${count} 个模型`;
    } else if (service.protocol === 'compshare-h3') {
      message = `积分余额接口正常，available_points=${String(data?.available_points ?? '未知')}`;
    } else if (service.protocol === 'compshare-image') {
      if (data?.available !== true) throw new Error(String(data?.unavailable_reason || '当前生图服务不可用'));
      const imageResolutions = qwenImageResolutions(data.prices);
      message = imageResolutions.length ? `生图服务可用 · ${imageResolutions.join(' / ')}` : '生图服务可用';
      return { status: 'ok', checkedAt: Date.now(), endpoint: url, message, imageResolutions };
    }
    return { status: 'ok', checkedAt: Date.now(), endpoint: url, message };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: 'failed', checkedAt: Date.now(), endpoint: url,
      message: `连接验证失败（${msg}）`,
    };
  }
}

/* ==================== 文本对话验证（创作助手用的渠道） ==================== */

export interface ChatCheckResult { ok: boolean; endpoint: string; message: string }

/**
 * 按协议规格里显式声明的 chat 端点发起一次极小的真实对话，确认这个文本模型
 * 确实能被创作助手调用。只在用户点击验证时执行，绝不自动发起。
 * /models 能列出模型不等于 /chat/completions 可用，两者分开验证。
 */
export async function verifyTextChat(service: ModelService, modelId: string): Promise<ChatCheckResult> {
  const spec = protocolSpec(service.protocol);
  if (!spec.chatEndpoint) {
    return { ok: false, endpoint: '', message: `${spec.label}没有适配文本对话端点，助手不会假定存在该接口` };
  }
  if (!service.baseUrl.trim() || !service.apiKey.trim()) {
    return { ok: false, endpoint: '', message: '接口地址或凭据未填写，无法验证文本对话' };
  }
  const url = joinUrl(service.baseUrl, spec.chatEndpoint);
  try {
    const res = await modelFetch(url, {
      method: 'POST',
      headers: authHeaders(service),
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: '请只回复 ok 两个字符' }],
        max_tokens: 8,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) {
      return { ok: false, endpoint: url, message: `对话请求返回 HTTP ${res.status}，凭据或模型可能不可用` };
    }
    const data = await res.json() as { choices?: { message?: { content?: string } }[] };
    const reply = data.choices?.[0]?.message?.content;
    if (typeof reply !== 'string') {
      return { ok: false, endpoint: url, message: '返回里没有 choices[0].message.content，无法确认对话可用' };
    }
    return { ok: true, endpoint: url, message: `文本对话正常，模型 ${modelId} 回复「${reply.trim().slice(0, 20)}」` };
  } catch (err) {
    return {
      ok: false, endpoint: url,
      message: `文本对话验证失败（${err instanceof Error ? err.message : String(err)}）。若浏览器跨域被拦截，属正常现象。`,
    };
  }
}
