# Implementation report

## Delivered

- Strict typed contracts for Observation, Evidence, State, StateDelta, Relation, GateTrace, Action, AuditResult, provider config, experiment config/results.
- SQLite transactions, evidence provenance, version chains, relations, formal/debug isolation, run replay and secret-free bundles.
- Unified mock and OpenAI-compatible Model Gateway, prompt registry/version, strict JSON validation, raw/parsed response traces, latency/token/retry/error capture.
- Six-State pipeline, temporal reconciliation, non-Gate Validity, ordered Three Gates, deterministic Action Policy, governed Generator, blocking Auditor.
- Four isolated adapters and four distinct benchmark pages with real visible boundaries.
- Workspace, provider settings, 20-step debugger, State Explorer, Gate Inspector, runs/errors, experiment controls and responsive UI.

## Honest limitations

- The compatible scorer is deliberately minimal; official/LLM judge execution requires the benchmark's external dependencies and a configured model. The UI never labels mock results as official.
- Experiment jobs run in the background; Pause / Resume / Cancel apply at safe observation boundaries, retain completed results, and the UI polls progress with ETA, current sample, failures, tokens, cost, and latency.
- Step rerun currently creates a complete isolated debug branch from the same input. It records the selected step in the UI but does not yet reuse a materialized intermediate checkpoint.
- Cost is estimated as zero for Mock. Provider-specific pricing tables are not hardcoded because they change; latency and token usage remain captured.

## Data discrepancies surfaced in UI

The MusPsy README describes directories but not all executable task fields; `train/task1.json`–`task3.json` were used as truth. PsychEval's data supports longitudinal analyses, while the official public evaluator is session-level. Both differences are shown in catalog and benchmark pages.
