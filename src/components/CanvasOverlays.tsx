import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  isMediaNode,
  nodeDisplayName,
  TYPE_LABELS,
  type CanvasNode,
} from '../types';
import Icon from './Icon';
import WorkflowDialog from './WorkflowDialog';

/**
 * 按需出现的画布辅助层，借鉴 BeefTV 的 canvas-node-search-modal 与
 * canvas-shortcuts-popover：快捷键说明不再常驻，需要时才弹出。
 * 这里只实现交互与呈现，不改画布数据。
 */

export interface ShortcutItem { title: string; keys: string; hint?: string }

export const CANVAS_SHORTCUTS: ShortcutItem[] = [
  { title: '搜索画布节点', keys: 'Ctrl / ⌘ + K' },
  { title: '快捷键速查', keys: '?' },
  { title: '进入 / 退出专注模式', keys: 'Ctrl / ⌘ + Shift + F' },
  { title: '新建节点', keys: '右键 / 双击空白' },
  { title: '粘贴文字、截图或节点', keys: 'Ctrl / ⌘ + V' },
  { title: '复制节点', keys: 'Ctrl / ⌘ + C' },
  { title: '原地复制', keys: 'Ctrl / ⌘ + D' },
  { title: '全选节点', keys: 'Ctrl / ⌘ + A' },
  { title: '撤销 / 重做', keys: 'Ctrl / ⌘ + Z / Shift + Z' },
  { title: '删除选中', keys: 'Delete / Backspace' },
  { title: '平移画布', keys: '空格拖动 / 中键' },
  { title: '缩放画布', keys: '滚轮 / + / −' },
  { title: '适应全部节点', keys: 'Ctrl / ⌘ + 0' },
  { title: '选择 / 抓手工具', keys: 'V / H' },
  { title: '清除选择 / 关闭弹窗', keys: 'Esc' },
  { title: '在提示词里引用节点', keys: '@', hint: '插入真实引用，来源更新后自动跟随' },
];

function nodeSummary(n: CanvasNode): string {
  if (n.type === 'text') return (n.text || '').trim().slice(0, 60) || '（空文本）';
  if (isMediaNode(n)) return n.fileName || `空${TYPE_LABELS[n.type]}节点`;
  return '分组框';
}

export function NodeSearchDialog({ nodes, onFocus, onClose }: {
  nodes: CanvasNode[];
  onFocus: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = nodes.filter((n) => n.type !== 'group' || q);
    if (!q) return list.slice(0, 40);
    return list.filter((n) => `${nodeDisplayName(n)} ${nodeSummary(n)} ${TYPE_LABELS[n.type]}`.toLowerCase().includes(q)).slice(0, 40);
  }, [nodes, query]);

  useEffect(() => { setActive(0); }, [query]);
  const clamped = Math.min(active, Math.max(0, results.length - 1));

  const choose = (id: string) => { onFocus(id); onClose(); };
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = Math.max(0, Math.min(results.length - 1, clamped + (e.key === 'ArrowDown' ? 1 : -1)));
      setActive(next);
      listRef.current?.querySelectorAll('button')[next]?.scrollIntoView({ block: 'nearest' });
    }
    else if (e.key === 'Enter') { e.preventDefault(); const hit = results[clamped]; if (hit) choose(hit.id); }
  };

  return (
    <WorkflowDialog title="搜索画布节点" onClose={onClose} className="overlay-card" testId="node-search-dialog" closeOnBackdrop>
      <div className="overlay-search" onKeyDown={onKeyDown}>
        <Icon name="zoomIn" size={15} />
        <input
          data-dialog-focus
          data-testid="node-search-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索节点名称、文字内容或素材文件名…"
          aria-label="搜索画布节点"
        />
      </div>
      <div className="overlay-result-count" data-testid="node-search-count">
        {query.trim() ? `找到 ${results.length} 个节点` : `画布上共 ${nodes.length} 个节点`}
      </div>
      <div ref={listRef} className="overlay-list" role="listbox" aria-label="搜索结果">
        {results.length === 0 && <div className="overlay-empty">没有匹配的节点，换个名称或内容继续搜索</div>}
        {results.map((n, i) => (
          <button
            key={n.id}
            type="button"
            role="option"
            aria-selected={i === clamped}
            data-search-node={n.id}
            className={`overlay-result${i === clamped ? ' active' : ''}`}
            onMouseEnter={() => setActive(i)}
            onClick={() => choose(n.id)}
          >
            <span className="overlay-result-icon"><Icon name={n.type} size={15} /></span>
            <span className="overlay-result-main">
              <strong>{nodeDisplayName(n)}</strong>
              <em>{nodeSummary(n)}</em>
            </span>
            <span className="overlay-result-kind">{TYPE_LABELS[n.type]}</span>
          </button>
        ))}
      </div>
    </WorkflowDialog>
  );
}

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <WorkflowDialog title="画布快捷键" onClose={onClose} className="overlay-card" testId="shortcuts-dialog" closeOnBackdrop>
      <div className="shortcut-grid">
        {CANVAS_SHORTCUTS.map((item) => (
          <div className="shortcut-entry" key={item.title} title={item.hint}>
            <span>{item.title}</span><kbd>{item.keys}</kbd>
          </div>
        ))}
      </div>
      <div className="overlay-foot">带 ⌘ 的组合在 Windows 上用 Ctrl。</div>
    </WorkflowDialog>
  );
}
