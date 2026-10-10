const $ = id => document.getElementById(id);
// All text goes in through textContent / text nodes. Tool arguments are attacker-influenced, so nothing is ever parsed as HTML.
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) { if (k === 'class') n.className = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else if (v === true) n.setAttribute(k, ''); else if (v !== false && v !== undefined && v !== null) n.setAttribute(k, v); }
  for (const k of kids.flat(Infinity)) if (k !== null && k !== undefined && k !== false) n.append(k.nodeType ? k : document.createTextNode(String(k)));
  return n;
};
const show = (...nodes) => $('view').replaceChildren(...nodes.flat(Infinity).filter(n => n !== null && n !== undefined && n !== false));
const toast = (msg, bad) => { const t = el('div', { class: `toast${bad ? ' bad' : ''}` }, msg); $('toast').append(t); setTimeout(() => t.remove(), 3500); };
class ApiError extends Error { constructor(m, status, code) { super(m); this.status = status; this.code = code; } }
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, { method, headers: { 'content-type': 'application/json', 'x-ag-csrf': '1' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/auth/login') { me = null; await boot(); }
  if (!res.ok) throw new ApiError(data.message || data.error || `Request failed (${res.status})`, res.status, data.error);
  return data;
}
const RANK = { viewer: 1, approver: 2, admin: 3 };
const can = role => me.user && RANK[me.user.role] >= RANK[role];
const money = n => `₹${(n / 100).toLocaleString('en-IN')}`;
const pretty = (tool, args) => { const a = { ...args }; if (tool === 'refund_payment' && typeof a.amount === 'number') a.amount = `${a.amount}  (${money(a.amount)})`; return JSON.stringify(a, null, 2); };
const tag = s => el('span', { class: `tag t-${s}` }, String(s).replaceAll('_', ' '));
const ago = iso => { const s = Math.round((Date.now() - Date.parse(iso)) / 1000); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`; };

let me = null, health = null, view = 'approvals', selectedRun = null, selectedApproval = null, pending = [], timer = null, tick = null;

/* ---------- sign in / set up ---------- */
function authScreen() {
  $('app').hidden = true; const box = $('auth'); box.hidden = false; box.replaceChildren();
  const setup = me.needsSetup;
  const err = el('p', { class: 'err', role: 'alert' });
  const f = (id, label, type = 'text', extra = {}) => el('div', { class: 'field' }, el('label', { for: id }, label), el('input', { id, type, required: true, autocomplete: type === 'password' ? (setup ? 'new-password' : 'current-password') : id === 'email' ? 'email' : 'off', ...extra }));
  const form = el('form', { novalidate: true },
    setup ? f('name', 'Your name', 'text', { maxlength: 80 }) : null,
    f('email', 'Email', 'email'),
    f('password', setup ? 'Password (10 characters or more)' : 'Password', 'password', setup ? { minlength: 10 } : {}),
    setup && me.setupTokenRequired ? f('setupToken', 'Setup token', 'password') : null,
    err,
    el('button', { class: 'btn primary block', type: 'submit' }, setup ? 'Create administrator' : 'Sign in'));
  form.addEventListener('submit', async e => {
    e.preventDefault(); err.textContent = '';
    const v = id => ($(id) ? $(id).value : undefined);
    try {
      await api(setup ? '/api/auth/setup' : '/api/auth/login', { method: 'POST', body: { name: v('name'), email: v('email'), password: v('password'), setupToken: v('setupToken') } });
      await boot();
    } catch (x) { err.textContent = x.message; }
  });
  box.append(el('div', { class: 'authcard' }, el('span', { class: 'mark' }),
    el('h1', {}, setup ? 'Set up AgentGate' : 'Sign in to AgentGate'),
    el('p', {}, setup ? 'Create the first administrator. They can add approvers and viewers afterwards.' : 'Approvals are tied to your account and recorded in the audit log.'), form));
  setTimeout(() => $(setup ? 'name' : 'email').focus(), 0);
}

/* ---------- shell ---------- */
const NAV = [['approvals', 'Approvals'], ['runs', 'Runs'], ['sandbox', 'Sandbox'], ['policy', 'Policy'], ['team', 'Team', 'admin']];
function shell() {
  $('auth').hidden = true; $('auth').replaceChildren(); $('app').hidden = false;
  const nav = $('nav'); nav.replaceChildren();
  for (const [id, label, role] of NAV) {
    if (role && !can(role)) continue;
    nav.append(el('a', { href: `#${id}`, 'aria-current': view === id ? 'page' : false }, label, id === 'approvals' && pending.length ? el('span', { class: 'pill' }, pending.length) : null));
  }
  const who = $('who'); who.replaceChildren(
    el('div', {}, el('b', {}, me.user.name), el('span', {}, me.authEnabled ? `${me.user.role} · ${me.user.email}` : 'demo mode, no sign-in')),
    me.authEnabled ? el('button', { class: 'btn', type: 'button', onclick: async () => { await api('/api/auth/logout', { method: 'POST', body: {} }); me = null; await boot(); } }, 'Sign out') : null);
}
const head = (title, sub, ...right) => el('div', { class: 'head' }, el('div', {}, el('h1', {}, title), sub ? el('p', {}, sub) : null), el('div', {}, right));
const demoBanner = () => (me.authEnabled ? null : el('div', { class: 'banner', role: 'note' }, 'Demo mode: there are no accounts, so anyone who can open this page can approve. Run with AUTH on (the default) for real sign-in.'));

