/// <reference types="vite/client" />
import { useCallback, useEffect, useRef, useState } from 'react';
import { assetIdsOf, useCanvas } from './store';
import { NODE_DEFAULTS, type CanvasNode, type MediaNode, type NodeType, type ProjectSummary } from './types';
import { deleteAsset, getAsset, getAllProjectsWithData, getProject, listAssets, putAsset, saveProject } from './lib/db';
import { exportProject, importProjectFile } from './lib/io';
import { canvasApi } from './lib/canvasApi';
import { installCanvasAgentApi } from './lib/canvasAgentApi';
import { detectAssetKind, guessMime, rectsIntersect, uid } from './lib/utils';
import Canvas from './components/Canvas';
import { AssetPanel, Inspector, Toolbar, TopBar } from './components/Panels';
import { ConfirmDialog, ImageLightbox, PromptDialog, SettingsModal, ToastStack, type ToastItem } from './components/Modals';
import { NodeSearchDialog, ShortcutsDialog } from './components/CanvasOverlays';
import AssistantPanel from './components/AssistantPanel';
import DesktopShell, { type DesktopPage, type Starter } from './components/DesktopShell';
import TaskPanel from './components/TaskPanel';
import QuickModelSetup, { type SetupModelType } from './components/QuickModelSetup';
import { installLocalBridge } from './lib/localBridge';
import { restoreProjectGenerations } from './lib/generation';
import Icon from './components/Icon';
import WorkbenchSettings, { WorkbenchMenu, installWorkbenchRuntime } from './features/workbench/WorkbenchSettings';
import { CanvasStarter, GridSplitDialog, SelectionToolbar } from './features/canvasTools';
import { PromptExpander, PromptOptimizer } from './features/promptTools';
import { ManualSaveMenu } from './features/dataTools';
import { WorkflowLibrary } from './features/studioTools';
import { config, isEnabled } from './lib/workbenchRuntime';
import { toastTone, type NoticeTone } from './features/notice';

// Preserve the old browser automation harness for development checks only.
if (import.meta.env.DEV) installCanvasAgentApi();

type PromptState = { kind: 'new'; starter?: Starter } | { kind: 'rename'; project?: ProjectSummary } | null;
type ConfirmState = { title: string; message: string; confirmText: string; danger: boolean; onConfirm: () => void | Promise<void> } | null;

const centerOfView = () => { const s = canvasApi.viewportSize(); return { x: s.w / 2, y: s.h / 2 }; };

/** 批量节点按网格有序摆放，并避开画布上已有节点 */
function layoutBatch(count: number, anchor: { x: number; y: number }, existing: CanvasNode[], sizes: { w: number; h: number }[]) {
  const occupied = existing.map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h }));
  const cellW = 380;
  const cellH = 300;
  const cols = 3;
  const positions: { x: number; y: number }[] = [];
  for (let i = 0; i < count; i += 1) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const { w, h } = sizes[i];
    let x = anchor.x - w / 2 + col * cellW;
    let y = anchor.y - h / 2 + row * cellH;
    let guard = 0;
    while (occupied.some((r) => rectsIntersect({ x, y, w, h }, r)) && guard < 80) {
      y += cellH;
      guard += 1;
    }
    positions.push({ x, y });
    occupied.push({ x, y, w, h });
  }
  return positions;
}

function nodeSizeFor(kind: 'image' | 'video' | 'audio') {
  const s = NODE_DEFAULTS[kind];
  return { w: kind === 'image' ? Math.min(320, s.w) : s.w, h: s.h };
}

