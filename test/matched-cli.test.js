import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCompleteCareHarnessRows,experimentScopes,parseArgs } from '../scripts/run-matched-medmemory.js';

test('MedMemory CLI defaults to exactly Persona 1 dev Clean',()=>{
  const args=parseArgs([]);
  assert.equal(args.dev_persona,1);
  assert.deepEqual(args.noise_modes,[false]);
  assert.deepEqual(experimentScopes(args),[
    {split:'dev',persona_id:1,noise:false}
  ]);
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
});

test('CLI reports only complete 97-query non-Mock reproducible results',()=>{
  const valid={split:'dev',noise:false,query_count:97,mock:false,reproducible:true,manifest_hash:'abc',score:0.5};
  assert.deepEqual(assertCompleteCareHarnessRows([valid]),[valid]);
  assert.throws(()=>assertCompleteCareHarnessRows([{...valid,query_count:96}]),/96\/97/);
  assert.throws(()=>assertCompleteCareHarnessRows([{...valid,mock:true}]),/Offline Mock/);
  assert.throws(()=>assertCompleteCareHarnessRows([{...valid,manifest_hash:null,reproducible:false}]),/reproducible frozen manifest/);
  assert.throws(()=>assertCompleteCareHarnessRows([{...valid,score:null}]),/numeric score/);
});
