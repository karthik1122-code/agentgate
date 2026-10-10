import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const PORT = 4400 + Math.floor(Math.random() * 400);
const base = `http://127.0.0.1:${PORT}`;
let child;
const post = (path, body, headers = {}) => fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });

async function start(env) {
  child = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, DATABASE_URL: '', PORT: String(PORT), ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
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
    assert.equal((await fetch(`${base}/api/runs`, { method: 'POST', body: '{bad' })).status, 400);
    assert.equal((await fetch(`${base}/api/runs`, { method: 'POST', body: JSON.stringify({ pad: 'x'.repeat(20000) }) }).catch(() => ({ status: 413 }))).status, 413);
    const check = await (await post('/api/policy/check', { tool: 'run_command', args: { command: 'ls; cat x' } })).json();
    assert.equal(check.effect, 'deny');
  } finally { await stop(); }
});

test('with APPROVER_TOKEN set, approvals need the token and the server names the approver', async () => {
  await start({ APPROVER_TOKEN: 'secret-token-for-test', APPROVER_NAME: 'human:ops' });
  try {
    const started = await (await post('/api/runs', { scenario: 'support-refund' })).json();
    const [p] = await (await fetch(`${base}/api/approvals`)).json();
    const url = `/api/runs/${started.run.id}/calls/${p.call.id}/decision`;
    const body = { by: 'agent:support-refund', decision: 'approve', hash: p.call.hash };
    assert.equal((await post(url, body)).status, 401);
    assert.equal((await post(url, body, { 'x-approver-token': 'wrong-token-value-xxx' })).status, 401);
    const ok = await post(url, body, { 'x-approver-token': 'secret-token-for-test' });
    assert.equal(ok.status, 200, 'a client-supplied name cannot override the server-assigned approver');
    const v = await ok.json();
    assert.equal(v.state.calls.find(c => c.id === p.call.id).approval.by, 'human:ops');
  } finally { await stop(); }
});
