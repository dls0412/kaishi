import { create } from 'zustand';
import { localRequest } from './lib/modelTransport';
import { SERVICE_PRESETS } from './lib/modelCatalog';
import {
  DEFAULT_IMAGE_PARAMS,
  DEFAULT_SETTINGS,
  DEFAULT_VIDEO_PARAMS,
  edgeKindLabel,
  EMPTY_DATA,
  inferEdgeKind,
  isMediaNode,
  NODE_DEFAULTS,
  normalizeEdge,
  normalizeNodes,
  TYPE_LABELS,
  type AppSettings,
  type AssetMeta,
  type CanvasNode,
  type Edge,
  type EdgeKind,
  type GroupNode,
  type ImageGenParams,
  type MediaNode,
  type NodeType,
  type ProjectMeta,
  type ProjectSummary,
  type Snapshot,
  type TextNode,
  type VideoGenParams,
  type Viewport,
} from './types';
import {
  deleteProject as dbDeleteProject,
  getProject,
  listProjects,
  loadLastProjectId,
  loadSettings,
  readMirror,
  saveLastProjectId,
  saveProject,
  saveSettings,
  writeMirror,
} from './lib/db';
import { capabilitiesOf, defaultParamsFor, refreshPromptRefLabels, remapPromptRefTokens, removePromptRefByNodeId } from './lib/models';
import { BASIC_VARIANTS, getNodeDefinition, type NodeVariant } from './lib/nodeRegistry';
import { clamp, freeCanvasPosition, uid } from './lib/utils';
import { canvasApi } from './lib/canvasApi';

export type Tool = 'select' | 'hand';
export type SaveStatus = 'saved' | 'saving' | 'error';

export type NodePatch = Partial<Omit<TextNode, 'type' | 'id'>>
  & Partial<Omit<MediaNode, 'type' | 'id'>>
  & Partial<Omit<GroupNode, 'type' | 'id'>>;

export type ParamPatch = Partial<ImageGenParams> & Partial<VideoGenParams>;

const HISTORY_LIMIT = 80;
let pendingSnapshot: Snapshot | null = null;
let saveChain: Promise<void> = Promise.resolve();
let initPromise: Promise<void> | null = null;

function snapshot(s: CanvasState): Snapshot {
  return { nodes: s.nodes, edges: s.edges };
}

function historyPatch(s: CanvasState, before: Snapshot): Pick<CanvasState, 'past' | 'future'> {
  return { past: [...s.past, before].slice(-HISTORY_LIMIT), future: [] };
}

function cloneNodes(nodes: CanvasNode[]): CanvasNode[] {
  return JSON.parse(JSON.stringify(nodes)) as CanvasNode[];
}

function cloneEdges(edges: Edge[]): Edge[] {
  return JSON.parse(JSON.stringify(edges)) as Edge[];
}

/**
 * 复制节点时，把本节点内的引用身份按「复制产生的新 ID」重绑定。
 * - 来源节点一起被复制：引用指向新的来源节点，关系保持正确。
 * - 来源节点没被复制：保留原来的 nodeId，继续指向画布上仍存在的原来源。
 * - 连线用途与参考顺序的 key 同样按新 edgeId 重映射。
 */
function rebindNodeReferences(node: CanvasNode, nodeMap: Map<string, string>, edgeMap: Map<string, string>): CanvasNode {
  if (node.type !== 'image' && node.type !== 'video') return node;
  const rebind = (p?: ImageGenParams | VideoGenParams) => {
    if (!p) return p;
    return {
      ...p,
      // 引用标记里直接写着 nodeId，复制后必须连提示词文本一起重绑
      prompt: remapPromptRefTokens(p.prompt ?? '', nodeMap),
      promptRefs: (p.promptRefs ?? []).map((r) => {
        const mapped = nodeMap.get(r.nodeId);
        return mapped ? { ...r, nodeId: mapped } : { ...r };
      }),
      edgeRoles: Object.fromEntries(
        Object.entries(p.edgeRoles ?? {}).map(([edgeId, role]) => [edgeMap.get(edgeId) ?? edgeId, role]),
      ),
      refOrder: (p.refOrder ?? []).map((key) => {
        const [prefix, id] = key.split(':');
        if (prefix === 'edge' && edgeMap.has(id)) return `edge:${edgeMap.get(id)}`;
        return key;
      }),
    };
  };
  if (node.type === 'image') return { ...node, imageParams: rebind(node.imageParams) as ImageGenParams | undefined };
  return { ...node, videoParams: rebind(node.videoParams) as VideoGenParams | undefined };
}

/**
 * 断开连线后，移除该连线提供的用途、排序项，以及指向该来源节点的提示词引用标记。
 * 与 BeefTV 的 applyCanvasConnectionPromptSync 一致：引用随连线消失，不留幽灵输入。
 */
function clearEdgeInput(node: CanvasNode, edgeId: string, sourceNodeId?: string): CanvasNode {
  if (node.type !== 'image' && node.type !== 'video') return node;
  const strip = (p?: ImageGenParams | VideoGenParams) => {
    if (!p) return p;
    const edgeRoles = { ...(p.edgeRoles ?? {}) };
    delete edgeRoles[edgeId];
    const base = {
      ...p,
      edgeRoles,
      refOrder: (p.refOrder ?? []).filter((k) => k !== `edge:${edgeId}`),
    };
    if (!sourceNodeId) return base;
    const cleaned = removePromptRefByNodeId(base.prompt ?? '', base.promptRefs ?? [], sourceNodeId);
    return { ...base, prompt: cleaned.prompt, promptRefs: cleaned.promptRefs };
  };
  if (node.type === 'image') return { ...node, imageParams: strip(node.imageParams) as ImageGenParams | undefined };
  return { ...node, videoParams: strip(node.videoParams) as VideoGenParams | undefined };
}

