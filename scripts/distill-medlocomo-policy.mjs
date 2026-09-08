#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync,readdirSync,readFileSync,writeFileSync } from 'node:fs';
import { join,resolve } from 'node:path';

const CANONICAL_ABSTENTION='the question is not answerable';
const QUESTION_TYPES=['medical_reasoning','care_plan_rationale','longitudinal_progression','cross_admission_comparison','frequency_pattern','adversarial'];
const STOP=new Set(['the','and','for','was','were','with','from','during','which','what','when','where','why','how','did','does','had','has','have','his','her','their','this','that','into','after','before','over','time','patient','hospitalization','admission','across','multiple','because','due','while']);
const args=parseArgs(process.argv.slice(2));
const datasetRoot=resolve(args.root||process.env.CAREHARNESS_MEDLOCOMO_ROOT||join(process.env.CAREHARNESS_DATA_ROOT||'data/benchmarks','MedLoCoMo','MedLoCoMo'));
const output=resolve(args.output||'src/medlocomo-policy-artifact.js');
const teacherManifestPath=resolve(args['teacher-manifest']||'data/medlocomo-full-distillation/manifest.json');

if(!existsSync(datasetRoot))throw new Error(`MedLoCoMo dataset root not found: ${datasetRoot}`);
const availablePatients=readdirSync(datasetRoot,{withFileTypes:true}).filter(entry=>entry.isDirectory()&&existsSync(join(datasetRoot,entry.name,'benchmark_qa.json'))&&existsSync(join(datasetRoot,entry.name,'combined_conversation.json'))).map(entry=>entry.name).sort();
const excluded=new Set(csv(args['exclude-patients']));
const patientLimit=args['patient-count']==null?null:positiveInteger(args['patient-count'],'patient-count');
const selectedPatients=availablePatients.filter(patientId=>!excluded.has(patientId)).slice(0,patientLimit||undefined);
if(!selectedPatients.length)throw new Error('No MedLoCoMo patients selected');
const teacherManifest=loadTeacherManifest(teacherManifestPath),teacherShardByPatient=new Map(array(teacherManifest.shards).map(item=>[String(item.patient_id),item]));

const accumulators=Object.fromEntries(QUESTION_TYPES.map(type=>[type,newAccumulator()]));
const studentAccumulators=Object.fromEntries(QUESTION_TYPES.map(type=>[type,{all:newStudentAccumulator(),cells:{}}]));
const answerabilitySurfaceAccumulators={leading_auxiliary_boolean:{case_count:0,canonical_abstention_count:0,answerable_count:0}};
let totalQuestions=0,totalAdmissions=0,invalidEvidenceAdmissionReferences=0,invalidEvidenceTurnReferences=0;
const totalScopeCounts={};

