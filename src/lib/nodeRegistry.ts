/**
 * 节点注册表，对齐 BeefTV 的 node-registry / node-definition / NODE_SPECS。
 *
 * 设计约定：
 *  - 持久化的 `type` 仍是 5 类（文字/图片/视频/音频/分组），不动数据格式与旧项目。
 *  - `variant` 描述「同一类型里具体是哪一种节点」，对应 BeefTV 的
 *    type + metadata.workflowKind 组合，让创建菜单、节点卡片、属性面板、
 *    输入插槽、拉伸下限等静态知识只有一个数据源。
 *  - 注册表只回答「这个节点是什么 / 长什么样 / 接受什么输入」，
 *    不参与角色判定与引用解析，避免和 nodeSemantics / models 的职责混淆。
 *  - 第三方可通过 registerNodeDefinitions() 追加定义，无需改任何 switch。
 */
import {
  NODE_DEFAULTS,
  TYPE_LABELS,
  isMediaNode,
  type CanvasNode,
  type NodeType,
} from '../types';

export type NodeVariant =
  | 'text' | 'prompt' | 'script' | 'markdown'
  | 'image' | 'image-input' | 'image-generator' | 'character' | 'scene' | 'keyframe'
  | 'video' | 'video-input' | 'video-generator' | 'shot'
  | 'audio' | 'audio-input'
  | 'group' | 'frame' | 'compare' | 'director';

export type NodeCategory = '输入' | '生成' | '文本' | '组织' | '工具';
export type ResourceKind = 'image' | 'video' | 'audio' | 'text';

/** 节点卡片上的一条输入插槽，对应 BeefTV 的「提示词 / 参考图片 / 参考视频」列表 */
export interface InputSlot {
  id: string;
  label: string;
  accepts: NodeType | NodeType[];
  optional?: boolean;
  /** 该插槽最多接几条连线 */
  max?: number;
}

export type PanelField = 'name' | 'usage' | 'model' | 'prompt' | 'upload' | 'fit' | 'appearance' | 'slots';

export interface NodeDefinition {
  variant: NodeVariant;
  type: NodeType;
  /** 创建菜单短标签 */
  label: string;
  /** 搜索 / 列表标签 */
  listLabel: string;
  icon: string;
  defaultTitle: string;
  description: string;
  category: NodeCategory;
  defaultSize: { w: number; h: number };
  minSize: { w: number; h: number };
  /** 基础 5 项，保持与旧版创建菜单一致，回归测试依赖这一组按钮 */
  basic?: boolean;
  showInCreateMenu: boolean;
  /** 空节点是否显示输入插槽列表而不是大块空态 */
  slotLayout?: boolean;
  inputSlots?: InputSlot[];
  acceptsInputKind?: NodeType | NodeType[];
  maxInputCount?: number;
  keepAspectRatio?: boolean;
  showOutputConnection?: boolean;
  resourceKind: (node: CanvasNode) => ResourceKind | null;
  generationMode?: (node: CanvasNode) => ResourceKind | null;
  panelFields: PanelField[];
}

const hasAsset = (node: CanvasNode) => isMediaNode(node) && !!node.assetId;
const hasText = (node: CanvasNode) => node.type === 'text' && !!node.text.trim();

const mediaSlots: InputSlot[] = [
  { id: 'prompt', label: '提示词', accepts: 'text', optional: true },
  { id: 'ref-image', label: '参考图片', accepts: 'image', optional: true },
  { id: 'ref-video', label: '参考视频', accepts: 'video', optional: true },
  { id: 'ref-audio', label: '参考音频', accepts: 'audio', optional: true },
];
const videoSlots: InputSlot[] = [
  { id: 'prompt', label: '提示词', accepts: 'text', optional: true },
  { id: 'first-frame', label: '首帧', accepts: 'image', optional: true },
  { id: 'last-frame', label: '尾帧', accepts: 'image', optional: true },
  { id: 'ref-video', label: '参考视频', accepts: 'video', optional: true },
  { id: 'ref-audio', label: '参考音频', accepts: 'audio', optional: true },
];

