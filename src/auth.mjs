import { scrypt, randomBytes, randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
export const ROLES = ['viewer', 'approver', 'admin'];
const RANK = { viewer: 1, approver: 2, admin: 3 };
export class AuthError extends Error { constructor(code, message) { super(message); this.code = code; } }

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
export const normaliseEmail = e => String(e ?? '').trim().toLowerCase();

/** scrypt, random 16-byte salt, stored as "scrypt$N$salt$hash". Constant-time verification. */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$${salt.toString('hex')}$${hash.toString('hex')}`;
}
export async function verifyPassword(password, stored) {
  const [alg, n, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const got = await scryptAsync(password, Buffer.from(salt, 'hex'), expected.length, { N: Number(n), r: 8, p: 1 });
  return got.length === expected.length && timingSafeEqual(got, expected);
}
const sha = t => createHash('sha256').update(t).digest('hex');
const publicUser = u => (u ? { id: u.id, email: u.email, name: u.name, role: u.role, createdAt: u.created_at } : null);

export function createMemoryAuthStore() {
  const users = new Map(); const sessions = new Map(); const failures = new Map(); const keys = new Map();
  return {
    async countUsers() { return users.size; },
    async createUser(u) { for (const x of users.values()) if (x.email === u.email) throw new AuthError('email_taken', 'That email already has an account.'); const row = { ...u, created_at: new Date().toISOString() }; users.set(u.id, row); return { ...row }; },
    async getUserByEmail(email) { for (const x of users.values()) if (x.email === email) return { ...x }; return null; },
    async getUser(id) { const x = users.get(id); return x ? { ...x } : null; },
    async listUsers() { return [...users.values()].sort((a, b) => a.created_at.localeCompare(b.created_at)).map(x => ({ ...x })); },
    async deleteUser(id) { users.delete(id); for (const [k, s] of sessions) if (s.user_id === id) sessions.delete(k); },
    async setRole(id, role) { const x = users.get(id); if (x) x.role = role; },
    async createSession(s) { sessions.set(s.token_hash, { ...s }); },
    async getSession(tokenHash) { const s = sessions.get(tokenHash); return s ? { ...s } : null; },
    async deleteSession(tokenHash) { sessions.delete(tokenHash); },
    async deleteExpiredSessions(now) { for (const [k, s] of sessions) if (s.expires_at <= now) sessions.delete(k); },
    async getFailure(k) { const f = failures.get(k); return f ? { ...f } : null; },
    async putFailure(k, f) { failures.set(k, { ...f }); },
    async deleteFailure(k) { failures.delete(k); },
    async deleteOldFailures(before) { for (const [k, f] of failures) if (f.last < before) failures.delete(k); },
    async createAgentKey(row) { keys.set(row.id, { ...row, created_at: new Date().toISOString(), last_used_at: null, revoked: false }); },
    async listAgentKeys() { return [...keys.values()].sort((a, b) => a.created_at.localeCompare(b.created_at)).map(x => ({ ...x })); },
    async getAgentKeyByHash(h) { for (const x of keys.values()) if (x.key_hash === h) return { ...x }; return null; },
    async revokeAgentKey(id) { const x = keys.get(id); if (!x) return false; x.revoked = true; return true; },
    async touchAgentKey(id, at) { const x = keys.get(id); if (x) x.last_used_at = new Date(at).toISOString(); },
  };
}

export async function createPostgresAuthStore(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (id text PRIMARY KEY, email text NOT NULL UNIQUE, name text NOT NULL, role text NOT NULL, password_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS sessions (token_hash text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at bigint NOT NULL);
    CREATE TABLE IF NOT EXISTS login_failures (key text PRIMARY KEY, count integer NOT NULL, last bigint NOT NULL);
    CREATE TABLE IF NOT EXISTS agent_keys (id text PRIMARY KEY, name text NOT NULL, key_hash text NOT NULL UNIQUE, prefix text NOT NULL, created_by text, created_at timestamptz NOT NULL DEFAULT now(), last_used_at timestamptz, revoked boolean NOT NULL DEFAULT false);`);
  const toKey = r => r && ({ id: r.id, name: r.name, key_hash: r.key_hash, prefix: r.prefix, created_by: r.created_by, created_at: new Date(r.created_at).toISOString(), last_used_at: r.last_used_at ? new Date(r.last_used_at).toISOString() : null, revoked: r.revoked });
  const toUser = r => r && ({ id: r.id, email: r.email, name: r.name, role: r.role, password_hash: r.password_hash, created_at: new Date(r.created_at).toISOString() });
  return {
    async countUsers() { return Number((await pool.query('SELECT count(*) FROM users')).rows[0].count); },
    async createUser(u) {
      try { return toUser((await pool.query('INSERT INTO users (id,email,name,role,password_hash) VALUES ($1,$2,$3,$4,$5) RETURNING *', [u.id, u.email, u.name, u.role, u.password_hash])).rows[0]); }
      catch (e) { if (e.code === '23505') throw new AuthError('email_taken', 'That email already has an account.'); throw e; }
    },
    async getUserByEmail(email) { return toUser((await pool.query('SELECT * FROM users WHERE email = $1', [email])).rows[0]) || null; },
    async getUser(id) { return toUser((await pool.query('SELECT * FROM users WHERE id = $1', [id])).rows[0]) || null; },
    async listUsers() { return (await pool.query('SELECT * FROM users ORDER BY created_at')).rows.map(toUser); },
    async deleteUser(id) { await pool.query('DELETE FROM users WHERE id = $1', [id]); },
    async setRole(id, role) { await pool.query('UPDATE users SET role = $2 WHERE id = $1', [id, role]); },
    async createSession(s) { await pool.query('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES ($1,$2,$3)', [s.token_hash, s.user_id, s.expires_at]); },
    async getSession(h) { const r = (await pool.query('SELECT * FROM sessions WHERE token_hash = $1', [h])).rows[0]; return r ? { token_hash: r.token_hash, user_id: r.user_id, expires_at: Number(r.expires_at) } : null; },
    async deleteSession(h) { await pool.query('DELETE FROM sessions WHERE token_hash = $1', [h]); },
    async deleteExpiredSessions(now) { await pool.query('DELETE FROM sessions WHERE expires_at <= $1', [now]); },
    async getFailure(k) { const r = (await pool.query('SELECT count, last FROM login_failures WHERE key = $1', [k])).rows[0]; return r ? { count: r.count, last: Number(r.last) } : null; },
    async putFailure(k, f) { await pool.query('INSERT INTO login_failures (key, count, last) VALUES ($1,$2,$3) ON CONFLICT (key) DO UPDATE SET count = EXCLUDED.count, last = EXCLUDED.last', [k, f.count, f.last]); },
    async deleteFailure(k) { await pool.query('DELETE FROM login_failures WHERE key = $1', [k]); },
    async deleteOldFailures(before) { await pool.query('DELETE FROM login_failures WHERE last < $1', [before]); },
    async createAgentKey(row) { await pool.query('INSERT INTO agent_keys (id, name, key_hash, prefix, created_by) VALUES ($1,$2,$3,$4,$5)', [row.id, row.name, row.key_hash, row.prefix, row.created_by]); },
    async listAgentKeys() { return (await pool.query('SELECT * FROM agent_keys ORDER BY created_at')).rows.map(toKey); },
    async getAgentKeyByHash(h) { return toKey((await pool.query('SELECT * FROM agent_keys WHERE key_hash = $1', [h])).rows[0]) || null; },
    async revokeAgentKey(id) { return (await pool.query('UPDATE agent_keys SET revoked = true WHERE id = $1', [id])).rowCount > 0; },
    async touchAgentKey(id, at) { await pool.query('UPDATE agent_keys SET last_used_at = $2 WHERE id = $1', [id, new Date(at)]); },
  };
}

