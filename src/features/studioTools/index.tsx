import './styles.css';
import { useState } from 'react';
import type { FC } from 'react';
import { useCanvas } from '../../store';
import Icon from '../../components/Icon';
import { uid, downloadBlob } from '../../lib/utils';
import {
  listWorkflows,
  saveWorkflow,
  deleteWorkflow,
  loadTimeline,
  saveTimeline,
  applyTimelineCommand,
  executionGate,
  generationReady,
  config,
  logEvent,
  textChannelReady,
} from '../../lib/workbenchRuntime';
import type {
  WorkflowTemplate,
  WorkflowSlot,
  TimelineClip,
  TimelineState,
  TimelineCommand,
} from '../../lib/workbenchRuntime';

/* ==================== 本地类型 ==================== */

type Notice = (message: string) => void;
type PortKind = 'image' | 'video' | 'audio' | 'text' | 'any';

/** 只声明本模块真正会读到的画布状态；通过 unknown 转换与真实 store 解耦。 */
interface StudioNode { id: string; name: string; type: string; [k: string]: unknown }
interface StudioEdge { id?: string; from: string; to: string; [k: string]: unknown }
interface StudioViewport {
  x?: number; y?: number; zoom?: number; k?: number; scale?: number;
  tx?: number; ty?: number; pan?: { x?: number; y?: number };
}
interface StudioStore {
  nodes: StudioNode[];
  edges: StudioEdge[];
  selection: unknown;
  projectId: string;
  viewport?: StudioViewport;
  applyAgentPlan: (steps: unknown[], anchor: { x: number; y: number }) => void;
}

interface StudioSlot extends WorkflowSlot {
  params?: string;
  inPort?: PortKind;
  outPort?: PortKind;
}
interface StudioTemplate extends Omit<WorkflowTemplate, 'slots'> { slots: StudioSlot[] }
interface EdgeRef { from: string; to: string }
interface InstanceSnapshot {
  slots: { name: string; type: string; role: string }[];
  edges: EdgeRef[];
  note: string;
}
interface WorkflowInstance {
  id: string;
  templateId: string;
  templateName: string;
  version: number;
  snapshot: InstanceSnapshot;
  at: number;
  upgradedAt?: number;
}

/* ==================== 通用工具 ==================== */

const Glyph = Icon as unknown as FC<{ name?: string; size?: number }>;
const makeId = uid as unknown as () => string;
const saveBlob = downloadBlob as unknown as (blob: Blob, filename: string) => void;

const WF_KEY = 'icw:workflows';
const INSTANCE_KEY = 'st:wf-instances';
const HISTORY_LIMIT = 200;
const PX_PER_SEC = 42;

function studioState(): StudioStore {
  return useCanvas.getState() as unknown as StudioStore;
}

function normalizeSelection(sel: unknown): string[] {
  if (!sel) return [];
  if (Array.isArray(sel)) {
    return sel
      .map((v) => (typeof v === 'string'
        ? v
        : v && typeof v === 'object' && 'id' in v ? String((v as { id: unknown }).id) : ''))
      .filter(Boolean);
  }
  if (sel instanceof Set) return Array.from(sel).map(String);
  if (typeof sel === 'object') {
    const o = sel as Record<string, unknown>;
    const arr = o.nodeIds ?? o.nodes ?? o.ids ?? o.selected;
    if (Array.isArray(arr)) return arr.map(String);
  }
  return [];
}

/** 视口中心换算成画布坐标：世界坐标 = (屏幕中心 - 平移) / 缩放。 */
function viewportAnchor(): { x: number; y: number } {
  const vp = studioState().viewport;
  const zoomRaw = vp?.zoom ?? vp?.k ?? vp?.scale ?? 1;
  const zoom = typeof zoomRaw === 'number' && zoomRaw > 0 ? zoomRaw : 1;
  const ox = typeof vp?.x === 'number' ? vp.x
    : typeof vp?.tx === 'number' ? vp.tx
      : typeof vp?.pan?.x === 'number' ? vp.pan.x : 0;
  const oy = typeof vp?.y === 'number' ? vp.y
    : typeof vp?.ty === 'number' ? vp.ty
      : typeof vp?.pan?.y === 'number' ? vp.pan.y : 0;
  const w = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const h = typeof window !== 'undefined' ? window.innerHeight : 720;
  return { x: (w / 2 - ox) / zoom, y: (h / 2 - oy) / zoom };
}

/* ==================== 模板 / 实例的本地存储 ==================== */

function readTemplatesRaw(): StudioTemplate[] {
  return listWorkflows() as unknown as StudioTemplate[];
}

/** 编辑保存时直接回写运行时同一键值，以便在不新增运行时 API 的前提下递增版本。 */
function writeTemplatesRaw(list: StudioTemplate[]): void {
  try { localStorage.setItem(WF_KEY, JSON.stringify(list)); } catch { /* 配额不足时忽略 */ }
}

function readInstances(): WorkflowInstance[] {
  try {
    const raw = localStorage.getItem(INSTANCE_KEY);
    return raw ? (JSON.parse(raw) as WorkflowInstance[]) : [];
  } catch { return []; }
}

function writeInstances(list: WorkflowInstance[]): void {
  try { localStorage.setItem(INSTANCE_KEY, JSON.stringify(list)); } catch { /* 配额不足时忽略 */ }
}

function snapshotOf(tpl: WorkflowTemplate): InstanceSnapshot {
  return {
    slots: tpl.slots.map((s) => ({ name: s.name, type: s.type, role: s.role })),
    edges: tpl.edges.map((e) => ({ from: e.from, to: e.to })),
    note: tpl.note,
  };
}

function formatTime(ts: number): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 把模板槽位翻译成 Agent 计划步骤；节点步骤带相对 anchor 的位置，连线步骤带端点。 */
function planStepsFor(tpl: WorkflowTemplate, anchor: { x: number; y: number }): Record<string, unknown>[] {
  const nodeSteps: Record<string, unknown>[] = tpl.slots.map((slot, i) => {
    const x = anchor.x + i * 260;
    const y = anchor.y + (i % 2) * 150;
    return {
      op: 'addNode', action: 'createNode', kind: 'node', type: 'createNode',
      id: slot.nodeId, key: slot.key, nodeId: slot.nodeId,
      name: slot.name, label: slot.name,
      nodeType: slot.type, slotType: slot.type, role: slot.role,
      prompt: slot.prompt ?? '', params: (slot as StudioSlot).params ?? '',
      position: { x, y }, x, y,
      templateId: tpl.id, templateVersion: tpl.version,
    };
  });
  const edgeSteps: Record<string, unknown>[] = tpl.edges.map((e) => ({
    op: 'addEdge', action: 'addEdge', kind: 'edge', type: 'addEdge',
    from: e.from, to: e.to, source: e.from, target: e.to,
    sourceId: e.from, targetId: e.to,
    templateId: tpl.id, templateVersion: tpl.version,
  }));
  return [...nodeSteps, ...edgeSteps];
}

