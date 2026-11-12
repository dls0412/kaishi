import { modelFetch } from './modelTransport';
import { create } from 'zustand';
import { useCanvas } from '../store';
import { capabilitiesOf, findBinding, fitParamsToCapabilities, h3ReferenceLabels, imageReferenceLabels, resolvePrompt, resolveReferences } from './models';
import { getAsset, listAssets, putAsset } from './db';
import { uid } from './utils';
import { DEFAULT_IMAGE_PARAMS, DEFAULT_VIDEO_PARAMS, EMPTY_CAPABILITIES, type AppSettings, type MediaNode, type ModelService } from '../types';
import { providerGeneration } from './providerGeneration';
import { CODEX_IMAGE, codexImage, useCodexAccount } from './codexAccount';
import { generationInputSignature } from './generationInputs';

export const codexCaps = { ...EMPTY_CAPABILITIES, ratios: ['1:1', '16:9', '9:16', '4:3', '3:4'], roles: ['reference-image' as const], maxReferences: 0, source: 'Codex 图片生成', note: '比例通过描述传达，实际尺寸以生成结果为准。' };
const codexModel = { id: 'codex-image', name: 'GPT 生图（Codex 账号）', type: 'image' as const, enabled: true, capabilities: codexCaps };
const codexService: ModelService = { id: 'codex', name: 'Codex', protocol: 'custom', baseUrl: '', apiKey: '', enabled: true, models: [codexModel], connection: { status: 'ok', checkedAt: 0, message: '', endpoint: '' }, note: '', createdAt: 0 };

async function imageReference(assetId: string): Promise<string> {
  const asset = await getAsset(assetId);
  if (!asset?.blob) throw new Error('参考图片不存在');
  const bitmap = await createImageBitmap(asset.blob);
  try {
    const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('参考图片无法读取');
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL('image/jpeg', 0.65);
    if (data.length > 500000) throw new Error('参考图片过大，请换一张较小的图片');
    return data;
  } finally { bitmap.close(); }
}

/** 只保存定位远端任务所需的非敏感信息；凭据始终从当前设置读取，不写进 localStorage。 */
export interface ResumeInfo {
  serviceId: string;
  protocol: string;
  baseUrl: string;
  modelKey: string;
  type: 'image' | 'video';
}

export interface GenerationTask {
  id: string; projectId: string; nodeId: string; name: string; type: 'image' | 'video';
  status: 'running' | 'completed' | 'failed' | 'cancelled'; message: string;
  remoteId?: string; assetIds: string[]; startedAt: number;
  deliveredResolution?: string;
  resume?: ResumeInfo;
  paramsSnapshot?: string;
  inputSignature?: string;
  interrupted?: boolean;
  deliveryPending?: boolean;
}
function history(): GenerationTask[] {
  try { return JSON.parse(localStorage.getItem('kaishi:tasks') || '[]').map((t: GenerationTask) => {
    const oldInterrupted = t.status === 'failed' && t.message?.startsWith('页面已重开，本机等待中断');
    if (t.status !== 'running' && !oldInterrupted) return t;
    return { ...t, status: 'failed', interrupted: Boolean(t.remoteId && t.resume), message: t.remoteId && t.resume ? '正在准备恢复远端任务' : '页面已重开，执行已中断；远端任务可能仍在运行，请核对任务编号后再生成' };
  }); } catch { return []; }
}
export const useGeneration = create<{ tasks: GenerationTask[] }>(() => ({ tasks: history() }));
const controllers = new Map<string, AbortController>();
function update(id: string, patch: Partial<GenerationTask>) {
  useGeneration.setState(s => ({ tasks: s.tasks.map(t => t.id === id ? { ...t, ...patch } : t) }));
  localStorage.setItem('kaishi:tasks', JSON.stringify(useGeneration.getState().tasks));
}
export function cancelGeneration(id: string) { controllers.get(id)?.abort(); }

function failureMessage(error: unknown, cancelled: boolean, signal: AbortSignal): string {
  if (cancelled) return '已停止本机等待；远端任务可能仍在执行，可在任务页续查远端产物';
  const timedOut = signal.reason?.name === 'TimeoutError' || (error instanceof DOMException && error.name === 'TimeoutError');
  if (timedOut) return '本机等待超时（15 分钟）；远端任务可能仍在执行，可在任务页续查远端产物';
  return error instanceof Error ? error.message : String(error);
}

