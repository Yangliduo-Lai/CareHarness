# CareHarness Studio

CareHarness is a local-first, runnable implementation of the Six-State longitudinal method:

The current lifecycle has two explicit stages. Memory build groups historical Profile/Patient/Doctor records by Session, sends each complete role-attributed Session to the Evidence Extractor once, and writes only durable patient-specific or actionable information into six independently maintained State families. Conversation still ingests a new Patient message immediately, updates those memories, runs an independent Action Policy, generates and audits the Doctor Agent response, then writes that sent response back as a Doctor observation for the next turn. The core conversation Policy remains independent; benchmark answering additionally offers three query-time decision gates for controlled ablation.

The core pipeline never accepts benchmark query, gold answer, answer options, judge scores, future sessions, or benchmark-generated summaries as observations. Five adapters keep benchmark protocol fields outside the core; four are exposed in the current Studio.

## Requirements and start

- Node.js 22.5 or newer (tested with Node 26)
- The local benchmark directories supplied with this project, or set `CAREHARNESS_DATA_ROOT`

```bash
cp .env.example .env        # optional; never commit real keys
npm start
```

Open <http://127.0.0.1:8766>. No npm install is required; the server, SQLite binding, frontend, and tests use Node built-ins. To use another port temporarily, run `PORT=9000 npm start`.

### 前端快捷重启

在项目根目录执行以下命令，可停止当前占用 `8766` 端口的服务并重新启动前端：

```bash
lsof -ti tcp:8766 | xargs kill 2>/dev/null || true; npm start
```

To use a real model, open **模型与 Provider** and choose OpenAI, DashScope, DeepSeek, OpenRouter, or a custom OpenAI-compatible endpoint. The DashScope preset uses the official Beijing endpoint `https://dashscope.aliyuncs.com/compatible-mode/v1`; selecting the preset does not change an existing provider assignment automatically. You may paste the API key directly into the page: the browser sends it once to the local backend, which keeps it only in process memory. It is never written to SQLite, logs, traces, exports, or browser storage, and must be entered again after a server restart. A server environment-variable reference remains available as an alternative.

## Test and smoke

```bash
npm test
npm run smoke
```

The smoke command runs one core observation plus one real local protocol sample from each installed adapter using the clearly labeled offline mock provider. CPCD-Bench correctly leaves rubric scoring unavailable under Offline Mock instead of inventing an official Judge result. Mock output validates protocol wiring, persistence, and drill-down, but is not a real benchmark score.

## Guide for a user who does not read code

1. Open **模型与 Provider**. Keep Offline Mock for an offline demo, or choose a provider and enter the model plus API key. **测试当前表单** performs both model listing and a minimal JSON inference. Save it, then assign it globally or to individual Pipeline components. Benchmark answering keeps the original `judge` assignment and JSON transport; `judge.task-contract.v4` additionally defines how enabled decision-gate output constrains the final answer. The MedMemory Official Judge remains scoring-only and sees the frozen answer plus benchmark references only afterward.
2. Open **两阶段调试器**. In Stage 1, enter historical Profile/Patient/Doctor records, choose **从空记忆开始** for an isolated test or **沿用该患者现有记忆**, then choose either **一步构建全部历史记忆** or **阶段 1 分段断点测试**. Records sharing a subject and episode are assembled into one complete Session transcript with explicit Turn/Role/Time headers before extraction. You can also clear only that patient's State memory while retaining Runs and traces. Stage 1 pauses after every actual component and between complete Sessions. Stage 2 offers the same run-through/breakpoint choice for the new Patient–Doctor Agent conversation. Continuation preserves the in-process execution context, so completed model calls are not repeated or billed again.
3. Open **State Explorer** to inspect six families, evidence spans, source, episode, confidence, update operation, and version chain. The risk row keeps PE disclosure, CS professional assessment, and CP safety plan separate.
4. Open **Action Policy** to inspect the core conversation Policy's plain-language reason for ASK, VERIFY, ESCALATE, or ANSWER. This page remains separate from the three optional query-time decision gates in benchmark experiments.
5. Open one of the four visible benchmark labs. Preview the real visible boundary before starting. MedMemoryBench accepts an exact start Session and Session count. A window beginning after Session 1 requires a compatible checkpoint for the preceding Session; restoring it deletes active State and later checkpoints from the selected start onward before rebuilding the requested window. MedMemoryBench and MedLoCoMo both expose a separate **直接用当前 State 答题并评分** action: it validates and freezes the currently persisted memory, skips State construction, and never mutates the State store. MedLoCoMo accepts this mode only when the snapshot exactly matches a successful complete all-Admission build for that patient. Results link to the full core run trace. Mock experiments carry a warning and must not be reported as official scores.
6. Open **Runs & Errors** to download a secret-free replay bundle. If a run fails, the page shows the exact step, input, raw response, parsed output, validation errors, and a suggested next action.

