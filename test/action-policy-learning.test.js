import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MEDLOCOMO_ACTION_POLICY_MODEL_VERSION,abstractActionPolicyState,abstractMedLoCoMoActionPolicyState,actionPolicyLearningManifest,actionPolicyTrajectoryEligibility,learnActionPolicyModel,loadActionPolicyModel,loadDefaultMedLoCoMoActionPolicy,medLoCoMoActionPolicyAcceptance,medLoCoMoActionPolicyAdvisoryAcceptance,validateActionPolicyModel,withActionExploration,withLearnedActionPrior } from '../src/action-policy-learning.js';
import { createInvestigationState,createQuestionRequest,policyView } from '../src/investigation-contract.js';
import { MEDLOCOMO_EMBEDDING_SNAPSHOT_FILE_HASHES,MEDLOCOMO_EMBEDDING_SNAPSHOT_HASH } from '../src/embedding-retrieval.js';

const snapshot={patient_profile:{item_count:2},recent_sessions:[{episode_id:'session-x'}],memory_nodes:[],memory_edges:[],verification:null,assessment:null,worker_state:null};
const turn=(worker,changed=true)=>({decision:{worker},result:{changed,snapshot:{...snapshot,worker_state:{last_worker:worker}}}});
const experiment=results=>({id:'training-run',benchmark:'medmemorybench',status:'completed',config:{split:'dev',persona_id:1,noise:false,investigation_budget:3,resolved_models:{investigation_policy:{provider:'dashscope',model:'qwen3.7-flash'}}},results});
const result=(score,worker,{task='inference_generation',scoreId=`case-${score}-${worker}`,judgeFailure=false,memoryIncomplete=false,complete=true}={})=>({kind:'score',score_id:scoreId,status:'scored',score,question:'must never become a feature',task,gold:['must never enter model'],judge_infrastructure_failure:judgeFailure,memory_incomplete:memoryIncomplete,retrieval_context:{patient_profile:snapshot.patient_profile,recent_sessions:snapshot.recent_sessions},retrieval_trace:{investigation:{termination_reason:complete?'answer_selected':'budget_exhausted',turns:complete?[turn(worker),turn('answer')]:[turn(worker)]}}});

test('action state abstraction ignores case content but transparently conditions on public query type',()=>{
  const base={current_information:snapshot,previous_steps:[],remaining_budget:4},left=abstractActionPolicyState({...base,query_type:'inference_generation',question:'A'}),right=abstractActionPolicyState({...base,query_type:'inference_generation',question:'B',gold:['secret'],required_patient_info:['secret']}),other=abstractActionPolicyState({...base,query_type:'entity_exact_match',question:'A'});
  assert.deepEqual(left,right);assert.notEqual(left.query_type,other.query_type);
});

test('unique score ids use a cross-case query-type baseline so high-score actions outrank low-score actions',()=>{
  const model=learnActionPolicyModel([experiment([result(.9,'search',{scoreId:'unique-high'}),result(.1,'verify',{scoreId:'unique-low'})])],{prior_strength:1}),input={question:'new unseen question',query_type:'inference_generation',current_information:snapshot,previous_steps:[],remaining_budget:4,allowed_workers:['search','verify']},prior=withLearnedActionPrior(input,model).learned_action_prior,serialized=JSON.stringify(model);
  assert.equal(prior.ranked_actions[0].worker,'search');assert.deepEqual(prior.ranked_actions.map(item=>item.worker).sort(),['search','verify']);
  assert.equal(prior.comparison_quality.mode,'cross_case_only');assert.equal(prior.comparison_quality.reliability,.2);
  assert.equal(serialized.includes('must never'),false);assert.equal(serialized.includes('hidden outer label'),false);
  assert.equal(model.training_scope.uses_question_text,false);assert.equal(model.training_scope.uses_task_label,true);assert.equal(model.training_scope.uses_gold_or_judge_content,false);
  assert.deepEqual(model.training_scope.comparison_mode_counts,{within_question:0,cross_case_query_type:2,calibrated_raw_score:0});
  assert.equal(model.training_scope.reward_interpretation,'correlational_weak_prior_not_causal_action_effect');assert.equal(model.training_scope.causal_claim,false);
});

