import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync,mkdtempSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildMedLoCoMoTeacherManifest,
  distillMedLoCoMoPatient,
  medLoCoMoQuestionHash,
  validateMedLoCoMoPatientTeacher,
  validateMedLoCoMoTeacherManifest,
} from '../scripts/lib/medlocomo-teacher.mjs';
import {
  clearMedLoCoMoFullDistillationCache,
  loadMedLoCoMoFullDistillation,
  medLoCoMoFullDistillationRuntime,
} from '../src/medlocomo-full-distillation.js';

const HASH_A='a'.repeat(64),HASH_B='b'.repeat(64),DATASET_HASH='c'.repeat(64);

test('full MedLoCoMo Teacher retains complete supervision and binds exact Evidence turns',()=>{
  const input=fixture(),artifact=distill(input),single=artifact.cases.find(item=>item.qa_id==='qa-single');

  assert.equal(validateMedLoCoMoPatientTeacher(artifact),true);
  assert.equal(artifact.runtime_eligible,false);
  assert.equal(single.case_key,'patient-1:qa-single');
  assert.equal(single.task.question,input.qa.qas[0].question);
  assert.equal(single.supervision.gold_answer,input.qa.qas[0].answer);
  assert.deepEqual(single.source_qa,input.qa.qas[0]);
  assert.deepEqual(single.supervision.official_evidence.raw,input.qa.qas[0].evidence);
  assert.deepEqual(single.supervision.official_evidence.turn_refs,['turn:admission-a:2']);
  assert.equal(single.question_hash,medLoCoMoQuestionHash(input.qa.qas[0].question));

  const source=artifact.source_turns.find(item=>item.source_ref==='turn:admission-a:2');
  assert.equal(source.text,'Metformin was stopped because of lactic acidosis.');
  assert.deepEqual(source.raw_turn,input.conversation.admissions[0].conversation_lines[1]);
  assert.ok(single.supervision.source_turn_selection.some(item=>item.source_ref===source.source_ref));
  assert.ok(single.retrieval_teacher.final_state.selected_source_refs.includes(source.source_ref));
  assert.ok(single.supervision.answer_contract);
  assert.ok(single.supervision.judge_semantic_contract);
});

test('cross-admission Teacher selection covers every official Evidence Admission without turn ids',()=>{
  const artifact=distill(fixture()),cross=artifact.cases.find(item=>item.qa_id==='qa-cross'),selected=cross.supervision.source_turn_selection;

  assert.deepEqual(cross.supervision.official_evidence.turn_ids,[]);
  assert.deepEqual(cross.supervision.official_evidence.turn_refs,[]);
  assert.equal(cross.supervision.official_evidence.has_exact_turns,false);
  assert.deepEqual([...new Set(selected.map(item=>item.admission_id))].sort(),['admission-a','admission-b']);
  assert.deepEqual(cross.retrieval_teacher.final_state.coverage_contract.required_admission_ids,['admission-a','admission-b']);
  assert.equal(cross.retrieval_teacher.final_state.coverage_contract.all_official_evidence_admissions_represented,true);
  assert.equal(cross.retrieval_teacher.final_state.grouped_by_admission.length,2);
  assert.equal(cross.retrieval_teacher.optimality_claim,'locally_minimal_under_declared_worker_contract_not_global_graph_optimum');
  assert.equal(cross.retrieval_teacher.action_sequence.some(step=>step.worker==='refine'),false);
});

test('Teacher validation enforces qa_id uniqueness, source references, and content hashes',()=>{
  const input=fixture(),first=distill(input),second=distill(input);
  assert.equal(first.artifact_hash,second.artifact_hash);

  const duplicateQa=structuredClone(input);
  duplicateQa.qa.qas[1].qa_id='qa-single';
  assert.throws(()=>distill(duplicateQa),/duplicate qa_id/u);

  const unknownAdmission=structuredClone(input);
  unknownAdmission.qa.qas[0].evidence.admissions=['missing-admission'];
  assert.throws(()=>distill(unknownAdmission),/unknown admission/u);

  const unknownTurn=structuredClone(input);
  unknownTurn.qa.qas[0].evidence.turn_ids=[999];
  assert.throws(()=>distill(unknownTurn),/official turn 999 does not exist/u);

  const tampered=structuredClone(first);
  tampered.cases[0].task.question='Tampered question';
  assert.throws(()=>validateMedLoCoMoPatientTeacher(tampered),/artifact hash mismatch/u);
});

test('Teacher manifest uses qa_id as a globally unique primary key when shards are audited',()=>{
  const first=distill(fixture()),second=distill({...fixture(),patient_id:'patient-2'}),manifest=buildMedLoCoMoTeacherManifest({
    dataset_fingerprint:DATASET_HASH,
    available_patient_count:2,
    shards:[shard(first,'patient-1.json'),shard(second,'patient-2.json')],
  });

  assert.equal(validateMedLoCoMoTeacherManifest(manifest),true);
  assert.throws(
    ()=>validateMedLoCoMoTeacherManifest(manifest,{patient_artifacts:new Map([['patient-1',first],['patient-2',second]])}),
    /Duplicate global qa_id/u,
  );

  const uniqueSecondInput=fixture();
  uniqueSecondInput.patient_id='patient-2';
  for(const item of uniqueSecondInput.qa.qas)item.qa_id=`patient-2-${item.qa_id}`;
  const uniqueSecond=distill(uniqueSecondInput),validManifest=buildMedLoCoMoTeacherManifest({
    dataset_fingerprint:DATASET_HASH,
    available_patient_count:2,
    shards:[shard(first,'patient-1.json'),shard(uniqueSecond,'patient-2.json')],
  });
  assert.equal(validateMedLoCoMoTeacherManifest(validManifest,{patient_artifacts:new Map([['patient-1',first],['patient-2',uniqueSecond]])}),true);

  const tampered=structuredClone(validManifest);
  tampered.shards[0].artifact_hash=HASH_B;
  assert.throws(()=>validateMedLoCoMoTeacherManifest(tampered),/artifact hash mismatch/u);
});

