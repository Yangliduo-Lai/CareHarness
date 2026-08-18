import test from'node:test';
import assert from'node:assert/strict';
import{Store}from'../src/db.js';
import{ExperimentHarness}from'../src/experiments.js';
import{adapters}from'../src/adapters/index.js';
import{ModelGateway}from'../src/gateway.js';
import{medLoCoMoJudgeInput,medLoCoMoTokenF1,normalizeMedLoCoMoAnswer,scoreMedLoCoMoAbstention,validateMedLoCoMoJudgeOutput}from'../src/medlocomo-official.js';
import{benchmarkAnswerContract,promptFor}from'../src/prompts.js';

test('MedLoCoMo token F1 follows official normalization and comma-aware matching',()=>{
  assert.equal(medLoCoMoTokenF1('The acute kidney injury.','acute kidney injury'),1);
  assert.equal(medLoCoMoTokenF1('rehab facility, home','home, rehab facility'),1);
  assert.equal(medLoCoMoTokenF1('acute injury','acute kidney injury'),.8);
  assert.equal(normalizeMedLoCoMoAnswer('The Answer, Here!'),'answer here');
});

test('MedLoCoMo adversarial matcher accepts normalized abstentions but rejects explanations',()=>{
  for(const answer of ['the question is not answerable','Cannot be determined.','not mentioned','not answerable from the record'])assert.equal(scoreMedLoCoMoAbstention(answer).score,1,answer);
  assert.equal(scoreMedLoCoMoAbstention('The question is not answerable because cultures were negative.').score,0);
  assert.equal(scoreMedLoCoMoAbstention('Insufficient grounded evidence in the visible history.').score,0);
});

test('MedLoCoMo Judge input and prompt reproduce the answerable-only binary contract',()=>{
  const item={score_id:'q-1',question:'What kidney issue developed?',gold:['acute kidney injury']},input=medLoCoMoJudgeInput('AKI',item),valid=validateMedLoCoMoJudgeOutput({judgments:[{qa_id:'q-1',score:1}]},item),prompt=promptFor('medlocomo_judge',input);
  assert.deepEqual(input,{items:[{qa_id:'q-1',question:'What kidney issue developed?',gold_answer:'acute kidney injury',candidate_answer:'AKI'}]});
  assert.deepEqual(valid,{judgments:[{qa_id:'q-1',score:1}]});
  assert.match(prompt,/Judge only from the provided question, gold_answer, and candidate_answer/);
  assert.match(prompt,/Return exactly one judgment per provided qa_id/);
  assert.throws(()=>validateMedLoCoMoJudgeOutput({judgments:[{qa_id:'wrong',score:1}]},item),/qa_id/);
  assert.throws(()=>validateMedLoCoMoJudgeOutput({judgments:[{qa_id:'q-1',score:.5}]},item),/0 or 1/);
});

test('MedLoCoMo Judge uses the official system and user message roles',async()=>{
  const priorFetch=globalThis.fetch;let request;
  globalThis.fetch=async(_url,options)=>{request=JSON.parse(options.body);return new Response(JSON.stringify({choices:[{message:{content:'{"judgments":[{"qa_id":"q-roles","score":1}]}'},finish_reason:'stop'}]}),{status:200});};
  try{const gateway=new ModelGateway({provider:'openai-compatible',base_url:'https://judge.test/v1',model:'current-judge'},{apiKey:'session-key'}),item={score_id:'q-roles'},input={items:[{qa_id:'q-roles',question:'Q',gold_answer:'A',candidate_answer:'A'}]};await gateway.completeJSON('medlocomo_judge',input,value=>validateMedLoCoMoJudgeOutput(value,item),()=>{throw new Error('unexpected mock')});assert.deepEqual(request.messages.map(message=>message.role),['system','user']);assert.match(request.messages[0].content,/Judge only from the provided question/);assert.equal(request.messages[1].content,JSON.stringify(input));}
  finally{globalThis.fetch=priorFetch;}
});

test('MedLoCoMo answer contracts are short and canonicalize adversarial abstention',()=>{
  for(const task of ['medical_reasoning','care_plan_rationale','longitudinal_progression','cross_admission_comparison','frequency_pattern'])assert.match(benchmarkAnswerContract('medlocomo',task).format,/at most 10 words/);
  assert.match(benchmarkAnswerContract('medlocomo','adversarial').format,/exactly: the question is not answerable/);
});