/**
 * 连线或来源名称变化后刷新提示词引用标记，对应 BeefTV 的
 * applyCanvasConnectionPromptSync。标记身份是节点 ID，不需要按连线顺序
 * 重编号；这里只把显示名同步为来源节点的最新名称。
 */
function refreshAllPromptRefs(nodes: CanvasNode[]): CanvasNode[] {
  let changed = false;
  const next = nodes.map((n) => {
    if (n.type !== 'image' && n.type !== 'video') return n;
    const apply = (p?: ImageGenParams | VideoGenParams) => {
      if (!p || !(p.promptRefs ?? []).length) return p;
      const synced = refreshPromptRefLabels(p.prompt ?? '', p.promptRefs ?? [], nodes);
      if (!synced.changed) return p;
      changed = true;
      return { ...p, prompt: synced.prompt, promptRefs: synced.promptRefs };
    };
    if (n.type === 'image') return { ...n, imageParams: apply(n.imageParams) as ImageGenParams | undefined };
    return { ...n, videoParams: apply(n.videoParams) as VideoGenParams | undefined };
  });
  return changed ? next : nodes;
}

/** 只有改动了显示名相关的字段才需要刷新，拖动 / 缩放不走这条路径 */
function touchesRefLabel(patches: Record<string, NodePatch>): boolean {
  return Object.values(patches).some((p) => p.name !== undefined || p.text !== undefined || p.fileName !== undefined);
}

function topZ(nodes: CanvasNode[]): number {
  return nodes.reduce((max, n) => Math.max(max, n.z ?? 0), 0);
}

