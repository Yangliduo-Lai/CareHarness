import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { adapters } from '../src/adapters/index.js';
import { Store } from '../src/db.js';
import { ExperimentHarness,mergeMedMemoryMqOptionContexts,parseMedMemoryMqOptions,queryVisibleContext } from '../src/experiments.js';
import { MEDMEMORY_QUERY_METRICS,medMemoryJudgeInput,medMemoryJudgeMaxTokens,renderMedMemoryJudgePrompt,scoreMedMemoryEmptyAnswer,scoreMedMemoryJudge,validateMedMemoryJudgeOutput } from '../src/medmemory-official.js';
import { MEDMEMORY_ANSWER_PROMPT_TEMPLATES,MEDMEMORY_CHINESE_ANSWER_REQUIREMENT,MEDMEMORY_CHINESE_JUDGE_REQUIREMENT,MEDMEMORY_SHARED_SYSTEM_PROMPT,medMemoryAnswerMessages,promptFor } from '../src/prompts.js';

const A=adapters();

test('MedMemory MQ parses options for independent retrieval and preserves the shared stem',()=>{
  const parsed=parseMedMemoryMqOptions('医生，我该怎么处理？\n\nA. 方案一\nB．方案二\nC、方案三\nD: 方案四');
  assert.equal(parsed.stem,'医生，我该怎么处理？');
  assert.deepEqual(parsed.options,[{letter:'A',text:'方案一'},{letter:'B',text:'方案二'},{letter:'C',text:'方案三'},{letter:'D',text:'方案四'}]);
});

test('MedMemory MQ merges independently retrieved State round-robin without producing option verdicts',()=>{
  const node=id=>({memory_id:id,text:id}),context=nodes=>({answer_ready:true,memory_nodes:nodes,memory_edges:[],semantic_evaluation:{assessment:'supported',relevant_memory_ids:nodes.map(item=>item.memory_id),covered_aspects:nodes.map(item=>item.text),answer_focus:[],connections:[],reasoning_hypotheses:[],missing_information:[]},investigation_trace:[],trace:{investigation:{turns:[]},semantic_relation_evaluator:{status:'completed',model_calls:1}}});
  const merged=mergeMedMemoryMqOptionContexts({questionRequest:{question:'Q'},patientProfile:null,recentSessions:[],optionRuns:[{letter:'A',text:'a',context:context([node('a1'),node('shared'),node('a2')])},{letter:'B',text:'b',context:context([node('b1'),node('shared'),node('b2')])}]});
  assert.deepEqual(merged.memory_nodes.map(item=>item.memory_id),['a1','b1','shared','a2','b2']);
  assert.equal(merged.answer_ready,true);assert.equal(merged.mq_option_retrieval.options.length,2);
  assert.equal('verdict' in merged.mq_option_retrieval.options[0],false);
});

test('query context rejects a node whose stored source span no longer matches its Observation',()=>{
  const observation={observation_id:'obs-query-grounding',subject_id:'p',source_type:'structured',episode_id:'session-1',turn_id:'session',event_time:'2024-01-01',raw_text:'患者只是前来复查。'},node={memory_id:'tampered',observation_id:observation.observation_id,subject_id:'p',text:'患者已确诊原文不存在的疾病。',source_text:'患者已经确诊疾病。',span:[0,9],source_type:'structured',episode_id:'session-1',turn_id:'session',event_time:'2024-01-01',certainty:1,polarity:'affirmed',families:['CS'],factor_key:'diagnosis',factor_domains:['biological'],status:'active',valid_from:'2024-01-01',version:1,version_chain:[],predecessor_memory_id:null,successor_memory_id:null,conflicts_with_memory_id:null,operation:'ADD'},context=queryVisibleContext({benchmark:'medmemorybench',item:{metadata:{visible_episode_ids:['session-1']}},data:{observations:[observation]},allMemoryNodes:[node],allMemoryEdges:[],sourceObservationById:new Map([[observation.observation_id,observation]]),stateProjection:true});
  assert.deepEqual(context.memory_nodes,[]);assert.equal(context.source_grounding_policy.observation_verified_memory_node_count,1);assert.equal(context.source_grounding_policy.quarantined_memory_node_count,1);assert.equal(context.source_grounding_policy.reason_counts.source_span_text_mismatch,1);
});

