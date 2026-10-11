# AgentGate

A policy gate and approval runtime for AI agent tool calls. An agent proposes a call. AgentGate canonicalises it, judges it against a JSON policy (default **deny**), asks a human when the policy says so, executes it at most once, and records every step in a hash-chained log.

The agents in this repo are **scripted** (`src/scenarios.mjs`), not language models. The product is the gate. A model-driven planner would implement the same `next({ input, history })` interface; that is not built yet. The world (files, outbox, refund ledger, commands) is simulated: nothing sends email, moves money or runs a shell.

## Run it

```bash
npm install
npm start                 # http://localhost:4200, in-memory store; the first visit creates the administrator
DATABASE_URL=postgres://... npm start   # durable runs, accounts and sessions in Postgres
AUTH=off npm start        # local demo only: no sign-in, anyone can approve
npm test                  # 75 tests (plus the Postgres store tests when TEST_DATABASE_URL is set)
npm run adversarial       # prints the table below
```

## The site

`/` is the landing page and `/app` is the dashboard, both served by `server.mjs` from `public/`. The landing page is not a mock-up. Its live gate, its run viewer and its tamper check call a public, stateless **playground API** that runs the same `prepareCall`, `evaluatePolicy`, `nextRecord` and `verifyChain` code the runtime uses:

| Endpoint | What it does |
|---|---|
| `GET /api/play/meta` | the policy, the tools and the five scripted agents |
| `POST /api/play/check` | judge one call: effect, rules matched, canonical form, call hash |
| `POST /api/play/run` | run a scripted agent through the gate and return its hash-chained log (`approve: true` plays the approver) |
| `POST /api/play/verify` | re-check a chain a visitor edited and say where it first breaks |

It stores nothing and is rate limited per client (`PLAY_RATE_LIMIT`, default 60 a minute). `test/play.test.mjs` checks that its decisions and log events match a real runtime run for every scenario.

## Deploy

The dashboard is stateful (a simulated world in memory, a timer that expires old approvals, Postgres for runs and accounts), so it needs a long-running Node host. The playground is stateless, so it can run anywhere.

1. **Backend on Render**: create a web service from `render.yaml` (named `agentgate-api`). Set `DATABASE_URL` (a Postgres connection string, for example from Neon) and `SETUP_TOKEN`, then open the service once and create the administrator. `TRUST_PROXY=1` is already set so rate limits and login lockout see the real client address.
2. **Site on Vercel**: import the repo. `vercel.json` serves `public/`, runs `api/play/*` as Vercel functions, and rewrites every other `/api/*` request to the Render service. If your Render URL is not `https://agentgate-api-hbbt.onrender.com`, change it in `vercel.json`.

If the backend is asleep or down, the landing page still works, and `/app` shows a "can't reach the server" screen.

## Accounts and roles

Sign-in is on by default. The first visit shows a setup screen that creates the administrator; set `SETUP_TOKEN` before deploying so a stranger who finds the URL first cannot claim that account. The administrator adds people under **Team**.

| Role | Can do |
|---|---|
| viewer | read approvals, runs and policy |
| approver | also start runs, dry-run calls, approve and reject |
| admin | also manage people and reset the sandbox |

The approver recorded in the log is the signed-in user's email. A name sent by the browser is ignored. Passwords are hashed with scrypt, sessions are random tokens stored only as SHA-256 hashes, cookies are `HttpOnly; SameSite=Strict` (and `Secure` over HTTPS), every change needs a custom `x-ag-csrf` header, and repeated failed logins lock that email and address for 15 minutes.

## What it guarantees (and the test for each)

| Property | How |
|---|---|
| The policy judges exactly what runs | Arguments are validated and canonicalised first (paths resolved, URL-decoded, case folded); the canonical form is what is hashed, judged and executed. |
| Default deny | A call no rule matches is denied. |
| Approval is for one specific call | The approver submits the call hash; a different hash is refused (409). |
| Four eyes | The approver cannot be the actor that proposed the call (403). With accounts on, the approver is the signed-in user, so it cannot be spoofed from the browser. |
| Approvals expire | 15 minutes by default; an expired call is never executed. |
| Policy is re-checked at execution | An approved call is judged again before it runs. |
| Effectively once | Execution uses an idempotency key; a retry after a crash does not repeat the side effect. |
| Slicing is caught | Refund rules look at the run's cumulative total, not only the single call. |
| Runaway agents stop | Call cap per run and a denial circuit breaker. |
| Tool output is data | Output from a tool is never interpreted as policy or instructions. |
| Tamper-evident history | Runs are folded from an append-only, hash-chained event log; `verifyChain` checks it. Optimistic concurrency (`expectedSeq`) stops two writers forking a run. |

## Adversarial suite (measured)

56 hand-written cases in `support/adversarial-cases.mjs`: 44 attacks and 12 legitimate calls. Result of `npm run adversarial`:

| Category | Cases | Denied | Held for a human | Executed |
|---|---|---|---|---|
| paths | 13 | 12 | 1 | 0 |
| shell | 8 | 7 | 1 | 0 |
| email | 7 | 3 | 4 | 0 |
| money | 8 | 7 | 1 | 0 |
| tools | 8 | 8 | 0 | 0 |
| **All attacks** | **44** | **37** | **7** | **0** |

Legitimate calls: 12. Allowed: 11. Held for a human by design: 1. **Wrongly denied: 0.** Side effects from attacks: 0. The false-block rate is reported next to the block rate on purpose, since a gate that blocks everything scores perfectly on attacks.

I wrote both the policy and the attacks, so this shows the gate does what the policy says against the cases I thought of. It is not a claim about attacks I did not think of.

## Test strength

I applied 15 deliberate bugs by hand (for example: remove the same-actor check, skip the hash comparison, skip re-checking policy at execution, ignore the cumulative total) and ran `node --test` after each. All 15 made at least one test fail. I did not keep the mutation script, so treat this as a result I observed, not one you can rerun with a command.

## Honest limits

- Secret detection is regex-based. It catches common key and private-key shapes, not arbitrary secrets.
- The ReDoS guard on patterns is a heuristic.
- An email to an internal address can still carry sensitive content; the content check is the same regexes.
- Accounts are email and password only: no email verification, password reset, SSO or two-factor yet. Lost passwords need an administrator to remove and re-add the person.
- Login throttling is in memory, so it resets on restart and is per server instance.
- `AUTH=off` has no identity at all and must never be exposed publicly.
- Scripted planners only. No LLM planner, so nothing here measures prompt-injection resistance of a real model.
- Truncating the newest records of a log is not detectable without an externally stored head hash. The chain detects edits and deletions in the middle.
- The tool set is five simulated tools. Real tools need their own validators.

## Layout

`src/policy.mjs` rules engine · `src/tools.mjs` validation, canonicalisation, simulated tools · `src/runtime.mjs` event-sourced run loop and approvals · `src/chain.mjs` hashing · `src/store.mjs`, `src/store-pg.mjs` storage · `policies/default.json` · `src/auth.mjs` accounts, sessions, roles · `src/play.mjs`, `src/play-http.mjs` public playground · `src/*` + `api/` Vercel functions · `server.mjs` + `public/` landing and dashboard · `EXPLAIN.md` interview prep.
