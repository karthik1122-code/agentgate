import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareCall, ArgError } from '../src/tools.mjs';

const bad = (tool, args, pattern) => assert.throws(() => prepareCall(tool, args), e => e instanceof ArgError && (!pattern || pattern.test(e.message)));

test('paths: traversal, absolute, empty segments, backslashes, encodings and lookalike characters are all rejected', () => {
  for (const p of ['../x', 'a/../b', '/etc/passwd', 'a//b', './a', 'a/./b', 'a\\b', 'a%2e%2e/b', 'a%2fb', 'wörkspace/a', 'a\u0000b', 'a b', '', 'a/..', '…/x']) bad('read_file', { path: p });
});

test('paths: a plain workspace path is accepted unchanged', () => assert.equal(prepareCall('read_file', { path: 'workspace/report.md' }).args.path, 'workspace/report.md'));

test('unknown tools, prototype names and wrong casing are rejected', () => {
  for (const t of ['delete_everything', 'Read_File', 'READ_FILE', '__proto__', 'constructor', 'toString', '', 5, null]) bad(t, { path: 'workspace/a' }, /unknown tool/);
});

test('unknown or smuggled arguments are rejected', () => {
  bad('read_file', { path: 'workspace/a', mode: 'root' }, /unknown argument/);
  bad('read_file', { path: 'workspace/a', __proto__x: 1 }, /unknown argument/);
  bad('read_file', null); bad('read_file', ['workspace/a']); bad('read_file', 'workspace/a');
});

test('types are enforced: no numbers as strings, no floats or negatives as amounts, only INR', () => {
  bad('refund_payment', { payment_id: 'pay_ABC12345', amount: '500', currency: 'INR' });
  bad('refund_payment', { payment_id: 'pay_ABC12345', amount: 500.5, currency: 'INR' });
  bad('refund_payment', { payment_id: 'pay_ABC12345', amount: -5, currency: 'INR' });
  bad('refund_payment', { payment_id: 'pay_ABC12345', amount: 0, currency: 'INR' });
  bad('refund_payment', { payment_id: 'pay_ABC12345', amount: 500, currency: 'USD' });
  bad('refund_payment', { payment_id: 'DROP TABLE', amount: 500, currency: 'INR' });
  bad('refund_payment', { payment_id: 'pay_ABC12345', amount: Number.MAX_SAFE_INTEGER + 2, currency: 'INR' });
  bad('refund_payment', { payment_id: 'pay_ABC12345', amount: NaN, currency: 'INR' });
});

test('oversized arguments are rejected before anything else', () => bad('write_file', { path: 'workspace/a', content: 'x'.repeat(30000) }));

test('email: addresses are validated, lowercased and de-duplicated; lists are capped', () => {
  const { args, facts } = prepareCall('send_email', { to: ['A@Company.com', 'a@company.com'], subject: 's', body: 'b' });
  assert.deepEqual(args.to, ['a@company.com']);
  assert.equal(facts.external_recipients, 0);
  bad('send_email', { to: ['not-an-email'], subject: 's', body: 'b' });
  bad('send_email', { to: Array.from({ length: 6 }, (_, i) => `u${i}@company.com`), subject: 's', body: 'b' });
  assert.equal(prepareCall('send_email', { to: ['x@company.com.evil.io'], subject: 's', body: 'b' }).facts.external_recipients, 1);
  assert.equal(prepareCall('send_email', { to: ['x@evilcompany.com'], subject: 's', body: 'b' }).facts.external_recipients, 1);
});

test('facts: secrets, dotfiles and shell metacharacters are detected', () => {
  assert.equal(prepareCall('write_file', { path: 'workspace/a', content: 'key: AKIAABCDEFGHIJKLMNOP' }).facts.contains_secret, true);
  assert.equal(prepareCall('write_file', { path: 'workspace/a', content: '-----BEGIN RSA PRIVATE KEY-----' }).facts.contains_secret, true);
  assert.equal(prepareCall('write_file', { path: 'workspace/a', content: 'hello' }).facts.contains_secret, false);
  assert.equal(prepareCall('read_file', { path: 'workspace/.env' }).facts.is_dotfile, true);
  assert.equal(prepareCall('read_file', { path: 'workspace/.git/config' }).facts.is_dotfile, true);
  assert.equal(prepareCall('read_file', { path: 'workspace/a.b/c.d' }).facts.is_dotfile, false);
  for (const c of ['ls; id', 'ls && id', 'ls | sh', 'echo `id`', 'echo $(id)', 'ls > f']) assert.equal(prepareCall('run_command', { command: c }).facts.has_shell_metachar, true, c);
  bad('run_command', { command: 'ls\nid' }, /control/);
  assert.equal(prepareCall('run_command', { command: '  git   status ' }).args.command, 'git status');
});
