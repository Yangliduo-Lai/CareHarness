import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.js';
import { ModelGateway } from '../src/gateway.js';
import { Pipeline,pipelineInternals as I } from '../src/pipeline.js';
import { retrieveMemoryCandidates } from '../src/retrieval.js';

const obs=(text,source_type='patient',extra={})=>({subject_id:'p',source_type,episode_id:'session-1',turn_id:'1',event_time:'2026-01-01',raw_text:text,...extra});

test('pipeline persists one Memory Node with multiple family labels and no Evidence/State tables',async()=>{
  const store=new Store(':memory:'),pipeline=new Pipeline(store),result=await pipeline.run(obs('我付不起 copay，已经停药。'),{phase:'memory_build'}),node=result.final.memory_nodes[0];
  assert.equal(result.traces.filter(trace=>trace.component==='memory_graph_updater').length,1);
  assert.equal(result.traces.some(trace=>/evidence|state/i.test(trace.component)),false);
  assert.ok(node.families.includes('BC'));assert.ok(node.families.includes('PE'));assert.ok(node.families.includes('CS'));
  assert.equal(store.memoryNodesFor('p').length,1);
  for(const table of['evidence','states','patient_graph_nodes'])assert.equal(store.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table),undefined);
  store.close();
});

test('extractor output accepts text only and code owns immutable provenance',()=>{
  const observation={observation_id:'obs-1',subject_id:'p',source_type:'structured',episode_id:'session-17',turn_id:'session',event_time:'2026-08-12',raw_text:'患者按时吃药。'};
  const nodes=I.normalizeMemoryNodeOutput({memory_nodes:[{text:'患者按时服药。',memory_id:'model-controlled',episode_id:'wrong'}]},observation);
  assert.equal(nodes.length,1);assert.equal(nodes[0].memory_id,'obs-1:llm:0');assert.equal(nodes[0].episode_id,'session-17');assert.equal(nodes[0].observation_id,'obs-1');assert.equal(nodes[0].text,'患者按时服药。');
});

test('semantic polarity does not negate rhetorical confirmation or explicit adherence',()=>{
  assert.equal(I.inferSemanticPolarity('您后来不是根据这些数据，把 CCB 改成晚上吃了嘛？'),'affirmed');
  assert.equal(I.inferSemanticPolarity('患者每天规律按时服药，没有漏服。'),'affirmed');
  assert.equal(I.inferSemanticPolarity('患者没有胸痛，也没有呼吸困难。'),'negated');
  assert.equal(I.inferSemanticPolarity('患者可能没有按时服药。'),'uncertain');
});

test('malformed extracted items are dropped without dropping valid Memory Nodes',()=>{
  const observation={observation_id:'obs-2',subject_id:'p',source_type:'structured',episode_id:'session-1',turn_id:'1',event_time:null,raw_text:'患者继续监测血糖。'},nodes=I.normalizeMemoryNodeOutput({memory_nodes:[{},'患者继续监测血糖。']},observation);
  assert.equal(nodes.length,1);assert.equal(nodes[0].text,'患者继续监测血糖。');assert.equal(nodes.warnings[0].failure_reason,'missing_atomic_text');
});

test('an extractor hallucination without a visible source span is quarantined before active Graph write',async()=>{
  const store=new Store(':memory:'),pipeline=new Pipeline(store),observation={observation_id:'obs-unaligned',...obs('患者今天只是来复查。')},ungrounded={memory_id:'obs-unaligned:llm:0',observation_id:'obs-unaligned',subject_id:'p',text:'患者已确诊一种原文不存在的疾病。',source_text:null,span:null,source_type:'patient',episode_id:'session-1',turn_id:'1',event_time:'2026-01-01',certainty:1,polarity:'affirmed'},prepared={observation,memory_nodes:[ungrounded],routes:[{...ungrounded,families:['CS']}],routerInput:[{id:'0',text:ungrounded.text,source:'patient'}],extractorTrace:{component:'extractor'},routerTrace:{component:'router'}};
  const result=await pipeline.run(observation,{phase:'memory_build',prepared}),extractor=result.traces.find(trace=>trace.component==='memory_node_extractor');
  assert.equal(result.final.memory_nodes.length,0);assert.equal(store.memoryNodesFor('p').length,0);assert.equal(extractor.gateway.source_alignment_gate.quarantined_memory_node_count,1);assert.deepEqual(extractor.gateway.source_alignment_gate.reason_counts,{missing_source_text:1,missing_source_span:1});assert.ok(extractor.gateway.validation_warnings.some(warning=>warning.warning_type==='memory_node_quarantined_unaligned_source'));store.close();
});

test('family tagging annotates the same object instead of materializing one node per family',()=>{
  const source={memory_id:'m1',observation_id:'o1',subject_id:'p',text:'患者担心低血糖并同意监测。',source_type:'patient',episode_id:'session-1',turn_id:'1',event_time:null,certainty:1,polarity:'affirmed'},tagged=I.normalizeMemoryTagsOutput({families:[['PA','CP']]},[source]);
  assert.equal(tagged.length,1);assert.equal(tagged[0].memory_id,'m1');assert.deepEqual(tagged[0].families,['PA','CP']);
});

