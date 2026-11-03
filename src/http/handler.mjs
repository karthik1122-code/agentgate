import { send, cookieOf, clientIp, limited } from './respond.mjs';
import { sendKnownError } from './errors.mjs';
import { accountRoutes } from './routes/account.routes.mjs';
import { adminRoutes } from './routes/admin.routes.mjs';
import { gateRoutes } from './routes/gate.routes.mjs';
import { agentApiRoutes } from './routes/agent-api.routes.mjs';
import { staticRoutes } from './routes/static.routes.mjs';

const DEMO_USER = { id: 'demo', email: 'demo@local', name: 'Demo', role: 'admin' };

/**
 * Builds the request handler. Each route returns true when it replied.
 *
 *   /api/play/*  -> public playground (its own limits)
 *   /api/v1/*    -> outside agents, Bearer key
 *   /api/*       -> CSRF check -> who is signed in -> public account routes -> sign-in check -> admin and gate routes
 *   anything else -> files from public/
 */
export function createHandler(deps) {
  const { auth, play, config } = deps;

  async function dashboardApi(req, res, url) {
    // Browsers cannot add a custom header cross-site without a CORS preflight, and this server sends no CORS headers.
    if (req.method !== 'GET' && req.method !== 'HEAD' && !req.headers['x-ag-csrf']) return send(res, 403, { error: 'csrf_header_required' });
    const token = cookieOf(req);
    const user = config.authOn ? await auth.userFromToken(token) : DEMO_USER;
    // need(role) replies 403 and returns true when the user lacks the role.
    const need = role => (auth.can(user, role) ? false : send(res, 403, { error: 'forbidden', message: `this needs the ${role} role` }));
    const ctx = { req, res, url, user, token, need };
    if (await accountRoutes(ctx, deps)) return;
    if (!user) return send(res, 401, { error: 'sign_in_required' });
    if (await adminRoutes(ctx, deps)) return;
    if (await gateRoutes(ctx, deps)) return;
    send(res, 404, { error: 'not_found' });
  }

  return async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      if (url.pathname.startsWith('/api/play/')) return play(req, res, url.pathname.slice('/api/play/'.length));
      if (url.pathname.startsWith('/api/')) {
        if (limited(clientIp(req))) return send(res, 429, { error: 'rate_limited' });
        if (url.pathname.startsWith('/api/v1/')) return void (await agentApiRoutes({ req, res, url }, deps));
        return await dashboardApi(req, res, url);
      }
      if (await staticRoutes(req, res, url)) return;
      send(res, 404, { error: 'not_found' });
    } catch (error) {
      if (sendKnownError(res, error)) return;
      console.error(error);
      if (!res.headersSent) send(res, 500, { error: 'internal_error' }); else res.end();
    }
  };
}
