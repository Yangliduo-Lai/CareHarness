import { createHash } from 'node:crypto';
import { existsSync,readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  MEDLOCOMO_EMBEDDING_BASE_MODEL,
  MEDLOCOMO_EMBEDDING_BASE_MODEL_REVISION,
  MEDLOCOMO_EMBEDDING_CHUNK_TURNS,
  MEDLOCOMO_EMBEDDING_DIMENSION,
  MEDLOCOMO_EMBEDDING_MODEL,
  MEDLOCOMO_EMBEDDING_MODEL_REVISION,
  MEDLOCOMO_EMBEDDING_SNAPSHOT_FILE_HASHES,
  MEDLOCOMO_EMBEDDING_SNAPSHOT_HASH,
} from './embedding-retrieval.js';
import { assertNoHiddenBenchmarkInput } from './information-boundary.js';
import { LEARNED_ACTION_PRIOR_ADVICE } from './prompts.js';

export const ACTION_POLICY_MODEL_VERSION='careharness-action-value-model.v4-hierarchical-relative-return';
export const MEDLOCOMO_ACTION_POLICY_MODEL_VERSION='careharness-medlocomo-action-value-model.v3-counterfactual-graph-rollout';
export const MEDLOCOMO_ACTION_POLICY_DEFAULT_PATH='data/medlocomo-hierarchical-distillation/graph-action-policy-97train-4validation.json';
const MEDLOCOMO_ACTION_POLICY_MODEL_VERSIONS=new Set([
  MEDLOCOMO_ACTION_POLICY_MODEL_VERSION,
  'careharness-medlocomo-action-value-model.v2-counterfactual-graph-rollout',
]);
const MEDLOCOMO_FIXED_VALIDATION_COMMITMENT='166669200359c91649418b44453686a9a0a867e2e622001e4cc8666b81393912';
const MEDLOCOMO_FIXED_VALIDATION_PATIENT_COUNT=4;
const MEDLOCOMO_FIXED_VALIDATION_CASE_COUNT=516;
const MEDLOCOMO_FIXED_VALIDATION_EXACT_TURN_CASE_COUNT=258;
const MEDLOCOMO_EMBEDDING_RUNTIME_CONTRACT=Object.freeze({provider:'local',model:MEDLOCOMO_EMBEDDING_MODEL,model_revision:MEDLOCOMO_EMBEDDING_MODEL_REVISION,model_revision_verification:'local_snapshot_sha256',base_model:MEDLOCOMO_EMBEDDING_BASE_MODEL,base_model_revision:MEDLOCOMO_EMBEDDING_BASE_MODEL_REVISION,snapshot_hash:MEDLOCOMO_EMBEDDING_SNAPSHOT_HASH,snapshot_file_hashes:MEDLOCOMO_EMBEDDING_SNAPSHOT_FILE_HASHES,normalized:true,dimension:MEDLOCOMO_EMBEDDING_DIMENSION,admission_chunk_turn_count:MEDLOCOMO_EMBEDDING_CHUNK_TURNS});
const LEGACY_ACTION_POLICY_MODEL_VERSIONS=new Set([
  'careharness-action-value-model.v2-relative-return',
  'careharness-action-value-model.v3-query-type-relative-return',
]);
export const ACTION_POLICY_PRIOR_VERSION='careharness-action-value-prior.v1';
export const ACTION_EXPLORATION_VERSION='careharness-safe-action-exploration.v1';
const DISCOVERY_WORKERS=new Set(['search','context','trace']);

/**
 * Build a case-free control state. Public query type may be a feature, while
 * question text, retrieved clinical text, Gold and Judge metadata never are.
 * The learned component can prefer an operation for a task contract, but
 * cannot memorize what to retrieve or what answer to produce.
 */
export function abstractActionPolicyState(input={}){
  const information=input.current_information||{},steps=array(input.previous_steps),assessment=information.assessment||null,verification=information.verification||null,last=steps.at(-1)||null,nodeCount=array(information.memory_nodes).length,missingCount=array(assessment?.missing_information).filter(Boolean).length,discoveryCount=steps.filter(step=>DISCOVERY_WORKERS.has(String(step?.worker||''))).length,assessmentCount=steps.filter(step=>step?.worker==='assess').length;
  return{
    query_type:normalizeQueryType(input.query_type||information.strategy_profile?.query_type),
    node_count:bucket(nodeCount,[0,4,12],['none','small','medium','large']),
    assessment:assessmentStatus(assessment),
    missing_count:bucket(missingCount,[0,1,2],['none','one','two','many']),
    verification:verificationStatus(verification),
    last_worker:String(last?.worker||information.worker_state?.last_worker||'none'),
    last_changed:last?changeStatus(last.changed):'none',
    stalled_discovery:bucket(noProgressDiscoveryStreak(steps),[0,1],['none','one','repeated']),
    discovery_count:bucket(discoveryCount,[0,1,2],['none','one','two','many']),
    assessment_count:bucket(assessmentCount,[0,1],['none','one','repeated']),
    remaining_budget:bucket(Number(input.remaining_budget||0),[1,3,6],['last','low','medium','high']),
    has_profile:Number(information.patient_profile?.item_count||0)>0,
    has_recent_sessions:array(information.recent_sessions).length>0,
  };
}

export function actionPolicyStateKey(input={}){return serializeState(abstractActionPolicyState(input));}

