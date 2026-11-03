import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { SECURITY_HEADERS } from '../../play-http.mjs';
import { send } from '../respond.mjs';

const publicRoot = new URL('../../../public/', import.meta.url).pathname;
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

// Files from public/ only. The path is normalised and must stay inside public/, so ../ tricks get 404.
export async function staticRoutes(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  let requested; try { requested = decodeURIComponent(url.pathname); } catch { return send(res, 400, { error: 'bad_path' }); }
  if (requested === '/') requested = '/index.html';
  else if (requested === '/app') requested = '/app.html';
  const path = normalize(join(publicRoot, requested));
  const type = mime[extname(path)];
  if (!path.startsWith(publicRoot.endsWith(sep) ? publicRoot : publicRoot + sep) || !type) return send(res, 404, { error: 'not_found' });
  let file; try { file = await readFile(path); } catch { return send(res, 404, { error: 'not_found' }); }
  res.writeHead(200, { 'content-type': type, 'cache-control': requested.endsWith('.html') ? 'no-cache' : 'public, max-age=300', ...SECURITY_HEADERS });
  res.end(req.method === 'HEAD' ? undefined : file);
  return true;
}
