import './styles.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';

import Icon from '../../components/Icon';
import { config, patchSection, PROMPT_OPERATIONS, workbenchOf, type PromptOperation } from '../../lib/workbenchRuntime';
import { firstTextService, type TextChannel } from '../../lib/skillCatalog';
import { refToken, hasRefToken } from '../../lib/models';
import { useCanvas } from '../../store';
import { nodeDisplayName, type CanvasNode, type Edge } from '../../types';

/* ==================== 共用：引用标记与指针拖拽 ==================== */

/** 与 src/lib/models.ts 保持一致：@[显示名#节点ID]，同时兼容旧的 @[node:ID] */
const REF_SCAN_RE = /@\[[^\]\n]+\]/g;
/** 图N / 图片N / imageN / image N，以及前后都不是文字的独立序号 */
const NUM_REF_RE = /(?:图片|图像|图|[Ii][Mm][Aa][Gg][Ee])\s*([0-9]{1,2})|(?<![\w\u4e00-\u9fff])([0-9]{1,2})(?![\w\u4e00-\u9fff])/g;

interface Conversion { start: number; end: number; replacement: string; nodeId: string }

/** 用项目已有的引用格式生成标记，显示名清洗规则完全复用 models.refToken */
function tokenFor(node: CanvasNode): string {
  return refToken({ id: node.id, nodeId: node.id, label: nodeDisplayName(node) });
}

/**
 * 只把「能唯一匹配到的指代」解析成引用标记。
 * 候选仅来自连线到本节点的上游：技能条目、素材库条目不是画布连线节点，天然不会被误引用。
 * 重名歧义、已有引用、落在引用标记内的文本一律跳过；普通数字如「约2秒」因前后是汉字不会命中。
 */
function computeConversions(value: string, nodeId: string, nodes: CanvasNode[], edges: Edge[]): Conversion[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const upstream: CanvasNode[] = [];
  const seen = new Set<string>();
  edges.filter((e) => e.to === nodeId).forEach((e) => {
    const src = byId.get(e.from);
    if (!src || src.id === nodeId || src.type === 'group' || seen.has(src.id)) return;
    seen.add(src.id);
    upstream.push(src);
  });
  if (!upstream.length || !value.trim()) return [];

  // 重名歧义：同名上游节点直接跳过，不猜指向谁
  const nameCount = new Map<string, number>();
  upstream.forEach((n) => {
    const name = (n.name || nodeDisplayName(n)).trim();
    nameCount.set(name, (nameCount.get(name) ?? 0) + 1);
  });

  // 已有引用：保护其区间，并记下已被引用的节点，避免重复插入
  const refRanges: { start: number; end: number }[] = [];
  for (const m of value.matchAll(REF_SCAN_RE)) {
    refRanges.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  }
  const refed = new Set(upstream.filter((n) => hasRefToken(value, n.id)).map((n) => n.id));

  const cands: { start: number; end: number; nodeId: string }[] = [];
  for (const m of value.matchAll(NUM_REF_RE)) {
    const at = m.index ?? 0;
    const n = Number(m[1] ?? m[2]);
    const target = upstream[n - 1];
    if (!target) continue;
    cands.push({ start: at, end: at + m[0].length, nodeId: target.id });
  }
  upstream.forEach((node) => {
    const name = (node.name || nodeDisplayName(node)).trim();
    if (name.length < 2 || (nameCount.get(name) ?? 0) > 1) return;
    let from = 0;
    while (from <= value.length - name.length) {
      const at = value.indexOf(name, from);
      if (at < 0) break;
      cands.push({ start: at, end: at + name.length, nodeId: node.id });
      from = at + name.length;
    }
  });

  // 长指代优先，贪心去重叠；同一节点只插一次，与 insertPromptRef 的去重一致
  cands.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const inRef = (s: number, e: number) => refRanges.some((r) => s < r.end && e > r.start);
  const inserted = new Set<string>();
  const result: Conversion[] = [];
  let cursor = 0;
  for (const c of cands) {
    if (c.start < cursor || inRef(c.start, c.end)) continue;
    if (refed.has(c.nodeId) || inserted.has(c.nodeId)) continue;
    const node = byId.get(c.nodeId);
    if (!node) continue;
    result.push({ start: c.start, end: c.end, nodeId: c.nodeId, replacement: tokenFor(node) });
    inserted.add(c.nodeId);
    cursor = c.end;
  }
  return result;
}