/**
 * MedLoCoMo uses a separately trained control state.  It contains only values
 * observable by the live policy after each worker call; official Evidence,
 * Gold, Patient/QA identity and source IDs are deliberately absent.
 */
export function abstractMedLoCoMoActionPolicyState(input={}){
  const information=input.current_information||{},steps=array(input.previous_steps),assessment=information.assessment||null,verification=information.verification||null,last=steps.at(-1)||null,nodes=array(information.memory_nodes),episodes=new Set(nodes.map(node=>String(node?.episode_id||'')).filter(Boolean)),signal=information.worker_state||{},discoveryCount=steps.filter(step=>DISCOVERY_WORKERS.has(String(step?.worker||''))).length,assessmentCount=steps.filter(step=>step?.worker==='assess').length;
  return{
    query_type:normalizeQueryType(input.query_type||information.strategy_profile?.query_type),
    node_count:bucket(nodes.length,[0,4,12,24],['none','small','medium','bounded','overflow']),
    episode_count:bucket(episodes.size,[0,1,2,4],['none','one','two','several','many']),
    assessment:assessmentStatus(assessment),
    missing_count:bucket(array(assessment?.missing_information).filter(Boolean).length,[0,1,2],['none','one','two','many']),
    verification:verificationStatus(verification),
    last_worker:String(last?.worker||signal.last_worker||'none'),
    last_changed:last?changeStatus(last.changed):'none',
    stalled_discovery:bucket(noProgressDiscoveryStreak(steps),[0,1],['none','one','repeated']),
    discovery_count:bucket(discoveryCount,[0,1,2],['none','one','two','many']),
    assessment_count:bucket(assessmentCount,[0,1],['none','one','repeated']),
    candidate_count:bucket(Number(signal?.candidate_count??signal?.trace?.candidate_count??0),[0,8,24,48],['none','few','bounded','many','very_many']),
    selected_episode_count:bucket(Number(signal?.selected_episode_count??signal?.trace?.selected_episode_count??episodes.size),[0,1,2,4],['none','one','two','several','many']),
    remaining_budget:bucket(Number(input.remaining_budget||0),[1,3,6],['last','low','medium','high']),
  };
}

export function medLoCoMoActionPolicyStateKey(input={}){return serializeState(abstractMedLoCoMoActionPolicyState(input));}

/** Load an explicitly requested policy artifact. Nothing is auto-discovered. */
export function loadActionPolicyModel(path,{expected_benchmark=null}={}){
  const artifactPath=resolve(String(path||''));
  if(!String(path||'').trim())throw new Error('Action-policy artifact path is required');
  let model;
  try{model=JSON.parse(readFileSync(artifactPath,'utf8'));}
  catch(error){throw new Error(`Cannot load action-policy artifact ${artifactPath}: ${String(error?.message||error)}`);}
  validateActionPolicyModel(model);
  if(expected_benchmark&&model.training_scope?.benchmark!==expected_benchmark)throw new Error(`Action-policy artifact benchmark must be ${expected_benchmark}`);
  return model;
}

/** Probe the fixed default without turning a rejected candidate into runtime control. */
export function loadDefaultMedLoCoMoActionPolicy({path=MEDLOCOMO_ACTION_POLICY_DEFAULT_PATH}={}){
  const artifactPath=resolve(path);
  if(!existsSync(artifactPath))return{status:'not_found',path:artifactPath,model:null,model_hash:null,execution:null,reason:'artifact_not_found'};
  try{
    const model=loadActionPolicyModel(artifactPath,{expected_benchmark:'medlocomo'}),greedy=medLoCoMoActionPolicyAcceptance(model),advisory=medLoCoMoActionPolicyAdvisoryAcceptance(model);
    if(greedy.accepted)return{status:'loaded',path:artifactPath,model,model_hash:model.model_hash,execution:'greedy_worker',reason:'accepted'};
    if(advisory.accepted)return{status:'loaded',path:artifactPath,model,model_hash:model.model_hash,execution:'advisory',reason:'experimental_advisory'};
    return{status:'rejected',path:artifactPath,model:null,model_hash:model.model_hash,execution:null,reason:advisory.reason};
  }catch(error){return{status:'rejected',path:artifactPath,model:null,model_hash:null,execution:null,reason:`invalid_artifact: ${String(error?.message||error)}`};}
}

