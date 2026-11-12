/** Legacy browser harness used only by development regression checks. */
import { useCanvas } from '../store';
import { BUILTIN_SKILLS, applyPlanToCanvas, type CanvasPlan } from './skills';
import { config, idempotentRun, listConnections, logEvent } from './workbenchRuntime';
import type { CanvasNode, CanvasSkill, NodeType } from '../types';

/** 写策略：没有启用任何外部连接时不额外限制；有连接时按该连接的只读/幂等设置执行 */
export interface AgentWritePolicy {
  readOnly: boolean;
  requireOperationId: boolean;
}

let policyOverride: Partial<AgentWritePolicy> | null = null;
let lastRejection = '';

function currentPolicy(): AgentWritePolicy {
  if (policyOverride && policyOverride.readOnly !== undefined && policyOverride.requireOperationId !== undefined) {
    return { readOnly: policyOverride.readOnly, requireOperationId: policyOverride.requireOperationId };
  }
  const conns = listConnections().filter((c) => c.enabled);
  if (!conns.length) {
    return {
      readOnly: policyOverride?.readOnly ?? false,
      requireOperationId: policyOverride?.requireOperationId ?? false,
    };
  }
  const cfg = config().agentConfig;
  return {
    readOnly: policyOverride?.readOnly ?? (cfg.readOnlyExternal || conns[0].mode === 'read-only'),
    requireOperationId: policyOverride?.requireOperationId ?? cfg.idempotencyRequired,
  };
}

/**
 * 所有写方法统一过这道闸：
 *  - 只读连接：直接拒绝，不写画布、不回显成功
 *  - 要求幂等键：缺键拒绝；同键同载荷回放原结果，不重复建节点；同键不同载荷拒绝
 */
function guarded<T>(label: string, payload: unknown, operationId: string | undefined, fn: () => T, fallback: T): T {
  const p = currentPolicy();
  if (p.readOnly) {
    lastRejection = '只读连接禁止写操作';
    logEvent('external-agent', `拒绝写操作：${label}`, lastRejection);
    return fallback;
  }
  if (!p.requireOperationId) return fn();
  const run = idempotentRun(operationId ?? '', payload, fn);
  if (!run.ok) {
    lastRejection = run.error === 'missing_operation_id'
      ? '缺少幂等键 operationId'
      : '幂等键冲突：同一个 operationId 不能提交不同内容';
    logEvent('external-agent', `拒绝写操作：${label}`, lastRejection);
    return fallback;
  }
  if (run.replayed) logEvent('external-agent', `回放写操作：${label}`, `operationId=${operationId}`);
  return run.result ?? fallback;
}

export interface AgentPlanInput {
  skillId?: string;
  goal?: string;
  steps: { key: string; type: NodeType; name: string; text?: string; prompt?: string; connectTo?: string[] }[];
}

export interface CanvasAgentApi {
  version: string;
  /** 临时覆盖写策略，用于连接前验证；resetPolicy() 恢复按连接配置判断 */
  configure: (patch: Partial<AgentWritePolicy>) => AgentWritePolicy;
  resetPolicy: () => AgentWritePolicy;
  getPolicy: () => AgentWritePolicy;
  lastError: () => string;
  describe: () => Record<string, unknown>;
  getSnapshot: () => { project: string; viewport: unknown; nodes: CanvasNode[]; edges: unknown[] };
  listNodes: () => { id: string; type: string; name: string; x: number; y: number }[];
  getNode: (id: string) => CanvasNode | null;
  listSkills: () => { id: string; name: string; enabled: boolean; requires: string; builtin: boolean }[];
  createNode: (type: NodeType, at: { x: number; y: number }, options?: { name?: string; text?: string; prompt?: string; operationId?: string }) => string;
  updateNode: (id: string, patch: Record<string, unknown>, operationId?: string) => boolean;
  deleteNode: (id: string, operationId?: string) => boolean;
  connect: (fromId: string, toId: string, operationId?: string) => boolean;
  disconnect: (edgeId: string, operationId?: string) => boolean;
  setPrompt: (nodeId: string, prompt: string, operationId?: string) => boolean;
  setModel: (nodeId: string, modelKey: string, operationId?: string) => boolean;
  applyPlan: (plan: AgentPlanInput, operationId?: string) => { nodeIds: string[]; edgeCount: number };
}

declare global {
  interface Window { __canvasAgent?: CanvasAgentApi }
}

const VERSION = '1.0.0';

