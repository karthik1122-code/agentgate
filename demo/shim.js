/* A small synchronous SHA-256 and UUID so the unmodified src/ modules run in a browser. */
const Buffer = { byteLength: s => new TextEncoder().encode(s).length };
const CRYPTO = (() => {
  const K = new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  function sha256(bytes) {
    const l = bytes.length, total = (((l + 9 + 63) >> 6) << 6), buf = new Uint8Array(total);
    buf.set(bytes); buf[l] = 0x80;
    const dv = new DataView(buf.buffer); dv.setUint32(total - 8, Math.floor(l / 0x20000000)); dv.setUint32(total - 4, (l << 3) >>> 0);
    const H = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]), w = new Uint32Array(64);
    for (let o = 0; o < total; o += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
      for (let i = 16; i < 64; i++) { const a = w[i-15], b = w[i-2]; w[i] = (w[i-16] + (rotr(a,7) ^ rotr(a,18) ^ (a >>> 3)) + w[i-7] + (rotr(b,17) ^ rotr(b,19) ^ (b >>> 10))) >>> 0; }
      let [a,b,c,d,e,f,g,h] = H;
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (rotr(e,6) ^ rotr(e,11) ^ rotr(e,25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
        const t2 = ((rotr(a,2) ^ rotr(a,13) ^ rotr(a,22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
    }
    return [...H].map(x => x.toString(16).padStart(8, '0')).join('');
  }
  const enc = new TextEncoder();
  return {
    createHash: () => { let s = ''; const o = { update(x) { s += x; return o; }, digest: () => sha256(enc.encode(s)) }; return o; },
    randomUUID: () => { const b = crypto.getRandomValues(new Uint8Array(16)); b[6] = b[6] & 15 | 64; b[8] = b[8] & 63 | 128; const h = [...b].map(x => x.toString(16).padStart(2, '0')).join(''); return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`; },
  };
})();
/*MODULES*/
/* The server's routes, answered in the page. Same logic as server.mjs with sign-in switched off. */
{
  const { createRuntime, GateError } = M.runtime, { createMemoryStore } = M.store, { createWorld, DEFAULT_FILES, TOOLS, prepareCall, ArgError } = M.tools;
  const { evaluatePolicy } = M.policy, { verifyChain } = M.chain, { SCENARIOS, planners } = M.scenarios;
  const policy = POLICY, store = createMemoryStore();
  let world = createWorld(DEFAULT_FILES);
  const runtime = createRuntime({ store, policy, planners, get world() { return world; } });
  const USER = { id: 'demo', email: 'you@browser', name: 'You', role: 'admin' };
  const summary = state => ({ runId: state.runId, planner: state.planner, actor: state.actor, status: state.status, abortReason: state.abortReason, calls: state.calls.map(c => ({ id: c.id, tool: c.tool, args: c.args, facts: c.facts, hash: c.hash, state: c.state, decision: c.decision, outcome: c.outcome, approval: c.approval })), denials: state.denials });
  async function runView(id) { const v = await runtime.view(id); if (!v.run) return null; return { run: v.run, state: summary(v.state), events: v.events, integrity: verifyChain(v.events) }; }
  const gateStatus = code => ({ not_found: 404, not_pending: 409, already_decided: 409, expired: 410, hash_mismatch: 409, same_actor: 403, invalid_decision: 400, invalid_approver: 400 }[code] || 400);
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  async function route(method, path, body) {
    if (method === 'GET' && path === '/api/health') return json(200, { status: 'ok', store: 'memory (in your browser)', policyHash: runtime.policyHash, auth: 'off (demo)', limits: runtime.limits });
    if (method === 'GET' && path === '/api/auth/me') return json(200, { authEnabled: false, needsSetup: false, setupTokenRequired: false, user: USER });
    if (method === 'GET' && path === '/api/users') return json(200, [{ id: 'demo', email: USER.email, name: USER.name, role: 'admin', created_at: new Date().toISOString() }]);
    if (method === 'GET' && path === '/api/scenarios') return json(200, Object.entries(SCENARIOS).map(([id, s]) => ({ id, title: s.title, description: s.description })));
    if (method === 'GET' && path === '/api/policy') return json(200, { policy, hash: runtime.policyHash, tools: Object.fromEntries(Object.entries(TOOLS).map(([k, t]) => [k, { description: t.description, fields: t.fields }])) });
    if (method === 'GET' && path === '/api/world') return json(200, { outbox: world.outbox, ledger: world.ledger, commands: world.commands, files: [...world.files.keys()] });
    if (method === 'POST' && path === '/api/world/reset') { world = createWorld(DEFAULT_FILES); return json(200, { ok: true }); }
    if (method === 'POST' && path === '/api/policy/check') {
      try {
        const call = prepareCall(body.tool, body.args, { maxArgsBytes: runtime.limits.maxArgsBytes });
        const d = evaluatePolicy(policy, call.tool, { args: call.args, facts: call.facts, run: { calls: 0, denials: 0 }, projected: Object.fromEntries(Object.entries(call.args).filter(([, v]) => typeof v === 'number')) });
        return json(200, { stage: 'policy', effect: d.effect, reason: d.reason, rules: d.rules, default: d.default, canonical: call.args, facts: call.facts });
      } catch (error) { if (error instanceof ArgError) return json(200, { stage: 'validation', effect: 'deny', reason: error.message, rules: [] }); throw error; }
    }
    if (method === 'GET' && path === '/api/runs') {
      const runs = await store.listRuns(50);
      return json(200, await Promise.all(runs.map(async r => { const v = await runtime.view(r.id); return { id: r.id, planner: r.planner, actor: r.actor, status: v.state.status, created_at: r.created_at, calls: v.state.calls.length, denials: v.state.denials }; })));
    }
    if (method === 'POST' && path === '/api/runs') {
      if (!Object.hasOwn(SCENARIOS, body.scenario)) return json(400, { error: 'unknown_scenario' });
      const state = await runtime.startRun({ planner: body.scenario, actor: `agent:${body.scenario}` });
      return json(201, await runView(state.runId));
    }
    if (method === 'GET' && path === '/api/approvals') {
      const pending = [];
      for (const r of await store.listByStatus('waiting_approval')) {
        const v = await runtime.view(r.id);
        for (const c of v.state.calls.filter(x => x.state === 'pending_approval')) pending.push({ runId: r.id, actor: r.actor, planner: r.planner, call: { id: c.id, tool: c.tool, args: c.args, facts: c.facts, hash: c.hash, reason: c.decision.reason, rules: c.decision.rules.map(x => x.id), expiresAt: c.approval.expiresAt, requestedAt: c.approval.requestedAt } });
      }
      return json(200, pending);
    }
    if (method === 'GET' && path === '/api/stats') {
      const runs = await store.listRuns(30);
      const views = (await Promise.all(runs.map(r => runView(r.id)))).filter(Boolean);
      const s = { runs: runs.length, calls: 0, allow: 0, approve: 0, deny: 0, stopped: 0, valid: 0, checked: views.length, tools: {}, feed: [] };
      for (const v of views) {
        if (v.integrity.valid) s.valid += 1;
        const toolOf = new Map(v.state.calls.map(c => [c.id, c.tool]));
        for (const c of v.state.calls) {
          s.calls += 1; const eff = c.decision && c.decision.effect; if (eff) s[eff] += 1;
          const t = (s.tools[c.tool] ||= { allow: 0, approve: 0, deny: 0 }); if (eff) t[eff] += 1;
          if (['denied', 'rejected', 'expired'].includes(c.state)) s.stopped += 1;
        }
        for (const e of v.events) { const d = e.data || {}; s.feed.push({ at: e.at, type: e.type, run: v.state.runId, data: { tool: d.tool || toolOf.get(d.call_id), effect: d.effect, reason: d.reason, by: d.by, planner: d.planner } }); }
      }
      s.feed.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)); s.feed = s.feed.slice(0, 12);
      return json(200, s);
    }
    let m = path.match(/^\/api\/runs\/([\w-]+)$/);
    if (m && method === 'GET') { const v = await runView(m[1]); return v ? json(200, v) : json(404, { error: 'not_found' }); }
    m = path.match(/^\/api\/runs\/([\w-]+)\/calls\/(c\d+)\/decision$/);
    if (m && method === 'POST') {
      await runtime.decide(m[1], m[2], { by: body.by || USER.email, decision: body.decision, hash: body.hash, note: body.note });
      return json(200, await runView(m[1]));
    }
    return json(404, { error: 'not_found' });
  }
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (!url.pathname.startsWith('/api/') && !url.pathname.includes('/api/')) return realFetch(input, init);
    const path = url.pathname.slice(url.pathname.indexOf('/api/'));
    try { return await route((init.method || 'GET').toUpperCase(), path, init.body ? JSON.parse(init.body) : {}); }
    catch (e) { if (e instanceof GateError) return json(gateStatus(e.code), { error: e.code, message: e.message }); console.error(e); return json(500, { error: 'server_error' }); }
  };
}
