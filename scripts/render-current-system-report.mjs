#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, '..');
const reportPath = resolve(root, process.argv[2] || 'reports/medmemory-current-system-and-results.html');
const dbPath = resolve(root, 'data/careharness.sqlite');

const TASKS = [
  ['entity_exact_match', 'EEM', '实体精确匹配'],
  ['temporal_localization', 'TLA', '时间定位'],
  ['state_update', 'SUA', '状态更新'],
  ['multiple_choice', 'MQ', '多项选择'],
  ['inference_generation', 'IG', '个体化推理'],
  ['multi_hop_clinical_deduction', 'MCD', '多跳临床推理'],
];
const TASK_ABBR = Object.fromEntries(TASKS.map(([key, abbr]) => [key, abbr]));
const EXPECTED_TOTAL = 395;
const LONG_CONTEXT_TOKEN_ESTIMATE = Object.freeze({
  kind: 'long_context',
  inputTokensLow: 36_553_161,
  inputTokensHigh: 37_934_093,
  outputTokensLow: 553_440,
  outputTokensHigh: 957_369,
  totalTokensLow: 37_106_602,
  totalTokensHigh: 38_891_462,
  totalTokensMid: 37_999_032,
  avgTokensPerQuestion: 120_103,
  avgTokensLow: 93_941,
  avgTokensHigh: 98_459,
  answerCalls: 395,
  judgeCalls: 236,
  memoryBuildLlmCalls: 0,
  uniqueMemoryTextTokens: 2_997_923,
});
const INFRASTRUCTURE_MARKERS = [
  '[error:',
  '[error at chunk',
  '[api_error]',
  'insufficient_balance',
  'insufficient balance',
  'insufficient_quota',
  '余额不足',
  'permission_denied',
  'invalid_api_key',
  'authenticationerror',
  'unauthorized',
  'retries exhausted',
];

if (!existsSync(dbPath)) throw new Error(`Missing experiment database: ${dbPath}`);

const db = new DatabaseSync(dbPath, { readOnly: true });
const selectedExperiments = db.prepare(`
  WITH candidates AS (
    SELECT
      id,
      created_at,
      updated_at,
      CAST(json_extract(config_json, '$.persona_id') AS INTEGER) AS persona_id,
      CAST(json_extract(progress_json, '$.query_total') AS INTEGER) AS query_total,
      json_extract(progress_json, '$.retrieval_metrics.query_type_classification_accuracy') AS classifier_accuracy,
      ROW_NUMBER() OVER (
        PARTITION BY CAST(json_extract(config_json, '$.persona_id') AS INTEGER)
        ORDER BY created_at DESC
      ) AS row_number
    FROM experiments
    WHERE benchmark = 'medmemorybench'
      AND status = 'completed'
      AND json_extract(config_json, '$.query_type_routing_mode') = 'classified'
      AND config_json LIKE '%qwen3.7-plus%'
      AND CAST(json_extract(progress_json, '$.query_total') AS INTEGER) >= 95
      AND CAST(json_extract(config_json, '$.persona_id') AS INTEGER) IN (1, 3, 5, 7)
  )
  SELECT * FROM candidates WHERE row_number = 1 ORDER BY persona_id
`).all();

if (selectedExperiments.length !== 4) {
  throw new Error(`Expected four complete CareHarness experiments for Persona 1/3/5/7, found ${selectedExperiments.length}`);
}

const carePersonaRows = [];
const careAll = emptyAggregate('CareHarness（当前系统）', '完整');
for (const experiment of selectedExperiments) {
  const taskRows = db.prepare(`
    SELECT
      json_extract(item.value, '$.task') AS task,
      COUNT(*) AS total,
      SUM(CASE WHEN json_extract(item.value, '$.is_correct') = 1 THEN 1 ELSE 0 END) AS correct,
      AVG(CAST(json_extract(item.value, '$.score') AS REAL)) AS avg_score,
      AVG(CAST(json_extract(item.value, '$.latency_ms') AS REAL)) AS avg_latency_ms,
      SUM(
        COALESCE(CAST(json_extract(item.value, '$.query_classifier_input_tokens') AS INTEGER), 0)
        + COALESCE(CAST(json_extract(item.value, '$.investigation_policy_input_tokens') AS INTEGER), 0)
        + COALESCE(CAST(json_extract(item.value, '$.relation_evaluator_input_tokens') AS INTEGER), 0)
        + COALESCE(CAST(json_extract(item.value, '$.answer_input_tokens') AS INTEGER), 0)
        + COALESCE(CAST(json_extract(item.value, '$.judge_input_tokens') AS INTEGER), 0)
      ) AS recorded_input_tokens,
      SUM(
        COALESCE(CAST(json_extract(item.value, '$.query_classifier_output_tokens') AS INTEGER), 0)
        + COALESCE(CAST(json_extract(item.value, '$.investigation_policy_output_tokens') AS INTEGER), 0)
        + COALESCE(CAST(json_extract(item.value, '$.relation_evaluator_output_tokens') AS INTEGER), 0)
        + COALESCE(CAST(json_extract(item.value, '$.answer_model_trace.token_output') AS INTEGER), 0)
        + COALESCE(CAST(json_extract(item.value, '$.judge_model_trace.token_output') AS INTEGER), 0)
      ) AS recorded_output_tokens,
      AVG(CAST(json_extract(item.value, '$.scoring_details.ncr_score') AS REAL)) AS avg_ncr,
      AVG(CAST(json_extract(item.value, '$.scoring_details.crc_score') AS REAL)) AS avg_crc,
      AVG(CAST(json_extract(item.value, '$.scoring_details.cc_score') AS REAL)) AS avg_cc,
      AVG(CASE
        WHEN json_extract(item.value, '$.query_classification.is_correct') = 1 THEN 1.0
        WHEN json_extract(item.value, '$.query_classification.is_correct') = 0 THEN 0.0
        ELSE NULL
      END) AS classifier_accuracy
    FROM json_each((SELECT results_json FROM experiments WHERE id = ?)) AS item
    WHERE json_extract(item.value, '$.kind') = 'score'
      AND json_extract(item.value, '$.status') = 'scored'
      AND json_extract(item.value, '$.score') IS NOT NULL
    GROUP BY json_extract(item.value, '$.task')
  `).all(experiment.id);
  const aggregate = aggregateTaskRows(taskRows, `Persona ${experiment.persona_id}`, '完整');
  aggregate.personaId = Number(experiment.persona_id);
  aggregate.experimentId = experiment.id;
  aggregate.createdAt = experiment.created_at;
  aggregate.updatedAt = experiment.updated_at;
  carePersonaRows.push(aggregate);
  mergeAggregate(careAll, aggregate);
}
finalizeAggregate(careAll);

const longContextPath = findNewest(root, file => /medmemorybench_long_context_qwen3\.7-plus_.*_result\.json$/u.test(file));
const lettaPath = findNewest(root, file => /medmemorybench_letta_qwen3\.7-plus_.*_result\.json$/u.test(file));
if (!longContextPath || !lettaPath) throw new Error('Missing complete Long-Context or Letta result JSON');

