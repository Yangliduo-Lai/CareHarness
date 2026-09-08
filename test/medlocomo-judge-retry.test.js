import test from 'node:test';
import assert from 'node:assert/strict';
import {MedLoCoMoAdapter} from '../src/adapters/medlocomo.js';
import {retryMedLoCoMoJudgeOnly} from '../src/experiments.js';

const item={score_id:'q1',task:'medical_reasoning',question:'What happened?',gold:['acute kidney injury'],metadata:{official_evaluation:{metric:'answerable_token_f1+answerable_llm_judge'}}};
const base={kind:'score',score_id:'q1',task:item.task,status:'failed',system_output:'acute kidney injury',gold:item.gold,score:null,is_correct:null,scoring_method:'medlocomo_official_answerable_judge_required',scoring_reason:'fetch failed',official_judge_input:{items:[{qa_id:'q1',question:item.question,gold_answer:'acute kidney injury',candidate_answer:'acute kidney injury'}]},judge_infrastructure_failure:true,latency_ms:100};

test('MedLoCoMo infrastructure retry reuses the frozen answer and replaces only Judge fields',async()=>{
  let calls=0;const gateway={completeJSON:async(_component,input,validator)=>{calls++;return{value:validator({judgments:[{qa_id:'q1',score:1}]}),trace:{token_input:10,latency_ms:12,input}};}};
  const result=await retryMedLoCoMoJudgeOnly({base,item,adapter:new MedLoCoMoAdapter('/tmp'),gateway});
  assert.equal(calls,1);assert.equal(result.system_output,base.system_output);assert.equal(result.status,'scored');assert.equal(result.is_correct,true);assert.equal(result.judge_infrastructure_failure,false);assert.deepEqual(result.judge_retry,{mode:'judge_only',attempted:true,recovered:true,answer_reused:true});
});

test('MedLoCoMo infrastructure retry remains failed when the second Judge call fails',async()=>{
  const error=Object.assign(new Error('fetch failed again'),{gatewayTrace:{component:'medlocomo_judge',error:{kind:'transport_error',message:'fetch failed again'}}}),gateway={completeJSON:async()=>{throw error;}};
  const result=await retryMedLoCoMoJudgeOnly({base,item,adapter:new MedLoCoMoAdapter('/tmp'),gateway});
  assert.equal(result.status,'failed');assert.equal(result.system_output,base.system_output);assert.equal(result.judge_infrastructure_failure,true);assert.equal(result.judge_retry.recovered,false);
});
