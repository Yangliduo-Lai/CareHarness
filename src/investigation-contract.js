import { assertNoHiddenBenchmarkInput } from './information-boundary.js';
import { INVESTIGATION_POLICY_NAVIGATION_PATH_POLICY,investigationPolicyWorkerCapabilityModelContext,medMemoryInvestigationStrategy } from './prompts.js';

export const QUESTION_REQUEST_VERSION='careharness-question-request.v2-transparent-strategy';
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
  const queryType=boundedText(value?.query_type??value?.task,80),strategyProfile=normalizeStrategyProfile(value?.strategy_profile,queryType);
  if(strategyProfile?.query_type&&queryType&&strategyProfile.query_type!==queryType)throw new Error('strategy profile query_type does not match question request');
  const request={version:QUESTION_REQUEST_VERSION,question,...(queryType?{query_type:queryType}:{}),...(strategyProfile?{strategy_profile:strategyProfile}:{}),information_boundary:{gold_or_judge_metadata_available:false,benchmark_task_label_available:Boolean(queryType),task_strategy_profile_available:Boolean(strategyProfile),query_preanalysis_performed:false}};
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
  const rationale=boundedText(value.rationale??value.reason,320),instruction=normalizeOpaqueInstruction(value.instruction);
  if(worker==='answer'&&informationStatus!=='sufficient')throw new Error('answer requires information_status=sufficient');
  const decision={version:INVESTIGATION_DECISION_VERSION,worker,information_status:informationStatus,instruction,rationale};
  assertNoHiddenBenchmarkInput(decision,'investigation_decision');
  return decision;
}

export function policyView(state,{allowed_workers=[],worker_capabilities={},remaining_budget=0}={}){
  const instructionProfiles={},capabilities=allowed_workers.map(name=>{const modelContext=investigationPolicyWorkerCapabilityModelContext(name,worker_capabilities[name]);if(!instructionProfiles[modelContext.instruction_profile])instructionProfiles[modelContext.instruction_profile]=modelContext.instruction_schema;return modelContext.capability;});
  const view={version:state.version,question:state.request.question,...(state.request.query_type?{query_type:state.request.query_type}:{}),current_information:policySnapshot(state.snapshot),previous_steps:state.history.map(item=>({turn:item.turn,worker:item.decision.worker,information_status:item.decision.information_status,instruction:item.decision.instruction,effective_instruction:item.result?.trace?.effective_instruction||item.decision.instruction,rationale:item.decision.rationale,result_summary:item.result?.summary||null,changed:item.result?.changed??null,result_signal:discoveryResultSignal(item)})),remaining_budget,allowed_workers:[...allowed_workers],worker_capabilities:capabilities,instruction_profiles:instructionProfiles,information_boundary:state.request.information_boundary};
  assertNoHiddenBenchmarkInput(view,'investigation_policy');
  return view;
}

