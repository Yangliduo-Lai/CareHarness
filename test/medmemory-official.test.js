import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { adapters } from '../src/adapters/index.js';
import { Store } from '../src/db.js';
import { ExperimentHarness } from '../src/experiments.js';
import { MEDMEMORY_QUERY_METRICS,medMemoryJudgeInput,medMemoryJudgeMaxTokens,renderMedMemoryJudgePrompt,scoreMedMemoryEmptyAnswer,scoreMedMemoryJudge,validateMedMemoryJudgeOutput } from '../src/medmemory-official.js';
import { promptFor } from '../src/prompts.js';

const A=adapters();

class MockGateway{
  constructor(model='mock'){this.config={provider:'mock',model}}
  publicConfig(){return this.config}
  async completeJSON(_component,input,validator,mockFactory){const value=validator(await mockFactory(input));return{value,trace:null}}
}

class StaticLiveGateway{
  constructor(model,response,calls){this.config={provider:'live-test',model};this.response=response;this.calls=calls}
  publicConfig(){return this.config}
  async completeJSON(component,input,validator,_mockFactory,options){this.calls.push({component,input,options,model:this.config.model});const raw=typeof this.response==='function'?this.response(component,input):this.response,value=validator(raw);return{value,trace:{component,provider:this.config.provider,model:this.config.model,model_input:input,prompt:'official-test-prompt',raw_model_response:JSON.stringify(raw),parsed_response:value,token_input:10,token_output:5,latency_ms:1,mock:false}}}
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
  assert.match(item.metadata.answer_contract.grounding,/患者特异性事实只能来自提供的 State 和 Evidence/);
  assert.match(item.metadata.answer_contract.grounding,/可以使用一般医学知识/);
  assert.match(item.metadata.answer_contract.format,/先给出明确结论或建议/);
  assert.match(item.metadata.answer_contract.format,/治疗反应与纵向变化/);
  assert.match(item.metadata.answer_contract.format,/不得套用表面上合理的常见答案/);
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

test('official Judge templates stay byte-identical to commit 7227bc1',()=>{
  const digest=value=>createHash('sha256').update(value).digest('hex'),judgeHashes={temporal_localization:'ebf744c8df009be8fa1083d26097b23dff59ffce00c372c4f3e7f20a67b1086e',state_update:'3b941638f3f94e812a096bbcfdbc41c2683c568a76a7a2494b9b0e8e154712a7',inference_generation:'f3320fa172e355d19c5038657100f44576b0901a62f0fcf7e3a744eabd661514',multi_hop_clinical_deduction:'c22570443b12cd18d597f2e9982e2617f6b84c6717c997351da6ceff5ea06b13'};
  for(const[task,hash]of Object.entries(judgeHashes))assert.equal(digest(renderMedMemoryJudgePrompt({query_type:task,question:'Q',expected_answer:'A',explanation:'E',metadata:{},model_output:'O'})),hash,task);
});

test('the benchmark answer prompt carries the IG patient-specific reasoning contract without hidden Judge data',()=>{const item=A.medmemorybench.cases(A.medmemorybench.load({persona_id:1,max_session:10,query_type:'inference_generation'}))[0],input={task:item.task,question:'医生，我要不要把降糖药加量？',answer_contract:item.metadata.answer_contract,query_plan:{intent:'evaluate medication dosage adjustment decision'},retrieved_states:[],retrieved_evidence:[],protocol:null},prompt=promptFor('judge',input);assert.match(prompt,/benchmark task outside the core state pipeline/i);assert.match(prompt,/先给出明确结论或建议/);assert.match(prompt,/患者特异性推理/);assert.match(prompt,/既往风险与禁忌/);assert.match(prompt,/治疗失效、快速恶化/);assert.match(prompt,/可执行的下一步/);assert.match(prompt,/可以使用一般医学知识/);assert.doesNotMatch(prompt,/required_patient_info|common_wrong_answer|expected_answer/);});

test('the MCD answer prompt requires target-patient evidence, discriminative causal hops, and one valid transport payload',()=>{const item=A.medmemorybench.cases(A.medmemorybench.load({persona_id:1,max_session:100,query_type:'multi_hop_clinical_deduction'}))[0],input={task:item.task,question:item.question,answer_contract:item.metadata.answer_contract,query_plan:{intent:'connect longitudinal clinical facts'},retrieved_states:[],retrieved_evidence:[],protocol:null},prompt=promptFor('judge',input),contract=item.metadata.answer_contract,serialized=JSON.stringify(contract);assert.match(contract.grounding,/患者特异性事实只能来自提供的 State 和 Evidence/);assert.match(contract.grounding,/患者证据锚点/);assert.match(contract.grounding,/临床机制桥梁/);assert.match(contract.grounding,/即使病历没有逐字写出/);assert.match(contract.grounding,/只保留目标患者本人的记录/);assert.match(contract.grounding,/排除亲属、其他患者、通用病例、假设情形和泛化医学教育/);assert.match(contract.grounding,/区分肯定、否定与不确定表述/);assert.match(contract.grounding,/比较可能的解释/);assert.match(contract.grounding,/唯一一条.*主链/);assert.match(contract.grounding,/单个较早改善、单次正常结果/);assert.match(contract.grounding,/不能用医学常识填补/);assert.match(contract.format,/严格返回 \{"answer":"非空字符串"\}/);assert.match(contract.format,/最小充分患者证据集合/);assert.match(contract.format,/1\. 患者记忆/);assert.match(contract.format,/起始情况 → 关键转折 → 最新或终点表现/);assert.match(contract.format,/3–6 条最具因果判别力/);assert.match(contract.format,/至少覆盖两个不同时间点/);assert.match(contract.format,/2\. 推理链/);assert.match(contract.format,/3–5 个因果 hop/);assert.match(contract.format,/患者具体事实 → 生理或病理机制 → 下一项患者具体事实/);assert.match(contract.format,/药物作用、器官、代谢、激素、神经或微血管过程/);assert.match(contract.format,/3\. 结论/);assert.match(contract.format,/1–2 句话/);assert.match(contract.format,/日期或时间、数值及单位、药名和剂量/);assert.match(prompt,/不得复制内部 State\/Evidence ID/);assert.match(prompt,/不要写前言、后记、自我修正/);assert.match(contract.format,/JSON 外不得输出任何字符/);assert.match(contract.format,/第二份答案\/JSON/);assert.doesNotMatch(contract.format,/不要输出内部 State\/Evidence ID、JSON/);assert.doesNotMatch(serialized,/required_memory_nodes|reasoning_chain|expected_answer|common_wrong_answer/);assert.doesNotMatch(prompt,/required_memory_nodes|reasoning_chain|expected_answer|common_wrong_answer/);});

test('the expanded IG contract does not change other MedMemory answer formats',()=>{const items=A.medmemorybench.cases(A.medmemorybench.load({persona_id:1,max_session:100})),stateUpdate=items.find(item=>item.task==='state_update'),multipleChoice=items.find(item=>item.task==='multiple_choice');assert.equal(stateUpdate.metadata.answer_contract.grounding,'只能依据提供的 State 和 Evidence，不得使用 Gold、答案或 source key points。');assert.equal(stateUpdate.metadata.answer_contract.format,'使用中文回答目标对象的最新状态。先明确给出当前状态，再用一句话简要说明支持该状态的患者历史记录或状态变化；不要复述无关病史或其他药物。');assert.equal(multipleChoice.metadata.answer_contract.format,'只返回所有正确选项字母，使用英文逗号分隔，例如 A, B；多选不得遗漏。');});

test('official EEM is normalized string containment and official MQ is exact A-F option-set match',()=>{
  const items=A.medmemorybench.cases(A.medmemorybench.load({persona_id:1,max_session:10})),eem=items.find(item=>item.score_id==='session_10_eem_1'),mq=items.find(item=>item.score_id==='session_10_mq_1');
  assert.equal(A.medmemorybench.compatibleScore('患者的疾病是：糖尿病。',eem.gold,eem).score,1);
  assert.equal(A.medmemorybench.compatibleScore('diabetes',eem.gold,eem).score,0);
  assert.equal(A.medmemorybench.compatibleScore('A“B”',['ab'],{task:'entity_exact_match'}).score,0);
  assert.equal(A.medmemorybench.compatibleScore('答案是 B、C',mq.gold,mq).score,1);
  assert.equal(A.medmemorybench.compatibleScore('B',mq.gold,mq).score,0);
  assert.equal(A.medmemorybench.compatibleScore('B、C、F',mq.gold,mq).score,0);
});

test('official SUA keeps the complete answer for memory-grounding judgment instead of collapsing to a label',()=>{
  const item=A.medmemorybench.cases(A.medmemorybench.load({persona_id:1,max_session:10,query_type:'state_update'}))[0],answer='根据 1 月 15 日复诊记录，患者已按医嘱停用恩格列净。';
  assert.equal(item.metadata.answer_contract.format,'使用中文回答目标对象的最新状态。先明确给出当前状态，再用一句话简要说明支持该状态的患者历史记录或状态变化；不要复述无关病史或其他药物。');
  assert.equal(A.medmemorybench.normalizeAnswer(answer,item),answer);
  assert.throws(()=>A.medmemorybench.compatibleScore(answer,item.gold,item),/requires the official LLM judge/);
});

test('official IG Judge prompt receives hidden references only after the system answer is frozen',()=>{
  const item=A.medmemorybench.cases(A.medmemorybench.load({persona_id:1,max_session:10,query_type:'inference_generation'}))[0],input=medMemoryJudgeInput('这是已经冻结的系统回答。',item),prompt=renderMedMemoryJudgePrompt(input);
  assert.match(prompt,/这是已经冻结的系统回答/);
  assert.match(prompt,/Required patient info:/);
  assert.match(prompt,/Common wrong answer:/);
  assert.match(prompt,/最终建议\/结论应与标准答案方向完全一致/);
  assert.doesNotMatch(JSON.stringify(item.metadata.answer_contract),/required_patient_info|common_wrong_answer/);
});

test('official MCD composite scoring preserves NCR, CRC, CC and retrieval penalties',()=>{
  const item={task:'multi_hop_clinical_deduction',gold:['标准结论'],metadata:{official_evaluation:{metric:'llm_judge_mcd',answers_data:[{content:'标准结论',is_correct:true,explanation:'说明'}],metadata:{}}}},judge={node_validations:[],ncr_score:.8,crc_score:.9,cc_score:.7,memory_retrieval_quality:'good',uses_patient_specific_info:true,is_correct:true,reason:'通过'};
  assert.deepEqual(validateMedMemoryJudgeOutput(judge,item),judge);
  const result=scoreMedMemoryJudge(judge,item);
  assert.equal(result.is_correct,true);
  assert.ok(Math.abs(result.score-((.8*.35+.9*.35+.7*.30)*.9))<1e-12);
  assert.equal(result.details.ncr_score,.8);
  assert.equal(result.details.metric,'llm_judge_mcd');
});

test('MedMemory IG preserves the original answer gateway and adds only a scoring Judge',async()=>{
  const store=new Store(':memory:'),calls=[],pipeline=new MockGateway('pipeline-mock'),planner=new MockGateway('planner-mock'),answer=new StaticLiveGateway('answer-model',{answer:'患者近期规律服药仍恶化并持续掉重、多饮多尿，应尽快评估胰岛功能和抗体并考虑胰岛素，不要自行加量。'},calls),scoringJudge=new StaticLiveGateway('claude-sonnet-4',{is_correct:true,reason:'回答使用了患者特异信息且结论一致。'},calls),registry={pipelineOptions:()=>({gateway:pipeline}),assignmentSnapshot:()=>({global:pipeline.config,query_planner:planner.config,judge:answer.config,scoring_judge:scoringJudge.config}),gateway:component=>component==='judge'?answer:component==='scoring_judge'?scoringJudge:planner},harness=new ExperimentHarness(store,undefined,registry),item=A.medmemorybench.cases(A.medmemorybench.load({persona_id:1,max_session:10,query_type:'inference_generation'}))[0],observations=[{subject_id:'official-ig-test',source_type:'patient',episode_id:'session-1',turn_id:'1',event_time:'2024-01-01',raw_text:'我一直按时吃降糖药，但血糖仍升高，而且持续掉重、多饮多尿。'}];
  harness.adapters.synthetic=syntheticOfficialAdapter(item,observations);
  const done=await harness.start('synthetic',{max_queries:1}),score=done.results.find(value=>value.kind==='score'),answerCall=calls.find(value=>value.component==='judge'),judgeCall=calls.find(value=>value.component==='medmemory_judge');
  assert.equal(score.status,'scored');
  assert.equal(score.scoring_method,'medmemory_official_llm_judge');
  assert.equal(score.score,1);
  assert.ok(answerCall);
  assert.ok(judgeCall);
  for(const hidden of ['gold','official_evaluation','expected_answer','judge_metadata'])assert.equal(Object.hasOwn(answerCall.input,hidden),false,hidden);
  assert.ok(answerCall.input.query_plan);
  assert.ok(Array.isArray(answerCall.input.retrieved_states));
  assert.ok(Array.isArray(answerCall.input.retrieved_evidence));
  assert.equal(Object.hasOwn(answerCall.input,'protocol'),true);
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
  const store=new Store(':memory:'),calls=[],pipeline=new MockGateway('pipeline-mock'),planner=new MockGateway('planner-mock'),answer=new StaticLiveGateway('answer-model',{answer:'患者特异性回答。'},calls),judge={config:{provider:'live-test',model:'broken-judge'},publicConfig(){return this.config},async completeJSON(component){const error=new Error('judge endpoint unavailable');error.gatewayTrace={component,provider:'live-test',model:'broken-judge',error:{message:error.message}};throw error}},registry={pipelineOptions:()=>({gateway:pipeline}),assignmentSnapshot:()=>({global:pipeline.config,query_planner:planner.config,judge:answer.config,scoring_judge:judge.config}),gateway:component=>component==='judge'?answer:component==='scoring_judge'?judge:planner},harness=new ExperimentHarness(store,undefined,registry),item=A.medmemorybench.cases(A.medmemorybench.load({persona_id:1,max_session:10,query_type:'inference_generation'}))[0],observations=[{subject_id:'official-judge-failure-test',source_type:'patient',episode_id:'session-1',turn_id:'1',event_time:'2024-01-01',raw_text:'患者有一段相关历史。'}];harness.adapters.synthetic=syntheticOfficialAdapter(item,observations);const done=await harness.start('synthetic',{max_queries:1}),score=done.results.find(value=>value.kind==='score');
  assert.equal(done.status,'completed');assert.equal(score.status,'scored');assert.equal(score.score,0);assert.equal(score.is_correct,false);assert.equal(score.scoring_reason,'Judge failed');assert.equal(score.judge_infrastructure_failure,true);assert.equal(score.judge_model_trace.error.message,'judge endpoint unavailable');assert.equal(done.progress.retrieval_metrics.judge_infrastructure_failure_count,1);store.close();
});

test('official MCD aggregates expose NCR, CRC, CC and node rates',async()=>{
  const store=new Store(':memory:'),calls=[],pipeline=new MockGateway('pipeline-mock'),planner=new MockGateway('planner-mock'),answer=new StaticLiveGateway('answer-model',{answer:'记忆1；记忆2；因此得到综合结论。'},calls),judgeResult={node_validations:[{node_id:1,mentioned:true,causal_link_correct:true},{node_id:2,mentioned:false,causal_link_correct:false}],ncr_score:.8,crc_score:.75,cc_score:.7,memory_retrieval_quality:'excellent',uses_patient_specific_info:true,is_correct:true,reason:'通过'},judge=new StaticLiveGateway('judge-model',judgeResult,calls),registry={pipelineOptions:()=>({gateway:pipeline}),assignmentSnapshot:()=>({global:pipeline.config,query_planner:planner.config,judge:answer.config,scoring_judge:judge.config}),gateway:component=>component==='judge'?answer:component==='scoring_judge'?judge:planner},harness=new ExperimentHarness(store,undefined,registry),item=A.medmemorybench.cases(A.medmemorybench.load({persona_id:1,max_session:100,query_type:'multi_hop_clinical_deduction'}))[0],observations=[{subject_id:'official-mcd-test',source_type:'patient',episode_id:'session-1',turn_id:'1',event_time:'2024-01-01',raw_text:'患者有两段需要联合分析的历史信息。'}];harness.adapters.synthetic=syntheticOfficialAdapter(item,observations);const done=await harness.start('synthetic',{max_queries:1}),summary=done.progress.retrieval_metrics.by_query_type.multi_hop_clinical_deduction;
  assert.equal(summary.avg_ncr,.8);assert.equal(summary.avg_crc,.75);assert.equal(summary.avg_cc,.7);assert.equal(summary.total_nodes_validated,2);assert.equal(summary.node_mention_rate,.5);assert.equal(summary.node_causal_rate,.5);store.close();
});

function syntheticOfficialAdapter(item,observations){const official=A.medmemorybench;return{load:()=>({observations}),cases:()=>[{...item,metadata:{...item.metadata,visible_episode_ids:['session-1']}}],normalizeAnswer:(...args)=>official.normalizeAnswer(...args),compatibleScore:(...args)=>official.compatibleScore(...args),requiresOfficialJudge:(...args)=>official.requiresOfficialJudge(...args),officialJudgeInput:(...args)=>official.officialJudgeInput(...args),officialJudgeMaxTokens:(...args)=>official.officialJudgeMaxTokens(...args),validateOfficialJudge:(...args)=>official.validateOfficialJudge(...args),scoreOfficialJudge:(...args)=>official.scoreOfficialJudge(...args),scoreOfficialEmptyAnswer:(...args)=>official.scoreOfficialEmptyAnswer(...args),scoreOfficialJudgeFailure:(...args)=>official.scoreOfficialJudgeFailure(...args)};}