## Data boundaries and verified differences

- MedMemoryBench: official `messages` are assembled into one role-attributed observation per complete dated Session; `knowledge_points` and `source_key_points` remain reference-only. The harness builds one Session, answers every query attached to that Session, and only then starts preprocessing and building the next Session. Gold answers, answer explanations, trap design, required patient information, and common-wrong-answer metadata remain isolated in the post-answer evaluator and cannot enter State construction, planning, retrieval, selection, or answer generation.
- MedLoCoMo: one patient is one formal sample, so every run builds every admission in chronological `combined_conversation.json` order. The `mode` and optional question-type controls filter only `benchmark_qa.json` questions (`single_admission`, `cross_admission`, or both); they never truncate the patient timeline. Admission and patient summaries remain inspection-only.
- MusPsy: `train/task1.json`, `task2.json`, and `task3.json` define executable boundaries beyond the brief README. Task 3 Last Memory is benchmark protocol context, not a Patient quote or a new observation.
- MediLongChat: every run builds all encounters for one patient. The current public repository snapshot contains `dataset.json` but not the paper's IDR/CDR/SR task annotations, so Studio questions are deterministic corpus-derived diagnostics. Their F1/BLEU-1/accuracy are explicitly marked `public_release_derived` and must not be compared with the paper's Table 6.
- CPCD-Bench: every run builds the selected case's complete released consultation history and executes the official 159-task SR/MR/TCR protocol. The answer model cannot see reference answers or evaluation focus. After the answer is frozen, the independent CPCD Judge applies the repository rubric; SR uses 1–5 dimensions, while MR/TCR use 0–5 dimensions. Offline Mock never fabricates these scores.

## One prompt editing surface

All model-facing prompt text is defined in `src/prompts.js`. `PROMPTS` contains the shared Extractor, Router, Query Planner, benchmark-answer shell, official scoring-Judge contracts, and other pipeline prompts. `BENCHMARK_ANSWER_PROMPTS` contains explicit answer contracts for MedMemoryBench, MedLoCoMo, MusPsy, MediLongChat, and CPCD-Bench. The same file contains the MedMemoryBench, MedLoCoMo, and CPCD-Bench post-answer Judge templates. Benchmark adapters select the applicable contract; they do not keep model-facing prompt prose.

Changing an answer requirement therefore means editing the matching entry in `src/prompts.js`; every adapter and experiment reads it through `benchmarkAnswerContract(...)`. Dataset-provided questions and protocol instructions remain dataset content rather than duplicated prompt definitions. Scoring algorithms, metric mappings, output validation, and hidden-reference isolation remain outside the prompt registry and are not changed by editing its wording.

## Benchmark query retrieval

Benchmark answering now uses query planning followed by one candidate-retrieval stage. The Query Planner receives only the untouched question text and produces a structured plan containing intent, target, answer slot, keywords, soft State-family scopes, temporal operator, evidence facets, answer options, and answer format. Older `{"keywords":[...]}` planner output is still accepted; deterministic query analysis supplies missing safety scopes and is the full fallback for Offline Mock or planner failure.

Candidate retrieval scores every visible State with several independent recall channels: direct terms, medical aliases, Chinese lexical n-grams, linked Evidence text, task-aware family priors, evidence facets, and answer-option matches. Scope is a soft prior rather than a filter, so a planner family mistake cannot hide all other families. When one Evidence produces States in several families, provenance-aware round-robin scheduling prevents that shared Evidence from consuming the candidate budget while keeping the original States auditable. Candidate caps and reducers depend on the task: temporal questions preserve chronological ordering, current-state questions expand the version chain, multiple-choice questions balance candidates per option, and clinical inference questions diversify across families and facets. Every candidate within the task-aware safety cap is passed directly to the answer model; no second State-selection model is called.

Every benchmark query now always runs the standalone **Evidence Index Gate** in `src/evidence-index-gate.js`; there is no UI or API option that can disable it. The gate indexes only query-visible State/Evidence by time, family, episode, entity/topic, provenance, and State-version relations; constructs a typed query-specific evidence chain; checks a task profile for uncovered evidence facets; and performs a bounded second-pass lookup before the complete task-capped candidate set is sent to the answer model. The gate is recall-first and fail-open: it unions indexed anchors with the ordinary hybrid signals rather than treating a planner scope as a hard exclusion. No Gold answer, official Judge metadata, or reference key point is accepted by this module.

