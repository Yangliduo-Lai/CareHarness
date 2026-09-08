import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MedLoCoMoHierarchicalTrainer,
  evaluateMedLoCoMoHierarchicalPolicy,
  evidenceTopology,
  queryOperation,
  splitCommitment,
  validateMedLoCoMoHierarchicalPolicy,
  withHierarchicalEvaluation,
} from '../scripts/lib/medlocomo-hierarchical-policy.mjs';

test('hierarchical MedLoCoMo distillation is patient-disjoint, deterministic, and case-free',()=>{
  const first=patient('train-a','lactic acidosis explained the medication change'),second=patient('train-b','lactic acidosis was the documented complication'),holdout=patient('holdout-c','lactic acidosis prompted clinicians to stop it');
  const compile=artifacts=>{
    const trainer=new MedLoCoMoHierarchicalTrainer({minimum_query_patient_support:2,minimum_pair_patient_support:2,minimum_pair_case_support:2});
    for(const artifact of artifacts)trainer.observeVocabularyPatient(artifact);trainer.sealVocabulary();
    for(const artifact of artifacts)trainer.observeTrainingPatient(artifact);
    return trainer.finalize({split:{holdout_patient_count:1,train_set_commitment:splitCommitment(['train-a','train-b']),holdout_set_commitment:splitCommitment(['holdout-c'])}});
  };
  const forward=compile([first,second]),reverse=compile([second,first]);
  assert.equal(forward.model_hash,reverse.model_hash);
  assert.equal(forward.runtime_eligible,false);
  assert.equal(validateMedLoCoMoHierarchicalPolicy(forward),true);
  assert.equal(forward.split.train_patient_count,2);
  assert.equal(forward.split.train_case_count,4);
  assert.equal(forward.boundary.retains_case_lookup,false);
  assert.ok(forward.admission_router.association_edge_count>0);
  assert.ok(forward.dynamic_action_prior.transition_count>0);
  assert.equal(forward.dynamic_action_prior.states['single_admission:causal_explanation:local_pair:target_covered_counterpart_missing'].actions[0].action_role,'retrieve_counterpart');
  const cell=forward.policy_cells['medical_reasoning:single_admission:causal_explanation:local_pair'];
  assert.deepEqual(cell.action_blueprint,['locate_scope','retrieve_target','expand_local_context','retrieve_counterpart','verify_relation','answer']);
  const serialized=JSON.stringify(forward);
  assert.doesNotMatch(serialized,/train-a|train-b|holdout-c|qa-train|turn:|Why was metformin stopped|lactic acidosis explained/iu);

  const evaluation=evaluateMedLoCoMoHierarchicalPolicy(forward,[holdout]);
  assert.equal(evaluation.groups.__all__.case_count,2);
  assert.equal(evaluation.groups.__all__.student.official_exact_turn.case_count,2);
  const evaluated=withHierarchicalEvaluation(forward,evaluation);
  assert.equal(evaluated.model_hash,forward.model_hash);
  assert.match(evaluated.report_hash,/^[a-f0-9]{64}$/u);
  assert.equal(evaluated.validation_evaluation.groups.__all__.student.official_admission_recall,1);

  const leaked=structuredClone(forward);leaked.qa_id='qa-leak';
  assert.throws(()=>validateMedLoCoMoHierarchicalPolicy(leaked),/forbidden field qa_id/u);
});

test('query operation and evidence topology are finer than the six public task labels',()=>{
  assert.equal(queryOperation('medical_reasoning','Why did renal function worsen?'),'causal_explanation');
  assert.equal(queryOperation('medical_reasoning','What complication developed?'),'direct_fact');
  assert.equal(queryOperation('frequency_pattern','How many times was dialysis performed?'),'count_occurrences');
  assert.equal(queryOperation('frequency_pattern','Which diagnosis was most frequent?'),'frequency_extremum');
  assert.equal(queryOperation('care_plan_rationale','Why was insulin discontinued?'),'treatment_change_reason');
  assert.equal(queryOperation('longitudinal_progression','What condition eventually developed?'),'endpoint_outcome');
  assert.equal(evidenceTopology('care_plan_rationale','plan_rationale'),'local_pair');
  assert.equal(evidenceTopology('cross_admission_comparison','aligned_comparison'),'parallel_sides');
});

function patient(patientId,positiveText){
  const admissionId=`admission-${patientId}`,otherAdmissionId=`other-${patientId}`,sourceRef=`turn:${admissionId}:1`,otherSourceRef=`turn:${otherAdmissionId}:1`,question='Why was metformin stopped?',qaId=`qa-${patientId}`;
  return{
    benchmark:'medlocomo',patient_id:patientId,
    admissions:[
      {admission_id:admissionId,admission_order:1,admission_start:'2024-01-01 00:00:00',admission_end:'2024-01-02 00:00:00',source_turn_refs:[sourceRef]},
      {admission_id:otherAdmissionId,admission_order:2,admission_start:'2024-02-01 00:00:00',admission_end:'2024-02-02 00:00:00',source_turn_refs:[otherSourceRef]},
    ],
    source_turns:[
      {source_ref:sourceRef,admission_id:admissionId,admission_order:1,turn_number:1,text:`Metformin was stopped; ${positiveText}.`},
      {source_ref:otherSourceRef,admission_id:otherAdmissionId,admission_order:2,turn_number:1,text:'A chest radiograph documented pneumonia.'},
    ],
    cases:[{
      qa_id:qaId,task:{question_type:'medical_reasoning',scope:'single_admission',question},
      supervision:{gold_answer:'lactic acidosis',official_evidence:{admission_ids:[admissionId],turn_refs:[sourceRef]},source_turn_selection:[{source_ref:sourceRef,selection_basis:'official_evidence_turn'}],required_numbers:[],required_relations:[{relation:'clinical_explanation_for'}],traps:[{type:'event_without_explanation'}],answer_contract:{target_kind:'clinical_explanation'}},
      retrieval_teacher:{hard_negatives:[],final_state:{selected_source_refs:[sourceRef]}},
    },{
      qa_id:`qa-imaging-${patientId}`,task:{question_type:'medical_reasoning',scope:'single_admission',question:'What imaging finding was documented?'},
      supervision:{gold_answer:'pneumonia',official_evidence:{admission_ids:[otherAdmissionId],turn_refs:[otherSourceRef]},source_turn_selection:[{source_ref:otherSourceRef,selection_basis:'official_evidence_turn'}],required_numbers:[],required_relations:[],traps:[],answer_contract:{target_kind:'clinical_fact'}},
      retrieval_teacher:{hard_negatives:[],final_state:{selected_source_refs:[otherSourceRef]}},
    }],
  };
}
