import { config } from '../config.mjs';
import { SECURITY_HEADERS, clientIp } from '../play-http.mjs';

// Low-level HTTP helpers shared by every route.
export { clientIp };

export const send = (res, status, body, extra = {}) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS, ...extra });
  res.end(JSON.stringify(body));
  return true; // routes return this to say "handled"
};

/** Reads a JSON body; rejects with { status: 413 | 400 } for a body that is too big or not JSON. */
export const readJson = req => new Promise((resolve, reject) => {
  let size = 0, big = false; const chunks = [];
  req.on('data', c => { if (big) return; size += c.length; if (size > config.maxBody) { big = true; req.resume(); reject(Object.assign(new Error('too_large'), { status: 413 })); } else chunks.push(c); });
  req.on('end', () => { if (big) return; try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(Object.assign(new Error('invalid_json'), { status: 400 })); } });
  req.on('error', reject);
});

// Session cookie: HttpOnly, SameSite=Strict, Secure over HTTPS.
export const cookieOf = req => { const m = /(?:^|;\s*)ag_session=([\w-]+)/.exec(req.headers.cookie || ''); return m ? m[1] : ''; };
const secure = req => config.isProduction || req.headers['x-forwarded-proto'] === 'https';
export const sessionCookie = (req, token, maxAge) => `ag_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure(req) ? '; Secure' : ''}`;

// Per-address limit for /api (the playground has its own).
const hits = new Map();
export const limited = ip => {
  const now = Date.now();
  // Forget visitors with no request in the last minute, so the map cannot grow without bound.
  if (hits.size > 5000) for (const [k, v] of hits) if (now - v[v.length - 1] >= 60_000) hits.delete(k);
  const l = (hits.get(ip) || []).filter(t => now - t < 60_000); l.push(now); hits.set(ip, l);
  return l.length > config.requestsPerMinute;
};
