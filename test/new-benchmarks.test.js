import test from 'node:test';
import assert from 'node:assert/strict';
import { cpcdAnswerInput,cpcdAnswerMaxTokens,cpcdJudgeInput,cpcdJudgeMaxTokens,scoreCpcdJudge,validateCpcdJudgeOutput } from '../src/cpcd-official.js';
import { ModelGateway } from '../src/gateway.js';
import { cpcdAnswerMessages,cpcdJudgeMessages } from '../src/prompts.js';

test('CPCD validators follow the separate SR and MR/TCR online-script schemas',()=>{
  const srg={score_id:'s',task:'session_level_response_generation'},mr={score_id:'m',task:'memory_recall'};
  const clamped=validateCpcdJudgeOutput({scores:{empathy:{score:0},coherence:{score:6},professionalism:{score:3}}},srg);
  assert.deepEqual(Object.values(clamped.scores).map(item=>item.score),[1,5,3]);assert.equal(clamped.overall.average_score,3);
  const pythonIntSemantics=validateCpcdJudgeOutput({scores:{accuracy:4.8,completeness:true,temporal_consistency:3,no_hallucination:5}},mr);
  assert.deepEqual(pythonIntSemantics.scores,{accuracy:4,completeness:1,temporal_consistency:3,no_hallucination:5});
  const zero=validateCpcdJudgeOutput({scores:{accuracy:0,completeness:0,temporal_consistency:0,no_hallucination:0},rationales:{accuracy:'none'},overall_comment:'zero'},mr);
  assert.equal(zero.average_score,0);assert.equal(zero.rationales.accuracy,'none');
  assert.throws(()=>validateCpcdJudgeOutput({scores:{accuracy:{score:1},completeness:0,temporal_consistency:0,no_hallucination:0}},mr),/accuracy must be an integer/);
  const scored=scoreCpcdJudge({scores:{empathy:{score:5,reason:'e'},coherence:{score:4,reason:'c'},professionalism:{score:3,reason:'p'}},overall:{summary:'ok'}},srg);
  assert.equal(scored.score,.8);assert.equal(scored.is_correct,null);assert.equal(scored.details.scale,'1-5');assert.equal(scored.details.classification_threshold,null);
});

test('CPCD post-answer Judge input follows task-specific reference and history defaults',()=>{
  const item={score_id:'s',task:'session_level_response_generation',question:'respond',gold:['reference'],metadata:{case_id:'c',task_file:'c.json',full_session_file:'c_fullsession.json',official_input:{current_student_utterance:'help'},representative_point:'point',evaluation_focus:{empathy:'criterion'},full_consultation_history:null}};
  const input=cpcdJudgeInput('candidate',item);
  assert.equal(input.model_response,'candidate');assert.equal(input.representative_point,'point');assert.equal(input.reference_answer,null);assert.equal(input.full_consultation_history,null);assert.deepEqual(input.dimensions,['empathy','coherence','professionalism']);
  const mr=cpcdJudgeInput('candidate',{score_id:'m',task:'memory_recall',question:'what',gold:['reference'],metadata:{answer_source:{primary_session:3},full_consultation_history:[{role:'Student',content:'history'}]}});
  assert.equal(mr.reference_answer,'reference');assert.equal(mr.answer_source.primary_session,3);assert.equal(mr.evaluation_focus,null);
  const tcr=cpcdJudgeInput('candidate',{score_id:'t',task:'temporal_causal_reasoning',question:'why',gold:['reference'],metadata:{evaluation_focus:{temporal_accuracy:'criterion'},full_consultation_history:[{role:'Student',content:'history'}]}});
  assert.equal(tcr.reference_answer,'reference');assert.equal(tcr.evaluation_focus.temporal_accuracy,'criterion');assert.equal(tcr.full_consultation_history.length,1);
});

