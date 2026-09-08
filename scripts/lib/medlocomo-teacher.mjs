import { createHash } from 'node:crypto';

export const MEDLOCOMO_FULL_TEACHER_MANIFEST_VERSION='medlocomo-full-teacher-manifest.v1';
export const MEDLOCOMO_FULL_TEACHER_PATIENT_VERSION='medlocomo-full-teacher-patient.v1';

const BENCHMARK='medlocomo';
const CANONICAL_ABSTENTION='the question is not answerable';
const QUESTION_TYPES=new Set(['medical_reasoning','care_plan_rationale','longitudinal_progression','cross_admission_comparison','frequency_pattern','adversarial']);
const SCOPES=new Set(['single_admission','cross_admission']);
const STOP=new Set([
  'a','an','the','and','or','of','for','to','in','on','at','by','as','was','were','is','are','be','been','being','with','from','during','which','what','when','where','why','how','did','does','do','had','has','have','his','her','their','this','that','these','those','into','after','before','over','time','patient','hospitalization','hospitalizations','admission','admissions','across','multiple','because','due','while','most','primary','main','reason','rationale','following','according','record','records'
]);
const NUMBER_WORDS=new Set(['zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen','twenty','once','twice','thrice']);

export function distillMedLoCoMoPatient({patient_id,qa,conversation,source_fingerprints={}}={}){
  const patientId=requiredText(patient_id,'patient_id');
  if(!qa||typeof qa!=='object'||!Array.isArray(qa.qas))throw new Error(`Patient ${patientId}: benchmark_qa.json must contain qas[]`);
  if(!conversation||typeof conversation!=='object'||!Array.isArray(conversation.admissions))throw new Error(`Patient ${patientId}: combined_conversation.json must contain admissions[]`);

  const admissionIds=new Set(),sourceRefs=new Set(),admissions=[],sourceTurns=[],turnsByAdmission=new Map();
  for(let admissionOrder=0;admissionOrder<conversation.admissions.length;admissionOrder++){
    const sourceAdmission=conversation.admissions[admissionOrder],admissionId=requiredText(sourceAdmission?.hadm_id,`Patient ${patientId}: admission hadm_id`);
    if(admissionIds.has(admissionId))throw new Error(`Patient ${patientId}: duplicate admission ${admissionId}`);
    admissionIds.add(admissionId);
    const lines=array(sourceAdmission.conversation_lines),turns=[],turnNumbers=new Set();
    for(let turnOrder=0;turnOrder<lines.length;turnOrder++){
      const line=lines[turnOrder],turnNumber=Number(line?.turn_number);
      if(!Number.isInteger(turnNumber)||turnNumber<1)throw new Error(`Patient ${patientId}, admission ${admissionId}: invalid turn_number ${line?.turn_number}`);
      if(turnNumbers.has(turnNumber))throw new Error(`Patient ${patientId}, admission ${admissionId}: duplicate turn ${turnNumber}`);
      turnNumbers.add(turnNumber);
      const sourceRef=sourceTurnRef(admissionId,turnNumber);
      if(sourceRefs.has(sourceRef))throw new Error(`Patient ${patientId}: duplicate source_ref ${sourceRef}`);
      sourceRefs.add(sourceRef);
      const turn={source_ref:sourceRef,admission_id:admissionId,admission_order:admissionOrder+1,turn_number:turnNumber,turn_order:turnOrder+1,time:nullableText(line?.time),speaker:requiredText(line?.speaker,`${sourceRef} speaker`),text:requiredText(line?.text,`${sourceRef} text`),raw_turn:clone(line)};
      turns.push(turn);sourceTurns.push(turn);
    }
    turnsByAdmission.set(admissionId,turns);
    const{conversation_lines:_lines,...metadata}=sourceAdmission;
    admissions.push({admission_id:admissionId,admission_order:admissionOrder+1,admission_start:nullableText(sourceAdmission.admission_start),admission_end:nullableText(sourceAdmission.admission_end),source_turn_refs:turns.map(turn=>turn.source_ref),source_metadata:clone(metadata)});
  }

  const sourceByRef=new Map(sourceTurns.map(turn=>[turn.source_ref,turn])),qaIds=new Set(),cases=[];
  for(const sourceQa of qa.qas){
    const distilled=distillCase({patientId,sourceQa,admissions,turnsByAdmission,sourceByRef});
    if(qaIds.has(distilled.qa_id))throw new Error(`Patient ${patientId}: duplicate qa_id ${distilled.qa_id}`);
    qaIds.add(distilled.qa_id);cases.push(distilled);
  }
  const provenance=teacherProvenance(),stats=patientStats(admissions,sourceTurns,cases),body={
    version:MEDLOCOMO_FULL_TEACHER_PATIENT_VERSION,runtime_eligible:false,benchmark:BENCHMARK,patient_id:patientId,
    provenance,source_fingerprints:{benchmark_qa_sha256:strictHash(source_fingerprints.benchmark_qa_sha256,'benchmark_qa_sha256'),combined_conversation_sha256:strictHash(source_fingerprints.combined_conversation_sha256,'combined_conversation_sha256')},
    runtime_projection:{source_only_eligible:true,default_source_ref_field:'retrieval_teacher.final_state.selected_source_refs',gold_or_semantic_contract_runtime_eligible:false},
    admissions,source_turns:sourceTurns,cases,stats
  };
  const artifact={...body,artifact_hash:hashArtifactBody(body)};
  validateMedLoCoMoPatientTeacher(artifact);return artifact;
}

