import test from 'node:test';
import assert from 'node:assert/strict';
import { adapters } from '../src/adapters/index.js';
import { Store } from '../src/db.js';
import { ExperimentHarness,MEMORY_PIPELINE_VERSION } from '../src/experiments.js';
import { medMemorySubjectId } from '../src/adapters/medmemory.js';

const A=adapters();

test('memory checkpoint compatibility contract is semantic-source-anchored unified Memory Graph v17',()=>assert.equal(MEMORY_PIPELINE_VERSION,'unified-memory-graph-v17-semantic-source-anchors'));

test('MedMemory emits one complete role-attributed Session observation without hidden fields',()=>{
  const data=A.medmemorybench.load({persona_id:1,max_session:1}),observation=data.observations[0],raw=JSON.stringify(observation);
  assert.equal(data.subject_id,medMemorySubjectId(1,false));assert.equal(data.observations.length,1);assert.equal(observation.source_type,'structured');
  assert.match(observation.raw_text,/\[Role=Patient\]/);assert.match(observation.raw_text,/\[Role=Doctor\]/);
  for(const key of ['knowledge_points','source_key_points','answers','gold','judge'])assert.equal(raw.includes(key),false,key);
});

test('MedMemory query visibility stops at the query Session and keeps official answer contracts',()=>{
  const cases=A.medmemorybench.cases(A.medmemorybench.load({persona_id:1,max_session:20,noise:false})),item=cases.find(value=>value.metadata.query_session===10);
  assert.ok(item);assert.ok(item.metadata.visible_episode_ids.includes('session-10'));assert.equal(item.metadata.visible_episode_ids.includes('session-11'),false);
  assert.ok(item.metadata.answer_contract.format);assert.equal(Object.hasOwn(item.metadata,'answers'),false);
});

test('MedMemory can select one exact query_id before any model payload is built',()=>{
  const data=A.medmemorybench.load({persona_id:1,start_session:60,max_session:60,query_id:'session_60_sua_1'}),cases=A.medmemorybench.cases(data);
  assert.deepEqual(cases.map(item=>item.score_id),['session_60_sua_1']);assert.equal(cases[0].task,'state_update');assert.equal(data.query_selection.query_id,'session_60_sua_1');
  assert.throws(()=>A.medmemorybench.load({persona_id:1,start_session:60,max_session:60,query_id:'missing-query'}),/does not contain query_id/);
});

test('MedMemory can select an explicit query_id subset for routing diagnostics',()=>{
  const queryIds=['session_10_eem_1','session_10_mq_1'],data=A.medmemorybench.load({persona_id:1,max_session:10,query_ids:queryIds}),cases=A.medmemorybench.cases(data);
  assert.deepEqual(cases.map(item=>item.score_id),queryIds);assert.deepEqual(data.query_selection.query_ids,queryIds);
  assert.throws(()=>A.medmemorybench.load({persona_id:1,max_session:10,query_ids:['session_10_eem_1','missing-query']}),/does not contain query_id/);
});

test('MedMemory keeps Clean and Noise in different graph subjects',()=>{
  const clean=A.medmemorybench.load({persona_id:1,max_session:1,noise:false}),noise=A.medmemorybench.load({persona_id:1,max_session:1,noise:true});
  assert.notEqual(clean.subject_id,noise.subject_id);assert.equal(clean.memory_namespace,'clean');assert.equal(noise.memory_namespace,'with-noise');
  assert.ok(noise.observations.every(item=>item.subject_id===noise.subject_id));assert.ok(clean.observations.every(item=>item.subject_id===clean.subject_id));
});

test('MedMemory preserves official MQ and LLM-Judge metric routing',()=>{
  const cases=A.medmemorybench.cases(A.medmemorybench.load({persona_id:1,max_session:10})),mq=cases.find(item=>item.task==='multiple_choice'),tla=cases.find(item=>item.task==='temporal_localization');
  assert.ok(mq);assert.ok(tla);assert.equal(A.medmemorybench.compatibleScore(mq.gold.join(','),mq.gold,mq).score,1);assert.equal(A.medmemorybench.requiresOfficialJudge(tla),true);
});

