/**
 * 工作台运行时：配置读写、事件总线、快照、任务、幂等、工作流、时间线、生成执行。
 *
 * 所有模块共用一个入口，避免各功能各自造一份存储和状态。
 * 保留画布本地数据和旧项目配置；实际生成由 generation.ts 管理。
 */
import type {
  AppSettings,
  CanvasNode,
  Edge,
  ExternalAgentConnection,
  PluginEntry,
  PricingRule,
  WorkbenchConfig,
} from '../types';
import { useCanvas } from '../store';
import {
  normalizeWorkbench,
  PROMPT_OPERATIONS,
  workbenchOf,
  withWorkbench,
  type PromptOperation,
} from './workbenchConfig';

export {
  PROMPT_OPERATIONS, normalizeWorkbench, workbenchOf,
};
export type { PromptOperation };

const PREFIX = 'icw:';
const MAX_EVENTS = 500;
const MAX_EVENT_BYTES = 512 * 1024;
const EVENT_TTL = 24 * 60 * 60 * 1000;

/* ==================== 本地键值读写 ==================== */

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch { return fallback; }
}
function write<T>(key: string, value: T): void {
  try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch { /* 配额不足时静默，由容量面板提示 */ }
}

/* ==================== 配置 ==================== */

export function config(): WorkbenchConfig {
  return workbenchOf(useCanvas.getState().settings);
}

export function patchConfig(patch: Partial<WorkbenchConfig>): WorkbenchConfig {
  const st = useCanvas.getState();
  const next = withWorkbench(st.settings, patch);
  void st.setSettings(next);
  return workbenchOf(next);
}

export function patchSection<K extends keyof WorkbenchConfig>(key: K, patch: Partial<WorkbenchConfig[K]>): WorkbenchConfig {
  const cur = config();
  return patchConfig({ [key]: { ...(cur[key] as object), ...patch } } as Partial<WorkbenchConfig>);
}

/** 外部服务是否真的配好。用来决定按钮是「可用」还是「如实标注未配置」 */
export function generationReady(cfg = config()): boolean {
  return cfg.generation.enabled && cfg.generation.endpoint.trim().length > 0;
}

export function textChannelReady(settings = useCanvas.getState().settings): boolean {
  return (settings.services ?? []).some((s) => s.enabled && s.baseUrl.trim() && s.apiKey.trim()
    && (s.models ?? []).some((m) => m.type === 'text' && m.enabled));
}

/* ==================== 事件总线与诊断 ==================== */

export interface WorkbenchEvent {
  id: string;
  at: number;
  kind: string;
  message: string;
  detail?: string;
}

/** 默认脱敏：不记录 Key、Cookie、完整 URL、查询参数与请求体 */
const SECRET_PATTERN = /(api[_-]?key|authorization|bearer|token|cookie|password|secret|https?:\/\/\S+)/gi;
export function sanitize(text: string): string {
  return String(text).replace(SECRET_PATTERN, '[已脱敏]').slice(0, 300);
}

export function logEvent(kind: string, message: string, detail?: string): void {
  const now = Date.now();
  const list = read<WorkbenchEvent[]>('events', []).filter((e) => now - e.at < EVENT_TTL);
  list.push({ id: `ev_${now}_${Math.random().toString(36).slice(2, 7)}`, at: now, kind, message: sanitize(message), detail: detail ? sanitize(detail) : undefined });
  let bytes = 0;
  const kept: WorkbenchEvent[] = [];
  for (let i = list.length - 1; i >= 0 && kept.length < MAX_EVENTS; i -= 1) {
    const size = JSON.stringify(list[i]).length;
    if (bytes + size > MAX_EVENT_BYTES) break;
    bytes += size;
    kept.push(list[i]);
  }
  write('events', kept.reverse());
}

export function listEvents(): WorkbenchEvent[] {
  const now = Date.now();
  return read<WorkbenchEvent[]>('events', []).filter((e) => now - e.at < EVENT_TTL);
}
export function clearEvents(): void { write('events', []); }

export interface DiagnosticsPreview { count: number; bytes: number; since: number; until: number }
export function diagnosticsPreview(): DiagnosticsPreview {
  const events = listEvents();
  return {
    count: events.length,
    bytes: new Blob([JSON.stringify(events)]).size,
    since: events[0]?.at ?? Date.now(),
    until: events[events.length - 1]?.at ?? Date.now(),
  };
}