export function buildMedLoCoMoTeacherManifest({dataset_fingerprint,shards,available_patient_count=null}={}){
  const rows=array(shards).map(item=>({patient_id:requiredText(item.patient_id,'manifest shard patient_id'),path:requiredText(item.path,'manifest shard path'),admission_count:positiveOrZero(item.admission_count,'manifest shard admission_count'),source_turn_count:positiveOrZero(item.source_turn_count,'manifest shard source_turn_count'),case_count:positiveOrZero(item.case_count,'manifest shard case_count'),artifact_hash:strictHash(item.artifact_hash,'manifest shard artifact_hash')})).sort((left,right)=>left.patient_id.localeCompare(right.patient_id));
  const questionTypeCounts={},scopeCounts={};let admissionCount=0,sourceTurnCount=0,questionCount=0;
  for(const item of array(shards)){
    admissionCount+=Number(item.admission_count||0);sourceTurnCount+=Number(item.source_turn_count||0);questionCount+=Number(item.case_count||0);
    mergeCounts(questionTypeCounts,item.question_type_counts);mergeCounts(scopeCounts,item.scope_counts);
  }
  const available=available_patient_count==null?rows.length:positiveOrZero(available_patient_count,'available_patient_count'),provenance=teacherProvenance(),body={
    version:MEDLOCOMO_FULL_TEACHER_MANIFEST_VERSION,runtime_eligible:false,benchmark:BENCHMARK,dataset_fingerprint:strictHash(dataset_fingerprint,'dataset_fingerprint'),
    selection:{method:'all_available_patients',available_patient_count:available,patient_count:rows.length,admission_count:admissionCount,source_turn_count:sourceTurnCount,question_count:questionCount,scope_counts:sortObject(scopeCounts),question_type_counts:sortObject(questionTypeCounts),all_available_patients_used:rows.length===available,not_held_out:rows.length===available,holdout_patient_count:Math.max(0,available-rows.length)},
    provenance,source_validation:{invalid_admission_refs:0,invalid_turn_refs:0,ambiguous_turn_refs:0,duplicate_qa_ids:0,duplicate_source_refs:0,artifact_hash_mismatches:0},shards:rows
  };
  const artifact={...body,artifact_hash:hashArtifactBody(body)};validateMedLoCoMoTeacherManifest(artifact);return artifact;
}

export function validateMedLoCoMoPatientTeacher(artifact){
  if(!artifact||typeof artifact!=='object'||Array.isArray(artifact))throw new Error('MedLoCoMo patient teacher artifact must be an object');
  if(artifact.version!==MEDLOCOMO_FULL_TEACHER_PATIENT_VERSION||artifact.benchmark!==BENCHMARK||artifact.runtime_eligible!==false)throw new Error('Unsupported MedLoCoMo patient teacher artifact');
  if(!artifact.provenance?.oracle_distillation||artifact.provenance?.valid_for_held_out_claims!==false)throw new Error('Patient teacher artifact must disclose oracle, non-held-out provenance');
  if(artifact.runtime_projection?.source_only_eligible!==true||artifact.runtime_projection?.gold_or_semantic_contract_runtime_eligible!==false)throw new Error('Patient teacher runtime projection boundary is invalid');
  const expectedHash=hashArtifactBody(withoutArtifactHash(artifact));if(artifact.artifact_hash!==expectedHash)throw new Error(`Patient ${artifact.patient_id}: artifact hash mismatch`);
  strictHash(artifact.source_fingerprints?.benchmark_qa_sha256,'benchmark_qa_sha256');strictHash(artifact.source_fingerprints?.combined_conversation_sha256,'combined_conversation_sha256');
  const admissionIds=new Set(),sourceRefs=new Set(),sourceByRef=new Map();
  for(const admission of array(artifact.admissions)){
    const id=requiredText(admission?.admission_id,'admission_id');if(admissionIds.has(id))throw new Error(`Patient ${artifact.patient_id}: duplicate admission ${id}`);admissionIds.add(id);
  }
  for(const turn of array(artifact.source_turns)){
    const ref=requiredText(turn?.source_ref,'source_ref'),expected=sourceTurnRef(turn?.admission_id,turn?.turn_number);
    if(ref!==expected)throw new Error(`Patient ${artifact.patient_id}: invalid source_ref ${ref}`);if(sourceRefs.has(ref))throw new Error(`Patient ${artifact.patient_id}: duplicate source_ref ${ref}`);if(!admissionIds.has(String(turn.admission_id)))throw new Error(`Patient ${artifact.patient_id}: source turn references unknown admission ${turn.admission_id}`);
    sourceRefs.add(ref);sourceByRef.set(ref,turn);
  }
  for(const admission of artifact.admissions)for(const ref of array(admission.source_turn_refs))requireRef(ref,sourceRefs,`admission ${admission.admission_id}`);
  const qaIds=new Set();
  for(const item of array(artifact.cases)){
    const qaId=requiredText(item?.qa_id,'qa_id');if(qaIds.has(qaId))throw new Error(`Patient ${artifact.patient_id}: duplicate qa_id ${qaId}`);qaIds.add(qaId);
    if(item.patient_id!==artifact.patient_id||item.case_key!==`${artifact.patient_id}:${qaId}`)throw new Error(`Patient ${artifact.patient_id}: invalid case key for ${qaId}`);
    if(item.question_hash!==medLoCoMoQuestionHash(item.task?.question))throw new Error(`Patient ${artifact.patient_id}: question hash mismatch for ${qaId}`);
    if(!QUESTION_TYPES.has(item.task?.question_type)||!SCOPES.has(item.task?.scope))throw new Error(`Patient ${artifact.patient_id}: invalid task metadata for ${qaId}`);
    if(item.source_qa?.qa_id!==qaId||item.source_qa?.question!==item.task.question||item.source_qa?.question_type!==item.task.question_type||item.source_qa?.scope!==item.task.scope||item.source_qa?.answer!==item.supervision?.gold_answer)throw new Error(`Patient ${artifact.patient_id}: ${qaId} does not retain its source QA exactly`);
    if(stableJson(item.source_qa?.evidence||{})!==stableJson(item.supervision?.official_evidence?.raw||{}))throw new Error(`Patient ${artifact.patient_id}: ${qaId} official Evidence changed during distillation`);
    const evidenceAdmissions=array(item.supervision?.official_evidence?.admission_ids).map(String);for(const id of evidenceAdmissions)if(!admissionIds.has(id))throw new Error(`Patient ${artifact.patient_id}: ${qaId} references unknown admission ${id}`);
    for(const ref of array(item.supervision?.official_evidence?.turn_refs))requireRef(ref,sourceRefs,`${qaId} official evidence`);
    const selectedRefs=new Set();for(const selected of array(item.supervision?.source_turn_selection)){requireRef(selected?.source_ref,sourceRefs,`${qaId} source selection`);if(selectedRefs.has(selected.source_ref))throw new Error(`Patient ${artifact.patient_id}: ${qaId} contains duplicate selected source ${selected.source_ref}`);selectedRefs.add(selected.source_ref);if(!evidenceAdmissions.includes(String(sourceByRef.get(selected.source_ref)?.admission_id)))throw new Error(`Patient ${artifact.patient_id}: ${qaId} selected source outside official admissions`);}
    for(const negative of array(item.retrieval_teacher?.hard_negatives))requireRef(negative?.source_ref,sourceRefs,`${qaId} hard negative`);
    const finalRefs=array(item.retrieval_teacher?.final_state?.selected_source_refs);for(const ref of finalRefs)requireRef(ref,sourceRefs,`${qaId} final state`);
    if(new Set(finalRefs).size!==finalRefs.length)throw new Error(`Patient ${artifact.patient_id}: ${qaId} final state has duplicate source refs`);
    const selectedSet=new Set(array(item.supervision?.source_turn_selection).map(value=>value.source_ref));for(const ref of finalRefs)if(!selectedSet.has(ref))throw new Error(`Patient ${artifact.patient_id}: ${qaId} final source ${ref} was not teacher-selected`);
    const requiredAdmissionIds=array(item.retrieval_teacher?.final_state?.coverage_contract?.required_admission_ids).map(String),coveredAdmissions=new Set(finalRefs.map(ref=>String(sourceByRef.get(ref)?.admission_id)));
    for(const id of requiredAdmissionIds)if(!coveredAdmissions.has(id))throw new Error(`Patient ${artifact.patient_id}: ${qaId} final state does not cover admission ${id}`);
    const steps=array(item.retrieval_teacher?.action_sequence);if(!steps.length||steps.at(-1)?.worker!=='answer')throw new Error(`Patient ${artifact.patient_id}: ${qaId} action sequence must terminate with answer`);for(let index=0;index<steps.length;index++){const step=steps[index];if(step.ordinal!==index+1||step.step_id!==`step_${index+1}`)throw new Error(`Patient ${artifact.patient_id}: ${qaId} action sequence order is invalid`);for(const ref of array(step.expected_source_refs))requireRef(ref,sourceRefs,`${qaId} ${step.step_id}`);}
    validateSemanticUnitRefs(item,sourceRefs,qaId);
    validateTypeSpecificContract(item,evidenceAdmissions,sourceRefs,qaId);
  }
  if(Number(artifact.stats?.admission_count)!==artifact.admissions.length||Number(artifact.stats?.source_turn_count)!==artifact.source_turns.length||Number(artifact.stats?.case_count)!==artifact.cases.length)throw new Error(`Patient ${artifact.patient_id}: stats do not match artifact arrays`);
  return true;
}

