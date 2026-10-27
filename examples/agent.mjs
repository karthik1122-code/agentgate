#!/usr/bin/env node
/**
 * A small AI agent whose every tool call goes through AgentGate before anything "runs".
 *
 *   node examples/agent.mjs --task "Refund pay_AB12CD34 for ₹500 and email the team"   (needs GEMINI_API_KEY)
 *   node examples/agent.mjs --mock prompt-injection                                    (no key, no network)
 *   node examples/agent.mjs --mock salami-refunds --base https://agentgate-lake.vercel.app
 *
 * Zero dependencies. The agent only PROPOSES calls. The gate answers allow, hold (needs a person) or deny.
 * The world is simulated: nothing here sends mail, moves money or touches a file.
 */
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { createPlayground } from '../src/play.mjs';
import { SCENARIOS } from '../src/scenarios.mjs';

const MAX_STEPS = 25; // the gate's own per-run call limit
const SYSTEM = 'You are a support operations agent. Use the tools to finish the task. If a tool result says a call was denied or is waiting for a person, do not try to get around it: explain it in one sentence and stop.';

/** The gate: where decisions come from. `local` runs the same engine in-process; `remote` calls a deployed playground. */
export function localGate(policy) {
  const play = createPlayground(policy);
  return { meta: async () => play.meta(), check: async body => play.check(body) };
}
export function remoteGate(base) {
  const url = path => `${base.replace(/\/+$/, '')}/api/play/${path}`;
  const call = async (path, init) => {
    const r = await fetch(url(path), init);
    if (!r.ok) throw new Error(`gate returned ${r.status} for ${path}`);
    return r.json();
  };
  return {
    meta: () => call('meta'),
    check: body => call('check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  };
}

/** A planner that replays a scripted scenario. Same interface as the Gemini one, so the loop below is identical for both. */
export function mockPlanner(calls) {
  let i = 0;
  return { next: async () => (i < calls.length ? { tool: calls[i].tool, args: calls[i++].args } : null), feed: () => {} };
}

/**
 * A planner backed by Gemini function calling over plain REST.
 * - Retries 429 and 5xx answers with backoff, then tries `fallbackModel` (GEMINI_FALLBACK_MODEL) if set.
 * - Gives up on one model call after `timeoutMs`.
 * - When the model asks for several tools in one turn, they are proposed to the gate one by one, and every
 *   result goes back to the model in a single turn, as the function-calling API requires.
 */
export function geminiPlanner({
  task, tools,
  key = process.env.GEMINI_API_KEY,
  model = process.env.GEMINI_MODEL || 'gemini-3.8-flash',
  fallbackModel = process.env.GEMINI_FALLBACK_MODEL || '',
  attempts = 3, retryDelayMs = 600, timeoutMs = 30_000,
}) {
  if (!key) throw new Error('Set GEMINI_API_KEY, or use --mock <scenario> to run without a key.');
  const declarations = Object.entries(tools).map(([name, t]) => ({
    name, description: t.description,
    parameters: {
      type: 'object',
      properties: Object.fromEntries(Object.entries(t.fields).map(([f, s]) => [f, s.type === 'stringArray' ? { type: 'array', items: { type: 'string' } } : { type: s.type === 'integer' ? 'integer' : 'string', ...(s.enum ? { enum: s.enum } : {}) }])),
      required: Object.entries(t.fields).filter(([, s]) => s.required).map(([f]) => f),
    },
  }));
  const contents = [{ role: 'user', parts: [{ text: task }] }];
  const queue = []; let asked = []; let answers = [];
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function ask() {
    const body = JSON.stringify({ systemInstruction: { parts: [{ text: SYSTEM }] }, contents, tools: [{ functionDeclarations: declarations }] });
    let last;
    for (const m of [model, fallbackModel].filter(Boolean)) {
      for (let i = 0; i < attempts; i += 1) {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body, signal: AbortSignal.timeout(timeoutMs),
        });
        if (r.ok) return r.json();
        last = new Error(`Gemini returned ${r.status}: ${(await r.text()).slice(0, 200)}`);
        if (r.status !== 429 && r.status < 500) throw last; // a bad request will not get better by retrying
        if (i < attempts - 1) await sleep(retryDelayMs * 2 ** i);
      }
    }
    throw last;
  }

  return {
    async next() {
      if (!queue.length) {
        const content = (await ask()).candidates?.[0]?.content;
        if (!content) return null;
        contents.push(content);
        const calls = (content.parts || []).filter(p => p.functionCall).map(p => p.functionCall);
        if (!calls.length) return { say: content.parts?.map(p => p.text).filter(Boolean).join(' ') || '' };
        queue.push(...calls); asked = []; answers = [];
      }
      const fc = queue.shift();
      asked.push(fc.name);
      return { tool: fc.name, args: fc.args || {} };
    },
    feed(result) {
      answers.push({ functionResponse: { name: asked[answers.length], response: result } });
      if (!queue.length) contents.push({ role: 'user', parts: answers });
    },
  };
}

