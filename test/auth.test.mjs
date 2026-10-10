import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuth, createMemoryAuthStore, hashPassword, verifyPassword, AuthError } from '../src/auth.mjs';

const mk = (opts = {}) => { let t = 1_000_000; const clock = { now: () => t, advance: ms => { t += ms; } }; return { auth: createAuth({ db: createMemoryAuthStore(), now: clock.now, ...opts }), clock }; };
const good = { email: 'Ada@Example.com', name: 'Ada', password: 'correct horse battery' };

test('password hashes are salted and verify in constant time', async () => {
  const a = await hashPassword('hunter2-hunter2'); const b = await hashPassword('hunter2-hunter2');
  assert.notEqual(a, b);
  assert.ok(await verifyPassword('hunter2-hunter2', a));
  assert.equal(await verifyPassword('wrong', a), false);
  assert.equal(await verifyPassword('x', 'garbage'), false);
});

test('first account becomes admin, setup is refused afterwards', async () => {
  const { auth } = mk();
  assert.equal(await auth.needsSetup(), true);
  const u = await auth.setup(good);
  assert.equal(u.role, 'admin'); assert.equal(u.email, 'ada@example.com');
  assert.equal(await auth.needsSetup(), false);
  await assert.rejects(auth.setup({ ...good, email: 'b@example.com' }), e => e.code === 'already_set_up');
});

test('validation rejects bad email, short password, unknown role', async () => {
  const { auth } = mk(); await auth.setup(good);
  await assert.rejects(auth.createUser({ ...good, email: 'nope', role: 'viewer' }), e => e.code === 'invalid_email');
  await assert.rejects(auth.createUser({ ...good, email: 'c@example.com', password: 'short', role: 'viewer' }), e => e.code === 'weak_password');
  await assert.rejects(auth.createUser({ ...good, email: 'c@example.com', role: 'root' }), e => e.code === 'invalid_role');
  await assert.rejects(auth.createUser({ ...good, role: 'viewer' }), e => e.code === 'email_taken');
});

test('login creates a session, wrong password does not, logout ends it', async () => {
  const { auth } = mk(); await auth.setup(good);
  const s = await auth.login('ada@example.com', good.password);
  assert.equal((await auth.userFromToken(s.token)).email, 'ada@example.com');
  await assert.rejects(auth.login('ada@example.com', 'wrong-password'), e => e.code === 'bad_credentials');
  await assert.rejects(auth.login('nobody@example.com', 'whatever-whatever'), e => e.code === 'bad_credentials');
  await auth.logout(s.token);
  assert.equal(await auth.userFromToken(s.token), null);
});

test('sessions expire', async () => {
  const { auth, clock } = mk({ sessionHours: 1 }); await auth.setup(good);
  const s = await auth.login('ada@example.com', good.password);
  clock.advance(59 * 60_000); assert.ok(await auth.userFromToken(s.token));
  clock.advance(2 * 60_000); assert.equal(await auth.userFromToken(s.token), null);
});

test('five failures lock that email and address, success elsewhere is unaffected, lock lifts', async () => {
  const { auth, clock } = mk(); await auth.setup(good);
  for (let i = 0; i < 5; i++) await assert.rejects(auth.login('ada@example.com', 'wrong-password', '1.1.1.1'));
  await assert.rejects(auth.login('ada@example.com', good.password, '1.1.1.1'), e => e.code === 'locked');
  assert.ok(await auth.login('ada@example.com', good.password, '2.2.2.2'), 'a different address is not locked');
  clock.advance(16 * 60_000);
  assert.ok(await auth.login('ada@example.com', good.password, '1.1.1.1'));
});

test('roles are ordered and the last admin cannot be removed', async () => {
  const { auth } = mk(); const admin = await auth.setup(good);
  const v = await auth.createUser({ email: 'v@example.com', name: 'V', password: 'viewer-password-1', role: 'viewer' });
  assert.ok(auth.can(admin, 'approver')); assert.ok(auth.can(v, 'viewer'));
  assert.equal(auth.can(v, 'approver'), false); assert.equal(auth.can(null, 'viewer'), false);
  await assert.rejects(auth.deleteUser(admin.id, v.id), e => e.code === 'last_admin');
  await assert.rejects(auth.deleteUser(admin.id, admin.id), e => e.code === 'self_delete');
  await auth.deleteUser(v.id, admin.id);
  assert.equal((await auth.listUsers()).length, 1);
});

const url = process.env.TEST_DATABASE_URL;
if (!url) test('postgres auth store skipped (TEST_DATABASE_URL not set)', { skip: true }, () => {});
else test('postgres auth store: setup, login, session expiry, duplicate email, delete cascades sessions', async () => {
  const { default: pg } = await import('pg'); const { createPostgresAuthStore } = await import('../src/auth.mjs');
  const pool = new pg.Pool({ connectionString: url });
  try {
    await createPostgresAuthStore(pool); await pool.query('TRUNCATE sessions, users CASCADE');
    let t = 5_000_000; const auth = createAuth({ db: await createPostgresAuthStore(pool), now: () => t, sessionHours: 1 });
    const admin = await auth.setup(good);
    const s = await auth.login('ada@example.com', good.password);
    assert.equal((await auth.userFromToken(s.token)).id, admin.id);
    await assert.rejects(auth.createUser({ ...good, role: 'viewer' }), e => e.code === 'email_taken');
    const v = await auth.createUser({ email: 'v@example.com', name: 'V', password: 'viewer-password-1', role: 'viewer' });
    const vs = await auth.login('v@example.com', 'viewer-password-1');
    await auth.deleteUser(v.id, admin.id);
    assert.equal(await auth.userFromToken(vs.token), null);
    t += 2 * 3600_000; assert.equal(await auth.userFromToken(s.token), null);
  } finally { await pool.end(); }
});
