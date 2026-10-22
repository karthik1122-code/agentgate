import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { createRuntime, GateError } from './src/runtime.mjs';
import { createMemoryStore } from './src/store.mjs';
import { createPostgresStore } from './src/store-pg.mjs';
import { createAuth, createMemoryAuthStore, createPostgresAuthStore, AuthError } from './src/auth.mjs';
import { createWorld, DEFAULT_FILES, TOOLS, prepareCall, ArgError } from './src/tools.mjs';
import { evaluatePolicy } from './src/policy.mjs';
import { verifyChain } from './src/chain.mjs';
import { SCENARIOS, planners } from './src/scenarios.mjs';
import { createPlayground } from './src/play.mjs';
import { createPlayHttp, clientIp } from './src/play-http.mjs';

const port = Number(process.env.PORT || 4200);
const publicRoot = new URL('./public/', import.meta.url).pathname;
const policy = JSON.parse(readFileSync(new URL('./policies/default.json', import.meta.url), 'utf8'));
const store = process.env.DATABASE_URL ? await createPostgresStore({ connectionString: process.env.DATABASE_URL }) : createMemoryStore();
let world = createWorld(DEFAULT_FILES);
const runtime = createRuntime({ store, policy, planners, get world() { return world; } });
// Accounts are on by default. AUTH=off is a local demo mode where the browser names the approver; never expose it publicly.
const AUTH_ON = process.env.AUTH !== 'off';
// Visitors can create their own account (viewer role only). Set SIGNUP=off to close it.
const SIGNUP_ON = AUTH_ON && process.env.SIGNUP !== 'off';
const SETUP_TOKEN = process.env.SETUP_TOKEN || '';
const auth = createAuth({ db: store._pool ? await createPostgresAuthStore(store._pool) : createMemoryAuthStore() });

const MAX_BODY = 8 * 1024;
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const headers = {
  'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
};
const play = createPlayHttp(createPlayground(policy));
const hits = new Map();
const limited = ip => { const now = Date.now(); const l = (hits.get(ip) || []).filter(t => now - t < 60_000); l.push(now); hits.set(ip, l); return l.length > 240; };
const send = (res, status, body, extra = {}) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers, ...extra }); res.end(JSON.stringify(body)); };
const readJson = req => new Promise((resolve, reject) => {
  let size = 0, big = false; const chunks = [];
  req.on('data', c => { if (big) return; size += c.length; if (size > MAX_BODY) { big = true; req.resume(); reject(Object.assign(new Error('too_large'), { status: 413 })); } else chunks.push(c); });
  req.on('end', () => { if (big) return; try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(Object.assign(new Error('invalid_json'), { status: 400 })); } });
  req.on('error', reject);
});
const cookieOf = req => { const m = /(?:^|;\s*)ag_session=([\w-]+)/.exec(req.headers.cookie || ''); return m ? m[1] : ''; };
const secure = req => process.env.NODE_ENV === 'production' || req.headers['x-forwarded-proto'] === 'https';
const setCookie = (req, token, maxAge) => `ag_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure(req) ? '; Secure' : ''}`;
const DEMO_USER = { id: 'demo', email: 'demo@local', name: 'Demo', role: 'admin' };
const authStatus = code => ({ bad_credentials: 401, locked: 429, already_set_up: 409, email_taken: 409, not_found: 404, self_delete: 409, last_admin: 409, needs_setup: 409, signup_limited: 429, self_role: 409 }[code] || 400);

const summary = state => ({ runId: state.runId, planner: state.planner, actor: state.actor, status: state.status, abortReason: state.abortReason, calls: state.calls.map(c => ({ id: c.id, tool: c.tool, args: c.args, facts: c.facts, hash: c.hash, state: c.state, decision: c.decision, outcome: c.outcome, approval: c.approval })), denials: state.denials });
async function runView(id) {
  const v = await runtime.view(id);
  if (!v.run) return null;
  return { run: v.run, state: summary(v.state), events: v.events, integrity: verifyChain(v.events) };
}

const gateStatus = code => ({ not_found: 404, not_pending: 409, already_decided: 409, expired: 410, hash_mismatch: 409, same_actor: 403, invalid_decision: 400, invalid_approver: 400, unknown_planner: 400, invalid_actor: 400 }[code] || 400);

