import { createHash } from 'node:crypto';
import { readFileSync,readdirSync } from 'node:fs';
import { join } from 'node:path';

export const MEDMEMORY_ORACLE_TEACHER_VERSION='medmemory-oracle-teacher.v2-auditable-trajectories';
export const MEDMEMORY_STUDENT_SUMMARY_VERSION='medmemory-student-strategy-summary.v2-action-role-patterns';

export function distillMedMemoryTeacher(datasetRoot,{holdout_persona=null}={}){
  const personas=personaDirectories(datasetRoot),cases=[];
  for(const directory of personas){
    const personaId=Number(directory.slice('persona_'.length));
    if(Number(holdout_persona)===personaId)continue;
    const evalRoot=join(datasetRoot,directory,'eval'),queries=readJson(join(evalRoot,'generated_queries.json')).queries||[],dialogues=readJson(join(evalRoot,'generated_dialogues.json')).sessions||[],sessionMap=new Map(dialogues.filter(item=>Number.isInteger(Number(item.session_id))).map(item=>[Number(item.session_id),sessionRecord(item)]));
    for(const query of queries)cases.push(distillCase(personaId,query,sessionMap));
  }
  return buildTeacherArtifact({training_persona_ids:personas.map(item=>Number(item.slice('persona_'.length))).filter(id=>Number(holdout_persona)!==id),holdout_persona_id:Number(holdout_persona)||null,cases});
}

export function buildHoldoutTeacherFromFullTeacher(fullTeacher,holdoutPersona){
  if(fullTeacher?.version!==MEDMEMORY_ORACLE_TEACHER_VERSION||fullTeacher?.holdout_persona_id!==null)throw new Error('Expected a full MedMemory oracle teacher artifact');
  const holdout=Number(holdoutPersona);
  if(!Number.isInteger(holdout)||holdout<1||!fullTeacher.training_persona_ids.includes(holdout))throw new Error(`Unknown holdout Persona: ${holdoutPersona}`);
  return buildTeacherArtifact({training_persona_ids:fullTeacher.training_persona_ids.filter(id=>id!==holdout),holdout_persona_id:holdout,cases:fullTeacher.cases.filter(item=>Number(item.persona_id)!==holdout)});
}

export function buildCaseFreeStudentSummary(teacher,{strategy_version=null,strategy_profile_hash=null}={}){
  if(teacher?.version!==MEDMEMORY_ORACLE_TEACHER_VERSION)throw new Error('Unsupported MedMemory oracle teacher artifact');
  const eligible=teacher.cases.filter(item=>item.training_eligible),types={};
  for(const item of eligible){
    const cell=types[item.query_type]||{case_count:0,target_count:0,reachability:{},source_session_count:0,oracle_step_count:0,action_sequences:{},evidence_role_patterns:{},action_role_patterns:{},decision_checks:{}};cell.case_count++;cell.target_count+=item.targets.length;cell.source_session_count+=new Set(item.targets.flatMap(target=>target.source_session_ids)).size;cell.oracle_step_count+=item.oracle_trajectory.length;
    for(const target of item.targets)cell.reachability[target.reachability]=(cell.reachability[target.reachability]||0)+1;
    const sequence=item.oracle_trajectory.map(step=>step.action).join('>');cell.action_sequences[sequence]=(cell.action_sequences[sequence]||0)+1;
    const evidenceRolePattern=[...new Set(item.targets.map(target=>target.evidence_role).filter(Boolean))].sort().join('>')||'none';cell.evidence_role_patterns[evidenceRolePattern]=(cell.evidence_role_patterns[evidenceRolePattern]||0)+1;
    for(const step of item.oracle_trajectory){const roles=[...new Set(step.expected_gain?.evidence_roles||[])].sort(),key=`${step.action}:${roles.join('+')||'none'}`;cell.action_role_patterns[key]=(cell.action_role_patterns[key]||0)+1;}
    for(const category of decisionCheckCategories(item.trap?.trap_design?.trap_type))cell.decision_checks[category]=(cell.decision_checks[category]||0)+1;
    types[item.query_type]=cell;
  }
  const summarized=Object.fromEntries(Object.entries(types).map(([type,cell])=>[type,{case_count:cell.case_count,mean_target_count:round(cell.target_count/cell.case_count),mean_source_session_count:round(cell.source_session_count/cell.case_count),mean_oracle_step_count:round(cell.oracle_step_count/cell.case_count),reachability_rates:Object.fromEntries(Object.entries(cell.reachability).map(([key,count])=>[key,round(count/Math.max(1,cell.target_count))])),recommended_action_paths:rankPatterns(cell.action_sequences).map(([path,count])=>({actions:path.split('>'),support:count})),recommended_evidence_role_patterns:rankPatterns(cell.evidence_role_patterns).map(([pattern,count])=>({evidence_roles:pattern==='none'?[]:pattern.split('>'),support:count})),action_evidence_role_patterns:rankPatterns(cell.action_role_patterns,8).map(([pattern,count])=>{const separator=pattern.indexOf(':'),action=pattern.slice(0,separator),roles=pattern.slice(separator+1);return{action,evidence_roles:roles==='none'?[]:roles.split('+'),support:count};}),decision_check_priors:rankPatterns(cell.decision_checks,12).map(([category,support])=>({category,support}))}]));
  const body={version:MEDMEMORY_STUDENT_SUMMARY_VERSION,runtime_eligible:true,source_teacher_version:teacher.version,source_teacher_hash:teacher.artifact_hash,compiled_strategy_version:strategy_version,compiled_strategy_profile_hash:strategy_profile_hash,training_scope:{clean_only:true,persona_count:teacher.training_persona_ids.length,holdout_persona_count:teacher.holdout_persona_id?1:0,case_count:eligible.length,teacher_read_question_text:true,teacher_read_gold_and_judge_metadata:true,runtime_retains_question_text:false,runtime_retains_case_ids:false,runtime_retains_persona_ids:false,runtime_retains_patient_facts:false,runtime_retains_gold_or_judge_content:false},query_types:typesToSortedObject(summarized)};
  const artifact={...body,artifact_hash:sha256(stableJson(body))};assertCaseFreeStudentArtifact(artifact,teacher);return artifact;
}