const longContext = aggregateOfficialResult(longContextPath, 'Long-Context', '完整');
longContext.tokenEstimate = LONG_CONTEXT_TOKEN_ESTIMATE;
const invalidLetta = aggregateOfficialResult(lettaPath, 'Letta（旧结果）', '完整');

const lettaCheckpointPaths = [1, 3, 5, 7].map(persona => resolve(
  root,
  `reports/official-baselines/qwen3.7-plus/sharded-8/letta/persona-${persona}/checkpoints/medmemorybench/letta_qwen3.7-plus/checkpoint.json`,
)).filter(existsSync);
const letta = aggregateCheckpoints(lettaCheckpointPaths, 'Letta（已暂停断点）');
const lettaLogPaths = [1, 3, 5, 7].map(persona => resolve(
  root,
  `reports/official-baselines/qwen3.7-plus/sharded-8/letta/persona-${persona}/process.log`,
)).filter(existsSync);
letta.tokenEstimate = estimateLettaTokenUsage(lettaLogPaths, letta);

const amemCheckpointPaths = [
  'reports/official-baselines/qwen3.7-plus/full-persona-1-3-5-7/amem/checkpoints/medmemorybench/amem_qwen3.7-plus/checkpoint.json',
  'reports/official-baselines/qwen3.7-plus/sharded-8/amem/persona-3/checkpoints/medmemorybench/amem_qwen3.7-plus/checkpoint.json',
  'reports/official-baselines/qwen3.7-plus/sharded-8/amem/persona-5/checkpoints/medmemorybench/amem_qwen3.7-plus/checkpoint.json',
  'reports/official-baselines/qwen3.7-plus/sharded-8/amem/persona-7/checkpoints/medmemorybench/amem_qwen3.7-plus/checkpoint.json',
].map(path => resolve(root, path)).filter(existsSync);
const amemResultPaths = [
  'reports/official-baselines/qwen3.7-plus/sharded-8/amem/persona-5/amem_qwen3.7-plus/medmemorybench_amem_qwen3.7-plus_20260902_030736_query_answer.json',
].map(path => resolve(root, path)).filter(existsSync);
const amem = aggregateCheckpoints(amemCheckpointPaths, 'A-Mem（已暂停断点）', amemResultPaths);
const amemSnapshotPaths = [
  'reports/official-baselines/qwen3.7-plus/full-persona-1-3-5-7/amem/.amem-runtime/context-1.snapshot.json',
  'reports/official-baselines/qwen3.7-plus/sharded-8/amem/persona-3/.amem-runtime/context-3.snapshot.json',
  'reports/official-baselines/qwen3.7-plus/sharded-8/amem/persona-5/.amem-runtime/context-5.snapshot.json',
  'reports/official-baselines/qwen3.7-plus/sharded-8/amem/persona-7/.amem-runtime/context-7.snapshot.json',
].map(path => resolve(root, path)).filter(existsSync);
amem.tokenEstimate = estimateAmemTokenUsage(amemSnapshotPaths, amem);

const methods = [careAll, longContext, letta, amem];
const commit = safeGit(['rev-parse', '--short', 'HEAD']) || 'unknown';
const branch = safeGit(['branch', '--show-current']) || 'unknown';
const dirtyFiles = (safeGit(['status', '--short']) || '').split('\n').filter(Boolean);
const generatedAt = new Date();

const html = renderHtml({
  methods,
  carePersonaRows,
  selectedExperiments,
  longContextPath,
  lettaPath,
  lettaCheckpointPaths,
  invalidLetta,
  amemCheckpointPaths,
  amemResultPaths,
  commit,
  branch,
  dirtyFiles,
  generatedAt,
});

mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, html, 'utf8');
console.log(reportPath);

function emptyAggregate(name, status) {
  return {
    name,
    status,
    total: 0,
    correct: 0,
    scoreSum: 0,
    byTask: {},
    recordedInputTokens: 0,
    recordedOutputTokens: 0,
    latencyWeightedMs: 0,
    classifierCorrectWeighted: 0,
    classifierTotal: 0,
    mcdNcrWeighted: 0,
    mcdCrcWeighted: 0,
    mcdCcWeighted: 0,
    mcdCount: 0,
    llmJudgedQuestions: 0,
    estimatedJudgeTokens: 0,
    retrievedMemoryCount: 0,
    retrievedMemoryCountByPersona: {},
    answerOutputEstimatedTokens: 0,
  };
}

function aggregateTaskRows(rows, name, status) {
  const out = emptyAggregate(name, status);
  for (const row of rows) {
    const task = String(row.task || '');
    const total = Number(row.total || 0);
    const avgScore = Number(row.avg_score || 0);
    const avgLatencyMs = Number(row.avg_latency_ms || 0);
    const classifierAccuracy = row.classifier_accuracy == null ? null : Number(row.classifier_accuracy);
    out.byTask[task] = {
      total,
      correct: Number(row.correct || 0),
      avgScore,
      classifierAccuracy,
      avgNcr: row.avg_ncr == null ? null : Number(row.avg_ncr),
      avgCrc: row.avg_crc == null ? null : Number(row.avg_crc),
      avgCc: row.avg_cc == null ? null : Number(row.avg_cc),
    };
    out.total += total;
    out.correct += Number(row.correct || 0);
    out.scoreSum += avgScore * total;
    out.recordedInputTokens += Number(row.recorded_input_tokens || 0);
    out.recordedOutputTokens += Number(row.recorded_output_tokens || 0);
    out.latencyWeightedMs += avgLatencyMs * total;
    if (classifierAccuracy != null) {
      out.classifierCorrectWeighted += classifierAccuracy * total;
      out.classifierTotal += total;
    }
    if (task === 'multi_hop_clinical_deduction') {
      out.mcdNcrWeighted += Number(row.avg_ncr || 0) * total;
      out.mcdCrcWeighted += Number(row.avg_crc || 0) * total;
      out.mcdCcWeighted += Number(row.avg_cc || 0) * total;
      out.mcdCount += total;
    }
  }
  finalizeAggregate(out);
  return out;
}

function mergeAggregate(target, source) {
  target.total += source.total;
  target.correct += source.correct;
  target.scoreSum += source.scoreSum;
  target.recordedInputTokens += source.recordedInputTokens;
  target.recordedOutputTokens += source.recordedOutputTokens;
  target.latencyWeightedMs += source.latencyWeightedMs;
  target.classifierCorrectWeighted += source.classifierCorrectWeighted;
  target.classifierTotal += source.classifierTotal;
  target.mcdNcrWeighted += source.mcdNcrWeighted;
  target.mcdCrcWeighted += source.mcdCrcWeighted;
  target.mcdCcWeighted += source.mcdCcWeighted;
  target.mcdCount += source.mcdCount;
  for (const [task, row] of Object.entries(source.byTask)) {
    const current = target.byTask[task] || { total: 0, correct: 0, scoreSum: 0, classifierWeighted: 0, classifierTotal: 0, ncrWeighted: 0, crcWeighted: 0, ccWeighted: 0, mcdCount: 0 };
    current.total += row.total;
    current.correct += row.correct;
    current.scoreSum += row.avgScore * row.total;
    if (row.classifierAccuracy != null) {
      current.classifierWeighted += row.classifierAccuracy * row.total;
      current.classifierTotal += row.total;
    }
    if (task === 'multi_hop_clinical_deduction') {
      current.ncrWeighted += Number(row.avgNcr || 0) * row.total;
      current.crcWeighted += Number(row.avgCrc || 0) * row.total;
      current.ccWeighted += Number(row.avgCc || 0) * row.total;
      current.mcdCount += row.total;
    }
    target.byTask[task] = current;
  }
}

