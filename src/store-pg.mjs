import { nextRecord } from './chain.mjs';
import { ConflictError } from './store.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id text PRIMARY KEY, planner text NOT NULL, input jsonb NOT NULL, actor text NOT NULL,
  status text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS run_events (
  run_id text NOT NULL REFERENCES runs(id), seq integer NOT NULL, record jsonb NOT NULL,
  PRIMARY KEY (run_id, seq)
);
CREATE INDEX IF NOT EXISTS runs_status_idx ON runs (status);`;

/** Postgres implementation of the store contract. Appends lock the run row, so each run's chain has one writer at a time. */
export async function createPostgresStore({ connectionString, pool: existing } = {}) {
  let pool = existing;
  if (!pool) { const { default: pg } = await import('pg'); pool = new pg.Pool({ connectionString, max: 10 }); }
  await pool.query(SCHEMA);
  const toRun = r => ({ id: r.id, planner: r.planner, input: r.input, actor: r.actor, status: r.status, created_at: new Date(r.created_at).toISOString() });
  return {
    kind: 'postgres',
    async createRun(run) {
      try {
        const { rows } = await pool.query('INSERT INTO runs (id, planner, input, actor, status) VALUES ($1,$2,$3,$4,$5) RETURNING *', [run.id, run.planner, run.input, run.actor, run.status || 'running']);
        return toRun(rows[0]);
      } catch (e) { if (e.code === '23505') throw new ConflictError('run already exists'); throw e; }
    },
    async append(runId, type, data, { expectedSeq, status, at } = {}) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const locked = await client.query('SELECT id FROM runs WHERE id = $1 FOR UPDATE', [runId]);
        if (!locked.rowCount) throw new Error(`unknown run ${runId}`);
        const last = (await client.query('SELECT record FROM run_events WHERE run_id = $1 ORDER BY seq DESC LIMIT 1', [runId])).rows[0]?.record || null;
        if (expectedSeq !== undefined && (last ? last.seq : 0) !== expectedSeq) throw new ConflictError();
        const record = nextRecord(runId, last, type, data, at);
        await client.query('INSERT INTO run_events (run_id, seq, record) VALUES ($1,$2,$3)', [runId, record.seq, record]);
        if (status) await client.query('UPDATE runs SET status = $2 WHERE id = $1', [runId, status]);
        await client.query('COMMIT');
        return record;
      } catch (e) { try { await client.query('ROLLBACK'); } catch { /* connection gone */ } throw e; }
      finally { client.release(); }
    },
    async events(runId) { return (await pool.query('SELECT record FROM run_events WHERE run_id = $1 ORDER BY seq', [runId])).rows.map(r => r.record); },
    async getRun(runId) { const { rows } = await pool.query('SELECT * FROM runs WHERE id = $1', [runId]); return rows[0] ? toRun(rows[0]) : null; },
    async listRuns(limit = 50) { return (await pool.query('SELECT * FROM runs ORDER BY created_at DESC LIMIT $1', [limit])).rows.map(toRun); },
    async listByStatus(status) { return (await pool.query('SELECT * FROM runs WHERE status = $1 ORDER BY created_at', [status])).rows.map(toRun); },
    async close() { await pool.end(); },
    _pool: pool,
  };
}