test('runtime prior contains only currently allowed actions and manifest records its hash',()=>{
  const model=learnActionPolicyModel([experiment([result(.8,'search',{scoreId:'q1'}),result(.4,'verify',{scoreId:'q2'})])]),decorated=withLearnedActionPrior({query_type:'inference_generation',current_information:snapshot,previous_steps:[],remaining_budget:4,allowed_workers:['verify']},model),manifest=actionPolicyLearningManifest(model);
  assert.deepEqual(decorated.learned_action_prior.ranked_actions.map(item=>item.worker),['verify']);assert.equal(manifest.enabled,true);assert.equal(manifest.model_hash,model.model_hash);assert.deepEqual(manifest.training_scope.persona_ids,[1]);
});

test('judge infrastructure failures and incomplete memory are excluded from learning',()=>{
  const model=learnActionPolicyModel([experiment([
    result(.8,'search',{scoreId:'valid'}),
    result(1,'verify',{scoreId:'judge-failed',judgeFailure:true}),
    result(1,'trace',{scoreId:'memory-failed',memoryIncomplete:true}),
  ])]),workers=model.global_actions.map(item=>item.worker);
  assert.equal(model.training_scope.trajectory_count,1);assert.equal(model.training_scope.excluded_result_count,2);
  assert.equal(model.training_scope.exclusion_counts.judge_infrastructure_failure,1);assert.equal(model.training_scope.exclusion_counts.memory_incomplete,1);
  assert.equal(model.training_scope.comparison_mode_counts.calibrated_raw_score,1);
  assert.equal(workers.includes('verify'),false);assert.equal(workers.includes('trace'),false);
});

test('trajectory eligibility is shared by training and offline policy evaluation',()=>{
  assert.equal(actionPolicyTrajectoryEligibility(result(.8,'search',{scoreId:'valid'})).eligible,true);
  assert.deepEqual(actionPolicyTrajectoryEligibility(result(1,'verify',{scoreId:'judge-failed',judgeFailure:true})),{eligible:false,reason:'judge_infrastructure_failure'});
  assert.deepEqual(actionPolicyTrajectoryEligibility(result(.5,'trace',{scoreId:'unfinished',complete:false})),{eligible:false,reason:'incomplete_or_invalid_trajectory'});
});

test('learner reports exclusions when no valid complete trajectory remains',()=>{
  assert.throws(()=>learnActionPolicyModel([experiment([
    result(1,'search',{scoreId:'judge-failed',judgeFailure:true}),
    result(.8,'trace',{scoreId:'unfinished',complete:false}),
  ])]),/No valid complete scored investigation trajectories.*judge_infrastructure_failure=1.*incomplete_or_invalid_trajectory=1/);
});

test('safe exploration is deterministic, uniform over runtime-allowed Actions and carries no query direction',()=>{
  const input={question:'患者问题只供千问生成指令',current_information:snapshot,previous_steps:[{worker:'search',changed:true}],remaining_budget:4,allowed_workers:['search','assess','verify']},left=withActionExploration(input,{rate:1,seed:73,trajectory_key:'opaque-trajectory'}),right=withActionExploration(input,{rate:1,seed:73,trajectory_key:'opaque-trajectory'}),assignment=left.action_exploration_assignment;
  assert.deepEqual(left,right);assert.ok(input.allowed_workers.includes(assignment.worker));assert.equal(assignment.conditional_probability,.3333);assert.equal(assignment.mode,'uniform_over_runtime_allowed_actions');assert.equal(JSON.stringify(assignment).includes('患者问题'),false);
  assert.equal(withActionExploration({...input,allowed_workers:['answer']},{rate:1,seed:73,trajectory_key:'x'}).action_exploration_assignment,undefined);
});

test('learner accepts any disclosed Clean Persona but rejects noise and non-Qwen policy trajectories',()=>{
  assert.doesNotThrow(()=>learnActionPolicyModel([{...experiment([result(.5,'search',{scoreId:'one'})]),config:{...experiment([]).config,persona_id:2}}]));
  assert.throws(()=>learnActionPolicyModel([{...experiment([result(.5,'search',{scoreId:'one'})]),config:{...experiment([]).config,persona_id:2,noise:true}}]),/Clean Persona/);
  assert.throws(()=>learnActionPolicyModel([{...experiment([result(.5,'search',{scoreId:'one'})]),config:{...experiment([]).config,resolved_models:{investigation_policy:{provider:'openai',model:'gpt'}}}}]),/qwen3.7-flash/);
});

