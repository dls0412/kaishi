import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useCanvas } from '../store';
import type { AssetMeta, CanvasNode } from '../types';
import { formatBytes, formatTime } from '../lib/utils';
import { definitionOf, getNodeInputSlots, listNodeDefinitions } from '../lib/nodeRegistry';
import { useAssetUrl } from './useAssetUrl';
import { isEnabled } from '../lib/workbenchRuntime';
import { StorageMeter } from '../features/dataTools';
import Icon from './Icon';
import { useGeneration } from '../lib/generation';
import WorkflowDialog from './WorkflowDialog';

/* ------------------------------ 顶部栏 ------------------------------ */
interface TopBarProps {
  onHome: () => void;
  onNewProject: () => void;
  onRename: () => void;
  onExport: () => void;
  onImport: () => void;
  onOpenSettings: () => void;
  onOpenAgent: () => void;
  onOpenTasks: () => void;
  tasksOpen: boolean;
  agentOpen: boolean;
  /** 工作台下拉菜单由 App 注入，避免在面板组件里重复管理弹窗状态 */
  workbenchMenu?: ReactNode;
  onToggleLeft: () => void;
  onToggleRight: () => void;
  leftOpen: boolean;
  rightOpen: boolean;
}

export function TopBar({ onHome, onNewProject, onRename, onExport, onImport, onOpenSettings, onOpenAgent, onOpenTasks, tasksOpen, agentOpen, workbenchMenu, onToggleLeft, onToggleRight, leftOpen, rightOpen }: TopBarProps) {
  const [open, setOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const projectName = useCanvas((s) => s.projectName);
  const projectId = useCanvas((s) => s.projectId);
  const runningTasks = useGeneration(s => s.tasks.filter(t => t.projectId === projectId && t.status === 'running').length);
  const projects = useCanvas((s) => s.projects);
  const saveStatus = useCanvas((s) => s.saveStatus);
  const lastSavedAt = useCanvas((s) => s.lastSavedAt);

  useEffect(() => {
    const handler = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) { setOpen(false); setPendingDelete(null); }
    };
    window.addEventListener('pointerdown', handler);
    return () => window.removeEventListener('pointerdown', handler);
  }, []);

  const statusText = saveStatus === 'saving' ? '正在保存…'
    : saveStatus === 'error' ? '保存失败，请检查浏览器存储权限'
      : lastSavedAt ? `已保存 ${formatTime(lastSavedAt).slice(11)}` : '已保存';

  return (
    <header className="topbar">
      <button className="canvas-home" onClick={onHome} title="返回首页"><Icon name="arrowLeft" size={15} /><span>首页</span></button>
      <span className="top-divider" />
      <button className={`icon-btn${leftOpen ? ' active' : ''}`} aria-label="素材库" aria-pressed={leftOpen} title="素材库" onClick={onToggleLeft}><Icon name="panelLeft" size={17} /></button>
      <div className="project-menu-wrap" ref={menuRef}>
        <button className="project-trigger" onClick={() => { setOpen(!open); setPendingDelete(null); }}>
          <Icon name="folder" size={15} /><span className="project-title">{projectName}</span><Icon name="chevronDown" size={13} />
        </button>
        {open && (
          <div className="project-dropdown">
            <div className="dropdown-head">项目列表 <span>{projects.length} 个</span></div>
            <div className="project-list">
              {projects.map((p) => (
                <div key={p.id} className={`project-item${p.id === projectId ? ' current' : ''}`}>
                  <button className="project-item-main" onClick={() => { useCanvas.getState().switchProject(p.id); setOpen(false); }}>
                    <Icon name={p.id === projectId ? 'check' : 'file'} size={15} />
                    <span className="pi-name">{p.name}</span>
                    <span className="pi-meta">{p.nodeCount} 节点 · {formatTime(p.updatedAt).slice(5)}</span>
                  </button>
                  <button
                    className={`project-del${pendingDelete === p.id ? ' confirm' : ''}`}
                    title={pendingDelete === p.id ? '再次点击确认删除' : '删除项目'}
                    onClick={() => {
                      if (pendingDelete === p.id) { useCanvas.getState().removeProject(p.id); setPendingDelete(null); }
                      else setPendingDelete(p.id);
                    }}
                  ><Icon name={pendingDelete === p.id ? 'check' : 'trash'} size={14} /></button>
                </div>
              ))}
            </div>
            <button className="dropdown-new" onClick={() => { setOpen(false); onNewProject(); }}><Icon name="plus" size={15} /> 新建项目</button>
          </div>
        )}
      </div>
      <button className="icon-btn" title="重命名项目" onClick={onRename}><Icon name="edit" size={15} /></button>
      <div className={`save-status ${saveStatus}`}><span className="save-dot" />{statusText}</div>
      <div className="top-spacer" />
      <button className="tb-action" onClick={onImport}><Icon name="upload" size={15} /> 导入项目</button>
      <button className="tb-action" onClick={onExport}><Icon name="download" size={15} /> 导出项目</button>
      <span className="top-divider" />
      {workbenchMenu}
      <span className="top-divider" />
      <button className="tb-action agent-entry" aria-pressed={agentOpen} data-testid="open-agent" onClick={onOpenAgent} title="打开或收起开视助手"><Icon name="sparkles" size={15} /> AI 助手</button>
      <button className="tb-action task-entry" aria-pressed={tasksOpen} onClick={onOpenTasks}>
        <Icon name="list" size={15} /> 生成任务 {runningTasks > 0 && <span className="task-count">{runningTasks}</span>}
      </button>
      <button className="icon-btn" title="设置与模型配置" onClick={onOpenSettings}><Icon name="settings" size={17} /></button>
      <button className={`icon-btn${rightOpen ? ' active' : ''}`} title="显示/隐藏属性面板" onClick={onToggleRight}><Icon name="panelRight" size={17} /></button>
    </header>
  );
}