/**
 * Accounts, sessions and roles. Sessions are random 32-byte tokens; only their SHA-256 is stored, so a database leak
 * does not hand out live sessions. Failed logins are throttled per email and per address.
 */
export function createAuth({ db, now = () => Date.now(), sessionHours = 12, maxFailures = 5, lockMinutes = 15, signupsPerHour = 5 } = {}) {
  const signups = new Map();
  const key = (email, ip) => `${email}|${ip}`;
  const lockMs = lockMinutes * 60_000;
  // Failed logins live in the auth store (Postgres in production), so a restart or a second instance does not reset them.
  const locked = async k => { const f = await db.getFailure(k); return !!f && f.count >= maxFailures && now() - f.last < lockMs; };
  const fail = async k => { const f = await db.getFailure(k); const fresh = !f || now() - f.last >= lockMs; await db.putFailure(k, { count: fresh ? 1 : f.count + 1, last: now() }); };
  const publicKey = k => ({ id: k.id, name: k.name, prefix: k.prefix, createdBy: k.created_by, createdAt: k.created_at, lastUsedAt: k.last_used_at, revoked: k.revoked });

  function validate({ email, name, password, role }) {
    const e = normaliseEmail(email);
    if (!EMAIL.test(e)) throw new AuthError('invalid_email', 'Enter a valid email address.');
    const n = String(name ?? '').trim();
    if (n.length < 1 || n.length > 80) throw new AuthError('invalid_name', 'Name must be 1 to 80 characters.');
    if (typeof password !== 'string' || password.length < 10 || password.length > 200) throw new AuthError('weak_password', 'Password must be 10 to 200 characters.');
    if (!ROLES.includes(role)) throw new AuthError('invalid_role', `Role must be one of ${ROLES.join(', ')}.`);
    return { email: e, name: n };
  }
  async function create(input) {
    const { email, name } = validate(input);
    return publicUser(await db.createUser({ id: `u_${randomUUID().slice(0, 12)}`, email, name, role: input.role, password_hash: await hashPassword(input.password) }));
  }
  return {
    ROLES,
    async needsSetup() { return (await db.countUsers()) === 0; },
    /** The first account becomes the admin. Refused once any user exists. */
    async setup(input) { if ((await db.countUsers()) > 0) throw new AuthError('already_set_up', 'An administrator already exists.'); return create({ ...input, role: 'admin' }); },
    createUser: create,
    /** Self-service sign-up. Always a viewer: it can read, never decide. An administrator can raise the role later. */
    async signup(input, ip = 'unknown') {
      if ((await db.countUsers()) === 0) throw new AuthError('needs_setup', 'Create the administrator first.');
      const recent = (signups.get(ip) || []).filter(t => now() - t < 3600_000);
      if (recent.length >= signupsPerHour) throw new AuthError('signup_limited', 'Too many sign-ups from this address. Try again in an hour.');
      const user = await create({ ...input, role: 'viewer' });
      recent.push(now()); signups.set(ip, recent);
      return user;
    },
    async setRole(id, role, byId) {
      if (!ROLES.includes(role)) throw new AuthError('invalid_role', `Role must be one of ${ROLES.join(', ')}.`);
      if (id === byId) throw new AuthError('self_role', 'You cannot change your own role.');
      const target = await db.getUser(id); if (!target) throw new AuthError('not_found', 'User not found.');
      if (target.role === 'admin' && role !== 'admin' && (await db.listUsers()).filter(u => u.role === 'admin').length < 2) throw new AuthError('last_admin', 'There must be at least one administrator.');
      await db.setRole(id, role);
      return publicUser(await db.getUser(id));
    },
    async login(email, password, ip = 'unknown') {
      const e = normaliseEmail(email); const k = key(e, ip);
      if (await locked(k)) throw new AuthError('locked', `Too many failed attempts. Try again in ${lockMinutes} minutes.`);
      const user = await db.getUserByEmail(e);
      // Verify against a dummy hash when the user is unknown so timing does not reveal which emails exist.
      const ok = await verifyPassword(String(password ?? ''), user ? user.password_hash : DUMMY);
      if (!user || !ok) { await fail(k); throw new AuthError('bad_credentials', 'Email or password is wrong.'); }
      await db.deleteFailure(k);
      const token = randomBytes(32).toString('base64url');
      await db.createSession({ token_hash: sha(token), user_id: user.id, expires_at: now() + sessionHours * 3600_000 });
      return { token, user: publicUser(user), maxAge: sessionHours * 3600 };
    },
    async userFromToken(token) {
      if (!token) return null;
      const s = await db.getSession(sha(token));
      if (!s) return null;
      if (s.expires_at <= now()) { await db.deleteSession(s.token_hash); return null; }
      return publicUser(await db.getUser(s.user_id));
    },
    async logout(token) { if (token) await db.deleteSession(sha(token)); },
    async listUsers() { return (await db.listUsers()).map(publicUser); },
    async deleteUser(id, byId) {
      if (id === byId) throw new AuthError('self_delete', 'You cannot delete your own account.');
      const target = await db.getUser(id); if (!target) throw new AuthError('not_found', 'User not found.');
      if (target.role === 'admin' && (await db.listUsers()).filter(u => u.role === 'admin').length < 2) throw new AuthError('last_admin', 'There must be at least one administrator.');
      await db.deleteUser(id);
    },
    can(user, role) { return !!user && RANK[user.role] >= RANK[role]; },
    async sweep() { await db.deleteExpiredSessions(now()); await db.deleteOldFailures(now() - lockMs); },

    /**
     * API keys for outside agents. The full key is shown once; only its SHA-256 is stored.
     * A key can start runs and propose calls on its own runs. It can never approve anything.
     */
    async createAgentKey(name, byId) {
      const n = String(name ?? '').trim();
      if (!/^[\w .-]{1,40}$/.test(n)) throw new AuthError('invalid_name', 'Name the key in 1 to 40 letters, numbers, spaces, dots or dashes.');
      const secret = `agk_${randomBytes(24).toString('base64url')}`;
      const row = { id: `k_${randomUUID().slice(0, 8)}`, name: n, key_hash: sha(secret), prefix: secret.slice(0, 10), created_by: byId || null };
      await db.createAgentKey(row);
      return { ...publicKey({ ...row, created_at: new Date(now()).toISOString(), last_used_at: null, revoked: false }), key: secret };
    },
    async listAgentKeys() { return (await db.listAgentKeys()).map(publicKey); },
    async revokeAgentKey(id) { if (!(await db.revokeAgentKey(id))) throw new AuthError('not_found', 'Key not found.'); },
    async agentFromKey(secret) {
      if (typeof secret !== 'string' || !/^agk_[\w-]{20,60}$/.test(secret)) return null;
      const k = await db.getAgentKeyByHash(sha(secret));
      if (!k || k.revoked) return null;
      await db.touchAgentKey(k.id, now());
      return { id: k.id, name: k.name };
    },
  };
}
const DUMMY = 'scrypt$16384$00000000000000000000000000000000$0000000000000000000000000000000000000000000000000000000000000000';
