import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.js';
import { Pipeline,pipelineInternals } from '../src/pipeline.js';
import { validateMemoryEdge } from '../src/schema.js';
import { inspectLongitudinalRelation,updateMemoryGraph } from '../src/memory-graph-updater.js';

const observation=(text,episode,event_time,source_type='patient')=>({subject_id:'graph-patient',source_type,episode_id:episode,turn_id:'1',event_time,raw_text:text});
const incoming=(memory_id,text,extra={})=>({memory_id,observation_id:`o-${memory_id}`,subject_id:'graph-patient',text,source_text:text,span:[0,text.length],source_type:'patient',episode_id:'session-1',turn_id:'1',event_time:'2025-01-01',certainty:1,polarity:'affirmed',families:['PE'],...extra});
const relationProposal=(from,to,relation_type,extra={})=>({candidate_id:'relation_candidate_001',from_memory_id:from,to_memory_id:to,relation_type,edge_family:['informs','motivates','constrains'].includes(relation_type)?'clinical_care':'temporal',confidence:.93,reason:'两个原文端点直接支持该非因果关系。',support_memory_ids:[from,to],source:'llm_source_grounded_relation_classifier',causal_claim:false,...extra});

test('one factual occurrence is one Memory Node with multiple family labels',()=>{
  const update=pipelineInternals.updateMemoryGraph([incoming('m1','患者正在服用二甲双胍。',{families:['PE','CS']})],[],[],{subject_id:'graph-patient'});
  assert.equal(update.nodes.length,1);assert.deepEqual(update.nodes[0].families,['PE','CS']);assert.equal(update.edges.length,0);
});

test('factor domains remain orthogonal to family labels',()=>{
  const update=pipelineInternals.updateMemoryGraph([incoming('medical','患者既往有糖尿病病史。',{families:['BC']}),incoming('social','患者因工作费用压力缺少家庭支持。',{families:['BC']}),incoming('behavior','患者经常漏服二甲双胍。',{families:['PE']})],[],[],{subject_id:'graph-patient'}),byId=new Map(update.nodes.map(node=>[node.memory_id,node]));
  assert.ok(byId.get('medical').factor_domains.includes('biological'));assert.ok(byId.get('social').factor_domains.includes('social'));assert.ok(byId.get('behavior').factor_domains.includes('behavioral'));
});

test('future-year date prefixes do not split the same clinical factor',()=>{
  const update=updateMemoryGraph([incoming('early','2114-09-23 患者空腹血糖为 7 mmol/L。',{families:['CS'],event_time:'2114-09-23'}),incoming('late','2209-12-31 患者空腹血糖为 9 mmol/L。',{families:['CS'],episode_id:'session-2',event_time:'2209-12-31'})],[],[],{subject_id:'graph-patient'});
  assert.equal(update.nodes[0].factor_key,update.nodes[1].factor_key);
});

test('one dated Session remains provenance membership and is not materialized as ordinary edges',()=>{
  const update=pipelineInternals.updateMemoryGraph([incoming('a','患者报告目标症状。'),incoming('b','医生记录相关检查。'),incoming('c','患者确认治疗执行。')],[],[],{subject_id:'graph-patient'});
  assert.equal(update.edges.some(edge=>edge.relation_type==='co_observed'),false);
  assert.deepEqual(update.episode_memberships,[{episode_id:'session-1',memory_ids:['a','b','c']}]);
});

test('quantitative changes form one version chain with a verified temporal edge',()=>{
  const first=pipelineInternals.updateMemoryGraph([incoming('jan','患者空腹血糖为 7 mmol/L。',{families:['CS'],event_time:'2025-01-01'})],[],[],{subject_id:'graph-patient'}),second=pipelineInternals.updateMemoryGraph([incoming('feb','患者空腹血糖为 9 mmol/L。',{families:['CS'],episode_id:'session-2',event_time:'2025-02-01'})],first.nodes,first.edges,{subject_id:'graph-patient'});
  assert.equal(first.nodes[0].factor_key,second.nodes[0].factor_key);assert.equal(second.nodes[0].predecessor_memory_id,'jan');assert.equal(second.nodes[0].operation,'UPDATE');
  assert.ok(second.edges.some(edge=>edge.from_memory_id==='jan'&&edge.to_memory_id==='feb'&&edge.relation_type==='updates'&&edge.status==='verified'));
});

