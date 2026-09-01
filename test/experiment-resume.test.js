import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db.js';
import { ExperimentHarness,memoryScopeKey } from '../src/experiments.js';
import { ModelRegistry } from '../src/model-registry.js';
import { checkpointSourceCompatible,explicitDiagnosticResumePlan,memoryResumeStart,queryResumePlan } from '../src/experiment-resume.js';

test('memory resume starts after the last compatible contiguous Session',()=>{
  const current={memory_pipeline_version:'unified-memory-graph-v17-semantic-source-anchors',memory_scope_key:'scope-a',complete_through_session:40,status:'incomplete',observation_failed:59};
  assert.equal(memoryResumeStart(current,'scope-a',100),41);
  assert.equal(memoryResumeStart({...current,memory_scope_key:'old'},'scope-a',100),1);
  assert.equal(memoryResumeStart({...current,complete_through_session:100},'scope-a',100),1);
});

test('Memory Graph scope identity freezes the relation-classifier model as well as extraction models',()=>{
  const model=name=>({provider:'dashscope',model:name,temperature:0,max_tokens:1200}),base={persona_id:1,noise:false,resolved_models:{extractor:model('qwen3.7-flash'),router:model('qwen3.7-flash'),relation_classifier:model('qwen3.7-flash')}};
  assert.notEqual(memoryScopeKey(base),memoryScopeKey({...base,resolved_models:{...base.resolved_models,relation_classifier:model('another-model')}}));
});

test('a failed later suffix does not invalidate an earlier zero-failure checkpoint source',()=>{
  const experiment={benchmark:'medmemorybench',status:'partial',config:{persona_id:1,noise:false,memory_pipeline_version:'unified-memory-graph-v17-semantic-source-anchors',memory_scope_key:'scope-a'},progress:{failed:59}};
  assert.equal(checkpointSourceCompatible(experiment,{benchmark:'medmemorybench',config:{persona_id:1,noise:false},scopeKey:'scope-a'}),true);
  assert.equal(checkpointSourceCompatible(experiment,{benchmark:'medmemorybench',config:{persona_id:2,noise:false},scopeKey:'scope-a'}),false);
});

test('query resume reuses only complete infrastructure-valid results from the exact manifest',()=>{
  const hash='manifest-a',cases=[{score_id:'q1'},{score_id:'q2'},{score_id:'q3'}],base={kind:'score',status:'scored',score:1,is_correct:true,memory_incomplete:false,judge_infrastructure_failure:false,matched_manifest_hash:hash},experiments=[{id:'latest',benchmark:'medmemorybench',config:{score_only_current_memory:true,matched_manifest:{manifest_hash:hash}},results:[{...base,score_id:'q1'},{...base,score_id:'q2',score:0,is_correct:false,judge_infrastructure_failure:true}]},{id:'wrong-manifest',benchmark:'medmemorybench',config:{score_only_current_memory:true,matched_manifest:{manifest_hash:'other'}},results:[{...base,score_id:'q3'}]}];
  const plan=queryResumePlan(experiments,{benchmark:'medmemorybench',manifest:{manifest_hash:hash},cases});
  assert.deepEqual(plan.reusable_scores.map(item=>item.score_id),['q1']);
  assert.deepEqual(plan.pending_cases.map(item=>item.score_id),['q2','q3']);
  assert.deepEqual(plan.source_experiment_ids,['latest']);
});

