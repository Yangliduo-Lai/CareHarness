import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.js';
import { ModelRegistry } from '../src/model-registry.js';
import { CareLifecycle } from '../src/lifecycle.js';

const item=(text,source_type,turn_id,extra={})=>({subject_id:'life-patient',source_type,episode_id:'session-1',turn_id:String(turn_id),event_time:'2026-01-01',raw_text:text,...extra});

test('memory build groups one Session and creates no conversation reply',async()=>{
  const store=new Store(':memory:'),life=new CareLifecycle(store,new ModelRegistry(store)),built=await life.buildMemory([item('既往记录：对青霉素过敏。','structured',0),item('我最近有时会恶心。','patient',1),item('建议下周复诊。','doctor',2)]);
  assert.equal(built.processed,1);assert.equal(built.source_observations,3);assert.equal(built.runs[0].phase,'memory_build');assert.equal(built.runs[0].final.response,null);
  assert.ok(built.memory_graph.nodes.length);assert.deepEqual(built.memory,built.memory_graph.nodes);assert.equal(built.runs[0].traces.some(trace=>trace.component==='action_policy'),false);store.close();
});

test('conversation commits Patient before Doctor feedback into the same Memory Graph',async()=>{
  const store=new Store(':memory:'),life=new CareLifecycle(store,new ModelRegistry(store));await life.buildMemory([item('建议下周复诊。','doctor',1)]);const result=await life.converse(item('我按时吃药了，但还是会恶心。','patient',2,{episode_id:'session-2'}));
  assert.equal(result.conversation.final.phase,'conversation');assert.ok(result.feedback);assert.deepEqual(result.writes.map(write=>[write.sequence,write.role,write.committed]),[[1,'patient',true],[2,'doctor',true]]);
  const written=store.db.prepare(`SELECT source_type FROM observations WHERE episode_id='session-2' ORDER BY rowid`).all();assert.deepEqual(written.map(row=>row.source_type),['patient','doctor']);assert.ok(result.memory_graph.nodes.some(node=>node.source_type==='doctor'));store.close();
});

test('pipeline stages use one extractor, family tagger, bounded relation classifier and graph updater',async()=>{
  const store=new Store(':memory:'),life=new CareLifecycle(store,new ModelRegistry(store));const built=await life.buildMemory([item('患者对青霉素过敏。','structured',1)]),names=built.runs[0].traces.map(trace=>trace.component);
  assert.deepEqual(names,['observation_ingest','memory_node_extractor','multi_family_tagger','memory_relation_classifier','memory_graph_updater','memory_commit']);
  for(const old of ['atomic_evidence_extractor','multi_label_router','patient_graph_updater','state_validity','updater_cs'])assert.equal(names.includes(old),false);
  assert.equal(built.runs[0].final.states,undefined);assert.equal(built.runs[0].final.evidence,undefined);store.close();
});

test('reset clears one patient Memory Graph while preserving audit Runs',async()=>{
  const store=new Store(':memory:'),life=new CareLifecycle(store,new ModelRegistry(store));await life.buildMemory([item('我有时恶心。','patient',1)]);const before=store.listRuns().length,result=await life.buildMemory([item('患者对青霉素过敏。','structured',2)],{reset_memory:true});
  assert.ok(result.cleared>0);assert.equal(store.memoryNodesFor('life-patient').some(node=>/恶心/.test(node.text)),false);assert.ok(store.listRuns().length>before);store.close();
});

test('Memory Graph subject index and deletion preserve Run history',async()=>{
  const store=new Store(':memory:'),life=new CareLifecycle(store,new ModelRegistry(store));await life.buildMemory([item('我有时恶心。','patient',1)]);await life.buildMemory([item('患者对青霉素过敏。','structured',1,{subject_id:'other-patient'})]);const runCount=store.listRuns().length;
  assert.deepEqual(new Set(store.memorySubjects().map(row=>row.subject_id)),new Set(['life-patient','other-patient']));assert.ok(store.clearMemory('other-patient')>0);assert.equal(store.listRuns().length,runCount);store.close();
});

test('Patient memory remains committed when response generation fails',async()=>{
  const store=new Store(':memory:'),registry=new ModelRegistry(store),broken=registry.save({name:'Broken generator',config:{provider:'openai-compatible',base_url:'https://provider.invalid/v1',model:'qwen'}});registry.assign({global:'offline-mock',generator:broken.id});const life=new CareLifecycle(store,registry),patient=item('我今天仍然恶心。','patient',3,{subject_id:'failure-patient',episode_id:'session-failure'});
  await assert.rejects(()=>life.converse(patient),error=>{assert.equal(error.publicError.write_progress.committed,true);assert.equal(error.publicError.write_progress.doctor_committed,false);return true;});
  assert.deepEqual(store.db.prepare(`SELECT source_type FROM observations WHERE subject_id='failure-patient' ORDER BY rowid`).all().map(row=>row.source_type),['patient']);assert.ok(store.memoryNodesFor('failure-patient').length);store.close();
});
