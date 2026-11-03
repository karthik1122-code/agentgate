import { createWorld, DEFAULT_FILES } from '../../tools.mjs';
import { send, readJson } from '../respond.mjs';

// Admin only: people and roles, agent keys, and resetting the simulated world.
export async function adminRoutes({ req, res, url, user, need }, deps) {
  const { auth } = deps; const { method } = req; const path = url.pathname;

  if (path === '/api/users' || /^\/api\/users\/[\w-]+$/.test(path)) {
    if (need('admin')) return true;
    const id = path.split('/').pop();
    if (method === 'GET' && path === '/api/users') return send(res, 200, await auth.listUsers());
    if (method === 'POST' && path === '/api/users') return send(res, 201, await auth.createUser(await readJson(req)));
    if (method === 'PATCH' && path !== '/api/users') return send(res, 200, await auth.setRole(id, (await readJson(req)).role, user.id));
    if (method === 'DELETE') { await auth.deleteUser(id, user.id); return send(res, 200, { ok: true }); }
  }

  // Keys for outside agents: the full key is shown once at creation; only its hash is stored.
  if (path === '/api/agent-keys' || /^\/api\/agent-keys\/[\w-]+$/.test(path)) {
    if (need('admin')) return true;
    if (method === 'GET' && path === '/api/agent-keys') return send(res, 200, await auth.listAgentKeys());
    if (method === 'POST' && path === '/api/agent-keys') return send(res, 201, await auth.createAgentKey((await readJson(req)).name, user.id));
    if (method === 'DELETE' && path !== '/api/agent-keys') { await auth.revokeAgentKey(path.split('/').pop()); return send(res, 200, { ok: true }); }
  }

  if (method === 'POST' && path === '/api/world/reset') {
    if (need('admin')) return true;
    deps.setWorld(createWorld(DEFAULT_FILES));
    return send(res, 200, { ok: true });
  }
  return false;
}
