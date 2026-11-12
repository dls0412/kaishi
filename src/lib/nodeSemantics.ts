/**
 * 节点语义。借鉴 BeefTV 校准的是「节点和输入的关系」，不是照搬它的云端产品结构：
 *
 *  - 一个节点同时承载内容、生成配置和连线输入，不给用户切换角色或模式。
 *  - 图片 / 视频节点选中后一律显示同一套控制区，上传过素材也一样能改参数。
 *  - 只有真正承载内容（有文字或有素材）的节点才能作为上游输入被引用。
 *
 * 旧项目里的 `nodeRole` / `resultOrigin` 字段原样保留、只用于兼容读取，
 * 不再决定节点能不能设参数，也不再写入新数据。
 */
import { isMediaNode, type CanvasNode, type MediaNode } from '../types';

/** 图片 / 视频 / 音频节点 */
function isCanvasMediaNode(n: CanvasNode | null | undefined): n is MediaNode {
  return !!n && isMediaNode(n);
}

/**
 * 能否被当作引用输入，对应 BeefTV 的 getNodeResourceKind：
 * 文本节点要有文字，媒体节点要有素材，空节点不算资源。
 */
export function isResourceNode(n: CanvasNode | null | undefined): boolean {
  if (!n) return false;
  if (n.type === 'text') return !!n.text.trim();
  if (n.type === 'group') return false;
  return isCanvasMediaNode(n) && !!n.assetId;
}

/**
 * 已导入和已生成的素材仅展示内容。空媒体节点和有创作配置的旧节点可以继续生成。
 */
export function canOpenPromptPanel(n: CanvasNode | null | undefined): boolean {
  if (!isCanvasMediaNode(n)) return false;
  if (n.type !== 'image' && n.type !== 'video') return false;
  if (!n.assetId) return true;
  const p = n.type === 'image' ? n.imageParams : n.videoParams;
  return n.nodeRole === 'generator' || (n.nodeRole !== 'result' && !!(p?.prompt || p?.modelKey));
}
