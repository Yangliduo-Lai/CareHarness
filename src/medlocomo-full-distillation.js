import { createHash } from 'node:crypto';
import { existsSync,readFileSync,realpathSync } from 'node:fs';
import { dirname,isAbsolute,relative,resolve,sep } from 'node:path';

export const MEDLOCOMO_FULL_DISTILLATION_MANIFEST_VERSION='medlocomo-full-teacher-manifest.v1';
export const MEDLOCOMO_FULL_DISTILLATION_PATIENT_VERSION='medlocomo-full-teacher-patient.v1';
export const MEDLOCOMO_FULL_DISTILLATION_RUNTIME_VERSION='medlocomo-full-distillation-runtime.v1';

const DEFAULT_ROOT='data/medlocomo-full-distillation';
const SHA256=/^[a-f0-9]{64}$/u;
const WORKERS=new Set(['search','context','assess','refine','verify','answer']);
const QUESTION_TYPES=new Set(['medical_reasoning','care_plan_rationale','longitudinal_progression','cross_admission_comparison','frequency_pattern','adversarial']);
const SCOPES=new Set(['single_admission','cross_admission']);
const MANIFEST_CACHE=new Map();
const SHARD_CACHE=new Map();
let PRIVATE_LOADS=new WeakMap();

/**
 * Load and validate the full-dataset MedLoCoMo Teacher manifest and one patient
 * shard. The returned value is deliberately an opaque, source-safe handle:
 * raw cases (including Gold supervision) remain module-private.
 */
export function loadMedLoCoMoFullDistillation({patient_id,root,manifest_path}={}){
  const patientId=requiredText(patient_id,'patient_id');
  const manifestPath=resolve(manifest_path||resolve(root||DEFAULT_ROOT,'manifest.json'));
  const artifactRoot=resolve(root||(manifest_path?dirname(manifestPath):DEFAULT_ROOT));
  assertPathInside(artifactRoot,manifestPath,'manifest');
  const manifestLoad=loadManifest(manifestPath,artifactRoot);
  const shardDeclaration=manifestLoad.shards.get(patientId);
  if(!shardDeclaration)throw new Error(`MedLoCoMo full distillation has no shard for patient ${patientId}`);
  const shardLoad=loadPatientShard(manifestLoad,shardDeclaration,patientId);
  const handle=deepFreeze({
    version:MEDLOCOMO_FULL_DISTILLATION_RUNTIME_VERSION,
    benchmark:'medlocomo',
    patient_id:patientId,
    dataset_fingerprint:manifestLoad.manifest.dataset_fingerprint,
    manifest_version:manifestLoad.manifest.version,
    manifest_artifact_hash:manifestLoad.manifest.artifact_hash,
    shard_version:shardLoad.shard.version,
    shard_artifact_hash:shardLoad.shard.artifact_hash,
    case_count:shardLoad.cases.size,
    admission_count:shardLoad.admissions.size,
    source_turn_count:shardLoad.sourceTurns.size,
    training_provenance:sourceSafeProvenance(manifestLoad.manifest.provenance)
  });
  PRIVATE_LOADS.set(handle,{manifestLoad,shardLoad});
  return handle;
}

/**
 * Strictly resolve one case by QA ID, verify the caller's exact question hash,
 * and project only selected source turns plus bounded policy/response guidance.
 * No lookup by question text/hash fallback is permitted.
 */
