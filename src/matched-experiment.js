import { MATCHED_EVALUATION_MODE } from './careharness-contract.js';
import { MEDMEMORY_QUERY_METRICS } from './medmemory-official.js';
import { assertStaticCareHarnessMode, positiveInteger, sha256, stableJson } from './matched-utils.js';
import { medMemoryStudentPolicyManifest } from './medmemory-student-policy.js';
import { MEDMEMORY_INVESTIGATION_STRATEGY_PROVENANCE,MEDMEMORY_INVESTIGATION_STRATEGY_VERSION,PROMPTS } from './prompts.js';
import { RECENT_SESSION_WINDOW } from './recent-session-context.js';
import { PATIENT_PROFILE_VERSION } from './patient-profile.js';

export {
  assertNoHiddenRuntimeInput,
  buildAdaptiveInvestigationContext,
  buildDiagnosticInvestigationContext,
  fallbackInvestigationPolicyDecision,
  validateInvestigationPolicyDecision,
} from './matched-runtime.js';

export const MATCHED_EXPERIMENT_VERSION = 'medmemory-matched-experiment.v31-relevance-before-earliest';
export const MEDMEMORY_MATCHED_QUERY_TYPES = Object.freeze(Object.keys(MEDMEMORY_QUERY_METRICS));
const MEDMEMORY_MATCHED_QUERY_TYPE_SET = new Set(MEDMEMORY_MATCHED_QUERY_TYPES);