/* ------------------------------ 素材面板 ------------------------------ */
interface AssetPanelProps {
  assets: AssetMeta[];
  assetUsage: Record<string, string[]>;
  onFiles: (files: File[]) => void;
  onPlace: (assetId: string) => void;
  onBatchAdd: (assetIds: string[]) => void;
  onDelete: (id: string) => void;
  onRefresh: () => void;
  onClose?: () => void;
  page?: boolean;
}

function AssetThumb({ meta }: { meta: AssetMeta }) {
  const url = useAssetUrl(meta.id);
  if (meta.kind === 'image' && url) return <img className="asset-thumb-img" src={url} alt={meta.name} draggable={false} />;
  if (meta.kind === 'video' && url) return <video className="asset-thumb-img" src={`${url}#t=0.2`} muted preload="metadata" />;
  return <div className={`asset-thumb-icon kind-${meta.kind}`}><Icon name={meta.kind} size={26} /></div>;
}

export function AssetPreview({ meta, onClose }: { meta: AssetMeta; onClose: () => void }) {
  const url = useAssetUrl(meta.id);
  return <WorkflowDialog title={meta.name} onClose={onClose}>
    <div className="asset-preview-body">
      {!url ? <p>正在读取本机素材…</p>
        : meta.kind === 'image' ? <img src={url} alt={meta.name} />
          : meta.kind === 'video' ? <video src={url} controls preload="metadata" />
            : <audio src={url} controls preload="metadata" />}
    </div>
  </WorkflowDialog>;
}