test('validator remains compatible with v2 and v3 learned models',()=>{
  const current=learnActionPolicyModel([experiment([result(.5,'search',{scoreId:'one'})])]);
  assert.doesNotThrow(()=>validateActionPolicyModel({...current,version:'careharness-action-value-model.v3-query-type-relative-return'}));
  assert.doesNotThrow(()=>validateActionPolicyModel({...current,version:'careharness-action-value-model.v2-relative-return',training_scope:{...current.training_scope,uses_task_label:false}}));
});

test('MedLoCoMo counterfactual policy is hash-bound, case-free and explicitly loadable from a file',()=>{
  const model=medLoCoMoModel(),directory=mkdtempSync(join(tmpdir(),'careharness-medlocomo-action-')),path=join(directory,'policy.json');writeFileSync(path,JSON.stringify(model));
  const loaded=loadActionPolicyModel(path,{expected_benchmark:'medlocomo'}),input={query_type:'medical_reasoning',current_information:{memory_nodes:[],assessment:null,verification:null},previous_steps:[],remaining_budget:7,allowed_workers:['search','answer']},prior=withLearnedActionPrior(input,loaded).learned_action_prior;
  assert.equal(loaded.model_hash,model.model_hash);assert.equal(prior.ranked_actions[0].worker,'search');assert.equal(prior.comparison_quality.mode,'patient_disjoint_counterfactual_graph_rollout');assert.ok(prior.comparison_quality.reliability<1);
  assert.throws(()=>validateActionPolicyModel({...model,prior_strength:999}),/hash does not match/);
  const [key]=Object.keys(model.contexts),unsafeKey=key.replace('query_type=medical_reasoning','query_type=What treatment did patient 11826927 receive?'),unsafeBody={...model,contexts:{[unsafeKey]:model.contexts[key]}};delete unsafeBody.model_hash;const unsafe={...unsafeBody,model_hash:digest(stable(unsafeBody))};assert.throws(()=>validateActionPolicyModel(unsafe),/invalid query_type/);
});

test('MedLoCoMo greedy acceptance is derived from all held-out objectives',()=>{
  const candidate=medLoCoMoModel();
  assert.deepEqual(medLoCoMoActionPolicyAcceptance(candidate),{accepted:false,metrics_accepted:false,declared_eligible:false,reason:'validation_metrics_missing'});
  const body={...candidate,training_scope:{...candidate.training_scope,deployment_eligible:true},validation:{...candidate.validation,accepted:true,learned_minus_baseline:{exact_turn_recall:.01,all_evidence_rate:0,mean_action_cost:-.01}}};delete body.model_hash;const accepted={...body,model_hash:digest(stable(body))};
  assert.equal(medLoCoMoActionPolicyAcceptance(accepted).accepted,true);assert.doesNotThrow(()=>validateActionPolicyModel(accepted));
  const failedBody={...body,validation:{...body.validation,learned_minus_baseline:{exact_turn_recall:.01,all_evidence_rate:-.01,mean_action_cost:-.01}}};delete failedBody.model_hash;const failed={...failedBody,model_hash:digest(stable(failedBody))};
  assert.throws(()=>validateActionPolicyModel(failed),/cannot be marked deployable/);
  const nullBody={...body,validation:{...body.validation,learned_minus_baseline:{exact_turn_recall:null,all_evidence_rate:null,mean_action_cost:null}}};delete nullBody.model_hash;const nullMetrics={...nullBody,model_hash:digest(stable(nullBody))};
  assert.equal(medLoCoMoActionPolicyAcceptance(nullMetrics).metrics_accepted,false);assert.throws(()=>validateActionPolicyModel(nullMetrics),/cannot be marked deployable/);
  const sampledBody={...body,validation:{...body.validation,case_count:48,exact_turn_case_count:20}};delete sampledBody.model_hash;const sampled={...sampledBody,model_hash:digest(stable(sampledBody))};
  assert.equal(medLoCoMoActionPolicyAcceptance(sampled).reason,'validation_not_applicable');assert.throws(()=>validateActionPolicyModel(sampled),/cannot be marked deployable/);
  const stringCountBody={...body,validation:{...body.validation,case_count:'516'}};delete stringCountBody.model_hash;const stringCount={...stringCountBody,model_hash:digest(stable(stringCountBody))};
  assert.equal(medLoCoMoActionPolicyAcceptance(stringCount).reason,'validation_not_applicable');assert.throws(()=>validateActionPolicyModel(stringCount),/cannot be marked deployable/);
});

