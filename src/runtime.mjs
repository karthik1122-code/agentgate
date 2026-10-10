import { randomUUID, createHash } from 'node:crypto';
import { callHash } from './chain.mjs';
import { validatePolicy, evaluatePolicy } from './policy.mjs';
import { TOOLS, prepareCall, ArgError } from './tools.mjs';
import { ConflictError } from './store.mjs';

export class GateError extends Error { constructor(code, message) { super(message); this.code = code; } }

const DEFAULT_LIMITS = { maxCalls: 25, maxDenials: 3, maxArgsBytes: 8192, approvalTtlSeconds: 900, requireDifferentApprover: true };
const TERMINAL = new Set(['completed', 'aborted']);
const clip = (v, n = 1000) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > n ? s.slice(0, n) + '…' : s; };

/**
 * Rebuilds everything the runtime needs from a run's event log. There is no other state:
 * a process that crashes and restarts folds the same log and continues exactly where it stopped.
 */
export function foldRun(events) {
  const s = { status: 'running', calls: [], denials: 0, callCount: 0, totals: {}, lastSeq: 0, result: null, abortReason: null };
  const byId = new Map();
  for (const e of events) {
    s.lastSeq = e.seq; s.runId = e.run_id;
    const d = e.data;
    switch (e.type) {
      case 'run_started': Object.assign(s, { planner: d.planner, input: d.input, actor: d.actor, policyHash: d.policy_hash }); break;
      case 'call_proposed': { const c = { id: d.call_id, tool: d.tool, rawArgs: d.raw, args: d.args, facts: d.facts, hash: d.hash, state: 'proposed' }; byId.set(c.id, c); s.calls.push(c); s.callCount += 1; break; }
      case 'policy_decision': { const c = byId.get(d.call_id); Object.assign(c, { args: d.args, facts: d.facts, hash: d.hash, decision: { effect: d.effect, rules: d.rules, reason: d.reason }, state: 'decided' }); break; }
      case 'call_denied': { const c = byId.get(d.call_id); c.state = 'denied'; c.outcome = { status: 'denied', source: d.source, reason: d.reason }; s.denials += 1; break; }
      case 'approval_requested': { const c = byId.get(d.call_id); c.state = 'pending_approval'; c.approval = { expiresAt: d.expires_at, requestedAt: e.at }; break; }
      case 'approval_granted': { const c = byId.get(d.call_id); c.state = 'approved'; c.approval = { ...c.approval, by: d.by, at: e.at }; break; }
      case 'approval_rejected': { const c = byId.get(d.call_id); c.state = 'rejected'; c.outcome = { status: 'rejected', reason: d.note || 'rejected by approver', by: d.by }; break; }
      case 'approval_expired': { const c = byId.get(d.call_id); c.state = 'expired'; c.outcome = { status: 'expired', reason: 'approval window passed' }; break; }
      case 'call_executed': { const c = byId.get(d.call_id); c.state = 'executed'; c.outcome = { status: 'executed', result: d.result }; const t = (s.totals[c.tool] ||= { count: 0, sum: {} }); t.count += 1; for (const [k, v] of Object.entries(c.args)) if (typeof v === 'number') t.sum[k] = (t.sum[k] || 0) + v; break; }
      case 'call_failed': { const c = byId.get(d.call_id); c.state = 'failed'; c.outcome = { status: 'failed', reason: d.error }; break; }
      case 'run_completed': s.status = 'completed'; s.result = d.result; break;
      case 'run_aborted': s.status = 'aborted'; s.abortReason = d.reason; break;
      default: break;
    }
  }
  if (!TERMINAL.has(s.status)) s.status = s.calls.some(c => c.state === 'pending_approval') ? 'waiting_approval' : 'running';
  s.history = s.calls.filter(c => c.outcome).map(c => ({ call: { tool: c.tool, args: c.args ?? c.rawArgs }, outcome: c.outcome }));
  return s;
}