/** 诊断包内容：清单 + 运行时信息 + 配置摘要 + JSONL 日志，不含凭据与节点正文 */
export function buildDiagnosticsBundle(): { files: Record<string, string>; summary: string } {
  const cfg = config();
  const st = useCanvas.getState();
  const manifest = {
    tool: cfg.workspace.appName,
    generatedAt: new Date().toISOString(),
    note: '诊断包已脱敏：不含 API Key、Cookie、完整 URL、请求体、提示词正文与媒体地址。',
    sections: ['manifest.json', 'runtime.json', 'model-config.json', 'capabilities.json', 'events.jsonl'],
  };
  const runtime = {
    userAgent: navigator.userAgent,
    language: navigator.language,
    localStorageKeys: Object.keys(localStorage).filter((k) => k.startsWith(PREFIX)).length,
    nodeCount: st.nodes.length,
    edgeCount: st.edges.length,
    projectCount: st.projects.length,
  };
  const modelConfig = {
    services: (st.settings.services ?? []).map((s) => ({
      name: s.name, protocol: s.protocol, enabled: s.enabled,
      baseDomain: (() => { try { return new URL(s.baseUrl).hostname; } catch { return ''; } })(),
      modelCount: (s.models ?? []).length,
      models: (s.models ?? []).map((m) => ({ id: m.id, type: m.type, enabled: m.enabled })),
    })),
    defaults: st.settings.defaults,
  };
  const files: Record<string, string> = {
    'manifest.json': JSON.stringify(manifest, null, 2),
    'runtime.json': JSON.stringify(runtime, null, 2),
    'model-config.json': JSON.stringify(modelConfig, null, 2),
    'events.jsonl': listEvents().map((e) => JSON.stringify(e)).join('\n'),
  };
  return { files, summary: `${Object.keys(files).length} 个文件 · ${listEvents().length} 条事件` };
}

/* ==================== 版本快照 ==================== */

export interface CanvasSnapshot {
  id: string;
  at: number;
  label: string;
  projectId: string;
  nodeCount: number;
  edgeCount: number;
  nodes: CanvasNode[];
  edges: Edge[];
}

export function listSnapshots(projectId = useCanvas.getState().projectId): CanvasSnapshot[] {
  return read<CanvasSnapshot[]>('snapshots', []).filter((s) => s.projectId === projectId);
}

export function saveSnapshot(label: string, force = false): CanvasSnapshot | null {
  const st = useCanvas.getState();
  const cfg = config();
  const all = read<CanvasSnapshot[]>('snapshots', []);
  const mine = all.filter((s) => s.projectId === st.projectId);
  const last = mine[mine.length - 1];
  const interval = cfg.workspace.snapshotIntervalMin * 60 * 1000;
  if (!force && last && Date.now() - last.at < interval && last.nodeCount === st.nodes.length && last.edgeCount === st.edges.length) {
    return null;
  }
  const snap: CanvasSnapshot = {
    id: `snap_${Date.now()}`, at: Date.now(), label, projectId: st.projectId,
    nodeCount: st.nodes.length, edgeCount: st.edges.length,
    nodes: JSON.parse(JSON.stringify(st.nodes)) as CanvasNode[],
    edges: JSON.parse(JSON.stringify(st.edges)) as Edge[],
  };
  const next = [...all.filter((s) => s.projectId !== st.projectId), snap].slice(-cfg.workspace.snapshotLimit * 4);
  // 每个项目单独保留最近 N 份
  const kept = next.filter((s) => s.projectId !== st.projectId).concat(
    next.filter((s) => s.projectId === st.projectId).slice(-cfg.workspace.snapshotLimit),
  );
  write('snapshots', kept);
  logEvent('snapshot', `已保存版本快照：${label}`, `${snap.nodeCount} 节点 / ${snap.edgeCount} 连线`);
  return snap;
}

export function restoreSnapshot(id: string): boolean {
  const snap = listSnapshots().find((s) => s.id === id);
  if (!snap) return false;
  // 恢复前先备份当前内容，避免不可逆
  saveSnapshot('恢复前自动备份', true);
  const st = useCanvas.getState();
  st.loadSnapshot(snap.nodes, snap.edges);
  logEvent('snapshot', `已恢复版本：${snap.label}`);
  return true;
}

