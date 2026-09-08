import { MEDLOCOMO_POLICY_DISTILLATION_ARTIFACT } from './medlocomo-policy-artifact.js';

export const MEDLOCOMO_POLICY_NAMESPACE='medlocomo';
export const MEDLOCOMO_POLICY_QUESTION_TYPES=Object.freeze(['medical_reasoning','care_plan_rationale','longitudinal_progression','cross_admission_comparison','frequency_pattern','adversarial']);

validateArtifact(MEDLOCOMO_POLICY_DISTILLATION_ARTIFACT);
export const MEDLOCOMO_POLICY_DISTILLATION=deepFreeze(structuredClone(MEDLOCOMO_POLICY_DISTILLATION_ARTIFACT));
export const MEDLOCOMO_POLICY_DISTILLATION_VERSION=MEDLOCOMO_POLICY_DISTILLATION.version;
export const MEDLOCOMO_POLICY_DISTILLATION_HASH=MEDLOCOMO_POLICY_DISTILLATION.artifact_hash;
export const MEDLOCOMO_STUDENT_POLICY_RUNTIME_VERSION='medlocomo-student-policy.runtime.v2-compact-cell';
export const MEDLOCOMO_ANSWERABILITY_POLICY=deepFreeze(buildAnswerabilityPolicy(MEDLOCOMO_POLICY_DISTILLATION));

export function medLoCoMoPolicyRecommendation(task){
  const value=MEDLOCOMO_POLICY_DISTILLATION.recommendations[String(task||'')];
  return value?structuredClone(value):null;
}

export function medLoCoMoStudentPolicyFor(task,{scope='unknown',question=''}={}){
  const type=String(task||''),student=MEDLOCOMO_POLICY_DISTILLATION.student_policy,typeSummary=student?.question_types?.[type];
  if(!typeSummary)return null;
  const queryShape=medLoCoMoQueryShape(type,question),cellKey=`${String(scope||'unknown')}:${queryShape}`,cell=typeSummary.cells?.[cellKey]||typeSummary.default;
  return structuredClone({version:MEDLOCOMO_STUDENT_POLICY_RUNTIME_VERSION,query_type:type,scope:String(scope||'unknown'),query_shape:queryShape,student_artifact_hash:MEDLOCOMO_POLICY_DISTILLATION_HASH,matched_cell:compactStudentCell(cellKey,cell)});
}

export function withMedLoCoMoStudentPolicy(input,task,context={}){
  const prior=medLoCoMoStudentPolicyFor(task,context);
  return prior?{...input,medlocomo_student_prior:prior}:input;
}

export function medLoCoMoAnswerFormPrior(task,context={}){
  const prior=medLoCoMoStudentPolicyFor(task,context),cell=prior?.matched_cell;
  if(!cell)return null;
  return{version:prior.version,query_type:prior.query_type,scope:prior.scope,query_shape:prior.query_shape,case_count:cell.case_count,typical_word_count:cell.answer_words?.median??null,p90_word_count:cell.answer_words?.p90??null,answer_shape_rates:cell.answer_shape_rates||{}};
}

