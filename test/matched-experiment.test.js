import test from 'node:test';
import assert from 'node:assert/strict';
import { assertNoHiddenRuntimeInput,buildMatchedManifest,buildMatchedRuntimeContext,buildMatchedRuntimeContextWithEvaluator,MEDMEMORY_FROZEN_QUERY_COUNT } from '../src/matched-experiment.js';
import { MATCHED_EVALUATION_MODE } from '../src/careharness-contract.js';

const model={provider:'dashscope',base_url:'https://example.invalid',model:'same-model',temperature:0,max_tokens:1200};
const manifestInput={noise:false,persona_id:1,query_ids:Array.from({length:MEDMEMORY_FROZEN_QUERY_COUNT},(_,index)=>`q-${index+1}`),state_snapshot:{fingerprint:'f'.repeat(64),state_count:100,edge_count:40,evidence_count:80,complete_through_session:100},memory_pipeline_version:'patient-graph-memory-v13',models:{answer:model,scoring_judge:model,query_planner:model},seed:42,candidate_budget:24,action_budget:6};

test('matched manifest freezes the 97-query identity and is deterministically hashed',()=>{
  const left=buildMatchedManifest(manifestInput),right=buildMatchedManifest(manifestInput);
  assert.equal(left.version,'medmemory-matched-experiment.v6');
  assert.equal(left.query_count,97);assert.equal(left.manifest_hash,right.manifest_hash);
  assert.equal(left.evaluation_mode,MATCHED_EVALUATION_MODE);assert.equal(left.mandatory_evidence_index_gate,true);
  assert.equal(left.state_snapshot.pipeline_version,'patient-graph-memory-v13');
  assert.equal(Object.hasOwn(left,'decision_gates'),false);
  assert.equal(left.method_claims.persistent_cross_state_graph,true);
  assert.equal(left.method_claims.strict_causality_claimed,false);
  assert.equal(left.information_policy.runtime_gold_or_judge_metadata_allowed,false);
  assert.equal(left.models.relation_evaluator.model,left.models.answer.model);
  assert.equal(left.prompt_versions.relation_evaluator,'careharness-query-relation-evaluator.v2');
  assert.equal(left.prompt_versions.answer,'medmemorybench-answer.appendix-v1');
  assert.equal(left.prompt_versions.scoring_judge,'medmemorybench-official-judge.appendix-v1');
  assert.equal(left.budgets.relation_evaluator_call_budget,1);assert.equal(left.budgets.relation_edge_budget,8);
});

test('matched manifest rejects v11 and incomplete full-suite selections',()=>{
  assert.throws(()=>buildMatchedManifest({...manifestInput,memory_pipeline_version:'six-state-session-memory-v12'}),/exact v13/);
  assert.throws(()=>buildMatchedManifest({...manifestInput,query_ids:['q-1']}),/exactly 97/);
  assert.throws(()=>buildMatchedManifest({...manifestInput,models:{...manifestInput.models,relation_evaluator:{...model,model:'different-model'}}}),/exactly the Answer Model configuration/);
  assert.throws(()=>buildMatchedManifest({...manifestInput,models:{...manifestInput.models,relation_evaluator:{...model,temperature:.2}}}),/exactly the Answer Model configuration/);
});

test('matched runtime is fixed to Static CareHarness with mandatory EIG',()=>{
  const item={task:'entity_exact_match',question:'患者服用什么药？'},query_plan={query_type:item.task,question:item.question,keywords:['二甲双胍'],state_scopes:[{family:'CS',priority:'primary'}],temporal_operator:'current'},evidence=[{evidence_id:'e1',subject_id:'p1',episode_id:'session-1',turn_id:'1',source_type:'patient',text:'患者服用二甲双胍。'}],states=[{state_id:'s1',subject_id:'p1',family:'CS',value:'患者服用二甲双胍。',status:'active',version:1,version_chain:[],evidence_ids:['e1'],episode_id:'session-1',event_time:'2025-01-01'}];
  const output=buildMatchedRuntimeContext({item,query_plan,states,evidence,candidate_budget:4,action_budget:6});
  assert.equal(output.evaluation_mode,MATCHED_EVALUATION_MODE);assert.equal(output.trace.mandatory_evidence_index_gate,true);assert.equal(Object.hasOwn(output,'retrieved_observations'),false);assert.ok(output.states.some(state=>state.state_id==='s1'));
});

