import { create } from 'zustand';
import { useCanvas } from '../store';
import { availableModels, capabilitiesOf, findBinding, fitParamsToCapabilities } from './models';
import { codexCaps, generateNode, generationSupport, prepareGeneration, resumeGeneration, useGeneration } from './generation';
import { CODEX_IMAGE, useCodexAccount } from './codexAccount';
import { setLocalToken } from './modelTransport';
import { NODE_DEFAULTS, ROLE_KINDS, type ModelType, type NodeType, type ReferenceRole, type VideoGenParams } from '../types';
import { freeCanvasPosition } from './utils';
import { canvasApi } from './canvasApi';
import { H3_DIRECTOR, H3_DIRECTOR_ID, h3ResourcePaths, readH3Resource } from './h3SkillLibrary';

interface Connection { projectId: string; online: boolean; active: boolean; clientSeen: boolean; error: string; node: string; script: string }
export const useLocalBridge = create<Connection>(() => ({ projectId: '', online: false, active: false, clientSeen: false, error: '', node: '', script: '' }));
const tabId = crypto.randomUUID();
let token = '';
let setActive: (() => Promise<void>) | null = null;
export const activateBridge = () => setActive?.();
type Input = Record<string, unknown>;
const receipts = new Map<string, { payload: string; promise: Promise<unknown> }>();
type StoredReceipt = { digest: string; status: 'pending' | 'done' | 'failed'; result?: unknown; error?: string };
function readReceipts(): Record<string, StoredReceipt> {
  try { return JSON.parse(localStorage.getItem('kaishi:receipts') || '{}'); } catch { return {}; }
}
function storeReceipt(key: string, value: StoredReceipt) {
  const entries = Object.entries(readReceipts()).filter(([id]) => id !== key);
  localStorage.setItem('kaishi:receipts', JSON.stringify(Object.fromEntries([...entries.slice(-499), [key, value]])));
}
const text = (v: unknown) => typeof v === 'string' ? v : '';

export async function runCanvasOperation(method: string, args: Input = {}): Promise<unknown> {
  const st = useCanvas.getState();
  // 只读操作也要拒绝过期项目号，否则外部 Agent 会拿到另一个项目的数据却以为是当前项目。
  const suppliedProject = text(args.projectId);
  if (suppliedProject && suppliedProject !== st.projectId) throw new Error('项目已切换，请重新读取画布');
  if (method === 'read_canvas') return { projectId: st.projectId, project: st.projectName, nodes: st.nodes, edges: st.edges, selection: st.selection };
  if (method === 'list_models') return (['text', 'image', 'video', 'audio'] as ModelType[]).flatMap(type => availableModels(st.settings, type).map(model => {
    const binding = findBinding(st.settings, model.key);
    return { modelKey: model.key, name: model.label, type, protocol: binding?.service.protocol, capabilities: binding?.model.capabilities };
  }));
  if (method === 'list_assets') return st.assets;
  if (method === 'list_tasks') return useGeneration.getState().tasks.filter(t => t.projectId === st.projectId);
  if (method === 'list_skills') return [
    { id: H3_DIRECTOR_ID, name: 'H3 导演', description: '按创作目标选择一个 Skill，编排镜头、素材和 H3 参数' },
    ...st.settings.skills.filter(skill => skill.enabled).map(skill => ({
      id: skill.id, name: skill.name, description: skill.description, resources: h3ResourcePaths(skill.id),
    })),
  ];
  if (method === 'read_skill') {
    const id = text(args.id);
    const resource = text(args.resource);
    if (id === H3_DIRECTOR_ID && !resource) return { id, body: H3_DIRECTOR };
    const skill = st.settings.skills.find(item => item.id === id && item.enabled);
    if (!skill) throw new Error('技能不存在或已停用');
    return { id, name: skill.name, resource, body: resource ? await readH3Resource(id, resource) : skill.body, resources: h3ResourcePaths(id) };
  }
  if (args.projectId !== st.projectId) throw new Error('项目已切换，请重新读取画布');
  const operationId = text(args.operationId);
  if (!operationId) throw new Error('写操作缺少 operationId');
  const key = `${st.projectId}:${operationId}`;
  const payload = JSON.stringify({ method, args });
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  const digest = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
  const receipt = receipts.get(key);
  if (receipt) { if (receipt.payload !== payload) throw new Error('operationId 已用于其他操作'); return receipt.promise; }
  const stored = readReceipts()[key];
  if (stored) {
    if (stored.digest !== digest) throw new Error('operationId 已用于其他操作');
    if (stored.status === 'done') return stored.result;
    throw new Error(stored.error || '上次操作尚未确认完成，请读取画布和任务记录核对，避免重复提交');
  }
  storeReceipt(key, { digest, status: 'pending' });
  const promise = Promise.resolve().then(async () => {
    if (useCanvas.getState().projectId !== args.projectId) throw new Error('项目已切换');
    const result = await mutateCanvas(method, args);
    if (method !== 'generate_node' && method !== 'resume_task') {
      await useCanvas.getState().persist();
      if (useCanvas.getState().saveStatus === 'error') throw new Error('修改已应用，但保存失败；请保留当前页面并重试保存');
    }
    return result;
  });
  receipts.set(key, { payload, promise });
  void promise.then(result => storeReceipt(key, { digest, status: 'done', result }), error => storeReceipt(key, { digest, status: 'failed', error: error.message })).finally(() => receipts.delete(key)).catch(() => {});
  return promise;
}

