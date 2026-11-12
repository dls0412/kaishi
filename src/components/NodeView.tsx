import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { invalidateAssetUrl, listAssets, putAsset } from '../lib/db';
import { freeCanvasPosition, uid } from '../lib/utils';
import { isEnabled } from '../lib/workbenchRuntime';
import {
  isEmptyMediaNode,
  isMediaNode,
  nodeDisplayName,
  NODE_DEFAULTS,
  TYPE_LABELS,
  type CanvasNode,
} from '../types';
import { useCanvas } from '../store';
import {
  definitionOf,
  getNodeInputSlots,
  hasSlotLayout,
  type InputSlot,
} from '../lib/nodeRegistry';
import { useAssetUrl } from './useAssetUrl';
import { generationInputSignature } from '../lib/generationInputs';
import Icon from './Icon';

/** 全局只允许一个视频在做悬停预览解码 */
let activePreviewVideo: HTMLVideoElement | null = null;

interface Props {
  node: CanvasNode;
  selected: boolean;
  /** 与当前选中节点直接相连的上/下游，只做轻量描边强调，不改变内容 */
  related?: boolean;
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>, id: string) => void;
  onResizeStart: (e: ReactPointerEvent<HTMLDivElement>, id: string, handle: string) => void;
  onConnectStart: (e: ReactPointerEvent<HTMLDivElement>, id: string, handle: string) => void;
  onOpenImage: (assetId: string) => void;
  onTextGenerate: (id: string) => void;
  onAudioGenerate: (id: string) => void;
}

/**
 * 输入插槽的来源完全由连线派生：断线即消失，不保存第二份来源清单。
 * 同一类型的多条连线按插槽顺序分配，剩余插槽显示「可选」。
 */
function resolveSlotSources(node: CanvasNode, slots: InputSlot[], edges: { from: string; to: string }[], nodes: CanvasNode[]) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const incoming = edges
    .filter((e) => e.to === node.id)
    .map((e) => byId.get(e.from))
    .filter((n): n is CanvasNode => !!n);
  const used = new Set<string>();
  return slots.map((slot) => {
    const accepts = Array.isArray(slot.accepts) ? slot.accepts : [slot.accepts];
    const limit = slot.max ?? 1;
    const hits = incoming.filter((n) => !used.has(n.id) && accepts.includes(n.type)).slice(0, limit);
    hits.forEach((n) => used.add(n.id));
    return hits.map((n) => n.name || (isMediaNode(n) ? n.fileName : '') || TYPE_LABELS[n.type]).join('、');
  });
}

/**
 * 节点卡片，对齐 BeefTV 的紧凑深灰卡片：标题栏（图标 + 名称 + 编辑/删除）、
 * 输入插槽列表、左右连接点。创作控制仍由画布顶层浮层统一渲染。
 */
