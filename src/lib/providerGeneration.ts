import { getAsset } from './db';
import { modelFetch } from './modelTransport';
import { ROLE_KINDS, type MediaNode, type ModelService, type ReferenceRole } from '../types';
import { H3_CAPABILITIES, qwenImageResolutions } from './modelCatalog';

const MIB = 1024 * 1024;

async function imageDimensions(blob: Blob) {
  const bitmap = await createImageBitmap(blob);
  try { return { width: bitmap.width, height: bitmap.height }; }
  finally { bitmap.close(); }
}

function readDuration(blob: Blob, kind: 'video' | 'audio', signal: AbortSignal): Promise<number | undefined> {
  return new Promise(resolve => {
    const media = document.createElement(kind);
    const url = URL.createObjectURL(blob);
    const done = (duration?: number) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      media.onloadedmetadata = null;
      media.onerror = null;
      media.removeAttribute('src');
      media.load();
      URL.revokeObjectURL(url);
      resolve(duration);
    };
    const abort = () => done();
    const timer = setTimeout(abort, 4000);
    signal.addEventListener('abort', abort, { once: true });
    media.preload = 'metadata';
    media.onloadedmetadata = () => done(Number.isFinite(media.duration) ? media.duration : undefined);
    media.onerror = abort;
    if (signal.aborted) abort();
    else media.src = url;
  });
}

