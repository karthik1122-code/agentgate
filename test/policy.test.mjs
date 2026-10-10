import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePolicy, evaluatePolicy } from '../src/policy.mjs';
import { loadPolicy } from '../support/helpers.mjs';

const P = rules => ({ version: 1, rules });
const rule = (id, effect, extra = {}) => ({ id, tool: 'x', effect, reason: `because ${id}`, ...extra });

test('the shipped default policy is valid', () => assert.deepEqual(validatePolicy(loadPolicy()), []));

test('validation rejects bad effects, duplicate ids, unknown operators and unknown paths', () => {
  const errors = validatePolicy(P([rule('a', 'maybe'), rule('b', 'allow'), rule('b', 'deny'), rule('c', 'allow', { when: { 'args.x': { nope: 1 } } }), rule('d', 'allow', { when: { 'secret.x': { eq: 1 } } })]));
  assert.ok(errors.some(e => /effect must be/.test(e)));
  assert.ok(errors.some(e => /duplicate id/.test(e)));
  assert.ok(errors.some(e => /unknown operator/.test(e)));
  assert.ok(errors.some(e => /unknown path/.test(e)));
});

test('validation requires a reason on every rule', () => assert.ok(validatePolicy(P([{ id: 'a', tool: 'x', effect: 'allow' }])).some(e => /reason is required/.test(e))));

test('validation rejects patterns that are too long, invalid, or have nested quantifiers', () => {
  const bad = pattern => validatePolicy(P([rule('a', 'deny', { when: { 'args.p': { matches: pattern } } })]));
  assert.ok(bad('a'.repeat(201)).length);
  assert.ok(bad('(').length);
  assert.ok(bad('(a+)+$').length);
  assert.equal(bad('^workspace/[a-z]+$').length, 0);
});

test('precedence: deny beats approve beats allow, whatever the rule order', () => {
  const ctx = { args: {}, facts: {}, run: {}, projected: {} };
  const eff = order => evaluatePolicy(P(order.map(e => rule(e, e))), 'x', ctx).effect;
  assert.equal(eff(['allow', 'approve', 'deny']), 'deny');
  assert.equal(eff(['deny', 'approve', 'allow']), 'deny');
  assert.equal(eff(['allow', 'approve']), 'approve');
  assert.equal(eff(['approve', 'allow']), 'approve');
});

test('no matching rule falls back to the default, which is deny unless stated', () => {
  const ctx = { args: {}, facts: {}, run: {}, projected: {} };
  const d = evaluatePolicy(P([rule('a', 'allow', { tool: 'other' })]), 'x', ctx);
  assert.equal(d.effect, 'deny'); assert.equal(d.default, true);
  assert.equal(evaluatePolicy({ ...P([]), default: 'approve' }, 'x', ctx).effect, 'approve');
});

test('operators behave on strings, numbers and lists; wrong types never match', () => {
  const ctx = { args: { s: 'workspace/a.txt', n: 5, l: ['a', 'b'] }, facts: {}, run: {}, projected: {} };
  const hit = when => evaluatePolicy(P([rule('r', 'allow', { when })]), 'x', ctx).effect === 'allow';
  assert.ok(hit({ 'args.s': { startsWith: 'workspace/', endsWith: '.txt', contains: 'space' } }));
  assert.ok(hit({ 'args.n': { gt: 4, gte: 5, lt: 6, lte: 5, in: [4, 5] } }));
  assert.ok(hit({ 'args.l': { contains: 'a' } }));
  assert.ok(hit({ 'args.missing': { exists: false } }));
  assert.ok(!hit({ 'args.s': { gt: 1 } }));          // a string is never "greater than" a number
  assert.ok(!hit({ 'args.n': { startsWith: '5' } })); // a number is never a string prefix match
  assert.ok(hit({ anyOf: [{ 'args.n': { eq: 99 } }, { 'args.n': { eq: 5 } }] }));
  assert.ok(hit({ not: { 'args.n': { eq: 99 } } }));
});

test('paths cannot reach prototype properties', () => {
  const ctx = { args: {}, facts: {}, run: {}, projected: {} };
  const d = evaluatePolicy(P([rule('r', 'allow', { when: { 'args.constructor.name': { exists: true } } })]), 'x', ctx);
  assert.equal(d.effect, 'deny');
});

test('tool can be a list or a wildcard', () => {
  const ctx = { args: {}, facts: {}, run: {}, projected: {} };
  assert.equal(evaluatePolicy(P([rule('r', 'allow', { tool: ['a', 'x'] })]), 'x', ctx).effect, 'allow');
  assert.equal(evaluatePolicy(P([rule('r', 'allow', { tool: '*' })]), 'anything', ctx).effect, 'allow');
});

test('a very long string is truncated before a regex sees it', () => {
  const ctx = { args: { s: 'a'.repeat(100000) + 'END' }, facts: {}, run: {}, projected: {} };
  const d = evaluatePolicy(P([rule('r', 'allow', { when: { 'args.s': { matches: 'END$' } } })]), 'x', ctx);
  assert.equal(d.effect, 'deny');
});