function mutateCanvas(method: string, args: Input) {
  const st = useCanvas.getState();
  const id = text(args.id);
  const node = st.nodes.find(n => n.id === id);
  switch (method) {
    case 'create_node': {
      if (!['text', 'image', 'video', 'audio', 'group'].includes(text(args.type))) throw new Error('节点类型不支持');
      const type = args.type as NodeType;
      const size = NODE_DEFAULTS[type];
      const center = canvasApi.centerWorld();
      const at = typeof args.x === 'number' && Number.isFinite(args.x) && typeof args.y === 'number' && Number.isFinite(args.y)
        ? { x: args.x, y: args.y }
        : freeCanvasPosition(st.nodes, { x: center.x - size.w / 2, y: center.y - size.h / 2 }, size);
      const newId = st.createNode(type, { x: at.x + size.w / 2, y: at.y + size.h / 2 }, { ...(text(args.name) ? { name: text(args.name) } : {}), ...(type === 'text' && args.variant === 'script' ? { variant: 'script' as const } : {}), ...(type === 'text' && typeof args.text === 'string' ? { text: args.text } : {}) });
      if (['image', 'video'].includes(text(args.type)) && text(args.prompt)) st.updateNodeParams(newId, { prompt: text(args.prompt) });
      return { id: newId };
    }
    case 'update_node': {
      if (!node) throw new Error('节点不存在');
      const patch = args.patch as Input;
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('patch 格式错误');
      for (const [k, v] of Object.entries(patch)) {
        if (!['name', 'text', 'x', 'y', 'w', 'h'].includes(k)) throw new Error(`不可修改字段 ${k}`);
        if (['x', 'y', 'w', 'h'].includes(k) && (typeof v !== 'number' || !Number.isFinite(v) || (['w', 'h'].includes(k) && v < 40))) throw new Error('位置或尺寸无效');
        if (['name', 'text'].includes(k) && typeof v !== 'string') throw new Error('名称或文字无效');
        if (k === 'text' && node.type !== 'text') throw new Error('仅文字节点可以修改 text');
      }
      st.updateNode(id, patch); break;
    }
    case 'connect_nodes': {
      const from = text(args.from), to = text(args.to);
      const source = st.nodes.find(item => item.id === from);
      const target = st.nodes.find(item => item.id === to);
      if (from === to || !source || !target) throw new Error('连线节点无效');
      const role = text(args.role) as ReferenceRole;
      const params = target.type === 'video' ? target.videoParams : target.type === 'image' ? target.imageParams : undefined;
      const caps = params?.modelKey === CODEX_IMAGE ? codexCaps : capabilitiesOf(st.settings, params?.modelKey || '');
      if (role && (!params || ROLE_KINDS[role] !== source.type || !caps?.roles.includes(role))) {
        throw new Error('当前模型或素材类型不支持这个参考用途');
      }
      if (!st.edges.some(edge => edge.from === from && edge.to === to)) st.addEdge(from, to);
      const edge = useCanvas.getState().edges.find(item => item.from === from && item.to === to);
      if (edge && role && params) st.updateNodeParams(to, { edgeRoles: { ...params.edgeRoles, [edge.id]: role } });
      break;
    }
    case 'set_prompt':
    case 'set_model': {
      if (!node || (node.type !== 'image' && node.type !== 'video')) throw new Error('请选择图片或视频节点');
      if (method === 'set_model') {
        const modelKey = text(args.modelKey);
        const codexAvailable = node.type === 'image' && modelKey === CODEX_IMAGE && Boolean(useCodexAccount.getState().status?.account);
        if (!codexAvailable && !availableModels(st.settings, node.type).some(m => m.key === modelKey)) throw new Error('该模型不可用');
        const caps = codexAvailable ? codexCaps : capabilitiesOf(st.settings, modelKey);
        const params = node.type === 'image' ? node.imageParams : node.videoParams;
        st.updateNodeParams(id, caps && params ? fitParamsToCapabilities({ ...params, modelKey }, caps, node.type).params : { modelKey });
      } else st.updateNodeParams(id, { prompt: text(args.prompt) });
      break;
    }
    case 'generate_node': {
      if (!node || (node.type !== 'image' && node.type !== 'video')) throw new Error('请选择图片或视频节点');
      const reason = generationSupport(node); if (reason) throw new Error(reason);
      if (useGeneration.getState().tasks.some(t => t.projectId === st.projectId && t.nodeId === id && t.status === 'running')) throw new Error('节点正在生成，请查询任务进度');
      const result = generateNode(id); result.catch(() => {});
      const task = useGeneration.getState().tasks[0];
      if (!task || task.nodeId !== id || task.status !== 'running') return result;
      return { taskId: task.id, status: task.status, note: '已启动，通过 list_tasks 查询结果；不要重复提交' };
    }
    case 'resume_task': {
      const taskId = text(args.taskId);
      const task = useGeneration.getState().tasks.find(item => item.id === taskId && item.projectId === st.projectId);
      if (!task) throw new Error('任务不存在或不属于当前项目');
      if (task.status === 'running') throw new Error('任务仍在运行');
      if (!task.remoteId || !task.resume) throw new Error('此任务没有可续查的远端编号');
      const result = resumeGeneration(taskId); result.catch(() => {});
      return { taskId, status: 'running', note: '已开始续查远端任务，通过 list_tasks 查询结果；不要重复提交' };
    }
    case 'set_image_params': {
      if (node?.type !== 'image' || !node.imageParams) throw new Error('请选择图片生成节点');
      const params = node.imageParams;
      const key = params.modelKey || st.settings.defaults.image || '';
      const caps = key === CODEX_IMAGE && useCodexAccount.getState().status?.account ? codexCaps : capabilitiesOf(st.settings, key);
      if (!caps) throw new Error('请先选择可用的图片模型');
      const patch: Record<string, unknown> = {};
      for (const [field, choices] of [['aspectRatio', caps.ratios], ['resolution', caps.resolutions]] as const) {
        if (args[field] === undefined) continue;
        if (typeof args[field] !== 'string' || !choices.includes(args[field] as string)) throw new Error(`当前模型不支持该参数：${field}`);
        patch[field] = args[field];
      }
      if (args.count !== undefined) {
        if (typeof args.count !== 'number' || !Number.isInteger(args.count) || args.count < 1 || args.count > caps.maxCount) throw new Error('当前模型不支持该图片数量');
        patch.count = args.count;
      }
      st.updateNodeParams(id, patch);
      break;
    }
    case 'set_video_params': {
      if (node?.type !== 'video' || !node.videoParams) throw new Error('请选择视频生成节点');
      const current = node.videoParams;
      const binding = findBinding(st.settings, current.modelKey);
      if (!binding?.service.enabled || !binding.model.enabled) throw new Error('请先选择已启用的视频模型');
      const caps = binding.model.capabilities;
      const patch: Partial<VideoGenParams> = {};
      if (args.duration !== undefined) {
        if (typeof args.duration !== 'number' || !caps.durations.includes(args.duration)) throw new Error('当前模型不支持该时长');
        patch.duration = args.duration;
      }
      for (const [key, supported] of [['aspectRatio', caps.ratios], ['resolution', caps.resolutions], ['audio', caps.audioOptions.map(option => option.id)]] as const) {
        const value = args[key];
        if (value === undefined) continue;
        if (typeof value !== 'string' || !supported.includes(value)) throw new Error(`当前模型不支持该参数：${key}`);
        patch[key] = value;
      }
      if (args.useContextIr !== undefined) {
        if (typeof args.useContextIr !== 'boolean' || binding.service.protocol !== 'compshare-h3') throw new Error('Context-IR 仅适用于 MiniMax H3');
        patch.advanced = { ...current.advanced, useContextIr: args.useContextIr };
      }
      st.updateNodeParams(id, patch);
      break;
    }
    default: throw new Error('未知画布操作');
  }
  return { ok: true };
}

