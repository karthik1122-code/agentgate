import { renderTrain } from '/train.js';
const $ = id => document.getElementById(id);
// All text goes in through textContent / text nodes. Tool arguments are attacker-influenced, so nothing is ever parsed as HTML.
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) { if (k === 'class') n.className = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else if (v === true) n.setAttribute(k, ''); else if (v !== false && v !== undefined && v !== null) n.setAttribute(k, v); }
  for (const k of kids.flat(Infinity)) if (k !== null && k !== undefined && k !== false) n.append(k.nodeType ? k : document.createTextNode(String(k)));
  return n;
};
const live = nodes => nodes.flat(Infinity).filter(n => n !== null && n !== undefined && n !== false);
const show = (...nodes) => $('view').replaceChildren(...live(nodes));
const NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  overview: 'M3 3h7v9H3z M14 3h7v5h-7z M14 12h7v9h-7z M3 16h7v5H3z', approvals: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z M9 12l2 2 4-4', runs: 'M3 12h4l3-8 4 16 3-8h4',
  sandbox: 'M6 4l14 8-14 8z', policy: 'M6 3h9l4 4v14H6z M14 3v5h5 M9 13h6 M9 17h6', team: 'M16 20v-2a4 4 0 00-4-4H7a4 4 0 00-4 4v2 M9.5 10a3.5 3.5 0 100-7 3.5 3.5 0 000 7 M21 20v-2a4 4 0 00-3-3.9 M16 3.1a3.5 3.5 0 010 6.8',
  search: 'M11 19a8 8 0 100-16 8 8 0 000 16 M21 21l-4.3-4.3', moon: 'M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z', sun: 'M12 17a5 5 0 100-10 5 5 0 000 10 M12 1v2 M12 21v2 M4.2 4.2l1.4 1.4 M18.4 18.4l1.4 1.4 M1 12h2 M21 12h2 M4.2 19.8l1.4-1.4 M18.4 5.6l1.4-1.4',
  check: 'M5 13l4 4L19 7', x: 'M6 6l12 12 M18 6L6 18', copy: 'M9 9h11v11H9z M5 15V5h10', logout: 'M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4 M16 17l5-5-5-5 M21 12H9', info: 'M12 21a9 9 0 100-18 9 9 0 000 18 M12 11v5 M12 8h.01',
  chain: 'M10 13a5 5 0 007 0l3-3a5 5 0 00-7-7l-1 1 M14 11a5 5 0 00-7 0l-3 3a5 5 0 007 7l1-1', inbox: 'M22 12h-6l-2 3h-4l-2-3H2 M5.5 5h13l3.5 7v6a2 2 0 01-2 2H4a2 2 0 01-2-2v-6z', bolt: 'M13 2L4 14h7l-1 8 9-12h-7z'
};
const icon = name => { const s = document.createElementNS(NS, 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', 'ic'); s.setAttribute('aria-hidden', 'true'); for (const d of ICONS[name].split(' M')) { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', (d.startsWith('M') ? '' : 'M') + d); s.append(p); } return s; };
const toast = (msg, bad) => { const t = el('div', { class: `toast${bad ? ' bad' : ''}` }, icon(bad ? 'x' : 'check'), msg); $('toast').append(t); setTimeout(() => t.remove(), 3600); };
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
const ago = iso => { const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000)); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`; };
const copy = async (text, what = 'Copied') => { try { await navigator.clipboard.writeText(text); toast(what); } catch { toast('Copy is blocked in this browser', true); } };
const setTheme = t => { document.documentElement.dataset.theme = t; try { localStorage.setItem('ag-theme', t); } catch { /* ignore */ } };
const isLight = () => document.documentElement.dataset.theme === 'light';

let me = null, health = null, view = 'overview', selectedRun = null, selectedApproval = null, pending = [], timer = null, tick = null, deskActions = null, lastLoad = Date.now();

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
  box.append(el('div', { class: 'authcard' }, el('div', { class: 'brand' }, el('span', { class: 'mark' }), el('span', { class: 'word' }, 'AgentGate')),
    el('h1', {}, setup ? 'Set up AgentGate' : 'Sign in to AgentGate'),
    el('p', { class: 'sub' }, setup ? 'Create the first administrator. They can add approvers and viewers afterwards.' : 'Approvals are tied to your account and recorded in the audit log.'), form));
  setTimeout(() => $(setup ? 'name' : 'email').focus(), 0);
}

function offlineScreen() {
  $('app').hidden = true; const box = $('auth'); box.hidden = false; box.replaceChildren(el('div', { class: 'authcard' }, el('div', { class: 'brand' }, el('span', { class: 'mark' }), el('span', { class: 'word' }, 'AgentGate')),
    el('h1', {}, 'Can’t reach the server'), el('p', { class: 'sub' }, 'The dashboard needs its backend, and it did not answer. If it runs on a free host it may be waking up, which can take a minute.'),
    el('div', { class: 'actions' }, el('button', { class: 'btn primary', type: 'button', onclick: () => location.reload() }, 'Try again'), el('a', { class: 'btn', href: '/' }, 'Back to the site'))));
}

/* ---------- shell ---------- */
const NAV = [['overview', 'Overview'], ['approvals', 'Approvals'], ['runs', 'Runs'], ['sandbox', 'Simulator'], ['policy', 'Policy'], ['team', 'Team', 'admin']];
function shell() {
  $('auth').hidden = true; $('auth').replaceChildren(); $('app').hidden = false;
  const nav = $('nav'); nav.replaceChildren();
  const GROUP = { overview: 'Workspace', sandbox: 'Tools', team: 'Admin' };
  for (const [id, label, role] of NAV) {
    if (role && !can(role)) continue;
    if (GROUP[id]) nav.append(el('span', { class: 'grp' }, GROUP[id]));
    nav.append(el('a', { href: `#${id}`, 'aria-current': view === id ? 'page' : false }, icon(id), label, id === 'approvals' && pending.length ? el('span', { class: 'pill' }, pending.length) : null));
  }
  const sp = $('openpal'); if (!sp.firstChild) sp.append(icon('search'), el('span', {}, 'Search or jump to'), el('kbd', {}, '⌘K'));
  const crumb = NAV.find(n => n[0] === view)[1];
  $('topbar').replaceChildren(
    el('div', { class: 'crumb' }, el('a', { href: '#overview' }, 'AgentGate'), el('span', { class: 'sep' }, '/'), el('b', {}, crumb)),
    el('div', { class: 'tright' },
      el('span', { class: 'chip' }, el('span', { class: 'live' }, 'Live'), el('span', { id: 'upd' }, 'just now')),
      el('button', { class: 'btn ghost sm', type: 'button', 'aria-label': isLight() ? 'Switch to dark theme' : 'Switch to light theme', title: 'Theme', onclick: () => { setTheme(isLight() ? 'dark' : 'light'); shell(); } }, icon(isLight() ? 'moon' : 'sun'))));
  $('status').replaceChildren(
    el('div', { class: 'sl' },
      health ? el('span', {}, 'policy ', el('b', {}, health.policyHash.slice(0, 8))) : null,
      health ? el('span', {}, 'store ', el('b', {}, String(health.store).split(' ')[0])) : null,
      el('span', {}, 'mode ', el('b', {}, me.authEnabled ? 'accounts' : 'demo')),
      el('span', {}, pending.length ? `${pending.length} awaiting approval` : 'nothing waiting')),
    el('div', { class: 'sr' }, el('span', {}, el('kbd', {}, '⌘K'), ' commands'), view === 'approvals' ? el('span', {}, el('kbd', {}, 'A'), ' approve ', el('kbd', {}, 'R'), ' reject ', el('kbd', {}, 'J'), el('kbd', {}, 'K'), ' move') : null));
  const initials = me.user.name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  $('who').replaceChildren(...live([
    el('span', { class: 'avatar' }, initials), el('div', { class: 't' }, el('b', {}, me.user.name), el('span', {}, me.authEnabled ? me.user.role : 'demo mode')),
    me.authEnabled ? el('button', { class: 'btn ghost sm', type: 'button', 'aria-label': 'Sign out', title: 'Sign out', onclick: signOut }, icon('logout')) : null]));
}
async function signOut() { await api('/api/auth/logout', { method: 'POST', body: {} }); me = null; await boot(); }
const head = (title, sub, ...right) => el('div', { class: 'head' }, el('div', {}, el('h1', {}, title), sub ? el('p', {}, sub) : null), el('div', { class: 'actions' }, right));
const demoBanner = () => (me.authEnabled ? null : el('div', { class: 'banner', role: 'note' }, icon('info'), 'Demo mode: there are no accounts, so anyone who can open this page can approve. Run with AUTH on (the default) for real sign-in.'));
const skeleton = () => show(el('div', { class: 'head' }, el('div', { class: 'skel sk-line' })), el('div', { class: 'kpis' }, [1, 2, 3, 4].map(() => el('div', { class: 'skel sk-card' }))), el('div', { class: 'skel sk-card' }));
const emptyState = (ic, title, text, ...actions) => el('div', { class: 'card empty' }, el('span', { class: 'glyph' }, icon(ic)), el('h3', {}, title), el('p', {}, text), actions.length ? el('div', { class: 'actions' }, actions) : null);