export function buildMatchedManifest({
  benchmark = 'medmemorybench',
  evaluation_mode = MATCHED_EVALUATION_MODE,
  noise,
  persona_id,
  split = 'dev',
  query_ids = [],
  query_types = [],
  expected_query_count = query_ids.length,
  adapter_query_count = expected_query_count,
  memory_snapshot,
  memory_pipeline_version,
  models,
  seed = 42,
  candidate_budget = 24,
  investigation_budget = 6,
  query_concurrency = 4,
  strict_full_suite = true,
  action_policy_learning = {enabled:false},
  action_policy_exploration = {enabled:false,rate:0,seed:0,training_only:true},
}) {
  if (benchmark !== 'medmemorybench') {
    throw new Error('Matched inference-time loop currently supports MedMemoryBench only');
  }
  assertStaticCareHarnessMode(evaluation_mode);
  const normalizedSplit = String(split || 'dev').toLowerCase();
  const normalizedPersona = Number(persona_id || 1);
  const selectedQueryTypes = normalizeMatchedQueryTypes(query_types);
  assertDirectedQueryScope({ query_types: selectedQueryTypes, split: normalizedSplit, persona_id: normalizedPersona });
  validateMemorySnapshot(memory_snapshot, memory_pipeline_version);

  const expectedCount = positiveInteger(expected_query_count, 'expected_query_count');
  const adapterCount = positiveInteger(adapter_query_count, 'adapter_query_count');
  const strictFullSuite = strict_full_suite !== false;
  validateQueryScope({ query_ids, expectedCount, adapterCount, strictFullSuite });
  const publicModels = normalizeModels(models);
  validateFrozenModels(publicModels);
  const normalizedInvestigationBudget = positiveInteger(investigation_budget, 'investigation_budget');
  const offlineStudentPolicy=medMemoryStudentPolicyManifest();

  const body = {
    version: MATCHED_EXPERIMENT_VERSION,
    benchmark,
    evaluation_mode,
    split: normalizedSplit,
    persona_id: normalizedPersona,
    noise: Boolean(noise),
    query_count: query_ids.length,
    expected_query_count: expectedCount,
    adapter_query_count: adapterCount,
    query_selection_policy: selectedQueryTypes.length ? 'dev_query_type_subset_complete' : 'adapter_complete_scope',
    query_types: selectedQueryTypes,
    strict_full_suite: strictFullSuite,
    query_ids: [...query_ids].map(String).sort(),
    memory_snapshot: {
      pipeline_version: memory_pipeline_version,
      fingerprint: String(memory_snapshot.fingerprint),
      memory_node_count: Number(memory_snapshot.memory_node_count),
      edge_count: Number(memory_snapshot.edge_count),
      complete_through_session: Number(memory_snapshot.complete_through_session || memory_snapshot.required_through_session || 0),
    },
    models: publicModels,
    seed: Number(seed),
    temperatures: Object.fromEntries(Object.entries(publicModels).filter(([,value])=>value.temperature!=null).map(([key, value]) => [key, value.temperature])),
    prompt_versions: {
      memory_extractor: PROMPTS.extractor.version,
      memory_relation_classifier: PROMPTS.relation_classifier.version,
      investigation_policy: PROMPTS.investigation_policy.version,
      relation_evaluator: PROMPTS.careharness_evaluate.version,
      answer: PROMPTS.medmemory_answer.version,
      scoring_judge: PROMPTS.medmemory_judge.version,
      investigation_strategy: MEDMEMORY_INVESTIGATION_STRATEGY_VERSION,
    },
    policy_artifacts: {
      offline_student: offlineStudentPolicy,
    },
    budgets: {
      candidate_budget: positiveInteger(candidate_budget, 'candidate_budget'),
      investigation_budget: normalizedInvestigationBudget,
      investigation_policy_call_budget: normalizedInvestigationBudget + 1,
      relation_evaluator_call_budget: 2,
      relation_edge_budget: 10,
      semantics: budgetSemantics(),
    },
    scheduling: {
      query_concurrency: positiveInteger(query_concurrency, 'query_concurrency'),
      independent_queries_parallel: true,
      per_query_dependency_order: ['investigation', 'answer', 'judge'],
      result_order: 'adapter_query_order',
    },
    information_policy: { runtime_gold_or_judge_metadata_allowed: false, post_answer_offline_diagnosis_allowed: true,public_query_type_strategy_profiles:true,strategy_profiles_contain_case_content:false,oracle_teacher_runtime_separated:true,offline_strategy_teacher:{...MEDMEMORY_INVESTIGATION_STRATEGY_PROVENANCE},offline_student_policy_status:offlineStudentPolicy.status,offline_student_runtime_overlap:offlineStudentPolicy.runtime_overlap,deterministic_question_temporal_gate:true,persistent_refine_boundary:true,hybrid_lexical_embedding_search:true,embedding_respects_structured_constraints:true,semantic_shortest_path_trace:true,state_update_answer_selected_memory_only:true,state_update_answer_excludes_assessor_artifacts:true,state_projection_conservative_refine:true,relative_date_documentation_lag_days:30,patient_profile_version:PATIENT_PROFILE_VERSION,patient_profile_query_independent:true,patient_profile_unranked:true,patient_profile_includes_recent_navigation:false,patient_profile_recent_sessions_disjoint:true,profile_backing_nodes_excluded_from_retrieval:true,recent_session_window:RECENT_SESSION_WINDOW,recent_sessions_unranked:true,historical_memory_only_investigation:true,answer_memory_edges_persistent_verified_source_grounded:true,query_time_connections_are_graph_facts:false },
    action_policy_learning,
    action_policy_exploration,
    method_claims: {
      persistent_unified_memory_graph: true,
      policy_owned_investigation_state: true,
      static_query_preanalysis: false,
      transparent_query_type_adaptation: true,
      extensible_worker_registry: true,
      strict_causality_claimed: false,
      learned_policy_claimed: action_policy_learning?.enabled===true,
      offline_student_policy_loaded: offlineStudentPolicy.status==='loaded_builtin',
    },
  };
  return { ...body, manifest_hash: sha256(stableJson(body)) };
}

export function selectMatchedQueryCases(cases = [], {
  benchmark = 'medmemorybench', split = 'dev', persona_id = 1, query_types = [],
} = {}) {
  if (benchmark !== 'medmemorybench') {
    throw new Error('Directed matched query selection supports MedMemoryBench only');
  }
  const selectedQueryTypes = normalizeMatchedQueryTypes(query_types);
  assertDirectedQueryScope({ query_types: selectedQueryTypes, split, persona_id });
  const selected = selectedQueryTypes.length
    ? cases.filter(item => selectedQueryTypes.includes(String(item?.task || item?.query_type || '')))
    : [...cases];
  return {
    cases: selected,
    query_types: selectedQueryTypes,
    query_selection_policy: selectedQueryTypes.length ? 'dev_query_type_subset_complete' : 'adapter_complete_scope',
    adapter_query_count: cases.length,
    expected_query_count: selected.length,
  };
}

export function normalizeMatchedQueryTypes(value = []) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error('query_types must be an array');
  const normalized = value.map(item => String(item || '').normalize('NFKC').trim().toLowerCase());
  if (normalized.some(item => !item || !MEDMEMORY_MATCHED_QUERY_TYPE_SET.has(item))) {
    throw new Error(`query_types must use MedMemoryBench types: ${MEDMEMORY_MATCHED_QUERY_TYPES.join(', ')}`);
  }
  if (new Set(normalized).size !== normalized.length) throw new Error('query_types must not contain duplicates');
  return MEDMEMORY_MATCHED_QUERY_TYPES.filter(type => normalized.includes(type));
}