/**
 * The loop. For each proposed call: ask the gate, then
 *   allow   -> "run" it (simulated) and tell the agent;
 *   approve -> ask a person if `approver` is given, otherwise leave it held;
 *   deny    -> tell the agent why and carry on.
 * Returns a summary so callers and tests can check what happened.
 */
export async function runAgent({ gate, planner, approver = null, log = () => {} }) {
  const prior = {}; const trail = [];
  for (let step = 1; step <= MAX_STEPS; step++) {
    const proposal = await planner.next();
    if (!proposal) break;
    if (proposal.say !== undefined) { log({ kind: 'say', text: proposal.say }); break; }
    const verdict = await gate.check({ tool: proposal.tool, args: proposal.args, prior: prior[proposal.tool] || {} });
    let outcome = verdict.effect === 'allow' ? 'ran' : verdict.effect === 'deny' ? 'denied' : 'held';
    if (verdict.effect === 'approve' && approver && await approver(proposal, verdict)) outcome = 'ran-after-approval';
    if (outcome.startsWith('ran')) {
      const bucket = prior[proposal.tool] ||= {};
      for (const [k, v] of Object.entries(verdict.canonical || {})) if (Number.isSafeInteger(v) && v >= 0) bucket[k] = (bucket[k] || 0) + v;
    }
    trail.push({ step, tool: proposal.tool, args: proposal.args, effect: verdict.effect, outcome, reason: verdict.reason, rules: (verdict.rules || []).map(r => r.id) });
    log({ kind: 'call', ...trail.at(-1) });
    planner.feed(outcome.startsWith('ran') ? { status: 'executed' } : outcome === 'held' ? { status: 'waiting_for_human_approval' } : { status: 'denied', reason: verdict.reason });
  }
  const count = o => trail.filter(t => (o === 'ran' ? t.outcome.startsWith('ran') : t.outcome === o)).length;
  return { trail, ran: count('ran'), held: count('held'), denied: count('denied') };
}

// ---- command line ----
const color = process.stdout.isTTY ? { allow: '\x1b[32m', approve: '\x1b[33m', deny: '\x1b[31m', dim: '\x1b[2m', off: '\x1b[0m' } : { allow: '', approve: '', deny: '', dim: '', off: '' };
const label = { allow: 'ALLOW', approve: 'HELD ', deny: 'DENY ' };
const short = a => { const s = JSON.stringify(a); return s.length > 90 ? `${s.slice(0, 90)}…` : s; };
function print(e) {
  if (e.kind === 'say') return console.log(`${color.dim}agent says:${color.off} ${e.text}`);
  const tag = label[e.effect] || e.effect;
  console.log(`${color[e.effect] || ''}${tag}${color.off} ${e.tool} ${color.dim}${short(e.args)}${color.off}`);
  console.log(`      ${color.dim}${e.reason}${e.rules.length ? ` [${e.rules.join(', ')}]` : ''}${e.outcome === 'ran-after-approval' ? ' [approved by you]' : ''}${color.off}`);
}
const arg = name => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : undefined; };

async function main() {
  const base = arg('base');
  const gate = base ? remoteGate(base) : localGate(JSON.parse(readFileSync(new URL('../policies/default.json', import.meta.url), 'utf8')));
  const mock = arg('mock');
  let planner;
  if (mock) {
    if (!Object.hasOwn(SCENARIOS, mock)) { console.error(`Unknown scenario. Choose one of: ${Object.keys(SCENARIOS).join(', ')}`); process.exit(2); }
    console.log(`${color.dim}Scripted agent: ${SCENARIOS[mock].title}${color.off}\n`);
    planner = mockPlanner(SCENARIOS[mock].planner.calls);
  } else {
    const task = arg('task');
    if (!task) { console.error('Give the agent a job: --task "..." (needs GEMINI_API_KEY), or run a scripted one: --mock <scenario>'); process.exit(2); }
    planner = geminiPlanner({ task, tools: (await gate.meta()).tools });
    console.log(`${color.dim}Task: ${task}${color.off}\n`);
  }
  let approver = null; let rl = null;
  if (process.stdin.isTTY && process.argv.includes('--ask')) {
    rl = createInterface({ input: process.stdin, output: process.stdout });
    approver = async (p, v) => /^y/i.test(await rl.question(`      Approve ${p.tool}? (${v.reason}) [y/N] `));
  }
  const out = await runAgent({ gate, planner, approver, log: print });
  rl?.close();
  console.log(`\n${out.ran} ran, ${out.held} held for a person, ${out.denied} denied.`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.error(e.message); process.exit(1); });
