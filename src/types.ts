export type NodeType = 'text' | 'image' | 'video' | 'audio' | 'group';
export type AssetKind = 'image' | 'video' | 'audio';
export type EdgeKind = 'text-input' | 'image-ref' | 'link';

/* ==================== 全局模型管理 ==================== */
export type ModelType = 'image' | 'video' | 'text' | 'audio';

/** 接口协议：决定鉴权头、模型列表接口、连接测试接口 */
export type ServiceProtocol = 'openai' | 'anthropic' | 'compshare-h3' | 'compshare-image' | 'custom';

/** 参考素材用途，取值与 H3 文档 role 一一对应 */
export type ReferenceRole = 'first-frame' | 'last-frame' | 'reference-image' | 'reference-video' | 'reference-audio';
export type ReferenceKind = AssetKind | 'text';

export interface AdvancedFieldSpec {
  key: string;
  label: string;
  kind: 'boolean' | 'text';
  hint: string;
  defaultValue: boolean | string;
}

export interface AudioOption { id: string; label: string }

/**
 * 能力必须来自真实接口文档 / 适配规则，显式写在模型上。
 * 禁止根据模型名称推断能力。
 */
export interface ModelCapabilities {
  ratios: string[];
  resolutions: string[];
  durations: number[];
  audioOptions: AudioOption[];
  maxCount: number;
  roles: ReferenceRole[];
  roleLimits: Partial<Record<ReferenceRole, number>>;
  maxReferences: number;
  advancedFields: AdvancedFieldSpec[];
  /** 能力依据（文档名称 / URL），界面如实展示 */
  source: string;
  note: string;
}

export interface ServiceModel {
  /** 实际请求用的模型 ID / 名称 */
  id: string;
  /** 显示名称 */
  name: string;
  type: ModelType;
  enabled: boolean;
  capabilities: ModelCapabilities;
}

export interface ConnectionState {
  status: 'unverified' | 'ok' | 'failed';
  checkedAt: number;
  message: string;
  /** 实际请求的完整地址，便于核对「按协议执行」 */
  endpoint: string;
  imageResolutions?: ('1K' | '2K')[];
}

export interface ModelService {
  id: string;
  name: string;
  protocol: ServiceProtocol;
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
  models: ServiceModel[];
  connection: ConnectionState;
  note: string;
  createdAt: number;
}

export interface LegacyModelConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

/* ==================== 本地创作技能 ====================
 * 对齐 BeefTV Skills 的定位：技能是给助手用的方法、步骤与要求，
 * 文件只保存在本机，不需要技能市场或云端账号。
 * 内置技能不可删除，只能停用；用户可导入、复制改写、导出。
 */
export type SkillRequirement = 'none' | 'text-model' | 'image-model' | 'video-model';

export interface CanvasSkill {
  id: string;
  name: string;
  description: string;
  /** 适用对象：某类节点、整个画布或任意 */
  appliesTo: ModelType | 'canvas' | 'any';
  /** 执行所需能力，文字技能不需要多模态模型 */
  requires: SkillRequirement;
  /** 技能正文：方法、步骤、要求 */
  body: string;
  /** 本地方案模板，{goal} 会替换成创作目标 */
  template: string;
  enabled: boolean;
  builtin: boolean;
  version: string;
  origin: string;
  createdAt: number;
  updatedAt: number;
}

/* ==================== 工作台整体配置 ====================
 * 所有需要外部服务、凭据、端点、单价、品牌与能力开关的地方都留成可配置项。
 * 默认值一律是「本机可用」，不预置任何第三方产品名或外链。
 */
export type CanvasTheme = 'follow' | 'light' | 'dark' | 'custom';
export type GridStyle = 'dots' | 'lines' | 'blank';

export interface AppearanceConfig {
  theme: CanvasTheme;
  grid: GridStyle;
  background: string;
  brightness: number;
  gridColor: string;
  gridStrength: number;
  savedAsDefault: boolean;
}

