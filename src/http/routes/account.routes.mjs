import { send, readJson, sessionCookie, clientIp } from '../respond.mjs';

// Public routes: health, who am I, first-admin setup, sign-up, login, logout. They run before the sign-in check.
export async function accountRoutes({ req, res, url, user, token }, { auth, runtime, store, config }) {
  const { method } = req; const path = url.pathname;
  if (method === 'GET' && path === '/api/health') {
    return send(res, 200, { status: 'ok', store: store.kind, policyHash: runtime.policyHash, auth: config.authOn ? 'accounts' : 'off (demo)', limits: runtime.limits });
  }
  if (method === 'GET' && path === '/api/auth/me') {
    return send(res, 200, { authEnabled: config.authOn, needsSetup: config.authOn && await auth.needsSetup(), setupTokenRequired: !!config.setupToken, signupOpen: config.signupOn, user });
  }
  if (method !== 'POST') return false;
  const signIn = async (body, status) => {
    const s = await auth.login(body.email, body.password, clientIp(req));
    return send(res, status, { user: s.user }, { 'set-cookie': sessionCookie(req, s.token, s.maxAge) });
  };
  // The first account becomes the admin. SETUP_TOKEN stops a stranger claiming it first.
  if (config.authOn && path === '/api/auth/setup') {
    const body = await readJson(req);
    if (config.setupToken && body.setupToken !== config.setupToken) return send(res, 403, { error: 'invalid_setup_token', message: 'The setup token is wrong.' });
    await auth.setup(body);
    return signIn(body, 201);
  }
  // Self-service accounts are always viewers.
  if (config.signupOn && path === '/api/auth/signup') {
    const body = await readJson(req);
    await auth.signup(body, clientIp(req));
    return signIn(body, 201);
  }
  if (config.authOn && path === '/api/auth/login') return signIn(await readJson(req), 200);
  if (config.authOn && path === '/api/auth/logout') {
    await auth.logout(token);
    return send(res, 200, { ok: true }, { 'set-cookie': sessionCookie(req, '', 0) });
  }
  return false;
}