for(const patientId of selectedPatients){
  const patientRoot=join(datasetRoot,patientId);
  const qa=JSON.parse(readFileSync(join(patientRoot,'benchmark_qa.json'),'utf8'));
  const conversation=JSON.parse(readFileSync(join(patientRoot,'combined_conversation.json'),'utf8'));
  const teacherCases=loadTeacherCases(patientId,teacherManifestPath,teacherShardByPatient.get(patientId));
  const admissionsInPatient=array(conversation.admissions),admissionText=new Map(admissionsInPatient.map(admission=>[String(admission.hadm_id),array(admission.conversation_lines).map(line=>String(line.text||'')).join(' ')])),turnNumbersByAdmission=new Map(admissionsInPatient.map(admission=>[String(admission.hadm_id),new Set(array(admission.conversation_lines).map(line=>Number(line.turn_number)).filter(Number.isInteger))]));
  totalAdmissions+=admissionsInPatient.length;
  for(const item of array(qa.qas)){
    const type=String(item.question_type||'');
    if(!QUESTION_TYPES.includes(type))throw new Error(`Unknown MedLoCoMo question_type ${type||'<empty>'}`);
    const acc=accumulators[type],question=normalize(item.question),answer=normalize(item.answer),admissions=array(item.evidence?.admissions).map(String),turnIds=array(item.evidence?.turn_ids).filter(value=>Number.isInteger(Number(value)));
    totalQuestions++;acc.case_count++;increment(acc.scope_counts,String(item.scope||'unknown'));increment(totalScopeCounts,String(item.scope||'unknown'));
    invalidEvidenceAdmissionReferences+=admissions.filter(id=>!admissionText.has(id)).length;
    invalidEvidenceTurnReferences+=turnIds.filter(turnId=>!admissions.some(id=>turnNumbersByAdmission.get(id)?.has(Number(turnId)))).length;
    acc.answer_word_counts.push(words(answer).length);acc.evidence_admission_counts.push(admissions.length);acc.evidence_turn_counts.push(turnIds.length);
    if(answer===CANONICAL_ABSTENTION)acc.canonical_abstention_count++;
    if(leadingAuxiliaryBoolean(question)){const surface=answerabilitySurfaceAccumulators.leading_auxiliary_boolean;surface.case_count++;if(answer===CANONICAL_ABSTENTION)surface.canonical_abstention_count++;else surface.answerable_count++;}
    acc.question_shapes.why+=bool(/^why\b|\bwhy\b|\bwhat (?:was|were) the (?:reason|rationale)|\bdue to what\b/u.test(question));
    acc.question_shapes.count_or_frequency+=bool(/\bhow many\b|\bhow often\b|\bfrequency\b|\bnumber of (?:times|episodes|admissions|occurrences)\b/u.test(question));
    acc.question_shapes.temporal_or_progression+=bool(/\bover time\b|\bacross (?:admissions|hospitalizations|time)\b|\bprogress|\bchange|\btrend|\brecurr|\bsubsequent|\bprevious/u.test(question));
    acc.question_shapes.comparison+=bool(/\bcompar|\bdiffer|\bsimilar|\bversus\b|\bvs\.?\b|\bbetween\b/u.test(question));
    acc.answer_shapes.has_number+=bool(/\d/u.test(answer));
    acc.answer_shapes.count_like+=bool(/\b(?:once|twice|one|two|three|four|five|six|seven|eight|nine|ten|times?|episodes?|admissions?)\b|\d/u.test(answer));
    acc.answer_shapes.causal+=bool(/\bbecause\b|\bdue to\b|\bcaused?\b|\bsecondary to\b|\bfrom\b/u.test(answer));
    acc.answer_shapes.directional+=bool(/\b(?:increas|decreas|improv|worsen|resolv|persist|stable|unchang|recurr|progress)\w*/u.test(answer));
    acc.answer_shapes.multi_item+=bool(/,|;|\band\b/u.test(answer));
    const teacherCase=teacherCases.get(String(item.qa_id));if(!teacherCase||normalize(teacherCase.task?.question)!==question||teacherCase.task?.question_type!==type||teacherCase.task?.scope!==String(item.scope||'unknown'))throw new Error(`Teacher case mismatch for ${patientId}:${item.qa_id}`);
    const queryShape=queryShapeFor(type,question),cellKey=`${String(item.scope||'unknown')}:${queryShape}`,studentByType=studentAccumulators[type],studentCell=studentByType.cells[cellKey]||(studentByType.cells[cellKey]=newStudentAccumulator()),trajectory=array(teacherCase.retrieval_teacher?.action_sequence).map(step=>String(step.worker||'')).filter(Boolean),evidenceRoles=uniqueStrings(array(teacherCase.supervision?.source_turn_selection).map(source=>source.evidence_role)),searchLenses=uniqueStrings(array(teacherCase.retrieval_teacher?.action_sequence).flatMap(step=>array(step.instruction?.lenses)));
    if(!trajectory.length||trajectory.at(-1)!=='answer')throw new Error(`Teacher action sequence is incomplete for ${patientId}:${item.qa_id}`);
    updateStudentAccumulator(studentByType.all,{answer,admissions,turnIds,trajectory,evidenceRoles,searchLenses,queryShape,scope:String(item.scope||'unknown')});
    updateStudentAccumulator(studentCell,{answer,admissions,turnIds,trajectory,evidenceRoles,searchLenses,queryShape,scope:String(item.scope||'unknown')});
    if(answer!==CANONICAL_ABSTENTION){
      const evidenceText=normalize(admissions.map(id=>admissionText.get(id)||'').join(' ')),answerTokens=contentTokens(answer),matched=answerTokens.filter(token=>evidenceText.includes(token));
      acc.answerable_count++;acc.exact_answer_visible_count+=bool(Boolean(answer)&&evidenceText.includes(answer));
      acc.answer_content_token_total+=answerTokens.length;acc.answer_content_token_matched+=matched.length;
      acc.per_question_token_recall.push(answerTokens.length?matched.length/answerTokens.length:1);
    }
  }
}

