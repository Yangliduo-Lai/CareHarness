import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/db.js';
import { Pipeline,pipelineInternals } from '../src/pipeline.js';

const observation=(text,episode,event_time)=>({subject_id:'graph-patient',source_type:'patient',episode_id:episode,turn_id:'1',event_time,raw_text:text});

test('one Patient Graph stores six-family typed nodes and conservative cross-state candidates',async()=>{
  const store=new Store(':memory:'),pipeline=new Pipeline(store);
  const result=await pipeline.run(observation('我正在服用二甲双胍。','session-1','2025-01-01'),{phase:'memory_build'}),graph=store.patientGraphFor('graph-patient');
  assert.equal(result.traces.filter(item=>item.component==='patient_graph_updater').length,1);
  assert.ok(graph.nodes.some(node=>node.family==='PE'));assert.ok(graph.nodes.some(node=>node.family==='CS'));
  assert.ok(graph.nodes.every(node=>node.factor_key&&Array.isArray(node.factor_domains)));
  const shared=graph.edges.find(edge=>edge.edge_family==='clinical_care');
  assert.equal(shared.status,'candidate');assert.equal(shared.verified,false);assert.equal(shared.support_kind,'hypothesized');assert.equal(shared.causal_claim,false);
  store.close();
});

test('factor domains stay orthogonal to the six node families',()=>{
  const make=(text,evidence_id,families)=>({id:evidence_id,evidence_id,subject_id:'graph-patient',source_type:'patient',episode_id:'session-1',source_session_id:'session-1',turn_id:'1',event_time:'2025-01-01',text,certainty:1,polarity:'affirmed',families}),medical=pipelineInternals.updatePatientGraph([make('患者既往有糖尿病病史。','e-medical',['BC'])],[],[],{subject_id:'graph-patient'}).nodes[0],work=pipelineInternals.updatePatientGraph([make('患者因工作费用压力缺少家庭支持。','e-social',['BC'])],[],[],{subject_id:'graph-patient'}).nodes[0],adherence=pipelineInternals.updatePatientGraph([make('患者经常漏服二甲双胍。','e-behavior',['PE'])],[],[],{subject_id:'graph-patient'}).nodes[0];
  assert.ok(medical.factor_domains.includes('biological'));assert.ok(work.factor_domains.includes('social'));assert.ok(adherence.factor_domains.includes('behavioral'));assert.deepEqual(new Set([medical.family,work.family,adherence.family]),new Set(['BC','PE']));
});

test('version transitions are persistent verified temporal edges and checkpoints restore nodes plus edges',async()=>{
  const store=new Store(':memory:'),pipeline=new Pipeline(store);
  await pipeline.run(observation('我正在服用二甲双胍。','session-1','2025-01-01'),{phase:'memory_build'});
  await pipeline.run(observation('我已经停用二甲双胍。','session-2','2025-02-01'),{phase:'memory_build'});
  const before=structuredClone(store.patientGraphFor('graph-patient')),temporal=before.edges.filter(edge=>edge.edge_family==='temporal');
  assert.ok(temporal.length>=2);assert.ok(temporal.every(edge=>edge.status==='verified'&&edge.support_kind==='structural'&&edge.persistent===true));
  store.saveMemoryCheckpoint({benchmark:'test',subject_id:'graph-patient',scope_key:'graph-v13',session_no:2,prefix_hash:'prefix',experiment_id:'test-experiment'});
  const checkpoint=store.getMemoryCheckpoint({benchmark:'test',subject_id:'graph-patient',scope_key:'graph-v13',session_no:2,prefix_hash:'prefix'});
  assert.equal(checkpoint.edges.length,before.edges.length);store.clearMemory('graph-patient');assert.equal(store.patientGraphFor('graph-patient').nodes.length,0);
  const restored=store.restoreMemoryCheckpoint(checkpoint),after=store.patientGraphFor('graph-patient');
  assert.equal(restored.restored,before.nodes.length);assert.equal(restored.restored_edges,before.edges.length);assert.deepEqual(after.nodes,before.nodes);assert.deepEqual(after.edges,before.edges);store.close();
});

