import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { chromium } from 'playwright-core';

const video = readFileSync('e2e/fixtures/test-video.mp4');
let submits = 0; let finish = false; let origin;
const provider = createServer(async (req, res) => {
  for await (const _ of req) { /* drain */ }
  if (req.url === '/output.mp4') { res.setHeader('content-type', 'video/mp4'); return res.end(video); }
  res.setHeader('content-type', 'application/json');
  if (req.url === '/minimax/v2/video_generation') return res.end(JSON.stringify({ task_id: `task-${++submits}` }));
  if (req.url?.startsWith('/minimax/v2/query/video_generation/')) return res.end(JSON.stringify({ task: finish ? { status: 'succeeded', resolution: '768P', content: { url: `${origin}/output.mp4` } } : { status: 'processing' } }));
  res.writeHead(404); res.end('{}');
});
await new Promise(r => provider.listen(0, '127.0.0.1', r)); origin = `http://127.0.0.1:${provider.address().port}`;
const scratch = mkdtempSync(join(tmpdir(), 'kaishi-recovery-')); const runtime = join(scratch, 'runtime.json');
const dev = spawn(process.execPath, [resolve('node_modules/vite/bin/vite.js'), '--port', '5202', '--strictPort'], { env: { ...process.env, KAISHI_RUNTIME_FILE: runtime }, windowsHide: true, stdio: 'ignore' });
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
try {
  let local; for (let i = 0; i < 100; i++) { try { local = JSON.parse(readFileSync(runtime)); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  assert(local);
  const page = await browser.newPage(); await page.goto(local.origin);
  await page.getByRole('button', { name: '视频生成', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建项目' });
  await dialog.getByLabel('项目名称').fill('任务恢复隔离测试'); await dialog.getByRole('button', { name: '创建', exact: true }).click();
  const ids = await page.evaluate(async origin => {
    const { useCanvas } = await import('/src/store.ts');
    const { H3_CAPABILITIES } = await import('/src/lib/modelCatalog.ts');
    const state = useCanvas.getState();
    const service = { id: 'test-h3', name: '测试', protocol: 'compshare-h3', baseUrl: origin, apiKey: 'test-key', enabled: true, models: [{ id: 'MiniMax-H3', name: 'H3', type: 'video', enabled: true, capabilities: H3_CAPABILITIES }], connection: { status: 'ok', message: '', checkedAt: 0, endpoint: '' }, note: '', createdAt: 0 };
    await state.setSettings({ ...state.settings, services: [service], defaults: { video: 'test-h3::MiniMax-H3' } });
    const id = useCanvas.getState().createNode('video', { x: 0, y: 0 }, { name: '恢复验收' });
    useCanvas.getState().updateNodeParams(id, { prompt: '视频恢复验收' }); await useCanvas.getState().persist();
    void (await import('/src/lib/generation.ts')).generateNode(id).catch(() => {});
    return { id, project: useCanvas.getState().projectId };
  }, origin);
  await page.evaluate(async () => { window.__gen = (await import('/src/lib/generation.ts')).useGeneration; window.__canvas = (await import('/src/store.ts')).useCanvas; });
  await page.waitForFunction(() => window.__gen.getState().tasks.some(t => t.remoteId === 'task-1'));
  finish = true; await page.reload();
  await page.evaluate(async () => { window.__gen = (await import('/src/lib/generation.ts')).useGeneration; window.__canvas = (await import('/src/store.ts')).useCanvas; });
  await page.waitForFunction(id => window.__canvas.getState().nodes.some(n => n.id === id && n.assetId), ids.id, { timeout: 30000 });
  await page.waitForFunction(() => window.__gen.getState().tasks.some(t => t.remoteId === 'task-1' && t.status === 'completed'));
  assert.equal(submits, 1, '重开只能查询，不能重复提交');
  const recovered = await page.evaluate(async id => { const st = (await import('/src/store.ts')).useCanvas.getState(); const tasks = (await import('/src/lib/generation.ts')).useGeneration.getState().tasks; return { node: st.nodes.find(n => n.id === id), task: tasks.find(t => t.remoteId === 'task-1') }; }, ids.id);
  assert.equal(recovered.task.status, 'completed'); assert.equal(recovered.node.assetId, recovered.task.assetIds[0]);
  finish = false;
  const otherId = await page.evaluate(async () => {
    const { useCanvas } = await import('/src/store.ts');
    const id = useCanvas.getState().createNode('video', { x: 200, y: 200 }, { name: '跨项目恢复' });
    useCanvas.getState().updateNodeParams(id, { prompt: '测试切换项目' }); await useCanvas.getState().persist();
    void (await import('/src/lib/generation.ts')).generateNode(id).catch(() => {}); return id;
  });
  await page.waitForFunction(() => window.__gen.getState().tasks.some(t => t.remoteId === 'task-2'));
  await page.evaluate(async () => { await window.__canvas.getState().newProject('另一个项目'); });
  finish = true;
  await page.waitForFunction(() => window.__gen.getState().tasks.some(t => t.remoteId === 'task-2' && t.status === 'completed' && t.deliveryPending), null, { timeout: 30000 });
  await page.evaluate(async project => { await window.__canvas.getState().switchProject(project); }, ids.project);
  await page.waitForFunction(id => window.__canvas.getState().nodes.some(n => n.id === id && n.assetId), otherId).catch(async e => {
    console.log('恢复诊断', JSON.stringify(await page.evaluate(id => ({ project: window.__canvas.getState().projectId, nodes: window.__canvas.getState().nodes.map(n => ({ id: n.id, name: n.name, assetId: n.assetId })), task: window.__gen.getState().tasks.find(t => t.remoteId === 'task-2'), id }), otherId))); throw e;
  });
  await page.evaluate(async () => {
    const { useCanvas } = await import('/src/store.ts'); const st = useCanvas.getState();
    const { applyAssistantActions } = await import('/src/lib/localBridge.ts');
    await applyAssistantActions([
      { method: 'create_node', args: { type: 'video', name: '镜头一', prompt: '第一个镜头', ref: 'shot1' } },
      { method: 'create_node', args: { type: 'video', name: '镜头二', prompt: '第二个镜头', ref: 'shot2' } },
      { method: 'generate_node', args: { id: '$shot1' } },
      { method: 'generate_node', args: { id: '$shot2' } },
    ], st.projectId);
  });
  await page.waitForFunction(() => window.__gen.getState().tasks.filter(t => ['镜头一', '镜头二'].includes(t.name) && t.status === 'completed').length === 2, null, { timeout: 30000 });
  const shots = await page.evaluate(async () => (await import('/src/store.ts')).useCanvas.getState().nodes.filter(n => ['镜头一', '镜头二'].includes(n.name)).map(n => ({ id: n.id, assetId: n.assetId })));
  assert.equal(shots.length, 2); assert.notEqual(shots[0].id, shots[1].id); assert(shots.every(s => s.assetId)); assert.equal(submits, 4);
  console.log('PASS 重开自动续查、切换项目后回写；两个镜头独立节点和任务');
} finally {
  await browser.close(); if (dev.exitCode === null) { const closed = once(dev, 'exit'); dev.kill(); await closed; } provider.close();
  try { rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { console.warn(`无法清理隔离测试目录：${scratch}`); }
}