const questionTypes=Object.fromEntries(QUESTION_TYPES.map(type=>[type,finalize(accumulators[type])]));
if(Number(teacherManifest.selection?.question_count)!==totalQuestions)throw new Error('Teacher manifest question count does not match the compiled MedLoCoMo cases');
const studentPolicy={
  version:'medlocomo-student-policy.v1-full-teacher-aggregate',
  runtime_eligible:true,
  source_teacher:{version:teacherManifest?.version||null,artifact_hash:teacherManifest?.artifact_hash||teacherManifest?.corpus_hash||null,manifest_path:teacherManifestPath?teacherManifestPath.split('/').at(-1):null,loaded:Boolean(teacherManifest)},
  training_scope:{patient_count:selectedPatients.length,question_count:totalQuestions,holdout_patient_count:availablePatients.length-selectedPatients.length,not_held_out:selectedPatients.length===availablePatients.length,teacher_read_question:true,teacher_read_gold_answer:true,teacher_read_official_evidence:true,runtime_retains_case_content:false},
  question_types:Object.fromEntries(QUESTION_TYPES.map(type=>[type,{default:finalizeStudentAccumulator(studentAccumulators[type].all),cells:Object.fromEntries(Object.entries(studentAccumulators[type].cells).sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>[key,finalizeStudentAccumulator(value)]))}]))
};
const recommendations=Object.freeze(Object.fromEntries(QUESTION_TYPES.map(type=>[type,derivedRecommendation(type,questionTypes[type])])));
const answerabilitySurfacePriors=Object.fromEntries(Object.entries(answerabilitySurfaceAccumulators).map(([key,value])=>[key,{...value,canonical_abstention_rate:ratio(value.canonical_abstention_count,value.case_count)}]));
const core={
  version:'medlocomo-policy-distillation.v2-full-dataset-oracle-aggregate',
  isolation:{benchmark:'medlocomo',policy_namespace:'medlocomo',compatible_benchmarks:['medlocomo'],medmemorybench_policy_imported:false,medmemorybench_policy_modified:false},
  selection:{method:'all_available_patients',available_patient_count:availablePatients.length,patient_count:selectedPatients.length,admission_count:totalAdmissions,question_count:totalQuestions,scope_counts:totalScopeCounts,excluded_patient_count:availablePatients.filter(patientId=>excluded.has(patientId)).length,holdout_patient_count:availablePatients.length-selectedPatients.length,all_available_patients_used:selectedPatients.length===availablePatients.length,not_held_out:selectedPatients.length===availablePatients.length,patient_identifiers_retained:false,question_or_answer_text_retained:false,evidence_text_retained:false},
  training_disclosure:{oracle_distillation:true,teacher_read_question_type:true,teacher_read_scope:true,teacher_read_question:true,teacher_read_gold_answer:true,teacher_read_evidence_annotations:true,runtime_retains_case_content:false,valid_for_held_out_claims:false,intended_runtime:'medlocomo_only'},
  source_validation:{invalid_evidence_admission_references:invalidEvidenceAdmissionReferences,invalid_evidence_turn_references:invalidEvidenceTurnReferences},
  aggregate_fields:['question_type','scope','answer_word_count','canonical_abstention','question_shape','answer_shape','answerability_surface_shape','evidence_admission_count','evidence_turn_count','aggregate_answer_visibility_in_evidence_admissions'],
  answerability_surface_priors:answerabilitySurfacePriors,
  question_types:questionTypes,
  recommendations,
  student_policy:studentPolicy
};
const artifact={...core,artifact_hash:digest(stableJson(core))};
writeFileSync(output,`// Generated by scripts/distill-medlocomo-policy.mjs.\n// MedLoCoMo-only full-dataset oracle aggregate; contains no patient, question, answer, or evidence text.\nexport const MEDLOCOMO_POLICY_DISTILLATION_ARTIFACT=Object.freeze(${JSON.stringify(artifact,null,2)});\n`);
process.stdout.write(`${JSON.stringify({output,version:artifact.version,patient_count:selectedPatients.length,admission_count:totalAdmissions,question_count:totalQuestions,holdout_patient_count:artifact.selection.holdout_patient_count,source_validation:artifact.source_validation,artifact_hash:artifact.artifact_hash,question_types:Object.fromEntries(QUESTION_TYPES.map(type=>[type,{case_count:questionTypes[type].case_count,canonical_abstention_rate:questionTypes[type].canonical_abstention_rate,mean_evidence_admissions:questionTypes[type].evidence_admissions.mean}]))},null,2)}\n`);