/** 把产物写入本机素材库，并回写到发起节点（仅当它仍在原项目里）。 */
async function deliverResult(options: {
  taskId: string; nodeId: string; projectId: string; name: string; type: 'image' | 'video';
  blobs: Blob[]; paramsSnapshot?: string; inputSignature?: string;
}): Promise<string[]> {
  const { taskId, nodeId, projectId, name, type, blobs, paramsSnapshot, inputSignature } = options;
  const assetIds: string[] = [];
  for (let i = 0; i < blobs.length; i++) {
    const blob = blobs[i]; if (!blob.size) throw new Error('服务返回空文件');
    const assetId = uid('asset'); assetIds.push(assetId);
    const fileName = `${name}-${Date.now()}-${i + 1}.${type === 'image' ? 'png' : 'mp4'}`;
    await putAsset({ meta: { id: assetId, name: fileName, mime: blob.type || (type === 'image' ? 'image/png' : 'video/mp4'), size: blob.size, kind: type, createdAt: Date.now() }, blob });
  }
  const current = useCanvas.getState();
  const inProject = current.projectId === projectId && current.nodes.some(n => n.id === nodeId);
  if (inProject) {
    // 生成期间改过提示词或连线时，结果要标成「需重新生成」，不能伪装成最新结果。
    const latest = current.nodes.find(item => item.id === nodeId);
    const latestParams = latest?.type === 'image' ? latest.imageParams : latest?.type === 'video' ? latest.videoParams : undefined;
    current.updateNode(nodeId, {
      assetId: assetIds[0], resultAssetIds: assetIds, fileName: `${name} · 结果 1`, nodeRole: 'generator',
      resultStale: paramsSnapshot !== undefined && JSON.stringify(latestParams) !== paramsSnapshot,
      resultInputSnapshot: inputSignature,
    });
    await useCanvas.getState().persist();
  }
  useCanvas.getState().setAssets(await listAssets());
  update(taskId, {
    status: 'completed', assetIds, deliveryPending: !inProject,
    message: inProject ? `已生成 ${assetIds.length} 个素材` : '生成完成，已保存到素材库；返回原项目后恢复到节点',
  });
  return assetIds;
}
export function generationConfig(node: MediaNode, settings: AppSettings) {
  if (node.type !== 'image' && node.type !== 'video') return null;
  const params = node.type === 'image' ? node.imageParams : node.videoParams;
  if (node.type === 'image' && params?.modelKey === CODEX_IMAGE) {
    if (!useCodexAccount.getState().status?.account) return null;
    return { binding: { key: CODEX_IMAGE, service: codexService, model: codexModel }, caps: codexCaps, node };
  }
  const protocol = node.type === 'image' ? 'compshare-image' : 'compshare-h3';
  const readyBinding = (key: string) => {
    const binding = findBinding(settings, key);
    if (!binding?.service.enabled || !binding.model.enabled || binding.model.type !== node.type) return null;
    if (!binding.service.baseUrl.trim() || !binding.service.apiKey.trim()) return null;
    return binding.service.protocol === 'openai' || binding.service.protocol === protocol ? binding : null;
  };
  const binding = params?.modelKey ? readyBinding(params.modelKey) : readyBinding(settings.defaults[node.type] || '');
  if (!binding) return null;
  const caps = capabilitiesOf(settings, binding.key) ?? binding.model.capabilities;
  if (params?.modelKey === binding.key) return { binding, caps, node };
  const prepared = node.type === 'image'
    ? { ...node, imageParams: fitParamsToCapabilities({ ...(node.imageParams ?? DEFAULT_IMAGE_PARAMS), modelKey: binding.key }, caps, 'image').params }
    : { ...node, videoParams: fitParamsToCapabilities({ ...(node.videoParams ?? DEFAULT_VIDEO_PARAMS), modelKey: binding.key }, caps, 'video').params };
  return { binding, caps, node: prepared };
}

