#!/usr/bin/env node
/**
 * The smallest outside agent: it talks to a running AgentGate over HTTP with an agent key.
 * Every call it sends is saved in a hash-chained run log; calls that need a person wait in Approvals.
 *
 *   AGENTGATE_URL=http://localhost:4200 AGENTGATE_KEY=agk_... node examples/external-agent.mjs
 *
 * An admin creates the key on the Team page. The key can start runs and propose calls. It cannot approve.
 */
const base = (process.env.AGENTGATE_URL || 'http://localhost:4200').replace(/\/+$/, '');
const key = process.env.AGENTGATE_KEY;
if (!key) { console.error('Set AGENTGATE_KEY to an agent key (Team page → New agent key).'); process.exit(1); }

async function gate(path, body) {
  const res = await fetch(`${base}/api/v1${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 202) throw new Error(`${res.status} ${data.error || ''}: ${data.message || ''}`);
  return data;
}

// What your model decided to do. Here it is a fixed list so the example runs without an API key.
const plan = [
  { tool: 'read_file', args: { path: 'workspace/report.md' } },
  { tool: 'refund_payment', args: { payment_id: 'pay_AB12CD34', amount: 50000, currency: 'INR' } },
  { tool: 'refund_payment', args: { payment_id: 'pay_EF56GH78', amount: 500000, currency: 'INR' } },
];

const run = await gate('/runs', { input: { ticket: 'example' } });
console.log(`run ${run.runId} started`);
for (const step of plan) {
  let { call } = await gate(`/runs/${run.runId}/calls`, step);
  console.log(`${call.tool}: ${call.status}${call.reason ? ` (${call.reason})` : ''}`);
  // A held call: wait for a person to decide in the AgentGate app, checking every few seconds.
  while (call.status === 'waiting_for_approval') {
    await new Promise(r => setTimeout(r, 3000));
    ({ call } = await gate(`/runs/${run.runId}/calls/${call.id}`));
    if (call.status !== 'waiting_for_approval') console.log(`  → ${call.status}${call.approval?.by ? ` by ${call.approval.by}` : ''}`);
  }
  if (call.status === 'denied' || call.status === 'rejected' || call.status === 'expired') { console.log('  the agent stops here instead of working around the gate'); break; }
}
console.log((await gate(`/runs/${run.runId}`)).status === 'running' ? (await gate(`/runs/${run.runId}/complete`, { result: 'done' })).status : 'run already closed');
