import { assertNoHiddenBenchmarkInput } from './information-boundary.js';
import { INVESTIGATION_POLICY_NAVIGATION_PATH_POLICY,investigationPolicyWorkerCapabilityModelContext,registeredInvestigationStrategy } from './prompts.js';

export const QUESTION_REQUEST_VERSION='careharness-question-request.v4-public-benchmark-scope';
export const INVESTIGATION_STATE_VERSION='careharness-investigation-state.v1';
export const INVESTIGATION_DECISION_VERSION='careharness-investigation-decision.v1';

/**
 * The query boundary stores the user's question verbatim. A caller may attach
 * one disclosed task-level strategy profile, but never a case answer, target
 * node, retrieval term list, Gold, or Judge metadata. Investigation policy
 * still owns every concrete keyword, temporal and graph decision.
 */
export function createQuestionRequest(value){
  const question=String(value?.question??value??'').trim();
  if(!question)throw new Error('question request requires non-empty question text');
  const queryType=boundedText(value?.query_type??value?.task,80),strategyNamespace=boundedText(value?.strategy_namespace,40),scope=normalizeBenchmarkScope(value?.scope,strategyNamespace),strategyProfile=normalizeStrategyProfile(value?.strategy_profile,queryType,strategyNamespace);
  if(strategyProfile?.query_type&&queryType&&strategyProfile.query_type!==queryType)throw new Error('strategy profile query_type does not match question request');
  const request={version:QUESTION_REQUEST_VERSION,question,...(queryType?{query_type:queryType}:{}),...(strategyNamespace?{strategy_namespace:strategyNamespace}:{}),...(scope?{scope}:{}),...(strategyProfile?{strategy_profile:strategyProfile}:{}),information_boundary:{gold_or_judge_metadata_available:false,benchmark_task_label_available:Boolean(queryType),public_benchmark_scope_available:Boolean(scope),task_strategy_profile_available:Boolean(strategyProfile),strategy_namespace:strategyNamespace||null,query_preanalysis_performed:false}};
  assertNoHiddenBenchmarkInput(request,'question_request');
  return request;
}

export function createInvestigationState({request,snapshot={},history=[]}={}){
  const normalizedRequest=createQuestionRequest(request||'');
  const normalizedHistory=Array.isArray(history)?history:[];
  const state={version:INVESTIGATION_STATE_VERSION,request:normalizedRequest,snapshot:normalizeSnapshot(snapshot),history:normalizedHistory,turn:normalizedHistory.length+1};
  assertNoHiddenBenchmarkInput(state,'investigation_state');
  return state;
}

/**
 * The core validates only control fields. `instruction` is an opaque,
 * bounded worker payload; individual workers will own its schema when their
 * contracts are designed.  This prevents the orchestrator from becoming a
 * second static Query Planner.
 */
export function validateInvestigationDecision(value,{allowed_workers=[]}={}){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('investigation policy must return one JSON object');
  const worker=String(value.worker||'').normalize('NFKC').trim().toLowerCase(),allowed=new Set(allowed_workers.map(String));
  if(!allowed.has(worker))throw new Error(`investigation worker ${worker||'<empty>'} is not allowed`);
  const informationStatus=String(value.information_status||value.sufficiency||'unknown').normalize('NFKC').trim().toLowerCase();
  if(!['unknown','insufficient','sufficient'].includes(informationStatus))throw new Error('information_status must be unknown, insufficient, or sufficient');
  const rationale=boundedText(value.rationale??value.reason,320),instruction=normalizeOpaqueInstruction(value.instruction),investigationFocus=normalizeInvestigationFocus(value.investigation_focus);
  if(worker==='answer'&&informationStatus!=='sufficient')throw new Error('answer requires information_status=sufficient');
  const decision={version:INVESTIGATION_DECISION_VERSION,worker,information_status:informationStatus,instruction,rationale,...(investigationFocus?{investigation_focus:investigationFocus}:{})};
  assertNoHiddenBenchmarkInput(decision,'investigation_decision');
  return decision;
}