function bbox(nodes: CanvasNode[]) {
  if (!nodes.length) return { x: 0, y: 0, w: 0, h: 0 };
  const x1 = Math.min(...nodes.map((n) => n.x));
  const y1 = Math.min(...nodes.map((n) => n.y));
  const x2 = Math.max(...nodes.map((n) => n.x + n.w));
  const y2 = Math.max(...nodes.map((n) => n.y + n.h));
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export interface CanvasState {
  ready: boolean;
  projectId: string;
  projectName: string;
  projects: ProjectSummary[];
  assets: AssetMeta[];
  nodes: CanvasNode[];
  edges: Edge[];
  viewport: Viewport;
  selection: string[];
  selectedEdgeId: string | null;
  tool: Tool;
  settings: AppSettings;
  saveStatus: SaveStatus;
  lastSavedAt: number;
  past: Snapshot[];
  future: Snapshot[];
  clipboard: { nodes: CanvasNode[]; edges: Edge[] } | null;

  init: () => Promise<void>;
  persist: () => Promise<void>;
  refreshProjects: () => Promise<void>;

  setAssets: (assets: AssetMeta[]) => void;
  setTool: (tool: Tool) => void;
  setViewport: (vp: Viewport) => void;
  setSettings: (settings: AppSettings) => Promise<void>;
  setSaveStatus: (status: SaveStatus) => void;

  newProject: (name?: string) => Promise<void>;
  switchProject: (id: string) => Promise<void>;
  renameProject: (name: string) => void;
  removeProject: (id: string) => Promise<void>;
  loadImported: (project: ProjectMeta) => Promise<void>;

  setSelection: (ids: string[]) => void;
  toggleSelection: (id: string) => void;
  selectEdge: (id: string | null) => void;
  clearSelection: () => void;

  addNode: (node: CanvasNode) => void;
  addNodes: (nodes: CanvasNode[]) => void;
  updateNode: (id: string, patch: NodePatch) => void;
  updateNodesLive: (patches: Record<string, NodePatch>) => void;
  beginGesture: () => void;
  endGesture: () => void;
  deleteSelection: () => void;
  duplicateSelection: () => void;
  copySelection: () => void;
  paste: (at?: { x: number; y: number }) => void;
  createNode: (type: NodeType, at?: { x: number; y: number }, extra?: NodePatch) => string;
  createTextNode: (text: string, at?: { x: number; y: number }) => string;
  updateNodeParams: (id: string, patch: ParamPatch, live?: boolean) => void;
  fillNodeAsset: (id: string, assetId: string, fileName: string) => void;
  bringToFront: (ids?: string[]) => void;
  sendToBack: (ids?: string[]) => void;
  groupSelection: () => void;

  addEdge: (from: string, to: string) => void;
  updateEdge: (id: string, patch: Partial<Edge>) => void;
  deleteEdge: (id: string) => void;

  undo: () => void;
  redo: () => void;
  zoomBy: (factor: number, center?: { x: number; y: number }) => void;
  resetZoom: () => void;
  fitToContent: (size: { w: number; h: number }) => void;
  /** 借鉴 BeefTV「自动整理节点」：按连线依赖从左到右分层，层内按类型分泳道；进一次撤销历史 */
  arrangeNodes: (ids?: string[]) => void;
  /** 创作助手 / 外部 Agent 批量落方案：建节点、写提示词、连线只进一次撤销历史 */
  applyAgentPlan: (steps: AgentPlanStep[], anchor: { x: number; y: number }) => { nodeIds: string[]; edgeCount: number };
  /** 版本记录恢复：整批替换节点与连线，只进一次撤销历史 */
  loadSnapshot: (nodes: CanvasNode[], edges: Edge[]) => void;
}

/** 结构化方案步骤，connectTo 用步骤 key 表达真实输入关系 */
export interface AgentPlanStep {
  key: string;
  type: NodeType;
  name: string;
  text?: string;
  prompt?: string;
  connectTo?: string[];
}

export const useCanvas = create<CanvasState>((set, get) => {
  const commit = (updater: (s: CanvasState) => Partial<CanvasState>) => {
    set((s) => ({ ...updater(s), ...historyPatch(s, snapshot(s)) }));
  };

  return {
    ready: false,
    projectId: '',
    projectName: '未命名项目',
    projects: [],
    assets: [],
    nodes: [],
    edges: [],
    viewport: { ...EMPTY_DATA.viewport },
    selection: [],
    selectedEdgeId: null,
    tool: 'select',
    settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as AppSettings,
    saveStatus: 'saved',
    lastSavedAt: 0,
    past: [],
    future: [],
    clipboard: null,

    init: () => {
      if (initPromise) return initPromise;
      initPromise = (async () => {
        let settings = await loadSettings();
        if (!settings.services.length && !localStorage.getItem('kaishi:local-h3-import-checked')) {
          try {
            const imported = await localRequest<{ available: boolean }>('h3/import-local');
            if (imported.available) {
              const now = Date.now();
              const services = SERVICE_PRESETS.filter(preset => preset.id === 'h3-video' || preset.id === 'qwen-image').map(preset => ({
                id: preset.id, name: preset.serviceName, protocol: preset.protocol, baseUrl: preset.baseUrl,
                apiKey: 'kaishi-local-h3', enabled: true, note: '使用本机加密保存的 H3 工作台凭据', createdAt: now,
                models: preset.models.map(model => ({ ...model, enabled: true })),
                connection: { status: 'unverified' as const, checkedAt: 0, message: '尚未验证连接', endpoint: '' },
              }));
              settings = { ...settings, services, defaults: { ...settings.defaults, image: 'qwen-image::Qwen-Image', video: 'h3-video::MiniMax-H3' } };
              await saveSettings(settings);
            }
            localStorage.setItem('kaishi:local-h3-import-checked', '1');
          } catch { /* 非本机运行时或工作台不可用时，继续显示原设置 */ }
        }
        let projects = await listProjects();
        const lastId = await loadLastProjectId();
        let current = lastId ? await getProject(lastId) : undefined;
        if (!current && projects.length) current = await getProject(projects[0].id);
        if (!current) {
          const now = Date.now();
          current = {
            id: uid('prj'),
            name: '我的第一个项目',
            createdAt: now,
            updatedAt: now,
            data: JSON.parse(JSON.stringify(EMPTY_DATA)) as typeof EMPTY_DATA,
          };
          await saveProject(current);
          projects = await listProjects();
        }
        // 同步镜像兜底：改动后立刻刷新时，IndexedDB 可能还没落盘
        const mirror = readMirror();
        if (mirror && mirror.projectId === current.id && mirror.updatedAt > (current.updatedAt ?? 0)) {
          current = { ...current, name: mirror.projectName || current.name, updatedAt: mirror.updatedAt, data: mirror.data };
          await saveProject(current);
        }
        await saveLastProjectId(current.id);
        const restoredNodes = normalizeNodes(current.data?.nodes ?? []);
        const nodeById = new Map(restoredNodes.map((n) => [n.id, n]));
        const restoredEdges = (current.data?.edges ?? []).map((e) => normalizeEdge(e, nodeById.get(e.from), nodeById.get(e.to)));
        set({
          ready: true,
          settings,
          projects,
          projectId: current.id,
          projectName: current.name,
          nodes: restoredNodes,
          edges: restoredEdges,
          viewport: current.data?.viewport ?? { ...EMPTY_DATA.viewport },
          selection: [],
          selectedEdgeId: null,
          past: [],
          future: [],
        });
      })();
      return initPromise;
    },

    persist: () => {
      saveChain = saveChain.catch(() => undefined).then(async () => {
        const s = get();
        if (!s.projectId || !s.ready) return;
        set({ saveStatus: 'saving' });
        try {
          const existing = await getProject(s.projectId);
          const now = Date.now();
          const project: ProjectMeta = {
            id: s.projectId,
            name: s.projectName,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
            data: { nodes: s.nodes, edges: s.edges, viewport: s.viewport },
          };
          await saveProject(project);
          set({ saveStatus: 'saved', lastSavedAt: now, projects: await listProjects() });
        } catch (err) {
          console.error('自动保存失败', err);
          set({ saveStatus: 'error' });
        }
      });
      return saveChain;
    },

    refreshProjects: async () => set({ projects: await listProjects() }),

    setAssets: (assets) => set({ assets }),
    setTool: (tool) => set({ tool }),
    setViewport: (viewport) => set({ viewport }),
    setSaveStatus: (saveStatus) => set({ saveStatus }),
    setSettings: async (settings) => {
      set({ settings });
      await saveSettings(settings);
    },

    newProject: async (name) => {
      await get().persist();
      const now = Date.now();
      const project: ProjectMeta = {
        id: uid('prj'),
        name: (name ?? '').trim() || `未命名项目 ${get().projects.length + 1}`,
        createdAt: now,
        updatedAt: now,
        data: JSON.parse(JSON.stringify(EMPTY_DATA)) as typeof EMPTY_DATA,
      };
      await saveProject(project);
      await saveLastProjectId(project.id);
      set({
        projectId: project.id,
        projectName: project.name,
        nodes: [],
        edges: [],
        viewport: { ...EMPTY_DATA.viewport },
        selection: [],
        selectedEdgeId: null,
        past: [],
        future: [],
      });
      await get().persist();
    },

    switchProject: async (id) => {
      if (id === get().projectId) return;
      await get().persist();
      const project = await getProject(id);
      if (!project) return;
      await saveLastProjectId(id);
      const ns = normalizeNodes(project.data?.nodes ?? []);
      const map = new Map(ns.map((n) => [n.id, n]));
      const es = (project.data?.edges ?? []).map((e) => normalizeEdge(e, map.get(e.from), map.get(e.to)));
      set({
        projectId: project.id,
        projectName: project.name,
        nodes: ns,
        edges: es,
        viewport: project.data?.viewport ?? { ...EMPTY_DATA.viewport },
        selection: [],
        selectedEdgeId: null,
        past: [],
        future: [],
      });
    },

    renameProject: (name) => {
      const clean = name.trim() || '未命名项目';
      set({ projectName: clean });
    },

    removeProject: async (id) => {
      if (id === get().projectId) {
        const next = (await listProjects()).find(project => project.id !== id);
        if (next) await get().switchProject(next.id);
        else await get().newProject('我的第一个项目');
        // Switching saves the old project. Delete it after pending writes have finished.
        await saveChain;
      }
      await dbDeleteProject(id);
      set({ projects: await listProjects() });
    },

    loadImported: async (project) => {
      await get().persist();
      await saveLastProjectId(project.id);
      const ns = normalizeNodes(project.data.nodes ?? []);
      const map = new Map(ns.map((n) => [n.id, n]));
      const es = (project.data.edges ?? []).map((e) => normalizeEdge(e, map.get(e.from), map.get(e.to)));
      set({
        projectId: project.id,
        projectName: project.name,
        nodes: ns,
        edges: es,
        viewport: project.data.viewport,
        selection: [],
        selectedEdgeId: null,
        past: [],
        future: [],
      });
      await get().persist();
    },

    setSelection: (ids) => set({ selection: [...new Set(ids)], selectedEdgeId: null }),
    toggleSelection: (id) => set((s) => ({
      selection: s.selection.includes(id) ? s.selection.filter((x) => x !== id) : [...s.selection, id],
      selectedEdgeId: null,
    })),
    selectEdge: (selectedEdgeId) => set({ selectedEdgeId, selection: [] }),
    clearSelection: () => set({ selection: [], selectedEdgeId: null }),

    addNode: (node) => commit((s) => ({ nodes: [...s.nodes, { ...node, z: topZ(s.nodes) + 1 }], selection: [node.id], selectedEdgeId: null })),
    addNodes: (added) => commit((s) => {
      const base = topZ(s.nodes);
      const withZ = added.map((n, i) => ({ ...n, z: base + i + 1 }));
      return { nodes: [...s.nodes, ...withZ], selection: withZ.map((n) => n.id), selectedEdgeId: null };
    }),

    updateNode: (id, patch) => commit((s) => {
      let nodes = s.nodes.map((n) => (n.id === id ? ({ ...n, ...patch } as CanvasNode) : n));
      if (touchesRefLabel({ [id]: patch })) nodes = refreshAllPromptRefs(nodes);
      return { nodes };
    }),

    updateNodesLive: (patches) => set((s) => {
      let nodes = s.nodes.map((n) => (patches[n.id] ? ({ ...n, ...patches[n.id] } as CanvasNode) : n));
      if (touchesRefLabel(patches)) nodes = refreshAllPromptRefs(nodes);
      return { nodes };
    }),

    beginGesture: () => { pendingSnapshot = snapshot(get()); },
    endGesture: () => {
      const before = pendingSnapshot;
      pendingSnapshot = null;
      if (!before) return;
      const s = get();
      if (before.nodes === s.nodes && before.edges === s.edges) return;
      set(historyPatch(s, before));
    },

    deleteSelection: () => commit((s) => {
      const ids = new Set(s.selection);
      const removed = s.edges.filter((e) => ids.has(e.from) || ids.has(e.to) || e.id === s.selectedEdgeId);
      const removedEdgeIds = removed.map((e) => e.id);
      const sourceByEdge = new Map(removed.map((e) => [e.id, e.from]));
      return {
        // 只断线时清掉该来源的引用标记；来源节点整个被删时保留标记并明确报失效，
        // 不静默伪装成有效内容。
        nodes: refreshAllPromptRefs(s.nodes
          .filter((n) => !ids.has(n.id))
          .map((n) => removedEdgeIds.reduce((acc, eid) => {
            const from = sourceByEdge.get(eid);
            return clearEdgeInput(acc, eid, from && !ids.has(from) ? from : undefined);
          }, n))),
        edges: s.edges.filter((e) => !removedEdgeIds.includes(e.id)),
        selection: [],
        selectedEdgeId: null,
      };
    }),

    copySelection: () => {
      const s = get();
      const ids = new Set(s.selection);
      if (!ids.size) return;
      set({
        clipboard: {
          nodes: cloneNodes(s.nodes.filter((n) => ids.has(n.id))),
          edges: cloneEdges(s.edges.filter((e) => ids.has(e.from) && ids.has(e.to))),
        },
      });
    },

    paste: (at) => commit((s) => {
      const clip = s.clipboard;
      if (!clip?.nodes.length) return {};
      const map = new Map<string, string>();
      const edgeMap = new Map<string, string>();
      const box = bbox(clip.nodes);
      const dx = at ? at.x - box.x : 32;
      const dy = at ? at.y - box.y : 32;
      const base = topZ(s.nodes);
      // 先建立全量 ID 映射，再统一重绑定引用，避免复制顺序影响绑定结果
      clip.nodes.forEach((n) => map.set(n.id, uid('n')));
      clip.edges.forEach((e) => edgeMap.set(e.id, uid('e')));
      const nodes = clip.nodes.map((n, i) => {
        const id = map.get(n.id)!;
        return rebindNodeReferences({ ...n, id, x: n.x + dx, y: n.y + dy, z: base + i + 1 } as CanvasNode, map, edgeMap);
      });
      const edges = clip.edges.map((e) => ({
        ...e,
        id: edgeMap.get(e.id)!,
        from: map.get(e.from) ?? e.from,
        to: map.get(e.to) ?? e.to,
      }));
      return { nodes: [...s.nodes, ...nodes], edges: [...s.edges, ...edges], selection: nodes.map((n) => n.id), selectedEdgeId: null };
    }),

    duplicateSelection: () => {
      get().copySelection();
      get().paste();
    },

    createNode: (type, at, extra) => {
      const id = uid(type === 'group' ? 'g' : 'n');
      const current = get();
      // 新建节点取「各类型默认模型」，之后修改默认不影响已有节点
      const boundKey = (type === 'image' || type === 'video') ? (current.settings.defaults[type] ?? '') : '';
      const boundCaps = boundKey ? capabilitiesOf(current.settings, boundKey) : null;
      commit((s) => {
      // 尺寸、默认标题与图标统一由注册表给出，不再散落在创建菜单 / 属性面板里
      const variant = (extra?.variant as NodeVariant | undefined) ?? BASIC_VARIANTS[type];
      const def = getNodeDefinition(variant);
      const size = def?.defaultSize ?? NODE_DEFAULTS[type];
      const center = at ?? canvasApi.centerWorld();
      const position = { x: center.x - size.w / 2, y: center.y - size.h / 2 };
      const placed = at ? position : freeCanvasPosition(s.nodes, position, size);
      const index = s.nodes.filter((n) => n.type === type).length + 1;
      const title = def && !def.basic ? def.defaultTitle : TYPE_LABELS[type];
      const base = {
        id, type, ...placed,
        w: size.w, h: size.h, z: topZ(s.nodes) + 1,
        name: `${title} ${index}`,
      };
        let node: CanvasNode;
        if (type === 'text') {
          node = { ...base, type: 'text', text: '', fontSize: 18, color: '#1e293b', bg: '#ffffff', bold: false, align: 'left' };
        } else if (type === 'image') {
          node = { ...base, type: 'image', assetId: '', fileName: '', fit: 'contain', imageParams: defaultParamsFor(boundKey, 'image', boundCaps) };
        } else if (type === 'video') {
          node = { ...base, type: 'video', assetId: '', fileName: '', fit: 'contain', videoParams: defaultParamsFor(boundKey, 'video', boundCaps) };
        } else if (type === 'audio') {
          node = { ...base, type: 'audio', assetId: '', fileName: '', fit: 'contain', audioModelKey: current.settings.defaults.audio || 'builtin:indextts' };
        } else {
          node = { ...base, type: 'group', color: '#8b5cf6' };
        }
        if (extra) node = { ...node, ...extra } as CanvasNode;
        return { nodes: [...s.nodes, node], selection: [id], selectedEdgeId: null };
      });
      return id;
    },

    createTextNode: (text, at) => {
      const clean = text.replace(/\r/g, '').trim();
      return get().createNode('text', at, {
        text: clean,
        name: clean.slice(0, 12) || '粘贴文本',
        fontSize: 16,
      });
    },

    updateNodeParams: (id, patch, live = false) => {
      const apply = (s: CanvasState): Partial<CanvasState> => ({
        nodes: s.nodes.map((n) => {
          if (n.id !== id) return n;
          if (n.type === 'image') {
            const oldParams = n.imageParams ?? DEFAULT_IMAGE_PARAMS;
            const nextParams = { ...oldParams, ...patch };
            const changed = JSON.stringify(oldParams) !== JSON.stringify(nextParams);
            const resultStale = n.resultStale || (changed && !!n.assetId && n.nodeRole === 'generator');
            return { ...n, imageParams: nextParams, resultStale };
          }
          if (n.type === 'video') {
            const oldParams = n.videoParams ?? DEFAULT_VIDEO_PARAMS;
            const nextParams = { ...oldParams, ...patch };
            const changed = JSON.stringify(oldParams) !== JSON.stringify(nextParams);
            const resultStale = n.resultStale || (changed && !!n.assetId && n.nodeRole === 'generator');
            return { ...n, videoParams: nextParams, resultStale };
          }
          return n;
        }),
      });
      if (live) set(apply); else commit(apply);
    },

    /** 把素材放进节点，只是内容填充，不改变任何交互能力 */
    fillNodeAsset: (id, assetId, fileName) => commit((s) => ({
      nodes: s.nodes.map((n) => (n.id === id && isMediaNode(n)
        ? { ...n, assetId, fileName, resultAssetIds: undefined, resultStale: false, resultInputSnapshot: undefined, name: fileName || n.name }
        : n)),
    })),

    bringToFront: (ids) => commit((s) => {
      const target = new Set(ids ?? s.selection);
      if (!target.size) return {};
      const base = topZ(s.nodes);
      let i = 0;
      return { nodes: s.nodes.map((n) => (target.has(n.id) ? { ...n, z: base + (++i) } : n)) };
    }),

    sendToBack: (ids) => commit((s) => {
      const target = new Set(ids ?? s.selection);
      if (!target.size) return {};
      const min = s.nodes.reduce((m, n) => Math.min(m, n.z ?? 0), 0);
      let i = 0;
      return { nodes: s.nodes.map((n) => (target.has(n.id) ? { ...n, z: min - target.size + (++i) } : n)) };
    }),

    groupSelection: () => commit((s) => {
      const ids = new Set(s.selection);
      const members = s.nodes.filter((n) => ids.has(n.id) && n.type !== 'group');
      if (members.length < 1) return {};
      const box = bbox(members);
      const pad = 36;
      const group: GroupNode = {
        id: uid('g'), type: 'group',
        x: box.x - pad, y: box.y - pad - 26,
        w: Math.max(240, box.w + pad * 2), h: Math.max(160, box.h + pad * 2 + 26),
        z: s.nodes.reduce((m, n) => Math.min(m, n.z ?? 0), 0) - 1,
        name: '新建分组', color: '#8b5cf6',
      };
      return { nodes: [...s.nodes, group], selection: [group.id], selectedEdgeId: null };
    }),

    addEdge: (from, to) => commit((s) => {
      if (from === to) return {};
      const fromNode = s.nodes.find((n) => n.id === from);
      const toNode = s.nodes.find((n) => n.id === to);
      if (!fromNode || !toNode) return {};
      if (s.edges.some((e) => e.from === from && e.to === to)) return {};
      const kind = inferEdgeKind(fromNode, toNode);
      const color = kind === 'text-input' ? '#8a8a94' : kind === 'image-ref' ? '#777781' : '#6c6c76';
      const edge: Edge = { id: uid('e'), from, to, kind, label: edgeKindLabel(kind), color };
      // 新连线不会让按节点 ID 绑定的引用失效，但顺带把标记的显示名对齐来源现状
      return { edges: [...s.edges, edge], nodes: refreshAllPromptRefs(s.nodes), selectedEdgeId: edge.id, selection: [] };
    }),

    updateEdge: (id, patch) => commit((s) => ({
      edges: s.edges.map((e) => (e.id === id ? { ...e, ...patch } : e)),
    })),

    deleteEdge: (id) => commit((s) => {
      const sourceId = s.edges.find((e) => e.id === id)?.from;
      return {
        edges: s.edges.filter((e) => e.id !== id),
        // 连线消失后，它提供的用途与提示词引用一并移除；旧版手选素材原样保留
        nodes: refreshAllPromptRefs(s.nodes.map((n) => clearEdgeInput(n, id, sourceId))),
        selectedEdgeId: s.selectedEdgeId === id ? null : s.selectedEdgeId,
      };
    }),

    undo: () => set((s) => {
      const before = s.past[s.past.length - 1];
      if (!before) return {};
      const ids = new Set(before.nodes.map((n) => n.id));
      const edgeIds = new Set(before.edges.map((e) => e.id));
      return {
        nodes: before.nodes,
        edges: before.edges,
        past: s.past.slice(0, -1),
        future: [snapshot(s), ...s.future].slice(0, HISTORY_LIMIT),
        selection: s.selection.filter((id) => ids.has(id)),
        selectedEdgeId: s.selectedEdgeId && edgeIds.has(s.selectedEdgeId) ? s.selectedEdgeId : null,
      };
    }),

    redo: () => set((s) => {
      const next = s.future[0];
      if (!next) return {};
      const ids = new Set(next.nodes.map((n) => n.id));
      return {
        nodes: next.nodes,
        edges: next.edges,
        past: [...s.past, snapshot(s)].slice(-HISTORY_LIMIT),
        future: s.future.slice(1),
        selection: s.selection.filter((id) => ids.has(id)),
        selectedEdgeId: null,
      };
    }),

    zoomBy: (factor, center) => set((s) => {
      const vp = s.viewport;
      const next = clamp(vp.zoom * factor, 0.1, 4);
      if (next === vp.zoom) return {};
      const cx = center?.x ?? 0;
      const cy = center?.y ?? 0;
      const ratio = next / vp.zoom;
      return { viewport: { zoom: next, x: cx - (cx - vp.x) * ratio, y: cy - (cy - vp.y) * ratio } };
    }),

    resetZoom: () => set((s) => {
      const vp = s.viewport;
      const view = canvasApi.viewportSize();
      const cx = view.w / 2;
      const cy = view.h / 2;
      const ratio = 1 / vp.zoom;
      return { viewport: { zoom: 1, x: cx - (cx - vp.x) * ratio, y: cy - (cy - vp.y) * ratio } };
    }),

    fitToContent: (size) => set((s) => {
      if (!s.nodes.length) return { viewport: { x: 0, y: 0, zoom: 1 } };
      const box = bbox(s.nodes);
      const zoom = clamp(Math.min(size.w / (box.w + 160), size.h / (box.h + 160)), 0.1, 2);
      return {
        viewport: {
          zoom,
          x: size.w / 2 - (box.x + box.w / 2) * zoom,
          y: size.h / 2 - (box.y + box.h / 2) * zoom,
        },
      };
    }),

    arrangeNodes: (ids) => commit((s) => {
      const chosen = ids?.length
        ? new Set(ids)
        : (s.selection.length >= 2 ? new Set(s.selection) : null);
      const movable = s.nodes.filter((n) => n.type !== 'group' && (!chosen || chosen.has(n.id)));
      if (movable.length < 2) return {};
      const anchorX = Math.min(...movable.map((n) => n.x));
      const anchorY = Math.min(...movable.map((n) => n.y));
      const involved = new Set(movable.map((n) => n.id));
      const links = s.edges.filter((e) => involved.has(e.from) && involved.has(e.to));
      const TYPE_ORDER: CanvasNode['type'][] = ['text', 'image', 'video', 'audio'];
      const COL_GAP = 80;
      const ROW_GAP = 40;
      const patches: Record<string, NodePatch> = {};

      if (links.length) {
        // 拓扑分层；有环时剩余节点留在第 0 层，不让整理卡住
        const indegree = new Map(movable.map((n) => [n.id, 0]));
        links.forEach((e) => indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1));
        const level = new Map<string, number>();
        const queue = movable.filter((n) => (indegree.get(n.id) ?? 0) === 0).map((n) => n.id);
        queue.forEach((id) => level.set(id, 0));
        while (queue.length) {
          const id = queue.shift()!;
          const cur = level.get(id) ?? 0;
          links.filter((e) => e.from === id).forEach((e) => {
            level.set(e.to, Math.max(level.get(e.to) ?? 0, cur + 1));
            const left = (indegree.get(e.to) ?? 1) - 1;
            indegree.set(e.to, left);
            if (left <= 0) queue.push(e.to);
          });
        }
        movable.forEach((n) => { if (!level.has(n.id)) level.set(n.id, 0); });
        const columns = new Map<number, CanvasNode[]>();
        movable.forEach((n) => {
          const l = level.get(n.id) ?? 0;
          if (!columns.has(l)) columns.set(l, []);
          columns.get(l)!.push(n);
        });
        let x = anchorX;
        [...columns.keys()].sort((a, b) => a - b).forEach((l) => {
          const column = columns.get(l)!.sort((a, b) =>
            TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) || a.y - b.y);
          let y = anchorY;
          let maxW = 0;
          column.forEach((n) => {
            patches[n.id] = { x, y };
            y += n.h + ROW_GAP;
            maxW = Math.max(maxW, n.w);
          });
          x += maxW + COL_GAP;
        });
      } else {
        // 无连线时按类型分列，同类节点按原纵坐标排，避免重排成完全陌生的宫格
        let x = anchorX;
        TYPE_ORDER.forEach((t) => {
          const column = movable.filter((n) => n.type === t).sort((a, b) => a.y - b.y);
          if (!column.length) return;
          let y = anchorY;
          let maxW = 0;
          column.forEach((n) => {
            patches[n.id] = { x, y };
            y += n.h + ROW_GAP;
            maxW = Math.max(maxW, n.w);
          });
          x += maxW + COL_GAP;
        });
      }
      if (!Object.keys(patches).length) return {};
      return { nodes: s.nodes.map((n) => (patches[n.id] ? { ...n, ...patches[n.id] } : n)) };
    }),

    applyAgentPlan: (steps, anchor) => {
      const current = get();
      const valid = steps.filter((s) => !!s && typeof s.key === 'string' && !!s.key);
      if (!valid.length) return { nodeIds: [], edgeCount: 0 };
      const baseZ = topZ(current.nodes);
      const created: CanvasNode[] = [];
      const keyToId = new Map<string, string>();
      const nodeIds: string[] = [];
      const COL_GAP = 110;
      const ROW_GAP = 46;

      const meta = valid.map((step) => {
        const type: NodeType = (['text', 'image', 'video', 'audio'] as NodeType[]).includes(step.type) ? step.type : 'text';
        const def = getNodeDefinition(BASIC_VARIANTS[type]);
        return { step, type, size: def?.defaultSize ?? NODE_DEFAULTS[type] };
      });
      const byKey = new Map(valid.map((s) => [s.key, s]));

      // 按 connectTo 依赖分层：上游在左，下游在右，同层纵向排开。
      // 循环引用时用有限轮次自然收敛，不把节点丢掉也不无限递归。
      const levels = new Map<string, number>();
      valid.forEach((s) => levels.set(s.key, 0));
      for (let pass = 0; pass < valid.length; pass += 1) {
        let changed = false;
        valid.forEach((s) => {
          const ups = (s.connectTo ?? []).filter((k) => byKey.has(k) && k !== s.key);
          if (!ups.length) return;
          const next = 1 + Math.max(...ups.map((k) => levels.get(k) ?? 0));
          if (next > (levels.get(s.key) ?? 0) && next <= valid.length) {
            levels.set(s.key, next);
            changed = true;
          }
        });
        if (!changed) break;
      }
      const groups = new Map<number, typeof meta>();
      meta.forEach((m) => {
        const l = levels.get(m.step.key) ?? 0;
        if (!groups.has(l)) groups.set(l, []);
        groups.get(l)!.push(m);
      });
      const sortedLevels = [...groups.keys()].sort((a, b) => a - b);
      const totalW = sortedLevels.reduce((sum, l) => sum + Math.max(...groups.get(l)!.map((m) => m.size.w)), 0)
        + Math.max(0, sortedLevels.length - 1) * COL_GAP;
      let columnX = anchor.x - totalW / 2;
      const posByKey = new Map<string, { x: number; y: number }>();
      sortedLevels.forEach((l) => {
        const group = groups.get(l)!;
        const colW = Math.max(...group.map((m) => m.size.w));
        const totalH = group.reduce((sum, m) => sum + m.size.h, 0) + (group.length - 1) * ROW_GAP;
        let y = anchor.y - totalH / 2;
        group.forEach((m) => {
          posByKey.set(m.step.key, { x: columnX + colW / 2, y: y + m.size.h / 2 });
          y += m.size.h + ROW_GAP;
        });
        columnX += colW + COL_GAP;
      });

      meta.forEach(({ step, type, size }, i) => {
        const at = posByKey.get(step.key) ?? anchor;
        const id = uid('n');
        const boundKey = type === 'image' || type === 'video' ? (current.settings.defaults[type] ?? '') : '';
        const boundCaps = boundKey ? capabilitiesOf(current.settings, boundKey) : null;
        const base = {
          id, type, x: at.x - size.w / 2, y: at.y - size.h / 2,
          w: size.w, h: size.h, z: baseZ + i + 1,
          name: step.name || TYPE_LABELS[type],
        };
        let node: CanvasNode;
        if (type === 'text') {
          node = { ...base, type: 'text', text: step.text ?? step.prompt ?? '', fontSize: 16, color: '#1e293b', bg: '#ffffff', bold: false, align: 'left' };
        } else if (type === 'image') {
          node = { ...base, type: 'image', assetId: '', fileName: '', fit: 'contain',
            imageParams: { ...defaultParamsFor(boundKey, 'image', boundCaps), ...(step.prompt ? { prompt: step.prompt } : {}) } };
        } else if (type === 'video') {
          node = { ...base, type: 'video', assetId: '', fileName: '', fit: 'contain',
            videoParams: { ...defaultParamsFor(boundKey, 'video', boundCaps), ...(step.prompt ? { prompt: step.prompt } : {}) } };
        } else {
          node = { ...base, type: 'audio', assetId: '', fileName: '', fit: 'contain' };
        }
        created.push(node);
        keyToId.set(step.key, id);
        nodeIds.push(id);
      });

      const byId = new Map(created.map((n) => [n.id, n]));
      const edges: Edge[] = [];
      valid.forEach((step) => {
        const to = keyToId.get(step.key);
        const toNode = to ? byId.get(to) : undefined;
        if (!to || !toNode) return;
        (step.connectTo ?? []).forEach((fromKey) => {
          const from = keyToId.get(fromKey);
          const fromNode = from ? byId.get(from) : undefined;
          if (!from || !fromNode || from === to) return;
          if (edges.some((e) => e.from === from && e.to === to)) return;
          const kind = inferEdgeKind(fromNode, toNode);
          const color = kind === 'text-input' ? '#8a8a94' : kind === 'image-ref' ? '#777781' : '#6c6c76';
          edges.push({ id: uid('e'), from, to, kind, label: edgeKindLabel(kind), color });
        });
      });

      // 整批只 commit 一次：用户在助手里点一次「确认落到画布」，撤销也只回退一次
      commit((s) => ({
        nodes: [...s.nodes, ...created],
        edges: [...s.edges, ...edges],
        selection: nodeIds,
        selectedEdgeId: null,
      }));
      return { nodeIds, edgeCount: edges.length };
    },

    loadSnapshot: (nodes, edges) => commit(() => ({
      nodes: JSON.parse(JSON.stringify(nodes)) as CanvasNode[],
      edges: JSON.parse(JSON.stringify(edges)) as Edge[],
      selection: [], selectedEdgeId: null,
    })),
  };
});

