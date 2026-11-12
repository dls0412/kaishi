import { getAsset } from './db';

export async function videoMetadataForAssistant(assetId: string, name: string) {
  const asset = await getAsset(assetId);
  if (!asset?.blob) return { name, durationSeconds: null };
  const url = URL.createObjectURL(asset.blob);
  try {
    return await new Promise<{ name: string; durationSeconds: number | null }>(resolve => {
      const video = document.createElement('video');
      const finish = (durationSeconds: number | null) => {
        clearTimeout(timer); video.onloadedmetadata = null; video.onerror = null;
        video.removeAttribute('src'); video.load(); resolve({ name, durationSeconds });
      };
      const timer = setTimeout(() => finish(null), 8000);
      video.preload = 'metadata';
      video.onloadedmetadata = () => finish(Number.isFinite(video.duration) ? video.duration : null);
      video.onerror = () => finish(null);
      video.src = url;
    });
  } finally { URL.revokeObjectURL(url); }
}
