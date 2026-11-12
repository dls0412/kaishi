import './styles.css';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import JSZip from 'jszip';
import pkg from '../../../package.json';
import { useCanvas } from '../../store';
import {
  listSnapshots,
  saveSnapshot,
  restoreSnapshot,
  listEvents,
  clearEvents,
  diagnosticsPreview,
  buildDiagnosticsBundle,
  config,
  patchSection,
  type CanvasSnapshot,
  type WorkbenchEvent,
  type DiagnosticsPreview,
} from '../../lib/workbenchRuntime';
import { downloadBlob, formatBytes } from '../../lib/utils';
import Icon from '../../components/Icon';
import type { NoticeFn } from '../notice';

const APP_VERSION: string = (pkg as { version?: string }).version ?? '本机';

const TYPE_LABEL: Record<string, string> = {
  text: '文本', image: '图片', video: '视频', audio: '音频', group: '分组',
};

const DESENSITIZE_RULES = [
  'API Key', 'Cookie', '完整 URL', '查询参数', '请求体', '提示词正文', '媒体地址',
];

/** 本模块写入的「只读预览缓存」键前缀，诊断面板的「清理预览缓存」负责清除 */
const DT_PREVIEW_CACHE_PREFIX = 'icw:datatools:preview:';

function clampInt(value: number, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

interface ConfirmCardProps {
  testid: string;
  message: string;
  detail?: ReactNode;
  confirmText?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

function ConfirmCard({ testid, message, detail, confirmText = '确认', danger, onConfirm, onCancel }: ConfirmCardProps) {
  return (
    <div className={`dt-confirm ${danger ? 'danger' : ''}`} data-testid={testid}>
      <p className="dt-confirm-msg">{message}</p>
      {detail && <div className="dt-confirm-detail">{detail}</div>}
      <div className="dt-confirm-actions">
        <button className="ghost-btn" onClick={onCancel} data-testid="wb-data-confirm-cancel">取消</button>
        <button className={`primary-btn ${danger ? 'danger' : ''}`} onClick={onConfirm} data-testid="wb-data-confirm-ok">{confirmText}</button>
      </div>
    </div>
  );
}

/* ==================== 1. 版本记录 ==================== */

export function VersionHistoryPanel({ onNotice }: { onNotice: NoticeFn }) {
  const [snapshots, setSnapshots] = useState<CanvasSnapshot[]>(() => listSnapshots());
  const [preview, setPreview] = useState<CanvasSnapshot | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<CanvasSnapshot | null>(null);
  const [intervalMin, setIntervalMin] = useState(() => config().workspace.snapshotIntervalMin);
  const [limit, setLimit] = useState(() => config().workspace.snapshotLimit);

  const refresh = useCallback(() => setSnapshots(listSnapshots()), []);

  const groups = useMemo(() => {
    const sorted = [...snapshots].sort((a, b) => b.at - a.at);
    const map = new Map<string, CanvasSnapshot[]>();
    sorted.forEach((s) => {
      const key = new Date(s.at).toLocaleDateString('zh-CN');
      const list = map.get(key);
      if (list) list.push(s);
      else map.set(key, [s]);
    });
    // 已按时间倒序插入：Map 的键顺序即日期倒序，组内同样保持最新在前
    return [...map.entries()];
  }, [snapshots]);

  const changeInterval = (value: number) => {
    const next = clampInt(value, 1, 60, intervalMin);
    setIntervalMin(next);
    patchSection('workspace', { snapshotIntervalMin: next });
  };
  const changeLimit = (value: number) => {
    const next = clampInt(value, 5, 100, limit);
    setLimit(next);
    patchSection('workspace', { snapshotLimit: next });
  };

  const createNow = () => {
    saveSnapshot('手动快照', true);
    refresh();
    onNotice('已创建手动快照', 'ok');
  };

  const openPreview = (s: CanvasSnapshot) => {
    try {
      localStorage.setItem(DT_PREVIEW_CACHE_PREFIX + s.id, JSON.stringify({
        at: Date.now(), label: s.label, nodeCount: s.nodeCount, edgeCount: s.edgeCount,
      }));
    } catch { /* 配额不足时忽略预览缓存 */ }
    setPreview(s);
  };

  const downloadVersion = (s: CanvasSnapshot) => {
    const blob = new Blob([JSON.stringify(s, null, 2)], { type: 'application/json' });
    downloadBlob(blob, `snapshot-${s.id}.json`);
    onNotice('已下载该版本 JSON', 'ok');
  };

  const doRestore = () => {
    if (!restoreTarget) return;
    const ok = restoreSnapshot(restoreTarget.id);
    setRestoreTarget(null);
    refresh();
    onNotice(ok ? '已恢复版本；恢复前已自动备份当前内容' : '未找到该版本，恢复未执行', ok ? 'ok' : 'err');
  };

  return (
    <div className="dt-panel" data-testid="wb-data-version-history">
      <div className="settings-section">
        <div className="section-title">
          <Icon name="layers" size={16} />
          <div>
            <h4>快照配置</h4>
            <p>仅保存在本机浏览器，不联网</p>
          </div>
        </div>
        <label className="settings-field">
          <span>快照最短间隔（分钟，1–60）<em>{intervalMin}</em></span>
          <input type="number" min={1} max={60} value={intervalMin}
            onChange={(e) => changeInterval(e.target.valueAsNumber)}
            data-testid="wb-data-version-interval" />
        </label>
        <label className="settings-field">
          <span>保留上限（5–100）<em>{limit}</em></span>
          <input type="number" min={5} max={100} value={limit}
            onChange={(e) => changeLimit(e.target.valueAsNumber)}
            data-testid="wb-data-version-limit" />
        </label>
        <div className="settings-note">
          <Icon name="info" size={14} />
          <span>本机快照只保存画布结构和媒体引用，不复制视频文件；不提供多人实时协同。</span>
        </div>
      </div>

      <div className="settings-section">
        <div className="section-title">
          <Icon name="database" size={16} />
          <div>
            <h4>版本记录</h4>
            <p>按日期倒序，共 {snapshots.length} 个版本</p>
          </div>
          <button className="primary-btn dt-title-action" onClick={createNow} data-testid="wb-data-version-create">立即创建快照</button>
        </div>

        {restoreTarget && (
          <ConfirmCard
            testid="wb-data-version-restore-confirm"
            message={`确认恢复版本「${restoreTarget.label}」？`}
            detail="恢复会用该版本替换当前画布内容，操作前会自动为当前内容创建一份备份快照。"
            confirmText="恢复此版本"
            danger
            onConfirm={doRestore}
            onCancel={() => setRestoreTarget(null)}
          />
        )}

        {groups.length === 0 ? (
          <div className="list-empty" data-testid="wb-data-version-empty">暂无版本快照。可点击「立即创建快照」保存当前画布。</div>
        ) : (
          <div className="dt-groups">
            {groups.map(([date, list]) => (
              <div className="dt-group" key={date} data-testid="wb-data-version-group">
                <div className="dt-group-date">{date}</div>
                <div className="dt-version-list">
                  {list.map((s) => (
                    <div className="dt-version-row" key={s.id} data-testid="wb-data-version-row">
                      <div className="dt-version-main">
                        <span className="dt-version-time">{new Date(s.at).toLocaleTimeString('zh-CN', { hour12: false })}</span>
                        <span className="dt-version-label">{s.label}</span>
                      </div>
                      <div className="dt-version-meta">{s.nodeCount} 节点 · {s.edgeCount} 连线</div>
                      <div className="dt-version-actions">
                        <button className="mini-btn" onClick={() => openPreview(s)} data-testid="wb-data-version-preview-btn">只读预览</button>
                        <button className="mini-btn" onClick={() => setRestoreTarget(s)} data-testid="wb-data-version-restore-btn">恢复此版本</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {preview && (
        <div className="dt-overlay" data-testid="wb-data-version-preview" onClick={() => setPreview(null)}>
          <div className="dt-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="dt-dialog-head">
              <h4>只读版本预览</h4>
              <button className="mini-btn" onClick={() => setPreview(null)} data-testid="wb-data-version-preview-close">关闭</button>
            </div>
            <div className="dt-dialog-body">
              <div className="dt-preview-meta">
                <span>{preview.label}</span>
                <span>{new Date(preview.at).toLocaleString('zh-CN', { hour12: false })}</span>
                <span>{preview.nodeCount} 节点 · {preview.edgeCount} 连线</span>
              </div>
              <p className="dt-preview-hint">简化缩略列表（名称 · 类型 · 坐标），不渲染真实画布。</p>
              {preview.nodes.length ? (
                <ul className="dt-thumb-list" data-testid="wb-data-version-thumb-list">
                  {preview.nodes.map((n) => (
                    <li key={n.id}>
                      <span className="dt-thumb-name">{n.name || '未命名'}</span>
                      <span className="dt-thumb-type">{TYPE_LABEL[n.type] ?? n.type}</span>
                      <span className="dt-thumb-pos">({Math.round(n.x)}, {Math.round(n.y)})</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="list-empty compact">该版本没有节点。</div>
              )}
            </div>
            <div className="dt-dialog-foot">
              <button className="primary-btn" onClick={() => downloadVersion(preview)} data-testid="wb-data-version-download">下载该版本 JSON</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ==================== 2. 诊断 ==================== */

export function DiagnosticsPanel({ onNotice }: { onNotice: NoticeFn }) {
  const [events, setEvents] = useState<WorkbenchEvent[]>(() => listEvents());
  const [info, setInfo] = useState<DiagnosticsPreview>(() => diagnosticsPreview());
  const [exportBundle, setExportBundle] = useState<ReturnType<typeof buildDiagnosticsBundle> | null>(null);
  const [clearEventsConfirm, setClearEventsConfirm] = useState(false);
  const [clearCacheConfirm, setClearCacheConfirm] = useState(false);

  const refresh = useCallback(() => {
    setEvents(listEvents());
    setInfo(diagnosticsPreview());
  }, []);

  const rangeText = info.count
    ? `${new Date(info.since).toLocaleString('zh-CN', { hour12: false })} ~ ${new Date(info.until).toLocaleString('zh-CN', { hour12: false })}`
    : '暂无事件';

  const doExport = async () => {
    if (!exportBundle) return;
    const zip = new JSZip();
    Object.entries(exportBundle.files).forEach(([name, content]) => zip.file(name, content));
    const blob = await zip.generateAsync({ type: 'blob' });
    downloadBlob(blob, `diagnostics-${Date.now()}.zip`);
    setExportBundle(null);
    onNotice('诊断包已导出', 'ok');
  };

  const copyInfo = async () => {
    const text = [
      `${config().workspace.appName} v${APP_VERSION}`,
      `时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
      `事件数：${info.count}`,
    ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      onNotice('排查信息已复制到剪贴板', 'ok');
    } catch {
      onNotice('复制失败，请检查浏览器剪贴板权限', 'err');
    }
  };

  const doClearEvents = () => {
    clearEvents();
    setClearEventsConfirm(false);
    refresh();
    onNotice('已清空本机事件', 'ok');
  };

  const doClearCache = () => {
    const keys = Object.keys(localStorage).filter((k) => k.startsWith(DT_PREVIEW_CACHE_PREFIX));
    keys.forEach((k) => localStorage.removeItem(k));
    setClearCacheConfirm(false);
    onNotice(`已清理 ${keys.length} 项预览缓存`, 'ok');
  };

  const recent = events.slice(-10).reverse();

  return (
    <div className="dt-panel" data-testid="wb-data-diagnostics">
      <div className="settings-section">
        <div className="section-title">
          <Icon name="script" size={16} />
          <div>
            <h4>脱敏诊断包</h4>
            <p>本机事件环形缓冲，24 小时 / 500 条上限</p>
          </div>
        </div>

        <div className="dt-diag-stats">
          <div className="dt-stat"><span className="dt-stat-label">事件数</span><span className="dt-stat-value">{info.count} 条</span></div>
          <div className="dt-stat"><span className="dt-stat-label">事件字节</span><span className="dt-stat-value">{formatBytes(info.bytes)}</span></div>
          <div className="dt-stat"><span className="dt-stat-label">时间范围</span><span className="dt-stat-value">{rangeText}</span></div>
        </div>

        <p className="dt-diag-note" data-testid="wb-data-diag-note">诊断包已脱敏，导出内容与排查信息均不含：</p>
        <div className="dt-rules" data-testid="wb-data-diag-rules">
          {DESENSITIZE_RULES.map((r) => (
            <label className="check-row" key={r}>
              <input type="checkbox" checked readOnly disabled />
              <span>不含 {r}</span>
            </label>
          ))}
        </div>

        <div className="dt-actions">
          <button className="primary-btn" onClick={() => setExportBundle(buildDiagnosticsBundle())} data-testid="wb-data-diag-export">导出诊断包</button>
          <button className="ghost-btn" onClick={copyInfo} data-testid="wb-data-diag-copy">复制排查信息</button>
          <button className="ghost-btn" onClick={() => setClearEventsConfirm(true)} data-testid="wb-data-diag-clear-events">清空事件</button>
          <button className="ghost-btn" onClick={() => setClearCacheConfirm(true)} data-testid="wb-data-diag-clear-cache">清理预览缓存</button>
        </div>

        {exportBundle && (
          <ConfirmCard
            testid="wb-data-diag-export-confirm"
            message="确认导出诊断包？下载前请核对数据量与文件清单。"
            confirmText="导出并下载"
            onConfirm={() => { void doExport(); }}
            onCancel={() => setExportBundle(null)}
            detail={
              <div className="dt-export-preview">
                <div className="dt-export-stats">
                  <span>事件数：{info.count}</span>
                  <span>事件字节：{formatBytes(info.bytes)}</span>
                  <span>时间范围：{rangeText}</span>
                </div>
                <div className="dt-file-list">
                  <div className="dt-file-list-title">文件清单（{Object.keys(exportBundle.files).length}）</div>
                  <ul>
                    {Object.entries(exportBundle.files).map(([name, content]) => (
                      <li key={name}>{name} · {formatBytes(new Blob([content]).size)}</li>
                    ))}
                  </ul>
                </div>
              </div>
            }
          />
        )}

        {clearEventsConfirm && (
          <ConfirmCard
            testid="wb-data-diag-clear-events-confirm"
            message="确认清空全部本机事件？该操作不可撤销。"
            confirmText="清空事件"
            danger
            onConfirm={doClearEvents}
            onCancel={() => setClearEventsConfirm(false)}
          />
        )}

        {clearCacheConfirm && (
          <ConfirmCard
            testid="wb-data-diag-clear-cache-confirm"
            message="确认清理只读预览缓存？仅清除本模块写入的预览缓存键。"
            confirmText="清理缓存"
            onConfirm={doClearCache}
            onCancel={() => setClearCacheConfirm(false)}
          />
        )}
      </div>

      <div className="settings-section">
        <div className="section-title">
          <Icon name="info" size={16} />
          <div>
            <h4>最近 10 条事件</h4>
            <p>仅显示 kind / 时间 / message</p>
          </div>
        </div>
        {recent.length ? (
          <div className="dt-event-list" data-testid="wb-data-diag-events">
            {recent.map((e) => (
              <div className="dt-event-row" key={e.id} data-testid="wb-data-diag-event">
                <span className="dt-event-kind">{e.kind}</span>
                <span className="dt-event-time">{new Date(e.at).toLocaleTimeString('zh-CN', { hour12: false })}</span>
                <span className="dt-event-msg">{e.message}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="list-empty" data-testid="wb-data-diag-events-empty">暂无事件。</div>
        )}
      </div>
    </div>
  );
}

/* ==================== 3. 容量 ==================== */

interface StorageMeterProps {
  compact?: boolean;
  onNotice?: NoticeFn;
}

export function StorageMeter({ compact = false, onNotice }: StorageMeterProps) {
  const [usage, setUsage] = useState(0);
  const [quota, setQuota] = useState(0);
  const [estimated, setEstimated] = useState(false);
  const [quotaMB, setQuotaMB] = useState(() => config().workspace.storageQuotaMB);

  useEffect(() => {
    let active = true;
    const run = async () => {
      try {
        if (navigator.storage && typeof navigator.storage.estimate === 'function') {
          const est = await navigator.storage.estimate();
          if (active && typeof est.usage === 'number' && typeof est.quota === 'number' && est.quota > 0) {
            setUsage(est.usage);
            setQuota(est.quota);
            setEstimated(false);
            return;
          }
        }
      } catch { /* 回落到按素材数估算 */ }
      if (!active) return;
      const count = useCanvas.getState().assets.length;
      const approx = count * 4 * 1024 * 1024;
      setUsage(approx);
      setQuota(Math.max(approx * 2, 64 * 1024 * 1024));
      setEstimated(true);
    };
    void run();
    return () => { active = false; };
  }, []);

  const configuredBytes = quotaMB > 0 ? quotaMB * 1024 * 1024 : 0;
  const cap = configuredBytes > 0 ? configuredBytes : quota;
  const ratio = cap > 0 ? usage / cap : 0;
  const pct = Math.min(100, Math.round(ratio * 100));
  const level = ratio >= 0.9 ? 'danger' : ratio >= 0.7 ? 'warn' : 'ok';
  const quotaLabel = configuredBytes > 0 ? `${quotaMB} MB（配置上限）` : `${formatBytes(quota)}（浏览器配额）`;
  const estimateNote = estimated ? ' · 浏览器未提供用量，按素材数估算' : '';
  const title = `本机容量 ${pct}% · 已用 ${formatBytes(usage)} / ${quotaLabel}${estimateNote} · 点击进入素材库`;

  const handleClick = () => onNotice?.('进入素材库可查看与管理本机素材', 'info');

  const changeQuota = (value: number) => {
    const next = clampInt(value, 0, 4096, quotaMB);
    setQuotaMB(next);
    patchSection('workspace', { storageQuotaMB: next });
  };

  if (compact) {
    return (
      <div className={`dt-compact ${level}`} data-testid="wb-data-storage-meter" role="button" tabIndex={0}
        title={title} onClick={handleClick}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleClick(); }}>
        <Icon name="database" size={14} />
        <div className="dt-compact-track">
          <div className={`dt-compact-fill ${level}`} style={{ width: `${pct}%` }} />
        </div>
      </div>
    );
  }

  return (
    <div className="dt-panel dt-meter" data-testid="wb-data-storage-meter">
      <div className="dt-meter-click" role="button" tabIndex={0} title={title} onClick={handleClick}
        data-testid="wb-data-storage-meter-click"
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleClick(); }}>
        <div className="dt-meter-head">
          <Icon name="database" size={16} />
          <span>本机容量</span>
          <span className="dt-meter-pct">{pct}%</span>
        </div>
        <div className="dt-meter-track">
          <div className={`dt-meter-fill ${level}`} style={{ width: `${pct}%` }} />
        </div>
        <div className="dt-meter-line">已用 {formatBytes(usage)} / 上限 {quotaLabel}</div>
      </div>

      {estimated && (
        <div className="settings-note dt-meter-note">
          <Icon name="info" size={14} />
          <span>浏览器未提供用量，按素材数估算</span>
        </div>
      )}

      <label className="settings-field dt-meter-field">
        <span>容量上限（MB，0 表示不限制）<em>{quotaMB}</em></span>
        <input type="number" min={0} max={4096} value={quotaMB}
          onChange={(e) => changeQuota(e.target.valueAsNumber)}
          data-testid="wb-data-storage-quota" />
      </label>

      <div className="settings-note dt-meter-note">
        <Icon name="info" size={14} />
        <span>容量按本机浏览器存储估算，不接任何账号体系。</span>
      </div>
    </div>
  );
}

/* ==================== 4. 手动保存菜单 ==================== */

export function ManualSaveMenu({ onClose, onNotice }: { onClose: () => void; onNotice: NoticeFn }) {
  const ref = useRef<HTMLDivElement>(null);
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [onClose]);

  const doSave = () => {
    void useCanvas.getState().persist();
    onNotice('已写入本机', 'ok');
    onClose();
  };

  const doForceSave = () => {
    saveSnapshot('强制覆盖前备份', true);
    void useCanvas.getState().persist();
    onNotice('已以本地画布为准重写本机镜像', 'ok');
    onClose();
  };

  const viewVersions = () => {
    onNotice('请在 工作台设置 · 版本记录 中查看', 'info');
    onClose();
  };

  return (
    <div className="dt-dropdown" ref={ref} data-testid="wb-data-manual-save-menu">
      {confirm ? (
        <div className="dt-dropdown-confirm" data-testid="wb-data-manual-save-confirm">
          <div className="dt-dropdown-confirm-title">强制覆盖保存</div>
          <p className="dt-dropdown-confirm-msg">以本地画布为准重写本机镜像，不会覆盖云端（本工具没有云端）。</p>
          <div className="dt-dropdown-confirm-actions">
            <button className="ghost-btn" onClick={() => setConfirm(false)} data-testid="wb-data-manual-save-cancel">取消</button>
            <button className="primary-btn danger" onClick={doForceSave} data-testid="wb-data-manual-save-force-ok">确认覆盖</button>
          </div>
        </div>
      ) : (
        <div className="dt-dropdown-list">
          <button className="dt-dropdown-item" onClick={doSave} data-testid="wb-data-manual-save-save">
            <Icon name="save" size={15} /><span>保存</span><small>写入本机</small>
          </button>
          <button className="dt-dropdown-item" onClick={() => setConfirm(true)} data-testid="wb-data-manual-save-force">
            <Icon name="refresh" size={15} /><span>强制覆盖保存</span><small>先备份再覆盖</small>
          </button>
          <button className="dt-dropdown-item" onClick={viewVersions} data-testid="wb-data-manual-save-versions">
            <Icon name="layers" size={15} /><span>查看版本记录</span><small>工作台设置</small>
          </button>
        </div>
      )}
    </div>
  );
}
