/**
 * 本机技能目录与纯函数。刻意不依赖 store，供设置读取阶段安全调用。
 */
import {
  normalizeSkill,
  type AppSettings,
  type CanvasSkill,
  type ModelService,
  type NodeType,
} from '../types';
import { protocolSpec } from './modelCatalog';
import { h3Skills } from './h3SkillLibrary';
import screenwritingBody from './screenwriting-skill/SKILL.md?raw';

function builtin(input: Omit<CanvasSkill, 'enabled' | 'builtin' | 'origin' | 'createdAt' | 'updatedAt'>): CanvasSkill {
  const now = Date.now();
  return { ...input, enabled: true, builtin: true, origin: '官方内置', createdAt: now, updatedAt: now };
}

export const BUILTIN_SKILLS: CanvasSkill[] = [
  ...h3Skills,
  builtin({
    id: 'screenwriting-master', name: '剧本创作',
    description: '从故事构思到剧本与场景拆解，支持短片、长片和剧集',
    appliesTo: 'canvas', requires: 'text-model', version: '1.0.0',
    body: screenwritingBody,
    template: '创作目标：{goal}\n按作品体量写剧本；需要落到画布时建立分镜脚本节点。',
  }),
  builtin({
    id: 'builtin-storyboard',
    name: '双镜头文字分镜',
    description: '把一句创意拆成两镜各 4 秒的分镜表，列出画面、声音与待确认项',
    appliesTo: 'canvas',
    requires: 'none',
    version: '1.0.0',
    body: [
      '方法：先确定两镜各自承担的信息，再写画面、动作、声音，最后列出待确认项。',
      '步骤：1. 明确创作目标与情绪；2. 拆成两个连续镜头；3. 每镜写清画面、动作、声音；4. 汇总待确认项。',
      '要求：两镜之间必须有因果或时间推进，不要只是重复同一个画面；声音单独成行；未确定的信息写进待确认项，不要编造。',
    ].join('\n'),
    template: '创作目标：{goal}\n\n镜头一（4 秒）\n画面：\n动作：\n声音：\n\n镜头二（4 秒）\n画面：\n动作：\n声音：\n\n待确认项：\n1. 场景与光线\n2. 人物或主体\n3. 配音与音乐',
  }),
  builtin({
    id: 'builtin-interview',
    name: '采访提纲',
    description: '生成三个开放问题、条件追问，以及补拍与授权清单',
    appliesTo: 'canvas',
    requires: 'none',
    version: '1.0.0',
    body: [
      '方法：从被访者的经历出发，用开放问题引出具体故事，再按回答准备条件追问。',
      '步骤：1. 写明采访目标；2. 设计三个开放问题；3. 为每个问题准备条件追问；4. 列出补拍与授权清单。',
      '要求：问题不能用是或否回答；追问要依赖前面的回答；授权清单包含肖像、场地与素材使用范围。',
    ].join('\n'),
    template: '采访目标：{goal}\n\n开放问题\n1.\n2.\n3.\n\n条件追问\n问题一若提到人：\n问题二若提到时间：\n问题三若提到结果：\n\n补拍与授权清单\n补拍：\n肖像授权：\n场地授权：\n素材使用范围：',
  }),
  builtin({
    id: 'builtin-asset-audit',
    name: '素材清单整理',
    description: '读取当前画布已有素材，按用途分类并记录缺口',
    appliesTo: 'canvas',
    requires: 'none',
    version: '1.0.0',
    body: [
      '方法：先盘点画布上真实存在的素材节点，再按图片、视频、音频分组，最后写清缺口。',
      '步骤：1. 列出画布中的素材节点；2. 按类型分组；3. 标注每个素材的名称；4. 记录时长、声音与授权缺口。',
      '要求：只统计画布里真实存在的节点，不凭空补充素材；缺口单独列出，等用户确认。',
    ].join('\n'),
    template: '整理目标：{goal}\n\n按画布现有节点盘点，分类列出名称。\n\n缺口：时长、声音、授权记录。',
  }),
  builtin({
    id: 'builtin-shot-visual',
    name: '分镜视觉化',
    description: '把分镜文字落成带提示词的视频节点，需要已启用的视频模型',
    appliesTo: 'video',
    requires: 'video-model',
    version: '1.0.0',
    body: [
      '方法：读取画布上的分镜文字节点，为每个镜头建立一个空视频节点并写入提示词，再按顺序连线。',
      '步骤：1. 找到分镜文本节点；2. 每个镜头建一个视频节点；3. 提示词取该镜头的画面描述；4. 按顺序连线表达镜头顺序。',
      '要求：需要已启用且可用的视频模型；没有模型时只生成方案，不伪装成已生成画面。',
    ].join('\n'),
    template: '创作目标：{goal}\n\n为每个镜头建立视频节点，提示词来自对应分镜的画面描述。',
  }),
];

/** 读取设置时补齐内置技能，用户已有的启用状态与私人改写都保留 */
export function mergeBuiltinSkills(settings: AppSettings): AppSettings {
  const existing = settings.skills ?? [];
  const byId = new Set(existing.map((s) => s.id));
  const merged = [...existing];
  let changed = false;
  BUILTIN_SKILLS.forEach((b) => {
    if (!byId.has(b.id)) { merged.push({ ...b }); changed = true; }
  });
  return changed ? { ...settings, skills: merged.map(normalizeSkill) } : settings;
}

