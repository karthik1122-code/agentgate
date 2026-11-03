import { verifyChain } from '../chain.mjs';

// The shapes the dashboard and the agent API receive. Kept here so routes stay short.

export const summary = state => ({
  runId: state.runId, planner: state.planner, actor: state.actor, status: state.status, abortReason: state.abortReason, denials: state.denials,
  calls: state.calls.map(c => ({ id: c.id, tool: c.tool, args: c.args, facts: c.facts, hash: c.hash, state: c.state, decision: c.decision, outcome: c.outcome, approval: c.approval })),
});

/** A run with its state, its events and whether its hash chain verifies. Null if the run does not exist. */
export async function runView(runtime, id) {
  const v = await runtime.view(id);
  if (!v.run) return null;
  return { run: v.run, state: summary(v.state), events: v.events, integrity: verifyChain(v.events) };
}

// Agent API views: a smaller, stable shape for outside agents.
export const callView = c => c && ({
  id: c.id, tool: c.tool, args: c.args ?? null, hash: c.hash ?? null,
  status: c.state === 'executed' ? 'executed' : c.state === 'pending_approval' ? 'waiting_for_approval' : c.state,
  reason: c.outcome?.reason ?? c.decision?.reason ?? null,
  result: c.outcome?.status === 'executed' ? c.outcome.result : undefined,
  approval: c.approval ? { expiresAt: c.approval.expiresAt, by: c.approval.by ?? null } : undefined,
});
export const runSummary = state => ({ runId: state.runId, status: state.status, abortReason: state.abortReason, calls: state.calls.length, denials: state.denials });
