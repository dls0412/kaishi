import './styles.css';
import { useState } from 'react';
import { useCanvas } from '../../store';
import { config, patchSection, applyAppearance, saveWorkflow, logEvent } from '../../lib/workbenchRuntime';
import { getAsset, listAssets, putAsset } from '../../lib/db';
import { freeCanvasPosition, uid } from '../../lib/utils';
import Icon from '../../components/Icon';
import { NODE_DEFAULTS, type CanvasNode, type Edge } from '../../types';
import type { NoticeFn, NoticeTone } from '../notice';

type Notice = NoticeFn;
type Level = NoticeTone;

interface StoreLike {
  updateNodesLive: (nodes: CanvasNode[]) => void;
  updateNode: (id: string, patch: Record<string, unknown>) => void;
  createNode: (type: string, at: { x: number; y: number }) => unknown;
  addEdge: (edge: Edge) => void;
  groupSelection: () => void;
  updateNodeParams: (id: string, patch: Record<string, unknown>) => void;
}

function store(): StoreLike {
  return useCanvas.getState() as unknown as StoreLike;
}

function allNodes(): CanvasNode[] {
  return useCanvas.getState().nodes as unknown as CanvasNode[];
}

function allEdges(): Edge[] {
  return useCanvas.getState().edges as unknown as Edge[];
}

function report(onNotice: Notice | undefined, kind: string, message: string, level: Level = 'ok'): void {
  logEvent(kind, message);
  onNotice?.(message, level);
}

function patchAppearance(patch: Record<string, unknown>): void {
  patchSection<'appearance'>('appearance', patch as unknown as never);
  applyAppearance();
}

function readSection(section: 'workspace' | 'appearance'): Record<string, unknown> {
  const cfg = config() as unknown as Record<string, Record<string, unknown>>;
  return cfg[section] ?? {};
}

function orderedNodes(sel: string[], all: CanvasNode[]): CanvasNode[] {
  const map = new Map(all.map((n) => [n.id, n]));
  return sel.map((id) => map.get(id)).filter((n): n is CanvasNode => Boolean(n));
}

/** 兼容「直接传节点数组」与「传更新函数」两种 store 实现 */
function liveUpdate(next: CanvasNode[]): void {
  const fn = store().updateNodesLive as unknown as (...args: unknown[]) => void;
  let applied = false;
  try {
    fn(next);
    const cur = allNodes();
    applied = next.every((n) => {
      const c = cur.find((x) => x.id === n.id);
      return c !== undefined && c.x === n.x && c.y === n.y;
    });
  } catch {
    applied = false;
  }
  if (!applied) fn(() => next);
}

function applyPositions(pos: Map<string, { x: number; y: number }>): void {
  liveUpdate(allNodes().map((n) => {
    const p = pos.get(n.id);
    return p ? { ...n, x: p.x, y: p.y } : n;
  }));
}

function connectSequential(sel: string[]): number {
  const fn = store().addEdge as unknown as (...args: unknown[]) => void;
  const existing = new Set(allEdges().map((e) => `${e.from}->${e.to}`));
  const pairForm = fn.length >= 2;
  let count = 0;
  for (let i = 0; i < sel.length - 1; i += 1) {
    const from = sel[i];
    const to = sel[i + 1];
    if (from === to) continue;
    const key = `${from}->${to}`;
    if (existing.has(key)) continue;
    existing.add(key);
    if (pairForm) fn(from, to);
    else fn({
      id: `edge_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`,
      from, to, label: '', color: '#94a3b8', kind: 'link',
    } as Edge);
    count += 1;
  }
  return count;
}

function normalizeHex(raw: string): string | null {
  const s = raw.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(s)) return `#${s.split('').map((ch) => ch + ch).join('')}`;
  if (/^[0-9a-fA-F]{6}$/.test(s)) return `#${s}`;
  return null;
}

function createImageNode(at: { x: number; y: number }): string {
  const before = new Set(allNodes().map((n) => n.id));
  const ret = store().createNode('image', at);
  if (typeof ret === 'string' && ret) return ret;
  if (ret && typeof ret === 'object' && 'id' in ret) return String((ret as { id: unknown }).id);
  const added = allNodes().find((n) => !before.has(n.id));
  return added?.id ?? '';
}

