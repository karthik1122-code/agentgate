/** HTTP wrapper for the playground. Used by server.mjs and by the Vercel functions in api/play/, so there is one implementation. */
import { PlayError } from './play.mjs';

const MAX_BODY = 96 * 1024;
const ROUTES = { meta: 'GET', check: 'POST', run: 'POST', verify: 'POST' };
export const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
};

/** Behind a proxy every request arrives from the proxy, so the client address comes from X-Forwarded-For. Only trusted when told to. */
export function clientIp(req) {
  if (process.env.VERCEL || process.env.TRUST_PROXY) {
    const first = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (first) return first;
  }
  return req.socket?.remoteAddress || 'unknown';
}

const readBody = req => new Promise((resolve, reject) => {
  if (req.body !== undefined && req.body !== null && process.env.VERCEL) {
    const b = typeof req.body === 'string' ? req.body : Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body);
    if (b.length > MAX_BODY) return reject(new PlayError('request too large', 413));
    try { return resolve(b ? JSON.parse(b) : {}); } catch { return reject(new PlayError('invalid JSON')); }
  }
  let size = 0, big = false; const chunks = [];
  req.on('data', c => { if (big) return; size += c.length; if (size > MAX_BODY) { big = true; req.resume(); reject(new PlayError('request too large', 413)); } else chunks.push(c); });
  req.on('end', () => { if (big) return; try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new PlayError('invalid JSON')); } });
  req.on('error', reject);
});

export function createPlayHttp(play, { perMinute = Number(process.env.PLAY_RATE_LIMIT || 60) } = {}) {
  const hits = new Map();
  const limited = ip => {
    const now = Date.now();
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(t => now - t < 60_000)) hits.delete(k);
    const list = (hits.get(ip) || []).filter(t => now - t < 60_000); list.push(now); hits.set(ip, list);
    return list.length > perMinute;
  };
  const send = (res, status, body, extra = {}) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS, ...extra }); res.end(JSON.stringify(body)); };
  return async function handle(req, res, name) {
    try {
      const want = ROUTES[name];
      if (!want) return send(res, 404, { error: 'not_found' });
      if (req.method !== want) return send(res, 405, { error: 'method_not_allowed' }, { allow: want });
      if (limited(clientIp(req))) return send(res, 429, { error: 'rate_limited', message: 'Too many tries. Wait a minute.' });
      if (name === 'meta') return send(res, 200, play.meta(), { 'cache-control': 'public, max-age=300' });
      const body = await readBody(req);
      return send(res, 200, play[name](body));
    } catch (error) {
      if (error instanceof PlayError) return send(res, error.status, { error: 'bad_request', message: error.message });
      console.error(error); return send(res, 500, { error: 'internal_error' });
    }
  };
}