/** 统一的 pointerdown/move/up 拖拽：被放大窗与优化抽屉共用 */
function beginDrag(e: ReactPointerEvent, onMove: (dx: number, dy: number, x: number, y: number) => void): void {
  e.preventDefault();
  e.stopPropagation();
  const sx = e.clientX;
  const sy = e.clientY;
  const move = (ev: PointerEvent) => onMove(ev.clientX - sx, ev.clientY - sy, ev.clientX, ev.clientY);
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

/* ==================== 1. 提示词放大编辑弹窗 ==================== */

export interface PromptExpanderProps {
  nodeId: string;
  value: string;
  onChange: (v: string) => void;
  onClose: () => void;
}

export function PromptExpander({ nodeId, value, onChange, onClose }: PromptExpanderProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  // null = 用 CSS 默认值 min(1200px, 92vw)；拖拽后转为固定像素
  const [size, setSize] = useState<{ w: number | null; h: number | null }>({ w: null, h: null });

  // 切换节点时尺寸恢复默认
  useEffect(() => { setSize({ w: null, h: null }); }, [nodeId]);

  const nodeName = useMemo(() => {
    const n = useCanvas.getState().nodes.find((x) => x.id === nodeId);
    return n ? nodeDisplayName(n) : '未命名节点';
  }, [nodeId]);

  const rectOf = () => dialogRef.current?.getBoundingClientRect();

  const nudge = (dw: number, dh: number) => {
    const rect = rectOf();
    if (!rect) return;
    setSize({
      w: Math.max(420, Math.round(rect.width + dw)),
      h: Math.max(280, Math.round(rect.height + dh)),
    });
  };

  const onResizeStart = (e: ReactPointerEvent) => {
    const rect = rectOf();
    if (!rect) return;
    const startW = rect.width;
    const startH = rect.height;
    beginDrag(e, (dx, dy) => setSize({
      w: Math.max(420, Math.round(startW + dx)),
      h: Math.max(280, Math.round(startH + dy)),
    }));
  };

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    // 禁止冒泡到画布快捷键
    e.stopPropagation();
    if (!e.altKey) return;
    const step = 20;
    if (e.key === 'ArrowRight') { e.preventDefault(); nudge(step, 0); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); nudge(-step, 0); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); nudge(0, step); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); nudge(0, -step); }
  };

  const style: CSSProperties | undefined = size.w != null
    ? { width: size.w, height: size.h ?? undefined }
    : undefined;

  return (
    <div className="modal-mask pt-expander-mask" data-testid="wb-prompt-expander" onClick={onClose}>
      <div
        ref={dialogRef}
        className="pt-expander"
        style={style}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="提示词放大编辑"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        onKeyUp={(e) => e.stopPropagation()}
      >
        <div className="dialog-head pt-expander-head">
          <h3><Icon name="edit" size={16} /> 提示词放大编辑</h3>
          <div className="pt-expander-meta">
            <span data-testid="wb-prompt-expander-node">{nodeName}</span>
            <span className="pt-dim" data-testid="wb-prompt-expander-count">{value.length} 字</span>
            <button className="mini-btn" onClick={onClose} aria-label="关闭" data-testid="wb-prompt-expander-close">
              <Icon name="close" size={14} />
            </button>
          </div>
        </div>
        <div className="dialog-body pt-expander-body">
          <textarea
            className="dialog-input pt-expander-textarea"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="在这里放大编辑提示词…"
            spellCheck={false}
            autoFocus
            data-testid="wb-prompt-expander-textarea"
          />
        </div>
        <div className="dialog-foot pt-expander-foot">
          <span className="pt-dim pt-expander-hint">按住 Alt + 方向键微调宽高（每次 20px）· 拖动右下角改尺寸</span>
          <button className="primary-btn" onClick={onClose} data-testid="wb-prompt-expander-done">
            <Icon name="check" size={14} /> 完成
          </button>
        </div>
        <div className="pt-expander-resize" onPointerDown={onResizeStart} title="拖动改尺寸" data-testid="wb-prompt-expander-resize">
          <Icon name="more" size={12} />
        </div>
      </div>
    </div>
  );
}