test('legacy states table migrates losslessly into canonical Patient Graph nodes',()=>{
  const directory=mkdtempSync(join(tmpdir(),'careharness-graph-migration-')),path=join(directory,'legacy.sqlite'),legacy=new DatabaseSync(path),state={state_id:'legacy-state',subject_id:'legacy-patient',family:'CS',value:'患者血糖偏高。',status:'active',version:1,version_chain:[],evidence_ids:['legacy-evidence']};
  legacy.exec(`CREATE TABLE runs(id TEXT PRIMARY KEY,subject_id TEXT NOT NULL,dataset TEXT NOT NULL,status TEXT NOT NULL,branch_kind TEXT NOT NULL,seed INTEGER NOT NULL,config_json TEXT NOT NULL,version_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,final_json TEXT,error_json TEXT);CREATE TABLE states(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,subject_id TEXT NOT NULL,family TEXT NOT NULL,status TEXT NOT NULL,version INTEGER NOT NULL,payload_json TEXT NOT NULL);`);
  legacy.prepare(`INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run('legacy-run','legacy-patient','core','completed','formal',42,'{}','{}','2025-01-01','2025-01-01',null,null);legacy.prepare(`INSERT INTO states VALUES(?,?,?,?,?,?,?)`).run(state.state_id,'legacy-run',state.subject_id,state.family,state.status,state.version,JSON.stringify(state));legacy.close();
  const store=new Store(path);assert.deepEqual(store.graphNodesFor('legacy-patient'),[state]);assert.equal(store.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='states'`).get(),undefined);store.close();rmSync(directory,{recursive:true,force:true});
});

test('backfilled events remain historical and cannot replace a later current fact',()=>{
  const route=(text,event_time,evidence_id)=>({id:evidence_id,evidence_id,subject_id:'graph-patient',source_type:'patient',episode_id:event_time==='2025-03-01'?'session-3':'session-1',source_session_id:event_time==='2025-03-01'?'session-3':'session-1',turn_id:'1',event_time,text,certainty:1,polarity:'affirmed',families:['CS']});
  const latest=pipelineInternals.updatePatientGraph([route('患者空腹血糖为 9。','2025-03-01','e-latest')],[],[],{subject_id:'graph-patient'}),backfill=pipelineInternals.updatePatientGraph([route('患者空腹血糖为 7。','2025-01-01','e-backfill')],latest.nodes,latest.edges,{subject_id:'graph-patient'}),current=pipelineInternals.currentMemory([...latest.nodes,...backfill.nodes]);
  assert.equal(backfill.nodes[0].version,2);assert.equal(backfill.nodes[0].operation,'ADD');assert.equal(current.length,1);assert.match(current[0].value,/9/);assert.equal(current[0].event_time,'2025-03-01');
});

test('an event inserted between two versions records both immediate chronological transitions',()=>{
  const route=(text,event_time,evidence_id)=>({id:evidence_id,evidence_id,subject_id:'graph-patient',source_type:'patient',episode_id:`session-${Number(event_time.slice(8,10))}`,source_session_id:`session-${Number(event_time.slice(8,10))}`,turn_id:'1',event_time,text,certainty:1,polarity:'affirmed',families:['CS']});let nodes=[],edges=[];
  for(const item of [['患者空腹血糖为 7。','2025-01-01','e-jan'],['患者空腹血糖为 9。','2025-03-03','e-mar'],['患者空腹血糖为 8。','2025-02-02','e-feb']]){const update=pipelineInternals.updatePatientGraph([route(...item)],nodes,edges,{subject_id:'graph-patient'});nodes.push(...update.nodes);edges.push(...update.edges);}
  const byTime=new Map(nodes.map(node=>[node.event_time,node.state_id])),hasUpdate=(from,to)=>edges.some(edge=>edge.edge_family==='temporal'&&edge.relation_type==='updates'&&edge.from_state_id===byTime.get(from)&&edge.to_state_id===byTime.get(to));
  assert.equal(hasUpdate('2025-01-01','2025-02-02'),true);assert.equal(hasUpdate('2025-02-02','2025-03-03'),true);
});

