import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';
import { once } from 'node:events';

let received; let fail = false;
const provider = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  received = JSON.parse(Buffer.concat(chunks).toString());
  res.setHeader('content-type', 'application/json');
  if (fail) { res.writeHead(500); return res.end('{}'); }
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reply: '测试完成', actions: [] }) } }] }));
});
await new Promise(r => provider.listen(0, '127.0.0.1', r));
const scratch = mkdtempSync(join(tmpdir(), 'kaishi-context-'));
const runtime = join(scratch, 'runtime.json');
const dev = spawn(process.execPath, [resolve('node_modules/vite/bin/vite.js'), '--port', '5201', '--strictPort'], { env: { ...process.env, KAISHI_RUNTIME_FILE: runtime }, windowsHide: true, stdio: 'ignore' });
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
try {
  let local;
  for (let i = 0; i < 100; i++) {
    try { local = JSON.parse(readFileSync(runtime)); break; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  assert(local, '隔离测试服务未启动');
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(local.origin);
  await page.getByRole('button', { name: '视频生成', exact: true }).click();
  const newProject = page.getByRole('dialog', { name: '新建项目' });
  await newProject.getByLabel('项目名称').fill('隔离助手素材验收');
  await newProject.getByRole('button', { name: '创建', exact: true }).click();
  await page.getByTestId('open-agent').waitFor();
  const video = readFileSync('e2e/fixtures/test-video.mp4').toString('base64');
  const image = readFileSync('e2e/fixtures/test-image.png').toString('base64');
  await page.evaluate(async ({ origin, video, image }) => {
    const { useCanvas } = await import('/src/store.ts');
    const { putAsset, listAssets } = await import('/src/lib/db.ts');
    const { EMPTY_CAPABILITIES } = await import('/src/types.ts');
    const s = useCanvas.getState();
    const service = { id: 'test', name: '测试', protocol: 'openai', baseUrl: origin + '/v1', apiKey: 'test-key', enabled: true, models: [{ id: 'text', name: '测试模型', type: 'text', enabled: true, capabilities: EMPTY_CAPABILITIES }], connection: { status: 'ok', message: '', checkedAt: 0, endpoint: '' }, note: '', createdAt: 0 };
    await useCanvas.getState().setSettings({ ...s.settings, services: [service], defaults: { text: 'test::text' }, assistantSource: 'api' });
    const insert = async (id, kind, data) => {
      const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
      const mime = kind === 'video' ? 'video/mp4' : 'image/png';
      await putAsset({ meta: { id, name: id, mime, size: bytes.length, kind, createdAt: Date.now() }, blob: new Blob([bytes], { type: mime }) });
      return useCanvas.getState().createNode(kind, { x: 100, y: 100 }, { assetId: id, fileName: id, name: id });
    };
    const ids = [await insert('test-video', 'video', video)];
    for (let i = 0; i < 7; i++) ids.push(await insert('test-image-' + i, 'image', image));
    for (let i = 0; i < 20; i++) useCanvas.getState().createNode('text', { x: 100, y: 100 }, { text: '长内容'.repeat(2000), name: `长文本${i}` });
    useCanvas.getState().setAssets(await listAssets()); useCanvas.getState().setSelection(ids);
  }, { origin: `http://127.0.0.1:${provider.address().port}`, video, image });
  await page.getByTestId('open-agent').click();
  const input = page.getByLabel('给开视助手发消息');
  await input.fill('视频多长？请看这七张图');
  await page.getByRole('button', { name: '发送消息' }).click();
  await page.getByText('测试完成', { exact: true }).waitFor();
  const system = received.messages.find(m => typeof m.content === 'string' && m.content.startsWith('当前画布参考资料：')).content;
  const context = JSON.parse(system.slice('当前画布参考资料：'.length).split('\n')[0]);
  assert.equal(context.videoMetadata[0].durationSeconds, 1);
  assert(context.omittedNodes > 0);
  assert.equal(context.nodes.find(n => n.type === 'video').videoParams.duration, 5);
  const user = received.messages.at(-1);
  assert.equal(user.content.filter(part => part.type === 'image_url').length, 7);
  assert(system.includes('本次引用'));
  await page.getByRole('button', { name: '这条消息不带已选节点' }).click();
  await input.fill('继续看刚才的图片');
  await page.getByRole('button', { name: '发送消息' }).click();
  await page.getByText('测试完成', { exact: true }).nth(1).waitFor();
  const followup = received.messages.find(m => typeof m.content === 'string' && m.content.startsWith('当前画布参考资料：')).content;
  assert(followup.includes('之前对话的参考图'));
  assert(!followup.includes('（本次引用）'));
  await page.getByRole('button', { name: '画布素材', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '画布素材' });
  await picker.getByLabel('搜索素材').fill('test-image-0');
  await picker.getByRole('button', { name: /test-image-0/ }).first().click();
  fail = true;
  await input.fill('失败时保留这段文字');
  await page.getByRole('button', { name: '发送消息' }).click();
  await page.getByRole('alert').waitFor();
  assert.equal(await input.inputValue(), '失败时保留这段文字');
  assert.equal(await page.getByRole('button', { name: '移除引用 test-image-0' }).count(), 1);
  console.log('PASS 真实视频时长、7 张图片传递、历史图片区分、失败保留输入和引用');
} finally {
  await browser.close();
  if (dev.exitCode === null) { const closed = once(dev, 'exit'); dev.kill(); await closed; }
  provider.close();
  try { rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
  catch { console.warn(`无法清理隔离测试目录：${scratch}`); }
}