After retrieval, `src/decision-gates.js` can run three independently selectable deterministic gates. Clinical Need & Safety reads CS/PE first and BC/LO/CP as support; Understanding & Clarification reads PA first and PE/CS/LO as support; Preference & Feasibility reads PA/BC first and CP/PE/LO as support, but may rank only options allowed by the Clinical gate. Their structured output retains State/Evidence IDs and is inserted into the answer-model input in the fixed order clinical safety → understanding/clarification → preference/feasibility. A clinical `must_escalate` or hard constraint cannot be overridden downstream. These gates do not create State and do not call another model.

The experiment trace records candidate scores and recall channels, evidence-index buckets/chains/coverage and second-pass repairs, optional decision-gate inputs and outputs, the complete capped candidate State/Evidence context sent directly to the answer model, missing facets and evidence IDs, and family/option distributions. There is no post-retrieval State Selector or rerank stage: every candidate that survives the task-aware safety cap is passed through. Summaries report evidence coverage, second-pass usage, and per-decision-gate query counts. If any Session visible to a query failed or was not attempted during memory construction, that query is marked `memory_incomplete` and answer generation/scoring is skipped instead of reporting a misleading wrong answer.

For MedMemoryBench, every query carries its own Session visibility boundary. A Session 10 query runs immediately after the Session 10 checkpoint and can read only State from the prefix through Session 10; Session 11 is not even preprocessed until those queries finish. Clean runs likewise cannot retrieve Noise episodes.

MedMemoryBench also has a scoring-only current-memory mode. At launch it freezes the current State and only the Evidence referenced by those States, records a SHA-256 snapshot fingerprint, then runs the unchanged Query Planner, mandatory Evidence Index Gate, any selected decision gates, candidate passthrough, answer model, and official scorer. It does not construct observations, invoke the Extractor/Router, clear or restore memory, write checkpoints, or update the State scope. The launch fails before creating an experiment unless Persona and Noise match, the memory is a complete continuous prefix from Session 1 through the latest selected query Session, and every State Evidence reference resolves. Each query still applies its own `visible_episode_ids`, so later-session State cannot leak into an earlier query.

## MedMemoryBench official evaluation

The six query types now follow the metric mapping shipped by MedMemoryBench:

| Query type | Official metric in CareHarness |
| --- | --- |
| `entity_exact_match` (EEM) | normalized `string_contain`; every correct answer must occur in the output |
| `multiple_choice` (MQ) | exact A–F option-set `option_match` |
| `temporal_localization` (TLA) | independent binary LLM-as-Judge |
| `state_update` (SUA) | independent binary LLM-as-Judge |
| `inference_generation` (IG) | independent binary LLM-as-Judge with inference type, trap mechanism, required patient information, and common-wrong-answer metadata |
| `multi_hop_clinical_deduction` (MCD) | independent official MCD Judge with NCR/CRC/CC, patient-specific-information and retrieval-quality penalties |

Answer generation still uses the pre-existing `judge` model assignment and JSON `{"answer":"..."}` transport. `judge.task-contract.v4` receives the answer contract, query plan, retrieved State/Evidence, fixed evidence chain, protocol input, and only the decision gates selected for that experiment. It does not receive Gold, answer explanations, or Judge metadata. After that answer is frozen, the scoring stage applies the official deterministic metric or calls the separate `scoring_judge`; only this scoring-only call receives the reference answer, explanation, and official evaluation metadata. Traces and wrong-answer exports store the answer call, decision-gate provenance, and scoring Judge call separately.

The official Judge prompts are ported from MedMemoryBench commit `7227bc1`. TLA/SUA/IG use the official 500-token Judge budget; MCD uses 2,000. An empty Answer follows the official zero-score shortcut without spending a Judge call. Once a live scoring Judge is configured, its transport, parsing, or validation failure likewise follows the official runner's zero-score fallback; CareHarness additionally records `judge_infrastructure_failure` and the full failed trace so that this case cannot be mistaken for a substantive Judge verdict. MCD result summaries expose the official average NCR/CRC/CC and node mention/causal rates. If only Offline Mock is assigned, the four Judge-dependent types remain explicitly unscored because no Judge call exists to reproduce. EEM and MQ remain deterministic and can be evaluated without a Judge. To reproduce the paper's reported scoring setup, assign its Judge model/configuration in the **MedMemory Official Judge（仅评分）** slot; every result records the actual provider, model, temperature, and prompt version.

## MedLoCoMo official evaluation

MedLoCoMo answer generation uses the benchmark's short-answer contract: an English answer of at most 10 words with no explanation. Adversarial questions request the canonical `the question is not answerable` phrase. Gold answers and hidden evidence annotations remain unavailable until the answer is frozen.