export function learnActionPolicyModel(experiments=[],options={}){
  const rows=[],trajectories=[],trainingHashes=[],trainingPersonas=new Set(),trainingSplits=new Set(),exclusionCounts={non_score_result:0,judge_infrastructure_failure:0,memory_incomplete:0,unscored_or_non_numeric:0,incomplete_or_invalid_trajectory:0};
  for(const experiment of array(experiments)){
    validateTrainingExperiment(experiment);
    trainingPersonas.add(Number(experiment.config?.persona_id));trainingSplits.add(String(experiment.config?.split||'dev'));
    trainingHashes.push(hashIdentifier(experiment.id||JSON.stringify(experiment.config||{})));
    const budget=Math.max(1,Number(experiment.config?.investigation_budget||8)+1);
    for(const result of array(experiment.results)){
      const exclusion=actionPolicyTrajectoryEligibility(result).reason;
      if(exclusion){exclusionCounts[exclusion]++;continue;}
      const turns=result.retrieval_trace.investigation.turns;
      const finalValue=clamp(Number(result.score),0,1),initialInformation={patient_profile:result.retrieval_context?.patient_profile||null,recent_sessions:array(result.retrieval_context?.recent_sessions).map(session=>({episode_id:session?.episode_id,event_time:session?.event_time})),memory_nodes:[],memory_edges:[],verification:null,assessment:null,answer_brief:null,worker_state:null};
      trajectories.push({comparison_group:String(result.score_id||'<unidentified>'),query_type:normalizeQueryType(result.task||result.query_type||result.retrieval_context?.question_request?.query_type),final_value:finalValue,budget,initial_information:initialInformation,turns});
    }
  }
  const comparisons=hierarchicalComparisons(trajectories),comparisonModeCounts={within_question:0,cross_case_query_type:0,calibrated_raw_score:0};
  for(const trajectory of trajectories){let currentInformation=trajectory.initial_information,previousSteps=[];const comparison=comparisons.get(trajectory),relativeReturn=comparison.relative_return;comparisonModeCounts[comparison.mode]++;for(let index=0;index<trajectory.turns.length;index++){const turn=trajectory.turns[index],worker=String(turn?.decision?.worker||'').trim(),input={query_type:trajectory.query_type,current_information:currentInformation,previous_steps:previousSteps,remaining_budget:Math.max(1,trajectory.budget-index)},state=abstractActionPolicyState(input),shapedValue=clamp(relativeReturn+transitionAdjustment(turn,index,currentInformation),0,1),conditionalProbability=Number(turn?.action_exploration_assignment?.conditional_probability||0);rows.push({state,worker,value:shapedValue,...(conditionalProbability>0?{conditional_probability:conditionalProbability}:{})});previousSteps=[...previousSteps,{worker,changed:turn?.result?.changed??null}];currentInformation=turn.result.snapshot;}}
  const excludedTotal=Object.values(exclusionCounts).reduce((sum,value)=>sum+value,0);
  if(!rows.length)throw new Error(`No valid complete scored investigation trajectories were available for action-policy learning (excluded ${excludedTotal}: ${formatCounts(exclusionCounts)})`);
  const global=aggregate(rows,()=>'*'),contexts=aggregate(rows,row=>serializeState(row.state)),backoffs=aggregate(rows,row=>serializeState(backoffState(row.state))),priorStrength=Math.max(1,Number(options.prior_strength||4)),globalMeans=meanByAction(global['*']||{}),contextValues=posteriorValues(contexts,globalMeans,priorStrength),backoffValues=posteriorValues(backoffs,globalMeans,priorStrength),globalValues=posteriorValues(global,globalMeans,0)['*']||[];
  const body={
    version:ACTION_POLICY_MODEL_VERSION,
    training_scope:{benchmark:'medmemorybench',splits:[...trainingSplits].sort(),persona_ids:[...trainingPersonas].sort((a,b)=>a-b),noise:false,trajectory_count:trajectories.length,decision_count:rows.length,exploration_decision_count:rows.filter(row=>row.conditional_probability>0).length,experiment_count:trainingHashes.length,experiment_hashes:trainingHashes.sort(),excluded_result_count:excludedTotal,exclusion_counts:exclusionCounts,comparison_mode_counts:comparisonModeCounts,uses_question_text:false,uses_task_label:true,uses_gold_or_judge_content:false,uses_post_answer_scalar_reward:true,reward_signal:'hierarchical_within_question_or_cross_case_query_type_or_calibrated_raw_score_plus_runtime_transition_progress',reward_interpretation:'correlational_weak_prior_not_causal_action_effect',causal_claim:false,propensity_weighting:'capped_inverse_conditional_assignment_probability',comparison_group_retained:false},
    state_features:Object.keys(abstractActionPolicyState({})),
    prior_strength:priorStrength,
    contexts:contextValues,
    backoff_contexts:backoffValues,
    global_actions:globalValues,
  };
  const model={...body,model_hash:sha256(stableJson(body))};
  assertSafeLearnedModel(model);
  return model;
}

export function withLearnedActionPrior(input={},model=null){
  if(!model)return input;
  validateActionPolicyModel(model);
  const medLoCoMo=model.training_scope?.benchmark==='medlocomo',state=medLoCoMo?abstractMedLoCoMoActionPolicyState(input):abstractActionPolicyState(input),backoffStateValue=medLoCoMo?medLoCoMoBackoffState(state):backoffState(state),exact=array(model.contexts?.[serializeState(state)]),backoff=array(model.backoff_contexts?.[serializeState(backoffStateValue)]),global=array(model.global_actions),allowed=[...new Set(array(input.allowed_workers).map(String))],ranked=allowed.map(worker=>valueForWorker(worker,exact,backoff,global)).filter(Boolean).sort((left,right)=>right.estimated_value-left.estimated_value||right.support-left.support||left.worker.localeCompare(right.worker)),margin=ranked.length>1?ranked[0].estimated_value-ranked[1].estimated_value:0,support=ranked[0]?.support||0,comparisonQuality=actionPolicyComparisonQuality(model),confidence=round(Math.min(.8,(support/(support+4))*(.25+Math.max(0,margin)))*comparisonQuality.reliability);
  const learned_action_prior={version:ACTION_POLICY_PRIOR_VERSION,model_hash:model.model_hash,source:ranked[0]?.value_source||'none',confidence,comparison_quality:comparisonQuality,advice:LEARNED_ACTION_PRIOR_ADVICE,ranked_actions:ranked};
  const output={...input,learned_action_prior};
  assertNoHiddenBenchmarkInput(output,'investigation_policy_with_learned_prior');
  return output;
}

