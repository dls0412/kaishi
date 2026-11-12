import { useEffect, useRef, useState } from 'react';
import { useCanvas } from '../../store';
import {
  applyAppearance, applyBrand, config, logEvent, saveSnapshot,
} from '../../lib/workbenchRuntime';
import Icon from '../../components/Icon';
import { AppearancePanel } from '../canvasTools';
import { PromptTemplatesPanel } from '../promptTools';
import { DiagnosticsPanel, VersionHistoryPanel } from '../dataTools';
import type { NoticeFn } from '../notice';
import './styles.css';

export type { NoticeFn } from '../notice';

interface Section {
  id: string;
  group: string;
  label: string;
  hint: string;
  icon: string;
  render: (notice: NoticeFn) => React.ReactNode;
}

/** 工作台设置：一个入口覆盖完整功能清单，所有外部能力都有独立配置页 */
export const WORKBENCH_SECTIONS: Section[] = [
  { id: 'appearance', group: '画布', label: '画布外观', hint: '主题与网格', icon: 'grid', render: (n) => <AppearancePanel onNotice={n} /> },
  { id: 'prompt', group: '画布', label: '提示词偏好', hint: '创作偏好与模板', icon: 'text', render: (n) => <PromptTemplatesPanel onNotice={n} /> },
  { id: 'versions', group: '数据', label: '版本记录', hint: '查看和恢复画布快照', icon: 'save', render: (n) => <VersionHistoryPanel onNotice={n} /> },
  { id: 'diagnostics', group: '数据', label: '问题诊断', hint: '导出脱敏诊断记录', icon: 'info', render: (n) => <DiagnosticsPanel onNotice={n} /> },
];

/** 顶栏下拉：一个入口进所有工作台能力 */
export function WorkbenchMenu({ onOpen, onWorkflow, onSave }: {
  onOpen: (section?: string) => void;
  onWorkflow: () => void;
  onSave: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // 点击菜单外部或按 Esc 收起，避免下拉常驻挡住顶栏按钮
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="wb-menu-wrap" ref={wrapRef} data-testid="wb-menu-wrap">
      <button className="tb-action wb-menu-trigger" data-testid="open-workbench" onClick={() => setOpen((v) => !v)}>
        <Icon name="layers" size={15} /> 画布
      </button>
      {open && (
        <div className="wb-menu" data-testid="wb-menu">
          <button onClick={() => { setOpen(false); onOpen('appearance'); }}><Icon name="grid" size={14} /> 画布外观</button>
          <button onClick={() => { setOpen(false); onOpen('versions'); }}><Icon name="save" size={14} /> 版本记录</button>
          <button onClick={() => { setOpen(false); onWorkflow(); }}><Icon name="layers" size={14} /> 工作流模板</button>
          <button onClick={() => { setOpen(false); onSave(); }}><Icon name="save" size={14} /> 手动保存</button>
          <button onClick={() => { setOpen(false); onOpen('diagnostics'); }}><Icon name="info" size={14} /> 问题诊断</button>
        </div>
      )}
    </div>
  );
}

export default function WorkbenchSettings({ onClose, onNotice, initialSection = 'appearance' }: {
  onClose: () => void;
  onNotice: NoticeFn;
  initialSection?: string;
}) {
  const [active, setActive] = useState(initialSection);
  const [filter, setFilter] = useState('');
  const groups = [...new Set(WORKBENCH_SECTIONS.map((s) => s.group))];
  const visible = WORKBENCH_SECTIONS.filter((s) => !filter || s.label.includes(filter) || s.hint.includes(filter));
  const current = WORKBENCH_SECTIONS.find((s) => s.id === active) ?? WORKBENCH_SECTIONS[0];

  useEffect(() => {
    applyAppearance();
    applyBrand();
  }, []);

  return (
    <div className="modal-mask" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog wb-dialog" data-testid="workbench-dialog">
        <div className="dialog-head">
          <h3><Icon name="layers" size={17} /> 画布设置</h3>
          <button className="icon-btn small" data-testid="wb-close" onClick={onClose}><Icon name="close" size={16} /></button>
        </div>
        <div className="wb-body">
          <nav className="wb-nav" data-testid="wb-nav">
            <input className="dialog-input wb-nav-search" data-testid="wb-nav-search" placeholder="筛选设置页…" value={filter} onChange={(e) => setFilter(e.target.value)} />
            {groups.map((g) => (
              <div key={g} className="wb-nav-group">
                <div className="wb-nav-label">{g}</div>
                {visible.filter((s) => s.group === g).map((s) => (
                  <button key={s.id} data-testid={`wb-nav-${s.id}`} className={active === s.id ? 'active' : ''} onClick={() => setActive(s.id)}>
                    <Icon name={s.icon} size={14} /><span>{s.label}</span>
                  </button>
                ))}
              </div>
            ))}
          </nav>
          <div className="wb-content" data-testid={`wb-section-${current.id}`} key={current.id}>
            <div className="wb-content-head">
              <div><h4>{current.label}</h4><p>{current.hint}</p></div>

            </div>
            {current.render(onNotice)}
          </div>
        </div>
        <div className="dialog-foot">
          <span className="wb-foot-note">开视 · 本地创作工作区</span>
          <button className="ghost-btn" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}

/** 供 App 启动时调用：把外观与品牌应用到页面，并挂自动快照与事件记录 */
export function installWorkbenchRuntime(): () => void {
  applyAppearance();
  applyBrand();
  const cfg = config();
  const timer = window.setInterval(() => {
    const st = useCanvas.getState();
    if (!st.ready) return;
    try { saveSnapshot('自动快照'); } catch { /* 快照失败不影响画布 */ }
  }, Math.max(1, cfg.workspace.snapshotIntervalMin) * 60 * 1000);
  const unsub = useCanvas.subscribe((state, prev) => {
    if (state.nodes !== prev.nodes || state.edges !== prev.edges) {
      // 只记录数量与动作，不记录节点正文
      logEvent('canvas', '画布结构变化', `${state.nodes.length} 节点 / ${state.edges.length} 连线`);
    }
  });
  return () => { window.clearInterval(timer); unsub(); };
}
