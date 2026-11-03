import { SCENARIOS } from '../../scenarios.mjs';
import { TOOLS, prepareCall, ArgError } from '../../tools.mjs';
import { evaluatePolicy } from '../../policy.mjs';
import { send, readJson } from '../respond.mjs';
import { runView } from '../views.mjs';

// The dashboard's view of the gate: policy, the simulated world, runs, approvals, stats and human decisions.
export async function gateRoutes({ req, res, url, user, need }, deps) {
  const { runtime, store, policy, config } = deps; const { method } = req; const path = url.pathname;

  if (method === 'GET' && path === '/api/scenarios') return send(res, 200, Object.entries(SCENARIOS).map(([id, s]) => ({ id, title: s.title, description: s.description })));
  if (method === 'GET' && path === '/api/policy') return send(res, 200, { policy, hash: runtime.policyHash, tools: Object.fromEntries(Object.entries(TOOLS).map(([k, t]) => [k, { description: t.description, fields: t.fields }])) });
  if (method === 'GET' && path === '/api/world') { const w = deps.world(); return send(res, 200, { outbox: w.outbox, ledger: w.ledger, commands: w.commands, files: [...w.files.keys()] }); }

  // Dry run: what would the policy say about this call? Nothing is recorded or executed.
  if (method === 'POST' && path === '/api/policy/check') {
    if (need('approver')) return true;
    const { tool, args } = await readJson(req);
    try {
      const call = prepareCall(tool, args, { maxArgsBytes: runtime.limits.maxArgsBytes });
      const d = evaluatePolicy(policy, call.tool, { args: call.args, facts: call.facts, run: { calls: 0, denials: 0 }, projected: Object.fromEntries(Object.entries(call.args).filter(([, v]) => typeof v === 'number')) });
      return send(res, 200, { stage: 'policy', effect: d.effect, reason: d.reason, rules: d.rules, default: d.default, canonical: call.args, facts: call.facts });
    } catch (error) { if (error instanceof ArgError) return send(res, 200, { stage: 'validation', effect: 'deny', reason: error.message, rules: [] }); throw error; }
  }

  if (method === 'GET' && path === '/api/runs') {
    const runs = await store.listRuns(50);
    return send(res, 200, await Promise.all(runs.map(async r => { const v = await runtime.view(r.id); return { id: r.id, planner: r.planner, actor: r.actor, status: v.state.status, created_at: r.created_at, calls: v.state.calls.length, denials: v.state.denials }; })));
  }
  if (method === 'POST' && path === '/api/runs') {
    if (need('approver')) return true;
    const { scenario } = await readJson(req);
    if (!Object.hasOwn(SCENARIOS, scenario)) return send(res, 400, { error: 'unknown_scenario' });
    const state = await runtime.startRun({ planner: scenario, actor: `agent:${scenario}` });
    return send(res, 201, await runView(runtime, state.runId));
  }

  if (method === 'GET' && path === '/api/approvals') {
    const pending = [];
    for (const r of await store.listByStatus('waiting_approval')) {
      const v = await runtime.view(r.id);
      for (const c of v.state.calls.filter(x => x.state === 'pending_approval')) {
        pending.push({ runId: r.id, actor: r.actor, planner: r.planner, call: { id: c.id, tool: c.tool, args: c.args, facts: c.facts, hash: c.hash, reason: c.decision.reason, rules: c.decision.rules.map(x => x.id), expiresAt: c.approval.expiresAt, requestedAt: c.approval.requestedAt } });
      }
    }
    return send(res, 200, pending);
  }

  if (method === 'GET' && path === '/api/stats') return send(res, 200, await stats(runtime, store));

  const m = path.match(/^\/api\/runs\/([\w-]+)(?:\/calls\/(c\d+)\/decision)?$/);
  if (m && method === 'GET' && !m[2]) { const v = await runView(runtime, m[1]); return v ? send(res, 200, v) : send(res, 404, { error: 'not_found' }); }
  // A person approves or rejects one held call. The hash must match the call they were shown.
  if (m && m[2] && method === 'POST') {
    if (need('approver')) return true;
    const body = await readJson(req);
    const by = config.authOn ? `human:${user.email}` : body.by;
    await runtime.decide(m[1], m[2], { by, decision: body.decision, hash: body.hash, note: body.note });
    return send(res, 200, await runView(runtime, m[1]));
  }
  return false;
}

// Totals over the last 30 runs for the overview page, plus the latest 12 events.
async function stats(runtime, store) {
  const runs = await store.listRuns(30);
  const views = (await Promise.all(runs.map(r => runView(runtime, r.id)))).filter(Boolean);
  const s = { runs: runs.length, calls: 0, allow: 0, approve: 0, deny: 0, stopped: 0, valid: 0, checked: views.length, tools: {}, feed: [] };
  for (const v of views) {
    if (v.integrity.valid) s.valid += 1;
    const toolOf = new Map(v.state.calls.map(c => [c.id, c.tool]));
    for (const c of v.state.calls) {
      s.calls += 1;
      const eff = (c.decision && c.decision.effect) || (c.state === 'denied' ? 'deny' : null);
      if (eff) s[eff] += 1;
      const t = (s.tools[c.tool] ||= { allow: 0, approve: 0, deny: 0 }); if (eff) t[eff] += 1;
      if (['denied', 'rejected', 'expired'].includes(c.state)) s.stopped += 1;
    }
    for (const e of v.events) { const d = e.data || {}; s.feed.push({ at: e.at, type: e.type, run: v.state.runId, data: { tool: d.tool || toolOf.get(d.call_id), effect: d.effect, reason: d.reason, by: d.by, planner: d.planner } }); }
  }
  s.feed.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)); s.feed = s.feed.slice(0, 12);
  return s;
}
