/**
 * Policy engine. A policy is plain JSON, so it can be reviewed, diffed and versioned.
 *
 *   effect precedence when several rules match:  deny  >  approve  >  allow
 *   when nothing matches: policy.default (deny unless the policy says otherwise)
 *
 * Rules see the CANONICAL arguments (after the tool's own normalisation) plus run context, so a rule can
 * never be satisfied by a spelling the tool would later interpret differently.
 *
 * Context paths:  args.<field>   facts.<field>   run.calls   run.denials   projected.<field>
 * where projected.<field> = total of that numeric field over earlier executed calls of the same tool, plus this call.
 */
export const EFFECTS = ['allow', 'approve', 'deny'];
const OPS = new Set(['eq', 'neq', 'in', 'notIn', 'gt', 'gte', 'lt', 'lte', 'startsWith', 'endsWith', 'contains', 'matches', 'exists']);
const STRENGTH = { allow: 0, approve: 1, deny: 2 };
const MAX_PATTERN = 200;
const MAX_VALUE = 2000;

export function validatePolicy(policy) {
  const errors = [];
  if (!policy || typeof policy !== 'object') return ['policy must be an object'];
  if (policy.version !== 1) errors.push('version must be 1');
  if (policy.default !== undefined && !EFFECTS.includes(policy.default)) errors.push(`default must be one of ${EFFECTS.join(', ')}`);
  if (!Array.isArray(policy.rules)) errors.push('rules must be an array');
  const seen = new Set();
  for (const [i, rule] of (policy.rules || []).entries()) {
    const at = `rules[${i}]${rule?.id ? ` (${rule.id})` : ''}`;
    if (!rule || typeof rule !== 'object') { errors.push(`${at}: must be an object`); continue; }
    if (!rule.id || typeof rule.id !== 'string') errors.push(`${at}: id is required`);
    else if (seen.has(rule.id)) errors.push(`${at}: duplicate id`);
    else seen.add(rule.id);
    if (!EFFECTS.includes(rule.effect)) errors.push(`${at}: effect must be one of ${EFFECTS.join(', ')}`);
    const tools = Array.isArray(rule.tool) ? rule.tool : [rule.tool];
    if (!tools.length || tools.some(t => typeof t !== 'string' || !t)) errors.push(`${at}: tool must be a name, a list of names, or "*"`);
    if (!rule.reason || typeof rule.reason !== 'string') errors.push(`${at}: reason is required (it is shown to humans)`);
    validateWhen(rule.when, at, errors);
  }
  return errors;
}

function validateWhen(when, at, errors) {
  if (when === undefined) return;
  if (!when || typeof when !== 'object' || Array.isArray(when)) { errors.push(`${at}: when must be an object`); return; }
  for (const [key, cond] of Object.entries(when)) {
    if (key === 'anyOf') { if (!Array.isArray(cond) || !cond.length) errors.push(`${at}: anyOf must be a non-empty array`); else cond.forEach(c => validateWhen(c, at, errors)); continue; }
    if (key === 'not') { validateWhen(cond, at, errors); continue; }
    if (!/^(args|run|projected|facts)\.[A-Za-z0-9_.]+$/.test(key)) { errors.push(`${at}: unknown path "${key}"`); continue; }
    if (!cond || typeof cond !== 'object' || Array.isArray(cond)) { errors.push(`${at}: condition for ${key} must be an object of operators`); continue; }
    for (const [op, arg] of Object.entries(cond)) {
      if (!OPS.has(op)) { errors.push(`${at}: unknown operator "${op}" on ${key}`); continue; }
      if (op === 'matches') {
        if (typeof arg !== 'string' || arg.length > MAX_PATTERN) errors.push(`${at}: pattern on ${key} must be a string of at most ${MAX_PATTERN} characters`);
        else if (/\([^)]*[+*][^)]*\)[+*{]/.test(arg)) errors.push(`${at}: pattern on ${key} has a nested quantifier, which can hang the matcher`);
        else { try { new RegExp(arg); } catch { errors.push(`${at}: pattern on ${key} is not a valid regular expression`); } }
      }
      if (['in', 'notIn'].includes(op) && !Array.isArray(arg)) errors.push(`${at}: ${op} on ${key} needs an array`);
    }
  }
}

const get = (obj, path) => path.split('.').reduce((o, k) => (o !== null && typeof o === 'object' && Object.hasOwn(o, k) ? o[k] : undefined), obj);

function testOp(op, actual, arg) {
  switch (op) {
    case 'exists': return (actual !== undefined && actual !== null) === Boolean(arg);
    case 'eq': return actual === arg;
    case 'neq': return actual !== arg;
    case 'in': return arg.includes(actual);
    case 'notIn': return !arg.includes(actual);
    case 'gt': return typeof actual === 'number' && actual > arg;
    case 'gte': return typeof actual === 'number' && actual >= arg;
    case 'lt': return typeof actual === 'number' && actual < arg;
    case 'lte': return typeof actual === 'number' && actual <= arg;
    case 'startsWith': return typeof actual === 'string' && actual.startsWith(arg);
    case 'endsWith': return typeof actual === 'string' && actual.endsWith(arg);
    case 'contains': return typeof actual === 'string' ? actual.includes(arg) : Array.isArray(actual) && actual.includes(arg);
    case 'matches': return typeof actual === 'string' && new RegExp(arg).test(actual.slice(0, MAX_VALUE));
    default: return false;
  }
}

function matchesWhen(when, ctx) {
  if (!when) return true;
  for (const [key, cond] of Object.entries(when)) {
    if (key === 'anyOf') { if (!cond.some(c => matchesWhen(c, ctx))) return false; continue; }
    if (key === 'not') { if (matchesWhen(cond, ctx)) return false; continue; }
    const actual = get(ctx, key);
    for (const [op, arg] of Object.entries(cond)) if (!testOp(op, actual, arg)) return false;
  }
  return true;
}

const toolMatches = (rule, tool) => (Array.isArray(rule.tool) ? rule.tool : [rule.tool]).some(t => t === '*' || t === tool);

/** Returns { effect, rules:[{id,effect,reason}], reason, default:boolean }. */
export function evaluatePolicy(policy, tool, ctx) {
  const matched = policy.rules.filter(r => toolMatches(r, tool) && matchesWhen(r.when, ctx)).map(r => ({ id: r.id, effect: r.effect, reason: r.reason }));
  if (!matched.length) {
    const effect = policy.default || 'deny';
    return { effect, rules: [], reason: `No rule matches ${tool}; default is ${effect}.`, default: true };
  }
  const top = matched.reduce((a, b) => (STRENGTH[b.effect] > STRENGTH[a.effect] ? b : a));
  return { effect: top.effect, rules: matched, reason: top.reason, default: false };
}
