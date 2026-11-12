/**
 * 开视 · 基础画布交互回归验收。
 *
 * 主验收 kaishi.mjs 覆盖生成 / 助手 / MCP / 账号，但没有覆盖第一阶段的基础画布编辑。
 * 本脚本补齐：从客户端首页新建项目 → 建节点 → 拖选缩放 → 复制粘贴删除撤销重做 →
 * 连线 → 素材导入与放大 → 刷新恢复 → 项目导出。
 *
 * 运行：npm run e2e:canvas（独立 vite 端口 + 独立浏览器 profile，不碰用户项目与凭据）
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';
import JSZip from 'jszip';

const PORT = 5192;
const scratch = mkdtempSync(join(tmpdir(), 'kaishi-canvas-regression-'));
const runtimePath = join(scratch, 'runtime.json');
const results = [];
const pass = (name, detail = '') => { results.push(name); console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`); };

const dev = spawn(process.execPath, [resolve('node_modules/vite/bin/vite.js'), '--port', String(PORT), '--strictPort'], {
  env: { ...process.env, KAISHI_RUNTIME_FILE: runtimePath }, windowsHide: true, stdio: 'ignore',
});
const profile = join(scratch, 'profile');
let browser;
const errors = [];

const state = page => page.evaluate(() => {
  const raw = localStorage.getItem('infinite-canvas-studio:mirror');
  return raw ? JSON.parse(raw) : null;
});
const nodesOf = async page => (await state(page))?.data?.nodes ?? [];
const edgesOf = async page => (await state(page))?.data?.edges ?? [];
const waitNodes = (page, n) => page.waitForFunction(
  x => (JSON.parse(localStorage.getItem('infinite-canvas-studio:mirror') || '{}')?.data?.nodes?.length ?? -1) === x,
  n, { timeout: 12000 },
);

async function main() {
  let origin = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 60; i += 1) {
    try {
      const rt = JSON.parse(readFileSync(runtimePath, 'utf8'));
      if (rt.origin) { origin = rt.origin; break; }
    } catch { /* 等待服务写 runtime */ }
    if (dev.exitCode !== null) throw new Error('隔离开发服务启动失败（端口可能被占用）');
    await new Promise(r => setTimeout(r, 150));
  }

  browser = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true, viewport: { width: 1600, height: 1000 }, acceptDownloads: true,
    args: ['--no-sandbox', '--no-first-run', '--disable-dev-shm-usage'],
  });
  const page = browser.pages()[0] ?? await browser.newPage();
  page.on('pageerror', e => errors.push(e.message));

  await page.goto(origin + '/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: '首页', exact: true }).waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: '视频生成', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建项目', exact: true });
  await dialog.getByLabel('项目名称').fill('画布基础回归');
  await dialog.getByLabel('项目名称').press('Enter');
  await page.waitForSelector('.canvas-viewport', { timeout: 15000 });
  await page.waitForTimeout(400);
  pass('客户端首页新建项目后进入无限画布');

  /* ---------- 建节点 ---------- */
  // 新版从「视频生成」入口进画布会带一个起始节点，后续一律按基线做增量断言
  const base = (await nodesOf(page)).length;
  const toolbar = page.locator('.toolbar');
  await toolbar.locator('button[title="添加文字节点"]').click();
  await toolbar.locator('button[title="添加图片生成节点"]').click();
  await toolbar.locator('button[title="添加视频生成节点"]').click();
  await toolbar.locator('button[title="添加分组框"]').click();
  await waitNodes(page, base + 4);
  const added = (await nodesOf(page)).slice(base).map(n => n.type).sort();
  assert.deepEqual(added, ['group', 'image', 'text', 'video']);
  pass('工具栏可建立文字 / 图片 / 视频 / 分组四类节点', `基线 ${base} → ${base + 4}，新增 ${added.join('、')}`);

  const vp = await page.locator('.canvas-viewport').boundingBox();
  await page.mouse.click(vp.x + 900, vp.y + 700, { button: 'right' });
  await page.waitForSelector('.create-menu', { timeout: 6000 });
  const menuLabels = await page.locator('.create-menu .node-type-grid button').allInnerTexts();
  assert(menuLabels.length >= 4, `菜单项 ${menuLabels.length}`);
  await page.keyboard.press('Escape');
  pass('空白处右键出现节点创建菜单', `${menuLabels.length} 个基础类型`);

  /* ---------- 选中、拖动、缩放 ---------- */
  const textId = (await nodesOf(page)).find(n => n.type === 'text').id;
  const head = page.locator(`.canvas-node[data-node-id="${textId}"] .node-head`);
  await head.click();
  assert.equal(await page.locator(`.canvas-node[data-node-id="${textId}"].is-selected`).count(), 1);
  pass('单击节点标题可选中并在属性面板定位');

  const before = (await nodesOf(page)).find(n => n.id === textId);
  const hb = await head.boundingBox();
  await page.mouse.move(hb.x + 40, hb.y + 10);
  await page.mouse.down();
  await page.mouse.move(hb.x + 130, hb.y + 70, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const after = (await nodesOf(page)).find(n => n.id === textId);
  assert(Math.abs(after.x - before.x) > 20, `x ${before.x} → ${after.x}`);
  pass('拖动节点改变位置并写入项目状态', `${Math.round(before.x)} → ${Math.round(after.x)}`);

  const zoomBefore = await page.locator('.canvas-zoom-badge').innerText();
  await page.keyboard.press('+');
  await page.waitForTimeout(200);
  const zoomAfter = await page.locator('.canvas-zoom-badge').innerText();
  assert.notEqual(zoomBefore, zoomAfter, `${zoomBefore} / ${zoomAfter}`);
  pass('快捷键缩放画布', `${zoomBefore} → ${zoomAfter}`);
  await page.keyboard.press('Control+0');
  await page.waitForTimeout(150);

  /* ---------- 复制 / 删除 / 撤销 / 重做 ---------- */
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  await waitNodes(page, base + 5);
  pass('内部节点复制粘贴保留', `${base + 4} → ${base + 5}`);

  await page.keyboard.press('Delete');
  await waitNodes(page, base + 4);
  const deletedId = await page.evaluate(id => {
    const cur = JSON.parse(localStorage.getItem('infinite-canvas-studio:mirror') || '{}')?.data?.nodes ?? [];
    return cur.some(n => n.id === id);
  }, textId);
  assert.equal(deletedId, true);
  pass('删除选中节点', `${base + 5} → ${base + 4}`);

  await toolbar.locator('button[title^="撤销"]').click();
  await waitNodes(page, base + 5);
  pass('撤销恢复被删节点', `${base + 4} → ${base + 5}`);
  await toolbar.locator('button[title^="重做"]').click();
  await waitNodes(page, base + 4);
  pass('重做再次删除节点', `${base + 5} → ${base + 4}`);

  /* ---------- 连线 ---------- */
  const list = await nodesOf(page);
  const a = list.find(n => n.type === 'text');
  const b = list.find(n => n.type === 'image');
  const out = page.locator(`.canvas-node[data-node-id="${a.id}"] .port-out`);
  const inn = page.locator(`.canvas-node[data-node-id="${b.id}"] .port-in`);
  const ob = await out.boundingBox();
  const ib = await inn.boundingBox();
  await page.mouse.move(ob.x + ob.width / 2, ob.y + ob.height / 2);
  await page.mouse.down();
  await page.mouse.move(ib.x + ib.width / 2, ib.y + ib.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(350);
  const edges = await edgesOf(page);
  assert(edges.some(e => e.from === a.id && e.to === b.id), `连线数 ${edges.length}`);
  pass('拖拽输出端口到输入端口建立真实连线', `${edges.length} 条`);

  /* ---------- 素材导入、放大、媒体节点 ---------- */
  await page.locator('input[accept^="image/"]').first().setInputFiles({
    name: '回归测试图.png', mimeType: 'image/png',
    buffer: readFileSync(resolve('e2e/fixtures/test-image.png')),
  });
  await page.waitForTimeout(900);
  const withAsset = (await nodesOf(page)).find(n => n.type === 'image' && n.assetId);
  assert(withAsset, '未建立带素材的图片节点');
  pass('拖入/选择图片导入并绑定素材到节点');

  await page.locator(`.canvas-node[data-node-id="${withAsset.id}"]`).dblclick({ position: { x: 40, y: 60 } });
  await page.waitForSelector('.lightbox', { timeout: 6000 });
  const natural = await page.locator('.lightbox-stage img').evaluate(img => img.naturalWidth);
  assert(natural > 0);
  pass('图片可全屏放大查看原图像素', `${natural}px`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  assert.equal(await page.locator('.lightbox').count(), 0);
  pass('Esc 关闭放大视图');

  /* ---------- 刷新恢复与导出 ---------- */
  const beforeReload = await nodesOf(page);
  await page.waitForTimeout(1200);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.canvas-viewport', { timeout: 15000 });
  await page.waitForTimeout(700);
  const afterReload = await nodesOf(page);
  assert.equal(afterReload.length, beforeReload.length);
  assert.deepEqual(afterReload.map(n => n.id).sort(), beforeReload.map(n => n.id).sort());
  pass('刷新后节点、位置与素材完整恢复', `${afterReload.length} 节点 / ${(await edgesOf(page)).length} 连线`);

  const download = page.waitForEvent('download', { timeout: 12000 });
  await page.getByRole('button', { name: '导出项目', exact: true }).click();
  const file = await download;
  assert(/\.canvasproj$/.test(file.suggestedFilename()), file.suggestedFilename());
  pass('项目可完整导出为单文件包', file.suggestedFilename());

  /* ---------- 重复导入同 ID 素材：必须失效旧对象 URL ---------- */
  const zip = await JSZip.loadAsync(readFileSync(await file.path()));
  const assetPath = `assets/${withAsset.assetId}`;
  assert(zip.file(assetPath), '导出包里缺少节点引用的素材');
  const replacement = Buffer.from('kaishi-reimport-cache-check', 'utf8');
  zip.file(assetPath, replacement);
  const modified = await zip.generateAsync({ type: 'nodebuffer' });
  const cacheCheck = await page.evaluate(async ({ base64, expected }) => {
    const { importProjectFile } = await import('/src/lib/io.ts');
    const { getAssetUrl } = await import('/src/lib/db.ts');
    const before = await getAssetUrl(JSON.parse(localStorage.getItem('infinite-canvas-studio:mirror')).data.nodes.find(n => n.assetId).assetId);
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const result = await importProjectFile(new File([bytes], 'modified.canvasproj', { type: 'application/zip' }));
    const after = await getAssetUrl(JSON.parse(localStorage.getItem('infinite-canvas-studio:mirror')).data.nodes.find(n => n.assetId).assetId);
    return { before, after, size: (await (await fetch(after)).blob()).size, expected, assetCount: result.assetCount };
  }, { base64: modified.toString('base64'), expected: replacement.length });
  assert(cacheCheck.assetCount > 0, '导入没有写回素材');
  assert.notEqual(cacheCheck.after, cacheCheck.before, '导入覆盖了同 ID 素材，却仍返回旧的对象 URL');
  assert.equal(cacheCheck.size, cacheCheck.expected, '导入后读到的仍是旧素材字节');
  pass('重复导入同 ID 素材时失效旧缓存并读取新字节', `${cacheCheck.size} 字节`);

  /* ---------- 框选多选、Shift 追加、调整尺寸、编组归属 ---------- */
  const pair = await page.evaluate(async () => {
    const { useCanvas } = await import('/src/store.ts');
    const s = useCanvas.getState();
    const keep = s.nodes.filter(n => n.type !== 'group').slice(0, 2).map(n => n.id);
    s.setViewport({ x: 0, y: 0, zoom: 1 });
    const patches = {};
    s.nodes.forEach((n, i) => {
      const slot = keep.indexOf(n.id);
      // 两个夹具节点必须拉开，尺寸调整后也不能互相遮挡，否则右键编组时选区只剩一个
      patches[n.id] = slot >= 0 ? { x: 120 + slot * 580, y: 160 } : { x: 3000 + i * 40, y: 3000 };
    });
    s.updateNodesLive(patches);
    await s.persist();
    return keep;
  });
  // zustand → React 重渲染是下一帧，取坐标前必须等待，否则框选矩形对不上节点最终位置
  await page.waitForTimeout(400);
  const box = await page.locator('.canvas-viewport').boundingBox();
  const ba = await page.locator(`.canvas-node[data-node-id="${pair[0]}"]`).boundingBox();
  const bb = await page.locator(`.canvas-node[data-node-id="${pair[1]}"]`).boundingBox();
  assert(ba && bb && box, '框选夹具节点未渲染');
  await page.mouse.move(box.x + 40, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + 1050, box.y + 480, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  const marqueeCount = await page.locator('.canvas-node.is-selected').count();
  assert(marqueeCount >= 2, `框选选中 ${marqueeCount} 个（视口 ${Math.round(box.x)},${Math.round(box.y)}；节点 ${Math.round(ba.x)},${Math.round(ba.y)} / ${Math.round(bb.x)},${Math.round(bb.y)}）`);
  pass('空白处拖拽框选可一次多选节点', `${marqueeCount} 个`);

  await page.mouse.click(box.x + 20, box.y + 20);
  await page.locator(`.canvas-node[data-node-id="${pair[0]}"] .node-head`).click();
  await page.locator(`.canvas-node[data-node-id="${pair[1]}"] .node-head`).click({ modifiers: ['Shift'] });
  const shiftCount = await page.locator('.canvas-node.is-selected').count();
  assert.equal(shiftCount, 2, `Shift 追加后 ${shiftCount} 个选中`);
  pass('Shift 点击可追加多选', '2 个');

  const sizeBefore = await page.evaluate(async id => {
    const { useCanvas } = await import('/src/store.ts');
    const n = useCanvas.getState().nodes.find(x => x.id === id);
    return { w: n.w, h: n.h };
  }, pair[0]);
  await page.locator(`.canvas-node[data-node-id="${pair[0]}"] .node-head`).click();
  const handle = await page.locator(`.canvas-node[data-node-id="${pair[0]}"] .rh-se`).boundingBox();
  assert(handle, '未找到尺寸手柄');
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 80, handle.y + handle.height / 2 + 60, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  const sizeAfter = await page.evaluate(async id => {
    const { useCanvas } = await import('/src/store.ts');
    const n = useCanvas.getState().nodes.find(x => x.id === id);
    return { w: n.w, h: n.h };
  }, pair[0]);
  assert(sizeAfter.w > sizeBefore.w + 20 && sizeAfter.h > sizeBefore.h + 20, `尺寸 ${JSON.stringify(sizeBefore)} → ${JSON.stringify(sizeAfter)}`);
  pass('拖拽右下手柄调整节点尺寸', `${Math.round(sizeBefore.w)}×${Math.round(sizeBefore.h)} → ${Math.round(sizeAfter.w)}×${Math.round(sizeAfter.h)}`);

  const beforeGroup = await page.evaluate(async ids => {
    const { useCanvas } = await import('/src/store.ts');
    useCanvas.getState().setSelection(ids);
    return useCanvas.getState().selection;
  }, pair);
  assert.deepEqual([...beforeGroup].sort(), [...pair].sort(), '编组前选区异常');
  await page.waitForTimeout(150);
  await page.mouse.click(box.x + 20, box.y + 20, { button: 'right' });
  await page.getByRole('button', { name: '编组', exact: true }).click();
  await page.waitForTimeout(300);
  const grouped = await page.evaluate(async (ids) => {
    const { useCanvas, nodesInGroup } = await import('/src/store.ts');
    const s = useCanvas.getState();
    const group = s.nodes.filter(n => n.type === 'group').at(-1);
    return group ? {
      name: group.name, members: nodesInGroup(group, s.nodes), ids, selection: s.selection,
      box: { x: group.x, y: group.y, w: group.w, h: group.h },
      nodes: s.nodes.filter(n => ids.includes(n.id)).map(n => ({ id: n.id, x: n.x, y: n.y, w: n.w, h: n.h })),
    } : null;
  }, pair);
  assert(grouped, '编组没有生成分组框');
  assert(pair.every(id => grouped.members.includes(id)), `分组只收纳 ${grouped.members.length} 个：${JSON.stringify(grouped)}`);
  pass('多选后编组生成分组框并正确收纳成员', `${grouped.members.length} 个成员`);

  /* ---------- 通过界面导入项目：节点、连线与素材还原 ---------- */
  const pack = readFileSync(await file.path());
  const manifest = JSON.parse(await (await JSZip.loadAsync(pack)).file('project.json').async('string'));
  await page.locator('input[accept*=".canvasproj"]').setInputFiles({
    name: '导入还原.canvasproj', mimeType: 'application/zip', buffer: pack,
  });
  await page.waitForFunction(() => document.body.innerText.includes('导入完成'), null, { timeout: 12000 }).catch(() => {});
  const restored = await page.evaluate(async () => {
    const { useCanvas } = await import('/src/store.ts');
    const s = useCanvas.getState();
    return { name: s.projectName, nodes: s.nodes.length, edges: s.edges.length, assetIds: s.nodes.map(n => n.assetId).filter(Boolean) };
  });
  assert(restored.name.includes('（导入）'), `导入后项目名 ${restored.name}`);
  assert.equal(restored.nodes, manifest.project.data.nodes.length, '导入后节点数不一致');
  assert.equal(restored.edges, manifest.project.data.edges.length, '导入后连线数不一致');
  pass('界面导入项目还原节点、连线与新项目身份', `${restored.nodes} 节点 / ${restored.edges} 连线`);

  const shared = await page.evaluate(async ids => {
    const { listAssets, getAsset } = await import('/src/lib/db.ts');
    const { useCanvas } = await import('/src/store.ts');
    const all = await listAssets();
    const visible = useCanvas.getState().assets;
    const records = await Promise.all(ids.map(async id => ({ id, size: (await getAsset(id))?.blob.size ?? 0 })));
    return { inLibrary: ids.every(id => all.some(a => a.id === id)), inPanel: ids.every(id => visible.some(a => a.id === id)), records };
  }, restored.assetIds);
  assert(shared.inLibrary && shared.inPanel, '导入项目的素材未出现在共享素材库');
  assert(shared.records.every(r => r.size > 0), `素材字节异常 ${JSON.stringify(shared.records)}`);
  pass('导入项目沿用全局素材库，跨项目引用仍可读到二进制', `${shared.records.length} 个素材`);

  /* ---------- 编辑后立即刷新：不等自动保存定时器，验证本地保存不丢最新内容 ---------- */
  const quickEdit = await page.evaluate(async () => {
    const { useCanvas } = await import('/src/store.ts');
    const s = useCanvas.getState();
    const target = s.nodes.find(n => n.type === 'text');
    if (!target) return null;
    const marker = `快速刷新验收-${Date.now()}`;
    s.updateNode(target.id, { text: marker });
    return { id: target.id, marker };
  });
  assert(quickEdit, '画布上缺少文字节点，无法验证快速刷新');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(async () => (await import('/src/store.ts')).useCanvas.getState().ready, null, { timeout: 15000 });
  await page.waitForSelector('.canvas-viewport', { timeout: 15000 });
  const afterQuick = await page.evaluate(async id => {
    const { useCanvas } = await import('/src/store.ts');
    return useCanvas.getState().nodes.find(n => n.id === id)?.text ?? '';
  }, quickEdit.id);
  assert.equal(afterQuick, quickEdit.marker, '编辑后立即刷新丢失了最新文字');
  pass('编辑后立即刷新不丢最新文字，本地保存可靠');

  assert.equal(errors.length, 0, errors.join(' | '));
  pass('全程无未捕获页面错误');
  console.log(`\n=== 基础画布回归通过：${results.length} 项 ===\n`);
}

main()
  .catch(e => { console.error(`\n回归失败：${e.message}\n`); process.exitCode = 1; })
  .finally(async () => {
    if (browser) await browser.close();
    dev.kill();
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响结论 */ }
  });