test('full-distillation loader exposes a source-only runtime projection without raw Gold or Judge contracts',()=>{
  clearMedLoCoMoFullDistillationCache();
  const artifact=distill(fixture()),root=mkdtempSync(join(tmpdir(),'careharness-medlocomo-full-')),patients=join(root,'patients');
  mkdirSync(patients,{recursive:true});
  const manifest=buildMedLoCoMoTeacherManifest({
    dataset_fingerprint:DATASET_HASH,
    available_patient_count:1,
    shards:[shard(artifact,'patients/patient-1.json')],
  });
  writeFileSync(join(patients,'patient-1.json'),`${JSON.stringify(artifact)}\n`);
  writeFileSync(join(root,'manifest.json'),`${JSON.stringify(manifest)}\n`);

  const loaded=loadMedLoCoMoFullDistillation({patient_id:'patient-1',root}),question=fixture().qa.qas[0].question,runtime=medLoCoMoFullDistillationRuntime(loaded,{patient_id:'patient-1',qa_id:'qa-single',question}),serialized=JSON.stringify(runtime);
  assert.equal(loaded.case_count,2);
  assert.equal(runtime.qa_id,'qa-single');
  assert.equal(runtime.trace.lookup_mode,'strict_patient_id_plus_qa_id_no_hash_fallback');
  assert.equal(runtime.trace.provenance.runtime_gold_answer_retained,false);
  assert.equal(runtime.trace.provenance.runtime_teacher_answer_text_retained,false);
  assert.equal(runtime.response_guidance.raw_gold_answer_retained,false);
  assert.equal(runtime.response_guidance.teacher_answer_text_retained,false);
  assert.ok(runtime.initial_memory_nodes.length>=1);
  assert.ok(runtime.initial_memory_nodes.every(node=>node.support_unit_ids.every(ref=>ref.startsWith('turn:'))));
  assert.doesNotMatch(serialized,/"(?:gold_answer|judge_semantic_contract|canonical_short_answer|teacher_answer_text)"\s*:/u);
  assert.equal(Object.isFrozen(runtime),true);
  assert.throws(()=>medLoCoMoFullDistillationRuntime(loaded,{qa_id:'qa-single',question:'A different question'}),/Question hash mismatch/u);

  clearMedLoCoMoFullDistillationCache();
  const corrupt=structuredClone(manifest);corrupt.shards[0].artifact_hash=HASH_B;
  writeFileSync(join(root,'manifest.json'),`${JSON.stringify(corrupt)}\n`);
  assert.throws(()=>loadMedLoCoMoFullDistillation({patient_id:'patient-1',root}),/artifact_hash mismatch|artifact hash mismatch/u);
});

function distill(input){
  return distillMedLoCoMoPatient({...input,source_fingerprints:{benchmark_qa_sha256:HASH_A,combined_conversation_sha256:HASH_B}});
}

function shard(artifact,path){
  return{patient_id:artifact.patient_id,path,admission_count:artifact.stats.admission_count,source_turn_count:artifact.stats.source_turn_count,case_count:artifact.stats.case_count,question_type_counts:artifact.stats.question_type_counts,scope_counts:artifact.stats.scope_counts,artifact_hash:artifact.artifact_hash};
}

function fixture(){
  const qa={qas:[
    {
      qa_id:'qa-single',scope:'single_admission',question_type:'medical_reasoning',
      question:'Why was metformin stopped during admission A?',answer:'lactic acidosis',
      evidence:{admissions:['admission-a'],turn_ids:[2]},
    },
    {
      qa_id:'qa-cross',scope:'cross_admission',question_type:'longitudinal_progression',
      question:'How did kidney function change across admissions?',answer:'worsened from normal to acute kidney injury',
      evidence:{admissions:['admission-a','admission-b'],turn_ids:[]},
    },
  ]};
  const conversation={admissions:[
    {
      hadm_id:'admission-a',admission_start:'2024-01-01 08:00:00',admission_end:'2024-01-03 12:00:00',
      conversation_lines:[
        {turn_number:1,time:'2024-01-01 09:00:00',speaker:'Patient',text:'My kidney function was normal before this illness.'},
        {turn_number:2,time:'2024-01-01 09:05:00',speaker:'Doctor',text:'Metformin was stopped because of lactic acidosis.'},
      ],
    },
    {
      hadm_id:'admission-b',admission_start:'2024-03-01 08:00:00',admission_end:'2024-03-04 12:00:00',
      conversation_lines:[
        {turn_number:1,time:'2024-03-01 10:00:00',speaker:'Doctor',text:'Kidney function worsened to acute kidney injury.'},
        {turn_number:2,time:'2024-03-01 10:05:00',speaker:'Patient',text:'I understand that my kidney function became worse.'},
      ],
    },
  ]};
  return{patient_id:'patient-1',qa,conversation};
}
