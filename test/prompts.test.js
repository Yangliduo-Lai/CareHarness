import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BENCHMARK_ANSWER_PROMPTS,MEDMEMORY_ANSWER_PROMPT_TEMPLATES,MEDMEMORY_SHARED_SYSTEM_PROMPT,PROMPTS,benchmarkAnswerContract,benchmarkQuestionPrompt,compactMedMemorySource,cpcdAnswerMessages,cpcdJudgeMessages,medMemoryAnswerMessages,promptFor,renderCpcdJudgePrompt,renderMedMemoryJudgePrompt } from '../src/prompts.js';

test('extractor prompt sends raw text without provenance packaging',()=>{
  const text='我按时吃药了，有时候会恶心。我希望下周复诊时问清楚。';
  const prompt=promptFor('extractor',text);
  assert.match(prompt,/"evidence"/);
  assert.ok(prompt.endsWith(text));
  const modelInput=prompt.split('INPUT:\n')[1];
  assert.equal(modelInput,text);
  assert.doesNotMatch(modelInput,/observation_id|subject_id|speaker|source_type|certainty|polarity/);
});

test('extractor selects equivalent Chinese and English standards from message-body language',()=>{const zh=promptFor('extractor','[Turn=1][Role=Patient][Time=2026-01-01]\n我已经停用恩格列净。'),en=promptFor('extractor','[Turn=1][Role=Patient][Time=2026-01-01]\nI stopped taking empagliflozin.');assert.match(zh,/绝对不能当作患者事实/);assert.match(zh,/医生问“有没有心慌、出汗？”不代表患者出现过这些症状/);assert.match(zh,/Patient 以确认式问句/);assert.match(zh,/不要输出 source_text/);assert.match(zh,/Session\/Admission 编号自动附加/);assert.match(zh,/不得出现“患者我……”/);assert.doesNotMatch(zh,/You are the Evidence Extractor/);assert.match(en,/Never treat these as patient facts/);assert.match(en,/does not establish that the Patient experienced those symptoms/);assert.match(en,/A Patient confirmation question may be retained/);assert.match(en,/Do not output source_text/);assert.match(en,/attaches the current Observation's immutable Session\/Admission identifier/);assert.match(en,/do not mechanically prefix/);assert.doesNotMatch(en,/你是纵向医疗记忆系统/)});

test('extractor and router prompts enforce exact output contracts and six controlled families',()=>{const extractor=promptFor('extractor','患者已停药。'),router=promptFor('router',[{id:'0',text:'患者已停用恩格列净。',source:'patient'}]);assert.match(extractor,/每个对象只能包含 text；不要返回 source_text/);assert.match(extractor,/\{"evidence":\[\{"text":/);assert.match(extractor,/任一答案为“否”，删除该条/);assert.match(router,/受控 Taxonomy/);assert.match(router,/"families":\["BC","PE","PA","CS","CP","LO"\]/);assert.match(router,/family 矩阵/);assert.match(router,/\{"families":\[\["PE","CS"\],\[\]\]\}/);assert.match(router,/不得输出 PE\|CS/);assert.match(router,/不要生成 route 对象/);assert.match(router,/代码根据输入顺序创建 route/)});

test('router prompt localizes from Evidence text and permits every provenance',()=>{const zh=promptFor('router',[{id:'0',text:'我有过自伤想法。',source:'patient'}]),en=promptFor('router',[{id:'0',text:'I have had thoughts of self-harm.',source:'patient'}]);assert.match(zh,/披露本身不能仅因为危险而自动进入 CS/);assert.match(zh,/BC、PE、PA、CS、CP、LO 全部允许 patient、doctor、structured/);assert.match(zh,/同一 family 只能出现一次/);assert.doesNotMatch(zh,/You are the State Router/);assert.match(en,/A safety disclosure does not enter CS merely because it is dangerous/);assert.match(en,/BC, PE, PA, CS, CP, and LO all allow patient, doctor, and structured Evidence/);assert.match(en,/return each family only once/);assert.doesNotMatch(en,/你是纵向医疗记忆系统的 State Router/)});

test('Query Planner prompt accepts raw question text and requests structured family routing',()=>{const question='患者既往病史中提到的慢性代谢性疾病是什么？',prompt=promptFor('query_planner',question),modelInput=prompt.split('INPUT:\n')[1];assert.equal(modelInput,question);for(const field of ['"target"','"answer_slot"','"keywords"','"state_scopes"','"temporal_operator"','"evidence_facets"'])assert.match(prompt,new RegExp(field));assert.match(prompt,/soft family priors/);assert.match(prompt,/"family":"BC"/);assert.match(prompt,/"family":"CS"/);assert.match(prompt,/慢性代谢性疾病/);assert.match(prompt,/never answer the question/i)});

test('Extractor protects high-value changes and Router preserves cross-family meaning',()=>{const extractor=promptFor('extractor','患者已经停用恩格列净。'),router=promptFor('router',[{id:'e1',text:'患者停药后症状改善。',source:'patient'}]);assert.match(extractor,/药物启动、停用、恢复、剂量变化/);assert.match(extractor,/首次出现、第一次发生、再次出现、复发/);assert.match(router,/PE（实际用药行为）\+ CS（当前用药事实）/);assert.match(router,/症状在治疗后改善：PE（体验）\+ LO（纵向治疗反应）/);assert.match(router,/同一 family 只能出现一次/)});


test('one prompt registry explicitly covers every QA benchmark answer task',()=>{
  const expected={
    medmemorybench:['entity_exact_match','temporal_localization','state_update','multiple_choice','inference_generation','multi_hop_clinical_deduction'],
    medlocomo:['adversarial','longitudinal_progression','care_plan_rationale','cross_admission_comparison','medical_reasoning','frequency_pattern'],
    cpcdbench:['session_level_response_generation','memory_recall','temporal_causal_reasoning']
  };
  for(const[benchmark,tasks]of Object.entries(expected)){
    assert.ok(BENCHMARK_ANSWER_PROMPTS[benchmark].default,benchmark);
    for(const task of tasks){
      assert.ok(BENCHMARK_ANSWER_PROMPTS[benchmark][task],`${benchmark}/${task}`);
      const contract=benchmarkAnswerContract(benchmark,task);
      assert.ok(contract.language,`${benchmark}/${task}/language`);
      assert.ok(contract.grounding,`${benchmark}/${task}/grounding`);
      assert.ok(contract.format,`${benchmark}/${task}/format`);
    }
  }
  assert.deepEqual(benchmarkAnswerContract('unknown','unknown'),BENCHMARK_ANSWER_PROMPTS.default.default);
});

test('MedMemory Answer prompts use the centralized appendix system and six task templates',()=>{
  assert.equal(PROMPTS.medmemory_answer.version,'medmemorybench-answer.appendix-v1');
  assert.equal(Object.keys(MEDMEMORY_ANSWER_PROMPT_TEMPLATES).length,6);
  const input={task:'multiple_choice',question:'Q?',retrieved_states:[],retrieved_evidence:[]},messages=medMemoryAnswerMessages(input);
  assert.deepEqual(messages.map(message=>message.role),['system','user']);
  assert.equal(messages[0].content,MEDMEMORY_SHARED_SYSTEM_PROMPT);
  assert.match(messages[1].content,/Output only the option letter\(s\), such as B or B,D/);
  assert.ok(messages[1].content.endsWith('Answer:'));
});

test('MedMemory Answer input projects audit objects to grounded answer fields',()=>{const source=compactMedMemorySource({retrieved_states:[{state_id:'s1',family:'CS',value:'LDL-C 3.2 mmol/L',event_time:'2025-06-13',evidence_ids:['e1'],audit_blob:'must-not-pass'}],retrieved_evidence:[{evidence_id:'e1',text:'患者检查结果为 LDL-C 3.2 mmol/L',event_time:'2025-06-13',debug_payload:'must-not-pass'}],working_state:{route:['CS'],state_ids:['s1'],temporal:{operator:'event_time'},evidence:{verification:{safe_to_answer:true,raw_graph:'must-not-pass'},proof:{verdict:'supported',complete:true,debug:'must-not-pass'}}},query_time_relations:[],harness_action_policy:{version:'v5',selected_actions:['focus','verify','answer'],candidate_budget:8,internal:'must-not-pass'}});assert.equal(source.states[0].value,'LDL-C 3.2 mmol/L');assert.equal(source.evidence[0].text,'患者检查结果为 LDL-C 3.2 mmol/L');assert.equal(source.working_state.safe_to_answer,true);assert.equal(source.evidence_proof.verdict,'supported');assert.doesNotMatch(JSON.stringify(source),/must-not-pass|raw_graph|debug_payload|audit_blob/);});

test('official Judge templates are sourced from prompts.js and preserve CPCD task-specific schemas',()=>{
  assert.throws(()=>benchmarkQuestionPrompt('unknown','unknown'),/No generated benchmark question prompt/);
  assert.match(renderMedMemoryJudgePrompt({query_type:'state_update',question:'Q',expected_answer:'A',explanation:'E',model_output:'O'}),/Must be based on memory/);
  const sr=renderCpcdJudgePrompt({task_type:'session_level_response_generation',task_id:'s',input_to_model:{},evaluation_focus:{}}),mr=renderCpcdJudgePrompt({task_type:'memory_recall',task_id:'m',answer_source:{},full_consultation_history:[]});
  assert.match(sr,/score 必须是 1-5 的整数/);assert.match(sr,/"empathy": \{"score": 1/);assert.match(mr,/四项分数必须是 0 到 5 的整数/);assert.match(mr,/"accuracy": 0/);assert.match(mr,/"rationales"/);
  const officialSource=readFileSync(new URL('../src/medmemory-official.js',import.meta.url),'utf8');
  assert.doesNotMatch(officialSource,/你是一个非常严格的医疗对话评测裁判/);
  assert.match(officialSource,/export \{ renderMedMemoryJudgePrompt \} from '\.\/prompts\.js'/);
});

test('CPCD uses official online-script SR messages and explicitly labels MR/TCR memory adaptation',()=>{
  const officialInput={student_profile_summary:'profile',history_until_previous_session:'history',current_session_event:'event',current_session_context:[{role:'Student',content:'context'}],current_student_utterance:'latest'},sr=cpcdAnswerMessages({task_id:'s1',task_type:'session_level_response_generation',input_to_model:officialInput});
  assert.deepEqual(sr.map(message=>message.role),['system','user']);assert.ok(sr[0].content.startsWith('你是一名受过专业训练的高校心理咨询师。'));assert.doesNotMatch(sr[1].content,/representative_point|reference_answer|evaluation_focus/u);
  const mr=cpcdAnswerMessages({task_id:'m1',task_type:'memory_recall',task_file:'m.json',full_session_file:'m_fullsession.json',question:'Q',input_to_model:{},memory_source:{states:[{state_id:'s1'}],evidence:[{evidence_id:'e1'}]}}),tcr=cpcdAnswerMessages({task_id:'t1',task_type:'temporal_causal_reasoning',task_file:'t.json',full_session_file:'t_fullsession.json',question:'Q',input_to_model:{},memory_source:{states:[],evidence:[]}});
  assert.match(mr[1].content,/CareHarness adaptation: Complete consultation history/);assert.match(mr[1].content,/official raw full-history slot is replaced/);assert.match(tcr[1].content,/CareHarness 适配：完整咨询历史/);assert.match(tcr[1].content,/官方 raw full-history 槽位已替换/);
  const mrJudge=cpcdJudgeMessages({task_type:'memory_recall',task_id:'m1',reference_answer:'R',answer_source:{primary_session:1},full_consultation_history:[],model_response:'A'}),tcrJudge=cpcdJudgeMessages({task_type:'temporal_causal_reasoning',task_id:'t1',reference_answer:'R',evaluation_focus:{temporal_accuracy:'E'},full_consultation_history:[],model_response:'A'});
  assert.match(mrJudge[1].content,/"answer_source"/);assert.doesNotMatch(mrJudge[1].content,/"evaluation_focus"/);assert.match(tcrJudge[1].content,/"reference_answer"/);assert.match(tcrJudge[1].content,/"evaluation_focus"/);
});

test('runtime modules call the centralized prompt surface instead of embedding prompt prose',()=>{
  const source=relative=>readFileSync(new URL(relative,import.meta.url),'utf8'),gateway=source('../src/gateway.js'),experiments=source('../src/experiments.js'),pipeline=source('../src/pipeline.js'),cpcd=source('../src/adapters/cpcdbench.js'),cpcdOfficial=source('../src/cpcd-official.js');
  assert.match(gateway,/gatewayConnectionTestPrompt/);assert.doesNotMatch(gateway,/Connection test\. Return exactly/);
  assert.match(experiments,/completeText\('medmemory_answer'/);assert.match(experiments,/completeText\('cpcd_answer'/);assert.doesNotMatch(experiments,/function matchedAnswerContract/);
  assert.match(pipeline,/communicationActionRequirements/);assert.doesNotMatch(pipeline,/明确建议立即联系当地急救/);
  assert.match(cpcd,/benchmarkQuestionPrompt/);assert.doesNotMatch(cpcd,/请生成 Counselor 对 Student 的下一轮回复/);
  assert.doesNotMatch(cpcdOfficial,/你是一名受过专业训练的高校心理咨询师|你是严格的事实回忆评测员/);
});
