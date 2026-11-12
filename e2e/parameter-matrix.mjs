// Exercises every advertised ratio and duration through the real frontend adapter against a local mock.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { once } from 'node:events';
import { chromium } from 'playwright-core';

const requests = [];
const png = readFileSync(resolve('e2e/fixtures/test-image.png'));
const video = readFileSync(resolve('e2e/fixtures/test-video.mp4'));
let origin;
const mock = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  let body = {}; try { body = JSON.parse(Buffer.concat(chunks)); } catch {}
  const send = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
  if (req.method === 'POST' && ['/minimax/v2/video_generation', '/image/v1/tasks'].includes(req.url)) {
    requests.push({ path: req.url, body }); return send({ task_id: req.url.includes('minimax') ? 'h3' : 'image' });
  }
  if (req.url === '/image/v1/config') return send({ available: true, prices: { '1K': { base: 1, per_reference: 1 }, '2K': { base: 2, per_reference: 1 } } });
  if (req.url === '/minimax/v2/query/video_generation/h3') return send({ task: { status: 'succeeded', resolution: '480P', content: { url: `${origin}/video` } } });
  if (req.url === '/image/v1/tasks/image') return send({ task: { status: 'succeeded', output_url: `${origin}/image` } });
  if (req.url === '/video') { res.setHeader('Content-Type', 'video/mp4'); return res.end(video); }
  if (req.url === '/image') { res.setHeader('Content-Type', 'image/png'); return res.end(png); }
  res.statusCode = 404; send({ error: 'unknown route' });
});
await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${mock.address().port}`;
const scratch = mkdtempSync(join(tmpdir(), 'kaishi-param-matrix-')); const runtime = join(scratch, 'runtime.json');
const dev = spawn(process.execPath, [resolve('node_modules/vite/bin/vite.js'), '--port', '5196', '--strictPort'], { env: { ...process.env, KAISHI_RUNTIME_FILE: runtime }, windowsHide: true, stdio: 'ignore' });
let browser;
try {
  let state; for (let i = 0; i < 80; i++) { try { state = JSON.parse(readFileSync(runtime)); break; } catch {} await new Promise(r => setTimeout(r, 150)); }
  if (!state) throw new Error('测试服务未启动');
  browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const page = await browser.newPage(); await page.goto(state.origin);
  await page.getByRole('button', { name: '新建画布', exact: true }).waitFor();
  const cases = await page.evaluate(async origin => {
    const { useCanvas } = await import('/src/store.ts');
    const { H3_CAPABILITIES, QWEN_IMAGE_CAPABILITIES } = await import('/src/lib/modelCatalog.ts');
    const { generateNode } = await import('/src/lib/generation.ts');
    await useCanvas.getState().newProject('参数覆盖隔离测试');
    const make = (id, protocol, type, caps) => ({ id, name: id, protocol, baseUrl: origin, apiKey: 'mock-key', enabled: true,
      models: [{ id, name: id, type, enabled: true, capabilities: caps }], connection: { status: 'ok', checkedAt: 0, message: '', endpoint: '', imageResolutions: ['1K', '2K'] }, note: '', createdAt: 0 });
    const services = [make('MiniMax-H3', 'compshare-h3', 'video', H3_CAPABILITIES), make('Qwen-Image', 'compshare-image', 'image', QWEN_IMAGE_CAPABILITIES)];
    await useCanvas.getState().setSettings({ ...useCanvas.getState().settings, services, defaults: { text: '', audio: '', video: 'MiniMax-H3::MiniMax-H3', image: 'Qwen-Image::Qwen-Image' } });
    const expected = []; const jobs = [];
    for (let i = 0; i < H3_CAPABILITIES.durations.length; i++) {
      const id = useCanvas.getState().createNode('video', { x: i * 10, y: 0 });
      const c = { prompt: `H3 matrix ${i}`, duration: H3_CAPABILITIES.durations[i], aspectRatio: H3_CAPABILITIES.ratios[i % 7], resolution: H3_CAPABILITIES.resolutions[i % 5], audio: i % 2 ? 'mute' : 'keep', advanced: { useContextIr: i % 2 === 0, aigcWatermark: i % 3 === 0 } };
      useCanvas.getState().updateNodeParams(id, c); expected.push({ type: 'video', ...c }); jobs.push(generateNode(id));
    }
    for (let i = 0; i < QWEN_IMAGE_CAPABILITIES.ratios.length; i++) {
      const id = useCanvas.getState().createNode('image', { x: i * 10, y: 400 });
      const c = { prompt: `Qwen matrix ${i}`, aspectRatio: QWEN_IMAGE_CAPABILITIES.ratios[i], resolution: i % 2 ? '2K' : '1K', advanced: { optimizePrompt: i % 2 === 0 } };
      useCanvas.getState().updateNodeParams(id, c); expected.push({ type: 'image', ...c }); jobs.push(generateNode(id));
    }
    await Promise.all(jobs); return expected;
  }, origin);
  for (const c of cases) {
    const req = requests.find(r => c.type === 'video' ? r.path.includes('minimax') && r.body.content?.[0]?.text === c.prompt : r.path === '/image/v1/tasks' && r.body.prompt === c.prompt);
    assert(req, `缺少请求 ${c.prompt}`);
    if (c.type === 'video') {
      assert.equal(req.body.ratio, c.aspectRatio); assert.equal(req.body.duration, c.duration); assert.equal(req.body.resolution, c.resolution);
      assert.equal(req.body.mute_audio, c.audio === 'mute'); assert.equal(req.body.use_context_ir, c.advanced.useContextIr); assert.equal(req.body.aigc_watermark, c.advanced.aigcWatermark);
    } else { assert.equal(req.body.aspect_ratio, c.aspectRatio); assert.equal(req.body.resolution, c.resolution); assert.equal(req.body.optimize_prompt, c.advanced.optimizePrompt); }
  }
  console.log(`PASS 本地模拟参数矩阵：${cases.filter(c => c.type === 'video').length} 个 H3 时长覆盖所有比例、分辨率及开关；${cases.filter(c => c.type === 'image').length} 个 Qwen 比例覆盖两个分辨率与优化开关`);
} finally {
  await browser?.close();
  if (dev.exitCode === null && dev.signalCode === null) { const exited = once(dev, 'exit'); dev.kill(); await exited; }
  await new Promise(resolve => mock.close(resolve));
  if (dirname(resolve(scratch)) === resolve(tmpdir()) && basename(scratch).startsWith('kaishi-param-matrix-')) {
    try { rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { console.error('隔离目录清理失败：' + scratch); }
  }
}