test('CPCD Answer input exposes only the official SR input or CareHarness MR/TCR memory',()=>{
  const runtime={retrieved_states:[{state_id:'s1'}],retrieved_evidence:[{evidence_id:'e1'}]},item={score_id:'m',task:'memory_recall',question:'Q',gold:['HIDDEN_REFERENCE'],metadata:{case_id:'c',task_file:'c.json',full_session_file:'c_fullsession.json',official_input:{consultation_history:'placeholder'},representative_point:'HIDDEN_POINT',answer_source:{secret:'HIDDEN_SOURCE'},evaluation_focus:{secret:'HIDDEN_EVALUATION'},official_rubric:'HIDDEN_RUBRIC',full_consultation_history:[{content:'HIDDEN_RAW_HISTORY'}]}};
  const answerInput=cpcdAnswerInput(runtime,item),serialized=JSON.stringify(answerInput);
  assert.equal(answerInput.prompt_protocol,'official-online-template-adapted-careharness-memory');assert.deepEqual(answerInput.memory_source.states,[{state_id:'s1'}]);
  for(const hidden of ['HIDDEN_REFERENCE','HIDDEN_POINT','HIDDEN_SOURCE','HIDDEN_EVALUATION','HIDDEN_RUBRIC','HIDDEN_RAW_HISTORY'])assert.equal(serialized.includes(hidden),false,hidden);
  assert.equal(cpcdAnswerMaxTokens(item),512);assert.equal(cpcdJudgeMaxTokens(item),1200);assert.equal(cpcdAnswerMaxTokens({...item,task:'temporal_causal_reasoning'}),3000);assert.equal(cpcdJudgeMaxTokens({...item,task:'temporal_causal_reasoning'}),2200);
});

test('CPCD transport uses plain-text Answer messages and task-specific JSON Judge messages',async()=>{
  const originalFetch=globalThis.fetch,requests=[];
  globalThis.fetch=async(_url,options)=>{
    const request=JSON.parse(options.body);requests.push(request);
    const content=requests.length===1?'我听见了你的挫败，我们可以一起慢慢看看。':JSON.stringify({task_id:'s1',scores:{empathy:{score:5,reason:'e'},coherence:{score:4,reason:'c'},professionalism:{score:5,reason:'p'}},overall:{average_score:4.67,summary:'ok'},risk_flags:['无']});
    return new Response(JSON.stringify({choices:[{message:{content},finish_reason:'stop'}]}),{status:200});
  };
  try{
    const gateway=new ModelGateway({provider:'openai-compatible',base_url:'https://cpcd.test/v1',model:'configured-model',retries:0},{apiKey:'session-key'}),officialInput={student_profile_summary:'画像',history_until_previous_session:'历史',current_session_event:'事件',current_session_context:[{role:'Student',content:'上下文'}],current_student_utterance:'最新发言'},answerInput={task_id:'s1',task_type:'session_level_response_generation',input_to_model:officialInput};
    const answer=await gateway.completeText('cpcd_answer',answerInput,()=>{throw new Error('unexpected mock')},{maxTokens:800});
    const judgeInput={task_id:'s1',task_type:'session_level_response_generation',input_to_model:officialInput,representative_point:'核心点',evaluation_focus:{empathy:'标准'},official_rubric:'rubric',model_response:answer.value};
    await gateway.completeJSON('cpcd_judge',judgeInput,value=>validateCpcdJudgeOutput(value,{score_id:'s1',task:'session_level_response_generation'}),()=>{throw new Error('unexpected mock')},{maxTokens:1200,extractJsonObject:true});
    assert.deepEqual(requests[0].messages,cpcdAnswerMessages(answerInput));assert.equal(Object.hasOwn(requests[0],'response_format'),false);
    assert.deepEqual(requests[1].messages,cpcdJudgeMessages(judgeInput));assert.deepEqual(requests[1].response_format,{type:'json_object'});
  }finally{globalThis.fetch=originalFetch;}
});
