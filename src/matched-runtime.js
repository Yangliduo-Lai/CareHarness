import { buildWorkingMemory,searchMemory,verifyWorkingMemory } from './careharness-actions.js';
import { MATCHED_EVALUATION_MODE } from './careharness-contract.js';
import { assertNoHiddenBenchmarkInput } from './information-boundary.js';
import { createQuestionRequest,validateInvestigationDecision } from './investigation-contract.js';
import { runInvestigation } from './investigation-runtime.js';
import { createMemoryInvestigationWorkers,deriveQuestionTemporalGate } from './investigation-workers.js';
import { PROMPTS } from './prompts.js';
import { assertStaticCareHarnessMode,positiveInteger } from './matched-utils.js';
import { explicitDatesInText as datesInPolicyText,explicitMonthsInText as monthsInPolicyText } from './temporal-expressions.js';

const RELATION_EVALUATOR_CALL_BUDGET=2;

/**
 * Synchronous diagnostic path for an explicitly supplied worker instruction.
 * Formal experiments use the adaptive closed loop below.
 */
export function buildDiagnosticInvestigationContext({evaluation_mode=MATCHED_EVALUATION_MODE,item,question_request,instruction={},memory_nodes=[],memory_edges=[],candidate_budget=24}={}){
  assertStaticCareHarnessMode(evaluation_mode);
  const request=createQuestionRequest(question_request||item||''),candidateLimit=positiveInteger(candidate_budget,'candidate_budget'),answerLimit=Math.min(candidateLimit,16),searched=searchMemory(request,memory_nodes,memory_edges,instruction,{limit:answerLimit}),verification=verifyWorkingMemory(searched.memory_nodes,searched.memory_edges,{limit:answerLimit});
  return finalizeContext({evaluation_mode,request,snapshot:{memory_nodes:verification.memory_nodes,memory_edges:verification.memory_edges,verification,assessment:null,worker_state:null},history:[],termination_reason:'single_explicit_instruction'});
}

/**
 * Formal adaptive runtime. There is no Query Planner call or semantic query
 * decomposition. Every retrieval direction is created on the turn where the
 * policy selects a worker. A deterministic calendar gate may be attached to
 * state solely to make an explicit date in the original question enforceable.
 */
export async function buildAdaptiveInvestigationContext({evaluation_mode=MATCHED_EVALUATION_MODE,item,question_request,patient_profile=null,recent_sessions=[],memory_nodes=[],memory_edges=[],candidate_budget=24,investigation_budget=6,state_projection=false,relation_evaluator,embedding_retriever,investigation_policy}={}){
  assertStaticCareHarnessMode(evaluation_mode);
  const request=createQuestionRequest(question_request||item||'');
  if(typeof investigation_policy!=='function')return buildDiagnosticInvestigationContext({evaluation_mode,item,question_request:request,instruction:{},memory_nodes,memory_edges,candidate_budget});
  assertNoHiddenRuntimeInput({request,patient_profile,recent_sessions,memory_nodes,memory_edges});
  const strategy=request.strategy_profile||null,candidateLimit=positiveInteger(candidate_budget,'candidate_budget'),profileAnswerLimit=strategy?.answer_memory_limit!=null?positiveInteger(strategy.answer_memory_limit,'strategy answer_memory_limit'):null,answerFocusLimit=strategy?.answer_focus_limit!=null?positiveInteger(strategy.answer_focus_limit,'strategy answer_focus_limit'):16,answerLimit=profileAnswerLimit!=null?Math.min(candidateLimit,profileAnswerLimit):state_projection?candidateLimit:Math.min(candidateLimit,16),temporalGate=deriveQuestionTemporalGate(request),allowReasoningHypotheses=strategy?strategy.reasoning_hypotheses===true:!state_projection&&!asksForDirectFact(request.question),targetOnly=strategy?.target_only_assessment===true,exactEntity=request.query_type==='entity_exact_match'||strategy?.strategy_id==='exact_entity';
  let relationEvaluatorCalls=0;
  const budgetedRelationEvaluator=typeof relation_evaluator==='function'?async input=>{
    if(relationEvaluatorCalls>=RELATION_EVALUATOR_CALL_BUDGET)throw new Error(`relation evaluator call budget exceeded (${RELATION_EVALUATOR_CALL_BUDGET})`);
    relationEvaluatorCalls++;return relation_evaluator(input);
  }:relation_evaluator;
  const workers=createMemoryInvestigationWorkers({question_request:request,memory_nodes,memory_edges,candidate_budget:candidateLimit,answer_memory_limit:answerLimit,answer_focus_limit:answerFocusLimit,relation_evaluator:budgetedRelationEvaluator,embedding_retriever,temporal_gate:temporalGate,allow_reasoning_hypotheses:allowReasoningHypotheses,target_only_focus_roles:targetOnly,exact_entity:exactEntity,conservative_refine:state_projection});
  workers.answer=instrumentAnswerWorker(workers.answer,answerLimit);
  const disabled=new Set(array(strategy?.disabled_workers).map(String)),workerNames=Object.keys(workers).filter(name=>!disabled.has(name)),budget=positiveInteger(investigation_budget,'investigation_budget')+1;
  const outcome=await runInvestigation({request,initial_snapshot:emptySnapshot(patient_profile,recent_sessions,temporalGate,state_projection,strategy),policy:investigation_policy,workers,budget,allowed_workers:({state,remaining_budget})=>availableWorkers(workerNames,state.snapshot,remaining_budget,answerLimit,state.history,request,{conservative_refine:state_projection,relation_evaluator_call_budget:RELATION_EVALUATOR_CALL_BUDGET}),fallback_decision:(input,cause)=>fallback_decision(input,cause,answerLimit),decision_validator:(value,input)=>validateInvestigationPolicyDecision(value,input)});
  return finalizeContext({evaluation_mode,request,snapshot:outcome.state.snapshot,history:outcome.history,termination_reason:outcome.termination_reason});
}

