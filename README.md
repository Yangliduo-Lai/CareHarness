# CareHarness Studio

CareHarness is a local-first, runnable implementation of the Six-State longitudinal method:

`Patient / Doctor / Structured observation → Packetizer → Evidence → Link/Route → BC/PE/PA/CS/CP/LO → Reconciler → Validity → G1 → G2 → G3 → Policy → Generator → Auditor → transactional commit`.

The core pipeline never accepts benchmark query, gold answer, answer options, judge scores, future sessions, or generic Derived summaries as observations. Four adapters keep benchmark protocol fields outside the core.

## Requirements and start

- Node.js 22.5 or newer (tested with Node 26)
- The local benchmark directories supplied with this project, or set `CAREHARNESS_DATA_ROOT`

```bash
cp .env.example .env        # optional; never commit real keys
npm start
```

Open <http://127.0.0.1:8765>. No npm install is required; the server, SQLite binding, frontend, and tests use Node built-ins.

To use an OpenAI-compatible model, set the real key in a server environment variable such as `OPENAI_API_KEY`, then enter only `OPENAI_API_KEY` as the UI's key reference. The browser, database traces, and exported bundles never receive the secret value.

## Test and smoke

```bash
npm test
npm run smoke
```

The smoke command runs one core observation and one real local sample plus one harness-side task from each of MedMemoryBench, MedLoCoMo, MusPsy, and PsychEval using the clearly labeled offline mock provider. Mock output validates observation ingestion, externally submitted query/task, score persistence, and drill-down, but is not a real benchmark score.

## Guide for a user who does not read code

1. Open **模型与 Provider**. Keep Offline Mock for an offline demo, or choose OpenAI-compatible and enter the base URL, model, and server environment-variable name. Click **测试连接**.
2. Open **Pipeline 调试器**, select the real source, paste one observation, and run it. Expand every step to see full input, parsed output, raw model output, field diff, latency, token count, validation details, and suggestions.
3. Open **State Explorer** to inspect six families, evidence spans, source, episode, confidence, update operation, and version chain. The risk row keeps PE disclosure, CS professional assessment, and CP safety plan separate.
4. Open **Three-Gate Inspector** to see G1 → G2 → G3 constraints and the plain-language reason for ASK, VERIFY, ESCALATE, or ANSWER.
5. Open one of the four benchmark labs. Preview the real visible boundary before starting. Results link to the full core run trace. Mock experiments carry a warning and must not be reported as official scores.
6. Open **Runs & Errors** to download a secret-free replay bundle. If a run fails, the page shows the exact step, input, raw response, parsed output, validation errors, and a suggested next action.

## Data boundaries and verified differences

- MedMemoryBench: official code injects `messages`; `knowledge_points` remain reference-only. Queries and answers are submitted after memory construction.
- MedLoCoMo: formal input comes from `combined_conversation.json`; QA comes from `benchmark_qa.json`. Admission and patient summaries remain inspection-only.
- MusPsy: `train/task1.json`, `task2.json`, and `task3.json` define executable boundaries beyond the brief README. Task 3 Last Memory is Derived protocol context, not a Patient quote or a new observation.
- PsychEval: the public evaluator loops over sessions and constructs `client_info + current session_dialogue`. Continuity/goal tracking are supported by rollout data but do not have a separate official metric.

## Persistence and replay

SQLite stores append-only evidence, versioned states, relations, runs, traces, experiments, actual provider/model config, prompt versions, seed, and Git version. Formal runs commit atomically only after Auditor success. Debug branches are stored separately and do not alter formal state. Runtime databases and outputs are gitignored.