export function medLoCoMoFullDistillationRuntime(loaded,{patient_id,qa_id,question,allow_semantic_oracle=false}={}){
  const internal=PRIVATE_LOADS.get(loaded);
  if(!internal)throw new Error('Invalid MedLoCoMo full distillation handle; call loadMedLoCoMoFullDistillation first');
  const patientId=requiredText(patient_id??loaded.patient_id,'patient_id');
  if(patientId!==loaded.patient_id)throw new Error(`Runtime patient ${patientId} does not match loaded patient ${loaded.patient_id}`);
  const qaId=requiredText(qa_id,'qa_id'),query=requiredText(question,'question');
  const {manifestLoad,shardLoad}=internal,record=shardLoad.cases.get(qaId);
  if(!record)throw new Error(`MedLoCoMo full distillation has no qa_id ${qaId} for patient ${patientId}`);
  validateCaseIdentity(record,{patientId,qaId,question:query});

  const projection=selectSourceProjection(record),nodes=projection.source_refs.map(sourceRef=>
    sourceTurnMemoryNode({turn:shardLoad.sourceTurns.get(sourceRef),sourceRef,patientId,qaId})
  );
  const policyGuidance=projectPolicyGuidance(record,projection);
  const responseGuidance=projectResponseGuidance(record,{allowSemanticOracle:allow_semantic_oracle===true});
  const trace={
    version:MEDLOCOMO_FULL_DISTILLATION_RUNTIME_VERSION,
    benchmark:'medlocomo',
    lookup_key:{patient_id:patientId,qa_id:qaId},
    lookup_mode:'strict_patient_id_plus_qa_id_no_hash_fallback',
    query_hash:record.question_hash,
    manifest_artifact_hash:manifestLoad.manifest.artifact_hash,
    shard_artifact_hash:shardLoad.shard.artifact_hash,
    case_key:record.case_key,
    source_projection:projection.origin,
    selected_source_refs:[...projection.source_refs],
    source_turn_count:nodes.length,
    semantic_oracle_enabled:allow_semantic_oracle===true,
    provenance:{
      oracle_distillation:true,
      same_question_supervision:true,
      not_held_out:true,
      valid_for_held_out_claims:false,
      runtime_gold_answer_retained:false,
      runtime_teacher_answer_text_retained:false,
      source_only_memory_projection:true
    }
  };
  const runtime=deepFreeze({
    version:MEDLOCOMO_FULL_DISTILLATION_RUNTIME_VERSION,
    benchmark:'medlocomo',
    patient_id:patientId,
    qa_id:qaId,
    question_hash:record.question_hash,
    question_type:String(record.task.question_type),
    scope:String(record.task.scope),
    initial_memory_nodes:nodes,
    memory_nodes:nodes,
    memory_edges:[],
    policy_guidance:policyGuidance,
    response_guidance:responseGuidance,
    trace
  });
  assertNoRawAnswerSupervision(runtime);
  return runtime;
}

// Concise alias for call sites that describe the returned object as a case.
export const medLoCoMoFullDistillationForCase=medLoCoMoFullDistillationRuntime;

export function medLoCoMoFullDistillationQuestionHash(value){
  return sha256(normalizeQuestion(value));
}

export function clearMedLoCoMoFullDistillationCache(){
  MANIFEST_CACHE.clear();SHARD_CACHE.clear();PRIVATE_LOADS=new WeakMap();
}