export function validateInvestigationPolicyDecision(value,input={}){
  const decision=validateInvestigationDecision(value,{allowed_workers:input.allowed_workers||[]});
  const assigned=String(input.action_exploration_assignment?.worker||'');if(assigned&&decision.worker!==assigned)throw new Error(`training exploration assigned ${assigned}, but policy returned ${decision.worker}`);
  if(decision.worker==='search'&&!hasDirectedSearchInstruction(decision.instruction))throw new Error('search requires literal terms, numeric/lens probes, or an exact date/Session/Memory scope; source_types and required_families alone are too broad');
  if(decision.worker==='search'&&targetsOnlyAlwaysVisibleRecentSessions(decision.instruction,input.current_information))throw new Error('search cannot target only always-visible recent Sessions; assess their supplied verbatim transcripts directly or search the older chart without those episode_ids');
  validatePolicyTemporalScope(decision,input);
  if(['search','context','trace'].includes(decision.worker)&&repeatsKnownNoProgressStep(decision,input.previous_steps))throw new Error(`${decision.worker} repeats the same effective no-progress direction; change the probe, relax a guessed constraint, or switch operation`);
  return decision;
}
export function fallbackInvestigationPolicyDecision(input={}){return fallback_decision(input);}

function fallback_decision(input,_cause=null,candidateLimit=24){
  const primary=fallbackDecisionCandidate(input,candidateLimit),candidates=[primary,...safeFallbackAlternatives(input,candidateLimit)];let lastError=null;
  for(const candidate of candidates){try{return validateInvestigationPolicyDecision(candidate,input);}catch(error){lastError=error;}}
  throw lastError||new Error('no validator-compliant investigation fallback is available');
}

function fallbackDecisionCandidate(input,candidateLimit=24){
  const allowed=input.allowed_workers||[],hasMemory=array(input.current_information?.memory_nodes).length>0,hasInformation=hasMemory||array(input.current_information?.recent_sessions).length>0||Number(input.current_information?.patient_profile?.item_count||0)>0,question=String(input.question||'').slice(0,500),needsDatedSearch=!hasMemory&&datesInPolicyText(question).length>0&&allowed.includes('search');
  const assigned=String(input.action_exploration_assignment?.worker||'');if(assigned&&allowed.includes(assigned))return fallbackForWorker(assigned,input,candidateLimit,'execute the recorded training-only safe exploration assignment');
  if(allowed.length===1&&allowed[0]==='answer')return{worker:'answer',information_status:'sufficient',instruction:{},rationale:'freeze the best available information at the investigation budget boundary'};
  if(allowed.includes('answer')&&input.current_information?.verification?.complete===true)return{worker:'answer',information_status:'sufficient',instruction:{},rationale:'current information passed deterministic verification'};
  if(allowed.includes('refine')&&hasMemory&&!allowed.includes('verify')&&!allowed.includes('answer')){
    const visibleIds=array(input.current_information?.memory_nodes).map(node=>String(node?.memory_id||'')).filter(Boolean),selectedIds=semanticSelectionIds(input.current_information,visibleIds),memoryIds=(selectedIds.length?selectedIds:visibleIds).slice(0,candidateLimit);
    return{worker:'refine',information_status:'insufficient',instruction:{memory_ids:memoryIds,...fallbackRefinementTemporalInstruction(question,input.current_information,memoryIds)},rationale:'explicitly reduce overflowing information before verification'};
  }
  const worker=needsDatedSearch?'search':hasInformation&&allowed.includes('verify')?'verify':allowed.includes('search')?'search':allowed.includes('context')?'context':allowed[0];
  const instruction={objective:question};
  // This is a turn-local safety fallback after the Policy has already chosen
  // Search and failed validation. It does not add fields to Question Request or
  // create a persistent/static query plan.
  if(worker==='search')Object.assign(instruction,fallbackTemporalInstruction(question,input.current_information?.refinement_boundary));
  return{worker,information_status:'insufficient',instruction,rationale:'safe policy-turn fallback using the original question verbatim'};
}

function safeFallbackAlternatives(input,candidateLimit){
  const assigned=String(input.action_exploration_assignment?.worker||''),allowed=array(input.allowed_workers).map(String).filter(worker=>!assigned||worker===assigned),order=['answer','verify','assess','refine','context','trace','search'],out=[];
  for(const worker of order)if(allowed.includes(worker)){out.push(fallbackForWorker(worker,input,candidateLimit,'validator-compliant bounded fallback',true));if(worker==='search')out.push(fallbackForWorker(worker,input,candidateLimit,'validator-compliant alternate search fallback',2));}
  return out;
}