test('same clinical factor forms a Memory Node version chain across observations',async()=>{
  const store=new Store(':memory:'),pipeline=new Pipeline(store);
  const first=await pipeline.run(obs('患者目前空腹血糖为 9 mmol/L。','structured',{episode_id:'session-1',event_time:'2026-01-01'}),{phase:'memory_build'}),second=await pipeline.run(obs('患者目前空腹血糖为 7 mmol/L。','structured',{episode_id:'session-2',event_time:'2026-02-01'}),{phase:'memory_build'}),prior=first.final.memory_nodes[0],current=second.final.memory_nodes[0];
  assert.equal(current.predecessor_memory_id,prior.memory_id);assert.equal(current.version,2);assert.ok(second.final.memory_edges.some(edge=>edge.from_memory_id===prior.memory_id&&edge.to_memory_id===current.memory_id&&edge.relation_type==='updates'));
  store.close();
});

test('doctor explanation applied to the patient remains attributed Memory',async()=>{
  const store=new Store(':memory:'),pipeline=new Pipeline(store),result=await pipeline.run(obs('医生解释：交感神经和 HPA 轴激活会影响患者目前的心率。','doctor'),{phase:'memory_build'});
  assert.ok(result.final.memory_nodes.some(node=>node.text.includes('交感神经')&&node.text.includes('HPA')));assert.ok(result.final.memory_nodes.some(node=>node.families.includes('CS')));store.close();
});

test('failed Memory Graph validation commits no partial node',async()=>{
  const store=new Store(':memory:'),pipeline=new Pipeline(store),observation={observation_id:'o-bad',...obs('患者记录。')},source={memory_id:'m-bad',observation_id:'o-bad',subject_id:'p',text:'患者记录。',source_text:'患者记录。',span:[0,5],source_type:'patient',episode_id:'session-1',turn_id:'1',event_time:'2026-01-01',certainty:1,polarity:'affirmed'},prepared={observation,memory_nodes:[source],routes:[{...source,text:'',families:['PE']}],routerInput:[]};
  await assert.rejects(()=>pipeline.run(observation,{phase:'memory_build',prepared}),/MemoryNode validation failed/);assert.equal(store.memoryNodesFor('p').length,0);store.close();
});

test('query and Gold cannot enter the observation boundary',async()=>{
  const store=new Store(':memory:'),pipeline=new Pipeline(store);await assert.rejects(()=>pipeline.run({...obs('患者记录。'),gold:'hidden'},{phase:'memory_build'}),/unsupported observation fields/);assert.equal(store.memoryNodesFor('p').length,0);store.close();
});

test('coverage ledger keeps one exact sentence fragment and its source span',()=>{
  const sentence='我近期体重轻微下降，裤腰变松，估计减少一两斤。',raw_text=`[Turn=1][Role=Patient][Time=2024-01-05]\n${sentence}\n第二句是其他记录。`,observation={observation_id:'coverage-source',subject_id:'p',source_type:'structured',episode_id:'session-1',turn_id:'session',event_time:'2024-01-05',raw_text},candidates=I.coverageLedgerCandidates(observation),target=candidates.find(item=>item.source_text===sentence);
  assert.ok(target);assert.deepEqual(target.span,[raw_text.indexOf(sentence),raw_text.indexOf(sentence)+sentence.length]);assert.equal(raw_text.slice(...target.span),sentence);assert.equal(target.source_text.includes('第二句'),false);
});

test('coverage ledger attaches a missing literal fragment to an obvious structured paraphrase',()=>{
  const sentence='我近期体重轻微下降，裤腰变松。',raw_text=`[Turn=1][Role=Patient][Time=2024-01-05]\n${sentence}`,observation={observation_id:'coverage-attach',subject_id:'p',source_type:'structured',episode_id:'session-1',turn_id:'session',event_time:'2024-01-05',raw_text},modelNode={memory_id:'coverage-attach:llm:0',observation_id:'coverage-attach',subject_id:'p',text:'患者近期体重轻微下降，裤腰变松。',source_text:null,span:null,source_type:'patient',episode_id:'session-1',turn_id:'1',event_time:'2024-01-05',certainty:1,polarity:'affirmed'},result=I.augmentExtractorCoverage({value:[modelNode],trace:{}},observation);
  assert.equal(result.value.length,1);assert.equal(result.value[0].source_text,sentence);assert.equal(raw_text.slice(...result.value[0].span),sentence);assert.equal(result.trace.coverage_ledger.attached_source_fragment_count,1);
});

test('coverage attachment keeps different values, negation and clinical facts separate',()=>{
  const run=(id,modelText,sourceText)=>{const raw_text=`[Turn=1][Role=Patient][Time=2024-01-05]\n${sourceText}`,observation={observation_id:id,subject_id:'p',source_type:'structured',episode_id:'session-1',turn_id:'session',event_time:'2024-01-05',raw_text},modelNode={memory_id:`${id}:llm:0`,observation_id:id,subject_id:'p',text:modelText,source_text:null,span:null,source_type:'patient',episode_id:'session-1',turn_id:'1',event_time:'2024-01-05',certainty:1,polarity:'affirmed'};return I.augmentExtractorCoverage({value:[modelNode],trace:{}},observation).value;};
  assert.equal(run('different-value','患者空腹血糖为12 mmol/L。','我的空腹血糖为13 mmol/L。').length,2);
  assert.equal(run('different-negation','患者最近有明显口干症状。','我最近没有明显口干症状。').length,2);
  assert.equal(run('different-fact','患者近期空腹血糖持续升高为13 mmol/L。','我近期餐后血糖持续升高为13 mmol/L。').length,2);
});