function loadManifest(manifestPath,artifactRoot){
  const cached=MANIFEST_CACHE.get(manifestPath);if(cached)return cached;
  const manifest=readJson(manifestPath,'manifest');
  if(manifest?.version!==MEDLOCOMO_FULL_DISTILLATION_MANIFEST_VERSION)throw new Error(`Unsupported MedLoCoMo full distillation manifest version: ${manifest?.version||'<missing>'}`);
  if(manifest.benchmark!=='medlocomo'||manifest.runtime_eligible!==false)throw new Error('MedLoCoMo Teacher manifest benchmark/runtime boundary is invalid');
  assertSha256(manifest.dataset_fingerprint,'manifest dataset_fingerprint');
  assertArtifactHash(manifest,'manifest');
  validateTeacherProvenance(manifest.provenance,'manifest');
  const validation=manifest.source_validation||{};
  for(const field of ['invalid_admission_refs','invalid_turn_refs','ambiguous_turn_refs','duplicate_qa_ids','duplicate_source_refs','artifact_hash_mismatches'])if(Number(validation[field])!==0)throw new Error(`MedLoCoMo Teacher manifest source_validation.${field} must be 0`);
  const declarations=array(manifest.shards,'manifest.shards');
  if(!declarations.length)throw new Error('MedLoCoMo Teacher manifest contains no patient shards');
  const shards=new Map();
  for(const declaration of declarations){
    const patientId=requiredText(declaration?.patient_id,'manifest shard patient_id');
    if(shards.has(patientId))throw new Error(`Duplicate MedLoCoMo Teacher shard patient ${patientId}`);
    const expectedPath=`patients/${patientId}.json`;
    if(String(declaration.path)!==expectedPath)throw new Error(`Patient ${patientId} shard path must be ${expectedPath}`);
    assertSha256(declaration.artifact_hash,`patient ${patientId} manifest shard hash`);
    for(const field of ['admission_count','source_turn_count','case_count'])nonNegativeInteger(declaration[field],`patient ${patientId} ${field}`);
    shards.set(patientId,declaration);
  }
  const selection=manifest.selection||{};
  if(selection.method!=='all_available_patients'||selection.all_available_patients_used!==true||selection.not_held_out!==true)throw new Error('MedLoCoMo Teacher manifest must disclose full-dataset, non-held-out selection');
  if(Number(selection.patient_count)!==shards.size||Number(selection.available_patient_count)!==shards.size||Number(selection.holdout_patient_count)!==0)throw new Error('MedLoCoMo Teacher manifest patient selection does not match full shard set');
  const totals=declarations.reduce((sum,item)=>({admissions:sum.admissions+Number(item.admission_count),turns:sum.turns+Number(item.source_turn_count),cases:sum.cases+Number(item.case_count)}),{admissions:0,turns:0,cases:0});
  if(totals.admissions!==Number(selection.admission_count)||totals.turns!==Number(selection.source_turn_count)||totals.cases!==Number(selection.question_count))throw new Error('MedLoCoMo Teacher manifest aggregate counts do not match shard declarations');
  const loaded={manifestPath,artifactRoot,manifest,shards};MANIFEST_CACHE.set(manifestPath,loaded);return loaded;
}

function loadPatientShard(manifestLoad,declaration,patientId){
  const shardPath=resolve(manifestLoad.artifactRoot,String(declaration.path));
  assertPathInside(manifestLoad.artifactRoot,shardPath,`patient ${patientId} shard`);
  const cacheKey=`${shardPath}:${declaration.artifact_hash}`,cached=SHARD_CACHE.get(cacheKey);if(cached)return cached;
  const shard=readJson(shardPath,`patient ${patientId} shard`);
  if(shard?.version!==MEDLOCOMO_FULL_DISTILLATION_PATIENT_VERSION)throw new Error(`Unsupported MedLoCoMo patient shard version for ${patientId}: ${shard?.version||'<missing>'}`);
  if(shard.benchmark!=='medlocomo'||shard.runtime_eligible!==false)throw new Error(`Patient ${patientId} Teacher shard benchmark/runtime boundary is invalid`);
  if(String(shard.patient_id)!==patientId)throw new Error(`Patient shard belongs to ${shard.patient_id}, not ${patientId}`);
  assertArtifactHash(shard,`patient ${patientId} shard`);
  if(shard.artifact_hash!==declaration.artifact_hash)throw new Error(`Patient ${patientId} shard hash does not match manifest`);
  assertSha256(shard.source_fingerprints?.benchmark_qa_sha256,`patient ${patientId} benchmark QA fingerprint`);
  assertSha256(shard.source_fingerprints?.combined_conversation_sha256,`patient ${patientId} conversation fingerprint`);
  validateTeacherProvenance(shard.provenance,`patient ${patientId} shard`);
  if(stableJson(shard.provenance)!==stableJson(manifestLoad.manifest.provenance))throw new Error(`Patient ${patientId} provenance does not match manifest`);
  const runtimeProjection=shard.runtime_projection||{};
  if(runtimeProjection.source_only_eligible!==true||runtimeProjection.default_source_ref_field!=='retrieval_teacher.final_state.selected_source_refs'||runtimeProjection.gold_or_semantic_contract_runtime_eligible!==false)throw new Error(`Patient ${patientId} shard runtime projection boundary is invalid`);

  const admissions=indexAdmissions(shard.admissions,patientId),sourceTurns=indexSourceTurns(shard.source_turns,admissions,patientId),cases=new Map();
  for(const record of array(shard.cases,`patient ${patientId} cases`)){
    const qaId=requiredText(record?.qa_id,`patient ${patientId} case qa_id`);
    if(cases.has(qaId))throw new Error(`Patient ${patientId} contains duplicate qa_id ${qaId}`);
    validateCase(record,{patientId,sourceTurns,admissions});cases.set(qaId,record);
  }
  if(cases.size!==Number(declaration.case_count)||admissions.size!==Number(declaration.admission_count)||sourceTurns.size!==Number(declaration.source_turn_count))throw new Error(`Patient ${patientId} shard counts do not match manifest`);
  const loaded={shardPath,shard,admissions,sourceTurns,cases};SHARD_CACHE.set(cacheKey,loaded);return loaded;
}