export function buildLeaveOnePersonaOutSummaries(datasetRoot,{strategy_version=null,strategy_profile_hash=null}={}){
  const fullTeacher=distillMedMemoryTeacher(datasetRoot);
  return fullTeacher.training_persona_ids.map(holdout=>{const teacher=buildHoldoutTeacherFromFullTeacher(fullTeacher,holdout),student=buildCaseFreeStudentSummary(teacher,{strategy_version,strategy_profile_hash});return{holdout_persona_id:holdout,teacher_hash:teacher.artifact_hash,student};});
}

export function assertCaseFreeStudentArtifact(student,teacher=null){
  const serialized=JSON.stringify(student),forbiddenKeys=new Set(['question','gold','answer','explanation','source_key_points','required_patient_info','common_wrong_answer','reasoning_chain','query_id','session_id','memory_id','target_text','target_id','target_ids','source_session_ids','annotated_session_id','persona_ids','holdout_persona_id','oracle_trajectory','objective','expected_gain','stop_condition','instruction_source']);
  visitKeys(student,key=>{if(forbiddenKeys.has(key))throw new Error(`Student artifact contains forbidden field ${key}`);});
  const scope=student.training_scope||{};
  if(student.runtime_eligible!==true||scope.teacher_read_question_text!==true||scope.teacher_read_gold_and_judge_metadata!==true||scope.runtime_retains_question_text!==false||scope.runtime_retains_case_ids!==false||scope.runtime_retains_persona_ids!==false||scope.runtime_retains_patient_facts!==false||scope.runtime_retains_gold_or_judge_content!==false)throw new Error('Student artifact does not disclose its Teacher inputs and safe runtime retention boundary');
  if(teacher)for(const item of teacher.cases){for(const value of[item.question,...item.correct_answers,...item.targets.map(target=>target.text)]){const needle=normalize(value);if(needle.length>=6&&normalize(serialized).includes(needle))throw new Error('Student artifact retained case-specific teacher text');}}
  return true;
}

function visitKeys(value,visitor){if(Array.isArray(value)){for(const item of value)visitKeys(item,visitor);return;}if(!value||typeof value!=='object')return;for(const[key,item]of Object.entries(value)){visitor(key);visitKeys(item,visitor);}}

