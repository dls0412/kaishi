import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';

const reports = [];
const passed = name => { reports.push(name); console.log(`PASS ${name}`); };
const requests = [];
const png = readFileSync(new URL('./fixtures/test-image.png', import.meta.url));
const video = readFileSync(new URL('./fixtures/test-video.mp4', import.meta.url));
const audio = Buffer.alloc(44 + 1600);
audio.write('RIFF', 0); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8);
audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
audio.writeUInt32LE(8000, 24); audio.writeUInt32LE(16000, 28); audio.writeUInt16LE(2, 32);
audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(1600, 40);
let mockOrigin;
const provider = createServer(async (req, res) => {
  const bytes = []; for await (const chunk of req) bytes.push(chunk);
  const raw = Buffer.concat(bytes);
  let body = {}; try { body = JSON.parse(raw); } catch {}
  requests.push({ url: req.url, method: req.method, headers: req.headers, body, raw: raw.toString() });
  const json = data => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
  if (req.url === '/v1/models') return json({ data: [
    { id: 'mock-text' }, { id: 'mock-image' }, { id: 'mock-video' },
    ...Array.from({ length: 35 }, (_, i) => ({ id: 'mock-catalogue-' + (i + 1) })),
  ] });
  if (req.url === '/v1/chat/completions' && body.messages[0].content.startsWith('从可用列表选择')) {
    return json({ choices: [{ message: { content: JSON.stringify({
      skillId: 'minimax-h3-visual-design',
      resources: ['references/typography-packaging.md'],
    }) } }] });
  }
  if (req.url === '/v1/chat/completions' && body.messages.some(message => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).includes('H3 导演测试'))) {
    return json({ choices: [{ message: { content: JSON.stringify({
      reply: '标题沿产品轮廓展开，然后收束成片名。',
      actions: [
        { method: 'create_node', args: { type: 'video', name: '导演片头', prompt: 'integrated_multimodal_description:\n标题沿产品轮廓展开。', ref: 'intro' } },
        { method: 'set_model', args: { id: '$intro', modelKey: 'compshare-h3::compshare-h3' } },
        { method: 'set_video_params', args: { id: '$intro', duration: 8, resolution: '768P', useContextIr: false } },
      ],
    }) } }] });
  }
  if (req.url === '/v1/chat/completions') return json({ choices: [{ message: { content: JSON.stringify({ reply: '按你的想法拆成两张分镜卡。', actions: [{ method: 'create_node', args: { type: 'text', name: '助手分镜一', text: '咖啡豆落入磨豆机', ref: 'shot1', x: 80, y: 80 } }, { method: 'create_node', args: { type: 'video', name: '助手视频', prompt: '特写，咖啡豆缓慢落下', ref: 'shot2', x: 500, y: 80 } }, { method: 'connect_nodes', args: { from: '$shot1', to: '$shot2' } }] }) } }] });
  if (req.url === '/v1/images/generations' || req.url === '/v1/images/edits') {
    if (body.prompt === 'FAIL') { res.statusCode = 429; return json({ error: { message: '模拟额度不足' } }); }
    return json({ data: Array.from({ length: body.prompt === '多张验收' ? 2 : 1 }, () => ({ b64_json: png.toString('base64') })) });
  }
  if (req.url === '/v1/videos' && req.method === 'POST') return json({ id: 'mock-video-task', status: 'queued' });
  if (req.url === '/v1/audio/speech' && req.method === 'POST') { res.setHeader('Content-Type', 'audio/wav'); return res.end(audio); }
  if (req.url === '/v1/videos/mock-video-task') return json({ id: 'mock-video-task', status: 'completed', progress: 100 });
  if (req.url === '/v1/videos/mock-video-task/content' || req.url === '/output.mp4') { res.setHeader('Content-Type', 'video/mp4'); return res.end(video); }
  if (req.url === '/output.png') { res.setHeader('Content-Type', 'image/png'); return res.end(png); }
  if (req.url === '/audio/v1/voices?kind=preset') return json({ items: [{ voice_id: 'voice-test', name: '测试音色', kind: 'preset' }] });
  if (req.url === '/audio/v1/speech/jobs' && req.method === 'POST') return json({ task_id: 'speech-test' });
  if (req.url === '/audio/v1/speech/jobs/speech-test') return json({ task: { status: 'succeeded', output_url: `${mockOrigin}/output.wav` } });
  if (req.url === '/output.wav') { res.setHeader('Content-Type', 'audio/wav'); return res.end(audio); }
  if (req.url === '/minimax/v2/query/point_usage_summary') return json({ available_points: 100 });
  if (req.url === '/minimax/v2/video_generation') return json({ task_id: 'h3-mock' });
  if (req.url === '/minimax/v2/query/video_generation/h3-mock') return json({ task: { id: 'h3-mock', status: 'succeeded', resolution: '768P', content: { url: `${mockOrigin}/output.mp4` } } });
  if (req.url === '/image/v1/config') return json({ available: true, prices: {
    '1K': { base: 6, per_reference: 2 }, '2K': { base: 12, per_reference: 2 },
  }, reference_moderation_available: true, prompt_optimization_available: true });
  if (req.url === '/image/v1/tasks' && req.method === 'POST') return json({ task_id: 'qwen-mock' });
  if (req.url === '/image/v1/tasks/qwen-mock') return json({ task: { task_id: 'qwen-mock', status: 'succeeded', output_url: `${mockOrigin}/output.png` } });
  if (req.url === '/image/v1/upload_urls') return json({ upload_url: `${mockOrigin}/upload`, authorization: 'temporary-upload-signature', bucket: 'mock', region: 'mock', object_key: 'mock/ref.png' });
  if (req.url === '/upload') return res.end();
  if (req.url === '/image/v1/assets') return json({ reference: { asset_id: 'registered-image' } });
  res.statusCode = 404; json({ error: 'missing mock route' });
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
mockOrigin = `http://127.0.0.1:${provider.address().port}`;
const scratch = mkdtempSync(join(tmpdir(), 'kaishi-acceptance-'));
const runtimePath = join(scratch, 'runtime.json');
const env = { ...process.env, KAISHI_RUNTIME_FILE: runtimePath };
const dev = spawn(process.execPath, [resolve('node_modules/vite/bin/vite.js'), '--port', '5189'], { env, windowsHide: true, stdio: 'ignore' });
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
let mcp;
const errors = [];
page.on('pageerror', e => errors.push(e.message));
try {
  let runtime;
  for (let i = 0; i < 50; i++) {
    try { runtime = JSON.parse(readFileSync(runtimePath)); break; } catch { if (dev.exitCode !== null) throw new Error('隔离测试服务未能启动'); await new Promise(r => setTimeout(r, 150)); }
  }
  assert(runtime?.origin, '隔离测试服务未就绪');
  await page.goto(runtime.origin + '/');
  const navigation = page.getByRole('navigation', { name: '客户端导航' });
  await page.getByRole('heading', { name: '首页', exact: true }).waitFor();
  mkdirSync('docs/acceptance', { recursive: true });
  await page.screenshot({ path: 'docs/acceptance/开视-客户端首页.png' });
  await page.getByRole('button', { name: '视频生成', exact: true }).click();
  const newProject = page.getByRole('dialog', { name: '新建项目', exact: true });
  const projectName = newProject.getByLabel('项目名称');
  assert(await projectName.evaluate(input => input === document.activeElement));
  assert(await newProject.getByRole('button', { name: '创建', exact: true }).isDisabled());
  await projectName.fill('取消的项目');
  await newProject.getByRole('button', { name: '取消', exact: true }).focus();
  await page.keyboard.press('Escape');
  await newProject.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '视频生成', exact: true }).click();
  await projectName.fill('客户端视频验收');
  assert.notEqual(await projectName.evaluate(input => getComputedStyle(input).backgroundColor), 'rgb(255, 255, 255)');
  await page.screenshot({ path: 'docs/acceptance/开视-新建项目.png', animations: 'disabled' });
  await projectName.press('Enter');
  await page.getByTestId('node-prompt').waitFor();
  await page.getByTitle('重命名项目', { exact: true }).click();
  const renameName = page.getByRole('dialog', { name: '重命名项目' }).getByLabel('项目名称');
  assert(await renameName.evaluate(input => input.selectionStart === 0 && input.selectionEnd === input.value.length));
  await renameName.fill('不应保存的名字');
  await renameName.press('Escape');
  await page.keyboard.press('Control+k');
  const searchNode = page.getByTestId('node-search-input');
  await searchNode.waitFor();
  assert(await searchNode.evaluate(input => input === document.activeElement && getComputedStyle(input.parentElement).backgroundColor !== 'rgb(255, 255, 255)'));
  await searchNode.fill('视频');
  await searchNode.press('ArrowDown');
  await searchNode.press('Enter');
  await searchNode.waitFor({ state: 'hidden' });
  await page.getByTestId('node-prompt').waitFor();
  await page.getByTitle('返回首页', { exact: true }).click();
  await navigation.getByRole('button', { name: '项目', exact: true }).click();
  await page.getByTitle('重命名项目「客户端视频验收」').click();
  await renameName.fill('客户端视频验收（已重命名）');
  await renameName.press('Enter');
  await renameName.waitFor({ state: 'hidden' });
  await page.getByLabel('搜索项目').fill('客户端视频验收');
  await page.getByRole('button', { name: /^客户端视频验收（已重命名）/ }).waitFor();
  await page.getByTitle('删除项目「客户端视频验收（已重命名）」').click();
  await page.getByRole('alertdialog', { name: '删除项目' }).getByRole('button', { name: '删除', exact: true }).click();
  await page.getByText('没有匹配的项目。', { exact: true }).waitFor();
  await page.reload();
  await page.getByRole('heading', { name: /^项目/ }).waitFor();
  assert.equal(await page.getByRole('button', { name: /^客户端视频验收/ }).count(), 0);
  passed('新建、重命名与节点搜索的键盘交互和聚焦样式，删除项目后刷新');

  await navigation.getByRole('button', { name: '资产', exact: true }).click();
  await page.locator('.desktop-assets-panel input[type=file]').setInputFiles({
    name: '资产页验收.png', mimeType: 'image/png', buffer: png,
  });
  await page.getByRole('button', { name: '预览 资产页验收.png' }).click();
  const preview = page.getByRole('dialog', { name: '资产页验收.png' });
  await preview.getByRole('img').waitFor();
  await preview.getByRole('button', { name: '关闭', exact: true }).click();
  assert.equal(await page.evaluate(async () => (await import('/src/store.ts')).useCanvas.getState().nodes.length), 0);
  await page.getByTitle('添加到画布', { exact: true }).click();
  await page.waitForFunction(async () => (await import('/src/store.ts')).useCanvas.getState().nodes.some(node => node.name === '资产页验收.png'));
  await page.getByTitle('返回首页', { exact: true }).click();
  passed('资产页独立导入、预览，再明确添加到当前画布');

  await navigation.getByRole('button', { name: '模型配置', exact: true }).click();
  await page.getByRole('heading', { name: '模型配置', exact: true }).waitFor();
  const defaultBackground = await page.locator('.default-card').first().evaluate(el => getComputedStyle(el).backgroundColor);
  assert.notEqual(defaultBackground, 'rgb(255, 255, 255)');
  assert.equal(await page.getByTestId('default-image').count(), 0);
  await page.locator('.toast-stack').waitFor({ state: 'hidden', timeout: 6000 });
  await page.screenshot({ path: 'docs/acceptance/开视-默认模型.png', animations: 'disabled' });
  const imageSettings = page.getByRole('region', { name: '图片生成', exact: true });
  await imageSettings.getByRole('button', { name: 'Qwen-Image 图片服务', exact: true }).click();
  const presetSetup = page.getByRole('dialog', { name: '配置图片模型', exact: true });
  await presetSetup.getByLabel('API Key', { exact: true }).waitFor();
  assert.equal(await presetSetup.getByLabel('接口地址').isVisible(), false);
  assert.equal(await presetSetup.getByLabel('服务协议').isVisible(), false);
  assert.equal(await presetSetup.getByLabel('模型 ID', { exact: true }).isVisible(), false);
  await page.screenshot({ path: 'docs/acceptance/开视-简化模型配置.png', animations: 'disabled' });
  await presetSetup.getByText('高级设置', { exact: true }).click();
  assert.equal(await presetSetup.getByLabel('接口地址').getAttribute('placeholder'), 'https://cp.compshare.cn');
  assert.equal(await presetSetup.getByLabel('从服务中选择模型').inputValue(), 'Qwen-Image');
  await presetSetup.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByTestId('settings-tab-canvas').click();
  await page.getByRole('checkbox', { name: '拖动时吸附到 20px 网格' }).click();
  await page.getByTestId('settings-tab-defaults').click();
  await imageSettings.getByRole('button', { name: '自定义', exact: true }).click();
  await presetSetup.getByLabel('接口地址').fill(mockOrigin + '/v1');
  await presetSetup.getByLabel('API Key', { exact: true }).fill('mock-key-never-real');
  await presetSetup.getByLabel('模型 ID', { exact: true }).fill('my-image-model');
  await presetSetup.getByRole('button', { name: '加入设置', exact: true }).click();
  assert.match(await page.getByTestId('default-image').inputValue(), /::my-image-model$/);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await page.getByTestId('default-image').count(), 0);
  assert.equal(await page.getByTestId('service-list').isVisible(), false);
  await page.getByText('管理模型服务', { exact: true }).click();
  await page.getByTestId('service-list').waitFor();
  await page.getByText('管理模型服务', { exact: true }).click();
  await page.getByTestId('settings-tab-skills').click();
  await page.getByText('H3 视觉设计', { exact: true }).first().waitFor();
  await page.getByTestId('settings-tab-external').click();
  await page.getByRole('region', { name: 'Codex 账号' }).waitFor();
  await page.getByTestId('settings-tab-canvas').click();
  const snap = page.getByRole('checkbox', { name: '拖动时吸附到 20px 网格' });
  const originalSnap = await snap.isChecked();
  await snap.click();
  await navigation.getByRole('button', { name: '首页', exact: true }).click();
  await page.getByRole('alertdialog', { name: '放弃未保存的设置？' }).getByRole('button', { name: '取消' }).click();
  assert.equal(await snap.isChecked(), !originalSnap);
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.getByText('设置已保存到本机', { exact: true }).waitFor();
  await navigation.getByRole('button', { name: '首页', exact: true }).click();
  await page.getByRole('button', { name: '新建画布', exact: true }).click();
  await newProject.getByLabel('项目名称').fill('首次生成验收');
  await newProject.getByRole('button', { name: '创建', exact: true }).click();
  passed('同页配置默认模型与展开管理服务，Agent 账号、技能库及画布偏好可导航');
  await page.getByTitle('添加图片生成节点', { exact: true }).waitFor();
  assert.equal(await page.title(), '开视');
  assert.equal(await page.getByText('功能对照总览', { exact: true }).count(), 0);
  assert.equal(await page.getByTestId('agent-dialog').count(), 0);
  assert.equal(await page.getByRole('button', { name: '素材库', exact: true }).getAttribute('aria-pressed'), 'false');
  await page.getByTitle('添加图片生成节点', { exact: true }).click();
  assert.equal(await page.getByLabel('图片模型', { exact: true }).isVisible(), true);
  const promptField = page.getByTestId('node-prompt');
  const collapsedHeight = await promptField.evaluate(element => element.getBoundingClientRect().height);
  await page.getByRole('button', { name: '展开输入框', exact: true }).click();
  assert((await promptField.evaluate(element => element.getBoundingClientRect().height)) > collapsedHeight);
  await page.getByRole('button', { name: '收起输入框', exact: true }).click();
  await promptField.fill(Array(18).fill('这是需要展示的长提示词').join('\n'));
  assert((await promptField.evaluate(element => element.getBoundingClientRect().height)) > collapsedHeight);
  await promptField.fill('');
  passed('节点输入框支持展开和长文本自动增长');
  assert.equal(await page.getByLabel('比例', { exact: true }).isVisible(), true);
  await page.getByLabel('比例', { exact: true }).selectOption('9:16');
  await page.getByRole('button', { name: '生成图片', exact: true }).click();
  const canvasSettings = page.getByRole('dialog', { name: '设置', exact: true });
  await canvasSettings.getByRole('region', { name: '图片生成', exact: true }).getByRole('button', { name: '自定义', exact: true }).click();
  const setup = page.getByRole('dialog', { name: '配置图片模型', exact: true });
  await setup.getByLabel('接口地址').fill(mockOrigin + '/v1');
  await setup.getByLabel('API Key').fill('mock-key-never-real');
  await setup.getByText('高级设置', { exact: true }).click();
  await setup.getByRole('button', { name: '测试连接' }).click();
  await setup.getByRole('status').or(setup.getByRole('alert')).waitFor();
  assert.equal(await setup.getByRole('alert').count(), 0, await setup.getByRole('alert').allTextContents());
  await setup.getByLabel('从服务中选择模型').selectOption('mock-image');
  await setup.getByRole('button', { name: '保存并使用' }).click();
  await setup.waitFor({ state: 'hidden' });
  await page.keyboard.press('Escape');
  await canvasSettings.waitFor({ state: 'hidden' });
  const initial = await page.evaluate(async () => {
    const { useCanvas } = await import('/src/store.ts');
    const { nodes, settings, selection } = useCanvas.getState();
    return { nodes, defaultKey: settings.defaults.image, selection };
  });
  assert.equal(initial.nodes.length, 1);
  assert.equal(initial.nodes[0].id, initial.selection[0]);
  assert.equal(initial.nodes[0].imageParams.modelKey, '');
  assert.match(initial.defaultKey, /::mock-image$/);
  assert((await page.getByLabel('图片模型', { exact: true }).locator('option').allTextContents()).some(text => text.includes('mock-image')));
  assert.equal(await page.getByRole('button', { name: '生成图片', exact: true }).count(), 1);
  await page.getByTestId('node-prompt').fill('首次画布生成验收');
  await page.getByTestId('generate-btn').click();
  await page.getByRole('button', { name: /^生成任务/ }).click();
  await page.getByRole('button', { name: '定位结果', exact: true }).waitFor();
  await page.getByLabel('筛选生成任务').selectOption('failed');
  await page.getByText('没有符合条件的任务', { exact: true }).waitFor();
  await page.getByLabel('筛选生成任务').selectOption('completed');
  await page.getByRole('button', { name: '预览', exact: true }).click();
  const resultPreview = page.getByRole('dialog', { name: /\.png$/ });
  await resultPreview.getByRole('img').waitFor();
  await page.keyboard.press('Escape');
  await resultPreview.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '定位结果', exact: true }).click();
  await page.getByRole('button', { name: '关闭生成任务', exact: true }).click();
  assert(requests.some(request => request.url === '/v1/images/generations' && request.body.prompt === '首次画布生成验收'));
  await page.getByTitle('添加视频生成节点', { exact: true }).click();
  assert.equal(await page.getByLabel('比例', { exact: true }).isVisible(), true);
  await page.getByLabel('比例', { exact: true }).selectOption('16:9');
  await page.getByLabel('时长', { exact: true }).selectOption('8');
  await page.getByLabel('保留声音', { exact: true }).uncheck();
  assert.equal(await page.getByLabel('时长', { exact: true }).inputValue(), '8');
  await page.screenshot({ path: 'docs/acceptance/开视-视频节点参数.png', animations: 'disabled' });
  passed('先建节点再到统一设置保存模型，回画布直接生成首图');
  await page.getByTitle('返回首页', { exact: true }).click();
  await navigation.getByRole('button', { name: '模型配置', exact: true }).click();
  const videoSettings = page.getByRole('region', { name: '视频生成', exact: true });
  await videoSettings.getByRole('button', { name: 'H3 视频服务', exact: true }).click();
  const videoSetup = page.getByRole('dialog', { name: '配置视频模型' });
  assert.equal(await videoSetup.getByLabel('服务协议').isVisible(), false);
  await videoSetup.getByText('高级设置', { exact: true }).click();
  assert.equal(await videoSetup.getByLabel('服务协议').inputValue(), 'compshare-h3');
  await videoSetup.getByLabel('服务名称').fill('我的 H3 视频服务');
  await videoSetup.getByLabel('接口地址').fill(mockOrigin);
  await videoSetup.getByLabel('API Key').fill('mock-key-never-real');
  await videoSetup.getByRole('button', { name: '手动添加模型', exact: true }).click();
  await videoSetup.getByLabel('模型 ID', { exact: true }).fill('MiniMax-H3');
  await videoSetup.getByRole('button', { name: '保存并使用' }).click();
  await videoSetup.waitFor({ state: 'hidden' });
  await page.getByText('模型已保存', { exact: true }).last().waitFor();
  assert.equal(await page.getByRole('button', { name: '保存设置', exact: true }).count(), 0);
  await page.getByText('管理模型服务', { exact: true }).click();
  await page.getByTestId('service-list').getByRole('button', { name: /我的 H3 视频服务/ }).click();
  await page.getByTestId('service-base-url-input').waitFor();
  assert.equal(await page.getByText('协议与接口说明', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '读取模型列表', exact: true }).count(), 0);
  await navigation.getByRole('button', { name: '首页', exact: true }).click();
  await page.getByText('首次生成验收', { exact: true }).click();
  await page.keyboard.press('Control+k');
  await searchNode.fill('视频 1');
  await searchNode.press('Enter');
  assert.equal(await page.getByLabel('比例', { exact: true }).inputValue(), '16:9');
  assert.equal(await page.getByLabel('时长', { exact: true }).inputValue(), '8');
  assert.equal(await page.getByLabel('保留声音', { exact: true }).isChecked(), false);
  await page.getByTitle('添加视频生成节点', { exact: true }).click();
  const configuredVideoKey = await page.getByLabel('视频模型', { exact: true }).locator('option').evaluateAll(options => options.find(option => option.value.endsWith('::MiniMax-H3'))?.value);
  assert(configuredVideoKey);
  await page.getByLabel('视频模型', { exact: true }).selectOption(configuredVideoKey);
  assert.equal(await page.getByText('Skill ID（创作规则）', { exact: true }).count(), 0);
  await page.locator('.toast-stack').waitFor({ state: 'hidden', timeout: 6000 });
  await page.screenshot({ path: 'docs/acceptance/开视-视频生成参数.png', animations: 'disabled' });
  await page.getByTestId('param-ratio').selectOption('9:16');
  await page.getByTestId('param-duration').selectOption('8');
  await page.getByTestId('param-audio').uncheck();
  const toolbarTops = await Promise.all(['node-model-select', 'param-resolution', 'param-ratio', 'param-duration', 'param-audio', 'generate-btn'].map(id => page.getByTestId(id).evaluate(el => el.getBoundingClientRect().top)));
  assert(Math.max(...toolbarTops) - Math.min(...toolbarTops) < 16, '常用生成参数应位于同一行');
  await page.getByTestId('node-prompt').fill('H3 协议生成验收');
  await page.screenshot({ path: 'docs/acceptance/开视-视频节点生成.png', animations: 'disabled' });
  await page.getByTestId('generate-btn').click();
  await page.getByRole('button', { name: /^生成任务/ }).click();
  await page.getByRole('button', { name: '定位结果', exact: true }).nth(1).waitFor();
  await page.getByRole('button', { name: '关闭生成任务', exact: true }).click();
  assert(requests.some(request => request.url === '/minimax/v2/query/point_usage_summary'));
  assert(requests.some(request => request.url === '/minimax/v2/video_generation'
    && request.body.model === 'MiniMax-H3' && request.body.ratio === '9:16'
    && request.body.duration === 8 && request.body.mute_audio === true
    && request.body.content[0].text === 'H3 协议生成验收'));
  passed('H3 预设只保存一次、自动验证连接、提交生成并轮询结果');
  await page.evaluate(async origin => {
    const { useCanvas } = await import('/src/store.ts');
    const { EMPTY_CAPABILITIES } = await import('/src/types.ts');
    const { QWEN_IMAGE_CAPABILITIES } = await import('/src/lib/modelCatalog.ts');
    const { testServiceConnection } = await import('/src/lib/models.ts');
    const st = useCanvas.getState(); await st.newProject('开视独立自动验收');
    const models = ['text', 'image', 'video'].map(type => ({ id: `mock-${type}`, name: `验收${type}`, type, enabled: true, capabilities: { ...EMPTY_CAPABILITIES, ratios: ['1:1', '16:9'], resolutions: [type === 'video' ? '720x1280' : '1024x1024'], durations: [4, 8], roles: ['reference-image', 'first-frame', 'last-frame'], maxReferences: 10 } }));
    const service = { id: 'mock', name: '本机验收服务', protocol: 'openai', baseUrl: `${origin}/v1`, apiKey: 'mock-key-never-real', enabled: true, models, connection: { status: 'ok', message: '本机模拟', checkedAt: Date.now(), endpoint: '' }, note: '', createdAt: Date.now() };
    const extra = ['compshare-h3', 'compshare-image'].map(protocol => ({ ...service, id: protocol, protocol, baseUrl: origin, models: [{ ...models[protocol === 'compshare-h3' ? 2 : 1], id: protocol, capabilities: { ...models[1].capabilities, resolutions: [protocol === 'compshare-h3' ? '768P' : '1K'] } }] }));
    const qwen = extra.find(service => service.protocol === 'compshare-image');
    qwen.models[0].capabilities = QWEN_IMAGE_CAPABILITIES;
    qwen.connection = await testServiceConnection(qwen);
    await useCanvas.getState().setSettings({ ...st.settings, services: [service, ...extra], defaults: { text: 'mock::mock-text', image: 'mock::mock-image', video: 'mock::mock-video' } });
    window.__testStore = useCanvas;
  }, mockOrigin);
  const openConnection = async () => {
    await page.getByTitle('设置与模型配置', { exact: true }).click();
    await page.getByTestId('settings-tab-external').click();
    const connection = page.getByTestId('agent-connection');
    await connection.getByText('让外部客户端操作开视画布（MCP）', { exact: true }).click();
    await connection.getByText('已就绪', { exact: true }).waitFor();
    const activate = connection.getByRole('button', { name: '连接到此画布', exact: true });
    const active = connection.getByText('当前画布', { exact: true });
    if (!await active.isVisible() && await activate.isVisible()) {
      // The bridge can activate itself while Playwright is preparing the click.
      await activate.click({ timeout: 1500 }).catch(async error => { if (!await active.isVisible()) throw error; });
    }
    await active.waitFor();
    return connection;
  };
  await (await openConnection()).getByText('等待客户端首次调用', { exact: true }).waitFor();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByTitle('设置与模型配置', { exact: true }).click();
  await page.getByText('管理模型服务', { exact: true }).click();
  await page.getByTestId('service-test-btn').click();
  await page.waitForFunction(() => document.querySelector('.settings-message.tone-ok'));
  assert(requests.some(r => r.url === '/v1/models'));
  await page.getByRole('button', { name: '读取模型列表', exact: true }).click();
  await page.getByRole('searchbox', { name: '搜索远程模型' }).fill('catalogue-35');
  await page.getByRole('button', { name: /mock-catalogue-35/ }).waitFor();
  await page.getByTestId('service-base-url-input').fill(mockOrigin + '/v1/changed');
  assert.equal(await page.getByTestId('service-connection-status').innerText(), '连接未验证');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  passed('模型服务测试、搜索第 30 项之后的模型、修改地址后重置旧连接状态');
  // Real MCP subprocess, not a mocked config or page.evaluate substitute.
  mcp = spawn(process.execPath, [resolve('server/mcp.mjs')], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  mcp.stdout.setEncoding('utf8');
  const waiting = new Map(); let buffer = '', seq = 0;
  mcp.stdout.on('data', bytes => { buffer += bytes; while (buffer.includes('\n')) { const end = buffer.indexOf('\n'); const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); const msg = JSON.parse(line); waiting.get(msg.id)?.(msg.result); waiting.delete(msg.id); } });
  const rpc = (method, params) => new Promise((resolve, reject) => { const id = ++seq; const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`MCP timeout ${method}`)); }, 15000); waiting.set(id, result => { clearTimeout(timer); resolve(result); }); mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const tool = async (name, args = {}) => { const response = await rpc('tools/call', { name, arguments: args }); if (response.isError) throw new Error(response.content[0].text); return JSON.parse(response.content[0].text); };
  const hello = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'kaishi-acceptance', version: '1' } }); assert.equal(hello.serverInfo.name, 'kaishi');
  const exposedTools = (await rpc('tools/list')).tools.map(t => t.name);
  assert(exposedTools.includes('generate_node'));
  assert(exposedTools.includes('set_image_params'), '外部 Agent 缺少图片参数设置工具');
  assert(exposedTools.includes('resume_task'), '外部 Agent 缺少远端任务续查工具');
  const snapshot = await tool('read_canvas'); const projectId = snapshot.projectId;
  assert.equal(snapshot.project, '开视独立自动验收');
  const args = { type: 'text', name: 'MCP 真实创建', text: '通过标准输入输出创建', projectId, operationId: 'e2e-create-once' };
  const first = await tool('create_node', args); const repeated = await tool('create_node', args); assert.equal(first.id, repeated.id);
  assert.equal((await tool('read_canvas')).nodes.filter(n => n.name === 'MCP 真实创建').length, 1);
  await assert.rejects(tool('create_node', { ...args, text: 'conflict' }), /operationId/);
  await assert.rejects(tool('create_node', { ...args, projectId: 'wrong-project' }), /项目/);
  await assert.rejects(tool('read_canvas', { projectId: 'wrong-project' }), /项目/);
  passed('标准 MCP 握手、工具发现、真实读写、幂等回放与读写两侧跨项目拒绝');
  await (await openConnection()).getByText('已成功调用当前画布', { exact: true }).waitFor();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByTestId('open-agent').click();
  const chatInput = page.getByLabel('给开视助手发消息');
  await chatInput.fill('帮我拆成两个镜头，参考 @MCP');
  await page.getByLabel('可引用的素材').getByRole('button', { name: /MCP 真实创建/ }).waitFor();
  await chatInput.press('Enter');
  await page.getByRole('button', { name: '移除引用 MCP 真实创建' }).waitFor();
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByRole('button', { name: '应用到画布', exact: true }).waitFor();
  await page.getByRole('button', { name: '应用到画布', exact: true }).click();
  await page.getByRole('button', { name: '已应用', exact: true }).waitFor();
  const after = await tool('read_canvas');
  assert(after.nodes.some(n => n.name === '助手分镜一')); assert(after.nodes.some(n => n.name === '助手视频')); assert.equal(after.edges.length, 1);
  assert(requests.some(r => r.url === '/v1/chat/completions' && r.body.messages.some(m =>
    m.content.includes('"references":[{') && m.content.includes('"name":"MCP 真实创建"'))));
  await page.getByTitle('撤销 (Ctrl Z)', { exact: true }).click();
  assert.equal((await tool('read_canvas')).nodes.length, 1);
  await page.getByTitle('重做 (Ctrl Shift Z)', { exact: true }).click();
  assert.equal((await tool('read_canvas')).edges.length, 1);
  const firstEdge = (await tool('read_canvas')).edges[0];
  await page.keyboard.press('Control+k');
  await searchNode.fill('助手视频'); await searchNode.press('Enter');
  await page.locator(`[data-text-input="${firstEdge.from}"]`).getByTestId('quote-source').click();
  assert((await tool('read_canvas')).nodes.find(node => node.id === firstEdge.to).videoParams.promptRefs.some(ref => ref.nodeId === firstEdge.from));
  assert.equal(await page.locator(`[data-edge-id="${firstEdge.id}"] .edge-label`).count(), 0);
  const edgeLine = page.locator(`[data-edge-id="${firstEdge.id}"] .edge-hit`);
  const middle = await edgeLine.evaluate(path => {
    const point = path.getPointAtLength(path.getTotalLength() / 2);
    const matrix = path.getScreenCTM();
    return { x: matrix.a * point.x + matrix.c * point.y + matrix.e, y: matrix.b * point.x + matrix.d * point.y + matrix.f };
  });
  await page.mouse.move(middle.x, middle.y);
  await page.getByRole('button', { name: '断开连线', exact: true }).click();
  assert.equal((await tool('read_canvas')).edges.length, 0);
  assert(!(await tool('read_canvas')).nodes.find(node => node.id === firstEdge.to).videoParams.promptRefs.some(ref => ref.nodeId === firstEdge.from));
  await page.getByTitle('撤销 (Ctrl Z)', { exact: true }).click();
  assert.equal((await tool('read_canvas')).edges.length, 1);
  assert((await tool('read_canvas')).nodes.find(node => node.id === firstEdge.to).videoParams.promptRefs.some(ref => ref.nodeId === firstEdge.from));
  passed('悬停连线出现剪刀，断开及撤销恢复');
  passed('助手实际请求文本服务、读取画布上下文、修改预览与真实节点连线');
  const textNode = await tool('create_node', { type: 'text', name: '文本生成验收', projectId, operationId: 'text-generate-node' });
  await page.locator(`[data-node-id="${textNode.id}"]`).getByTitle('文本生成', { exact: true }).click();
  const textPrompt = page.getByLabel('描述想生成的文字');
  await textPrompt.fill('写一段开场白');
  await page.getByRole('button', { name: '生成文字', exact: true }).click();
  await textPrompt.waitFor({ state: 'hidden' });
  assert((await tool('read_canvas')).nodes.find(node => node.id === textNode.id).text.includes('按你的想法'));
  const textCount = (await tool('read_canvas')).nodes.length;
  await page.locator(`[data-node-id="${textNode.id}"]`).getByTitle('文本生成', { exact: true }).click();
  await textPrompt.fill('再写一次');
  await page.getByRole('button', { name: '生成文字', exact: true }).click();
  await textPrompt.waitFor({ state: 'hidden' });
  assert.equal((await tool('read_canvas')).nodes.length, textCount);
  assert((await tool('read_canvas')).nodes.find(node => node.id === textNode.id).text.includes('按你的想法'));
  passed('文字节点调用已配置的文本模型并写入节点');
  const audioNode = await tool('create_node', { type: 'audio', name: '配音验收', projectId, operationId: 'audio-generate-node' });
  await page.locator(`[data-node-id="${audioNode.id}"]`).getByTitle('生成配音', { exact: true }).click();
  await page.getByLabel('配音文字').fill('这是配音验收');
  await page.getByLabel('配音语速').selectOption('1.25');
  await page.getByLabel('配音语言').selectOption('EN');
  await page.getByRole('option', { name: '测试音色' }).waitFor({ state: 'attached' });
  await page.locator('.cc-generate').getByText('生成配音', { exact: true }).click();
  await page.getByLabel('配音文字').waitFor({ state: 'hidden' });
  const generatedAudio = (await tool('read_canvas')).nodes.find(node => node.id === audioNode.id);
  assert(generatedAudio.assetId);
  const audioElement = page.locator(`[data-node-id="${audioNode.id}"] audio`);
  await audioElement.waitFor();
  await audioElement.evaluate(element => new Promise((resolve, reject) => {
    if (element.readyState >= 1) return resolve();
    element.addEventListener('loadedmetadata', resolve, { once: true });
    element.addEventListener('error', () => reject(new Error('生成的音频无法播放')), { once: true });
  }));
  assert((await audioElement.evaluate(element => element.duration)) > 0);
  assert(requests.some(request => request.url === '/audio/v1/speech/jobs'
    && request.body.text === '这是配音验收' && request.body.voice.voice_id === 'voice-test' && request.body.speed === 1.25 && request.body.language === 'EN'
    && request.headers['idempotency-key']));
  passed('音频节点获取音色、提交配音任务并保存音频素材');
  await page.getByTitle('设置与模型配置', { exact: true }).click();
  await page.getByRole('region', { name: '语音生成', exact: true }).getByRole('button', { name: '自定义', exact: true }).click();
  const audioSetup = page.getByRole('dialog', { name: '配置音频模型', exact: true });
  await audioSetup.getByLabel('接口地址').fill(mockOrigin + '/v1');
  await audioSetup.getByLabel('API Key', { exact: true }).fill('mock-key-never-real');
  await audioSetup.getByLabel('模型 ID', { exact: true }).fill('mock-audio');
  await audioSetup.getByRole('button', { name: '保存并使用', exact: true }).click();
  await audioSetup.waitFor({ state: 'hidden' });
  await page.keyboard.press('Escape');
  const customAudioNode = await tool('create_node', { type: 'audio', name: '自定义语音验收', projectId, operationId: 'custom-audio' });
  await page.locator(`[data-node-id="${customAudioNode.id}"]`).getByTitle('生成配音', { exact: true }).click();
  const audioKey = await page.getByLabel('语音模型').locator('option').evaluateAll(options => options.find(option => option.value.endsWith('::mock-audio'))?.value);
  assert(audioKey);
  await page.getByLabel('语音模型').selectOption(audioKey);
  await page.getByLabel('配音文字').fill('自定义语音接口验收');
  await page.getByLabel('配音音色').selectOption('nova');
  await page.locator('.cc-generate').getByText('生成配音', { exact: true }).click();
  await page.getByLabel('配音文字').waitFor({ state: 'hidden' });
  assert((await tool('read_canvas')).nodes.find(n => n.id === customAudioNode.id).assetId);
  assert(requests.some(r => r.url === '/v1/audio/speech' && r.body.model === 'mock-audio' && r.body.voice === 'nova' && r.body.input === '自定义语音接口验收'));
  passed('添加的兼容语音模型自动出现在节点并实际调用');
  const image = await tool('create_node', { type: 'image', name: '图片验收', prompt: '一杯咖啡', x: 70, y: 450, projectId, operationId: 'image' });
  const waitTask = async taskId => { for (let i = 0; i < 50; i++) { const task = (await tool('list_tasks')).find(t => t.id === taskId); if (task && task.status !== 'running') { assert.equal(task.status, 'completed', task.message); return task; } await new Promise(r => setTimeout(r, 250)); } throw new Error('task timeout'); };
  assert.equal(await page.getByLabel('比例', { exact: true }).isVisible(), true);
  assert.equal(await page.getByLabel('比例', { exact: true }).isEnabled(), true);
  await page.getByTestId('generate-btn').click();
  const imageJob = (await tool('list_tasks')).find(t => t.nodeId === image.id); assert(imageJob?.id);
  const imageResult = await waitTask(imageJob.id); assert.equal(imageResult.assetIds.length, 1);
  assert.equal((await tool('read_canvas')).nodes.find(node => node.id === image.id).assetId, imageResult.assetIds[0]);
  assert.equal(await page.getByTestId('node-controls-float').count(), 1);
  await page.getByTestId('node-prompt').fill('更改后的提示词');
  assert.equal(await page.getByTestId('result-stale').count(), 1);
  passed('图片结果显示在生成节点中，仍可继续调整参数');
  const batch = await tool('create_node', { type: 'image', name: '多张验收', prompt: '多张验收', projectId, operationId: 'batch-image' });
  const batchCountBefore = (await tool('read_canvas')).nodes.length;
  const batchJob = await tool('generate_node', { id: batch.id, projectId, operationId: 'batch-generate' });
  const batchResult = await waitTask(batchJob.taskId);
  const batchCanvas = await tool('read_canvas');
  assert.equal(batchCanvas.nodes.length, batchCountBefore);
  assert.equal(batchResult.assetIds.length, 2);
  assert.deepEqual(batchCanvas.nodes.find(n => n.id === batch.id).resultAssetIds, batchResult.assetIds);
  await page.getByLabel('下一张生成结果').click();
  assert.equal((await tool('read_canvas')).nodes.find(n => n.id === batch.id).assetId, batchResult.assetIds[1]);
  const exportedIds = await page.evaluate(async () => { const { assetIdsOf, useCanvas } = await import('/src/store.ts'); return assetIdsOf(useCanvas.getState().nodes); });
  assert(batchResult.assetIds.every(id => exportedIds.includes(id)));
  passed('多张结果在同一节点切换，项目导出保留全部素材');
  const assistantImage = await page.evaluate(async () => {
    const { useCanvas } = await import('/src/store.ts');
    const { applyAssistantActions } = await import('/src/lib/localBridge.ts');
    const id = useCanvas.getState().projectId;
    const actions = [
      { method: 'create_node', args: { type: 'image', name: '助手图片比例验收', prompt: '参数测试', ref: 'image' } },
      { method: 'set_model', args: { id: '$image', modelKey: 'mock::mock-image' } },
      { method: 'set_image_params', args: { id: '$image', aspectRatio: '16:9' } },
    ];
    await applyAssistantActions(actions, id);
    const node = useCanvas.getState().nodes.find(n => n.name === '助手图片比例验收');
    let rejected = false;
    try { await applyAssistantActions([{ method: 'set_image_params', args: { id: node.id, aspectRatio: 'bad-ratio' } }], id); } catch { rejected = true; }
    return { ratio: node.imageParams.aspectRatio, rejected };
  });
  assert.deepEqual(assistantImage, { ratio: '16:9', rejected: true });
  passed('助手可设置图片比例，不支持的参数被拒绝');
  const imageEdit = await tool('create_node', { type: 'image', name: '参考图验收', prompt: '暖色灯光', projectId, operationId: 'edit' });
  const resultNode = (await tool('read_canvas')).nodes.find(n => n.assetId === imageResult.assetIds[0]);
  await page.getByRole('button', { name: '参考素材', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '添加参考素材' });
  await picker.getByRole('button', { name: /^图片验收-/ }).click();
  await picker.waitFor({ state: 'hidden' });
  const reference = (await tool('read_canvas')).nodes.find(node => node.id === imageEdit.id).imageParams.references[0];
  assert.equal(reference.assetId, resultNode.assetId);
  const promptInput = page.getByTestId('node-prompt');
  await promptInput.fill('暖色灯光参考 @');
  await page.getByTestId('mention-menu').getByRole('button', { name: /图片验收-/ }).waitFor();
  await promptInput.press('Enter');
  assert.match(await promptInput.inputValue(), /@\[/);
  const editJob = await tool('generate_node', { id: imageEdit.id, projectId, operationId: 'edit-generate' }); await waitTask(editJob.taskId);
  assert(requests.some(r => r.url === '/v1/images/edits' && r.raw.includes('image[]') && r.raw.includes('暖色灯光')));
  passed('已添加的参考图片可用 @ 引用，实际随 multipart 请求上传');
  const videoNode = after.nodes.find(n => n.name === '助手视频');
  const videoJob = await tool('generate_node', { id: videoNode.id, projectId, operationId: 'video-generate' }); const videoTask = await waitTask(videoJob.taskId);
  assert(requests.some(r => r.url === '/v1/videos/mock-video-task/content'));
  passed('视频异步提交、轮询完成、文件下载落库');
  const videoOutput = (await tool('read_canvas')).nodes.find(n => n.assetId === videoTask.assetIds[0]);
  assert(videoOutput);
  await page.keyboard.press('Control+k');
  await searchNode.fill(videoOutput.name); await searchNode.press('Enter');
  const outputVideo = page.locator(`[data-node-id="${videoOutput.id}"] video`);
  await outputVideo.waitFor();
  await outputVideo.evaluate(element => new Promise((resolve, reject) => {
    if (element.readyState >= 2) return resolve();
    element.addEventListener('loadeddata', resolve, { once: true });
    element.addEventListener('error', () => reject(new Error('视频不能解码')), { once: true });
  }));
  await page.locator(`[data-node-id="${videoOutput.id}"]`).getByTitle('截取当前帧').click();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-node-id]')].some(el => el.textContent.includes('当前帧')));
  assert((await tool('read_canvas')).nodes.some(n => n.name.endsWith('-当前帧.png') && n.assetId));
  for (const frame of ['首帧', '尾帧']) {
    await page.keyboard.press('Control+k'); await searchNode.fill(videoOutput.name); await searchNode.press('Enter');
    await page.locator(`[data-node-id="${videoOutput.id}"]`).getByTitle(`截取${frame}`).click();
    await page.waitForFunction(name => [...document.querySelectorAll('[data-node-id]')].some(el => el.textContent.includes(name)), frame);
    assert((await tool('read_canvas')).nodes.some(n => n.name.endsWith(`-${frame}.png`) && n.assetId));
  }
  passed('视频首帧、当前帧和尾帧截取为画布图片和素材');
  for (const [kind, modelKey] of [['video', 'compshare-h3::compshare-h3'], ['image', 'compshare-image::compshare-image']]) {
    const n = await tool('create_node', { type: kind, name: `${kind}供应商协议验收`, projectId, operationId: `provider-${kind}` });
    await tool('set_model', { id: n.id, modelKey, projectId, operationId: `provider-model-${kind}` });
    if (kind === 'video') await tool('connect_nodes', { from: resultNode.id, to: n.id, projectId, operationId: `provider-ref-${kind}` });
    await page.keyboard.press('Control+k');
    await searchNode.fill(`${kind}供应商协议验收`);
    await searchNode.press('Enter');
    await searchNode.waitFor({ state: 'hidden' });
    await promptInput.fill(kind === 'video' ? '参考 @' : '参考 @图片验收-');
    await page.getByTestId('mention-menu').getByRole('button').first().waitFor();
    await promptInput.press('Enter');
    await page.keyboard.insertText(' 的光线');
    assert.match(await promptInput.inputValue(), /^参考 @\[[^\]]+\] 的光线$/);
    if (kind === 'image') await page.evaluate(async id => {
      const { useCanvas } = await import('/src/store.ts');
      useCanvas.getState().updateNodeParams(id, { resolution: '2K' });
    }, n.id);
    const job = await tool('generate_node', { id: n.id, projectId, operationId: `provider-generate-${kind}` }); await waitTask(job.taskId);
  }
  assert(requests.some(r => r.url === '/minimax/v2/video_generation'
    && r.body.content.some(c => c.image_url?.url.startsWith('data:') && c.role === 'reference_image')
    && r.body.content[0].text === '参考 <Picture 1> 的光线'),
    JSON.stringify(requests.filter(r => r.url === '/minimax/v2/video_generation').map(r => r.body.content[0]?.text)));
  assert(requests.some(r => r.url === '/image/v1/config'));
  assert(requests.some(r => r.url === '/image/v1/tasks' && r.body.resolution === '2K'
    && r.body.prompt === '参考 图 1 的光线' && r.body.reference_images?.[0].asset_id === 'registered-image'));
  const upload = requests.find(r => r.url === '/upload');
  assert.equal(upload.headers.authorization, 'temporary-upload-signature');
  assert.equal(upload.headers.ufile_indicated_region, 'mock');
  passed('H3 参考编号与异步视频；Qwen 实时档位、签名上传、读取官方格式的登记结果');
  const linked = await tool('create_node', { type: 'video', name: '参考映射验收', prompt: '人物外观依据连接的图片验收', projectId, operationId: 'linked-video' });
  await tool('set_model', { id: linked.id, modelKey: 'compshare-h3::compshare-h3', projectId, operationId: 'linked-model' });
  await tool('connect_nodes', { from: resultNode.id, to: linked.id, role: 'reference-image', projectId, operationId: 'linked-edge' });
  const linkedJob = await tool('generate_node', { id: linked.id, projectId, operationId: 'linked-generate' }); await waitTask(linkedJob.taskId);
  assert(requests.some(r => r.url === '/minimax/v2/video_generation' && r.body.content?.[0]?.text?.includes('<Picture 1> 对应素材 "图片验收"')));
  await page.evaluate(async ({ id, assetId }) => (await import('/src/store.ts')).useCanvas.getState().updateNode(id, { assetId }), { id: resultNode.id, assetId: batchResult.assetIds[1] });
  assert.equal(await page.locator(`[data-node-id="${linked.id}"]`).getByTestId('result-stale').count(), 1);
  await page.evaluate(async ({ id, assetId }) => (await import('/src/store.ts')).useCanvas.getState().updateNode(id, { assetId }), { id: resultNode.id, assetId: resultNode.assetId });
  assert.equal(await page.locator(`[data-node-id="${linked.id}"]`).getByTestId('result-stale').count(), 0);
  passed('连线名称映射到 H3 素材编号，参考素材变化时提示结果过期');
  const skills = await tool('list_skills');
  assert.equal(skills.filter(skill => skill.id.startsWith('minimax-')).length, 9);
  const visual = await tool('read_skill', { id: 'minimax-h3-visual-design' });
  const resource = 'references/typography-packaging.md';
  assert(visual.resources.includes(resource));
  const guide = await tool('read_skill', { id: visual.id, resource });
  assert(guide.body.length > 1000);
  assert((await tool('read_skill', { id: 'h3-director' })).body.includes('开视'));
  await assert.rejects(tool('read_skill', { id: visual.id, resource: '../SKILL.md' }), /参考文件/);
  await page.getByRole('button', { name: '画布素材', exact: true }).click();
  const assistantPicker = page.getByRole('dialog', { name: '画布素材' });
  await assistantPicker.getByLabel('搜索素材').fill(resultNode.name);
  await assistantPicker.getByRole('button', { name: new RegExp(resultNode.name) }).first().click();
  await page.getByLabel('助手技能').selectOption('h3-director');
  await page.getByLabel('给开视助手发消息').fill('H3 导演测试：让标题沿产品轮廓展开');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByText('开视助手 · H3 视觉设计', { exact: true }).waitFor();
  await page.getByRole('button', { name: '应用到画布', exact: true }).click();
  await page.getByRole('button', { name: '已应用', exact: true }).nth(1).waitFor();
  const directed = (await tool('read_canvas')).nodes.find(node => node.name === '导演片头');
  assert(requests.some(r => r.url === '/v1/chat/completions' && r.body.messages.some(m => Array.isArray(m.content) && m.content.some(part => part.type === 'image_url' && part.image_url.url.startsWith('data:image/jpeg;base64,')))));
  assert.equal(directed.videoParams.duration, 8);
  assert.equal(directed.videoParams.advanced.useContextIr, false);
  const directedJob = await tool('generate_node', { id: directed.id, projectId, operationId: 'h3-director-generate' });
  await waitTask(directedJob.taskId);
  assert(requests.some(request => request.url === '/minimax/v2/video_generation'
    && request.body.use_context_ir === false
    && request.body.duration === 8
    && request.body.content[0].text === 'integrated_multimodal_description:\n标题沿产品轮廓展开。'));
  assert(requests.some(request => request.url === '/v1/chat/completions'
    && request.body.messages.some(message => message.content.includes(guide.body))));
  passed('H3 导演选择原 Skill 与参考文件，应用 H3 模型、提示词和参数；外部 Agent 可读取同一技能库');
  await tool('set_prompt', { id: image.id, prompt: 'FAIL', projectId, operationId: 'image-fail-prompt' });
  const failed = await tool('generate_node', { id: image.id, projectId, operationId: 'image-fail' });
  for (let i = 0; i < 20; i++) { const task = (await tool('list_tasks')).find(t => t.id === failed.taskId); if (task?.status === 'failed') { assert.match(task.message, /429/); break; } if (i === 19) throw new Error('failure not recorded'); await new Promise(r => setTimeout(r, 200)); }
  passed('供应商失败显示真实错误，不伪造生成结果');
  await page.keyboard.press('Control+k'); await searchNode.fill(resultNode.name); await searchNode.press('Enter');
  await page.locator(`[data-node-id="${resultNode.id}"]`).click({ button: 'right' });
  await page.getByRole('button', { name: '宫格切分' }).click();
  await page.getByTestId('wb-canvas-split-confirm').click();
  await page.getByTestId('wb-canvas-split-dialog').waitFor({ state: 'hidden' });
  const slices = (await tool('read_canvas')).nodes.filter(n => n.name.startsWith(`${resultNode.name} · `));
  assert.equal(slices.length, 4);
  assert.equal(new Set(slices.map(n => n.assetId)).size, 4);
  assert(slices.every(n => n.assetId && n.assetId !== resultNode.assetId));
  passed('图片宫格切分生成四个独立素材节点');
  assert.equal((await fetch(`${runtime.origin}/api/local/rpc`, { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await fetch(`${runtime.origin}/api/local/bootstrap`, { method: 'POST', headers: { Origin: 'https://foreign.example' } })).status, 403);
  passed('本机接口拒绝无凭据与跨站请求');
  // 外部 Agent 设置图片参数：能力按所选模型校验，不能绕过界面填非法值。
  const paramImage = await tool('create_node', { type: 'image', name: 'MCP 图片参数验收', projectId, operationId: 'mcp-image-params-node' });
  await tool('set_model', { id: paramImage.id, modelKey: 'mock::mock-image', projectId, operationId: 'mcp-image-params-model' });
  await tool('set_image_params', { id: paramImage.id, aspectRatio: '16:9', projectId, operationId: 'mcp-image-params' });
  assert.equal((await tool('read_canvas')).nodes.find(n => n.id === paramImage.id).imageParams.aspectRatio, '16:9');
  await assert.rejects(tool('set_image_params', { id: paramImage.id, aspectRatio: '9:99', projectId, operationId: 'mcp-image-params-bad' }), /不支持/);
  passed('外部 Agent 可设置图片比例，模型不支持的参数被拒绝');

  // 模拟「页面被重开、远端任务已完成但产物未领取」，验证续查只查询既有远端任务。
  const resumeNode = await tool('create_node', { type: 'video', name: '断点续查验收', projectId, operationId: 'resume-node' });
  const submitCountBefore = requests.filter(r => r.url === '/minimax/v2/video_generation').length;
  await page.evaluate(({ projectId, nodeId, origin }) => {
    const tasks = JSON.parse(localStorage.getItem('kaishi:tasks') || '[]');
    tasks.unshift({
      id: 'resume-e2e-task', projectId, nodeId, name: '断点续查验收', type: 'video',
      status: 'failed', message: '页面已重开，执行已中断；远端任务可能仍在运行',
      remoteId: 'h3-mock', assetIds: [], startedAt: Date.now(),
      resume: { serviceId: 'compshare-h3', protocol: 'compshare-h3', baseUrl: origin, modelKey: 'compshare-h3::compshare-h3', type: 'video' },
    });
    localStorage.setItem('kaishi:tasks', JSON.stringify(tasks));
  }, { projectId, nodeId: resumeNode.id, origin: mockOrigin });
  await page.reload();
  await page.waitForSelector('.canvas-viewport');
  await openConnection();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: /^生成任务/ }).click();
  const resumeItem = page.locator('.task-item').filter({ hasText: '断点续查验收' });
  await resumeItem.getByRole('button', { name: '续查远端产物' }).waitFor();
  await page.screenshot({ path: 'docs/acceptance/开视-任务续查.png', animations: 'disabled' });
  await resumeItem.getByRole('button', { name: '续查远端产物' }).click();
  await resumeItem.getByText('已完成', { exact: true }).waitFor({ timeout: 15000 });
  assert.equal(requests.filter(r => r.url === '/minimax/v2/video_generation').length, submitCountBefore, '续查不应重新提交生成');
  assert(requests.some(r => r.url === '/minimax/v2/query/video_generation/h3-mock'), '续查没有查询远端任务');
  const resumedNode = (await tool('read_canvas')).nodes.find(n => n.id === resumeNode.id);
  assert(resumedNode?.assetId, '续查产物没有回写到原节点');
  const resumedTask = (await tool('list_tasks')).find(t => t.id === 'resume-e2e-task');
  assert.equal(resumedTask?.status, 'completed');
  assert.equal(resumedTask?.assetIds.length, 1);
  await page.getByRole('button', { name: '关闭生成任务', exact: true }).click();
  passed('刷新后按远端任务编号续查并领取产物，不重新提交生成、不重复扣费');
  const beforeReload = (await tool('read_canvas')).nodes.length;
  await page.reload();
  await openConnection();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByTestId('open-agent').click();
  assert.equal((await tool('read_canvas')).nodes.length, beforeReload);
  assert.equal((await tool('create_node', args)).id, first.id);
  await page.getByRole('button', { name: '已应用', exact: true }).nth(1).waitFor();
  assert.equal(await page.getByRole('button', { name: '已应用', exact: true }).count(), 2);
  const restoredAssets = await page.evaluate(async () => { const db = await import('/src/lib/db.ts'); const assets = await db.listAssets(); return Promise.all(assets.map(async a => ({ id: a.id, size: (await db.getAsset(a.id)).blob.size }))); });
  assert(restoredAssets.every(a => a.size > 0));
  const restoredAudio = page.locator(`[data-node-id="${audioNode.id}"] audio`);
  await restoredAudio.waitFor();
  await restoredAudio.evaluate(element => new Promise((resolve, reject) => {
    if (element.readyState >= 1) return resolve();
    element.addEventListener('loadedmetadata', resolve, { once: true });
    element.addEventListener('error', () => reject(new Error('刷新后音频无法播放')), { once: true });
  }));
  assert((await restoredAudio.evaluate(element => element.duration)) > 0);
  passed('刷新恢复画布、助手会话、应用状态与二进制素材');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '导出项目', exact: true }).click()]);
  const zipPath = await dl.path();
  const JSZip = (await import('jszip')).default; const zip = await JSZip.loadAsync(readFileSync(zipPath)); assert(Object.keys(zip.files).some(f => f.startsWith('assets/')));
  passed('项目导出包含实际素材文件');
  await openConnection();
  assert((await page.locator('.connection-code').innerText()).includes('server\\mcp.mjs'));
  await page.getByLabel('选择客户端').selectOption('workbuddy');
  const workbuddy = JSON.parse(await page.locator('.connection-code').innerText());
  assert.equal(workbuddy.mcpServers.kaishi.type, 'stdio');
  assert(workbuddy.mcpServers.kaishi.args[0].endsWith('mcp.mjs'));
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '画布适应全部内容', exact: true }).click();
  await page.locator('.toast-stack').waitFor({ state: 'hidden', timeout: 6000 });
  mkdirSync('docs/acceptance', { recursive: true });
  await page.screenshot({ path: 'docs/acceptance/开视-画布与助手.png' });
  assert.equal(errors.length, 0, errors.join('\n'));
  passed('主界面无运行时错误，已保存验收截图');
  let account = null, loginPending = false;
  await page.evaluate(async () => {
    localStorage.removeItem('kaishi:codex-account-source');
    (await import('/src/lib/codexAccount.ts')).useCodexAccount.setState({ status: null });
  });
  const authUrl = 'https://auth.openai.com/kaishi-local-e2e';
  await context.route(authUrl, async route => route.fulfill({ body: '模拟授权页' }));
  await page.route('**/api/local/codex/*', async route => {
    const endpoint = new URL(route.request().url()).pathname.split('/').at(-1);
    if (endpoint === 'login') {
      loginPending = true;
      return route.fulfill({ json: { authUrl } });
    }
    if (endpoint === 'logout') account = null;
    if (endpoint === 'status' || endpoint === 'logout') return route.fulfill({ json: { account, pending: loginPending, error: '' } });
    if (endpoint === 'quota') return route.fulfill({ json: { limits: [{ used: 15, minutes: 300, resetsAt: null }] } });
    assert.equal(endpoint, 'reply');
    const { messages, images } = route.request().postDataJSON();
    assert(messages.some(message => message.role === 'user' && message.content === '用 Codex 写一张分镜卡'));
    assert(messages.some(message => message.role === 'system' && message.content.includes('当前画布参考资料')));
    assert(images.some(image => image.startsWith('data:image/jpeg;base64,')));
    return route.fulfill({ json: { text: JSON.stringify({
      reply: '先用一个近景开场。',
      actions: [{ method: 'create_node', args: { type: 'text', name: 'Codex 分镜', text: '产品特写' } }],
    }) } });
  });
  await openConnection();
  const accountCard = page.getByRole('region', { name: 'Codex 账号' });
  const popupEvent = page.waitForEvent('popup');
  await accountCard.getByRole('button', { name: '登录 ChatGPT' }).click();
  const popup = await popupEvent;
  await popup.waitForURL(authUrl);
  await accountCard.getByText('等待浏览器授权', { exact: true }).waitFor();
  account = { email: 'mock@example.invalid', plan: 'plus' };
  loginPending = false;
  await popup.close();
  await accountCard.getByText('已登录', { exact: true }).waitFor();
  await accountCard.getByRole('button', { name: '刷新额度' }).click();
  await accountCard.getByText('已用 15%', { exact: true }).waitFor();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByLabel('助手文本模型').selectOption('kaishi:codex-account');
  await page.getByRole('button', { name: '画布素材', exact: true }).click();
  const codexPicker = page.getByRole('dialog', { name: '画布素材' });
  await codexPicker.getByLabel('搜索素材').fill(resultNode.name);
  await codexPicker.getByRole('button', { name: new RegExp(resultNode.name) }).first().click();
  await page.getByLabel('给开视助手发消息').fill('用 Codex 写一张分镜卡');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByRole('button', { name: '应用到画布', exact: true }).click();
  await page.getByRole('button', { name: '已应用', exact: true }).nth(2).waitFor();
  assert((await tool('read_canvas')).nodes.some(node => node.name === 'Codex 分镜'));
  await openConnection();
  await accountCard.getByRole('button', { name: '退出登录' }).click();
  await accountCard.getByText('未登录', { exact: true }).waitFor();
  assert.equal(errors.length, 0, errors.join('\n'));
  passed('模拟官方 OAuth 页面回跳、账号与额度展示、Codex 助手应用画布、退出登录；WorkBuddy 配置可用');
  writeFileSync('docs/acceptance/自动验收.json', JSON.stringify({ date: '2026-11-11', mode: 'isolated-browser-local-mock-provider', paidCalls: 0, passed: reports, requests: requests.map(r => ({ path: r.url, method: r.method })) }, null, 2));
} finally {
  mcp?.kill(); await context.close(); await browser.close();
  if (dev.exitCode === null && dev.signalCode === null) {
    const exited = once(dev, 'exit');
    dev.kill();
    await exited;
  }
  await new Promise(resolve => provider.close(resolve));
  if (dirname(resolve(scratch)) === resolve(tmpdir()) && basename(scratch).startsWith('kaishi-acceptance-')) {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
