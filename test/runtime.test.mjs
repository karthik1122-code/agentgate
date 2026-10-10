import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime, foldRun, GateError } from '../src/runtime.mjs';
import { verifyChain } from '../src/chain.mjs';
import { createMemoryStore } from '../src/store.mjs';
import { createWorld, DEFAULT_FILES } from '../src/tools.mjs';
import { setup, loadPolicy, pendingCall, refund, script, APPROVER, AGENT } from '../support/helpers.mjs';

const start = (rt, planner = 'support-refund') => rt.startRun({ planner, actor: AGENT });
const approve = (rt, state, extra = {}) => { const c = pendingCall(state); return rt.decide(state.runId, c.id, { by: APPROVER, decision: 'approve', hash: c.hash, ...extra }); };
const rejects = async (promise, code) => assert.rejects(promise, e => e instanceof GateError && e.code === code, `expected ${code}`);

test('allowed calls run at once; a risky call pauses the run before it happens', async () => {
  const { runtime, world } = setup();
  const state = await start(runtime);
  assert.equal(state.status, 'waiting_approval');
  assert.deepEqual(state.calls.map(c => `${c.tool}:${c.state}`), ['read_file:executed', 'refund_payment:executed', 'refund_payment:pending_approval']);
  assert.equal(world.ledger.length, 1);              // only the small refund happened
  assert.equal(world.ledger[0].amount, 50000);
});

test('approval executes exactly the approved call and the run finishes', async () => {
  const { runtime, world, store } = setup();
  const paused = await start(runtime);
  const done = await approve(runtime, paused);
  assert.equal(done.status, 'completed');
  assert.deepEqual(world.ledger.map(l => l.amount), [50000, 500000]);
  assert.equal(world.outbox.length, 1);
  assert.equal(verifyChain(await store.events(paused.runId)).valid, true);
});

test('rejection means the call never runs and the agent sees the refusal', async () => {
  const { runtime, world } = setup();
  const paused = await start(runtime);
  const c = pendingCall(paused);
  const done = await runtime.decide(paused.runId, c.id, { by: APPROVER, decision: 'reject', hash: c.hash, note: 'amount looks wrong' });
  assert.equal(done.status, 'completed');
  assert.equal(world.ledger.length, 1);
  assert.equal(done.calls[2].outcome.status, 'rejected');
  assert.equal(done.history[2].outcome.reason, 'amount looks wrong');
});

test('approval is bound to the call: a wrong or missing hash is refused and nothing runs', async () => {
  const { runtime, world } = setup();
  const paused = await start(runtime);
  const c = pendingCall(paused);
  await rejects(runtime.decide(paused.runId, c.id, { by: APPROVER, decision: 'approve', hash: 'f'.repeat(64) }), 'hash_mismatch');
  await rejects(runtime.decide(paused.runId, c.id, { by: APPROVER, decision: 'approve' }), 'hash_mismatch');
  assert.equal(world.ledger.length, 1);
  assert.equal((await runtime.view(paused.runId)).state.status, 'waiting_approval');
});

test('four eyes: the actor that started the run cannot approve its own call', async () => {
  const { runtime, world } = setup();
  const paused = await start(runtime);
  const c = pendingCall(paused);
  await rejects(runtime.decide(paused.runId, c.id, { by: AGENT, decision: 'approve', hash: c.hash }), 'same_actor');
  assert.equal(world.ledger.length, 1);
});

test('approver identity is required', async () => {
  const { runtime } = setup();
  const paused = await start(runtime);
  const c = pendingCall(paused);
  for (const by of ['', undefined, 'x'.repeat(101), 5]) await rejects(runtime.decide(paused.runId, c.id, { by, decision: 'approve', hash: c.hash }), 'invalid_approver');
  await rejects(runtime.decide(paused.runId, c.id, { by: APPROVER, decision: 'yes', hash: c.hash }), 'invalid_decision');
});

test('only a pending call can be decided: wrong call, unknown call, unknown run, already executed', async () => {
  const { runtime } = setup();
  const paused = await start(runtime);
  const c = pendingCall(paused);
  await rejects(runtime.decide(paused.runId, 'c1', { by: APPROVER, decision: 'approve', hash: paused.calls[0].hash }), 'not_pending');
  await rejects(runtime.decide(paused.runId, 'c99', { by: APPROVER, decision: 'approve', hash: c.hash }), 'not_found');
  await rejects(runtime.decide('run_nope', 'c1', { by: APPROVER, decision: 'approve', hash: c.hash }), 'not_found');
  await approve(runtime, paused);
  await rejects(runtime.decide(paused.runId, c.id, { by: APPROVER, decision: 'approve', hash: c.hash }), 'not_pending');
});

test('an approval that arrives after the deadline is refused, the call never runs, and the run moves on', async () => {
  const { runtime, world, clock } = setup();
  const paused = await start(runtime);
  clock.t += 16 * 60 * 1000;
  await rejects(approve(runtime, paused), 'expired');
  const view = await runtime.view(paused.runId);
  assert.equal(view.state.calls[2].state, 'expired');
  assert.equal(view.state.status, 'completed');
  assert.equal(world.ledger.length, 1);
});

