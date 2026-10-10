import { readFileSync } from 'node:fs';
import { createRuntime } from '../src/runtime.mjs';
import { createMemoryStore } from '../src/store.mjs';
import { createWorld, DEFAULT_FILES } from '../src/tools.mjs';
import { planners as scenarioPlanners, script } from '../src/scenarios.mjs';

export const loadPolicy = () => JSON.parse(readFileSync(new URL('../policies/default.json', import.meta.url), 'utf8'));

/** A runtime with a controllable clock, over a fresh simulated world. */
export function setup({ policy = loadPolicy(), planners = scenarioPlanners, store = createMemoryStore(), world = createWorld(DEFAULT_FILES), hooks = {}, startAt = Date.parse('2026-10-10T09:00:00Z') } = {}) {
  const clock = { t: startAt };
  const runtime = createRuntime({ store, policy, planners, world, now: () => clock.t, hooks });
  return { runtime, store, world, clock, policy };
}

export const refund = (id, amount) => ({ tool: 'refund_payment', args: { payment_id: id, amount, currency: 'INR' } });
export { script };
export const pendingCall = state => state.calls.find(c => c.state === 'pending_approval');
export const APPROVER = 'human:karthik';
export const AGENT = 'agent:support-bot';