function fallbackForWorker(worker,input,candidateLimit,rationale,alternate=false){
  const question=String(input.question||'').slice(0,500),visibleIds=array(input.current_information?.memory_nodes).map(node=>String(node?.memory_id||'')).filter(Boolean),selectedIds=semanticSelectionIds(input.current_information,visibleIds),memoryIds=(selectedIds.length?selectedIds:visibleIds).slice(0,candidateLimit),information_status=worker==='answer'?'sufficient':'insufficient';let instruction={};
  if(worker==='search')instruction=alternate===2?{expansion_terms:[question],term_match:'any',expand_graph:true,...fallbackTemporalInstruction(question,input.current_information?.refinement_boundary)}:{search_terms:[question],term_match:'any',expand_graph:Boolean(alternate),...fallbackTemporalInstruction(question,input.current_information?.refinement_boundary)};
  else if(worker==='context')instruction=memoryIds.length?{memory_ids:memoryIds.slice(0,3)}:{objective:question};
  else if(worker==='trace')instruction={seed_memory_ids:memoryIds.slice(0,6),depth:1,include_same_factor:true,include_same_concept:true};
  else if(worker==='assess')instruction={objective:'assess whether the currently visible patient information is sufficient'};
  else if(worker==='refine')instruction={memory_ids:memoryIds,...fallbackRefinementTemporalInstruction(question,input.current_information,memoryIds)};
  return{worker,information_status,instruction,rationale};
}

function availableWorkers(workerNames,snapshot,remainingBudget,answerLimit,history=[],request={},options={}){
  const conservativeRefine=options.conservative_refine===true,nodes=array(snapshot.memory_nodes),hasMemory=nodes.length>0,hasRecent=array(snapshot.recent_sessions).length>0,hasProfile=Number(snapshot.patient_profile?.item_count||0)>0,hasInformation=hasMemory||hasRecent||hasProfile,verified=snapshot.verification?.complete===true,assessment=snapshot.assessment,missing=array(assessment?.missing_information).filter(Boolean),assessmentSettled=assessment?.assessment==='supported'&&missing.length===0,visibleIds=nodes.map(node=>String(node?.memory_id||'')).filter(Boolean),selectedIds=semanticSelectionIds(snapshot,visibleIds),semanticRefine=Boolean(!conservativeRefine&&assessmentSettled&&selectedIds.length&&selectedIds.length<visibleIds.length),overflow=nodes.length>answerLimit||snapshot.verification?.requires_refine===true,needsRefine=overflow||semanticRefine,answerAvailable=workerNames.includes('answer'),lastWorker=String(snapshot.worker_state?.last_worker||''),freshEvidence=['search','context','trace'].includes(lastWorker),noProgressDiscoveryStreak=countNoProgressDiscoveryStreak(history),relativeGate=snapshot.temporal_gate?.hard===true&&snapshot.temporal_gate?.kind==='relative_documentation_window',lastSearchHits=Number(snapshot.worker_state?.trace?.selected_memory_count||0)>0;
  const relationBudget=Math.max(0,Number(options.relation_evaluator_call_budget)||0),relationCalls=array(history).filter(record=>record?.decision?.worker==='assess').length;
  if(relationBudget&&relationCalls>=relationBudget)workerNames=workerNames.filter(name=>name!=='assess');
  // The last budgeted turn always freezes the best available information.
  // An incomplete investigation is preferable to suppressing the answer.
  if(remainingBudget<=1&&answerAvailable)return['answer'];
  if(noProgressDiscoveryStreak>=2){if(hasInformation&&workerNames.includes('verify'))return['verify'];if(answerAvailable)return['answer'];}
  if(!hasInformation)return workerNames.includes('search')?['search']:answerAvailable?['answer']:[];
  if(verified&&answerAvailable)return['answer'];
  // A relative-date Search is already bounded to the only useful chart window.
  // Once it returns candidates, make the semantic assessor decide whether the
  // requested value is present instead of allowing wording variants to repeat
  // the same Search. Supported evidence proceeds only to refine/verify.
  if(relativeGate&&lastWorker==='search'&&lastSearchHits&&!assessment&&workerNames.includes('assess'))return['assess'];
  if(relativeGate&&assessmentSettled){if(needsRefine&&workerNames.includes('refine'))return['refine'];if(workerNames.includes('verify'))return['verify'];}
  // Two consecutive discovery operations that add nothing are evidence that
  // the current gap is not historically retrievable. Close the chart packet
  // instead of letting wording variants burn the remaining budget.
  if(!hasMemory&&(hasRecent||hasProfile))return['assess','search','verify'].filter(name=>workerNames.includes(name)&&!(name==='verify'&&!assessment));
  // Reserve the final three turns for an auditable refine -> verify -> answer.
  if(remainingBudget<=2){if(needsRefine&&workerNames.includes('refine'))return['refine'];if(workerNames.includes('verify'))return['verify'];}
  if(semanticRefine&&workerNames.includes('refine'))return['refine'];
  if(overflow){
    const choices=(assessment?['refine']:['assess']).filter(name=>workerNames.includes(name));if(choices.length)return choices;
  }
  if(lastWorker==='refine'&&missing.length){const choices=['search','context'].filter(name=>workerNames.includes(name));if(choices.length)return choices;}
  if(freshEvidence&&!assessment&&array(snapshot.answer_brief?.missing_information).length){const allowance=Math.min(2,Math.max(1,array(snapshot.answer_brief.missing_information).length));if(countDiscoveryRunsSinceAssessment(history)>=allowance&&workerNames.includes('assess'))return['assess'];}
  const choices=['search',...(hasMemory?['context','trace']:[]),'assess',...(hasMemory&&(!conservativeRefine||overflow)?['refine']:[]),'verify'].filter(name=>workerNames.includes(name));
  if(remainingBudget<=3&&freshEvidence&&!assessment)return choices.filter(name=>['assess','refine','verify'].includes(name));
  return choices;
}
function countDiscoveryRunsSinceAssessment(history){let count=0;for(let index=array(history).length-1;index>=0;index--){const worker=String(history[index]?.decision?.worker||'');if(worker==='assess')break;if(['search','context','trace'].includes(worker))count++;}return count;}
function countNoProgressDiscoveryStreak(history){let count=0;for(let index=array(history).length-1;index>=0;index--){const record=history[index],worker=String(record?.decision?.worker||'');if(!['search','context','trace'].includes(worker)||record?.result?.changed!==false)break;count++;}return count;}
function asksForDirectFact(value){const text=String(value||'').normalize('NFKC');return/(多少|是什么|为何物|哪(?:个|些|类|种|项)|何时|什么时候|哪天|几月几日|what\s+(?:is|was|were)|which|when|how\s+(?:many|much))/iu.test(text)&&!/(为什么|为何|原因|机制|解释|如何导致|因果|依据|理由|建议|应该|怎么办)/u.test(text);}

