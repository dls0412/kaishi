import type { CanvasNode, Edge } from '../types';

/** Track connected content so changing a reference cannot silently leave an old result looking current. */
export function generationInputSignature(nodeId: string, nodes: CanvasNode[], edges: Edge[]): string {
  const byId = new Map(nodes.map(node => [node.id, node]));
  return JSON.stringify(edges.filter(edge => edge.to === nodeId).map(edge => {
    const source = byId.get(edge.from);
    return { edge: edge.id, from: edge.from, type: source?.type ?? '', content: source?.type === 'text' ? source.text : source && source.type !== 'group' ? source.assetId : '' };
  }));
}