/* ==================== 2. 智能引用控制条 ==================== */

export interface AutoLinkControlsProps {
  nodeId: string;
  value: string;
  onChange: (v: string) => void;
  onNotice: (msg: string) => void;
}

export function AutoLinkControls({ nodeId, value, onChange, onNotice }: AutoLinkControlsProps) {
  const nodes = useCanvas((s) => s.nodes);
  const edges = useCanvas((s) => s.edges);
  // 面板临时状态，但通过 patchSection 写回配置持久化
  const [autoLink, setAutoLink] = useState<boolean>(() => config().features.autoLink);

  useEffect(() => { setAutoLink(config().features.autoLink); }, [nodeId]);

  const conversions = useMemo(
    () => computeConversions(value, nodeId, nodes, edges),
    [value, nodeId, nodes, edges],
  );

  const toggle = () => {
    const next = !autoLink;
    setAutoLink(next);
    patchSection('features', { autoLink: next });
    onNotice(next ? 'AutoLink 已开启并保存' : 'AutoLink 已关闭并保存');
  };

  const apply = () => {
    if (!conversions.length) return;
    let next = value;
    for (let i = conversions.length - 1; i >= 0; i -= 1) {
      const c = conversions[i];
      next = next.slice(0, c.start) + c.replacement + next.slice(c.end);
    }
    onChange(next);
    onNotice(`已把 ${conversions.length} 处指代替换为引用标记`);
  };

  return (
    <div className="pt-autolink" data-testid="wb-prompt-autolink">
      <label className="check-row pt-autolink-toggle">
        <input type="checkbox" checked={autoLink} onChange={toggle} data-testid="wb-prompt-autolink-toggle" />
        <span>AutoLink 智能引用</span>
      </label>
      <button className="mini-btn" onClick={apply} disabled={!conversions.length} data-testid="wb-prompt-autolink-apply">
        <Icon name="link" size={12} /> 一键引用全文
      </button>
      <span className="pt-dim" data-testid="wb-prompt-autolink-count">
        {conversions.length ? `可转换 ${conversions.length} 处` : '没有可转换的指代'}
      </span>
    </div>
  );
}

/* ==================== 3. AI 提示词优化器 ==================== */

type ModeId = 'expand' | 'refine' | 'style' | 'model' | 'reference';

const OPTIMIZER_MODES: { id: ModeId; label: string; hint: string }[] = [
  { id: 'expand', label: '扩展想法', hint: '把简短想法补成主体、构图、光线的完整描述' },
  { id: 'refine', label: '精修已有提示词', hint: '去重、规范标点、整理语序' },
  { id: 'style', label: '强化风格', hint: '补风格修饰与常见规避项' },
  { id: 'model', label: '适配模型', hint: '整理成结构化短句，降低解析歧义' },
  { id: 'reference', label: '结合参考', hint: '保留并归集已有引用标记' },
];

interface OptimizeResult {
  positive: string;
  negative: string;
  changes: string[];
  assumptions: string[];
  alternatives: string[];
  source: 'model' | 'template';
  sourceDetail: string;
}

