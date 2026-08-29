import test from 'node:test';
import assert from 'node:assert/strict';
import { abstractActionPolicyState,actionPolicyLearningManifest,actionPolicyTrajectoryEligibility,learnActionPolicyModel,validateActionPolicyModel,withActionExploration,withLearnedActionPrior } from '../src/action-policy-learning.js';

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