export interface GenerationRef { assetId: string; kind: string; role?: ReferenceRole }
export async function providerGeneration(service: ModelService, node: MediaNode, refs: GenerationRef[], prompt: string, operationId: string, signal: AbortSignal, progress: (value: { message: string; remoteId?: string; deliveredResolution?: string }) => void): Promise<Blob[]> {
  const base = service.baseUrl.replace(/\/+$/, '');
  const request = async (path: string, payload?: unknown, createTask = false) => {
    const response = await modelFetch(base + path, {
      method: payload === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${service.apiKey.trim()}`, Accept: 'application/json', 'Content-Type': 'application/json', ...(createTask ? { 'Idempotency-Key': operationId } : {}) },
      body: payload === undefined ? undefined : JSON.stringify(payload), signal,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || (data?.RetCode && data.RetCode !== 0)) throw new Error(`HTTP ${response.status}：${String(data?.error?.message || data?.error || data?.message || data?.Message || '生成请求失败').replaceAll(service.apiKey.trim(), '[已隐藏]').slice(0, 200)}`);
    if (!data) throw new Error('服务未返回有效的 JSON');
    return data;
  };
  const wait = () => new Promise<void>((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(new Error('已停止等待')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, 3000);
    signal.addEventListener('abort', onAbort, { once: true }); if (signal.aborted) onAbort();
  });
  const download = async (url: string) => {
    if (!url) throw new Error('任务成功但缺少产物地址');
    const response = await modelFetch(url, { signal }); if (!response.ok) throw new Error(`产物下载失败 ${response.status}`);
    return response.blob();
  };
  if (service.protocol === 'compshare-h3') {
    const p = node.videoParams!;
    if ([...prompt].length > 10000) throw new Error('H3 提示词不能超过 10000 字符');
    if (!prompt.trim() && !refs.length) throw new Error('请填写提示词或添加参考素材');
    if (refs.length > 12) throw new Error('H3 最多接收 12 个参考素材');
    const useContextIr = Boolean(p.advanced.useContextIr ?? false);
    const skillId = typeof p.advanced.skillId === 'string' ? p.advanced.skillId.trim() : '';
    if (skillId && !useContextIr) throw new Error('使用平台 Skill ID 时，请开启 Context-IR 提示词优化');
    const content: Record<string, unknown>[] = prompt.trim() ? [{ type: 'text', text: prompt }] : [];
    const roleCounts = new Map<ReferenceRole, number>();
    const seconds = { video: 0, audio: 0 };
    for (const ref of refs) {
      const asset = await getAsset(ref.assetId); if (!asset) throw new Error('参考素材不存在');
      const kind = asset.meta.kind;
      const role = ref.role ?? (`reference-${kind}` as ReferenceRole);
      if (kind !== ref.kind || ROLE_KINDS[role] !== kind) throw new Error(`「${asset.meta.name}」的素材类型与用途不匹配`);
      const count = (roleCounts.get(role) ?? 0) + 1;
      const limit = H3_CAPABILITIES.roleLimits[role]!;
      if (count > limit) throw new Error(`参考用途 ${role} 超出上限 ${limit}`);
      roleCounts.set(role, count);
      const maxMiB = kind === 'image' ? 30 : kind === 'video' ? 50 : 15;
      if (!asset.blob.size || asset.blob.size > maxMiB * MIB) throw new Error(`「${asset.meta.name}」文件为空或超过 ${maxMiB} MiB`);
      const blob = asset.blob.type ? asset.blob : asset.blob.slice(0, asset.blob.size, asset.meta.mime);
      if (kind === 'image') {
        const { width, height } = await imageDimensions(blob);
        if (width < 256 || height < 256 || width > 5760 || height > 5760 || width / height < 0.4 || width / height > 2.5) {
          throw new Error(`「${asset.meta.name}」宽高须在 256–5760 像素，比例须在 2:5–5:2`);
        }
      } else {
        const duration = await readDuration(blob, kind, signal);
        signal.throwIfAborted();
        if (duration !== undefined) {
          if (duration < 2 || duration > 15.08) throw new Error(`「${asset.meta.name}」单段时长须在 2–15.08 秒`);
          seconds[kind] += duration;
          if (seconds[kind] > 15.08 + 1e-9) throw new Error(`参考${kind === 'video' ? '视频' : '音频'}合计不得超过 15.08 秒`);
        }
      }
      const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(blob); });
      content.push({ type: `${kind}_url`, [`${kind}_url`]: { url: dataUrl }, role: role.replaceAll('-', '_') });
    }
    if ((roleCounts.has('first-frame') || roleCounts.has('last-frame')) && [...roleCounts.keys()].some(r => r.startsWith('reference-'))) throw new Error('首尾帧不能与全能参考素材混用');
    const modelId = p.modelKey.slice(p.modelKey.indexOf('::') + 2);
    const data = await request('/minimax/v2/video_generation', { model: modelId, content, duration: p.duration, ratio: p.aspectRatio || '16:9', resolution: p.resolution || '768P', use_context_ir: useContextIr, mute_audio: p.audio === 'mute', aigc_watermark: Boolean(p.advanced.aigcWatermark), ...(skillId ? { skill_id: skillId } : {}) }, true);
    const remoteId = data.task_id; if (!remoteId) throw new Error('H3 未返回任务编号');
    progress({ remoteId, message: '视频已提交，等待生成' });
    while (true) {
      await wait(); const status = await request(`/minimax/v2/query/video_generation/${encodeURIComponent(remoteId)}`);
      const task = status.task; if (!task) throw new Error('H3 任务响应格式错误');
      if (task.status === 'succeeded') {
        progress({ message: '正在保存视频', deliveredResolution: task.resolution });
        return [await download(task.content?.url)];
      }
      if (['failed', 'cancelled', 'blocked'].includes(task.status)) throw new Error(task.error?.message || `任务结束：${task.status}`);
      progress({ message: `视频生成中 · ${task.status}` });
    }
  }
  if (service.protocol === 'compshare-image') {
    const p = node.imageParams!;
    if (!prompt.trim() || [...prompt].length > 7000) throw new Error('Qwen-Image 需要非空提示词，最多 7000 字符');
    if (p.count > 1) throw new Error('此图片协议每个任务只输出一张图片');
    if (refs.length > 10 || refs.some(r => r.kind !== 'image')) throw new Error('此协议最多支持 10 张参考图片');
    const resolution = p.resolution || '1K';
    const config = await request('/image/v1/config');
    if (config.available !== true) throw new Error(config.unavailable_reason || '当前生图服务不可用');
    if (!qwenImageResolutions(config.prices).some(tier => tier === resolution)) throw new Error(`当前生图服务未开放 ${resolution} 档位，请重新测试连接后选择可用规格`);
    if (refs.length && config.reference_moderation_available === false) throw new Error('当前参考图审核不可用，暂时不能提交参考图');
    if (p.advanced.optimizePrompt && config.prompt_optimization_available === false) throw new Error('当前提示词优化不可用，请关闭该选项后生成');
    const remoteRefs: { asset_id: string }[] = [];
    for (const ref of refs) {
      const asset = await getAsset(ref.assetId); if (!asset) throw new Error('参考图片不存在');
      if (!asset.blob.size || asset.blob.size > 30 * MIB) throw new Error('参考图片不能为空或超过 30 MiB');
      const extension = asset.meta.name.split('.').at(-1)?.toLowerCase();
      const contentType = extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg'
        : extension === 'png' ? 'image/png' : extension === 'webp' ? 'image/webp' : '';
      if (!contentType || (asset.blob.type && asset.blob.type !== contentType && asset.blob.type !== 'application/octet-stream')) {
        throw new Error(`「${asset.meta.name}」须为扩展名与格式匹配的 JPG、PNG 或 WebP`);
      }
      const dimensions = await imageDimensions(asset.blob);
      const meta = { file_name: asset.meta.name, content_type: contentType, file_size: asset.blob.size };
      const upload = await request('/image/v1/upload_urls', meta);
      const res = await modelFetch(upload.upload_url, { method: 'PUT', headers: { 'Content-Type': meta.content_type, Authorization: upload.authorization, bucket: upload.bucket, ufile_indicated_region: upload.region }, body: asset.blob, signal });
      if (!res.ok) throw new Error(`参考图上传失败 ${res.status}`);
      const remote = await request('/image/v1/assets', { ...meta, ...dimensions, object_key: upload.object_key });
      const assetId = remote.reference?.asset_id ?? remote.asset_id;
      if (typeof assetId !== 'string' || !assetId) throw new Error('参考图登记失败');
      remoteRefs.push({ asset_id: assetId });
    }
    const data = await request('/image/v1/tasks', { prompt, aspect_ratio: p.aspectRatio || '1:1', resolution, optimize_prompt: Boolean(p.advanced.optimizePrompt), ...(remoteRefs.length ? { reference_images: remoteRefs } : {}) }, true);
    const remoteId = data.task_id; if (!remoteId) throw new Error('服务未返回图片任务编号');
    progress({ remoteId, message: '图片已提交，等待生成' });
    while (true) {
      await wait(); const status = await request(`/image/v1/tasks/${encodeURIComponent(remoteId)}`);
      const task = status.task; if (!task) throw new Error('图片任务响应格式错误');
      if (task.status === 'succeeded') return [await download(task.output_url)];
      if (['failed', 'cancelled', 'blocked'].includes(task.status)) throw new Error(task.error_message || `任务结束：${task.status}`);
      progress({ message: `图片生成中 · ${task.status}` });
    }
  }
  throw new Error('此协议尚未适配生成');
}