function finalizeContext({evaluation_mode,request,snapshot,history,termination_reason}){
  const working_memory=buildWorkingMemory(request,snapshot.memory_nodes,snapshot.memory_edges,snapshot.assessment||snapshot.answer_brief||{}),evaluations=history.filter(record=>record.decision.worker==='assess'),modelTraces=evaluations.map(record=>record?.result?.trace).filter(Boolean),modelTrace=modelTraces.at(-1)||null,answerSelection=history.findLast(record=>record.decision.worker==='answer')?.result?.trace?.answer_selection||null;
  const tokenInput=sumNullable(modelTraces.map(trace=>trace?.token_input)),tokenOutput=sumNullable(modelTraces.map(trace=>trace?.token_output)),reportedTotal=sumNullable(modelTraces.map(trace=>trace?.total_tokens)),totalTokens=reportedTotal??(tokenInput!=null||tokenOutput!=null?Number(tokenInput||0)+Number(tokenOutput||0):null),latencyMs=sumNullable(modelTraces.map(trace=>trace?.latency_ms));
  const answerSelected=termination_reason==='answer_selected'&&history.at(-1)?.decision.worker==='answer',verificationComplete=snapshot.verification?.complete===true,packetFrozen=answerSelected||(termination_reason==='single_explicit_instruction'&&verificationComplete),answerReady=packetFrozen,readinessSemantics='packet_frozen_for_answer_generation; verification_complete is a separate provenance-and-size check';
  const relationEvaluatorFailed=modelTraces.some(trace=>Boolean(trace?.error));
  return{evaluation_mode,question_request:request,temporal_gate:snapshot.temporal_gate||null,refinement_boundary:snapshot.refinement_boundary||null,patient_profile:snapshot.patient_profile||null,recent_sessions:snapshot.recent_sessions||[],memory_nodes:snapshot.memory_nodes,memory_edges:snapshot.memory_edges,working_memory,verification:snapshot.verification,semantic_evaluation:snapshot.assessment,packet_frozen:packetFrozen,verification_complete:verificationComplete,answer_ready:answerReady,answer_ready_semantics:readinessSemantics,investigation_policy:{version:PROMPTS.investigation_policy.version,mode:'grounded_clinician_policy_owned_closed_loop',termination_reason,packet_frozen:packetFrozen,verification_complete:verificationComplete,answer_ready:answerReady,answer_ready_semantics:readinessSemantics,learned_action_prior_used:history.some(record=>Boolean(record.learned_action_prior)),action_exploration_used:history.some(record=>Boolean(record.action_exploration_assignment))},investigation_trace:history.map(record=>({ordinal:record.turn,worker:record.decision.worker,information_status:record.decision.information_status,instruction:record.decision.instruction,effective_instruction:record.result.trace?.effective_instruction||record.decision.instruction,refinement_boundary:record.result.trace?.refinement_boundary||null,...(record.result.trace?.answer_selection?{answer_selection:record.result.trace.answer_selection}:{}),rationale:record.decision.rationale,result_summary:record.result.summary,changed:record.result.changed,...(record.learned_action_prior?{learned_action_prior:record.learned_action_prior}:{}),...(record.action_exploration_assignment?{action_exploration_assignment:record.action_exploration_assignment}:{})})),trace:{investigation:{version:'careharness-investigation-runtime.v14-relevance-before-earliest',termination_reason,packet_frozen:packetFrozen,verification_complete:verificationComplete,answer_ready:answerReady,answer_ready_semantics:readinessSemantics,temporal_gate:snapshot.temporal_gate||null,refinement_boundary:snapshot.refinement_boundary||null,turns:history},semantic_relation_evaluator:evaluations.length?{status:relationEvaluatorFailed?'failed':'completed',model_calls:evaluations.length,call_budget:RELATION_EVALUATOR_CALL_BUDGET,token_input:tokenInput,token_output:tokenOutput,total_tokens:totalTokens,latency_ms:latencyMs,model_trace:modelTrace,model_traces:modelTraces,...(relationEvaluatorFailed?{error:modelTraces.findLast(trace=>trace?.error)?.error||null}:{})}:{status:'not_run',model_calls:0,call_budget:RELATION_EVALUATOR_CALL_BUDGET},answer_selection:answerSelection,unified_memory_graph:true,patient_profile_unranked:true,recent_sessions_unranked:true,deterministic_temporal_gate_applied:Boolean(snapshot.temporal_gate),persistent_refinement_boundary_applied:Boolean(snapshot.refinement_boundary),query_preanalysis_performed:false}};
}

