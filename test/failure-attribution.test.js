import test from 'node:test';
import assert from 'node:assert/strict';
import { attributeFailure,failureTaxonomyReport } from '../src/failure-attribution.js';

const baseScore={kind:'score',score_id:'q1',task:'entity_exact_match',status:'scored',question:'患者服用什么药？',system_output:'不知道',gold:['二甲双胍'],score:0,is_correct:false,scoring_method:'test',scoring_reason:'遗漏二甲双胍'};

test('counterfactual audit assigns H1 when raw Session contains target but Evidence does not',()=>{
  const result=attributeFailure({score:baseScore,raw_observations:[{observation_id:'o1',raw_text:'患者正在服用二甲双胍。'}],all_evidence:[{evidence_id:'e1',text:'患者血糖偏高。'}],all_states:[],runtime_context:{states:[],action_trace:[]}});
  assert.equal(result.code,'H1');
  assert.deepEqual(result.counterfactual_checks.map(item=>item.stage),['raw_session','Evidence','State','Working_State','relation/verify-route','verify','answer','scorer']);
  assert.equal(result.diagnostic_boundary.phase,'post_answer_offline_only');
  assert.equal(result.diagnostic_boundary.runtime_input_modified,false);
});

test('failure report selects the most frequent harness class',()=>{
  const h1={code:'H1',axis:'harness'},h4={code:'H4',axis:'harness'},m3={code:'M3',axis:'model_foundation'},report=failureTaxonomyReport([h1,h1,h4,m3]);
  assert.equal(report.counts.H1,2);assert.equal(report.high_frequency_harness_failure,'H1');assert.equal(report.axis.harness,3);
});

test('a relation-evaluator schema/model failure is attributed to M1 instead of H5',()=>{
  const score={...baseScore,task:'multi_hop_clinical_deduction',retrieval_trace:{semantic_relation_evaluator:{status:'failed',model_calls:1,error:'invalid evaluator payload',error_kind:'schema_error',token_input:30,token_output:4,latency_ms:8,pre_semantic_verification:{safe_to_answer:true}}}},runtime={action_trace:['focus','trace','connect','evaluate','verify','answer'].map(action=>({action,status:'completed'})),relations:[],proof:{complete:false},working_state:{temporal:{resolved_state_ids:['s1']},evidence:{verification:{gold_or_judge_input_used:false}}},verification:{gold_or_judge_input_used:false}};
  const result=attributeFailure({score,runtime_context:runtime});
  assert.equal(result.code,'M1');
  assert.equal(result.axis,'model_foundation');
  const relation=result.counterfactual_checks.find(item=>item.stage==='relation/verify-route');
  assert.equal(relation.support_chain_satisfied,false);
  assert.equal(relation.semantic_evaluator_status,'failed');
  assert.equal(relation.semantic_evaluator_error_kind,'schema_error');
  assert.equal(relation.pre_semantic_verification_safe_to_answer,true);
});

test('a relation-evaluator transport/provider failure is attributed to X3 instead of H5',()=>{
  const score={...baseScore,task:'inference_generation',retrieval_trace:{semantic_relation_evaluator:{status:'failed',model_calls:1,error:'provider unavailable',model_trace:{error:{kind:'transport_error',message:'network unavailable'}}}}},runtime={action_trace:['focus','trace','connect','evaluate','verify','answer'].map(action=>({action,status:'completed'})),relations:[],proof:{complete:false},working_state:{temporal:{resolved_state_ids:['s1']},evidence:{verification:{gold_or_judge_input_used:false}}},verification:{gold_or_judge_input_used:false}};
  const result=attributeFailure({score,runtime_context:runtime});
  assert.equal(result.code,'X3');
  assert.equal(result.axis,'external');
  assert.match(result.reason,/provider, transport, or runtime configuration/);
});