export function generationSupport(node: MediaNode): string | null {
  return generationConfig(node, useCanvas.getState().settings) ? null : '请先在模型配置中设置可用的默认模型';
}
const delay = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const abort = () => { clearTimeout(timer); reject(new DOMException('已停止等待', 'AbortError')); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
});
export function prepareGeneration(nodeId: string) {
  const st = useCanvas.getState();
  const source = st.nodes.find(n => n.id === nodeId);
  if (!source || (source.type !== 'image' && source.type !== 'video')) throw new Error('请选择图片或视频节点');
  const config = generationConfig(source, st.settings);
  if (!config) throw new Error('请先在模型配置中设置可用的默认模型');
  const { binding, caps, node } = config;
  if (useGeneration.getState().tasks.some(t => t.nodeId === nodeId && t.projectId === st.projectId && t.status === 'running')) throw new Error('此节点正在生成');
  const p = (node.type === 'video' ? node.videoParams : node.imageParams)!;
  const isH3 = binding.service.protocol === 'compshare-h3';
  const isCodexImage = binding.key === CODEX_IMAGE;
  const usesCompShareRefs = isH3 || binding.service.protocol === 'compshare-image';
  const rows = usesCompShareRefs
    ? resolveReferences(node, st.nodes, st.edges, caps, st.assets).mediaInputs
    : [];
  const labels = isH3 ? h3ReferenceLabels(rows) : usesCompShareRefs ? imageReferenceLabels(rows) : undefined;
  const resolved = resolvePrompt(p.prompt, p.promptRefs, st.nodes, labels,
    p.references.filter(reference => st.assets.some(asset => asset.id === reference.assetId)));
  if (resolved.issues.length) throw new Error(resolved.issues.join('；'));
  const upstream = st.edges.filter(e => e.to === nodeId).map(e => st.nodes.find(n => n.id === e.from)).filter(Boolean);
  let prompt = [resolved.text, ...upstream.filter(n => n?.type === 'text' && !p.promptRefs.some(r => r.nodeId === n.id)).map(n => n?.type === 'text' ? n.text : '')].filter(Boolean).join('\n\n');
  if (isH3 && labels) {
    const mappings = rows.filter(row => row.ready && !row.duplicate && row.assetId && labels.has(row.assetId) && !prompt.includes(labels.get(row.assetId)!))
      .map(row => `${labels.get(row.assetId)} 对应素材 ${JSON.stringify(row.name.slice(0, 120))}`);
    if (mappings.length) prompt += `\n\n参考素材对应关系：${mappings.join('；')}。`;
  }
  const mediaRefs = upstream.filter((n): n is MediaNode => !!n && (n.type === 'image' || n.type === 'video' || n.type === 'audio'));
  if (mediaRefs.some(n => !n.assetId)) throw new Error('参考节点还没有素材');
  const references = usesCompShareRefs
    ? rows.filter(row => !row.duplicate).map(row => ({ assetId: row.assetId, kind: row.kind, role: row.role ?? undefined }))
    : [...mediaRefs.map(n => ({ assetId: n.assetId, kind: n.type, role: p.edgeRoles[st.edges.find(e => e.from === n.id && e.to === nodeId)!.id] })), ...p.references.map(r => ({ assetId: r.assetId, kind: r.kind, role: r.role }))].filter((r, i, arr) => arr.findIndex(x => x.assetId === r.assetId) === i);
  if (!prompt.trim() && !(isH3 && references.length)) throw new Error('请先填写提示词或连接文字节点');
  if (binding.service.protocol === 'openai' && references.some(r => r.kind !== 'image')) throw new Error('当前 OpenAI 兼容适配只接收图片参考；请移除视频或音频参考');
  if (isCodexImage && references.some(r => r.kind !== 'image')) throw new Error('Codex 生图仅支持图片作为参考素材');
  if (binding.service.protocol === 'openai' && node.type === 'video' && references.length > 1) throw new Error('当前视频协议只接收一张首帧参考');
  return { st, source, binding, node, p, isCodexImage, prompt, references };
}
export async function generateNode(nodeId: string): Promise<{ taskId: string; assetIds: string[] }> {
  const { st, source, binding, node, p, isCodexImage, prompt, references } = prepareGeneration(nodeId);
  const startedParams = JSON.stringify(source.type === 'image' ? source.imageParams : source.videoParams);
  const startedInputs = generationInputSignature(nodeId, st.nodes, st.edges);
  const id = uid('task');
  const controller = new AbortController();
  controllers.set(id, controller);
  const task: GenerationTask = {
    id, projectId: st.projectId, nodeId, name: node.name, type: source.type as 'image' | 'video',
    status: 'running', message: '正在提交', assetIds: [], startedAt: Date.now(),
    paramsSnapshot: startedParams, inputSignature: startedInputs,
    // 记录定位信息（不含密钥），刷新页面后仍可按远端任务编号把产物取回来。
    ...(binding.service.protocol !== 'custom' ? {
      resume: { serviceId: binding.service.id, protocol: binding.service.protocol, baseUrl: binding.service.baseUrl, modelKey: binding.key, type: source.type as 'image' | 'video' },
    } : {}),
  };
  useGeneration.setState(s => ({ tasks: [task, ...s.tasks] })); update(id, {});
  const base = binding.service.baseUrl.replace(/\/+$/, '');
  const headers = { Authorization: `Bearer ${binding.service.apiKey}` };
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15 * 60 * 1000)]);
  const request = async (path: string, init: RequestInit = {}) => {
    const res = await modelFetch(base + path, { ...init, headers: { ...headers, ...init.headers }, signal });
    if (!res.ok) { let detail = ''; try { const error = await res.json(); detail = typeof error.error === 'string' ? error.error : error.error?.message || error.message || ''; } catch { /* only show safe status */ } throw new Error(`模型服务返回 ${res.status}${detail ? `：${String(detail).replaceAll(binding.service.apiKey, '[已隐藏]').slice(0, 220)}` : ''}`); }
    return res;
  };
  const json = async (path: string, payload: unknown) => (await request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })).json();
  try {
    const blobs: Blob[] = [];
    const size = p.resolution.replace('×', 'x');
    if (isCodexImage) {
      update(id, { message: 'Codex 正在生成图片' });
      const image = await codexImage(`${prompt}\n\n请生成一张图片，画面比例：${p.aspectRatio || '1:1'}。`, signal, await Promise.all(references.map(ref => imageReference(ref.assetId))));
      blobs.push(new Blob([Uint8Array.from(atob(image), c => c.charCodeAt(0))], { type: 'image/png' }));
    } else if (binding.service.protocol !== 'openai') {
      blobs.push(...await providerGeneration(binding.service, node, references, prompt, id, signal, value => update(id, value)));
    } else if (node.type === 'image') {
      let data;
      if (references.length) {
        const form = new FormData(); form.set('model', binding.model.id); form.set('prompt', prompt); form.set('n', String(node.imageParams?.count || 1));
        if (/^\d+x\d+$/.test(size)) form.set('size', size);
        for (const ref of references) { const asset = await getAsset(ref.assetId); if (!asset) throw new Error('参考素材不存在'); form.append('image[]', asset.blob, asset.meta.name); }
        data = await (await request('/images/edits', { method: 'POST', body: form })).json();
      } else {
        data = await json('/images/generations', { model: binding.model.id, prompt, n: node.imageParams?.count || 1, ...(/^\d+x\d+$/.test(size) ? { size } : {}) });
      }
      if (!Array.isArray(data.data) || !data.data.length) throw new Error('服务未返回图片');
      update(id, { message: '正在保存图片' });
      for (const item of data.data) {
        if (item.b64_json) { const bytes = Uint8Array.from(atob(item.b64_json), c => c.charCodeAt(0)); blobs.push(new Blob([bytes], { type: 'image/png' })); }
        else if (item.url) { const res = await modelFetch(item.url, { signal }); if (!res.ok) throw new Error('图片下载失败'); blobs.push(await res.blob()); }
        else throw new Error('图片响应缺少 URL 或 base64');
      }
    } else {
      let reference: string | undefined;
      if (references.length) { const asset = await getAsset(references[0].assetId); if (!asset) throw new Error('首帧素材不存在'); reference = await new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = reject; r.readAsDataURL(asset.blob); }); }
      let data = await json('/videos', { model: binding.model.id, prompt, seconds: String(node.videoParams?.duration || 4), ...(/^\d+x\d+$/.test(size) ? { size } : {}), ...(reference ? { input_reference: { image_url: reference } } : {}) });
      if (!data.id) throw new Error('服务未返回视频任务编号');
      const remoteId = String(data.id); update(id, { remoteId, message: '视频生成中' });
      while (!['completed', 'failed', 'cancelled'].includes(data.status)) { await delay(2500, signal); data = await (await request(`/videos/${encodeURIComponent(remoteId)}`)).json(); update(id, { message: `视频生成中${typeof data.progress === 'number' ? ` · ${data.progress}%` : ''}` }); }
      if (data.status !== 'completed') throw new Error(data.error?.message || '视频生成失败');
      update(id, { message: '正在保存视频' });
      blobs.push(await (await request(`/videos/${encodeURIComponent(remoteId)}/content`)).blob());
    }
    const assetIds = await deliverResult({ taskId: id, nodeId, projectId: task.projectId, name: node.name, type: task.type, blobs, paramsSnapshot: startedParams, inputSignature: startedInputs });
    return { taskId: id, assetIds };
  } catch (error) {
    const cancelled = controller.signal.aborted;
    const message = failureMessage(error, cancelled, signal);
    update(id, { status: cancelled ? 'cancelled' : 'failed', message }); throw new Error(message);
  } finally { controllers.delete(id); }
}

