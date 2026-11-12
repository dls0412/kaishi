import type { AssetKind, CanvasNode, Viewport } from '../types';

export function uid(prefix = 'n'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export function screenToWorld(sx: number, sy: number, vp: Viewport): { x: number; y: number } {
  return { x: (sx - vp.x) / vp.zoom, y: (sy - vp.y) / vp.zoom };
}

export function worldToScreen(wx: number, wy: number, vp: Viewport): { x: number; y: number } {
  return { x: wx * vp.zoom + vp.x, y: wy * vp.zoom + vp.y };
}

export function rectsIntersect(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** Find room for a new card without reordering cards already on the canvas. */
export function freeCanvasPosition(nodes: Pick<CanvasNode, 'x' | 'y' | 'w' | 'h' | 'type'>[], origin: { x: number; y: number }, size: { w: number; h: number }) {
  const cards = nodes.filter(n => n.type !== 'group');
  const gap = 36;
  const free = (x: number, y: number) => !cards.some(n => rectsIntersect({ x: x - gap, y: y - gap, w: size.w + gap * 2, h: size.h + gap * 2 }, n));
  for (let ring = 0; ring <= 12; ring++) {
    for (let row = 0; row <= ring; row++) {
      const x = origin.x + (ring - row) * (size.w + gap);
      const y = origin.y + row * (size.h + gap);
      if (free(x, y)) return { x, y };
    }
  }
  return { x: origin.x, y: Math.max(origin.y, ...cards.map(n => n.y + n.h + gap)) };
}

export function nodeCenter(n: CanvasNode): { x: number; y: number } {
  return { x: n.x + n.w / 2, y: n.y + n.h / 2 };
}

export interface EdgePath {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  d: string;
  mx: number;
  my: number;
}

export function edgePath(from: CanvasNode, to: CanvasNode): EdgePath {
  const a = nodeCenter(from);
  const b = nodeCenter(to);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let x1: number, y1: number, x2: number, y2: number, c1x: number, c1y: number, c2x: number, c2y: number;
  if (Math.abs(dx) >= Math.abs(dy)) {
    const sign = dx >= 0 ? 1 : -1;
    x1 = a.x + (sign * from.w) / 2;
    y1 = a.y;
    x2 = b.x - (sign * to.w) / 2;
    y2 = b.y;
    const bend = Math.max(48, Math.abs(x2 - x1) * 0.45);
    c1x = x1 + sign * bend;
    c1y = y1;
    c2x = x2 - sign * bend;
    c2y = y2;
  } else {
    const sign = dy >= 0 ? 1 : -1;
    x1 = a.x;
    y1 = a.y + (sign * from.h) / 2;
    x2 = b.x;
    y2 = b.y - (sign * to.h) / 2;
    const bend = Math.max(48, Math.abs(y2 - y1) * 0.45);
    c1x = x1;
    c1y = y1 + sign * bend;
    c2x = x2;
    c2y = y2 - sign * bend;
  }
  return {
    x1, y1, x2, y2,
    d: `M ${x1} ${y1} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${x2} ${y2}`,
    mx: (x1 + x2) / 2,
    my: (y1 + y2) / 2,
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function detectAssetKind(file: File): AssetKind | null {
  const mime = file.type.toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif'].includes(ext)) return 'image';
  if (['mp4', 'webm', 'mov', 'm4v', 'ogv', 'avi', 'mkv'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'opus'].includes(ext)) return 'audio';
  return null;
}

export function guessMime(file: File, kind: AssetKind): string {
  if (file.type) return file.type;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4',
    mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac',
  };
  return map[ext] ?? (kind === 'image' ? 'image/png' : kind === 'video' ? 'video/mp4' : 'audio/mpeg');
}

export function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || '未命名项目';
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