export function withActionExploration(input={},options={}){
  const rate=Number(options.rate||0),allowed=[...new Set(array(input.allowed_workers).map(String))];
  if(!Number.isFinite(rate)||rate<0||rate>1)throw new Error('Action exploration rate must be between 0 and 1');
  if(rate===0||allowed.length<2)return input;
  const turn=array(input.previous_steps).length+1,key=`${Number(options.seed||0)}\u0000${String(options.trajectory_key||'trajectory')}\u0000${turn}`,gate=randomUnit(`${key}\u0000gate`);
  if(gate>=rate)return input;
  const worker=allowed[Math.floor(randomUnit(`${key}\u0000action`)*allowed.length)%allowed.length],action_exploration_assignment={version:ACTION_EXPLORATION_VERSION,mode:'uniform_over_runtime_allowed_actions',worker,eligible_workers:allowed,conditional_probability:round(1/allowed.length),assignment_probability:round(rate/allowed.length),seed:Number(options.seed||0),turn};
  const output={...input,action_exploration_assignment};assertNoHiddenBenchmarkInput(output,'investigation_policy_with_action_exploration');return output;
}

export function actionPolicyLearningManifest(model=null){
  if(!model)return{enabled:false};
  validateActionPolicyModel(model);
  return{enabled:true,version:model.version,model_hash:model.model_hash,training_scope:model.training_scope,state_features:model.state_features,prior_strength:model.prior_strength};
}

/**
 * Keep a failed candidate available for offline diagnosis, but require a
 * patient-disjoint non-inferiority result before it can control a live greedy
 * rollout.  Recomputing the decision here prevents a hand-edited boolean from
 * bypassing the gate.
 */
export function medLoCoMoActionPolicyAcceptance(model){
  if(model?.training_scope?.benchmark!=='medlocomo')return{accepted:false,reason:'not_medlocomo'};
  const facts=medLoCoMoAcceptanceFacts(model),validation=model.validation||{},scope=model.training_scope||{},applicable=facts.retrievalApplicable&&validation.applies_to_serialized_model===true&&validation.runtime_environment_parity===true,metricsAccepted=applicable&&facts.nonInferior&&facts.strict,declared=validation.accepted===true&&scope.deployment_eligible===true;
  return acceptanceResult({facts,applicable,metricsAccepted,declared,undeclaredReason:'artifact_not_marked_deployable'});
}

/** A full offline retrieval-stack A/B may advise the Policy LLM, never force a worker. */
export function medLoCoMoActionPolicyAdvisoryAcceptance(model){
  if(model?.training_scope?.benchmark!=='medlocomo')return{accepted:false,reason:'not_medlocomo'};
  const facts=medLoCoMoAcceptanceFacts(model),validation=model.validation||{},scope=model.training_scope||{},applicable=facts.retrievalApplicable&&validation.retrieval_stack_parity===true,metricsAccepted=applicable&&facts.nonInferior&&facts.strict,declared=validation.experimental_advisory_accepted===true&&scope.advisory_eligible===true;
  return acceptanceResult({facts,applicable,metricsAccepted,declared,undeclaredReason:'artifact_not_marked_advisory'});
}

function medLoCoMoAcceptanceFacts(model){
  const validation=model.validation||{},scope=model.training_scope||{},delta=validation.learned_minus_baseline||{},raw=[delta.exact_turn_recall,delta.all_evidence_rate,delta.mean_action_cost],finite=raw.every(finiteNumber),[exact,allEvidence,cost]=finite?raw:[NaN,NaN,NaN],productionGraph=['frozen_production_sqlite','frozen_production_sqlite_v1_plus_deterministic_v2_literal_migration'].includes(String(validation.validation_graph_source||'')),fullFixedHoldout=exactNumber(validation.patient_count,MEDLOCOMO_FIXED_VALIDATION_PATIENT_COUNT)&&exactNumber(validation.case_count,MEDLOCOMO_FIXED_VALIDATION_CASE_COUNT)&&exactNumber(validation.exact_turn_case_count,MEDLOCOMO_FIXED_VALIDATION_EXACT_TURN_CASE_COUNT)&&String(scope.validation_set_commitment||'')===MEDLOCOMO_FIXED_VALIDATION_COMMITMENT&&exactNumber(scope.patient_count,97),pairwiseSplitAligned=validation.pairwise_valid_for_held_out_claims===true&&validation.pairwise_validation_patients_included===false&&exactNumber(validation.pairwise_train_patient_count,97)&&exactNumber(validation.pairwise_validation_patient_count,4)&&String(validation.pairwise_train_set_commitment||'')===String(scope.train_set_commitment||'')&&String(validation.pairwise_validation_set_commitment||'')===String(scope.validation_set_commitment||''),instructionSplitAligned=exactNumber(validation.instruction_policy_train_patient_count,97)&&exactNumber(validation.instruction_policy_validation_patient_count,4)&&String(validation.instruction_policy_train_set_commitment||'')===String(scope.train_set_commitment||'')&&String(validation.instruction_policy_validation_set_commitment||'')===String(scope.validation_set_commitment||'')&&validation.instruction_policy_final_refit===false,runtimeExecuted=validMedLoCoMoRuntimeExecution(validation.runtime_stack_execution)&&validMedLoCoMoInstructionExecution(validation)&&validation.embedding_runtime_contract_matched===true,retrievalApplicable=validation.patient_disjoint===true&&validation.validation_graph_memory_compatible===true&&productionGraph&&validation.production_pairwise_ranker_used===true&&validation.production_embedding_selector_used===true&&validation.production_instruction_policy_used===true&&fullFixedHoldout&&pairwiseSplitAligned&&instructionSplitAligned&&runtimeExecuted,nonInferior=finite&&exact>=0&&allEvidence>=0&&cost<=0,strict=finite&&(exact>0||allEvidence>0||cost<0);
  return{finite,nonInferior,strict,retrievalApplicable};
}
function acceptanceResult({facts,applicable,metricsAccepted,declared,undeclaredReason}){return{accepted:metricsAccepted&&declared,metrics_accepted:metricsAccepted,declared_eligible:declared,reason:!facts.finite?'validation_metrics_missing':!applicable?'validation_not_applicable':!facts.nonInferior?'held_out_non_inferiority_failed':!facts.strict?'no_held_out_improvement':!declared?undeclaredReason:'accepted'};}