Answerable questions record the official normalized token F1, including the comma-aware maximum, and are independently graded 0/1 with the paper's fixed Judge prompt. Adversarial questions bypass the Judge and use the normalized abstention-phrase matcher. Result summaries expose F1, answerable Judge accuracy (J), adversarial abstention accuracy (Acc), and the official item-weighted combined Score for overall, single-admission, and cross-admission splits. The **MedLoCoMo Answerable Judge** model slot inherits the current global model by default; assigning a dedicated profile freezes it for that experiment. The paper reports `gemini-3-flash-preview`, while CareHarness records the actual selected provider/model so runs using another current model are not mislabeled as paper-reproduction runs. Offline Mock never fabricates a Judge verdict: answerable F1 remains diagnostic, while J and combined Score stay incomplete until a live Judge is configured.

The MedLoCoMo experiment page automatically reads the newest matching results for the selected Patient and question type. It displays Overall, Single-admission, and Cross-admission independently in the paper's F1/J/Acc/Score order: a Single-only run updates only Single, a Cross-only run updates only Cross, and an all-question run can update all three scopes. Experiment lists and dashboards transfer summary payloads only; opening an experiment loads a compact index, then retrieves one question or Run trace on demand. This keeps large MedLoCoMo and MedMemory result records inspectable without serializing the entire experiment into one browser string.

## Session-level State construction

Historical and benchmark memory construction uses one model call pair per complete Session: the Evidence Extractor reads the whole transcript, then the State Router routes the retained Evidence. The model emits only normalized Evidence text and family choices. Code attaches the immutable Session/Admission identifier to Evidence and State, assigns Router IDs from input order, and validates the Router envelope and item count; the model never generates provenance, source text, offsets, IDs, or persistence operations.

The Extractor keeps symptoms, medication status, measurements, diagnoses, patient beliefs/goals/constraints, and concrete Doctor assessments or plans. It drops greetings, empathy, encouragement, reassurance, companionship promises, metaphors, generic education not applied to the patient, and repetition. A quote may come from only one message body and may not include a transcript header or cross a Turn boundary. Real-time conversation remains Turn-level because the system must update Patient memory before generating the Doctor response.

A deliberately narrow coverage guard restores only the demonstrated Chinese direct-object pattern `我[时间词]把 <单一药名> 停了[后/之后]` when the model omits it. Every other medication statement remains with the model, including English, starts/restarts, dose/current use, instructions, questions, intentions, uncertainty, hypotheticals, third-party or multi-drug statements, corrections, and later resumptions. Every guard addition carries the code-owned Session provenance plus a trace warning. At routing time, each Evidence is assigned directly to one or more of BC, PE, PA, CS, CP, and LO. A family may appear only once for the same Evidence; duplicate family labels are removed deterministically, while an unknown family still fails validation. Evidence provenance is retained, and every State family accepts Patient, Doctor, and Structured Evidence; source type is never a family-level rejection rule.

This State-building and retrieval change uses checkpoint compatibility version `six-state-session-memory-v12`. Version 12 keeps the six family-only State schema and makes Router structure code-owned: the model selects only an ordered matrix of family names, while code creates routes, attaches IDs, normalizes harmless legacy wrappers, and validates the exact item count. Providers and models that support strict JSON Schema receive `strict:true`; other JSON-mode models are checked at the application boundary. If a JSON-mode model still exhausts its retries with a structural or taxonomy error, the deterministic six-family Router completes that Session and records the raw model failure plus an explicit fallback warning instead of making memory incomplete. Extractor provenance remains code-owned: the model outputs only normalized atomic `text`; code attaches the current immutable `episode_id` as `source_session_id` on Evidence and State. The model never generates `source_text`, character offsets, Router objects, or Router IDs. MedMemoryBench Clean and With-noise retain independent physical subjects (`medmemory-persona-N-clean` and `medmemory-persona-N-with-noise`), so rebuilding, clearing, resuming, or scoring one mode cannot overwrite or read the other. Direct current-State scoring validates the stored State schema generation, Persona/Noise namespace, continuous Session coverage, and every Evidence reference; it does not reject an otherwise compatible frozen State merely because the current builder prompt or model assignment differs. Checkpoint continuation remains stricter: each experiment persists its creation-time pipeline version and scope key, and resume requires the current builder identity, exact successful State snapshot, resolvable Evidence, and complete lineage. Older incompatible State schemas, failed or incomplete memory Sessions, and truncated snapshots are never reused as checkpoints. Query-only scoring failures may leave an experiment `partial`, but its checkpoint remains reusable when the memory build itself is complete.

## Persistence and replay

SQLite stores append-only evidence, versioned states, runs, traces, experiments, actual provider/model config, prompt versions, seed, and Git version. Formal runs commit atomically only after Auditor success. Debug branches are stored separately and do not alter formal state. Runtime databases and outputs are gitignored.