export interface WorkspaceConfig {
  appName: string;
  tagline: string;
  starter: 'ask' | 'blank' | 'storyboard';
  storageQuotaMB: number;
  snapshotIntervalMin: number;
  snapshotLimit: number;
}

export interface PricingRule {
  id: string;
  label: string;
  unit: 'second' | 'image' | 'token' | 'flat';
  price: number;
  currency: string;
  note: string;
}

export interface GenerationConfig {
  /** 真实生成执行默认关闭；所有接口只保留配置，不伪装成已接入 */
  enabled: boolean;
  endpoint: string;
  protocol: string;
  submitPath: string;
  statusPath: string;
  timeoutSec: number;
  maxConcurrent: number;
  requireConfirmation: boolean;
  showCostEstimate: boolean;
  pricing: PricingRule[];
}

export interface AgentConfig {
  showThinking: boolean;
  autoRunSkillScripts: boolean;
  scriptTimeoutSec: number;
  readOnlyExternal: boolean;
  idempotencyRequired: boolean;
  maxSteps: number;
}

export interface PluginEntry {
  id: string;
  name: string;
  kind: 'interface' | 'app' | 'skill';
  version: string;
  enabled: boolean;
  source: string;
  risk: 'official' | 'user';
  manifest: Record<string, unknown>;
}

export interface ExternalAgentConnection {
  id: string;
  label: string;
  mode: 'read-write' | 'read-only';
  endpoint: string;
  clientId: string;
  tokenHint: string;
  enabled: boolean;
  createdAt: number;
}

export interface FeatureFlags {
  autoLink: boolean;
  hoverPreview: boolean;
  batchTable: boolean;
  upscaleNode: boolean;
  chapterExtract: boolean;
  promptOptimizer: boolean;
  versionHistory: boolean;
  diagnostics: boolean;
  timeline: boolean;
  workflows: boolean;
  pluginCenter: boolean;
  externalAgents: boolean;
  costEstimate: boolean;
  gridSplit: boolean;
  multiAngle: boolean;
  storageMeter: boolean;
  promptTemplates: boolean;
  promptExpander: boolean;
  selectionToolbar: boolean;
  mediaPreview: boolean;
}

export interface PromptPrefs {
  followOfficial: boolean;
  append: string;
  protectedContract: string;
}

export interface WorkbenchConfig {
  appearance: AppearanceConfig;
  workspace: WorkspaceConfig;
  generation: GenerationConfig;
  agentConfig: AgentConfig;
  plugins: PluginEntry[];
  externalAgents: ExternalAgentConnection[];
  features: FeatureFlags;
  promptPrefs: PromptPrefs;
}

export interface AppSettings {
  services: ModelService[];
  /** 各类型默认模型，值为 modelKey = `${serviceId}::${modelId}` */
  defaults: Partial<Record<ModelType, string>>;
  assistantSource?: 'codex' | 'api';
  /** 旧版单模型配置迁移保留，不参与任何节点状态判定 */
  legacy: LegacyModelConfig | null;
  /** 本机技能库，内置技能在读取设置时补齐 */
  skills: CanvasSkill[];
  /** 工作台整体配置，缺字段由 normalizeWorkbench 补齐，旧项目数据兼容 */
  workbench?: Partial<WorkbenchConfig>;
  showGrid: boolean;
  snapToGrid: boolean;
  wheelZoom: boolean;
}

/* ==================== 节点创作参数 ==================== */
/** 提示词引用：保存来源节点或当前节点的参考素材身份 */
export interface PromptRef {
  /** 标记里的短 ID */
  id: string;
  nodeId: string;
  /** 插入时的展示名快照，实际内容按来源身份解析 */
  label: string;
}

/** 用户从素材库独立手选的参考素材 */
export interface NodeReference {
  id: string;
  assetId: string;
  kind: AssetKind;
  name: string;
  role: ReferenceRole;
}