test('attribution wrappers and temporal wording do not split one clinical factor',()=>{
  const first=pipelineInternals.updateMemoryGraph([incoming('wrapped-old','患者原话：患者近期晨起心率为 90 bpm。',{families:['CS'],event_time:'2025-01-01'})],[],[],{subject_id:'graph-patient'}),second=pipelineInternals.updateMemoryGraph([incoming('wrapped-new','医生记录：患者当前晨起心率为 80 bpm。',{source_type:'doctor',families:['CS'],episode_id:'session-2',event_time:'2025-02-01'})],first.nodes,first.edges,{subject_id:'graph-patient'});
  assert.equal(second.nodes[0].factor_key,first.nodes[0].factor_key);assert.equal(second.nodes[0].predecessor_memory_id,'wrapped-old');assert.equal(second.edges[0].relation_type,'updates');
});

test('a repeated fact records persistence rather than another semantic copy layer',()=>{
  const first=pipelineInternals.updateMemoryGraph([incoming('first','患者空腹血糖为 7 mmol/L。',{families:['CS'],event_time:'2025-01-01'})],[],[],{subject_id:'graph-patient'}),second=pipelineInternals.updateMemoryGraph([incoming('second','患者空腹血糖为 7 mmol/L。',{families:['CS'],episode_id:'session-2',event_time:'2025-02-01'})],first.nodes,first.edges,{subject_id:'graph-patient'});
  assert.equal(second.nodes[0].operation,'NOOP');assert.equal(second.edges[0].relation_type,'persists');assert.equal(second.edges[0].persistent,true);
});

test('same source occurrence is coalesced before persistence and keeps all family labels',()=>{
  const first=incoming('llm','患者视物模糊。',{observation_id:'same-observation',span:[10,17],source_text:'患者视物模糊。',families:['PE']}),coverage=incoming('coverage','患者原话：患者视物模糊。',{observation_id:'same-observation',span:[10,17],source_text:'患者视物模糊。',families:['CS']});
  const update=pipelineInternals.updateMemoryGraph([first,coverage],[],[],{subject_id:'graph-patient'});
  assert.equal(update.nodes.length,1);assert.equal(update.nodes[0].memory_id,'llm');assert.deepEqual(update.nodes[0].families,['PE','CS']);assert.equal(update.edges.length,0);
});

test('explicit longitudinal wording produces verified resolves, recurs and supersedes edges',()=>{
  const start=pipelineInternals.updateMemoryGraph([incoming('start','患者头痛开始出现。',{factor_key:'symptom:headache',event_time:'2025-01-01'})],[],[],{subject_id:'graph-patient'}),resolved=pipelineInternals.updateMemoryGraph([incoming('resolved','患者头痛已经消失。',{factor_key:'symptom:headache',episode_id:'session-2',event_time:'2025-02-01'})],start.nodes,start.edges,{subject_id:'graph-patient'}),recurred=pipelineInternals.updateMemoryGraph([incoming('recurred','患者头痛再次出现。',{factor_key:'symptom:headache',episode_id:'session-3',event_time:'2025-03-01'})],[...start.nodes,...resolved.nodes],[...start.edges,...resolved.edges],{subject_id:'graph-patient'}),oldPlan=pipelineInternals.updateMemoryGraph([incoming('old-plan','患者使用旧治疗方案。',{factor_key:'care:regimen',families:['CP'],event_time:'2025-01-01'})],[],[],{subject_id:'graph-patient'}),newPlan=pipelineInternals.updateMemoryGraph([incoming('new-plan','患者由旧治疗方案改为新治疗方案。',{factor_key:'care:regimen',families:['CP'],episode_id:'session-2',event_time:'2025-02-01'})],oldPlan.nodes,oldPlan.edges,{subject_id:'graph-patient'});
  assert.equal(resolved.nodes[0].operation,'RESOLVE');assert.ok(resolved.edges.some(edge=>edge.relation_type==='resolves'));
  assert.ok(recurred.edges.some(edge=>edge.relation_type==='recurs'));
  assert.equal(newPlan.nodes[0].operation,'SUPERSEDE');assert.ok(newPlan.edges.some(edge=>edge.relation_type==='supersedes'));
  for(const edge of [...resolved.edges,...recurred.edges,...newPlan.edges])validateMemoryEdge(edge);
});

