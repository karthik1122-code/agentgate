const $ = id => document.getElementById(id);
const api = async (path, opts = {}) => {
  const res = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.message || body.error || `HTTP ${res.status}`), { code: body.error, status: res.status });
  return body;
};
// Text is only ever inserted with textContent / createTextNode, never innerHTML, so tool arguments cannot inject markup.
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) { if (k === 'class') n.className = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else if (v !== undefined && v !== null) n.setAttribute(k, v); }
  for (const k of kids.flat()) if (k !== null && k !== undefined) n.append(k.nodeType ? k : document.createTextNode(String(k)));
  return n;
};
const badge = s => el('span', { class: `badge b-${s}` }, String(s).replace('_', ' '));
const money = (n) => `₹${(n / 100).toLocaleString('en-IN')}`;
const showArgs = (tool, args) => {
  const a = { ...args };
  if (tool === 'refund_payment' && typeof a.amount === 'number') a.amount = `${a.amount} (${money(a.amount)})`;
  return JSON.stringify(a, null, 2);
};
let selected = null, token = '';

async function loadMeta() {
  const h = await api('/api/health');
  token = h.auth;
  $('meta').textContent = `store: ${h.store} · approvals: ${h.auth === 'token' ? 'token required' : 'demo mode, no token'} · policy ${h.policyHash}`;
}

async function loadScenarios() {
  const list = await api('/api/scenarios');
  const box = $('scenarios'); box.replaceChildren();
  for (const s of list) box.append(el('button', { class: 'scn', type: 'button', onclick: async () => { const v = await api('/api/runs', { method: 'POST', body: JSON.stringify({ scenario: s.id }) }); selected = v.run.id; await refresh(); } }, el('strong', {}, s.title), el('span', {}, s.description)));
}

function approvalCard(a) {
  const err = el('div', { class: 'err', role: 'alert' });
  const note = el('input', { placeholder: 'Optional note', maxlength: 200, 'aria-label': 'Note' });
  const decide = async decision => {
    err.textContent = '';
    try {
      const headers = {};
      const t = sessionStorage.getItem('approverToken'); if (t) headers['x-approver-token'] = t;
      await api(`/api/runs/${a.runId}/calls/${a.call.id}/decision`, { method: 'POST', headers, body: JSON.stringify({ by: $('approver').value.trim(), decision, hash: a.call.hash, note: note.value }) });
      selected = a.runId; await refresh();
    } catch (e) {
      if (e.status === 401) { const t = prompt('Approver token'); if (t) { sessionStorage.setItem('approverToken', t); return decide(decision); } }
      err.textContent = e.message;
    }
  };
  const mins = Math.max(0, Math.round((Date.parse(a.call.expiresAt) - Date.now()) / 60000));
  return el('div', { class: 'appr' },
    el('h3', {}, `${a.call.tool} · requested by ${a.actor}`),
    el('div', { class: 'hint' }, a.call.reason, ` Expires in about ${mins} min.`),
    el('pre', {}, showArgs(a.call.tool, a.call.args)),
    el('div', { class: 'hint mono' }, `call hash ${a.call.hash.slice(0, 16)}… (your approval is bound to exactly this call)`),
    note,
    el('div', { class: 'btns' }, el('button', { class: 'ok', type: 'button', onclick: () => decide('approve') }, 'Approve'), el('button', { class: 'no', type: 'button', onclick: () => decide('reject') }, 'Reject')),
    err);
}

async function loadQueue() {
  const list = await api('/api/approvals');
  $('appr-count').textContent = list.length;
  const q = $('queue'); q.replaceChildren();
  if (!list.length) q.append(el('p', { class: 'empty' }, 'Nothing is waiting. Start a scenario that needs approval, such as the support refund.'));
  for (const a of list) q.append(approvalCard(a));
}

async function loadRuns() {
  const runs = await api('/api/runs');
  const box = $('runs'); box.replaceChildren();
  if (!runs.length) box.append(el('p', { class: 'empty' }, 'No runs yet.'));
  for (const r of runs) box.append(el('button', { class: 'runbtn', type: 'button', 'aria-pressed': String(r.id === selected), onclick: () => { selected = r.id; refresh(); } }, `${r.planner} · ${r.id.slice(-4)} · ${r.status}`));
  if (selected) await loadDetail(selected); else $('run-detail').replaceChildren(el('p', { class: 'empty' }, 'Select a run.'));
}