/* ---------- overview ---------- */
const EFFECT_WORD = { allow: 'allowed', approve: 'held for approval', deny: 'denied' };
function describe(e, tool) {
  const d = e.data || {}; const t = d.tool || tool || 'a call';
  switch (e.type) {
    case 'run_started': return ['i', `Run started: ${d.planner}`];
    case 'policy_decision': return [d.effect === 'allow' ? 'a' : d.effect === 'approve' ? 'h' : 'd', `${t} ${EFFECT_WORD[d.effect] || d.effect}. ${d.reason || ''}`];
    case 'approval_granted': return ['a', `${t} approved by ${d.by}`];
    case 'approval_rejected': return ['d', `${t} rejected by ${d.by}`];
    case 'approval_expired': return ['h', `${t} approval expired`];
    case 'call_executed': return ['a', `${t} ran once`];
    case 'call_denied': return ['d', `${t} blocked: ${d.reason || ''}`];
    case 'run_completed': return ['i', 'Run completed'];
    case 'run_aborted': return ['d', `Run aborted (${d.reason})`];
    default: return null;
  }
}
async function loadStats() {
  const s = await api('/api/stats');
  s.feed = s.feed.map(e => { const x = describe(e, e.data.tool); return x ? { at: e.at, kind: x[0], text: x[1], run: e.run } : null; }).filter(Boolean).slice(0, 9);
  return s;
}
async function viewOverview() {
  const s = await loadStats();
  const kpi = (cls, ic, label, value, hint, href) => el(href ? 'a' : 'div', { class: `kpi ${cls}`, href }, el('div', { class: 'l' }, icon(ic), label), el('div', { class: 'v' }, value), el('div', { class: 'h' }, hint));
  const total = Math.max(1, s.allow + s.approve + s.deny); const pct = n => `${Math.round((n / total) * 100)}%`;
  const mix = (a, h, d) => { const t = Math.max(1, a + h + d); const bar = el('div', { class: 'mix', role: 'img', 'aria-label': `${a} allowed, ${h} held, ${d} denied` }, el('i', { class: 'a' }), el('i', { class: 'h' }), el('i', { class: 'd' })); const [ia, ih, id] = bar.children; ia.style.width = `${(a / t) * 100}%`; ih.style.width = `${(h / t) * 100}%`; id.style.width = `${(d / t) * 100}%`; if (!a) ia.hidden = true; if (!h) ih.hidden = true; if (!d) id.hidden = true; return bar; };
  const tools = Object.entries(s.tools).sort((a, b) => (b[1].allow + b[1].approve + b[1].deny) - (a[1].allow + a[1].approve + a[1].deny));
  const scn = scenarios;
  show(head('Overview', 'What your agents tried, what the policy decided, and what is waiting for a person.', can('approver') && scn[0] ? el('button', { class: 'btn primary', type: 'button', onclick: () => startScenario(scn[0].id) }, icon('bolt'), 'Run a demo agent') : null), demoBanner(),
    el('div', { class: 'kpis' },
      kpi(pending.length ? 'hot' : '', 'approvals', 'Waiting for you', pending.length, pending.length ? 'Review them now' : 'Nothing needs a decision', '#approvals'),
      kpi('', 'runs', 'Calls decided', s.calls, `across ${s.runs} run${s.runs === 1 ? '' : 's'}`, '#runs'),
      kpi(s.stopped ? 'bad' : '', 'x', 'Stopped before running', s.stopped, 'denied, rejected or expired'),
      kpi(s.checked && s.valid === s.checked ? 'good' : s.checked ? 'bad' : '', 'chain', 'Log integrity', s.checked ? `${s.valid}/${s.checked}` : '0', s.checked ? 'hash chains re-checked just now' : 'No runs yet')),
    el('div', { class: 'three' },
      el('div', { class: 'stack' },
        el('div', { class: 'card' }, el('h2', {}, 'Decision mix'), el('p', { class: 'cap' }, 'Every proposed call ends up in one of three buckets. Anything unmatched is denied.'),
          mix(s.allow, s.approve, s.deny),
          el('div', { class: 'legend' }, el('span', {}, 'Allowed ', el('b', {}, s.allow), ` · ${pct(s.allow)}`), el('span', { class: 'h' }, 'Held for a human ', el('b', {}, s.approve), ` · ${pct(s.approve)}`), el('span', { class: 'd' }, 'Denied ', el('b', {}, s.deny), ` · ${pct(s.deny)}`)),
          tools.length ? el('div', { class: 'rowbars' }, tools.map(([name, t]) => el('div', { class: 'rb' }, el('code', {}, name), mix(t.allow, t.approve, t.deny), el('span', { class: 'n' }, t.allow + t.approve + t.deny)))) : null),
        pending.length ? el('div', { class: 'card' }, el('h2', {}, 'Needs a decision'), el('p', { class: 'cap' }, 'Held calls, oldest first.'), el('div', { class: 'list' }, pending.slice(0, 4).map(p => el('a', { class: 'item', href: '#approvals', onclick: () => { selectedApproval = key(p); } }, el('div', { class: 'r1' }, el('b', { class: 'mono' }, p.call.tool), el('span', { class: 'exp', 'data-exp': p.call.expiresAt }, '')), el('small', {}, `${p.actor} · ${p.call.reason}`))))) : null),
      el('div', { class: 'card' }, el('h2', {}, 'Recent activity'), el('p', { class: 'cap' }, 'From the hash-chained log.'),
        s.feed.length ? el('ul', { class: 'feed' }, s.feed.map(f => el('li', {}, el('span', { class: `dot ${f.kind}` }), el('p', {}, f.text), el('small', {}, ago(f.at))))) : emptyState('inbox', 'No activity yet', 'Three steps to see AgentGate work: 1. Run a demo agent. 2. Approve or reject the call it holds. 3. Open Runs and check the log.', can('approver') && scn[0] ? el('button', { class: 'btn primary', type: 'button', onclick: () => startScenario(scn[0].id) }, icon('bolt'), 'Run a demo agent') : null))));
  document.querySelectorAll('[data-exp]').forEach(paint);
  if (!viewOverview.seen) { viewOverview.seen = true; document.querySelectorAll('.kpis,.three').forEach(n => n.classList.add('fx')); countUp(); }
}
function countUp() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  document.querySelectorAll('.kpi .v').forEach(n => {
    const end = parseInt(n.textContent, 10); if (!(end > 0) || String(end) !== n.textContent.trim()) return;
    const t0 = performance.now(); const step = now => { const k = Math.min(1, (now - t0) / 700); n.textContent = String(Math.round(end * (1 - Math.pow(1 - k, 3)))); if (k < 1) requestAnimationFrame(step); }; requestAnimationFrame(step);
  });
}

