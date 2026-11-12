import JSZip from 'jszip';
import { getAsset, invalidateAssetUrl, listAssets, putAsset, saveProject } from './db';
import {
  normalizeEdge,
  normalizeNodes,
  type AssetMeta,
  type CanvasNode,
  type Edge,
  type ImageGenParams,
  type ProjectData,
  type VideoGenParams,
  type ProjectMeta,
  type Viewport,
} from '../types';
import { downloadBlob, formatTime, safeFileName, uid } from './utils';
import { assetIdsOf } from '../store';

const FORMAT = 'infinite-canvas-project';

interface Manifest {
  format: string;
  version: number;
  exportedAt: number;
  project: {
    name: string;
    createdAt: number;
    updatedAt: number;
    data: ProjectData;
  };
  assets: AssetMeta[];
}

export function collectAssetIds(data: ProjectData): string[] {
  // 同时包含节点素材与创作参数里引用的参考素材，保证跨项目导出不缺文件
  return assetIdsOf(data.nodes);
}

function normalizeData(raw: unknown): ProjectData {
  const src = (raw ?? {}) as Partial<ProjectData>;
  const rawNodes: CanvasNode[] = Array.isArray(src.nodes)
    ? src.nodes.filter((n): n is CanvasNode => !!n && typeof n.id === 'string' && typeof n.type === 'string'
      && Number.isFinite(n.x) && Number.isFinite(n.y) && Number.isFinite(n.w) && Number.isFinite(n.h))
    : [];
  const nodes = normalizeNodes(rawNodes);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges: Edge[] = Array.isArray(src.edges)
    ? src.edges
      .filter((e): e is Edge => !!e && typeof e.id === 'string' && typeof e.from === 'string' && typeof e.to === 'string')
      .map((e) => normalizeEdge(e, byId.get(e.from), byId.get(e.to)))
    : [];
  const vp = src.viewport;
  const viewport: Viewport = vp && Number.isFinite(vp.x) && Number.isFinite(vp.y) && Number.isFinite(vp.zoom)
    ? { x: vp.x, y: vp.y, zoom: Math.min(4, Math.max(0.1, vp.zoom)) }
    : { x: 0, y: 0, zoom: 1 };
  return { nodes, edges, viewport };
}

export async function exportProject(project: ProjectMeta): Promise<{ fileName: string; assetCount: number; size: number }> {
  const zip = new JSZip();
  const ids = collectAssetIds(project.data);
  const assets: AssetMeta[] = [];
  for (const id of ids) {
    const record = await getAsset(id);
    if (!record) continue;
    assets.push(record.meta);
    zip.file(`assets/${id}`, record.blob, { compression: 'STORE' });
  }
  const manifest: Manifest = {
    format: FORMAT,
    version: 1,
    exportedAt: Date.now(),
    project: {
      name: project.name,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      data: project.data,
    },
    assets,
  };
  zip.file('project.json', JSON.stringify(manifest, null, 2), { compression: 'DEFLATE' });
  const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
  const stamp = formatTime(Date.now()).replace(/[-: ]/g, '').slice(0, 12);
  const fileName = `${safeFileName(project.name)}-${stamp}.canvasproj`;
  downloadBlob(blob, fileName);
  return { fileName, assetCount: assets.length, size: blob.size };
}

/**
 * 导入时校验引用绑定：来源节点 / 素材 / 连线是否仍然存在。
 * 失效引用不静默伪装成有效内容，而是整理成明确提示；
 * 连线派生出来的用途与排序项则直接清掉，避免留下幽灵输入。
 */
function validateReferences(data: ProjectData, packaged: Set<string>, existing: Set<string>): { data: ProjectData; notes: string[] } {
  const nodeIds = new Set(data.nodes.map((n) => n.id));
  const edgeIds = new Set(data.edges.map((e) => e.id));
  let brokenSources = 0;
  let missingRefAssets = 0;
  let boundNodes = 0;
  const rewrite = (p?: ImageGenParams | VideoGenParams) => {
    if (!p) return p;
    if (p.modelKey) boundNodes += 1;
    const attachmentIds = new Set((p.references ?? []).map(reference => reference.id));
    brokenSources += (p.promptRefs ?? []).filter((r) => !nodeIds.has(r.nodeId) && !attachmentIds.has(r.nodeId)).length;
    (p.references ?? []).forEach((r) => {
      if (r.assetId && !packaged.has(r.assetId) && !existing.has(r.assetId)) missingRefAssets += 1;
    });
    const edgeRoles = Object.fromEntries(Object.entries(p.edgeRoles ?? {}).filter(([id]) => edgeIds.has(id)));
    const refOrder = (p.refOrder ?? []).filter((key) => {
      const [prefix, id] = key.split(':');
      return prefix !== 'edge' || edgeIds.has(id);
    });
    return { ...p, edgeRoles, refOrder };
  };
  const nodes: CanvasNode[] = data.nodes.map((n) => {
    if (n.type === 'image') return { ...n, imageParams: rewrite(n.imageParams) as ImageGenParams | undefined };
    if (n.type === 'video') return { ...n, videoParams: rewrite(n.videoParams) as VideoGenParams | undefined };
    return n;
  });
  const notes: string[] = [];
  if (brokenSources) notes.push(`${brokenSources} 个文本引用的来源节点不在项目包里，已标记为失效`);
  if (missingRefAssets) notes.push(`${missingRefAssets} 个手选参考素材文件缺失，相关输入显示未就绪`);
  if (boundNodes) notes.push(`项目包不含模型服务凭据，${boundNodes} 个节点的模型绑定需在设置里重新配置服务`);
  return { data: { ...data, nodes }, notes };
}

export interface ImportResult {
  project: ProjectMeta;
  assetCount: number;
  missing: string[];
  notes: string[];
}

export async function importProjectFile(file: File): Promise<ImportResult> {
  const zip = await JSZip.loadAsync(file);
  const jsonFile = zip.file('project.json');
  if (!jsonFile) throw new Error('文件中没有 project.json，不是有效的画布项目文件');
  let manifest: Manifest;
  try {
    manifest = JSON.parse(await jsonFile.async('string')) as Manifest;
  } catch {
    throw new Error('project.json 解析失败，文件可能已损坏');
  }
  if (manifest?.format !== FORMAT) throw new Error('文件格式不匹配，请选择 .canvasproj 项目文件');

  const existing = new Set((await listAssets()).map((a) => a.id));
  const missing: string[] = [];
  let assetCount = 0;
  for (const meta of manifest.assets ?? []) {
    if (!meta?.id) continue;
    const entry = zip.file(`assets/${meta.id}`);
    if (!entry) { missing.push(meta.name ?? meta.id); continue; }
    const blob = await entry.async('blob');
    // 同 ID 素材可能被项目包覆盖；先清掉旧的对象 URL，否则画布仍显示导入前的内容。
    invalidateAssetUrl(meta.id);
    await putAsset({
      meta: { ...meta, mime: meta.mime || blob.type || 'application/octet-stream', size: blob.size },
      blob,
    });
    existing.add(meta.id);
    assetCount += 1;
  }

  const normalized = normalizeData(manifest.project?.data);
  const validated = validateReferences(normalized, new Set((manifest.assets ?? []).map((a) => a.id)), existing);
  const now = Date.now();
  const project: ProjectMeta = {
    id: uid('prj'),
    name: `${manifest.project?.name || '未命名项目'}（导入）`,
    createdAt: now,
    updatedAt: now,
    data: validated.data,
  };
  await saveProject(project);
  return { project, assetCount, missing, notes: validated.notes };
}