test('MedLoCoMo training snapshot and real flattened policy view produce the same Action state key',()=>{
  const request=createQuestionRequest({question:'What changed?',query_type:'longitudinal_progression',strategy_namespace:'medlocomo'}),memoryNodes=[{memory_id:'m1',episode_id:'a1',text:'one'},{memory_id:'m2',episode_id:'a2',text:'two'}],workerState={last_worker:'search',trace:{candidate_count:37,selected_episode_count:2}},snapshot={memory_nodes:memoryNodes,memory_edges:[],worker_state:workerState},steps=[{worker:'search',changed:true}],raw=abstractMedLoCoMoActionPolicyState({query_type:'longitudinal_progression',current_information:snapshot,previous_steps:steps,remaining_budget:5}),view=policyView(createInvestigationState({request,snapshot,history:[]}),{allowed_workers:['search','context'],remaining_budget:5}),flattened=abstractMedLoCoMoActionPolicyState({query_type:'longitudinal_progression',current_information:view.current_information,previous_steps:steps,remaining_budget:5});
  assert.equal(view.current_information.worker_state.candidate_count,37);assert.equal(view.current_information.worker_state.selected_episode_count,2);assert.deepEqual(flattened,raw);
});

test('default MedLoCoMo Action probe loads only a fully accepted artifact',()=>{
  const directory=mkdtempSync(join(tmpdir(),'careharness-medlocomo-default-action-')),missing=loadDefaultMedLoCoMoActionPolicy({path:join(directory,'missing.json')});assert.equal(missing.status,'not_found');assert.equal(missing.model,null);
  const candidate=medLoCoMoModel(),rejectedPath=join(directory,'rejected.json');writeFileSync(rejectedPath,JSON.stringify(candidate));const rejected=loadDefaultMedLoCoMoActionPolicy({path:rejectedPath});assert.equal(rejected.status,'rejected');assert.equal(rejected.reason,'validation_metrics_missing');assert.equal(rejected.model,null);
  const body={...candidate,training_scope:{...candidate.training_scope,deployment_eligible:true},validation:{...candidate.validation,accepted:true,learned_minus_baseline:{exact_turn_recall:0,all_evidence_rate:.01,mean_action_cost:-.01}}};delete body.model_hash;const accepted={...body,model_hash:digest(stable(body))},acceptedPath=join(directory,'accepted.json');writeFileSync(acceptedPath,JSON.stringify(accepted));const loaded=loadDefaultMedLoCoMoActionPolicy({path:acceptedPath});assert.equal(loaded.status,'loaded');assert.equal(loaded.model_hash,accepted.model_hash);assert.equal(loaded.model.model_hash,accepted.model_hash);
  const advisoryBody={...candidate,training_scope:{...candidate.training_scope,advisory_eligible:true},validation:{...candidate.validation,applies_to_serialized_model:false,runtime_environment_parity:false,retrieval_stack_parity:true,experimental_advisory_accepted:true,learned_minus_baseline:{exact_turn_recall:0,all_evidence_rate:.01,mean_action_cost:-.01}}};delete advisoryBody.model_hash;const advisory={...advisoryBody,model_hash:digest(stable(advisoryBody))},advisoryPath=join(directory,'advisory.json');writeFileSync(advisoryPath,JSON.stringify(advisory));assert.equal(medLoCoMoActionPolicyAcceptance(advisory).accepted,false);assert.equal(medLoCoMoActionPolicyAdvisoryAcceptance(advisory).accepted,true);const advisoryLoaded=loadDefaultMedLoCoMoActionPolicy({path:advisoryPath}),prior=withLearnedActionPrior({query_type:'medical_reasoning',current_information:{memory_nodes:[]},previous_steps:[],remaining_budget:7,allowed_workers:['search','answer']},advisory);assert.equal(advisoryLoaded.status,'loaded');assert.equal(advisoryLoaded.execution,'advisory');assert.equal(advisoryLoaded.reason,'experimental_advisory');assert.equal(prior.learned_action_prior.comparison_quality.mode,'patient_disjoint_retrieval_stack_advisory');assert.ok(prior.learned_action_prior.comparison_quality.reliability>.2&&prior.learned_action_prior.comparison_quality.reliability<=.6);
});

