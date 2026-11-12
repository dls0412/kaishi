import type { CanvasNode, Viewport } from '../types';

export interface ControlGeometry {
  left: number;
  top: number;
  width: number;
  transform: string;
  maxPanelHeight: number;
  placement: 'below' | 'above';
  flipAbove: boolean;
}

/**
 * 控制区几何：反向补偿画布缩放，让控件始终保持固定的屏幕像素尺寸；
 * 水平按可见区域夹紧，下方空间不足时翻到节点上方，避免超出可用区域。
 * 放在画布世界顶层统一渲染，避免被其它节点卡片盖住。
 */
export function controlGeometry(node: CanvasNode, viewport: Viewport, view: { w: number; h: number }): ControlGeometry {
  const zoom = viewport.zoom;
  const screenW = Math.min(Math.max(280, view.w - 24), Math.max(720, Math.min(860, node.w * zoom * 1.5)));
  const gapWorld = 12 / zoom;
  const worldLeft = -viewport.x / zoom;
  const worldRight = (view.w - viewport.x) / zoom;
  const minLeft = worldLeft + gapWorld;
  const maxLeft = Math.max(minLeft, worldRight - screenW / zoom - gapWorld);
  const centeredLeft = node.x + node.w / 2 - screenW / zoom / 2;
  const left = Math.max(minLeft, Math.min(centeredLeft, maxLeft));

  const nodeBottomScreen = viewport.y + (node.y + node.h) * zoom;
  const nodeTopScreen = viewport.y + node.y * zoom;
  const roomBelow = view.h - nodeBottomScreen - 12 - 76;
  const roomAbove = nodeTopScreen - 14;
  const flipAbove = roomBelow < 230 && roomAbove > roomBelow;
  const placement: 'below' | 'above' = flipAbove ? 'above' : 'below';
  const available = flipAbove ? roomAbove : roomBelow;
  const maxPanelHeight = Math.max(120, Math.min(460, available - 8));
  const top = flipAbove ? node.y - gapWorld : node.y + node.h + gapWorld;
  const transform = `scale(${1 / zoom})${flipAbove ? ' translateY(-100%)' : ''}`;

  return { left, top, width: screenW, transform, maxPanelHeight, placement, flipAbove };
}