function blockSet(side: number): Set<string> {
  const s = new Set<string>();
  for (let r = 0; r < side; r += 1) {
    for (let c = 0; c < side; c += 1) s.add(`${r}-${c}`);
  }
  return s;
}

function cellOrder(keys: string[]): string[] {
  return [...keys].sort((a, b) => {
    const ap = a.split('-');
    const bp = b.split('-');
    return Number(ap[0]) - Number(bp[0]) || Number(ap[1]) - Number(bp[1]);
  });
}

function isBlock(cells: Set<string>, n: number): boolean {
  const want = blockSet(Math.sqrt(n));
  return want.size === cells.size && [...want].every((k) => cells.has(k));
}

const PRESETS = [4, 9, 16, 25];
const ANGLES = [
  { key: 'front', label: '正面' },
  { key: 'side', label: '侧面' },
  { key: 'back', label: '背面' },
  { key: 'top', label: '俯视' },
  { key: 'low', label: '仰视' },
  { key: 'a45', label: '45°' },
];
const THEMES = [
  { value: 'global', label: '跟随全局' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'custom', label: '自定义' },
];
const GRIDS = [
  { value: 'dots', label: '点阵' },
  { value: 'lines', label: '线稿' },
  { value: 'none', label: '空白' },
];

/* ==================== 1. 多选悬浮工具条 ==================== */