test('a repeated same-factor fact records persistence instead of inventing an update',()=>{
  const route=(evidence_id,episode_id)=>({id:evidence_id,evidence_id,subject_id:'graph-patient',source_type:'patient',episode_id,source_session_id:episode_id,turn_id:'1',event_time:episode_id==='session-1'?'2025-01-01':'2025-02-01',text:'患者空腹血糖为 7。',certainty:1,polarity:'affirmed',families:['CS']});
  const first=pipelineInternals.updatePatientGraph([route('e-1','session-1')],[],[],{subject_id:'graph-patient'}),second=pipelineInternals.updatePatientGraph([route('e-2','session-2')],first.nodes,first.edges,{subject_id:'graph-patient'});
  assert.equal(second.nodes[0].operation,'NOOP');assert.equal(second.edges.length,1);assert.equal(second.edges[0].edge_family,'temporal');assert.equal(second.edges[0].relation_type,'persists');assert.equal(second.edges[0].status,'verified');
});

test('a changed quantitative result remains in one factor chain but is an update, not persistence',()=>{
  const route=(evidence_id,text,event_time)=>({id:evidence_id,evidence_id,subject_id:'graph-patient',source_type:'structured',episode_id:evidence_id,source_session_id:evidence_id,turn_id:'1',event_time,text,certainty:1,polarity:'affirmed',families:['CS']});
  const first=pipelineInternals.updatePatientGraph([route('e-glucose-6','患者空腹血糖为 6。','2025-01-01')],[],[],{subject_id:'graph-patient'}),second=pipelineInternals.updatePatientGraph([route('e-glucose-9','患者空腹血糖为 9。','2025-02-01')],first.nodes,first.edges,{subject_id:'graph-patient'});
  assert.equal(first.nodes[0].factor_key,second.nodes[0].factor_key);assert.equal(second.nodes[0].operation,'UPDATE');assert.equal(second.edges.length,1);assert.equal(second.edges[0].relation_type,'updates');
});

test('a changed medication dose is an update, not a no-op',()=>{
  const route=(evidence_id,text,event_time)=>({id:evidence_id,evidence_id,subject_id:'graph-patient',source_type:'patient',episode_id:evidence_id,source_session_id:evidence_id,turn_id:'1',event_time,text,certainty:1,polarity:'affirmed',families:['CS']});
  const first=pipelineInternals.updatePatientGraph([route('e-dose-500','患者目前正在服用二甲双胍 500 mg。','2025-01-01')],[],[],{subject_id:'graph-patient'}),second=pipelineInternals.updatePatientGraph([route('e-dose-1000','患者目前正在服用二甲双胍 1000 mg。','2025-02-01')],first.nodes,first.edges,{subject_id:'graph-patient'});
  assert.equal(first.nodes[0].factor_key,second.nodes[0].factor_key);assert.equal(second.nodes[0].operation,'UPDATE');assert.equal(second.edges.length,1);assert.equal(second.edges[0].relation_type,'updates');
});