export function nodesInGroup(group: GroupNode, nodes: CanvasNode[]): string[] {
  return nodes
    .filter((n) => n.type !== 'group' && n.x + n.w / 2 >= group.x && n.x + n.w / 2 <= group.x + group.w
      && n.y + n.h / 2 >= group.y && n.y + n.h / 2 <= group.y + group.h)
    .map((n) => n.id);
}

export function assetIdsOf(nodes: CanvasNode[]): string[] {
  const ids = new Set<string>();
  nodes.forEach((n) => {
    if (isMediaNode(n) && n.assetId) ids.add(n.assetId);
    if (isMediaNode(n)) n.resultAssetIds?.forEach(id => { if (id) ids.add(id); });
    const p = n.type === 'image' ? n.imageParams : n.type === 'video' ? n.videoParams : undefined;
    p?.references?.forEach((r) => { if (r.assetId) ids.add(r.assetId); });
    // 兼容旧字段
    const legacy = p as unknown as { referenceAssetIds?: string[] } | undefined;
    legacy?.referenceAssetIds?.forEach((id) => ids.add(id));
  });
  return [...ids];
}

export interface ConnectedInput {
  edgeId: string;
  kind: EdgeKind;
  fromId: string;
  name: string;
  text: string;
  assetId: string;
  fileName: string;
}