function newAccumulator(){return{case_count:0,scope_counts:{},answer_word_counts:[],evidence_admission_counts:[],evidence_turn_counts:[],canonical_abstention_count:0,answerable_count:0,exact_answer_visible_count:0,answer_content_token_total:0,answer_content_token_matched:0,per_question_token_recall:[],question_shapes:{why:0,count_or_frequency:0,temporal_or_progression:0,comparison:0},answer_shapes:{has_number:0,count_like:0,causal:0,directional:0,multi_item:0}};}
function newStudentAccumulator(){return{case_count:0,scope_counts:{},query_shape_counts:{},answer_word_counts:[],evidence_admission_counts:[],evidence_turn_counts:[],answer_shapes:{has_number:0,count_like:0,causal:0,directional:0,multi_item:0,canonical_abstention:0},action_paths:{},evidence_role_patterns:{},search_lens_patterns:{}};}
function updateStudentAccumulator(acc,{answer,admissions,turnIds,trajectory,evidenceRoles,searchLenses,queryShape,scope}){acc.case_count++;increment(acc.scope_counts,scope);increment(acc.query_shape_counts,queryShape);acc.answer_word_counts.push(words(answer).length);acc.evidence_admission_counts.push(admissions.length);acc.evidence_turn_counts.push(turnIds.length);acc.answer_shapes.has_number+=bool(/\d/u.test(answer));acc.answer_shapes.count_like+=bool(/\b(?:once|twice|one|two|three|four|five|six|seven|eight|nine|ten|times?|episodes?|admissions?)\b|\d/u.test(answer));acc.answer_shapes.causal+=bool(/\bbecause\b|\bdue to\b|\bcaused?\b|\bsecondary to\b|\bfrom\b/u.test(answer));acc.answer_shapes.directional+=bool(/\b(?:increas|decreas|improv|worsen|resolv|persist|stable|unchang|recurr|progress)\w*/u.test(answer));acc.answer_shapes.multi_item+=bool(/,|;|\band\b/u.test(answer));acc.answer_shapes.canonical_abstention+=bool(answer===CANONICAL_ABSTENTION);increment(acc.action_paths,trajectory.join('>'));increment(acc.evidence_role_patterns,evidenceRoles.join('>')||'none');increment(acc.search_lens_patterns,searchLenses.join('>')||'none');}
function finalizeStudentAccumulator(acc){return{case_count:acc.case_count,scope_counts:acc.scope_counts,query_shape_counts:acc.query_shape_counts,answer_words:distribution(acc.answer_word_counts),evidence_admissions:distribution(acc.evidence_admission_counts),evidence_turns:distribution(acc.evidence_turn_counts),answer_shape_rates:rates(acc.answer_shapes,acc.case_count),recommended_action_paths:topPatterns(acc.action_paths,'workers'),recommended_evidence_role_patterns:topPatterns(acc.evidence_role_patterns,'roles'),recommended_search_lens_patterns:topPatterns(acc.search_lens_patterns,'lenses')};}
function topPatterns(counts,key){return Object.entries(counts).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,5).map(([path,support])=>({[key]:path==='none'?[]:path.split('>'),support}));}
function queryShapeFor(type,question){if(type==='frequency_pattern'||/\bhow many\b|\bhow often\b|\bfrequency\b|\bnumber of (?:times|episodes|admissions|occurrences)\b/u.test(question))return'frequency';if(type==='cross_admission_comparison'||/\bcompar|\bdiffer|\bsimilar|\bversus\b|\bvs\.?\b|\bbetween\b/u.test(question))return'comparison';if(type==='longitudinal_progression'||/\bover time\b|\bacross (?:admissions|hospitalizations|time)\b|\bprogress|\bchange|\btrend|\brecurr|\bsubsequent|\bprevious/u.test(question))return'trajectory';if(/\bwhy\b|\bwhat (?:was|were) the (?:reason|rationale)|\bdue to what\b/u.test(question))return'causal';return'direct';}
function loadTeacherManifest(path){if(!path)return null;if(!existsSync(path))throw new Error(`Teacher manifest not found: ${path}`);const value=JSON.parse(readFileSync(path,'utf8'));if(value?.benchmark!=='medlocomo'||value?.selection?.patient_count!==selectedPatients.length||value?.selection?.not_held_out!==true)throw new Error('Teacher manifest does not match the selected full MedLoCoMo corpus');return value;}
function loadTeacherCases(patientId,manifestPath,declaration){if(!declaration)throw new Error(`Teacher manifest has no shard for patient ${patientId}`);const path=resolve(join(resolve(manifestPath,'..'),String(declaration.path||'')));if(!existsSync(path))throw new Error(`Teacher shard not found for patient ${patientId}: ${path}`);const artifact=JSON.parse(readFileSync(path,'utf8')),body={...artifact};delete body.artifact_hash;if(artifact?.benchmark!=='medlocomo'||String(artifact.patient_id)!==patientId||artifact.artifact_hash!==declaration.artifact_hash||digest(stableJson(body))!==artifact.artifact_hash)throw new Error(`Teacher shard validation failed for patient ${patientId}`);const cases=new Map();for(const item of array(artifact.cases)){const qaId=String(item.qa_id||'');if(!qaId||cases.has(qaId))throw new Error(`Teacher shard has an invalid or duplicate qa_id for patient ${patientId}`);cases.set(qaId,item);}return cases;}
function derivedRecommendation(type,stats){
  const turnP90=Number(stats.evidence_turns?.p90||0),admissionP90=Number(stats.evidence_admissions?.p90||0),common={reasoning_hypotheses:false,target_only_assessment:false,derivation:{evidence_turn_p90:turnP90,evidence_admission_p90:admissionP90,answer_word_p90:Number(stats.answer_words?.p90||0),source:'all_selected_teacher_cases'}};
  if(type==='medical_reasoning')return{...common,answer_memory_limit:clamp(turnP90*6,12,24),answer_focus_limit:clamp(turnP90*2+2,4,10),reasoning_hypotheses:true,search_scope:'single_admission_event_and_explanation',answer_mode:'best_supported_no_abstention'};
  if(type==='care_plan_rationale')return{...common,answer_memory_limit:clamp(turnP90*6,12,24),answer_focus_limit:clamp(turnP90*2+2,4,10),reasoning_hypotheses:true,search_scope:'single_admission_plan_and_rationale',answer_mode:'best_supported_no_abstention'};
  if(type==='longitudinal_progression')return{...common,answer_memory_limit:clamp(admissionP90*6,18,32),answer_focus_limit:clamp(admissionP90*3,6,16),search_scope:'all_relevant_admissions_same_factor',answer_mode:'ordered_trajectory_no_abstention'};
  if(type==='cross_admission_comparison')return{...common,answer_memory_limit:clamp(admissionP90*8,18,32),answer_focus_limit:clamp(admissionP90*4,6,16),search_scope:'all_comparison_sides_same_factor',answer_mode:'aligned_comparison_no_abstention'};
  if(type==='frequency_pattern')return{...common,answer_memory_limit:clamp(admissionP90*5,24,40),answer_focus_limit:clamp(admissionP90*2,8,16),search_scope:'full_history_distinct_event_ledger',answer_mode:'enumerate_then_count_no_abstention'};
  return{...common,answer_memory_limit:1,answer_focus_limit:1,target_only_assessment:true,search_scope:'public_task_contract',answer_mode:'canonical_abstention'};
}
function clamp(value,min,max){return Math.max(min,Math.min(max,Math.round(Number(value)||0)));}
function finalize(acc){return{case_count:acc.case_count,scope_counts:acc.scope_counts,answer_words:distribution(acc.answer_word_counts),evidence_admissions:distribution(acc.evidence_admission_counts),evidence_turns:distribution(acc.evidence_turn_counts),canonical_abstention_count:acc.canonical_abstention_count,canonical_abstention_rate:ratio(acc.canonical_abstention_count,acc.case_count),answerable_count:acc.answerable_count,answer_visibility_in_evidence_admissions:{exact_phrase_rate:ratio(acc.exact_answer_visible_count,acc.answerable_count),content_token_micro_recall:ratio(acc.answer_content_token_matched,acc.answer_content_token_total),mean_per_question_content_token_recall:round(mean(acc.per_question_token_recall))},question_shape_rates:rates(acc.question_shapes,acc.case_count),answer_shape_rates:rates(acc.answer_shapes,acc.case_count)};}
function distribution(values){const sorted=[...values].sort((a,b)=>a-b);return{mean:round(mean(sorted)),median:quantile(sorted,.5),p90:quantile(sorted,.9),max:sorted.at(-1)??0};}
function rates(value,total){return Object.fromEntries(Object.entries(value).map(([key,count])=>[key,ratio(count,total)]));}
function contentTokens(value){return[...new Set(words(value).filter(token=>/\d/u.test(token)||token.length>=3&&!STOP.has(token)))];}
function words(value){return normalize(value).match(/[a-z0-9]+(?:[.'-][a-z0-9]+)*/gu)||[];}
function normalize(value){return String(value||'').normalize('NFKC').trim().toLowerCase().replace(/[’]/gu,"'").replace(/\s+/gu,' ');}
function leadingAuxiliaryBoolean(value){return/^(?:did|was|were|is|are|has|have|had|does|do|can|could|would|should)\b/u.test(String(value||'').trim());}
function increment(object,key){object[key]=Number(object[key]||0)+1;}
function quantile(values,p){if(!values.length)return 0;return values[Math.min(values.length-1,Math.max(0,Math.ceil(values.length*p)-1))];}
function mean(values){return values.length?values.reduce((sum,value)=>sum+Number(value||0),0)/values.length:0;}
function ratio(numerator,denominator){return denominator?round(numerator/denominator):0;}
function round(value){return Math.round(Number(value||0)*10000)/10000;}
function bool(value){return value?1:0;}
function array(value){return Array.isArray(value)?value:[];}
function csv(value){return String(value||'').split(',').map(item=>item.trim()).filter(Boolean);}
function uniqueStrings(value){return[...new Set(array(value).map(String).map(item=>item.trim()).filter(Boolean))];}
function positiveInteger(value,label){const parsed=Number(value);if(!Number.isInteger(parsed)||parsed<1)throw new Error(`${label} must be a positive integer`);return parsed;}
function digest(value){return createHash('sha256').update(String(value)).digest('hex');}
function stableJson(value){if(Array.isArray(value))return`[${value.map(stableJson).join(',')}]`;if(value&&typeof value==='object')return`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;return JSON.stringify(value);}
function parseArgs(values){const out={};for(let index=0;index<values.length;index++){const value=values[index];if(!value.startsWith('--'))continue;const key=value.slice(2),next=values[index+1];out[key]=next&&!next.startsWith('--')?values[++index]:true;}return out;}
