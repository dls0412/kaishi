import { createInterface } from 'node:readline';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = { type: 'string' };
const tools = [
  { name: 'read_canvas', description: '读取开视当前画布、项目 ID、节点和连线。写操作前先读取。', inputSchema: schema({}) },
  { name: 'list_models', description: '读取可用模型，不返回密钥。', inputSchema: schema({}) },
  { name: 'list_assets', description: '读取当前素材库名称和 ID。', inputSchema: schema({}) },
  { name: 'list_tasks', description: '读取生成任务进度、任务编号和结果素材 ID。', inputSchema: schema({}) },
  { name: 'list_skills', description: '查看 H3 导演和开视本机启用的创作 Skill。', inputSchema: schema({}) },
  { name: 'read_skill', description: '读取指定 Skill 正文，或读取它列出的一个参考文档。', inputSchema: schema({ id: str, resource: str }, ['id']) },
  { name: 'create_node', description: '在画布创建节点；返回实际节点 ID。剧本正文可使用 text 类型与 script 变体。', inputSchema: schema({ type: { enum: ['text', 'image', 'video', 'audio', 'group'] }, variant: { enum: ['script'] }, name: str, text: str, prompt: str, x: { type: 'number' }, y: { type: 'number' }, projectId: str, operationId: str }, ['type', 'projectId', 'operationId']) },
  { name: 'update_node', description: '修改节点名称、文字或位置。', inputSchema: schema({ id: str, patch: schema({ name: str, text: str, x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } }), projectId: str, operationId: str }, ['id', 'patch', 'projectId', 'operationId']) },
  { name: 'connect_nodes', description: '建立真实素材或提示词引用连线。媒体可以填写当前模型支持的参考用途。', inputSchema: schema({ from: str, to: str, role: { enum: ['first-frame', 'last-frame', 'reference-image', 'reference-video', 'reference-audio'] }, projectId: str, operationId: str }, ['from', 'to', 'projectId', 'operationId']) },
  { name: 'set_prompt', description: '设置图片或视频生成提示词。', inputSchema: schema({ id: str, prompt: str, projectId: str, operationId: str }, ['id', 'prompt', 'projectId', 'operationId']) },
  { name: 'set_model', description: '选择 list_models 返回的 modelKey。', inputSchema: schema({ id: str, modelKey: str, projectId: str, operationId: str }, ['id', 'modelKey', 'projectId', 'operationId']) },
  { name: 'set_image_params', description: '为图片节点设置当前模型支持的比例、分辨率或生成数量。', inputSchema: schema({ id: str, aspectRatio: str, resolution: str, count: { type: 'integer' }, projectId: str, operationId: str }, ['id', 'projectId', 'operationId']) },
  { name: 'set_video_params', description: '为视频节点设置模型支持的时长、比例、分辨率、音轨或 H3 Context-IR。', inputSchema: schema({ id: str, duration: { type: 'integer' }, aspectRatio: str, resolution: str, audio: str, useContextIr: { type: 'boolean' }, projectId: str, operationId: str }, ['id', 'projectId', 'operationId']) },
  { name: 'generate_node', description: '调用用户模型服务生成素材并保存到画布，可能消耗供应商额度。仅在用户要求生成时调用。', inputSchema: schema({ id: str, projectId: str, operationId: str }, ['id', 'projectId', 'operationId']) },
  { name: 'resume_task', description: '刷新页面或停止等待后，按 list_tasks 里的远端任务编号续查并领取产物；只查询已有远端任务，不重新提交生成。', inputSchema: schema({ taskId: str, projectId: str, operationId: str }, ['taskId', 'projectId', 'operationId']) },
];
let projectId = '';
async function handle(message) {
  if (!('id' in message)) return;
  const respond = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
  if (message.method === 'initialize') return respond({ protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'kaishi', version: '1.1.0' }, instructions: '开视是本机 AI 画布。先用 read_canvas 读取项目。写操作传 projectId 和唯一 operationId。需要创作规划时，可以用 list_skills 和 read_skill 读取 H3 导演及一项匹配的 Skill。避免重复提交生成。' });
  if (message.method === 'ping') return respond({});
  if (message.method === 'tools/list') return respond({ tools });
  if (message.method === 'resources/list') return respond({ resources: [] });
  if (message.method === 'prompts/list') return respond({ prompts: [] });
  if (message.method === 'tools/call') {
    try {
      const name = message.params?.name;
      if (!tools.some(t => t.name === name)) throw new Error('未知工具');
      const args = message.params.arguments || {};
      const readOnly = ['read_canvas', 'list_models', 'list_assets', 'list_tasks', 'list_skills', 'read_skill'].includes(name);
      if (!readOnly && (!args.projectId || !args.operationId)) throw new Error('写操作需要 projectId 和 operationId');
      const localRuntime = fileURLToPath(new URL('../.local/runtime.json', import.meta.url));
      const desktopRuntime = join(process.env.LOCALAPPDATA || '', 'Kaishi', 'Desktop', '.local', 'runtime.json');
      const runtime = JSON.parse(readFileSync(process.env.KAISHI_RUNTIME_FILE || (existsSync(localRuntime) ? localRuntime : desktopRuntime), 'utf8'));
      const res = await fetch(`${runtime.origin}/api/local/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-kaishi-token': runtime.token }, body: JSON.stringify({ method: name, args, projectId: readOnly ? undefined : args.projectId || projectId || undefined }), signal: AbortSignal.timeout(125000) });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || `HTTP ${res.status}`);
      if (name === 'read_canvas') projectId = result.projectId;
      return respond({ content: [{ type: 'text', text: JSON.stringify(result) }] });
    } catch (error) { return respond({ isError: true, content: [{ type: 'text', text: error.message }] }); }
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }) + '\n');
}
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  try { await handle(JSON.parse(line)); }
  catch { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n'); }
}
