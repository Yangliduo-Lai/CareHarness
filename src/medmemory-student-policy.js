import { INVESTIGATION_WORKER_SET_VERSION } from './careharness-actions.js';
import { sha256,stableJson } from './matched-utils.js';
import { MEDMEMORY_INVESTIGATION_STRATEGIES,MEDMEMORY_INVESTIGATION_STRATEGY_VERSION } from './prompts.js';
import { MEDMEMORY_BUILTIN_STUDENT_ARTIFACT } from './medmemory-student-policy-artifact.js';

export const MEDMEMORY_STUDENT_POLICY_RUNTIME_VERSION='medmemory-student-policy.runtime.v1-case-free-aggregate';
export const MEDMEMORY_MATCHED_RUNTIME_VERSION='careharness-investigation-runtime.v14-relevance-before-earliest';

const QUERY_TYPES=Object.freeze(Object.keys(MEDMEMORY_INVESTIGATION_STRATEGIES).sort());
const STUDENT_VERSION='medmemory-student-strategy-summary.v2-action-role-patterns';
const TEACHER_VERSION='medmemory-oracle-teacher.v2-auditable-trajectories';
const ACTIONS=new Set(['search_entity_evidence','search_temporal_evidence','trace_longitudinal_evidence','search_option_constraint_evidence','search_patient_decision_evidence','search_multi_visit_evidence','trace_longitudinal_relations','compare_option_constraints','connect_patient_decision_evidence','connect_multi_visit_evidence','infer_missing_mechanism_bridge','assess_unreachable_evidence_gap','verify_target_coverage','answer_from_verified_evidence']);
const EVIDENCE_ROLES=new Set(['entity_fact','temporal_event_anchor','longitudinal_state_observation','option_discriminator','option_constraint_evidence','patient_specific_decision_factor','patient_specific_anchor','multi_visit_fact_node','causal_chain_observation','patient_history_anchor','missing_mechanism_bridge']);
const REACHABILITY=new Set(['direct_state_candidate','paraphrase_candidate','raw_dialogue_only','infer_missing_mechanism_bridge','unreachable']);
const DECISION_CHECKS=new Set(['allergy','contraindication','interaction','longitudinal_update','preference','lifestyle','symptom_differential','dose_adjustment','dose_timing','monitoring','access','disease_stage','other_protocol_risk']);
const ROOT_KEYS=new Set(['version','runtime_eligible','source_teacher_version','source_teacher_hash','compiled_strategy_version','compiled_strategy_profile_hash','training_scope','query_types','artifact_hash']);
const SCOPE_KEYS=new Set(['clean_only','persona_count','holdout_persona_count','case_count','teacher_read_question_text','teacher_read_gold_and_judge_metadata','runtime_retains_question_text','runtime_retains_case_ids','runtime_retains_persona_ids','runtime_retains_patient_facts','runtime_retains_gold_or_judge_content']);
const TYPE_KEYS=new Set(['case_count','mean_target_count','mean_source_session_count','mean_oracle_step_count','reachability_rates','recommended_action_paths','recommended_evidence_role_patterns','action_evidence_role_patterns','decision_check_priors']);

export function medMemoryStrategyProfileHash(){
  return sha256(stableJson({version:MEDMEMORY_INVESTIGATION_STRATEGY_VERSION,profiles:MEDMEMORY_INVESTIGATION_STRATEGIES}));
}