/* ---------- approvals ---------- */
async function viewApprovals() {
  const main = $('view');
  const list = el('div', { class: 'list' }); const detail = el('div');
  show(head('Approvals', 'Calls the policy held for a person. Your decision applies to exactly the call shown, identified by its hash.'), demoBanner(), el('div', { class: 'grid2' }, list, detail));
  if (!pending.length) {
    list.append(el('div', { class: 'card empty' }, el('h3', {}, 'Nothing is waiting'), el('p', {}, 'Held calls appear here the moment an agent proposes them.')));
    detail.append(can('approver') ? el('div', { class: 'card empty' }, el('h3', {}, 'Try it'), el('p', {}, 'Run a scripted agent that triggers an approval.'), el('button', { class: 'btn primary', type: 'button', onclick: () => startScenario('support-refund') }, 'Start the support-refund agent')) : el('div', { class: 'card empty' }, el('p', {}, 'Ask an approver to start a run.')));
    return;
  }
  if (!pending.some(p => key(p) === selectedApproval)) selectedApproval = key(pending[0]);
  for (const p of pending) list.append(el('button', { class: 'item', type: 'button', 'aria-current': key(p) === selectedApproval, onclick: () => { selectedApproval = key(p); viewApprovals(); } }, el('b', {}, p.call.tool), el('small', {}, `${p.actor} · ${p.call.reason}`)));
  detail.append(reviewDesk(pending.find(p => key(p) === selectedApproval)));
}
const key = p => `${p.runId}/${p.call.id}`;
function reviewDesk(p) {
  const note = el('input', { id: 'note', class: 'inp', placeholder: 'Optional note for the log', maxlength: 200, 'aria-label': 'Note' });
  const by = me.authEnabled ? null : el('div', { class: 'field' }, el('label', { for: 'by' }, 'Approve as'), el('input', { id: 'by', value: 'human:you', maxlength: 40 }));
  const allowed = can('approver');
  const countdown = el('span', { class: 'time', id: 'cd' });
  const decide = async decision => {
    try { await api(`/api/runs/${p.runId}/calls/${p.call.id}/decision`, { method: 'POST', body: { by: by ? $('by').value.trim() : undefined, decision, hash: p.call.hash, note: note.value } }); toast(decision === 'approve' ? 'Approved. The call ran once.' : 'Rejected. The call did not run.'); selectedRun = p.runId; await refresh(); }
    catch (e) { toast(e.message, true); await refresh(); }
  };
  deskActions = { approve: () => decide('approve'), reject: () => decide('reject') };
  setCountdown(countdown, p.call.expiresAt);
  return el('div', { class: 'card' },
    el('div', { class: 'head mb6' }, el('div', {}, el('h2', {}, p.call.tool), el('p', { class: 'mono mute mt2' }, `requested by ${p.actor}`)), el('div', {}, 'Expires in ', countdown)),
    el('div', { class: 'why' }, tag('approve'), ...p.call.rules.map(r => el('code', {}, r))),
    el('p', {}, p.call.reason),
    el('pre', { class: 'args' }, pretty(p.call.tool, p.call.args)),
    el('dl', { class: 'kv' }, el('dt', {}, 'Call hash'), el('dd', { class: 'mono' }, p.call.hash), el('dt', {}, 'Run'), el('dd', {}, el('a', { href: '#runs', onclick: () => { selectedRun = p.runId; } }, p.runId))),
    by, note,
    el('div', { class: 'actions' },
      el('button', { class: 'btn ok', type: 'button', disabled: !allowed, onclick: () => decide('approve') }, 'Approve ', el('kbd', {}, 'A')),
      el('button', { class: 'btn no', type: 'button', disabled: !allowed, onclick: () => decide('reject') }, 'Reject ', el('kbd', {}, 'R')),
      allowed ? el('span', { class: 'mono mute' }, 'J / K to move') : el('span', { class: 'mute' }, `Your role (${me.user.role}) can read approvals but not decide them.`)));
}
let deskActions = null;
function setCountdown(node, iso) { node.dataset.exp = iso; paint(node); }
function paint(node) { const left = Math.max(0, Math.round((Date.parse(node.dataset.exp) - Date.now()) / 1000)); node.textContent = left ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : 'expired'; node.classList.toggle('low', left < 120); }