function buildTeacherArtifact({training_persona_ids,holdout_persona_id,cases}){const body={version:MEDMEMORY_ORACLE_TEACHER_VERSION,runtime_eligible:false,oracle_metadata_used:true,clean_only:true,training_persona_ids,holdout_persona_id,case_count:cases.length,eligible_case_count:cases.filter(item=>item.training_eligible).length,cases};return{...body,artifact_hash:sha256(stableJson(body))};}

function distillCase(personaId,query,sessionMap){
  const querySession=Number(query.session_id),visibleSessions=[...sessionMap.values()].filter(item=>item.session_id<=querySession),correctAnswers=(query.answers||[]).filter(item=>item.is_correct).map(item=>String(item.content||'')),targets=[];
  const sourceTargets=teacherSourceKeyPoints(query).map(item=>targetFromAnnotation('source_key_point',item.content||item.name,item.session_id,visibleSessions,sessionMap,{instruction_source:'query.source_key_points'}));targets.push(...sourceTargets);
  for(const text of query.metadata?.trap_design?.required_patient_info||[])targets.push(targetFromAnnotation('required_patient_info',text,null,visibleSessions,sessionMap,{instruction_source:'metadata.trap_design.required_patient_info',preferred_session_ids:preferredSessionIds(text,sourceTargets,visibleSessions)}));
  for(const text of query.metadata?.required_memory_nodes||[])targets.push(targetFromAnnotation('required_memory_node',text,null,visibleSessions,sessionMap,{instruction_source:'metadata.required_memory_nodes',preferred_session_ids:preferredSessionIds(text,sourceTargets,visibleSessions)}));
  for(const node of query.metadata?.reasoning_chain||[])targets.push(targetFromAnnotation('reasoning_node',node.content,node.session_id,visibleSessions,sessionMap,{role:node.role,node_id:node.node_id,instruction_source:'metadata.reasoning_chain'}));
  const deduped=decorateTargets(dedupeTargets(targets),query.query_type),oracleTrajectory=buildOracleTrajectory(query.query_type,deduped),trainingEligible=correctAnswers.length>0;
  return{persona_id:personaId,query_id:String(query.query_id||''),query_type:String(query.query_type||''),query_session:querySession,question:String(query.question||''),correct_answers:correctAnswers,answer_explanations:(query.answers||[]).filter(item=>item.is_correct&&item.explanation).map(item=>String(item.explanation)),trap:query.metadata?.trap_design||query.metadata?.common_wrong_answer?{trap_design:query.metadata?.trap_design||null,common_wrong_answer:query.metadata?.common_wrong_answer||null}:null,targets:deduped,oracle_trajectory:oracleTrajectory,oracle_summary:oracleSummary(deduped,oracleTrajectory),teacher_action_path:oracleTrajectory.map(step=>step.action),training_eligible:trainingEligible,exclusion_reason:trainingEligible?null:'no correct answer'};
}

function teacherSourceKeyPoints(query){
  const points=query.source_key_points||[];if(query.query_type!=='state_update'||points.length<=8)return points;
  const needle=[query.question,...(query.answers||[]).filter(item=>item.is_correct).map(item=>item.content),query.metadata?.change_description].filter(Boolean).join(' '),ranked=points.map((item,index)=>({item,index,score:textSimilarity([item.name,item.content].filter(Boolean).join(' '),needle).score})).sort((a,b)=>b.score-a.score||Number(b.item.session_id||0)-Number(a.item.session_id||0)||a.index-b.index),selected=ranked.slice(0,8).map(item=>item.item);
  return selected.sort((a,b)=>Number(a.session_id||0)-Number(b.session_id||0));
}

