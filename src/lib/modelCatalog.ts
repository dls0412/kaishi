import {
  EMPTY_CAPABILITIES,
  type ModelCapabilities,
  type ModelService,
  type ModelType,
  type ServiceModel,
  type ServiceProtocol,
} from '../types';

export function suggestedTemplate(protocol: ServiceProtocol, type: ModelType): string {
  if (type === 'text') return 'text-only';
  if (protocol === 'compshare-h3' && type === 'video') return 'h3-video';
  if (protocol === 'compshare-image' && type === 'image') return 'qwen-image';
  if (protocol === 'openai' && type === 'image') return 'openai-image';
  if (protocol === 'openai' && type === 'video') return 'openai-video';
  return 'custom';
}

/* ==================== 协议规格 ====================
 * 每个协议只声明其真实公开文档定义的接口路径。
 * 不允许把所有渠道都当成 /models。
 */
export interface ProtocolSpec {
  id: ServiceProtocol;
  label: string;
  baseUrlHint: string;
  authHint: string;
  keyHint: string;
  supportsListModels: boolean;
  listEndpoint: string | null;
  testEndpoint: string | null;
  testLabel: string;
  /** 文本对话端点。只有显式声明且格式与 OpenAI chat/completions 一致时，助手才会调用它 */
  chatEndpoint: string | null;
  chatLabel: string;
  docUrl: string;
  note: string;
  noListReason: string;
}

export const PROTOCOLS: ProtocolSpec[] = [
  {
    id: 'openai',
    label: 'OpenAI 兼容',
    baseUrlHint: 'https://api.openai.com/v1',
    authHint: 'Authorization: Bearer <API Key>',
    keyHint: 'sk-...',
    supportsListModels: true,
    listEndpoint: '/models',
    testEndpoint: '/models',
    testLabel: '读取 /models 验证',
    chatEndpoint: '/chat/completions',
    chatLabel: '验证文本对话',
    docUrl: 'https://platform.openai.com/docs/api-reference/models',
    note: '按 OpenAI 兼容协议请求 /models，返回 data[].id。文本对话走 /chat/completions，供创作助手生成结构化方案。',
    noListReason: '',
  },
  {
    id: 'anthropic',
    label: 'Anthropic 兼容',
    baseUrlHint: 'https://api.anthropic.com/v1',
    authHint: 'x-api-key + anthropic-version',
    keyHint: 'sk-ant-...',
    supportsListModels: true,
    listEndpoint: '/models',
    testEndpoint: '/models',
    testLabel: '读取 /models 验证',
    chatEndpoint: null,
    chatLabel: '未适配文本对话',
    docUrl: 'https://docs.anthropic.com/en/api/models-list',
    note: '使用 x-api-key 与 anthropic-version: 2023-06-01，不使用 Bearer。/messages 的请求格式与 OpenAI 不同，助手不猜测协议，暂不接入文本对话。',
    noListReason: '',
  },
  {
    id: 'compshare-h3',
    label: '共绩算力 · MiniMax H3 视频',
    baseUrlHint: 'https://cp.compshare.cn',
    authHint: 'Authorization: Bearer <sk-ml-...>',
    keyHint: 'sk-ml-...（视频工作台创建）',
    supportsListModels: false,
    listEndpoint: null,
    testEndpoint: '/minimax/v2/query/point_usage_summary',
    testLabel: '查询积分余额验证',
    chatEndpoint: null,
    chatLabel: '该协议是视频任务，无文本对话',
    docUrl: 'https://www.compshare.cn/docs/minimax-h3/api/minimax-h3-video-api',
    note: '文档定义的 10 个接口中没有模型列表接口；model 固定为 MiniMax-H3 / minimax-h3-lite。连接验证走只读的积分余额接口。',
    noListReason: '该协议没有模型列表接口，请按公开文档手动添加 MiniMax-H3 / minimax-h3-lite，或使用文档预设。',
  },
  {
    id: 'compshare-image',
    label: '共绩算力 · Qwen-Image 图片',
    baseUrlHint: 'https://cp.compshare.cn',
    authHint: 'Authorization: Bearer <sk-ml-...>',
    keyHint: 'sk-ml-...（与 H3 同一模块 Key）',
    supportsListModels: false,
    listEndpoint: null,
    testEndpoint: '/image/v1/config',
    testLabel: '查询服务配置验证',
    chatEndpoint: null,
    chatLabel: '该协议是图片生成，无文本对话',
    docUrl: 'https://www.compshare.cn/docs/minimax-h3/api/qwen-image-api',
    note: '该接口没有 model 字段，也没有模型列表接口；每次请求输出 1 张 PNG。连接验证走只读 /image/v1/config。',
    noListReason: '该协议没有模型列表接口与 model 字段，服务即模型。请手动添加或使用文档预设。',
  },
  {
    id: 'custom',
    label: '自定义 / 未适配',
    baseUrlHint: 'https://your-host/v1',
    authHint: '自行定义，工具不假定任何请求格式',
    keyHint: '按需填写',
    supportsListModels: false,
    listEndpoint: null,
    testEndpoint: null,
    testLabel: '该协议需手动验证',
    chatEndpoint: null,
    chatLabel: '自定义协议不假定对话端点',
    docUrl: '',
    note: '未适配的协议不猜测接口，既不读取模型列表、不自动验证连接，也不假定存在 /chat/completions。若要给助手配文本渠道，请选「OpenAI 兼容」并填自己的 Base URL。',
    noListReason: '自定义协议不假定存在 /models，请手动添加模型并按自己的接口文档验证。',
  },
];