export function SelectionToolbar({ onNotice }: { onNotice?: Notice }) {
  const selection = useCanvas((s) => s.selection) as unknown as string[];
  const [saving, setSaving] = useState(false);
  const [wfName, setWfName] = useState('');

  if (!selection || selection.length < 2) return null;

  const picked = () => orderedNodes(selection, allNodes());

  const alignLeft = () => {
    const p = picked();
    if (p.length === 0) return;
    const minX = Math.min(...p.map((n) => n.x));
    const pos = new Map<string, { x: number; y: number }>();
    p.forEach((n) => pos.set(n.id, { x: minX, y: n.y }));
    applyPositions(pos);
    report(onNotice, 'align', `已将 ${p.length} 个节点左对齐`);
  };

  const distribute = (axis: 'x' | 'y', label: string) => {
    const p = picked();
    if (p.length === 0) return;
    const sorted = [...p].sort((a, b) => a[axis] - b[axis]);
    const first = Math.min(...sorted.map((n) => n[axis]));
    const last = Math.max(...sorted.map((n) => n[axis]));
    const step = sorted.length > 1 ? (last - first) / (sorted.length - 1) : 0;
    const pos = new Map<string, { x: number; y: number }>();
    sorted.forEach((n, i) => pos.set(n.id, axis === 'x'
      ? { x: first + step * i, y: n.y }
      : { x: n.x, y: first + step * i }));
    applyPositions(pos);
    report(onNotice, 'distribute', `${label}：${p.length} 个节点已按坐标均匀分布在首末之间`);
  };

  const alignVCenter = () => {
    const p = picked();
    if (p.length === 0) return;
    const minY = Math.min(...p.map((n) => n.y));
    const maxY = Math.max(...p.map((n) => n.y + n.h));
    const cy = (minY + maxY) / 2;
    const pos = new Map<string, { x: number; y: number }>();
    p.forEach((n) => pos.set(n.id, { x: n.x, y: cy - n.h / 2 }));
    applyPositions(pos);
    report(onNotice, 'align', `已将 ${p.length} 个节点垂直居中`);
  };

  const group = () => {
    store().groupSelection();
    report(onNotice, 'group', '已按当前选择创建分镜组');
  };

  const connect = () => {
    const n = connectSequential(selection);
    report(onNotice, 'connect', n > 0
      ? `已按选择顺序新增 ${n} 条连线（自连与已存在边已跳过）`
      : '没有可新增的连线，自连与已存在边已跳过', n > 0 ? 'ok' : 'info');
  };

  const openSave = () => { setSaving(true); setWfName(''); };

  const confirmSave = () => {
    const name = wfName.trim() || '未命名工作流';
    const sel = picked();
    const ids = new Set(sel.map((n) => n.id));
    const inner = allEdges().filter((e) => ids.has(e.from) && ids.has(e.to));
    saveWorkflow(name, sel, inner);
    setSaving(false);
    setWfName('');
    report(onNotice, 'workflow', `已保存工作流「${name}」，含 ${sel.length} 个节点与 ${inner.length} 条内部边`);
  };

  const tidy = () => {
    const p = picked();
    if (p.length === 0) return;
    const cx = p.reduce((s, n) => s + n.x + n.w / 2, 0) / p.length;
    const cy = p.reduce((s, n) => s + n.y + n.h / 2, 0) / p.length;
    const k = 1.35;
    const pos = new Map<string, { x: number; y: number }>();
    p.forEach((n) => pos.set(n.id, {
      x: cx + (n.x + n.w / 2 - cx) * k - n.w / 2,
      y: cy + (n.y + n.h / 2 - cy) * k - n.h / 2,
    }));
    applyPositions(pos);
    report(onNotice, 'tidy', `已保持相对关系向外扩散 ${p.length} 个节点，未重排成宫格`);
  };

  return (
    <>
      <div className="ct-toolbar" data-testid="wb-canvas-selection-toolbar">
        <span className="ct-count" data-testid="wb-canvas-selection-count">已选 {selection.length}</span>
        <span className="ct-divider" />
        <button type="button" className="mini-btn ct-tool-btn" data-testid="wb-canvas-align-left" onClick={alignLeft}><Icon name="grid" />左对齐</button>
        <button type="button" className="mini-btn ct-tool-btn" data-testid="wb-canvas-distribute-h" onClick={() => distribute('x', '水平等距')}><Icon name="grid" />水平等距</button>
        <button type="button" className="mini-btn ct-tool-btn" data-testid="wb-canvas-distribute-v" onClick={() => distribute('y', '垂直等距')}><Icon name="grid" />垂直等距</button>
        <button type="button" className="mini-btn ct-tool-btn" data-testid="wb-canvas-align-vcenter" onClick={alignVCenter}><Icon name="layers" />垂直居中</button>
        <span className="ct-divider" />
        <button type="button" className="mini-btn ct-tool-btn" data-testid="wb-canvas-group" onClick={group}><Icon name="image" />创建分镜组</button>
        <button type="button" className="mini-btn ct-tool-btn" data-testid="wb-canvas-connect" onClick={connect}><Icon name="plus" />批量连接</button>
        <button type="button" className="mini-btn ct-tool-btn" data-testid="wb-canvas-save-workflow" onClick={openSave}><Icon name="check" />保存为工作流</button>
        <button type="button" className="mini-btn ct-tool-btn" data-testid="wb-canvas-tidy" onClick={tidy}><Icon name="sparkles" />自适应整理</button>
      </div>
      {saving && (
        <div className="ct-save-pop" data-testid="wb-canvas-workflow-pop">
          <input className="dialog-input ct-input" data-testid="wb-canvas-workflow-name" value={wfName} placeholder="工作流名称" onChange={(e) => setWfName(e.target.value)} />
          <button type="button" className="primary-btn" data-testid="wb-canvas-workflow-confirm" onClick={confirmSave}>保存</button>
          <button type="button" className="ghost-btn" data-testid="wb-canvas-workflow-cancel" onClick={() => setSaving(false)}>取消</button>
        </div>
      )}
    </>
  );
}

/* ==================== 2. 图片宫格切分弹窗 ==================== */