test('opposing same-moment facts conflict while later status is an update',()=>{
  const first=pipelineInternals.updateMemoryGraph([incoming('yes','患者存在头痛。',{factor_key:'symptom:headache'})],[],[],{subject_id:'graph-patient'}),sameMoment=pipelineInternals.updateMemoryGraph([incoming('no','患者否认头痛。',{factor_key:'symptom:headache',polarity:'negated'})],first.nodes,first.edges,{subject_id:'graph-patient'}),later=pipelineInternals.updateMemoryGraph([incoming('later-no','患者目前没有头痛症状。',{factor_key:'symptom:headache',episode_id:'session-2',event_time:'2025-02-01',polarity:'negated'})],first.nodes,first.edges,{subject_id:'graph-patient'});
  assert.equal(sameMoment.nodes[0].operation,'CONFLICT');assert.equal(sameMoment.edges[0].relation_type,'conflicts');
  assert.equal(later.nodes[0].operation,'UPDATE');assert.equal(later.edges[0].relation_type,'updates');
});

test('relation verifier rejects unsupported causal proposals and cross-factor links',()=>{
  const from={...incoming('from','患者空腹血糖为 7 mmol/L。',{factor_key:'measurement:glucose'}),subject_id:'graph-patient'},to={...incoming('to','患者空腹血糖为 9 mmol/L。',{factor_key:'measurement:glucose',episode_id:'session-2',event_time:'2025-02-01'}),subject_id:'graph-patient'},other={...incoming('other','患者近期睡眠变差。',{factor_key:'symptom:sleep'}),subject_id:'graph-patient'};
  assert.deepEqual(inspectLongitudinalRelation(from,to,'updates').grounded,true);
  assert.deepEqual(inspectLongitudinalRelation(from,to,'contributes_to').grounded,false);
  assert.deepEqual(inspectLongitudinalRelation(from,other).reasons,['different_clinical_factor']);
  assert.deepEqual(inspectLongitudinalRelation(from,{...to,source_text:null,span:null}).reasons,['ungrounded_endpoint']);
});

test('a complete high-confidence source-grounded care proposal becomes a verified persistent edge',()=>{
  const lab=incoming('lab','患者 HbA1c 为 9.2%。',{families:['CS'],event_time:'2025-01-01'}),plan=incoming('plan','医生基于 HbA1c 9.2% 的结果调整了胰岛素方案。',{source_type:'doctor',families:['CP'],episode_id:'session-2',event_time:'2025-02-01'}),update=updateMemoryGraph([plan],[lab],[],{subject_id:'graph-patient'},{relationProposals:[relationProposal('lab','plan','informs')]}),edge=update.edges.find(item=>item.source==='llm_source_grounded_relation_classifier');
  assert.ok(edge);assert.equal(edge.edge_family,'clinical_care');assert.equal(edge.relation_type,'informs');assert.deepEqual(edge.support_memory_ids,['lab','plan']);assert.equal(edge.confidence,.93);assert.equal(edge.support_kind,'asserted');assert.equal(edge.status,'verified');assert.equal(edge.verified,true);assert.equal(edge.persistent,true);assert.equal(edge.causal_claim,false);validateMemoryEdge(edge);
});

test('care-family grounding works even when endpoint vocabulary does not overlap',()=>{
  const assessment=incoming('assessment','患者检查结果异常。',{families:['CS'],event_time:'2025-01-01'}),plan=incoming('care-plan','医生因此调整治疗方案。',{source_type:'doctor',families:['CP'],episode_id:'session-2',event_time:'2025-02-01'}),update=updateMemoryGraph([plan],[assessment],[],{subject_id:'graph-patient'},{relationProposals:[relationProposal('assessment','care-plan','informs')]});
  assert.ok(update.edges.some(edge=>edge.source==='llm_source_grounded_relation_classifier'&&edge.relation_type==='informs'));
});

test('Pipeline sends bounded pairs to the relation model and persists only its verified proposal',async()=>{
  const relationGateway={config:{provider:'live-test',model:'relation-test'},publicConfig(){return this.config;},async completeJSON(component,input,validator){const raw={relations:input.candidates.map(candidate=>({candidate_id:candidate.candidate_id,relation_type:'informs',confidence:.95,reason:'后续医生原文明示依据该 HbA1c 检查结果调整方案。'}))};return{value:validator(raw),trace:{component,model:'relation-test',model_input:input,raw_model_response:JSON.stringify(raw),parsed_response:raw}};}},store=new Store(':memory:'),pipeline=new Pipeline(store,{componentGateways:{relation_classifier:relationGateway}});
  await pipeline.run(observation('患者 HbA1c 为 9.2%。','session-1','2025-01-01','structured'),{phase:'memory_build'});
  const second=await pipeline.run(observation('医生基于 HbA1c 9.2% 的检查结果调整胰岛素方案。','session-2','2025-02-01','doctor'),{phase:'memory_build'}),relationTrace=second.traces.find(trace=>trace.component==='memory_relation_classifier'),edge=store.memoryEdgesFor('graph-patient').find(item=>item.source==='llm_source_grounded_relation_classifier');
  assert.ok(relationTrace);assert.equal(relationTrace.output.candidate_count>0,true);assert.equal(relationTrace.gateway.model_input.candidates.every(candidate=>!Object.hasOwn(candidate,'gold')),true);
  assert.ok(edge);assert.equal(edge.relation_type,'informs');assert.equal(edge.edge_family,'clinical_care');assert.equal(edge.status,'verified');assert.equal(edge.causal_claim,false);store.close();
});