test('MedMemory adapter excludes unusable records with an empty question',()=>{
  const adapter=adapters().medmemorybench,data=adapter.load({persona_id:4,noise:false,max_session:100}),cases=adapter.cases(data);
  assert.ok(cases.length>0);assert.equal(cases.every(item=>String(item.question||'').trim().length>0),true);
});

test('MedLoCoMo and CPCD retain protocol inputs outside core observations',()=>{
  const med=A.medlocomo.load({patient_id:'16957952'}),cpcd=A.cpcdbench.load({case_id:'张明_261'}),cpcdCases=A.cpcdbench.cases(cpcd),raw=JSON.stringify([...med.observations,...cpcd.observations]);
  assert.ok(med.observations.length>1);assert.ok(cpcd.observations.length);assert.equal(raw.includes('reference_answer'),false);assert.equal(raw.includes('evaluation_focus'),false);
  assert.ok(cpcdCases.some(item=>item.metadata.protocol_only===true));assert.ok(cpcdCases.every(item=>item.metadata.answer_contract));
});

test('MedLoCoMo can select exact query IDs for bounded diagnostics',()=>{
  const all=A.medlocomo.load({patient_id:'16957952'}),queryIds=all.queries.slice(0,2).map(item=>String(item.qa_id)),selected=A.medlocomo.cases(all,{query_ids:queryIds});
  assert.deepEqual(selected.map(item=>item.score_id),queryIds);
  assert.throws(()=>A.medlocomo.load({patient_id:'16957952',query_id:'missing-query'}),/does not contain query_id/);
});

test('all adapters emit the same minimal core observation shape',()=>{
  const samples=[A.medmemorybench.load({persona_id:1,max_session:1}),A.medlocomo.load({patient_id:'16957952'}),A.cpcdbench.load({case_id:'张明_261'})],expected=['episode_id','event_time','raw_text','source_type','subject_id','turn_id'];
  for(const sample of samples){assert.ok(sample.observations.length);assert.deepEqual(Object.keys(sample.observations[0]).sort(),expected);}
});

test('query, Gold and evaluator metadata cannot become core observations',()=>{
  for(const key of ['query','question','gold','answers','answer_options','judge_score'])assert.throws(()=>A.medmemorybench.assertCoreObservation({metadata:{[key]:'leak'}}),/leakage|forbidden hidden field/i);
});

test('a synthetic experiment stores only unified Memory Nodes and adaptive Investigation output',async()=>{
  const store=new Store(':memory:'),harness=new ExperimentHarness(store),subject='synthetic-memory';
  harness.adapters.synthetic={load:()=>({observations:[{subject_id:subject,source_type:'patient',episode_id:'session-1',turn_id:'1',event_time:'2024-01-01',raw_text:'患者正在服用二甲双胍。'}]}),cases:()=>[{score_id:'q1',task:'entity_exact_match',question:'患者服用什么药？',gold:['二甲双胍'],metadata:{visible_episode_ids:['session-1'],answer_contract:{language:'zh-CN',format:'brief'}}}],normalizeAnswer:String,compatibleScore:()=>({score:1,is_correct:true,method:'synthetic'})};
  const done=await harness.start('synthetic',{}),score=done.results.find(item=>item.kind==='score');
  assert.equal(done.status,'completed');assert.ok(store.memoryNodesFor(subject).length);assert.equal(store.memoryEdgesFor(subject).every(edge=>edge.from_memory_id&&edge.to_memory_id),true);
  assert.ok(score.retrieval_context.question_request);assert.ok(Array.isArray(score.retrieval_context.investigation_trace));assert.equal(score.retrieval_context.query_plan,undefined);
  assert.equal(score.retrieval_context.states,undefined);assert.equal(score.retrieval_context.evidence,undefined);store.close();
});