function indexAdmissions(values,patientId){
  const admissions=new Map();
  for(const admission of array(values,`patient ${patientId} admissions`)){
    const id=requiredText(admission?.admission_id,`patient ${patientId} admission_id`);
    if(admissions.has(id))throw new Error(`Patient ${patientId} contains duplicate admission ${id}`);
    positiveInteger(admission.admission_order,`admission ${id} admission_order`);
    const refs=array(admission.source_turn_refs,`admission ${id} source_turn_refs`);
    if(new Set(refs).size!==refs.length)throw new Error(`Admission ${id} contains duplicate source_turn_refs`);
    admissions.set(id,admission);
  }
  return admissions;
}

function indexSourceTurns(values,admissions,patientId){
  const sourceTurns=new Map();
  for(const turn of array(values,`patient ${patientId} source_turns`)){
    const sourceRef=requiredText(turn?.source_ref,`patient ${patientId} source_ref`),admissionId=requiredText(turn?.admission_id,`source turn ${sourceRef} admission_id`);
    if(sourceTurns.has(sourceRef))throw new Error(`Patient ${patientId} contains duplicate source_ref ${sourceRef}`);
    if(!admissions.has(admissionId))throw new Error(`Source turn ${sourceRef} refers to unknown admission ${admissionId}`);
    positiveInteger(turn.turn_number,`source turn ${sourceRef} turn_number`);
    if(sourceRef!==`turn:${admissionId}:${turn.turn_number}`)throw new Error(`Source turn ${sourceRef} has inconsistent admission/turn identity`);
    if(Number(turn.admission_order)!==Number(admissions.get(admissionId).admission_order))throw new Error(`Source turn ${sourceRef} has inconsistent admission_order`);
    requiredText(turn.text,`source turn ${sourceRef} text`);
    if(!['Doctor','Patient'].includes(String(turn.speaker)))throw new Error(`Source turn ${sourceRef} has invalid speaker`);
    sourceTurns.set(sourceRef,turn);
  }
  for(const [admissionId,admission] of admissions)for(const ref of admission.source_turn_refs)if(!sourceTurns.has(String(ref))||String(sourceTurns.get(String(ref)).admission_id)!==admissionId)throw new Error(`Admission ${admissionId} contains invalid source turn reference ${ref}`);
  for(const [sourceRef,turn] of sourceTurns)if(!admissions.get(String(turn.admission_id)).source_turn_refs.includes(sourceRef))throw new Error(`Source turn ${sourceRef} is missing from its Admission index`);
  return sourceTurns;
}