export function installCanvasAgentApi(): void {
  if (typeof window === 'undefined') return;
  const api: CanvasAgentApi = {
    version: VERSION,
    configure: (patch) => {
      policyOverride = { ...(policyOverride ?? {}), ...patch };
      lastRejection = '';
      return currentPolicy();
    },
    resetPolicy: () => { policyOverride = null; lastRejection = ''; return currentPolicy(); },
    getPolicy: () => currentPolicy(),
    lastError: () => lastRejection,
    describe: () => ({
      name: '开视开发验收接口',
      version: VERSION,
      transport: '浏览器内 window.__canvasAgent，需要 CDP / Playwright 连接到已打开的页面',
      note: '仅开发环境；正式客户端通过开视 MCP 接入',
      writePolicy: currentPolicy(),
      methods: ['configure', 'resetPolicy', 'getPolicy', 'lastError', 'describe', 'getSnapshot', 'listNodes', 'getNode', 'listSkills', 'createNode', 'updateNode', 'deleteNode', 'connect', 'disconnect', 'setPrompt', 'setModel', 'applyPlan'],
    }),
    getSnapshot: () => {
      const s = useCanvas.getState();
      return { project: s.projectName, viewport: s.viewport, nodes: s.nodes, edges: s.edges };
    },
    listNodes: () => useCanvas.getState().nodes.map((n) => ({
      id: n.id, type: n.type, name: n.name, x: n.x, y: n.y,
    })),
    getNode: (id) => useCanvas.getState().nodes.find((n) => n.id === id) ?? null,
    listSkills: () => {
      const fromSettings = useCanvas.getState().settings.skills ?? [];
      const list: CanvasSkill[] = fromSettings.length ? fromSettings : BUILTIN_SKILLS;
      return list.map((s) => ({ id: s.id, name: s.name, enabled: s.enabled, requires: s.requires, builtin: s.builtin }));
    },
    createNode: (type, at, options) => guarded('createNode', { type, at, options: { ...options, operationId: undefined } }, options?.operationId, () => {
      const st = useCanvas.getState();
      const id = type === 'text'
        ? st.createTextNode(options?.text ?? options?.name ?? '新文本', at)
        : st.createNode(type, at);
      const patch: Record<string, unknown> = {};
      if (options?.name) patch.name = options.name;
      if (Object.keys(patch).length) st.updateNode(id, patch);
      if (options?.prompt && (type === 'image' || type === 'video')) st.updateNodeParams(id, { prompt: options.prompt });
      return id;
    }, ''),
    updateNode: (id, patch, operationId) => guarded('updateNode', { id, patch }, operationId, () => {
      const st = useCanvas.getState();
      if (!st.nodes.some((n) => n.id === id)) return false;
      st.updateNode(id, patch);
      return true;
    }, false),
    deleteNode: (id, operationId) => guarded('deleteNode', { id }, operationId, () => {
      const st = useCanvas.getState();
      if (!st.nodes.some((n) => n.id === id)) return false;
      st.setSelection([id]);
      st.deleteSelection();
      return true;
    }, false),
    connect: (fromId, toId, operationId) => guarded('connect', { fromId, toId }, operationId, () => {
      const st = useCanvas.getState();
      if (!st.nodes.some((n) => n.id === fromId) || !st.nodes.some((n) => n.id === toId)) return false;
      if (st.edges.some((e) => e.from === fromId && e.to === toId)) return false;
      st.addEdge(fromId, toId);
      return true;
    }, false),
    disconnect: (edgeId, operationId) => guarded('disconnect', { edgeId }, operationId, () => {
      const st = useCanvas.getState();
      if (!st.edges.some((e) => e.id === edgeId)) return false;
      st.deleteEdge(edgeId);
      return true;
    }, false),
    setPrompt: (nodeId, prompt, operationId) => guarded('setPrompt', { nodeId, prompt }, operationId, () => {
      const st = useCanvas.getState();
      const node = st.nodes.find((n) => n.id === nodeId);
      if (!node || (node.type !== 'image' && node.type !== 'video')) return false;
      st.updateNodeParams(nodeId, { prompt });
      return true;
    }, false),
    setModel: (nodeId, modelKey, operationId) => guarded('setModel', { nodeId, modelKey }, operationId, () => {
      const st = useCanvas.getState();
      const node = st.nodes.find((n) => n.id === nodeId);
      if (!node || (node.type !== 'image' && node.type !== 'video')) return false;
      st.updateNodeParams(nodeId, { modelKey });
      return true;
    }, false),
    applyPlan: (input, operationId) => guarded('applyPlan', input, operationId, () => {
      const plan: CanvasPlan = {
        skillId: input.skillId ?? 'external-agent',
        skillName: '外部 Agent 方案',
        goal: input.goal ?? '',
        source: 'template',
        sourceDetail: '外部 Agent 提交的结构化方案',
        steps: input.steps,
        notes: [],
      };
      return applyPlanToCanvas(plan);
    }, { nodeIds: [], edgeCount: 0 }),
  };
  window.__canvasAgent = api;
}