/* ---------- approvals ---------- */
const key = p => `${p.runId}/${p.call.id}`;
async function viewApprovals() {
  const list = el('div', { class: 'list' }); const detail = el('div');
  show(head('Approvals', 'Calls the policy held for a person. Your decision applies to exactly the call shown, identified by its hash.'), demoBanner(), el('div', { class: 'grid2' }, list, detail));
  if (!pending.length) {
    list.append(emptyState('approvals', 'All clear', 'Held calls appear here the moment an agent proposes them.'));
    detail.append(can('approver') ? emptyState('bolt', 'See it work', 'Run a scripted agent. One of its refunds is too large to run on its own, so it lands here.', el('button', { class: 'btn primary', type: 'button', onclick: () => startScenario('support-refund') }, 'Start the support-refund agent')) : emptyState('info', 'Nothing to review', 'Ask an approver to start a run.'));
    deskActions = null; return;
  }
  if (!pending.some(p => key(p) === selectedApproval)) selectedApproval = key(pending[0]);
  for (const p of pending) list.append(el('button', { class: 'item', type: 'button', 'aria-current': key(p) === selectedApproval, onclick: () => { selectedApproval = key(p); viewApprovals(); } }, el('div', { class: 'r1' }, el('b', { class: 'mono' }, p.call.tool), el('span', { class: 'exp', 'data-exp': p.call.expiresAt }, '')), el('small', {}, `${p.actor} · ${p.call.reason}`)));
  detail.append(reviewDesk(pending.find(p => key(p) === selectedApproval)));
  document.querySelectorAll('[data-exp]').forEach(paint);
}
function factsFor(p) {
  const a = p.call.args, out = [];
  if (p.call.tool === 'refund_payment') { out.push(['Amount', money(a.amount), 'big']); out.push(['Payment', a.payment_id, 'sm']); out.push(['Currency', a.currency]); return out; }
  for (const [k, v] of Object.entries(a)) { const s = Array.isArray(v) ? v.join(', ') : String(v); out.push([k, s.length > 90 ? `${s.slice(0, 90)}…` : s, s.length > 16 || /path|command|payment/.test(k) ? 'sm' : '']); }
  return out;
}
function reviewDesk(p) {
  const note = el('input', { id: 'note', class: 'inp grow', placeholder: 'Optional note for the log', maxlength: 200, 'aria-label': 'Note for the log' });
  const by = me.authEnabled ? null : el('div', { class: 'field' }, el('label', { for: 'by' }, 'Approve as'), el('input', { id: 'by', value: 'human:you', maxlength: 40 }));
  const allowed = can('approver');
  const decide = async decision => {
    try { await api(`/api/runs/${p.runId}/calls/${p.call.id}/decision`, { method: 'POST', body: { by: by ? $('by').value.trim() : undefined, decision, hash: p.call.hash, note: note.value } }); toast(decision === 'approve' ? 'Approved. The call ran once.' : 'Rejected. The call did not run.'); selectedRun = p.runId; await refresh(); }
    catch (e) { toast(e.message, true); await refresh(); }
  };
  deskActions = { approve: () => decide('approve'), reject: () => decide('reject') };
  const exp = el('span', { class: 'exp', 'data-exp': p.call.expiresAt }, '');
  return el('div', { class: 'card desk' },
    el('section', { class: 'top' }, el('div', {}, el('h2', {}, p.call.tool), el('p', { class: 'mute' }, `requested by ${p.actor} · ${ago(p.call.requestedAt)}`)), el('div', {}, el('span', { class: 'lab' }, 'Expires in '), exp)),
    el('section', {}, el('div', { class: 'lab mb' }, 'What it will do'), el('div', { class: 'facts' }, factsFor(p).map(([k, v, c]) => el('div', { class: `fact ${c === 'big' ? 'big' : ''}` }, el('div', { class: 'k' }, k), el('div', { class: `vv ${c === 'sm' ? 'sm' : ''}` }, v)))),
      el('details', {}, el('summary', {}, 'Raw call'), el('pre', { class: 'args' }, pretty(p.call.tool, p.call.args)))),
    el('section', { class: 'why' }, el('div', { class: 'chips' }, tag('approve'), ...p.call.rules.map(r => el('span', { class: 'rule' }, r))), el('p', {}, p.call.reason)),
    el('section', {}, el('div', { class: 'lab' }, 'What your approval means'), el('ul', { class: 'ensures mt' },
      el('li', {}, icon('check'), 'It applies to this exact call. The hash below changes if even one character does.'),
      el('li', {}, icon('check'), 'The policy is checked again at the moment it runs, and it runs once.'),
      el('li', {}, icon('check'), me.authEnabled ? 'The log records you as the approver. The requester cannot approve their own call.' : 'Demo mode: the log records the name you type.')),
      el('div', { class: 'hashrow mt' }, el('code', {}, p.call.hash), el('button', { class: 'btn ghost sm', type: 'button', onclick: () => copy(p.call.hash, 'Hash copied') }, icon('copy'), 'Copy'))),
    el('section', {}, by, el('div', { class: 'actions' }, note,
      el('button', { class: 'btn ok', type: 'button', disabled: !allowed, onclick: () => decide('approve') }, 'Approve ', el('kbd', {}, 'A')),
      el('button', { class: 'btn no', type: 'button', disabled: !allowed, onclick: () => decide('reject') }, 'Reject ', el('kbd', {}, 'R'))),
      allowed ? el('p', { class: 'faint mt' }, 'J and K move between held calls.') : el('p', { class: 'mute mt' }, `Your role (${me.user.role}) can read approvals but not decide them.`)));
}
function paint(node) {
  const left = Math.max(0, Math.round((Date.parse(node.dataset.exp) - Date.now()) / 1000));
  node.textContent = left ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : 'expired'; node.classList.toggle('low', left < 120);
}
async function startScenario(id) { try { const v = await api('/api/runs', { method: 'POST', body: { scenario: id } }); selectedRun = v.run.id; toast(`Started ${id}`); await refresh(); } catch (e) { toast(e.message, true); } }