function instanceDiffLines(inst: WorkflowInstance, tpl: WorkflowTemplate): string[] {
  const lines: string[] = [];
  lines.push(`模板版本 v${inst.version} → v${tpl.version}`);
  const before = inst.snapshot.slots.map((s) => s.name);
  const after = tpl.slots.map((s) => s.name);
  const delta = after.length - before.length;
  lines.push(`槽位 ${before.length} → ${after.length}（${delta >= 0 ? `+${delta}` : delta}）`);
  lines.push(`连线 ${inst.snapshot.edges.length} → ${tpl.edges.length}`);
  const added = after.filter((n) => !before.includes(n));
  const removed = before.filter((n) => !after.includes(n));
  if (added.length) lines.push(`新增槽位：${added.join('、')}`);
  if (removed.length) lines.push(`移除槽位：${removed.join('、')}`);
  if (inst.version === tpl.version && !added.length && !removed.length) lines.push('无结构差异，已是最新版本');
  return lines;
}

/* ==================== 组件 1：模板库 ==================== */

export function WorkflowLibrary({ onNotice }: { onNotice: Notice }) {
  const [tick, setTick] = useState(0);
  const [newDraft, setNewDraft] = useState<{ nodes: StudioNode[]; edges: StudioEdge[] } | null>(null);
  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [updateId, setUpdateId] = useState<string | null>(null);

  const bump = () => setTick((t) => t + 1);
  const templates = listWorkflows();
  const instances = readInstances();
  const updatingTpl = updateId ? templates.find((t) => t.id === updateId) ?? null : null;
  const updateTargets = updateId ? instances.filter((i) => i.templateId === updateId) : [];

  const startFromSelection = () => {
    const st = studioState();
    const ids = new Set(normalizeSelection(st.selection));
    const nodes = st.nodes.filter((n) => ids.has(n.id));
    if (nodes.length === 0) {
      onNotice('新建模板失败：当前没有选中节点，请先在画布上框选节点');
      return;
    }
    const idSet = new Set(nodes.map((n) => n.id));
    const edges = st.edges.filter((e) => idSet.has(e.from) && idSet.has(e.to));
    setNewName(`工作流 ${new Date().toLocaleTimeString('zh-CN')}`);
    setNewDraft({ nodes, edges });
  };

  const confirmNew = () => {
    if (!newDraft) return;
    const name = newName.trim();
    if (!name) { onNotice('新建模板失败：名称不能为空'); return; }
    saveWorkflow(
      name,
      newDraft.nodes as unknown as Parameters<typeof saveWorkflow>[1],
      newDraft.edges as unknown as Parameters<typeof saveWorkflow>[2],
    );
    logEvent('workflow', `从选中节点新建模板：${name}`, `${newDraft.nodes.length} 节点 / ${newDraft.edges.length} 内部连线`);
    onNotice(`已新建模板「${name}」（v1），共 ${newDraft.nodes.length} 个槽位`);
    setNewDraft(null);
    bump();
  };

  const addToCanvas = (tpl: WorkflowTemplate) => {
    const anchor = viewportAnchor();
    studioState().applyAgentPlan(planStepsFor(tpl, anchor), anchor);
    const inst: WorkflowInstance = {
      id: makeId(), templateId: tpl.id, templateName: tpl.name,
      version: tpl.version, snapshot: snapshotOf(tpl), at: Date.now(),
    };
    writeInstances([inst, ...readInstances()]);
    logEvent('workflow', `添加画布实例：${tpl.name} 固定 v${tpl.version}`, `anchor ${Math.round(anchor.x)},${Math.round(anchor.y)}`);
    onNotice(`已添加「${tpl.name}」到画布：实例固定使用模板 v${tpl.version}，后续模板升级不会自动改写该实例`);
    bump();
  };

  const confirmDelete = () => {
    if (!deleteId) return;
    const tpl = templates.find((t) => t.id === deleteId);
    deleteWorkflow(deleteId);
    logEvent('workflow', `删除工作流模板：${tpl?.name ?? deleteId}`);
    onNotice(`已删除模板「${tpl?.name ?? deleteId}」`);
    setDeleteId(null);
    bump();
  };

  const confirmUpdate = () => {
    if (!updateId || !updatingTpl) { setUpdateId(null); return; }
    const next = readInstances().map((i) => i.templateId === updateId
      ? { ...i, version: updatingTpl.version, snapshot: snapshotOf(updatingTpl), upgradedAt: Date.now() }
      : i);
    writeInstances(next);
    logEvent('workflow', `实例升级确认：${updatingTpl.name} → v${updatingTpl.version}`, `${updateTargets.length} 个实例`);
    onNotice(`已确认升级 ${updateTargets.length} 个实例到 v${updatingTpl.version}；画布上已有节点保持原固定版本，不自动改写，如需新结构请重新「添加到画布」`);
    setUpdateId(null);
    bump();
  };

  return (
    <section className="st-library" data-tick={tick} data-testid="wb-studio-workflow-library">
      <div className="st-library-head">
        <div className="section-title">工作流模板库</div>
        <div className="st-toolbar">
          <button className="mini-btn" data-testid="wb-studio-wf-new-from-selection" onClick={startFromSelection}>
            <Glyph name="plus" size={12} /> 从当前选中节点新建
          </button>
        </div>
      </div>
      <p className="st-library-note settings-note" data-testid="wb-studio-workflow-note">
        保存只更新模板版本；画布实例固定版本，升级需确认
      </p>

      <div className="st-list" data-testid="wb-studio-wf-list">
        {templates.length === 0 ? (
          <div className="list-empty" data-testid="wb-studio-wf-empty">
            暂无模板。可先在画布上选中若干节点，再点「从当前选中节点新建」。
          </div>
        ) : templates.map((tpl) => {
          const ins = instances.filter((i) => i.templateId === tpl.id);
          const versions = Array.from(new Set(ins.map((i) => i.version))).sort((a, b) => a - b);
          return (
            <div className="st-row" key={tpl.id} data-testid="wb-studio-wf-item">
              <div className="st-row-main">
                <div className="st-row-title">
                  <span data-testid="wb-studio-wf-name">{tpl.name}</span>
                  <span className="st-badge" data-testid="wb-studio-wf-version">v{tpl.version}</span>
                </div>
                <div className="st-row-meta">
                  <span data-testid="wb-studio-wf-slots">槽位 {tpl.slots.length} · 连线 {tpl.edges.length}</span>
                  <span data-testid="wb-studio-wf-created">创建 {formatTime(tpl.createdAt)}</span>
                </div>
                <div className="st-instance-line" data-testid="wb-studio-wf-instances">
                  实例 {ins.length} 个 · 固定版本 {versions.length ? versions.map((v) => `v${v}`).join('、') : '—'}（升级需确认）
                </div>
              </div>
              <div className="st-row-actions">
                <button className="mini-btn" data-testid="wb-studio-wf-add-to-canvas" onClick={() => addToCanvas(tpl)}>添加到画布</button>
                <button className="mini-btn" data-testid="wb-studio-wf-edit" onClick={() => setEditingId(tpl.id)}>编辑</button>
                <button className="mini-btn" data-testid="wb-studio-wf-update-instance" onClick={() => setUpdateId(tpl.id)} disabled={ins.length === 0}>更新实例</button>
                <button className="mini-btn st-danger" data-testid="wb-studio-wf-delete" onClick={() => setDeleteId(tpl.id)}>删除</button>
              </div>
            </div>
          );
        })}
      </div>

      {newDraft && (
        <div className="modal-mask" data-testid="wb-studio-wf-new-dialog">
          <div className="dialog st-dialog-narrow">
            <div className="dialog-head">从选中节点新建模板</div>
            <div className="dialog-body">
              <div className="settings-field">
                <label>模板名称</label>
                <input
                  className="dialog-input"
                  data-testid="wb-studio-wf-name-input"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="例如：分镜生成流程"
                />
              </div>
              <p className="settings-note">
                将封装 {newDraft.nodes.length} 个选中节点与 {newDraft.edges.length} 条内部连线；输入槽位可替换，原素材不写死。
              </p>
            </div>
            <div className="dialog-foot">
              <button className="ghost-btn" data-testid="wb-studio-wf-cancel" onClick={() => setNewDraft(null)}>取消</button>
              <button className="primary-btn" data-testid="wb-studio-wf-confirm" onClick={confirmNew}>保存模板</button>
            </div>
          </div>
        </div>
      )}

      {deleteId && (
        <div className="modal-mask" data-testid="wb-studio-wf-delete-dialog">
          <div className="dialog st-dialog-narrow">
            <div className="dialog-head">二次确认 · 删除模板</div>
            <div className="dialog-body">
              <p className="st-confirm-text">
                确定删除模板「{templates.find((t) => t.id === deleteId)?.name ?? deleteId}」吗？此操作不可撤销，已生成的画布实例不会被改写。
              </p>
            </div>
            <div className="dialog-foot">
              <button className="ghost-btn" onClick={() => setDeleteId(null)}>取消</button>
              <button className="primary-btn st-danger" data-testid="wb-studio-wf-delete-confirm" onClick={confirmDelete}>确认删除</button>
            </div>
          </div>
        </div>
      )}

      {updateId && updatingTpl && (
        <div className="modal-mask" data-testid="wb-studio-wf-update-dialog">
          <div className="dialog">
            <div className="dialog-head">更新实例 · 版本差异确认</div>
            <div className="dialog-body">
              <p className="settings-note">
                画布实例固定版本，升级需确认。以下为各实例固定版本与模板当前版本 v{updatingTpl.version} 的差异。
              </p>
              <div className="st-diff" data-testid="wb-studio-wf-diff">
                {updateTargets.length === 0 ? (
                  <div className="list-empty">该模板暂无画布实例</div>
                ) : updateTargets.map((i) => (
                  <div className="st-diff-item" key={i.id}>
                    <div className="st-diff-title">实例 {i.id} · 添加于 {formatTime(i.at)}</div>
                    {instanceDiffLines(i, updatingTpl).map((line, k) => (
                      <div className="st-diff-line" key={k}>{line}</div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
            <div className="dialog-foot">
              <button className="ghost-btn" onClick={() => setUpdateId(null)}>取消</button>
              <button className="primary-btn" data-testid="wb-studio-wf-update-confirm" onClick={confirmUpdate} disabled={updateTargets.length === 0}>确认升级</button>
            </div>
          </div>
        </div>
      )}

      {editingId && (
        <WorkflowEditorDialog
          templateId={editingId}
          onClose={() => { setEditingId(null); bump(); }}
          onNotice={onNotice}
        />
      )}
    </section>
  );
}

/* ==================== 组件 2：工作流编辑器 ==================== */

interface NodeTypeSpec {
  key: string;
  name: string;
  group: 'input' | 'process' | 'generate';
  type: string;
  role: WorkflowSlot['role'];
  inPort: PortKind;
  outPort: PortKind;
  prompt: string;
}

const NODE_TYPES: NodeTypeSpec[] = [
  { key: 'in-text', name: '文本输入', group: 'input', type: 'text', role: 'input', inPort: 'any', outPort: 'text', prompt: '输入主题文案' },
  { key: 'in-image', name: '图片输入', group: 'input', type: 'image', role: 'input', inPort: 'any', outPort: 'image', prompt: '输入参考图' },
  { key: 'in-video', name: '视频输入', group: 'input', type: 'video', role: 'input', inPort: 'any', outPort: 'video', prompt: '输入素材视频' },
  { key: 'in-audio', name: '音频输入', group: 'input', type: 'audio', role: 'input', inPort: 'any', outPort: 'audio', prompt: '输入音频素材' },
  { key: 'proc-text', name: '文本改写', group: 'process', type: 'text', role: 'process', inPort: 'text', outPort: 'text', prompt: '润色与扩写' },
  { key: 'proc-image', name: '图片处理', group: 'process', type: 'image', role: 'process', inPort: 'image', outPort: 'image', prompt: '裁切与调色' },
  { key: 'proc-video', name: '视频处理', group: 'process', type: 'video', role: 'process', inPort: 'video', outPort: 'video', prompt: '剪辑与拼接' },
  { key: 'proc-audio', name: '音频处理', group: 'process', type: 'audio', role: 'process', inPort: 'audio', outPort: 'audio', prompt: '降噪与混音' },
  { key: 'gen-image', name: '图片生成', group: 'generate', type: 'image', role: 'output', inPort: 'text', outPort: 'any', prompt: '根据提示词生成图片' },
  { key: 'gen-video', name: '视频生成', group: 'generate', type: 'video', role: 'output', inPort: 'text', outPort: 'any', prompt: '根据提示词生成视频' },
  { key: 'gen-final', name: '成片输出', group: 'generate', type: 'video', role: 'output', inPort: 'any', outPort: 'any', prompt: '汇总输出成片' },
];
const GROUP_LABEL: Record<NodeTypeSpec['group'], string> = {
  input: '输入节点', process: '处理节点', generate: '生成节点',
};
const PROCESS_STEPS = ['图片裁切', '尺寸调整', '视频画面裁切', '截帧', '音频提取', '视频剪辑', '拼接', '深度处理'];

interface EditorDraft { slots: StudioSlot[]; edges: EdgeRef[]; selectedId: string }
interface EditorHist { items: EditorDraft[]; index: number }

function portsOf(slot: StudioSlot): { inPort: PortKind; outPort: PortKind } {
  const derived: PortKind = (['image', 'video', 'audio', 'text'].includes(slot.type) ? slot.type : 'any') as PortKind;
  return {
    inPort: slot.inPort ?? (slot.role === 'input' || slot.role === 'output' ? 'any' : derived),
    outPort: slot.outPort ?? (slot.role === 'output' ? 'any' : derived),
  };
}

/** 简单 DFS 三色标记：发现回边即认为内部连线成环。 */
function hasCycle(slots: StudioSlot[], edges: EdgeRef[]): boolean {
  const ids = new Set(slots.map((s) => s.nodeId));
  const adj = new Map<string, string[]>();
  ids.forEach((id) => adj.set(id, []));
  edges.forEach((e) => { if (ids.has(e.from) && ids.has(e.to)) adj.get(e.from)!.push(e.to); });
  const color = new Map<string, number>();
  ids.forEach((id) => color.set(id, 0));
  const visit = (id: string): boolean => {
    color.set(id, 1);
    for (const nxt of adj.get(id) ?? []) {
      const c = color.get(nxt) ?? 0;
      if (c === 1) return true;
      if (c === 0 && visit(nxt)) return true;
    }
    color.set(id, 2);
    return false;
  };
  for (const id of ids) if ((color.get(id) ?? 0) === 0 && visit(id)) return true;
  return false;
}

function validateDraft(d: EditorDraft): string[] {
  const errs: string[] = [];
  if (!d.slots.some((s) => s.role === 'input')) {
    errs.push('缺输入：至少需要一个用途为 input 的输入槽位');
  }
  for (const e of d.edges) {
    const a = d.slots.find((s) => s.nodeId === e.from);
    const b = d.slots.find((s) => s.nodeId === e.to);
    if (!a || !b) { errs.push(`连线指向不存在的槽位：${e.from} → ${e.to}`); continue; }
    const pa = portsOf(a);
    const pb = portsOf(b);
    if (!(pa.outPort === 'any' || pb.inPort === 'any' || pa.outPort === pb.inPort)) {
      errs.push(`端口类型不匹配：${a.name}(出 ${pa.outPort}) → ${b.name}(入 ${pb.inPort})`);
    }
  }
  if (hasCycle(d.slots, d.edges)) errs.push('内部连线存在循环（DFS 检测到回边）');
  return errs;
}

export function WorkflowEditorDialog({ templateId, onClose, onNotice }: {
  templateId: string;
  onClose: () => void;
  onNotice: Notice;
}) {
  const tplMeta = readTemplatesRaw().find((t) => t.id === templateId) ?? null;
  const [hist, setHist] = useState<EditorHist>(() => {
    const tpl = readTemplatesRaw().find((t) => t.id === templateId);
    const slots: StudioSlot[] = tpl ? tpl.slots.map((s) => ({ ...s, key: s.nodeId })) : [];
    const base: EditorDraft = {
      slots,
      edges: tpl ? tpl.edges.map((e) => ({ from: e.from, to: e.to })) : [],
      selectedId: slots[0]?.nodeId ?? '',
    };
    return { items: [base], index: 0 };
  });
  const [errors, setErrors] = useState<string[]>([]);

  const draft = hist.items[hist.index];
  const cfg = config();
  const ready = generationReady(cfg);
  const selected = draft.slots.find((s) => s.nodeId === draft.selectedId) ?? null;
  const nameOf = (id: string): string => draft.slots.find((s) => s.nodeId === id)?.name ?? id;

  const commit = (mutate: (d: EditorDraft) => EditorDraft) => {
    setHist((h) => {
      const cur = h.items[h.index];
      const copy: EditorDraft = {
        ...cur,
        slots: cur.slots.map((s) => ({ ...s })),
        edges: cur.edges.map((e) => ({ ...e })),
      };
      const next = mutate(copy);
      const items = [...h.items.slice(0, h.index + 1), next];
      return { items, index: items.length - 1 };
    });
    setErrors([]);
  };

  const addSlot = (spec: NodeTypeSpec) => {
    commit((d) => {
      const id = makeId();
      const slot: StudioSlot = {
        key: id, nodeId: id, name: spec.name, type: spec.type, role: spec.role,
        prompt: spec.prompt, params: '', inPort: spec.inPort, outPort: spec.outPort,
      };
      const edges = [...d.edges];
      if (d.slots.length) edges.push({ from: d.slots[d.slots.length - 1].nodeId, to: id });
      return { ...d, slots: [...d.slots, slot], edges, selectedId: id };
    });
  };

  const moveSlot = (index: number, dir: -1 | 1) => {
    commit((d) => {
      const j = index + dir;
      if (j < 0 || j >= d.slots.length) return d;
      const slots = [...d.slots];
      const tmp = slots[index];
      slots[index] = slots[j];
      slots[j] = tmp;
      return { ...d, slots };
    });
  };

  const removeSlot = (id: string) => {
    commit((d) => {
      const slots = d.slots.filter((s) => s.nodeId !== id);
      return {
        ...d,
        slots,
        edges: d.edges.filter((e) => e.from !== id && e.to !== id),
        selectedId: d.selectedId === id ? (slots[0]?.nodeId ?? '') : d.selectedId,
      };
    });
  };

  const removeEdge = (i: number) => {
    commit((d) => ({ ...d, edges: d.edges.filter((_, k) => k !== i) }));
  };

  const patchSelected = (patch: Partial<StudioSlot>) => {
    commit((d) => ({
      ...d,
      slots: d.slots.map((s) => (s.nodeId === d.selectedId ? { ...s, ...patch } : s)),
    }));
  };

  const undo = () => setHist((h) => ({ ...h, index: Math.max(0, h.index - 1) }));
  const redo = () => setHist((h) => ({ ...h, index: Math.min(h.items.length - 1, h.index + 1) }));

  const save = () => {
    const errs = validateDraft(draft);
    if (errs.length) {
      setErrors(errs);
      onNotice(`保存被阻止：${errs.length} 项校验未通过，草稿已保留，可继续编辑`);
      return;
    }
    const list = readTemplatesRaw();
    const idx = list.findIndex((t) => t.id === templateId);
    if (idx < 0) { onNotice('保存被阻止：模板不存在，草稿已保留'); return; }
    const prev = list[idx];
    const next: StudioTemplate = {
      ...prev,
      version: prev.version + 1,
      updatedAt: Date.now(),
      note: `${prev.note}｜v${prev.version + 1} 编辑保存`,
      slots: draft.slots.map((s) => ({
        key: s.nodeId, nodeId: s.nodeId, name: s.name, type: s.type, role: s.role,
        prompt: s.prompt ?? '', params: s.params ?? '', inPort: s.inPort, outPort: s.outPort,
      })),
      edges: draft.edges.map((e) => ({ from: e.from, to: e.to })),
    };
    list[idx] = next;
    writeTemplatesRaw(list);
    logEvent('workflow', `模板更新版本：${next.name} v${next.version}`, `${next.slots.length} 槽位 / ${next.edges.length} 连线`);
    setErrors([]);
    onNotice(`已保存为 v${next.version}：仅更新模板版本，画布实例仍固定原版本，升级需确认`);
    onClose();
  };

  if (!tplMeta) {
    return (
      <div className="modal-mask" data-testid="wb-studio-editor">
        <div className="dialog st-dialog-narrow">
          <div className="dialog-head">工作流编辑器</div>
          <div className="dialog-body"><p className="st-confirm-text">模板不存在或已被删除。</p></div>
          <div className="dialog-foot">
            <button className="ghost-btn" data-testid="wb-studio-editor-close" onClick={onClose}>关闭</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-mask" data-testid="wb-studio-editor">
      <div className="dialog st-editor st-dialog-wide">
        <div className="dialog-head">
          工作流编辑器 · {tplMeta.name}
          <span className="st-badge">v{tplMeta.version} → v{tplMeta.version + 1}</span>
        </div>
        <div className="dialog-body st-editor-cols">
          {/* 左：节点类型 + 固定处理步骤清单 */}
          <div className="st-col" data-testid="wb-studio-editor-types">
            <div className="st-col-head">可添加节点类型</div>
            {(['input', 'process', 'generate'] as NodeTypeSpec['group'][]).map((g) => (
              <div className="st-type-group" key={g}>
                <div className="section-title">{GROUP_LABEL[g]}</div>
                {NODE_TYPES.filter((n) => n.group === g).map((n) => (
                  <button className="st-type-item" key={n.key} data-testid="wb-studio-editor-add-type" onClick={() => addSlot(n)}>
                    <Glyph name="plus" size={11} /> {n.name}
                    <span className="st-hint">{n.inPort} → {n.outPort}</span>
                  </button>
                ))}
              </div>
            ))}
            <div className="st-steps" data-testid="wb-studio-editor-steps">
              <div className="st-col-head">处理步骤清单（固定）</div>
              {PROCESS_STEPS.map((s) => (
                <div className="st-step" key={s}>
                  <span>{s}</span>
                  <span className={`st-step-tag ${ready ? '' : 'st-step-tag--off'}`}>
                    {ready ? '需外部工具' : '未配置 · 不可自动运行'}
                  </span>
                </div>
              ))}
              <p className="settings-note" data-testid="wb-studio-editor-steps-note">
                本地媒体处理需要外部工具，未配置时不可自动运行，界面如实标注
              </p>
              <p className="settings-note">
                当前执行状态：{ready ? `执行端点已配置 ${cfg.generation.endpoint}` : '执行端点未配置（不会自动运行）'}
              </p>
            </div>
          </div>

          {/* 中：槽位与连线示意 */}
          <div className="st-col" data-testid="wb-studio-editor-slots">
            <div className="st-col-head">槽位与连线示意（{draft.slots.length} 槽位 / {draft.edges.length} 连线）</div>
            <div className="st-slot-list">
              {draft.slots.length === 0 ? (
                <div className="list-empty">从左侧添加节点类型</div>
              ) : draft.slots.map((s, i) => (
                <div key={s.nodeId}>
                  <div
                    className={`st-slot ${draft.selectedId === s.nodeId ? 'st-slot--sel' : ''}`}
                    data-testid="wb-studio-editor-slot"
                    onClick={() => commit((d) => ({ ...d, selectedId: s.nodeId }))}
                  >
                    <span className="st-slot-idx">{i + 1}</span>
                    <span className="st-slot-name">{s.name}</span>
                    <span className="st-slot-role">{s.role}</span>
                    <span className="st-slot-ops">
                      <button className="mini-btn" data-testid="wb-studio-editor-slot-up" onClick={(ev) => { ev.stopPropagation(); moveSlot(i, -1); }}>↑</button>
                      <button className="mini-btn" data-testid="wb-studio-editor-slot-down" onClick={(ev) => { ev.stopPropagation(); moveSlot(i, 1); }}>↓</button>
                      <button className="mini-btn st-danger" data-testid="wb-studio-editor-slot-del" onClick={(ev) => { ev.stopPropagation(); removeSlot(s.nodeId); }}>×</button>
                    </span>
                  </div>
                  {i < draft.slots.length - 1 && <div className="st-arrow">↓ 连线</div>}
                </div>
              ))}
            </div>
            <div className="st-col-head">内部连线（点 × 删除）</div>
            <div className="st-edge-list" data-testid="wb-studio-editor-edges">
              {draft.edges.length === 0 ? (
                <div className="list-empty">暂无连线</div>
              ) : draft.edges.map((e, i) => (
                <div className="st-edge-item" key={i}>
                  <span>{nameOf(e.from)} → {nameOf(e.to)}</span>
                  <button className="mini-btn" onClick={() => removeEdge(i)}>×</button>
                </div>
              ))}
            </div>
          </div>

          {/* 右：选中槽位属性 */}
          <div className="st-col" data-testid="wb-studio-editor-props">
            <div className="st-col-head">槽位属性</div>
            {selected ? (
              <>
                <div className="settings-field">
                  <label>名称</label>
                  <input className="dialog-input" data-testid="wb-studio-editor-name" value={selected.name} onChange={(e) => patchSelected({ name: e.target.value })} />
                </div>
                <div className="settings-field">
                  <label>用途 role</label>
                  <select
                    className="dialog-input"
                    data-testid="wb-studio-editor-role"
                    value={selected.role}
                    onChange={(e) => patchSelected({ role: e.target.value as WorkflowSlot['role'] })}
                  >
                    <option value="input">input · 输入</option>
                    <option value="fixed">fixed · 固定素材</option>
                    <option value="process">process · 处理</option>
                    <option value="output">output · 输出</option>
                  </select>
                </div>
                <div className="settings-field">
                  <label>提示词</label>
                  <textarea className="dialog-input" rows={4} data-testid="wb-studio-editor-prompt" value={selected.prompt ?? ''} onChange={(e) => patchSelected({ prompt: e.target.value })} />
                </div>
                <div className="settings-field">
                  <label>参数（JSON 文本）</label>
                  <textarea className="dialog-input" rows={4} data-testid="wb-studio-editor-params" value={selected.params ?? ''} onChange={(e) => patchSelected({ params: e.target.value })} />
                </div>
                <p className="settings-note">
                  端口：入 {portsOf(selected).inPort} / 出 {portsOf(selected).outPort}；端口类型不匹配会在保存时拦截。
                </p>
              </>
            ) : (
              <div className="list-empty">在中间栏选中一个槽位进行编辑</div>
            )}
          </div>
        </div>

        {errors.length > 0 && (
          <div className="st-errors" data-testid="wb-studio-editor-validate">
            {errors.map((e, i) => <div className="st-error" key={i}>· {e}</div>)}
          </div>
        )}

        <div className="dialog-foot st-editor-foot">
          <button className="ghost-btn" data-testid="wb-studio-editor-undo" onClick={undo} disabled={hist.index === 0}>撤销</button>
          <button className="ghost-btn" data-testid="wb-studio-editor-redo" onClick={redo} disabled={hist.index >= hist.items.length - 1}>重做</button>
          <span className="st-hint">历史 {hist.index + 1}/{hist.items.length}</span>
          <span className="st-spacer" />
          <button className="ghost-btn" data-testid="wb-studio-editor-close" onClick={onClose}>关闭</button>
          <button className="primary-btn" data-testid="wb-studio-editor-save" onClick={save}>保存并更新版本</button>
        </div>
      </div>
    </div>
  );
}

/* ==================== 组件 3：时间线编辑器 ==================== */

interface Preset { name: string; group: string; track: number; duration: number; kind: string }
const PRESETS: Preset[] = [
  { name: '主画面片段', group: '画面片段', track: 0, duration: 6, kind: 'video' },
  { name: '空镜 B-roll', group: '画面片段', track: 0, duration: 4, kind: 'video' },
  { name: '转场片段', group: '画面片段', track: 0, duration: 1.5, kind: 'video' },
  { name: '封面定格', group: '画面片段', track: 1, duration: 3, kind: 'image' },
  { name: '标题字幕', group: '字幕/文字', track: 1, duration: 2, kind: 'subtitle' },
  { name: '对白字幕', group: '字幕/文字', track: 1, duration: 4, kind: 'subtitle' },
  { name: '注释文字', group: '字幕/文字', track: 1, duration: 3, kind: 'text' },
  { name: '片尾字幕', group: '字幕/文字', track: 1, duration: 5, kind: 'subtitle' },
];

interface ParsedCmd { type: string; payload: Record<string, unknown>; desc: string }

/** 本机规则解析：把自然语言拆成若干条时间线命令（不发起任何模型请求）。 */
function parseInstruction(text: string, clips: TimelineClip[], selectedId: string | null): ParsedCmd[] {
  const parts = text.split(/[，,；;、]|然后|接着/).map((s) => s.replace(/^再/, '').trim()).filter(Boolean);
  const out: ParsedCmd[] = [];
  const nextStart = (track: number): number =>
    clips.filter((c) => c.track === track).reduce((m, c) => Math.max(m, c.start + c.duration), 0);
  const fallbackId = selectedId ?? clips[0]?.id ?? '';

  for (const part of parts) {
    let m: RegExpMatchArray | null;
    if ((m = part.match(/第\s*(\d+)\s*段.*?(?:移到|移动到|移至|移动至|挪到|起点设为?)\s*(\d+(?:\.\d+)?)\s*秒?/))) {
      const id = clips[Number(m[1]) - 1]?.id ?? '';
      out.push({ type: 'move', payload: { id, start: Number(m[2]) }, desc: `第 ${m[1]} 段起点 → ${m[2]} 秒` });
      continue;
    }
    if ((m = part.match(/第\s*(\d+)\s*段.*?开头/))) {
      const id = clips[Number(m[1]) - 1]?.id ?? '';
      out.push({ type: 'move', payload: { id, start: 0 }, desc: `第 ${m[1]} 段移到开头(0 秒)` });
      continue;
    }
    if ((m = part.match(/(?:删除|去掉|移除)\s*第\s*(\d+)\s*段/))) {
      const id = clips[Number(m[1]) - 1]?.id ?? '';
      out.push({ type: 'remove', payload: { id }, desc: `删除第 ${m[1]} 段` });
      continue;
    }
    if (/删除(选中|当前|该)?片段/.test(part)) {
      out.push({ type: 'remove', payload: { id: fallbackId }, desc: '删除当前选中片段' });
      continue;
    }
    if ((m = part.match(/第\s*(\d+)\s*段.*?(?:修剪|裁剪|时长改为?|时长设为?|时长)\s*(?:到|为|=)?\s*(\d+(?:\.\d+)?)\s*秒?/))) {
      const id = clips[Number(m[1]) - 1]?.id ?? '';
      out.push({ type: 'trim', payload: { id, duration: Number(m[2]) }, desc: `第 ${m[1]} 段时长 → ${m[2]} 秒` });
      continue;
    }
    if (/拆分/.test(part)) {
      const n = part.match(/(\d+(?:\.\d+)?)/);
      const at = n ? Number(n[1]) : 2;
      out.push({ type: 'split', payload: { id: fallbackId, at }, desc: `在 ${at} 秒(片段内)拆分当前片段` });
      continue;
    }
    if (/添加|新增|插入/.test(part)) {
      const isText = /字幕|文字|标题/.test(part);
      const track = isText ? 1 : 0;
      const label = isText ? '字幕片段' : '新片段';
      const duration = isText ? 3 : 4;
      out.push({
        type: 'add',
        payload: { track, start: nextStart(track), duration, label, kind: isText ? 'subtitle' : 'video' },
        desc: `添加${label}到轨道 ${track + 1}`,
      });
      continue;
    }
  }
  return out;
}

export function TimelineEditor({ onClose, onNotice }: { onClose: () => void; onNotice: Notice }) {
  const [projectId] = useState<string>(() => studioState().projectId);
  const [hist, setHist] = useState<{ items: TimelineState[]; index: number }>(() => {
    const loaded = loadTimeline(projectId);
    return { items: [{ ...loaded, projectId }], index: 0 };
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cutPoint, setCutPoint] = useState('2');
  const [durationInput, setDurationInput] = useState('4');
  const [startInput, setStartInput] = useState('0');
  const [aiText, setAiText] = useState('');
  const [pending, setPending] = useState<{ cmds: TimelineCommand[]; desc: string[] } | null>(null);

  const timeline = hist.items[hist.index];
  const selected = timeline.clips.find((c) => c.id === selectedId) ?? null;
  const maxEnd = Math.max(10, ...timeline.clips.map((c) => c.start + c.duration)) + 2;
  const ticks: number[] = [];
  for (let t = 0; t <= Math.ceil(maxEnd); t += 2) ticks.push(t);
  const textReady = textChannelReady();

  const mk = (type: string, payload: Record<string, unknown>): TimelineCommand => ({ type, payload, at: Date.now() });

  const commit = (next: TimelineState) => setHist((h) => {
    const items = [...h.items.slice(0, h.index + 1), { ...next, projectId }].slice(-HISTORY_LIMIT);
    return { items, index: items.length - 1 };
  });

  /** 整批执行：任一条失败即回滚到原状态并拒绝全部命令。 */
  const runCommands = (cmds: TimelineCommand[]): boolean => {
    if (cmds.length === 0) { onNotice('没有可执行的命令'); return false; }
    let working: TimelineState = { ...timeline, projectId };
    for (const cmd of cmds) {
      const res = applyTimelineCommand(working, cmd);
      if (!res.ok) {
        saveTimeline({ ...timeline, projectId });
        onNotice(`命令整批拒绝：${res.reason}；已回滚，不产生半应用状态`);
        return false;
      }
      working = res.state;
    }
    saveTimeline({ ...working, projectId });
    commit(working);
    onNotice(`已应用 ${cmds.length} 条命令并持久化（项目 ${projectId}）`);
    return true;
  };

  const nextStartOn = (track: number): number =>
    timeline.clips.filter((c) => c.track === track).reduce((m, c) => Math.max(m, c.start + c.duration), 0);

  const needSelected = (): boolean => {
    if (!selectedId) { onNotice('请先点击轨道上的片段以选中'); return false; }
    return true;
  };

  const onAdd = () => runCommands([mk('add', { track: 0, start: nextStartOn(0), duration: 4, label: '新片段', kind: 'video' })]);
  const onRemove = () => {
    if (!needSelected()) return;
    if (runCommands([mk('remove', { id: selectedId })])) setSelectedId(null);
  };
  const onSplit = () => {
    if (!needSelected()) return;
    const at = Number(cutPoint);
    if (!Number.isFinite(at) || at <= 0) { onNotice('拆分失败：请输入有效的切点(片段内秒数)'); return; }
    runCommands([mk('split', { id: selectedId, at })]);
  };
  const onTrim = () => {
    if (!needSelected()) return;
    const d = Number(durationInput);
    if (!Number.isFinite(d) || d <= 0) { onNotice('修剪失败：请输入有效时长'); return; }
    runCommands([mk('trim', { id: selectedId, duration: d })]);
  };
  const onMove = () => {
    if (!needSelected()) return;
    const s = Number(startInput);
    if (!Number.isFinite(s) || s < 0) { onNotice('移动失败：请输入有效起点'); return; }
    runCommands([mk('move', { id: selectedId, start: s })]);
  };

  const onUndo = () => {
    const index = Math.max(0, hist.index - 1);
    setHist({ ...hist, index });
    saveTimeline({ ...hist.items[index], projectId });
    onNotice(`撤销到历史第 ${index + 1}/${hist.items.length} 层`);
  };
  const onRedo = () => {
    const index = Math.min(hist.items.length - 1, hist.index + 1);
    setHist({ ...hist, index });
    saveTimeline({ ...hist.items[index], projectId });
    onNotice(`重做到历史第 ${index + 1}/${hist.items.length} 层`);
  };
  const onSave = () => {
    saveTimeline({ ...timeline, projectId });
    logEvent('timeline', '手动保存时间线', `${timeline.clips.length} 个片段`);
    onNotice(`时间线已保存（项目 ${projectId}，${timeline.clips.length} 个片段）`);
  };

  const addPreset = (p: Preset) => runCommands([
    mk('add', { track: p.track, start: nextStartOn(p.track), duration: p.duration, label: p.name, kind: p.kind }),
  ]);

  const onTranscribe = () => {
    const gate = executionGate();
    if (!gate.allowed) {
      logEvent('timeline', '语音转写被拒绝', gate.reason);
      onNotice(`语音转写失败：${gate.reason}`);
      return;
    }
    logEvent('timeline', '语音转写意图已记录');
    onNotice('已记录语音转写意图；真实转写需外部服务执行，本界面不声称已产生转写结果');
  };

  const onExportFilm = () => {
    const gate = executionGate();
    if (!gate.allowed) {
      logEvent('timeline', '成片导出被拒绝', gate.reason);
      onNotice(`成片导出失败：${gate.reason}`);
      return;
    }
    logEvent('timeline', '成片导出意图已记录');
    onNotice('成片导出未执行：本界面不输出成片文件，已记录导出意图；真实成片需外部渲染服务返回，绝不声称已输出成片');
  };

  const onExportPlan = () => {
    const plan = {
      projectId,
      generatedAt: new Date().toISOString(),
      clips: timeline.clips,
      note: '仅导出渲染计划 JSON，不代表成片已输出',
    };
    saveBlob(new Blob([JSON.stringify(plan, null, 2)], { type: 'application/json' }), `render-plan-${projectId}.json`);
    logEvent('timeline', '导出渲染计划', `${timeline.clips.length} 个片段`);
    onNotice(`已导出渲染计划 JSON（${timeline.clips.length} 个片段）；仅为计划，不代表成片已输出`);
  };

  const onAiRun = () => {
    const parsed = parseInstruction(aiText, timeline.clips, selectedId);
    if (parsed.length === 0) {
      onNotice('AI 编辑助手：未识别到可执行命令（示例：在 3 秒拆分、把第 2 段移到 0 秒）');
      return;
    }
    const cmds: TimelineCommand[] = parsed.map((p) => ({ type: p.type, payload: p.payload, at: Date.now() }));
    if (cmds.length > 3) {
      setPending({ cmds, desc: parsed.map((p) => p.desc) });
      onNotice(`解析出 ${cmds.length} 条命令（超过 3 条），已生成差异预览，请确认后执行`);
    } else {
      runCommands(cmds);
    }
  };

  const onAiConfirm = () => {
    if (!pending) return;
    runCommands(pending.cmds);
    setPending(null);
  };

  return (
    <div className="modal-mask" data-testid="wb-studio-timeline">
      <div className="dialog st-timeline st-dialog-wide">
        <div className="dialog-head">时间线编辑器 · 项目 {projectId}</div>
        <div className="dialog-body st-tl-body">
          {/* 左：8 个片段/字幕预设，分组显示 */}
          <div className="st-tl-left" data-testid="wb-studio-timeline-presets">
            <div className="st-col-head">添加预设（点击即添加）</div>
            {Array.from(new Set(PRESETS.map((p) => p.group))).map((g) => (
              <div className="st-preset-group" key={g}>
                <div className="section-title">{g}</div>
                {PRESETS.filter((p) => p.group === g).map((p) => (
                  <button className="st-preset" key={p.name} data-testid="wb-studio-timeline-preset" onClick={() => addPreset(p)}>
                    <Glyph name="plus" size={11} /> {p.name}
                    <span className="st-hint">轨{p.track + 1} · {p.duration}s</span>
                  </button>
                ))}
              </div>
            ))}
          </div>

          {/* 中：工具栏 + 双轨道视图 */}
          <div className="st-tl-center">
            <div className="st-tl-toolbar" data-testid="wb-studio-timeline-toolbar">
              <button className="mini-btn" data-testid="wb-studio-timeline-add" onClick={onAdd}>添加片段</button>
              <button className="mini-btn" data-testid="wb-studio-timeline-remove" onClick={onRemove}>删除</button>
              <span className="st-tl-num">切点<input className="dialog-input" value={cutPoint} onChange={(e) => setCutPoint(e.target.value)} /></span>
              <button className="mini-btn" data-testid="wb-studio-timeline-split" onClick={onSplit}>拆分</button>
              <span className="st-tl-num">时长<input className="dialog-input" value={durationInput} onChange={(e) => setDurationInput(e.target.value)} /></span>
              <button className="mini-btn" data-testid="wb-studio-timeline-trim" onClick={onTrim}>修剪</button>
              <span className="st-tl-num">起点<input className="dialog-input" value={startInput} onChange={(e) => setStartInput(e.target.value)} /></span>
              <button className="mini-btn" data-testid="wb-studio-timeline-move" onClick={onMove}>移动</button>
              <span className="st-tl-sep" />
              <button className="mini-btn" data-testid="wb-studio-timeline-undo" onClick={onUndo} disabled={hist.index === 0}>撤销</button>
              <button className="mini-btn" data-testid="wb-studio-timeline-redo" onClick={onRedo} disabled={hist.index >= hist.items.length - 1}>重做</button>
              <span className="st-hint">历史 {hist.index + 1}/{hist.items.length}（上限 {HISTORY_LIMIT}）</span>
            </div>

            <div className="st-status" data-testid="wb-studio-timeline-status">
              {selected
                ? `选中：${selected.label} · 起点 ${selected.start}s · 时长 ${selected.duration}s · 轨道 ${selected.track + 1}`
                : '未选中片段（点击轨道上的片段）'}
            </div>

            <div className="st-tracks" data-testid="wb-studio-timeline-tracks">
              <div className="st-ruler" style={{ width: maxEnd * PX_PER_SEC }}>
                {ticks.map((t) => (
                  <div className="st-ruler-tick" key={t} style={{ left: t * PX_PER_SEC }}>{t}s</div>
                ))}
              </div>
              {[0, 1].map((track) => (
                <div className="st-track" key={track} data-testid="wb-studio-timeline-track">
                  <div className="st-track-label">轨道 {track + 1}</div>
                  <div className="st-track-lane" style={{ width: maxEnd * PX_PER_SEC }}>
                    {timeline.clips.filter((c) => c.track === track).map((c) => (
                      <div
                        className={`st-clip ${selectedId === c.id ? 'st-clip--sel' : ''}`}
                        key={c.id}
                        data-testid="wb-studio-timeline-clip"
                        style={{ left: c.start * PX_PER_SEC, width: Math.max(24, c.duration * PX_PER_SEC) }}
                        onClick={() => setSelectedId(c.id)}
                        title={`${c.label} · ${c.start}s + ${c.duration}s`}
                      >
                        <div className="st-clip-label">{c.label}</div>
                        <div className="st-clip-meta">{c.duration.toFixed(1)}s</div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <p className="settings-note">
              所有编辑均通过 applyTimelineCommand(state, {'{type,payload,at}'}) 执行；任一条失败整批拒绝并回滚。
            </p>
          </div>

          {/* 右：执行 / 导出 / AI 编辑助手 */}
          <div className="st-tl-right">
            <div className="st-col-head">执行与导出</div>
            <button className="mini-btn" data-testid="wb-studio-timeline-transcribe" onClick={onTranscribe}>语音转写</button>
            <button className="mini-btn" data-testid="wb-studio-timeline-export-film" onClick={onExportFilm}>成片导出</button>
            <button className="mini-btn" data-testid="wb-studio-timeline-export-plan" onClick={onExportPlan}>导出渲染计划</button>
            <p className="settings-note">
              「语音转写」「成片导出」先经 executionGate()；未配置时显示明确失败原因，绝不声称已输出成片。
            </p>

            <div className="st-ai">
              <div className="st-col-head">AI 编辑助手</div>
              <div className="settings-note" data-testid="wb-studio-timeline-ai-label">
                {textReady
                  ? '文本模型已配置；助手仍使用本机规则解析，不发起模型请求'
                  : '未配置文本模型 · 使用本机规则解析'}
              </div>
              <textarea
                className="dialog-input"
                rows={4}
                data-testid="wb-studio-timeline-ai-input"
                value={aiText}
                onChange={(e) => setAiText(e.target.value)}
                placeholder="例如：在 3 秒拆分，把第 2 段移到 0 秒"
              />
              <button className="mini-btn" data-testid="wb-studio-timeline-ai-run" onClick={onAiRun}>解析并执行</button>
              <p className="settings-note">
                最多 3 条直接执行；超过 3 条先显示差异预览再确认。示例：在 3 秒拆分、把第 2 段移到 0 秒、删除第 1 段。
              </p>
              {pending && (
                <div className="st-ai-preview" data-testid="wb-studio-timeline-ai-preview">
                  <div className="st-col-head">差异预览（{pending.cmds.length} 条）</div>
                  {pending.desc.map((d, i) => <div className="st-ai-line" key={i}>{i + 1}. {d}</div>)}
                  <div className="st-ai-actions">
                    <button className="ghost-btn" onClick={() => setPending(null)}>取消</button>
                    <button className="primary-btn" data-testid="wb-studio-timeline-ai-confirm" onClick={onAiConfirm}>确认执行</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="dialog-foot">
          <button className="ghost-btn" data-testid="wb-studio-timeline-save" onClick={onSave}>保存时间线</button>
          <span className="st-spacer" />
          <button className="ghost-btn" data-testid="wb-studio-timeline-close" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