function normalizeSnapshot(value={}){
  const snapshot=value&&typeof value==='object'&&!Array.isArray(value)?value:{};
  return{
    strategy_profile:snapshot.strategy_profile&&typeof snapshot.strategy_profile==='object'?snapshot.strategy_profile:null,
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

function policySnapshot(snapshot={}){
  const nodeKeys=['memory_id','text','families','event_time','episode_id','turn_id','source_type','certainty','polarity','factor_key','status','version','operation'],edgeKeys=['edge_id','from_memory_id','to_memory_id','edge_family','relation_type','status','confidence','support_memory_ids','persistent','causal_claim'],pick=(value,keys)=>Object.fromEntries(keys.filter(key=>value?.[key]!=null).map(key=>[key,value[key]]));
  return{strategy_profile:snapshot.strategy_profile||null,temporal_gate:snapshot.temporal_gate||null,refinement_boundary:snapshot.refinement_boundary||null,patient_profile:snapshot.patient_profile||null,recent_sessions:(snapshot.recent_sessions||[]).map(session=>({...pick(session,['episode_id','event_time']),verbatim_available_to_assess_and_answer:true})),memory_nodes:(snapshot.memory_nodes||[]).map(node=>pick(node,nodeKeys)),memory_edges:(snapshot.memory_edges||[]).map(edge=>pick(edge,edgeKeys)),navigation_paths:policyNavigationPaths(snapshot.navigation_paths),navigation_path_policy:INVESTIGATION_POLICY_NAVIGATION_PATH_POLICY,verification:snapshot.verification?{complete:snapshot.verification.complete,rejected_memory_ids:snapshot.verification.rejected_memory_ids||[],overflow:snapshot.verification.overflow===true,overflow_count:Number(snapshot.verification.overflow_count||0),limit:snapshot.verification.limit??null,requires_refine:snapshot.verification.requires_refine===true,policy:snapshot.verification.policy||null}:null,assessment:snapshot.assessment||null,answer_brief:snapshot.answer_brief||null,worker_state:snapshot.worker_state?{last_worker:snapshot.worker_state.last_worker||null,...workerTraceSignal(snapshot.worker_state.trace)}:null};
}

function normalizeStrategyProfile(value,queryType){
  if(value==null)return null;
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('strategy_profile must be one object');
  const copy=JSON.parse(JSON.stringify(value)),serialized=JSON.stringify(copy);
  if(serialized.length>8000)throw new Error('strategy_profile exceeds bounded size');
  const allowed=new Set(['version','query_type','strategy_id','answer_memory_limit','answer_focus_limit','reasoning_hypotheses','target_only_assessment','disabled_workers','evidence_contract','preferred_path','stop_condition','policy_directive']);
  for(const key of Object.keys(copy))if(!allowed.has(key))throw new Error(`strategy_profile contains unsupported field ${key}`);
  assertNoHiddenBenchmarkInput(copy,'question_request.strategy_profile');
  const registered=medMemoryInvestigationStrategy(queryType);
  if(!registered)throw new Error(`strategy_profile is not registered for query_type ${queryType||'<empty>'}`);
  if(stableJson(copy)!==stableJson(registered))throw new Error('strategy_profile must exactly match the server-side registered profile for query_type');
  return copy;
}

function stableJson(value){if(Array.isArray(value))return`[${value.map(stableJson).join(',')}]`;if(value&&typeof value==='object')return`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;return JSON.stringify(value);}

function discoveryResultSignal(item){
  const trace=item?.result?.trace||{},signal=workerTraceSignal(trace);
  return Object.keys(signal).length?signal:null;
}
function workerTraceSignal(trace={}){
  const source=trace?.result_signal&&typeof trace.result_signal==='object'?trace.result_signal:trace,worker=String(source.worker||trace.worker||''),selected=finite(source.selected_count??trace.selected_memory_count),candidate=finite(source.candidate_count??trace.candidate_count),newNodeCount=finite(source.new_node_count??trace.new_node_count),pathCount=finite(source.path_count??trace.path_count),unconnectedTargetCount=finite(source.unconnected_target_count??trace.unconnected_target_count),discovery=['search','context','trace'].includes(worker)||selected!==null||newNodeCount!==null,zero=source.zero_recall===true||trace.zero_recall===true||(discovery&&selected===0),navigationPaths=policyNavigationPaths(trace.navigation_paths);
  if(!discovery&&!trace.embedding?.status&&!navigationPaths.length)return{};
  return Object.fromEntries(Object.entries({worker:worker||undefined,selected_count:selected,candidate_count:candidate,new_node_count:newNodeCount,path_count:pathCount,unconnected_target_count:unconnectedTargetCount,zero_recall:discovery?zero:undefined,navigation_paths:navigationPaths.length?navigationPaths:undefined,embedding_status:trace.embedding?.status||undefined}).filter(([,value])=>value!==null&&value!==undefined));
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