export interface GenParamsBase {
  prompt: string;
  promptRefs: PromptRef[];
  references: NodeReference[];
  /** 每条连线输入指定的用途，key = edgeId */
  edgeRoles: Record<string, ReferenceRole>;
  /** 参考列表顺序，key = `edge:<edgeId>` / `manual:<refId>` */
  refOrder: string[];
  modelKey: string;
  aspectRatio: string;
  resolution: string;
  advanced: Record<string, boolean | string>;
  /** 旧项目遗留字段，仅用于迁移展示 */
  legacyModel?: string;
}

export interface ImageGenParams extends GenParamsBase {
  count: number;
}

export interface VideoGenParams extends GenParamsBase {
  duration: number;
  audio: string;
}

export type GenParams = ImageGenParams | VideoGenParams;

/* ==================== 画布节点 ==================== */
/**
 * 媒体节点的交互角色，借鉴 BeefTV 的 CanvasMediaNodeRole：
 * generator 拥有提示词/模型/生成控制，result 是可被连线和引用的素材对象。
 */
export type MediaNodeRole = 'generator' | 'result';
/** 素材进入画布的来源，仅 result 有意义 */
export type MediaResultOrigin = 'upload' | 'library' | 'generated' | 'derived' | 'imported' | 'unknown';

export interface BaseNode {
  id: string;
  type: NodeType;
  /**
   * 节点变体（注册表 ID）。持久化类型仍是 type，变体只描述「这一类节点里
   * 具体是哪一种」，对应 BeefTV 的 type + metadata.workflowKind 组合。
   * 旧项目没有这个字段，由 nodeRegistry.variantOf() 按内容推导，不改原有数据。
   */
  variant?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  name: string;
}

export interface TextNode extends BaseNode {
  type: 'text';
  text: string;
  fontSize: number;
  color: string;
  bg: string;
  bold: boolean;
  align: 'left' | 'center' | 'right';
}

export interface MediaNode extends BaseNode {
  type: 'image' | 'video' | 'audio';
  assetId: string;
  fileName: string;
  /** Results from the most recent batch; assetId is the currently displayed item. */
  resultAssetIds?: string[];
  /** The current prompt or parameters changed after the visible result was generated. */
  resultStale?: boolean;
  resultInputSnapshot?: string;
  fit: 'contain' | 'cover';
  /** 显式语义优先；旧项目由 normalizeNode 按「有没有素材」推导 */
  nodeRole?: MediaNodeRole;
  resultOrigin?: MediaResultOrigin;
  /** 由哪个生成节点产出，用于追溯 */
  generatedFromNodeId?: string;
  imageParams?: ImageGenParams;
  videoParams?: VideoGenParams;
  audioModelKey?: string;
}

export interface GroupNode extends BaseNode {
  type: 'group';
  name: string;
  color: string;
}

export type CanvasNode = TextNode | MediaNode | GroupNode;

export interface Edge {
  id: string;
  from: string;
  to: string;
  label: string;
  color: string;
  kind: EdgeKind;
}

export interface Viewport { x: number; y: number; zoom: number }

export interface ProjectData { nodes: CanvasNode[]; edges: Edge[]; viewport: Viewport }

export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  data: ProjectData;
}

export interface ProjectSummary {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  nodeCount: number;
}

export interface AssetMeta {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: AssetKind;
  createdAt: number;
}

export interface AssetRecord { meta: AssetMeta; blob: Blob }

export interface Snapshot { nodes: CanvasNode[]; edges: Edge[] }

/* ==================== 默认值与迁移 ==================== */
export const EMPTY_CAPABILITIES: ModelCapabilities = {
  ratios: [], resolutions: [], durations: [], audioOptions: [], maxCount: 1,
  roles: [], roleLimits: {}, maxReferences: 0, advancedFields: [],
  source: '未填写能力来源', note: '能力未确认，请按接口文档补全后再使用。',
};

export function emptyGenParams(): GenParamsBase {
  return {
    prompt: '', promptRefs: [], references: [], edgeRoles: {}, refOrder: [],
    modelKey: '', aspectRatio: '', resolution: '', advanced: {},
  };
}

export const DEFAULT_IMAGE_PARAMS: ImageGenParams = { ...emptyGenParams(), count: 1 };
export const DEFAULT_VIDEO_PARAMS: VideoGenParams = { ...emptyGenParams(), duration: 5, audio: '' };

