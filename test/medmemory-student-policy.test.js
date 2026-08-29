import test from 'node:test';
import assert from 'node:assert/strict';
import { assertNoHiddenBenchmarkInput } from '../src/information-boundary.js';
import { MEDMEMORY_BUILTIN_STUDENT_ARTIFACT } from '../src/medmemory-student-policy-artifact.js';
import { medMemoryStrategyProfileHash,medMemoryStudentPolicyFor,medMemoryStudentPolicyManifest,renderMedMemoryStudentPolicyArtifactModule,validateMedMemoryStudentArtifact,withMedMemoryStudentPolicy } from '../src/medmemory-student-policy.js';

test('built-in MedMemory Student is hash-bound, case-free, and available without reports',()=>{
  const student=validateMedMemoryStudentArtifact(MEDMEMORY_BUILTIN_STUDENT_ARTIFACT),manifest=medMemoryStudentPolicyManifest(),prior=medMemoryStudentPolicyFor('inference_generation'),serialized=JSON.stringify(prior);
  assert.equal(manifest.status,'loaded_builtin');assert.equal(manifest.strategy_profiles.content_hash,medMemoryStrategyProfileHash());assert.equal(manifest.student_artifact.artifact_hash,student.artifact_hash);assert.equal(manifest.source_teacher_artifact.artifact_hash,student.source_teacher_hash);assert.equal(manifest.compiled_strategy.profile_hash,manifest.strategy_profiles.content_hash);assert.equal(manifest.runtime_overlap.gold_answers,false);assert.equal(manifest.runtime_overlap.judge_metadata,false);assert.equal(manifest.runtime_overlap.patient_facts,false);assert.equal(manifest.components.worker_set_version,'careharness-investigation-workers.v5-source-separated-relations');assert.match(manifest.components.matched_runtime_version,/careharness-investigation-runtime/u);
  assert.equal(prior.query_type,'inference_generation');assert.equal(prior.student_artifact_hash,student.artifact_hash);assert.ok(prior.aggregate_prior.recommended_action_paths.length);assert.ok(prior.aggregate_prior.decision_check_priors.length);assert.equal(serialized.includes('source_teacher_hash'),false);assert.equal(serialized.includes('training_scope'),false);assert.doesNotThrow(()=>assertNoHiddenBenchmarkInput(prior));
});

test('runtime decorator supplies only the selected public-type aggregate',()=>{
  const input={question:'任意问题',allowed_workers:['search']},decorated=withMedMemoryStudentPolicy(input,'multiple_choice');assert.equal(input.offline_student_prior,undefined);assert.equal(decorated.offline_student_prior.query_type,'multiple_choice');assert.deepEqual(Object.keys(decorated.offline_student_prior).sort(),['aggregate_prior','query_type','student_artifact_hash','version']);assert.equal(medMemoryStudentPolicyFor('unknown'),null);assert.equal(medMemoryStudentPolicyManifest(null).status,'not_loaded');
});

test('Student validation rejects tampering and runtime profile drift',()=>{
  const tampered=JSON.parse(JSON.stringify(MEDMEMORY_BUILTIN_STUDENT_ARTIFACT));tampered.query_types.inference_generation.case_count+=1;assert.throws(()=>validateMedMemoryStudentArtifact(tampered),/hash mismatch/u);
  const extra=JSON.parse(JSON.stringify(MEDMEMORY_BUILTIN_STUDENT_ARTIFACT));extra.query_types.multiple_choice.case_text='hidden';assert.throws(()=>validateMedMemoryStudentArtifact(extra),/forbidden field/u);
  const drift=JSON.parse(JSON.stringify(MEDMEMORY_BUILTIN_STUDENT_ARTIFACT));drift.compiled_strategy_profile_hash='f'.repeat(64);assert.throws(()=>validateMedMemoryStudentArtifact(drift),/profiles do not match runtime/u);
});

test('compiled artifact module is deterministic and contains aggregate data only',()=>{
  const left=renderMedMemoryStudentPolicyArtifactModule(MEDMEMORY_BUILTIN_STUDENT_ARTIFACT),right=renderMedMemoryStudentPolicyArtifactModule(MEDMEMORY_BUILTIN_STUDENT_ARTIFACT);assert.equal(left,right);for(const forbidden of['source_key_points','required_patient_info','common_wrong_answer','reasoning_chain','query_id','persona_ids','source_session_ids'])assert.equal(left.includes(`"${forbidden}"`),false);
});