async function startScenario(id) { try { const v = await api('/api/runs', { method: 'POST', body: { scenario: id } }); selectedRun = v.run.id; toast(`Started ${id}`); await refresh(); } catch (e) { toast(e.message, true); } }

/* ---------- runs ---------- */
async function viewRuns() {
  const runs = await api('/api/runs');
  const main = $('view'); const list = el('div', { class: 'list' }); const detail = el('div');
  show(head('Runs', 'Every run is folded from an append-only, hash-chained log. Nothing here is stored as mutable state.'), el('div', { class: 'grid2' }, list, detail));
  if (!runs.length) { list.append(el('div', { class: 'card empty' }, el('h3', {}, 'No runs yet'), el('p', {}, 'Start one from the Sandbox.'))); return; }
  if (!selectedRun || !runs.some(r => r.id === selectedRun)) selectedRun = runs[0].id;
  for (const r of runs) list.append(el('button', { class: 'item', type: 'button', 'aria-current': r.id === selectedRun, onclick: () => { selectedRun = r.id; viewRuns(); } }, el('div', {}, el('b', {}, r.planner), ' ', tag(r.status)), el('small', {}, `${r.calls} calls · ${r.denials} denied · ${ago(r.created_at)}`)));
  const v = await api(`/api/runs/${selectedRun}`);
  const tl = el('ol', { class: 'rail-tl' });
  for (const c of v.state.calls) {
    const out = c.outcome ? (c.outcome.result || c.outcome.reason || c.outcome.error || c.outcome.status) : '';
    const who = c.approval && c.approval.by ? `Approved by ${c.approval.by}.` : c.outcome && c.outcome.by ? `Rejected by ${c.outcome.by}.` : '';
    tl.append(el('li', { class: `e-${c.state === 'executed' ? 'executed' : c.decision.effect}` }, el('h4', {}, `${c.id} ${c.tool}`, tag(c.decision.effect), tag(c.state)), el('p', {}, c.decision.reason, ' ', who), el('pre', { class: 'args' }, pretty(c.tool, c.args)), out ? el('p', { class: 'mono' }, `result: ${out}`) : null));
  }
  const log = el('div', { class: 'log' }, v.events.map(e => el('div', {}, `#${e.seq} ${e.type} ${e.hash.slice(0, 10)} ← ${e.prev.slice(0, 10)}`)));
  detail.append(el('div', { class: 'card' },
    el('div', {}, tag(v.state.status), ' ', v.state.abortReason ? `(${v.state.abortReason}) ` : '', 'Log ', tag(v.integrity.valid ? 'valid' : 'invalid'), el('span', { class: 'mono mute' }, ` ${v.integrity.records} records, head ${(v.integrity.head || '').slice(0, 12)}`)),
    tl, el('details', {}, el('summary', {}, `Raw hash-chained log (${v.events.length})`), log)));
}