function buildAnswerabilityPolicy(artifact){
  const ordinaryTypes=MEDLOCOMO_POLICY_QUESTION_TYPES.filter(type=>type!=='adversarial'),answerableCaseCount=ordinaryTypes.reduce((sum,type)=>sum+Number(artifact.question_types?.[type]?.answerable_count||0),0),notAnswerableCaseCount=Number(artifact.question_types?.adversarial?.canonical_abstention_count||0);
  return{
    version:`medlocomo-answerability-policy.v1-full-teacher-${artifact.artifact_hash.slice(0,12)}`,
    source_artifact_hash:artifact.artifact_hash,
    training_scope:{patient_count:Number(artifact.selection.patient_count),question_count:Number(artifact.selection.question_count),answerable_case_count:answerableCaseCount,not_answerable_case_count:notAnswerableCaseCount,not_held_out:artifact.selection.not_held_out===true,runtime_retains_case_content:false},
    answerable_exact_phrase_rates:Object.fromEntries(ordinaryTypes.map(type=>[type,Number(artifact.question_types[type].answer_visibility_in_evidence_admissions?.exact_phrase_rate||0)])),
    decision_contract:{answerable_support:['direct','composed'],not_answerable_support:['missing','contradicted'],allow_cross_turn_and_admission_synthesis:true,allow_minimal_stable_clinical_or_temporal_inference:true,exact_phrase_required:false,explicit_negative_can_answer_boolean_or_absence_question:true},
    forbidden_runtime_features:['official_question_type','gold_answer','judge_metadata','candidate_answer','question_surface_template_prior','assessor_reasoning_hypothesis'],
    routing:{refusal_confidence_threshold:.8,low_confidence_not_answerable_route:'answer_with_answerability_check',classifier_failure_route:'answer_with_answerability_check',post_answer_rewrite:false}
  };
}

function validateArtifact(artifact){
  if(!artifact||typeof artifact!=='object')throw new Error('MedLoCoMo policy artifact is missing');
  if(artifact.isolation?.benchmark!=='medlocomo'||artifact.isolation?.policy_namespace!==MEDLOCOMO_POLICY_NAMESPACE)throw new Error('MedLoCoMo policy artifact has the wrong benchmark namespace');
  if(JSON.stringify(artifact.isolation?.compatible_benchmarks)!==JSON.stringify(['medlocomo']))throw new Error('MedLoCoMo policy artifact must be MedLoCoMo-only');
  if(artifact.isolation?.medmemorybench_policy_imported!==false||artifact.isolation?.medmemorybench_policy_modified!==false)throw new Error('MedLoCoMo policy artifact is not isolated from MedMemoryBench');
  if(artifact.selection?.not_held_out!==true||artifact.selection?.all_available_patients_used!==true||artifact.selection?.holdout_patient_count!==0||artifact.selection?.patient_count!==artifact.selection?.available_patient_count||artifact.training_disclosure?.valid_for_held_out_claims!==false)throw new Error('MedLoCoMo full-dataset oracle provenance is not explicit');
  if(artifact.selection?.patient_identifiers_retained!==false||artifact.selection?.question_or_answer_text_retained!==false||artifact.selection?.evidence_text_retained!==false||artifact.training_disclosure?.runtime_retains_case_content!==false)throw new Error('MedLoCoMo policy artifact may not retain case content');
  if(artifact.source_validation?.invalid_evidence_admission_references!==0||artifact.source_validation?.invalid_evidence_turn_references!==0)throw new Error('MedLoCoMo policy artifact contains invalid aggregate Evidence references');
  validateStudentPolicy(artifact.student_policy,artifact);
  for(const type of MEDLOCOMO_POLICY_QUESTION_TYPES){
    if(!artifact.question_types?.[type]||!artifact.recommendations?.[type])throw new Error(`MedLoCoMo policy artifact is missing ${type}`);
    const recommendation=artifact.recommendations[type];
    if(!positiveInteger(recommendation.answer_memory_limit)||!positiveInteger(recommendation.answer_focus_limit)||typeof recommendation.reasoning_hypotheses!=='boolean'||typeof recommendation.target_only_assessment!=='boolean')throw new Error(`MedLoCoMo policy recommendation is invalid for ${type}`);
  }
}