export function AssetPanel({ assets, assetUsage, onFiles, onPlace, onBatchAdd, onDelete, onRefresh, onClose, page }: AssetPanelProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | AssetMeta['kind']>('all');
  const [picked, setPicked] = useState<string[]>([]);
  const [previewId, setPreviewId] = useState('');
  const preview = assets.find(asset => asset.id === previewId);
  const filtered = assets.filter((a) => (filter === 'all' || a.kind === filter) && a.name.toLowerCase().includes(query.trim().toLowerCase()));

  const togglePick = (id: string) => setPicked((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]));

  return (
    <section className={page ? 'desktop-assets-panel' : 'side-panel left-panel'} aria-label="素材库">
      <div className="panel-head">
        {page ? <h1>资产 <small>{assets.length}</small></h1> : <div className="panel-title"><Icon name="folder" size={16} /> 素材库</div>}
        {onClose && <button className="icon-btn small" title="收起面板" onClick={onClose}><Icon name="close" size={15} /></button>}
      </div>
      <div className="panel-actions">
        <button className="primary-btn" onClick={() => fileRef.current?.click()}><Icon name="plus" size={15} /> 导入素材</button>
        <button className="icon-btn small" title="刷新素材库" onClick={onRefresh}><Icon name="refresh" size={15} /></button>
        <input ref={fileRef} type="file" multiple hidden accept="image/*,video/*,audio/*,.mov,.m4v,.mkv,.flac,.m4a"
          onChange={(e) => { const files = Array.from(e.target.files ?? []); if (files.length) onFiles(files); e.target.value = ''; }} />
      </div>
      <div className="asset-search"><Icon name="search" size={14} /><input aria-label="搜索素材" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索素材名称" /></div>
      <div className="filter-tabs">
        {([['all', '全部'], ['image', '图片'], ['video', '视频'], ['audio', '音频']] as const).map(([key, label]) => (
          <button key={key} className={filter === key ? 'active' : ''} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}</button>
        ))}
      </div>
      <div className="asset-list">
        {filtered.length === 0 && (
          <div className="asset-empty"><Icon name="upload" size={26} /><p>{assets.length ? '没有匹配的素材' : '素材库还是空的'}</p>
            <span>{assets.length ? '换个关键词试试' : page ? '导入图片、视频或音频后，可在任意项目里使用' : '点击上方导入，或直接把文件拖到画布'}</span></div>
        )}
        {filtered.map((meta) => {
          const usedBy = assetUsage[meta.id] ?? [];
          return (
            <div key={meta.id} className={`asset-card${picked.includes(meta.id) ? ' picked' : ''}`} draggable={!page}
              onDragStart={(e) => { e.dataTransfer.setData('application/x-canvas-asset', meta.id); e.dataTransfer.effectAllowed = 'copy'; }}
              title={page ? meta.name : '拖到画布中使用，或拖到空节点上直接填充'}>
              <label className="asset-check" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
                <input type="checkbox" aria-label={'选择 ' + meta.name} checked={picked.includes(meta.id)} onChange={() => togglePick(meta.id)} />
              </label>
              <button className="asset-thumb" aria-label={'预览 ' + meta.name} onClick={() => setPreviewId(meta.id)}>
                  <AssetThumb meta={meta} /><span className={`kind-badge kind-${meta.kind}`}>{meta.kind === 'image' ? '图' : meta.kind === 'video' ? '视' : '音'}</span>
              </button>
              <div className="asset-info">
                <div className="asset-name" title={meta.name}>{meta.name}</div>
                <div className="asset-meta">{formatBytes(meta.size)}{usedBy.length > 0 && <span className="usage-badge" title={`被 ${usedBy.join('、')} 引用`}>{usedBy.length} 项目</span>}</div>
              </div>
              <div className="asset-ops">
                <button title="添加到画布" onClick={() => onPlace(meta.id)}><Icon name="plus" size={14} /></button>
                <button title="从素材库移除" onClick={() => onDelete(meta.id)}><Icon name="trash" size={14} /></button>
              </div>
            </div>
          );
        })}
      </div>
      {picked.length > 0 && (
        <div className="batch-bar">
          <span>已选 {picked.length} 个</span>
          <button className="primary-btn" onClick={() => { onBatchAdd(picked); setPicked([]); }}><Icon name="plus" size={14} /> 有序加入画布</button>
          <button className="icon-btn small" title="取消选择" onClick={() => setPicked([])}><Icon name="close" size={14} /></button>
        </div>
      )}
      <div className="panel-foot">
        <span>共 {assets.length} 个素材 · 全项目共享</span>
        {isEnabled('storageMeter') && <StorageMeter compact />}
      </div>
      {preview && <AssetPreview meta={preview} onClose={() => setPreviewId('')} />}
    </section>
  );
}