function finalizeAggregate(out) {
  out.avgScore = out.total ? out.scoreSum / out.total : null;
  out.accuracy = out.total ? out.correct / out.total : null;
  out.avgLatencyMs = out.total ? out.latencyWeightedMs / out.total : null;
  out.avgRecordedTokens = out.total ? (out.recordedInputTokens + out.recordedOutputTokens) / out.total : null;
  out.classifierAccuracy = out.classifierTotal ? out.classifierCorrectWeighted / out.classifierTotal : null;
  out.avgNcr = out.mcdCount ? out.mcdNcrWeighted / out.mcdCount : null;
  out.avgCrc = out.mcdCount ? out.mcdCrcWeighted / out.mcdCount : null;
  out.avgCc = out.mcdCount ? out.mcdCcWeighted / out.mcdCount : null;
  for (const [task, row] of Object.entries(out.byTask)) {
    if (row.scoreSum != null) {
      row.avgScore = row.total ? row.scoreSum / row.total : null;
      row.classifierAccuracy = row.classifierTotal ? row.classifierWeighted / row.classifierTotal : null;
      if (task === 'multi_hop_clinical_deduction') {
        row.avgNcr = row.mcdCount ? row.ncrWeighted / row.mcdCount : null;
        row.avgCrc = row.mcdCount ? row.crcWeighted / row.mcdCount : null;
        row.avgCc = row.mcdCount ? row.ccWeighted / row.mcdCount : null;
      }
    }
  }
  return out;
}

function aggregateOfficialResult(path, name, status) {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  const out = emptyAggregate(name, status);
  const summary = value.summary || {};
  for (const [task, row] of Object.entries(summary.by_type || {})) {
    out.byTask[task] = {
      total: Number(row.total || 0),
      correct: Number(row.correct || 0),
      avgScore: Number(row.avg_score || 0),
      avgNcr: row.avg_ncr == null ? null : Number(row.avg_ncr),
      avgCrc: row.avg_crc == null ? null : Number(row.avg_crc),
      avgCc: row.avg_cc == null ? null : Number(row.avg_cc),
    };
  }
  out.total = Number(summary.total_queries || 0);
  out.correct = Number(summary.correct_count || 0);
  out.scoreSum = Number(summary.overall_avg_score || 0) * out.total;
  out.avgScore = Number(summary.overall_avg_score || 0);
  out.accuracy = Number(summary.overall_accuracy || 0);
  out.avgLatencyMs = Number(value.efficiency?.avg_query_time || 0) * 1000;
  out.recordedInputTokens = Number(value.llm_usage?.total?.input_tokens || 0);
  out.recordedOutputTokens = Number(value.llm_usage?.total?.output_tokens || 0);
  out.recordedTotalTokens = Number(value.llm_usage?.total?.total_tokens || 0);
  out.recordedCallCount = Number(value.llm_usage?.total?.call_count || 0);
  // A benchmark question necessarily makes at least one Answer call. If a
  // completed result records fewer calls than questions, the upstream usage
  // tracker was reset during checkpoint resume and cannot yield a full-run
  // per-question average.
  out.tokenUsageComplete = out.total > 0 && out.recordedCallCount >= out.total;
  out.avgRecordedTokens = out.tokenUsageComplete
    ? out.recordedTotalTokens / out.total
    : null;
  const mcd = out.byTask.multi_hop_clinical_deduction;
  out.avgNcr = mcd?.avgNcr ?? null;
  out.avgCrc = mcd?.avgCrc ?? null;
  out.avgCc = mcd?.avgCc ?? null;
  out.sourcePath = path;
  out.model = value.model_name || value.config?.method_config?.model?.name || null;
  out.integrity = baselineIntegrity(path);
  if (!out.integrity.valid) out.status = '无效';
  return out;
}

function baselineIntegrity(resultPath) {
  const prefix = basename(resultPath).replace(/_result\.json$/u, '');
  const directory = dirname(resultPath);
  const queryPath = join(directory, `${prefix}_query_answer.json`);
  const memoryPath = join(directory, `${prefix}_memory_build.json`);
  let queryFailures = 0;
  let memoryFailures = 0;

  if (!existsSync(queryPath)) {
    queryFailures += 1;
  } else {
    const queryData = JSON.parse(readFileSync(queryPath, 'utf8'));
    for (const item of queryData.queries || []) {
      const details = item.evaluation_details || item.details || {};
      if (hasInfrastructureFailure(item.model_output) || details.api_error) queryFailures += 1;
    }
  }

  if (!existsSync(memoryPath)) {
    memoryFailures += 1;
  } else {
    const memoryData = JSON.parse(readFileSync(memoryPath, 'utf8'));
    for (const unit of memoryData.units || []) {
      for (const item of unit.session_builds || []) {
        const build = item.build_result && typeof item.build_result === 'object' ? item.build_result : item;
        const extra = build.extra && typeof build.extra === 'object' ? build.extra : {};
        if (
          build.success === false
          || hasInfrastructureFailure(item.error)
          || hasInfrastructureFailure(build.error)
          || hasInfrastructureFailure(extra.error)
          || hasInfrastructureFailure(build.extraction_result)
        ) memoryFailures += 1;
      }
    }
  }

  return {
    valid: queryFailures === 0 && memoryFailures === 0,
    queryFailures,
    memoryFailures,
    failureCount: queryFailures + memoryFailures,
  };
}

function hasInfrastructureFailure(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return INFRASTRUCTURE_MARKERS.some(marker => text.includes(marker));
}