export const DEFAULT_SETTINGS: AppSettings = {
  services: [],
  defaults: {},
  legacy: null,
  skills: [],
  workbench: {},
  showGrid: true,
  snapToGrid: false,
  wheelZoom: true,
};

/** 兼容旧版设置：凭据原样保留到 legacy，不伪装成已启用的服务 */
export function normalizeSettings(raw: unknown): AppSettings {
  const src = (raw ?? {}) as Partial<AppSettings> & { model?: Partial<LegacyModelConfig> };
  const services = Array.isArray(src.services) ? src.services.map(normalizeService) : [];
  let legacy: LegacyModelConfig | null = null;
  if (src.legacy) {
    legacy = {
      baseUrl: String(src.legacy.baseUrl ?? ''),
      apiKey: String(src.legacy.apiKey ?? ''),
      model: String(src.legacy.model ?? ''),
      temperature: Number(src.legacy.temperature ?? 0.7),
      maxTokens: Number(src.legacy.maxTokens ?? 2048),
    };
  } else if (src.model && (src.model.baseUrl || src.model.apiKey || src.model.model)) {
    legacy = {
      baseUrl: String(src.model.baseUrl ?? ''),
      apiKey: String(src.model.apiKey ?? ''),
      model: String(src.model.model ?? ''),
      temperature: Number(src.model.temperature ?? 0.7),
      maxTokens: Number(src.model.maxTokens ?? 2048),
    };
  }
  return {
    services,
    defaults: { ...(src.defaults ?? {}) },
    ...(src.assistantSource === 'codex' || src.assistantSource === 'api' ? { assistantSource: src.assistantSource } : {}),
    legacy,
    skills: Array.isArray(src.skills) ? src.skills.filter((s) => !!s && typeof s.id === 'string').map(normalizeSkill) : [],
    workbench: (src.workbench && typeof src.workbench === 'object' ? src.workbench : {}) as Partial<WorkbenchConfig>,
    showGrid: src.showGrid ?? true,
    snapToGrid: src.snapToGrid ?? false,
    wheelZoom: src.wheelZoom ?? true,
  };
}

/** 兼容旧项目 / 外部导入的技能数据，缺字段一律给安全默认值 */
export function normalizeSkill(raw: CanvasSkill): CanvasSkill {
  const now = Date.now();
  return {
    id: String(raw.id || `skill-${now}`),
    name: String(raw.name || '未命名技能'),
    description: String(raw.description || ''),
    appliesTo: raw.appliesTo || 'any',
    requires: raw.requires || 'none',
    body: String(raw.body || ''),
    template: String(raw.template || ''),
    enabled: raw.enabled !== false,
    builtin: !!raw.builtin,
    version: String(raw.version || '1.0.0'),
    origin: String(raw.origin || '本机导入'),
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : now,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : now,
  };
}

export function normalizeService(raw: ModelService): ModelService {
  return {
    id: raw.id,
    name: raw.name || '未命名服务',
    protocol: raw.protocol || 'custom',
    baseUrl: raw.baseUrl || '',
    apiKey: raw.apiKey || '',
    enabled: raw.enabled !== false,
    note: raw.note || '',
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
    models: Array.isArray(raw.models) ? raw.models.map(normalizeServiceModel) : [],
    connection: {
      status: raw.connection?.status ?? 'unverified',
      checkedAt: raw.connection?.checkedAt ?? 0,
      message: raw.connection?.message ?? '尚未验证连接',
      endpoint: raw.connection?.endpoint ?? '',
      ...(Array.isArray(raw.connection?.imageResolutions) ? {
        imageResolutions: raw.connection.imageResolutions.filter(tier => tier === '1K' || tier === '2K'),
      } : {}),
    },
  };
}