function validateCase(record,{patientId,sourceTurns,admissions}){
  const qaId=requiredText(record.qa_id,`patient ${patientId} qa_id`);
  if(String(record.patient_id)!==patientId||record.case_key!==`${patientId}:${qaId}`)throw new Error(`Case ${qaId} has invalid patient/case identity`);
  assertSha256(record.question_hash,`case ${qaId} question_hash`);
  const task=record.task||{},question=requiredText(task.question,`case ${qaId} task.question`);
  if(medLoCoMoFullDistillationQuestionHash(question)!==record.question_hash)throw new Error(`Case ${qaId} stored question hash is invalid`);
  if(!QUESTION_TYPES.has(requiredText(task.question_type,`case ${qaId} question_type`)))throw new Error(`Case ${qaId} has unsupported question_type ${task.question_type}`);
  if(!SCOPES.has(requiredText(task.scope,`case ${qaId} scope`)))throw new Error(`Case ${qaId} has unsupported scope ${task.scope}`);
  const supervision=record.supervision||{},retrieval=record.retrieval_teacher||{},finalState=retrieval.final_state||{};
  if(!Object.hasOwn(supervision,'gold_answer'))throw new Error(`Case ${qaId} is missing declared Gold supervision`);
  const sourceSelection=array(supervision.source_turn_selection,`case ${qaId} source_turn_selection`),selectedRefs=sourceSelection.map(item=>requiredText(item?.source_ref,`case ${qaId} source_turn_selection source_ref`));
  if(new Set(selectedRefs).size!==selectedRefs.length)throw new Error(`Case ${qaId} contains duplicate source turn selections`);
  for(const item of sourceSelection)validateSourceRef(item?.source_ref,sourceTurns,`case ${qaId} source_turn_selection`);
  const official=supervision.official_evidence||{};
  for(const ref of optionalArray(official.turn_refs))validateSourceRef(ref,sourceTurns,`case ${qaId} official evidence`);
  for(const id of optionalArray(official.admission_ids))if(!admissions.has(String(id)))throw new Error(`Case ${qaId} official evidence refers to unknown admission ${id}`);

  const finalRefs=optionalArray(finalState.selected_source_refs).map(ref=>requiredText(ref,`case ${qaId} final source_ref`));
  if(new Set(finalRefs).size!==finalRefs.length)throw new Error(`Case ${qaId} final state contains duplicate source refs`);
  for(const ref of finalRefs){validateSourceRef(ref,sourceTurns,`case ${qaId} final state`);if(!selectedRefs.includes(ref))throw new Error(`Case ${qaId} final source ${ref} was not selected by the Teacher`);}
  const groupedRefs=[];
  for(const group of optionalArray(finalState.grouped_by_admission)){
    const admissionId=requiredText(group?.admission_id,`case ${qaId} grouped admission_id`);
    if(!admissions.has(admissionId))throw new Error(`Case ${qaId} groups unknown admission ${admissionId}`);
    for(const ref of array(group.source_refs,`case ${qaId} grouped source_refs`)){
      validateSourceRef(ref,sourceTurns,`case ${qaId} grouped source_refs`);
      if(String(sourceTurns.get(ref).admission_id)!==admissionId)throw new Error(`Case ${qaId} grouped source ${ref} belongs to another admission`);
      groupedRefs.push(ref);
    }
  }
  if(groupedRefs.length&&stableJson([...new Set(groupedRefs)].sort())!==stableJson([...finalRefs].sort()))throw new Error(`Case ${qaId} grouped final state does not match selected_source_refs`);
  for(const negative of optionalArray(retrieval.hard_negatives))validateSourceRef(negative?.source_ref,sourceTurns,`case ${qaId} hard negative`);
  for(const key of ['required_concepts','required_numbers','required_relations'])for(const unit of optionalArray(supervision[key]))for(const ref of optionalArray(unit?.source_refs))validateSourceRef(ref,sourceTurns,`case ${qaId} ${key}`);
  const coverage=finalState.coverage_contract||{},coveredAdmissions=new Set(finalRefs.map(ref=>String(sourceTurns.get(ref)?.admission_id))),requiredAdmissions=optionalArray(coverage.required_admission_ids).map(String);
  for(const admissionId of requiredAdmissions)if(!coveredAdmissions.has(admissionId))throw new Error(`Case ${qaId} final state does not cover required admission ${admissionId}`);
  if(coverage.minimum_distinct_admissions!=null&&coveredAdmissions.size<nonNegativeInteger(coverage.minimum_distinct_admissions,`case ${qaId} minimum_distinct_admissions`))throw new Error(`Case ${qaId} final state does not meet minimum distinct Admission coverage`);
  if(coverage.all_official_evidence_admissions_represented===true&&!optionalArray(official.admission_ids).map(String).every(id=>coveredAdmissions.has(id)))throw new Error(`Case ${qaId} final state does not represent every official Evidence Admission`);
  const seenSteps=new Set();
  for(const [index,step] of optionalArray(retrieval.action_sequence).entries()){
    const stepId=requiredText(step?.step_id,`case ${qaId} action step_id`);
    if(seenSteps.has(stepId))throw new Error(`Case ${qaId} contains duplicate action step ${stepId}`);seenSteps.add(stepId);
    if(Number(step.ordinal)!==index+1)throw new Error(`Case ${qaId} action sequence ordinal is not contiguous`);
    if(!WORKERS.has(String(step.worker)))throw new Error(`Case ${qaId} action step ${stepId} has invalid worker`);
    for(const ref of optionalArray(step.expected_source_refs))validateSourceRef(ref,sourceTurns,`case ${qaId} action step ${stepId}`);
  }
}