test('semantic Context Units keep soft newlines and dependent clauses inside one Turn',()=>{
  const raw_text='[Turn=1][Role=Patient][Time=2024-01-05]\n脚步一迈出去，整个人自然就落下来，\n心口没以前那一点点紧，\n脑子也不会卡一下，\n身体是明显松的。\n而且这种改善能持续半小时。',observation={observation_id:'soft-lines',subject_id:'p',source_type:'structured',episode_id:'session-1',turn_id:'session',event_time:'2024-01-05',raw_text},units=I.buildSemanticContextUnits(observation);
  assert.equal(units.length,1);assert.match(units[0].text,/心口没以前那一点点紧/u);assert.match(units[0].text,/而且这种改善能持续半小时/u);assert.equal(units[0].source_text,raw_text.slice(...units[0].span));
});

test('semantic Context Units retain Markdown heading and list context without crossing Role boundaries',()=>{
  const raw_text='[Turn=1][Role=Patient][Time=2024-01-05]\n### 最近状态\n- 胸口不紧。\n- 晨起心率约 80 bpm。\n\n[Turn=2][Role=Doctor][Time=2024-01-06]\n### 后续计划\n- 继续监测晨起心率。',observation={observation_id:'markdown-context',subject_id:'p',source_type:'structured',episode_id:'session-1',turn_id:'session',event_time:'2024-01-05',raw_text},units=I.buildSemanticContextUnits(observation);
  assert.equal(units.length,2);assert.equal(units[0].source_type,'patient');assert.equal(units[0].turn_id,'1');assert.match(units[0].text,/最近状态/u);assert.match(units[0].text,/胸口不紧/u);assert.match(units[0].text,/80 bpm/u);assert.equal(units[1].source_type,'doctor');assert.equal(units[1].event_time,'2024-01-06');assert.match(units[1].text,/后续计划/u);
});

