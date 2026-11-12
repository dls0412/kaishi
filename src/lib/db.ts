import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  type AppSettings,
  type AssetMeta,
  type AssetRecord,
  type ProjectData,
  type ProjectMeta,
  type ProjectSummary,
} from '../types';
import { mergeBuiltinSkills } from './skillCatalog';

const DB_NAME = 'infinite-canvas-studio';
const DB_VERSION = 1;
const S_PROJECTS = 'projects';
const S_ASSETS = 'assets';
const S_KV = 'kv';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(S_PROJECTS)) db.createObjectStore(S_PROJECTS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(S_ASSETS)) db.createObjectStore(S_ASSETS, { keyPath: 'meta.id' });
      if (!db.objectStoreNames.contains(S_KV)) db.createObjectStore(S_KV, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('无法打开本地数据库'));
  }).catch((err) => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

async function request<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDB();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    let result: T;
    let failed = false;
    const req = fn(transaction.objectStore(store));
    req.onsuccess = () => { result = req.result; };
    req.onerror = () => { failed = true; reject(req.error ?? new Error('数据库操作失败')); };
    transaction.oncomplete = () => { if (!failed) resolve(result); };
    transaction.onabort = () => { if (!failed) reject(transaction.error ?? new Error('事务已中止')); };
  });
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const all = await request<ProjectMeta[]>(S_PROJECTS, 'readonly', (s) => s.getAll());
  return all
    .map((p) => ({
      id: p.id,
      name: p.name,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      nodeCount: p.data?.nodes?.length ?? 0,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getProject(id: string): Promise<ProjectMeta | undefined> {
  return request<ProjectMeta | undefined>(S_PROJECTS, 'readonly', (s) => s.get(id));
}

export async function getAllProjectsWithData(): Promise<ProjectMeta[]> {
  return request<ProjectMeta[]>(S_PROJECTS, 'readonly', (s) => s.getAll());
}

export async function saveProject(project: ProjectMeta): Promise<void> {
  await request<IDBValidKey>(S_PROJECTS, 'readwrite', (s) => s.put(project));
}

export async function deleteProject(id: string): Promise<void> {
  await request<undefined>(S_PROJECTS, 'readwrite', (s) => s.delete(id));
}

export async function putAsset(record: AssetRecord): Promise<void> {
  await request<IDBValidKey>(S_ASSETS, 'readwrite', (s) => s.put(record));
}

export async function getAsset(id: string): Promise<AssetRecord | undefined> {
  return request<AssetRecord | undefined>(S_ASSETS, 'readonly', (s) => s.get(id));
}

export async function listAssets(): Promise<AssetMeta[]> {
  const all = await request<AssetRecord[]>(S_ASSETS, 'readonly', (s) => s.getAll());
  return all.map((r) => r.meta).sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteAsset(id: string): Promise<void> {
  await request<undefined>(S_ASSETS, 'readwrite', (s) => s.delete(id));
  invalidateAssetUrl(id);
}

async function getKV<T>(key: string): Promise<T | undefined> {
  const row = await request<{ key: string; value: T } | undefined>(S_KV, 'readonly', (s) => s.get(key));
  return row?.value;
}

async function setKV<T>(key: string, value: T): Promise<void> {
  await request<IDBValidKey>(S_KV, 'readwrite', (s) => s.put({ key, value }));
}

export async function loadSettings(): Promise<AppSettings> {
  const saved = await getKV<unknown>('settings');
  const settings = normalizeSettings({ ...DEFAULT_SETTINGS, ...(saved as object) });
  // 内置技能在读取时补齐，用户已有的启用状态与私人改写原样保留
  return mergeBuiltinSkills(settings);
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await setKV('settings', settings);
}

export async function loadLastProjectId(): Promise<string | null> {
  return (await getKV<string>('lastProjectId')) ?? null;
}

export async function saveLastProjectId(id: string): Promise<void> {
  await setKV('lastProjectId', id);
}

const urlCache = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();

export function getAssetUrl(id: string): Promise<string | null> {
  const cached = urlCache.get(id);
  if (cached) return Promise.resolve(cached);
  const pending = inflight.get(id);
  if (pending) return pending;
  const task = getAsset(id)
    .then((record) => {
      if (!record) return null;
      const url = URL.createObjectURL(record.blob);
      urlCache.set(id, url);
      return url;
    })
    .finally(() => inflight.delete(id));
  inflight.set(id, task);
  return task;
}

export function invalidateAssetUrl(id: string): void {
  const url = urlCache.get(id);
  if (url) {
    URL.revokeObjectURL(url);
    urlCache.delete(id);
  }
}

export function clearAssetUrlCache(): void {
  urlCache.forEach((url) => URL.revokeObjectURL(url));
  urlCache.clear();
}

/* 同步镜像：每次画布状态变更立即写入 localStorage，防止改动后立刻刷新丢失 */
const MIRROR_KEY = 'infinite-canvas-studio:mirror';

export interface ProjectMirror {
  projectId: string;
  projectName: string;
  updatedAt: number;
  data: ProjectData;
}

export function readMirror(): ProjectMirror | null {
  try {
    const raw = localStorage.getItem(MIRROR_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ProjectMirror;
    if (!parsed?.projectId || !parsed?.data || !Array.isArray(parsed.data.nodes)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeMirror(mirror: ProjectMirror): void {
  try {
    localStorage.setItem(MIRROR_KEY, JSON.stringify(mirror));
  } catch (err) {
    console.warn('本地镜像写入失败', err);
  }
}

export function clearMirror(): void {
  try { localStorage.removeItem(MIRROR_KEY); } catch { /* ignore */ }
}
