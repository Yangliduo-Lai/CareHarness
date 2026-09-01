import test from 'node:test';
import assert from 'node:assert/strict';
import { assertNoHiddenBenchmarkInput } from '../src/information-boundary.js';
import { MEDMEMORY_BUILTIN_STUDENT_ARTIFACT,classifyMedMemoryQuery,fallbackMedMemoryQueryClassification,medMemoryStrategyProfileHash,medMemoryStudentPolicyFor,medMemoryStudentPolicyManifest,renderMedMemoryStudentPolicyArtifactModule,resolveMedMemoryRuntimeTasks,validateMedMemoryQueryClassification,validateMedMemoryStudentArtifact,withMedMemoryStudentPolicy } from '../src/medmemory-policy.js';

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

test('question-only classifier has one generic fallback for every public query type',()=>{
  const examples={
    entity_exact_match:'医生怀疑是哪类药物出现药效减弱？',
    temporal_localization:'患者在2025-02-03次日测得的指标是多少？',
    state_update:'患者之前体重约65kg，最近一次体重是多少？',
    multiple_choice:'以下哪些正确？\nA. 选项一\nB. 选项二',
    inference_generation:'医生，我现在要不要调整用药？',
    multi_hop_clinical_deduction:'请综合分析多次复查之间的因果关系。'
  };
  for(const[type,question]of Object.entries(examples))assert.equal(fallbackMedMemoryQueryClassification(question).query_type,type,question);
  assert.throws(()=>validateMedMemoryQueryClassification({query_type:'unknown',confidence:.5,rationale:'无效'}),/Unknown MedMemory query type/u);
});

test('LLM classifier receives the question only and never receives the official type',async()=>{
  let seen=null;const gateway={config:{provider:'live-test'},async completeJSON(component,input,validator){seen={component,input};return{value:validator({query_type:'state_update',confidence:.91,rationale:'询问最新状态。'}),trace:{component,token_input:8,token_output:4,latency_ms:1,mock:false}};}};
  const result=await classifyMedMemoryQuery('患者当前状态是什么？',gateway);
  assert.deepEqual(seen,{component:'medmemory_query_classifier',input:{question:'患者当前状态是什么？'}});assert.equal(result.query_type,'state_update');assert.equal(result.method,'llm_question_only');assert.equal(JSON.stringify(seen).includes('official_query_type'),false);
});

test('a classifier error may change retrieval but never changes the official Answer Prompt task',()=>{
  assert.deepEqual(resolveMedMemoryRuntimeTasks('multi_hop_clinical_deduction',{query_type:'inference_generation'}),{retrieval_task:'inference_generation',answer_task:'multi_hop_clinical_deduction',routing_mode:'classified'});
  assert.deepEqual(resolveMedMemoryRuntimeTasks('entity_exact_match',null),{retrieval_task:'entity_exact_match',answer_task:'entity_exact_match',routing_mode:'classified'});
  assert.deepEqual(resolveMedMemoryRuntimeTasks('multi_hop_clinical_deduction',{query_type:'inference_generation'},{routing_mode:'official_oracle_diagnostic'}),{retrieval_task:'multi_hop_clinical_deduction',answer_task:'multi_hop_clinical_deduction',routing_mode:'official_oracle_diagnostic'});
});