/* ==================== 任务中心 ==================== */

export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export interface WorkbenchTask {
  id: string;
  at: number;
  label: string;
  kind: string;
  status: TaskStatus;
  detail: string;
  operationId: string;
  estimate?: number;
}

export function listTasks(): WorkbenchTask[] { return read<WorkbenchTask[]>('tasks', []); }

export function createTask(label: string, kind: string, detail = '', estimate?: number): WorkbenchTask {
  const task: WorkbenchTask = {
    id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    at: Date.now(), label, kind, status: 'queued', detail, estimate,
    operationId: `op_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  };
  write('tasks', [task, ...listTasks()].slice(0, 200));
  logEvent('task', `创建任务：${label}`, detail);
  return task;
}

export function updateTask(id: string, patch: Partial<WorkbenchTask>): void {
  write('tasks', listTasks().map((t) => (t.id === id ? { ...t, ...patch } : t)));
  logEvent('task', `任务状态更新：${patch.status ?? '信息变更'}`, id);
}

/** 幂等：同键同载荷回放，同键不同载荷拒绝。用于外部 Agent 写操作与生成提交 */
export interface IdempotencyRecord { key: string; payload: string; result: unknown; at: number }
export function idempotentRun<T>(key: string, payload: unknown, fn: () => T): { ok: boolean; replayed: boolean; result?: T; error?: string } {
  const required = config().agentConfig.idempotencyRequired;
  if (required && !key.trim()) return { ok: false, replayed: false, error: 'missing_operation_id' };
  const records = read<IdempotencyRecord[]>('idempotency', []);
  const hit = records.find((r) => r.key === key);
  const encoded = JSON.stringify(payload);
  if (hit) {
    if (hit.payload !== encoded) return { ok: false, replayed: false, error: 'operation_id_reused_with_different_payload' };
    return { ok: true, replayed: true, result: hit.result as T };
  }
  const result = fn();
  if (key.trim()) {
    write('idempotency', [...records, { key, payload: encoded, result, at: Date.now() }].slice(-300));
  }
  return { ok: true, replayed: false, result };
}

/** 生成提交：未配置时明确失败，绝不创建假任务或伪造成功 */
export function submitGeneration(label: string, payload: unknown, operationId: string): { ok: boolean; reason: string; task?: WorkbenchTask } {
  const cfg = config();
  if (!generationReady(cfg)) {
    logEvent('generation', '生成提交被拒绝：执行端点未配置');
    return { ok: false, reason: '生成执行未配置。请在工作台设置 · 生成执行里填写端点并启用，当前不会创建任务、不会扣费。' };
  }
  if (cfg.generation.requireConfirmation) {
    logEvent('generation', '生成提交需要用户确认');
  }
  const run = idempotentRun(operationId || `op_${Date.now()}`, payload, () =>
    createTask(label, 'generation', `协议 ${cfg.generation.protocol}`, estimateCost(cfg.generation.pricing, payload)));
  if (!run.ok || !run.result) {
    return { ok: false, reason: run.error === 'missing_operation_id' ? '缺少幂等键 operationId' : '幂等键冲突：同一个 operationId 不能提交不同内容' };
  }
  return { ok: true, reason: run.replayed ? '同一幂等键已提交过，直接回放原任务，不会重复扣费' : '已登记任务，真实执行状态需要外部服务返回', task: run.result };
}

/* ==================== 费用预估 ==================== */

export interface CostLine { ruleId: string; label: string; amount: number; known: boolean; note: string }
export function estimateCost(rules: PricingRule[], payload: unknown): number {
  const p = (payload ?? {}) as Record<string, unknown>;
  return rules.reduce((sum, r) => {
    const qty = Number(p[r.unit] ?? (r.unit === 'image' ? p.count : r.unit === 'second' ? p.seconds : 0)) || 0;
    return sum + (Number.isFinite(qty) ? qty * r.price : 0);
  }, 0);
}

export function costLines(rules: PricingRule[], payload: unknown): CostLine[] {
  const p = (payload ?? {}) as Record<string, unknown>;
  return rules.map((r) => {
    const raw = p[r.unit] ?? (r.unit === 'image' ? p.count : r.unit === 'second' ? p.seconds : undefined);
    const qty = Number(raw);
    const known = Number.isFinite(qty) && raw !== undefined;
    return {
      ruleId: r.id, label: r.label,
      amount: known ? qty * r.price : 0, known,
      note: known ? `${qty} ${r.unit} × ${r.price} ${r.currency}` : `算不出：缺少 ${r.unit} 用量，未计入合计`,
    };
  });
}

/* ==================== 工作流模板 ==================== */

export interface WorkflowSlot { key: string; nodeId: string; name: string; type: string; role: 'input' | 'fixed' | 'process' | 'output'; prompt?: string }
export interface WorkflowTemplate {
  id: string;
  name: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  slots: WorkflowSlot[];
  edges: { from: string; to: string }[];
  note: string;
}

export function listWorkflows(): WorkflowTemplate[] { return read<WorkflowTemplate[]>('workflows', []); }

export function saveWorkflow(name: string, nodes: CanvasNode[], edges: Edge[]): WorkflowTemplate {
  const ids = new Set(nodes.map((n) => n.id));
  const tpl: WorkflowTemplate = {
    id: `wf_${Date.now()}`, name, version: 1, createdAt: Date.now(), updatedAt: Date.now(),
    note: '从画布选中节点封装，输入槽位可替换，原素材不写死',
    slots: nodes.map((n) => ({
      key: n.id, nodeId: n.id, name: n.name, type: n.type,
      role: edges.some((e) => e.to === n.id && ids.has(e.from)) ? 'process' : 'input',
      prompt: (n.type === 'image' ? n.imageParams?.prompt : n.type === 'video' ? n.videoParams?.prompt : undefined) ?? '',
    })),
    edges: edges.filter((e) => ids.has(e.from) && ids.has(e.to)).map((e) => ({ from: e.from, to: e.to })),
  };
  write('workflows', [tpl, ...listWorkflows()]);
  logEvent('workflow', `保存工作流模板：${name}`, `${tpl.slots.length} 个槽位`);
  return tpl;
}

export function deleteWorkflow(id: string): void { write('workflows', listWorkflows().filter((w) => w.id !== id)); }

/* ==================== 时间线 ==================== */

export interface TimelineClip { id: string; track: number; start: number; duration: number; label: string; assetId?: string; kind: string }
export interface TimelineState { projectId: string; clips: TimelineClip[]; updatedAt: number }
export interface TimelineCommand { type: string; payload: Record<string, unknown>; at: number }

export function loadTimeline(projectId = useCanvas.getState().projectId): TimelineState {
  return read<TimelineState>(`timeline:${projectId}`, { projectId, clips: [], updatedAt: 0 });
}
export function saveTimeline(state: TimelineState): void {
  write(`timeline:${state.projectId}`, { ...state, updatedAt: Date.now() });
  logEvent('timeline', '时间线已保存', `${state.clips.length} 个片段`);
}

/** 时间线命令状态机：非法操作整批拒绝，不产生半应用状态 */
export function applyTimelineCommand(state: TimelineState, cmd: TimelineCommand): { ok: boolean; state: TimelineState; reason: string } {
  const clips = [...state.clips];
  const p = cmd.payload;
  if (cmd.type === 'add') {
    const clip: TimelineClip = {
      id: `clip_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
      track: Number(p.track) || 0, start: Number(p.start) || 0,
      duration: Math.max(0.5, Number(p.duration) || 4), label: String(p.label || '新片段'),
      kind: String(p.kind || 'video'), assetId: p.assetId ? String(p.assetId) : undefined,
    };
    clips.push(clip);
  } else if (cmd.type === 'remove') {
    const i = clips.findIndex((c) => c.id === p.id);
    if (i < 0) return { ok: false, state, reason: '片段不存在' };
    clips.splice(i, 1);
  } else if (cmd.type === 'split') {
    const i = clips.findIndex((c) => c.id === p.id);
    if (i < 0) return { ok: false, state, reason: '片段不存在' };
    const at = Number(p.at);
    const c = clips[i];
    if (!(at > 0.2 && at < c.duration - 0.2)) return { ok: false, state, reason: '切点不在片段内部' };
    clips.splice(i, 1, { ...c, duration: at }, { ...c, id: `clip_${Date.now()}_b`, start: c.start + at, duration: c.duration - at, label: `${c.label} · 后段` });
  } else if (cmd.type === 'trim' || cmd.type === 'move') {
    const i = clips.findIndex((c) => c.id === p.id);
    if (i < 0) return { ok: false, state, reason: '片段不存在' };
    const next = { ...clips[i] };
    if (cmd.type === 'trim') next.duration = Math.max(0.5, Number(p.duration) || next.duration);
    else next.start = Math.max(0, Number(p.start) || 0);
    clips[i] = next;
  } else {
    return { ok: false, state, reason: `未知命令 ${cmd.type}` };
  }
  const next = { ...state, clips, updatedAt: Date.now() };
  saveTimeline(next);
  return { ok: true, state: next, reason: '已应用' };
}