test('standalone Markdown headings are context labels rather than meaningless Memory candidates',()=>{
  const raw_text='[Turn=1][Role=Patient][Time=2024-01-05]\n### 最近状态\n\n晨起心率约 80 bpm。',observation={observation_id:'standalone-heading',subject_id:'p',source_type:'structured',episode_id:'session-1',turn_id:'session',event_time:'2024-01-05',raw_text},units=I.buildSemanticContextUnits(observation);
  assert.equal(units.length,1);assert.equal(units[0].text,'晨起心率约 80 bpm。');assert.equal(units[0].section_heading,'最近状态');assert.doesNotMatch(units[0].source_text,/^###/u);
});

test('extractor support_unit_ids bind semantic text to immutable source provenance',()=>{
  const raw_text='[Turn=1][Role=Patient][Time=2024-01-05]\n我最近按时服用二甲双胍，空腹血糖为 12 mmol/L。',observation={observation_id:'semantic-bind',subject_id:'p',source_type:'structured',episode_id:'session-1',turn_id:'session',event_time:'2024-01-05',raw_text},input=I.semanticExtractorInput(observation),unit=input.context_units[0],nodes=I.normalizeMemoryNodeOutput({memory_nodes:[{text:'患者最近按时服用二甲双胍，空腹血糖为 12 mmol/L。',support_unit_ids:[unit.unit_id]}]},observation);
  assert.equal(nodes.length,1);assert.equal(nodes[0].source_text,'我最近按时服用二甲双胍，空腹血糖为 12 mmol/L。');assert.equal(raw_text.slice(...nodes[0].span),nodes[0].source_text);assert.equal(nodes[0].source_type,'patient');assert.deepEqual(nodes[0].support_unit_ids,[unit.unit_id]);assert.equal(nodes[0].construction_kind,'semantic');assert.deepEqual(nodes.support_bindings[0].support_unit_ids,[unit.unit_id]);assert.equal(nodes.support_bindings[0].binding_mode,'context_unit');
});

test('invalid semantic support is marked for repair and cannot silently acquire provenance',()=>{
  const raw_text='[Turn=1][Role=Patient][Time=2024-01-05]\n我的空腹血糖为 12 mmol/L。',observation={observation_id:'semantic-repair',subject_id:'p',source_type:'structured',episode_id:'session-1',turn_id:'session',event_time:'2024-01-05',raw_text},unit=I.semanticExtractorInput(observation).context_units[0],nodes=I.normalizeMemoryNodeOutput({memory_nodes:[{text:'患者空腹血糖为 13 mmol/L。',support_unit_ids:[unit.unit_id]}]},observation);
  assert.equal(nodes[0].source_text,null);assert.equal(nodes[0].span,null);assert.ok(nodes.warnings.some(warning=>warning.warning_type==='semantic_state_support_repair_required'&&warning.failure_reasons.includes('unsupported_or_changed_number_date_or_unit')));
});

test('semantic support guard preserves source negation and uncertainty',()=>{
  const run=(id,source,text)=>{const raw_text=`[Turn=1][Role=Patient][Time=2024-01-05]\n${source}`,observation={observation_id:id,subject_id:'p',source_type:'structured',episode_id:'session-1',turn_id:'session',event_time:'2024-01-05',raw_text},unit=I.semanticExtractorInput(observation).context_units[0];return I.normalizeMemoryNodeOutput({memory_nodes:[{text,support_unit_ids:[unit.unit_id]}]},observation);};
  const negated=run('guard-negation','我没有口渴。','患者有口渴。'),uncertain=run('guard-uncertainty','我的晨起心率约 80 bpm。','患者晨起心率为 80 bpm。'),mixed=run('guard-mixed','我没有口渴，但有头痛。','患者有头痛。');
  const repairReasons=nodes=>nodes.warnings.find(warning=>warning.warning_type==='semantic_state_support_repair_required')?.failure_reasons||[];
  assert.equal(negated[0].source_text,null);assert.ok(repairReasons(negated).includes('omitted_source_negation'));assert.equal(uncertain[0].source_text,null);assert.ok(repairReasons(uncertain).includes('omitted_source_uncertainty'));assert.notEqual(mixed[0].source_text,null);
});

test('semantic support guard preserves specific Chinese medication categories and clinical terms',()=>{
  const run=(id,source,text)=>{const raw_text=`[Turn=1][Role=Patient][Time=2024-01-05]\n${source}`,observation={observation_id:id,subject_id:'p',source_type:'structured',episode_id:'session-1',turn_id:'session',event_time:'2024-01-05',raw_text},unit=I.semanticExtractorInput(observation).context_units[0];return I.normalizeMemoryNodeOutput({memory_nodes:[{text,support_unit_ids:[unit.unit_id]}]},observation);},broadened=run('guard-category','我一直规律服用口服降糖药。','患者一直规律服用口服药。'),preserved=run('guard-category-ok','我一直规律服用口服降糖药。','患者一直规律服用口服降糖药。');
  const reasons=broadened.warnings.find(warning=>warning.warning_type==='semantic_state_support_repair_required')?.failure_reasons||[];
  assert.equal(broadened[0].source_text,null);assert.ok(reasons.includes('unsupported_or_changed_clinical_term'));assert.notEqual(preserved[0].source_text,null);
});

test('support_unit_ids may not combine facts across Turn Role or Time hard boundaries',()=>{
  const raw_text='[Turn=1][Role=Patient][Time=2024-01-05]\n我最近口渴。\n\n[Turn=2][Role=Doctor][Time=2024-01-06]\n医生建议继续观察。',observation={observation_id:'hard-boundary',subject_id:'p',source_type:'structured',episode_id:'session-1',turn_id:'session',event_time:'2024-01-05',raw_text},units=I.semanticExtractorInput(observation).context_units,binding=I.bindSemanticSupport({text:'患者最近口渴，医生建议继续观察。',support_unit_ids:units.map(unit=>unit.unit_id)},observation);
  assert.equal(binding.bound,false);assert.ok(binding.reasons.includes('support_crosses_turn_role_or_time_boundary'));
});

test('coverage fallback uses complete semantic text without duplicating a verbatim-role prefix',()=>{
  const raw_text='[Turn=1][Role=Patient][Time=2024-01-05]\n我近期体重轻微下降，\n裤腰变松，估计减少一两斤。',observation={observation_id:'coverage-semantic',subject_id:'p',source_type:'structured',episode_id:'session-1',turn_id:'session',event_time:'2024-01-05',raw_text},candidates=I.coverageLedgerCandidates(observation);
  assert.equal(candidates.length,1);assert.doesNotMatch(candidates[0].text,/^(?:患者|医生)原话[：:]/u);assert.match(candidates[0].text,/体重轻微下降/u);assert.match(candidates[0].text,/裤腰变松/u);assert.equal(candidates[0].construction_kind,'fallback');assert.deepEqual(candidates[0].support_unit_ids,['turn_1_unit_1']);assert.equal(raw_text.slice(...candidates[0].span),candidates[0].source_text);
});

test('equivalent semantic extractor outputs collapse to one Memory Node before coverage',()=>{
  const sentence='我近期体重轻微下降，裤腰变松。',raw_text=`[Turn=1][Role=Patient][Time=2024-01-05]\n${sentence}`,observation={observation_id:'semantic-dedup',subject_id:'p',source_type:'structured',episode_id:'session-1',turn_id:'session',event_time:'2024-01-05',raw_text},unit=I.semanticExtractorInput(observation).context_units[0],nodes=I.normalizeMemoryNodeOutput({memory_nodes:[{text:'患者近期体重轻微下降，裤腰变松。',support_unit_ids:[unit.unit_id]},{text:'患者近期体重轻微下降且裤腰变松。',support_unit_ids:[unit.unit_id]}]},observation),result=I.augmentExtractorCoverage({value:nodes,trace:{}},observation);
  assert.equal(result.value.length,1);assert.equal(result.trace.coverage_ledger.model_duplicate_collapsed_count,1);assert.equal(result.trace.coverage_ledger.skipped_already_cited_context_unit_count,1);
});

test('pipeline repairs an invalid source-bound semantic State once and keeps the validated replacement',async()=>{
  let calls=0;const extractor={config:{provider:'live-test',model:'semantic-repair-test'},publicConfig(){return this.config;},async completeJSON(component,input,validator){calls++;const unit=input.context_units[0],raw=calls===1?{memory_nodes:[{text:'患者空腹血糖为 13 mmol/L。',support_unit_ids:[unit.unit_id]}]}:{memory_nodes:[{text:'患者空腹血糖为 12 mmol/L。',support_unit_ids:[unit.unit_id]}]},value=validator(raw);return{value,trace:{component,model_input:input,raw_model_response:JSON.stringify(raw),validation_warnings:value.warnings||[]}};}},store=new Store(':memory:'),pipeline=new Pipeline(store,{componentGateways:{extractor}}),raw_text='[Turn=1][Role=Patient][Time=2024-01-05]\n我的空腹血糖为 12 mmol/L。',observation={subject_id:'p',source_type:'structured',episode_id:'session-1',turn_id:'session',event_time:'2024-01-05',raw_text},result=await pipeline.run(observation,{phase:'memory_build'}),trace=result.traces.find(item=>item.component==='memory_node_extractor');
  assert.equal(calls,2);assert.ok(result.final.memory_nodes.some(node=>node.text==='患者空腹血糖为 12 mmol/L。'&&node.construction_kind==='semantic'));assert.equal(result.final.memory_nodes.some(node=>node.text.includes('13 mmol/L')),false);assert.equal(trace.gateway.semantic_state_repair.attempted,true);assert.equal(trace.gateway.semantic_state_repair.accepted_replacement_count,1);store.close();
});

test('MedLoCoMo retries an empty semantic extraction instead of silently committing an empty Admission',async()=>{
  const raw_text='[Turn=1][Role=Patient][Time=2024-01-01]\nThe patient developed acute kidney injury.',observation={observation_id:'medlocomo-empty-retry',subject_id:'medlocomo-patient',source_type:'structured',episode_id:'admission-1',turn_id:'session',event_time:'2024-01-01',raw_text},unit=I.semanticExtractorInput(observation).context_units[0],extractor=new ModelGateway({provider:'openai-compatible',base_url:'https://provider.test/v1',model:'test-model',retries:1},{apiKey:'memory-key'}),store=new Store(':memory:'),pipeline=new Pipeline(store,{componentGateways:{extractor}}),originalFetch=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;const content=calls===1?'0.16':JSON.stringify({memory_nodes:[{text:'The patient developed acute kidney injury.',support_unit_ids:[unit.unit_id]}]});return new Response(JSON.stringify({choices:[{message:{content},finish_reason:'stop'}]}),{status:200})};
  try{
    const result=await pipeline.run(observation,{phase:'memory_build',dataset:'medlocomo'}),trace=result.traces.find(item=>item.component==='memory_node_extractor');
    assert.equal(calls,2);assert.equal(result.final.memory_nodes.filter(node=>node.construction_kind==='semantic').length,1);assert.equal(result.final.memory_nodes.filter(node=>node.construction_kind==='literal_provenance').length,1);assert.equal(store.memoryNodesFor('medlocomo-patient').length,2);assert.match(trace.gateway.raw_model_attempts[0].error,/non-empty Memory Node array/);
  }finally{globalThis.fetch=originalFetch;store.close()}
});

