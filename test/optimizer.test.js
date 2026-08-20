import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.js';
import { evaluatePatchAcceptance,runOptimizationRound,selectOptimizationTarget } from '../src/optimizer.js';

const metrics=(dev,overrides={})=>({dev_score:dev,ig_score:.5,mcd_score:.5,safety_score:1,average_action_cost:3,...overrides});

test('optimizer chooses exactly one highest-frequency H component',()=>{
  assert.deepEqual(selectOptimizationTarget({counts:{H1:2,H3:5,M3:9}}),{target_code:'H3',count:5,component:'focus',axis:'harness',source_split:'dev'});
});

test('acceptance gates require dev improvement without IG, MCD, safety, or cost regression',()=>{
  const accepted=evaluatePatchAcceptance({before:metrics(.4),after:metrics(.5),action_cost_budget:4});
  assert.equal(accepted.accepted,true);
  const rejected=evaluatePatchAcceptance({before:metrics(.4),after:metrics(.5,{mcd_score:.4}),action_cost_budget:4});
  assert.equal(rejected.accepted,false);assert.ok(rejected.failed_checks.includes('mcd_non_degrading'));
});

test('optimization round automatically reverts and records its full ledger',async()=>{
  const store=new Store(':memory:');let applied=false,reverted=false;
  const round=await runOptimizationRound({store,manifest:{manifest_hash:'manifest-1'},target:{target_code:'H3',component:'focus',source_split:'dev',count:3},patch:{component:'focus',components:['focus'],design_split:'dev',description:'raise lexical threshold',minimal_reproduction_test:'focus-recall-q1',diff:'one component diff'},measureBefore:async()=>metrics(.4),applyPatch:async()=>{applied=true},runFullTests:async()=>({passed:true,summary:'all pass'}),runTargetedEval:async()=>({metrics:metrics(.5,{mcd_score:.4}),taxonomy_before:{H3:3},taxonomy_after:{H3:2}}),revertPatch:async()=>{reverted=true},acceptance:{action_cost_budget:4}});
  assert.equal(applied,true);assert.equal(reverted,true);assert.equal(round.status,'reverted');assert.equal(round.training_performed,false);assert.equal(store.getOptimizationRound(round.id).decision.decision,'reverted');store.close();
});
