import test from'node:test';
import assert from'node:assert/strict';
import{mkdtempSync,writeFileSync}from'node:fs';
import{join}from'node:path';
import{tmpdir}from'node:os';
import{MEDLOCOMO_PATIENT_DISTILLATION_VERSION,loadMedLoCoMoPatientDistillation,medLoCoMoPatientDistilledMemory,medLoCoMoQuestionHash}from'../src/medlocomo-patient-distillation.js';

test('same-patient MedLoCoMo distillation exposes source turns without retaining teacher answers',()=>{
  const question='Why was the treatment stopped?',hash=medLoCoMoQuestionHash(question),dir=mkdtempSync(join(tmpdir(),'careharness-distill-')),path=join(dir,'artifact.json'),artifact={version:MEDLOCOMO_PATIENT_DISTILLATION_VERSION,patient_id:'p1',training_scope:'same_patient_same_questions_oracle_diagnostic',not_held_out:true,official_evidence_used:true,gold_used_for_source_selection:true,gold_answer_text_retained:false,question_text_retained:false,artifact_hash:'test',records:[{question_hash:hash,question_type:'medical_reasoning',scope:'single_admission',source_turns:[{admission_id:'a1',turn_number:2,time:'2024-01-02 10:00:00',speaker:'Doctor',text:'The treatment was stopped after the adverse reaction.'}]}]};
  writeFileSync(path,JSON.stringify(artifact));
  const loaded=loadMedLoCoMoPatientDistillation({patient_id:'p1',path}),memory=medLoCoMoPatientDistilledMemory(loaded,question),serialized=JSON.stringify(memory);
  assert.equal(memory.source_turn_count,1);assert.equal(memory.memory_nodes[0].episode_id,'a1');assert.equal(memory.memory_nodes[0].source_text,'The treatment was stopped after the adverse reaction.');assert.equal(memory.gold_answer_text_retained,false);assert.doesNotMatch(serialized,/"answer"\s*:|must stay hidden/iu);assert.equal(medLoCoMoPatientDistilledMemory(loaded,'Different question'),null);
});

test('same-patient distillation refuses artifacts without explicit oracle provenance',()=>{
  const dir=mkdtempSync(join(tmpdir(),'careharness-distill-')),path=join(dir,'artifact.json');writeFileSync(path,JSON.stringify({version:MEDLOCOMO_PATIENT_DISTILLATION_VERSION,patient_id:'p1',official_evidence_used:false,gold_used_for_source_selection:false,gold_answer_text_retained:false,records:[]}));assert.throws(()=>loadMedLoCoMoPatientDistillation({patient_id:'p1',path}),/oracle training provenance/);
});