test('Pipeline keeps source-grounded Memory Nodes when the optional relation classifier fails',async()=>{
  const relationGateway={config:{provider:'live-test',model:'relation-test'},publicConfig(){return this.config;},async completeJSON(){const error=new Error('relation output invalid');throw Object.assign(error,{gatewayTrace:{component:'relation_classifier',input:{},error:{kind:'schema_error',message:error.message,validation_errors:['invalid relation']}}});}},store=new Store(':memory:'),pipeline=new Pipeline(store,{componentGateways:{relation_classifier:relationGateway}});
  await pipeline.run(observation('患者 HbA1c 为 9.2%。','session-1','2025-01-01','structured'),{phase:'memory_build'});
  const second=await pipeline.run(observation('医生基于 HbA1c 9.2% 的结果调整了胰岛素方案。','session-2','2025-02-01','doctor'),{phase:'memory_build'}),trace=second.traces.find(item=>item.component==='memory_relation_classifier');
  assert.equal(second.status,'completed');assert.equal(trace.status,'failed');assert.equal(trace.output.degraded,true);assert.equal(store.memoryNodesFor('graph-patient').some(node=>node.episode_id==='session-2'),true);store.close();
});

test('LLM proposals are rejected when provenance, support, confidence, family, type or non-causal contract is invalid',()=>{
  const lab=incoming('lab','患者 HbA1c 为 9.2%。',{families:['CS'],event_time:'2025-01-01'}),plan=incoming('plan','医生基于 HbA1c 9.2% 的结果调整了胰岛素方案。',{source_type:'doctor',families:['CP'],episode_id:'session-2',event_time:'2025-02-01'}),base=relationProposal('lab','plan','informs'),invalid=[
    {...base,source:'another_classifier'},
    {...base,causal_claim:true},
    {...base,support_memory_ids:['plan','lab']},
    {...base,edge_family:'temporal'},
    {...base,confidence:.84},
    {...base,relation_type:'contributes_to'},
    {...base,relation_type:'co_observed'},
    {...base,relation_type:'causes'},
    {...base,causal:true},
    {...base,candidate_id:''},
    {...base,to_memory_id:'missing',support_memory_ids:['lab','missing']}
  ];
  for(const proposal of invalid){const update=updateMemoryGraph([plan],[lab],[],{subject_id:'graph-patient'},{relationProposals:[proposal]});assert.equal(update.edges.some(edge=>edge.source==='llm_source_grounded_relation_classifier'),false,JSON.stringify(proposal));}
  const crossPatient={...lab,subject_id:'another-patient'},cross=updateMemoryGraph([plan],[crossPatient],[],{subject_id:'graph-patient'},{relationProposals:[base]});assert.equal(cross.edges.some(edge=>edge.source==='llm_source_grounded_relation_classifier'),false);
  const ungrounded={...lab,source_text:null,span:null},missingSource=updateMemoryGraph([plan],[ungrounded],[],{subject_id:'graph-patient'},{relationProposals:[base]});assert.equal(missingSource.edges.some(edge=>edge.source==='llm_source_grounded_relation_classifier'),false);
});

test('LLM longitudinal proposals require exact deterministic agreement',()=>{
  const active=incoming('active','患者头痛持续存在。',{factor_key:'symptom:headache',event_time:'2025-01-01'}),resolved=incoming('resolved-by-source','患者头痛已经消失。',{factor_key:'symptom:headache',episode_id:'session-2',event_time:'2025-02-01'}),update=updateMemoryGraph([resolved],[active],[],{subject_id:'graph-patient'},{relationProposals:[relationProposal('active','resolved-by-source','updates')]});
  assert.ok(update.edges.some(edge=>edge.relation_type==='resolves'&&edge.source==='source_grounded_memory_transition'));
  assert.equal(update.edges.some(edge=>edge.source==='llm_source_grounded_relation_classifier'),false);
});