/* ------------------------------ 属性面板（只管基础布局与样式） ------------------------------ */
function NumberField({ label, value, onChange, suffix }: { label: string; value: number; onChange: (v: number) => void; suffix?: string }) {
  return (
    <label className="field-row"><span className="field-label">{label}</span>
      <input type="number" value={Math.round(value * 10) / 10}
        onFocus={() => useCanvas.getState().beginGesture()}
        onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) onChange(v); }}
        onBlur={() => useCanvas.getState().endGesture()} />
      {suffix && <em>{suffix}</em>}
    </label>
  );
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const hex = /^#[0-9a-fA-F]{6}$/.test(value) ? value : '#1e293b';
  return (
    <label className="field-row"><span className="field-label">{label}</span>
      <span className="color-control">
        <input type="color" value={hex} onFocus={() => useCanvas.getState().beginGesture()}
          onChange={(e) => onChange(e.target.value)} onBlur={() => useCanvas.getState().endGesture()} />
        <code>{value}</code>
      </span>
    </label>
  );
}

const BG_PRESETS = [
  { label: '白', value: '#ffffff' }, { label: '米', value: '#fef3c7' }, { label: '蓝', value: '#dbeafe' },
  { label: '绿', value: '#dcfce7' }, { label: '粉', value: '#fce7f3' }, { label: '深', value: '#1e293b' },
  { label: '透明', value: 'transparent' },
];

function nodeLabel(n: CanvasNode) {
  return n.name || (n.type === 'text' ? '文字' : n.type === 'group' ? '分组' : n.fileName);
}

interface InspectorProps {
  onClose: () => void;
  onOpenImage: (id: string) => void;
}