export function policyView(state,{allowed_workers=[],worker_capabilities={},remaining_budget=0}={}){
  const instructionProfiles={},capabilities=allowed_workers.map(name=>{const modelContext=investigationPolicyWorkerCapabilityModelContext(name,worker_capabilities[name]);if(!instructionProfiles[modelContext.instruction_profile])instructionProfiles[modelContext.instruction_profile]=modelContext.instruction_schema;return modelContext.capability;});
  const medLoCoMo=state.request.strategy_namespace==='medlocomo',allSteps=state.history.map(item=>({turn:item.turn,worker:item.decision.worker,information_status:item.decision.information_status,instruction:item.decision.instruction,effective_instruction:item.result?.trace?.effective_instruction||item.decision.instruction,rationale:item.decision.rationale,result_summary:item.result?.summary||null,changed:item.result?.changed??null,result_signal:discoveryResultSignal(item)})),previousSteps=medLoCoMo?allSteps.slice(-3):allSteps;
  const view={version:state.version,question:state.request.question,...(state.request.query_type?{query_type:state.request.query_type}:{}),...(state.request.strategy_namespace?{strategy_namespace:state.request.strategy_namespace}:{}),...(state.request.scope?{scope:state.request.scope}:{}),current_information:policySnapshot(state.snapshot,{compact_medlocomo:medLoCoMo}),...(medLoCoMo?{investigation_progress:medLoCoMoInvestigationProgress(state,allSteps)}:{}),previous_steps:previousSteps,remaining_budget,allowed_workers:[...allowed_workers],worker_capabilities:capabilities,instruction_profiles:instructionProfiles,information_boundary:state.request.information_boundary};
  assertNoHiddenBenchmarkInput(view,'investigation_policy');
  return view;
}

function normalizeSnapshot(value={}){
  const snapshot=value&&typeof value==='object'&&!Array.isArray(value)?value:{};
  return{
    strategy_profile:snapshot.strategy_profile&&typeof snapshot.strategy_profile==='object'?snapshot.strategy_profile:null,
    admission_overview:snapshot.admission_overview&&typeof snapshot.admission_overview==='object'?snapshot.admission_overview:null,
    investigation_focus:normalizeInvestigationFocus(snapshot.investigation_focus),
    role_coverage:Array.isArray(snapshot.role_coverage)?snapshot.role_coverage:null,
    coverage_state:snapshot.coverage_state&&typeof snapshot.coverage_state==='object'?snapshot.coverage_state:null,
    evidence_ledger:snapshot.evidence_ledger&&typeof snapshot.evidence_ledger==='object'?snapshot.evidence_ledger:null,
    search_instruction_prior:snapshot.search_instruction_prior&&typeof snapshot.search_instruction_prior==='object'?snapshot.search_instruction_prior:null,
    patient_profile:snapshot.patient_profile&&typeof snapshot.patient_profile==='object'?snapshot.patient_profile:null,
    temporal_gate:snapshot.temporal_gate&&typeof snapshot.temporal_gate==='object'?snapshot.temporal_gate:null,
    refinement_boundary:snapshot.refinement_boundary&&typeof snapshot.refinement_boundary==='object'?snapshot.refinement_boundary:null,
    recent_sessions:Array.isArray(snapshot.recent_sessions)?snapshot.recent_sessions:[],
    memory_nodes:Array.isArray(snapshot.memory_nodes)?snapshot.memory_nodes:[],
    memory_edges:Array.isArray(snapshot.memory_edges)?snapshot.memory_edges:[],
    navigation_paths:policyNavigationPaths(snapshot.navigation_paths),
    verification:snapshot.verification||null,
    assessment:snapshot.assessment||null,
    answer_brief:snapshot.answer_brief||null,
    worker_state:snapshot.worker_state||null,
  };
}