function instrumentAnswerWorker(worker,answerLimit){
  if(!worker||typeof worker.run!=='function')return worker;
  return{...worker,run:async args=>{
    const before=array(args?.state?.snapshot?.memory_nodes),result=await worker.run(args),after=array(result?.snapshot?.memory_nodes),selected=new Set(after.map(node=>String(node?.memory_id||'')).filter(Boolean)),dropped=before.map(node=>String(node?.memory_id||'')).filter(id=>id&&!selected.has(id)),answer_selection={answer_memory_limit:answerLimit,input_memory_count:before.length,selected_memory_count:after.length,overflow:before.length>answerLimit,overflow_count:Math.max(0,before.length-answerLimit),selected_memory_ids:[...selected],dropped_memory_ids:dropped,selection_audited:true};
    return{...result,summary:`${result.summary}${dropped.length?`; explicitly dropped ${dropped.length} overflow Memory Nodes`:''}`,trace:{...(result.trace||{}),answer_selection}};
  }};
}

function sumNullable(values){const finite=array(values).filter(value=>value!=null&&Number.isFinite(Number(value))).map(Number);return finite.length?finite.reduce((sum,value)=>sum+value,0):null;}

function semanticSelectionIds(snapshot,visibleIds){
  const visible=new Set(visibleIds),assessment=snapshot?.assessment||snapshot?.current_information?.assessment||{},ids=[
    ...array(assessment.relevant_memory_ids),
    ...array(assessment.answer_focus).flatMap(item=>array(item?.memory_ids)),
    ...array(assessment.connections).flatMap(item=>[item?.from_memory_id,item?.to_memory_id,...array(item?.supporting_memory_ids)]),
    ...array(assessment.reasoning_hypotheses).flatMap(item=>[...array(item?.supporting_memory_ids),...array(item?.counter_memory_ids)]),
  ].map(String).filter(id=>visible.has(id));
  return[...new Set(ids)];
}
function hasDirectedSearchInstruction(instruction={}){
  const temporal=instruction?.temporal&&typeof instruction.temporal==='object'?instruction.temporal:{},arrays=['search_terms','expansion_terms','required_terms','memory_ids','episode_ids','numeric_signals','lenses'];
  return arrays.some(key=>array(instruction[key]).some(value=>typeof value==='object'?Object.keys(value).length:String(value||'').trim()))||['date_keys','month_keys'].some(key=>array(temporal[key]).some(value=>String(value||'').trim()))||['base_date','start_date','end_date'].some(key=>String(temporal[key]||'').trim())||/[\p{Script=Han}\d]/u.test(String(instruction.objective||''));
}
function repeatsKnownNoProgressStep(decision,steps=[]){
  const current=new Set([decision?.instruction,decision?.effective_instruction].filter(Boolean).map(discoveryInstructionSignature));
  return array(steps).some(step=>{
    // Search/Context/Trace are deterministic for an unchanged effective
    // instruction and chart boundary. Reissuing the same direction after an
    // Assess turn returns the same nodes even when the earlier snapshot was
    // marked changed for bookkeeping, so it must not consume another turn.
    if(step?.worker!==decision.worker)return false;
    const previous=new Set([step?.instruction,step?.effective_instruction].filter(Boolean).map(discoveryInstructionSignature));
    return[...current].some(signature=>previous.has(signature));
  });
}
function targetsOnlyAlwaysVisibleRecentSessions(instruction={},currentInformation={}){
  const requested=new Set(array(instruction?.episode_ids).map(String).filter(Boolean));if(!requested.size)return false;
  const recent=new Set(array(currentInformation?.recent_sessions).map(item=>String(item?.episode_id||'')).filter(Boolean));
  return recent.size>0&&[...requested].every(id=>recent.has(id));
}
function discoveryInstructionSignature(value={}){
  const instruction=plainObject(value),temporal=plainObject(instruction.temporal),normalizeList=list=>array(list).map(item=>typeof item==='object'?stablePolicyObject(item):normalizePolicyText(item)).filter(item=>item!==''&&item!=null).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),normalizeScalar=value=>typeof value==='string'?normalizePolicyText(value):value,shape={search_terms:normalizeList(instruction.search_terms),expansion_terms:normalizeList(instruction.expansion_terms),required_terms:normalizeList(instruction.required_terms),excluded_terms:normalizeList(instruction.excluded_terms),source_types:normalizeList(instruction.source_types),required_families:normalizeList(instruction.required_families),family_weights:normalizeList(instruction.family_weights),numeric_signals:normalizeList(instruction.numeric_signals),lenses:normalizeList(instruction.lenses),episode_ids:normalizeList(instruction.episode_ids),memory_ids:normalizeList(instruction.memory_ids),target_terms:normalizeList(instruction.target_terms),target_memory_ids:normalizeList(instruction.target_memory_ids),seed_memory_ids:normalizeList(instruction.seed_memory_ids),term_match:normalizeScalar(instruction.term_match),family_match:normalizeScalar(instruction.family_match),expand_graph:typeof instruction.expand_graph==='boolean'?instruction.expand_graph:null,depth:Number.isInteger(instruction.depth)?instruction.depth:null,max_paths:Number.isInteger(instruction.max_paths)?instruction.max_paths:null,include_same_factor:typeof instruction.include_same_factor==='boolean'?instruction.include_same_factor:null,include_same_concept:typeof instruction.include_same_concept==='boolean'?instruction.include_same_concept:null,include_same_episode:typeof instruction.include_same_episode==='boolean'?instruction.include_same_episode:null,include_context:typeof instruction.include_context==='boolean'?instruction.include_context:null,max_results:Number.isInteger(instruction.max_results)?instruction.max_results:null,temporal:stablePolicyObject(temporal)};
  const hasStructured=Object.entries(shape).some(([key,item])=>key==='temporal'?Object.keys(item||{}).length:Array.isArray(item)?item.length:item!==null&&item!==undefined&&item!=='');
  if(!hasStructured)shape.objective=normalizePolicyText(instruction.objective);
  return JSON.stringify(shape);
}
function stablePolicyObject(value){if(Array.isArray(value))return value.map(stablePolicyObject).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,stablePolicyObject(value[key])]));return typeof value==='string'?normalizePolicyText(value):value;}
function normalizePolicyText(value){return String(value||'').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu,'');}

