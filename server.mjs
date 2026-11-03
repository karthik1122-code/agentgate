import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { config } from './src/config.mjs';
import { createRuntime } from './src/runtime.mjs';
import { createMemoryStore } from './src/store.mjs';
import { createPostgresStore } from './src/store-pg.mjs';
import { createAuth, createMemoryAuthStore, createPostgresAuthStore } from './src/auth.mjs';
import { createWorld, DEFAULT_FILES } from './src/tools.mjs';
import { planners } from './src/scenarios.mjs';
import { createPlayground } from './src/play.mjs';
import { createPlayHttp } from './src/play-http.mjs';
import { createHandler } from './src/http/handler.mjs';

// Entry point: load the policy, choose the store, build the runtime and auth, start listening.
// All request logic lives in src/http.
const policy = JSON.parse(readFileSync(new URL('./policies/default.json', import.meta.url), 'utf8'));
const store = config.databaseUrl ? await createPostgresStore({ connectionString: config.databaseUrl }) : createMemoryStore();
let world = createWorld(DEFAULT_FILES); // the simulated world the tools act on; admins can reset it
const runtime = createRuntime({ store, policy, planners, get world() { return world; } });
const auth = createAuth({ db: store._pool ? await createPostgresAuthStore(store._pool) : createMemoryAuthStore() });
const play = createPlayHttp(createPlayground(policy));

const server = createServer(createHandler({
  store, runtime, auth, policy, play, config,
  world: () => world,
  setWorld: next => { world = next; },
}));

setInterval(() => auth.sweep().catch(() => {}), 600_000).unref();
setInterval(() => runtime.expireStale().catch(e => console.error('expireStale failed:', e.message)), 30_000).unref();
server.listen(config.port, () => console.log(`AgentGate ready at http://localhost:${config.port} (${store.kind}, auth: ${config.authOn ? 'accounts' : 'OFF (demo)'})`));