function targetFromAnnotation(kind,text,annotatedSession,visibleSessions,sessionMap,extra={}){
  const{preferred_session_ids=[],...publicExtra}=extra,target=String(text||'').normalize('NFKC').trim(),hasAnnotatedSession=annotatedSession!==null&&annotatedSession!==undefined&&String(annotatedSession).trim()!=='',sessionId=hasAnnotatedSession?Number(annotatedSession):NaN,visibleSessionIds=new Set(visibleSessions.map(session=>session.session_id)),validAnnotated=Number.isInteger(sessionId)&&sessionId>0&&visibleSessionIds.has(sessionId),missingMechanismBridge=kind==='reasoning_node'&&sessionId===0;
  if(missingMechanismBridge)return{kind,text:target,...publicExtra,annotated_session_id:0,source_session_ids:[],match_score:0,reachability:'infer_missing_mechanism_bridge',search_eligible:false,reason:'No real Session 0 exists; infer this medical mechanism only after visible patient evidence is retrieved, never as a Search target.'};
  const preferredIds=[...new Set([...dateMatchedSessionIds(target,visibleSessions),...preferred_session_ids])].filter(id=>visibleSessionIds.has(id)),scope=validAnnotated?[sessionMap.get(sessionId)]:preferredIds.length?preferredIds.map(id=>sessionMap.get(id)):visibleSessions,best=bestSessionMatch(target,scope),reachability=!best||best.score<.08?'unreachable':best.exact?'direct_state_candidate':best.score>=.22?'paraphrase_candidate':'raw_dialogue_only',sourceSessionIds=reachability==='unreachable'?[]:[best.session.session_id],usedPreferred=!validAnnotated&&preferredIds.length>0;
  return{kind,text:target,...publicExtra,annotated_session_id:Number.isInteger(sessionId)?sessionId:null,source_session_ids:sourceSessionIds,match_score:round(best?.score||0),reachability,search_eligible:reachability!=='unreachable',reason:!validAnnotated&&hasAnnotatedSession?'Annotated Session is outside the real visible dialogue index; any source was recovered by visible-dialogue alignment.':usedPreferred&&best?`Aligned first to a same-query Source Key Point or explicit date in visible Session ${best.session.session_id}.`:best?.exact?'Annotation text is directly present in a visible Session.':best&&reachability!=='unreachable'?'Best visible dialogue match is paraphrastic or partial.':'No visible supporting Session passed the minimum alignment threshold.'};
}

function bestSessionMatch(text,sessions){let best=null;for(const session of sessions){const match=textSimilarity(text,session.transcript);if(!best||match.score>best.score)best={session,...match};}return best;}
function textSimilarity(left,right){const a=normalize(left),b=normalize(right);if(!a||!b)return{score:0,exact:false};if(b.includes(a))return{score:1,exact:true};const grams=value=>{const out=new Set();for(let i=0;i<value.length-1;i++)out.add(value.slice(i,i+2));return out;},x=grams(a),y=grams(b);let hits=0;for(const gram of x)if(y.has(gram))hits++;return{score:hits/Math.max(1,x.size),exact:false};}

function preferredSessionIds(text,sourceTargets,visibleSessions){
  const dated=dateMatchedSessionIds(text,visibleSessions);if(dated.length)return dated;
  const ranked=sourceTargets.map(target=>({target,score:textSimilarity(text,target.text).score,session_ids:target.source_session_ids.length?target.source_session_ids:Number(target.annotated_session_id)>0?[Number(target.annotated_session_id)]:[]})).filter(item=>item.session_ids.length).sort((left,right)=>right.score-left.score||left.session_ids[0]-right.session_ids[0]);
  if(!ranked.length||ranked[0].score<.22)return[];const floor=Math.max(.22,ranked[0].score-.03);return[...new Set(ranked.filter(item=>item.score>=floor).flatMap(item=>item.session_ids))].sort((a,b)=>a-b);
}

function dateMatchedSessionIds(text,sessions){const dates=dateHints(text);if(!dates.length)return[];return sessions.filter(session=>{const date=String(session.date||'').match(/(\d{4})-(\d{1,2})-(\d{1,2})/u);if(!date)return false;const full=`${date[1]}-${pad(date[2])}-${pad(date[3])}`,monthDay=`${pad(date[2])}-${pad(date[3])}`;return dates.some(item=>item===full||item===monthDay);}).map(session=>session.session_id);}
function dateHints(value){const text=String(value||'').normalize('NFKC'),out=[];for(const match of text.matchAll(/(\d{4})[年\-/.](\d{1,2})[月\-/.](\d{1,2})日?/gu))out.push(`${match[1]}-${pad(match[2])}-${pad(match[3])}`);for(const match of text.matchAll(/(?<!\d)(\d{1,2})月(\d{1,2})日/gu))out.push(`${pad(match[1])}-${pad(match[2])}`);return[...new Set(out)];}
function pad(value){return String(value).padStart(2,'0');}