/* ==================== 插件与外部 Agent ==================== */

export function listPlugins(): PluginEntry[] { return config().plugins; }
export function upsertPlugin(entry: PluginEntry): void {
  const list = listPlugins().filter((p) => p.id !== entry.id);
  patchConfig({ plugins: [entry, ...list] });
  logEvent('plugin', `${entry.enabled ? '启用' : '停用'}插件：${entry.name}`, entry.kind);
}
export function removePlugin(id: string): void { patchConfig({ plugins: listPlugins().filter((p) => p.id !== id) }); }

export function listConnections(): ExternalAgentConnection[] { return config().externalAgents; }
export function upsertConnection(conn: ExternalAgentConnection): void {
  patchConfig({ externalAgents: [conn, ...listConnections().filter((c) => c.id !== conn.id)] });
  logEvent('external-agent', `保存外部连接：${conn.label}`, conn.mode);
}

/** 通用连接配置模板，不写任何第三方客户端名称与路径 */
export function buildConnectionConfig(conn: ExternalAgentConnection): string {
  return JSON.stringify({
    endpoint: conn.endpoint || '（由用户填写本机地址）',
    clientId: conn.clientId,
    mode: conn.mode,
    token: '<只展示一次，请自行保管>',
    rules: {
      readOnly: conn.mode === 'read-only',
      requireOperationId: config().agentConfig.idempotencyRequired,
      note: '本工具是纯浏览器应用，没有常驻服务。请把 endpoint 指向你自己运行的桥接服务。',
    },
  }, null, 2);
}