function validMedLoCoMoRuntimeExecution(value){
  if(!value||typeof value!=='object')return false;
  const attempted=value.embedding_attempted,completed=value.embedding_completed,failed=value.embedding_failed,pairwiseAttempted=value.pairwise_attempted,pairwiseApplied=value.pairwise_applied,pairwiseFailed=value.pairwise_failed;
  return finiteNumber(attempted)&&attempted>0&&completed===attempted&&failed===0&&finiteNumber(pairwiseAttempted)&&pairwiseAttempted>0&&pairwiseApplied===pairwiseAttempted&&pairwiseFailed===0&&value.embedding_expected_dimensions===MEDLOCOMO_EMBEDDING_RUNTIME_CONTRACT.dimension&&singleton(value.embedding_observed_dimensions,MEDLOCOMO_EMBEDDING_RUNTIME_CONTRACT.dimension)&&singleton(value.embedding_observed_providers,MEDLOCOMO_EMBEDDING_RUNTIME_CONTRACT.provider)&&singleton(value.embedding_observed_models,MEDLOCOMO_EMBEDDING_RUNTIME_CONTRACT.model)&&singleton(value.embedding_observed_model_revisions,MEDLOCOMO_EMBEDDING_RUNTIME_CONTRACT.model_revision)&&singleton(value.embedding_observed_model_revision_verifications,MEDLOCOMO_EMBEDDING_RUNTIME_CONTRACT.model_revision_verification)&&singleton(value.embedding_observed_base_models,MEDLOCOMO_EMBEDDING_RUNTIME_CONTRACT.base_model)&&singleton(value.embedding_observed_base_model_revisions,MEDLOCOMO_EMBEDDING_RUNTIME_CONTRACT.base_model_revision)&&singleton(value.embedding_observed_snapshot_hashes,MEDLOCOMO_EMBEDDING_RUNTIME_CONTRACT.snapshot_hash)&&singleton(value.embedding_observed_snapshot_file_hash_commitments,sha256(stableJson(MEDLOCOMO_EMBEDDING_RUNTIME_CONTRACT.snapshot_file_hashes)))&&singleton(value.embedding_observed_normalized,true)&&singleton(value.embedding_observed_chunk_turn_counts,MEDLOCOMO_EMBEDDING_RUNTIME_CONTRACT.admission_chunk_turn_count);
}
function validMedLoCoMoInstructionExecution(validation){const value=validation.runtime_stack_execution||{},attempted=value.instruction_prior_attempted;return finiteNumber(attempted)&&attempted>0&&value.instruction_prior_completed===attempted&&value.instruction_prior_failed===0&&singleton(value.instruction_prior_observed_artifact_hashes,String(validation.production_instruction_policy_artifact_hash||''));}
function finiteNumber(value){return typeof value==='number'&&Number.isFinite(value);}
function exactNumber(value,expected){return finiteNumber(value)&&value===expected;}
function singleton(value,expected){return Array.isArray(value)&&value.length===1&&value[0]===expected;}

export function validateActionPolicyModel(model){
  if(MEDLOCOMO_ACTION_POLICY_MODEL_VERSIONS.has(model?.version)){validateMedLoCoMoActionPolicyModel(model);assertSafeLearnedModel(model);return model;}
  if(!model||model.version!==ACTION_POLICY_MODEL_VERSION&&!LEGACY_ACTION_POLICY_MODEL_VERSIONS.has(model.version))throw new Error(`Unsupported action-policy model version: ${model?.version||'<missing>'}`);
  if(model.training_scope?.benchmark!=='medmemorybench'||model.training_scope?.noise!==false)throw new Error('Action-policy model must be trained only on MedMemoryBench Clean trajectories');
  if(model.training_scope?.uses_question_text!==false||model.training_scope?.uses_gold_or_judge_content!==false)throw new Error('Action-policy model violates the runtime information boundary');
  if(model.version==='careharness-action-value-model.v2-relative-return'&&model.training_scope?.uses_task_label!==false)throw new Error('Legacy action-policy model has an invalid task-label boundary');
  if(model.version!=='careharness-action-value-model.v2-relative-return'&&model.training_scope?.uses_task_label!==true)throw new Error('Type-adaptive action-policy model must disclose task-label conditioning');
  assertSafeLearnedModel(model);
  return model;
}