function decorateTargets(values,type){return values.map((item,index)=>({...item,target_id:`target_${index+1}`,evidence_role:evidenceRole(type,item),search_eligible:item.reachability!=='infer_missing_mechanism_bridge'&&item.reachability!=='unreachable'&&item.source_session_ids.length>0}));}

function evidenceRole(type,target){
  if(target.reachability==='infer_missing_mechanism_bridge')return'missing_mechanism_bridge';
  if(type==='entity_exact_match')return'entity_fact';
  if(type==='temporal_localization')return'temporal_event_anchor';
  if(type==='state_update')return'longitudinal_state_observation';
  if(type==='multiple_choice')return target.kind==='required_patient_info'?'option_discriminator':'option_constraint_evidence';
  if(type==='inference_generation')return target.kind==='required_patient_info'?'patient_specific_decision_factor':'patient_specific_anchor';
  if(type==='multi_hop_clinical_deduction'){if(target.kind==='required_memory_node')return'multi_visit_fact_node';if(target.kind==='reasoning_node')return'causal_chain_observation';return'patient_history_anchor';}
  return'visible_patient_evidence';
}

function buildOracleTrajectory(type,targets){
  const searchable=targets.filter(target=>target.search_eligible),bridges=targets.filter(target=>target.reachability==='infer_missing_mechanism_bridge'),unreachable=targets.filter(target=>target.reachability==='unreachable'),steps=[];
  for(const group of greedyRetrievalBatches(searchable))steps.push(oracleStep({action:retrievalAction(type),objective:`Retrieve a compact visible Session batch covering ${roleText(group)}.`,targets:group,expected_gain:{new_reachable_targets:group.length,evidence_roles:rolesFor(group),source_session_count:sourceSessionsFor(group).length},stop_condition:'Stop when every listed reachable target has at least one visible supporting Session.',instruction_source:instructionSourcesFor(group)}));
  const allSourceSessions=sourceSessionsFor(searchable),relationAction=relationActionFor(type,allSourceSessions,searchable);
  if(relationAction)steps.push(oracleStep({action:relationAction,objective:relationObjective(type),targets:searchable,expected_gain:{relation_candidates:Math.max(1,allSourceSessions.length-1),evidence_roles:rolesFor(searchable)},stop_condition:relationStopCondition(type),instruction_source:'oracle visible-source chronology and target coverage'}));
  if(bridges.length)steps.push(oracleStep({action:'infer_missing_mechanism_bridge',objective:'Infer non-retrievable clinical mechanism bridges only after visible patient evidence is grounded.',targets:bridges,source_session_ids:allSourceSessions,expected_gain:{mechanism_bridges:bridges.length,evidence_roles:rolesFor(bridges)},stop_condition:allSourceSessions.length?'Stop when each bridge connects retrieved patient evidence without being represented as a remembered patient fact.':'Mark each bridge unsupported if no visible patient evidence can ground it.',instruction_source:'metadata.reasoning_chain where session_id=0 (offline teacher only)'}));
  if(unreachable.length)steps.push(oracleStep({action:'assess_unreachable_evidence_gap',objective:`Classify unresolved targets by ${roleText(unreachable)} without fabricating a source.`,targets:unreachable,expected_gain:{unreachable_targets_classified:unreachable.length,evidence_roles:rolesFor(unreachable)},stop_condition:'Stop after every unresolved target is explicitly excluded from Search coverage.',instruction_source:instructionSourcesFor(unreachable)}));
  steps.push(oracleStep({action:'verify_target_coverage',objective:'Verify reachable evidence coverage, inferred bridges, and unresolved gaps before answering.',targets,source_session_ids:allSourceSessions,expected_gain:{reachable_targets_to_verify:searchable.length,mechanism_bridges_to_verify:bridges.length,unresolved_targets_to_report:unreachable.length,evidence_roles:rolesFor(targets)},stop_condition:'Stop when every target is classified as grounded, inferred bridge, or unresolved.',instruction_source:'oracle reachability audit'}));
  steps.push(oracleStep({action:'answer_from_verified_evidence',objective:'Answer using only verified patient evidence and explicitly grounded reasoning.',targets,source_session_ids:allSourceSessions,expected_gain:{answer_readiness:true,evidence_roles:rolesFor(targets)},stop_condition:'Stop after producing the benchmark-format answer without exposing teacher metadata.',instruction_source:'benchmark answer contract after oracle coverage gate'}));
  return steps;
}