export function validateMedLoCoMoTeacherManifest(manifest,{patient_artifacts=null}={}){
  if(!manifest||typeof manifest!=='object'||Array.isArray(manifest)||manifest.version!==MEDLOCOMO_FULL_TEACHER_MANIFEST_VERSION||manifest.benchmark!==BENCHMARK||manifest.runtime_eligible!==false)throw new Error('Unsupported MedLoCoMo teacher manifest');
  if(!manifest.provenance?.oracle_distillation||manifest.provenance?.valid_for_held_out_claims!==false)throw new Error('Teacher manifest must disclose oracle, non-held-out provenance');
  strictHash(manifest.dataset_fingerprint,'dataset_fingerprint');if(manifest.artifact_hash!==hashArtifactBody(withoutArtifactHash(manifest)))throw new Error('Teacher manifest artifact hash mismatch');
  const patients=new Set(),paths=new Set(),qaIds=new Set();let admissions=0,turns=0,cases=0;
  const provided=patient_artifacts instanceof Map?patient_artifacts:null;
  for(const shard of array(manifest.shards)){
    if(patients.has(shard.patient_id)||paths.has(shard.path))throw new Error(`Duplicate Teacher shard ${shard.patient_id}`);patients.add(shard.patient_id);paths.add(shard.path);strictHash(shard.artifact_hash,'shard artifact_hash');
    admissions+=Number(shard.admission_count||0);turns+=Number(shard.source_turn_count||0);cases+=Number(shard.case_count||0);
    if(provided){const artifact=provided.get(shard.patient_id);if(!artifact)throw new Error(`Missing patient artifact ${shard.patient_id}`);validateMedLoCoMoPatientTeacher(artifact);if(artifact.artifact_hash!==shard.artifact_hash)throw new Error(`Shard hash mismatch for patient ${shard.patient_id}`);for(const item of artifact.cases){if(qaIds.has(item.qa_id))throw new Error(`Duplicate global qa_id ${item.qa_id}`);qaIds.add(item.qa_id);}}
  }
  const selection=manifest.selection||{};if(Number(selection.patient_count)!==manifest.shards.length||Number(selection.admission_count)!==admissions||Number(selection.source_turn_count)!==turns||Number(selection.question_count)!==cases)throw new Error('Teacher manifest selection totals do not match shards');
  if(provided&&qaIds.size!==cases)throw new Error('Teacher manifest global qa_id total is invalid');return true;
}