function validateMedLoCoMoActionPolicyModel(model){
  const scope=model?.training_scope||{};
  if(scope.benchmark!=='medlocomo'||scope.runtime_eligible!==true||scope.counterfactual_worker_rollout!==true)throw new Error('MedLoCoMo action-policy model requires a runtime-eligible counterfactual worker rollout');
  if(scope.runtime_uses_question_text!==false||scope.runtime_uses_gold_or_judge_content!==false||scope.runtime_retains_case_content!==false)throw new Error('MedLoCoMo action-policy model violates the runtime information boundary');
  if(!Number.isInteger(Number(scope.patient_count))||Number(scope.patient_count)<1||!Number.isInteger(Number(scope.rollout_case_count))||Number(scope.rollout_case_count)<1)throw new Error('MedLoCoMo action-policy model has invalid training counts');
  if(!Array.isArray(model.state_features)||!model.state_features.length||!Array.isArray(model.global_actions)||!model.global_actions.length)throw new Error('MedLoCoMo action-policy model is empty');
  const expectedFeatures=Object.keys(abstractMedLoCoMoActionPolicyState({})).sort(),actualFeatures=[...model.state_features].map(String).sort();
  if(JSON.stringify(actualFeatures)!==JSON.stringify(expectedFeatures))throw new Error('MedLoCoMo action-policy model has an incompatible runtime state schema');
  validateMedLoCoMoValueTable(model.contexts,expectedFeatures,'contexts');
  validateMedLoCoMoValueTable(model.backoff_contexts,['query_type','node_count','episode_count','assessment','verification','last_worker','last_changed','remaining_budget'],'backoff_contexts');
  validateMedLoCoMoActionRows(model.global_actions,'global_actions');
  const acceptance=medLoCoMoActionPolicyAcceptance(model);
  const advisoryAcceptance=medLoCoMoActionPolicyAdvisoryAcceptance(model);
  if((model.validation?.accepted===true||scope.deployment_eligible===true)&&!acceptance.metrics_accepted)throw new Error(`MedLoCoMo Action policy cannot be marked deployable: ${acceptance.reason}`);
  if(Boolean(model.validation?.accepted)!==Boolean(scope.deployment_eligible))throw new Error('MedLoCoMo Action policy deployment markers disagree');
  if((model.validation?.experimental_advisory_accepted===true||scope.advisory_eligible===true)&&!advisoryAcceptance.metrics_accepted)throw new Error(`MedLoCoMo Action policy cannot be marked advisory: ${advisoryAcceptance.reason}`);
  if(Boolean(model.validation?.experimental_advisory_accepted)!==Boolean(scope.advisory_eligible))throw new Error('MedLoCoMo Action policy advisory markers disagree');
  const body={...model};delete body.model_hash;
  if(!/^[a-f0-9]{64}$/u.test(String(model.model_hash||''))||sha256(stableJson(body))!==model.model_hash)throw new Error('MedLoCoMo action-policy artifact hash does not match its contents');
}

function validateMedLoCoMoValueTable(table,features,label){
  if(!table||typeof table!=='object'||Array.isArray(table))throw new Error(`MedLoCoMo ${label} must be an object`);
  const expected=[...features].sort();
  for(const[key,rows]of Object.entries(table)){
    const fields=Object.fromEntries(String(key).split('|').map(part=>{const index=part.indexOf('=');if(index<1)throw new Error(`MedLoCoMo ${label} contains an invalid state key`);return[part.slice(0,index),part.slice(index+1)];})),actual=Object.keys(fields).sort();
    if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(`MedLoCoMo ${label} contains an incompatible state key`);
    validateMedLoCoMoStateValues(fields,label);validateMedLoCoMoActionRows(rows,label);
  }
}
function validateMedLoCoMoStateValues(fields,label){
  const enums={query_type:['medical_reasoning','care_plan_rationale','longitudinal_progression','cross_admission_comparison','frequency_pattern','adversarial','unknown'],node_count:['none','small','medium','bounded','overflow'],episode_count:['none','one','two','several','many'],assessment:['none','supported','partial','unresolved','other'],missing_count:['none','one','two','many'],verification:['none','complete','incomplete','overflow'],last_worker:['none','search','context','trace','assess','refine','verify','answer'],last_changed:['none','yes','no','unknown'],stalled_discovery:['none','one','repeated'],discovery_count:['none','one','two','many'],assessment_count:['none','one','repeated'],candidate_count:['none','few','bounded','many','very_many'],selected_episode_count:['none','one','two','several','many'],remaining_budget:['last','low','medium','high']};
  for(const[key,value]of Object.entries(fields))if(!enums[key]?.includes(value))throw new Error(`MedLoCoMo ${label} contains an invalid ${key} value`);
}
function validateMedLoCoMoActionRows(rows,label){
  if(!Array.isArray(rows)||!rows.length)throw new Error(`MedLoCoMo ${label} contains no Action values`);
  const seen=new Set(),allowed=new Set(['search','context','trace','assess','refine','verify','answer']);
  for(const row of rows){const worker=String(row?.worker||'');if(!allowed.has(worker)||seen.has(worker)||!Number.isInteger(Number(row?.count))||Number(row.count)<1||!Number.isFinite(Number(row?.mean))||Number(row.mean)<0||Number(row.mean)>1)throw new Error(`MedLoCoMo ${label} contains an invalid Action value`);seen.add(worker);}
}

export function actionPolicyTrajectoryEligibility(result){
  const reason=trainingExclusionReason(result);return{eligible:reason===null,reason};
}