/* ==================== 导入与导出 ==================== */

export function parseSkillFile(fileName: string, text: string): CanvasSkill {
  const baseName = fileName.replace(/\.(md|markdown|json|txt)$/i, '') || '导入技能';
  const now = Date.now();
  if (fileName.toLowerCase().endsWith('.json')) {
    try {
      const raw = JSON.parse(text) as Partial<CanvasSkill>;
      if (!raw || Array.isArray(raw) || typeof raw !== 'object' || typeof raw.body !== 'string' || !raw.body.trim()) throw new Error('技能正文为空');
      return normalizeSkill({ ...raw, id: `skill-${now}`, builtin: false, origin: '本机导入' } as CanvasSkill);
    } catch {
      throw new Error('JSON 技能文件解析失败，请检查格式');
    }
  }
  const fm = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  const meta: Record<string, string> = {};
  if (fm) {
    fm[1].split(/\r?\n/).forEach((line) => {
      const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
      if (m) {
        const value = m[2].trim();
        try { meta[m[1].toLowerCase()] = value.startsWith('"') ? JSON.parse(value) : value.replace(/^'|'$/g, ''); }
        catch { meta[m[1].toLowerCase()] = value.replace(/^['"]|['"]$/g, ''); }
      }
    });
  }
  const body = (fm ? text.slice(fm[0].length) : text).trim();
  if (!body) throw new Error('技能正文为空');
  const requires = (['none', 'text-model', 'image-model', 'video-model'] as const).find((r) => r === meta.requires) ?? 'none';
  const appliesTo = (['text', 'image', 'video', 'audio', 'canvas', 'any'] as const).find((r) => r === meta.appliesto) ?? 'any';
  return normalizeSkill({
    id: `skill-${now}`,
    name: meta.name || baseName,
    description: meta.description || body.split('\n')[0].slice(0, 80),
    appliesTo, requires, body,
    template: meta.template || `${body}\n\n创作目标：{goal}`,
    enabled: true, builtin: false,
    version: meta.version || '1.0.0', origin: '本机导入',
    createdAt: now, updatedAt: now,
  } as CanvasSkill);
}

export function skillToMarkdown(skill: CanvasSkill): string {
  return [
    '---',
    `name: ${skill.name}`,
    `description: ${skill.description.replace(/\n/g, ' ')}`,
    `appliesTo: ${skill.appliesTo}`,
    `requires: ${skill.requires}`,
    `version: ${skill.version}`,
    `template: ${JSON.stringify(skill.template)}`,
    '---',
    '',
    skill.body,
    '',
  ].join('\n');
}

/* ==================== 能力校验 ==================== */

export interface SkillReadiness { met: boolean; label: string; reason: string }

function enabledModels(settings: AppSettings, type: 'text' | 'image' | 'video'): ModelService[] {
  return (settings.services ?? []).filter((s) => s.enabled
    && (s.models ?? []).some((m) => m.type === type && m.enabled));
}

export function skillReadiness(skill: CanvasSkill, settings: AppSettings, codexAvailable = false): SkillReadiness {
  if (skill.requires === 'none') return { met: true, label: '纯文字技能', reason: '不需要多模态模型，可直接执行' };
  if (skill.requires === 'text-model') {
    const channel = firstTextService(settings);
    return channel || codexAvailable
      ? { met: true, label: '文本模型', reason: channel ? '已配置助手文本服务' : 'Codex 账号已登录' }
      : { met: false, label: '文本模型', reason: '请配置助手文本模型或登录 Codex' };
  }
  const type = skill.requires === 'image-model' ? 'image' : 'video';
  const label = type === 'image' ? '图片模型' : '视频模型';
  const services = enabledModels(settings, type);
  return services.length
    ? { met: true, label, reason: `已启用 ${services.length} 个含该能力的服务` }
    : { met: false, label, reason: `需要已启用且含${label}的模型服务，当前未配置` };
}

export interface TextChannel { service: ModelService; modelId: string; endpoint: string; label: string }

/** 可用于助手生成方案的文本模型渠道：端点必须来自协议规格，不对自定义服务凭空假定接口 */
export function firstTextService(settings: AppSettings): TextChannel | null {
  for (const s of settings.services ?? []) {
    if (!s.enabled || !s.baseUrl.trim() || !s.apiKey.trim()) continue;
    const spec = protocolSpec(s.protocol);
    if (!spec.chatEndpoint) continue;
    const model = (s.models ?? []).find((m) => m.type === 'text' && m.enabled);
    if (model) return { service: s, modelId: model.id, endpoint: spec.chatEndpoint, label: spec.chatLabel };
  }
  return null;
}

/* ==================== 方案类型 ==================== */

export interface PlanStep {
  key: string;
  type: NodeType;
  name: string;
  text?: string;
  prompt?: string;
  /** 连到哪些步骤（用 key 引用），表达真实输入关系 */
  connectTo?: string[];
}

export interface CanvasPlan {
  skillId: string;
  skillName: string;
  goal: string;
  /** 'model' = 真实文本模型生成，'template' = 本地模板，界面必须如实标注 */
  source: 'model' | 'template';
  sourceDetail: string;
  steps: PlanStep[];
  notes: string[];
}