export function GridSplitDialog({ nodeId, onClose, onNotice }: { nodeId: string; onClose: () => void; onNotice?: Notice }) {
  const nodes = useCanvas((s) => s.nodes) as unknown as CanvasNode[];
  const [cells, setCells] = useState<Set<string>>(() => blockSet(2));
  const parent = nodes.find((n) => n.id === nodeId);
  const rawMedia = parent as unknown as { assetId?: string; fileName?: string } | undefined;
  const hasAsset = Boolean(rawMedia?.assetId);
  const ordered = cellOrder([...cells]);
  const count = ordered.length;

  const toggle = (key: string) => {
    setCells((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const usePreset = (n: number) => {
    setCells(blockSet(Math.sqrt(n)));
    report(onNotice, 'grid-preset', `已选择 ${n} 格预设`, 'info');
  };

  const applyAngle = (label: string) => {
    const cur = allNodes().find((n) => n.id === nodeId);
    if (!cur) {
      report(onNotice, 'grid-angle', '节点不存在，无法追加角度', 'err');
      return;
    }
    const p = cur as unknown as { imageParams?: { prompt?: string }; videoParams?: { prompt?: string } };
    const base = p.imageParams?.prompt ?? p.videoParams?.prompt ?? '';
    store().updateNode(nodeId, { name: `${cur.name} · ${label}` });
    store().updateNodeParams(nodeId, { prompt: base ? `${base} · ${label}` : label });
    report(onNotice, 'grid-angle', `已把角度「${label}」追加到节点名称与提示词`);
  };

  const confirm = async () => {
    if (!parent) {
      report(onNotice, 'grid-split', '原节点不存在，无法切分', 'err');
      return;
    }
    if (count === 0) {
      report(onNotice, 'grid-split', '请先选择至少一个方格', 'err');
      return;
    }
    const media = parent as unknown as { assetId?: string; fileName?: string };
    const gw = parent.w || 300;
    const gh = parent.h || 230;
    const gap = 40;
    const baseX = parent.x + gw + 80;
    const baseY = parent.y;
    const parts = ordered.map((key) => key.split('-').map(Number));
    const rows = Math.max(...parts.map((p) => p[0])) + 1;
    const cols = Math.max(...parts.map((p) => p[1])) + 1;

    // 有原图时真正裁出子图：每张单独写入本机素材库，子节点各自引用自己的 assetId
    let bitmap: ImageBitmap | null = null;
    let sourceMime = 'image/png';
    if (media.assetId) {
      const record = await getAsset(media.assetId);
      if (record) {
        sourceMime = record.meta.mime?.startsWith('image/jpeg') ? 'image/jpeg' : 'image/png';
        try { bitmap = await createImageBitmap(record.blob); }
        catch { bitmap = null; }
      }
    }
    if (media.assetId && !bitmap) {
      report(onNotice, 'grid-split', '原图无法读取，未执行切分，请检查素材后重试', 'err');
      return;
    }
    if (bitmap && (bitmap.width < cols || bitmap.height < rows)) {
      bitmap.close();
      report(onNotice, 'grid-split', '图片尺寸小于宫格数量，无法切分', 'err');
      return;
    }

    let made = 0;
    let cropped = 0;
    const newAssets: string[] = [];
    for (let i = 0; i < parts.length; i += 1) {
      const [r, c] = parts[i];
      const size = NODE_DEFAULTS.image;
      const position = freeCanvasPosition(allNodes(), { x: baseX + c * (gw + gap), y: baseY + r * (gh + gap) }, size);
      const id = createImageNode({ x: position.x + size.w / 2, y: position.y + size.h / 2 });
      if (!id) continue;
      let assetId = media.assetId ?? '';
      let fileName = media.fileName ?? '';
      if (bitmap) {
        const left = Math.floor(c * bitmap.width / cols);
        const top = Math.floor(r * bitmap.height / rows);
        const cw = Math.floor((c + 1) * bitmap.width / cols) - left;
        const ch = Math.floor((r + 1) * bitmap.height / rows) - top;
        const canvas = document.createElement('canvas');
        canvas.width = cw;
        canvas.height = ch;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(bitmap, left, top, cw, ch, 0, 0, cw, ch);
          const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, sourceMime, 0.92));
          if (blob) {
            assetId = uid('asset');
            fileName = `${media.fileName || parent.name} · ${r + 1}-${c + 1}.${sourceMime === 'image/jpeg' ? 'jpg' : 'png'}`;
            await putAsset({
              meta: { id: assetId, name: fileName, mime: blob.type || sourceMime, size: blob.size, kind: 'image', createdAt: Date.now() },
              blob,
            });
            newAssets.push(assetId);
            cropped += 1;
          }
        }
      }
      store().updateNode(id, { name: `${parent.name} · ${i + 1}/${count}`, assetId, fileName });
      made += 1;
    }
    bitmap?.close();
    if (newAssets.length) {
      try { useCanvas.getState().setAssets(await listAssets()); } catch { /* 素材面板刷新失败不影响节点 */ }
    }
    report(onNotice, 'grid-split', bitmap
      ? `已按 ${rows}×${cols} 真实裁出 ${cropped} 张子图，创建 ${made} 个子节点并各自写入本机素材库`
      : hasAsset
        ? `原素材无法在本机解码裁切，已创建 ${made} 个占位节点并沿用原素材，不会假装已切分`
        : `原节点没有素材，只创建了 ${made} 个空白占位节点，不会凭空生成图片`,
    bitmap || !hasAsset ? 'ok' : 'info');
    onClose();
  };

  return (
    <div className="modal-mask ct-mask" data-testid="wb-canvas-split-mask" onClick={onClose}>
      <div className="dialog ct-dialog" data-testid="wb-canvas-split-dialog" role="dialog" aria-label="图片宫格切分" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <span>图片宫格切分</span>
          <button type="button" className="mini-btn" data-testid="wb-canvas-split-close" onClick={onClose}><Icon name="close" /></button>
        </div>
        <div className="dialog-body ct-split-body">
          <div>
            <p className="ct-section-title">预设宫格</p>
            <div className="ct-presets">
              {PRESETS.map((n) => (
                <button key={n} type="button" className={`mini-btn ct-preset ${isBlock(cells, n) ? 'is-on' : ''}`} data-testid={`wb-canvas-preset-${n}`} onClick={() => usePreset(n)}>{n} 格</button>
              ))}
            </div>
          </div>
          <div>
            <p className="ct-section-title">自定义 5×5 方格（可点选切换）</p>
            <div className="ct-cell-grid" data-testid="wb-canvas-split-grid">
              {Array.from({ length: 25 }, (_, i) => {
                const r = Math.floor(i / 5);
                const c = i % 5;
                const key = `${r}-${c}`;
                const on = cells.has(key);
                return (
                  <button key={key} type="button" aria-pressed={on} className={`ct-cell ${on ? 'is-on' : ''}`} data-testid={`wb-canvas-cell-${r}-${c}`} onClick={() => toggle(key)}>
                    {on ? <Icon name="check" /> : null}
                  </button>
                );
              })}
            </div>
            <p className="ct-count-line" data-testid="wb-canvas-split-count">已选 {count} 格，确认后将生成 {count} 个子节点</p>
          </div>
          <div>
            <p className="ct-section-title">角度预设</p>
            <div className="ct-angles">
              {ANGLES.map((a) => (
                <button key={a.key} type="button" className="mini-btn ct-angle" data-testid={`wb-canvas-angle-${a.key}`} onClick={() => applyAngle(a.label)}>{a.label}</button>
              ))}
            </div>
            <p className="settings-note ct-note">角度描述预设，不是 3D 编辑器：点击只把文字追加到节点名称与提示词，不会生成或旋转 3D 模型。</p>
          </div>
          {!hasAsset && <p className="ct-note ct-warn">当前节点没有素材，确认后只创建空白占位节点，不会复制或生成图片内容。</p>}
        </div>
        <div className="dialog-foot ct-foot">
          <button type="button" className="ghost-btn" data-testid="wb-canvas-split-cancel" onClick={onClose}>取消</button>
          <button type="button" className="primary-btn" data-testid="wb-canvas-split-confirm" onClick={confirm}>确认切分</button>
        </div>
      </div>
    </div>
  );
}

