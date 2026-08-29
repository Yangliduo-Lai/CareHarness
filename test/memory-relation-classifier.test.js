import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelGateway } from '../src/gateway.js';
import { buildMemoryRelationCandidates,classifyMemoryRelations,memoryRelationClassifierInput,normalizeMemoryRelationOutput,relationProposalsFromDecisions } from '../src/memory-relation-classifier.js';

function node(id,text,eventTime='2025-01-01',extra={}){const source=extra.source_text||text,start=Number(extra.span_start)||0;return{memory_id:id,observation_id:extra.observation_id||`obs-${id}`,subject_id:extra.subject_id||'patient-1',text,source_text:source,span:extra.span||[start,start+source.length],source_type:extra.source_type||'patient',episode_id:extra.episode_id||`session-${eventTime}`,turn_id:extra.turn_id||'1',event_time:eventTime,certainty:1,polarity:'affirmed',families:extra.families||['CS'],factor_key:extra.factor_key||'',...extra};}

test('bounded relation candidates use source-grounded same-patient indexes instead of all node pairs',()=>{
  const historical=[];for(let index=0;index<300;index++)historical.push(node(`unrelated-${index}`,`患者记录了互不相关的事项编号 ${index}。`,'2024-01-01',{factor_key:`factor:${index}`,families:['BC']}));
  historical.push(node('old-glucose','患者空腹血糖为 7 mmol/L。','2025-01-01',{factor_key:'measurement:fasting-glucose'}));
  historical.push(node('other-patient','患者空腹血糖为 8 mmol/L。','2025-01-02',{subject_id:'patient-2',factor_key:'measurement:fasting-glucose'}));
  historical.push(node('ungrounded','患者空腹血糖为 8 mmol/L。','2025-01-02',{factor_key:'measurement:fasting-glucose',source_text:null,span:null}));
  const incoming=[node('new-glucose','患者空腹血糖升至 9 mmol/L。','2025-02-01',{factor_key:'measurement:fasting-glucose'})],candidates=buildMemoryRelationCandidates(incoming,historical,{maxCandidates:8,maxCandidatesPerIncoming:3});
  assert.equal(candidates.length<=3,true);assert.ok(candidates.some(candidate=>candidate.from_node.memory_id==='old-glucose'&&candidate.to_node.memory_id==='new-glucose'));assert.equal(candidates.some(candidate=>candidate.from_node.memory_id==='other-patient'),false);assert.equal(candidates.some(candidate=>candidate.from_node.memory_id==='ungrounded'),false);
});

test('classifier input exposes only opaque candidate ids and grounded endpoint evidence',()=>{
  const from=node('from','患者规律服用二甲双胍。','2025-01-01',{query:'secret query',gold:'secret gold',judge_metadata:{trap:true}}),to=node('to','患者改用胰岛素。','2025-02-01',{query:'secret query',answer_explanation:'secret explanation'}),candidate={candidate_id:'relation_candidate_001',from_node:from,to_node:to},input=memoryRelationClassifierInput([candidate]),serialized=JSON.stringify(input);
  assert.deepEqual(Object.keys(input.candidates[0]),['candidate_id','from','to']);assert.deepEqual(Object.keys(input.candidates[0].from),['text','source_text','role','event_time']);assert.equal(serialized.includes('from_memory_id'),false);assert.equal(serialized.includes('secret query'),false);assert.equal(serialized.includes('secret gold'),false);assert.equal(serialized.includes('secret explanation'),false);assert.equal(serialized.includes('judge_metadata'),false);
});

test('relation output requires every candidate exactly once and rejects unknown ids and causal relations',()=>{
  const candidates=[{candidate_id:'c1'},{candidate_id:'c2'}],valid={relations:[{candidate_id:'c2',relation_type:'none',confidence:.9,reason:'无直接关系。'},{candidate_id:'c1',relation_type:'updates',confidence:.91,reason:'同一指标出现新值。'}]};
  assert.deepEqual(normalizeMemoryRelationOutput(valid,candidates).relations.map(item=>item.candidate_id),['c1','c2']);
  assert.throws(()=>normalizeMemoryRelationOutput({relations:[valid.relations[0],valid.relations[0]]},candidates),/appears more than once|is missing/);
  assert.throws(()=>normalizeMemoryRelationOutput({relations:[valid.relations[0],{...valid.relations[1],candidate_id:'invented'}]},candidates),/unknown candidate_id/);
  for(const relation_type of['causes','contributes_to','co_observed'])assert.throws(()=>normalizeMemoryRelationOutput({relations:[{...valid.relations[1],relation_type},{...valid.relations[0]}]},candidates),/forbidden or unknown relation_type/);
});

test('unsupported non-causal labels degrade to none and overlong reasons are safely bounded',()=>{
  const candidates=[{candidate_id:'c1'}],reason='原文依据。'.repeat(120),relations=normalizeMemoryRelationOutput({relations:[{candidate_id:'c1',relation_type:'confirms',confidence:.93,reason}]},candidates).relations;
  assert.equal(relations[0].relation_type,'none');assert.equal(relations[0].reason.length,500);
});

test('only high-confidence, source-complete, non-causal decisions become updater proposals',()=>{
  const from=node('old','患者头痛持续存在。','2025-01-01',{factor_key:'symptom:headache'}),to=node('new','患者头痛已经消失。','2025-02-01',{factor_key:'symptom:headache'}),candidates=[{candidate_id:'c1',from_node:from,to_node:to},{candidate_id:'c2',from_node:from,to_node:{...to,memory_id:'broken',source_text:null,span:null}},{candidate_id:'c3',from_node:from,to_node:to}],decisions=[{candidate_id:'c1',relation_type:'resolves',confidence:.9,reason:'后续原文明示头痛消失。'},{candidate_id:'c2',relation_type:'updates',confidence:.99,reason:'缺少来源。'},{candidate_id:'c3',relation_type:'updates',confidence:.7,reason:'置信度不足。'}],proposals=relationProposalsFromDecisions(decisions,candidates);
  assert.equal(proposals.length,1);assert.deepEqual(proposals[0],{candidate_id:'c1',from_memory_id:'old',to_memory_id:'new',relation_type:'resolves',edge_family:'temporal',confidence:.9,reason:'后续原文明示头痛消失。',support_memory_ids:['old','new'],source:'llm_source_grounded_relation_classifier',causal_claim:false});
});

test('offline classifier returns no proposals and a real-compatible gateway receives no benchmark fields',async()=>{
  const gateway=new ModelGateway(),from=node('old','患者头痛持续存在。','2025-01-01',{factor_key:'symptom:headache'}),to=node('new','患者头痛已经消失。','2025-02-01',{factor_key:'symptom:headache'}),result=await classifyMemoryRelations(gateway,[to],[from]);
  assert.ok(result.candidates.length>0);assert.equal(result.decisions.every(decision=>decision.relation_type==='none'),true);assert.deepEqual(result.relationProposals,[]);assert.equal(result.trace.component,'relation_classifier');assert.equal(JSON.stringify(result.trace.model_input).includes('gold'),false);
});