export default function NodeView({
  node, selected, related = false, onPointerDown, onResizeStart, onConnectStart, onOpenImage, onTextGenerate, onAudioGenerate,
}: Props) {
  const assetId = isMediaNode(node) && node.assetId ? node.assetId : null;
  const [reloadKey, setReloadKey] = useState(0);
  const [mediaError, setMediaError] = useState(false);
  const url = useAssetUrl(assetId, reloadKey);
  useEffect(() => { setMediaError(false); }, [assetId, reloadKey]);

  /** 加载失败后重新读 Blob 并生成新的对象 URL，不静默留一张空白卡片 */
  const reloadMedia = () => {
    if (assetId) invalidateAssetUrl(assetId);
    setMediaError(false);
    setReloadKey((k) => k + 1);
  };

  /* 视频悬停静音预览：全局同时只解码一个，350ms 延迟，3 秒后自动停，离开即停 */
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hoverTimer = useRef<number | null>(null);
  const previewTimer = useRef<number | null>(null);
  const previewing = useRef(false);
  const clearHoverTimers = () => {
    if (hoverTimer.current !== null) { window.clearTimeout(hoverTimer.current); hoverTimer.current = null; }
    if (previewTimer.current !== null) { window.clearTimeout(previewTimer.current); previewTimer.current = null; }
  };
  const stopPreview = () => {
    clearHoverTimers();
    const el = videoRef.current;
    if (previewing.current && el) {
      el.pause();
      try { el.currentTime = 0; } catch { /* 忽略不支持 seek 的编码 */ }
      el.muted = false;
    }
    previewing.current = false;
    if (activePreviewVideo === el) activePreviewVideo = null;
  };
  const startPreview = () => {
    const el = videoRef.current;
    if (!el || !isEnabled('hoverPreview')) return;
    if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    clearHoverTimers();
    hoverTimer.current = window.setTimeout(() => {
      if (activePreviewVideo && activePreviewVideo !== el) {
        activePreviewVideo.pause();
        activePreviewVideo.muted = false;
      }
      activePreviewVideo = el;
      previewing.current = true;
      el.muted = true;
      try { el.currentTime = 0; } catch { /* 忽略不支持 seek 的编码 */ }
      void el.play().catch(() => { /* 浏览器拒绝自动播放时保持静帧 */ });
      previewTimer.current = window.setTimeout(stopPreview, 3000);
    }, 350);
  };
  useEffect(() => () => {
    clearHoverTimers();
    if (previewing.current) stopPreview();
  // 组件卸载时收尾，依赖保持为空避免每次渲染重绑
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [editingText, setEditingText] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [frameError, setFrameError] = useState('');
  const [frameBusy, setFrameBusy] = useState(false);
  const updateNodesLive = useCanvas((s) => s.updateNodesLive);
  const beginGesture = useCanvas((s) => s.beginGesture);
  const endGesture = useCanvas((s) => s.endGesture);
  const edges = useCanvas((s) => s.edges);
  const allNodes = useCanvas((s) => s.nodes);
  const setSelection = useCanvas((s) => s.setSelection);
  const deleteSelection = useCanvas((s) => s.deleteSelection);

  const def = definitionOf(node);
  const isGroup = node.type === 'group';
  const empty = isEmptyMediaNode(node);
  const slots = selected && !def.basic && hasSlotLayout(node) && empty ? getNodeInputSlots(node) : [];
  const slotSources = slots.length ? resolveSlotSources(node, slots, edges, allNodes) : [];
  const isFinalOutput = def.variant === 'image-generator' || def.variant === 'video-generator';
  // 控制区固定在 5000 层，节点层级封顶，避免其它节点盖住控制区
  const zIndex = isGroup ? 1 : Math.min(100 + (node.z ?? 0), 4000);

  const onDoubleClick = (e: ReactMouseEvent) => {
    e.stopPropagation();
    if (node.type === 'text') setEditingText(true);
    else if (node.type === 'image' && node.assetId) onOpenImage(node.assetId);
  };

  const removeNode = (e: ReactMouseEvent) => {
    e.stopPropagation();
    setSelection([node.id]);
    deleteSelection();
  };

  const captureFrame = async (position: 'current' | 'first' | 'last' = 'current') => {
    if (frameBusy) return;
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) { setFrameError('视频尚未加载完成'); return; }
    const projectId = useCanvas.getState().projectId;
    setFrameBusy(true);
    try {
      video.pause();
      if (position !== 'current') {
        const target = position === 'first' ? 0 : Math.max(0, video.duration - 0.05);
        if (!Number.isFinite(target)) throw new Error('无法确定视频时长');
        if (Math.abs(video.currentTime - target) > 0.001) {
          await new Promise<void>((resolve, reject) => {
            const timer = window.setTimeout(() => { video.removeEventListener('seeked', done); reject(new Error('读取视频帧超时')); }, 10000);
            const done = () => { window.clearTimeout(timer); resolve(); };
            video.addEventListener('seeked', done, { once: true });
            video.currentTime = target;
          });
        }
      }
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('无法读取视频画面');
      context.drawImage(video, 0, 0);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('无法保存当前帧')), 'image/png'));
      const id = uid('asset');
      const frameName = position === 'first' ? '首帧' : position === 'last' ? '尾帧' : '当前帧';
      const name = `${node.name || '视频'}-${frameName}.png`;
      await putAsset({ meta: { id, name, mime: 'image/png', size: blob.size, kind: 'image', createdAt: Date.now() }, blob });
      useCanvas.getState().setAssets(await listAssets());
      const current = useCanvas.getState();
      if (current.projectId === projectId && current.nodes.some(item => item.id === node.id)) {
        const size = NODE_DEFAULTS.image;
        const at = freeCanvasPosition(current.nodes, { x: node.x + node.w + 96, y: node.y }, size);
        current.createNode('image', { x: at.x + size.w / 2, y: at.y + size.h / 2 }, { assetId: id, fileName: name, name });
        await useCanvas.getState().persist();
      }
      setFrameError('');
    } catch (error) { setFrameError(error instanceof Error ? error.message : '截帧失败'); }
    finally { setFrameBusy(false); }
  };

  return (
    <div
      data-node-id={node.id}
      data-node-variant={def.variant}
      className={`canvas-node node-${node.type}${selected ? ' is-selected' : ''}${related ? ' is-related' : ''}${empty ? ' is-empty' : ''}${slots.length ? ' has-slots' : ''}`}
      data-related={related ? 'true' : undefined}
      style={{ left: node.x, top: node.y, width: node.w, height: node.h, zIndex }}
      onPointerDown={(e) => onPointerDown(e, node.id)}
      onDoubleClick={onDoubleClick}
    >
      <div
        className={`node-head${isGroup ? ' group-head' : ''}`}
        style={isGroup ? { background: node.color } : undefined}
        onDoubleClick={(e) => { e.stopPropagation(); setEditingName(true); }}
      >
        <span className="node-head-type" title={`${def.label} · ${def.description}`}>
          <Icon name={def.icon} size={12} />{def.label}
        </span>
        {editingName ? (
          <input
            className="node-name-input"
            data-no-drag
            autoFocus
            value={node.name}
            onPointerDown={(e) => e.stopPropagation()}
            onFocus={() => beginGesture()}
            onChange={(e) => updateNodesLive({ [node.id]: { name: e.target.value } })}
            onBlur={() => { setEditingName(false); endGesture(); }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229 || (e.key !== 'Enter' && e.key !== 'Escape')) return;
              e.stopPropagation();
              e.currentTarget.blur();
            }}
          />
        ) : (
          <span className="node-head-name" title={node.name || nodeDisplayName(node)}>{node.name || nodeDisplayName(node)}</span>
        )}
        {isFinalOutput && <span className="node-final-badge" title="标记为最终输出"><Icon name="check" size={10} />最终输出</span>}
        {isMediaNode(node) && node.assetId && (node.resultStale || (node.resultInputSnapshot !== undefined && node.resultInputSnapshot !== generationInputSignature(node.id, allNodes, edges))) && <span className="node-stale-badge" data-testid="result-stale" title="提示词、参数或连线素材已改变，现有结果尚未更新">需重新生成</span>}
        <span className="node-head-ops" data-no-drag>
          {node.type === 'text' && selected && <button title="文本生成" onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onTextGenerate(node.id); }}><Icon name="sparkles" size={12} /></button>}
          {node.type === 'audio' && selected && <button title="生成配音" onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onAudioGenerate(node.id); }}><Icon name="sparkles" size={12} /></button>}
          {node.type === 'video' && node.assetId && selected && <>
            <button title="截取首帧" onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); void captureFrame('first'); }}>首</button>
            <button title="截取当前帧" onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); void captureFrame(); }}><Icon name="image" size={12} /></button>
            <button title="截取尾帧" onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); void captureFrame('last'); }}>尾</button>
          </>}
          <button title="重命名" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); setEditingName(true); }}><Icon name="edit" size={12} /></button>
          <button title="删除节点" onPointerDown={(e) => e.stopPropagation()} onClick={removeNode}><Icon name="trash" size={12} /></button>
        </span>
      </div>

      <div className="node-port port-in" title="输入端口" />
      <div
        className="node-port port-out"
        title="输出端口：拖到其他节点建立连线"
        onPointerDown={(e) => onConnectStart(e, node.id, 'out')}
      />

      {slots.length > 0 && (
        <div className="node-slots">
          {slots.map((slot, i) => (
            <div className={`node-slot${slotSources[i] ? ' filled' : ''}`} key={slot.id} data-slot={slot.id}>
              <span className="slot-dot" />
              <span className="slot-label">{slot.label}</span>
              <span className="slot-value">{slotSources[i] || (slot.optional ? '可选' : '未连接')}</span>
            </div>
          ))}
        </div>
      )}

      {node.type === 'text' && (
        <div
          className="node-body text-body"
          style={{
            background: node.bg,
            color: node.color,
            fontSize: node.fontSize,
            fontWeight: node.bold ? 700 : 400,
            textAlign: node.align,
          }}
        >
          {editingText ? (
            <textarea
              className="text-editor"
              data-no-drag
              autoFocus
              value={node.text}
              style={{ color: node.color, fontSize: node.fontSize, fontWeight: node.bold ? 700 : 400, textAlign: node.align }}
              onPointerDown={(e) => e.stopPropagation()}
              onFocus={() => beginGesture()}
              onChange={(e) => updateNodesLive({ [node.id]: { text: e.target.value } })}
              onBlur={() => { setEditingText(false); endGesture(); }}
              onKeyDown={(e) => {
                if (e.key !== 'Escape' || e.nativeEvent.isComposing || e.keyCode === 229) return;
                e.stopPropagation();
                e.currentTarget.blur();
              }}
            />
          ) : (
            <div className="text-content">{node.text || '双击编辑文字'}</div>
          )}
        </div>
      )}

      {isMediaNode(node) && empty && !slots.length && (
        <div className="node-body empty-media-body">
          <Icon name={def.icon} size={26} />
          {node.type === 'audio' && <strong>拖入音频</strong>}
        </div>
      )}

      {node.type === 'image' && !empty && (
        <div className="node-body media-body">
          {url && !mediaError
            ? <img src={url} alt={node.fileName} draggable={false} style={{ objectFit: node.fit }}
                onError={() => setMediaError(true)} data-testid="node-image" />
            : mediaError
              ? <div className="media-error" data-testid="node-media-error">
                  <span>图片加载失败</span>
                  <button className="mini-btn" data-no-drag data-testid="node-media-reload"
                    onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); reloadMedia(); }}>
                    <Icon name="refresh" size={13} /> 重新加载
                  </button>
                </div>
              : <div className="media-placeholder">素材加载中…</div>}
          <button
            className="node-zoom-btn"
            data-no-drag
            title="放大查看"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onOpenImage(node.assetId); }}
          >
            <Icon name="zoomIn" size={14} />
          </button>
          {node.resultAssetIds && node.resultAssetIds.length > 1 && <div className="node-result-switcher" data-no-drag onPointerDown={e => e.stopPropagation()}>
            <button aria-label="上一张生成结果" onClick={e => { e.stopPropagation(); const ids = node.resultAssetIds!; const index = (ids.indexOf(node.assetId) + ids.length - 1) % ids.length; useCanvas.getState().updateNode(node.id, { assetId: ids[index], fileName: `${node.name} · 结果 ${index + 1}` }); }}>‹</button>
            <span>{Math.max(0, node.resultAssetIds.indexOf(node.assetId)) + 1} / {node.resultAssetIds.length}</span>
            <button aria-label="下一张生成结果" onClick={e => { e.stopPropagation(); const ids = node.resultAssetIds!; const index = (ids.indexOf(node.assetId) + 1) % ids.length; useCanvas.getState().updateNode(node.id, { assetId: ids[index], fileName: `${node.name} · 结果 ${index + 1}` }); }}>›</button>
          </div>}
        </div>
      )}

      {node.type === 'video' && !empty && (
        <div className="node-body media-body" onMouseEnter={startPreview} onMouseLeave={stopPreview}>
          {frameError && <span role="alert">{frameError}</span>}
          {url && !mediaError
            ? <video
                ref={videoRef}
                className="media-video"
                src={url}
                controls
                preload="metadata"
                playsInline
                data-no-drag
                data-testid="node-video"
                onPointerDown={stopPreview}
                onError={() => setMediaError(true)}
                onLoadedMetadata={(e) => {
                  const el = e.currentTarget;
                  if (el.readyState < 2) { try { el.currentTime = 0.02; } catch { /* 忽略不支持 seek 的编码 */ } }
                }}
                style={{ objectFit: node.fit }}
              />
            : mediaError
              ? <div className="media-error" data-testid="node-media-error">
                  <span>视频加载失败</span>
                  <button className="mini-btn" data-no-drag data-testid="node-media-reload"
                    onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); reloadMedia(); }}>
                    <Icon name="refresh" size={13} /> 重新加载
                  </button>
                </div>
              : <div className="media-placeholder">素材加载中…</div>}
        </div>
      )}

      {node.type === 'audio' && !empty && (
        <div className="node-body audio-body" data-no-drag>
          <div className="audio-head">
            <span className="audio-icon"><Icon name="audio" size={18} /></span>
            <span className="audio-name" title={node.fileName}>{node.fileName}</span>
          </div>
          {url
            ? <audio src={url} controls preload="metadata" data-no-drag />
            : <div className="media-placeholder">素材加载中…</div>}
        </div>
      )}

      {isGroup && <div className="group-body" style={{ borderColor: node.color }} />}

      {selected && (['nw', 'ne', 'sw', 'se'] as const).map((h) => (
        <div key={h} className={`resize-handle rh-${h}`} onPointerDown={(e) => onResizeStart(e, node.id, h)} />
      ))}
    </div>
  );
}
