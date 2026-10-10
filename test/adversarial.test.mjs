import test from 'node:test';
import assert from 'node:assert/strict';
import { runCases } from '../support/adversarial-run.mjs';

const results = await runCases();

test('every case ends the way the policy requires', () => {
  const wrong = results.filter(r => !r.ok).map(r => `${r.id} (${r.note}): expected ${r.expect}, got ${r.outcome} [${r.reason}]`);
  assert.deepEqual(wrong, []);
});

test('no attack case ever has a side effect without a human', () => {
  const leaked = results.filter(r => r.attack && r.outcome !== 'approve' && r.sideEffect).map(r => r.id);
  assert.deepEqual(leaked, []);
  assert.deepEqual(results.filter(r => r.attack && r.outcome === 'approve' && r.sideEffect).map(r => r.id), []); // held means nothing happened yet
});

test('no legitimate case is blocked', () => {
  assert.deepEqual(results.filter(r => !r.attack && r.outcome === 'deny').map(r => r.id), []);
});

test('the suite is not trivially small and covers every category', () => {
  assert.ok(results.length >= 50);
  for (const cat of ['paths', 'shell', 'email', 'money', 'tools', 'benign']) assert.ok(results.some(r => r.category === cat), cat);
});