/* ---------- runs ---------- */
async function viewRuns() {
  const runs = await api('/api/runs');
  const list = el('div', { class: 'list' }); const detail = el('div');
  show(head('Runs', 'Every run is folded from an append-only, hash-chained log. Nothing here is stored as mutable state.'), el('div', { class: 'grid2' }, list, detail));
  if (!runs.length) { list.append(emptyState('runs', 'No runs yet', 'Start one from the Simulator.', el('a', { class: 'btn primary', href: '#sandbox' }, 'Open the simulator'))); return; }
  if (!selectedRun || !runs.some(r => r.id === selectedRun)) selectedRun = runs[0].id;
  for (const r of runs) list.append(el('button', { class: 'item', type: 'button', 'aria-current': r.id === selectedRun, onclick: () => { selectedRun = r.id; viewRuns(); } }, el('div', { class: 'r1' }, el('b', {}, r.planner), tag(r.status)), el('small', {}, `${r.calls} calls · ${r.denials} denied · ${ago(r.created_at)}`)));
  const v = await api(`/api/runs/${selectedRun}`);
  const chain = renderTrain(v.events, { verdict: v.integrity, animate: 'run' });
  const tl = el('ol', { class: 'tl' });
  for (const c of v.state.calls) {
    const out = c.outcome ? (c.outcome.result || c.outcome.reason || c.outcome.error || c.outcome.status) : '';
    const who = c.approval && c.approval.by ? `Approved by ${c.approval.by}.` : c.outcome && c.outcome.by ? `Rejected by ${c.outcome.by}.` : '';
    tl.append(el('li', { class: `e-${c.state === 'executed' ? 'executed' : c.state === 'denied' ? 'denied' : c.decision.effect}` }, el('h4', {}, el('code', {}, `${c.id} ${c.tool}`), tag(c.decision.effect), tag(c.state)), el('p', {}, c.decision.reason, ' ', who), el('pre', { class: 'args' }, pretty(c.tool, c.args)), out ? el('p', { class: 'mono' }, `result: ${out}`) : null));
  }
  const log = el('div', { class: 'log' }, v.events.map(e => el('div', {}, `#${e.seq} ${e.type} ${e.hash.slice(0, 10)} ← ${e.prev.slice(0, 10)}`)));
  detail.append(el('div', { class: 'card' },
    el('div', { class: 'actions mb' }, tag(v.state.status), v.state.abortReason ? el('span', { class: 'mute' }, `(${v.state.abortReason})`) : null, tag(v.integrity.valid ? 'valid' : 'invalid'), el('span', { class: 'mono mute' }, `${v.integrity.records} records · head ${(v.integrity.head || '').slice(0, 12)}`)),
    el('div', { class: 'lab' }, 'Hash chain'), chain,
    el('div', { class: 'lab mt' }, 'Calls'), tl, el('details', {}, el('summary', {}, `Raw log (${v.events.length})`), log)));
}