async function loadDetail(id) {
  const v = await api(`/api/runs/${id}`);
  const out = $('run-detail'); out.replaceChildren();
  out.append(el('div', { class: 'kv' },
    el('div', {}, 'Status ', badge(v.state.status), v.state.abortReason ? ` (${v.state.abortReason})` : ''),
    el('div', {}, 'Log integrity ', badge(v.integrity.valid ? 'valid' : 'invalid'), ` ${v.integrity.records} records, head `, el('code', {}, (v.integrity.head || '').slice(0, 12)))));
  const ol = el('ol', { class: 'timeline' });
  for (const c of v.state.calls) {
    const outcome = c.outcome ? (c.outcome.result || c.outcome.error || c.outcome.status) : '';
    ol.append(el('li', {},
      el('div', { class: 'head' }, el('strong', {}, `${c.id} ${c.tool}`), el('span', {}, badge(c.decision.effect), ' ', badge(c.state))),
      el('div', { class: 'hint' }, c.decision.reason, c.approval && c.approval.by ? ` Approved by ${c.approval.by}.` : (c.outcome && c.outcome.by ? ` Rejected by ${c.outcome.by}.` : '')),
      el('pre', {}, showArgs(c.tool, c.args)),
      outcome ? el('pre', {}, `result: ${outcome}`) : null));
  }
  out.append(ol);
  const ev = el('div', { class: 'events mono' });
  for (const e of v.events) ev.append(el('div', {}, `#${e.seq} ${e.type} ${e.hash.slice(0, 10)} ← ${e.prev.slice(0, 10)}`));
  out.append(el('details', {}, el('summary', {}, `Raw hash-chained event log (${v.events.length})`), ev));
}

async function loadWorld() {
  const w = await api('/api/world');
  const box = $('world'); box.replaceChildren();
  const part = (title, items, fmt) => { box.append(el('h3', { class: 'hint' }, title)); box.append(items.length ? el('ul', {}, items.map(i => el('li', {}, fmt(i)))) : el('p', { class: 'empty' }, 'none')); };
  part('Emails sent', w.outbox, m => `to ${m.to.join(', ')}: ${m.subject}`);
  part('Refunds issued', w.ledger, r => `${r.payment_id} ${money(r.amount)}`);
  part('Commands run', w.commands, c => c.command || JSON.stringify(c));
}

async function loadPolicy() {
  const p = await api('/api/policy');
  $('pol-hash').textContent = p.hash;
  const sel = $('tool'); if (!sel.options.length) for (const t of Object.keys(p.tools)) sel.append(el('option', { value: t }, t));
  const box = $('policy'); box.replaceChildren();
  const rows = p.policy.rules.map(r => el('tr', {}, el('td', {}, el('code', {}, r.id)), el('td', {}, [].concat(r.tool).join(', ')), el('td', {}, badge(r.effect)), el('td', {}, r.reason)));
  box.append(el('div', { class: 'scroll' }, el('table', {}, el('thead', {}, el('tr', {}, ...['Rule', 'Tool', 'Effect', 'Why'].map(h => el('th', {}, h)))), el('tbody', {}, rows))));
  box.append(el('p', { class: 'hint' }, `Limits: ${Object.entries(p.policy.limits).map(([k, v]) => `${k}=${v}`).join(', ')}`));
}

$('check').addEventListener('submit', async ev => {
  ev.preventDefault();
  const out = $('check-out'); out.replaceChildren();
  let args; try { args = JSON.parse($('args').value || '{}'); } catch { out.append(el('p', { class: 'err' }, 'Arguments are not valid JSON.')); return; }
  const r = await api('/api/policy/check', { method: 'POST', body: JSON.stringify({ tool: $('tool').value, args }) });
  out.append(el('div', {}, badge(r.effect), ` stage: ${r.stage}. `, r.reason));
  if (r.canonical) out.append(el('pre', {}, `what would actually run:\n${JSON.stringify(r.canonical, null, 2)}`));
});
$('reset').addEventListener('click', async () => { await api('/api/world/reset', { method: 'POST', body: '{}' }); await refresh(); });
$('args').value = JSON.stringify({ path: 'workspace/%2e%2e/secrets/.env' }, null, 2);

async function refresh() { await Promise.all([loadQueue(), loadRuns(), loadWorld()]); }
await loadMeta(); await loadScenarios(); await loadPolicy(); await refresh();
setInterval(() => { if (document.activeElement && document.activeElement.closest('#queue')) return; refresh().catch(() => {}); }, 5000);