export function createRuntime({ store, policy, planners = {}, world, tools = TOOLS, now = () => Date.now(), hooks = {} }) {
  const problems = validatePolicy(policy);
  if (problems.length) throw new GateError('invalid_policy', `Policy is invalid:\n- ${problems.join('\n- ')}`);
  const limits = { ...DEFAULT_LIMITS, ...(policy.limits || {}) };
  const policyHash = createHash('sha256').update(JSON.stringify(policy)).digest('hex').slice(0, 16);
  const iso = () => new Date(now()).toISOString();

  const append = async (runId, state, type, data, status) => {
    await hooks.beforeAppend?.(type, data);
    const rec = await store.append(runId, type, data, { expectedSeq: state.lastSeq, status, at: iso() });
    state.lastSeq = rec.seq;
    return rec;
  };

  const abort = async (runId, state, reason) => { await append(runId, state, 'run_aborted', { reason }, 'aborted'); return refold(runId); };
  const refold = async runId => foldRun(await store.events(runId));

  async function execute(runId, state, call) {
    // Policy is checked again at execution time: if it was tightened while this call waited, the tighter rule wins.
    const again = evaluatePolicy(policy, call.tool, contextFor(state, call));
    if (again.effect === 'deny') {
      await append(runId, state, 'call_denied', { call_id: call.id, source: 'policy_changed', reason: again.reason });
      return;
    }
    const key = `${runId}:${call.id}`;
    try {
      await hooks.beforeExecute?.(call);
      const result = await tools[call.tool].run(call.args, { world, key });
      await hooks.afterExecute?.(call);
      await append(runId, state, 'call_executed', { call_id: call.id, key, result: clip(result), untrusted: true });
    } catch (error) {
      if (error instanceof ConflictError || error?.code === 'simulated_crash') throw error;
      await append(runId, state, 'call_failed', { call_id: call.id, error: clip(error.message, 300) });
    }
  }

  function contextFor(state, call) {
    const projected = {};
    const t = state.totals[call.tool]?.sum || {};
    for (const [k, v] of Object.entries(call.args)) if (typeof v === 'number') projected[k] = (t[k] || 0) + v;
    return { args: call.args, facts: call.facts, run: { calls: state.callCount, denials: state.denials }, projected };
  }

  async function decide(runId, state, call) {
    const decision = evaluatePolicy(policy, call.tool, contextFor(state, call));
    await append(runId, state, 'policy_decision', { call_id: call.id, tool: call.tool, args: call.args, facts: call.facts, hash: call.hash, effect: decision.effect, rules: decision.rules, reason: decision.reason });
    return decision;
  }

  /** Applies a recorded decision: deny closes the call, approve opens an approval request. Allow is executed by the drive loop. */
  async function applyDecision(runId, state, call, decision) {
    if (decision.effect === 'deny') await append(runId, state, 'call_denied', { call_id: call.id, source: 'policy', reason: decision.reason });
    else if (decision.effect === 'approve') {
      const expires = new Date(now() + limits.approvalTtlSeconds * 1000).toISOString();
      await append(runId, state, 'approval_requested', { call_id: call.id, hash: call.hash, expires_at: expires, reason: decision.reason }, 'waiting_approval');
    }
  }
  const resolve = async (runId, state, call) => applyDecision(runId, state, call, await decide(runId, state, call));

  async function propose(runId, state, proposal) {
    const callId = `c${state.callCount + 1}`;
    let prepared;
    try { prepared = prepareCall(proposal?.tool, proposal?.args, { maxArgsBytes: limits.maxArgsBytes, tools }); }
    catch (error) {
      if (!(error instanceof ArgError)) throw error;
      await append(runId, state, 'call_proposed', { call_id: callId, tool: clip(String(proposal?.tool), 60), raw: clip(proposal?.args ?? null, 300) });
      await append(runId, state, 'call_denied', { call_id: callId, source: 'validation', reason: error.message });
      return;
    }
    const hash = callHash(prepared.tool, prepared.args);
    await append(runId, state, 'call_proposed', { call_id: callId, tool: prepared.tool, args: prepared.args, facts: prepared.facts, hash });
    const call = { id: callId, tool: prepared.tool, args: prepared.args, facts: prepared.facts, hash };
    await resolve(runId, state, call);
  }

  /** Runs the planner and the gate until the run finishes or needs a human. Safe to call again at any time. */
  async function drive(runId) {
    for (let guard = 0; guard < 200; guard += 1) {
      const state = await refold(runId);
      if (TERMINAL.has(state.status)) return state;
      if (state.status === 'waiting_approval') return state;
      if (state.denials >= limits.maxDenials) return abort(runId, state, 'too_many_denials');
      // Crash recovery: a call that was approved (or decided "allow") but never executed.
      const unfinished = state.calls.find(c => c.state === 'approved' || (c.state === 'decided' && c.decision.effect === 'allow'));
      try {
        if (unfinished) { await execute(runId, state, unfinished); continue; }
        const undecided = state.calls.find(c => c.state === 'proposed' && c.args);
        if (undecided) { await resolve(runId, state, undecided); continue; }
        const half = state.calls.find(c => c.state === 'decided' && c.decision.effect !== 'allow');
        if (half) { await applyDecision(runId, state, half, half.decision); continue; }
      } catch (error) { if (error instanceof ConflictError) continue; throw error; }
      const orphan = state.calls.find(c => c.state === 'proposed' && !c.args);
      if (orphan) { await append(runId, state, 'call_denied', { call_id: orphan.id, source: 'validation', reason: 'proposal was interrupted before it was checked' }); continue; }
      const planner = planners[state.planner];
      if (!planner) return abort(runId, state, `unknown planner "${state.planner}"`);
      const next = await planner.next({ input: state.input, history: state.history });
      if (next?.done) { await append(runId, state, 'run_completed', { result: clip(next.result ?? null, 500) }, 'completed'); return refold(runId); }
      if (state.callCount >= limits.maxCalls) return abort(runId, state, 'max_calls_exceeded');
      try { await propose(runId, state, next?.call); }
      catch (error) { if (error instanceof ConflictError) continue; throw error; }
      const after = await refold(runId);
      if (after.status === 'waiting_approval') return after;
    }
    throw new GateError('loop_guard', 'run did not settle');
  }

  return {
    limits, policyHash,
    async startRun({ planner, input = {}, actor }) {
      if (!planners[planner]) throw new GateError('unknown_planner', `Unknown planner "${planner}"`);
      if (!actor || typeof actor !== 'string' || actor.length > 100) throw new GateError('invalid_actor', 'actor is required');
      const id = `run_${randomUUID().slice(0, 8)}`;
      await store.createRun({ id, planner, input, actor, status: 'running' });
      const state = { lastSeq: 0 };
      await append(id, state, 'run_started', { planner, input, actor, policy_hash: policyHash });
      return drive(id);
    },
    drive,
    /** Approve or reject a pending call. `hash` must be the call hash the approver was shown. */
    async decide(runId, callId, { by, decision, hash, note }) {
      if (!['approve', 'reject'].includes(decision)) throw new GateError('invalid_decision', 'decision must be approve or reject');
      if (!by || typeof by !== 'string' || by.length > 100) throw new GateError('invalid_approver', 'approver identity is required');
      const state = await refold(runId);
      if (!state.planner) throw new GateError('not_found', 'run not found');
      const call = state.calls.find(c => c.id === callId);
      if (!call) throw new GateError('not_found', 'call not found');
      if (call.state !== 'pending_approval') throw new GateError('not_pending', `call is ${call.state}, not waiting for approval`);
      if (!hash || hash !== call.hash) throw new GateError('hash_mismatch', 'the call changed since you reviewed it, or no hash was provided');
      if (limits.requireDifferentApprover && by === state.actor) throw new GateError('same_actor', 'the approver must be different from whoever started the run');
      if (now() > Date.parse(call.approval.expiresAt)) {
        await append(runId, state, 'approval_expired', { call_id: callId }, 'running');
        await drive(runId);
        throw new GateError('expired', 'the approval window had already passed; the call was not executed');
      }
      try {
        if (decision === 'approve') await append(runId, state, 'approval_granted', { call_id: callId, by, hash }, 'running');
        else await append(runId, state, 'approval_rejected', { call_id: callId, by, note: clip(note ?? '', 200) }, 'running');
      } catch (error) { if (error instanceof ConflictError) throw new GateError('already_decided', 'someone else decided this call first'); throw error; }
      return drive(runId);
    },
    /** Expires approvals past their deadline and continues those runs. Call it on a timer. */
    async expireStale() {
      const out = [];
      for (const run of await store.listByStatus('waiting_approval')) {
        const state = await refold(run.id);
        for (const c of state.calls.filter(x => x.state === 'pending_approval' && now() > Date.parse(x.approval.expiresAt))) {
          try { await append(run.id, state, 'approval_expired', { call_id: c.id }, 'running'); out.push(`${run.id}:${c.id}`); } catch (e) { if (!(e instanceof ConflictError)) throw e; }
        }
        await drive(run.id);
      }
      return out;
    },
    async view(runId) {
      const events = await store.events(runId);
      return { run: await store.getRun(runId), state: foldRun(events), events };
    },
  };
}