test('followed_by requires strict chronology and clinically related candidate endpoints',()=>{
  const treatment=incoming('treatment','患者开始使用 DPP-4 抑制剂。',{families:['CP'],event_time:'2025-01-01'}),response=incoming('response','患者使用 DPP-4 抑制剂后复查血糖。',{families:['CS'],episode_id:'session-2',event_time:'2025-02-01'}),accepted=updateMemoryGraph([response],[treatment],[],{subject_id:'graph-patient'},{relationProposals:[relationProposal('treatment','response','followed_by')]}),edge=accepted.edges.find(item=>item.source==='llm_source_grounded_relation_classifier');
  assert.ok(edge);assert.equal(edge.relation_type,'followed_by');assert.equal(edge.edge_family,'temporal');validateMemoryEdge(edge);
  const sameTime={...response,event_time:'2025-01-01'},notOrdered=updateMemoryGraph([sameTime],[treatment],[],{subject_id:'graph-patient'},{relationProposals:[relationProposal('treatment','response','followed_by')]});assert.equal(notOrdered.edges.some(item=>item.source==='llm_source_grounded_relation_classifier'),false);
  const unrelated=incoming('unrelated','患者家庭住址发生变化。',{families:['BC'],episode_id:'session-2',event_time:'2025-02-01'}),notRelated=updateMemoryGraph([unrelated],[treatment],[],{subject_id:'graph-patient'},{relationProposals:[relationProposal('treatment','unrelated','followed_by')]});assert.equal(notRelated.edges.some(item=>item.source==='llm_source_grounded_relation_classifier'),false);
});

test('backfilled events do not replace a later current Memory Node',()=>{
  const latest=pipelineInternals.updateMemoryGraph([incoming('latest','患者空腹血糖为 9 mmol/L。',{families:['CS'],episode_id:'session-3',event_time:'2025-03-01'})],[],[],{subject_id:'graph-patient'}),backfill=pipelineInternals.updateMemoryGraph([incoming('old','患者空腹血糖为 7 mmol/L。',{families:['CS'],event_time:'2025-01-01'})],latest.nodes,latest.edges,{subject_id:'graph-patient'}),current=pipelineInternals.currentMemory([...latest.nodes,...backfill.nodes]);
  assert.equal(current.length,1);assert.equal(current[0].memory_id,'latest');
});

test('checkpoints restore the same unified nodes and edges',async()=>{
  const store=new Store(':memory:'),pipeline=new Pipeline(store);await pipeline.run(observation('患者目前空腹血糖为 7 mmol/L。','session-1','2025-01-01','structured'),{phase:'memory_build'});await pipeline.run(observation('患者目前空腹血糖为 9 mmol/L。','session-2','2025-02-01','structured'),{phase:'memory_build'});
  const before=structuredClone(store.memoryGraphFor('graph-patient'));store.saveMemoryCheckpoint({benchmark:'test',subject_id:'graph-patient',scope_key:'unified-v14',session_no:2,prefix_hash:'prefix',experiment_id:'test'});const checkpoint=store.getMemoryCheckpoint({benchmark:'test',subject_id:'graph-patient',scope_key:'unified-v14',session_no:2,prefix_hash:'prefix'});
  store.clearMemory('graph-patient');const restored=store.restoreMemoryCheckpoint(checkpoint),after=store.memoryGraphFor('graph-patient');assert.equal(restored.restored,before.nodes.length);assert.equal(restored.restored_edges,before.edges.length);assert.deepEqual(after.nodes,before.nodes);assert.deepEqual(after.edges,before.edges);store.close();
});

test('optimistic graph revision rejects a stale concurrent calculation',async()=>{
  const store=new Store(':memory:'),outer=new Pipeline(store),competitor=new Pipeline(store);let injected=false;
  await assert.rejects(()=>outer.run(observation('患者目前空腹血糖为 7 mmol/L。','session-1','2025-01-01','structured'),{phase:'memory_build',breakpoint:async({traces})=>{if(!injected&&traces.at(-1)?.component==='memory_graph_updater'){injected=true;await competitor.run(observation('患者目前空腹血糖为 9 mmol/L。','session-2','2025-02-01','structured'),{phase:'memory_build'});}}}),/changed concurrently/);
  assert.ok(store.memoryNodesFor('graph-patient').every(node=>node.episode_id==='session-2'));store.close();
});