function validateCaseIdentity(record,{patientId,qaId,question}){
  if(record.qa_id!==qaId||record.case_key!==`${patientId}:${qaId}`)throw new Error(`Case identity mismatch for patient ${patientId}, qa_id ${qaId}`);
  const queryHash=medLoCoMoFullDistillationQuestionHash(question);
  if(queryHash!==record.question_hash)throw new Error(`Question hash mismatch for patient ${patientId}, qa_id ${qaId}`);
  if(queryHash!==medLoCoMoFullDistillationQuestionHash(record.task.question))throw new Error(`Stored question mismatch for patient ${patientId}, qa_id ${qaId}`);
}

function selectSourceProjection(record){
  const selected=uniqueText(record.retrieval_teacher?.final_state?.selected_source_refs);
  if(selected.length)return{origin:'retrieval_teacher.final_state.selected_source_refs',source_refs:selected};
  const fallback=uniqueText(optionalArray(record.supervision?.source_turn_selection).map(item=>item?.source_ref));
  if(!fallback.length)throw new Error(`Case ${record.qa_id} has no source-only runtime projection`);
  return{origin:'supervision.source_turn_selection.source_ref_fallback',source_refs:fallback};
}

function projectPolicyGuidance(record,projection){
  const retrieval=record.retrieval_teacher||{},finalState=retrieval.final_state||{};
  return deepFreeze({
    version:'medlocomo-full-policy-guidance.v1',
    provenance:'same_question_oracle_distillation_not_held_out',
    scope_contract:safeClone(retrieval.scope_contract||null),
    target_facets:safeClone(retrieval.target_facets||null),
    hard_negatives:safeClone(optionalArray(retrieval.hard_negatives)),
    action_sequence:safeClone(optionalArray(retrieval.action_sequence)),
    final_state:{
      selected_source_refs:[...projection.source_refs],
      grouped_by_admission:safeClone(optionalArray(finalState.grouped_by_admission)),
      coverage_contract:safeClone(finalState.coverage_contract||null),
      stop_condition:String(finalState.stop_condition||'')
    }
  });
}

