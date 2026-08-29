import { MEMORY_FAMILIES } from './schema.js';

export const CAREHARNESS_METHOD_CONTRACT_VERSION='careharness-method-contract.v11-semantic-source-anchored';
export const MATCHED_EVALUATION_MODE='static_careharness';
export const CAREHARNESS_MEMORY_FAMILIES=Object.freeze({BC:'Background and Context',PE:'Patient Experience',PA:'Patient Adaptation',CS:'Clinical State',CP:'Care Plan',LO:'Longitudinal Outcome'});

export const CAREHARNESS_METHOD_CONTRACT=deepFreeze({
  version:CAREHARNESS_METHOD_CONTRACT_VERSION,
  memory:{representation:'single_atomic_versioned_memory_graph',node_representation:'source_anchored_semantic_state',families:CAREHARNESS_MEMORY_FAMILIES,duplicate_fact_layers:false,coverage_role:'bounded_complete-unit_fallback_only',session_membership:'episode_hyperedge_metadata',persistent_edges_are_noncausal:true,co_observed_is_reasoning_edge:false},
  question_boundary:{representation:'verbatim_question_plus_public_task_strategy',static_query_analysis:false,public_task_label_allowed:true,task_strategy_contains_case_content:false,generated_keywords:false,generated_family_priorities:false,generated_time_constraints:false,generated_relation_targets:false,generated_node_slots:false},
  investigation:{representation:'policy_owned_closed_loop',state:'question + current information + prior worker results + remaining budget',worker_registry:'extensible_capability_descriptors',worker_instruction:'step_local_and_opaque_to_orchestrator',decision_strategy:'smallest_unresolved_aspect_then_reassess',fixed_worker_sequence:false,workers_may_repeat:true,policy_reassesses_after_every_result:true},
  policy:{implementation:'llm_guided_transparent_type_adaptive_closed_loop',decision_model:'configured_investigation_policy_model',deterministic_failure_fallback:true},
  answer_boundary:{separate_answer_model:true,receives_frozen_investigation_information:true},
  provenance:{runtime_gold_or_judge_metadata_allowed:false,offline_post_answer_diagnosis_allowed:true},
  architecture_claims:{persistent_memory_graph:true,strict_causality_claimed:false,learned_runtime_policy:false,offline_oracle_teacher_separated:true},
});

export function validateCareHarnessMethodContract(contract=CAREHARNESS_METHOD_CONTRACT){
  const errors=[];
  if(JSON.stringify(Object.keys(contract?.memory?.families||{}))!==JSON.stringify(MEMORY_FAMILIES))errors.push('Memory families must be exactly BC / PE / PA / CS / CP / LO');
  if(contract?.memory?.representation!=='single_atomic_versioned_memory_graph'||contract?.memory?.node_representation!=='source_anchored_semantic_state'||contract?.memory?.duplicate_fact_layers!==false)errors.push('memory must use one source-anchored semantic graph without duplicate fact layers');
  if(contract?.memory?.coverage_role!=='bounded_complete-unit_fallback_only'||contract?.memory?.session_membership!=='episode_hyperedge_metadata'||contract?.memory?.co_observed_is_reasoning_edge!==false)errors.push('memory must keep complete-unit fallback and Session membership separate from reasoning edges');
  if(contract?.question_boundary?.representation!=='verbatim_question_plus_public_task_strategy'||contract?.question_boundary?.static_query_analysis!==false||contract?.question_boundary?.public_task_label_allowed!==true||contract?.question_boundary?.task_strategy_contains_case_content!==false)errors.push('the Question Request boundary must preserve the question and expose only a transparent case-free task strategy');
  for(const key of['generated_keywords','generated_family_priorities','generated_time_constraints','generated_relation_targets','generated_node_slots'])if(contract?.question_boundary?.[key]!==false)errors.push(`question boundary must not provide ${key}`);
  if(contract?.investigation?.representation!=='policy_owned_closed_loop'||contract?.investigation?.worker_registry!=='extensible_capability_descriptors'||contract?.investigation?.decision_strategy!=='smallest_unresolved_aspect_then_reassess'||contract?.investigation?.fixed_worker_sequence!==false||contract?.investigation?.policy_reassesses_after_every_result!==true)errors.push('investigation must be an extensible policy-owned closed loop');
  if(contract?.policy?.implementation!=='llm_guided_transparent_type_adaptive_closed_loop'||contract?.policy?.decision_model!=='configured_investigation_policy_model')errors.push('investigation policy must be configured, LLM-guided, and transparently type-adaptive');
  if(contract?.provenance?.runtime_gold_or_judge_metadata_allowed!==false)errors.push('Gold/Judge metadata must never enter runtime inputs');
  if(contract?.architecture_claims?.persistent_memory_graph!==true||contract?.architecture_claims?.strict_causality_claimed!==false||contract?.architecture_claims?.learned_runtime_policy!==false||contract?.architecture_claims?.offline_oracle_teacher_separated!==true)errors.push('architecture claims are inconsistent');
  if(errors.length)throw new Error(`CareHarness method contract violation: ${errors.join('; ')}`);
  return contract;
}

function deepFreeze(value){if(!value||typeof value!=='object'||Object.isFrozen(value))return value;for(const child of Object.values(value))deepFreeze(child);return Object.freeze(value);}