test('legacy comparator modes are rejected instead of silently changing the runtime',()=>{
  for(const evaluation_mode of ['direct','long_context','bm25','general_harness']){
    assert.throws(()=>buildMatchedManifest({...manifestInput,evaluation_mode}),/fixed to static_careharness/);
    assert.throws(()=>buildMatchedRuntimeContext({evaluation_mode,item:{task:'entity_exact_match',question:'q'},query_plan:{query_type:'entity_exact_match',question:'q'}}),/fixed to static_careharness/);
  }
});

test('Gold and Judge metadata are rejected from runtime inputs',()=>{
  assert.throws(()=>assertNoHiddenRuntimeInput({question:'q',nested:{gold:'hidden'}}),/Forbidden post-answer field/);
  assert.throws(()=>buildMatchedRuntimeContext({item:{task:'entity_exact_match',question:'q'},query_plan:{query_type:'entity_exact_match',gold:'hidden'}}),/Forbidden post-answer field/);
  assert.equal(assertNoHiddenRuntimeInput({question:'q',working_state:null}),true);
});

test('matched complex runtime uses one frozen semantic evaluator call and accounts for its model cost',async()=>{
  const fixture=complexFixture();let calls=0;
  const output=await buildMatchedRuntimeContextWithEvaluator({...fixture,candidate_budget:8,action_budget:6,relation_evaluator:async input=>{
    calls++;assertNoHiddenRuntimeInput(input);
    return{value:supportedRelationEvaluation(),trace:{provider:'test',model:'same-model',prompt_version:'careharness-query-relation-evaluator.v2',token_input:17,token_output:9,latency_ms:4.2}};
  }});
  assert.equal(calls,1);
  assert.deepEqual({status:output.trace.semantic_relation_evaluator.status,calls:output.trace.semantic_relation_evaluator.model_calls,input:output.trace.semantic_relation_evaluator.token_input,output:output.trace.semantic_relation_evaluator.token_output,total:output.trace.semantic_relation_evaluator.total_tokens,latency:output.trace.semantic_relation_evaluator.latency_ms},{status:'completed',calls:1,input:17,output:9,total:26,latency:4.2});
  assert.equal(output.action_trace.find(action=>action.action==='evaluate').cost_units,2);
  assert.equal(output.action_policy.total_cost_units,6);
  assert.equal(output.trace.careharness_action_policy.total_cost_units,6);
  assert.equal(output.pre_semantic_verification.safe_to_answer,true);
  assert.deepEqual(output.trace.semantic_relation_evaluator.pre_semantic_verification,output.pre_semantic_verification);
  assert.equal(output.proof.verdict,'supported');
  assert.equal(output.action_trace.at(-1).outcome.status,'supported');
  assert.ok(output.relations.every(item=>item.persistent===false&&item.causal_claim===false));
  assert.deepEqual(new Set(output.relations.map(item=>item.type)),new Set(['care_targets','observed_after_care']));
});

test('a complex matched runtime that requires semantic evaluation rejects a missing callback as configuration failure',async()=>{
  await assert.rejects(()=>buildMatchedRuntimeContextWithEvaluator(complexFixture()),/relation_evaluator callback is required/);
  const simple={item:{task:'entity_exact_match',question:'患者吃什么药？'},query_plan:{query_type:'entity_exact_match',question:'患者吃什么药？',keywords:['二甲双胍'],state_scopes:[{family:'CS',priority:'primary'}],temporal_operator:'none'},states:[state('simple','CS','患者服用二甲双胍。','e-simple')],evidence:[evidence('e-simple','患者服用二甲双胍。')]};
  const output=await buildMatchedRuntimeContextWithEvaluator(simple);
  assert.equal(output.trace.semantic_relation_evaluator.status,'skipped_already_supported');
  assert.equal(output.trace.semantic_relation_evaluator.model_calls,0);
});