test('explicit diagnostic resume reuses only valid scores from the identical graph and model configuration',()=>{
  const model={provider:'openai',base_url:'https://example.test/v1',model:'qwen3.5-flash',temperature:0,max_tokens:1200},models={global:model,investigation_policy:model,judge:model,scoring_judge:model},config={persona_id:7,noise:false,evaluation_mode:'persona7',memory_pipeline_version:'graph-v1',memory_scope_key:'scope-7',resolved_models:models},cases=[{score_id:'q1'},{score_id:'q2'},{score_id:'q3'}],valid={kind:'score',status:'scored',score:1,is_correct:true,memory_incomplete:false,judge_infrastructure_failure:false};
  const source={id:'source',benchmark:'medmemorybench',config:{...config,score_only_current_memory:true,current_memory_snapshot:{fingerprint:'graph-7'}},results:[{...valid,score_id:'q1'},{...valid,score_id:'q2',status:'failed',score:null,is_correct:null},{...valid,score_id:'q3',judge_infrastructure_failure:true}]};
  const plan=explicitDiagnosticResumePlan(source,{benchmark:'medmemorybench',config,cases,memorySnapshot:{fingerprint:'graph-7'}});
  assert.deepEqual(plan.reusable_scores.map(item=>item.score_id),['q1']);
  assert.deepEqual(plan.pending_cases.map(item=>item.score_id),['q2','q3']);
  assert.throws(()=>explicitDiagnosticResumePlan(source,{benchmark:'medmemorybench',config:{...config,resolved_models:{...models,judge:{...model,model:'different'}}},cases,memorySnapshot:{fingerprint:'graph-7'}}),/different Answer, Policy, or Judge models/);
  assert.throws(()=>explicitDiagnosticResumePlan(source,{benchmark:'medmemorybench',config,cases,memorySnapshot:{fingerprint:'other'}}),/different Memory Graph snapshot/);
});

test('answer-frozen query checkpoints persist locally until the Judge succeeds',()=>{
  const store=new Store(':memory:'),input={manifest_hash:'manifest-a',score_id:'q1',phase:'answer_frozen',payload:{result:{status:'answer_frozen',system_output:'已生成答案'}},experiment_id:'exp-1'};
  store.saveQueryPhaseCheckpoint(input);assert.equal(store.getQueryPhaseCheckpoint(input).payload.result.system_output,'已生成答案');
  store.saveQueryPhaseCheckpoint({...input,payload:{result:{status:'answer_frozen',system_output:'更新答案'}},experiment_id:'exp-2'});assert.equal(store.getQueryPhaseCheckpoint(input).experiment_id,'exp-2');
  assert.equal(store.deleteQueryPhaseCheckpoint(input),1);assert.equal(store.getQueryPhaseCheckpoint(input),null);store.close();
});

test('a later suffix can restore a complete prefix checkpoint from a partial experiment',async()=>{
  const root=mkdtempSync(join(tmpdir(),'careharness-resume-')),dir=join(root,'MedMemoryBench','data','MedMemoryBench','persona_1','eval');mkdirSync(dir,{recursive:true});
  const session=id=>({session_id:id,event_info:{date:`2024-01-0${id}`},turn_count:2,messages:[{role:'user',turn:1,content:`第 ${id} 次患者记录。`},{role:'assistant',turn:1,content:`第 ${id} 次医生记录。`}]});
  writeFileSync(join(dir,'generated_dialogues.json'),JSON.stringify({sessions:[session(1),session(2)]}));writeFileSync(join(dir,'generated_queries.json'),JSON.stringify({queries:[]}));
  const store=new Store(':memory:'),models=new ModelRegistry(store),harness=new ExperimentHarness(store,root,models);
  try{
    const first=await harness.start('medmemorybench',{persona_id:1,start_session:1,max_session:1,query_type:'__memory_build_only__',preprocess_concurrency:1});assert.equal(first.status,'completed');
    const brokenProgress={...first.progress,phase:'finished',failed:1,memory_build_completeness:{...first.progress.memory_build_completeness,memory_incomplete:true,failed_observation_count:1}};store.db.prepare(`UPDATE experiments SET status='partial',progress_json=? WHERE id=?`).run(JSON.stringify(brokenProgress),first.id);
    const resumed=await harness.start('medmemorybench',{persona_id:1,start_session:2,max_session:2,query_type:'__memory_build_only__',preprocess_concurrency:1});assert.equal(resumed.status,'completed');assert.equal(resumed.progress.reused_through_session,1);assert.equal(resumed.progress.completed,1);assert.equal(resumed.progress.total,1);assert.equal(store.memoryScope('medmemory-persona-1-clean').complete_through_session,2);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