export async function applyAssistantActions(actions: { method: string; args: Input }[], projectId: string): Promise<void> {
  const st = useCanvas.getState();
  if (st.projectId !== projectId) throw new Error('项目已切换，请在原项目中应用');
  const previous = { nodes: st.nodes, edges: st.edges, selection: st.selection, selectedEdgeId: st.selectedEdgeId, past: st.past, future: st.future };
  const refs = new Map<string, string>();
  const createdIds: string[] = [];
  const generationIds: string[] = [];
  try {
    for (const action of actions) {
      if (!['create_node', 'update_node', 'connect_nodes', 'set_prompt', 'set_model', 'set_image_params', 'set_video_params', 'generate_node'].includes(action.method)) throw new Error('方案包含不支持的操作');
      const args = { ...action.args };
      for (const key of ['id', 'from', 'to']) {
        const value = args[key];
        if (typeof value === 'string' && value.startsWith('$')) {
          const id = refs.get(value.slice(1));
          if (!id) throw new Error('方案引用了不存在的新节点');
          args[key] = id;
        }
      }
      if (action.method === 'generate_node') {
        const target = useCanvas.getState().nodes.find(node => node.id === args.id);
        if (!target || (target.type !== 'image' && target.type !== 'video')) throw new Error('请选择图片或视频节点');
        const reason = generationSupport(target); if (reason) throw new Error(reason);
        if (useGeneration.getState().tasks.some(task => task.projectId === projectId && task.nodeId === target.id && task.status === 'running')) throw new Error('节点正在生成');
        if (generationIds.includes(target.id)) throw new Error('同一个节点不能同时提交多个生成任务');
        prepareGeneration(target.id);
        generationIds.push(target.id);
        continue;
      }
      if (generationIds.length) throw new Error('生成操作必须放在方案最后');
      if (action.method === 'create_node' && typeof args.ref === 'string' && refs.has(args.ref)) throw new Error('方案中新节点的引用名重复');
      const result = mutateCanvas(action.method, args);
      if (action.method === 'create_node' && result && 'id' in result && typeof result.id === 'string') createdIds.push(result.id);
      if (typeof args.ref === 'string' && result && 'id' in result && typeof result.id === 'string') refs.set(args.ref, result.id);
    }
  } catch (error) {
    useCanvas.setState(previous);
    throw error;
  }
  if (st.nodes !== useCanvas.getState().nodes || st.edges !== useCanvas.getState().edges) {
    useCanvas.setState({ past: [...st.past, { nodes: st.nodes, edges: st.edges }].slice(-80), future: [] });
  }
  if (createdIds.length === 1) {
    const state = useCanvas.getState();
    const created = state.nodes.find(node => node.id === createdIds[0]);
    const view = canvasApi.viewportSize();
    if (created) {
      const { x, y, zoom } = state.viewport;
      const left = x + created.x * zoom, top = y + created.y * zoom;
      if (left < 0 || top < 0 || left + created.w * zoom > view.w || top + created.h * zoom > view.h - 120) {
        state.setViewport({ zoom, x: view.w / 2 - (created.x + created.w / 2) * zoom, y: view.h * 0.36 - (created.y + created.h / 2) * zoom });
      }
    }
  }
  await useCanvas.getState().persist();
  for (const generationId of generationIds) {
    // Starts only after the complete plan has been checked and saved; task errors stay visible in the generation list.
    void generateNode(generationId).catch(() => {});
    if (!useGeneration.getState().tasks.some(task => task.projectId === projectId && task.nodeId === generationId && task.status === 'running')) {
      throw new Error('生成未启动，请检查节点提示词和参考素材');
    }
  }
}

