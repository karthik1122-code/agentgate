import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const PORT = 4390 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${PORT}`;

async function up() {
  const child = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(PORT), AUTH: 'off', DATABASE_URL: '' }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${base}/api/scenarios`)).ok) return child; } catch { /* not up yet */ } await new Promise(r => setTimeout(r, 100)); }
  child.kill(); throw new Error('server did not start');
}

test('/api/stats aggregates decisions across runs and keeps the log verifiable', async () => {
  const child = await up();
  try {
    const empty = await (await fetch(`${base}/api/stats`)).json();
    assert.equal(empty.runs, 0); assert.equal(empty.calls, 0); assert.deepEqual(empty.feed, []);

    const scenarios = await (await fetch(`${base}/api/scenarios`)).json();
    for (const s of scenarios.slice(0, 2)) {
      const r = await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ag-csrf': '1' }, body: JSON.stringify({ scenario: s.id }) });
      assert.ok(r.ok, `start ${s.id}`);
    }
    const s = await (await fetch(`${base}/api/stats`)).json();
    assert.equal(s.runs, 2);
    assert.ok(s.calls > 0);
    assert.equal(s.allow + s.approve + s.deny, s.calls, 'every call has exactly one decision');
    assert.equal(s.valid, s.checked, 'every chain verifies');
    assert.ok(s.feed.length > 0 && s.feed.length <= 12);
    for (let i = 1; i < s.feed.length; i++) assert.ok(Date.parse(s.feed[i - 1].at) >= Date.parse(s.feed[i].at), 'feed is newest first');
  } finally { child.kill(); }
});