export function validateMedMemoryStudentArtifact(value,{require_profile_match=true}={}){
  const artifact=plainObject(value,'student artifact');
  assertExactKeys(artifact,ROOT_KEYS,'student artifact');
  if(artifact.version!==STUDENT_VERSION||artifact.runtime_eligible!==true)throw new Error('Unsupported or runtime-ineligible MedMemory Student artifact');
  if(artifact.source_teacher_version!==TEACHER_VERSION||!hashLike(artifact.source_teacher_hash))throw new Error('MedMemory Student artifact has invalid Teacher provenance');
  if(artifact.compiled_strategy_version!==MEDMEMORY_INVESTIGATION_STRATEGY_VERSION)throw new Error('MedMemory Student artifact strategy version does not match runtime');
  if(!hashLike(artifact.compiled_strategy_profile_hash))throw new Error('MedMemory Student artifact lacks a strategy profile hash');
  if(require_profile_match&&artifact.compiled_strategy_profile_hash!==medMemoryStrategyProfileHash())throw new Error('MedMemory Student artifact strategy profiles do not match runtime');
  const scope=plainObject(artifact.training_scope,'training_scope');assertExactKeys(scope,SCOPE_KEYS,'training_scope');
  if(scope.clean_only!==true||!positive(scope.persona_count)||!nonnegative(scope.holdout_persona_count)||!positive(scope.case_count)||scope.teacher_read_question_text!==true||scope.teacher_read_gold_and_judge_metadata!==true||scope.runtime_retains_question_text!==false||scope.runtime_retains_case_ids!==false||scope.runtime_retains_persona_ids!==false||scope.runtime_retains_patient_facts!==false||scope.runtime_retains_gold_or_judge_content!==false)throw new Error('MedMemory Student artifact has an unsafe or incomplete training boundary');
  const types=plainObject(artifact.query_types,'query_types');if(stableJson(Object.keys(types).sort())!==stableJson(QUERY_TYPES))throw new Error('MedMemory Student artifact must contain exactly the six public query types');
  for(const type of QUERY_TYPES)validateTypeSummary(types[type],type);
  const body={...artifact};delete body.artifact_hash;
  if(!hashLike(artifact.artifact_hash)||sha256(stableJson(body))!==artifact.artifact_hash)throw new Error('MedMemory Student artifact hash mismatch');
  return clone(artifact);
}

export function medMemoryStudentPolicyFor(queryType,artifact=MEDMEMORY_BUILTIN_STUDENT_ARTIFACT){
  if(!artifact)return null;
  const student=validateMedMemoryStudentArtifact(artifact),type=String(queryType||''),summary=student.query_types[type];
  if(!summary)return null;
  return clone({version:MEDMEMORY_STUDENT_POLICY_RUNTIME_VERSION,query_type:type,student_artifact_hash:student.artifact_hash,aggregate_prior:summary});
}

export function withMedMemoryStudentPolicy(input,queryType,artifact=MEDMEMORY_BUILTIN_STUDENT_ARTIFACT){
  const prior=medMemoryStudentPolicyFor(queryType,artifact);return prior?{...input,offline_student_prior:prior}:input;
}

export function medMemoryStudentPolicyManifest(artifact=MEDMEMORY_BUILTIN_STUDENT_ARTIFACT){
  const strategyProfiles={version:MEDMEMORY_INVESTIGATION_STRATEGY_VERSION,content_hash:medMemoryStrategyProfileHash(),query_type_count:QUERY_TYPES.length};
  if(!artifact)return{status:'not_loaded',runtime_version:MEDMEMORY_STUDENT_POLICY_RUNTIME_VERSION,strategy_profiles:strategyProfiles,student_artifact:{version:null,artifact_hash:null},source_teacher_artifact:{version:null,artifact_hash:null},runtime_overlap:runtimeOverlap(),components:runtimeComponents()};
  const student=validateMedMemoryStudentArtifact(artifact);
  return{status:'loaded_builtin',runtime_version:MEDMEMORY_STUDENT_POLICY_RUNTIME_VERSION,strategy_profiles:strategyProfiles,student_artifact:{version:student.version,artifact_hash:student.artifact_hash},source_teacher_artifact:{version:student.source_teacher_version,artifact_hash:student.source_teacher_hash},compiled_strategy:{version:student.compiled_strategy_version,profile_hash:student.compiled_strategy_profile_hash},training_scope:{clean_only:student.training_scope.clean_only,persona_count:student.training_scope.persona_count,holdout_persona_count:student.training_scope.holdout_persona_count,case_count:student.training_scope.case_count},runtime_overlap:runtimeOverlap(),components:runtimeComponents()};
}