export function medLoCoMoQuestionHash(value){return sha256(normalizeQuestion(value));}
export function sha256(value){return createHash('sha256').update(String(value)).digest('hex');}
export function stableJson(value){if(Array.isArray(value))return`[${value.map(stableJson).join(',')}]`;if(value&&typeof value==='object')return`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;return JSON.stringify(value);}

function distillCase({patientId,sourceQa,admissions,turnsByAdmission,sourceByRef}){
  const qaId=requiredText(sourceQa?.qa_id,`Patient ${patientId}: qa_id`),questionType=requiredText(sourceQa?.question_type,`${qaId} question_type`),scope=requiredText(sourceQa?.scope,`${qaId} scope`),question=requiredText(sourceQa?.question,`${qaId} question`),goldAnswer=requiredText(sourceQa?.answer,`${qaId} answer`);
  if(!QUESTION_TYPES.has(questionType))throw new Error(`${qaId}: unknown question_type ${questionType}`);if(!SCOPES.has(scope))throw new Error(`${qaId}: unknown scope ${scope}`);
  const evidenceAdmissionIds=unique(array(sourceQa?.evidence?.admissions).map(String).filter(Boolean));if(!evidenceAdmissionIds.length)throw new Error(`${qaId}: official evidence has no admissions`);
  for(const id of evidenceAdmissionIds)if(!turnsByAdmission.has(id))throw new Error(`${qaId}: official evidence references unknown admission ${id}`);
  const officialTurnIds=unique(array(sourceQa?.evidence?.turn_ids).map(Number).filter(Number.isInteger)),officialTurnRefs=bindOfficialTurnRefs(qaId,evidenceAdmissionIds,officialTurnIds,turnsByAdmission);
  const questionTokens=contentTokens(question),countQuestion=questionType==='frequency_pattern'&&isCountQuestion(question),answerTokens=goldAnswer.toLowerCase()===CANONICAL_ABSTENTION||countQuestion?[]:contentTokens(goldAnswer),selection=selectSourceTurns({questionType,question,goldAnswer,evidenceAdmissionIds,officialTurnRefs,turnsByAdmission,questionTokens,answerTokens});
  const finalRefs=selection.map(item=>item.source_ref),semantic=semanticSupervision({questionType,question,goldAnswer,selectedRefs:finalRefs,sourceByRef}),targetFacets=targetFacetsFor(question,semantic),hardNegatives=hardNegativesFor({evidenceAdmissionIds,finalRefs,sourceByRef,questionTokens}),typeSpecific=typeSpecificContract({questionType,question,goldAnswer,evidenceAdmissionIds,selection,admissions,semantic}),coverageContract=coverageFor({scope,questionType,evidenceAdmissionIds,finalRefs,sourceByRef,semantic,typeSpecific}),finalState={selected_source_refs:finalRefs,grouped_by_admission:groupRefs(finalRefs,sourceByRef),coverage_contract:coverageContract,stop_condition:stopCondition(questionType)},actionSequence=actionSequenceFor({questionType,question,evidenceAdmissionIds,selection,semantic,finalState,targetFacets,typeSpecific});
  return{
    case_key:`${patientId}:${qaId}`,patient_id:patientId,qa_id:qaId,question_hash:medLoCoMoQuestionHash(question),
    task:{question_type:questionType,scope,question,query_intent:queryIntent(questionType,question,targetFacets,typeSpecific)},
    source_qa:clone(sourceQa),
    supervision:{gold_answer:goldAnswer,official_evidence:{raw:clone(sourceQa.evidence||{}),admission_ids:evidenceAdmissionIds,turn_ids:officialTurnIds,turn_refs:officialTurnRefs,has_exact_turns:officialTurnRefs.length>0},source_turn_selection:selection,required_concepts:semantic.concepts,required_numbers:semantic.numbers,required_relations:semantic.relations,traps:trapsFor(questionType,question,goldAnswer,semantic),answer_contract:answerContract(questionType,question,goldAnswer,semantic),judge_semantic_contract:judgeContract(questionType,semantic)},
    retrieval_teacher:{scope_contract:{allowed_admission_ids:evidenceAdmissionIds,required_admission_ids:evidenceAdmissionIds,exclude_out_of_scope:true,scope},target_facets:targetFacets,hard_negatives:hardNegatives,action_sequence:actionSequence,final_state:finalState,trajectory_semantics:'teacher_demonstration_not_direct_runtime_input',optimality_claim:'locally_minimal_under_declared_worker_contract_not_global_graph_optimum'},
    type_specific:typeSpecific
  };
}

function bindOfficialTurnRefs(qaId,admissionIds,turnIds,turnsByAdmission){
  const refs=[];
  for(const turnId of turnIds){const matches=[];for(const admissionId of admissionIds)for(const turn of turnsByAdmission.get(admissionId)||[])if(turn.turn_number===turnId)matches.push(turn.source_ref);
    if(!matches.length)throw new Error(`${qaId}: official turn ${turnId} does not exist in evidence admissions`);if(matches.length>1)throw new Error(`${qaId}: official turn ${turnId} is ambiguous across evidence admissions`);refs.push(matches[0]);
  }
  return unique(refs);
}

function selectSourceTurns({questionType,question,goldAnswer,evidenceAdmissionIds,officialTurnRefs,turnsByAdmission,questionTokens,answerTokens}){
  const selected=new Map(),official=new Set(officialTurnRefs),countQuestion=questionType==='frequency_pattern'&&isCountQuestion(question),perAdmissionLimit=questionType==='frequency_pattern'?8:['longitudinal_progression','cross_admission_comparison'].includes(questionType)?5:4,totalLimit=questionType==='frequency_pattern'?40:['longitudinal_progression','cross_admission_comparison'].includes(questionType)?24:18;
  const add=(turn,basis,score,role)=>{const prior=selected.get(turn.source_ref);if(prior&&basis!=='official_evidence_turn')return;selected.set(turn.source_ref,{source_ref:turn.source_ref,admission_id:turn.admission_id,admission_order:turn.admission_order,turn_number:turn.turn_number,time:turn.time,speaker:turn.speaker,selection_basis:basis,relevance_score:round(score),evidence_role:role});};
  for(const ref of officialTurnRefs){const turn=findTurn(ref,turnsByAdmission);add(turn,'official_evidence_turn',1,evidenceRole(questionType));}
  for(const admissionId of evidenceAdmissionIds){
    const turns=turnsByAdmission.get(admissionId)||[],ranked=turns.map(turn=>({turn,score:teacherTurnScore(turn.text,question,goldAnswer,questionTokens,answerTokens,{countQuestion})})).sort((left,right)=>right.score-left.score||left.turn.turn_number-right.turn.turn_number),quota=Math.max(1,perAdmissionLimit-array([...selected.values()]).filter(item=>item.admission_id===admissionId).length);
    let added=0;for(const candidate of ranked){if(selected.size>=totalLimit||added>=quota)break;if(official.has(candidate.turn.source_ref)||candidate.score<=0)continue;add(candidate.turn,answerTokens.some(token=>tokenMatch(normalize(candidate.turn.text),token))?'gold_query_rank':'query_rank',candidate.score,evidenceRole(questionType));added++;}
    if(!array([...selected.values()]).some(item=>item.admission_id===admissionId)&&ranked[0])add(ranked[0].turn,'admission_coverage_fallback',ranked[0].score,evidenceRole(questionType));
  }
  if(officialTurnRefs.length){
    for(const ref of officialTurnRefs){const anchor=findTurn(ref,turnsByAdmission),turns=turnsByAdmission.get(anchor.admission_id)||[],index=turns.findIndex(turn=>turn.source_ref===ref);for(const offset of[-1,1]){const neighbor=turns[index+offset];if(neighbor&&selected.size<totalLimit)add(neighbor,'adjacent_context',.25,evidenceRole(questionType));}}
  }
  const order=new Map();for(const admissionId of evidenceAdmissionIds)(turnsByAdmission.get(admissionId)||[]).forEach((turn,index)=>order.set(turn.source_ref,index));
  return[...selected.values()].sort((left,right)=>left.admission_order-right.admission_order||(order.get(left.source_ref)||0)-(order.get(right.source_ref)||0));
}

function semanticSupervision({questionType,question,goldAnswer,selectedRefs,sourceByRef}){
  const selected=selectedRefs.map(ref=>sourceByRef.get(ref)),answerNorm=normalize(goldAnswer),conceptValues=[];
  if(questionType!=='adversarial'&&answerNorm){conceptValues.push(goldAnswer.trim());for(const token of contentTokens(goldAnswer))if(!numeric(token)&&!NUMBER_WORDS.has(token))conceptValues.push(token);}
  const concepts=unique(conceptValues.map(value=>normalizeSpaces(value)).filter(Boolean)).map((concept,index)=>{
    const grounding=groundingFor(concept,selected),sourceRefs=grounding.refs;return{semantic_unit_id:`concept_${index+1}`,concept,kind:index===0?'canonical_answer_phrase':'gold_content_concept',required:true,grounding:grounding.kind,source_refs:sourceRefs};
  });
  const numbers=extractNumbers(goldAnswer).map((item,index)=>{const grounding=groundingFor(item.text,selected);return{semantic_unit_id:`number_${index+1}`,...item,required:true,grounding:grounding.kind,source_refs:grounding.refs};});
  const relations=relationsFor(questionType,question,goldAnswer).map((item,index)=>({semantic_unit_id:`relation_${index+1}`,...item,required:true,source_refs:selectedRefs.slice(0,Math.min(8,selectedRefs.length))}));
  return{concepts,numbers,relations};
}

function relationsFor(questionType,question,goldAnswer){
  const out=[],answer=normalizeSpaces(goldAnswer).toLowerCase();
  if(questionType==='medical_reasoning')out.push({relation:'clinical_explanation_for',description:'The answer must state the documented cause, trigger, or finding that explains the questioned event.'});
  if(questionType==='care_plan_rationale')out.push({relation:'patient_specific_rationale_for_plan',description:'The answer must state why the named plan was chosen, withheld, continued, or changed.'});
  if(questionType==='longitudinal_progression')out.push({relation:'ordered_trajectory',description:'The answer must preserve the requested factor and its clinically material progression across Admissions.'});
  if(questionType==='cross_admission_comparison')out.push({relation:'like_for_like_cross_admission_comparison',description:'The answer must compare every requested side on one shared factor.'});
  if(questionType==='frequency_pattern')out.push({relation:isCountQuestion(question)?'deduplicated_count':'recurrence_or_frequency_pattern',description:'The result must be derived from distinct qualifying events using the unit requested in the question.'});
  if(questionType==='adversarial')out.push({relation:'unsupported_requested_fact',description:'The requested claim is not answerable and must not be inferred from related facts.'});
  const fromTo=/\bfrom\s+(.{1,60}?)\s+to\s+(.{1,60}?)(?:[.,;]|$)/iu.exec(goldAnswer);if(fromTo)out.push({relation:'change_from_to',description:`Preserve both endpoints: ${fromTo[1].trim()} -> ${fromTo[2].trim()}.`});
  const direction=(answer.match(/\b(?:improved?|increased?|decreased?|worsened?|resolved?|persisted?|remained?|recurred?|progressed?|shifted?|changed?)\b/gu)||[]);if(direction.length)out.push({relation:'directionality',description:`Preserve directional cue(s): ${unique(direction).join(', ')}.`});
  return dedupeBy(out,item=>`${item.relation}\0${item.description}`);
}

function typeSpecificContract({questionType,question,goldAnswer,evidenceAdmissionIds,selection,admissions,semantic}){
  const admissionById=new Map(admissions.map(item=>[item.admission_id,item])),selectedByAdmission=new Map();for(const item of selection){const values=selectedByAdmission.get(item.admission_id)||[];values.push(item.source_ref);selectedByAdmission.set(item.admission_id,values);}
  if(questionType==='longitudinal_progression')return{trajectory:{factor:primaryTarget(question,semantic),points:evidenceAdmissionIds.map((id,index)=>({point_id:`point_${index+1}`,admission_id:id,admission_order:admissionById.get(id)?.admission_order??null,source_refs:selectedByAdmission.get(id)||[]})),direction:directionFromAnswer(goldAnswer),outcome:goldAnswer,required_point_count:evidenceAdmissionIds.length,all_points_required:true}};
  if(questionType==='cross_admission_comparison')return{comparison:{axis:primaryTarget(question,semantic),sides:evidenceAdmissionIds.map((id,index)=>({side_id:`side_${index+1}`,admission_ids:[id],label:`Admission ${index+1}`,source_refs:selectedByAdmission.get(id)||[]})),relation:directionFromAnswer(goldAnswer)||'compare_on_shared_axis',all_sides_required:true,gold_synthesis:goldAnswer}};
  if(questionType==='frequency_pattern'){
    const requestedUnit=frequencyUnit(question),mode=isCountQuestion(question)?'count':isArgmaxQuestion(question)?'most_frequent_item':'recurrence_pattern',candidates=evidenceAdmissionIds.map((id,index)=>({ledger_id:`ledger_${index+1}`,admission_id:id,event_key:`${normalize(primaryTarget(question,semantic)).slice(0,80)}:${id}`,source_refs:selectedByAdmission.get(id)||[],qualification:'official_evidence_admission_candidate',requires_semantic_deduplication:requestedUnit!=='admission'}));
    return{frequency_ledger:{requested_unit:requestedUnit,aggregate_mode:mode,qualifying_rule:`Count only source-supported instances of ${primaryTarget(question,semantic)} that satisfy the question.`,dedupe_key:requestedUnit==='admission'?'admission_id':requestedUnit==='site'?'normalized_site':'clinical_event_identity_within_admission',candidates,teacher_aggregate_answer:goldAnswer,recomputed_from_candidate_rows:false,all_official_evidence_admissions_must_be_checked:true}};
  }
  return null;
}

function actionSequenceFor({questionType,question,evidenceAdmissionIds,selection,semantic,finalState,targetFacets,typeSpecific}){
  const refs=selection.map(item=>item.source_ref),units=[...semantic.concepts,...semantic.numbers,...semantic.relations].map(item=>item.semantic_unit_id),searchTerms=targetFacets.search_terms.slice(0,10),expansionTerms=targetFacets.gold_derived_expansion_terms.slice(0,8),steps=[],push=(worker,instruction,expectedRefs,expectedUnits,check)=>steps.push({step_id:`step_${steps.length+1}`,ordinal:steps.length+1,worker,instruction,expected_source_refs:unique(expectedRefs),expected_new_semantic_unit_ids:unique(expectedUnits),completion_check:check});
  push('search',{objective:searchObjective(questionType),episode_ids:evidenceAdmissionIds,search_terms:searchTerms,expansion_terms:expansionTerms,lenses:searchLenses(questionType),max_results:questionType==='frequency_pattern'?40:24},refs,[],questionType==='frequency_pattern'?'Every official Evidence Admission has been scanned for a qualifying event.':'Every required Admission side has at least one relevant source candidate.');
  if(['longitudinal_progression','cross_admission_comparison','frequency_pattern'].includes(questionType)||selection.some(item=>item.selection_basis==='adjacent_context'))push('context',{objective:contextObjective(questionType),episode_ids:evidenceAdmissionIds},refs.filter(ref=>selection.find(item=>item.source_ref===ref)?.selection_basis==='adjacent_context'),[],questionType==='frequency_pattern'?'Each candidate has enough local context to decide whether and how it counts.':'Elliptical facts and comparison endpoints have their local context.');
  push('assess',{objective:assessmentObjective(questionType,typeSpecific)},refs,units,questionType==='frequency_pattern'?'A source-cited deduplicated occurrence ledger is complete.':'Every required semantic unit and Admission side is classified as supported or unresolved.');
  push('verify',{objective:'Verify source provenance, scope, semantic coverage, and final packet size.'},refs,units,'All final facts resolve to visible source turns and the coverage contract passes.');
  push('answer',{objective:'Freeze the concise benchmark answer from the verified packet.'},refs,units,'The answer satisfies the answer and Judge semantic contracts without exposing teacher metadata.');
  return steps;
}

function hardNegativesFor({evidenceAdmissionIds,finalRefs,sourceByRef,questionTokens}){
  const final=new Set(finalRefs),evidence=new Set(evidenceAdmissionIds),ranked=[];
  for(const turn of sourceByRef.values()){
    if(final.has(turn.source_ref))continue;const score=lexicalScore(turn.text,questionTokens);if(score<=0)continue;
    ranked.push({source_ref:turn.source_ref,reason:evidence.has(turn.admission_id)?'same-evidence-Admission lexical match omitted from the minimal final packet':'similar wording outside the official Evidence Admission scope',similarity_score:round(score)});
  }
  return ranked.sort((left,right)=>right.similarity_score-left.similarity_score||left.source_ref.localeCompare(right.source_ref)).slice(0,8);
}

function targetFacetsFor(question,semantic){
  const searchTerms=contentTokens(question).filter(token=>!numeric(token)).slice(0,16),goldTerms=semantic.concepts.filter(item=>item.kind!=='canonical_answer_phrase').map(item=>item.concept).slice(0,12),numericSignals=extractNumbers(question).map(item=>item.text);
  return{search_terms:unique(searchTerms),gold_derived_expansion_terms:unique(goldTerms),numeric_signals:unique(numericSignals),target_factor:primaryTarget(question,semantic)};
}

function queryIntent(questionType,question,targetFacets,typeSpecific){return{target_operation:({medical_reasoning:'explain',care_plan_rationale:'justify_plan',longitudinal_progression:'trace_progression',cross_admission_comparison:'compare',frequency_pattern:'enumerate_and_aggregate',adversarial:'verify_answerability'})[questionType],target_factor:targetFacets.target_factor,time_scope:/\b(?:during|from|between)\b/iu.test(question)?'question_explicit':'task_scope',requested_unit:typeSpecific?.frequency_ledger?.requested_unit||null};}

function coverageFor({scope,questionType,evidenceAdmissionIds,finalRefs,sourceByRef,semantic}){
  const covered=new Set(finalRefs.map(ref=>sourceByRef.get(ref)?.admission_id).filter(Boolean)),semanticIds=[...semantic.concepts,...semantic.numbers,...semantic.relations].filter(item=>item.required).map(item=>item.semantic_unit_id);
  return{required_admission_ids:evidenceAdmissionIds,minimum_distinct_admissions:scope==='cross_admission'?evidenceAdmissionIds.length:1,all_official_evidence_admissions_represented:evidenceAdmissionIds.every(id=>covered.has(id)),required_semantic_unit_ids:semanticIds,question_type:questionType};
}

function trapsFor(questionType,question,goldAnswer,semantic){
  const traps=[];const add=(type,description,avoidance)=>traps.push({trap_id:`trap_${traps.length+1}`,type,description,avoidance});
  if(questionType!=='adversarial')add('premature_abstention','Treating partial wording overlap as proof that this answerable item is unanswerable.','Return the best source-supported answer for answerable task types.');
  if(questionType==='medical_reasoning')add('event_without_explanation','Repeating the event or treatment without stating why it occurred.','Bind the questioned event to the decisive documented cause or finding.');
  if(questionType==='care_plan_rationale')add('plan_without_rationale','Naming what clinicians did but omitting the patient-specific reason.','Answer why the plan was chosen, not merely what it was.');
  if(questionType==='longitudinal_progression')add('single_timepoint','Answering from one Admission and losing the trajectory.','Preserve earliest, material intermediate, and latest relevant states.');
  if(questionType==='cross_admission_comparison')add('missing_comparison_side','Using one Admission or a within-Admission change as the cross-Admission comparison.','Align every required side on the same factor before synthesizing.');
  if(questionType==='frequency_pattern'){add('counting_mentions','Counting Memory Nodes or repeated mentions instead of distinct requested units.','Build a source-cited ledger and deduplicate before aggregation.');add('top_k_count','Counting only the retrieved top-k sample.','Check every official Evidence Admission before counting.');}
  if(questionType==='adversarial')add('related_fact_inference','Inferring the requested unsupported relation from nearby related facts.','Return the canonical abstention exactly.');
  if(semantic.numbers.length)add('lost_number_or_unit','Dropping or changing a decisive value, endpoint, count, or unit.','Preserve every required numeric semantic unit exactly.');
  if(/\bfrom\b[\s\S]*\bto\b/iu.test(goldAnswer))add('one_endpoint_only','Returning only one endpoint of a requested change.','Include both from and to endpoints.');
  return traps;
}

function answerContract(questionType,question,goldAnswer,semantic){
  const words=wordTokens(goldAnswer).length,targetKind=questionType==='frequency_pattern'?(isCountQuestion(question)?'count':isArgmaxQuestion(question)?'argmax':'pattern'):questionType==='cross_admission_comparison'?'comparison':questionType==='longitudinal_progression'?'trajectory':questionType==='care_plan_rationale'?'rationale':questionType==='medical_reasoning'?'clinical_explanation':'canonical_abstention';
  return{language:'English',target_kind:targetKind,canonical_short_answer:goldAnswer,recommended_max_words:questionType==='adversarial'?5:Math.min(16,Math.max(8,words+2)),preserve_names_values_units_negation_and_endpoints:true,no_explanation_or_label:true,exact_output:questionType==='adversarial'?CANONICAL_ABSTENTION:null,required_semantic_unit_ids:[...semantic.concepts,...semantic.numbers,...semantic.relations].filter(item=>item.required).map(item=>item.semantic_unit_id)};
}

function judgeContract(questionType,semantic){return{protocol:'MedLoCoMo Appendix B.2 binary answerable Judge',judge_visible_fields:['question','gold_answer','candidate_answer'],score_one_if:questionType==='adversarial'?'Not applicable; adversarial uses the official deterministic abstention matcher.':'The candidate is correct, complete enough for the short-answer question, and semantically agrees with the Gold answer.',score_zero_if:questionType==='adversarial'?'Not applicable.':'The candidate is false, unsupported, materially incomplete, or only says it is not answerable.',required_semantic_unit_ids:[...semantic.concepts,...semantic.numbers,...semantic.relations].filter(item=>item.required).map(item=>item.semantic_unit_id),binary_scores:[0,1]};}

function teacherTurnScore(text,question,goldAnswer,questionTokens,answerTokens,{countQuestion=false}={}){const normalized=normalize(text);let score=lexicalScore(text,questionTokens);if(!countQuestion&&goldAnswer&&normalize(goldAnswer)!==normalize(CANONICAL_ABSTENTION)&&normalized.includes(normalize(goldAnswer)))score+=100;for(const token of answerTokens)if(tokenMatch(normalized,token))score+=numeric(token)?18:Math.min(12,3+token.length);if(/\b(?:because|due to|secondary to|therefore|so that|reason|caused|showed|revealed)\b/iu.test(text)&&/\b(?:why|reason|rationale|prompted)\b/iu.test(question))score+=4;return score;}
function lexicalScore(text,tokens){const normalized=normalize(text);let score=0;for(const token of tokens)if(tokenMatch(normalized,token))score+=numeric(token)?6:Math.min(5,1+token.length/4);return score;}
function groundingFor(needle,turns){const norm=normalize(needle),tokens=contentTokens(needle),ranked=turns.map(turn=>{const text=normalize(turn?.text),exact=norm&&text.includes(norm),matched=tokens.filter(token=>tokenMatch(text,token)).length;return{ref:turn.source_ref,exact,matched,score:exact?1:tokens.length?matched/tokens.length:0};}).filter(item=>item.score>0).sort((a,b)=>b.score-a.score||a.ref.localeCompare(b.ref));const top=ranked[0]?.score||0;return{kind:top===1?'direct':top>=.5?'partial':'teacher_synthesis_from_official_evidence',refs:ranked.filter(item=>item.score===top).slice(0,6).map(item=>item.ref)};}

function extractNumbers(value){const matches=String(value||'').match(/(?:\b\d+(?:,\d{3})*(?:\.\d+)?(?:\s*(?:-|–|to)\s*\d+(?:,\d{3})*(?:\.\d+)?)?\s*(?:%|mg|mcg|g|kg|ml|l|mmhg|bpm|cm|mm|days?|weeks?|months?|years?|times?|sites?|admissions?)?\b|\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|once|twice|thrice)\b)/giu)||[];return unique(matches.map(text=>normalizeSpaces(text))).map(text=>{const unit=/\b(%|mg|mcg|g|kg|ml|l|mmhg|bpm|cm|mm|days?|weeks?|months?|years?|times?|sites?|admissions?)\b/iu.exec(text)?.[1]||null;return{text,value:text.replace(unit||'','').trim(),unit};});}
function directionFromAnswer(value){const matches=String(value||'').toLowerCase().match(/\b(?:improved?|increased?|decreased?|worsened?|resolved?|persisted?|remained?|recurred?|progressed?|shifted?|changed?)\b/gu)||[];return unique(matches).join(', ')||null;}
function primaryTarget(question,semantic){const content=contentTokens(question).filter(token=>!numeric(token));return content.slice(-6).join(' ')||semantic.concepts[0]?.concept||'requested clinical factor';}
function frequencyUnit(question){if(/\badmissions?\b/iu.test(question))return'admission';if(/\b(?:different\s+)?sites?\b/iu.test(question))return'site';if(isCountQuestion(question))return'occurrence';return'pattern';}
function isCountQuestion(value){return/\bhow\s+many\b|\bnumber\s+of\b/iu.test(value);}
function isArgmaxQuestion(value){return/\bmost\s+(?:often|frequent(?:ly)?|common(?:ly)?|consistent(?:ly)?|repeated)\b/iu.test(value);}
function evidenceRole(type){return({medical_reasoning:'clinical_explanation',care_plan_rationale:'plan_and_rationale',longitudinal_progression:'trajectory_point',cross_admission_comparison:'comparison_side',frequency_pattern:'occurrence_candidate',adversarial:'answerability_probe'})[type];}
function searchObjective(type){return({medical_reasoning:'Locate the questioned event and its documented same-Admission explanation.',care_plan_rationale:'Locate the named plan and the patient-specific reason for it.',longitudinal_progression:'Locate the same requested factor across every required Admission.',cross_admission_comparison:'Locate the requested factor separately on every comparison side.',frequency_pattern:'Enumerate every candidate occurrence across the complete required Admission scope.',adversarial:'Verify the exact requested claim without inferring from related facts.'})[type];}
function contextObjective(type){return type==='frequency_pattern'?'Open local context needed to qualify and deduplicate every occurrence candidate.':'Open local context around selected source turns so pronouns, replies, endpoints, and stages remain attributable.';}
function assessmentObjective(type,specific){if(type==='frequency_pattern')return`Build the ${specific?.frequency_ledger?.requested_unit||'event'} ledger, qualify each row, deduplicate it, and only then aggregate.`;if(type==='cross_admission_comparison')return'Align every Admission side on the same comparison axis and preserve paired values or states.';if(type==='longitudinal_progression')return'Order all relevant Admission points into one factor-specific trajectory.';return'Assess whether the selected sources cover the requested short-answer semantics.';}
function searchLenses(type){return({medical_reasoning:['event','cause','same_admission'],care_plan_rationale:['intervention','rationale','constraint'],longitudinal_progression:['same_factor','chronology','episode_diversity'],cross_admission_comparison:['same_axis','paired_sides','episode_diversity'],frequency_pattern:['full_scope','occurrence_ledger','episode_diversity'],adversarial:['exact_claim','negation','alternatives']})[type];}
function stopCondition(type){return({medical_reasoning:'The target event and decisive source-supported explanation are both present.',care_plan_rationale:'The plan and its patient-specific rationale are present as one pair.',longitudinal_progression:'Every required Admission point is represented and the ordered trajectory is supportable.',cross_admission_comparison:'Every comparison side is represented on one shared axis.',frequency_pattern:'Every official Evidence Admission has been checked and distinct qualifying units can be deduplicated.',adversarial:'The exact requested relation has been exhaustively checked and remains unsupported.'})[type];}

function groupRefs(refs,sourceByRef){const groups=new Map();for(const ref of refs){const turn=sourceByRef.get(ref),id=turn.admission_id,group=groups.get(id)||{admission_id:id,admission_order:turn.admission_order,source_refs:[]};group.source_refs.push(ref);groups.set(id,group);}return[...groups.values()].sort((a,b)=>a.admission_order-b.admission_order);}
function findTurn(ref,turnsByAdmission){for(const turns of turnsByAdmission.values()){const found=turns.find(turn=>turn.source_ref===ref);if(found)return found;}throw new Error(`Unknown source turn ${ref}`);}
function patientStats(admissions,sourceTurns,cases){const questionTypeCounts={},scopeCounts={};let exact=0,selected=0;for(const item of cases){increment(questionTypeCounts,item.task.question_type);increment(scopeCounts,item.task.scope);exact+=item.supervision.official_evidence.turn_refs.length;selected+=item.supervision.source_turn_selection.length;}return{admission_count:admissions.length,source_turn_count:sourceTurns.length,case_count:cases.length,question_type_counts:sortObject(questionTypeCounts),scope_counts:sortObject(scopeCounts),official_exact_turn_ref_count:exact,teacher_selected_source_ref_count:selected};}
function teacherProvenance(){return{oracle_distillation:true,training_scope:'all_available_same_dataset_questions',teacher_read_question_text:true,teacher_read_gold_answer:true,teacher_read_official_evidence:true,teacher_read_source_turns:true,teacher_derived_answer_and_judge_semantic_contracts:true,judge_protocol:'medlocomo_appendix_b2',valid_for_held_out_claims:false,intended_benchmark:'medlocomo_only'};}
function validateSemanticUnitRefs(item,refs,qaId){for(const key of['required_concepts','required_numbers','required_relations'])for(const unit of array(item.supervision?.[key]))for(const ref of array(unit.source_refs))requireRef(ref,refs,`${qaId} ${unit.semantic_unit_id}`);}
function validateTypeSpecificContract(item,evidenceAdmissions,refs,qaId){
  const type=item.task?.question_type,specific=item.type_specific;
  if(type==='longitudinal_progression'){
    const points=array(specific?.trajectory?.points);if(points.length!==evidenceAdmissions.length||specific?.trajectory?.all_points_required!==true)throw new Error(`${qaId}: invalid longitudinal trajectory contract`);for(const point of points)for(const ref of array(point.source_refs))requireRef(ref,refs,`${qaId} trajectory point`);
  }else if(type==='cross_admission_comparison'){
    const sides=array(specific?.comparison?.sides);if(sides.length!==evidenceAdmissions.length||specific?.comparison?.all_sides_required!==true)throw new Error(`${qaId}: invalid comparison contract`);for(const side of sides)for(const ref of array(side.source_refs))requireRef(ref,refs,`${qaId} comparison side`);
  }else if(type==='frequency_pattern'){
    const rows=array(specific?.frequency_ledger?.candidates);if(rows.length!==evidenceAdmissions.length||specific?.frequency_ledger?.all_official_evidence_admissions_must_be_checked!==true)throw new Error(`${qaId}: invalid frequency ledger contract`);for(const row of rows)for(const ref of array(row.source_refs))requireRef(ref,refs,`${qaId} frequency ledger`);
  }else if(specific!==null)throw new Error(`${qaId}: unexpected type-specific contract for ${type}`);
}
function requireRef(value,refs,label){const ref=requiredText(value,`${label} source_ref`);if(!refs.has(ref))throw new Error(`${label}: unknown source_ref ${ref}`);}
function sourceTurnRef(admissionId,turnNumber){const id=requiredText(admissionId,'admission_id');if(id.includes(':'))throw new Error(`Admission ID may not contain colon: ${id}`);const turn=Number(turnNumber);if(!Number.isInteger(turn)||turn<1)throw new Error(`Invalid turn number ${turnNumber}`);return`turn:${id}:${turn}`;}
function contentTokens(value){return unique(wordTokens(value).filter(token=>numeric(token)||NUMBER_WORDS.has(token)||token.length>=3&&!STOP.has(token)));}
function wordTokens(value){return normalizeSpaces(value).toLowerCase().match(/[a-z0-9]+(?:[.'-][a-z0-9]+)*/gu)||[];}
function tokenMatch(text,token){if(text.includes(token))return true;if(numeric(token)||token.length<7)return false;return text.includes(token.slice(0,6));}
function numeric(value){return/\d/u.test(value);}
function normalizeQuestion(value){return normalizeSpaces(value).toLowerCase();}
function normalize(value){return normalizeSpaces(value).toLowerCase().replace(/[’]/gu,"'");}
function normalizeSpaces(value){return String(value||'').normalize('NFKC').trim().replace(/\s+/gu,' ');}
function strictHash(value,label){const text=String(value||'');if(!/^[a-f0-9]{64}$/u.test(text))throw new Error(`${label} must be a SHA-256 hex digest`);return text;}
function hashArtifactBody(body){return sha256(stableJson(body));}
function withoutArtifactHash(value){const{artifact_hash:_hash,...body}=value;return body;}
function positiveOrZero(value,label){const number=Number(value);if(!Number.isInteger(number)||number<0)throw new Error(`${label} must be a non-negative integer`);return number;}
function requiredText(value,label){const text=String(value??'').trim();if(!text)throw new Error(`${label} is required`);return text;}
function nullableText(value){const text=String(value??'').trim();return text||null;}
function unique(values){return[...new Set(values)];}
function array(value){return Array.isArray(value)?value:[];}
function clone(value){return value==null?value:JSON.parse(JSON.stringify(value));}
function round(value){return Math.round(Number(value||0)*10000)/10000;}
function increment(value,key){value[key]=Number(value[key]||0)+1;}
function mergeCounts(target,source){for(const[key,value]of Object.entries(source||{}))target[key]=Number(target[key]||0)+Number(value||0);}
function sortObject(value){return Object.fromEntries(Object.entries(value).sort(([left],[right])=>left.localeCompare(right)));}
function dedupeBy(values,key){const seen=new Set();return values.filter(value=>{const current=key(value);if(seen.has(current))return false;seen.add(current);return true;});}