function validateTrainingExperiment(experiment){
  const config=experiment?.config||{},model=config.resolved_models?.investigation_policy;
  if(experiment?.benchmark!=='medmemorybench'||!Number.isInteger(Number(config.persona_id))||Number(config.persona_id)<1||Boolean(config.noise))throw new Error('Training accepts only completed MedMemoryBench Clean Persona experiments');
  if(experiment.status!=='completed')throw new Error(`Training experiment ${experiment.id||'<unknown>'} is not completed`);
  if(model?.provider!=='dashscope'||model?.model!=='qwen3.7-flash')throw new Error('Training trajectories must use DashScope qwen3.7-flash Investigation Policy');
}
function assertSafeLearnedModel(model){
  assertNoHiddenBenchmarkInput(model,'learned_action_policy');
  const serialized=JSON.stringify(model);
  for(const forbidden of ['question','task_label','score_id','system_output','memory_nodes','required_patient_info','nodes_for_validation'])if(serialized.includes(`"${forbidden}"`))throw new Error(`Learned action-policy model contains forbidden feature ${forbidden}`);
  return true;
}
function aggregate(rows,keyFor){const output={};for(const row of rows){const key=keyFor(row),actions=output[key]||={},cell=actions[row.worker]||{count:0,weight_sum:0,sum:0},weight=trajectoryWeight(row);cell.count++;cell.weight_sum+=weight;cell.sum+=row.value*weight;actions[row.worker]=cell;output[key]=actions;}return output;}
function meanByAction(actions){return Object.fromEntries(Object.entries(actions).map(([worker,value])=>[worker,value.weight_sum?value.sum/value.weight_sum:0]));}
function posteriorValues(groups,globalMeans,priorStrength){return Object.fromEntries(Object.entries(groups).map(([key,actions])=>[key,Object.entries(actions).map(([worker,value])=>({worker,count:value.count,effective_weight:round(value.weight_sum),mean:round((value.sum+priorStrength*Number(globalMeans[worker]||0))/(value.weight_sum+priorStrength))})).sort((left,right)=>right.mean-left.mean||right.effective_weight-left.effective_weight||left.worker.localeCompare(right.worker))]));}
function valueForWorker(worker,exact,backoff,global){for(const[value_source,values]of[['exact',exact],['backoff',backoff],['global',global]]){const value=values.find(item=>String(item?.worker||'')===worker);if(value)return{worker,estimated_value:round(Number(value.mean||0)),support:Number(value.count||0),value_source};}return{worker,estimated_value:.5,support:0,value_source:'unobserved'};}
function backoffState(state){return{node_count:state.node_count,assessment:state.assessment,verification:state.verification,last_worker:state.last_worker,last_changed:state.last_changed,remaining_budget:state.remaining_budget};}
function medLoCoMoBackoffState(state){return{query_type:state.query_type,node_count:state.node_count,episode_count:state.episode_count,assessment:state.assessment,verification:state.verification,last_worker:state.last_worker,last_changed:state.last_changed,remaining_budget:state.remaining_budget};}
function serializeState(value){return Object.keys(value).sort().map(key=>`${key}=${String(value[key])}`).join('|');}
function assessmentStatus(value){const status=String(value?.assessment||'none').toLowerCase();return['supported','partial','unresolved'].includes(status)?status:value?'other':'none';}
function verificationStatus(value){if(!value)return'none';if(value.overflow===true||value.requires_refine===true)return'overflow';return value.complete===true?'complete':'incomplete';}
function changeStatus(value){return value===true?'yes':value===false?'no':'unknown';}
function noProgressDiscoveryStreak(steps){let count=0;for(let index=steps.length-1;index>=0;index--){const step=steps[index];if(!DISCOVERY_WORKERS.has(String(step?.worker||''))||step?.changed!==false)break;count++;}return count;}
function transitionAdjustment(turn,index,before={}){const worker=String(turn?.decision?.worker||''),changed=turn?.result?.changed,after=turn?.result?.snapshot||before;let value=-.003*(index+1);if(DISCOVERY_WORKERS.has(worker)){const nodeGain=array(after.memory_nodes).length-array(before.memory_nodes).length,edgeGain=array(after.memory_edges).length-array(before.memory_edges).length;value+=changed===false?-.08:Math.min(.07,.012*Math.max(0,nodeGain)+.006*Math.max(0,edgeGain)+.01);}else if(worker==='assess'){const prior=before.assessment||before.answer_brief||null,next=after.assessment||null;if(prior&&assessmentSignature(prior)===assessmentSignature(next))value-=.07;else{const coveredGain=array(next?.covered_aspects).length-array(prior?.covered_aspects).length,missingReduction=array(prior?.missing_information).length-array(next?.missing_information).length;value+=.015+.008*Math.max(0,coveredGain)+.01*Math.max(0,missingReduction)+.004*array(next?.answer_focus).length;if(next?.assessment==='supported')value+=.02;}}else if(worker==='refine'){const beforeCount=array(before.memory_nodes).length,afterCount=array(after.memory_nodes).length;if(changed===false)value-=.05;else value+=beforeCount>16&&afterCount<=16?.06:.015;}else if(worker==='verify')value+=after.verification?.complete===true?.04:-.04;else if(worker==='answer')value+=.01;return value;}
function assessmentSignature(value){return stableJson({assessment:value?.assessment||null,relevant_memory_ids:array(value?.relevant_memory_ids).map(String).sort(),covered_aspects:array(value?.covered_aspects).map(String).sort(),missing_information:array(value?.missing_information).map(String).sort(),answer_focus:array(value?.answer_focus).map(item=>({aspect:String(item?.aspect||''),memory_ids:array(item?.memory_ids).map(String).sort(),source_refs:array(item?.source_refs).map(String).sort()}))});}
function trainingExclusionReason(result){
  if(result?.kind!=='score')return'non_score_result';
  if(result.judge_infrastructure_failure===true)return'judge_infrastructure_failure';
  if(result.memory_incomplete===true)return'memory_incomplete';
  if(result.status!=='scored'||!Number.isFinite(Number(result.score)))return'unscored_or_non_numeric';
  const investigation=result.retrieval_trace?.investigation,turns=investigation?.turns;
  if(!Array.isArray(turns)||!turns.length||String(investigation.termination_reason||'')!=='answer_selected'||String(turns.at(-1)?.decision?.worker||'')!=='answer'||!turns.every(validTrainingTurn))return'incomplete_or_invalid_trajectory';
  return null;
}
function actionPolicyComparisonQuality(model){
  if(MEDLOCOMO_ACTION_POLICY_MODEL_VERSIONS.has(model.version)){const validation=model.validation||null,accuracy=Number(validation?.one_step_best_action_accuracy),regret=Number(validation?.one_step_mean_action_regret),facts=medLoCoMoAcceptanceFacts(model),greedyScope=facts.retrievalApplicable&&validation?.runtime_environment_parity===true&&validation?.applies_to_serialized_model===true,advisoryScope=!greedyScope&&facts.retrievalApplicable&&validation?.retrieval_stack_parity===true,hasValidation=validation?.patient_disjoint===true&&(greedyScope||advisoryScope)&&Number.isFinite(accuracy)&&Number.isFinite(regret),mode=greedyScope?'patient_disjoint_counterfactual_graph_rollout':advisoryScope?'patient_disjoint_retrieval_stack_advisory':'unvalidated_or_post_validation_refit',ceiling=advisoryScope?.6:1;return{mode,within_question_fraction:null,reliability:hasValidation?round(clamp(accuracy*(1-Math.max(0,regret)),.2,ceiling)):.2};}
  if(model.version!==ACTION_POLICY_MODEL_VERSION)return{mode:'legacy_unspecified',within_question_fraction:null,reliability:1};
  const counts=model.training_scope?.comparison_mode_counts||{},within=Math.max(0,Number(counts.within_question)||0),cross=Math.max(0,Number(counts.cross_case_query_type)||0),raw=Math.max(0,Number(counts.calibrated_raw_score)||0),total=within+cross+raw,fraction=total?within/total:0;
  return{mode:fraction===1?'within_question':fraction>0?'mixed':cross>0?'cross_case_only':'calibrated_raw_only',within_question_fraction:round(fraction),reliability:round(.2+.8*fraction)};
}
function validTrainingTurn(turn){const worker=String(turn?.decision?.worker||'');return['search','context','trace','assess','refine','verify','answer'].includes(worker)&&Boolean(turn?.result?.snapshot&&typeof turn.result.snapshot==='object'&&!Array.isArray(turn.result.snapshot));}
function hierarchicalComparisons(trajectories){
  const byQuestion=groupStats(trajectories,item=>item.comparison_group),byType=groupStats(trajectories,item=>item.query_type),output=new Map();
  for(const trajectory of trajectories){const question=byQuestion.get(trajectory.comparison_group),type=byType.get(trajectory.query_type);let mode,baseline;
    if(question.count>=2){mode='within_question';baseline=question.sum/question.count;}
    else if(type.count>=2){mode='cross_case_query_type';baseline=(type.sum-trajectory.final_value)/(type.count-1);}
    else{mode='calibrated_raw_score';baseline=.5;}
    output.set(trajectory,{mode,relative_return:clamp(.5+(trajectory.final_value-baseline),0,1)});
  }
  return output;
}
function groupStats(values,keyFor){const cells=new Map();for(const item of values){const key=keyFor(item),cell=cells.get(key)||{sum:0,count:0};cell.sum+=item.final_value;cell.count++;cells.set(key,cell);}return cells;}
function formatCounts(value){return Object.entries(value).map(([key,count])=>`${key}=${count}`).join(', ');}
function trajectoryWeight(row){const probability=Number(row?.conditional_probability||0);return probability>0?Math.min(6,1/probability):1;}
function hashIdentifier(value){return sha256(String(value)).slice(0,16);}
function sha256(value){return createHash('sha256').update(value).digest('hex');}
function randomUnit(value){return Number.parseInt(sha256(value).slice(0,13),16)/0x10000000000000;}
function stableJson(value){if(Array.isArray(value))return`[${value.map(stableJson).join(',')}]`;if(value&&typeof value==='object')return`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;return JSON.stringify(value);}
function bucket(value,limits,labels){const number=Number(value)||0;for(let index=0;index<limits.length;index++)if(number<=limits[index])return labels[index];return labels.at(-1);}
function normalizeQueryType(value){const type=String(value||'unknown').normalize('NFKC').trim().toLowerCase();return type&&type.length<=80?type:'unknown';}
function clamp(value,min,max){return Math.min(max,Math.max(min,value));}
function round(value){return Math.round((Number(value)||0)*10000)/10000;}
function array(value){return Array.isArray(value)?value:[];}