test('MedLoCoMo records official metrics and can rescore a frozen complete current-State snapshot',async()=>{
  const store=new Store(':memory:'),calls=[],pipeline=new StaticGateway('mock','pipeline',calls),planner=new StaticGateway('mock','planner',calls),answer=new StaticGateway('live-test','answer',calls),medJudge=new StaticGateway('live-test','medlocomo-judge',calls),medMemoryJudge=new StaticGateway('mock','medmemory-judge',calls),registry={pipelineOptions:()=>({gateway:pipeline}),assignmentSnapshot:()=>({global:pipeline.config,query_planner:planner.config,judge:answer.config,scoring_judge:medMemoryJudge.config,medlocomo_judge:medJudge.config}),gateway:component=>component==='judge'?answer:component==='medlocomo_judge'?medJudge:component==='scoring_judge'?medMemoryJudge:planner},harness=new ExperimentHarness(store,undefined,registry),official=adapters().medlocomo,observations=[{subject_id:'medlocomo-metric-test',source_type:'patient',episode_id:'admission-1',turn_id:'1',event_time:'2024-01-01',raw_text:'The patient developed acute kidney injury.'}],items=[{score_id:'answerable-1',task:'medical_reasoning',question:'What kidney issue developed?',gold:['acute kidney injury'],metadata:{answer_contract:benchmarkAnswerContract('medlocomo','medical_reasoning'),scope:'single_admission',official_evaluation:{benchmark:'medlocomo',metric:'answerable_token_f1+answerable_llm_judge'}}},{score_id:'adversarial-1',task:'adversarial',question:'Which culture confirmed the source?',gold:['the question is not answerable'],metadata:{answer_contract:benchmarkAnswerContract('medlocomo','adversarial'),scope:'single_admission',official_evaluation:{benchmark:'medlocomo',metric:'adversarial_abstention_accuracy'}}}];
  harness.adapters.medlocomo={load:()=>({observations}),cases:(_data,config)=>{assert.equal(config.mode,'single_admission');return items;},normalizeAnswer:value=>official.normalizeAnswer(value),requiresOfficialJudge:item=>official.requiresOfficialJudge(item),compatibleScore:(...args)=>official.compatibleScore(...args),officialJudgeInput:(...args)=>official.officialJudgeInput(...args),validateOfficialJudge:(...args)=>official.validateOfficialJudge(...args),scoreOfficialJudge:(...args)=>official.scoreOfficialJudge(...args),scoreOfficialJudgeUnavailable:(...args)=>official.scoreOfficialJudgeUnavailable(...args)};
  const done=await harness.start('medlocomo',{mode:'single_admission'}),answerable=done.results.find(item=>item.score_id==='answerable-1'),adversarial=done.results.find(item=>item.score_id==='adversarial-1'),metrics=done.progress.retrieval_metrics.medlocomo_official.overall;
  assert.equal(done.status,'completed');
  assert.equal(answerable.scoring_method,'medlocomo_official_answerable_llm_judge');
  assert.equal(answerable.scoring_details.answerable_token_f1,1);
  assert.equal(answerable.scoring_details.answerable_judge_score,1);
  assert.equal(answerable.judge_model_trace.model,'medlocomo-judge');
  assert.equal(adversarial.scoring_method,'medlocomo_official_adversarial_abstention_matcher');
  assert.equal(adversarial.judge_model_trace,null);
  assert.deepEqual({f1:metrics.answerable_token_f1,judge:metrics.answerable_judge_accuracy,abstention:metrics.adversarial_abstention_accuracy,combined:metrics.combined_score},{f1:1,judge:1,abstention:1,combined:1});
  assert.ok(calls.some(call=>call.component==='medlocomo_judge'));
  assert.equal(done.config.resolved_models.medlocomo_judge.model,'medlocomo-judge');
  const before={states:store.statesFor('medlocomo-metric-test'),evidence:store.evidenceFor('medlocomo-metric-test'),runs:store.db.prepare(`SELECT COUNT(*) AS n FROM runs`).get().n},rescored=await harness.start('medlocomo',{mode:'single_admission',score_only_current_state:true}),after={states:store.statesFor('medlocomo-metric-test'),evidence:store.evidenceFor('medlocomo-metric-test'),runs:store.db.prepare(`SELECT COUNT(*) AS n FROM runs`).get().n};
  assert.equal(rescored.status,'completed');assert.equal(rescored.config.score_only_current_state,true);assert.equal(rescored.progress.total,0);assert.equal(rescored.results.filter(item=>item.run_id).length,0);assert.equal(rescored.progress.memory_build_completeness.status,'not_run_current_state');assert.equal(rescored.config.current_state_snapshot.source_admission_count,1);assert.ok(rescored.results.filter(item=>item.kind==='score').every(item=>item.memory_completeness.policy==='answer_and_score_frozen_current_state'));assert.deepEqual(after,before);
  store.close();
});

class StaticGateway{
  constructor(provider,model,calls){this.config={provider,model};this.calls=calls;}
  publicConfig(){return this.config;}
  async completeJSON(component,input,validator,mockFactory){this.calls.push({component,input,model:this.config.model});let raw;if(this.config.provider==='mock')raw=await mockFactory(input);else if(component==='judge')raw={answer:input.task==='adversarial'?'the question is not answerable':'acute kidney injury'};else if(component==='medlocomo_judge')raw={judgments:[{qa_id:input.items[0].qa_id,score:1}]};else raw=await mockFactory(input);const value=validator?validator(raw):raw;return{value,trace:{component,provider:this.config.provider,model:this.config.model,token_input:1,token_output:1,latency_ms:0,model_input:input,parsed_response:value,error:null,mock:this.config.provider==='mock'}};}
}
