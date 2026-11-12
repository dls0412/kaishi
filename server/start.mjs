import { createServer } from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localApi } from './local.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const dist = resolve(root, 'dist');
if (!existsSync(resolve(dist, 'index.html'))) throw new Error('请先运行 npm run build');
const api = localApi(root);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = createServer((req, res) => api.handler(req, res, () => {
  const path = resolve(dist, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
  if (path !== dist && !path.startsWith(dist + sep)) { res.writeHead(403); return res.end(); }
  const file = existsSync(path) && extname(path) ? path : resolve(dist, 'index.html');
  res.setHeader('Content-Type', types[extname(file)] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-cache');
  createReadStream(file).on('error', () => { res.writeHead(404); res.end(); }).pipe(res);
}));
api.listen(server);
server.listen(Number(process.env.PORT || 5173), '127.0.0.1', () => console.log(`开视已启动：http://127.0.0.1:${server.address().port}`));
