import test from 'node:test';
import assert from 'node:assert/strict';
import { CAREHARNESS_MEMORY_FAMILIES,CAREHARNESS_METHOD_CONTRACT,validateCareHarnessMethodContract } from '../src/careharness-contract.js';

test('method contract freezes the new question, memory, investigation, and answer boundaries',()=>{
  assert.deepEqual(Object.keys(CAREHARNESS_MEMORY_FAMILIES),['BC','PE','PA','CS','CP','LO']);
  assert.equal(CAREHARNESS_METHOD_CONTRACT.memory.representation,'single_atomic_versioned_memory_graph');
  assert.equal(CAREHARNESS_METHOD_CONTRACT.memory.node_representation,'source_anchored_semantic_state');
  assert.equal(CAREHARNESS_METHOD_CONTRACT.memory.duplicate_fact_layers,false);
  assert.equal(CAREHARNESS_METHOD_CONTRACT.memory.coverage_role,'bounded_complete-unit_fallback_only');
  assert.equal(CAREHARNESS_METHOD_CONTRACT.memory.session_membership,'episode_hyperedge_metadata');
  assert.equal(CAREHARNESS_METHOD_CONTRACT.memory.co_observed_is_reasoning_edge,false);
  assert.equal(CAREHARNESS_METHOD_CONTRACT.question_boundary.representation,'verbatim_question_plus_public_task_strategy');
  assert.equal(CAREHARNESS_METHOD_CONTRACT.question_boundary.public_task_label_allowed,true);
  assert.equal(CAREHARNESS_METHOD_CONTRACT.question_boundary.task_strategy_contains_case_content,false);
  assert.equal(CAREHARNESS_METHOD_CONTRACT.question_boundary.static_query_analysis,false);
  for(const key of ['generated_keywords','generated_family_priorities','generated_time_constraints','generated_relation_targets','generated_node_slots'])assert.equal(CAREHARNESS_METHOD_CONTRACT.question_boundary[key],false,key);
  assert.equal(CAREHARNESS_METHOD_CONTRACT.investigation.representation,'policy_owned_closed_loop');
  assert.equal(CAREHARNESS_METHOD_CONTRACT.investigation.worker_registry,'extensible_capability_descriptors');
  assert.equal(CAREHARNESS_METHOD_CONTRACT.investigation.decision_strategy,'smallest_unresolved_aspect_then_reassess');
  assert.equal(CAREHARNESS_METHOD_CONTRACT.investigation.fixed_worker_sequence,false);
  assert.equal(CAREHARNESS_METHOD_CONTRACT.investigation.policy_reassesses_after_every_result,true);
  assert.equal(CAREHARNESS_METHOD_CONTRACT.policy.decision_model,'configured_investigation_policy_model');
  assert.equal(CAREHARNESS_METHOD_CONTRACT.policy.implementation,'llm_guided_transparent_type_adaptive_closed_loop');
  assert.equal(CAREHARNESS_METHOD_CONTRACT.answer_boundary.receives_frozen_investigation_information,true);
  assert.strictEqual(validateCareHarnessMethodContract(),CAREHARNESS_METHOD_CONTRACT);
});

test('contract validator rejects reintroducing static query analysis or duplicate fact layers',()=>{
  assert.throws(()=>validateCareHarnessMethodContract({...CAREHARNESS_METHOD_CONTRACT,question_boundary:{...CAREHARNESS_METHOD_CONTRACT.question_boundary,generated_node_slots:true}}),/generated_node_slots/);
  assert.throws(()=>validateCareHarnessMethodContract({...CAREHARNESS_METHOD_CONTRACT,memory:{...CAREHARNESS_METHOD_CONTRACT.memory,duplicate_fact_layers:true}}),/source-anchored semantic graph/);
});