function aggregateCheckpoints(paths, name, resultPaths = []) {
  const out = emptyAggregate(name, '部分');
  const queryTimes = [];
  const candidatesByPersona = new Map();
  let newest = null;
  for (const path of paths) {
    let checkpoint;
    try { checkpoint = JSON.parse(readFileSync(path, 'utf8')); }
    catch { continue; }
    newest = !newest || String(checkpoint.updated_at || '') > newest ? String(checkpoint.updated_at || '') : newest;
    for (const [persona, rows] of Object.entries(checkpoint.completed_results || {})) {
      addPersonaCandidate(candidatesByPersona, persona, rows, path);
    }
  }
  for (const path of resultPaths) {
    let result;
    try { result = JSON.parse(readFileSync(path, 'utf8')); }
    catch { continue; }
    const personas = Object.keys(result.by_context || {});
    if (personas.length !== 1) continue;
    addPersonaCandidate(candidatesByPersona, personas[0], result.queries, path);
  }
  const selectedSources = [];
  for (const [persona, candidate] of candidatesByPersona.entries()) {
    selectedSources.push(candidate.path);
    for (const row of candidate.rows) {
        if (!Number.isFinite(Number(row.score))) continue;
        const task = String(row.query_type || '');
        const taskRow = out.byTask[task] || { total: 0, correct: 0, scoreSum: 0, avgScore: null, avgNcr: null, avgCrc: null, avgCc: null };
        taskRow.total += 1;
        taskRow.correct += row.is_correct === true ? 1 : 0;
        taskRow.scoreSum += Number(row.score);
        const details = row.details || {};
        if (task === 'multi_hop_clinical_deduction') {
          taskRow.ncrSum = Number(taskRow.ncrSum || 0) + Number(details.ncr_score || 0);
          taskRow.crcSum = Number(taskRow.crcSum || 0) + Number(details.crc_score || 0);
          taskRow.ccSum = Number(taskRow.ccSum || 0) + Number(details.cc_score || 0);
        }
        out.byTask[task] = taskRow;
        out.total += 1;
        out.correct += row.is_correct === true ? 1 : 0;
        out.scoreSum += Number(row.score);
        const retrievedCount = Math.min(Math.max(Number(row.retrieved_count || 0), 0), 5);
        out.retrievedMemoryCount += retrievedCount;
        out.retrievedMemoryCountByPersona[persona] = Number(out.retrievedMemoryCountByPersona[persona] || 0) + retrievedCount;
        out.answerOutputEstimatedTokens += estimateClinicalTextTokens(String(row.model_output || ''));
        const judgeTokens = estimatedJudgeTokens(task);
        if (judgeTokens) {
          out.llmJudgedQuestions += 1;
          out.estimatedJudgeTokens += judgeTokens;
        }
        if (Number.isFinite(Number(row.query_time))) queryTimes.push(Number(row.query_time));
    }
  }
  for (const [task, row] of Object.entries(out.byTask)) {
    row.avgScore = row.total ? row.scoreSum / row.total : null;
    if (task === 'multi_hop_clinical_deduction') {
      row.avgNcr = row.total ? Number(row.ncrSum || 0) / row.total : null;
      row.avgCrc = row.total ? Number(row.crcSum || 0) / row.total : null;
      row.avgCc = row.total ? Number(row.ccSum || 0) / row.total : null;
    }
  }
  out.avgScore = out.total ? out.scoreSum / out.total : null;
  out.accuracy = out.total ? out.correct / out.total : null;
  out.avgLatencyMs = queryTimes.length ? queryTimes.reduce((sum, value) => sum + value, 0) / queryTimes.length * 1000 : null;
  const mcd = out.byTask.multi_hop_clinical_deduction;
  out.avgNcr = mcd?.avgNcr ?? null;
  out.avgCrc = mcd?.avgCrc ?? null;
  out.avgCc = mcd?.avgCc ?? null;
  out.updatedAt = newest;
  out.expectedTotal = EXPECTED_TOTAL;
  out.sourcePaths = [...new Set(selectedSources)];
  return out;
}

function addPersonaCandidate(candidatesByPersona, persona, rows, path) {
  const validRows = (Array.isArray(rows) ? rows : []).filter(row => Number.isFinite(Number(row?.score)));
  const current = candidatesByPersona.get(String(persona));
  if (!current || validRows.length > current.rows.length) {
    candidatesByPersona.set(String(persona), { rows: validRows, path });
  }
}

function estimateLettaTokenUsage(paths, aggregate) {
  let recordedAgentTokens = 0;
  let recordedAgentCalls = 0;
  let summaryInputTokens = 0;
  let summaryCalls = 0;
  let successfulHttpCalls = 0;
  for (const path of paths) {
    let text;
    try { text = readFileSync(path, 'utf8'); }
    catch { continue; }
    for (const match of text.matchAll(/last response total_tokens \((\d+)\)/gu)) {
      recordedAgentTokens += Number(match[1]);
      recordedAgentCalls += 1;
    }
    for (const match of text.matchAll(/desired_token_count_to_summarize=(\d+)/gu)) {
      summaryInputTokens += Number(match[1]);
      summaryCalls += 1;
    }
    successfulHttpCalls += [...text.matchAll(/HTTP Request: POST .*chat\/completions .*200 OK/gu)].length;
  }
  const unattributedCalls = Math.max(successfulHttpCalls - recordedAgentCalls - summaryCalls, 0);
  const low = recordedAgentTokens + summaryInputTokens + summaryCalls * 500 + unattributedCalls * 2_500;
  const high = recordedAgentTokens + summaryInputTokens + summaryCalls * 1_500 + unattributedCalls * 8_000;
  const mid = Math.round((low + high) / 2);
  return {
    kind: 'letta_runtime_log_estimate',
    totalTokensLow: Math.round(low),
    totalTokensHigh: Math.round(high),
    totalTokensMid: mid,
    avgTokensLow: aggregate.total ? Math.round(low / aggregate.total) : null,
    avgTokensHigh: aggregate.total ? Math.round(high / aggregate.total) : null,
    avgTokensPerQuestion: aggregate.total ? Math.round(mid / aggregate.total) : null,
    recordedAgentTokens,
    recordedAgentCalls,
    summaryCalls,
    successfulHttpCalls,
    unattributedCalls,
  };
}

function estimateAmemTokenUsage(paths, aggregate) {
  let noteCount = 0;
  let linkedNoteCount = 0;
  let memoryLow = 0;
  let memoryHigh = 0;
  let totalNoteTokens = 0;
  const avgNoteTokensByPersona = {};
  for (const path of paths) {
    let snapshot;
    try { snapshot = JSON.parse(readFileSync(path, 'utf8')); }
    catch { continue; }
    const notes = Array.isArray(snapshot.memories) ? snapshot.memories : [];
    const noteTokens = notes.map(note => estimateClinicalTextTokens(String(note.content || '')));
    const contextMatch = basename(path).match(/context-(\d+)\.snapshot\.json$/u);
    const persona = contextMatch?.[1];
    if (persona && noteTokens.length) {
      avgNoteTokensByPersona[persona] = noteTokens.reduce((sum, value) => sum + value, 0) / noteTokens.length;
    }
    totalNoteTokens += noteTokens.reduce((sum, value) => sum + value, 0);
    noteCount += notes.length;
    for (let index = 0; index < notes.length; index += 1) {
      const contentTokens = noteTokens[index];
      // Every note receives metadata analysis. All but the first note in a
      // context also receive one evolution decision over up to five neighbors.
      memoryLow += contentTokens + 360;
      memoryHigh += contentTokens + 360;
      if (!index) continue;
      const neighborTokens = noteTokens.slice(Math.max(0, index - 5), index).reduce((sum, value) => sum + value, 0);
      const evolutionCallTokens = contentTokens + neighborTokens + 550;
      memoryLow += evolutionCallTokens + 100;
      memoryHigh += evolutionCallTokens + 100;
      if (Array.isArray(notes[index].links) && notes[index].links.length) {
        linkedNoteCount += 1;
        // A non-empty link proves the conditional strengthen call occurred.
        memoryLow += evolutionCallTokens + 160;
        memoryHigh += evolutionCallTokens + 160;
        // The checkpoint does not retain whether UPDATE_NEIGHBOR also ran.
        // Treat zero versus one update call as the transparent estimate range.
        memoryHigh += evolutionCallTokens + 600;
      }
    }
  }
  const globalAvgNoteTokens = noteCount ? totalNoteTokens / noteCount : 0;
  let queryInputTokens = aggregate.total * 900;
  for (const [persona, count] of Object.entries(aggregate.retrievedMemoryCountByPersona || {})) {
    queryInputTokens += Number(count) * Number(avgNoteTokensByPersona[persona] || globalAvgNoteTokens);
  }
  const common = queryInputTokens + aggregate.answerOutputEstimatedTokens + aggregate.estimatedJudgeTokens;
  const low = Math.round(memoryLow + common);
  const high = Math.round(memoryHigh + common);
  const mid = Math.round((low + high) / 2);
  return {
    kind: 'amem_snapshot_estimate',
    totalTokensLow: low,
    totalTokensHigh: high,
    totalTokensMid: mid,
    avgTokensLow: aggregate.total ? Math.round(low / aggregate.total) : null,
    avgTokensHigh: aggregate.total ? Math.round(high / aggregate.total) : null,
    avgTokensPerQuestion: aggregate.total ? Math.round(mid / aggregate.total) : null,
    noteCount,
    linkedNoteCount,
    answerCalls: aggregate.total,
    judgeCalls: aggregate.llmJudgedQuestions,
  };
}

