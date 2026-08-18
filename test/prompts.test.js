import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BENCHMARK_ANSWER_PROMPTS,benchmarkAnswerContract,benchmarkQuestionPrompt,promptFor,renderCpcdJudgePrompt,renderMedMemoryJudgePrompt } from '../src/prompts.js';

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
    muspsy:['task_1','task_2','task_3'],
    medilongchat:['in_dialogue_reasoning','cross_dialogue_reasoning','synthesis_reasoning'],
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

test('official Judge templates are sourced from prompts.js and preserve CPCD task scales',()=>{
  assert.throws(()=>benchmarkQuestionPrompt('unknown','unknown'),/No generated benchmark question prompt/);
  assert.match(renderMedMemoryJudgePrompt({query_type:'state_update',question:'Q',expected_answer:'A',explanation:'E',model_output:'O'}),/必须基于记忆回答/);
  assert.match(renderCpcdJudgePrompt({task_type:'session_level_response_generation',task_id:'s',dimensions:['empathy']}),/1–5/);
  assert.match(renderCpcdJudgePrompt({task_type:'memory_recall',task_id:'m',dimensions:['accuracy']}),/0–5/);
  assert.match(renderCpcdJudgePrompt({task_type:'session_level_response_generation',task_id:'s',dimensions:['empathy']}),/不使用 reference_answer 或 full consultation history/);
  const officialSource=readFileSync(new URL('../src/medmemory-official.js',import.meta.url),'utf8');
  assert.doesNotMatch(officialSource,/你是一个非常严格的医疗对话评测裁判/);
  assert.match(officialSource,/export \{ renderMedMemoryJudgePrompt \} from '\.\/prompts\.js'/);
});