class MockGateway{
  constructor(model='mock'){this.config={provider:'mock',model}}
  publicConfig(){return this.config}
  async completeJSON(_component,input,validator,mockFactory){const value=validator(await mockFactory(input));return{value,trace:null}}
}

class StaticLiveGateway{
  constructor(model,response,calls){this.config={provider:'live-test',model};this.response=response;this.calls=calls}
  publicConfig(){return this.config}
  async completeJSON(component,input,validator,_mockFactory,options){this.calls.push({component,input,options,model:this.config.model});const raw=typeof this.response==='function'?this.response(component,input):this.response,value=validator(raw);return{value,trace:{component,provider:this.config.provider,model:this.config.model,model_input:input,prompt:'official-test-prompt',raw_model_response:JSON.stringify(raw),parsed_response:value,token_input:10,token_output:5,latency_ms:1,mock:false}}}
  async completeText(component,input,_mockFactory,options){this.calls.push({component,input,options,model:this.config.model});const raw=typeof this.response==='function'?this.response(component,input):this.response,value=String(raw?.answer??raw);return{value,trace:{component,provider:this.config.provider,model:this.config.model,model_input:input,prompt:'official-test-prompt',raw_model_response:value,parsed_response:value,token_input:10,token_output:5,latency_ms:1,mock:false}}}
}

test('MedMemoryBench exposes the official six-type metric mapping',()=>{
  assert.deepEqual(MEDMEMORY_QUERY_METRICS,{entity_exact_match:'string_contain',temporal_localization:'llm_judge',state_update:'llm_judge',multiple_choice:'option_match',inference_generation:'llm_judge',multi_hop_clinical_deduction:'llm_judge_mcd'});
});

test('MedMemory cases retain official evaluation metadata behind the post-answer boundary',()=>{
  const item=A.medmemorybench.cases(A.medmemorybench.load({persona_id:1,max_session:10,query_type:'inference_generation'}))[0],answerVisible={task:item.task,question:item.question,answer_contract:item.metadata.answer_contract};
  assert.equal(item.metadata.official_evaluation.metric,'llm_judge');
  assert.ok(item.metadata.official_evaluation.answers_data[0].explanation);
  assert.ok(item.metadata.official_evaluation.metadata.trap_design.required_patient_info.length);
  assert.equal(JSON.stringify(answerVisible).includes('required_patient_info'),false);
  assert.equal(JSON.stringify(answerVisible).includes('common_wrong_answer'),false);
  assert.match(item.metadata.answer_contract.grounding,/Gold answers.*unavailable/);
  assert.match(item.metadata.answer_contract.format,/patient’s specific remembered information/);
  assert.match(item.metadata.answer_contract.format,/avoid boilerplate/);
  assert.equal(JSON.stringify(item.metadata.answer_contract).includes('required_patient_info'),false);
  assert.equal(JSON.stringify(item.metadata.answer_contract).includes('common_wrong_answer'),false);
});

test('all six query types keep the pre-existing answer contract while using the official evaluator family',()=>{
  const items=A.medmemorybench.cases(A.medmemorybench.load({persona_id:1,max_session:100})),byType=Object.fromEntries(items.map(item=>[item.task,item]));
  for(const[task,metric]of Object.entries(MEDMEMORY_QUERY_METRICS)){
    const item=byType[task];assert.ok(item,task);assert.equal(item.metadata.official_evaluation.metric,metric);assert.equal(Object.hasOwn(item.metadata.answer_contract,'official_prompt'),false);assert.equal(JSON.stringify(item.metadata.answer_contract).includes(JSON.stringify(item.gold[0])),false,task);
  }
  for(const task of ['temporal_localization','state_update','inference_generation'])assert.equal(medMemoryJudgeMaxTokens(byType[task]),500,task);
  assert.equal(medMemoryJudgeMaxTokens(byType.multi_hop_clinical_deduction),2000);
});

