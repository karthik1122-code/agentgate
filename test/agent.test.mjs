import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runAgent, localGate, mockPlanner, geminiPlanner } from '../examples/agent.mjs';
import { SCENARIOS } from '../src/scenarios.mjs';

const policy = JSON.parse(readFileSync(new URL('../policies/default.json', import.meta.url), 'utf8'));
const run = (scenario, opts = {}) => runAgent({ gate: localGate(policy), planner: mockPlanner(SCENARIOS[scenario].planner.calls), ...opts });

test('prompt injection: the harmless read runs, the exfiltration is held, secrets are denied', async () => {
  const { trail, ran, held, denied } = await run('prompt-injection');
  assert.equal(trail[0].outcome, 'ran');
  assert.equal(trail.find(t => t.tool === 'send_email').outcome, 'held');
  assert.equal(trail.find(t => t.args.path === 'secrets/.env').outcome, 'denied');
  assert.deepEqual([ran, held, denied], [1, 2, 2]);
});

test('salami refunds: small refunds run until the per-run total is crossed, then each one is held', async () => {
  const { trail } = await run('salami-refunds');
  const first = trail.findIndex(t => t.outcome === 'held');
  assert.ok(first > 0, 'some small refunds run first');
  assert.ok(trail.slice(first).every(t => t.outcome === 'held'), 'every refund after the budget is held');
});

test('a held call runs only when the approver says yes', async () => {
  const no = await run('prompt-injection', { approver: async () => false });
  const yes = await run('prompt-injection', { approver: async () => true });
  assert.equal(no.held, 2);
  assert.equal(yes.held, 0);
  assert.equal(yes.denied, 2, 'approval never overrides a deny');
});

test('gemini planner: sends tool declarations, returns the proposed call, and feeds the gate result back', async () => {
  const sent = [];
  const realFetch = globalThis.fetch;
  const replies = [
    { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'workspace/report.md' } } }] } }] },
    { candidates: [{ content: { role: 'model', parts: [{ text: 'Done.' }] } }] },
  ];
  globalThis.fetch = async (url, init) => { sent.push({ url, body: JSON.parse(init.body), key: init.headers['x-goog-api-key'] }); return { ok: true, json: async () => replies.shift() }; };
  try {
    const gate = localGate(policy);
    const planner = geminiPlanner({ task: 'read the report', tools: (await gate.meta()).tools, key: 'test-key', model: 'test-model' });
    const out = await runAgent({ gate, planner });
    assert.equal(out.ran, 1);
    assert.equal(sent.length, 2);
    assert.equal(sent[0].key, 'test-key');
    assert.match(sent[0].url, /models\/test-model:generateContent/);
    assert.ok(sent[0].body.tools[0].functionDeclarations.some(d => d.name === 'refund_payment'));
    const fed = sent[1].body.contents.at(-1).parts[0].functionResponse;
    assert.deepEqual([fed.name, fed.response.status], ['read_file', 'executed']);
  } finally { globalThis.fetch = realFetch; }
});

test('gemini planner refuses to start without a key', () => {
  const had = process.env.GEMINI_API_KEY; delete process.env.GEMINI_API_KEY;
  try { assert.throws(() => geminiPlanner({ task: 'x', tools: {} }), /GEMINI_API_KEY/); } finally { if (had) process.env.GEMINI_API_KEY = had; }
});

test('gemini planner: retries an overloaded model, then uses the fallback model', async () => {
  const realFetch = globalThis.fetch; const urls = [];
  const done = { candidates: [{ content: { role: 'model', parts: [{ text: 'Nothing to do.' }] } }] };
  globalThis.fetch = async url => { urls.push(url.match(/models\/([^:]+)/)[1]); return urls.length <= 3 ? { ok: false, status: 503, text: async () => 'busy' } : { ok: true, json: async () => done }; };
  try {
    const planner = geminiPlanner({ task: 'x', tools: {}, key: 'k', model: 'main', fallbackModel: 'backup', retryDelayMs: 0 });
    assert.deepEqual(await planner.next(), { say: 'Nothing to do.' });
    assert.deepEqual(urls, ['main', 'main', 'main', 'backup']);
  } finally { globalThis.fetch = realFetch; }
});

test('gemini planner: a bad request is not retried', async () => {
  const realFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls += 1; return { ok: false, status: 400, text: async () => 'bad' }; };
  try {
    const planner = geminiPlanner({ task: 'x', tools: {}, key: 'k', retryDelayMs: 0 });
    await assert.rejects(planner.next(), /400/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = realFetch; }
});

test('gemini planner: two tool calls in one turn go through the gate one by one, and both results go back together', async () => {
  const realFetch = globalThis.fetch; const sent = [];
  const replies = [
    { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'workspace/report.md' } } }, { functionCall: { name: 'read_file', args: { path: 'secrets/.env' } } }] } }] },
    { candidates: [{ content: { role: 'model', parts: [{ text: 'Done.' }] } }] },
  ];
  globalThis.fetch = async (url, init) => { sent.push(JSON.parse(init.body)); return { ok: true, json: async () => replies.shift() }; };
  try {
    const gate = localGate(policy);
    const planner = geminiPlanner({ task: 'read files', tools: (await gate.meta()).tools, key: 'k' });
    const out = await runAgent({ gate, planner });
    assert.deepEqual(out.trail.map(t => t.outcome), ['ran', 'denied']);
    assert.equal(sent.length, 2, 'one model call per turn, not per tool call');
    const fed = sent[1].contents.at(-1).parts.map(p => [p.functionResponse.name, p.functionResponse.response.status]);
    assert.deepEqual(fed, [['read_file', 'executed'], ['read_file', 'denied']]);
  } finally { globalThis.fetch = realFetch; }
});