/**
 * 每种节点的自有特征。尺寸与默认标题不在这里重复，装配时统一读 NODE_SPECS，
 * 避免同一份知识在创建菜单、搜索、拉伸逻辑里各写一遍后漂移。
 */
const TRAITS: Record<NodeVariant, Omit<NodeDefinition, 'variant' | 'type' | 'defaultSize' | 'minSize' | 'listLabel'>> = {
  text: {
    label: '文字', icon: 'text', defaultTitle: '文字', description: '承载提示词、台词或备注，可作为文本输入被引用',
    category: '文本', basic: true, showInCreateMenu: true,
    resourceKind: (n) => (hasText(n) ? 'text' : null), generationMode: () => 'text',
    panelFields: ['name', 'appearance'],
  },
  prompt: {
    label: '提示词', icon: 'edit', defaultTitle: '提示词', description: '写提示词或旁白，连到其它节点作为文本输入',
    category: '文本', showInCreateMenu: true,
    resourceKind: (n) => (hasText(n) ? 'text' : null), generationMode: () => 'text',
    panelFields: ['name', 'appearance'],
  },
  script: {
    label: '分镜脚本', icon: 'script', defaultTitle: '分镜脚本', description: '按镜号组织剧情、时长与画面描述',
    category: '文本', showInCreateMenu: true,
    resourceKind: (n) => (hasText(n) ? 'text' : null), generationMode: () => 'text',
    panelFields: ['name', 'appearance'],
  },
  markdown: {
    label: 'Markdown', icon: 'file', defaultTitle: 'Markdown', description: '用 Markdown 写说明与结构化文本',
    category: '文本', showInCreateMenu: true,
    resourceKind: (n) => (hasText(n) ? 'text' : null),
    panelFields: ['name', 'appearance'],
  },

  image: {
    label: '图片', icon: 'image', defaultTitle: '图片', description: '放图片素材，或留空写提示词生成',
    category: '生成', basic: true, showInCreateMenu: true, slotLayout: true, inputSlots: mediaSlots,
    keepAspectRatio: true, resourceKind: (n) => (hasAsset(n) ? 'image' : null),
    generationMode: (n) => (!hasAsset(n) ? 'image' : null),
    panelFields: ['name', 'usage', 'model', 'prompt', 'upload', 'fit', 'slots'],
  },
  'image-input': {
    label: '图片输入', icon: 'upload', defaultTitle: '图片输入', description: '每次可替换的图片素材入口',
    category: '输入', showInCreateMenu: true, slotLayout: false,
    resourceKind: (n) => (hasAsset(n) ? 'image' : null),
    panelFields: ['name', 'usage', 'upload', 'fit'],
  },
  'image-generator': {
    label: '生成图片', icon: 'sparkles', defaultTitle: '生成图片', description: '按提示词与参考素材生成图片，可标记最终输出',
    category: '生成', showInCreateMenu: true, slotLayout: true, inputSlots: mediaSlots,
    keepAspectRatio: true, resourceKind: (n) => (hasAsset(n) ? 'image' : null),
    generationMode: (n) => (!hasAsset(n) ? 'image' : null),
    panelFields: ['name', 'usage', 'model', 'prompt', 'upload', 'fit', 'slots'],
  },
  character: {
    label: '角色设定', icon: 'character', defaultTitle: '角色设定', description: '人物设定图，跨镜头复用的角色参考',
    category: '输入', showInCreateMenu: true,
    resourceKind: (n) => (hasAsset(n) ? 'image' : null),
    panelFields: ['name', 'usage', 'upload', 'fit'],
  },
  scene: {
    label: '场景设定', icon: 'scene', defaultTitle: '场景设定', description: '场景氛围图，作为分镜与视频的视觉基准',
    category: '输入', showInCreateMenu: true,
    resourceKind: (n) => (hasAsset(n) ? 'image' : null),
    panelFields: ['name', 'usage', 'upload', 'fit'],
  },
  keyframe: {
    label: '关键帧', icon: 'keyframe', defaultTitle: '关键帧', description: '视频首尾帧或关键帧截图',
    category: '输入', showInCreateMenu: true,
    resourceKind: (n) => (hasAsset(n) ? 'image' : null),
    panelFields: ['name', 'usage', 'upload', 'fit'],
  },

  video: {
    label: '视频', icon: 'video', defaultTitle: '视频', description: '放视频素材，或留空写提示词生成',
    category: '生成', basic: true, showInCreateMenu: true, slotLayout: true, inputSlots: videoSlots,
    keepAspectRatio: true, resourceKind: (n) => (hasAsset(n) ? 'video' : null),
    generationMode: (n) => (!hasAsset(n) ? 'video' : null),
    panelFields: ['name', 'usage', 'model', 'prompt', 'upload', 'fit', 'slots'],
  },
  'video-input': {
    label: '视频输入', icon: 'upload', defaultTitle: '视频输入', description: '每次可替换的原片输入',
    category: '输入', showInCreateMenu: true,
    resourceKind: (n) => (hasAsset(n) ? 'video' : null),
    panelFields: ['name', 'usage', 'upload', 'fit'],
  },
  'video-generator': {
    label: '生成视频', icon: 'sparkles', defaultTitle: '生成视频', description: '按提示词、首尾帧与参考视频生成片段',
    category: '生成', showInCreateMenu: true, slotLayout: true, inputSlots: videoSlots,
    keepAspectRatio: true, resourceKind: (n) => (hasAsset(n) ? 'video' : null),
    generationMode: (n) => (!hasAsset(n) ? 'video' : null),
    panelFields: ['name', 'usage', 'model', 'prompt', 'upload', 'fit', 'slots'],
  },
  shot: {
    label: '分镜镜头', icon: 'script', defaultTitle: '分镜镜头', description: '单个镜头的画面与生成结果',
    category: '生成', showInCreateMenu: true, slotLayout: true, inputSlots: videoSlots,
    resourceKind: (n) => (hasAsset(n) ? 'video' : null),
    generationMode: (n) => (!hasAsset(n) ? 'video' : null),
    panelFields: ['name', 'usage', 'model', 'prompt', 'upload', 'fit', 'slots'],
  },

  audio: {
    label: '音频', icon: 'audio', defaultTitle: '音频', description: '音频素材或配音节点',
    category: '生成', basic: true, showInCreateMenu: true,
    resourceKind: (n) => (hasAsset(n) ? 'audio' : null),
    generationMode: (n) => (!hasAsset(n) ? 'audio' : null),
    panelFields: ['name', 'usage', 'upload'],
  },
  'audio-input': {
    label: '音频输入', icon: 'upload', defaultTitle: '音频输入', description: '参考音频 / 配音输入',
    category: '输入', showInCreateMenu: true,
    resourceKind: (n) => (hasAsset(n) ? 'audio' : null),
    panelFields: ['name', 'usage', 'upload'],
  },

  group: {
    label: '分组', icon: 'group', defaultTitle: '分组', description: '把相关节点框在一起',
    category: '组织', basic: true, showInCreateMenu: true,
    resourceKind: () => null, panelFields: ['name', 'appearance'],
  },
  frame: {
    label: '背板', icon: 'panelLeft', defaultTitle: '背板', description: '视觉容器，不参与素材与容量计数',
    category: '组织', showInCreateMenu: true, showOutputConnection: false,
    resourceKind: () => null, panelFields: ['name', 'appearance'],
  },
  compare: {
    label: '对比', icon: 'compare', defaultTitle: '对比', description: '并排比较两张上游图片',
    category: '工具', showInCreateMenu: true, acceptsInputKind: 'image', maxInputCount: 2,
    resourceKind: () => null, panelFields: ['name', 'slots'],
  },
  director: {
    label: '导演台', icon: 'sparkles', defaultTitle: '导演台', description: '统筹分镜、角色与场景的工作台节点',
    category: '工具', showInCreateMenu: true,
    resourceKind: () => null, panelFields: ['name', 'slots'],
  },
};