/** 输入关系完全由连线派生，断开连线或删除来源节点后自动消失 */
export function connectedInputs(nodeId: string, nodes: CanvasNode[], edges: Edge[]): ConnectedInput[] {
  const target = nodes.find((n) => n.id === nodeId);
  const result: ConnectedInput[] = [];
  edges.filter((e) => e.to === nodeId).forEach((e) => {
    const src = nodes.find((n) => n.id === e.from);
    if (!src) return;
    result.push({
      edgeId: e.id,
      kind: e.kind ?? inferEdgeKind(src, target),
      fromId: src.id,
      name: src.name || '',
      text: src.type === 'text' ? src.text : '',
      assetId: isMediaNode(src) ? src.assetId : '',
      fileName: isMediaNode(src) ? src.fileName : '',
    });
  });
  return result;
}

/* 每次画布状态变更立即同步写入 localStorage，刷新时不会丢失未落盘的改动 */
useCanvas.subscribe((state, prev) => {
  if (!state.ready || !state.projectId) return;
  const changed = state.nodes !== prev.nodes || state.edges !== prev.edges
    || state.viewport !== prev.viewport || state.projectName !== prev.projectName
    || state.projectId !== prev.projectId;
  if (!changed) return;
  writeMirror({
    projectId: state.projectId,
    projectName: state.projectName,
    updatedAt: Date.now(),
    data: { nodes: state.nodes, edges: state.edges, viewport: state.viewport },
  });
});

export function defaultNodeSize(type: CanvasNode['type']) {
  return NODE_DEFAULTS[type];
}