/**
 * 刷新或手动停止后，用已收到的远端任务编号重新查询并领取产物。
 * 只读取既有远端任务，绝不重新提交生成，避免重复扣费。
 */
export async function resumeGeneration(taskId: string): Promise<{ taskId: string; assetIds: string[] }> {
  const task = useGeneration.getState().tasks.find(t => t.id === taskId);
  if (!task) throw new Error('任务不存在');
  if (task.status === 'running') throw new Error('任务仍在运行');
  if (!task.remoteId || !task.resume) throw new Error('此任务没有可续查的远端编号；旧任务只能复制编号到服务商后台核对');
  const st = useCanvas.getState();
  if (st.projectId !== task.projectId) throw new Error('请切回任务所属项目后续查');
  const info = task.resume;
  const service = st.settings.services.find(s => s.id === info.serviceId);
  if (!service?.enabled || !service.apiKey.trim() || !service.baseUrl.trim()) {
    throw new Error('原模型服务已停用或凭据已移除，请在设置里恢复后重试，或复制远端编号到服务商后台核对');
  }
  if (service.protocol !== info.protocol || service.baseUrl.trim().replace(/\/+$/, '') !== info.baseUrl.trim().replace(/\/+$/, '')) {
    throw new Error('原模型服务地址或协议已变更，请恢复原配置后续查');
  }
  if (useGeneration.getState().tasks.some(t => t.id !== taskId && t.remoteId === task.remoteId && t.status === 'running')) {
    throw new Error('此远端任务正在续查，请勿重复操作');
  }
  const controller = new AbortController();
  controllers.set(taskId, controller);
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15 * 60 * 1000)]);
  update(taskId, { status: 'running', interrupted: false, message: '正在续查远端任务' });
  const base = info.baseUrl.replace(/\/+$/, '');
  const request = async (path: string, init: RequestInit = {}) => {
    const res = await modelFetch(base + path, {
      ...init,
      headers: { Authorization: `Bearer ${service.apiKey}`, ...init.headers }, signal,
    });
    if (!res.ok) {
      let detail = '';
      try { const error = await res.json(); detail = typeof error.error === 'string' ? error.error : error.error?.message || error.message || ''; } catch { /* 只显示安全的状态码 */ }
      throw new Error(`模型服务返回 ${res.status}${detail ? `：${String(detail).replaceAll(service.apiKey, '[已隐藏]').slice(0, 220)}` : ''}`);
    }
    return res;
  };
  const download = async (url: string) => {
    if (!url) throw new Error('远端任务成功但缺少产物地址');
    const res = await modelFetch(url, { signal });
    if (!res.ok) throw new Error(`产物下载失败 ${res.status}`);
    return res.blob();
  };
  const remote = encodeURIComponent(task.remoteId);
  try {
    let blob: Blob;
    if (info.protocol === 'compshare-h3') {
      for (;;) {
        const data = await (await request(`/minimax/v2/query/video_generation/${remote}`)).json();
        const result = data.task;
        if (!result) throw new Error('H3 任务响应格式错误');
        if (result.status === 'succeeded') { update(taskId, { message: '正在保存视频', deliveredResolution: result.resolution }); blob = await download(result.content?.url); break; }
        if (['failed', 'cancelled', 'blocked'].includes(result.status)) throw new Error(result.error?.message || `远端任务结束：${result.status}`);
        update(taskId, { message: `远端生成中 · ${result.status}` });
        await delay(3000, signal);
      }
    } else if (info.protocol === 'compshare-image') {
      for (;;) {
        const data = await (await request(`/image/v1/tasks/${remote}`)).json();
        const result = data.task;
        if (!result) throw new Error('图片任务响应格式错误');
        if (result.status === 'succeeded') { update(taskId, { message: '正在保存图片' }); blob = await download(result.output_url); break; }
        if (['failed', 'cancelled', 'blocked'].includes(result.status)) throw new Error(result.error_message || `远端任务结束：${result.status}`);
        update(taskId, { message: `远端生成中 · ${result.status}` });
        await delay(3000, signal);
      }
    } else if (info.protocol === 'openai') {
      for (;;) {
        const data = await (await request(`/videos/${remote}`)).json();
        if (data.status === 'completed') { update(taskId, { message: '正在保存视频' }); blob = await (await request(`/videos/${remote}/content`)).blob(); break; }
        if (['failed', 'cancelled'].includes(data.status)) throw new Error(data.error?.message || `远端任务结束：${data.status}`);
        update(taskId, { message: `远端生成中${typeof data.progress === 'number' ? ` · ${data.progress}%` : ''}` });
        await delay(2500, signal);
      }
    } else throw new Error('此协议暂不支持自动续查，请复制远端编号到服务商后台核对');
    const assetIds = await deliverResult({
      taskId, nodeId: task.nodeId, projectId: task.projectId, name: task.name, type: info.type,
      blobs: [blob], paramsSnapshot: task.paramsSnapshot, inputSignature: task.inputSignature,
    });
    return { taskId, assetIds };
  } catch (error) {
    const cancelled = controller.signal.aborted;
    const message = failureMessage(error, cancelled, signal);
    update(taskId, { status: cancelled ? 'cancelled' : 'failed', message });
    throw new Error(message);
  } finally { controllers.delete(taskId); }
}