function policySnapshot(snapshot={},options={}){
  const nodeKeys=['memory_id','text','families','event_time','episode_id','turn_id','source_type','certainty','polarity','factor_key','status','version','operation'],edgeKeys=['edge_id','from_memory_id','to_memory_id','edge_family','relation_type','status','confidence','support_memory_ids','persistent','causal_claim'],pick=(value,keys)=>Object.fromEntries(keys.filter(key=>value?.[key]!=null).map(key=>[key,value[key]]));
  const compact=options.compact_medlocomo===true,nodeRows=(snapshot.memory_nodes||[]).map(node=>({...pick(node,nodeKeys),...(node?.construction_kind==='literal_provenance'?{construction_kind:'literal_provenance'}:{})})),assessment=snapshot.assessment||null;
  if(compact)for(const node of nodeRows)if(typeof node.text==='string')node.text=node.text.slice(0,360);
  return{strategy_profile:snapshot.strategy_profile||null,search_instruction_prior:snapshot.search_instruction_prior||null,admission_overview:snapshot.admission_overview||null,investigation_focus:snapshot.investigation_focus||null,coverage_state:snapshot.coverage_state||null,role_coverage:snapshot.role_coverage||assessment?.role_coverage||null,temporal_gate:snapshot.temporal_gate||null,refinement_boundary:snapshot.refinement_boundary||null,patient_profile:snapshot.patient_profile||null,recent_sessions:(snapshot.recent_sessions||[]).map(session=>({...pick(session,['episode_id','event_time']),verbatim_available_to_assess_and_answer:true})),memory_nodes:nodeRows,memory_edges:(snapshot.memory_edges||[]).map(edge=>pick(edge,edgeKeys)),navigation_paths:policyNavigationPaths(snapshot.navigation_paths),navigation_path_policy:INVESTIGATION_POLICY_NAVIGATION_PATH_POLICY,verification:snapshot.verification?{complete:snapshot.verification.complete,rejected_memory_ids:snapshot.verification.rejected_memory_ids||[],overflow:snapshot.verification.overflow===true,overflow_count:Number(snapshot.verification.overflow_count||0),limit:snapshot.verification.limit??null,requires_refine:snapshot.verification.requires_refine===true,policy:snapshot.verification.policy||null}:null,assessment:compact?compactAssessment(assessment):assessment,answer_brief:compact?null:snapshot.answer_brief||null,worker_state:snapshot.worker_state?{last_worker:snapshot.worker_state.last_worker||null,...workerTraceSignal(snapshot.worker_state.trace)}:null};
}

function normalizeInvestigationFocus(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const target=boundedText(value.target,180),comparisonAxis=boundedText(value.comparison_axis,160),scope=boundedText(value.scope,80),stopCondition=boundedText(value.stop_condition,200),coveredRoles=boundedStringArray(value.covered_roles,16,160),missingRoles=boundedStringArray(value.missing_roles,8,240),excludedInterpretations=boundedStringArray(value.excluded_interpretations,4,140);
  if(!target&&!comparisonAxis&&!coveredRoles.length&&!missingRoles.length)return null;
  return{target,scope,comparison_axis:comparisonAxis,covered_roles:coveredRoles,missing_roles:missingRoles,excluded_interpretations:excludedInterpretations,stop_condition:stopCondition};
}

function compactAssessment(value){
  if(!value||typeof value!=='object')return null;
  return{assessment:value.assessment||null,covered_aspects:(value.covered_aspects||[]).slice(0,12),answer_focus:(value.answer_focus||[]).slice(0,16),role_coverage:(value.role_coverage||[]).slice(0,64),occurrence_candidates:(value.occurrence_candidates||[]).slice(0,80).map(item=>({event_key:item.event_key,admission_id:item.admission_id,site:item.site,event_status:item.event_status,included:item.included,source_refs:item.source_refs,exclusion_reason:item.exclusion_reason})),counting:value.counting||null,missing_information:(value.missing_information||[]).slice(0,8)};
}

function medLoCoMoInvestigationProgress(state,steps){
  const counts={};for(const step of steps)counts[step.worker]=(counts[step.worker]||0)+1;
  const snapshot=state.snapshot||{},coverage=snapshot.role_coverage||snapshot.assessment?.role_coverage||null;
  return{step_count:steps.length,worker_counts:counts,current_focus:snapshot.investigation_focus||null,coverage_state:snapshot.coverage_state||null,role_coverage:coverage,last_result:steps.at(-1)?.result_summary||null,no_progress_discovery_streak:noProgressStreak(steps)};
}
function noProgressStreak(steps){let count=0;for(let index=steps.length-1;index>=0;index--){const row=steps[index];if(!['search','context','trace'].includes(row.worker)||row.changed!==false)break;count++;}return count;}
function boundedStringArray(value,limit,itemLimit){return(Array.isArray(value)?value:[]).map(item=>boundedText(item,itemLimit)).filter(Boolean).slice(0,limit);}

function normalizeStrategyProfile(value,queryType,strategyNamespace){
  if(value==null)return null;
  if(!strategyNamespace)throw new Error('strategy_profile requires an explicit strategy_namespace');
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('strategy_profile must be one object');
  const copy=JSON.parse(JSON.stringify(value)),serialized=JSON.stringify(copy);
  if(serialized.length>8000)throw new Error('strategy_profile exceeds bounded size');
  const allowed=new Set(['version','query_type','strategy_id','answer_memory_limit','answer_focus_limit','evidence_admission_p90','reasoning_hypotheses','target_only_assessment','disabled_workers','evidence_contract','preferred_path','stop_condition','policy_directive']);
  for(const key of Object.keys(copy))if(!allowed.has(key))throw new Error(`strategy_profile contains unsupported field ${key}`);
  assertNoHiddenBenchmarkInput(copy,'question_request.strategy_profile');
  const registered=registeredInvestigationStrategy(queryType,strategyNamespace);
  if(!registered)throw new Error(`strategy_profile is not registered for ${strategyNamespace}:${queryType||'<empty>'}`);
  if(stableJson(copy)!==stableJson(registered))throw new Error('strategy_profile must exactly match the server-side registered profile for query_type');
  return copy;
}

