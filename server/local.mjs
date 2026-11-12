import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { createCodexClient } from './codex.mjs';
import { h3Credentials, LOCAL_H3_TOKEN } from './h3Credentials.mjs';

// Local transport shared by Vite and the production server. No remote account or relay.
export function localApi(root) {
  const dataRoot = process.env.KAISHI_DATA_ROOT || root;
  const h3 = h3Credentials(dataRoot);
  const token = randomBytes(32).toString('hex');
  const tabs = new Map();
  const pending = new Map();
  const codexHome = process.env.KAISHI_RUNTIME_FILE
    ? resolve(dirname(process.env.KAISHI_RUNTIME_FILE), 'codex')
    : resolve(process.env.LOCALAPPDATA || resolve(root, '.local'), 'Kaishi', 'Codex');
  const codex = createCodexClient(codexHome);
  const installedCodex = createCodexClient(codexHome, undefined, true);
  let origin = '';
  let activeTab = '';
  const authenticated = (req) => {
    const supplied = Buffer.from(String(req.headers['x-kaishi-token'] || ''));
    const expected = Buffer.from(token);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  };
  const send = (res, status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  const body = async (req) => {
    const chunks = [];
    let length = 0;
    for await (const chunk of req) {
      length += chunk.length;
      if (length > 50_000_000) throw new Error('引用素材总体积过大，请减少图片后重试');
      chunks.push(chunk);
    }
    return length ? JSON.parse(Buffer.concat(chunks, length).toString('utf8')) : {};
  };
  const listen = (server) => {
    const start = () => {
      origin = `http://127.0.0.1:${server.address().port}`;
      mkdirSync(resolve(dataRoot, '.local'), { recursive: true });
      writeFileSync(process.env.KAISHI_RUNTIME_FILE || resolve(dataRoot, '.local/runtime.json'), JSON.stringify({ origin, token }), { mode: 0o600 });
    };
    if (server.listening) start(); else server.once('listening', start);
    server.once('close', () => {
      codex.close();
      installedCodex.close();
      for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error('开视已关闭')); }
      pending.clear();
    });
  };
  const handler = async (req, res, next) => {
    const url = new URL(req.url, origin || 'http://127.0.0.1');
    if (!url.pathname.startsWith('/api/local/')) return next();
    // Reject foreign websites and DNS rebinding, including requests without an Origin.
    if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) {
      return send(res, 403, { error: '仅允许开视本机访问' });
    }
    const route = url.pathname.slice('/api/local/'.length);
    if (route === 'health' && req.method === 'GET') return send(res, 200, { name: 'kaishi', version: '1.1.0' });
    if (!authenticated(req) && !(route === 'bootstrap' && req.headers.origin === origin && req.method === 'POST')) {
      return send(res, 401, { error: '连接凭据无效' });
    }
    try {
      if (route === 'upstream') {
        const target = new URL(String(req.headers['x-kaishi-upstream'] || ''));
        if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('模型服务地址无效');
        const headers = {};
        for (const key of ['authorization', 'x-api-key', 'anthropic-version', 'idempotency-key', 'content-type', 'bucket', 'ufile_indicated_region']) {
          const value = req.headers[`x-upstream-${key}`]; if (value) headers[key] = value;
        }
        if (headers.authorization === `Bearer ${LOCAL_H3_TOKEN}`) {
          if (target.origin !== 'https://cp.compshare.cn') throw new Error('本机 H3 凭据只能用于共绩算力官方接口');
          headers.authorization = `Bearer ${await h3.get()}`;
        }
        if (!headers['content-type'] && req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
        const abort = new AbortController();
        res.once('close', () => { if (!res.writableEnded) abort.abort(); });
        const upstream = await fetch(target, { method: req.method, headers, ...(['GET', 'HEAD'].includes(req.method) ? {} : { body: req, duplex: 'half' }), redirect: 'error', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15 * 60 * 1000)]) });
        res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': 'sandbox' });
        if (upstream.body) Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res); else res.end();
        return;
      }
      const data = req.method === 'POST' ? await body(req) : {};
      if (route === 'bootstrap' && req.method === 'POST') {
        return send(res, 200, { token, node: process.execPath, script: resolve(root, 'server/mcp.mjs') });
      }
      if (route === 'h3/import-local' && req.method === 'POST') return send(res, 200, { available: await h3.importLegacy() });
      if (route.startsWith('codex/') && req.method === 'POST') {
        res.setHeader('Referrer-Policy', 'no-referrer');
        const account = data.source === 'installed' ? installedCodex : codex;
        switch (route) {
          case 'codex/status': return send(res, 200, await account.status());
          case 'codex/login': return send(res, 200, await codex.startLogin());
          case 'codex/cancel': return send(res, 200, await codex.cancelLogin());
          case 'codex/logout': return send(res, 200, await codex.logout());
          case 'codex/quota': return send(res, 200, { limits: await account.quota() });
          case 'codex/image': {
            const { prompt, images = [] } = data;
            if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 20000) throw new Error('图片描述无效。');
            if (!Array.isArray(images) || images.some(image => typeof image !== 'string' || image.length > 500000 || !/^data:image\/(png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/.test(image))) throw new Error('图片引用无效或过大。');
            const abort = new AbortController();
            res.once('close', () => { if (!res.writableEnded) abort.abort(); });
            return send(res, 200, { image: await account.generateImage(prompt, abort.signal, images) });
          }
          case 'codex/reply': {
            const { messages, images = [] } = data;
            if (!Array.isArray(messages) || !messages.length || messages.length > 32
              || messages.some(message => !message || !['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string')
              || !messages.some(message => message.role === 'user')) throw new Error('Codex 对话内容无效。');
            if (!Array.isArray(images) || images.some(image => typeof image !== 'string' || image.length > 500000 || !/^data:image\/(png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/.test(image))) throw new Error('图片引用无效或过大。');
            const abort = new AbortController();
            res.once('close', () => { if (!res.writableEnded) abort.abort(); });
            return send(res, 200, { text: await account.complete(messages, abort.signal, images) });
          }
        }
      }
      if (route === 'heartbeat' && req.method === 'POST') {
        for (const [id, tab] of tabs) if (tab.at < Date.now() - 10000) tabs.delete(id);
        const previous = tabs.get(data.tabId);
        const verified = previous?.projectId === data.projectId && previous.verified;
        tabs.set(data.tabId, { projectId: data.projectId, project: data.project, at: Date.now(), verified });
        if (data.active || !activeTab || !tabs.has(activeTab)) activeTab = data.tabId;
        const active = tabs.get(activeTab);
        return send(res, 200, { active: activeTab === data.tabId, project: active?.project, clients: Boolean(verified) && activeTab === data.tabId });
      }
      if (route === 'poll') {
        const tab = url.searchParams.get('tab');
        const tasks = [];
        for (const task of pending.values()) {
          if (task.tabId === tab && !task.delivered && task.deadline > Date.now()) {
            task.delivered = true;
            tasks.push({ id: task.id, method: task.method, args: task.args, projectId: task.projectId, deadline: task.deadline });
          }
        }
        return send(res, 200, tasks);
      }
      if (route === 'result' && req.method === 'POST') {
        const task = pending.get(data.id);
        if (!task || task.tabId !== data.tabId) return send(res, 409, { error: '操作已过期' });
        pending.delete(data.id); clearTimeout(task.timer);
        const tab = tabs.get(task.tabId);
        if (!data.error && tab?.projectId === task.projectId) tab.verified = true;
        data.error ? task.reject(new Error(data.error)) : task.resolve(data.result);
        return send(res, 200, { ok: true });
      }
      if (route === 'rpc' && req.method === 'POST') {
        const tab = tabs.get(activeTab);
        if (!tab || tab.at < Date.now() - 10000) return send(res, 409, { error: '请先打开开视画布；有多个窗口时，在目标画布点击“连接到此画布”' });
        if (data.projectId && data.projectId !== tab.projectId) return send(res, 409, { error: '当前项目已切换，请重新读取画布' });
        const id = randomUUID();
        const result = await new Promise((resolveTask, reject) => {
          const timer = setTimeout(() => { pending.delete(id); reject(new Error('画布操作超时，请先读取画布核对结果，不要直接重复生成')); }, 120000);
          pending.set(id, { id, method: data.method, args: data.args, projectId: tab.projectId, tabId: activeTab, deadline: Date.now() + 120000, timer, resolve: resolveTask, reject });
        });
        return send(res, 200, result);
      }
      return send(res, 404, { error: '接口不存在' });
    } catch (error) { return send(res, 400, { error: error.message }); }
  };
  return { handler, listen };
}