export function normalizeServiceModel(raw: ServiceModel): ServiceModel {
  const c = { ...EMPTY_CAPABILITIES, ...(raw.capabilities ?? {}) };
  return {
    id: raw.id,
    name: raw.name || raw.id,
    type: raw.type || 'text',
    enabled: raw.enabled !== false,
    capabilities: {
      ...c,
      ratios: Array.isArray(c.ratios) ? c.ratios : [],
      resolutions: Array.isArray(c.resolutions) ? c.resolutions : [],
      durations: Array.isArray(c.durations) ? c.durations : [],
      audioOptions: Array.isArray(c.audioOptions) ? c.audioOptions : [],
      roles: Array.isArray(c.roles) ? c.roles : [],
      roleLimits: c.roleLimits ?? {},
      advancedFields: Array.isArray(c.advancedFields) ? c.advancedFields : [],
    },
  };
}

export const EMPTY_DATA: ProjectData = { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };

export const NODE_DEFAULTS: Record<NodeType, { w: number; h: number }> = {
  text: { w: 260, h: 150 },
  image: { w: 300, h: 230 },
  video: { w: 360, h: 260 },
  audio: { w: 300, h: 130 },
  group: { w: 480, h: 340 },
};

export const TYPE_LABELS: Record<NodeType, string> = {
  text: '文字', image: '图片', video: '视频', audio: '音频', group: '分组',
};

export const MODEL_TYPE_LABELS: Record<ModelType, string> = {
  image: '图片', video: '视频', text: '文本', audio: '音频',
};

export const ROLE_LABELS: Record<ReferenceRole, string> = {
  'first-frame': '首帧',
  'last-frame': '尾帧',
  'reference-image': '参考图片',
  'reference-video': '参考视频',
  'reference-audio': '参考音频',
};

export const ROLE_KINDS: Record<ReferenceRole, AssetKind> = {
  'first-frame': 'image',
  'last-frame': 'image',
  'reference-image': 'image',
  'reference-video': 'video',
  'reference-audio': 'audio',
};

/** 与 H3 文档 content[].role 的对应 */
export const ROLE_API_VALUE: Record<ReferenceRole, string> = {
  'first-frame': 'first_frame',
  'last-frame': 'last_frame',
  'reference-image': 'reference_image',
  'reference-video': 'reference_video',
  'reference-audio': 'reference_audio',
};

export function isMediaNode(n: CanvasNode): n is MediaNode {
  return n.type === 'image' || n.type === 'video' || n.type === 'audio';
}

export function isGeneratableNode(n: CanvasNode): n is MediaNode {
  return n.type === 'image' || n.type === 'video';
}

export function isEmptyMediaNode(n: CanvasNode): boolean {
  return (n.type === 'image' || n.type === 'video' || n.type === 'audio') && !(n as MediaNode).assetId;
}

export function inferEdgeKind(from: CanvasNode | undefined, to: CanvasNode | undefined): EdgeKind {
  if (!from || !to) return 'link';
  if (from.type === 'text' && (to.type === 'image' || to.type === 'video')) return 'text-input';
  if (isMediaNode(from) && (to.type === 'video' || to.type === 'image')) return 'image-ref';
  return 'link';
}

export function edgeKindLabel(kind: EdgeKind): string {
  if (kind === 'text-input') return '提示词输入';
  if (kind === 'image-ref') return '参考素材';
  return '';
}

export function nodeDisplayName(n: CanvasNode): string {
  if (n.name) return n.name;
  if (n.type === 'text') return (n.text || '').trim().slice(0, 12) || '文字节点';
  if (isMediaNode(n)) return n.fileName || `空${TYPE_LABELS[n.type]}节点`;
  return '分组';
}

interface LegacyGenParams extends Partial<GenParamsBase> {
  model?: string;
  referenceAssetIds?: string[];
}

