/**
 * 工作台整体配置与「完整功能对照表」。
 *
 * 设计原则：
 * 1. 所有指向外部服务、凭据、端点、单价、品牌、能力开关的东西都留成可配置项，
 *    默认值是「本机可用、不联网、不假装有服务」。
 * 2. 不内置任何第三方产品名、官网、社群、市场地址或官方账号体系。
 * 3. 旧项目数据没有 workbench 字段时，全部补安全默认值，不迁移、不丢数据。
 */
import type {
  AgentConfig,
  AppSettings,
  AppearanceConfig,
  FeatureFlags,
  GenerationConfig,
  PromptPrefs,
  WorkbenchConfig,
  WorkspaceConfig,
} from '../types';

/* ==================== 默认值 ==================== */

export const DEFAULT_APPEARANCE: AppearanceConfig = {
  theme: 'follow', grid: 'dots', background: '#0d0d10', brightness: 0,
  gridColor: '#2a2a31', gridStrength: 45, savedAsDefault: false,
};

export const DEFAULT_WORKSPACE: WorkspaceConfig = {
  appName: '开视',
  tagline: '在一张画布里连接创意、素材与模型',
  starter: 'blank',
  storageQuotaMB: 0,
  snapshotIntervalMin: 5,
  snapshotLimit: 20,
};

export const DEFAULT_GENERATION: GenerationConfig = {
  enabled: false,
  endpoint: '',
  protocol: 'openai-compatible',
  submitPath: '/tasks',
  statusPath: '/tasks/{id}',
  timeoutSec: 120,
  maxConcurrent: 1,
  requireConfirmation: true,
  showCostEstimate: true,
  pricing: [],
};

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  showThinking: true,
  autoRunSkillScripts: false,
  scriptTimeoutSec: 300,
  readOnlyExternal: false,
  idempotencyRequired: true,
  maxSteps: 24,
};

export const DEFAULT_FEATURES: FeatureFlags = {
  autoLink: true,
  hoverPreview: true,
  batchTable: true,
  upscaleNode: true,
  chapterExtract: true,
  promptOptimizer: true,
  versionHistory: true,
  diagnostics: true,
  timeline: true,
  workflows: true,
  pluginCenter: true,
  externalAgents: true,
  costEstimate: true,
  gridSplit: true,
  multiAngle: true,
  storageMeter: true,
  promptTemplates: true,
  promptExpander: true,
  selectionToolbar: true,
  mediaPreview: true,
};

export const DEFAULT_PROMPT_PREFS: PromptPrefs = {
  followOfficial: true,
  append: '',
  protectedContract: '动态上下文与 JSON 输出契约由工具注入，用户偏好不能覆盖',
};

export const DEFAULT_WORKBENCH: WorkbenchConfig = {
  appearance: DEFAULT_APPEARANCE,
  workspace: DEFAULT_WORKSPACE,
  generation: DEFAULT_GENERATION,
  agentConfig: DEFAULT_AGENT_CONFIG,
  plugins: [],
  externalAgents: [],
  features: DEFAULT_FEATURES,
  promptPrefs: DEFAULT_PROMPT_PREFS,
};

/** 浅合并 + 数组兜底，任何缺字段都补默认值 */
export function normalizeWorkbench(raw: Partial<WorkbenchConfig> | undefined | null): WorkbenchConfig {
  const w = (raw && typeof raw === 'object' ? raw : {}) as Partial<WorkbenchConfig>;
  return {
    appearance: { ...DEFAULT_APPEARANCE, ...(w.appearance ?? {}) },
    workspace: { ...DEFAULT_WORKSPACE, ...(w.workspace ?? {}), appName: '开视' },
    generation: {
      ...DEFAULT_GENERATION, ...(w.generation ?? {}),
      pricing: Array.isArray(w.generation?.pricing) ? w.generation!.pricing : [],
    },
    agentConfig: { ...DEFAULT_AGENT_CONFIG, ...(w.agentConfig ?? {}) },
    plugins: Array.isArray(w.plugins) ? w.plugins : [],
    externalAgents: Array.isArray(w.externalAgents) ? w.externalAgents : [],
    features: { ...DEFAULT_FEATURES, ...(w.features ?? {}) },
    promptPrefs: { ...DEFAULT_PROMPT_PREFS, ...(w.promptPrefs ?? {}) },
  };
}

/** 任何模块读配置都走这里，保证拿到的一定是完整结构 */
export function workbenchOf(settings: AppSettings): WorkbenchConfig {
  return normalizeWorkbench(settings.workbench);
}

/** 写回配置：保持 settings 其它字段不变 */
export function withWorkbench(settings: AppSettings, patch: Partial<WorkbenchConfig>): AppSettings {
  return { ...settings, workbench: { ...workbenchOf(settings), ...patch } };
}

export function featureOn(settings: AppSettings, key: keyof FeatureFlags): boolean {
  return workbenchOf(settings).features[key] !== false;
}

export interface PromptOperation {
  id: string;
  label: string;
  summary: string;
  template: string;
  protected: boolean;
}

export const PROMPT_OPERATIONS: PromptOperation[] = [
  { id: 'chapter-assets', label: '章节资产提取', summary: '从章节文本提取角色、场景、道具三类数组', template: '读取章节内容，分别输出 characters / scenes / props 三个数组。缺失的类返回空数组，不要编造。', protected: true },
  { id: 'storyboard-plan', label: '分镜规划', summary: '把创意拆成逐镜时长、画面、动作、声音', template: '按目标总时长拆分镜头，每镜写清时长、画面、动作、声音与待确认项。', protected: true },
  { id: 'storyboard-repair', label: '分镜修复', summary: '修正节奏与镜头衔接', template: '检查景别跳跃、总时长与相邻镜头衔接，逐条给出修改建议。', protected: true },
  { id: 'first-frame', label: '分镜首帧', summary: '把分镜文字转成首帧画面提示词', template: '只描述静态画面：主体、构图、光线、色彩、景别。不要写动作过程。', protected: true },
  { id: 'shot-video', label: '分镜视频', summary: '把首帧与分镜写成视频提示词', template: '描述一个连续动作、镜头运动与时长，保持与首帧一致的主体和场景。', protected: true },
  { id: 'character-card', label: '角色卡提取', summary: '从文本整理角色设定', template: '输出角色名称、外貌、服装、性格与一致性约束，未提到的写待确认。', protected: true },
  { id: 'character-views', label: '角色三视图', summary: '生成正面、侧面、背面一致性描述', template: '同一角色的正面、侧面、背面，服装与配色保持一致。', protected: true },
  { id: 'drama-outline', label: '短剧大纲', summary: '世界观、人物、反转与结尾', template: '输出世界观、角色关系、两次反转与结尾悬念，标注未确定项。', protected: true },
  { id: 'skill-draft', label: '技能草稿', summary: '生成技能正文草稿', template: '按「方法 / 步骤 / 要求」三段写技能正文，不虚构未提供的信息。', protected: true },
];
