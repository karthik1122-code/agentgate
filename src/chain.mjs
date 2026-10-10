import { createHash } from 'node:crypto';

const sha = s => createHash('sha256').update(s).digest('hex');
// Keys are sorted recursively before hashing. Postgres jsonb does not preserve key order, so without this
// a chain that verifies in memory would fail after a round trip through the database.
const canonical = r => JSON.stringify(sortKeys({ run_id: r.run_id, seq: r.seq, type: r.type, data: r.data, at: r.at, prev: r.prev }));

/** Builds the next record in a run's hash chain. `last` is the previous record or null. */
export function nextRecord(runId, last, type, data, at = new Date().toISOString()) {
  const record = { run_id: runId, seq: last ? last.seq + 1 : 1, type, data, at, prev: last ? last.hash : 'GENESIS' };
  record.hash = sha(canonical(record));
  return record;
}

/** Verifies one run's events (oldest first). Detects edits, deletions, reordering and truncation of the middle. */
export function verifyChain(records) {
  let prev = 'GENESIS';
  for (let i = 0; i < records.length; i += 1) {
    const r = records[i];
    if (r.seq !== i + 1) return { valid: false, at: i + 1, reason: 'sequence_gap' };
    if (r.prev !== prev) return { valid: false, at: r.seq, reason: 'chain_link_mismatch' };
    if (sha(canonical(r)) !== r.hash) return { valid: false, at: r.seq, reason: 'record_hash_mismatch' };
    prev = r.hash;
  }
  return { valid: true, records: records.length, head: prev };
}

/** Stable hash of a tool call. Approvals are bound to this, so approving one call can never execute another. */
export const callHash = (tool, args) => sha(JSON.stringify([tool, sortKeys(args)]));
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])]));
  return v;
}
