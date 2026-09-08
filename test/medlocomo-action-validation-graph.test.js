import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MEDLOCOMO_VALIDATION_EMBEDDING_CONTRACT,buildMedLoCoMoSourceLiteralActionGraph,loadMedLoCoMoValidationGraphs,medLoCoMoValidationRuntimeStatus } from '../src/medlocomo-action-validation-graph.js';

test('production validation graph loader is read-only, active-only and reconstructs Admission/Turn refs',()=>{
  const path=join(mkdtempSync(join(tmpdir(),'careharness-action-graph-')),'graph.sqlite'),db=new DatabaseSync(path);
  db.exec(`CREATE TABLE memory_nodes(subject_id TEXT,payload_json TEXT); CREATE TABLE memory_edges(subject_id TEXT,payload_json TEXT);`);
  const active={memory_id:'m1',subject_id:'medlocomo-7',episode_id:'admission-3',turn_id:'turn_09',status:'active',text:'fact'},conflict={memory_id:'m2',subject_id:'medlocomo-7',episode_id:'admission-3',turn_id:'10',status:'conflict',text:'old'},edge={edge_id:'e1',from_memory_id:'m1',to_memory_id:'m2',status:'verified'};
  db.prepare('INSERT INTO memory_nodes VALUES(?,?)').run('medlocomo-7',JSON.stringify(active));db.prepare('INSERT INTO memory_nodes VALUES(?,?)').run('medlocomo-7',JSON.stringify(conflict));db.prepare('INSERT INTO memory_edges VALUES(?,?)').run('medlocomo-7',JSON.stringify(edge));db.close();
  const graph=loadMedLoCoMoValidationGraphs(path,['7']).get('7');assert.equal(graph.source,'frozen_production_sqlite');assert.deepEqual(graph.nodes.map(node=>node.memory_id),['m1']);assert.deepEqual(graph.edges,[]);assert.equal(graph.refByMemory.get('m1'),'turn:admission-3:9');assert.match(graph.fingerprint,/^[a-f0-9]{64}$/u);
});

test('diagnostic source projection emits one unique node per source Turn and no invented edges',()=>{
  const turn={source_ref:'turn:a:1',admission_id:'a',turn_number:1,time:'2120-01-01',speaker:'Doctor',text:'hello'},graph=buildMedLoCoMoSourceLiteralActionGraph({source_turns:[turn]});
  assert.equal(graph.nodes.length,1);assert.equal(graph.nodeById.size,1);assert.deepEqual(graph.edges,[]);assert.equal(graph.refByMemory.get(graph.nodes[0].memory_id),'turn:a:1');
  assert.throws(()=>buildMedLoCoMoSourceLiteralActionGraph({source_turns:[turn,{...turn,text:'duplicate'}]}),/Duplicate MedLoCoMo source Turn memory_id/);
});

test('runtime parity requires successful execution, not merely configured callbacks',()=>{
  const status=(stats,contract=MEDLOCOMO_VALIDATION_EMBEDDING_CONTRACT)=>medLoCoMoValidationRuntimeStatus({has_production_graph:true,stats,embedding_contract:contract}),expected=(embedding,pairwise,contract)=>({production_embedding_selector_used:embedding,production_pairwise_ranker_used:pairwise,embedding_runtime_contract_matched:contract,runtime_environment_parity:embedding&&pairwise});
  assert.deepEqual(status({...runtimeStats(),embedding_completed:2,embedding_failed:1}),expected(false,true,true));
  assert.deepEqual(status({...runtimeStats(),pairwise_applied:2}),expected(true,false,true));
  assert.deepEqual(status(runtimeStats()),expected(true,true,true));
  assert.deepEqual(status(runtimeStats(),{...MEDLOCOMO_VALIDATION_EMBEDDING_CONTRACT,model_revision:'unpinned'}),expected(false,true,false));
  assert.deepEqual(status({...runtimeStats(),embedding_observed_model_revisions:['unpinned']}),expected(false,true,false));
  assert.deepEqual(status({...runtimeStats(),embedding_observed_snapshot_hashes:['0'.repeat(64)]}),expected(false,true,false));
  assert.deepEqual(status(runtimeStats(),{...MEDLOCOMO_VALIDATION_EMBEDDING_CONTRACT,snapshot_file_hashes:{...MEDLOCOMO_VALIDATION_EMBEDDING_CONTRACT.snapshot_file_hashes,'config.json':'0'.repeat(64)}}),expected(false,true,false));
});