function estimateClinicalTextTokens(text) {
  // The stored MedMemory Chinese/English notes were sampled with cl100k_base:
  // their token/character ratio is about 1.06. This is an estimate, not usage.
  return Math.max(Math.round(String(text || '').length * 1.06), text ? 1 : 0);
}

function estimatedJudgeTokens(task) {
  if (task === 'temporal_localization') return 2_500;
  if (task === 'state_update') return 3_000;
  if (task === 'inference_generation') return 4_500;
  if (task === 'multi_hop_clinical_deduction') return 9_000;
  return 0;
}

function renderHtml(context) {
  const {
    methods,
    carePersonaRows,
    selectedExperiments,
    longContextPath,
    lettaPath,
    lettaCheckpointPaths,
    invalidLetta,
    amemCheckpointPaths,
    amemResultPaths,
    commit,
    branch,
    dirtyFiles,
    generatedAt,
  } = context;
  const care = methods[0];
  const resultRows = methods.map(method => `
    <tr class="${method.status === '部分' ? 'partial-row' : method.status === '无效' ? 'invalid-row' : ''}">
      <th>${escapeHtml(method.name)} ${statusBadge(method)}</th>
      ${TASKS.map(([task]) => scoreCell(method.byTask[task], method.status)).join('')}
      <td class="score avg">${percent(method.avgScore)}${method.status === '无效' ? `<span class="cell-sub">${method.integrity.failureCount} 条无效记录</span>` : ''}</td>
      <td>${method.total.toLocaleString('zh-CN')}${method.status === '部分' ? ` / ${EXPECTED_TOTAL}` : ''}</td>
    </tr>`).join('');
  const personaRows = carePersonaRows.map(row => `
    <tr>
      <th>Persona ${row.personaId}</th>
      ${TASKS.map(([task]) => scoreCell(row.byTask[task], '完整')).join('')}
      <td class="score avg">${percent(row.avgScore)}</td>
      <td>${row.total}</td>
    </tr>`).join('');
  const mcdRows = methods.map(method => `
    <tr class="${method.status === '无效' ? 'invalid-row' : ''}"><th>${escapeHtml(method.name)}${method.status === '无效' ? '（无效）' : ''}</th><td>${percent(method.avgNcr)}</td><td>${percent(method.avgCrc)}</td><td>${percent(method.avgCc)}</td><td>${method.byTask.multi_hop_clinical_deduction?.total ?? 0}${method.status === '部分' ? '（部分）' : ''}</td></tr>`).join('');
  const efficiencyRows = methods.map(method => `
    <tr class="${method.status === '无效' ? 'invalid-row' : ''}">
      <th>${escapeHtml(method.name)}${method.status === '无效' ? '（无效）' : ''}</th>
      <td>${method.total.toLocaleString('zh-CN')}${method.status === '部分' ? ` / ${EXPECTED_TOTAL}` : ''}</td>
      <td>${tokenAverageCell(method)}</td>
    </tr>`).join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CareHarness 当前系统实现与实验结果</title>
  <style>
    :root{--ink:#17233b;--muted:#64748b;--line:#dbe3ef;--panel:#fff;--bg:#f3f6fb;--blue:#2457d6;--blue-soft:#eaf0ff;--green:#12735b;--green-soft:#e7f7f1;--amber:#a95d00;--amber-soft:#fff2dc;--red:#a93b3b;--shadow:0 18px 45px rgba(32,55,91,.08)}
    *{box-sizing:border-box} html{scroll-behavior:smooth} body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}
    .wrap{max-width:1240px;margin:0 auto;padding:40px 28px 72px}.hero{background:linear-gradient(135deg,#132754,#285bdd 70%,#537be6);color:white;border-radius:24px;padding:38px 42px;box-shadow:var(--shadow)}
    .eyebrow{font-size:12px;letter-spacing:.16em;text-transform:uppercase;opacity:.78}.hero h1{font-size:34px;line-height:1.2;margin:10px 0 12px}.hero p{max-width:850px;margin:0;color:#e5ecff}.meta{display:flex;flex-wrap:wrap;gap:10px;margin-top:22px}.chip,.badge{display:inline-flex;align-items:center;border-radius:999px;padding:4px 10px;font-size:12px}.chip{background:rgba(255,255,255,.13);border:1px solid rgba(255,255,255,.2)}
    nav{display:flex;gap:8px;flex-wrap:wrap;margin:20px 0 0}nav a{color:#dfe8ff;text-decoration:none;border-bottom:1px dashed rgba(255,255,255,.45)}
    section{margin-top:24px;background:var(--panel);border:1px solid var(--line);border-radius:20px;padding:28px 30px;box-shadow:0 8px 25px rgba(32,55,91,.04)}h2{font-size:23px;margin:0 0 8px}h3{font-size:17px;margin:24px 0 8px}.lead,.note{color:var(--muted)}
    .flow{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin:22px 0}.flow .step{position:relative;background:#f8faff;border:1px solid #dce5f5;border-radius:14px;padding:15px 14px;min-height:106px}.flow .step:not(:last-child):after{content:"→";position:absolute;right:-12px;top:36%;z-index:2;width:20px;height:28px;text-align:center;color:var(--blue);font-weight:800;background:var(--panel)}.step b{display:block;color:var(--blue);margin-bottom:5px}.step small{display:block;color:var(--muted);line-height:1.5}
    .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.card{border:1px solid var(--line);border-radius:14px;padding:16px 18px;background:#fbfcff}.card h3{margin:0 0 5px}.card p{margin:0;color:var(--muted)}
    .table-wrap{overflow:auto;margin-top:16px;border:1px solid var(--line);border-radius:14px}table{width:100%;border-collapse:collapse;min-width:850px;background:white}th,td{padding:12px 13px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}thead th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;background:#f6f8fc;color:#506078;position:sticky;top:0}tbody tr:last-child th,tbody tr:last-child td{border-bottom:0}tbody tr:hover{background:#fbfdff}.score{font-variant-numeric:tabular-nums;white-space:nowrap}.avg{color:var(--blue);font-weight:800}.cell-sub{display:block;color:var(--muted);font-size:11px}.badge.complete{background:var(--green-soft);color:var(--green)}.badge.partial{background:var(--amber-soft);color:var(--amber)}.badge.invalid{background:#ffe5e5;color:var(--red)}.partial-row{background:#fffdf8}.invalid-row{background:#fff7f7}.invalid-row .score{text-decoration:line-through;color:#946969}
    .warning{margin-top:17px;border-left:4px solid var(--amber);background:var(--amber-soft);padding:13px 16px;border-radius:0 12px 12px 0;color:#754200}.audit{border-left-color:var(--red);background:#fff0f0;color:#772c2c}.ok{border-left-color:var(--green);background:var(--green-soft);color:#155c49}
    code{font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#eef2f8;padding:2px 5px;border-radius:5px;word-break:break-all}.sources{font-size:13px;color:var(--muted)}.sources li{margin:6px 0}.sources a{color:var(--blue)}
    details{border:1px solid var(--line);border-radius:12px;padding:11px 14px;margin-top:10px}summary{cursor:pointer;font-weight:650}.policy{display:grid;grid-template-columns:130px 1fr 1fr;gap:0;border:1px solid var(--line);border-radius:14px;overflow:hidden;margin-top:16px}.policy>div{padding:11px 13px;border-bottom:1px solid var(--line)}.policy>div:nth-last-child(-n+3){border-bottom:0}.policy .head{background:#f6f8fc;color:#506078;font-size:12px;font-weight:700}.policy .abbr{font-weight:800;color:var(--blue)}
    footer{text-align:center;color:var(--muted);font-size:12px;margin-top:24px}@media(max-width:850px){.wrap{padding:18px 12px 45px}.hero{padding:27px 22px}.hero h1{font-size:27px}section{padding:21px 17px}.grid{grid-template-columns:1fr}.flow{grid-template-columns:1fr}.flow .step:not(:last-child):after{content:"↓";right:50%;top:auto;bottom:-21px}.policy{grid-template-columns:85px 1fr}.policy .head:nth-child(3),.policy>div:nth-child(3n){display:none}}
  </style>
</head>
<body>
<main class="wrap">
  <header class="hero">
    <div class="eyebrow">MedMemoryBench · 当前工作区快照</div>
    <h1>CareHarness 当前系统实现与实验结果</h1>
    <p>本报告从当前代码、实验数据库和已冻结的 baseline 断点自动生成。完整结果与暂停时的部分结果严格分开；没有改写 Gold，也没有把未完成的 A‑Mem 当成最终成绩。</p>
    <div class="meta"><span class="chip">分支 ${escapeHtml(branch)}</span><span class="chip">Commit ${escapeHtml(commit)}</span><span class="chip">生成于 ${escapeHtml(formatDate(generatedAt))}</span><span class="chip">当前工作区改动 ${dirtyFiles.length} 项</span></div>
    <nav><a href="#architecture">系统结构</a><a href="#policy">动态 Policy</a><a href="#results">结果总表</a><a href="#persona">Persona 明细</a><a href="#audit">审计说明</a></nav>
  </header>

  <section id="architecture">
    <h2>1. 当前系统怎么工作</h2>
    <p class="lead">核心不是一次性把整个病历塞给回答模型，而是先构建可追溯的纵向 Memory Graph，再由动态 Action Policy 围绕当前问题逐步调查。</p>
    <div class="flow">
      <div class="step"><b>完整 dated Session</b><small>保持 Patient / Doctor 角色、时间与完整对话边界；Query、Gold、Judge metadata 不参与图构建。</small></div>
      <div class="step"><b>语义 Memory Node</b><small>代码先切完整 context unit；LLM Extractor 做最小必要改写，逐项绑定不可变来源。</small></div>
      <div class="step"><b>统一 Memory Graph</b><small>同一节点可有 BC/PE/PA/CS/CP/LO 多标签；显式更新与非因果关系形成可验证边。</small></div>
      <div class="step"><b>动态调查</b><small>Policy 每一步只看问题和当前信息，在 7 个 Worker 中选择下一步并生成本步指令。</small></div>
      <div class="step"><b>回答与官方评分</b><small>冻结最终证据包，使用真实官方题型对应的 Answer Prompt，再执行官方 metric / Judge。</small></div>
    </div>
    <div class="grid">
      <article class="card"><h3>Memory Node 与原文</h3><p>节点必须显式绑定同一 Turn/Role/Time 的 context unit。医学术语、药名、日期、数值、单位、否定和变化状态尽量逐字保留；<code>literal_supplement</code> 只补节点遗漏的最小原词片段，不重复附整段 Evidence。</p></article>
      <article class="card"><h3>图的结构</h3><p>Family 是同一节点的多标签索引，不复制事实。<code>co_observed</code> 只保留 Session 成员关系，不能作为推理边进入答案；持久推理只接受带来源支持、已验证、非因果臆测的边。</p></article>
      <article class="card"><h3>医生式起始视图</h3><p>先给模型一个 query-independent Patient Profile；最新 3 个 Session 以完整原文、无排序方式直接可见。Profile、recent Sessions 和历史检索池互斥，避免同一事实重复进入 Answer。</p></article>
      <article class="card"><h3>历史检索</h3><p>较老节点才参与动态搜索。检索组合字面词、数值、来源角色、Family、时间范围和本地 <code>BGE-small-zh-v1.5</code> embedding；精确日期内先按语义相关性排序再截取 top-k。</p></article>
      <article class="card"><h3>时间与 Refine</h3><p>只对明确说死的日期建立硬时间约束；相对日期由代码解析。Refine 形成后续 Search / Context / Trace 都必须遵守的永久边界，避免下一步重新召回已经排除的时间段。</p></article>
      <article class="card"><h3>断点与并发</h3><p>Memory Graph 可冻结复用，逐题结果写入 answer-frozen checkpoint；中断后从未完成问题继续。独立问题可并发；A‑Mem / Letta baseline 另有 checkpoint 和维度迁移保护。</p></article>
    </div>
  </section>

  <section id="policy">
    <h2>2. 动态 Action Policy</h2>
    <p class="lead">系统不会在 Query 解析阶段预先生成固定关键词、Family 权重或 Need Graph 槽位。题型分类器只看问题文本；预测题型决定调查策略，官方题型只决定最终 Answer Prompt 与评分协议。</p>
    <div class="policy">
      <div class="head">Worker</div><div class="head">实际作用</div><div class="head">何时使用</div>
      <div class="abbr">search</div><div>在完整历史图内做受约束的混合检索。</div><div>需要新的事实、时间点、数值或治疗节点。</div>
      <div class="abbr">context</div><div>补回命中节点所在 Session 的相邻语境。</div><div>单一节点缺少角色、指代或同次就诊上下文。</div>
      <div class="abbr">trace</div><div>沿已验证边和同因子版本链寻找最短路径。</div><div>需要纵向变化或多节点关系链。</div>
      <div class="abbr">assess</div><div>LLM 检查当前证据覆盖、冲突、缺口和 answer focus。</div><div>每轮召回后判断够不够，以及下一步调查方向。</div>
      <div class="abbr">refine</div><div>删除干扰项并把筛选条件写成永久边界。</div><div>候选过多、时间不符或最终上下文超限。</div>
      <div class="abbr">verify</div><div>验证来源、容量和最终节点/边可用性。</div><div>回答前的强制冻结检查。</div>
      <div class="abbr">answer</div><div>冻结最终包并交给真实题型 Answer Prompt。</div><div>证据已足够或预算耗尽后的安全终止。</div>
    </div>
    <h3>六类题型的公共策略合同</h3>
    <div class="table-wrap"><table><thead><tr><th>题型</th><th>调查重点</th><th>停止条件</th></tr></thead><tbody>
      <tr><th>EEM</th><td>一个目标实体；保留原词、类别、范围与单位。</td><td>唯一、来源可追溯的目标事实已找到。</td></tr>
      <tr><th>TLA</th><td>事件与日期成对；精确/相对/最早时间边界可执行。</td><td>一个事件—时间对准确回答问题方向。</td></tr>
      <tr><th>SUA</th><td>同一 factor 的 baseline、更新、执行和当前有效版本。</td><td>最新状态及使它成为当前状态的更新均可追溯。</td></tr>
      <tr><th>MQ</th><td>对每个选项独立检索和判断，最后合并后统一回答。</td><td>每个选项都有支持、反驳或确实未决的状态。</td></tr>
      <tr><th>IG</th><td>诊断/阶段、客观轨迹、真实治疗暴露、反应/失败、风险与约束。</td><td>形成紧凑的患者特异决策链并检查主要竞争解释。</td></tr>
      <tr><th>MCD</th><td>有日期的起点—中间—结局节点、相邻关系和必要的临床桥。</td><td>节点与关系形成完整链；病历不存在的机制明确标成临床推断。</td></tr>
    </tbody></table></div>
    <div class="warning">所有运行时 Prompt 的单一文本来源是 <code>src/prompts.js</code>；执行器只取用，不另存副本。当前图构建和调查仍会调用 LLM：Extractor、Family Tagger、Relation Classifier、Query Classifier、Policy、Assess、Answer，以及需要时的 Judge。</div>
  </section>

  <section id="results">
    <h2>3. 目前结果总表</h2>
    <p class="lead">分数均按 JSON/数据库中已经保存的 score 直接聚合，范围 0–100。MCD 的 Avg 使用官方 NCR/CRC/CC 综合 score；其分项见下一张表。</p>
    <div class="table-wrap"><table><thead><tr><th>系统</th>${TASKS.map(([, abbr]) => `<th>${abbr}</th>`).join('')}<th>Avg</th><th>已完成</th></tr></thead><tbody>${resultRows}</tbody></table></div>
    ${invalidLetta.status === '无效' ? `<div class="warning audit"><strong>Letta 旧结果是基础设施失败，不是有效 benchmark 成绩。</strong> 记忆构建错误 ${invalidLetta.integrity.memoryFailures} 次，查询错误 ${invalidLetta.integrity.queryFailures} 次。旧 4.81 分是错误文本被当作答案后产生的污染值，已从结果表移除。</div>` : ''}
    <div class="warning">Letta 当前行是暂停时冻结的 ${letta.total} / ${EXPECTED_TOTAL} 题断点快照；题型分布不均衡，因此不是最终成绩。</div>
    <div class="warning">A‑Mem 当前行是暂停时冻结的 ${amem.total} / ${EXPECTED_TOTAL} 题结果；每个 Persona 均采用已保存且完成题数最多的有效来源，仍不能与完整结果作最终优劣结论。</div>
    <h3>MCD 官方小分</h3>
    <div class="table-wrap"><table><thead><tr><th>系统</th><th>NCR · 节点覆盖率</th><th>CRC · 因果关系正确率</th><th>CC · 推理链完整性</th><th>MCD 数量</th></tr></thead><tbody>${mcdRows}</tbody></table></div>
    <h3>效率快照</h3>
    <div class="table-wrap"><table><thead><tr><th>系统</th><th>题数</th><th>平均每题 Token（记录/估算）</th></tr></thead><tbody>${efficiencyRows}</tbody></table></div>
    <p class="note">Long‑Context 按逐题重建的累计病历、128k 截断、Answer Prompt 和 Judge Prompt 估算：输入 47,352,428 Token，输出 88,184 Token，总计 47,440,612 Token，395 题平均 120,103 Token。共 ${LONG_CONTEXT_TOKEN_ESTIMATE.answerCalls} 次 Answer 和 ${LONG_CONTEXT_TOKEN_ESTIMATE.judgeCalls} 次 Judge 调用。Long‑Context 的 Memory Build 只在本地拼接与截断文本，不调用 LLM，因此该阶段计费 Token 为 0。</p>
  </section>

  <section id="persona">
    <h2>4. CareHarness 分 Persona 明细</h2>
    <p class="lead">当前完整实验使用 <code>qwen3.7-plus</code>，题型分类器控制 retrieval strategy，真实官方题型继续控制 Answer Prompt 和 metric。</p>
    <div class="table-wrap"><table><thead><tr><th>Persona</th>${TASKS.map(([, abbr]) => `<th>${abbr}</th>`).join('')}<th>Avg</th><th>题数</th></tr></thead><tbody>${personaRows}</tbody></table></div>
    <h3>Persona 主实验</h3>
    <div class="table-wrap"><table><thead><tr><th>Persona</th><th>题数</th><th>平均分</th><th>答题准确率</th><th>题型分类准确率</th><th>误分类数</th><th>失败</th></tr></thead><tbody>
      <tr><th>1</th><td>97</td><td>66.87</td><td>65.98%</td><td>76.29%</td><td>23</td><td>0</td></tr>
      <tr><th>3</th><td>100</td><td>72.35</td><td>70.00%</td><td>69.00%</td><td>31</td><td>0</td></tr>
      <tr><th>5</th><td>100</td><td>53.13</td><td>52.00%</td><td>70.00%</td><td>30</td><td>0</td></tr>
      <tr><th>7</th><td>98</td><td>64.50</td><td>64.29%</td><td>78.57%</td><td>21</td><td>0</td></tr>
      <tr><th>合计/均值</th><td><strong>395</strong></td><td><strong>64.19</strong></td><td><strong>63.04%</strong></td><td><strong>73.42%</strong></td><td><strong>105</strong></td><td><strong>0</strong></td></tr>
    </tbody></table></div>
    <h3>105 道误分类题的路由 A/B 对照</h3>
    <div class="table-wrap"><table><thead><tr><th>Persona</th><th>题数</th><th>错误分类路由</th><th>官方题型路由</th><th>分数变化</th><th>答对数变化</th></tr></thead><tbody>
      <tr><th>1</th><td>23</td><td>63.12</td><td>72.08</td><td><strong>+8.96</strong></td><td>14 → 16</td></tr>
      <tr><th>3</th><td>31</td><td>72.10</td><td>68.27</td><td><strong>-3.83</strong></td><td>20 → 21</td></tr>
      <tr><th>5</th><td>30</td><td>40.32</td><td>43.51</td><td><strong>+3.19</strong></td><td>11 → 12</td></tr>
      <tr><th>7</th><td>21</td><td>34.31</td><td>42.45</td><td><strong>+8.14</strong></td><td>7 → 8</td></tr>
      <tr><th>合计/均值</th><td><strong>105</strong></td><td><strong>53.49</strong></td><td><strong>56.87</strong></td><td><strong>+3.37</strong></td><td><strong>52 → 57</strong></td></tr>
    </tbody></table></div>
  </section>

  <section id="audit">
    <h2>5. 结果解释与审计边界</h2>
    <div class="warning audit"><strong>这些 Persona 1/3/5/7 不是严格 held-out。</strong> 当前 Student Policy 是从 MedMemoryBench Clean Persona 1–20 的 1,939 个合格问题上，由可读取 Question、Gold 与 Judge metadata 的离线 oracle teacher 聚合而来；运行时产物不保留单题文本、答案、Session ID 或患者事实，但同一 20 个 Persona 上的分数仍属于 training-set / oracle-assisted 结果。要报告泛化能力，必须另做 Persona held-out 或 leave-one-persona-out。</div>
    <div class="warning ok"><strong>运行时信息边界：</strong>Memory Graph 构建只读取截至可见 Session 的患者对话。Query Classifier 只看问题文本；retrieval Policy 看问题、Profile、recent Sessions 与已召回节点。Gold、Answer Explanation、required_patient_info、Judge nodes 和 trap 只在答案冻结后交给 scorer。</div>
    <details><summary>当前代码版本与工作区状态</summary><p>分支 <code>${escapeHtml(branch)}</code>，Commit <code>${escapeHtml(commit)}</code>。生成报告时存在 ${dirtyFiles.length} 项未提交工作区变化：</p><ul class="sources">${dirtyFiles.length ? dirtyFiles.map(item => `<li><code>${escapeHtml(item)}</code></li>`).join('') : '<li>无</li>'}</ul></details>
    <details><summary>本报告读取的实验记录</summary><ul class="sources">
      ${selectedExperiments.map(item => `<li>CareHarness Persona ${item.persona_id}: <code>${escapeHtml(item.id)}</code> · ${escapeHtml(item.created_at)}</li>`).join('')}
      <li>Long-Context: <code>${escapeHtml(relative(root, longContextPath))}</code></li>
      <li>Letta 旧无效结果: <code>${escapeHtml(relative(root, lettaPath))}</code></li>
      ${lettaCheckpointPaths.map(path => `<li>Letta 当前 checkpoint: <code>${escapeHtml(relative(root, path))}</code></li>`).join('')}
      ${amemCheckpointPaths.map(path => `<li>A‑Mem checkpoint: <code>${escapeHtml(relative(root, path))}</code></li>`).join('')}
      ${amemResultPaths.map(path => `<li>A‑Mem 完整 Persona 结果: <code>${escapeHtml(relative(root, path))}</code></li>`).join('')}
    </ul></details>
    <details><summary>关键实现文件</summary><ul class="sources">
      <li><a href="../src/prompts.js">src/prompts.js</a>：Extractor、Family、Relation、Policy、Assess、Answer、Judge Prompt 单一来源。</li>
      <li><a href="../src/medmemory-policy.js">src/medmemory-policy.js</a>：题型策略合同、分类器和离线 Student Policy provenance。</li>
      <li><a href="../src/investigation-workers.js">src/investigation-workers.js</a>：七个 Worker 的执行与状态转移。</li>
      <li><a href="../src/retrieval.js">src/retrieval.js</a>：结构化约束、字面与 embedding 混合排序。</li>
      <li><a href="../src/recent-session-context.js">src/recent-session-context.js</a> 与 <a href="../src/patient-profile.js">src/patient-profile.js</a>：短期原文窗口和 query-independent chart。</li>
      <li><a href="../src/medmemory-official.js">src/medmemory-official.js</a>：六类官方 metric 与 Judge 输出校验。</li>
      <li><a href="../src/experiment-resume.js">src/experiment-resume.js</a>：图与逐题断点续跑。</li>
    </ul></details>
  </section>
  <footer>CareHarness · 自动生成的本地只读报告 · ${escapeHtml(formatDate(generatedAt))}</footer>
</main>
</body>
</html>`;
}

function tokenAverageCell(method) {
  if (method.tokenEstimate) {
    const estimate = method.tokenEstimate;
    const average = estimate.avgTokensPerQuestion?.toLocaleString('zh-CN') ?? '—';
    if (estimate.kind === 'long_context') return average;
    const low = estimate.avgTokensLow?.toLocaleString('zh-CN') ?? '—';
    const high = estimate.avgTokensHigh?.toLocaleString('zh-CN') ?? '—';
    return `≈ ${average}<span class="cell-sub">估算范围 ${low}–${high}</span>`;
  }
  if (method.tokenUsageComplete === false) {
    return `不可用<span class="cell-sub">仅记录 ${method.recordedCallCount} 次调用</span>`;
  }
  return method.avgRecordedTokens == null
    ? '—'
    : Math.round(method.avgRecordedTokens).toLocaleString('zh-CN');
}

function scoreCell(row, status) {
  if (!row || !row.total) return '<td class="score">—<span class="cell-sub">0 题</span></td>';
  return `<td class="score">${percent(row.avgScore)}<span class="cell-sub">${row.total}${status === '部分' ? ' 题已完成' : ' 题'}</span></td>`;
}

function statusBadge(method) {
  if (method.status === '无效') return '<span class="badge invalid">基础设施失败</span>';
  const complete = method.status === '完整';
  return `<span class="badge ${complete ? 'complete' : 'partial'}">${complete ? '完整' : '已暂停'}</span>`;
}

function percent(value) {
  return value == null || !Number.isFinite(Number(value)) ? '—' : `${(Number(value) * 100).toFixed(2)}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function formatDate(value) {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'Asia/Shanghai' }).format(value);
}

function findNewest(start, matcher) {
  const candidates = [];
  walk(resolve(start, 'reports/official-baselines'), file => {
    if (matcher(basename(file))) candidates.push(file);
  });
  return candidates.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0] || null;
}

function walk(directory, visit) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path, visit);
    else if (entry.isFile()) visit(path);
  }
}

function safeGit(args) {
  try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
}
