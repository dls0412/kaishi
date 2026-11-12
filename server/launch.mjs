import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const origin = 'http://127.0.0.1:5173';
const health = async () => {
  try { const response = await fetch(`${origin}/api/local/health`, { signal: AbortSignal.timeout(750) }); return (await response.json()).name === 'kaishi'; } catch { return false; }
};
try {
  if (!await health()) {
    const entry = fileURLToPath(new URL('./start.mjs', import.meta.url));
    if (!existsSync(fileURLToPath(new URL('../dist/index.html', import.meta.url)))) throw new Error('请先在项目目录运行 npm run build');
    const child = spawn(process.execPath, [entry], { detached: true, windowsHide: true, stdio: 'ignore', env: { ...process.env, PORT: '5173' } });
    child.unref();
    for (let i = 0; i < 20 && !await health(); i++) await new Promise(resolve => setTimeout(resolve, 150));
    if (!await health()) throw new Error('开视无法启动，可能是 5173 端口被其它应用占用。');
  }
  if (!process.argv.includes('--no-browser')) {
    const chrome = ['ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA'].map(key => process.env[key]).filter(Boolean)
      .map(base => join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    const edge = ['ProgramFiles(x86)', 'ProgramFiles'].map(key => process.env[key]).filter(Boolean)
      .map(base => join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    const browser = [...chrome, ...edge].find(path => existsSync(path));
    const launchOptions = { detached: true, windowsHide: true, stdio: 'ignore' };
    const openBrowser = () => spawn('rundll32.exe', ['url.dll,FileProtocolHandler', `${origin}/`], launchOptions).unref();
    if (browser && !process.argv.includes('--browser')) {
      const window = spawn(browser, [`--app=${origin}/`], { ...launchOptions, windowsHide: false });
      window.once('error', openBrowser);
      window.unref();
    } else openBrowser();
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