/* ---------- simulator ---------- */
async function viewSandbox() {
  const [scn, w, pol] = await Promise.all([api('/api/scenarios'), api('/api/world'), api('/api/policy')]);
  const cards = el('div', { class: 'scns' }, scn.map(s => el('button', { class: 'scn', type: 'button', disabled: !can('approver'), onclick: () => startScenario(s.id) }, el('b', {}, s.title), el('span', {}, s.description), el('span', { class: 'go' }, icon('bolt'), 'Run this agent'))));
  const tool = el('select', { id: 'tool', 'aria-label': 'Tool' }); const args = el('textarea', { id: 'args', rows: 5, spellcheck: false, 'aria-label': 'Arguments as JSON' }, JSON.stringify({ path: 'workspace/%2e%2e/secrets/.env' }, null, 2));
  const out = el('div', { 'aria-live': 'polite', class: 'mt' });
  for (const t of Object.keys(pol.tools)) tool.append(el('option', { value: t }, t)); tool.value = 'read_file';
  const part = (title, items, fmt) => el('div', { class: 'mb' }, el('div', { class: 'lab' }, title), items.length ? el('ul', { class: 'ul0' }, items.map(i => el('li', {}, fmt(i)))) : el('p', { class: 'faint' }, 'none'));
  show(head('Simulator', 'The agents are scripts and the world is simulated: nothing here sends email, moves money or runs a command.', can('admin') ? el('button', { class: 'btn', type: 'button', onclick: async () => { await api('/api/world/reset', { method: 'POST', body: {} }); toast('Simulated world reset'); viewSandbox(); } }, 'Reset world') : null), demoBanner(),
    el('h2', { class: 'mb' }, 'Start a scripted agent'), cards,
    el('div', { class: 'two' },
      el('div', { class: 'card' }, el('h2', {}, 'Dry-run a call'), el('p', { class: 'cap' }, 'See what the policy would do, and the canonical form that would actually run.'),
        el('div', { class: 'field' }, el('label', { for: 'tool' }, 'Tool'), tool), el('div', { class: 'field' }, el('label', { for: 'args' }, 'Arguments (JSON)'), args),
        el('button', { class: 'btn primary', type: 'button', disabled: !can('approver'), onclick: async () => {
          out.replaceChildren(); let a; try { a = JSON.parse(args.value || '{}'); } catch { out.append(el('p', { class: 'err' }, 'Arguments are not valid JSON.')); return; }
          try { const r = await api('/api/policy/check', { method: 'POST', body: { tool: tool.value, args: a } }); out.append(...live([el('p', {}, tag(r.effect), ` ${r.stage === 'validation' ? 'Rejected before policy: ' : ''}${r.reason}`), r.canonical ? el('pre', { class: 'args mt' }, `what would actually run\n${JSON.stringify(r.canonical, null, 2)}`) : null])); } catch (e) { out.append(el('p', { class: 'err' }, e.message)); }
        } }, 'Check'), out),
      el('div', { class: 'card' }, el('h2', {}, 'Simulated world'), el('p', { class: 'cap' }, 'What the agents actually changed. Nothing leaves this box.'), part('Emails sent', w.outbox, m => `to ${m.to.join(', ')}: ${m.subject}`), part('Refunds issued', w.ledger, r => `${r.payment_id} ${money(r.amount)}`), part('Commands run', w.commands, c => String(c)))));
}