/* ==================== 品牌与外观 ==================== */

/** 把外观配置写成 CSS 变量，启动时与设置变更后都要调用 */
export function applyAppearance(cfg = config()): void {
  if (typeof document === 'undefined') return;
  const a = cfg.appearance;
  const root = document.documentElement;
  const base = a.theme === 'light' ? '#ececf0' : a.theme === 'dark' ? '#0d0d10' : a.background;
  root.style.setProperty('--canvas-bg', a.theme === 'custom' ? a.background : base);
  root.style.setProperty('--canvas-brightness', String(a.brightness));
  root.style.setProperty('--canvas-grid-color', a.gridColor);
  root.style.setProperty('--canvas-grid-strength', String(a.gridStrength / 100));
  root.dataset.canvasTheme = a.theme;
  root.dataset.canvasGrid = a.grid;
  document.title = cfg.workspace.appName;
}

export function applyBrand(cfg = config()): void {
  if (typeof document === 'undefined') return;
  document.title = cfg.workspace.appName;
}

/* ==================== 能力开关 ==================== */

export function isEnabled(key: keyof WorkbenchConfig['features'], cfg = config()): boolean {
  return cfg.features[key] !== false;
}

/** 生成执行统一入口：所有「生成 / 转写 / 渲染」按钮都走这里，未配置时给出同一句真话 */
export function executionGate(cfg = config()): { allowed: boolean; reason: string } {
  if (!cfg.features.mediaPreview) return { allowed: false, reason: '媒体处理能力已在配置里关闭' };
  if (!generationReady(cfg)) return { allowed: false, reason: '未配置生成执行端点。请在工作台设置里填写并启用，当前不会创建任务、不会扣费、不会产出文件。' };
  return { allowed: true, reason: `执行端点 ${cfg.generation.endpoint}` };
}

export type { AppSettings, WorkbenchConfig };
