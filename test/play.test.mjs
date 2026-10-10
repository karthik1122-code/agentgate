import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPlayground, PlayError } from '../src/play.mjs';
import { createRuntime } from '../src/runtime.mjs';
import { createMemoryStore } from '../src/store.mjs';
import { createWorld, DEFAULT_FILES } from '../src/tools.mjs';
import { SCENARIOS, planners } from '../src/scenarios.mjs';
import { verifyChain } from '../src/chain.mjs';

const policy = JSON.parse(readFileSync(new URL('../policies/default.json', import.meta.url), 'utf8'));
const play = createPlayground(policy);

test('check: allow, approve and deny come from the policy file, with the canonical form and call hash', () => {
  const small = play.check({ tool: 'refund_payment', args: { payment_id: 'pay_AB12CD34', amount: 50000, currency: 'INR' } });
  assert.equal(small.effect, 'allow'); assert.deepEqual(small.rules.map(r => r.id), ['refund-small']); assert.match(small.hash, /^[0-9a-f]{64}$/);
  assert.equal(play.check({ tool: 'refund_payment', args: { payment_id: 'pay_AB12CD34', amount: 500000, currency: 'INR' } }).effect, 'approve');
  assert.equal(play.check({ tool: 'refund_payment', args: { payment_id: 'pay_AB12CD34', amount: 5000000, currency: 'INR' } }).effect, 'deny');
  const env = play.check({ tool: 'read_file', args: { path: 'secrets/.env' } });
  assert.equal(env.effect, 'deny'); assert.ok(env.rules.some(r => r.id === 'deny-dotfiles'));
  const unknown = play.check({ tool: 'read_file', args: { path: 'notes/readme.txt' } });
  assert.equal(unknown.effect, 'deny'); assert.equal(unknown.default, true, 'no rule matched, so the default decided');
});

test('check: arguments the tool would reinterpret are rejected before the policy sees them', () => {
  const r = play.check({ tool: 'read_file', args: { path: 'workspace/%2e%2e/secrets/.env' } });
  assert.equal(r.stage, 'validation'); assert.equal(r.effect, 'deny');
  assert.equal(play.check({ tool: 'rm_rf', args: {} }).stage, 'validation');
  assert.equal(play.check({}).stage, 'validation');
});

test('check: refunds earlier in the same run count toward the total', () => {
  const call = { tool: 'refund_payment', args: { payment_id: 'pay_AB12CD34', amount: 90000, currency: 'INR' } };
  assert.equal(play.check(call).effect, 'allow');
  const after = play.check({ ...call, prior: { amount: 150000 } });
  assert.equal(after.effect, 'approve'); assert.ok(after.rules.some(r => r.id === 'refund-cumulative'));
});

test('run: every scripted agent produces a chain that verifies, and stops at the first held call unless approved', () => {
  for (const id of Object.keys(SCENARIOS)) {
    const held = play.run({ scenario: id }); const all = play.run({ scenario: id, approve: true });
    assert.equal(held.integrity.valid, true, id); assert.equal(all.integrity.valid, true, id);
    assert.equal(held.integrity.records, held.events.length);
    assert.ok(['waiting_approval', 'completed', 'aborted'].includes(held.status), `${id}: ${held.status}`);
    assert.notEqual(all.status, 'waiting_approval', id);
  }
  assert.equal(play.run({ scenario: 'support-refund' }).status, 'waiting_approval');
  assert.equal(play.run({ scenario: 'support-refund', approve: true }).status, 'completed');
  assert.equal(play.run({ scenario: 'path-traversal' }).status, 'aborted', 'three denials end the run');
});

test('run: decisions match the real runtime call for call (same engine, same answers)', async () => {
  for (const id of Object.keys(SCENARIOS)) {
    const store = createMemoryStore(); let world = createWorld(DEFAULT_FILES);
    const rt = createRuntime({ store, policy, planners, get world() { return world; } });
    let state = await rt.startRun({ planner: id, actor: 'agent:parity' });
    for (let guard = 0; guard < 30 && state.status === 'waiting_approval'; guard += 1) {
      const c = state.calls.find(x => x.state === 'pending_approval');
      await rt.decide(state.runId, c.id, { by: 'human:parity', decision: 'approve', hash: c.hash });
      state = (await rt.view(state.runId)).state;
    }
    const fake = play.run({ scenario: id, approve: true });
    assert.deepEqual(fake.calls.map(c => [c.tool, c.effect, c.state]), state.calls.map(c => [c.tool, c.decision?.effect ?? 'deny', c.state === 'approved' ? 'executed' : c.state]), id);
    assert.equal(fake.status, state.status, id);
    assert.deepEqual(fake.events.map(e => e.type), (await rt.view(state.runId)).events.map(e => e.type), `${id}: same sequence of log events`);
  }
});

test('run: rejects unknown scenarios', () => {
  assert.throws(() => play.run({ scenario: 'nope' }), PlayError);
  assert.throws(() => play.run({}), PlayError);
});

test('verify: an untouched chain passes; an edit is found at the edited record; every later record is untrusted', () => {
  const { events } = play.run({ scenario: 'support-refund', approve: true });
  assert.equal(play.verify({ events }).valid, true);
  const i = events.findIndex(e => e.type === 'call_executed');
  const edited = structuredClone(events); edited[i].data.result = '{"ok":true,"refunded":999999}';
  const bad = play.verify({ events: edited });
  assert.equal(bad.valid, false); assert.equal(bad.at, edited[i].seq); assert.equal(bad.reason, 'record_hash_mismatch');
  const deleted = events.filter((_, k) => k !== i);
  assert.equal(play.verify({ events: deleted }).valid, false, 'a removed record is a sequence gap');
  const swapped = structuredClone(events); [swapped[2], swapped[3]] = [swapped[3], swapped[2]];
  assert.equal(play.verify({ events: swapped }).valid, false);
  const rehashed = structuredClone(events); rehashed[i].data.result = 'x';
  assert.equal(verifyChain(rehashed).valid, false);
});

test('verify: malformed input is refused with a reason, not a crash', () => {
  for (const body of [null, {}, { events: [] }, { events: 'x' }, { events: [{}] }, { events: [{ run_id: 'r', seq: '1', type: 't', data: {}, at: 'a', prev: 'p', hash: 'h' }] }, { events: [{ run_id: 'r', seq: 1, type: 't', data: null, at: 'a', prev: 'p', hash: 'h' }] }])
    assert.throws(() => play.verify(body), PlayError);
  assert.throws(() => play.verify({ events: Array.from({ length: 81 }, () => ({})) }), e => e.status === 413);
});

test('meta lists the policy, the tools and the scripted agents with their calls', () => {
  const m = play.meta();
  assert.equal(m.policy.default, 'deny'); assert.ok(m.tools.refund_payment);
  assert.equal(m.scenarios.length, Object.keys(SCENARIOS).length); assert.ok(m.scenarios.every(s => Array.isArray(s.calls) && s.calls.length));
});