async function route(req, res, url) {
  const mutating = req.method !== 'GET' && req.method !== 'HEAD';
  // Browsers cannot add a custom header cross-site without a CORS preflight, and this server sends no CORS headers.
  if (mutating && !req.headers['x-ag-csrf']) return send(res, 403, { error: 'csrf_header_required' });
  const token = cookieOf(req);
  const user = AUTH_ON ? await auth.userFromToken(token) : DEMO_USER;
  if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { status: 'ok', store: store.kind, policyHash: runtime.policyHash, auth: AUTH_ON ? 'accounts' : 'off (demo)', limits: runtime.limits });
  if (req.method === 'GET' && url.pathname === '/api/auth/me') return send(res, 200, { authEnabled: AUTH_ON, needsSetup: AUTH_ON && await auth.needsSetup(), setupTokenRequired: !!SETUP_TOKEN, signupOpen: SIGNUP_ON, user });
  if (AUTH_ON && req.method === 'POST' && url.pathname === '/api/auth/setup') {
    const body = await readJson(req);
    if (SETUP_TOKEN && body.setupToken !== SETUP_TOKEN) return send(res, 403, { error: 'invalid_setup_token', message: 'the setup token is wrong' });
    try { await auth.setup(body); const s = await auth.login(body.email, body.password, clientIp(req)); return send(res, 201, { user: s.user }, { 'set-cookie': setCookie(req, s.token, s.maxAge) }); }
    catch (e) { if (e instanceof AuthError) return send(res, authStatus(e.code), { error: e.code, message: e.message }); throw e; }
  }
  if (SIGNUP_ON && req.method === 'POST' && url.pathname === '/api/auth/signup') {
    const body = await readJson(req);
    try { await auth.signup(body, clientIp(req)); const s = await auth.login(body.email, body.password, clientIp(req)); return send(res, 201, { user: s.user }, { 'set-cookie': setCookie(req, s.token, s.maxAge) }); }
    catch (e) { if (e instanceof AuthError) return send(res, authStatus(e.code), { error: e.code, message: e.message }); throw e; }
  }
  if (AUTH_ON && req.method === 'POST' && url.pathname === '/api/auth/login') {
    const body = await readJson(req);
    try { const s = await auth.login(body.email, body.password, clientIp(req)); return send(res, 200, { user: s.user }, { 'set-cookie': setCookie(req, s.token, s.maxAge) }); }
    catch (e) { if (e instanceof AuthError) return send(res, authStatus(e.code), { error: e.code, message: e.message }); throw e; }
  }
  if (AUTH_ON && req.method === 'POST' && url.pathname === '/api/auth/logout') { await auth.logout(token); return send(res, 200, { ok: true }, { 'set-cookie': setCookie(req, '', 0) }); }
  if (!user) return send(res, 401, { error: 'sign_in_required' });
  const need = role => { if (auth.can(user, role)) return false; send(res, 403, { error: 'forbidden', message: `this needs the ${role} role` }); return true; };
  if (url.pathname === '/api/users' || /^\/api\/users\/[\w-]+$/.test(url.pathname)) {
    if (need('admin')) return true;
    try {
      if (req.method === 'GET' && url.pathname === '/api/users') return send(res, 200, await auth.listUsers());
      if (req.method === 'POST' && url.pathname === '/api/users') return send(res, 201, await auth.createUser(await readJson(req)));
      if (req.method === 'PATCH' && url.pathname !== '/api/users') return send(res, 200, await auth.setRole(url.pathname.split('/').pop(), (await readJson(req)).role, user.id));
      if (req.method === 'DELETE') { await auth.deleteUser(url.pathname.split('/').pop(), user.id); return send(res, 200, { ok: true }); }
    } catch (e) { if (e instanceof AuthError) return send(res, authStatus(e.code), { error: e.code, message: e.message }); throw e; }
  }
  const m = url.pathname.match(/^\/api\/runs\/([\w-]+)(?:\/calls\/(c\d+)\/decision)?$/);
  if (req.method === 'GET' && url.pathname === '/api/scenarios') return send(res, 200, Object.entries(SCENARIOS).map(([id, s]) => ({ id, title: s.title, description: s.description })));
  if (req.method === 'GET' && url.pathname === '/api/policy') return send(res, 200, { policy, hash: runtime.policyHash, tools: Object.fromEntries(Object.entries(TOOLS).map(([k, t]) => [k, { description: t.description, fields: t.fields }])) });
  if (req.method === 'GET' && url.pathname === '/api/world') return send(res, 200, { outbox: world.outbox, ledger: world.ledger, commands: world.commands, files: [...world.files.keys()] });
  if (req.method === 'POST' && url.pathname === '/api/world/reset') { if (need('admin')) return true; world = createWorld(DEFAULT_FILES); return send(res, 200, { ok: true }); }
  if (req.method === 'POST' && url.pathname === '/api/policy/check') {
    if (need('approver')) return true;
    const { tool, args } = await readJson(req);
    try {
      const call = prepareCall(tool, args, { maxArgsBytes: runtime.limits.maxArgsBytes });
      const d = evaluatePolicy(policy, call.tool, { args: call.args, facts: call.facts, run: { calls: 0, denials: 0 }, projected: Object.fromEntries(Object.entries(call.args).filter(([, v]) => typeof v === 'number')) });
      return send(res, 200, { stage: 'policy', effect: d.effect, reason: d.reason, rules: d.rules, default: d.default, canonical: call.args, facts: call.facts });
    } catch (error) { if (error instanceof ArgError) return send(res, 200, { stage: 'validation', effect: 'deny', reason: error.message, rules: [] }); throw error; }
  }
  if (req.method === 'GET' && url.pathname === '/api/runs') {
    const runs = await store.listRuns(50);
    return send(res, 200, await Promise.all(runs.map(async r => { const v = await runtime.view(r.id); return { id: r.id, planner: r.planner, actor: r.actor, status: v.state.status, created_at: r.created_at, calls: v.state.calls.length, denials: v.state.denials }; })));
  }
  if (req.method === 'POST' && url.pathname === '/api/runs') {
    if (need('approver')) return true;
    const { scenario } = await readJson(req);
    if (!Object.hasOwn(SCENARIOS, scenario)) return send(res, 400, { error: 'unknown_scenario' });
    const state = await runtime.startRun({ planner: scenario, actor: `agent:${scenario}` });
    return send(res, 201, await runView(state.runId));
  }
  if (req.method === 'GET' && url.pathname === '/api/approvals') {
    const pending = [];
    for (const r of await store.listByStatus('waiting_approval')) {
      const v = await runtime.view(r.id);
      for (const c of v.state.calls.filter(x => x.state === 'pending_approval')) pending.push({ runId: r.id, actor: r.actor, planner: r.planner, call: { id: c.id, tool: c.tool, args: c.args, facts: c.facts, hash: c.hash, reason: c.decision.reason, rules: c.decision.rules.map(x => x.id), expiresAt: c.approval.expiresAt, requestedAt: c.approval.requestedAt } });
    }
    return send(res, 200, pending);
  }
  if (req.method === 'GET' && url.pathname === '/api/stats') {
    const runs = await store.listRuns(30);
    const views = (await Promise.all(runs.map(r => runView(r.id)))).filter(Boolean);
    const s = { runs: runs.length, calls: 0, allow: 0, approve: 0, deny: 0, stopped: 0, valid: 0, checked: views.length, tools: {}, feed: [] };
    for (const v of views) {
      if (v.integrity.valid) s.valid += 1;
      const toolOf = new Map(v.state.calls.map(c => [c.id, c.tool]));
      for (const c of v.state.calls) {
        s.calls += 1; const eff = c.decision && c.decision.effect; if (eff) s[eff] += 1;
        const t = (s.tools[c.tool] ||= { allow: 0, approve: 0, deny: 0 }); if (eff) t[eff] += 1;
        if (['denied', 'rejected', 'expired'].includes(c.state)) s.stopped += 1;
      }
      for (const e of v.events) { const d = e.data || {}; s.feed.push({ at: e.at, type: e.type, run: v.state.runId, data: { tool: d.tool || toolOf.get(d.call_id), effect: d.effect, reason: d.reason, by: d.by, planner: d.planner } }); }
    }
    s.feed.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)); s.feed = s.feed.slice(0, 12);
    return send(res, 200, s);
  }
  if (m && req.method === 'GET' && !m[2]) { const v = await runView(m[1]); return v ? send(res, 200, v) : send(res, 404, { error: 'not_found' }); }
  if (m && m[2] && req.method === 'POST') {
    if (need('approver')) return true;
    const body = await readJson(req);
    const by = AUTH_ON ? `human:${user.email}` : body.by;
    try { await runtime.decide(m[1], m[2], { by, decision: body.decision, hash: body.hash, note: body.note }); }
    catch (error) { if (error instanceof GateError) return send(res, gateStatus(error.code), { error: error.code, message: error.message }); throw error; }
    return send(res, 200, await runView(m[1]));
  }
  return null;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname.startsWith('/api/play/')) return play(req, res, url.pathname.slice('/api/play/'.length));
      if (limited(clientIp(req))) return send(res, 429, { error: 'rate_limited' });
      const handled = await route(req, res, url);
      if (handled === null) send(res, 404, { error: 'not_found' });
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      let requested; try { requested = decodeURIComponent(url.pathname); } catch { return send(res, 400, { error: 'bad_path' }); }
      if (requested === '/') requested = '/index.html';
      else if (requested === '/app') requested = '/app.html';
      const path = normalize(join(publicRoot, requested));
      const type = mime[extname(path)];
      if (!path.startsWith(publicRoot.endsWith(sep) ? publicRoot : publicRoot + sep) || !type) return send(res, 404, { error: 'not_found' });
      let file; try { file = await readFile(path); } catch { return send(res, 404, { error: 'not_found' }); }
      res.writeHead(200, { 'content-type': type, 'cache-control': requested.endsWith('.html') ? 'no-cache' : 'public, max-age=300', ...headers });
      return res.end(req.method === 'HEAD' ? undefined : file);
    }
    send(res, 404, { error: 'not_found' });
  } catch (error) {
    if (error.status) return send(res, error.status, { error: error.message });
    console.error(error); if (!res.headersSent) send(res, 500, { error: 'internal_error' }); else res.end();
  }
});

setInterval(() => auth.sweep().catch(() => {}), 600_000).unref();
setInterval(() => runtime.expireStale().catch(e => console.error('expireStale failed:', e.message)), 30_000).unref();
server.listen(port, () => console.log(`AgentGate ready at http://localhost:${port} (${store.kind}, auth: ${AUTH_ON ? 'accounts' : 'OFF (demo)'})`));