/**
 * Validate the worker payload generated on this Policy turn. Question Request
 * remains opaque, while current_information may expose a deterministic hard
 * temporal gate. Every dated Search must stay inside that gate.
 */
function validatePolicyTemporalScope(decision,input={}){
  if(!['search','refine'].includes(decision.worker))return;
  const isSearch=decision.worker==='search',actionLabel=isSearch?'Search':'Refine';
  const question=String(input.question||''),objective=String(decision.instruction?.objective||''),questionDates=datesInPolicyText(question),objectiveDates=datesInPolicyText(objective),temporal=plainObject(decision.instruction?.temporal),operator=String(temporal.operator||'').toLowerCase(),resolved=resolvePolicyTemporalDates(temporal),start=canonicalPolicyDate(temporal.start_date),end=canonicalPolicyDate(temporal.end_date),hasTemporal=hasEffectiveTemporalInstruction(temporal),boundary=plainObject(input.current_information?.refinement_boundary),boundaryTemporal=plainObject(boundary.temporal);
  if((objectiveDates.length||temporalDirectionInText(objective))&&!hasTemporal)throw new Error(`a ${actionLabel} objective containing a date or temporal direction must also encode it as an executable instruction.temporal field; objective prose is not a retrieval boundary`);
  if(!questionDates.length&&isEarliestOccurrenceQuestion(question)&&!['earliest'].includes(operator)&&String(temporal.prefer||'').toLowerCase()!=='earliest')throw new Error(`a first/onset ${actionLabel} must encode temporal.operator="earliest" or temporal.prefer="earliest"; stating “first” only in objective does not order or bound retrieval`);
  if(!isSearch&&!questionDates.length&&isEarliestOccurrenceQuestion(question)&&!end&&retainedRefineAnchorDates(decision,input).length)throw new Error('a first/onset Refine must persist an end_date derived from the retained anchor date, so unseen later records cannot re-enter');
  if(Object.keys(boundaryTemporal).length){
    if(!hasTemporal)throw new Error(`${actionLabel} after Refine must explicitly carry the persistent refinement_boundary.temporal direction; an unconstrained ${actionLabel} is invalid`);
    if(!temporalInsideBoundary(temporal,boundaryTemporal))throw new Error(`${actionLabel} temporal scope attempts to broaden or omit part of the persistent Refine boundary`);
  }
  if(objectiveDates.length&&(!questionDates.length||temporalDirectionInText(objective))&&!objectiveTemporalMatches(objective,temporal,objectiveDates))throw new Error('the executable instruction.temporal does not implement the date/direction stated in objective');
  if(!questionDates.length)return;
  const gate=plainObject(input.current_information?.temporal_gate),derived=gate.hard===true?gate:deriveQuestionTemporalGate({question}),expected=String(derived?.target_date||relativeDateTarget(question,questionDates)[0]||questionDates[0]),gateStart=canonicalPolicyDate(derived?.start_date),gateEnd=canonicalPolicyDate(derived?.end_date),openLatest=!derived&&['latest','current'].includes(operator)&&!end&&(!start||start>=questionDates.at(-1));
  if(openLatest)return;
  if(!derived)throw new Error(`${actionLabel} for a current/latest question with a historical date must use temporal.operator="latest" or "current" without an old end_date; the historical date is a lower-bound baseline, not an exact-date gate`);
  const boundedSpan=['explicit_date_range','discrete_dates_span'].includes(String(derived.kind)),exactFits=!boundedSpan&&operator==='exact'&&resolved.includes(expected)&&resolved.every(date=>!gateStart||date>=gateStart&&date<=gateEnd),rangeFits=boundedSpan?operator==='range'&&start===gateStart&&end===gateEnd:operator==='range'&&start&&end&&start<=expected&&end>=expected&&(!gateStart||start>=gateStart&&end<=gateEnd);
  if(exactFits||rangeFits)return;
  const example=relativeDateOffset(question)!=null
    ? `{"temporal":{"operator":"exact","base_date":"${questionDates[0]}","offset_days":${relativeDateOffset(question)}}}`
    : `{"temporal":{"operator":"exact","date_keys":["${questionDates[0]}"]}}`;
  throw new Error(`${actionLabel} for an explicit date must include an effective instruction.temporal event_time constraint inside the hard temporal gate, such as ${example}; putting a date only in objective or search_terms is not a temporal filter`);
}