export function renderMedMemoryStudentPolicyArtifactModule(artifact){
  const student=validateMedMemoryStudentArtifact(artifact);
  return`// Generated by scripts/distill-medmemory-policy.mjs. Do not edit by hand.\n// This aggregate contains no case, question, Gold, Judge, patient, persona, or Session content.\nexport const MEDMEMORY_BUILTIN_STUDENT_ARTIFACT=Object.freeze(${JSON.stringify(student,null,2)});\n`;
}

function validateTypeSummary(value,type){
  const summary=plainObject(value,`query_types.${type}`);assertExactKeys(summary,TYPE_KEYS,`query_types.${type}`);
  for(const key of ['case_count','mean_target_count','mean_source_session_count','mean_oracle_step_count'])if(!nonnegative(summary[key]))throw new Error(`${type}.${key} must be finite and non-negative`);
  const rates=plainObject(summary.reachability_rates,`${type}.reachability_rates`);for(const [key,rate] of Object.entries(rates)){if(!REACHABILITY.has(key)||!unit(rate))throw new Error(`${type} has invalid reachability aggregate`);}
  validatePatterns(summary.recommended_action_paths,['actions'],'action path',item=>item.actions.every(action=>ACTIONS.has(action)));
  validatePatterns(summary.recommended_evidence_role_patterns,['evidence_roles'],'evidence role pattern',item=>item.evidence_roles.every(role=>EVIDENCE_ROLES.has(role)));
  validatePatterns(summary.action_evidence_role_patterns,['action','evidence_roles'],'action/evidence role pattern',item=>ACTIONS.has(item.action)&&item.evidence_roles.every(role=>EVIDENCE_ROLES.has(role)));
  validatePatterns(summary.decision_check_priors,['category'],'decision check prior',item=>DECISION_CHECKS.has(item.category));
}
function validatePatterns(value,fields,label,predicate){if(!Array.isArray(value)||value.length>12)throw new Error(`Invalid ${label} collection`);for(const item of value){const expected=new Set([...fields,'support']),object=plainObject(item,label);assertExactKeys(object,expected,label);if(Object.hasOwn(object,'actions')&&(!Array.isArray(object.actions)||!object.actions.length||object.actions.length>16||object.actions.some(action=>typeof action!=='string')))throw new Error(`Invalid ${label} actions`);if(Object.hasOwn(object,'evidence_roles')&&(!Array.isArray(object.evidence_roles)||object.evidence_roles.length>16||object.evidence_roles.some(role=>typeof role!=='string')))throw new Error(`Invalid ${label} evidence roles`);if(Object.hasOwn(object,'action')&&typeof object.action!=='string')throw new Error(`Invalid ${label} action`);if(Object.hasOwn(object,'category')&&typeof object.category!=='string')throw new Error(`Invalid ${label} category`);if(!positive(object.support)||!predicate(object))throw new Error(`Invalid ${label}`);}}
function runtimeOverlap(){return{public_query_type:true,aggregate_action_frequencies:true,aggregate_evidence_role_frequencies:true,aggregate_decision_check_frequencies:true,question_text:false,case_ids:false,persona_ids:false,patient_facts:false,gold_answers:false,judge_metadata:false,source_sessions:false,oracle_trajectories:false};}
function runtimeComponents(){return{matched_runtime_version:MEDMEMORY_MATCHED_RUNTIME_VERSION,worker_set_version:INVESTIGATION_WORKER_SET_VERSION};}
function assertExactKeys(value,allowed,label){const keys=Object.keys(value);for(const key of keys)if(!allowed.has(key))throw new Error(`${label} contains forbidden field ${key}`);for(const key of allowed)if(!Object.hasOwn(value,key))throw new Error(`${label} lacks required field ${key}`);}
function plainObject(value,label){if(!value||typeof value!=='object'||Array.isArray(value))throw new Error(`${label} must be an object`);return value;}
function hashLike(value){return/^[a-f0-9]{64}$/u.test(String(value||''));}
function positive(value){return Number.isInteger(Number(value))&&Number(value)>0;}
function nonnegative(value){return Number.isFinite(Number(value))&&Number(value)>=0;}
function unit(value){return Number.isFinite(Number(value))&&Number(value)>=0&&Number(value)<=1;}
function clone(value){return JSON.parse(JSON.stringify(value));}