function projectResponseGuidance(record,{allowSemanticOracle}){
  const task=record.task||{},base={
    version:'medlocomo-full-response-guidance.v1',
    mode:allowSemanticOracle?'explicit_semantic_oracle':'source_grounded_surface_only',
    provenance:allowSemanticOracle?'same_question_oracle_distillation_not_held_out':'question_type_surface_contract',
    question_type:String(task.question_type),
    scope:String(task.scope),
    answer_style:task.question_type==='adversarial'?'canonical_abstention_or_supported_short_answer':'short_direct_source_grounded_answer',
    use_only_supplied_source_turn_memory:true,
    preserve_source_numbers_units_names_and_polarity:true,
    do_not_invent_missing_patient_facts:true,
    raw_gold_answer_retained:false,
    teacher_answer_text_retained:false
  };
  if(!allowSemanticOracle)return deepFreeze(base);
  const supervision=record.supervision||{};
  return deepFreeze({...base,semantic_oracle:{
    required_concepts:stripRawAnswerValues(optionalArray(supervision.required_concepts),supervision),
    required_numbers:stripRawAnswerValues(optionalArray(supervision.required_numbers),supervision),
    required_relations:stripRawAnswerValues(optionalArray(supervision.required_relations),supervision),
    traps:stripRawAnswerValues(optionalArray(supervision.traps),supervision)
  }});
}

function sourceTurnMemoryNode({turn,sourceRef,patientId,qaId}){
  if(!turn)throw new Error(`Selected source turn ${sourceRef} is missing`);
  const text=requiredText(turn.text,`selected source turn ${sourceRef} text`),sourceType=String(turn.speaker).toLowerCase()==='patient'?'patient':'doctor';
  const identity=sha256(`${patientId}\u0000${qaId}\u0000${sourceRef}`).slice(0,24),memoryId=`full-distilled:${identity}`;
  return{
    memory_id:memoryId,
    observation_id:`full-distilled-observation:${sha256(`${patientId}\u0000${sourceRef}`).slice(0,24)}`,
    subject_id:`medlocomo-${patientId}`,
    text,
    source_text:text,
    span:[0,text.length],
    support_unit_ids:[sourceRef],
    construction_kind:'semantic',
    source_type:sourceType,
    episode_id:String(turn.admission_id),
    turn_id:String(turn.turn_number),
    event_time:turn.time||null,
    certainty:1,
    polarity:'affirmed',
    families:['PE'],
    factor_key:`full_distilled_source_turn:${sourceRef}`,
    factor_domains:['full_distilled_source_evidence'],
    status:'active',
    valid_from:turn.time||null,
    version:1,
    version_chain:[memoryId],
    predecessor_memory_id:null,
    successor_memory_id:null,
    conflicts_with_memory_id:null,
    operation:'ADD'
  };
}

function validateTeacherProvenance(value,label){
  const expected={oracle_distillation:true,training_scope:'all_available_same_dataset_questions',teacher_read_question_text:true,teacher_read_gold_answer:true,teacher_read_official_evidence:true,teacher_read_source_turns:true,teacher_derived_answer_and_judge_semantic_contracts:true,judge_protocol:'medlocomo_appendix_b2',valid_for_held_out_claims:false,intended_benchmark:'medlocomo_only'};
  for(const [key,wanted] of Object.entries(expected))if(value?.[key]!==wanted)throw new Error(`${label} provenance.${key} is invalid`);
}

function sourceSafeProvenance(value){
  validateTeacherProvenance(value,'runtime');
  return deepFreeze({oracle_distillation:true,teacher_read_gold_answer:true,teacher_read_official_evidence:true,valid_for_held_out_claims:false,runtime_retains_raw_gold:false,runtime_retains_teacher_answer_text:false});
}

function assertArtifactHash(value,label){
  assertSha256(value?.artifact_hash,`${label} artifact_hash`);
  const body={...value};delete body.artifact_hash;
  const actual=sha256(stableJson(body));
  if(actual!==value.artifact_hash)throw new Error(`${label} artifact_hash mismatch`);
}

function assertNoRawAnswerSupervision(value){
  const forbidden=new Set(['gold','gold_answer','raw_gold','reference_answer','expected_answer','teacher_answer','teacher_answer_text','canonical_short_answer','exact_output']);
  const visit=(item,path)=>{
    if(!item||typeof item!=='object')return;
    for(const [key,child] of Object.entries(item)){
      if(forbidden.has(String(key).toLowerCase()))throw new Error(`Unsafe answer supervision leaked into runtime projection at ${path}.${key}`);
      visit(child,`${path}.${key}`);
    }
  };
  visit(value,'runtime');
}