function retainedRefineAnchorDates(decision,input={}){
  const retained=new Set(array(decision?.instruction?.memory_ids).map(String).filter(Boolean));
  return array(input.current_information?.memory_nodes)
    .filter(node=>!retained.size||retained.has(String(node?.memory_id||'')))
    .map(node=>canonicalPolicyDate(String(node?.event_time||'').slice(0,10)))
    .filter(Boolean);
}

function fallbackTemporalInstruction(question,refinementBoundary=null){
  const boundaryTemporal=plainObject(refinementBoundary?.temporal);
  if(Object.keys(boundaryTemporal).length)return{temporal:executableBoundaryTemporal(boundaryTemporal)};
  const dates=datesInPolicyText(question),offset=relativeDateOffset(question);
  if(dates.length&&offset!=null)return{temporal:{operator:'exact',base_date:dates[0],offset_days:offset}};
  const gate=deriveQuestionTemporalGate({question});
  if(['explicit_date_range','discrete_dates_span'].includes(String(gate?.kind)))return{temporal:{operator:'range',start_date:gate.start_date,end_date:gate.end_date,prefer:gate.prefer}};
  if(dates.length&&!gate)return{temporal:{operator:'latest',start_date:[...dates].sort().at(-1),prefer:'latest'}};
  if(dates.length)return{temporal:{operator:'exact',date_keys:[gate?.target_date||dates[0]]}};
  const months=monthsInPolicyText(question);
  if(months.length)return{temporal:{operator:'range',month_keys:months,...(isLatestStatusQuestion(question)?{prefer:'latest'}:{})}};
  if(isLatestStatusQuestion(question))return{temporal:{operator:'latest',prefer:'latest'}};
  return isEarliestOccurrenceQuestion(question)?{temporal:{operator:'earliest',prefer:'earliest'}}:{};
}
function fallbackRefinementTemporalInstruction(question,currentInformation={},memoryIds=[]){
  const boundaryTemporal=plainObject(currentInformation?.refinement_boundary?.temporal);if(Object.keys(boundaryTemporal).length)return{temporal:executableBoundaryTemporal(boundaryTemporal)};
  const gate=plainObject(currentInformation?.temporal_gate);if(gate.hard===true){const start=canonicalPolicyDate(gate.start_date),end=canonicalPolicyDate(gate.end_date),target=canonicalPolicyDate(gate.target_date);if(start&&end&&start===end)return{temporal:{operator:'exact',date_keys:[target||start]}};if(start&&end)return{temporal:{operator:'range',start_date:start,end_date:end,prefer:String(gate.prefer||'earliest')==='latest'?'latest':'earliest'}};}
  const generic=fallbackTemporalInstruction(question);if(generic.temporal&&!isEarliestOccurrenceQuestion(question))return generic;
  if(isEarliestOccurrenceQuestion(question)){const selected=new Set(array(memoryIds).map(String)),dates=array(currentInformation?.memory_nodes).filter(node=>!selected.size||selected.has(String(node?.memory_id||''))).map(node=>canonicalPolicyDate(String(node?.event_time||'').slice(0,10))).filter(Boolean).sort(),end=dates.at(-1);return{temporal:{operator:'earliest',...(end?{end_date:end}:{}),prefer:'earliest'}};}
  return generic;
}

function executableBoundaryTemporal(value={}){
  const temporal=plainObject(value),operator=String(temporal.operator||'').toLowerCase(),start=canonicalPolicyDate(temporal.start_date),end=canonicalPolicyDate(temporal.end_date),prefer=String(temporal.prefer||'').toLowerCase();
  if(operator==='exact'&&start&&end&&start===end)return{operator:'exact',date_keys:[start]};
  if(operator==='range'&&start&&end)return{operator:'range',start_date:start,end_date:end,...(['earliest','latest'].includes(prefer)?{prefer}:{})};
  if(operator==='earliest')return{operator:'earliest',...(end?{end_date:end}:{}),prefer:'earliest'};
  if(['latest','current'].includes(operator))return{operator,...(start?{start_date:start}:{}),prefer:'latest'};
  return JSON.parse(JSON.stringify(temporal));
}