/* ---------- policy ---------- */
async function viewPolicy() {
  const p = await api('/api/policy');
  const order = { deny: 0, approve: 1, allow: 2 };
  const rules = [...p.policy.rules].sort((a, b) => order[a.effect] - order[b.effect]);
  show(head('Policy', 'Default is deny. Calls are canonicalised first, then judged, and the same canonical form is what runs.', el('button', { class: 'btn', type: 'button', onclick: () => copy(p.hash, 'Version copied') }, icon('copy'), `Version ${p.hash.slice(0, 8)}`)),
    el('div', { class: 'legendrow' }, 'When several rules match:', tag('deny'), '›', tag('approve'), '›', tag('allow'), 'and when none match, the call is denied.'),
    el('div', { class: 'card tight scroll' }, el('table', {}, el('thead', {}, el('tr', {}, ['Rule', 'Tool', 'Effect', 'Why'].map(h => el('th', {}, h)))), el('tbody', {}, rules.map(r => el('tr', {}, el('td', {}, el('span', { class: 'rule' }, r.id)), el('td', { class: 'mono' }, [].concat(r.tool).join(', ')), el('td', {}, tag(r.effect)), el('td', {}, r.reason)))))),
    el('div', { class: 'chips mt' }, Object.entries(p.policy.limits).map(([k, v]) => el('span', { class: 'rule' }, `${k} = ${v}`))));
}