test('a repeated conflicting assertion remains conflicted with the original opposing node',()=>{
  const route=(evidence_id,text,source_type,polarity,event_time)=>({id:evidence_id,evidence_id,subject_id:'graph-patient',source_type,episode_id:evidence_id,source_session_id:evidence_id,turn_id:'1',event_time,text,certainty:1,polarity,families:['CS']});
  const affirmed=pipelineInternals.updatePatientGraph([route('e-taking','患者正在服用二甲双胍。','patient','affirmed','2025-01-01')],[],[],{subject_id:'graph-patient'}),negated=pipelineInternals.updatePatientGraph([route('e-not-taking','患者没有服用二甲双胍。','doctor','negated','2025-02-01')],affirmed.nodes,affirmed.edges,{subject_id:'graph-patient'}),repeated=pipelineInternals.updatePatientGraph([route('e-not-taking-repeat','患者没有服用二甲双胍。','doctor','negated','2025-03-01')],[...affirmed.nodes,...negated.nodes],[...affirmed.edges,...negated.edges],{subject_id:'graph-patient'});
  assert.equal(negated.nodes[0].operation,'CONFLICT');assert.equal(negated.nodes[0].conflicts_with,affirmed.nodes[0].state_id);
  assert.equal(repeated.nodes[0].operation,'CONFLICT');assert.equal(repeated.nodes[0].status,'conflict');assert.equal(repeated.nodes[0].predecessor_state_id,negated.nodes[0].state_id);assert.equal(repeated.nodes[0].conflicts_with,affirmed.nodes[0].state_id);
  assert.equal(repeated.edges.length,1);assert.equal(repeated.edges[0].relation_type,'conflicts');assert.equal(repeated.edges[0].from_state_id,repeated.nodes[0].state_id);assert.equal(repeated.edges[0].to_state_id,affirmed.nodes[0].state_id);
});

test('optimistic graph revision rejects a stale concurrent version calculation',async()=>{
  const store=new Store(':memory:'),outer=new Pipeline(store),competing=new Pipeline(store);let injected=false;
  await assert.rejects(()=>outer.run(observation('我正在服用二甲双胍。','session-1','2025-01-01'),{phase:'memory_build',breakpoint:async({traces})=>{if(!injected&&traces.at(-1)?.component==='patient_graph_updater'){injected=true;await competing.run(observation('我已经停用二甲双胍。','session-2','2025-02-01'),{phase:'memory_build'});}}}),/changed concurrently/);
  const graph=store.patientGraphFor('graph-patient');assert.ok(graph.nodes.length>0);assert.ok(graph.nodes.every(node=>node.episode_id==='session-2'));assert.equal(store.listRuns().filter(run=>run.status==='failed').length,1);store.close();
});

test('monotonic graph revision rejects clear-and-rebuild ABA with the same graph size',async()=>{
  const store=new Store(':memory:'),seed=new Pipeline(store),outer=new Pipeline(store),competing=new Pipeline(store);await seed.run(observation('我正在服用二甲双胍。','session-1','2025-01-01'),{phase:'memory_build'});const before=store.graphRevisionFor('graph-patient');let injected=false;
  await assert.rejects(()=>outer.run(observation('我的空腹血糖为 8。','session-3','2025-03-01'),{phase:'memory_build',breakpoint:async({traces})=>{if(!injected&&traces.at(-1)?.component==='patient_graph_updater'){injected=true;store.clearMemory('graph-patient');await competing.run(observation('我已经停用二甲双胍。','session-2','2025-02-01'),{phase:'memory_build'});}}}),/changed concurrently/);
  assert.notEqual(store.graphRevisionFor('graph-patient'),before);assert.ok(store.patientGraphFor('graph-patient').nodes.every(node=>node.episode_id==='session-2'));store.close();
});

test('checkpoint restore validates every patient binding before deleting the current graph',async()=>{
  const store=new Store(':memory:'),pipeline=new Pipeline(store);await pipeline.run(observation('我正在服用二甲双胍。','session-1','2025-01-01'),{phase:'memory_build'});store.saveMemoryCheckpoint({benchmark:'test',subject_id:'graph-patient',scope_key:'tamper-check',session_no:1,prefix_hash:'prefix',experiment_id:'test-experiment'});const checkpoint=store.getMemoryCheckpoint({benchmark:'test',subject_id:'graph-patient',scope_key:'tamper-check',session_no:1,prefix_hash:'prefix'}),before=structuredClone(store.patientGraphFor('graph-patient'));checkpoint.states[0].state.subject_id='other-patient';assert.throws(()=>store.restoreMemoryCheckpoint(checkpoint),/cross-patient/);assert.deepEqual(store.patientGraphFor('graph-patient'),before);store.close();
});