// This is deterministic bounded batching, not a proven globally shortest path
// or minimum set cover. The name and artifact metadata deliberately make that
// weaker claim explicit.
function greedyRetrievalBatches(targets){
  const sorted=[...targets].sort((left,right)=>(left.source_session_ids[0]??Infinity)-(right.source_session_ids[0]??Infinity)||left.evidence_role.localeCompare(right.evidence_role)||left.target_id.localeCompare(right.target_id)),groups=[];let group=[],sessions=new Set();
  for(const target of sorted){const nextSessions=new Set([...sessions,...target.source_session_ids]),wouldOverflow=group.length>=8||nextSessions.size>4;if(wouldOverflow&&group.length){groups.push(group);group=[];sessions=new Set();}group.push(target);for(const sessionId of target.source_session_ids)sessions.add(sessionId);}
  if(group.length)groups.push(group);return groups;
}

function retrievalAction(type){return({entity_exact_match:'search_entity_evidence',temporal_localization:'search_temporal_evidence',state_update:'trace_longitudinal_evidence',multiple_choice:'search_option_constraint_evidence',inference_generation:'search_patient_decision_evidence',multi_hop_clinical_deduction:'search_multi_visit_evidence'})[type]||'search_visible_patient_evidence';}
function relationActionFor(type,sourceSessions,targets){if(type==='multiple_choice'&&targets.length)return'compare_option_constraints';if(sourceSessions.length<2)return null;return({state_update:'trace_longitudinal_relations',inference_generation:'connect_patient_decision_evidence',multi_hop_clinical_deduction:'connect_multi_visit_evidence'})[type]||null;}
function relationObjective(type){if(type==='state_update')return'Order the retrieved observations for the same changing state and identify the latest supported transition.';if(type==='multiple_choice')return'Compare patient-specific constraints against every answer option independently.';if(type==='inference_generation')return'Connect patient-specific history, treatment response, and current decision evidence.';return'Connect retrieved multi-visit facts into the shortest supported causal chain.';}
function relationStopCondition(type){if(type==='state_update')return'Stop when the prior and latest supported state are chronologically resolved.';if(type==='multiple_choice')return'Stop when every option has an evidence-backed allow or reject status.';if(type==='inference_generation')return'Stop when the recommendation direction is supported by patient-specific evidence.';return'Stop when all retrievable chain observations are connected without inventing missing memory.';}
function oracleStep({action,objective,targets=[],source_session_ids=null,expected_gain={},stop_condition,instruction_source}){return{action,objective,source_session_ids:[...new Set(source_session_ids||sourceSessionsFor(targets))].filter(id=>Number.isInteger(id)&&id>0).sort((a,b)=>a-b),target_ids:targets.map(target=>target.target_id),expected_gain,stop_condition,instruction_source};}
function rolesFor(targets){return[...new Set(targets.map(target=>target.evidence_role).filter(Boolean))].sort();}
function roleText(targets){return`evidence roles: ${rolesFor(targets).join(', ')||'none'}`;}
function sourceSessionsFor(targets){return[...new Set(targets.flatMap(target=>target.source_session_ids||[]))].filter(id=>Number.isInteger(id)&&id>0).sort((a,b)=>a-b);}
function instructionSourcesFor(targets){return[...new Set(targets.map(target=>target.instruction_source).filter(Boolean))].sort().join(' + ')||'visible-dialogue alignment';}
function oracleSummary(targets,trajectory){return{algorithm:'greedy_bounded_visible_source_batching.v1',optimality_claim:'none',step_count:trajectory.length,retrieval_step_count:trajectory.filter(step=>/^(?:search|trace_longitudinal_evidence)/u.test(step.action)).length,reachable_target_count:targets.filter(target=>target.search_eligible).length,mechanism_bridge_count:targets.filter(target=>target.reachability==='infer_missing_mechanism_bridge').length,unreachable_target_count:targets.filter(target=>target.reachability==='unreachable').length,source_session_count:sourceSessionsFor(targets).length};}