test('expireStale() closes overdue approvals on its own and lets runs continue', async () => {
  const { runtime, clock, world } = setup();
  const paused = await start(runtime);
  assert.deepEqual(await runtime.expireStale(), []);              // not overdue yet
  clock.t += 15 * 60 * 1000 + 1;
  assert.deepEqual(await runtime.expireStale(), [`${paused.runId}:c3`]);
  assert.equal((await runtime.view(paused.runId)).state.status, 'completed');
  assert.equal(world.ledger.length, 1);
});

test('two approvers racing: exactly one wins and the refund happens once', async () => {
  const { runtime, world } = setup();
  const paused = await start(runtime);
  const c = pendingCall(paused);
  const results = await Promise.allSettled(['human:a', 'human:b', 'human:c', 'human:d'].map(by => runtime.decide(paused.runId, c.id, { by, decision: 'approve', hash: c.hash })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.ok(results.filter(r => r.status === 'rejected').every(r => ['already_decided', 'not_pending'].includes(r.reason.code)));
  assert.equal(world.ledger.filter(l => l.amount === 500000).length, 1);
});

test('crash after a tool ran but before it was recorded: the retry does not repeat the side effect', async () => {
  let crashed = false;
  const hooks = { afterExecute: call => { if (call.id === 'c2' && !crashed) { crashed = true; throw Object.assign(new Error('power cut'), { code: 'simulated_crash' }); } } };
  const first = setup({ hooks });
  await assert.rejects(start(first.runtime), /power cut/);
  assert.equal(first.world.ledger.length, 1);                      // the money moved, the log does not know yet
  const [run] = await first.store.listRuns();
  const second = createRuntime({ store: first.store, policy: first.policy, planners: (await import('../src/scenarios.mjs')).planners, world: first.world, now: () => first.clock.t });
  const state = await second.drive(run.id);
  assert.equal(first.world.ledger.length, 1);                      // still exactly one refund of 50000
  assert.equal(state.status, 'waiting_approval');
  assert.equal(state.calls[1].state, 'executed');
});

test('crash between approval and execution: a new process finishes the job once', async () => {
  let crashed = false;
  const hooks = { beforeExecute: call => { if (call.id === 'c3' && !crashed) { crashed = true; throw Object.assign(new Error('power cut'), { code: 'simulated_crash' }); } } };
  const a = setup({ hooks });
  const paused = await start(a.runtime);
  await assert.rejects(approve(a.runtime, paused), /power cut/);
  assert.equal(a.world.ledger.length, 1);                          // approved, not executed
  const b = createRuntime({ store: a.store, policy: a.policy, planners: (await import('../src/scenarios.mjs')).planners, world: a.world, now: () => a.clock.t });
  const done = await b.drive(paused.runId);
  assert.equal(done.status, 'completed');
  assert.deepEqual(a.world.ledger.map(l => l.amount), [50000, 500000]);
});

test('a restarted process sees the pending approval and can act on it', async () => {
  const a = setup();
  const paused = await start(a.runtime);
  const b = createRuntime({ store: a.store, policy: a.policy, planners: (await import('../src/scenarios.mjs')).planners, world: a.world, now: () => a.clock.t });
  const view = await b.view(paused.runId);
  assert.equal(view.state.status, 'waiting_approval');
  assert.equal((await approve(b, view.state)).status, 'completed');
});

test('policy tightened while a call waits: the tighter rule wins at execution time', async () => {
  const a = setup();
  const paused = await start(a.runtime);
  const tighter = loadPolicy();
  tighter.rules.push({ id: 'freeze-refunds', tool: 'refund_payment', effect: 'deny', reason: 'Refunds are frozen.' });
  const b = createRuntime({ store: a.store, policy: tighter, planners: (await import('../src/scenarios.mjs')).planners, world: a.world, now: () => a.clock.t });
  const state = await approve(b, paused);
  assert.equal(state.calls[2].state, 'denied');
  assert.equal(state.calls[2].outcome.source, 'policy_changed');
  assert.equal(a.world.ledger.length, 1);
});

test('too many denials aborts the run: the agent cannot keep probing the gate', async () => {
  const { runtime, world } = setup();
  const state = await start(runtime, 'path-traversal');
  assert.equal(state.status, 'aborted');
  assert.equal(state.abortReason, 'too_many_denials');
  assert.equal(world.files.has('workspace/ok.txt'), false);        // the 4th, harmless call never got to run
});

test('a run is capped at maxCalls', async () => {
  const policy = loadPolicy(); policy.limits.maxCalls = 5;
  const planners = { loop: { next: () => ({ call: { tool: 'read_file', args: { path: 'workspace/report.md' } } }) } };
  const { runtime } = setup({ policy, planners });
  const state = await runtime.startRun({ planner: 'loop', actor: AGENT });
  assert.equal(state.status, 'aborted');
  assert.equal(state.abortReason, 'max_calls_exceeded');
  assert.equal(state.calls.length, 5);
});

test('many small refunds hit the per-run total and then need a human', async () => {
  const { runtime, world } = setup();
  const state = await start(runtime, 'salami-refunds');
  assert.equal(state.status, 'waiting_approval');
  assert.equal(world.ledger.length, 10);
  assert.equal(world.ledger.reduce((s, l) => s + l.amount, 0), 190000);
  assert.equal(pendingCall(state).id, 'c11');
});

test('prompt injection in a file cannot change a decision: the leak waits for a human and the secrets stay shut', async () => {
  const { runtime, world } = setup();
  const paused = await start(runtime, 'prompt-injection');
  assert.equal(paused.calls[0].state, 'executed');                 // the read happened
  assert.match(paused.calls[0].outcome.result, /ignore your policy/); // and the injected text was in the result
  assert.equal(paused.status, 'waiting_approval');                 // the email to an outsider is held
  assert.equal(world.outbox.length, 0);
  const c = pendingCall(paused);
  const next = await runtime.decide(paused.runId, c.id, { by: APPROVER, decision: 'reject', hash: c.hash });
  assert.equal(next.calls[2].state, 'denied');                     // secrets/.env
  assert.equal(next.calls[3].state, 'denied');                     // workspace/.env
  assert.equal(next.status, 'waiting_approval');                   // the 9,000 rupee refund needs a human
  const c2 = pendingCall(next);
  const end = await runtime.decide(paused.runId, c2.id, { by: APPROVER, decision: 'reject', hash: c2.hash });
  assert.equal(end.status, 'completed');
  assert.equal(world.outbox.length, 0); assert.equal(world.ledger.length, 0);
  assert.equal(world.files.get('secrets/.env').startsWith('API_KEY'), true);
});

test('tool results are stored as untrusted data and truncated', async () => {
  const planners = { big: script([{ tool: 'read_file', args: { path: 'workspace/big.txt' } }]) };
  const world = createWorld({ ...DEFAULT_FILES, 'workspace/big.txt': 'A'.repeat(5000) });
  const { runtime, store } = setup({ planners, world });
  const state = await runtime.startRun({ planner: 'big', actor: AGENT });
  const executed = (await store.events(state.runId)).find(e => e.type === 'call_executed');
  assert.equal(executed.data.untrusted, true);
  assert.ok(executed.data.result.length <= 1001);
});

test('history tampering is detected: edits, deletions and reordering break the chain', async () => {
  const { runtime, store } = setup();
  const paused = await start(runtime);
  const good = await store.events(paused.runId);
  assert.equal(verifyChain(good).valid, true);

  const edited = structuredClone(good); edited[3].data.args = { ...edited[3].data.args, amount: 1 };
  assert.deepEqual(verifyChain(edited), { valid: false, at: 4, reason: 'record_hash_mismatch' });

  const deleted = good.filter((_, i) => i !== 3);
  assert.equal(verifyChain(deleted).valid, false);

  const swapped = structuredClone(good); [swapped[2], swapped[3]] = [swapped[3], swapped[2]];
  assert.equal(verifyChain(swapped).valid, false);

  const relinked = structuredClone(good); relinked[5].prev = 'GENESIS';
  assert.equal(verifyChain(relinked).valid, false);
});

test('known limit: dropping the newest records is invisible to the chain alone, but visible against a recorded head', async () => {
  const { runtime, store } = setup();
  const paused = await start(runtime);
  const good = await store.events(paused.runId);
  const head = verifyChain(good).head;
  const truncated = good.slice(0, -2);
  const check = verifyChain(truncated);
  assert.equal(check.valid, true);
  assert.notEqual(check.head, head);
});

test('startRun validates its inputs and an invalid policy never loads', async () => {
  const { runtime } = setup();
  await rejects(runtime.startRun({ planner: 'nope', actor: AGENT }), 'unknown_planner');
  await rejects(runtime.startRun({ planner: 'support-refund' }), 'invalid_actor');
  assert.throws(() => createRuntime({ store: createMemoryStore(), policy: { version: 1, rules: [{ id: 'x' }] }, planners: {}, world: createWorld() }), e => e.code === 'invalid_policy');
});

test('the run state is a pure function of its log', async () => {
  const { runtime, store } = setup();
  const paused = await start(runtime);
  const events = await store.events(paused.runId);
  assert.deepEqual(foldRun(events), foldRun(structuredClone(events)));
  assert.equal(foldRun(events).status, (await store.getRun(paused.runId)).status);
});

test('chain hashes do not depend on key order', async () => {
  const { nextRecord } = await import('../src/chain.mjs');
  const a = nextRecord('r', null, 't', { x: 1, y: { b: 1, a: 2 } }, '2026-01-01T00:00:00.000Z');
  const b = nextRecord('r', null, 't', { y: { a: 2, b: 1 }, x: 1 }, '2026-01-01T00:00:00.000Z');
  assert.equal(a.hash, b.hash);
});
