import { useEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { nodesInGroup, useCanvas, type NodePatch } from '../store';
import { isEmptyMediaNode, type CanvasNode, type GroupNode, type MediaNode, type NodeType, type Viewport } from '../types';
import { rectsIntersect, screenToWorld } from '../lib/utils';
import { canvasApi } from '../lib/canvasApi';
import { controlGeometry } from '../lib/controlGeometry';
import { canOpenPromptPanel } from '../lib/nodeSemantics';
import { groupDefinitionsByCategory, listBasicNodeDefinitions, listExtraNodeDefinitions, type NodeDefinition } from '../lib/nodeRegistry';
import EdgeLayer from './EdgeLayer';
import NodeView from './NodeView';
import NodeCreativeControls from './CreativePanel';
import TextGenerator from './TextGenerator';
import AudioGenerator from './AudioGenerator';
import Icon from './Icon';

type Gesture =
  | { kind: 'pan'; start: { x: number; y: number }; vp: Viewport }
  | { kind: 'marquee'; start: { x: number; y: number }; additive: boolean; moved: boolean }
  | { kind: 'drag'; startWorld: { x: number; y: number }; ids: string[]; origins: Record<string, { x: number; y: number }> }
  | { kind: 'resize'; id: string; handle: string; startWorld: { x: number; y: number }; origin: { x: number; y: number; w: number; h: number }; nodeType: CanvasNode['type'] }
  | { kind: 'connect'; from: string; start: { x: number; y: number } }
  | null;

interface Props {
  onImportFiles: (files: File[], at: { x: number; y: number }) => void;
  onPlaceAsset: (assetId: string, at: { x: number; y: number }, targetNodeId?: string) => void;
  onOpenImage: (assetId: string) => void;
  onCreateNode: (type: NodeType, at: { x: number; y: number }, variant?: string) => void;
  onPasteText: (text: string, at: { x: number; y: number }) => void;
  onFillNode: (nodeId: string, files: File[]) => void;
  onUnsupportedClipboard: (types: string[]) => void;
  onOpenSettings: () => void;
  onNotice: (text: string, kind?: 'ok' | 'err' | 'info') => void;
  shortcutsActive?: boolean;
  focusMode?: boolean;
  onToggleFocus?: () => void;
  onExitFocus?: () => void;
  onOpenSearch?: () => void;
  onOpenShortcuts?: () => void;
  onNodeTool?: (tool: 'expand' | 'optimize' | 'split', id: string) => void;
}

const INTERNAL_MIME = 'application/x-canvas-nodes';
/** 基础 5 项由注册表派生，保持旧版创建菜单的文字与顺序，回归测试依赖这一组 */
const BASIC_DEFS = listBasicNodeDefinitions();
const EXTRA_GROUPS = groupDefinitionsByCategory(listExtraNodeDefinitions());

function localPointOf(el: HTMLElement | null, e: { clientX: number; clientY: number }) {
  if (!el) return { x: 0, y: 0 };
  const rect = el.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function anchorOf(n: CanvasNode, handle: string) {
  if (handle === 'in') return { x: n.x, y: n.y + n.h / 2 };
  return { x: n.x + n.w, y: n.y + n.h / 2 };
}

export default function Canvas({
  onImportFiles, onPlaceAsset, onOpenImage, onCreateNode, onPasteText, onFillNode, onUnsupportedClipboard,
  onOpenSettings, onNotice, shortcutsActive = true, focusMode = false, onToggleFocus, onExitFocus, onOpenSearch, onOpenShortcuts, onNodeTool,
}: Props) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<Gesture>(null);
  const spaceRef = useRef(false);
  const sizeRef = useRef({ w: 1200, h: 800 });
  const lastMouseWorld = useRef({ x: 0, y: 0 });
  const pasteEventSeen = useRef(false);
  const internalCopyAt = useRef(0);
  const handlersRef = useRef({ onImportFiles, onPasteText, onUnsupportedClipboard });
  const replaceFileRef = useRef<HTMLInputElement>(null);
  const replaceNodeId = useRef('');
  handlersRef.current = { onImportFiles, onPasteText, onUnsupportedClipboard };

  const [size, setSize] = useState({ w: 1200, h: 800 });
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [pendingConnect, setPendingConnect] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [spaceDown, setSpaceDown] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; world: { x: number; y: number }; mode: 'context' | 'create' } | null>(null);
  const [showVariants, setShowVariants] = useState(false);
  const [textGenerator, setTextGenerator] = useState<string | null>(null);
  const [audioGenerator, setAudioGenerator] = useState<string | null>(null);

  /** 底部缩放胶囊：以视口中心为锚点，不用鼠标位置，避免按钮本身导致跳动 */
  const zoomFromPill = (factor: number) => {
    const view = canvasApi.viewportSize();
    useCanvas.getState().zoomBy(factor, { x: view.w / 2, y: view.h / 2 });
  };
  // window 上的键盘监听只注册一次，这里用 ref 读最新的专注状态
  const focusRef = useRef(false);
  focusRef.current = focusMode;
  const shortcutsRef = useRef(shortcutsActive);
  shortcutsRef.current = shortcutsActive;

  const nodes = useCanvas((s) => s.nodes);
  const edges = useCanvas((s) => s.edges);
  const viewport = useCanvas((s) => s.viewport);
  const selection = useCanvas((s) => s.selection);
  const selectedEdgeId = useCanvas((s) => s.selectedEdgeId);
  const settings = useCanvas((s) => s.settings);
  const tool = useCanvas((s) => s.tool);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      const next = { w: rect.width, h: rect.height };
      sizeRef.current = next;
      setSize(next);
      canvasApi.viewportSize = () => ({ w: next.w, h: next.h });
      canvasApi.centerWorld = () => screenToWorld(next.w / 2, next.h / 2, useCanvas.getState().viewport);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const lp = localPointOf(viewportRef.current, e);
      const st = useCanvas.getState();
      lastMouseWorld.current = screenToWorld(lp.x, lp.y, st.viewport);
      const g = gestureRef.current;
      if (!g) return;

      if (g.kind === 'pan') {
        st.setViewport({ ...g.vp, x: g.vp.x + lp.x - g.start.x, y: g.vp.y + lp.y - g.start.y });
      } else if (g.kind === 'marquee') {
        g.moved = g.moved || Math.abs(lp.x - g.start.x) > 3 || Math.abs(lp.y - g.start.y) > 3;
        setMarquee({
          x: Math.min(g.start.x, lp.x), y: Math.min(g.start.y, lp.y),
          w: Math.abs(lp.x - g.start.x), h: Math.abs(lp.y - g.start.y),
        });
      } else if (g.kind === 'drag') {
        const w = screenToWorld(lp.x, lp.y, st.viewport);
        const dx = w.x - g.startWorld.x;
        const dy = w.y - g.startWorld.y;
        const patches: Record<string, NodePatch> = {};
        g.ids.forEach((id) => {
          const origin = g.origins[id];
          if (!origin) return;
          let nx = origin.x + dx;
          let ny = origin.y + dy;
          if (st.settings.snapToGrid) { nx = Math.round(nx / 20) * 20; ny = Math.round(ny / 20) * 20; }
          patches[id] = { x: nx, y: ny };
        });
        st.updateNodesLive(patches);
      } else if (g.kind === 'resize') {
        const w = screenToWorld(lp.x, lp.y, st.viewport);
        const dx = w.x - g.startWorld.x;
        const dy = w.y - g.startWorld.y;
        let nx = g.origin.x, ny = g.origin.y, nw = g.origin.w, nh = g.origin.h;
        if (g.handle.includes('e')) nw = g.origin.w + dx;
        if (g.handle.includes('s')) nh = g.origin.h + dy;
        if (g.handle.includes('w')) { nw = g.origin.w - dx; nx = g.origin.x + dx; }
        if (g.handle.includes('n')) { nh = g.origin.h - dy; ny = g.origin.y + dy; }
        const minW = g.nodeType === 'audio' ? 220 : 140;
        const minH = g.nodeType === 'audio' ? 110 : 116;
        if (nw < minW) { if (g.handle.includes('w')) nx = g.origin.x + g.origin.w - minW; nw = minW; }
        if (nh < minH) { if (g.handle.includes('n')) ny = g.origin.y + g.origin.h - minH; nh = minH; }
        if (e.shiftKey && (g.nodeType === 'image' || g.nodeType === 'video')) {
          const ratio = g.origin.w / g.origin.h;
          if (Math.abs(dx) > Math.abs(dy)) nh = nw / ratio; else nw = nh * ratio;
          if (g.handle.includes('w')) nx = g.origin.x + g.origin.w - nw;
          if (g.handle.includes('n')) ny = g.origin.y + g.origin.h - nh;
        }
        if (st.settings.snapToGrid) {
          nx = Math.round(nx / 20) * 20; ny = Math.round(ny / 20) * 20;
          nw = Math.round(nw / 20) * 20; nh = Math.round(nh / 20) * 20;
        }
        st.updateNodesLive({ [g.id]: { x: nx, y: ny, w: nw, h: nh } });
      } else if (g.kind === 'connect') {
        const w = screenToWorld(lp.x, lp.y, st.viewport);
        setPendingConnect({ x1: g.start.x, y1: g.start.y, x2: w.x, y2: w.y });
      }
    };

    const onUp = (e: PointerEvent) => {
      const g = gestureRef.current;
      gestureRef.current = null;
      if (!g) return;
      const st = useCanvas.getState();
      if (g.kind === 'drag' || g.kind === 'resize') {
        st.endGesture();
      } else if (g.kind === 'marquee') {
        setMarquee(null);
        if (g.moved) {
          const lp = localPointOf(viewportRef.current, e);
          const a = screenToWorld(Math.min(g.start.x, lp.x), Math.min(g.start.y, lp.y), st.viewport);
          const b = screenToWorld(Math.max(g.start.x, lp.x), Math.max(g.start.y, lp.y), st.viewport);
          const rect = { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
          const hits = st.nodes.filter((n) => rectsIntersect(rect, n)).map((n) => n.id);
          st.setSelection([...(g.additive ? st.selection : []), ...hits]);
        }
      } else if (g.kind === 'connect') {
        setPendingConnect(null);
        const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
        const target = el?.closest('[data-node-id]')?.getAttribute('data-node-id');
        if (target && target !== g.from) st.addEdge(g.from, target);
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, []);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // 控制区与按需弹窗内部交给自身滚动，不触发画布缩放/平移
      if ((e.target as HTMLElement | null)?.closest?.('.node-controls-float, .overlay-mask')) return;
      e.preventDefault();
      const st = useCanvas.getState();
      const rect = el.getBoundingClientRect();
      const center = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      if (st.settings.wheelZoom || e.ctrlKey || e.metaKey) {
        st.zoomBy(Math.pow(1.0015, -e.deltaY), center);
      } else {
        st.setViewport({ ...st.viewport, x: st.viewport.x - e.deltaX, y: st.viewport.y - e.deltaY });
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  /* 剪贴板：内部节点复制 / 外部文字 / 外部截图与文件 / 编辑中原生粘贴 */
  useEffect(() => {
    const isTyping = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    };

    const onCopy = (e: ClipboardEvent) => {
      if (!shortcutsRef.current || document.querySelector('dialog[open]') || isTyping(e.target)) return;
      const st = useCanvas.getState();
      if (!st.selection.length) return;
      e.clipboardData?.setData(INTERNAL_MIME, '1');
      e.preventDefault();
    };

    const onPaste = (e: ClipboardEvent) => {
      if (!shortcutsRef.current || document.querySelector('dialog[open]') || isTyping(e.target)) return;
      pasteEventSeen.current = true;
      e.preventDefault();
      const cd = e.clipboardData;
      const at = { ...lastMouseWorld.current };
      const st = useCanvas.getState();
      const types = Array.from(cd?.types ?? []);
      const marked = cd?.getData(INTERNAL_MIME) === '1';
      const files: File[] = [];
      for (const item of Array.from(cd?.items ?? [])) {
        if (item.kind === 'file') { const f = item.getAsFile(); if (f) files.push(f); }
      }
      if (!marked && files.length) { handlersRef.current.onImportFiles(files, at); return; }
      const text = cd?.getData('text/plain') ?? '';
      if (!marked && text.trim()) { handlersRef.current.onPasteText(text, at); return; }
      const recentInternal = Date.now() - internalCopyAt.current < 60_000;
      if (marked || (recentInternal && st.clipboard?.nodes.length)) { st.paste(at); return; }
      handlersRef.current.onUnsupportedClipboard(types);
    };

    document.addEventListener('copy', onCopy);
    document.addEventListener('paste', onPaste);
    return () => { document.removeEventListener('copy', onCopy); document.removeEventListener('paste', onPaste); };
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || !shortcutsRef.current || document.querySelector('dialog[open]')) return;
      const target = e.target as HTMLElement | null;
      const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      // 全局组合键：即使在输入框里也生效
      if (mod && key === 'k') { e.preventDefault(); onOpenSearch?.(); return; }
      if (mod && e.shiftKey && key === 'f') { e.preventDefault(); onToggleFocus?.(); return; }
      if (e.code === 'Space' && !typing && !target?.closest('button, summary, a[href]')) {
        spaceRef.current = true;
        setSpaceDown(true);
        e.preventDefault();
      }
      if (typing) return;
      const st = useCanvas.getState();
      const center = { x: sizeRef.current.w / 2, y: sizeRef.current.h / 2 };
      // 快捷键速查按需弹出，替代常驻说明
      if (e.key === '?') { e.preventDefault(); onOpenShortcuts?.(); return; }
      if (mod && key === 'z') { e.preventDefault(); e.shiftKey ? st.redo() : st.undo(); return; }
      if (mod && key === 'y') { e.preventDefault(); st.redo(); return; }
      if (mod && key === 'c') { st.copySelection(); internalCopyAt.current = Date.now(); return; }
      if (mod && key === 'v') {
        // 不阻止默认，让 paste 事件携带真实剪贴板数据；若环境未派发 paste 事件则兜底内部粘贴
        pasteEventSeen.current = false;
        window.setTimeout(() => {
          if (shortcutsRef.current && !document.querySelector('dialog[open]') && !pasteEventSeen.current && useCanvas.getState().clipboard?.nodes.length) {
            useCanvas.getState().paste(lastMouseWorld.current);
          }
        }, 240);
        return;
      }
      if (mod && key === 'd') { e.preventDefault(); st.duplicateSelection(); return; }
      if (mod && key === 'a') { e.preventDefault(); st.setSelection(st.nodes.map((n) => n.id)); return; }
      if (mod && key === '0') { e.preventDefault(); st.fitToContent(sizeRef.current); return; }
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); st.deleteSelection(); return; }
      if (e.key === 'Escape') {
        if (focusRef.current) { onExitFocus?.(); return; }
        st.clearSelection(); setMenu(null); return;
      }
      if (e.key === '+' || e.key === '=') { st.zoomBy(1.2, center); return; }
      if (e.key === '-' || e.key === '_') { st.zoomBy(1 / 1.2, center); return; }
      if (key === 'v' && !mod) st.setTool('select');
      if (key === 'h' && !mod) st.setTool('hand');
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') { spaceRef.current = false; setSpaceDown(false); }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp); };
  }, []);

  const handleBackgroundPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button === 2) return;
    if ((e.target as HTMLElement).closest('.node-controls-float')) return;
    setMenu(null);
    const st = useCanvas.getState();
    const lp = localPointOf(viewportRef.current, e);
    const panMode = e.button === 1 || spaceRef.current || st.tool === 'hand';
    if (panMode) {
      gestureRef.current = { kind: 'pan', start: lp, vp: { ...st.viewport } };
    } else {
      gestureRef.current = { kind: 'marquee', start: lp, additive: e.shiftKey, moved: false };
      if (!e.shiftKey) st.clearSelection();
      setMarquee({ x: lp.x, y: lp.y, w: 0, h: 0 });
    }
  };

  const openCreateMenu = (clientX: number, clientY: number, mode: 'context' | 'create') => {
    const lp = localPointOf(viewportRef.current, { clientX, clientY });
    // 每次打开都回到基础态，避免上次展开的「更多节点类型」残留影响下一次操作
    setShowVariants(false);
    setMenu({ x: clientX, y: clientY, world: screenToWorld(lp.x, lp.y, useCanvas.getState().viewport), mode });
  };

  const handleNodePointerDown = (e: ReactPointerEvent<HTMLDivElement>, id: string) => {
    if (e.button !== 0) return;
    const st = useCanvas.getState();
    if ((e.target as HTMLElement).closest('[data-no-drag]')) {
      if (!st.selection.includes(id)) st.setSelection([id]);
      return;
    }
    e.stopPropagation();
    setMenu(null);
    if (e.shiftKey) { st.toggleSelection(id); return; }
    let ids = st.selection.includes(id) ? [...st.selection] : [id];
    if (!st.selection.includes(id)) st.setSelection([id]);
    const extra = new Set<string>();
    ids.forEach((nid) => {
      const node = st.nodes.find((n) => n.id === nid);
      if (node?.type === 'group') nodesInGroup(node as GroupNode, st.nodes).forEach((x) => extra.add(x));
    });
    ids = [...new Set([...ids, ...extra])];
    const origins: Record<string, { x: number; y: number }> = {};
    st.nodes.forEach((n) => { if (ids.includes(n.id)) origins[n.id] = { x: n.x, y: n.y }; });
    st.beginGesture();
    const lp = localPointOf(viewportRef.current, e);
    gestureRef.current = {
      kind: 'drag',
      startWorld: screenToWorld(lp.x, lp.y, st.viewport),
      ids,
      origins,
    };
  };

  const handleResizeStart = (e: ReactPointerEvent<HTMLDivElement>, id: string, handle: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const st = useCanvas.getState();
    const node = st.nodes.find((n) => n.id === id);
    if (!node) return;
    st.beginGesture();
    const lp = localPointOf(viewportRef.current, e);
    gestureRef.current = {
      kind: 'resize', id, handle,
      startWorld: screenToWorld(lp.x, lp.y, st.viewport),
      origin: { x: node.x, y: node.y, w: node.w, h: node.h },
      nodeType: node.type,
    };
  };

  const handleConnectStart = (e: ReactPointerEvent<HTMLDivElement>, id: string, handle: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const st = useCanvas.getState();
    const node = st.nodes.find((n) => n.id === id);
    if (!node) return;
    const start = anchorOf(node, handle);
    gestureRef.current = { kind: 'connect', from: id, start };
    setPendingConnect({ x1: start.x, y1: start.y, x2: start.x, y2: start.y });
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const lp = localPointOf(viewportRef.current, e);
    const at = screenToWorld(lp.x, lp.y, useCanvas.getState().viewport);
    const targetEl = e.target as HTMLElement;
    const nodeId = targetEl.closest('[data-node-id]')?.getAttribute('data-node-id');
    const targetNode = nodeId ? useCanvas.getState().nodes.find((n) => n.id === nodeId) : undefined;
    const assetId = e.dataTransfer.getData('application/x-canvas-asset');
    if (assetId) {
      if (targetNode && isEmptyMediaNode(targetNode)) onPlaceAsset(assetId, at, nodeId ?? undefined);
      else onPlaceAsset(assetId, at);
      return;
    }
    const files = Array.from(e.dataTransfer.files);
    if (!files.length) return;
    if (targetNode && isEmptyMediaNode(targetNode)) onFillNode(nodeId!, files);
    else onImportFiles(files, at);
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    const el = e.target as HTMLElement;
    if (el.closest('.node-controls-float')) return;
    e.preventDefault();
    const nodeId = el.closest('[data-node-id]')?.getAttribute('data-node-id');
    const st = useCanvas.getState();
    if (nodeId && !st.selection.includes(nodeId)) st.setSelection([nodeId]);
    openCreateMenu(e.clientX, e.clientY, 'context');
  };

  const handleBackgroundDoubleClick = (e: React.MouseEvent) => {
    const el = e.target as HTMLElement;
    if (el.closest('[data-node-id]') || el.closest('.node-controls-float') || el.closest('.edge-hit') || el.closest('.context-menu')) return;
    openCreateMenu(e.clientX, e.clientY, 'create');
  };

  const runMenu = (action: string) => {
    const st = useCanvas.getState();
    if (action === 'copy') st.copySelection();
    if (action === 'paste') st.paste(lastMouseWorld.current);
    if (action === 'duplicate') st.duplicateSelection();
    if (action === 'delete') st.deleteSelection();
    if (action === 'front') st.bringToFront();
    if (action === 'back') st.sendToBack();
    if (action === 'group') st.groupSelection();
    if (action === 'fit') st.fitToContent(sizeRef.current);
    if (action === 'selectall') st.setSelection(st.nodes.map((n) => n.id));
    setMenu(null);
  };

  const cursor = spaceDown || tool === 'hand' ? (gestureRef.current?.kind === 'pan' ? 'grabbing' : 'grab') : 'default';
  const selectedSet = new Set(selection);
  const gridSize = 24 * viewport.zoom;
  const dotSize = Math.max(1, Math.min(2.4, viewport.zoom * 1.2));

  /* 顶层唯一浮层：图片 / 视频节点一律显示同一套控制区，不再按角色分流 */
  const activePanelNode = useMemo<MediaNode | null>(() => {
    if (selection.length !== 1) return null;
    const n = nodes.find((x) => x.id === selection[0]);
    return n && canOpenPromptPanel(n) ? n as MediaNode : null;
  }, [selection, nodes]);
  const cg = activePanelNode ? controlGeometry(activePanelNode, viewport, size) : null;
  const textNode = textGenerator && selection.length === 1 && selection[0] === textGenerator
    ? nodes.find(node => node.id === textGenerator && node.type === 'text') : undefined;
  const textGeometry = textNode ? controlGeometry(textNode, viewport, size) : null;
  const audioNode = audioGenerator && selection.length === 1 && selection[0] === audioGenerator
    ? nodes.find(node => node.id === audioGenerator && node.type === 'audio') : undefined;
  const audioGeometry = audioNode ? controlGeometry(audioNode, viewport, size) : null;

  /* 关联态：选中节点/连线时，跟它直接相连的上下游与连线被强调，其余连线淡化 */
  const focus = useMemo(() => {
    const sel = new Set(selection);
    if (!sel.size && !selectedEdgeId) {
      return { edges: new Set<string>(), nodes: new Set<string>(), on: false };
    }
    const edgeIds = new Set<string>();
    const nodeIds = new Set<string>(selection);
    edges.forEach((e) => {
      if (sel.has(e.from) || sel.has(e.to) || e.id === selectedEdgeId) {
        edgeIds.add(e.id);
        nodeIds.add(e.from);
        nodeIds.add(e.to);
      }
    });
    return { edges: edgeIds, nodes: nodeIds, on: true };
  }, [selection, edges, selectedEdgeId]);

  return (
    <div
      ref={viewportRef}
      className={`canvas-viewport${dragOver ? ' is-dragover' : ''}${spaceDown || tool === 'hand' ? ' is-hand' : ''}`}
      style={{
        cursor,
        backgroundImage: settings.showGrid ? `radial-gradient(circle, #34343d ${dotSize}px, transparent ${dotSize}px)` : 'none',
        backgroundSize: `${gridSize}px ${gridSize}px`,
        backgroundPosition: `${viewport.x}px ${viewport.y}px`,
      }}
      onPointerDown={handleBackgroundPointerDown}
      onDoubleClick={handleBackgroundDoubleClick}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDragOver(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false); }}
      onDrop={handleDrop}
      onContextMenu={handleContextMenu}
    >
      <div className="canvas-world" style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})` }}>
        <EdgeLayer
          nodes={nodes}
          edges={edges}
          selectedEdgeId={selectedEdgeId}
          pending={pendingConnect}
          relatedEdgeIds={focus.edges}
          hasFocus={focus.on}
          onSelectEdge={(id) => useCanvas.getState().selectEdge(id)}
          onDeleteEdge={(id) => useCanvas.getState().deleteEdge(id)}
        />
        {nodes.map((node) => (
          <NodeView
            key={node.id}
            node={node}
            selected={selectedSet.has(node.id)}
            related={focus.on && focus.nodes.has(node.id) && !selectedSet.has(node.id)}
            onPointerDown={handleNodePointerDown}
            onResizeStart={handleResizeStart}
            onConnectStart={handleConnectStart}
            onOpenImage={onOpenImage}
            onTextGenerate={setTextGenerator}
            onAudioGenerate={setAudioGenerator}
          />
        ))}
        {textNode && textGeometry && <div className="node-controls-wrap expanded is-selected node-controls-float"
          style={{ left: textGeometry.left, top: textGeometry.top, width: textGeometry.width,
            transform: textGeometry.transform, transformOrigin: '0 0', zIndex: 5000 }}
          onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
          <TextGenerator key={textNode.id} nodeId={textNode.id} onClose={() => setTextGenerator(id => id === textNode.id ? null : id)} />
        </div>}
        {audioNode && audioGeometry && <div className="node-controls-wrap expanded is-selected node-controls-float"
          style={{ left: audioGeometry.left, top: audioGeometry.top, width: audioGeometry.width,
            transform: audioGeometry.transform, transformOrigin: '0 0', zIndex: 5000 }}
          onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
          <AudioGenerator key={audioNode.id} nodeId={audioNode.id} onClose={() => setAudioGenerator(id => id === audioNode.id ? null : id)} />
        </div>}

        {/* 唯一的控制区浮层：位于所有节点之后且 z-index 最高，不会被其它节点卡片遮挡 */}
        {activePanelNode && cg && (
          <div
            key={activePanelNode.id}
            className={`node-controls-wrap expanded is-selected node-controls-float place-${cg.placement}`}
            data-node-controls={activePanelNode.id}
            data-node-panel-kind="node"
            data-testid="node-controls-float"
            data-placement={cg.placement}
            style={{
              left: cg.left,
              top: cg.top,
              width: cg.width,
              transform: cg.transform,
              transformOrigin: '0 0',
              zIndex: 5000,
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.stopPropagation()}
          >
            <NodeCreativeControls
              key={activePanelNode.id}
              node={activePanelNode}
              maxHeight={cg.maxPanelHeight}
              onOpenSettings={onOpenSettings}
              onNotice={onNotice}
            />
          </div>
        )}
      </div>

      {marquee && (marquee.w > 1 || marquee.h > 1) && (
        <div className="marquee" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }} />
      )}

      {dragOver && (
        <div className="drop-overlay">
          <div className="drop-inner">
            <Icon name="upload" size={30} />
            <strong>松开即可导入素材</strong>
            <span>拖到空节点上可直接填充该节点</span>
          </div>
        </div>
      )}

      <input ref={replaceFileRef} type="file" hidden onChange={event => {
        const file = event.currentTarget.files?.[0];
        const nodeId = replaceNodeId.current;
        event.currentTarget.value = '';
        if (file && nodeId) onFillNode(nodeId, [file]);
      }} />
      {menu && (
        <div className="context-menu create-menu" style={{ left: menu.x, top: menu.y }} onPointerDown={(e) => e.stopPropagation()}>
          <div className="menu-title">{menu.mode === 'create' ? '在此新建节点' : '在此新建'}</div>
          <div className="node-type-grid">
            {BASIC_DEFS.map((def) => (
              <button
                key={def.variant}
                title={`在光标位置新建${def.label}节点`}
                onClick={() => { onCreateNode(def.type, menu.world); setMenu(null); }}
              >
                <Icon name={def.icon} size={17} />
                <span>{def.label}</span>
              </button>
            ))}
          </div>
          <button className={`variant-toggle${showVariants ? ' open' : ''}`} onClick={() => setShowVariants((v) => !v)}>
            <Icon name="layers" size={14} /> 更多节点类型
            <span className="variant-count">{listExtraNodeDefinitions().length}</span>
            <Icon name="chevronDown" size={13} />
          </button>
          {showVariants && (
            <div className="node-variant-panel" data-testid="node-variant-panel">
              {EXTRA_GROUPS.map((group) => (
                <div className="variant-group" key={group.category}>
                  <div className="variant-group-title">{group.category}</div>
                  <div className="variant-list">
                    {group.items.map((def: NodeDefinition) => (
                      <button
                        key={def.variant}
                        data-variant={def.variant}
                        title={def.description}
                        onClick={() => { onCreateNode(def.type, menu.world, def.variant); setMenu(null); }}
                      >
                        <span className="variant-icon"><Icon name={def.icon} size={14} /></span>
                        <span className="variant-main"><strong>{def.label}</strong><em>{def.description}</em></span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="menu-note">图片、视频可先建空节点，之后再填充素材</div>
          {menu.mode === 'context' && (
            <>
              <div className="menu-sep" />
              {activePanelNode && <button onClick={() => {
                const input = replaceFileRef.current;
                if (!input) return;
                replaceNodeId.current = activePanelNode.id;
                input.accept = `${activePanelNode.type}/*`;
                input.click();
                setMenu(null);
              }}><Icon name="upload" size={15} /> {activePanelNode.assetId ? '替换本机素材' : '导入本机素材到节点'}</button>}
              {activePanelNode && onNodeTool && <>
                <button onClick={() => { onNodeTool('expand', activePanelNode.id); setMenu(null); }}><Icon name="edit" size={15} /> 放大编辑提示词</button>
                <button onClick={() => { onNodeTool('optimize', activePanelNode.id); setMenu(null); }}><Icon name="sparkles" size={15} /> 优化提示词</button>
              </>}
              {selection.length === 1 && onNodeTool && nodes.some(n => n.id === selection[0] && n.type === 'image' && !!n.assetId) && <button onClick={() => { onNodeTool('split', selection[0]); setMenu(null); }}><Icon name="grid" size={15} /> 宫格切分</button>}
              <button onClick={() => runMenu('copy')}><Icon name="copy" size={15} /> 复制 <kbd>Ctrl C</kbd></button>
              <button onClick={() => runMenu('paste')}><Icon name="copy" size={15} /> 粘贴 <kbd>Ctrl V</kbd></button>
              <button onClick={() => runMenu('duplicate')}><Icon name="layers" size={15} /> 原地复制 <kbd>Ctrl D</kbd></button>
              <button onClick={() => runMenu('group')}><Icon name="group" size={15} /> 编组</button>
              <div className="menu-sep" />
              <button onClick={() => runMenu('front')}><Icon name="front" size={15} /> 置于顶层</button>
              <button onClick={() => runMenu('back')}><Icon name="back" size={15} /> 置于底层</button>
              <button onClick={() => runMenu('selectall')}><Icon name="cursor" size={15} /> 全选</button>
              <button onClick={() => runMenu('fit')}><Icon name="fit" size={15} /> 适应画布</button>
              <div className="menu-sep" />
              <button className="danger" onClick={() => runMenu('delete')}><Icon name="trash" size={15} /> 删除 <kbd>Del</kbd></button>
            </>
          )}
        </div>
      )}

      <div className="zoom-pill" onPointerDown={(e) => e.stopPropagation()}>
        <button title="画布缩小" onClick={() => zoomFromPill(1 / 1.2)}><Icon name="zoomOut" size={14} /></button>
        <div className="canvas-zoom-badge" title="当前缩放">{Math.round(viewport.zoom * 100)}%</div>
        <button title="画布放大" onClick={() => zoomFromPill(1.2)}><Icon name="zoomIn" size={14} /></button>
        <span className="zoom-sep" />
        <button title="画布缩放复位" onClick={() => useCanvas.getState().resetZoom()}><Icon name="dot" size={12} /></button>
        <button title="画布适应全部内容" onClick={() => useCanvas.getState().fitToContent(canvasApi.viewportSize())}><Icon name="fit" size={14} /></button>
      </div>
      <div className="canvas-size-badge" aria-hidden="true">{size.w}×{size.h}</div>
    </div>
  );
}
