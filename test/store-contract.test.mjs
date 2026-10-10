import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore, ConflictError } from '../src/store.mjs';
import { createPostgresStore } from '../src/store-pg.mjs';
import { createRuntime, GateError } from '../src/runtime.mjs';
import { verifyChain } from '../src/chain.mjs';
import { createWorld, DEFAULT_FILES } from '../src/tools.mjs';
import { planners } from '../src/scenarios.mjs';
import { loadPolicy, pendingCall, APPROVER, AGENT } from '../support/helpers.mjs';

// The same tests run against every store. Postgres runs only when TEST_DATABASE_URL is set:
//   TEST_DATABASE_URL=postgres://user:pass@host/db npm test
const url = process.env.TEST_DATABASE_URL;
const backends = [['memory', async () => createMemoryStore()]];
if (url) backends.push(['postgres', async () => {
  const store = await createPostgresStore({ connectionString: url });
  await store._pool.query('TRUNCATE run_events, runs CASCADE');
  return store;
}]);
if (!url) test('postgres store tests skipped (TEST_DATABASE_URL not set)', { skip: true }, () => {});

for (const [name, make] of backends) {
  test(`${name}: appends form a verifiable chain and status changes with the record`, async () => {
    const store = await make();
    await store.createRun({ id: 'r1', planner: 'p', input: {}, actor: 'a', status: 'running' });
    await store.append('r1', 'one', { n: 1 });
    await store.append('r1', 'two', { n: 2 }, { status: 'waiting_approval' });
    const events = await store.events('r1');
    assert.deepEqual(events.map(e => e.seq), [1, 2]);
    assert.equal(verifyChain(events).valid, true);
    assert.equal((await store.getRun('r1')).status, 'waiting_approval');
    assert.deepEqual((await store.listByStatus('waiting_approval')).map(r => r.id), ['r1']);
    await store.close?.();
  });

  test(`${name}: a stale writer gets a conflict and writes nothing`, async () => {
    const store = await make();
    await store.createRun({ id: 'r1', planner: 'p', input: {}, actor: 'a' });
    await store.append('r1', 'one', {}, { expectedSeq: 0 });
    await assert.rejects(store.append('r1', 'late', {}, { expectedSeq: 0 }), ConflictError);
    assert.equal((await store.events('r1')).length, 1);
    await store.close?.();
  });

  test(`${name}: 30 writers racing for the same slot produce exactly one winner and an intact chain`, async () => {
    const store = await make();
    await store.createRun({ id: 'r1', planner: 'p', input: {}, actor: 'a' });
    const results = await Promise.allSettled(Array.from({ length: 30 }, (_, i) => store.append('r1', 'race', { i }, { expectedSeq: 0 })));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.ok(results.filter(r => r.status === 'rejected').every(r => r.reason instanceof ConflictError));
    assert.equal(verifyChain(await store.events('r1')).valid, true);
    await store.close?.();
  });

  test(`${name}: events with differently ordered keys hash the same, so a database round trip cannot break the chain`, async () => {
    const store = await make();
    await store.createRun({ id: 'r1', planner: 'p', input: {}, actor: 'a' });
    await store.append('r1', 'x', { zebra: 1, apple: { y: 2, b: 1 }, list: [{ q: 1, a: 2 }] });
    assert.equal(verifyChain(await store.events('r1')).valid, true);
    await store.close?.();
  });

  test(`${name}: duplicate run ids are refused`, async () => {
    const store = await make();
    await store.createRun({ id: 'r1', planner: 'p', input: {}, actor: 'a' });
    await assert.rejects(store.createRun({ id: 'r1', planner: 'p', input: {}, actor: 'a' }), ConflictError);
    await store.close?.();
  });

  test(`${name}: full approval flow, restart and double-approval race behave the same`, async () => {
    const store = await make();
    const world = createWorld(DEFAULT_FILES);
    const clock = { t: Date.parse('2026-10-10T09:00:00Z') };
    const build = () => createRuntime({ store, policy: loadPolicy(), planners, world, now: () => clock.t });
    const paused = await build().startRun({ planner: 'support-refund', actor: AGENT });
    assert.equal(paused.status, 'waiting_approval');
    const second = build();                                        // "restarted process"
    const c = pendingCall((await second.view(paused.runId)).state);
    const results = await Promise.allSettled(['human:a', 'human:b', 'human:c'].map(by => build().decide(paused.runId, c.id, { by, decision: 'approve', hash: c.hash })));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.ok(results.filter(r => r.status === 'rejected').every(r => r.reason instanceof GateError));
    assert.deepEqual(world.ledger.map(l => l.amount), [50000, 500000]);
    const view = await second.view(paused.runId);
    assert.equal(view.state.status, 'completed');
    assert.equal(verifyChain(view.events).valid, true);
    await store.close?.();
  });
}
