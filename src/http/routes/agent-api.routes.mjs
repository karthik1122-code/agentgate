import { EXTERNAL } from '../../runtime.mjs';
import { send, readJson } from '../respond.mjs';
import { callView, runSummary } from '../views.mjs';

// API for outside agents: Authorization: Bearer agk_...
// No cookies are involved, so no CSRF header is needed. A key only sees runs it started, and can never approve.
export async function agentApiRoutes({ req, res, url }, { auth, runtime, store }) {
  const bearer = /^Bearer\s+(\S+)$/.exec(req.headers.authorization || '');
  const agent = bearer ? await auth.agentFromKey(bearer[1]) : null;
  if (!agent) return send(res, 401, { error: 'invalid_agent_key', message: 'Send an agent key as "Authorization: Bearer agk_...". An admin creates keys on the Agent keys page.' });
  const actor = `agent:${agent.name} (${agent.id})`;
  const owns = async runId => { const r = await store.getRun(runId); return !!r && r.planner === EXTERNAL && r.actor === actor; };
  const p = url.pathname.slice('/api/v1'.length);

  if (req.method === 'POST' && p === '/runs') {
    const { input } = await readJson(req);
    return send(res, 201, runSummary(await runtime.startRun({ planner: EXTERNAL, actor, input: input ?? {} })));
  }
  const r = p.match(/^\/runs\/([\w-]+)(\/calls(?:\/(c\d+))?|\/complete)?$/);
  if (!r || !(await owns(r[1]))) return send(res, 404, { error: 'not_found' });
  const [, runId, sub, callId] = r;

  if (req.method === 'GET' && !sub) { const v = await runtime.view(runId); return send(res, 200, { ...runSummary(v.state), calls: v.state.calls.map(callView) }); }
  // Propose one call: 200 with executed or denied, or 202 while it waits for a person.
  if (req.method === 'POST' && sub === '/calls') {
    const { tool, args } = await readJson(req);
    const { state, call } = await runtime.submitCall(runId, { tool, args });
    return send(res, call.state === 'pending_approval' ? 202 : 200, { run: runSummary(state), call: callView(call) });
  }
  if (req.method === 'GET' && callId) {
    const v = await runtime.view(runId);
    const call = v.state.calls.find(c => c.id === callId);
    return call ? send(res, 200, { run: runSummary(v.state), call: callView(call) }) : send(res, 404, { error: 'not_found' });
  }
  if (req.method === 'POST' && sub === '/complete') { const { result } = await readJson(req); return send(res, 200, runSummary(await runtime.completeRun(runId, result))); }
  return send(res, 404, { error: 'not_found' });
}