/* ==================== 3. 空白画布起始引导 ==================== */

export function CanvasStarter({ onCreate, onImport }: { onCreate: () => void; onImport: () => void }) {
  const nodeCount = useCanvas(s => s.nodes.length);
  if (nodeCount) return null;
  return <div className="ct-starter" data-testid="wb-canvas-starter"><div className="ct-starter-inner">
    <button className="ct-starter-plus" data-testid="wb-canvas-starter-create" onClick={onCreate}><Icon name="plus" /> 新建节点</button>
    <div className="ct-starter-links"><button className="ct-link" onClick={onImport}>导入素材</button></div>
  </div></div>;
}

/* ==================== 4. 外观面板 ==================== */

export function AppearancePanel({ onNotice }: { onNotice?: Notice }) {
  useCanvas((s) => s.settings);
  const a = readSection('appearance');
  const theme = String(a.theme ?? 'global');
  const grid = String(a.grid ?? 'dots');
  const background = String(a.background ?? '#0d0d10');
  const brightness = Number(a.brightness ?? 0);
  const gridColor = String(a.gridColor ?? '#2c2c33');
  const gridStrength = Number(a.gridStrength ?? 40);
  const saved = Boolean(a.savedAsDefault);
  const [bgInput, setBgInput] = useState(background);
  const [gridInput, setGridInput] = useState(gridColor);
  const [bgErr, setBgErr] = useState('');
  const [gridErr, setGridErr] = useState('');

  const patch = (p: Record<string, unknown>, msg?: string) => {
    patchAppearance(p);
    if (msg) report(onNotice, 'appearance', msg);
  };

  const changeBg = (v: string) => {
    setBgInput(v);
    const norm = normalizeHex(v);
    if (!norm) {
      setBgErr('请输入 3 或 6 位 HEX 色值，可不带 #');
      return;
    }
    setBgErr('');
    patch({ background: norm, brightness: 0 });
  };

  const changeGridColor = (v: string) => {
    setGridInput(v);
    const norm = normalizeHex(v);
    if (!norm) {
      setGridErr('请输入 3 或 6 位 HEX 色值，可不带 #');
      return;
    }
    setGridErr('');
    patch({ gridColor: norm });
  };

  const themeLabel = THEMES.find((t) => t.value === theme)?.label ?? theme;
  const gridLabel = GRIDS.find((g) => g.value === grid)?.label ?? grid;

  return (
    <div className="ct-appearance" data-testid="wb-canvas-appearance">
      <div className="ct-row">
        <span className="ct-label">主题</span>
        <div className="ct-seg">
          {THEMES.map((t) => (
            <button key={t.value} type="button" className={`ct-seg-btn ${theme === t.value ? 'is-on' : ''}`} data-testid={`wb-canvas-appearance-theme-${t.value}`} onClick={() => patch({ theme: t.value }, `主题已设为「${t.label}」`)}>{t.label}</button>
          ))}
        </div>
      </div>
      <div className="ct-row">
        <span className="ct-label">网格</span>
        <div className="ct-seg">
          {GRIDS.map((g) => (
            <button key={g.value} type="button" className={`ct-seg-btn ${grid === g.value ? 'is-on' : ''}`} data-testid={`wb-canvas-appearance-grid-${g.value}`} onClick={() => patch({ grid: g.value }, `网格已设为「${g.label}」`)}>{g.label}</button>
          ))}
        </div>
      </div>
      {theme === 'custom' && (
        <div className="ct-custom" data-testid="wb-canvas-appearance-custom">
          <div className="ct-field">
            <span className="ct-field-label">背景色 HEX</span>
            <input className="dialog-input ct-input-sm" data-testid="wb-canvas-appearance-bg" value={bgInput} placeholder="#0d0d10" onChange={(e) => changeBg(e.target.value)} />
            <span className="ct-err">{bgErr}</span>
          </div>
          <div className="ct-field">
            <span className="ct-field-label">明亮度</span>
            <input type="range" className="ct-range" min={-100} max={100} step={1} value={brightness} data-testid="wb-canvas-appearance-brightness" onChange={(e) => patch({ brightness: Number(e.target.value) })} />
            <span className="ct-val">{brightness}</span>
          </div>
          <div className="ct-field">
            <span className="ct-field-label">网格颜色</span>
            <input className="dialog-input ct-input-sm" data-testid="wb-canvas-appearance-grid-color" value={gridInput} placeholder="#2c2c33" onChange={(e) => changeGridColor(e.target.value)} />
            <span className="ct-err">{gridErr}</span>
          </div>
          <div className="ct-field">
            <span className="ct-field-label">网格强度</span>
            <input type="range" className="ct-range" min={0} max={100} step={1} value={gridStrength} data-testid="wb-canvas-appearance-grid-strength" onChange={(e) => patch({ gridStrength: Number(e.target.value) })} />
            <span className="ct-val">{gridStrength}</span>
          </div>
          <p className="ct-note">选择新背景色时明亮度会自动归零。</p>
        </div>
      )}
      <div className="ct-actions">
        <button type="button" className="primary-btn" data-testid="wb-canvas-appearance-save-default" onClick={() => patch({ savedAsDefault: true }, '已保存为默认外观')}><Icon name="check" /> 保存为默认</button>
      </div>
      <div className="settings-note ct-summary" data-testid="wb-canvas-appearance-summary">
        <Icon name="info" />
        <span>当前配置：主题「{themeLabel}」· 网格「{gridLabel}」· 背景 {background} · 明亮度 {brightness} · 网格色 {gridColor} · 强度 {gridStrength}% · {saved ? '已设为默认' : '未设为默认'}</span>
      </div>
    </div>
  );
}