test('MedLoCoMo commits exact literal provenance when semantic extraction fails completely',async()=>{
  const raw_text='[Turn=1][Role=Patient][Time=2132-10-01 09:00:00]\nNo.\n\n[Turn=2][Role=Doctor][Time=2132-10-01 09:01:00]\nOK',observation={observation_id:'medlocomo-extractor-fail-open',subject_id:'medlocomo-patient',source_type:'structured',episode_id:'admission-1',turn_id:'session',event_time:'2132-10-01 09:00:00',raw_text},extractor={config:{provider:'live-test',model:'always-fails'},publicConfig(){return this.config},async completeJSON(){const error=new Error('extractor unavailable');error.gatewayTrace={component:'extractor',error:{kind:'provider_http_error',message:error.message}};throw error;}},store=new Store(':memory:'),pipeline=new Pipeline(store,{componentGateways:{extractor}});
  try{
    const result=await pipeline.run(observation,{phase:'memory_build',dataset:'medlocomo'}),trace=result.traces.find(item=>item.component==='memory_node_extractor');
    assert.equal(result.status,'completed');assert.deepEqual(result.final.memory_nodes.map(node=>node.text),['No.','OK']);assert.ok(result.final.memory_nodes.every(node=>node.construction_kind==='literal_provenance'));assert.equal(trace.gateway.semantic_extraction_status,'failed_open_to_literal_provenance');assert.equal(trace.gateway.literal_provenance_source_bindings.length,2);assert.equal(store.memoryNodesFor('medlocomo-patient').length,2);
  }finally{store.close()}
});