test('localized Judge prompts preserve the byte-identical appendix body and add only the Chinese free-text requirement',()=>{
  const digest=value=>createHash('sha256').update(value).digest('hex'),judgeHashes={temporal_localization:'d20a9b5a01eb635cbcb8723691bcd7f84aaf13f2fab18210b67a5e3488c17e5b',state_update:'378a4f657162f604571a1ca7f1dacaf44b1bccac651837e8992097cfed8f530b',inference_generation:'357e4ddd33d2b761af1feac7fe1249592d700f69046aac3859762f7c9142aaa6',multi_hop_clinical_deduction:'f7490960d6bce7e431daf84b06eb12da991e758ac6983d68c284577585ca4ec6'};
  for(const[task,hash]of Object.entries(judgeHashes)){const localized=renderMedMemoryJudgePrompt({query_type:task,question:'Q',expected_answer:'A',explanation:'E',metadata:{},model_output:'O'}),official=localized.replace(`${MEDMEMORY_CHINESE_JUDGE_REQUIREMENT}\n\n`,'');assert.match(localized,/Simplified Chinese/);assert.equal(digest(official),hash,task);}
});

test('the IG Answer Prompt is rendered from the appendix without hidden Judge data',()=>{const item=A.medmemorybench.cases(A.medmemorybench.load({persona_id:1,max_session:10,query_type:'inference_generation'}))[0],input={task:item.task,question:'医生，我要不要把降糖药加量？',memory_nodes:[{memory_id:'m1',text:'患者已规律用药。',families:['PE']}],memory_edges:[]},prompt=promptFor('medmemory_answer',input),messages=medMemoryAnswerMessages(input);assert.equal(messages[0].content,MEDMEMORY_SHARED_SYSTEM_PROMPT);assert.match(prompt,/considering the patient’s allergy history, medical history, medications, and personal preferences/);assert.match(prompt,/do not give generic medical advice/);assert.match(prompt,/患者已规律用药/);assert.match(prompt,new RegExp(MEDMEMORY_CHINESE_ANSWER_REQUIREMENT.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&')));assert.ok(prompt.endsWith('Answer:'));assert.doesNotMatch(prompt,/required_patient_info|common_wrong_answer|expected_answer|Gold|Transport Requirement/);});

test('the MCD Answer Prompt keeps the appendix body and a transparent grounded overlay',()=>{const item=A.medmemorybench.cases(A.medmemorybench.load({persona_id:1,max_session:100,query_type:'multi_hop_clinical_deduction'}))[0],input={task:item.task,question:item.question,memory_nodes:[{memory_id:'m1',text:'2024-01-15 患者停用恩格列净。',families:['PE','CS'],event_time:'2024-01-15'}],memory_edges:[]},prompt=promptFor('medmemory_answer',input);assert.match(prompt,/carefully review the patient’s complete medical history/);assert.match(prompt,/combining information from multiple visits/);assert.match(prompt,/Clearly list the memory content/);assert.match(prompt,/clear reasoning path from evidence to conclusions/);assert.match(prompt,/final comprehensive judgment/);assert.match(prompt,/normally 4–10/);assert.match(prompt,/Never invent a patient event or output internal IDs/);assert.match(prompt,/within 1800 Chinese characters/);assert.match(prompt,/2024-01-15 患者停用恩格列净/);assert.ok(prompt.endsWith('Answer:'));assert.doesNotMatch(prompt,/required_memory_nodes|reasoning_chain|expected_answer|common_wrong_answer/);});

test('all six MedMemory answer contracts follow the appendix requirements',()=>{const items=A.medmemorybench.cases(A.medmemorybench.load({persona_id:1,max_session:100})),byTask=Object.fromEntries(items.map(item=>[item.task,item.metadata.answer_contract]));assert.match(byTask.entity_exact_match.format,/target entity name directly/);assert.match(byTask.temporal_localization.format,/YYYY-MM-DD/);assert.match(byTask.state_update.format,/most recent status/);assert.match(byTask.multiple_choice.format,/B or B,D/);assert.match(byTask.inference_generation.format,/specific remembered information/);assert.match(byTask.multi_hop_clinical_deduction.format,/final comprehensive judgment/);});

test('official EEM is normalized string containment and official MQ is exact A-F option-set match',()=>{
  const items=A.medmemorybench.cases(A.medmemorybench.load({persona_id:1,max_session:10})),eem=items.find(item=>item.score_id==='session_10_eem_1'),mq=items.find(item=>item.score_id==='session_10_mq_1');
  assert.equal(A.medmemorybench.compatibleScore('患者的疾病是：糖尿病。',eem.gold,eem).score,1);
  assert.equal(A.medmemorybench.compatibleScore('diabetes',eem.gold,eem).score,0);
  assert.equal(A.medmemorybench.compatibleScore('A“B”',['ab'],{task:'entity_exact_match'}).score,0);
  assert.equal(A.medmemorybench.compatibleScore('答案是 B、C',mq.gold,mq).score,1);
  assert.equal(A.medmemorybench.compatibleScore('B',mq.gold,mq).score,0);
  assert.equal(A.medmemorybench.compatibleScore('B、C、F',mq.gold,mq).score,0);
});

test('EEM canonicalization preserves clinical result markers and generic acronym/name equivalence',()=>{
  const marker=A.medmemorybench.compatibleScore('（++）',['++'],{task:'entity_exact_match'}),diagnosis=A.medmemorybench.compatibleScore('慢性阻塞性肺疾病（COPD）',['COPD慢性阻塞性肺疾病'],{task:'entity_exact_match'}),diagnosisWithAlias=A.medmemorybench.compatibleScore('COPD/COLD（慢性阻塞性肺疾病）',['COPD慢性阻塞性肺疾病'],{task:'entity_exact_match'}),range=A.medmemorybench.compatibleScore('根据记录，检查结果是 11 到 14 mg/L。',['11–14mg/L'],{task:'entity_exact_match'});
  assert.equal(marker.score,1);
  assert.deepEqual(marker.details.match_kinds,[{answer:'++',kind:'normalized_containment'}]);
  assert.equal(diagnosis.score,1);
  assert.deepEqual(diagnosis.details.match_kinds,[{answer:'COPD慢性阻塞性肺疾病',kind:'acronym_name_order_equivalence'}]);
  assert.equal(diagnosisWithAlias.score,1);
  assert.deepEqual(diagnosisWithAlias.details.match_kinds,[{answer:'COPD慢性阻塞性肺疾病',kind:'acronym_name_order_equivalence'}]);
  assert.equal(range.score,1);
  assert.equal(A.medmemorybench.compatibleScore('慢性阻塞性肺疾病（COLD）',['COPD慢性阻塞性肺疾病'],{task:'entity_exact_match'}).score,0);
});

test('official SUA keeps the complete answer for memory-grounding judgment instead of collapsing to a label',()=>{
  const item=A.medmemorybench.cases(A.medmemorybench.load({persona_id:1,max_session:10,query_type:'state_update'}))[0],answer='根据 1 月 15 日复诊记录，患者已按医嘱停用恩格列净。';
  assert.match(item.metadata.answer_contract.format,/most recent status/);
  assert.equal(A.medmemorybench.normalizeAnswer(answer,item),answer);
  assert.throws(()=>A.medmemorybench.compatibleScore(answer,item.gold,item),/requires the official LLM judge/);
});

test('official IG Judge prompt receives hidden references only after the system answer is frozen',()=>{
  const item=A.medmemorybench.cases(A.medmemorybench.load({persona_id:1,max_session:10,query_type:'inference_generation'}))[0],input=medMemoryJudgeInput('这是已经冻结的系统回答。',item),prompt=renderMedMemoryJudgePrompt(input);
  assert.match(prompt,/这是已经冻结的系统回答/);
  assert.match(prompt,/Required patient info:/);
  assert.match(prompt,/Common wrong answer:/);
  assert.match(prompt,/final recommendation\/conclusion should be fully consistent with the reference answer in direction/);
  assert.doesNotMatch(JSON.stringify(item.metadata.answer_contract),/required_patient_info|common_wrong_answer/);
});

test('official MCD composite scoring preserves NCR, CRC, CC and retrieval penalties',()=>{
  const item={task:'multi_hop_clinical_deduction',gold:['标准结论'],metadata:{official_evaluation:{metric:'llm_judge_mcd',answers_data:[{content:'标准结论',is_correct:true,explanation:'说明'}],metadata:{}}}},judge={node_validations:[],ncr_score:.8,crc_score:.9,cc_score:.7,memory_retrieval_quality:'good',uses_patient_specific_info:true,is_correct:true,reason:'通过'};
  assert.deepEqual(validateMedMemoryJudgeOutput(judge,item),judge);
  assert.throws(()=>validateMedMemoryJudgeOutput({...judge,node_validations:[{node_id:1,mentioned:true,causal_link_correct:true,note:'missing field'}]},item),/specific_data_matched must be boolean/);
  const result=scoreMedMemoryJudge(judge,item);
  assert.equal(result.is_correct,true);
  assert.ok(Math.abs(result.score-((.8*.35+.9*.35+.7*.30)*.9))<1e-12);
  assert.equal(result.details.ncr_score,.8);
  assert.equal(result.details.metric,'llm_judge_mcd');
});

test('MedMemory IG preserves the original answer gateway and adds only a scoring Judge',async()=>{
  const store=new Store(':memory:'),calls=[],pipeline=new MockGateway('pipeline-mock'),policy=new MockGateway('policy-mock'),answer=new StaticLiveGateway('answer-model',{answer:'患者近期规律服药仍恶化并持续掉重、多饮多尿，应尽快评估胰岛功能和抗体并考虑胰岛素，不要自行加量。'},calls),scoringJudge=new StaticLiveGateway('claude-sonnet-4',{is_correct:true,reason:'回答使用了患者特异信息且结论一致。'},calls),registry={pipelineOptions:()=>({gateway:pipeline}),assignmentSnapshot:()=>({global:pipeline.config,investigation_policy:policy.config,judge:answer.config,scoring_judge:scoringJudge.config}),gateway:component=>component==='judge'?answer:component==='scoring_judge'?scoringJudge:policy},harness=new ExperimentHarness(store,undefined,registry),item=A.medmemorybench.cases(A.medmemorybench.load({persona_id:1,max_session:10,query_type:'inference_generation'}))[0],observations=[{subject_id:'official-ig-test',source_type:'patient',episode_id:'session-1',turn_id:'1',event_time:'2024-01-01',raw_text:'我一直按时吃降糖药，但血糖仍升高，而且持续掉重、多饮多尿。'}];
  harness.adapters.synthetic=syntheticOfficialAdapter(item,observations);
  const done=await harness.start('synthetic',{max_queries:1}),score=done.results.find(value=>value.kind==='score'),answerCall=calls.find(value=>value.component==='medmemory_answer'),judgeCall=calls.find(value=>value.component==='medmemory_judge');
  assert.equal(score.status,'scored');
  assert.equal(score.scoring_method,'medmemory_official_llm_judge');
  assert.equal(score.score,1);
  assert.ok(answerCall);
  assert.ok(judgeCall);
  for(const hidden of ['gold','official_evaluation','expected_answer','judge_metadata'])assert.equal(Object.hasOwn(answerCall.input,hidden),false,hidden);
  assert.ok(Array.isArray(answerCall.input.memory_source.recent_sessions));
  assert.ok(Array.isArray(answerCall.input.memory_source.historical_memory_nodes));
  assert.ok(Array.isArray(answerCall.input.memory_source.memory_edges));
  assert.equal(Object.hasOwn(answerCall.input,'question_request'),false);
  assert.equal(Object.hasOwn(answerCall.input,'investigation_trace'),false);
  assert.equal(Object.hasOwn(answerCall.input,'protocol'),false);
  assert.equal(JSON.stringify(answerCall.input).includes('required_patient_info'),false);
  assert.equal(JSON.stringify(answerCall.input).includes('common_wrong_answer'),false);
  assert.equal(judgeCall.input.model_output,score.system_output);
  assert.ok(judgeCall.input.metadata.trap_design.required_patient_info.length);
  assert.equal(judgeCall.options.maxTokens,500);
  assert.equal(score.answer_model_trace.model,'answer-model');
  assert.equal(score.judge_model_trace.model,'claude-sonnet-4');
  store.close();
});

test('MedMemory LLM-judged tasks are explicitly unscored when only Offline Mock Judge is configured',async()=>{
  const store=new Store(':memory:'),harness=new ExperimentHarness(store),item=A.medmemorybench.cases(A.medmemorybench.load({persona_id:1,max_session:10,query_type:'inference_generation'}))[0],observations=[{subject_id:'official-ig-mock-test',source_type:'patient',episode_id:'session-1',turn_id:'1',event_time:'2024-01-01',raw_text:'我一直按时吃药，但血糖仍升高。'}];harness.adapters.synthetic=syntheticOfficialAdapter(item,observations);const done=await harness.start('synthetic',{max_queries:1}),score=done.results.find(value=>value.kind==='score');
  assert.equal(done.status,'completed');
  assert.equal(score.status,'skipped');
  assert.equal(score.score,null);
  assert.equal(score.scoring_method,'medmemory_official_judge_required');
  assert.match(score.scoring_reason,/configured live scoring Judge model/);
  store.close();
});

test('an empty MedMemory answer keeps the official zero-score shortcut at scoring time',()=>{const item=A.medmemorybench.cases(A.medmemorybench.load({persona_id:1,max_session:10,query_type:'inference_generation'}))[0],score=scoreMedMemoryEmptyAnswer(item);assert.equal(score.score,0);assert.equal(score.is_correct,false);assert.equal(score.reason,'Model provided no response')});

test('a configured Judge failure follows the official zero fallback and remains auditable',async()=>{
  const store=new Store(':memory:'),calls=[],pipeline=new MockGateway('pipeline-mock'),policy=new MockGateway('policy-mock'),answer=new StaticLiveGateway('answer-model',{answer:'患者特异性回答。'},calls),judge={config:{provider:'live-test',model:'broken-judge'},publicConfig(){return this.config},async completeJSON(component){const error=new Error('judge endpoint unavailable');error.gatewayTrace={component,provider:'live-test',model:'broken-judge',error:{message:error.message}};throw error}},registry={pipelineOptions:()=>({gateway:pipeline}),assignmentSnapshot:()=>({global:pipeline.config,investigation_policy:policy.config,judge:answer.config,scoring_judge:judge.config}),gateway:component=>component==='judge'?answer:component==='scoring_judge'?judge:policy},harness=new ExperimentHarness(store,undefined,registry),item=A.medmemorybench.cases(A.medmemorybench.load({persona_id:1,max_session:10,query_type:'inference_generation'}))[0],observations=[{subject_id:'official-judge-failure-test',source_type:'patient',episode_id:'session-1',turn_id:'1',event_time:'2024-01-01',raw_text:'患者有一段相关历史。'}];harness.adapters.synthetic=syntheticOfficialAdapter(item,observations);const done=await harness.start('synthetic',{max_queries:1}),score=done.results.find(value=>value.kind==='score');
  assert.equal(done.status,'completed');assert.equal(score.status,'scored');assert.equal(score.score,0);assert.equal(score.is_correct,false);assert.equal(score.scoring_reason,'Judge failed');assert.equal(score.judge_infrastructure_failure,true);assert.equal(score.judge_model_trace.error.message,'judge endpoint unavailable');assert.equal(done.progress.retrieval_metrics.judge_infrastructure_failure_count,1);store.close();
});

test('official MCD aggregates expose NCR, CRC, CC and node rates',async()=>{
  const store=new Store(':memory:'),calls=[],pipeline=new MockGateway('pipeline-mock'),policy=new MockGateway('policy-mock'),answer=new StaticLiveGateway('answer-model',{answer:'记忆1；记忆2；因此得到综合结论。'},calls),judgeResult={node_validations:[{node_id:1,mentioned:true,specific_data_matched:true,causal_link_correct:true,note:'具体数据匹配。'},{node_id:2,mentioned:false,specific_data_matched:false,causal_link_correct:false,note:'未覆盖。'}],ncr_score:.8,crc_score:.75,cc_score:.7,memory_retrieval_quality:'excellent',uses_patient_specific_info:true,is_correct:true,reason:'通过'},judge=new StaticLiveGateway('judge-model',judgeResult,calls),registry={pipelineOptions:()=>({gateway:pipeline}),assignmentSnapshot:()=>({global:pipeline.config,investigation_policy:policy.config,judge:answer.config,scoring_judge:judge.config}),gateway:component=>component==='judge'?answer:component==='scoring_judge'?judge:policy},harness=new ExperimentHarness(store,undefined,registry),item=A.medmemorybench.cases(A.medmemorybench.load({persona_id:1,max_session:100,query_type:'multi_hop_clinical_deduction'}))[0],observations=[{subject_id:'official-mcd-test',source_type:'patient',episode_id:'session-1',turn_id:'1',event_time:'2024-01-01',raw_text:'患者有两段需要联合分析的历史信息。'}];harness.adapters.synthetic=syntheticOfficialAdapter(item,observations);const done=await harness.start('synthetic',{max_queries:1}),summary=done.progress.retrieval_metrics.by_query_type.multi_hop_clinical_deduction;
  assert.equal(summary.avg_ncr,.8);assert.equal(summary.avg_crc,.75);assert.equal(summary.avg_cc,.7);assert.equal(summary.total_nodes_validated,2);assert.equal(summary.node_mention_rate,.5);assert.equal(summary.node_causal_rate,.5);store.close();
});

function syntheticOfficialAdapter(item,observations){const official=A.medmemorybench;return{load:()=>({observations}),cases:()=>[{...item,metadata:{...item.metadata,visible_episode_ids:['session-1']}}],normalizeAnswer:(...args)=>official.normalizeAnswer(...args),compatibleScore:(...args)=>official.compatibleScore(...args),requiresOfficialJudge:(...args)=>official.requiresOfficialJudge(...args),officialJudgeInput:(...args)=>official.officialJudgeInput(...args),officialJudgeMaxTokens:(...args)=>official.officialJudgeMaxTokens(...args),validateOfficialJudge:(...args)=>official.validateOfficialJudge(...args),scoreOfficialJudge:(...args)=>official.scoreOfficialJudge(...args),scoreOfficialEmptyAnswer:(...args)=>official.scoreOfficialEmptyAnswer(...args),scoreOfficialJudgeFailure:(...args)=>official.scoreOfficialJudgeFailure(...args)};}