export function Inspector({ onClose, onOpenImage }: InspectorProps) {
  const nodes = useCanvas((s) => s.nodes);
  const edges = useCanvas((s) => s.edges);
  const selection = useCanvas((s) => s.selection);
  const selectedEdgeId = useCanvas((s) => s.selectedEdgeId);
  const viewport = useCanvas((s) => s.viewport);

  const selected = nodes.filter((n) => selection.includes(n.id));
  const edge = edges.find((e) => e.id === selectedEdgeId) ?? null;
  const single = selected.length === 1 ? selected[0] : null;
  // 节点类型、描述、插槽与可切换变体全部由注册表派生
  const nodeDef = single ? definitionOf(single) : null;
  const nodeSlots = single ? getNodeInputSlots(single) : [];
  const variantOptions = single ? listNodeDefinitions().filter((d) => d.type === single.type) : [];
  const st = useCanvas.getState();
  const live = (id: string, patch: Parameters<typeof st.updateNodesLive>[0][string]) => st.updateNodesLive({ [id]: patch });

  const propertiesView = (
    <>
      {!single && !edge && selected.length === 0 && (
        <>
          <div className="insp-section"><h4>画布概览</h4>
            <div className="stat-grid">
              <div><strong>{nodes.length}</strong><span>节点</span></div>
              <div><strong>{edges.length}</strong><span>连线</span></div>
              <div><strong>{nodes.filter((n) => n.type === 'group').length}</strong><span>分组</span></div>
              <div><strong>{Math.round(viewport.zoom * 100)}%</strong><span>缩放</span></div>
            </div>
          </div>
        </>
      )}

      {edge && (
        <>
          <div className="insp-section"><h4>连线</h4>
            <p className="muted-text">{(() => {
              const a = nodes.find((n) => n.id === edge.from); const b = nodes.find((n) => n.id === edge.to);
              return `${a ? nodeLabel(a) : '已删除节点'} → ${b ? nodeLabel(b) : '已删除节点'}`;
            })()}</p>
            <div className="edge-kind-note">{edge.kind === 'text-input' ? '文本输入：下游节点可引用这段文本作为提示词' : edge.kind === 'image-ref' ? '参考图输入：下游节点可引用该图片' : '普通关联'}</div>
            <label className="field-row"><span className="field-label">标签</span>
              <input type="text" value={edge.label} placeholder="连线说明"
                onFocus={() => st.beginGesture()}
                onChange={(e) => useCanvas.setState((s) => ({ edges: s.edges.map((x) => (x.id === edge.id ? { ...x, label: e.target.value } : x)) }))}
                onBlur={() => st.endGesture()} />
            </label>
            <ColorField label="颜色" value={edge.color} onChange={(v) => st.updateEdge(edge.id, { color: v })} />
          </div>
          <div className="insp-section"><button className="wide-btn danger" onClick={() => st.deleteEdge(edge.id)}><Icon name="trash" size={15} /> 断开连线</button></div>
        </>
      )}

      {selected.length > 1 && (
        <>
          <div className="insp-section"><h4>已选中 {selected.length} 个节点</h4></div>
          <div className="insp-section btn-grid">
            <button className="wide-btn" onClick={() => st.bringToFront()}><Icon name="front" size={15} /> 置于顶层</button>
            <button className="wide-btn" onClick={() => st.sendToBack()}><Icon name="back" size={15} /> 置于底层</button>
            <button className="wide-btn" onClick={() => st.groupSelection()}><Icon name="group" size={15} /> 创建分组框</button>
            <button className="wide-btn" onClick={() => st.duplicateSelection()}><Icon name="copy" size={15} /> 复制选中</button>
          </div>
          <div className="insp-section"><button className="wide-btn danger" onClick={() => st.deleteSelection()}><Icon name="trash" size={15} /> 删除选中</button></div>
        </>
      )}

      {single && (
        <>
          {nodeDef && (
            <div className="insp-section node-def-section" data-testid="node-definition-section">
              <h4>节点类型</h4>
              <div className="node-def-head">
                <span className="node-def-icon"><Icon name={nodeDef.icon} size={15} /></span>
                <div className="node-def-main">
                  <strong>{nodeDef.label}</strong>
                  <em>{nodeDef.description}</em>
                </div>
              </div>
              <label className="field-row"><span className="field-label">变体</span>
                <select data-testid="node-variant-select" value={nodeDef.variant}
                  onChange={(e) => st.updateNode(single.id, { variant: e.target.value })}>
                  {variantOptions.map((d) => <option key={d.variant} value={d.variant}>{d.label}</option>)}
                </select>
              </label>
              <div className="node-def-meta">
                <span data-testid="node-def-size">默认 {nodeDef.defaultSize.w}×{nodeDef.defaultSize.h}</span>
                <span>最小 {nodeDef.minSize.w}×{nodeDef.minSize.h}</span>
                <span>{nodeDef.category}</span>
              </div>
              {nodeSlots.length > 0 && (
                <div className="node-def-slots" data-testid="node-def-slots">
                  {nodeSlots.map((slot) => (
                    <div key={slot.id}><span className="slot-dot mini" /><span>{slot.label}</span><em>{slot.optional ? '可选' : '必填'}</em></div>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className="insp-section">
            <div className="selected-head"><span className={`type-chip type-${single.type}`}><Icon name={single.type} size={13} />{single.type === 'text' ? '文字' : single.type === 'group' ? '分组框' : single.type === 'image' ? '图片' : single.type === 'video' ? '视频' : '音频'}</span></div>
            <div className="node-id">ID {single.id.slice(-8)}</div>
            <label className="field-row"><span className="field-label">名称</span>
              <input type="text" value={single.name ?? ''} onFocus={() => st.beginGesture()}
                onChange={(e) => live(single.id, { name: e.target.value })} onBlur={() => st.endGesture()} />
            </label>
          </div>
          <div className="insp-section"><h4>位置与尺寸</h4>
            <div className="field-pair">
              <NumberField label="X" value={single.x} onChange={(v) => live(single.id, { x: v })} />
              <NumberField label="Y" value={single.y} onChange={(v) => live(single.id, { y: v })} />
            </div>
            <div className="field-pair">
              <NumberField label="宽" value={single.w} onChange={(v) => live(single.id, { w: Math.max(140, v) })} />
              <NumberField label="高" value={single.h} onChange={(v) => live(single.id, { h: Math.max(116, v) })} />
            </div>
          </div>

          {single.type === 'text' && (
            <div className="insp-section"><h4>文字内容</h4>
              <textarea className="insp-textarea" rows={5} value={single.text}
                onFocus={() => st.beginGesture()} onChange={(e) => live(single.id, { text: e.target.value })} onBlur={() => st.endGesture()} placeholder="输入文字…" />
              <NumberField label="字号" value={single.fontSize} onChange={(v) => live(single.id, { fontSize: Math.max(8, Math.min(160, v)) })} suffix="px" />
              <ColorField label="字色" value={single.color} onChange={(v) => live(single.id, { color: v })} />
              <div className="field-row"><span className="field-label">背景</span>
                <div className="bg-presets">{BG_PRESETS.map((p) => (
                  <button key={p.value} title={p.label} className={single.bg === p.value ? 'active' : ''}
                    style={{ background: p.value === 'transparent' ? 'linear-gradient(135deg,#fff 45%,#ef4444 47%,#ef4444 53%,#fff 55%)' : p.value }}
                    onClick={() => st.updateNode(single.id, { bg: p.value })} />
                ))}</div>
              </div>
              <div className="field-row"><span className="field-label">字形</span>
                <div className="seg-control">
                  <button className={single.bold ? 'active' : ''} onClick={() => st.updateNode(single.id, { bold: !single.bold })}><strong>B</strong></button>
                  {(['left', 'center', 'right'] as const).map((a) => (
                    <button key={a} className={single.align === a ? 'active' : ''} onClick={() => st.updateNode(single.id, { align: a })}>{a === 'left' ? '左' : a === 'center' ? '中' : '右'}</button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {single.type === 'group' && (
            <div className="insp-section"><h4>分组框</h4>
              <ColorField label="主题色" value={single.color} onChange={(v) => live(single.id, { color: v })} />
            </div>
          )}

          {(single.type === 'image' || single.type === 'video' || single.type === 'audio') && (
            <div className="insp-section"><h4>节点素材</h4>
              <div className="asset-filename"><Icon name={single.type} size={15} /><span title={single.fileName}>{single.fileName || '空节点，尚未填充素材'}</span></div>
              {(single.type === 'image' || single.type === 'video') && (
                <div className="field-row"><span className="field-label">填充</span>
                  <div className="seg-control">
                    <button className={single.fit === 'contain' ? 'active' : ''} onClick={() => st.updateNode(single.id, { fit: 'contain' })}>完整显示</button>
                    <button className={single.fit === 'cover' ? 'active' : ''} onClick={() => st.updateNode(single.id, { fit: 'cover' })}>铺满裁切</button>
                  </div>
                </div>
              )}
              {single.type === 'image' && single.assetId && <button className="wide-btn" onClick={() => onOpenImage(single.assetId)}><Icon name="zoomIn" size={15} /> 放大查看原图</button>}
            </div>
          )}

          <div className="insp-section"><h4>层级与操作</h4>
            <div className="btn-grid">
              <button className="wide-btn" onClick={() => st.bringToFront([single.id])}><Icon name="front" size={15} /> 置于顶层</button>
              <button className="wide-btn" onClick={() => st.sendToBack([single.id])}><Icon name="back" size={15} /> 置于底层</button>
              <button className="wide-btn" onClick={() => { st.setSelection([single.id]); st.duplicateSelection(); }}><Icon name="copy" size={15} /> 复制节点</button>
              <button className="wide-btn" onClick={() => st.groupSelection()}><Icon name="group" size={15} /> 装进分组框</button>
            </div>
            <button className="wide-btn danger" onClick={() => st.deleteSelection()}><Icon name="trash" size={15} /> 删除节点</button>
          </div>
        </>
      )}
    </>
  );

  return (
    <aside className="side-panel right-panel">
      <div className="panel-head">
        <div className="panel-title"><Icon name="settings" size={16} /> 属性</div>
        <button className="icon-btn small" title="收起面板" onClick={onClose}><Icon name="close" size={15} /></button>
      </div>
      <div className="inspector-body">{propertiesView}</div>
    </aside>
  );
}

/* ------------------------------ 底部工具栏 ------------------------------ */
interface ToolbarProps {
  onAddText: () => void;
  onAddGroup: () => void;
  onAddFiles: () => void;
  onSearch?: () => void;
  onShortcuts?: () => void;
  onToggleFocus?: () => void;
  focusMode?: boolean;
}

export function Toolbar({ onAddText, onAddGroup, onAddFiles, onSearch, onShortcuts, onToggleFocus, focusMode = false }: ToolbarProps) {
  const tool = useCanvas((s) => s.tool);
  const canUndo = useCanvas((s) => s.past.length > 0);
  const canRedo = useCanvas((s) => s.future.length > 0);
  const st = useCanvas.getState();

  return (
    <div className="toolbar" onPointerDown={(e) => e.stopPropagation()}>
      <div className="tool-group">
        <button className={tool === 'select' ? 'active' : ''} title="选择工具 (V)：拖动框选" onClick={() => st.setTool('select')}><Icon name="cursor" size={17} /></button>
        <button className={tool === 'hand' ? 'active' : ''} title="抓手工具 (H)：拖动平移画布" onClick={() => st.setTool('hand')}><Icon name="hand" size={17} /></button>
      </div>
      <span className="tool-sep" />
      <div className="tool-group">
        <button title="添加文字节点" onClick={onAddText}><Icon name="text" size={17} /><span>文字</span></button>
        <button title="添加图片生成节点" onClick={() => st.createNode('image')}><Icon name="image" size={17} /><span>图片</span></button>
        <button title="添加视频生成节点" onClick={() => st.createNode('video')}><Icon name="video" size={17} /><span>视频</span></button>
        <button title="添加分组框" onClick={onAddGroup}><Icon name="group" size={17} /><span>分组</span></button>
        <button title="导入图片 / 视频 / 音频" onClick={onAddFiles}><Icon name="upload" size={17} /><span>素材</span></button>
      </div>
      <span className="tool-sep" />
      <div className="tool-group">
        <button title="撤销 (Ctrl Z)" disabled={!canUndo} onClick={() => st.undo()}><Icon name="undo" size={17} /></button>
        <button title="重做 (Ctrl Shift Z)" disabled={!canRedo} onClick={() => st.redo()}><Icon name="redo" size={17} /></button>
      </div>
      <span className="tool-sep" />
      <div className="tool-group">
        <button data-testid="arrange-nodes" title="自动整理节点：按连线依赖分层、按类型分泳道" onClick={() => st.arrangeNodes()}>
          <Icon name="grid" size={17} /><span>整理</span>
        </button>
        <button data-testid="open-node-search" title="搜索画布节点 (Ctrl K)" onClick={onSearch}><Icon name="zoomIn" size={17} /></button>
        <button data-testid="open-shortcuts" title="快捷键速查 (?)" onClick={onShortcuts} className="tool-question">?</button>
        <button data-testid="toggle-focus" className={focusMode ? 'active' : ''} title="进入 / 退出专注模式 (Ctrl Shift F)" onClick={onToggleFocus}>
          <Icon name="layers" size={17} />
        </button>
      </div>
    </div>
  );
}