/* ---------- team ---------- */
async function viewTeam() {
  const users = await api('/api/users');
  const err = el('p', { class: 'err', role: 'alert' });
  const form = el('form', { novalidate: true, class: 'card' }, el('h2', { class: 'mb' }, 'Add a person'),
    ...[['n', 'Name', 'text'], ['e', 'Email', 'email'], ['p', 'Temporary password (10+ characters)', 'password']].map(([id, l, t]) => el('div', { class: 'field' }, el('label', { for: id }, l), el('input', { id, type: t, required: true, autocomplete: 'off' }))),
    el('div', { class: 'field' }, el('label', { for: 'r' }, 'Role'), el('select', { id: 'r' }, el('option', { value: 'viewer' }, 'Viewer: can read'), el('option', { value: 'approver', selected: true }, 'Approver: can decide and run'), el('option', { value: 'admin' }, 'Admin: can also manage people'))),
    err, el('button', { class: 'btn primary', type: 'submit' }, 'Add person'));
  form.addEventListener('submit', async e => { e.preventDefault(); err.textContent = ''; try { await api('/api/users', { method: 'POST', body: { name: $('n').value, email: $('e').value, password: $('p').value, role: $('r').value } }); toast('Person added'); viewTeam(); } catch (x) { err.textContent = x.message; } });
  show(head('Team', 'Who can see, decide and manage. Every approval in the log carries the approver’s email.'),
    el('div', { class: 'three' }, el('div', { class: 'card tight scroll' }, el('table', {}, el('thead', {}, el('tr', {}, ['Name', 'Email', 'Role', ''].map(h => el('th', {}, h)))), el('tbody', {}, users.map(u => el('tr', {}, el('td', {}, u.name), el('td', {}, u.email), el('td', {}, el('span', { class: 'rule' }, u.role)), el('td', {}, u.id === me.user.id ? el('span', { class: 'mute' }, 'you') : el('button', { class: 'btn sm', type: 'button', onclick: async () => { if (!confirm(`Remove ${u.email}? Their sessions end immediately.`)) return; try { await api(`/api/users/${u.id}`, { method: 'DELETE' }); toast('Removed'); viewTeam(); } catch (x) { toast(x.message, true); } } }, 'Remove'))))))), form));
}