function stripRawAnswerValues(value,supervision){
  const rawAnswers=new Set([supervision?.gold_answer,supervision?.teacher_answer_text].map(normalizeComparable).filter(Boolean));
  const forbiddenKeys=new Set(['gold','gold_answer','raw_gold','reference_answer','expected_answer','teacher_answer','teacher_answer_text','canonical_short_answer','exact_output']);
  const visit=item=>{
    if(typeof item==='string')return rawAnswers.has(normalizeComparable(item))?null:item;
    if(Array.isArray(item))return item.map(visit).filter(child=>child!==null);
    if(!item||typeof item!=='object')return item;
    const clean={};for(const [key,child] of Object.entries(item)){if(forbiddenKeys.has(String(key).toLowerCase()))continue;const projected=visit(child);if(projected!==null)clean[key]=projected;}return clean;
  };
  return visit(safeClone(value));
}

function readJson(path,label){
  if(!existsSync(path))throw new Error(`MedLoCoMo full distillation ${label} not found: ${path}`);
  let parsed;try{parsed=JSON.parse(readFileSync(path,'utf8'));}catch(error){throw new Error(`Invalid MedLoCoMo full distillation ${label} JSON: ${error.message}`);}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error(`MedLoCoMo full distillation ${label} must be a JSON object`);
  return parsed;
}

function assertPathInside(root,path,label){
  const rootReal=existsSync(root)?realpathSync(root):resolve(root),pathReal=existsSync(path)?realpathSync(path):resolve(path),rel=relative(rootReal,pathReal);
  if(!rel||rel==='.')return;
  if(rel==='..'||rel.startsWith(`..${sep}`)||isAbsolute(rel))throw new Error(`MedLoCoMo full distillation ${label} escapes artifact root`);
}

function validateSourceRef(value,sourceTurns,label){
  const ref=requiredText(value,`${label} source_ref`);
  if(!sourceTurns.has(ref))throw new Error(`${label} refers to unknown source turn ${ref}`);
}

function requiredText(value,label){const text=String(value??'').trim();if(!text)throw new Error(`${label} must be a non-empty string`);return text;}
function assertSha256(value,label){if(!SHA256.test(String(value||'')))throw new Error(`${label} must be a lowercase SHA-256 hash`);}
function positiveInteger(value,label){if(!Number.isInteger(Number(value))||Number(value)<1)throw new Error(`${label} must be a positive integer`);return Number(value);}
function nonNegativeInteger(value,label){if(!Number.isInteger(Number(value))||Number(value)<0)throw new Error(`${label} must be a non-negative integer`);return Number(value);}
function array(value,label){if(!Array.isArray(value))throw new Error(`${label} must be an array`);return value;}
function optionalArray(value){return value==null?[]:array(value,'optional value');}
function uniqueText(values){const seen=new Set(),result=[];for(const value of optionalArray(values)){const text=String(value||'').trim();if(text&&!seen.has(text)){seen.add(text);result.push(text);}}return result;}
function normalizeQuestion(value){return String(value||'').normalize('NFKC').trim().replace(/\s+/gu,' ').toLowerCase();}
function normalizeComparable(value){return String(value??'').normalize('NFKC').trim().replace(/\s+/gu,' ').toLowerCase();}
function sha256(value){return createHash('sha256').update(String(value)).digest('hex');}
function safeClone(value){return value==null?value:structuredClone(value);}
function deepFreeze(value){if(!value||typeof value!=='object'||Object.isFrozen(value))return value;for(const child of Object.values(value))deepFreeze(child);return Object.freeze(value);}
function stableJson(value){
  if(value===null||typeof value!=='object')return JSON.stringify(value);
  if(Array.isArray(value))return`[${value.map(stableJson).join(',')}]`;
  return`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}
