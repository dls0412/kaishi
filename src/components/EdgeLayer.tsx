import { useState, type MouseEvent } from 'react';
import type { CanvasNode, Edge, EdgeKind } from '../types';
import { edgePath } from '../lib/utils';

interface Props {
  nodes: CanvasNode[];
  edges: Edge[];
  selectedEdgeId: string | null;
  pending: { x1: number; y1: number; x2: number; y2: number } | null;
  /** 与当前选中节点/连线直接相关的连线：只在关联态绘制流光，其余淡化 */
  relatedEdgeIds: Set<string>;
  hasFocus: boolean;
  onSelectEdge: (id: string) => void;
  onDeleteEdge: (id: string) => void;
}

/** 深色画布用低饱和灰阶，靠明度区分状态，不靠彩色（对齐 BeefTV 的细线风格） */
const KIND_COLOR: Record<EdgeKind, string> = {
  'text-input': '#8a8a94',
  'image-ref': '#777781',
  link: '#6c6c76',
};

export default function EdgeLayer({ nodes, edges, selectedEdgeId, pending, relatedEdgeIds, hasFocus, onSelectEdge, onDeleteEdge }: Props) {
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return (
    <svg className="edge-layer" width="1" height="1" aria-hidden="false">
      <defs>
        {(['text-input', 'image-ref', 'link'] as EdgeKind[]).map((kind) => (
          <marker key={kind} id={`arrow-${kind}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 1 L 10 5 L 0 9 z" fill={KIND_COLOR[kind]} />
          </marker>
        ))}
        <marker id="arrow-active" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 1 L 10 5 L 0 9 z" fill="#dedee6" />
        </marker>
        <marker id="arrow-pending" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 1 L 10 5 L 0 9 z" fill="#b8b8c4" />
        </marker>
      </defs>
      {edges.map((edge) => {
        const from = byId.get(edge.from);
        const to = byId.get(edge.to);
        if (!from || !to) return null;
        const p = edgePath(from, to);
        const active = edge.id === selectedEdgeId;
        const related = relatedEdgeIds.has(edge.id);
        const emphasis = active || related;
        const dimmed = hasFocus && !emphasis;
        const kind: EdgeKind = edge.kind ?? 'link';
        const color = active ? '#dedee6' : KIND_COLOR[kind];
        const handleClick = (e: MouseEvent) => { e.stopPropagation(); onSelectEdge(edge.id); };
        return (
          <g
            key={edge.id}
            data-edge-id={edge.id}
            data-edge-kind={kind}
            data-edge-related={emphasis ? 'true' : undefined}
            data-edge-dimmed={dimmed ? 'true' : undefined}
            onPointerEnter={() => setHoveredEdge(edge.id)}
            onPointerLeave={() => setHoveredEdge(current => current === edge.id ? null : current)}
          >
            <path className="edge-hit" d={p.d} vectorEffect="non-scaling-stroke" onPointerDown={(e) => e.stopPropagation()} onClick={handleClick} />
            {/* 流光与光晕只在选中/关联态挂载，平时保持低对比细线 */}
            {emphasis && <path className="edge-glow" d={p.d} vectorEffect="non-scaling-stroke" />}
            <path
              className="edge-line"
              d={p.d}
              stroke={color}
              strokeWidth={emphasis ? 3 : 1.8}
              strokeOpacity={dimmed ? 0.22 : emphasis ? 0.95 : 0.58}
              vectorEffect="non-scaling-stroke"
              markerEnd={active ? 'url(#arrow-active)' : `url(#arrow-${kind})`}
            />
            {emphasis && <path className="edge-flow" d={p.d} vectorEffect="non-scaling-stroke" />}
            {hoveredEdge === edge.id && (
              <g className="edge-cut" role="button" tabIndex={0} aria-label="断开连线" transform={`translate(${p.mx} ${p.my})`}
                onPointerDown={e => e.stopPropagation()}
                onClick={e => { e.stopPropagation(); onDeleteEdge(edge.id); setHoveredEdge(null); }}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onDeleteEdge(edge.id); setHoveredEdge(null); } }}>
                <circle r="14" fill="#25252a" stroke="#777780" />
                <g fill="none" stroke="#eeeef2" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="-5" cy="-4" r="2.4" /><circle cx="-5" cy="4" r="2.4" />
                  <path d="M-3 -3 6 4M-3 3 6 -4" />
                </g>
              </g>
            )}
          </g>
        );
      })}
      {pending && (
        <path
          className="edge-pending"
          d={`M ${pending.x1} ${pending.y1} C ${pending.x1 + 60} ${pending.y1}, ${pending.x2 - 60} ${pending.y2}, ${pending.x2} ${pending.y2}`}
          fill="none"
          stroke="#b8b8c4"
          strokeWidth="1.6"
          strokeDasharray="6 5"
          markerEnd="url(#arrow-pending)"
        />
      )}
    </svg>
  );
}
