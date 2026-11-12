import { execFile, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve as resolvePath, relative, isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { promisify } from 'node:util';

const exec = promisify(execFile);

function loginFailure(error) {
  if (typeof error === 'string' && /(?:country|region|territory).*not supported|unsupported_country_region_territory/i.test(error)) {
    return 'OpenAI 拒绝授权：当前国家或地区不受支持。';
  }
  return '授权未完成，请查看浏览器中的登录结果。';
}

async function codexCommand() {
  const command = process.platform === 'win32' ? 'codex.exe' : 'codex';
  try {
    await exec(command, ['--version'], { windowsHide: true, timeout: 5000 });
    return command;
  } catch {
    if (process.platform === 'win32') {
      try {
        const { stdout } = await exec('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-Command',
          '(Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1).InstallLocation',
        ], { windowsHide: true, timeout: 5000 });
        if (stdout.trim()) return join(stdout.trim(), 'app', 'resources', command);
      } catch { /* The user can install the official Codex runtime. */ }
    }
    throw new Error('未找到 Codex。请先安装官方 Codex 客户端或 CLI，然后重试。');
  }
}

export function createCodexClient(home, command = codexCommand, useInstalledAccount = false) {
  const cwd = join(home, 'workspace');
  const events = new EventEmitter();
  events.setMaxListeners(0);
  const pending = new Map();
  let nextId = 0;
  let child;
  let ready;
  let login;
  let loginError = '';
  let changingAccount = false;
  let activeTurns = 0;
  let closed = false;

  function stop(process) {
    if (child !== process) return;
    child = undefined;
    ready = undefined;
    if (login) loginError = '授权已中断，请重新登录。';
    login = undefined;
    for (const call of pending.values()) call.reject(new Error('Codex 本机服务已断开，请重试。'));
    pending.clear();
    events.emit('disconnect');
  }

  function write(message) {
    if (!child?.stdin.writable) throw new Error('Codex 本机服务不可用。');
    child.stdin.write(JSON.stringify(message) + '\n');
  }

  function rpc(method, params, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Codex 本机服务响应超时，请重试。'));
      }, timeout);
      pending.set(id, {
        resolve(value) { clearTimeout(timer); resolve(value); },
        reject(error) { clearTimeout(timer); reject(error); },
      });
      try { write({ id, method, params }); } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  async function connect() {
    if (closed) throw new Error('开视已关闭。');
    ready ??= (async () => {
      const executable = await command();
      if (closed) throw new Error('开视已关闭。');
      mkdirSync(cwd, { recursive: true });
      const env = { ...process.env };
      if (!useInstalledAccount) env.CODEX_HOME = home;
      delete env.OPENAI_API_KEY;
      delete env.CODEX_API_KEY;
      delete env.CODEX_ACCESS_TOKEN;
      const processHandle = spawn(executable, [
        'app-server', '--stdio', '-c', 'web_search="disabled"',
        '-c', 'mcp_servers={}',
        '--disable', 'shell_tool', '--disable', 'shell_snapshot',
        '--disable', 'apps', '--disable', 'plugins',
        ...(!useInstalledAccount ? ['-c', 'cli_auth_credentials_store="file"'] : []),
      ], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
      child = processHandle;
      child.on('error', () => stop(processHandle));
      child.on('close', () => stop(processHandle));
      child.stdin.on('error', () => stop(processHandle));
      createInterface({ input: child.stdout }).on('line', line => {
        if (child !== processHandle) return;
        let message;
        try { message = JSON.parse(line); } catch { return; }
        const { id, method, params, result, error } = message;
        if (id !== undefined && method) {
          // The canvas assistant uses the text returned by the turn. It grants no server requests.
          write({ id, error: { code: -32601, message: 'This client does not grant tool requests.' } });
          return;
        }
        if (id !== undefined) {
          const call = pending.get(id);
          pending.delete(id);
          if (error) call?.reject(new Error(error.message || 'Codex 请求失败。'));
          else call?.resolve(result);
          return;
        }
        if (method === 'account/login/completed' && login && params?.loginId === login.id) {
          login = undefined;
          loginError = params.success ? '' : loginFailure(params.error);
        }
        events.emit('notification', method, params);
      });
      try {
        await rpc('initialize', { clientInfo: { name: 'kaishi', title: '开视', version: '1.1.0' }, capabilities: { experimentalApi: true } });
        write({ method: 'initialized' });
      } catch (error) {
        processHandle.kill();
        throw error;
      }
    })().catch(error => {
      ready = undefined;
      throw error;
    });
    return ready;
  }

  async function status() {
    await connect();
    const { account } = await rpc('account/read', { refreshToken: false });
    return {
      account: account?.type === 'chatgpt' ? { email: account.email, plan: account.planType } : null,
      pending: Boolean(login),
      error: loginError,
    };
  }

  async function accountChange(action) {
    if (changingAccount || activeTurns) throw new Error('Codex 正在处理请求，请稍后再试。');
    changingAccount = true;
    try {
      await connect();
      return await action();
    } finally {
      changingAccount = false;
    }
  }

  async function startLogin() {
    return accountChange(async () => {
      const current = await status();
      if (current.account) throw new Error('请先退出开视当前的 Codex 账号。');
      if (login) return { authUrl: login.url };
      loginError = '';
      const { loginId, authUrl } = await rpc('account/login/start', { type: 'chatgpt' });
      const url = new URL(authUrl);
      if (url.protocol !== 'https:' || !['auth.openai.com', 'chatgpt.com'].includes(url.hostname)) {
        await rpc('account/login/cancel', { loginId });
        throw new Error('Codex 返回的授权地址无效。');
      }
      login = { id: loginId, url: url.href };
      return { authUrl: url.href };
    });
  }

  async function cancelLogin() {
    return accountChange(async () => {
      if (login) await rpc('account/login/cancel', { loginId: login.id });
      login = undefined;
      loginError = '';
      return status();
    });
  }

  async function logout() {
    return accountChange(async () => {
      if (login) await rpc('account/login/cancel', { loginId: login.id });
      await rpc('account/logout');
      login = undefined;
      loginError = '';
      return status();
    });
  }

  async function quota() {
    if (!(await status()).account) throw new Error('请先登录 Codex。');
    const { rateLimits } = await rpc('account/rateLimits/read', {});
    return [rateLimits?.primary, rateLimits?.secondary].filter(Boolean).map(limit => ({
      used: limit.usedPercent, minutes: limit.windowDurationMins, resetsAt: limit.resetsAt,
    }));
  }

  async function complete(messages, signal, images = [], imageMode = false) {
    if (changingAccount) throw new Error('Codex 正在切换账号，请稍后再试。');
    activeTurns++;
    let threadId;
    try {
      if (!(await status()).account) throw new Error('请先在「Agent 账号」登录 Codex。');
      signal.throwIfAborted();
      const instructions = messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n');
      const conversation = messages.filter(message => message.role !== 'system');
      const { thread } = await rpc('thread/start', {
        cwd, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only', environments: [],
        developerInstructions: imageMode ? '使用内置图片生成工具生成图片。不要使用命令、外部 API 或其他工具。' : (instructions || '根据用户的请求返回文本。不要使用工具。'),
      });
      threadId = thread.id;
      signal.throwIfAborted();
      const text = conversation.length === 1 ? conversation[0].content : JSON.stringify(conversation);
      return await new Promise((resolve, reject) => {
        let turnId;
        let lastText = '';
        let finalText = '';
        let imagePath = '';
        let imageFailure = '';
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(imageMode ? 600000 : 175000)]);
        function finish(error, value) {
          events.off('notification', onEvent);
          events.off('disconnect', onDisconnect);
          deadline.removeEventListener('abort', onAbort);
          if (error) reject(error); else resolve(value);
        }
        function onEvent(method, params) {
          if (params?.threadId !== threadId) return;
          if (method === 'turn/started') turnId = params.turn.id;
          if (method === 'item/completed' && params.item?.type === 'agentMessage') {
            lastText = params.item.text;
            if (params.item.phase === 'final_answer') finalText = lastText;
          }
          if (method === 'item/completed' && params.item?.type === 'imageGeneration') {
            imagePath = params.item.savedPath || '';
            if (params.item.failure) imageFailure = 'Codex 图片生成失败，请检查账号额度后重试。';
          }
          if (method === 'turn/completed') {
            if (imageMode) {
              if (params.turn.status !== 'completed' || !imagePath) { finish(new Error(imageFailure || params.turn.error?.message || 'Codex 未返回生成图片。')); return; }
              const generatedRoot = resolvePath(useInstalledAccount ? (process.env.CODEX_HOME || join(homedir(), '.codex')) : home, 'generated_images', threadId);
              const rel = relative(generatedRoot, resolvePath(imagePath));
              if (!rel || rel.startsWith('..') || isAbsolute(rel)) { finish(new Error('Codex 返回的图片位置无效。')); return; }
              void readFile(imagePath).then(bytes => {
                if (bytes.length > 25_000_000 || bytes.length < 8 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('Codex 返回的图片格式无效。');
                finish(null, bytes.toString('base64'));
              }).catch(finish);
              return;
            }
            const result = finalText || lastText;
            if (params.turn.status === 'completed' && result) finish(null, result);
            else finish(new Error(params.turn.error?.message || 'Codex 未返回可用回复。'));
          }
        }
        function onDisconnect() { finish(new Error('Codex 本机服务已断开，请重试。')); }
        function onAbort() {
          if (turnId) void rpc('turn/interrupt', { threadId, turnId }).catch(() => {});
          finish(deadline.reason);
        }
        events.on('notification', onEvent);
        events.on('disconnect', onDisconnect);
        deadline.addEventListener('abort', onAbort, { once: true });
        void rpc('turn/start', { threadId, input: [{ type: 'text', text }, ...images.map(url => ({ type: 'image', url }))] })
          .then(({ turn }) => {
            turnId = turn.id;
            if (deadline.aborted) void rpc('turn/interrupt', { threadId, turnId }).catch(() => {});
          })
          .catch(finish);
      });
    } finally {
      if (threadId && child) void rpc('thread/unsubscribe', { threadId }).catch(() => {});
      activeTurns--;
    }
  }

  return { status, startLogin, cancelLogin, logout, quota, complete, generateImage: (prompt, signal, images = []) => complete([{ role: 'user', content: prompt }], signal, images, true), close() {
    closed = true;
    if (child) child.kill();
  } };
}