function stableJson(value){if(Array.isArray(value))return`[${value.map(stableJson).join(',')}]`;if(value&&typeof value==='object')return`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;return JSON.stringify(value);}

function normalizeBenchmarkScope(value,strategyNamespace){
  const scope=boundedText(value,40);
  if(!scope)return'';
  if(!['single_admission','cross_admission'].includes(scope))throw new Error(`question request scope must be single_admission or cross_admission, received ${scope}`);
  if(strategyNamespace!=='medlocomo')throw new Error('question request scope is available only in the medlocomo strategy namespace');
  return scope;
}

function discoveryResultSignal(item){
  const trace=item?.result?.trace||{},signal=workerTraceSignal(trace);
  return Object.keys(signal).length?signal:null;
}
function workerTraceSignal(trace={}){
  const source=trace?.result_signal&&typeof trace.result_signal==='object'?trace.result_signal:trace,worker=String(source.worker||trace.worker||''),selected=finite(source.selected_count??trace.selected_memory_count),candidate=finite(source.candidate_count??trace.candidate_count),selectedEpisodes=finite(source.selected_episode_count??trace.selected_episode_count),candidateEpisodes=finite(source.candidate_episode_count??trace.candidate_episode_count),newNodeCount=finite(source.new_node_count??trace.new_node_count),pathCount=finite(source.path_count??trace.path_count),unconnectedTargetCount=finite(source.unconnected_target_count??trace.unconnected_target_count),discovery=['search','context','trace'].includes(worker)||[selected,candidate,selectedEpisodes,candidateEpisodes,newNodeCount].some(value=>value!==null),zero=source.zero_recall===true||trace.zero_recall===true||(discovery&&selected===0),navigationPaths=policyNavigationPaths(trace.navigation_paths);
  if(!discovery&&!trace.embedding?.status&&!navigationPaths.length)return{};
  return Object.fromEntries(Object.entries({worker:worker||undefined,selected_count:selected,candidate_count:candidate,selected_episode_count:selectedEpisodes,candidate_episode_count:candidateEpisodes,new_node_count:newNodeCount,path_count:pathCount,unconnected_target_count:unconnectedTargetCount,zero_recall:discovery?zero:undefined,navigation_paths:navigationPaths.length?navigationPaths:undefined,embedding_status:trace.embedding?.status||undefined}).filter(([,value])=>value!==null&&value!==undefined));
}
function policyNavigationPaths(value){return(Array.isArray(value)?value:[]).slice(0,6).map(path=>({target_memory_id:String(path?.target_memory_id||''),memory_ids:(Array.isArray(path?.memory_ids)?path.memory_ids:[]).map(String).filter(Boolean).slice(0,6),navigation_step_count:Math.max(0,Number(path?.navigation_step_count)||0),semantics:'navigation_only_non_causal',establishes_patient_fact:false,establishes_causal_relation:false,navigation_links:(Array.isArray(path?.navigation_links)?path.navigation_links:[]).slice(0,5).map(link=>({from_memory_id:String(link?.from_memory_id||''),to_memory_id:String(link?.to_memory_id||''),link_kind:String(link?.link_kind||'unknown_navigation_link'),edge_id:link?.edge_id?String(link.edge_id):null,pseudo:link?.pseudo===true,navigation_only:true,establishes_patient_fact:false,establishes_causal_relation:false})).filter(link=>link.from_memory_id&&link.to_memory_id)})).filter(path=>path.target_memory_id&&path.memory_ids.length);}
function finite(value){const number=Number(value);return Number.isFinite(number)?number:null;}

function normalizeOpaqueInstruction(value){
  if(value==null)return{};
  if(typeof value==='string')return{objective:boundedText(value,500)};
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('instruction must be a JSON object or string');
  const serialized=JSON.stringify(value);
  if(serialized.length>4000)throw new Error('instruction exceeds bounded size');
  const copy=JSON.parse(serialized);
  assertNoHiddenBenchmarkInput(copy,'investigation_worker_instruction');
  return copy;
}

function boundedText(value,limit){return String(value||'').normalize('NFKC').trim().slice(0,limit);}
