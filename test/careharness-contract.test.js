import test from 'node:test';
import assert from 'node:assert/strict';
import { CAREHARNESS_ACTIONS,CAREHARNESS_METHOD_CONTRACT,CAREHARNESS_RUNTIME_CONTROLS,CAREHARNESS_STATE_FAMILIES,validateCareHarnessMethodContract } from '../src/careharness-contract.js';

test('frozen method contract has exact State, control, action, and claim boundaries',()=>{
  assert.deepEqual(Object.keys(CAREHARNESS_STATE_FAMILIES),['BC','PE','PA','CS','CP','LO']);
  assert.deepEqual(CAREHARNESS_RUNTIME_CONTROLS,['scope','time','relation']);
  assert.deepEqual(CAREHARNESS_ACTIONS,['focus','trace','connect','evaluate','verify','answer']);
  assert.equal(CAREHARNESS_METHOD_CONTRACT.policy.fixed_six_step_sequence,false);
  assert.equal(Object.hasOwn(CAREHARNESS_METHOD_CONTRACT,'decision_gates'),false);
  assert.equal(CAREHARNESS_METHOD_CONTRACT.architecture_claims.persistent_cross_state_graph,true);
  assert.equal(CAREHARNESS_METHOD_CONTRACT.architecture_claims.strict_causality_claimed,false);
  assert.equal(CAREHARNESS_METHOD_CONTRACT.architecture_claims.learned_runtime_policy,false);
  assert.strictEqual(validateCareHarnessMethodContract(),CAREHARNESS_METHOD_CONTRACT);
});

test('method contract validator requires the Patient Graph and rejects strict causality',()=>{
  assert.throws(()=>validateCareHarnessMethodContract({...CAREHARNESS_METHOD_CONTRACT,architecture_claims:{...CAREHARNESS_METHOD_CONTRACT.architecture_claims,persistent_cross_state_graph:false}}),/requires a persistent/);
  assert.throws(()=>validateCareHarnessMethodContract({...CAREHARNESS_METHOD_CONTRACT,architecture_claims:{...CAREHARNESS_METHOD_CONTRACT.architecture_claims,strict_causality_claimed:true}}),/strict causality/);
});
