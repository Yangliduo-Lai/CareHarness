import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCompleteCareHarnessRows,experimentScopes,parseArgs } from '../scripts/run-matched-medmemory.js';

test('MedMemory CLI defaults to exactly Persona 1 dev Clean',()=>{
  const args=parseArgs([]);
  assert.equal(args.persona,1);assert.equal(args.split,'dev');
  assert.deepEqual(args.query_types,[]);
  assert.deepEqual(args.noise_modes,[false]);
  assert.equal(args.investigation_budget,6);
  assert.equal(args.query_concurrency,4);
  assert.equal(args.action_policy_values,null);
  assert.equal(args.action_exploration_rate,0);assert.equal(args.action_exploration_seed,0);
  assert.equal(args.prepare_snapshots,false);assert.equal(args.force_rebuild,false);
  assert.deepEqual(experimentScopes(args),[
    {split:'dev',persona_id:1,noise:false}
  ]);
});

test('MedMemory CLI can explicitly rebuild a snapshot from Session 1',()=>{
  const args=parseArgs(['--prepare-snapshots','--force-rebuild']);
  assert.equal(args.prepare_snapshots,true);assert.equal(args.force_rebuild,true);
  assert.throws(()=>parseArgs(['--force-rebuild']),/requires --prepare-snapshots/);
});

test('Persona 1 dev accepts a reproducible comma-separated query-type subset',()=>{
  const args=parseArgs(['--query-types','inference_generation,multi_hop_clinical_deduction,multiple_choice']);
  assert.deepEqual(args.query_types,['multiple_choice','inference_generation','multi_hop_clinical_deduction']);
  assert.deepEqual(experimentScopes(args),[{split:'dev',persona_id:1,noise:false,query_types:['multiple_choice','inference_generation','multi_hop_clinical_deduction']}]);
});

test('Noise scopes require an explicit CLI flag and remain on the dev Persona',()=>{
  const args=parseArgs(['--noise','both']);
  assert.deepEqual(experimentScopes(args),[
    {split:'dev',persona_id:1,noise:false},
    {split:'dev',persona_id:1,noise:true}
  ]);
});

test('MedMemory CLI rejects ambiguous or incomplete scope arguments',()=>{
  assert.throws(()=>parseArgs(['--noise','typo']),/clean, noise, or both/);
  assert.throws(()=>parseArgs(['--extra-scope']),/Unknown argument/);
  assert.throws(()=>parseArgs(['--output','--noise','clean']),/requires a value/);
  assert.throws(()=>parseArgs(['--split','test']),/dev or heldout/);
  assert.throws(()=>parseArgs(['--query-types','unknown']),/MedMemoryBench types/);
  assert.throws(()=>parseArgs(['--query-types','inference_generation,inference_generation']),/duplicates/);
  assert.throws(()=>parseArgs(['--query-types','inference_generation,']),/non-empty comma-separated/);
  assert.throws(()=>parseArgs(['--split','heldout','--query-types','inference_generation']),/Persona 1 dev/);
  assert.throws(()=>parseArgs(['--persona','2','--query-types','inference_generation']),/Persona 1 dev/);
  assert.throws(()=>parseArgs(['--action-budget','6']),/Unknown argument/);
  assert.equal(parseArgs(['--action-policy-values','data/policy.json']).action_policy_values,'data/policy.json');
  assert.equal(parseArgs(['--action-exploration-rate','1','--action-exploration-seed','9']).action_exploration_seed,9);
  assert.throws(()=>parseArgs(['--action-exploration-rate','1.1']),/between 0 and 1/);
  assert.throws(()=>parseArgs(['--persona','2','--action-exploration-rate','1']),/training-only/);
  assert.equal(parseArgs(['--query-concurrency','8']).query_concurrency,8);
  assert.throws(()=>parseArgs(['--query-concurrency','17']),/between 1 and 16/);
});

test('CLI reports only complete adapter-scope non-Mock reproducible results',()=>{
  const valid={split:'heldout',noise:false,query_count:100,query_types:[],strict_full_suite:true,mock:false,reproducible:true,manifest_hash:'abc',score:0.5},scopes=[{query_count:100,query_types:[]}];
  assert.deepEqual(assertCompleteCareHarnessRows([valid],scopes),[valid]);
  assert.throws(()=>assertCompleteCareHarnessRows([{...valid,query_count:99}],scopes),/99\/100/);
  assert.throws(()=>assertCompleteCareHarnessRows([{...valid,mock:true}],scopes),/Offline Mock/);
  assert.throws(()=>assertCompleteCareHarnessRows([{...valid,manifest_hash:null,reproducible:false}],scopes),/reproducible frozen manifest/);
  assert.throws(()=>assertCompleteCareHarnessRows([{...valid,strict_full_suite:false}],scopes),/strict complete query scope/);
  assert.throws(()=>assertCompleteCareHarnessRows([{...valid,query_types:['inference_generation']}],scopes),/does not match preflight/);
  assert.throws(()=>assertCompleteCareHarnessRows([{...valid,score:null}],scopes),/numeric score/);
});

test('held-out scope is explicitly labeled and uses the selected Persona',()=>{
  const args=parseArgs(['--persona','2','--split','heldout']);
  assert.deepEqual(experimentScopes(args),[{split:'heldout',persona_id:2,noise:false}]);
});