/** 变体 → 持久化类型。把这份知识集中放这里，TRAITS 里就不必重复 22 遍 */
const VARIANT_TYPE: Record<NodeVariant, NodeType> = {
  text: 'text', prompt: 'text', script: 'text', markdown: 'text',
  image: 'image', 'image-input': 'image', 'image-generator': 'image',
  character: 'image', scene: 'image', keyframe: 'image',
  video: 'video', 'video-input': 'video', 'video-generator': 'video', shot: 'video',
  audio: 'audio', 'audio-input': 'audio',
  group: 'group', frame: 'group', compare: 'group', director: 'group',
};

/** 变体 → 默认尺寸 / 拉伸下限，对应 BeefTV 的 NODE_SPECS */
const VARIANT_SPECS: Record<NodeVariant, { size?: { w: number; h: number }; min?: { w: number; h: number } }> = {
  text: {}, prompt: {}, script: { size: { w: 420, h: 200 } }, markdown: { size: { w: 360, h: 200 } },
  image: {}, 'image-input': { size: { w: 260, h: 150 } }, 'image-generator': { size: { w: 300, h: 230 } },
  character: { size: { w: 220, h: 280 } }, scene: { size: { w: 280, h: 200 } }, keyframe: { size: { w: 280, h: 190 } },
  video: {}, 'video-input': { size: { w: 280, h: 180 } }, 'video-generator': { size: { w: 340, h: 230 } },
  shot: { size: { w: 240, h: 300 } },
  audio: {}, 'audio-input': {},
  group: {}, frame: { size: { w: 520, h: 360 } }, compare: { size: { w: 520, h: 300 } },
  director: { size: { w: 360, h: 320 } },
};