export default function App() {
  const ready = useCanvas((s) => s.ready);
  const nodes = useCanvas((s) => s.nodes);
  const edges = useCanvas((s) => s.edges);
  const viewport = useCanvas((s) => s.viewport);
  const projectName = useCanvas((s) => s.projectName);
  const projectId = useCanvas((s) => s.projectId);
  const projects = useCanvas((s) => s.projects);
  const assets = useCanvas((s) => s.assets);
  useCanvas((s) => s.settings); // 能力开关变化后即时刷新工作台入口

  const [assetUsage, setAssetUsage] = useState<Record<string, string[]>>({});
  const [view, setView] = useState<DesktopPage | 'canvas'>(() => {
    const page = sessionStorage.getItem('kaishi:client-view');
    return page === 'canvas' || page === 'projects' || page === 'assets' || page === 'settings' ? page : 'home';
  });
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState<false | 'defaults' | 'services' | 'external'>(false);
  const [prompt, setPrompt] = useState<PromptState>(null);
  const [confirm, setConfirm] = useState<ConfirmState>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [assistantSetup, setAssistantSetup] = useState<SetupModelType | null>(null);
  const [workbenchOpen, setWorkbenchOpen] = useState(false);
  const [wbSection, setWbSection] = useState('appearance');
  const [workflowOpen, setWorkflowOpen] = useState(false);
  const [saveMenuOpen, setSaveMenuOpen] = useState(false);
  const [gridSplitNode, setGridSplitNode] = useState<string | null>(null);
  const [expandPromptNode, setExpandPromptNode] = useState<string | null>(null);
  const [optimizePromptNode, setOptimizePromptNode] = useState<string | null>(null);
  const [focusMode, setFocusMode] = useState(false);
  const panelsBeforeFocus = useRef({ left: true, right: true });
  const projectFileRef = useRef<HTMLInputElement>(null);
  const mediaFileRef = useRef<HTMLInputElement>(null);
  const settingsDirty = useRef(false);
  const recordSettingsDirty = useCallback((dirty: boolean) => { settingsDirty.current = dirty; }, []);
  useEffect(() => { sessionStorage.setItem('kaishi:client-view', view); }, [view]);

  // 启动时应用本机外观与品牌，挂自动快照与结构变化事件记录
  useEffect(() => installWorkbenchRuntime(), []);
  useEffect(() => installLocalBridge(), []);
  useEffect(() => { if (ready && projectId) restoreProjectGenerations(projectId); }, [ready, projectId]);

  // 工作台系列弹窗也优先消费 Esc
  useEffect(() => {
    if (!workbenchOpen && !workflowOpen && !gridSplitNode && !expandPromptNode && !optimizePromptNode) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing || document.querySelector('dialog[open]')) return;
      e.preventDefault(); e.stopPropagation();
      setWorkbenchOpen(false); setWorkflowOpen(false);
      setGridSplitNode(null); setExpandPromptNode(null); setOptimizePromptNode(null);
    };
    window.addEventListener('keydown', onEsc, true);
    return () => window.removeEventListener('keydown', onEsc, true);
  }, [workbenchOpen, workflowOpen, gridSplitNode, expandPromptNode, optimizePromptNode]);

  const enterFocus = useCallback(() => {
    if (focusMode) return;
    panelsBeforeFocus.current = { left: leftOpen, right: rightOpen };
    setLeftOpen(false);
    setRightOpen(false);
    setFocusMode(true);
  }, [focusMode, leftOpen, rightOpen]);
  const exitFocus = useCallback(() => {
    setFocusMode(false);
    setLeftOpen(panelsBeforeFocus.current.left);
    setRightOpen(panelsBeforeFocus.current.right);
  }, []);
  const toggleFocus = useCallback(() => {
    if (focusMode) exitFocus(); else enterFocus();
  }, [focusMode, enterFocus, exitFocus]);

  const focusNodeById = useCallback((id: string) => {
    const st = useCanvas.getState();
    const node = st.nodes.find((x) => x.id === id);
    if (!node) return;
    st.setSelection([id]);
    const view = canvasApi.viewportSize();
    const vp = st.viewport;
    st.setViewport({
      ...vp,
      x: view.w / 2 - (node.x + node.w / 2) * vp.zoom,
      y: view.h / 2 - (node.y + node.h / 2) * vp.zoom,
    });
  }, []);

  const notify = useCallback((text: string, tone: NoticeTone = 'ok') => {
    const id = Date.now() + Math.random();
    const kind: ToastItem['kind'] = toastTone(tone);
    setToasts((list) => [...list, { id, text, kind }]);
    window.setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 4000);
  }, []);

  const refreshUsage = useCallback(async () => {
    try {
      const all = await getAllProjectsWithData();
      const usage: Record<string, string[]> = {};
      all.forEach((p) => {
        assetIdsOf(p.data?.nodes ?? []).forEach((id) => {
          if (!usage[id]) usage[id] = [];
          if (!usage[id].includes(p.name)) usage[id].push(p.name);
        });
      });
      setAssetUsage(usage);
    } catch { /* 数据库不可用时忽略 */ }
  }, []);

  const refreshAssets = useCallback(async () => {
    // 素材库同时写入全局 store，节点下方的内联控制区可直接读取，不必依赖侧边栏
    try { useCanvas.getState().setAssets(await listAssets()); } catch { /* 保持现有列表 */ }
    await refreshUsage();
  }, [refreshUsage]);

  useEffect(() => {
    useCanvas.getState().init()
      .then(refreshAssets)
      .catch((err: unknown) => notify(`初始化失败：${err instanceof Error ? err.message : String(err)}`, 'err'));
  }, [notify, refreshAssets]);

  useEffect(() => { if (ready) refreshUsage(); }, [ready, projectId, projects, refreshUsage]);

  // 状态一变立刻标记「正在保存」，同步镜像已由 store 写入；200ms 后落盘 IndexedDB
  useEffect(() => {
    if (!ready) return;
    useCanvas.getState().setSaveStatus('saving');
    const timer = window.setTimeout(() => { useCanvas.getState().persist(); }, 200);
    return () => window.clearTimeout(timer);
  }, [ready, nodes, edges, viewport, projectName]);

  useEffect(() => {
    // 页面转入后台时补一次落盘。
    const onLeave = () => { if (document.visibilityState === 'hidden') useCanvas.getState().persist(); };
    document.addEventListener('visibilitychange', onLeave);
    window.addEventListener('beforeunload', onLeave);
    return () => {
      document.removeEventListener('visibilitychange', onLeave);
      window.removeEventListener('beforeunload', onLeave);
    };
  }, []);

  const importFiles = useCallback(async (files: File[], at?: { x: number; y: number }, libraryOnly = false) => {
    const anchor = at ?? canvasApi.centerWorld();
    const targetProject = useCanvas.getState().projectId;
    const prepared: { assetId: string; file: File; kind: 'image' | 'video' | 'audio' }[] = [];
    let skipped = 0;
    for (const file of files) {
      const kind = detectAssetKind(file);
      if (!kind) { skipped += 1; continue; }
      const assetId = uid('asset');
      try {
        await putAsset({
          meta: { id: assetId, name: file.name, mime: guessMime(file, kind), size: file.size, kind, createdAt: Date.now() },
          blob: file,
        });
        prepared.push({ assetId, file, kind });
      } catch (err) {
        console.error('素材写入失败', err);
        notify(`「${file.name}」写入失败，可能是浏览器存储空间不足`, 'err');
      }
    }
    await refreshAssets();
    const placeOnCanvas = !libraryOnly && useCanvas.getState().projectId === targetProject;
    if (prepared.length && placeOnCanvas) {
      const st = useCanvas.getState();
      const sizes = prepared.map((p) => nodeSizeFor(p.kind));
      const positions = layoutBatch(prepared.length, anchor, st.nodes, sizes);
      const created: MediaNode[] = prepared.map((p, i) => ({
        id: uid('n'), type: p.kind, assetId: p.assetId, fileName: p.file.name, name: p.file.name,
        fit: 'contain', resultOrigin: 'upload' as const,
        x: positions[i].x, y: positions[i].y, w: sizes[i].w, h: sizes[i].h, z: 0,
      }));
      st.addNodes(created);
      notify(`已导入 ${created.length} 个素材并有序摆放`, 'ok');
    }
    if (prepared.length && !placeOnCanvas) notify(`已导入 ${prepared.length} 个素材到资产库`, 'ok');
    if (skipped) notify(`跳过 ${skipped} 个不支持的文件（仅支持图片/视频/音频）`, 'info');
  }, [notify, refreshAssets]);

  const placeAsset = useCallback(async (assetId: string, at?: { x: number; y: number }, targetNodeId?: string) => {
    const targetProject = useCanvas.getState().projectId;
    try {
      const record = await getAsset(assetId);
      if (!record) { notify('素材已不存在，请重新导入', 'err'); return; }
      const st = useCanvas.getState();
      if (st.projectId !== targetProject) { notify('项目已切换，请在目标画布添加素材', 'info'); return; }
      if (targetNodeId) {
        const target = st.nodes.find((n) => n.id === targetNodeId);
        if (target && (target.type === 'image' || target.type === 'video' || target.type === 'audio') && !target.assetId && record.meta.kind === target.type) {
          st.fillNodeAsset(targetNodeId, assetId, record.meta.name);
          notify(`已用「${record.meta.name}」填充节点`, 'ok');
          return;
        }
      }
      const size = nodeSizeFor(record.meta.kind);
      const center = at ?? canvasApi.centerWorld();
      st.addNode({
        id: uid('n'), type: record.meta.kind, assetId, fileName: record.meta.name, name: record.meta.name, fit: 'contain',
        resultOrigin: 'library' as const,
        x: center.x - size.w / 2, y: center.y - size.h / 2, w: size.w, h: size.h, z: 0,
      } as MediaNode);
      notify(`已添加「${record.meta.name}」到画布`, 'ok');
    } catch (err) {
      notify(`添加失败：${err instanceof Error ? err.message : String(err)}`, 'err');
    }
  }, [notify]);

  const batchAdd = useCallback(async (assetIds: string[]) => {
    const targetProject = useCanvas.getState().projectId;
    try {
      const records = (await Promise.all(assetIds.map((id) => getAsset(id)))).filter((r): r is NonNullable<typeof r> => !!r);
      if (!records.length) return;
      const st = useCanvas.getState();
      if (st.projectId !== targetProject) { notify('项目已切换，请在目标画布添加素材', 'info'); return; }
      const sizes = records.map((r) => nodeSizeFor(r.meta.kind));
      const positions = layoutBatch(records.length, canvasApi.centerWorld(), st.nodes, sizes);
      const created: MediaNode[] = records.map((r, i) => ({
        id: uid('n'), type: r.meta.kind, assetId: r.meta.id, fileName: r.meta.name, name: r.meta.name, fit: 'contain',
        resultOrigin: 'library' as const,
        x: positions[i].x, y: positions[i].y, w: sizes[i].w, h: sizes[i].h, z: 0,
      }));
      st.addNodes(created);
      notify(`已把 ${created.length} 个素材有序加入画布`, 'ok');
    } catch (err) {
      notify(`批量加入失败：${err instanceof Error ? err.message : String(err)}`, 'err');
    }
  }, [notify]);

  const createNode = useCallback((type: NodeType, at: { x: number; y: number }, variant?: string) => {
    useCanvas.getState().createNode(type, at, variant ? { variant } : undefined);
  }, []);

  const pasteText = useCallback((text: string, at: { x: number; y: number }) => {
    useCanvas.getState().createTextNode(text, at);
    notify('已把剪贴板文字建成文本节点', 'ok');
  }, [notify]);

  const fillNode = useCallback(async (nodeId: string, files: File[]) => {
    const file = files[0];
    const kind = file ? detectAssetKind(file) : null;
    const st = useCanvas.getState();
    const node = st.nodes.find((n) => n.id === nodeId);
    if (!file || !kind || !node || (node.type !== 'image' && node.type !== 'video' && node.type !== 'audio')) {
      notify('拖入的文件不是支持的图片、视频或音频', 'err');
      return;
    }
    if (kind !== node.type) {
      notify(`类型不匹配：${node.type === 'image' ? '图片' : node.type === 'video' ? '视频' : '音频'}节点需要${node.type === 'image' ? '图片' : node.type === 'video' ? '视频' : '音频'}文件`, 'err');
      return;
    }
    const assetId = uid('asset');
    await putAsset({ meta: { id: assetId, name: file.name, mime: guessMime(file, kind), size: file.size, kind, createdAt: Date.now() }, blob: file });
    st.fillNodeAsset(nodeId, assetId, file.name);
    await refreshAssets();
    notify(`已填充「${file.name}」`, 'ok');
  }, [notify, refreshAssets]);

  const unsupportedClipboard = useCallback((types: string[]) => {
    notify(`暂不支持该剪贴板形式（${types.length ? types.join('、') : '空剪贴板'}）`, 'info');
  }, [notify]);

  const addText = useCallback(() => { useCanvas.getState().createNode('text'); }, []);
  const addGroup = useCallback(() => { useCanvas.getState().createNode('group'); }, []);

  /** 空白画布中央加号：复用画布自己的右键创建菜单，不另造一份节点类型清单 */
  const openCreateMenuAtCenter = useCallback(() => {
    const el = document.querySelector('.canvas-viewport');
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, button: 2,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
    }));
  }, []);

  const promptOf = (id: string | null) => {
    const n = id ? nodes.find((x) => x.id === id) : undefined;
    return n?.type === 'image' ? (n.imageParams?.prompt ?? '')
      : n?.type === 'video' ? (n.videoParams?.prompt ?? '') : '';
  };
  const setPromptOf = (id: string, value: string) => useCanvas.getState().updateNodeParams(id, { prompt: value });
  const wb = config();

  const handleExport = useCallback(async () => {
    try {
      const st = useCanvas.getState();
      await st.persist();
      const project = await getProject(st.projectId);
      if (!project) { notify('项目数据尚未就绪', 'err'); return; }
      notify('正在打包项目与素材…', 'info');
      const result = await exportProject(project);
      notify(`已导出 ${result.fileName}，包含 ${result.assetCount} 个素材`, 'ok');
    } catch (err) {
      notify(`导出失败：${err instanceof Error ? err.message : String(err)}`, 'err');
    }
  }, [notify]);

  const handleImportFile = useCallback(async (file: File) => {
    try {
      const result = await importProjectFile(file);
      await useCanvas.getState().loadImported(result.project);
      setView('canvas');
      await refreshAssets();
      const tail = result.missing.length ? `，有 ${result.missing.length} 个素材缺失` : '';
      const hasNotes = result.missing.length > 0 || result.notes.length > 0;
      notify(`导入完成：${result.project.data.nodes.length} 个节点、${result.assetCount} 个素材${tail}`, hasNotes ? 'info' : 'ok');
      result.notes.forEach((note) => notify(note, 'info'));
    } catch (err) {
      notify(`导入失败：${err instanceof Error ? err.message : String(err)}`, 'err');
    }
  }, [notify, refreshAssets]);

  const handleDeleteAsset = useCallback((id: string) => {
    const meta = assets.find((a) => a.id === id);
    const usedBy = assetUsage[id] ?? [];
    setConfirm({
      title: '从素材库移除',
      message: usedBy.length
        ? `「${meta?.name ?? '该素材'}」被 ${usedBy.length} 个项目引用（${usedBy.join('、')}），这些项目共用同一个文件。移除后相关节点会显示为空，导出时也会缺少素材。确定继续吗？`
        : `确定移除「${meta?.name ?? '该素材'}」吗？此操作不可撤销。`,
      confirmText: '移除',
      danger: true,
      onConfirm: async () => {
        await deleteAsset(id);
        await refreshAssets();
        notify('素材已移除', 'ok');
        setConfirm(null);
      },
    });
  }, [assets, assetUsage, notify, refreshAssets]);

  const openProject = async (id: string) => {
    try {
      await useCanvas.getState().switchProject(id);
      setView('canvas');
    } catch (err) {
      notify('打开项目失败：' + (err as Error).message, 'err');
    }
  };

  const deleteProject = (project: ProjectSummary) => setConfirm({
    title: '删除项目',
    message: `确定删除「${project.name}」？`,
    confirmText: '删除',
    danger: true,
    onConfirm: async () => {
      try {
        await useCanvas.getState().removeProject(project.id);
        notify('项目已删除', 'ok');
      } catch (err) {
        notify('删除失败：' + (err as Error).message, 'err');
      } finally { setConfirm(null); }
    },
  });

  const openAssistant = () => {
    setView('canvas');
    setRightOpen(false);
    setTasksOpen(false);
    setAgentOpen(true);
  };

  const leaveSettings = (action: () => void) => {
    if (view !== 'settings' || !settingsDirty.current) { action(); return; }
    setConfirm({
      title: '放弃未保存的设置？',
      message: '离开后，本次对模型与画布设置的修改会丢失。',
      confirmText: '放弃修改',
      danger: false,
      onConfirm: () => { settingsDirty.current = false; setConfirm(null); action(); },
    });
  };

  if (!ready) return <div className="boot-screen"><div className="boot-spinner" /><span>正在打开开视…</span></div>;

  return (
    <div className="app-shell">
      {view !== 'canvas' && <DesktopShell page={view} projects={projects}
        onPage={page => { if (page !== view) leaveSettings(() => setView(page)); }}
        onNew={starter => leaveSettings(() => {
          if (view === 'settings') setView('home');
          setPrompt({ kind: 'new', starter });
        })} onOpen={id => void openProject(id)}
        onImport={() => projectFileRef.current?.click()} onRename={project => setPrompt({ kind: 'rename', project })}
        onDelete={deleteProject} onAssistant={openAssistant}>
        {view === 'assets' && <AssetPanel page assets={assets} assetUsage={assetUsage}
          onFiles={files => void importFiles(files, undefined, true)}
          onPlace={id => { setView('canvas'); void placeAsset(id); }}
          onBatchAdd={ids => { setView('canvas'); void batchAdd(ids); }}
          onDelete={handleDeleteAsset} onRefresh={refreshAssets} />}
        {view === 'settings' && <SettingsModal page onClose={() => setView('home')} onDirtyChange={recordSettingsDirty}
          onNotice={msg => notify(msg, 'ok')} onOpenAgent={openAssistant} />}
      </DesktopShell>}
      {view === 'canvas' && <>
      <TopBar
        onHome={() => { if (focusMode) exitFocus(); setView('home'); }}
        onNewProject={() => setPrompt({ kind: 'new' })}
        onRename={() => setPrompt({ kind: 'rename' })}
        onExport={handleExport}
        onImport={() => projectFileRef.current?.click()}
        onOpenSettings={() => setSettingsOpen('defaults')}
        agentOpen={agentOpen && !focusMode && !tasksOpen}
        tasksOpen={tasksOpen && !focusMode}
        onOpenAgent={() => { setRightOpen(false); setTasksOpen(false); setAgentOpen(v => tasksOpen || !v); }}
        onOpenTasks={() => setTasksOpen(v => !v)}
        workbenchMenu={
          <WorkbenchMenu
            onOpen={(section) => { setWbSection(section ?? 'appearance'); setWorkbenchOpen(true); }}
            onWorkflow={() => setWorkflowOpen(true)}
            onSave={() => setSaveMenuOpen(true)}
          />
        }
        onToggleLeft={() => setLeftOpen((v) => !v)}
        onToggleRight={() => { setRightOpen(v => !v); setAgentOpen(false); setTasksOpen(false); }}
        leftOpen={leftOpen}
        rightOpen={rightOpen}
      />
      <div className="workspace">
        {leftOpen && (
          <AssetPanel
            assets={assets}
            assetUsage={assetUsage}
            onFiles={(files) => importFiles(files)}
            onPlace={(id) => placeAsset(id)}
            onBatchAdd={batchAdd}
            onDelete={handleDeleteAsset}
            onRefresh={refreshAssets}
            onClose={() => setLeftOpen(false)}
          />
        )}
        <main className="canvas-area">
          <Canvas
            shortcutsActive={!settingsOpen && !workbenchOpen && !prompt && !confirm && !lightbox && !assistantSetup && !workflowOpen
              && !gridSplitNode && !expandPromptNode && !optimizePromptNode && !searchOpen && !shortcutsOpen}
            onImportFiles={importFiles}
            onPlaceAsset={placeAsset}
            onOpenImage={setLightbox}
            onCreateNode={createNode}
            onPasteText={pasteText}
            onFillNode={fillNode}
            onUnsupportedClipboard={unsupportedClipboard}
            onOpenSettings={() => setSettingsOpen('defaults')}
            onNotice={notify}
            focusMode={focusMode}
            onToggleFocus={toggleFocus}
            onExitFocus={exitFocus}
            onOpenSearch={() => setSearchOpen(true)}
            onOpenShortcuts={() => setShortcutsOpen(true)}
            onNodeTool={(tool, id) => { if (tool === 'expand') setExpandPromptNode(id); else if (tool === 'optimize') setOptimizePromptNode(id); else setGridSplitNode(id); }}
          />
          <Toolbar
            onAddText={addText}
            onAddGroup={addGroup}
            onAddFiles={() => mediaFileRef.current?.click()}
            onSearch={() => setSearchOpen(true)}
            onShortcuts={() => setShortcutsOpen(true)}
            onToggleFocus={toggleFocus}
            focusMode={focusMode}
          />

          {isEnabled('selectionToolbar', wb) && <SelectionToolbar onNotice={notify} />}
          <CanvasStarter
            onCreate={openCreateMenuAtCenter}
            onImport={() => mediaFileRef.current?.click()}
          />
          {focusMode && (
            <div className="focus-bar" data-testid="focus-bar" onPointerDown={(e) => e.stopPropagation()}>
              <button title="退出专注模式 (Esc)" onClick={exitFocus}><Icon name="close" size={14} /></button>
              <span className="focus-sep" />
              <button title="缩小" onClick={() => useCanvas.getState().zoomBy(1 / 1.2, centerOfView())}><Icon name="zoomOut" size={14} /></button>
              <button className="focus-zoom" title="恢复 100%" onClick={() => useCanvas.getState().resetZoom()}>{Math.round(viewport.zoom * 100)}%</button>
              <button title="放大" onClick={() => useCanvas.getState().zoomBy(1.2, centerOfView())}><Icon name="zoomIn" size={14} /></button>
              <button title="适应全部内容" onClick={() => useCanvas.getState().fitToContent(canvasApi.viewportSize())}><Icon name="fit" size={14} /></button>
              <span className="focus-sep" />
              <button title="搜索节点 (Ctrl K)" onClick={() => setSearchOpen(true)}><Icon name="zoomIn" size={14} /></button>
              <button title="快捷键速查 (?)" onClick={() => setShortcutsOpen(true)}>?</button>
              <span className="focus-label">专注模式</span>
            </div>
          )}
        </main>
        {agentOpen && <AssistantPanel hidden={focusMode || tasksOpen} onClose={() => setAgentOpen(false)}
          onNotice={notify} />}
        {tasksOpen && !focusMode && <TaskPanel
          onClose={() => setTasksOpen(false)}
          onLocate={focusNodeById}
          onPlace={id => void placeAsset(id)}
        />}
        {rightOpen && !tasksOpen && (
          <Inspector
            onClose={() => setRightOpen(false)}
            onOpenImage={setLightbox}
          />
        )}
      </div>
      </>}

      <input ref={projectFileRef} type="file" hidden accept=".canvasproj,.zip,application/zip"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImportFile(f); e.target.value = ''; }} />
      <input ref={mediaFileRef} type="file" hidden multiple accept="image/*,video/*,audio/*,.mov,.m4v,.mkv,.flac,.m4a"
        onChange={(e) => { const files = Array.from(e.target.files ?? []); if (files.length) importFiles(files); e.target.value = ''; }} />

      {assistantSetup && <QuickModelSetup type={assistantSetup} onClose={() => setAssistantSetup(null)}
        onApply={() => { setAssistantSetup(null); notify('文本模型已保存', 'ok'); }} />}
      {settingsOpen && (
        <SettingsModal
          initialTab={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          onNotice={(msg) => notify(msg, 'ok')}
          onOpenAgent={openAssistant}
        />
      )}
      {workbenchOpen && (
        <WorkbenchSettings initialSection={wbSection} onClose={() => setWorkbenchOpen(false)} onNotice={notify} />
      )}
      {workflowOpen && (
        <div className="modal-mask" onPointerDown={(e) => { if (e.target === e.currentTarget) setWorkflowOpen(false); }}>
          <div className="dialog wb-standalone" data-testid="wb-workflow-dialog">
            <div className="dialog-head">
              <h3><Icon name="grid" size={16} /> 工作流模板库</h3>
              <button className="icon-btn small" data-testid="wb-workflow-close" onClick={() => setWorkflowOpen(false)}><Icon name="close" size={16} /></button>
            </div>
            <div className="dialog-body"><WorkflowLibrary onNotice={notify} /></div>
          </div>
        </div>
      )}
      {saveMenuOpen && (
        <div className="wb-save-anchor" data-testid="wb-save-anchor">
          <ManualSaveMenu onClose={() => setSaveMenuOpen(false)} onNotice={notify} />
        </div>
      )}
      {gridSplitNode && (
        <GridSplitDialog nodeId={gridSplitNode} onClose={() => setGridSplitNode(null)} onNotice={notify} />
      )}
      {expandPromptNode && (
        <PromptExpander nodeId={expandPromptNode} value={promptOf(expandPromptNode)}
          onChange={(v) => setPromptOf(expandPromptNode, v)} onClose={() => setExpandPromptNode(null)} />
      )}
      {optimizePromptNode && (
        <PromptOptimizer nodeId={optimizePromptNode} value={promptOf(optimizePromptNode)}
          onChange={(v) => setPromptOf(optimizePromptNode, v)} onClose={() => setOptimizePromptNode(null)} onNotice={notify} />
      )}
      {lightbox && <ImageLightbox assetId={lightbox} onClose={() => setLightbox(null)} />}
      {searchOpen && <NodeSearchDialog nodes={nodes} onFocus={focusNodeById} onClose={() => setSearchOpen(false)} />}
      {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
      {prompt && (
        <PromptDialog
          title={prompt.kind === 'new' ? '新建项目' : '重命名项目'}
          label="项目名称"
          defaultValue={prompt.kind === 'rename' ? (prompt.project?.name ?? projectName) : ''}
          placeholder={prompt.kind === 'new' ? '例如：短片分镜 v2' : undefined}
          confirmText={prompt.kind === 'new' ? '创建' : '保存'}
          onCancel={() => setPrompt(null)}
          onConfirm={async (value) => {
            if (prompt.kind === 'new') {
              const starter = prompt.starter;
              await useCanvas.getState().newProject(value);
              if (starter) {
                const st = useCanvas.getState();
                const { x, y, zoom } = st.viewport;
                st.createNode(starter, { x: (window.innerWidth / 2 - x) / zoom, y: ((window.innerHeight - 56) / 2 - y) / zoom });
              }
              setView('canvas');
              void refreshAssets();
              notify('新项目已创建', 'ok');
            } else {
              const st = useCanvas.getState();
              if (!prompt.project || prompt.project.id === st.projectId) {
                st.renameProject(value);
                await st.persist();
                if (useCanvas.getState().saveStatus === 'error') throw new Error('项目名称未能保存，请重试');
              } else {
                const project = await getProject(prompt.project.id);
                if (!project) throw new Error('项目已不存在');
                await saveProject({ ...project, name: value, updatedAt: Date.now() });
                await st.refreshProjects();
              }
              notify('项目名称已更新', 'ok');
            }
            setPrompt(null);
          }}
        />
      )}
      {confirm && <ConfirmDialog {...confirm} onCancel={() => setConfirm(null)} />}
      <ToastStack items={toasts} />
    </div>
  );
}
