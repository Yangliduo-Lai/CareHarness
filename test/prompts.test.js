import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BENCHMARK_ANSWER_PROMPTS,MEDMEMORY_ANSWER_PROMPT_TEMPLATES,MEDMEMORY_CAREHARNESS_ANSWER_OVERLAYS,
  INVESTIGATION_ASSESSOR_NAVIGATION_PATH_POLICY,INVESTIGATION_POLICY_NAVIGATION_PATH_POLICY,LEARNED_ACTION_PRIOR_ADVICE,
  MEDMEMORY_CHINESE_ANSWER_REQUIREMENT,MEDMEMORY_CHINESE_JUDGE_REQUIREMENT,MEDMEMORY_IG_FINAL_STATE_COVERAGE_REQUIREMENT,MEDMEMORY_MQ_CARDINALITY_PATCH,
  MEDMEMORY_LITERAL_SUPPLEMENT_REQUIREMENT,MEDMEMORY_QUERY_EVIDENCE_REQUIREMENT,MEDMEMORY_SHARED_SYSTEM_PROMPT,MEDMEMORY_STATE_ONLY_REQUIREMENT,PROMPTS,benchmarkAnswerContract,
  compactMedMemorySource,cpcdAnswerMessages,investigationAssessmentModelContract,investigationPolicyWorkerCapabilityModelContext,medMemoryAnswerMessages,memoryInvestigationWorkerPromptContracts,
  promptFor,renderMedMemoryJudgePrompt
} from '../src/prompts.js';

