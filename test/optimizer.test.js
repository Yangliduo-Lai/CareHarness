import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.js';
import { evaluatePatchAcceptance,runOptimizationRound,selectOptimizationTarget } from '../src/optimizer.js';

const metrics=(average,overrides={})=>({split:'heldout',average_score:average,query_count:100,failed_query_count:0,mock_query_count:0,details_accessed:false,...overrides});

test('optimizer chooses exactly one highest-frequency H component',()=>{
  assert.deepEqual(selectOptimizationTarget({counts:{H1:2,H3:5,M3:9}}),{target_code:'H3',count:5,component:'search/refine',axis:'harness',source_split:'dev'});
});

test('acceptance uses only a strict held-out average improvement after integrity checks',()=>{
  const accepted=evaluatePatchAcceptance({before:metrics(.4),after:metrics(.5)});
  assert.equal(accepted.accepted,true);
  const tied=evaluatePatchAcceptance({before:metrics(.4),after:metrics(.4)});
  assert.equal(tied.accepted,false);assert.ok(tied.failed_checks.includes('heldout_average_improves'));
  const invalid=evaluatePatchAcceptance({before:metrics(.4),after:metrics(.5,{query_count:99})});
  assert.equal(invalid.accepted,false);assert.ok(invalid.failed_checks.includes('complete_same_scope'));
});

test('optimization round automatically reverts and records its full ledger',async()=>{
  const store=new Store(':memory:');let applied=false,reverted=false;
  const round=await runOptimizationRound({store,manifest:{manifest_hash:'manifest-1'},target:{target_code:'H3',component:'search/refine',source_split:'dev',count:3},patch:{component:'search/refine',components:['search/refine'],design_split:'dev',description:'raise lexical threshold',minimal_reproduction_test:'search-recall-q1',diff:'one component diff'},measureBefore:async()=>metrics(.4),applyPatch:async()=>{applied=true},runFullTests:async()=>({passed:true,summary:'all pass'}),runTargetedEval:async()=>({metrics:metrics(.4),taxonomy_before:{H3:3},taxonomy_after:{H3:2}}),revertPatch:async()=>{reverted=true}});
  assert.equal(applied,true);assert.equal(reverted,true);assert.equal(round.status,'reverted');assert.equal(round.training_performed,false);assert.equal(store.getOptimizationRound(round.id).decision.decision,'reverted');store.close();
});