/** 重开后只查询已经提交的任务，绝不再次发起生成。 */
export function restoreProjectGenerations(projectId: string) {
  const current = useCanvas.getState();
  if (!current.ready || current.projectId !== projectId) return;
  let changed = false;
  for (const task of useGeneration.getState().tasks.filter(item => item.projectId === projectId && item.deliveryPending && item.status === 'completed')) {
    const node = useCanvas.getState().nodes.find(item => item.id === task.nodeId);
    if (node && (node.type === 'image' || node.type === 'video') && task.assetIds.length) {
      const params = node.type === 'image' ? node.imageParams : node.videoParams;
      useCanvas.getState().updateNode(task.nodeId, { assetId: task.assetIds[0], resultAssetIds: task.assetIds, fileName: `${task.name} · 结果 1`, nodeRole: 'generator', resultStale: task.paramsSnapshot !== undefined && JSON.stringify(params) !== task.paramsSnapshot, resultInputSnapshot: task.inputSignature });
      update(task.id, { deliveryPending: false, message: `已生成 ${task.assetIds.length} 个素材` });
      changed = true;
    }
  }
  if (changed) void useCanvas.getState().persist();
  for (const task of useGeneration.getState().tasks.filter(item => item.projectId === projectId && item.interrupted && item.remoteId && item.resume)) {
    void resumeGeneration(task.id).catch(error => update(task.id, { interrupted: false, message: error instanceof Error ? error.message : String(error) }));
  }
}