test('the MedLoCoMo non-empty extraction guard does not change MedMemoryBench extraction acceptance',async()=>{
  const observation={observation_id:'medmemory-empty-allowed',subject_id:'medmemory-patient',source_type:'patient',episode_id:'session-1',turn_id:'1',event_time:'2024-01-01',raw_text:'follow-up'},extractor={config:{provider:'live-test',model:'empty-test'},publicConfig(){return this.config},async completeJSON(_component,_input,validator){return{value:validator({memory_nodes:[]}),trace:{component:'extractor',raw_model_attempts:[{attempt:0,raw:'{"memory_nodes":[]}'}]}}}},store=new Store(':memory:'),pipeline=new Pipeline(store,{componentGateways:{extractor}});
  const result=await pipeline.run(observation,{phase:'memory_build',dataset:'medmemorybench'});
  assert.equal(result.final.memory_nodes.length,0);assert.equal(store.memoryNodesFor('medmemory-patient').length,0);store.close();
});

test('MedLoCoMo preserves an exact source-grounded fallback for every meaningful English Turn without crossing Role or Time',()=>{
  const doctor='Imaging shows the stent is open. Warfarin was increased to 4 mg daily.',patient='I am worried about bleeding after discharge.',raw_text=`[Turn=8][Role=Doctor][Time=2132-10-01 09:08:00]\n${doctor}\n\n[Turn=9][Role=Patient][Time=2132-10-01 09:10:00]\n${patient}`,observation={observation_id:'medlocomo-source-turn-boundary',subject_id:'medlocomo-patient',source_type:'structured',episode_id:'admission-1',turn_id:'session',event_time:'2132-10-01 09:08:00',raw_text},candidates=I.medLoCoMoSourceTurnFallbackCandidates(observation);
  assert.equal(candidates.length,2);
  assert.deepEqual(candidates.map(node=>({text:node.text,source_text:node.source_text,source_type:node.source_type,turn_id:node.turn_id,event_time:node.event_time})),[
    {text:doctor,source_text:doctor,source_type:'doctor',turn_id:'8',event_time:'2132-10-01 09:08:00'},
    {text:patient,source_text:patient,source_type:'patient',turn_id:'9',event_time:'2132-10-01 09:10:00'}
  ]);
  for(const node of candidates){const binding=I.bindSemanticSupport(node,observation);assert.equal(raw_text.slice(...node.span),node.source_text);assert.equal(node.construction_kind,'literal_provenance');assert.equal(binding.bound,true);assert.equal(binding.source_type,node.source_type);assert.equal(binding.turn_id,node.turn_id);assert.equal(binding.event_time,node.event_time);}
  assert.doesNotMatch(candidates[0].source_text,/worried about bleeding/u);assert.doesNotMatch(candidates[1].source_text,/Warfarin/u);
});

test('MedLoCoMo literal provenance includes every nonempty short Patient or Doctor Turn',()=>{
  const raw_text='[Turn=1][Role=Patient][Time=2132-10-01 09:00:00]\nNo.\n\n[Turn=2][Role=Doctor][Time=2132-10-01 09:01:00]\nOK\n\n[Turn=3][Role=Patient][Time=2132-10-01 09:02:00]\n?\n\n[Turn=4][Role=Doctor][Time=2132-10-01 09:03:00]\n   ',observation={observation_id:'medlocomo-short-turns',subject_id:'medlocomo-patient',source_type:'structured',episode_id:'admission-1',turn_id:'session',event_time:'2132-10-01 09:00:00',raw_text},candidates=I.medLoCoMoSourceTurnFallbackCandidates(observation);
  assert.deepEqual(candidates.map(node=>({text:node.text,source_type:node.source_type,turn_id:node.turn_id,event_time:node.event_time,construction_kind:node.construction_kind})),[
    {text:'No.',source_type:'patient',turn_id:'1',event_time:'2132-10-01 09:00:00',construction_kind:'literal_provenance'},
    {text:'OK',source_type:'doctor',turn_id:'2',event_time:'2132-10-01 09:01:00',construction_kind:'literal_provenance'},
    {text:'?',source_type:'patient',turn_id:'3',event_time:'2132-10-01 09:02:00',construction_kind:'literal_provenance'}
  ]);
  for(const node of candidates)assert.equal(raw_text.slice(...node.span),node.source_text);
});

test('MedLoCoMo literal provenance stays separate from semantic State versioning and relations',()=>{
  const text='Warfarin was increased to 4 mg daily.',raw_text=`[Turn=8][Role=Doctor][Time=2132-10-01 09:08:00]\n${text}`,observation={observation_id:'medlocomo-provenance-separation',subject_id:'medlocomo-patient',source_type:'structured',episode_id:'admission-1',turn_id:'session',event_time:'2132-10-01 09:08:00',raw_text},literal=I.medLoCoMoSourceTurnFallbackCandidates(observation)[0],semantic={...literal,memory_id:'medlocomo-provenance-separation:llm:0',construction_kind:'semantic'},augmented=I.augmentMedLoCoMoSourceTurnCoverage({value:[semantic],trace:{}},observation),tagged=I.tagMemoryNodes(augmented.value,observation),graph=I.updateMemoryGraph(tagged,[],[],observation),provenance=graph.nodes.find(node=>node.construction_kind==='literal_provenance');
  assert.equal(augmented.value.length,2);assert.ok(provenance);assert.deepEqual(provenance.factor_domains,['provenance']);assert.equal(provenance.operation,'ADD');assert.equal(provenance.predecessor_memory_id,null);assert.deepEqual(provenance.version_chain,[]);assert.equal(graph.edges.length,0);
});