/* ---------- sandbox ---------- */
async function viewSandbox() {
  const [scn, w] = await Promise.all([api('/api/scenarios'), api('/api/world')]);
  const main = $('view');
  const cards = el('div', { class: 'scns' }, scn.map(s => el('button', { class: 'scn', type: 'button', disabled: !can('approver'), onclick: () => startScenario(s.id) }, el('b', {}, s.title), el('span', {}, s.description))));
  const tool = el('select', { id: 'tool', 'aria-label': 'Tool' }); const args = el('textarea', { id: 'args', rows: 5, spellcheck: false, 'aria-label': 'Arguments as JSON' }, JSON.stringify({ path: 'workspace/%2e%2e/secrets/.env' }, null, 2));
  const out = el('div', { 'aria-live': 'polite' });
  const pol = await api('/api/policy'); for (const t of Object.keys(pol.tools)) tool.append(el('option', { value: t }, t)); tool.value = 'read_file';
  const part = (title, items, fmt) => el('div', {}, el('h3', { class: 'h15' }, title), items.length ? el('ul', { class: 'ul0' }, items.map(i => el('li', {}, fmt(i)))) : el('p', { class: 'mute m0' }, 'none'));
  show(head('Sandbox', 'The agents are scripts and the world is simulated: nothing here sends email, moves money or runs a command.', can('admin') ? el('button', { class: 'btn', type: 'button', onclick: async () => { await api('/api/world/reset', { method: 'POST', body: {} }); toast('Simulated world reset'); viewSandbox(); } }, 'Reset world') : null), demoBanner(),
    el('h2', { class: 'h18 mb10' }, 'Start a scripted agent'), cards,
    el('div', { class: 'two mt24' },
      el('div', { class: 'card' }, el('h2', { class: 'h18' }, 'Dry-run a call'), el('p', { class: 'mute sub' }, 'See what the policy would do, and the canonical form that would actually run.'),
        el('div', { class: 'field' }, el('label', { for: 'tool' }, 'Tool'), tool), el('div', { class: 'field' }, el('label', { for: 'args' }, 'Arguments (JSON)'), args),
        el('button', { class: 'btn primary', type: 'button', disabled: !can('approver'), onclick: async () => {
          out.replaceChildren(); let a; try { a = JSON.parse(args.value || '{}'); } catch { out.append(el('p', { class: 'err' }, 'Arguments are not valid JSON.')); return; }
          try { const r = await api('/api/policy/check', { method: 'POST', body: { tool: tool.value, args: a } }); out.append(el('p', {}, tag(r.effect), ` ${r.stage === 'validation' ? 'Rejected before policy: ' : ''}${r.reason}`), r.canonical ? el('pre', { class: 'args' }, `what would actually run\n${JSON.stringify(r.canonical, null, 2)}`) : null); } catch (e) { out.append(el('p', { class: 'err' }, e.message)); }
        } }, 'Check'), out),
      el('div', { class: 'card' }, el('h2', { class: 'h18' }, 'Simulated world'), part('Emails sent', w.outbox, m => `to ${m.to.join(', ')}: ${m.subject}`), part('Refunds issued', w.ledger, r => `${r.payment_id} ${money(r.amount)}`), part('Commands run', w.commands, c => String(c)))));
}

/* ---------- policy ---------- */
async function viewPolicy() {
  const p = await api('/api/policy');
  show(head('Policy', `Default is deny. Calls are canonicalised first, then judged, and the same canonical form is what runs. Version ${p.hash}.`),
    el('div', { class: 'card scroll' }, el('table', {}, el('thead', {}, el('tr', {}, ['Rule', 'Tool', 'Effect', 'Why'].map(h => el('th', {}, h)))), el('tbody', {}, p.policy.rules.map(r => el('tr', {}, el('td', {}, el('code', {}, r.id)), el('td', {}, [].concat(r.tool).join(', ')), el('td', {}, tag(r.effect)), el('td', {}, r.reason)))))),
    el('p', { class: 'mono mute mt14' }, `Limits: ${Object.entries(p.policy.limits).map(([k, v]) => `${k}=${v}`).join(', ')}`));
}