/** 基础变体：旧项目与默认创建入口都落到这里 */
export const BASIC_VARIANTS: Record<NodeType, NodeVariant> = {
  text: 'text', image: 'image', video: 'video', audio: 'audio', group: 'group',
};

const definitions = new Map<string, NodeDefinition>();
const ownerByVariant = new Map<string, string>();

function buildDefinitions(): NodeDefinition[] {
  return (Object.keys(TRAITS) as NodeVariant[]).map((variant) => {
    const trait = TRAITS[variant];
    const spec = VARIANT_SPECS[variant];
    const type = VARIANT_TYPE[variant];
    return {
      ...trait,
      showInCreateMenu: Boolean(trait.basic) || variant === 'script',
      variant,
      type,
      listLabel: `${trait.label}节点`,
      defaultSize: spec.size ?? NODE_DEFAULTS[type],
      minSize: spec.min ?? { w: 180, h: 110 },
    };
  });
}

/** 批量注册。同一 owner 可重复注册覆盖，不同 owner 冲突时报错。 */
export function registerNodeDefinitions(defs: NodeDefinition[], ownerId = 'builtin'): void {
  for (const def of defs) {
    const owner = ownerByVariant.get(def.variant);
    if (owner && owner !== ownerId) throw new Error(`节点变体归属冲突：${def.variant}`);
  }
  defs.forEach((def) => {
    definitions.set(def.variant, def);
    ownerByVariant.set(def.variant, ownerId);
  });
}

export function unregisterNodeDefinitions(ownerId: string): void {
  for (const [variant, owner] of ownerByVariant) {
    if (owner !== ownerId) continue;
    definitions.delete(variant);
    ownerByVariant.delete(variant);
  }
}

registerNodeDefinitions(buildDefinitions());

export function listNodeDefinitions(): NodeDefinition[] {
  return [...definitions.values()];
}