function hasEffectiveTemporalInstruction(value={}){
  const temporal=plainObject(value),operator=String(temporal.operator||'').toLowerCase();
  return resolvePolicyTemporalDates(temporal).length>0||array(temporal.month_keys).some(value=>/^20\d{2}-\d{2}$/u.test(String(value)))||Boolean(canonicalPolicyDate(temporal.start_date)||canonicalPolicyDate(temporal.end_date))||['earliest','latest','current','history'].includes(operator);
}
function temporalDirectionInText(value){return/(?:prior\s+to|before|after|earliest|latest|first|initial|onset|截至|以前|之前|之后|以后|最初|首次|最早|最晚|当前|最新)/iu.test(String(value||''));}
function isLatestStatusQuestion(value){return/(?:当前|目前|现在|如今|现阶段|最新|最近一次|至今|后来|后续|current(?:ly)?|now|latest|most\s+recent|at\s+present|since\s+then|subsequent(?:ly)?|afterwards)/iu.test(String(value||'').normalize('NFKC'));}
function isEarliestOccurrenceQuestion(value){return/(?:最初|首次|最早|第一次|开始出现|起初|first|initial|onset|when\s+did\s+.*(?:begin|start))/iu.test(String(value||''));}
function objectiveTemporalMatches(objective,temporal,dates){
  const text=String(objective||''),resolved=resolvePolicyTemporalDates(temporal),start=canonicalPolicyDate(temporal.start_date),end=canonicalPolicyDate(temporal.end_date),operator=String(temporal.operator||'').toLowerCase(),target=dates[0];
  if(/(?:当前|目前|现在|如今|现阶段|最新|最近一次|至今|后来|后续|current(?:ly)?|now|latest|most\s+recent|at\s+present|since\s+then|subsequent(?:ly)?|afterwards)/iu.test(text)&&['latest','current'].includes(operator))return!end&&(!start||start>=target);
  if(/(?:排除|删除|移除|剔除|不含|不要)[^。；;]*(?:之后|以后|later|after)/iu.test(text))return Boolean(end&&end<=target&&['earliest','range','history'].includes(operator));
  if(/(?:排除|删除|移除|剔除|不含|不要)[^。；;]*(?:之前|以前|earlier|before)/iu.test(text))return Boolean(start&&start>=target&&['latest','range','history'].includes(operator));
  if(/(?:prior\s+to|before|截至|以前|之前|不晚于)/iu.test(text))return Boolean(end&&end<=target&&['earliest','range','history'].includes(operator));
  if(/(?:after|之后|以后|不早于)/iu.test(text))return Boolean(start&&start>=target&&['latest','range','history'].includes(operator));
  return resolved.includes(target)||(start&&end&&start<=target&&end>=target);
}
function temporalInsideBoundary(value,boundary){
  const temporal=plainObject(value),dates=resolvePolicyTemporalDates(temporal),start=canonicalPolicyDate(temporal.start_date),end=canonicalPolicyDate(temporal.end_date),boundaryStart=canonicalPolicyDate(boundary.start_date),boundaryEnd=canonicalPolicyDate(boundary.end_date);
  if(boundaryStart&&!start&&dates.length===0)return false;if(boundaryEnd&&!end&&dates.length===0)return false;
  if(start&&boundaryStart&&start<boundaryStart)return false;if(end&&boundaryEnd&&end>boundaryEnd)return false;
  return dates.every(date=>(!boundaryStart||date>=boundaryStart)&&(!boundaryEnd||date<=boundaryEnd));
}

function relativeDateTarget(question,dates){
  const offset=relativeDateOffset(question);if(offset==null||!dates.length)return[];
  const value=new Date(`${dates[0]}T00:00:00.000Z`);value.setUTCDate(value.getUTCDate()+offset);return[value.toISOString().slice(0,10)];
}
function relativeDateOffset(value){
  const text=String(value||'').normalize('NFKC');
  if(/(?:大前天|三天前)/u.test(text))return-3;if(/(?:大后天|三天后)/u.test(text))return 3;
  if(/(?:前天|两天前)/u.test(text))return-2;if(/(?:后天|两天后)/u.test(text))return 2;
  if(/(?:前一日|前一天|上一日|前日|previous day)/iu.test(text))return-1;
  if(/(?:次日|翌日|第二天|后一天|下一日|next day)/iu.test(text))return 1;
  return null;
}
function resolvePolicyTemporalDates(temporal={}){
  const dates=datesInPolicyText(array(temporal.date_keys).join(' ')),base=canonicalPolicyDate(temporal.base_date),offset=Number(temporal.offset_days??0);
  if(base&&Number.isInteger(offset)&&Math.abs(offset)<=3660){const value=new Date(`${base}T00:00:00.000Z`);value.setUTCDate(value.getUTCDate()+offset);dates.push(value.toISOString().slice(0,10));}
  return[...new Set(dates)];
}
function canonicalPolicyDate(value){
  const match=/^(?<year>20\d{2})[-/.](?<month>\d{1,2})[-/.](?<day>\d{1,2})$/u.exec(String(value||'').trim());if(!match)return'';
  const year=Number(match.groups.year),month=Number(match.groups.month),day=Number(match.groups.day),date=new Date(Date.UTC(year,month-1,day));return date.getUTCFullYear()===year&&date.getUTCMonth()===month-1&&date.getUTCDate()===day?date.toISOString().slice(0,10):'';
}
function plainObject(value){return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}

function emptySnapshot(patientProfile=null,recentSessions=[],temporalGate=null,stateProjection=false,strategyProfile=null){return{state_projection:stateProjection===true,strategy_profile:strategyProfile||null,temporal_gate:temporalGate||null,refinement_boundary:null,patient_profile:patientProfile&&typeof patientProfile==='object'?patientProfile:null,recent_sessions:array(recentSessions),memory_nodes:[],memory_edges:[],verification:null,assessment:null,answer_brief:null,worker_state:null};}
function array(value){return Array.isArray(value)?value:[];}
export function assertNoHiddenRuntimeInput(value,path='runtime'){return assertNoHiddenBenchmarkInput(value,path);}