function runtimeStats(){return{embedding_expected_dimensions:384,embedding_observed_dimensions:[384],embedding_observed_providers:['local'],embedding_observed_models:['Xenova/all-MiniLM-L6-v2'],embedding_observed_model_revisions:['751bff37182d3f1213fa05d7196b954e230abad9'],embedding_observed_model_revision_verifications:['local_snapshot_sha256'],embedding_observed_base_models:['sentence-transformers/all-MiniLM-L6-v2'],embedding_observed_base_model_revisions:['1110a243fdf4706b3f48f1d95db1a4f5529b4d41'],embedding_observed_snapshot_hashes:[MEDLOCOMO_VALIDATION_EMBEDDING_CONTRACT.snapshot_hash],embedding_observed_snapshot_file_hash_commitments:[createHash('sha256').update(stable(MEDLOCOMO_VALIDATION_EMBEDDING_CONTRACT.snapshot_file_hashes)).digest('hex')],embedding_observed_normalized:[true],embedding_observed_chunk_turn_counts:[6],embedding_attempted:3,embedding_completed:3,embedding_failed:0,pairwise_attempted:3,pairwise_applied:3,pairwise_failed:0};}
function stable(value){if(Array.isArray(value))return`[${value.map(stable).join(',')}]`;if(value&&typeof value==='object')return`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;return JSON.stringify(value);}

test('v1 to v2 literal migration proves coverage against the independent teacher Turn set',()=>{
  const path=join(mkdtempSync(join(tmpdir(),'careharness-action-migration-')),'graph.sqlite'),db=new DatabaseSync(path),subject='medlocomo-7',observation={observation_id:'o1',subject_id:subject,source_type:'structured',episode_id:'a',turn_id:'session',event_time:'2120-01-01 09:00:00',raw_text:'[Turn=1][Role=Doctor][Time=2120-01-01 09:00:00]\nHow are you?\n\n[Turn=2][Role=Patient][Time=2120-01-01 09:01:00]\nBetter today.'},semantic={memory_id:'m1',observation_id:'o1',subject_id:subject,episode_id:'a',turn_id:'2',event_time:'2120-01-01 09:01:00',source_type:'patient',status:'active',text:'The patient feels better.'};
  db.exec(`CREATE TABLE memory_nodes(run_id TEXT,subject_id TEXT,payload_json TEXT); CREATE TABLE memory_edges(subject_id TEXT,payload_json TEXT); CREATE TABLE observations(run_id TEXT,subject_id TEXT,payload_json TEXT); CREATE TABLE experiments(benchmark TEXT,config_json TEXT,updated_at TEXT);`);
  db.prepare('INSERT INTO memory_nodes VALUES(?,?,?)').run('r1',subject,JSON.stringify(semantic));db.prepare('INSERT INTO observations VALUES(?,?,?)').run('r1',subject,JSON.stringify(observation));db.prepare('INSERT INTO experiments VALUES(?,?,?)').run('medlocomo',JSON.stringify({patient_id:'7',medlocomo_memory_completeness_version:'medlocomo-admission-node-completeness-v1'}),'2120-01-02');db.close();
  const options={migrate_literal_provenance:true,expected_turn_refs_by_patient:new Map([['7',['turn:a:1','turn:a:2']]])},graph=loadMedLoCoMoValidationGraphs(path,['7'],options).get('7');
  assert.equal(graph.source,'frozen_production_sqlite_v1_plus_deterministic_v2_literal_migration');assert.equal(graph.literal_migration.added_literal_node_count,2);assert.equal(graph.literal_migration.all_nonempty_turns_retrievable,true);assert.equal(graph.refByMemory.size,3);
  const mismatch=loadMedLoCoMoValidationGraphs(path,['7'],{...options,expected_turn_refs_by_patient:new Map([['7',['turn:a:1','turn:a:2','turn:a:3']]])}).get('7');assert.equal(mismatch.literal_migration.all_nonempty_turns_retrievable,false);assert.equal(mismatch.literal_migration.missing_expected_turn_ref_count,1);
});
