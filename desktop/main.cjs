const { app, BrowserWindow, shell, dialog } = require('electron');
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const http = require('node:http');
const net = require('node:net');

const port = 5188;
const origin = `http://127.0.0.1:${port}`;
let server;
let mainWindow;

function waitForServer() {
  return new Promise((resolve, reject) => {
    let tries = 0;
    const check = () => {
      if (server.exitCode !== null) return reject(new Error('本地服务启动失败，端口可能已被占用。'));
      const req = http.get(`${origin}/api/local/health`, res => {
        let body = '';
        res.on('data', data => { body += data; });
        res.on('end', () => {
          try { if (JSON.parse(body).name === 'kaishi' && server.exitCode === null) return resolve(); } catch {}
          retry();
        });
      });
      req.on('error', retry);
      req.setTimeout(500, () => req.destroy());
    };
    const retry = () => ++tries < 80 ? setTimeout(check, 150) : reject(new Error('本地服务启动超时。'));
    check();
  });
}

async function openApp() {
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', () => reject(new Error(`本地端口 ${port} 已被占用，请关闭占用程序后重试。`)));
    probe.listen(port, '127.0.0.1', () => probe.close(resolve));
  });
  const root = join(process.resourcesPath, 'kaishi');
  const node = join(root, 'node.exe');
  server = spawn(node, [join(root, 'server', 'start.mjs')], {
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env, PORT: String(port), KAISHI_DATA_ROOT: join(process.env.LOCALAPPDATA || app.getPath('appData'), 'Kaishi', 'Desktop') },
  });
  await new Promise((resolve, reject) => { server.once('spawn', resolve); server.once('error', reject); });
  await waitForServer();
  mainWindow = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 620,
    title: '开视', backgroundColor: '#111116', autoHideMenuBar: true,
    icon: join(root, 'kaishi.ico'),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(origin + '/')) { event.preventDefault(); if (/^https?:\/\//i.test(url)) shell.openExternal(url); }
  });
  await mainWindow.loadURL(origin);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
  app.whenReady().then(openApp).catch(error => { dialog.showErrorBox('开视启动失败', error.message); app.quit(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { if (server && !server.killed) server.kill(); });
}