/** 本机模板改写：不联网、按所选方式做确定性文本整理，如实标注来源 */
function templateRewrite(mode: ModeId, value: string): OptimizeResult {
  const parts = value.split(/[\n,，;；]+/).map((x) => x.trim()).filter(Boolean);
  const base = parts.join('，');
  let positive = base;
  let negative = '';
  const changes: string[] = [];
  const assumptions: string[] = [];
  const alternatives: string[] = [];

  if (mode === 'expand') {
    positive = [base, '主体清晰', '构图明确（景别与视角）', '光线与色彩统一', '细节与质感到位'].filter(Boolean).join('；');
    negative = '画面杂乱、主体不明确、光线冲突';
    changes.push('按主体 / 构图 / 光线 / 细节四个维度补齐了描述骨架');
    assumptions.push('保留原有描述，不新增未提供的具体对象');
    alternatives.push(`${base}；电影感，浅景深，柔和自然光`);
  } else if (mode === 'refine') {
    const uniq = [...new Set(parts)];
    positive = uniq.join('，');
    negative = '重复描述、矛盾修饰、多余标点';
    changes.push(`合并了 ${Math.max(0, parts.length - uniq.length)} 处重复短语，统一了分隔符`);
    assumptions.push('只做确定性整理，不改变原意');
    alternatives.push(`${uniq.join('，')}；画面干净，重点突出`);
  } else if (mode === 'style') {
    positive = `${base}；统一的视觉风格，光影层次分明，色调一致`;
    negative = '低清晰度、水印、多余文字、肢体变形、风格跳变';
    changes.push('追加了风格一致性与光影约束，补齐常见规避项');
    assumptions.push('风格词是通用修饰，可按实际需要删改');
    alternatives.push(`${base}；写实摄影，柔和侧光，低饱和`);
  } else if (mode === 'model') {
    positive = parts.map((p, i) => `${i + 1}. ${p}`).join('\n');
    negative = '长句、歧义指代、与画面无关的说明';
    changes.push('把提示词整理成逐条短句，降低模型解析歧义');
    assumptions.push('编号只是整理顺序，不代表镜头顺序');
    alternatives.push(parts.slice().reverse().join('，'));
  } else {
    const refs = [...value.matchAll(/@\[[^\]\n]+\]/g)].map((m) => m[0]);
    const body = value.replace(/@\[[^\]\n]+\]/g, '').replace(/[ \t]{2,}/g, ' ').trim();
    positive = [body, refs.join(' ')].filter(Boolean).join('\n');
    negative = '引用来源缺失、指代不清';
    changes.push(`把 ${refs.length} 个引用标记归集到末尾，正文与引用分离`);
    assumptions.push('引用按 nodeId 解析内容，不复制原文');
    alternatives.push(body);
  }

  return {
    positive, negative, changes, assumptions, alternatives,
    source: 'template',
    sourceDetail: '本机模板改写，没有调用大模型',
  };
}