function medLoCoMoModel(){
  const trainCommitment='a'.repeat(64),validationCommitment='166669200359c91649418b44453686a9a0a867e2e622001e4cc8666b81393912',instructionHash='b'.repeat(64),state=abstractMedLoCoMoActionPolicyState({query_type:'medical_reasoning',current_information:{memory_nodes:[]},previous_steps:[],remaining_budget:7}),key=stateKey(state),backoff=stateKey({query_type:state.query_type,node_count:state.node_count,episode_count:state.episode_count,assessment:state.assessment,verification:state.verification,last_worker:state.last_worker,last_changed:state.last_changed,remaining_budget:state.remaining_budget}),rows=[{worker:'search',count:10,effective_weight:10,mean:.8},{worker:'answer',count:10,effective_weight:10,mean:.2}],body={version:MEDLOCOMO_ACTION_POLICY_MODEL_VERSION,training_scope:{benchmark:'medlocomo',runtime_eligible:true,counterfactual_worker_rollout:true,patient_count:97,rollout_case_count:100,train_set_commitment:trainCommitment,validation_set_commitment:validationCommitment,runtime_uses_question_text:false,runtime_uses_gold_or_judge_content:false,runtime_retains_case_content:false},state_features:Object.keys(state),prior_strength:4,contexts:{[key]:rows},backoff_contexts:{[backoff]:rows},global_actions:rows,validation:{patient_disjoint:true,patient_count:4,case_count:516,exact_turn_case_count:258,applies_to_serialized_model:true,runtime_environment_parity:true,validation_graph_source:'frozen_production_sqlite',validation_graph_memory_compatible:true,production_pairwise_ranker_used:true,production_embedding_selector_used:true,production_instruction_policy_used:true,production_instruction_policy_artifact_hash:instructionHash,instruction_policy_train_patient_count:97,instruction_policy_validation_patient_count:4,instruction_policy_train_set_commitment:trainCommitment,instruction_policy_validation_set_commitment:validationCommitment,instruction_policy_final_refit:false,embedding_runtime_contract_matched:true,pairwise_valid_for_held_out_claims:true,pairwise_validation_patients_included:false,pairwise_train_patient_count:97,pairwise_validation_patient_count:4,pairwise_train_set_commitment:trainCommitment,pairwise_validation_set_commitment:validationCommitment,runtime_stack_execution:validRuntimeExecution(instructionHash),one_step_best_action_accuracy:.7,one_step_mean_action_regret:.1}};return{...body,model_hash:digest(stable(body))};
}
function validRuntimeExecution(instructionHash='b'.repeat(64)){return{embedding_expected_dimensions:384,embedding_observed_dimensions:[384],embedding_observed_providers:['local'],embedding_observed_models:['Xenova/all-MiniLM-L6-v2'],embedding_observed_model_revisions:['751bff37182d3f1213fa05d7196b954e230abad9'],embedding_observed_model_revision_verifications:['local_snapshot_sha256'],embedding_observed_base_models:['sentence-transformers/all-MiniLM-L6-v2'],embedding_observed_base_model_revisions:['1110a243fdf4706b3f48f1d95db1a4f5529b4d41'],embedding_observed_snapshot_hashes:[MEDLOCOMO_EMBEDDING_SNAPSHOT_HASH],embedding_observed_snapshot_file_hash_commitments:[digest(stable(MEDLOCOMO_EMBEDDING_SNAPSHOT_FILE_HASHES))],embedding_observed_normalized:[true],embedding_observed_chunk_turn_counts:[6],embedding_attempted:3,embedding_completed:3,embedding_failed:0,pairwise_attempted:3,pairwise_applied:3,pairwise_failed:0,instruction_prior_attempted:3,instruction_prior_completed:3,instruction_prior_failed:0,instruction_prior_observed_artifact_hashes:[instructionHash]};}
function stateKey(value){return Object.keys(value).sort().map(key=>`${key}=${String(value[key])}`).join('|');}
function digest(value){return createHash('sha256').update(value).digest('hex');}
function stable(value){if(Array.isArray(value))return`[${value.map(stable).join(',')}]`;if(value&&typeof value==='object')return`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;return JSON.stringify(value);}