test('semantic evaluator skips blocked verification and audits a failed provider call without disguising NO_LINK',async()=>{
  const blockedEvidence=[evidence('e-conflict','患者用药状态存在冲突。')],blockedStates=[{...state('conflict','CS','患者用药状态存在冲突。','e-conflict'),status:'conflict'}],item={task:'inference_generation',question:'用药状态意味着什么？'},query_plan={query_type:item.task,question:item.question,keywords:['用药状态','冲突'],state_scopes:[{family:'CS',priority:'primary'}],temporal_operator:'history'};let calls=0;
  const blocked=await buildMatchedRuntimeContextWithEvaluator({item,query_plan,states:blockedStates,evidence:blockedEvidence,relation_evaluator:async()=>{calls++;return{verdict:'unresolved',relations:[]}}});
  assert.equal(calls,0);assert.equal(blocked.trace.semantic_relation_evaluator.status,'skipped_verification_blocked');assert.equal(blocked.action_trace.at(-1).outcome.status,'uncertain');assert.equal(blocked.action_policy.total_cost_units,5);
  const gatewayTrace={provider:'test',model:'same-model',token_input:7,token_output:0,latency_ms:5,error:{kind:'transport_error',message:'provider unavailable'}},failed=await buildMatchedRuntimeContextWithEvaluator({...complexFixture(),relation_evaluator:async()=>{const error=new Error('semantic verifier unavailable');error.gatewayTrace=gatewayTrace;throw error}});
  assert.deepEqual({status:failed.trace.semantic_relation_evaluator.status,calls:failed.trace.semantic_relation_evaluator.model_calls,input:failed.trace.semantic_relation_evaluator.token_input,output:failed.trace.semantic_relation_evaluator.token_output,total:failed.trace.semantic_relation_evaluator.total_tokens,latency:failed.trace.semantic_relation_evaluator.latency_ms},{status:'failed',calls:1,input:7,output:0,total:7,latency:5});
  assert.match(failed.trace.semantic_relation_evaluator.error,/unavailable/);
  assert.equal(failed.action_trace.find(action=>action.action==='evaluate').outcome.semantic_evaluator_status,'failed');
  assert.equal(failed.action_trace.find(action=>action.action==='evaluate').cost_units,2);
  assert.equal(failed.action_policy.total_cost_units,6);
  assert.equal(failed.trace.careharness_action_policy.total_cost_units,6);
  assert.equal(failed.pre_semantic_verification.safe_to_answer,true);
  assert.equal(failed.trace.semantic_relation_evaluator.no_link,undefined);
});

function complexFixture(){
  const item={task:'multi_hop_clinical_deduction',question:'治疗后为何仍恶化？'},query_plan={query_type:item.task,question:item.question,keywords:['糖尿病','治疗','恶化'],state_scopes:[{family:'CS',priority:'primary'},{family:'CP',priority:'primary'},{family:'LO',priority:'primary'}],temporal_operator:'history'},evidenceItems=[evidence('e1','患者有糖尿病。'),evidence('e2','医生开始治疗，针对患者有糖尿病。'),evidence('e3','医生开始治疗后，患者状态仍恶化。')],states=[state('s1','CS','患者有糖尿病。','e1'),state('s2','CP','医生开始治疗。','e2'),state('s3','LO','患者状态仍恶化。','e3')];
  return{item,query_plan,states,evidence:evidenceItems};
}

function supportedRelationEvaluation(){return{verdict:'supported',relations:[{from_state_id:'s2',to_state_id:'s1',relation_type:'care_targets',relation_evidence_id:'e2',relation_quote:'医生开始治疗，针对患者有糖尿病。',from_claim_quote:'医生开始治疗',to_claim_quote:'患者有糖尿病',assessment:'supports',confidence:.9},{from_state_id:'s2',to_state_id:'s3',relation_type:'observed_after_care',relation_evidence_id:'e3',relation_quote:'医生开始治疗后，患者状态仍恶化。',from_claim_quote:'医生开始治疗',to_claim_quote:'患者状态仍恶化',assessment:'supports',confidence:.9}],competing_hypotheses_checked:true,competing_hypotheses:['其他机制'],missing_evidence:[],no_link_reason:''};}
function evidence(evidence_id,text){return{evidence_id,subject_id:'p1',episode_id:'session-1',turn_id:'1',source_type:'doctor',text,certainty:1};}
function state(state_id,family,value,evidenceId){return{state_id,subject_id:'p1',family,value,status:'active',version:1,version_chain:[],evidence_ids:[evidenceId],episode_id:'session-1',event_time:'2025-01-01'};}
