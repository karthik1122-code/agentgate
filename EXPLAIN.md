# EXPLAIN.md: AgentGate, for the person who built it

Read this out loud before every interview. If you cannot explain a section without looking, open the file it names.

## The 30-second version
AI agents call tools: send email, issue refunds, write files. AgentGate sits between the agent and those tools. Each call is cleaned up, checked against a JSON policy that denies by default, held for a human if the policy says so, executed at most once, and written to a hash-chained log. The agent is untrusted; the gate is the product.

## The 2-minute version
1. The agent proposes `{tool, args}`. `prepareCall` (tools.mjs) validates and canonicalises the args: resolves paths, decodes percent-escapes, folds case, and computes facts like "is a dotfile", "has shell metacharacters", "looks like a secret".
2. `evaluatePolicy` (policy.mjs) matches rules against the canonical args and facts. Effects: allow, approve, deny. Deny wins over approve, approve over allow; no match means deny.
3. Deny closes the call. Approve creates an approval request bound to the call's hash with an expiry. Allow executes.
4. A human approves or rejects through `decide` (runtime.mjs): the hash must match, the approver must differ from the actor, and the request must not have expired. Policy is evaluated again right before execution.
5. Execution uses an idempotency key, so a crash and retry does not refund twice.
6. Everything is an event in an append-only chain. A run's state is a fold over its events, which is why a run can resume after a restart.

## Decisions and why
| Decision | Why | Trade-off |
|---|---|---|
| Canonicalise before policy | If the checker sees `workspace/%2e%2e/secrets` as a harmless string but the tool decodes it, the check is bypassed. Judge what runs. | Strict validation rejects some legitimate odd paths. |
| Default deny | New tools and new attack shapes are blocked until someone writes a rule. | More rules to write. |
| Approval bound to a call hash | A human approves one exact call; the agent cannot swap the args after approval. | Any change needs a new approval. |
| Four eyes | An agent (or the person running it) cannot approve itself. | Needs at least two identities. |
| Re-check policy at execution | The policy may have changed while the call waited. | Slight extra work. |
| Event sourcing | Audit and resume come from the same data. | State is derived; needs the fold to be correct and tested. |
| Cumulative budget per run | Twelve refunds of ₹190 each each pass a ₹200 limit but not a ₹2,000 total. | Needs a notion of "run". |
| Tool output is untrusted | A file can say "ignore your policy". The gate never reads it as instructions. | The planner (an LLM) can still be fooled; the gate limits the damage. |
| The agent only proposes | The example agent never executes anything itself. It sends each call to the gate and acts only on the answer, so a confused or hijacked model has no direct path to a tool. | The agent has to cope with "held" and "denied" answers. |
| Report false blocks too | A gate that denies everything has a perfect attack score. | More cases to maintain. |

## What broke, and how I found out
1. **Postgres changed key order.** jsonb does not preserve key order, so a log verified in memory failed after a database round trip. Fix: canonical hashing sorts keys recursively. The Postgres contract tests caught it.
2. **My first mutation run was invalid.** I ran `node --test test/`, which does not discover tests the way I assumed. I redid it with `node --test` and got 15 of 15 caught.
3. **Helper files counted as tests.** Node runs every file in `test/`. Helpers moved to `support/`.
4. **A wrong field name in the UI and a test.** The dashboard looked for `decidedBy`; the real field is `by`. The server test caught it, and a stray "null" appeared in the dry-run panel because `append(null)` writes the text "null". Both only showed up in a real browser or an integration test.

## Likely interview questions
**1. Why not just ask the model to be careful?** A model can be talked out of its instructions by any text it reads. A gate outside the model enforces the rule whatever the model believes.
**2. What does canonicalisation stop?** Encoded traversal (`%2e%2e`), case tricks, absolute paths, and the mismatch between what was checked and what runs.
**3. How is "once" guaranteed?** Idempotency key on execution plus optimistic concurrency on the log (`expectedSeq`), so two drivers cannot both advance the same run.
**4. What stops an agent approving its own refund?** The decide step refuses an approver equal to the run's actor, and the server takes the approver from the signed-in session, so a client cannot claim to be someone else.
**4b. How do your sessions work?** A random 32-byte token in an HttpOnly, SameSite=Strict cookie. Only its SHA-256 is stored, so a database leak does not hand out live sessions. Passwords use scrypt with a per-user salt. Mutating requests need a custom header, which a cross-site page cannot send without a CORS preflight, and the server sends no CORS headers.
**4c. Why a setup token?** The first account becomes admin. On a public URL, whoever gets there first would own the gate, so deployment sets `SETUP_TOKEN` and the setup form needs it.
**5. Is the hash chain secure?** It detects edits and mid-log deletions. It does not stop someone with database access rewriting the whole chain, and removing the newest records is undetectable without an externally stored head.
**6. What if the policy has a bug?** Then it is wrong in the way it is written. The adversarial suite and the 15 mutation checks test the engine and the default policy against cases I wrote; they do not prove the policy complete.
**7. How would this work with a real LLM agent?** Implement the planner interface with a model call. The gate does not change. I would then measure injection attempts against the real model, which I have not done.
**8. What would you do next?** Run the agent example against a real model many times and measure how often it proposes an unsafe call, turning that into a measured injection suite. Then per-user approver identity, a real tool behind the gate in a sandbox, and an external anchor for the log head.

**9. Did you test it with a real LLM agent?** There is a small agent in `examples/agent.mjs` that asks Gemini which tool to call, and every call goes through the gate. The scripted attack runs are deterministic and tested. The Gemini path is tested against a mocked API, and I have not measured how often a real model falls for injection. I say that plainly. The gate does not rely on the model behaving: a fooled agent still hits the same policy.

## Things I should say honestly
- Accounts are basic: email and password, no reset flow, SSO or two-factor.
- Planners are scripts and the world is simulated. No real email, money or commands.
- The 56-case suite and the policy are both mine.
- I built this with AI assistance and can walk through every file and change a rule live.

## Files to know by heart
`policy.mjs`, `tools.mjs` (canonicalisation), `runtime.mjs` (decide, drive), `chain.mjs`, `server.mjs`.