test('MedLoCoMo router bounds concurrency, routes literal provenance without an LLM, and fails open per batch',async()=>{
  const make=(index,construction_kind='semantic',source_type='patient')=>({memory_id:`router-${index}`,observation_id:'router-observation',subject_id:'p',text:source_type==='doctor'?'OK.':`Patient reports fatigue marker ${index}.`,source_text:'source',span:[0,6],source_type,episode_id:'admission-1',turn_id:String(index),event_time:'2132-10-01',certainty:1,polarity:'affirmed',construction_kind}),semantic=Array.from({length:24},(_,index)=>make(index)),literal=[make(24,'literal_provenance'),make(25,'literal_provenance','doctor')],nodes=[...semantic,...literal],input=nodes.map((node,index)=>({id:String(index),text:node.text,source:node.source_type}));let active=0,maxActive=0,calls=0;
  const gateway={async completeJSON(component,batchInput,validator){calls++;active++;maxActive=Math.max(maxActive,active);await new Promise(resolve=>setTimeout(resolve,3));try{if(batchInput.some(item=>item.id==='8')){const error=new Error('one router batch failed');error.gatewayTrace={component,error:{kind:'provider_http_error',message:error.message},token_input:1,token_output:0};throw error;}const raw={families:batchInput.map(()=>['LO'])};return{value:validator(raw),trace:{component,token_input:batchInput.length,token_output:batchInput.length,latency_ms:3,raw_model_response:JSON.stringify(raw)}};}finally{active--;}}},result=await I.tagMemoryWithFallback(gateway,input,nodes,{},{bounded_batch_concurrency:2,deterministic_literal_provenance:true,per_batch_fail_open:true});
  assert.equal(calls,3);assert.ok(maxActive<=2);assert.equal(result.value.length,nodes.length);
  assert.ok(result.value.slice(0,8).every(node=>node.families.includes('LO')));assert.ok(result.value.slice(8,16).every(node=>node.families.includes('PE')));assert.ok(result.value.slice(16,24).every(node=>node.families.includes('LO')));
  assert.ok(result.value[24].families.includes('PE'));assert.ok(result.value[25].families.includes('CP'));
  assert.equal(result.trace.router_failed_batch_count,1);assert.equal(result.trace.router_successful_batch_count,2);assert.equal(result.trace.literal_provenance_count,2);assert.equal(result.trace.batch_failure_policy,'failed_batch_only');
});

test('one failed MedLoCoMo router batch does not roll back the Admission graph commit',async()=>{
  const lines=Array.from({length:9},(_,index)=>`[Turn=${index+1}][Role=Patient][Time=2132-10-01 09:${String(index).padStart(2,'0')}:00]\nPatient reports symptom marker ${index+1}.`),raw_text=lines.join('\n\n'),observation={observation_id:'medlocomo-router-fail-open',subject_id:'medlocomo-router-patient',source_type:'structured',episode_id:'admission-1',turn_id:'session',event_time:'2132-10-01 09:00:00',raw_text},extractor={config:{provider:'live-test',model:'extractor'},publicConfig(){return this.config},async completeJSON(component,input,validator){const raw={memory_nodes:input.context_units.map(unit=>({text:unit.text,support_unit_ids:[unit.unit_id]}))};return{value:validator(raw),trace:{component,token_input:1,token_output:1}};}},router={config:{provider:'live-test',model:'router'},publicConfig(){return this.config},calls:0,async completeJSON(component,input,validator){this.calls++;if(this.calls===2){const error=new Error('second batch failed');error.gatewayTrace={component,error:{kind:'provider_http_error',message:error.message}};throw error;}const raw={families:input.map(()=>['PE'])};return{value:validator(raw),trace:{component,token_input:1,token_output:1}};}},store=new Store(':memory:'),pipeline=new Pipeline(store,{componentGateways:{extractor,router}});
  try{
    const result=await pipeline.run(observation,{phase:'memory_build',dataset:'medlocomo'}),trace=result.traces.find(item=>item.component==='multi_family_tagger');
    assert.equal(result.status,'completed');assert.equal(result.final.memory_nodes.length,18);assert.equal(result.final.memory_nodes.filter(node=>node.construction_kind==='literal_provenance').length,9);assert.equal(trace.gateway.router_failed_batch_count,1);assert.equal(trace.gateway.router_successful_batch_count,1);assert.equal(store.memoryNodesFor('medlocomo-router-patient').length,18);
  }finally{store.close()}
});