export function listCreatableNodeDefinitions(): NodeDefinition[] {
  return listNodeDefinitions().filter((d) => d.showInCreateMenu);
}

export function listBasicNodeDefinitions(): NodeDefinition[] {
  return listNodeDefinitions().filter((d) => d.basic);
}

export function listExtraNodeDefinitions(): NodeDefinition[] {
  return listNodeDefinitions().filter((d) => d.showInCreateMenu && !d.basic);
}

export function getNodeDefinition(variant: string | undefined): NodeDefinition | null {
  return variant ? (definitions.get(variant) ?? null) : null;
}

/**
 * 读节点的变体。旧项目没有 variant 字段，按 type + 内容保守推导，
 * 不改写持久化数据，保证导入导出与刷新后行为一致。
 */
export function variantOf(node: CanvasNode | null | undefined): NodeVariant {
  if (!node) return 'text';
  const explicit = node.variant;
  if (explicit && definitions.has(explicit)) {
    const def = definitions.get(explicit)!;
    if (def.type === node.type) return explicit as NodeVariant;
  }
  return BASIC_VARIANTS[node.type] ?? 'text';
}

export function definitionOf(node: CanvasNode | null | undefined): NodeDefinition {
  return getNodeDefinition(variantOf(node)) ?? definitions.get('text')!;
}

export function getNodeLabel(node: CanvasNode | null | undefined): string {
  return definitionOf(node).label;
}

export function getNodeListLabel(node: CanvasNode | null | undefined): string {
  return definitionOf(node).listLabel;
}

export function getNodeIcon(node: CanvasNode | null | undefined): string {
  return definitionOf(node).icon;
}

export function getNodeMinSize(node: CanvasNode | null | undefined): { w: number; h: number } {
  return definitionOf(node).minSize;
}

export function shouldKeepAspectRatio(node: CanvasNode | null | undefined): boolean {
  return definitionOf(node).keepAspectRatio ?? false;
}

export function getNodeResourceKind(node: CanvasNode | null | undefined): ResourceKind | null {
  return node ? definitionOf(node).resourceKind(node) : null;
}

export function getNodeGenerationMode(node: CanvasNode | null | undefined): ResourceKind | null {
  return node ? (definitionOf(node).generationMode?.(node) ?? null) : null;
}

export function getNodeInputSlots(node: CanvasNode | null | undefined): InputSlot[] {
  return definitionOf(node).inputSlots ?? [];
}

export function getNodePanelFields(node: CanvasNode | null | undefined): PanelField[] {
  return definitionOf(node).panelFields;
}

export function getAcceptedInputKinds(node: CanvasNode | null | undefined): NodeType[] {
  const accepted = node ? definitionOf(node).acceptsInputKind : undefined;
  if (!accepted) return [];
  return Array.isArray(accepted) ? accepted : [accepted];
}

export function getNodeMaxInputCount(node: CanvasNode | null | undefined): number | undefined {
  return definitionOf(node).maxInputCount;
}

export function hasSlotLayout(node: CanvasNode | null | undefined): boolean {
  return !!definitionOf(node).slotLayout;
}

/** 按分类分组，供创建菜单与搜索面板使用 */
export function groupDefinitionsByCategory(defs: NodeDefinition[]): { category: NodeCategory; items: NodeDefinition[] }[] {
  const order: NodeCategory[] = ['生成', '输入', '文本', '组织', '工具'];
  return order
    .map((category) => ({ category, items: defs.filter((d) => d.category === category) }))
    .filter((g) => g.items.length > 0);
}

/** 创建节点时写入变体，基础变体不写，保持旧项目数据形态 */
export function variantPatchFor(variant: NodeVariant): { variant?: string } {
  const def = definitions.get(variant);
  if (!def) return {};
  return def.basic ? {} : { variant };
}

export function typeOfVariant(variant: NodeVariant): NodeType {
  return definitions.get(variant)?.type ?? 'text';
}

export function labelOfType(type: NodeType): string {
  return TYPE_LABELS[type];
}
