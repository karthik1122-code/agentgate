import { setup, script, AGENT } from './helpers.mjs';
import { cases } from './adversarial-cases.mjs';

/** Runs every case as the single call of its own run and reports what actually happened. */
export async function runCases() {
  const out = [];
  for (const c of cases) {
    const planners = { one: script([{ tool: c.tool, args: c.args }]) };
    const { runtime, world } = setup({ planners });
    const before = JSON.stringify([world.outbox, world.ledger, world.commands, [...world.files]]);
    const state = await runtime.startRun({ planner: 'one', actor: AGENT });
    const call = state.calls[0];
    const outcome = call.state === 'executed' ? 'allow' : call.state === 'pending_approval' ? 'approve' : 'deny';
    const sideEffect = JSON.stringify([world.outbox, world.ledger, world.commands, [...world.files]]) !== before;
    out.push({ ...c, outcome, sideEffect, ok: outcome === c.expect, source: call.outcome?.source || (call.decision?.default ? 'default' : call.decision?.rules?.[0]?.id), reason: call.outcome?.reason || call.decision?.reason });
  }
  return out;
}