function validateStudentPolicy(student,artifact){
  if(!student||student.version!=='medlocomo-student-policy.v1-full-teacher-aggregate'||student.runtime_eligible!==true)throw new Error('MedLoCoMo Student policy artifact is missing or unsupported');
  if(student.source_teacher?.loaded!==true||student.source_teacher?.version!=='medlocomo-full-teacher-manifest.v1'||!hashLike(student.source_teacher?.artifact_hash))throw new Error('MedLoCoMo Student policy is not linked to the validated full Teacher corpus');
  const scope=student.training_scope;
  if(scope?.patient_count!==artifact.selection.patient_count||scope?.question_count!==artifact.selection.question_count||scope?.holdout_patient_count!==0||scope?.not_held_out!==true||scope?.teacher_read_question!==true||scope?.teacher_read_gold_answer!==true||scope?.teacher_read_official_evidence!==true||scope?.runtime_retains_case_content!==false)throw new Error('MedLoCoMo Student policy training provenance is invalid');
  for(const type of MEDLOCOMO_POLICY_QUESTION_TYPES){const summary=student.question_types?.[type];if(!summary?.default||!summary?.cells||summary.default.case_count!==artifact.question_types?.[type]?.case_count)throw new Error(`MedLoCoMo Student policy is missing ${type}`);for(const cell of [summary.default,...Object.values(summary.cells)])validateStudentCell(cell,type);}
}

function validateStudentCell(cell,type){
  if(!Number.isInteger(Number(cell?.case_count))||Number(cell.case_count)<1)throw new Error(`MedLoCoMo Student cell has invalid support for ${type}`);
  if(!Array.isArray(cell.recommended_action_paths)||!cell.recommended_action_paths.length||cell.recommended_action_paths.some(item=>!Array.isArray(item?.workers)||!item.workers.length||item.workers.some(worker=>!['search','context','trace','assess','refine','verify','answer'].includes(worker))||!positiveInteger(item.support)))throw new Error(`MedLoCoMo Student cell has invalid Action paths for ${type}`);
  if(!positiveInteger(cell.answer_words?.p90)&&cell.answer_words?.p90!==0)throw new Error(`MedLoCoMo Student cell has invalid answer form for ${type}`);
}

function medLoCoMoQueryShape(task,question){const text=String(question||'').normalize('NFKC').toLowerCase();if(task==='frequency_pattern'||/\bhow many\b|\bhow often\b|\bfrequency\b|\bnumber of (?:times|episodes|admissions|occurrences)\b/u.test(text))return'frequency';if(task==='cross_admission_comparison'||/\bcompar|\bdiffer|\bsimilar|\bversus\b|\bvs\.?\b|\bbetween\b/u.test(text))return'comparison';if(task==='longitudinal_progression'||/\bover time\b|\bacross (?:admissions|hospitalizations|time)\b|\bprogress|\bchange|\btrend|\brecurr|\bsubsequent|\bprevious/u.test(text))return'trajectory';if(/\bwhy\b|\bwhat (?:was|were) the (?:reason|rationale)|\bdue to what\b/u.test(text))return'causal';return'direct';}

function compactStudentCell(cellKey,cell){
  return{
    cell_key:cellKey,
    case_count:Number(cell?.case_count||0),
    expected_admissions:{median:Number(cell?.evidence_admissions?.median||0),p90:Number(cell?.evidence_admissions?.p90||0)},
    expected_evidence_count:{median:Number(cell?.evidence_turns?.median||0),p90:Number(cell?.evidence_turns?.p90||0)},
    answer_words:{median:Number(cell?.answer_words?.median||0),p90:Number(cell?.answer_words?.p90||0)},
    answer_shape_rates:{...(cell?.answer_shape_rates||{})},
    recommended_action_paths:(cell?.recommended_action_paths||[]).slice(0,2).map(item=>({workers:[...(item.workers||[])],support:Number(item.support||0)})),
    evidence_roles:(cell?.recommended_evidence_role_patterns||[]).slice(0,2).map(item=>({roles:[...(item.roles||[])],support:Number(item.support||0)})),
    search_lenses:(cell?.recommended_search_lens_patterns||[]).slice(0,2).map(item=>({lenses:[...(item.lenses||[])],support:Number(item.support||0)}))
  };
}

function positiveInteger(value){return Number.isInteger(Number(value))&&Number(value)>0;}
function hashLike(value){return/^[a-f0-9]{64}$/u.test(String(value||''));}
function deepFreeze(value){if(!value||typeof value!=='object'||Object.isFrozen(value))return value;for(const child of Object.values(value))deepFreeze(child);return Object.freeze(value);}
