import { nextRecord } from './chain.mjs';

export class ConflictError extends Error { constructor(message = 'run changed since it was read') { super(message); this.code = 'conflict'; } }

/**
 * Store contract (memory and Postgres implement the same one):
 *   createRun(run)                          -> run
 *   append(runId, type, data, opts)         -> record     opts: { expectedSeq, status, at }
 *        Atomically adds the next hash-chained record and, if given, sets the run status.
 *        If expectedSeq is given and the last record's seq differs it throws ConflictError.
 *        This is what stops two approvers, or an approver and the runtime, acting on the same state.
 *   events(runId)                           -> records oldest first
 *   getRun(runId), listRuns(limit), listByStatus(status)
 */
export function createMemoryStore() {
  const runs = new Map();
  const logs = new Map();
  return {
    kind: 'memory',
    async createRun(run) {
      if (runs.has(run.id)) throw new ConflictError('run already exists');
      const stored = { status: 'running', created_at: new Date().toISOString(), ...run };
      runs.set(run.id, stored); logs.set(run.id, []);
      return { ...stored };
    },
    async append(runId, type, data, { expectedSeq, status, at } = {}) {
      const run = runs.get(runId); if (!run) throw new Error(`unknown run ${runId}`);
      const log = logs.get(runId); const last = log.at(-1) || null;
      if (expectedSeq !== undefined && (last ? last.seq : 0) !== expectedSeq) throw new ConflictError();
      const record = nextRecord(runId, last, type, data, at);
      log.push(record);
      if (status) run.status = status;
      return structuredClone(record);
    },
    async events(runId) { return structuredClone(logs.get(runId) || []); },
    async getRun(runId) { const r = runs.get(runId); return r ? { ...r } : null; },
    async listRuns(limit = 50) { return [...runs.values()].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit).map(r => ({ ...r })); },
    async listByStatus(status) { return [...runs.values()].filter(r => r.status === status).map(r => ({ ...r })); },
    /** Test helper: lets a test tamper with stored history to prove verification catches it. */
    _logs: logs,
  };
}