export function careHarnessResultRows(experiments = []) {
  return experiments.map(experiment => {
    const scores = (experiment.results || []).filter(item => item.kind === 'score' && item.status === 'scored');
    const byTask = {};
    for (const item of scores) (byTask[item.task] ||= []).push(Number(item.score));
    const manifest = experiment.config?.matched_manifest || null;
    return {
      manifest_hash: manifest?.manifest_hash || null,
      runtime: experiment.config?.evaluation_mode || MATCHED_EVALUATION_MODE,
      split: manifest?.split || null,
      noise: Boolean(experiment.config?.noise),
      query_count: scores.length,
      query_selection_policy: manifest?.query_selection_policy || null,
      query_types: manifest?.query_types || [],
      strict_full_suite: manifest?.strict_full_suite === true,
      score: average(scores.map(item => Number(item.score))),
      by_task: Object.fromEntries(Object.entries(byTask).map(([task, values]) => [task, average(values)])),
      mock: scores.some(item => item.mock === true),
      reproducible: Boolean(manifest?.manifest_hash),
    };
  });
}

function validateMemorySnapshot(memorySnapshot, memoryPipelineVersion) {
  if (memoryPipelineVersion !== 'unified-memory-graph-v17-semantic-source-anchors') {
    throw new Error('Matched experiments require an exact v17 semantic-source-anchored unified Memory Graph snapshot');
  }
  const validCounts = ['memory_node_count', 'edge_count']
    .every(key => Number.isInteger(Number(memorySnapshot?.[key])));
  if (!memorySnapshot?.fingerprint || !validCounts) {
    throw new Error('Matched experiments require a frozen Memory Graph fingerprint and node/edge counts');
  }
}

function validateQueryScope({ query_ids, expectedCount, adapterCount, strictFullSuite }) {
  if (expectedCount > adapterCount) throw new Error('Matched expected_query_count cannot exceed adapter_query_count');
  if (strictFullSuite && query_ids.length !== expectedCount) {
    throw new Error(`Matched strict query scope requires all ${expectedCount} selected queries, found ${query_ids.length}`);
  }
  if (new Set(query_ids.map(String)).size !== query_ids.length) {
    throw new Error('Matched experiment query_ids must be unique');
  }
}

function validateFrozenModels(models) {
  if (!models.answer || !models.scoring_judge || !models.investigation_policy || !models.embedding) {
    throw new Error('Matched experiments must freeze Answer Model, Scoring Judge, Investigation Policy, and local Embedding Model');
  }
  if (stableJson(models.relation_evaluator) !== stableJson(models.answer)) {
    throw new Error('Matched experiments require relation_evaluator to use exactly the Answer Model configuration');
  }
}

function assertDirectedQueryScope({ query_types, split, persona_id }) {
  if (query_types.length && (String(split || 'dev').toLowerCase() !== 'dev' || Number(persona_id || 1) !== 1)) {
    throw new Error('Directed query_types are allowed only for Persona 1 dev evaluation');
  }
}

function normalizeModels(models = {}) {
  const answer = models.answer || models.judge || models.global;
  const aliases = {
    answer,
    relation_evaluator: models.relation_evaluator || answer,
    scoring_judge: models.scoring_judge || models.global,
    investigation_policy: models.investigation_policy || models.global,
    embedding: models.embedding,
  };
  const normalized = {};
  for (const [key, value] of Object.entries(aliases)) {
    if (!value) continue;
    normalized[key] = key==='embedding'?{
      provider:value.provider||'local',
      model:value.model||null,
      base_model:value.base_model||null,
      pooling:value.pooling||'cls',
      normalized:value.normalized!==false,
    }:{
      provider: value.provider || null,
      base_url: value.base_url || '',
      model: value.model || null,
      temperature: Number(value.temperature ?? 0),
      max_tokens: Number(value.max_tokens ?? 1200),
      context_length: value.context_length ?? null,
    };
  }
  return normalized;
}

function budgetSemantics() {
  return {
    candidates: 'maximum unified Memory Nodes in current information',
    actions: 'policy selects one registered worker after each observed result; non-terminal workers consume budget',
    investigation_policy: 'one bounded transparent type-adaptive policy call per decision; no case answer or Judge metadata',
    relation_evaluator: 'called only when the policy selects the semantic evaluation worker',
  };
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}