test('independent queries run concurrently while final score order remains stable',async()=>{
  const store=new Store(':memory:'),pipeline=new InlineMockGateway(),policy=new InlineMockGateway(),completionOrder=[];let active=0,maxActive=0;
  const answer={config:{provider:'live-test',model:'parallel-answer'},publicConfig(){return this.config},async completeJSON(component,input,validator){assert.equal(component,'judge');active++;maxActive=Math.max(maxActive,active);const delayMs={q1:60,q2:5,q3:15,q4:5}[input.question]||5;await new Promise(resolve=>setTimeout(resolve,delayMs));active--;completionOrder.push(input.question);const value=validator({answer:input.question});return{value,trace:{component,provider:'live-test',model:'parallel-answer',latency_ms:delayMs,token_input:1,token_output:1,mock:false}}}};
  const registry={pipelineOptions:()=>({gateway:pipeline}),assignmentSnapshot:()=>({global:pipeline.config,investigation_policy:policy.config,judge:answer.config,scoring_judge:answer.config}),gateway:component=>component==='judge'||component==='scoring_judge'?answer:policy},harness=new ExperimentHarness(store,undefined,registry),subject='parallel-query-test',items=['q1','q2','q3','q4'].map(id=>({score_id:id,task:'entity_exact_match',question:id,gold:[id],metadata:{visible_episode_ids:['session-1'],answer_contract:{language:'zh-CN',format:'brief'}}}));
  harness.adapters.synthetic_parallel={load:()=>({observations:[{subject_id:subject,source_type:'patient',episode_id:'session-1',turn_id:'1',event_time:'2024-01-01',raw_text:'患者存在一条可用于检索的记录。'}]}),cases:()=>items,normalizeAnswer:String,compatibleScore:(output,gold)=>({score:gold.includes(output)?1:0,is_correct:gold.includes(output),method:'synthetic'})};
  const done=await harness.start('synthetic_parallel',{query_concurrency:3,preprocess_concurrency:2}),scores=done.results.filter(item=>item.kind==='score');
  assert.equal(done.status,'completed');assert.equal(done.config.query_concurrency,3);assert.equal(done.progress.scoring_concurrency,3);assert.equal(maxActive,3);assert.notEqual(completionOrder[0],'q1');assert.deepEqual(scores.map(item=>item.score_id),['q1','q2','q3','q4']);store.close();
});

test('experiment summaries omit heavy per-query traces until detail is requested',()=>{
  const store=new Store(':memory:'),harness=new ExperimentHarness(store),now=new Date().toISOString(),score={kind:'score',score_id:'large',task:'adversarial',status:'scored',question:'Q',system_output:'A',gold:['A'],score:1,is_correct:true,retrieval_context:{large_trace:'hidden-in-summary'}};
  store.db.prepare(`INSERT INTO experiments(id,benchmark,status,config_json,progress_json,results_json,version_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`).run('summary','medlocomo','completed','{}','{}',JSON.stringify([score]),'{}',now,now);
  const view=harness.view('summary'),detail=harness.scoreResult('summary','large');assert.equal(Object.hasOwn(view.results[0],'retrieval_context'),false);assert.equal(detail.retrieval_context.large_trace,'hidden-in-summary');store.close();
});

test('wrong-answer export names unified Memory Graph artifacts, not State/Evidence layers',async()=>{
  const store=new Store(':memory:'),harness=new ExperimentHarness(store),subject='wrong-export';
  harness.adapters.synthetic={load:()=>({observations:[{subject_id:subject,source_type:'patient',episode_id:'session-1',turn_id:'1',event_time:'2024-01-01',raw_text:'患者记录目标事实。'}]}),cases:()=>[{score_id:'wrong',task:'entity_exact_match',question:'另一个事实是什么？',gold:['不存在答案'],metadata:{visible_episode_ids:['session-1'],answer_contract:{language:'zh-CN',format:'brief'}}}],normalizeAnswer:String,compatibleScore:()=>({score:0,is_correct:false,method:'synthetic'})};
  const done=await harness.start('synthetic',{}),exported=harness.wrongAnswerExport(done.id),serialized=JSON.stringify(exported);
  assert.equal(exported.wrong_answers.length,1);assert.ok(Array.isArray(exported.wrong_answers[0].related_memory_nodes));assert.equal(serialized.includes('retrieved_states'),false);assert.equal(serialized.includes('retrieved_evidence'),false);store.close();
});

class InlineMockGateway{
  constructor(){this.config={provider:'mock',model:'parallel-mock'}}
  publicConfig(){return this.config}
  async completeJSON(_component,input,validator,mockFactory){return{value:validator(await mockFactory(input)),trace:null}}
}