test('extractor creates Memory Nodes while code owns immutable provenance',()=>{
  const text='[Turn=1][Role=Patient][Time=2026-01-01]\n我已经停用恩格列净。',prompt=promptFor('extractor',text),modelInput=prompt.split('INPUT:\n')[1];
  assert.equal(modelInput,text);assert.match(prompt,/Memory Node Extractor/);assert.match(prompt,/\{"memory_nodes":\[\{"text":/);
  assert.match(prompt,/不要输出 source_text/);assert.doesNotMatch(modelInput,/observation_id|subject_id|certainty|polarity/);
});

test('family tagger labels one object with the six controlled families',()=>{
  const prompt=promptFor('router',[{id:'0',text:'患者停药后症状改善。',source:'patient'}]);
  assert.match(prompt,/Memory Family Tagger/);assert.match(prompt,/"families":\["BC","PE","PA","CS","CP","LO"\]/);
  assert.match(prompt,/不要改写事实、不要生成另一层对象/);assert.match(prompt,/每个节点必须至少标注一个 family/);
});

test('investigation policy is the only query-time planning prompt and receives no static decomposition',()=>{
  assert.ok(PROMPTS.investigation_policy);assert.equal(PROMPTS.query_planner,undefined);
  const input={question:'患者当前情况如何？',current_information:{memory_nodes:[]},previous_steps:[],remaining_budget:4,allowed_workers:['inspect'],worker_capabilities:[{worker:'inspect',capability:{description:'inspect'}}]},prompt=promptFor('investigation_policy',input);
  assert.match(prompt,/Reassess after every result/);assert.match(prompt,/current_information/);assert.match(prompt,/worker_capabilities/);
  assert.match(prompt,/clinician opening a chart/);assert.match(prompt,/current_information\.patient_profile/);
  assert.match(PROMPTS.investigation_policy.contract,/clinical problem representation/);assert.match(PROMPTS.investigation_policy.contract,/literal probes/);assert.match(PROMPTS.investigation_policy.contract,/retrieval hypotheses, never patient facts/);
  assert.match(PROMPTS.investigation_policy.contract,/single decision target/);assert.match(PROMPTS.investigation_policy.contract,/Exact fact or value/);assert.match(PROMPTS.investigation_policy.contract,/assessment\.answer_focus as the grounded must-use checklist/);
  assert.match(PROMPTS.investigation_policy.contract,/date copied only into objective or search_terms does not filter Memory Node event_time/);
  assert.match(PROMPTS.investigation_policy.contract,/"base_date":"YYYY-MM-DD","offset_days":1 or -1/);
  assert.match(PROMPTS.investigation_policy.contract,/current_information\.temporal_gate/);assert.match(PROMPTS.investigation_policy.contract,/stop searching and select Assess/);
  assert.match(PROMPTS.investigation_policy.contract,/Latest.*ranking preferences, not hard date boundaries/);
  assert.match(PROMPTS.investigation_policy.contract,/search the factor, baseline literal, and likely change\/update wording together/);
  for(const hardcodedTerm of ['DPP-4','C肽','自身免疫性糖尿病','布洛芬'])assert.doesNotMatch(PROMPTS.investigation_policy.contract,new RegExp(hardcodedTerm));
  for(const term of ['node_blueprint','state_scopes','temporal_operator','relation_goals','target_slot_ids'])assert.doesNotMatch(PROMPTS.investigation_policy.contract,new RegExp(term));
});

test('MedMemory query classifier is question-only and covers exactly the six public task types',()=>{
  const prompt=promptFor('medmemory_query_classifier',{question:'患者当前状态是什么？'});
  for(const type of ['entity_exact_match','temporal_localization','state_update','multiple_choice','inference_generation','multi_hop_clinical_deduction'])assert.match(prompt,new RegExp(type));
  assert.match(prompt,/患者当前状态是什么/u);assert.match(prompt,/only the question text/u);
  for(const hidden of ['expected_answer','required_patient_info','reasoning_chain','official_query_type'])assert.doesNotMatch(prompt,new RegExp(hidden));
});

test('semantic evaluator reads only currently visible unified Memory objects',()=>{
  const contract=PROMPTS.careharness_evaluate.contract;
  assert.match(contract,/"connections"/);assert.match(contract,/"reasoning_hypotheses"/);assert.match(contract,/"answer_focus"/);assert.match(contract,/historical Memory Node/);
  assert.match(contract,/strategy_profile\.strategy_id starts with medlocomo_/);assert.match(contract,/cited source language/);assert.match(contract,/otherwise write them in Simplified Chinese/);
  assert.match(contract,/minimal verbatim span/);assert.match(contract,/cross-node link only in connections/);
  assert.doesNotMatch(contract,/node_bindings|Need Graph|Evidence-only|option_assessments/);
});

test('MedMemory answer source contains one atomic node copy and no full source quote',()=>{
  const source=compactMedMemorySource({patient_profile:{version:'p1',as_of:'2025-01-02',sections:[{key:'treatment',label:'治疗',items:[{source_ref:'memory:profile-node',text:'患者当前使用胰岛素。',event_time:'2025-01-02',source_type:'doctor',families:['CP'],memory_id:'must-not-leak'}]}]},recent_sessions:[{episode_id:'session-2',event_time:'2025-01-03',transcript:'[Role=Patient] 最近状态稳定。'}],memory_nodes:[{memory_id:'m1',text:'患者正在服用口服降糖药。',source_text:'一整段很长的原始会话',families:['PE','CS'],event_time:'2025-01-01',episode_id:'session-1',source_type:'patient',status:'active'}],memory_edges:[]});
  assert.equal(source.patient_profile.item_count,1);assert.equal(source.patient_profile.sections[0].items[0].memory_id,undefined);assert.equal(source.patient_profile.sections[0].items[0].source_ref,'memory:profile-node');assert.equal(source.recent_sessions.length,1);
  assert.equal(source.historical_memory_nodes.length,1);assert.equal(source.historical_memory_nodes[0].text,'患者正在服用口服降糖药。');
  assert.equal(source.historical_memory_nodes[0].source_text,undefined);assert.equal(source.states,undefined);assert.equal(source.evidence,undefined);
  assert.equal(JSON.stringify(source).includes('一整段很长的原始会话'),false);
});

test('MedMemory compact Profile retains only source-ref-bound validated literal deltas',()=>{
  const source=compactMedMemorySource({patient_profile:{version:'p',sections:[{key:'treatment',label:'治疗',items:[{source_ref:'memory:profile-drug',text:'患者服用口服药。',literal_supplement:[{kind:'medical_term',text:'口服降糖药'},{kind:'unknown',text:'不应透传'},{kind:'unit',text:'x'.repeat(80)}],source_text:'整段原文绝不能透传',memory_id:'profile-drug'}]}]},memory_nodes:[]}),item=source.patient_profile.sections[0].items[0],serialized=JSON.stringify(source);
  assert.deepEqual(item.literal_supplement,[{kind:'medical_term',text:'口服降糖药'}]);assert.equal(item.source_ref,'memory:profile-drug');
  assert.equal(item.memory_id,undefined);assert.equal(item.source_text,undefined);assert.equal(serialized.includes('整段原文'),false);assert.equal(serialized.includes('不应透传'),false);
});

test('MedMemory source restores only a bounded medication-class literal delta',()=>{
  const fullSource='医生复查时认为口服降糖药可能出现继发性药效减弱，随后只安排常规随访。',source=compactMedMemorySource({task:'entity_exact_match',memory_nodes:[{memory_id:'drug-class',text:'医生复查时认为口服药可能出现继发性药效减弱。',source_text:fullSource,families:['CS']}],memory_edges:[]}),node=source.historical_memory_nodes[0],serialized=JSON.stringify(source);
  assert.deepEqual(node.literal_supplement,[{kind:'medical_term',text:'口服降糖药'}]);
  assert.equal(serialized.includes(fullSource),false);assert.equal(serialized.includes('安排常规随访'),false);assert.equal(node.source_text,undefined);
});

test('MedMemory source restores a missing unit without attaching its source sentence',()=>{
  const fullSource='患者空腹血糖为12-13 mmol/L，同时早餐吃了一片面包。',source=compactMedMemorySource({memory_nodes:[{memory_id:'unit',text:'患者空腹血糖为12-13。',source_text:fullSource,families:['CS']}]}),node=source.historical_memory_nodes[0];
  assert.deepEqual(node.literal_supplement,[{kind:'unit',text:'mmol/L'}]);
  assert.equal(JSON.stringify(source).includes(fullSource),false);assert.equal(JSON.stringify(source).includes('早餐'),false);
});

test('MedMemory source restores an omitted negation but emits nothing when no protected literal is missing',()=>{
  const source=compactMedMemorySource({memory_nodes:[{memory_id:'negated',text:'患者有明显口渴。',source_text:'患者没有明显口渴，下午去公园散步。',families:['PE']},{memory_id:'complete',text:'患者没有明显头痛。',source_text:'患者无明显头痛。',families:['PE']}]});
  assert.deepEqual(source.historical_memory_nodes[0].literal_supplement,[{kind:'negation',text:'没有'}]);
  assert.equal(source.historical_memory_nodes[1].literal_supplement,undefined);
  assert.equal(JSON.stringify(source).includes('公园散步'),false);
  const prompt=medMemoryAnswerMessages({task:'temporal_localization',question:'Q',memory_nodes:[]})[1].content;
  assert.match(prompt,new RegExp(MEDMEMORY_LITERAL_SUPPLEMENT_REQUIREMENT.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&')));
});

test('MedMemory source keeps only persistent verified source-grounded edges between selected Memory Nodes',()=>{
  const nodes=[{memory_id:'a',text:'A',families:['CS']},{memory_id:'b',text:'B',families:['LO']}],base={edge_family:'temporal',relation_type:'updates',persistent:true,verified:true,causal_claim:false,support_memory_ids:['a','b']},source=compactMedMemorySource({memory_nodes:nodes,memory_edges:[{...base,edge_id:'ok',from_memory_id:'a',to_memory_id:'b',status:'verified'},{...base,edge_id:'candidate',from_memory_id:'a',to_memory_id:'b',status:'candidate'},{...base,edge_id:'outside',from_memory_id:'a',to_memory_id:'c',status:'verified'}]});
  assert.deepEqual(source.memory_edges.map(edge=>edge.edge_id),['ok']);
});

test('MedMemory source hands Answer a grounded query-local focus without evaluator duplication',()=>{
  const source=compactMedMemorySource({memory_nodes:[{memory_id:'a',text:'当前值为 8 mmol/L。',families:['CS']},{memory_id:'b',text:'无关节点',families:['PE']}],memory_edges:[],semantic_evaluation:{answer_focus:[{aspect:'当前值为 8 mmol/L',role:'current',memory_ids:['a','outside'],required_in_answer:true}],reasoning_hypotheses:[{grounding_scope:'generic_clinical_bridge',summary:'一般而言，指标变化可能解释症状',supporting_memory_ids:['a'],counter_memory_ids:['outside'],reasoning_steps:['当前值为 8 mmol/L'],confidence:.7}],missing_information:['缺少同一指标基线']}});
  assert.deepEqual(source.query_evidence_brief.answer_focus,[{aspect:'当前值为 8 mmol/L',role:'current',source_refs:['memory:a'],memory_ids:['a'],required_in_answer:true}]);
  assert.deepEqual(source.query_evidence_brief.reasoning_hypotheses[0].supporting_memory_ids,['a']);
  assert.equal(source.query_evidence_brief.reasoning_hypotheses[0].establishes_patient_fact,false);
  assert.equal(source.working_memory,undefined);assert.equal(source.semantic_evaluation,undefined);
});

test('MedMemory answer compaction rejects partially matching patient claims and retains a safe explicit mechanism bridge',()=>{
  const source=compactMedMemorySource({memory_nodes:[{memory_id:'a',text:'患者已确诊 DXQ，MARKER+++ 阳性。',families:['PE']},{memory_id:'b',text:'患者的方案甲疗效已明显减弱。',families:['PE']}],semantic_evaluation:{answer_focus:[{aspect:'患者指标 X 为 0.2 unitX，已确诊 DXQ',memory_ids:['a']}],reasoning_hypotheses:[{grounding_scope:'generic_clinical_bridge',summary:'一般而言，进行性细胞功能下降可能使既有方案疗效减弱。',supporting_memory_ids:['a','b']}]}});
  assert.deepEqual(source.query_evidence_brief.answer_focus,[]);
  assert.equal(source.query_evidence_brief.reasoning_hypotheses.length,1);
  assert.equal(source.query_evidence_brief.reasoning_hypotheses[0].grounding_scope,'generic_clinical_bridge');
  assert.equal(source.query_evidence_brief.reasoning_hypotheses[0].establishes_patient_fact,false);
});

test('MedMemory EEM answer source drops reasoning hypotheses defensively',()=>{
  const source=compactMedMemorySource({task:'entity_exact_match',memory_nodes:[{memory_id:'m1',text:'患者的口服药出现继发性药效减弱。',families:['PE']}],semantic_evaluation:{answer_focus:[{aspect:'口服药',role:'target',memory_ids:['m1'],required_in_answer:true}],reasoning_hypotheses:[{summary:'不应进入 EEM Answer',supporting_memory_ids:['m1'],reasoning_steps:['无须推理']}]}});
  assert.deepEqual(source.query_evidence_brief.reasoning_hypotheses,[]);
});

test('MedMemory SUA Answer receives only Refine-selected Memory states',()=>{
  const input={task:'state_update',question:'患者24年3月的血糖监测意愿状态是什么？',patient_profile:{sections:[{key:'preferences',items:[{text:'旧画像'}]}]},recent_sessions:[{episode_id:'session-60',event_time:'2024-03-10',transcript:'最近会话原文'}],memory_nodes:[{memory_id:'old',text:'患者先前只愿意进行极简三点监测。',event_time:'2024-02-01',episode_id:'session-40',status:'superseded',version:1,successor_memory_id:'current'},{memory_id:'current',text:'患者现在更主动，承诺测空腹、深夜进食后两小时、外卖后血糖并报告。',event_time:'2024-03-10',episode_id:'session-60',status:'active',version:2,predecessor_memory_id:'old'}],memory_edges:[{edge_id:'assessor-edge',from_memory_id:'old',to_memory_id:'current',relation_type:'causes',status:'verified'}],semantic_evaluation:{answer_focus:[{aspect:'Assessor 归纳',memory_ids:['current'],required_in_answer:true}],reasoning_hypotheses:[{summary:'Assessor 构造的因果关系',supporting_memory_ids:['current']}]}},source=compactMedMemorySource(input),prompt=medMemoryAnswerMessages(input)[1].content,transportPrompt=medMemoryAnswerMessages({task:input.task,question:input.question,memory_source:{...source,answer_focus:['不应透传'],reasoning_hypotheses:['不应透传']}})[1].content;
  assert.deepEqual(Object.keys(source),['selected_memory_nodes']);
  assert.deepEqual(source.selected_memory_nodes.map(node=>node.memory_id),['old','current']);
  assert.equal(source.selected_memory_nodes[1].event_time,'2024-03-10');assert.equal(source.selected_memory_nodes[1].status,'active');assert.equal(source.selected_memory_nodes[1].version,2);
  assert.match(prompt,/"selected_memory_nodes"/);assert.match(prompt,/Answer Requirements: 1\. Describe the patient’s most recent status\. 2\. Reflect important changes over time when necessary\. 3\. Maintain a warm yet professional tone\. 4\. Be concise and direct\./u);
  assert.match(prompt,/CareHarness State Focus: Answer in the question’s language and put the requested factor first\./u);assert.match(prompt,/Return only the minimum patient-specific fact needed/u);assert.match(prompt,/Every answer must demonstrate patient-memory use with exactly one compact grounding anchor/u);assert.match(prompt,/Prefer “According to the YYYY-MM-DD record/u);assert.match(prompt,/do not use a generic phrase such as “according to memory” without a concrete date or baseline/u);assert.match(prompt,/output exactly one direct sentence stating the change/u);assert.match(prompt,/Add a second sentence only when the question explicitly asks for a cause, reason, interpretation, or advice/u);assert.match(prompt,/do not add mechanisms, clinical interpretation, improvement or worsening claims, recommendations, reassurance, unrelated history, treatment background, evidence lists, or extra dates/u);assert.match(prompt,/Do not use Markdown headings or bullets/u);assert.match(prompt,/explicitly binds a supplied baseline to its new value/u);assert.match(prompt,/Answer:$/u);
  assert.doesNotMatch(prompt,/State Evidence Requirement|Literal Supplement Requirement|Language Requirement/u);
  for(const artifact of ['patient_profile','recent_sessions','memory_edges','query_evidence_brief','answer_focus','reasoning_hypotheses','Assessor 归纳','Assessor 构造的因果关系'])assert.equal(prompt.includes(artifact),false,artifact);
  assert.match(transportPrompt,/"memory_id":"current"/);assert.equal(transportPrompt.includes('不应透传'),false);
});

test('MedMemory current decision tasks serialize the complete recent window before the longitudinal profile',()=>{
  const source=compactMedMemorySource({task:'inference_generation',patient_profile:{sections:[]},recent_sessions:[{episode_id:'session-1',transcript:'prior'},{episode_id:'session-2',transcript:'current'}],memory_nodes:[]});
  assert.deepEqual(Object.keys(source),['recent_sessions','query_evidence_brief','historical_memory_nodes','patient_profile','memory_edges']);
  assert.deepEqual(source.recent_sessions.map(session=>session.episode_id),['session-1','session-2']);
  const multipleChoice=compactMedMemorySource({task:'multiple_choice',patient_profile:{sections:[]},recent_sessions:[],memory_nodes:[]});
  assert.equal(Object.keys(multipleChoice)[0],'option_state_index');
  const packeted=compactMedMemorySource({task:'multiple_choice',memory_nodes:[{memory_id:'a1',text:'支持 A 的患者事实。',polarity:'affirmed'},{memory_id:'shared',text:'同时影响两个选项的事实。',polarity:'negated'},{memory_id:'b1',text:'支持 B 的患者事实。',polarity:'affirmed'}],semantic_evaluation:{answer_focus:[{aspect:'Assessor 不应进入 MQ Answer',memory_ids:['a1'],required_in_answer:true}]},mq_option_retrieval:{options:[{letter:'A',text:'选项甲',selected_memory_ids:['a1','shared']},{letter:'B',text:'选项乙',selected_memory_ids:['shared','b1','missing']}]}});
  assert.deepEqual(Object.keys(packeted),['option_state_index','selected_states','recent_sessions','patient_profile','memory_edges']);
  assert.deepEqual(packeted.option_state_index.map(item=>({letter:item.letter,ids:item.state_ids})),[{letter:'A',ids:['a1','shared']},{letter:'B',ids:['shared','b1']}]);
  assert.deepEqual(packeted.selected_states.map(state=>state.memory_id),['a1','shared','b1']);
  assert.equal('polarity' in packeted.selected_states[0],false);
  assert.equal(JSON.stringify(packeted).includes('Assessor 不应进入 MQ Answer'),false);
});

test('all six official MedMemory templates and transparent overlays stay centralized',()=>{
  assert.equal(Object.keys(MEDMEMORY_ANSWER_PROMPT_TEMPLATES).length,6);assert.equal(Object.keys(MEDMEMORY_CAREHARNESS_ANSWER_OVERLAYS).length,6);assert.equal(PROMPTS.medmemory_answer.version,'medmemorybench-answer.appendix-v1-careharness-overlay-v41-mq-general-medical-knowledge');
  const messages=medMemoryAnswerMessages({task:'multiple_choice',question:'Q?',memory_nodes:[]});
  assert.deepEqual(messages.map(message=>message.role),['system','user']);assert.equal(messages[0].content,MEDMEMORY_SHARED_SYSTEM_PROMPT);
  assert.match(messages[1].content,/Output only the option letter\(s\), such as B or B,D/);
});

test('MedMemory IG audits source-cited must-use states without copying the whole candidate packet',()=>{
  const input={task:'inference_generation',question:'是否需要调整治疗？',memory_nodes:[{memory_id:'diagnosis',text:'患者已确诊目标疾病。',families:['CS']},{memory_id:'failure',text:'患者规律执行当前治疗后指标仍持续恶化。',families:['CS','LO']},{memory_id:'symptoms',text:'患者相关症状继续加重。',families:['PE']}],memory_edges:[]},prompt=medMemoryAnswerMessages(input)[1].content,tla=medMemoryAnswerMessages({...input,task:'temporal_localization'})[1].content;
  assert.match(prompt,/Silently verify every required_in_answer item/);
  assert.match(prompt,/Do not attempt to mention every historical_memory_node/);
  assert.match(prompt,/within 600 Chinese characters/);
  assert.match(prompt,new RegExp(MEDMEMORY_IG_FINAL_STATE_COVERAGE_REQUIREMENT.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&')));
  assert.doesNotMatch(tla,/IG Final-State Coverage Requirement/);
});

test('MedMemory EEM adds only the deterministic strict-containment format patch to the official template',()=>{
  const prompt=medMemoryAnswerMessages({task:'entity_exact_match',question:'医生怀疑哪类药物出现继发性药效减弱？',memory_nodes:[{memory_id:'m1',text:'患者的口服药出现继发性药效变弱趋势。',families:['PE']}],memory_edges:[]})[1].content;
  assert.match(prompt,/Answer Requirements: 1\. Provide the target entity name directly\. 2\. Keep the answer brief and precise\. 3\. Do not include lengthy explanations\./u);
  assert.match(prompt,/EEM Numeric Format Patch:/u);
  assert.match(prompt,/eGFR → <number> mL\/min\/1\.73m²/u);
  assert.match(prompt,/Repetition frequency per second → <number or range> Hz/u);
  assert.match(prompt,/EEM Strict-Containment Surface Rules:/u);
  assert.match(prompt,/For exactly two requested entities, join the two complete entity spans with “与”/u);
  assert.match(prompt,/retain the explicit slot head\/suffix supplied by the question or chart/u);
  assert.match(prompt,/These are surface-form rules only\.[\s\S]*\nAnswer:$/u);
  assert.doesNotMatch(prompt,/Query Evidence Requirement/);
  assert.doesNotMatch(prompt,/Literal Supplement Requirement/);
  assert.doesNotMatch(prompt,/CareHarness Task Overlay/);
  assert.doesNotMatch(prompt,/complete canonical target entity/u);
  assert.doesNotMatch(prompt,/multiple-choice questions/);
});

test('MedMemory MQ keeps the official appendix Answer Prompt and adds cardinality plus bounded medical-knowledge rules',()=>{
  const memorySource={patient_profile:null,recent_sessions:[],historical_memory_nodes:[],memory_edges:[],query_evidence_brief:{answer_focus:[],reasoning_hypotheses:[]}},question='Q?\nA. one\nB. two';
  const prompt=medMemoryAnswerMessages({task:'multiple_choice',question,memory_source:memorySource})[1].content;
  assert.equal(prompt,`Context: Based on ${JSON.stringify(memorySource)}, and considering the patient’s allergy history, medical history, medications, and personal preferences, answer the following question.\nQuestion: ${question}\nAnswer Requirements:\n1. Select all correct options. 2. Output only the option letter(s), such as B or B,D. 3. Do not provide any explanation.\n${MEDMEMORY_MQ_CARDINALITY_PATCH}\nAnswer:`);
  assert.match(prompt,/single best, most appropriate, most necessary/u);
  assert.match(prompt,/Otherwise, treat the question as multiple-select/u);
  assert.match(prompt,/explicitly allowed and expected to use established general medical knowledge/u);
  assert.match(prompt,/Do not require an otherwise correct option to have verbatim support in memory/u);
  assert.match(prompt,/must not invent a patient diagnosis, measurement, medication exposure, preference, or event/u);
  assert.doesNotMatch(prompt,/Language Requirement|Query Evidence Requirement|Literal Supplement Requirement|CareHarness Task Overlay/u);
});

test('MedMemory Judge prompt remains post-answer and preserves Chinese free-text requirement',()=>{
  const prompt=renderMedMemoryJudgePrompt({query_type:'inference_generation',question:'Q',expected_answer:'A',explanation:'E',metadata_info:'M',model_output:'O'});
  assert.match(prompt,/Model’s Answer: O/);assert.match(prompt,/Reference Answer: A/);assert.match(prompt,new RegExp(MEDMEMORY_CHINESE_JUDGE_REQUIREMENT.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&')));
});

test('benchmark answer contracts cover every supported QA task',()=>{
  const expected={medmemorybench:['entity_exact_match','temporal_localization','state_update','multiple_choice','inference_generation','multi_hop_clinical_deduction'],medlocomo:['adversarial','medical_reasoning'],cpcdbench:['session_level_response_generation','memory_recall','temporal_causal_reasoning']};
  for(const [benchmark,tasks] of Object.entries(expected))for(const task of tasks){assert.ok(BENCHMARK_ANSWER_PROMPTS[benchmark][task]);const contract=benchmarkAnswerContract(benchmark,task);assert.ok(contract.language);assert.ok(contract.grounding);assert.ok(contract.format);}
});

test('CPCD answer messages never serialize hidden Judge fields',()=>{
  const messages=cpcdAnswerMessages({task_id:'s1',task_type:'session_level_response_generation',input_to_model:{student_profile_summary:'profile',history_until_previous_session:'history',current_session_event:'event',current_session_context:[],current_student_utterance:'latest'},reference_answer:'hidden',evaluation_focus:{hidden:true}}),serialized=JSON.stringify(messages);
  assert.equal(serialized.includes('reference_answer'),false);assert.equal(serialized.includes('evaluation_focus'),false);
});

test('runtime modules call the centralized prompt registry',()=>{
  const source=relative=>readFileSync(new URL(relative,import.meta.url),'utf8'),experiments=source('../src/experiments.js'),pipeline=source('../src/pipeline.js');
  assert.match(experiments,/completeJSON\('investigation_policy'/);assert.match(experiments,/completeText\('medmemory_answer'/);assert.match(pipeline,/communicationActionRequirements/);
});

test('adaptive investigation model-facing contracts stay centralized in prompts.js',()=>{
  const capabilities=memoryInvestigationWorkerPromptContracts(),conservative=memoryInvestigationWorkerPromptContracts({conservative_refine:true}),assessment=investigationAssessmentModelContract({answer_focus_limit:2,target_only_focus_roles:true,allow_reasoning_hypotheses:false});
  assert.match(capabilities.search.description,/complete visible Memory Graph/);assert.equal(capabilities.search.instruction_schema.properties.temporal.properties.operator.enum.includes('exact'),true);
  assert.match(capabilities.trace.description,/non-causal navigation paths/);assert.match(conservative.refine.description,/Conservatively retain/);
  assert.equal(assessment.navigation_path_policy,INVESTIGATION_ASSESSOR_NAVIGATION_PATH_POLICY);assert.equal(assessment.focus_role_policy.includes('role=target'),true);assert.match(assessment.output_schema.answer_focus[0].aspect,/at most 2/);assert.deepEqual(assessment.output_schema.reasoning_hypotheses,[]);
  assert.deepEqual(investigationPolicyWorkerCapabilityModelContext('verify',capabilities.verify).capability,{worker:'verify',description:capabilities.verify.description,instruction_profile:'empty.v1'});
  assert.deepEqual(investigationPolicyWorkerCapabilityModelContext('custom').capability,{worker:'custom',description:'custom worker',instruction_profile:'custom.instruction'});
  assert.match(INVESTIGATION_POLICY_NAVIGATION_PATH_POLICY,/not patient facts/);assert.match(LEARNED_ACTION_PRIOR_ADVICE,/weak_prior_only/);
  const source=relative=>readFileSync(new URL(relative,import.meta.url),'utf8'),workers=source('../src/investigation-workers.js'),actions=source('../src/careharness-actions.js'),contract=source('../src/investigation-contract.js'),learning=source('../src/action-policy-learning.js'),runtimeSources=[workers,actions,contract,learning].join('\n');
  for(const leakedInstruction of['Search the complete visible Memory Graph','Navigation paths are search provenance only','Use memory:<memory_id> for Profile','target_only: do not use baseline or current','weak_prior_only_policy_must_override','semantic evaluator unavailable','verification requires refine','best available Memory Nodes for answer generation'])assert.doesNotMatch(runtimeSources,new RegExp(leakedInstruction));
  assert.doesNotMatch(workers,/function (?:search|trace|assessment)Schema\s*\(/);assert.doesNotMatch(source('../src/investigation-runtime.js'),/description:\s*`\$\{name\} worker`/);assert.match(workers,/memoryInvestigationWorkerPromptContracts/);assert.match(actions,/investigationAssessmentModelContract/);assert.match(contract,/investigationPolicyWorkerCapabilityModelContext/);assert.match(contract,/INVESTIGATION_POLICY_NAVIGATION_PATH_POLICY/);assert.match(learning,/LEARNED_ACTION_PRIOR_ADVICE/);
});
