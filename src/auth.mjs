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
  const users = new Map(); const sessions = new Map();
  return {
    async countUsers() { return users.size; },
    async createUser(u) { for (const x of users.values()) if (x.email === u.email) throw new AuthError('email_taken', 'that email already has an account'); const row = { ...u, created_at: new Date().toISOString() }; users.set(u.id, row); return { ...row }; },
    async getUserByEmail(email) { for (const x of users.values()) if (x.email === email) return { ...x }; return null; },
    async getUser(id) { const x = users.get(id); return x ? { ...x } : null; },
    async listUsers() { return [...users.values()].sort((a, b) => a.created_at.localeCompare(b.created_at)).map(x => ({ ...x })); },
    async deleteUser(id) { users.delete(id); for (const [k, s] of sessions) if (s.user_id === id) sessions.delete(k); },
    async createSession(s) { sessions.set(s.token_hash, { ...s }); },
    async getSession(tokenHash) { const s = sessions.get(tokenHash); return s ? { ...s } : null; },
    async deleteSession(tokenHash) { sessions.delete(tokenHash); },
    async deleteExpiredSessions(now) { for (const [k, s] of sessions) if (s.expires_at <= now) sessions.delete(k); },
  };
}

export async function createPostgresAuthStore(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (id text PRIMARY KEY, email text NOT NULL UNIQUE, name text NOT NULL, role text NOT NULL, password_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS sessions (token_hash text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at bigint NOT NULL);`);
  const toUser = r => r && ({ id: r.id, email: r.email, name: r.name, role: r.role, password_hash: r.password_hash, created_at: new Date(r.created_at).toISOString() });
  return {
    async countUsers() { return Number((await pool.query('SELECT count(*) FROM users')).rows[0].count); },
    async createUser(u) {
      try { return toUser((await pool.query('INSERT INTO users (id,email,name,role,password_hash) VALUES ($1,$2,$3,$4,$5) RETURNING *', [u.id, u.email, u.name, u.role, u.password_hash])).rows[0]); }
      catch (e) { if (e.code === '23505') throw new AuthError('email_taken', 'that email already has an account'); throw e; }
    },
    async getUserByEmail(email) { return toUser((await pool.query('SELECT * FROM users WHERE email = $1', [email])).rows[0]) || null; },
    async getUser(id) { return toUser((await pool.query('SELECT * FROM users WHERE id = $1', [id])).rows[0]) || null; },
    async listUsers() { return (await pool.query('SELECT * FROM users ORDER BY created_at')).rows.map(toUser); },
    async deleteUser(id) { await pool.query('DELETE FROM users WHERE id = $1', [id]); },
    async createSession(s) { await pool.query('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES ($1,$2,$3)', [s.token_hash, s.user_id, s.expires_at]); },
    async getSession(h) { const r = (await pool.query('SELECT * FROM sessions WHERE token_hash = $1', [h])).rows[0]; return r ? { token_hash: r.token_hash, user_id: r.user_id, expires_at: Number(r.expires_at) } : null; },
    async deleteSession(h) { await pool.query('DELETE FROM sessions WHERE token_hash = $1', [h]); },
    async deleteExpiredSessions(now) { await pool.query('DELETE FROM sessions WHERE expires_at <= $1', [now]); },
  };
}

/**
 * Accounts, sessions and roles. Sessions are random 32-byte tokens; only their SHA-256 is stored, so a database leak
 * does not hand out live sessions. Failed logins are throttled per email and per address.
 */
export function createAuth({ db, now = () => Date.now(), sessionHours = 12, maxFailures = 5, lockMinutes = 15 } = {}) {
  const failures = new Map();
  const key = (email, ip) => `${email}|${ip}`;
  const locked = k => { const f = failures.get(k); return f && f.count >= maxFailures && now() - f.last < lockMinutes * 60_000; };
  const fail = k => { const f = failures.get(k); const fresh = !f || now() - f.last >= lockMinutes * 60_000; failures.set(k, { count: fresh ? 1 : f.count + 1, last: now() }); };

  function validate({ email, name, password, role }) {
    const e = normaliseEmail(email);
    if (!EMAIL.test(e)) throw new AuthError('invalid_email', 'enter a valid email address');
    const n = String(name ?? '').trim();
    if (n.length < 1 || n.length > 80) throw new AuthError('invalid_name', 'name must be 1 to 80 characters');
    if (typeof password !== 'string' || password.length < 10 || password.length > 200) throw new AuthError('weak_password', 'password must be 10 to 200 characters');
    if (!ROLES.includes(role)) throw new AuthError('invalid_role', `role must be one of ${ROLES.join(', ')}`);
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
    async setup(input) { if ((await db.countUsers()) > 0) throw new AuthError('already_set_up', 'an administrator already exists'); return create({ ...input, role: 'admin' }); },
    createUser: create,
    async login(email, password, ip = 'unknown') {
      const e = normaliseEmail(email); const k = key(e, ip);
      if (locked(k)) throw new AuthError('locked', `too many failed attempts; try again in ${lockMinutes} minutes`);
      const user = await db.getUserByEmail(e);
      // Verify against a dummy hash when the user is unknown so timing does not reveal which emails exist.
      const ok = await verifyPassword(String(password ?? ''), user ? user.password_hash : DUMMY);
      if (!user || !ok) { fail(k); throw new AuthError('bad_credentials', 'email or password is wrong'); }
      failures.delete(k);
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
      if (id === byId) throw new AuthError('self_delete', 'you cannot delete your own account');
      const target = await db.getUser(id); if (!target) throw new AuthError('not_found', 'user not found');
      if (target.role === 'admin' && (await db.listUsers()).filter(u => u.role === 'admin').length < 2) throw new AuthError('last_admin', 'there must be at least one administrator');
      await db.deleteUser(id);
    },
    can(user, role) { return !!user && RANK[user.role] >= RANK[role]; },
    sweep() { return db.deleteExpiredSessions(now()); },
  };
}
const DUMMY = 'scrypt$16384$00000000000000000000000000000000$0000000000000000000000000000000000000000000000000000000000000000';