const DECISION_CHECK_CATEGORIES=Object.freeze(['allergy','contraindication','interaction','longitudinal_update','preference','lifestyle','symptom_differential','dose_adjustment','dose_timing','monitoring','access','disease_stage','other_protocol_risk']);
function decisionCheckCategories(value){
  const text=String(value||'').normalize('NFKC').toLowerCase(),found=new Set();
  const add=(category,pattern)=>{if(pattern.test(text))found.add(category);};
  add('allergy',/allerg|过敏/u);add('contraindication',/contraindicat|禁忌|disease[_ -]?conflict/u);add('interaction',/interaction|相互作用/u);add('longitudinal_update',/temporal|纵向|变化|change|state|value[_ -]?memory/u);add('preference',/preference|compliance|偏好|依从/u);add('lifestyle',/lifestyle|生活方式/u);add('symptom_differential',/symptom|症状|归因|鉴别/u);add('dose_adjustment',/dosage|dose[_ -]?adjust|加量|减量/u);add('dose_timing',/timing|时机|给药方式/u);add('monitoring',/monitor|复查/u);add('access',/economic|费用|经济|access/u);add('disease_stage',/disease|疾病|progression/u);
  if(text&&!found.size)found.add('other_protocol_risk');
  return DECISION_CHECK_CATEGORIES.filter(category=>found.has(category));
}

function dedupeTargets(values){
  const out=[],indexByKey=new Map();for(const item of values){const normalized=normalize(item.text);if(!normalized)continue;const bridge=item.reachability==='infer_missing_mechanism_bridge',key=bridge?`bridge\0${item.node_id??''}\0${normalized}`:normalized,index=indexByKey.get(key);if(index===undefined){indexByKey.set(key,out.length);out.push({...item,annotation_kinds:[item.kind],instruction_sources:item.instruction_source?[item.instruction_source]:[],reasoning_nodes:item.kind==='reasoning_node'?[reasoningNodeSummary(item)]:[]});continue;}out[index]=mergeTargets(out[index],item);}return out;
}
function mergeTargets(current,next){const winner=targetRank(next)>targetRank(current)?next:current,source_session_ids=[...new Set([...current.source_session_ids,...next.source_session_ids])].sort((a,b)=>a-b),annotation_kinds=[...new Set([...(current.annotation_kinds||[current.kind]),next.kind])],instruction_sources=[...new Set([...(current.instruction_sources||[]),next.instruction_source].filter(Boolean))].sort(),reasoning_nodes=[...(current.reasoning_nodes||[]),...(next.kind==='reasoning_node'?[reasoningNodeSummary(next)]:[])];return{...winner,source_session_ids,annotation_kinds,instruction_sources,instruction_source:instruction_sources.join(' + '),reasoning_nodes};}
function targetRank(target){return({direct_state_candidate:40,paraphrase_candidate:30,raw_dialogue_only:20,unreachable:10,infer_missing_mechanism_bridge:0})[target.reachability]+({source_key_point:4,required_patient_info:3,required_memory_node:2,reasoning_node:1})[target.kind];}
function reasoningNodeSummary(target){return{node_id:target.node_id??null,role:target.role||null,annotated_session_id:target.annotated_session_id};}
function sessionRecord(value){return{session_id:Number(value.session_id),date:value.event_info?.date||null,transcript:(value.messages||[]).map(item=>`${item.role}: ${item.content}`).join('\n')};}
function personaDirectories(root){return readdirSync(root,{withFileTypes:true}).filter(item=>item.isDirectory()&&/^persona_\d+$/u.test(item.name)).map(item=>item.name).sort((a,b)=>Number(a.slice(8))-Number(b.slice(8)));}
function readJson(path){return JSON.parse(readFileSync(path,'utf8'));}
function normalize(value){return String(value||'').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu,'');}
function typesToSortedObject(value){return Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]]));}
function rankPatterns(value,limit=3){return Object.entries(value).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,limit);}
function round(value){return Math.round((Number(value)||0)*10000)/10000;}
function sha256(value){return createHash('sha256').update(String(value)).digest('hex');}
function stableJson(value){if(Array.isArray(value))return`[${value.map(stableJson).join(',')}]`;if(value&&typeof value==='object')return`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;return JSON.stringify(value);}