function normalizeGenParams(raw: unknown): GenParamsBase {
  const src = (raw ?? {}) as LegacyGenParams;
  const legacyModel = typeof src.model === 'string' ? src.model : undefined;
  // 旧版参考素材：只存了 assetId 列表，迁移为「手选 · 参考图片」
  const oldRefs = Array.isArray(src.referenceAssetIds) ? src.referenceAssetIds : [];
  const references: NodeReference[] = Array.isArray(src.references)
    ? src.references.map((r) => ({
        id: r.id || `legacy-${r.assetId}`,
        assetId: r.assetId,
        kind: r.kind || 'image',
        name: r.name || r.assetId,
        role: r.role || 'reference-image',
      }))
    : oldRefs.map((assetId, i) => ({
        id: `legacy-${i}-${assetId}`, assetId, kind: 'image' as AssetKind,
        name: assetId, role: 'reference-image' as ReferenceRole,
      }));
  return {
    ...emptyGenParams(),
    prompt: typeof src.prompt === 'string' ? src.prompt : '',
    promptRefs: Array.isArray(src.promptRefs) ? src.promptRefs : [],
    references,
    edgeRoles: src.edgeRoles && typeof src.edgeRoles === 'object' ? { ...src.edgeRoles } : {},
    refOrder: Array.isArray(src.refOrder) ? [...src.refOrder] : [],
    // 旧节点只写了模型 ID，无法还原「服务 + 模型」绑定，一律标记为未绑定
    modelKey: typeof src.modelKey === 'string' ? src.modelKey : '',
    aspectRatio: typeof src.aspectRatio === 'string' ? src.aspectRatio : '',
    resolution: typeof src.resolution === 'string' ? src.resolution : '',
    advanced: src.advanced && typeof src.advanced === 'object' ? { ...src.advanced } : {},
    legacyModel: legacyModel || (typeof src.legacyModel === 'string' ? src.legacyModel : undefined),
  };
}

/** 兼容旧项目数据：补齐新增字段，旧模型名单明确标成「未绑定」 */
export function normalizeNode(raw: CanvasNode): CanvasNode {
  const n = { ...raw } as CanvasNode & Record<string, unknown>;
  if (!n.name) n.name = nodeDisplayName(raw);
  if (!Number.isFinite(n.z)) n.z = 0;
  if (raw.type === 'text') {
    const t = n as unknown as TextNode;
    t.fontSize = Number.isFinite(t.fontSize) ? t.fontSize : 18;
    t.color = t.color || '#1e293b';
    t.bg = t.bg || '#ffffff';
    t.bold = !!t.bold;
    t.align = t.align || 'left';
    t.text = t.text || '';
  }
  if (isMediaNode(raw)) {
    const m = n as unknown as MediaNode;
    m.assetId = m.assetId || '';
    m.fileName = m.fileName || '';
    m.fit = m.fit || 'contain';
    if (m.type === 'audio' && typeof m.audioModelKey !== 'string') m.audioModelKey = 'builtin:indextts';
    // 旧项目兼容：nodeRole / resultOrigin 只是只读来源标注，不决定节点能不能设参数。
    // 新项目不再写 nodeRole；有内容但缺来源的旧数据补一个保守标注。
    if (!m.resultOrigin && m.assetId) m.resultOrigin = 'upload';
    if (m.type === 'image') {
      m.imageParams = { ...normalizeGenParams(m.imageParams), count: (m.imageParams?.count ?? 1) };
    }
    if (m.type === 'video') {
      m.videoParams = {
        ...normalizeGenParams(m.videoParams),
        duration: m.videoParams?.duration ?? 5,
        audio: m.videoParams?.audio ?? '',
      };
    }
  }
  if (raw.type === 'group') {
    const g = n as unknown as GroupNode;
    g.color = g.color || '#8b5cf6';
    g.name = g.name || '新建分组';
  }
  return n as CanvasNode;
}

export function normalizeNodes(nodes: CanvasNode[]): CanvasNode[] { return nodes.map(normalizeNode); }

export function normalizeEdge(raw: Edge, from: CanvasNode | undefined, to: CanvasNode | undefined): Edge {
  const kind = raw.kind || inferEdgeKind(from, to);
  return {
    ...raw,
    kind,
    color: raw.color || (kind === 'text-input' ? '#2563eb' : kind === 'image-ref' ? '#8b5cf6' : '#94a3b8'),
    label: raw.label || edgeKindLabel(kind),
  };
}
