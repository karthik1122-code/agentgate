/**
 * The public playground: stateless, unauthenticated, and built from the same engine the dashboard uses.
 *
 * It exists so anyone can watch the gate decide without an account. It reuses prepareCall, evaluatePolicy,
 * callHash, nextRecord and verifyChain unchanged, so what it says is what the real runtime would say.
 * It holds no state: nothing is stored, and approvals here are a flag on the request, not a person.
 */
import { createHash } from 'node:crypto';
import { evaluatePolicy } from './policy.mjs';
import { TOOLS, prepareCall, ArgError, createWorld, DEFAULT_FILES } from './tools.mjs';
import { callHash, nextRecord, verifyChain } from './chain.mjs';
import { SCENARIOS } from './scenarios.mjs';

const clip = (v, n = 300) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > n ? `${s.slice(0, n)}…` : s; };
export class PlayError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }

const RECORD_FIELDS = ['run_id', 'seq', 'type', 'data', 'at', 'prev', 'hash'];
const MAX_EVENTS = 80;

export function createPlayground(policy) {
  const limits = { maxCalls: 25, maxDenials: 3, maxArgsBytes: 8192, approvalTtlSeconds: 900, ...(policy.limits || {}) };
  const policyHash = createHash('sha256').update(JSON.stringify(policy)).digest('hex').slice(0, 16);

  const contextFor = (calls, denials, totals, call) => {
    const projected = {};
    const sum = totals[call.tool] || {};
    for (const [k, v] of Object.entries(call.args)) if (typeof v === 'number') projected[k] = (sum[k] || 0) + v;
    return { args: call.args, facts: call.facts, run: { calls, denials }, projected };
  };

  return {
    policyHash,
    meta() {
      return {
        policyHash, policy,
        tools: Object.fromEntries(Object.entries(TOOLS).map(([k, t]) => [k, { description: t.description, fields: t.fields }])),
        scenarios: Object.entries(SCENARIOS).map(([id, s]) => ({ id, title: s.title, description: s.description, calls: s.planner.calls })),
      };
    },

    /** Judge one call. `prior` is the total already spent in the same run for numeric fields, e.g. { amount: 150000 }. */
    check(body) {
      const { tool, args } = body || {};
      const prior = body?.prior && typeof body.prior === 'object' ? body.prior : {};
      let call;
      try { call = prepareCall(tool, args, { maxArgsBytes: limits.maxArgsBytes }); }
      catch (error) { if (error instanceof ArgError) return { stage: 'validation', effect: 'deny', reason: error.message, rules: [], default: false }; throw error; }
      const totals = { [call.tool]: Object.fromEntries(Object.entries(prior).filter(([, v]) => Number.isSafeInteger(v) && v >= 0)) };
      const d = evaluatePolicy(policy, call.tool, contextFor(1, 0, totals, call));
      return { stage: 'policy', effect: d.effect, reason: d.reason, rules: d.rules, default: d.default, tool: call.tool, canonical: call.args, facts: call.facts, hash: callHash(call.tool, call.args), policyHash };
    },

    /**
     * Runs a scripted agent through the real gate and returns the hash-chained log it would write.
     * With approve=false the run stops at the first held call, exactly as the real runtime does.
     */
    run({ scenario, approve = false } = {}) {
      if (typeof scenario !== 'string' || !Object.hasOwn(SCENARIOS, scenario)) throw new PlayError('unknown scenario');
      const planner = SCENARIOS[scenario].planner;
      const runId = `play_${createHash('sha256').update(`${scenario}${Math.random()}`).digest('hex').slice(0, 8)}`;
      const world = createWorld(DEFAULT_FILES);
      const events = []; let last = null;
      let tick = Date.now();
      const add = (type, data) => { tick += 7 + Math.floor(Math.random() * 40); last = nextRecord(runId, last, type, data, new Date(tick).toISOString()); events.push(last); };
      const calls = []; const totals = {};
      let callCount = 0, denials = 0, status = 'completed', abortReason = null;
      add('run_started', { planner: scenario, input: {}, actor: `agent:${scenario}`, policy_hash: policyHash });

      outer: for (const proposal of planner.calls) {
        if (denials >= limits.maxDenials) { add('run_aborted', { reason: 'too_many_denials' }); status = 'aborted'; abortReason = 'too_many_denials'; break; }
        if (callCount >= limits.maxCalls) { add('run_aborted', { reason: 'max_calls_exceeded' }); status = 'aborted'; abortReason = 'max_calls_exceeded'; break; }
        const id = `c${callCount + 1}`;
        const row = { id, tool: proposal.tool, args: proposal.args, effect: null, reason: '', rules: [], state: 'proposed', hash: null };
        calls.push(row);
        let call;
        try { call = prepareCall(proposal.tool, proposal.args, { maxArgsBytes: limits.maxArgsBytes }); }
        catch (error) {
          if (!(error instanceof ArgError)) throw error;
          callCount += 1; denials += 1;
          add('call_proposed', { call_id: id, tool: clip(String(proposal.tool), 60), raw: clip(proposal.args ?? null) });
          add('call_denied', { call_id: id, source: 'validation', reason: error.message });
          Object.assign(row, { effect: 'deny', reason: error.message, state: 'denied', stage: 'validation' });
          continue;
        }
        callCount += 1;
        const hash = callHash(call.tool, call.args);
        Object.assign(row, { args: call.args, hash });
        add('call_proposed', { call_id: id, tool: call.tool, args: call.args, facts: call.facts, hash });
        const d = evaluatePolicy(policy, call.tool, contextFor(callCount, denials, totals, call));
        add('policy_decision', { call_id: id, tool: call.tool, args: call.args, facts: call.facts, hash, effect: d.effect, rules: d.rules, reason: d.reason });
        Object.assign(row, { effect: d.effect, reason: d.reason, rules: d.rules.map(r => r.id), state: 'decided' });
        if (d.effect === 'deny') { denials += 1; add('call_denied', { call_id: id, source: 'policy', reason: d.reason }); row.state = 'denied'; continue; }
        if (d.effect === 'approve') {
          add('approval_requested', { call_id: id, hash, expires_at: new Date(tick + limits.approvalTtlSeconds * 1000).toISOString(), reason: d.reason });
          row.state = 'pending_approval';
          if (!approve) { status = 'waiting_approval'; break outer; }
          add('approval_granted', { call_id: id, by: 'human:playground', hash });
          row.state = 'approved'; row.approvedBy = 'human:playground';
          // The runtime judges the call again at the moment it would run.
          const again = evaluatePolicy(policy, call.tool, contextFor(callCount, denials, totals, call));
          if (again.effect === 'deny') { denials += 1; add('call_denied', { call_id: id, source: 'policy_changed', reason: again.reason }); row.state = 'denied'; continue; }
        }
        const result = TOOLS[call.tool].run(call.args, { world, key: `${runId}:${id}` });
        add('call_executed', { call_id: id, key: `${runId}:${id}`, result: clip(result), untrusted: true });
        row.state = 'executed';
        const t = (totals[call.tool] ||= {});
        for (const [k, v] of Object.entries(call.args)) if (typeof v === 'number') t[k] = (t[k] || 0) + v;
      }
      if (status === 'completed') add('run_completed', { result: clip(`${calls.length} calls finished`) });
      return { runId, scenario, status, abortReason, calls, events, integrity: verifyChain(events), policyHash };
    },

    /** Re-checks a chain a visitor may have edited. This is the real verifier, not a copy of it. */
    verify(body) {
      const events = body?.events;
      if (!Array.isArray(events) || !events.length) throw new PlayError('events must be a non-empty array');
      if (events.length > MAX_EVENTS) throw new PlayError(`at most ${MAX_EVENTS} events`, 413);
      for (const e of events) {
        if (!e || typeof e !== 'object' || RECORD_FIELDS.some(f => !Object.hasOwn(e, f))) throw new PlayError('every event needs run_id, seq, type, data, at, prev and hash');
        if (typeof e.hash !== 'string' || typeof e.prev !== 'string' || typeof e.type !== 'string' || typeof e.run_id !== 'string' || typeof e.at !== 'string' || !Number.isInteger(e.seq) || e.data === null || typeof e.data !== 'object') throw new PlayError('an event has a field of the wrong type');
      }
      return verifyChain(events);
    },
  };
}