export function installLocalBridge() {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  let heartbeatAt = 0;
  let heartbeatProjectId = '';
  let bootstrapped = false;
  const controller = new AbortController();
  const request = async (route: string, value?: unknown) => {
    const res = await fetch(`/api/local/${route}`, { method: value === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'x-kaishi-token': token }, body: value === undefined ? undefined : JSON.stringify(value), signal: controller.signal });
    if (!res.ok) throw new Error('本机连接服务不可用，请通过“启动开视”打开');
    return res.json();
  };
  const heartbeat = async (active = false) => {
    const st = useCanvas.getState();
    const state = await request('heartbeat', { tabId, projectId: st.projectId, project: st.projectName, active });
    heartbeatAt = Date.now();
    heartbeatProjectId = st.projectId;
    useLocalBridge.setState({ projectId: st.projectId, online: true, active: state.active, clientSeen: state.clients, error: '' });
  };
  const activate = async () => { if (bootstrapped) await heartbeat(true).catch(() => {}); };
  setActive = activate;
  const loop = async () => {
    try {
      if (!useCanvas.getState().ready) return;
      if (!bootstrapped) {
        const data = await request('bootstrap', {}); token = data.token; setLocalToken(token);
        useLocalBridge.setState({ node: data.node, script: data.script }); bootstrapped = true;
      }
      if (heartbeatProjectId !== useCanvas.getState().projectId || Date.now() - heartbeatAt > 2000) await heartbeat();
      const tasks = await request(`poll?tab=${encodeURIComponent(tabId)}`);
      for (const task of tasks) {
        if (stopped) break;
        void (async () => {
        let result, error;
        try {
          if (task.deadline < Date.now() || task.projectId !== useCanvas.getState().projectId) throw new Error('操作已过期或项目已切换');
          result = await runCanvasOperation(task.method, task.args);
        } catch (err) { error = err instanceof Error ? err.message : String(err); }
        await request('result', { id: task.id, tabId, result, error });
        })().catch(() => {});
      }
    } catch (err) {
      if (!stopped) { bootstrapped = false; useLocalBridge.setState({ online: false, error: err instanceof Error ? err.message : String(err) }); }
    } finally { if (!stopped) timer = setTimeout(loop, bootstrapped ? 500 : 3000); }
  };
  void loop();
  return () => { stopped = true; clearTimeout(timer); controller.abort(); if (setActive === activate) setActive = null; };
}