/* ---------- team ---------- */
async function viewTeam() {
  const users = await api('/api/users');
  const err = el('p', { class: 'err', role: 'alert' });
  const form = el('form', { novalidate: true, class: 'card' }, el('h2', { class: 'h18 mb12' }, 'Add a person'),
    ...[['n', 'Name', 'text'], ['e', 'Email', 'email'], ['p', 'Temporary password (10+ characters)', 'password']].map(([id, l, t]) => el('div', { class: 'field' }, el('label', { for: id }, l), el('input', { id, type: t, required: true, autocomplete: 'off' }))),
    el('div', { class: 'field' }, el('label', { for: 'r' }, 'Role'), el('select', { id: 'r' }, el('option', { value: 'viewer' }, 'Viewer: can read'), el('option', { value: 'approver', selected: true }, 'Approver: can decide and run'), el('option', { value: 'admin' }, 'Admin: can also manage people'))),
    err, el('button', { class: 'btn primary', type: 'submit' }, 'Add person'));
  form.addEventListener('submit', async e => { e.preventDefault(); err.textContent = ''; try { await api('/api/users', { method: 'POST', body: { name: $('n').value, email: $('e').value, password: $('p').value, role: $('r').value } }); toast('Person added'); viewTeam(); } catch (x) { err.textContent = x.message; } });
  show(head('Team', 'Who can see, decide and manage. Every approval in the log carries the approver’s email.'),
    el('div', { class: 'two' }, el('div', { class: 'card scroll' }, el('table', {}, el('thead', {}, el('tr', {}, ['Name', 'Email', 'Role', ''].map(h => el('th', {}, h)))), el('tbody', {}, users.map(u => el('tr', {}, el('td', {}, u.name), el('td', {}, u.email), el('td', {}, u.role), el('td', {}, u.id === me.user.id ? el('span', { class: 'mute' }, 'you') : el('button', { class: 'btn', type: 'button', onclick: async () => { if (!confirm(`Remove ${u.email}? Their sessions end immediately.`)) return; try { await api(`/api/users/${u.id}`, { method: 'DELETE' }); toast('Removed'); viewTeam(); } catch (x) { toast(x.message, true); } } }, 'Remove'))))))), form));
}

/* ---------- routing and refresh ---------- */
const VIEWS = { approvals: viewApprovals, runs: viewRuns, sandbox: viewSandbox, policy: viewPolicy, team: viewTeam };
async function refresh() {
  if (!me || !me.user) return;
  try { pending = await api('/api/approvals'); } catch { return; }
  shell();
  const f = can('admin') || view !== 'team' ? VIEWS[view] : viewApprovals;
  await f();
}
function route() { const h = location.hash.slice(1); view = VIEWS[h] ? h : 'approvals'; document.title = `${NAV.find(n => n[0] === view)[1]} · AgentGate`; refresh(); }
addEventListener('hashchange', route);
addEventListener('keydown', e => {
  if (view !== 'approvals' || !deskActions || e.metaKey || e.ctrlKey || e.altKey) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;
  const k = e.key.toLowerCase();
  if (k === 'a' && can('approver')) deskActions.approve();
  else if (k === 'r' && can('approver')) deskActions.reject();
  else if ((k === 'j' || k === 'k') && pending.length) { const i = pending.findIndex(p => key(p) === selectedApproval); selectedApproval = key(pending[(i + (k === 'j' ? 1 : -1) + pending.length) % pending.length]); viewApprovals(); }
});

async function boot() {
  clearInterval(timer); clearInterval(tick);
  me = await api('/api/auth/me').catch(() => null);
  if (!me) return toast('Cannot reach the server', true);
  if (!me.user) return authScreen();
  health = await api('/api/health').catch(() => null);
  route();
  timer = setInterval(() => { const a = document.activeElement; if (a && a.closest && a.closest('#view') && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return; refresh(); }, 5000);
  tick = setInterval(() => { const n = $('cd'); if (n) paint(n); }, 1000);
}
boot();