/** 有真实文本渠道时按 chat/completions 发一次请求，要求模型返回结构化 JSON */
async function callModel(channel: TextChannel, mode: ModeId, value: string, appName: string, signal: AbortSignal): Promise<OptimizeResult> {
  const info = OPTIMIZER_MODES.find((m) => m.id === mode)!;
  const url = `${channel.service.baseUrl.replace(/\/+$/, '')}${channel.endpoint}`;
  const system = [
    `你在「${appName}」的提示词优化器里工作。只输出 JSON，不要输出解释文字。`,
    '输出格式：{"positive":"正向提示词","negative":"规避项","changes":["修改说明"],"assumptions":["假设"],"alternatives":["备选版本"]}',
    'changes / assumptions / alternatives 必须是字符串数组。不要编造未提供的对象，缺失信息写进 assumptions。',
    `优化方式：${info.label}。${info.hint}`,
  ].join('\n');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${channel.service.apiKey}` },
    body: JSON.stringify({
      model: channel.modelId,
      messages: [{ role: 'system', content: system }, { role: 'user', content: `原提示词：\n${value || '（空）'}` }],
      temperature: 0.4,
    }),
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json() as { choices?: { message?: { content?: string } }[] };
  const raw = data.choices?.[0]?.message?.content ?? '';
  const json = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '')) as Record<string, unknown>;
  const toList = (v: unknown): string[] => Array.isArray(v)
    ? v.map(String)
    : typeof v === 'string' && v.trim() ? [v] : [];
  return {
    positive: String(json.positive ?? ''),
    negative: String(json.negative ?? ''),
    changes: toList(json.changes),
    assumptions: toList(json.assumptions),
    alternatives: toList(json.alternatives),
    source: 'model',
    sourceDetail: `${channel.service.name} / ${channel.modelId} · ${channel.label}`,
  };
}

function ResultSection({ title, body, items, testid, mono }: {
  title: string; body?: string; items?: string[]; testid: string; mono?: boolean;
}) {
  return (
    <section className="pt-result-sec">
      <h4>{title}</h4>
      {body !== undefined ? (
        <pre className={mono ? 'pt-mono' : ''} data-testid={`wb-prompt-optimizer-${testid}`}>{body || '（无）'}</pre>
      ) : items && items.length ? (
        <ul data-testid={`wb-prompt-optimizer-${testid}`}>{items.map((x, i) => <li key={i}>{x}</li>)}</ul>
      ) : (
        <p className="pt-dim" data-testid={`wb-prompt-optimizer-${testid}`}>（无）</p>
      )}
    </section>
  );
}

function ResultView({ r }: { r: OptimizeResult }) {
  return (
    <div className="pt-result" data-testid="wb-prompt-optimizer-result">
      <div className={`pt-source ${r.source === 'template' ? 'pt-source-tpl' : 'pt-source-model'}`} data-testid="wb-prompt-optimizer-source">
        {r.source === 'template' ? '本机模板改写，没有调用大模型' : `文本模型生成 · ${r.sourceDetail}`}
      </div>
      <ResultSection title="正向提示词" body={r.positive} testid="positive" mono />
      <ResultSection title="规避项" body={r.negative} testid="negative" />
      <ResultSection title="修改说明" items={r.changes} testid="changes" />
      <ResultSection title="假设" items={r.assumptions} testid="assumptions" />
      <ResultSection title="备选版本" items={r.alternatives} testid="alternatives" mono />
    </div>
  );
}

export interface PromptOptimizerProps {
  nodeId: string;
  value: string;
  onChange: (v: string) => void;
  onClose: () => void;
  onNotice: (msg: string) => void;
}

export function PromptOptimizer({ nodeId, value, onChange, onClose, onNotice }: PromptOptimizerProps) {
  const settings = useCanvas((s) => s.settings);
  const channel = firstTextService(settings);
  const appName = config().workspace.appName;
  const nodeName = useCanvas.getState().nodes.find((n) => n.id === nodeId)?.name || '当前节点';

  const [mode, setMode] = useState<ModeId>('expand');
  const [extra, setExtra] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<OptimizeResult | null>(null);
  const [error, setError] = useState('');
  const controllerRef = useRef<AbortController | null>(null);

  // 抽屉可拖动、可边缘调整尺寸
  const [frame, setFrame] = useState(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = Math.min(460, vw - 48);
    const h = Math.min(680, vh - 48);
    return { x: vw - w - 24, y: 24, w, h };
  });

  const onHeadDown = (e: ReactPointerEvent) => {
    const start = { ...frame };
    beginDrag(e, (dx, dy) => setFrame({ ...start, x: Math.max(0, start.x + dx), y: Math.max(0, start.y + dy) }));
  };
  const onLeftDown = (e: ReactPointerEvent) => {
    const start = { ...frame };
    const right = start.x + start.w;
    beginDrag(e, (dx) => {
      const x = Math.max(0, Math.min(right - 320, start.x + dx));
      setFrame({ ...start, x, w: right - x });
    });
  };
  const onCornerDown = (e: ReactPointerEvent) => {
    const start = { ...frame };
    beginDrag(e, (dx, dy) => setFrame({
      ...start, w: Math.max(320, start.w + dx), h: Math.max(320, start.h + dy),
    }));
  };

  const run = async () => {
    if (busy) return;
    setError('');
    setResult(null);
    const fresh = firstTextService(useCanvas.getState().settings);
    const controller = new AbortController();
    controllerRef.current = controller;
    setBusy(true);
    const source = extra.trim() ? `${value}\n补充：${extra.trim()}` : value;
    try {
      let out: OptimizeResult;
      if (fresh) {
        // 取消（controller）与 15s 超时（AbortSignal.timeout）合并成一个信号
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
        out = await callModel(fresh, mode, source, appName, signal);
      } else {
        out = templateRewrite(mode, value);
      }
      if (controller.signal.aborted) return; // 用户中途取消
      setResult(out);
      onNotice(out.source === 'model' ? '已由文本模型生成优化结果' : '本机模板改写，没有调用大模型');
    } catch (err) {
      if (controller.signal.aborted) {
        onNotice('已取消本次优化');
        return;
      }
      // 失败如实回落本机模板，绝不伪装成 AI 结果，也不覆盖原提示词
      setResult(templateRewrite(mode, value));
      setError(`文本模型调用失败（${err instanceof Error ? err.message : String(err)}），已回落本机模板改写`);
      onNotice('文本模型不可用，已回落本机模板改写，没有调用大模型');
    } finally {
      controllerRef.current = null;
      setBusy(false);
    }
  };

  const cancel = () => { controllerRef.current?.abort(); };

  const adopt = () => {
    if (!result || !result.positive.trim()) { onNotice('结果为空，未覆盖原提示词'); return; }
    onChange(result.positive);
    onNotice('已采用优化后的正向提示词');
    onClose();
  };

  const close = () => { controllerRef.current?.abort(); onClose(); };

  return (
    <div
      className="pt-optimizer"
      style={{ left: frame.x, top: frame.y, width: frame.w, height: frame.h }}
      data-testid="wb-prompt-optimizer"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="dialog-head pt-optimizer-head" onPointerDown={onHeadDown} data-testid="wb-prompt-optimizer-head">
        <h3><Icon name="sparkles" size={16} /> 提示词优化 · <span className="pt-dim">{nodeName}</span></h3>
        <button className="mini-btn" onClick={close} aria-label="关闭" data-testid="wb-prompt-optimizer-close">
          <Icon name="close" size={14} />
        </button>
      </div>

      <div className="pt-optimizer-status" data-testid="wb-prompt-optimizer-status">
        {channel
          ? <>已配置文本模型：<strong>{channel.service.name} / {channel.modelId}</strong></>
          : <>未配置可用的文本模型渠道，将使用<strong>本机模板改写，没有调用大模型</strong></>}
      </div>

      <div className="pt-chat">
        <div className="pt-msg pt-msg-sys">
          选择一种优化方式后点「生成」。{channel ? '有文本渠道时优先调用大模型；' : ''}失败或未配置一律如实回落本机模板，只有点「采用」才会回填。
        </div>
        <div className="pt-msg pt-msg-user">原提示词：{value.trim() ? value.slice(0, 160) : '（空）'}</div>
        {result && <div className="pt-msg pt-msg-bot"><ResultView r={result} /></div>}
        {error && <div className="pt-error" data-testid="wb-prompt-optimizer-error">{error}</div>}
      </div>

      <div className="pt-optimizer-composer">
        <div className="pt-modes">
          {OPTIMIZER_MODES.map((m) => (
            <button
              key={m.id}
              className={`mini-btn pt-mode ${mode === m.id ? 'active' : ''}`}
              onClick={() => setMode(m.id)}
              title={m.hint}
              data-testid={`wb-prompt-optimizer-mode-${m.id}`}
            >{m.label}</button>
          ))}
        </div>
        <input
          className="dialog-input pt-composer-input"
          value={extra}
          onChange={(e) => setExtra(e.target.value)}
          placeholder="补充说明（可选），例如想要的风格或约束…"
          data-testid="wb-prompt-optimizer-input"
        />
        <div className="pt-composer-actions">
          {busy ? (
            <button className="ghost-btn" onClick={cancel} data-testid="wb-prompt-optimizer-cancel">取消</button>
          ) : (
            <button className="primary-btn" onClick={run} data-testid="wb-prompt-optimizer-run">
              <Icon name="sparkles" size={14} /> 生成
            </button>
          )}
          {result && (
            <button className="primary-btn" onClick={adopt} data-testid="wb-prompt-optimizer-adopt">
              <Icon name="check" size={14} /> 采用
            </button>
          )}
          <span className="pt-dim">{busy ? '正在请求…可取消' : `${OPTIMIZER_MODES.find((m) => m.id === mode)?.label ?? ''} · 超时 15s`}</span>
        </div>
      </div>

      <div className="pt-optimizer-resize-left" onPointerDown={onLeftDown} title="拖动改宽度" data-testid="wb-prompt-optimizer-resize-left" />
      <div className="pt-optimizer-resize-corner" onPointerDown={onCornerDown} title="拖动改尺寸" data-testid="wb-prompt-optimizer-resize-corner">
        <Icon name="more" size={11} />
      </div>
    </div>
  );
}

/* ==================== 4. 提示词模板目录与用户偏好 ==================== */

export interface PromptTemplatesPanelProps {
  onNotice: (msg: string) => void;
}

export function PromptTemplatesPanel({ onNotice }: PromptTemplatesPanelProps) {
  const settings = useCanvas((s) => s.settings);
  const prefs = workbenchOf(settings).promptPrefs;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const copy = async (op: PromptOperation) => {
    // append 是「追加到所有操作的创作层」，复制时一并带上
    const text = [op.template, prefs.append.trim()].filter(Boolean).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      onNotice(`已复制「${op.label}」模板`);
    } catch {
      onNotice('复制失败：浏览器未授权剪贴板，请手动选择文本');
    }
  };

  const setFollow = (v: boolean) => {
    patchSection('promptPrefs', { followOfficial: v });
    onNotice(v ? '已跟随官方操作模板' : '已关闭跟随官方操作模板');
  };
  const setAppend = (v: string) => { patchSection('promptPrefs', { append: v }); };

  return (
    <div className="pt-templates" data-testid="wb-prompt-templates">
      <div className="pt-templates-head">
        <h3><Icon name="script" size={15} /> 提示词操作目录</h3>
        <span className="pt-dim">{PROMPT_OPERATIONS.length} 个内置操作 · 模板只读</span>
      </div>

      <div className="pt-templates-list">
        {PROMPT_OPERATIONS.length === 0 && <div className="list-empty">没有可用的操作模板</div>}
        {PROMPT_OPERATIONS.map((op) => {
          const open = expanded.has(op.id);
          return (
            <div className={`pt-tpl-item ${open ? 'open' : ''}`} key={op.id} data-testid={`wb-prompt-templates-item-${op.id}`}>
              <div className="pt-tpl-row">
                <button className="pt-tpl-main" onClick={() => toggleExpand(op.id)} data-testid={`wb-prompt-templates-expand-${op.id}`}>
                  <Icon name={open ? 'chevronDown' : 'file'} size={13} />
                  <span className="pt-tpl-label">{op.label}</span>
                  <span className="pt-dim pt-tpl-summary">{op.summary}</span>
                </button>
                <button className="mini-btn" onClick={() => copy(op)} data-testid={`wb-prompt-templates-copy-${op.id}`}>
                  <Icon name="copy" size={12} /> 复制
                </button>
              </div>
              <div className="pt-dim pt-tpl-abstract">模板摘要：{op.template.slice(0, 46)}{op.template.length > 46 ? '…' : ''}</div>
              {open && <pre className="pt-mono pt-tpl-full" data-testid={`wb-prompt-templates-full-${op.id}`}>{op.template}</pre>}
            </div>
          );
        })}
      </div>

      <div className="pt-templates-prefs">
        <h4>用户偏好</h4>
        <label className="check-row" data-testid="wb-prompt-templates-follow-row">
          <input type="checkbox" checked={prefs.followOfficial} onChange={(e) => setFollow(e.target.checked)} data-testid="wb-prompt-templates-follow" />
          <span>followOfficial · 跟随官方操作模板</span>
        </label>
        <label className="settings-field">
          <span>append · 追加到所有操作的创作层（复制模板时一并带上）</span>
          <textarea rows={3} value={prefs.append} onChange={(e) => setAppend(e.target.value)} placeholder="每次使用操作模板时追加的创作层文字…" data-testid="wb-prompt-templates-append" />
        </label>
        <div className="settings-note pt-tpl-contract" data-testid="wb-prompt-templates-contract">
          <Icon name="info" size={14} />
          <div>
            <strong>protectedContract（只读，不可覆盖）</strong>
            <p>动态上下文与 JSON 输出契约由工具注入，用户偏好不能覆盖。</p>
            <pre className="pt-mono">{prefs.protectedContract}</pre>
          </div>
        </div>
      </div>
    </div>
  );
}