test('MedLoCoMo source-Turn fallback survives dropped repair facts and remains lexically retrievable',async()=>{
  const doctor='Imaging shows the stent is open. Warfarin was increased to 4 mg daily.',patient='I am worried about bleeding after discharge.',raw_text=`[Turn=8][Role=Doctor][Time=2132-10-01 09:08:00]\n${doctor}\n\n[Turn=9][Role=Patient][Time=2132-10-01 09:10:00]\n${patient}`,observation={observation_id:'medlocomo-source-turn-repair',subject_id:'medlocomo-patient',source_type:'structured',episode_id:'admission-1',turn_id:'session',event_time:'2132-10-01 09:08:00',raw_text},units=I.semanticExtractorInput(observation).context_units,stentUnit=units.find(unit=>unit.text.includes('stent is open')),warfarinUnit=units.find(unit=>unit.text.includes('Warfarin')),extractor={config:{provider:'live-test',model:'source-turn-repair-test'},publicConfig(){return this.config},async completeJSON(component,input,validator){const repairing=Boolean(input.repair_request),raw=repairing?{memory_nodes:[]}:{memory_nodes:[{text:'Imaging shows the stent is open.',support_unit_ids:[stentUnit.unit_id]},{text:'Warfarin was increased to 5 mg daily.',support_unit_ids:[warfarinUnit.unit_id]}]},value=validator(raw);return{value,trace:{component,model_input:input,raw_model_response:JSON.stringify(raw)}};}},store=new Store(':memory:'),pipeline=new Pipeline(store,{componentGateways:{extractor}});
  try{
    const prepared=await pipeline.preprocess(observation,{dataset:'medlocomo'}),result=await pipeline.run(observation,{phase:'memory_build',dataset:'medlocomo',prepared}),trace=result.traces.find(item=>item.component==='memory_node_extractor'),fallback=result.final.memory_nodes.find(node=>node.memory_id.endsWith(':source-turn:0')),patientFallback=result.final.memory_nodes.find(node=>node.memory_id.endsWith(':source-turn:1'));
    assert.ok(fallback);assert.equal(fallback.text,doctor);assert.equal(fallback.source_text,doctor);assert.equal(raw_text.slice(...fallback.span),doctor);assert.equal(fallback.source_type,'doctor');assert.equal(fallback.turn_id,'8');assert.equal(fallback.event_time,'2132-10-01 09:08:00');
    assert.ok(patientFallback);assert.equal(patientFallback.text,patient);assert.equal(patientFallback.source_type,'patient');assert.equal(patientFallback.turn_id,'9');assert.equal(patientFallback.event_time,'2132-10-01 09:10:00');
    assert.equal(result.final.memory_nodes.some(node=>node.text.includes('5 mg daily')),false);
    assert.equal(trace.gateway.semantic_state_repair.accepted_replacement_count,0);assert.equal(trace.gateway.medlocomo_source_turn_fallback.added_count,2);assert.equal(trace.gateway.medlocomo_source_turn_fallback.gold_or_judge_input_used,false);assert.equal(trace.gateway.source_alignment_gate.quarantined_memory_node_count,0);
    const retrieval=retrieveMemoryCandidates({question_request:'Q',instruction:{search_terms:['Warfarin','4 mg']}},result.final.memory_nodes);
    assert.ok(retrieval.memory_nodes.some(node=>node.memory_id===fallback.memory_id));
  }finally{store.close()}
});

test('source-Turn fallback is MedLoCoMo-only and the ordinary source-alignment gate still quarantines tampering',async()=>{
  const text='Imaging shows the stent is open. Warfarin was increased to 4 mg daily.',raw_text=`[Turn=8][Role=Doctor][Time=2024-10-01 09:08:00]\n${text}`,observation={observation_id:'source-turn-scope',subject_id:'patient',source_type:'structured',episode_id:'session-1',turn_id:'session',event_time:'2024-10-01 09:08:00',raw_text},unit=I.semanticExtractorInput(observation).context_units[0],extractor={config:{provider:'live-test',model:'source-turn-scope-test'},publicConfig(){return this.config},async completeJSON(component,input,validator){const raw={memory_nodes:[{text:'Imaging shows the stent is open.',support_unit_ids:[unit.unit_id]}]},value=validator(raw);return{value,trace:{component,model_input:input,raw_model_response:JSON.stringify(raw)}};}},store=new Store(':memory:'),pipeline=new Pipeline(store,{componentGateways:{extractor}});
  try{
    const result=await pipeline.run(observation,{phase:'memory_build',dataset:'medmemorybench'});
    assert.equal(result.final.memory_nodes.some(node=>node.memory_id.includes(':source-turn:')),false);
    const candidate=I.medLoCoMoSourceTurnFallbackCandidates(observation)[0],ungrounded={...candidate,memory_id:'source-turn-scope:llm:0',source_text:null,span:null},supplemented=I.augmentMedLoCoMoSourceTurnCoverage({value:[ungrounded],trace:{}},observation),eligible=I.quarantineUnalignedMemoryNodes(supplemented,observation).value;
    assert.deepEqual(eligible.map(node=>node.memory_id),[candidate.memory_id]);
    const tampered={...candidate,span:[candidate.span[0],candidate.span[1]-1]},gated=I.quarantineUnalignedMemoryNodes({value:[tampered],trace:{}},observation);
    assert.equal(gated.value.length,0);assert.deepEqual(gated.trace.source_alignment_gate.reason_counts,{source_span_text_mismatch:1});
  }finally{store.close()}
});