/* ---------- command palette ---------- */
let palItems = [], palSel = 0;
function commands() {
  const c = NAV.filter(n => !n[2] || can(n[2])).map(n => ({ label: `Go to ${n[1]}`, ic: n[0], hint: 'Page', run: () => { location.hash = n[0]; } }));
  if (can('approver')) for (const s of scenarios) c.push({ label: `Run: ${s.title}`, ic: 'bolt', hint: 'Agent', run: () => startScenario(s.id) });
  c.push({ label: isLight() ? 'Switch to dark theme' : 'Switch to light theme', ic: isLight() ? 'moon' : 'sun', hint: 'Theme', run: () => { setTheme(isLight() ? 'dark' : 'light'); shell(); } });
  if (health) c.push({ label: 'Copy policy version', ic: 'copy', hint: 'Policy', run: () => copy(health.policyHash, 'Version copied') });
  if (me.authEnabled) c.push({ label: 'Sign out', ic: 'logout', hint: 'Account', run: signOut });
  return c;
}
let scenarios = [];
function palRender() {
  const q = $('pin').value.trim().toLowerCase();
  palItems = commands().filter(c => c.label.toLowerCase().includes(q)); palSel = Math.min(palSel, Math.max(0, palItems.length - 1));
  $('pls').replaceChildren(...(palItems.length ? palItems.map((c, i) => el('li', { role: 'option', 'aria-selected': i === palSel, onclick: () => palRun(i), onmousemove: () => { if (palSel !== i) { palSel = i; palRender(); } } }, icon(c.ic), c.label, el('span', { class: 'hint' }, c.hint))) : [el('li', { class: 'none' }, 'Nothing matches that.')]));
}
function palOpen() { if (!me || !me.user) return; $('pal').classList.add('on'); $('pin').value = ''; palSel = 0; palRender(); $('pin').focus(); }
function palClose() { $('pal').classList.remove('on'); }
function palRun(i) { const c = palItems[i]; if (c) { palClose(); c.run(); } }

/* ---------- routing and refresh ---------- */
const VIEWS = { overview: viewOverview, approvals: viewApprovals, runs: viewRuns, sandbox: viewSandbox, policy: viewPolicy, team: viewTeam };
let firstPaint = true;
async function refresh() {
  if (!me || !me.user) return;
  try { pending = await api('/api/approvals'); } catch { return; }
  shell();
  if (firstPaint) { skeleton(); firstPaint = false; }
  const f = can('admin') || view !== 'team' ? VIEWS[view] : viewOverview;
  await f(); lastLoad = Date.now();
}
function route() { const h = location.hash.slice(1); view = VIEWS[h] ? h : 'overview'; firstPaint = true; document.title = `${NAV.find(n => n[0] === view)[1]} · AgentGate`; deskActions = null; refresh(); }
addEventListener('hashchange', route);
addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('pal').classList.contains('on') ? palClose() : palOpen(); return; }
  if ($('pal').classList.contains('on')) {
    if (e.key === 'Escape') palClose(); else if (e.key === 'ArrowDown') { palSel = Math.min(palItems.length - 1, palSel + 1); palRender(); e.preventDefault(); } else if (e.key === 'ArrowUp') { palSel = Math.max(0, palSel - 1); palRender(); e.preventDefault(); } else if (e.key === 'Enter') palRun(palSel);
    return;
  }
  if (view !== 'approvals' || !deskActions || e.metaKey || e.ctrlKey || e.altKey) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;
  const k = e.key.toLowerCase();
  if (k === 'a' && can('approver')) deskActions.approve();
  else if (k === 'r' && can('approver')) deskActions.reject();
  else if ((k === 'j' || k === 'k') && pending.length) { const i = pending.findIndex(p => key(p) === selectedApproval); selectedApproval = key(pending[(i + (k === 'j' ? 1 : -1) + pending.length) % pending.length]); viewApprovals(); }
});
$('pal').addEventListener('mousedown', e => { if (e.target === $('pal')) palClose(); });
$('pin').addEventListener('input', () => { palSel = 0; palRender(); });
$('openpal').addEventListener('click', palOpen);

async function boot() {
  clearInterval(timer); clearInterval(tick);
  me = await api('/api/auth/me').catch(() => null);
  if (!me) return offlineScreen();
  if (!me.user) return authScreen();
  health = await api('/api/health').catch(() => null);
  scenarios = await api('/api/scenarios').catch(() => []);
  route();
  timer = setInterval(() => { const a = document.activeElement; if (a && a.closest && a.closest('#view') && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return; refresh(); }, 5000);
  tick = setInterval(() => { document.querySelectorAll('[data-exp]').forEach(paint); const u = $('upd'); if (u) { const s = Math.round((Date.now() - lastLoad) / 1000); u.textContent = s < 3 ? 'just now' : `${s}s ago`; } }, 1000);
}
boot();