export function protocolSpec(id: ServiceProtocol): ProtocolSpec {
  return PROTOCOLS.find((p) => p.id === id) ?? PROTOCOLS[PROTOCOLS.length - 1];
}

/* ==================== 能力模板（来自公开文档，不按模型名猜） ==================== */
const H3_DOC = 'https://www.compshare.cn/docs/minimax-h3/api/minimax-h3-video-api';
const QWEN_DOC = 'https://www.compshare.cn/docs/minimax-h3/api/qwen-image-api';

export function qwenImageResolutions(prices: unknown): ('1K' | '2K')[] {
  const tiers = prices as Partial<Record<'1K' | '2K', { base?: unknown; per_reference?: unknown }>> | null;
  return (['1K', '2K'] as const).filter(tier =>
    typeof tiers?.[tier]?.base === 'number' && typeof tiers[tier]?.per_reference === 'number');
}

export const H3_CAPABILITIES: ModelCapabilities = {
  ratios: ['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
  resolutions: ['480P', '768P', '1080P', '2K', '4K'],
  durations: Array.from({ length: 27 }, (_, i) => i + 4), // 文档：4～30 秒整数
  audioOptions: [
    { id: 'keep', label: '保留成片音轨（mute_audio=false）' },
    { id: 'mute', label: '无声视频（mute_audio=true）' },
  ],
  maxCount: 1,
  roles: ['first-frame', 'last-frame', 'reference-image', 'reference-video', 'reference-audio'],
  roleLimits: {
    'first-frame': 1, 'last-frame': 1,
    'reference-image': 9, 'reference-video': 3, 'reference-audio': 3,
  },
  maxReferences: 12,
  advancedFields: [
    { key: 'useContextIr', label: 'Context-IR 提示词优化', kind: 'boolean', defaultValue: true, hint: '文档建议所有时长开启；每条任务另计 5 积分。' },
    { key: 'skillId', label: 'Skill ID（创作规则）', kind: 'text', defaultValue: '', hint: '来自平台公开 GET /minimax/v2/skills，需同时开启 Context-IR。Skill 不是模型。' },
    { key: 'aigcWatermark', label: 'AIGC 水印', kind: 'boolean', defaultValue: false, hint: '文档字段 aigc_watermark。' },
  ],
  source: `共绩算力 MiniMax H3 视频任务 API（${H3_DOC}，2026-10-14 更新）`,
  note: '文档没有独立声音参数：声音由参考音频、带音轨参考视频与 mute_audio 表达。首尾帧不能与参考素材混用；图片/视频/音频合计最多 12 个。无模型列表接口。',
};

export const QWEN_IMAGE_CAPABILITIES: ModelCapabilities = {
  ratios: ['1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16'],
  resolutions: ['1K'],
  durations: [],
  audioOptions: [],
  maxCount: 1,
  roles: ['reference-image'],
  roleLimits: { 'reference-image': 10 },
  maxReferences: 10,
  advancedFields: [
    { key: 'optimizePrompt', label: '提示词智能优化', kind: 'boolean', defaultValue: false, hint: '文档字段 optimize_prompt，默认 false。' },
  ],
  source: `共绩算力 Qwen-Image 图片生成 API（${QWEN_DOC}）`,
  note: '每个任务输出 1 张 PNG。分辨率以当前服务配置为准。最多 10 张参考图，须上传并登记。',
};

export const TEXT_CAPABILITIES: ModelCapabilities = {
  ...EMPTY_CAPABILITIES,
  source: '仅文本对话模型，本工具的画布节点不使用出图 / 出视频参数',
  note: '文本服务不提供图片或视频生成能力，也不会让图片 / 视频节点变成已配置。',
};

export interface CapabilityTemplate {
  id: string;
  label: string;
  caps: ModelCapabilities;
}

export const CAPABILITY_TEMPLATES: CapabilityTemplate[] = [
  { id: 'openai-image', label: 'OpenAI Images 协议', caps: { ...EMPTY_CAPABILITIES, resolutions: ['1024x1024', '1536x1024', '1024x1536', 'auto'], roles: ['reference-image'], maxReferences: 16, maxCount: 10, source: 'OpenAI Images 接口', note: '尺寸由分辨率选项决定；兼容服务的具体能力以供应商文档为准。' } },
  { id: 'openai-video', label: 'OpenAI Videos 协议', caps: { ...EMPTY_CAPABILITIES, resolutions: ['1280x720', '720x1280'], durations: [4, 8, 12], roles: ['first-frame'], maxReferences: 1, source: 'OpenAI Videos 接口', note: '兼容服务的具体能力以供应商文档为准。' } },
  { id: 'h3-video', label: 'H3 视频（按公开文档）', caps: H3_CAPABILITIES },
  { id: 'qwen-image', label: 'Qwen-Image 图片（按公开文档）', caps: QWEN_IMAGE_CAPABILITIES },
  { id: 'text-only', label: '仅文本（无生成参数）', caps: TEXT_CAPABILITIES },
  { id: 'custom', label: '自定义 / 能力未确认', caps: EMPTY_CAPABILITIES },
];

export function capabilityTemplate(id: string): ModelCapabilities {
  const t = CAPABILITY_TEMPLATES.find((x) => x.id === id);
  return t ? JSON.parse(JSON.stringify(t.caps)) as ModelCapabilities : JSON.parse(JSON.stringify(EMPTY_CAPABILITIES)) as ModelCapabilities;
}

/* ==================== 配置引导预设 ====================
 * 预设只用于快速搭建服务结构，创建出来默认是停用 + 未验证，
 * 不会混进「已可用的模型」。
 */
export interface ServicePreset {
  id: string;
  label: string;
  hint: string;
  serviceName: string;
  protocol: ServiceProtocol;
  baseUrl: string;
  models: Omit<ServiceModel, 'enabled'>[];
}

export const SERVICE_PRESETS: ServicePreset[] = [
  {
    id: 'h3-video',
    label: 'H3 视频服务',
    hint: '归属视频服务。模型与能力来自公开文档，Skill 走平台公开接口，不从本机拼装。',
    serviceName: '共绩算力 H3 视频',
    protocol: 'compshare-h3',
    baseUrl: 'https://cp.compshare.cn',
    models: [
      { id: 'MiniMax-H3', name: 'MiniMax H3', type: 'video', capabilities: H3_CAPABILITIES },
      { id: 'minimax-h3-lite', name: 'MiniMax H3 Lite（兼容别名）', type: 'video', capabilities: H3_CAPABILITIES },
    ],
  },
  {
    id: 'qwen-image',
    label: 'Qwen-Image 图片服务',
    hint: '图片服务独立管理，与视频服务不共用模型名单。凭据可与 H3 同 Key。',
    serviceName: '共绩算力 Qwen-Image 图片',
    protocol: 'compshare-image',
    baseUrl: 'https://cp.compshare.cn',
    models: [
      { id: 'Qwen-Image', name: 'Qwen-Image', type: 'image', capabilities: QWEN_IMAGE_CAPABILITIES },
    ],
  },
  {
    id: 'minimax-h3-image',
    label: 'MiniMax H3 Image（官方 API）',
    hint: '使用 MiniMax 开放平台 API Key；与优云智算工作台 Key 不通用。',
    serviceName: 'MiniMax 官方图片',
    protocol: 'openai',
    baseUrl: 'https://api.minimax.cn/v1',
    models: [
      { id: 'MiniMax-H3-Image', name: 'MiniMax H3 Image', type: 'image', capabilities: {
        ...EMPTY_CAPABILITIES,
        resolutions: ['1024x1024', '1536x1024', '1024x1536', '2048x2048', '3072x2048', '2048x3072', '4096x4096'],
        roles: ['reference-image'], roleLimits: { 'reference-image': 16 }, maxReferences: 16, maxCount: 10,
        source: 'MiniMax 官方 Image Generation API',
        note: '使用 MiniMax 开放平台 API Key。参考图和图片生成的具体用量以平台为准。',
      } },
    ],
  },
  {
    id: 'openai-text',
    label: 'OpenAI 文本',
    hint: '填写 OpenAI API Key，可在目录中选择账号可用的文本模型。',
    serviceName: 'OpenAI 文本',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    models: [
      { id: 'gpt-4o-mini', name: 'gpt-4o-mini', type: 'text', capabilities: TEXT_CAPABILITIES },
    ],
  },
  {
    id: 'deepseek-text',
    label: 'DeepSeek',
    hint: '使用 DeepSeek API Key，走 /chat/completions。',
    serviceName: 'DeepSeek',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com',
    models: [
      { id: 'deepseek-flash', name: 'DeepSeek Flash', type: 'text', capabilities: TEXT_CAPABILITIES },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', type: 'text', capabilities: TEXT_CAPABILITIES },
    ],
  },
  {
    id: 'openai-image',
    label: 'GPT Image',
    hint: '使用 OpenAI Images API，可更换为服务商支持的图片模型 ID。',
    serviceName: 'OpenAI 图片',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    models: [
      { id: 'gpt-image-2', name: 'GPT Image 2', type: 'image', capabilities: capabilityTemplate('openai-image') },
    ],
  },
];

/** H3 Skill 是创作规则，不是模型；后续只通过平台公开接口选择 */
export const H3_SKILL_INFO = {
  endpoint: 'GET https://cp.compshare.cn/minimax/v2/skills',
  note: 'Skill 保存可复用的镜头语言与提示词规范，不会单独生成视频。后续通过平台公开 Skill 列表接口选择并把 skill_id 作为高级参数传入，不从桌面软件内部资源拼装依赖。',
  status: '尚未接入真实调用',
};

export function newServiceFromPreset(preset: ServicePreset, id: string): ModelService {
  return {
    id,
    name: preset.serviceName,
    protocol: preset.protocol,
    baseUrl: preset.baseUrl,
    apiKey: '',
    enabled: false,
    note: `由「${preset.label}」配置引导创建。${preset.hint}`,
    createdAt: Date.now(),
    models: preset.models.map((m) => ({
      ...m,
      capabilities: JSON.parse(JSON.stringify(m.capabilities)) as ModelCapabilities,
      enabled: true,
    })),
    connection: { status: 'unverified', checkedAt: 0, message: '尚未验证连接', endpoint: '' },
  };
}
