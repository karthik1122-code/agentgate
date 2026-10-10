import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const PORT = 4400 + Math.floor(Math.random() * 400);
const base = `http://127.0.0.1:${PORT}`;
let child;
const post = (path, body, headers = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { 'x-ag-csrf': '1', ...headers }, body: JSON.stringify(body) });

async function start(env) {
  child = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, DATABASE_URL: '', AUTH: 'off', PORT: String(PORT), ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => { child.stdout.on('data', d => String(d).includes('ready') && resolve()); child.on('error', reject); setTimeout(() => reject(new Error('server did not start')), 5000); });
}
const stop = async () => { child.kill(); await once(child, 'exit'); };

test('demo mode: refund scenario waits for approval, approval is bound to the hash', async () => {
  await start({});
  try {
    const home = await fetch(`${base}/`);
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-security-policy'), /default-src 'self'/);
    for (const path of ['/.env', '/server.mjs', '/package.json', '/%2e%2e/server.mjs', '/src/runtime.mjs']) assert.equal((await fetch(`${base}${path}`)).status, 404, path);

    const started = await (await post('/api/runs', { scenario: 'support-refund' })).json();
    const runId = started.run.id;
    assert.equal(started.state.status, 'waiting_approval');
    assert.equal(started.integrity.valid, true);
    const [pending] = await (await fetch(`${base}/api/approvals`)).json();
    assert.equal(pending.call.tool, 'refund_payment');

    const wrong = await post(`/api/runs/${runId}/calls/${pending.call.id}/decision`, { by: 'human:a', decision: 'approve', hash: 'f'.repeat(64) });
    assert.equal(wrong.status, 409);
    const self = await post(`/api/runs/${runId}/calls/${pending.call.id}/decision`, { by: pending.actor, decision: 'approve', hash: pending.call.hash });
    assert.equal(self.status, 403);
    assert.equal((await (await fetch(`${base}/api/world`)).json()).ledger.length, 1, 'only the small refund ran so far');

    const ok = await post(`/api/runs/${runId}/calls/${pending.call.id}/decision`, { by: 'human:a', decision: 'approve', hash: pending.call.hash });
    assert.equal(ok.status, 200);
    const done = await ok.json();
    assert.equal(done.state.status, 'completed');
    assert.equal(done.integrity.valid, true);
    const again = await post(`/api/runs/${runId}/calls/${pending.call.id}/decision`, { by: 'human:b', decision: 'approve', hash: pending.call.hash });
    assert.equal(again.status, 409);
    assert.equal((await (await fetch(`${base}/api/world`)).json()).ledger.length, 2, 'the approved refund ran exactly once');
  } finally { await stop(); }
});

test('attack scenarios never cause side effects; bad input is rejected', async () => {
  await start({});
  try {
    for (const scenario of ['prompt-injection', 'path-traversal', 'shell-injection']) await post('/api/runs', { scenario });
    const w = await (await fetch(`${base}/api/world`)).json();
    assert.equal(w.outbox.length, 0);
    assert.ok(!w.commands.some(c => c.includes(';')));
    assert.equal((await post('/api/runs', { scenario: 'nope' })).status, 400);
    assert.equal((await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'x-ag-csrf': '1' }, body: '{bad' })).status, 400);
    assert.equal((await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'x-ag-csrf': '1' }, body: JSON.stringify({ pad: 'x'.repeat(20000) }) }).catch(() => ({ status: 413 }))).status, 413);
    const check = await (await post('/api/policy/check', { tool: 'run_command', args: { command: 'ls; cat x' } })).json();
    assert.equal(check.effect, 'deny');
  } finally { await stop(); }
});

const J = { 'x-ag-csrf': '1' };
function cookieJar() { let c = ''; return { set(res) { const sc = res.headers.get('set-cookie'); if (sc) c = sc.split(';')[0]; }, headers: () => ({ ...J, cookie: c }) }; }

test('accounts mode: sign-in required, setup once, roles enforced, approver named by the server', async () => {
  await start({ AUTH: 'on', SETUP_TOKEN: 'setup-secret-xyz' });
  try {
    const anon = await fetch(`${base}/api/runs`); assert.equal(anon.status, 401);
    const me = await (await fetch(`${base}/api/auth/me`)).json();
    assert.equal(me.needsSetup, true); assert.equal(me.user, null); assert.equal(me.setupTokenRequired, true);
    const admin = { email: 'admin@example.com', name: 'Admin', password: 'admin-password-123' };
    assert.equal((await post('/api/auth/setup', admin, J)).status, 403, 'setup needs the token');
    const nocsrf = await fetch(`${base}/api/auth/setup`, { method: 'POST', body: JSON.stringify({ ...admin, setupToken: 'setup-secret-xyz' }) });
    assert.equal(nocsrf.status, 403, 'mutating requests need the csrf header');
    const jar = cookieJar();
    const setup = await post('/api/auth/setup', { ...admin, setupToken: 'setup-secret-xyz' }, J);
    assert.equal(setup.status, 201); jar.set(setup);
    assert.match(setup.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    assert.equal((await post('/api/auth/setup', { ...admin, setupToken: 'setup-secret-xyz' }, J)).status, 409);

    const viewer = await post('/api/users', { email: 'v@example.com', name: 'Vee', password: 'viewer-password-1', role: 'viewer' }, jar.headers());
    assert.equal(viewer.status, 201);
    const approver = await post('/api/users', { email: 'a@example.com', name: 'Aye', password: 'approver-password-1', role: 'approver' }, jar.headers());
    assert.equal(approver.status, 201);

    const started = await (await post('/api/runs', { scenario: 'support-refund' }, jar.headers())).json();
    const [pend] = await (await fetch(`${base}/api/approvals`, { headers: jar.headers() })).json();

    const vj = cookieJar(); vj.set(await post('/api/auth/login', { email: 'v@example.com', password: 'viewer-password-1' }, J));
    assert.equal((await fetch(`${base}/api/approvals`, { headers: vj.headers() })).status, 200, 'viewers can read');
    const blocked = await post(`/api/runs/${started.run.id}/calls/${pend.call.id}/decision`, { decision: 'approve', hash: pend.call.hash }, vj.headers());
    assert.equal(blocked.status, 403, 'viewers cannot approve');
    assert.equal((await post('/api/users', { email: 'x@example.com', name: 'X', password: 'password-password', role: 'viewer' }, vj.headers())).status, 403);
    assert.equal((await post('/api/auth/login', { email: 'v@example.com', password: 'nope-nope-nope' }, J)).status, 401);

    const aj = cookieJar(); aj.set(await post('/api/auth/login', { email: 'a@example.com', password: 'approver-password-1' }, J));
    const ok = await post(`/api/runs/${started.run.id}/calls/${pend.call.id}/decision`, { by: 'human:somebody-else', decision: 'approve', hash: pend.call.hash }, aj.headers());
    assert.equal(ok.status, 200);
    const done = await ok.json();
    assert.equal(done.state.calls.find(c => c.id === pend.call.id).approval.by, 'human:a@example.com', 'a client-supplied name is ignored');

    await post('/api/auth/logout', {}, aj.headers());
    assert.equal((await fetch(`${base}/api/runs`, { headers: aj.headers() })).status, 401, 'logout ends the session');
  } finally { await stop(); }
});
