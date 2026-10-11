// A run drawn as a train: one car per log record, coupled by the hash of the car before it.
// Shared by the landing page and the dashboard. All text goes in through text nodes; nothing is parsed as HTML.
const mk = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };

export function describeEvent(e, toolOf = new Map()) {
  const d = e.data || {}; const tool = d.tool || toolOf.get(d.call_id) || '';
  switch (e.type) {
    case 'run_started': return { kind: 'info', title: 'Run started', detail: d.planner || '' };
    case 'call_proposed': return { kind: 'info', title: 'Call proposed', detail: tool };
    case 'policy_decision': return { kind: d.effect === 'allow' ? 'allow' : d.effect === 'approve' ? 'hold' : 'deny', title: `Policy: ${d.effect}`, detail: tool };
    case 'approval_requested': return { kind: 'hold', title: 'Held for a person', detail: tool };
    case 'approval_granted': return { kind: 'allow', title: 'Approved', detail: String(d.by || '') };
    case 'approval_rejected': return { kind: 'deny', title: 'Rejected', detail: String(d.by || '') };
    case 'approval_expired': return { kind: 'hold', title: 'Approval expired', detail: tool };
    case 'call_executed': return { kind: 'allow', title: 'Ran once', detail: tool };
    case 'call_denied': return { kind: 'deny', title: 'Blocked', detail: tool };
    case 'call_failed': return { kind: 'deny', title: 'Failed', detail: tool };
    case 'run_completed': return { kind: 'info', title: 'Run complete', detail: '' };
    case 'run_aborted': return { kind: 'deny', title: 'Run stopped', detail: String(d.reason || '').replaceAll('_', ' ') };
    default: return { kind: 'info', title: e.type, detail: '' };
  }
}

export function toolMap(events) {
  const m = new Map();
  for (const e of events) if (e.data && e.data.call_id && e.data.tool) m.set(e.data.call_id, e.data.tool);
  return m;
}

/**
 * verdict: the result of verifyChain ({ valid, at, reason }). When invalid, the car at `at` is marked broken
 * and every later car is marked unverifiable, because each one's hash depends on the one before it.
 */
const bad_ = v => !!v && !v.valid;
export function renderTrain(events, { verdict = null, selected = null, onSelect = null, label = 'Hash chain', animate = '' } = {}) {
  const track = mk('div', 'train'); track.setAttribute('role', 'group'); track.setAttribute('aria-label', `${label}. Each car holds the hash of the car before it.`);
  const tools = toolMap(events);
  if (animate) track.classList.add('go', animate === 'verify' ? 'chk' : 'run');
  if (animate && bad_(verdict)) track.classList.add('bad');
  // Where the chain first fails. For a sequence gap, `at` counts positions, so the broken car is the one at that position.
  const bad = verdict && !verdict.valid;
  const bi = bad ? (verdict.reason === 'sequence_gap' ? verdict.at - 1 : events.findIndex(x => x.seq === verdict.at)) : -1;
  events.forEach((e, i) => {
    const info = describeEvent(e, tools);
    if (i > 0) {
      const link = mk('span', 'coupling'); link.title = `links to ${e.prev}`; link.style.setProperty('--i', i); link.setAttribute('aria-hidden', 'true');
      if (bad && i === bi && verdict.reason !== 'record_hash_mismatch') link.classList.add('cut');
      else if (bad && i > bi) link.classList.add('after');
      track.append(link);
    }
    const car = mk(onSelect ? 'button' : 'div', `car k-${info.kind}`);
    if (onSelect) { car.type = 'button'; car.addEventListener('click', () => onSelect(e, i)); }
    car.style.setProperty('--i', i);
    if (selected === e.seq) car.classList.add('sel');
    if (bad) { if (i === bi) car.classList.add('broken'); else if (i > bi) car.classList.add('after'); }
    const state = verdict ? (!bad ? 'verified' : i < bi ? 'verified' : i === bi ? (verdict.reason === 'record_hash_mismatch' ? 'does not match its hash' : 'breaks the chain') : 'cannot be trusted') : '';
    car.setAttribute('aria-label', `Record ${e.seq}: ${info.title}${info.detail ? `, ${info.detail}` : ''}${state ? `. ${state}` : ''}`);
    car.append(mk('span', 'cs', `#${e.seq}`), mk('b', 'ct', info.title), mk('span', 'cd', info.detail || ' '), mk('code', 'ch', e.hash.slice(0, 8)));
    track.append(car);
  });
  if (bad && bi >= 0) track.style.setProperty('--bi', bi);
  if (animate) track.style.setProperty('--n', events.length);
  return track;
}

