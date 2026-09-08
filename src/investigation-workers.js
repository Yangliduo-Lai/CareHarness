import { applyInvestigationAssessment,contextualizeMemory,investigationAssessmentInput,refineWorkingMemory,searchMemory,traceMemoryGraph,verifyWorkingMemory } from './careharness-actions.js';
import { assertNoHiddenBenchmarkInput } from './information-boundary.js';
import { INVESTIGATION_ASSESSOR_UNAVAILABLE_MESSAGE,investigationWorkerResultSummary,memoryInvestigationWorkerPromptContracts } from './prompts.js';
import { canonicalCalendarDate as canonicalDate,canonicalCalendarMonth,explicitDatesInText as datesInText,explicitMonthsInText as monthsInText } from './temporal-expressions.js';
import { augmentMedLoCoMoSearchInstruction } from './medlocomo-instruction-policy.js';

/**
 * Default worker plug-ins for a Memory Graph investigation. The closed-loop
 * runtime does not know these names or schemas; replacing this registry does
 * not require changing the orchestrator or Question Request boundary.
 */
export function createMemoryInvestigationWorkers({question_request,memory_nodes=[],memory_edges=[],candidate_budget=24,search_candidate_limit=candidate_budget,context_candidate_limit=candidate_budget,assess_memory_limit=candidate_budget,answer_memory_limit=Math.min(candidate_budget,16),answer_focus_limit=16,relation_evaluator=null,embedding_retriever=null,search_ranker=null,search_instruction_prior=null,temporal_gate=null,allow_reasoning_hypotheses=true,target_only_focus_roles=false,exact_entity=false,conservative_refine=false,evidence_preserving_refine=false,structured_evidence_ledger=false}={}){
  const pool=[...memory_nodes],persistentEdges=[...memory_edges],workingLimit=Math.max(1,Number(candidate_budget)||24),searchLimit=Math.max(1,Math.min(workingLimit,Number(search_candidate_limit)||workingLimit)),contextLimit=Math.max(searchLimit,Number(context_candidate_limit)||workingLimit),assessLimit=Math.max(1,Math.min(workingLimit,Number(assess_memory_limit)||workingLimit)),finalLimit=Math.max(1,Math.min(workingLimit,Number(answer_memory_limit)||16)),temporalGate=normalizeTemporalGate(temporal_gate)||deriveQuestionTemporalGate(question_request),promptContracts=memoryInvestigationWorkerPromptContracts({conservative_refine,evidence_preserving_refine}),medLoCoMo=question_request?.strategy_namespace==='medlocomo',crossAdmissionScope=isMedLoCoMoCrossAdmissionScope(question_request),episodeDiversity=crossAdmissionScope;
  return{
    search:descriptor(promptContracts.search,({state,instruction})=>{
      const storedBoundary=normalizeRefinementBoundary(state.snapshot.refinement_boundary),boundary=discoveryRefinementBoundary(state.snapshot.refinement_boundary,{recover_soft:crossAdmissionScope}),boundedPool=applyRefinementBoundary(pool,boundary),priorNoProgress=state.snapshot.worker_state?.trace?.result_signal?.zero_recall===true||state.snapshot.worker_state?.trace?.result_signal?.new_node_count===0,learned=question_request?.strategy_namespace==='medlocomo'?augmentMedLoCoMoSearchInstruction(instruction,search_instruction_prior,{prior_discovery_no_progress:priorNoProgress}):{instruction,trace:{status:'skipped_scope',added_terms:[]}},basePrepared=enforceRefinementBoundary(prepareDiscoveryInstruction(question_request,learned.instruction,boundedPool,state.snapshot.memory_nodes,temporalGate),boundary),prepared=medLoCoMo?withDynamicAspectLenses(basePrepared,state.snapshot):basePrepared,pairwiseEnabled=question_request?.strategy_namespace==='medlocomo'&&typeof search_ranker==='function',rankerFeaturePool=pairwiseEnabled?pool:boundedPool,complete=embedding=>{
        const candidateReranker=pairwiseEnabled?input=>search_ranker({...input,memory_nodes:rankerFeaturePool,dense_admission_features:embedding?.admission_features}):null,result=searchMemory(question_request,boundedPool,persistentEdges,prepared,{limit:searchLimit,semantic_scores:embedding?.scores,semantic_top_k:candidateReranker?boundedPool.length:Math.max(searchLimit,16),episode_diversity:episodeDiversity,candidate_reranker:candidateReranker,dense_admission_features:embedding?.admission_features,aspect_top_k:medLoCoMo?4:1,strict_fact_diversity:medLoCoMo}),trace=discoveryTrace('search',{...result.trace,effective_instruction:prepared,learned_instruction_prior:learned.trace,temporal_gate:temporalGate,refinement_boundary:boundary,stored_refinement_boundary:storedBoundary,soft_refinement_recovery:crossAdmissionScope&&storedBoundary&&!boundary,embedding:embedding?.trace||{status:'not_configured'},ranker_feature_pool_scope:pairwiseEnabled?'complete_question_visible_patient_graph':'candidate_boundary_pool',stage_limits:{search_new:searchLimit,working_set:workingLimit,context_pool:contextLimit,assess_visible:assessLimit,final_packet:finalLimit}},state.snapshot.memory_nodes,result.memory_nodes),addition={temporal_gate:temporalGate,refinement_boundary:boundary,memory_nodes:result.memory_nodes,memory_edges:result.memory_edges,verification:null,assessment:null,answer_brief:null,role_coverage:null,evidence_ledger:null,worker_state:{last_worker:'search',trace}},candidate=medLoCoMo?mergeWorkingSnapshot(state.snapshot,addition,workingLimit):mergeSnapshot(state.snapshot,addition),changed=changedIds(state.snapshot.memory_nodes,candidate.memory_nodes),snapshot=changed?candidate:{...candidate,verification:state.snapshot.verification,assessment:state.snapshot.assessment,answer_brief:state.snapshot.answer_brief,role_coverage:state.snapshot.role_coverage,evidence_ledger:state.snapshot.evidence_ledger};
        return{snapshot,summary:investigationWorkerResultSummary('search',{memory_node_count:result.memory_nodes.length,boundary_id:boundary?.boundary_id,temporal_start:temporalGate?.start_date,temporal_end:temporalGate?.end_date}),changed,trace};
      };
      if(typeof embedding_retriever!=='function')return complete(null);
      const query=embeddingQueryForWorker(question_request,prepared);return Promise.resolve(embedding_retriever({query,memory_nodes:rankerFeaturePool,instruction:prepared})).then(complete,error=>complete({scores:null,admission_features:null,trace:{status:'failed_open',degraded_to:'validated_lexical_only_ranker',error:String(error?.message||error)}}));
    }),
    context:descriptor(promptContracts.context,({state,instruction})=>{
      const storedBoundary=normalizeRefinementBoundary(state.snapshot.refinement_boundary),boundary=discoveryRefinementBoundary(state.snapshot.refinement_boundary,{recover_soft:crossAdmissionScope}),boundedPool=applyRefinementBoundary(pool,boundary),prepared=enforceRefinementBoundary(prepareDiscoveryInstruction(question_request,instruction,boundedPool,state.snapshot.memory_nodes,temporalGate),boundary),scoped=scopeContextInstruction(prepared,state.snapshot.memory_nodes),result=medLoCoMo?contextualizeMedLoCoMoMemory(boundedPool,state.snapshot.memory_nodes,scoped.instruction,contextLimit):contextualizeMemory(question_request,boundedPool,scoped.instruction,{anchor_limit:3,node_limit:contextLimit}),trace=discoveryTrace('context',{...result.trace,effective_instruction:scoped.instruction,inherited_episode_ids:scoped.inherited_episode_ids,temporal_gate:temporalGate,refinement_boundary:boundary,stored_refinement_boundary:storedBoundary,soft_refinement_recovery:crossAdmissionScope&&storedBoundary&&!boundary,stage_limits:{context_pool:contextLimit,working_set:workingLimit}},state.snapshot.memory_nodes,result.memory_nodes),addition={temporal_gate:temporalGate,refinement_boundary:boundary,memory_nodes:result.memory_nodes,verification:null,assessment:null,answer_brief:null,role_coverage:null,evidence_ledger:null,worker_state:{last_worker:'context',trace}},candidate=medLoCoMo?mergeWorkingSnapshot(state.snapshot,addition,workingLimit):mergeSnapshot(state.snapshot,addition),changed=changedIds(state.snapshot.memory_nodes,candidate.memory_nodes),snapshot=changed?candidate:{...candidate,verification:state.snapshot.verification,assessment:state.snapshot.assessment,answer_brief:state.snapshot.answer_brief,role_coverage:state.snapshot.role_coverage,evidence_ledger:state.snapshot.evidence_ledger};
      return{snapshot,summary:investigationWorkerResultSummary('context',{session_count:result.anchors.length,memory_node_count:result.memory_nodes.length}),changed,trace};
    }),
    trace:descriptor(promptContracts.trace,({state,instruction})=>{
      const storedBoundary=normalizeRefinementBoundary(state.snapshot.refinement_boundary),boundary=discoveryRefinementBoundary(state.snapshot.refinement_boundary,{recover_soft:crossAdmissionScope}),activeTemporalGate=normalizeTemporalGate(state.snapshot.temporal_gate)||temporalGate,boundedPool=applyTemporalGate(applyRefinementBoundary(pool,boundary),activeTemporalGate),scopedCurrent=applyTemporalGate(applyRefinementBoundary(state.snapshot.memory_nodes,boundary),activeTemporalGate),scopedIds=new Set(scopedCurrent.map(node=>String(node.memory_id))),scopedEdges=state.snapshot.memory_edges.filter(edge=>scopedIds.has(String(edge.from_memory_id))&&scopedIds.has(String(edge.to_memory_id))),baseSnapshot={...state.snapshot,temporal_gate:activeTemporalGate,refinement_boundary:boundary,memory_nodes:scopedCurrent,memory_edges:scopedEdges},suppliedSeeds=array(instruction?.seed_memory_ids),assessmentSeeds=assessmentMemoryIds(state.snapshot.assessment||state.snapshot.answer_brief),traceInstruction={...instruction,seed_memory_ids:suppliedSeeds.length?suppliedSeeds:(assessmentSeeds.length?assessmentSeeds:scopedCurrent.map(node=>node.memory_id)).slice(0,6),include_same_factor:instruction?.include_same_factor!==false,include_same_concept:instruction?.include_same_concept!==false,include_context:instruction?.include_context===true},result=traceMemoryGraph(boundedPool,persistentEdges,scopedCurrent,traceInstruction,{limit:workingLimit,temporal_gate:activeTemporalGate,refinement_boundary:boundary}),trace=discoveryTrace('trace',{...result.trace,effective_instruction:traceInstruction,temporal_gate:activeTemporalGate,refinement_boundary:boundary,stored_refinement_boundary:storedBoundary,soft_refinement_recovery:crossAdmissionScope&&storedBoundary&&!boundary,stage_limits:{working_set:workingLimit}},state.snapshot.memory_nodes,result.memory_nodes),addition={temporal_gate:activeTemporalGate,refinement_boundary:boundary,navigation_paths:result.trace.navigation_paths,memory_nodes:result.memory_nodes,memory_edges:result.memory_edges,verification:null,assessment:null,answer_brief:null,role_coverage:null,evidence_ledger:null,worker_state:{last_worker:'trace',trace}},candidate=medLoCoMo?mergeWorkingSnapshot(baseSnapshot,addition,workingLimit):mergeSnapshot(baseSnapshot,addition),changed=changedIds(state.snapshot.memory_nodes,candidate.memory_nodes)||changedIds(state.snapshot.memory_edges,candidate.memory_edges,'edge_id')||navigationPathSignature(state.snapshot.navigation_paths)!==navigationPathSignature(candidate.navigation_paths),snapshot=changed?candidate:{...candidate,verification:state.snapshot.verification,assessment:state.snapshot.assessment,answer_brief:state.snapshot.answer_brief,role_coverage:state.snapshot.role_coverage,evidence_ledger:state.snapshot.evidence_ledger};
      return{snapshot,summary:investigationWorkerResultSummary('trace',{memory_node_count:result.memory_nodes.length,edge_count:result.memory_edges.length}),changed,trace};
    }),
    assess:descriptor(promptContracts.assess,async({state,instruction})=>{
      if(typeof relation_evaluator!=='function')return{snapshot:{...state.snapshot,assessment:{assessment:'unresolved',relevant_memory_ids:[],covered_aspects:[],missing_information:[INVESTIGATION_ASSESSOR_UNAVAILABLE_MESSAGE]},worker_state:{last_worker:'assess'}},summary:investigationWorkerResultSummary('assess',{unavailable:true}),changed:false};
      const assessmentSnapshot=medLoCoMo?boundedAssessmentSnapshot(state.snapshot,assessLimit):state.snapshot,input=investigationAssessmentInput(question_request,assessmentSnapshot,instruction,{allow_reasoning_hypotheses,target_only_focus_roles,exact_entity,answer_focus_limit,structured_evidence_ledger});assertNoHiddenBenchmarkInput(input,'investigation_assessor');
      try{
        const response=await relation_evaluator(input),raw=response?.value??response,constrained=allow_reasoning_hypotheses?raw:{...raw,reasoning_hypotheses:[]},evaluated=applyInvestigationAssessment(question_request,assessmentSnapshot,constrained,{exact_entity:exact_entity===true,target_only_focus_roles,answer_focus_limit,structured_evidence_ledger}),focus=dynamicInvestigationFocus(state.snapshot.investigation_focus,evaluated.semantic_evaluation,question_request);
        return{snapshot:{...state.snapshot,...evaluated,assessment:evaluated.semantic_evaluation,answer_brief:evaluated.semantic_evaluation,coverage_state:evaluated.coverage_state,investigation_focus:focus,role_coverage:structured_evidence_ledger?evaluated.semantic_evaluation.role_coverage||[]:state.snapshot.role_coverage,worker_state:{last_worker:'assess',model_trace:response?.trace||null}},summary:investigationWorkerResultSummary('assess',{covered_count:evaluated.semantic_evaluation.covered_aspects.length,missing_count:evaluated.semantic_evaluation.missing_information.length}),changed:true,trace:response?.trace||null};
      }catch(error){
        const trace=error?.gatewayTrace||{component:'careharness_evaluate',error:{kind:'assessment_error',message:String(error?.message||error)}},assessment={assessment:'unresolved',relevant_memory_ids:[],covered_aspects:[],answer_focus:[],connections:[],reasoning_hypotheses:[],missing_information:['Semantic assessment was unavailable; preserve retrieved source-grounded information and continue.']};
        return{snapshot:{...state.snapshot,assessment,answer_brief:assessment,worker_state:{last_worker:'assess',model_trace:trace}},summary:investigationWorkerResultSummary('assess',{unavailable:true,memory_node_count:state.snapshot.memory_nodes.length}),changed:true,trace};
      }
    }),
    refine:descriptor(promptContracts.refine,({state,instruction})=>{
      const sourceAssessment=state.snapshot.assessment||state.snapshot.answer_brief||null,protectedIds=assessmentMemoryIds(sourceAssessment),refineInstruction=evidence_preserving_refine?{...instruction,memory_ids:[...new Set([...array(instruction?.memory_ids).map(String),...protectedIds])]}:instruction,result=refineWorkingMemory(question_request,state.snapshot.memory_nodes,state.snapshot.memory_edges,refineInstruction,{limit:workingLimit,conservative:conservative_refine,evidence_preserving:evidence_preserving_refine}),restored=crossAdmissionScope?restoreProtectedAssessmentNodes(result.memory_nodes,state.snapshot.memory_nodes,protectedIds):result.memory_nodes,activeTemporalGate=normalizeTemporalGate(state.snapshot.temporal_gate)||temporalGate,preserved=crossAdmissionScope?applyTemporalGate(restored,activeTemporalGate):restored,preservedIds=new Set(preserved.map(node=>String(node.memory_id))),preservedEdges=state.snapshot.memory_edges.filter(edge=>preservedIds.has(String(edge.from_memory_id))&&preservedIds.has(String(edge.to_memory_id))),boundary=crossAdmissionScope?discoveryRefinementBoundary(state.snapshot.refinement_boundary,{recover_soft:true}):result.trace.refinement_applied?extendRefinementBoundary(state.snapshot.refinement_boundary,state.snapshot.memory_nodes,preserved,refineInstruction):normalizeRefinementBoundary(state.snapshot.refinement_boundary),actuallyRemoved=state.snapshot.memory_nodes.filter(node=>!preservedIds.has(String(node?.memory_id||''))).map(node=>node.memory_id),trace={...result.trace,removed_memory_ids:actuallyRemoved,effective_instruction:refineInstruction,reasoning_coverage_preserved:preserved.map(node=>node.memory_id),protected_assessment_memory_ids:protectedIds.filter(id=>preservedIds.has(String(id))),refinement_boundary:boundary,refinement_semantics:evidence_preserving_refine?'evidence_preserving_duplicate_or_hard_mismatch_only':crossAdmissionScope?'soft_recoverable_selection':'persistent_boundary',soft_removed_memory_ids:crossAdmissionScope?actuallyRemoved:[]},assessment=assessmentForNodes(sourceAssessment,preserved,state.snapshot.patient_profile),snapshot={...state.snapshot,refinement_boundary:boundary,memory_nodes:preserved,memory_edges:preservedEdges,verification:null,assessment:state.snapshot.assessment?assessment:null,answer_brief:assessment,role_coverage:assessment?.role_coverage||null,worker_state:{last_worker:'refine',trace}};
      return{snapshot,summary:investigationWorkerResultSummary('refine',{applied:result.trace.refinement_applied,memory_node_count:preserved.length,boundary_id:boundary?.boundary_id}),changed:changedIds(state.snapshot.memory_nodes,snapshot.memory_nodes),trace};
    }),
    verify:descriptor(promptContracts.verify,({state})=>{
      const verification=verifyWorkingMemory(state.snapshot.memory_nodes,state.snapshot.memory_edges,{limit:medLoCoMo?workingLimit:finalLimit,fixed_context_count:array(state.snapshot.recent_sessions).length+Number(state.snapshot.patient_profile?.item_count||0)}),snapshot={...state.snapshot,...verification,verification,worker_state:{last_worker:'verify'}};
      return{snapshot,summary:investigationWorkerResultSummary('verify',{complete:verification.complete,memory_node_count:verification.memory_nodes.length,limit:verification.limit}),changed:true};
    }),
    answer:descriptor(promptContracts.answer,({state})=>{
      const nodes=boundedAnswerNodes({...state.snapshot,question_request},finalLimit),verification=verifyWorkingMemory(nodes,state.snapshot.memory_edges,{limit:finalLimit,fixed_context_count:array(state.snapshot.recent_sessions).length+Number(state.snapshot.patient_profile?.item_count||0)}),sourceAssessment=state.snapshot.assessment||state.snapshot.answer_brief||null,assessment=assessmentForNodes(sourceAssessment,verification.memory_nodes,state.snapshot.patient_profile),snapshot={...state.snapshot,...verification,verification,assessment:state.snapshot.assessment?assessment:null,answer_brief:assessment,role_coverage:assessment?.role_coverage||null,worker_state:{last_worker:'answer'}};
      return{snapshot,summary:investigationWorkerResultSummary('answer',{memory_node_count:verification.memory_nodes.length}),changed:changedIds(state.snapshot.memory_nodes,verification.memory_nodes),terminal:true};
    }),
  };
}

function descriptor(capability,run){return{capability,run};}
function discoveryTrace(worker,trace,beforeNodes,selectedNodes){
  const beforeIds=new Set(array(beforeNodes).map(node=>String(node?.memory_id||'')).filter(Boolean)),selected=array(selectedNodes),newNodeCount=selected.filter(node=>!beforeIds.has(String(node?.memory_id||''))).length,pathCount=Math.max(0,Number(trace?.path_count??array(trace?.navigation_paths).length)||0),unconnectedTargetCount=Math.max(0,Number(trace?.unconnected_target_count??array(trace?.unconnected_target_memory_ids).length)||0),candidateCount=Number.isFinite(Number(trace?.candidate_count))?Number(trace.candidate_count):Number.isFinite(Number(trace?.candidate_session_count))?Number(trace.candidate_session_count):selected.length,resultSignal={worker,selected_count:selected.length,candidate_count:candidateCount,new_node_count:newNodeCount,path_count:pathCount,unconnected_target_count:unconnectedTargetCount,zero_recall:selected.length===0};
  return{...trace,worker,candidate_count:candidateCount,selected_memory_count:selected.length,new_node_count:newNodeCount,path_count:pathCount,unconnected_target_count:unconnectedTargetCount,zero_recall:selected.length===0,result_signal:resultSignal};
}
function scopeContextInstruction(instruction,currentNodes){
  const clean=instruction&&typeof instruction==='object'&&!Array.isArray(instruction)?JSON.parse(JSON.stringify(instruction)):{};
  if(array(clean.memory_ids).length||array(clean.episode_ids).length)return{instruction:clean,inherited_episode_ids:[]};
  const episodes=[...new Set(array(currentNodes).map(node=>String(node?.episode_id||'')).filter(Boolean))];
  if(!episodes.length)return{instruction:clean,inherited_episode_ids:[]};
  clean.episode_ids=episodes;
  return{instruction:clean,inherited_episode_ids:episodes};
}
function contextualizeMedLoCoMoMemory(pool,currentNodes,instruction,limit){
  const available=array(pool),current=array(currentNodes),byId=new Map(available.map(node=>[String(node?.memory_id||''),node])),currentIds=new Set(current.map(node=>String(node?.memory_id||'')).filter(Boolean)),requestedMemoryIds=array(instruction?.memory_ids).map(String).filter(id=>byId.has(id)),requestedEpisodeIds=array(instruction?.episode_ids).map(String).filter(Boolean),episodeIds=[];
  const addEpisode=value=>{const id=String(value||'');if(id&&!episodeIds.includes(id))episodeIds.push(id);};
  if(requestedMemoryIds.length)for(const id of requestedMemoryIds)addEpisode(byId.get(id)?.episode_id);
  else if(requestedEpisodeIds.length)for(const id of requestedEpisodeIds)addEpisode(id);
  else for(const node of current)addEpisode(node?.episode_id);
  const groups=[];
  for(const episodeId of episodeIds){
    const anchors=requestedMemoryIds.length?requestedMemoryIds.map(id=>byId.get(id)).filter(node=>String(node?.episode_id||'')===episodeId):current.filter(node=>String(node?.episode_id||'')===episodeId),candidates=available.filter(node=>String(node?.episode_id||'')===episodeId&&!currentIds.has(String(node?.memory_id||''))).sort((left,right)=>compareLocalContext(left,right,anchors));
    if(anchors.length||candidates.length)groups.push({episode_id:episodeId,anchors,candidates});
  }
  const boundedLimit=Math.max(1,Number(limit)||24),additionLimit=Math.min(boundedLimit,Math.max(groups.length,Math.max(0,boundedLimit-currentIds.size))),selected=[];
  for(let depth=0;selected.length<additionLimit&&groups.some(group=>depth<group.candidates.length);depth++)for(const group of groups){if(group.candidates[depth])selected.push(group.candidates[depth]);if(selected.length>=additionLimit)break;}
  const selectedByEpisode=new Map();for(const node of selected){const id=String(node?.episode_id||''),values=selectedByEpisode.get(id)||[];values.push(String(node.memory_id));selectedByEpisode.set(id,values);}
  const anchors=groups.map(group=>({episode_id:group.episode_id,event_time:group.anchors.map(node=>node?.event_time).filter(Boolean).sort()[0]||group.candidates[0]?.event_time||null,score:1,matched_terms:[],memory_ids:group.anchors.map(node=>node.memory_id),context_memory_ids:selectedByEpisode.get(group.episode_id)||[]}));
  return{memory_nodes:selected,anchors,trace:{version:'careharness-medlocomo-context.worker-v2-local-turns-per-admission',context_mode:'local_adjacent_turns_per_candidate_admission',candidate_session_count:groups.length,selected_session_count:anchors.filter(anchor=>anchor.context_memory_ids.length).length,selected_memory_count:selected.length,worker_instruction:instruction}};
}
function compareLocalContext(left,right,anchors){
  const leftDistance=localContextDistance(left,anchors),rightDistance=localContextDistance(right,anchors);
  for(let index=0;index<leftDistance.length;index++)if(leftDistance[index]!==rightDistance[index])return leftDistance[index]-rightDistance[index];
  return String(left?.memory_id||'').localeCompare(String(right?.memory_id||''));
}
function localContextDistance(node,anchors){
  const turn=numericTurn(node?.turn_id),time=Date.parse(node?.event_time||''),turnDistances=[],timeDistances=[];
  for(const anchor of array(anchors)){const anchorTurn=numericTurn(anchor?.turn_id),anchorTime=Date.parse(anchor?.event_time||'');if(Number.isFinite(turn)&&Number.isFinite(anchorTurn))turnDistances.push(Math.abs(turn-anchorTurn));if(Number.isFinite(time)&&Number.isFinite(anchorTime))timeDistances.push(Math.abs(time-anchorTime));}
  return[turnDistances.length?Math.min(...turnDistances):Number.MAX_SAFE_INTEGER,timeDistances.length?Math.min(...timeDistances):Number.MAX_SAFE_INTEGER,Number.isFinite(turn)?turn:Number.MAX_SAFE_INTEGER,Number.isFinite(time)?time:Number.MAX_SAFE_INTEGER];
}
function numericTurn(value){const match=String(value||'').match(/\d+/u),number=match?Number(match[0]):NaN;return Number.isFinite(number)?number:NaN;}
function mergeSnapshot(current,addition){const nodes=mergeById(current.memory_nodes,addition.memory_nodes,'memory_id'),ids=new Set(nodes.map(node=>String(node.memory_id))),edges=mergeById(current.memory_edges,addition.memory_edges,'edge_id').filter(edge=>ids.has(String(edge.from_memory_id))&&ids.has(String(edge.to_memory_id)));return{...current,...addition,memory_nodes:nodes,memory_edges:edges};}
function mergeWorkingSnapshot(current,addition,limit){
  const merged=mergeSnapshot(current,addition),protectedIds=assessmentMemoryIds(current.assessment||current.answer_brief),newIds=new Set(array(addition.memory_nodes).map(node=>String(node?.memory_id||''))),nodes=selectWorkingSet(merged.memory_nodes,Math.max(1,Number(limit)||48),protectedIds,newIds),ids=new Set(nodes.map(node=>String(node.memory_id))),edges=merged.memory_edges.filter(edge=>ids.has(String(edge.from_memory_id))&&ids.has(String(edge.to_memory_id)));
  return{...merged,memory_nodes:nodes,memory_edges:edges};
}
function selectWorkingSet(nodes,limit,protectedIds=[],newIds=new Set()){
  const byId=new Map(array(nodes).map(node=>[String(node?.memory_id||''),node])),ordered=[],seen=new Set(),add=node=>{const id=String(node?.memory_id||'');if(id&&byId.has(id)&&!seen.has(id)&&ordered.length<limit&&!ordered.some(current=>workingNearDuplicate(current,node))){seen.add(id);ordered.push(node);}};
  for(const id of protectedIds)add(byId.get(String(id)));
  const groups=new Map();for(const node of array(nodes)){const episode=String(node?.episode_id||node?.observation_id||node?.memory_id||''),values=groups.get(episode)||[];values.push(node);groups.set(episode,values);}
  const episodeGroups=[...groups.values()].map(values=>[...values].sort((a,b)=>Number(newIds.has(String(b?.memory_id)))-Number(newIds.has(String(a?.memory_id)))));
  for(let depth=0;ordered.length<limit&&episodeGroups.some(values=>depth<values.length);depth++)for(const values of episodeGroups){add(values[depth]);if(ordered.length>=limit)break;}
  for(const node of nodes)add(node);return ordered;
}
function workingNearDuplicate(left,right){
  if(String(left?.subject_id||'')!==String(right?.subject_id||'')||String(left?.episode_id||left?.observation_id||'')!==String(right?.episode_id||right?.observation_id||''))return false;
  const normalize=value=>String(value||'').normalize('NFKC').toLowerCase().replace(/^(?:patient|doctor|患者|医生)(?:原话|陈述|报告|建议|解释)?[：:]?/u,'').replace(/[\s\p{P}\p{S}]+/gu,''),a=normalize(left?.source_text||left?.text),b=normalize(right?.source_text||right?.text);if(!a||!b)return false;if(a===b)return true;const short=Math.min(a.length,b.length),long=Math.max(a.length,b.length);return short>=12&&(a.includes(b)||b.includes(a))&&short/Math.max(1,long)>=.82;
}
function boundedAssessmentSnapshot(snapshot,limit){
  if(array(snapshot?.memory_nodes).length<=limit)return snapshot;
  const ids=assessmentMemoryIds(snapshot.assessment||snapshot.answer_brief),nodes=selectWorkingSet(snapshot.memory_nodes,limit,ids,new Set()),kept=new Set(nodes.map(node=>String(node.memory_id))),edges=array(snapshot.memory_edges).filter(edge=>kept.has(String(edge.from_memory_id))&&kept.has(String(edge.to_memory_id)));
  return{...snapshot,memory_nodes:nodes,memory_edges:edges};
}
function withDynamicAspectLenses(instruction,snapshot){
  const copy=JSON.parse(JSON.stringify(instruction||{})),coverage=snapshot?.coverage_state||{},missing=[...array(coverage.missing_aspects),...array(snapshot?.investigation_focus?.missing_roles),...array(snapshot?.assessment?.missing_information)].map(String).filter(Boolean).slice(0,5);if(!missing.length)return copy;
  const lenses=array(copy.lenses),expansion=array(copy.expansion_terms).map(String);for(const [index,aspect] of missing.entries()){if(!lenses.some(item=>String(item?.id||'')===`missing_${index+1}`))lenses.push({id:`missing_${index+1}`,objective:aspect,terms:[aspect]});if(!expansion.includes(aspect))expansion.push(aspect);}copy.lenses=lenses.slice(0,8);copy.expansion_terms=expansion.slice(0,80);return copy;
}
function dynamicInvestigationFocus(previous,assessment,request){
  const roles=array(assessment?.role_coverage),covered=[...new Set(roles.filter(item=>item?.status==='covered').map(item=>String(item.role||'')).filter(Boolean))].slice(0,12),missing=[...new Set([...roles.filter(item=>['missing','partial','contradicted'].includes(String(item?.status))).map(item=>String(item.missing_detail||item.role||'')).filter(Boolean),...array(assessment?.missing_information).map(String)])].slice(0,8);
  return{target:String(previous?.target||request?.question||'').slice(0,180),scope:String(previous?.scope||request?.scope||'').slice(0,80),comparison_axis:String(previous?.comparison_axis||'').slice(0,160),covered_roles:covered,missing_roles:missing,excluded_interpretations:array(previous?.excluded_interpretations).slice(0,4),stop_condition:String(previous?.stop_condition||'All decision-changing aspects are source-grounded and no missing aspect remains.').slice(0,200)};
}
function embeddingQuery(questionRequest,instruction={}){
  const parts=[questionText(questionRequest),instruction.objective,...array(instruction.search_terms),...array(instruction.expansion_terms),...array(instruction.required_terms)].map(value=>String(value||'').trim()).filter(Boolean);
  return[...new Set(parts)].join('；').slice(0,1600);
}
function embeddingQueryForWorker(questionRequest,instruction={}){
  // The MedLoCoMo pairwise Admission model was trained with the raw Question
  // embedding. LLM-generated objectives and search terms still control lexical
  // filtering, but may not shift this learned dense feature at runtime.
  return String(questionRequest?.strategy_namespace||'')==='medlocomo'?questionText(questionRequest).slice(0,1600):embeddingQuery(questionRequest,instruction);
}
function normalizeRefinementBoundary(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const temporal=value.temporal&&typeof value.temporal==='object'&&!Array.isArray(value.temporal)?value.temporal:{},start=canonicalDate(temporal.start_date),end=canonicalDate(temporal.end_date),operator=['earliest','latest','range','exact'].includes(String(temporal.operator||''))?String(temporal.operator):'',excluded=[...new Set(array(value.excluded_memory_ids).map(String).filter(Boolean))];
  if(!excluded.length&&!start&&!end&&!operator)return null;
  return{version:'careharness-refinement-boundary.v1',boundary_id:String(value.boundary_id||`refine-${Math.max(1,Number(value.revision)||1)}`),revision:Math.max(1,Number(value.revision)||1),excluded_memory_ids:excluded,temporal:{...(operator?{operator}:{}),...(start?{start_date:start}:{}),...(end?{end_date:end}:{}),...(['earliest','latest'].includes(String(temporal.prefer||''))?{prefer:String(temporal.prefer)}:{})},permanent:true};
}
function discoveryRefinementBoundary(value,{recover_soft=false}={}){
  const normalized=normalizeRefinementBoundary(value);if(!recover_soft||!normalized)return normalized;
  // MedLoCoMo cross-Admission Refine is a working-set operation. Only an
  // explicitly marked hard boundary may constrain a later discovery turn;
  // semantic omissions remain recoverable when the Policy changes direction.
  return value?.hard===true||String(value?.boundary_kind||'')==='hard_temporal'?{...normalized,hard:true}:null;
}
function restoreProtectedAssessmentNodes(refined,current,protectedIds){
  const byId=new Map(array(current).map(node=>[String(node?.memory_id||''),node])),out=[],seen=new Set(),add=node=>{const id=String(node?.memory_id||'');if(id&&!seen.has(id)){seen.add(id);out.push(node);}};
  for(const node of array(refined))add(node);
  for(const id of array(protectedIds).map(String))if(byId.has(id))add(byId.get(id));
  return out;
}
function extendRefinementBoundary(previous,beforeNodes,afterNodes,instruction={}){
  const prior=normalizeRefinementBoundary(previous),keptIds=new Set(array(afterNodes).map(node=>String(node?.memory_id||'')).filter(Boolean)),removed=array(beforeNodes).filter(node=>!keptIds.has(String(node?.memory_id||''))),excluded=[...new Set([...(prior?.excluded_memory_ids||[]),...removed.map(node=>String(node?.memory_id||'')).filter(Boolean)])],explicit=normalizeBoundaryTemporal(instruction.temporal),inferred=inferTemporalBoundary(removed,afterNodes),temporal=intersectBoundaryTemporal(prior?.temporal,explicit||inferred),boundaryChanged=removed.length>0||Boolean(explicit),revision=(prior?.revision||0)+(boundaryChanged?1:0);
  if(!excluded.length&&!Object.keys(temporal).length)return prior;
  return normalizeRefinementBoundary({revision,boundary_id:`refine-${Math.max(1,revision)}`,excluded_memory_ids:excluded,temporal});
}
function inferTemporalBoundary(removed,kept){
  const keptDates=array(kept).map(node=>canonicalDate(node?.event_time)).filter(Boolean),removedDates=array(removed).map(node=>canonicalDate(node?.event_time)).filter(Boolean);if(!keptDates.length||!removedDates.length)return null;
  const min=[...keptDates].sort()[0],max=[...keptDates].sort().at(-1),earlier=removedDates.some(date=>date<min),later=removedDates.some(date=>date>max);
  if(later&&!earlier)return{operator:'earliest',end_date:max,prefer:'earliest'};
  if(earlier&&!later)return{operator:'latest',start_date:min,prefer:'latest'};
  return null;
}
function normalizeBoundaryTemporal(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return null;const operator=String(value.operator||''),dates=array(value.date_keys).map(canonicalDate).filter(Boolean),start=canonicalDate(value.start_date)||(operator==='exact'&&dates.length===1?dates[0]:''),end=canonicalDate(value.end_date)||(operator==='exact'&&dates.length===1?dates[0]:'');
  if(!start&&!end&&!['earliest','latest'].includes(operator))return null;
  return{...(['earliest','latest','range','exact'].includes(operator)?{operator}:{}),...(start?{start_date:start}:{}),...(end?{end_date:end}:{}),...(['earliest','latest'].includes(String(value.prefer||''))?{prefer:String(value.prefer)}:{})};
}
function intersectBoundaryTemporal(previous,next){
  const left=normalizeBoundaryTemporal(previous)||{},right=normalizeBoundaryTemporal(next)||{},starts=[left.start_date,right.start_date].filter(Boolean).sort(),ends=[left.end_date,right.end_date].filter(Boolean).sort(),start=starts.at(-1)||'',end=ends[0]||'',operator=right.operator||left.operator||((start||end)?'range':''),prefer=right.prefer||left.prefer||(['earliest','latest'].includes(operator)?operator:'');
  return{...(operator?{operator}:{}),...(start?{start_date:start}:{}),...(end?{end_date:end}:{}),...(prefer?{prefer}:{})};
}
function applyRefinementBoundary(nodes,boundary){
  if(!boundary)return array(nodes);const excluded=new Set(boundary.excluded_memory_ids),start=canonicalDate(boundary.temporal?.start_date),end=canonicalDate(boundary.temporal?.end_date);
  return array(nodes).filter(node=>{if(excluded.has(String(node?.memory_id||'')))return false;const date=canonicalDate(node?.event_time);if(start&&(!date||date<start))return false;if(end&&(!date||date>end))return false;return true;});
}
function applyTemporalGate(nodes,gate){
  if(!gate)return array(nodes);const start=canonicalDate(gate.start_date),end=canonicalDate(gate.end_date);return array(nodes).filter(node=>{const date=canonicalDate(node?.event_time);if(start&&(!date||date<start))return false;if(end&&(!date||date>end))return false;return true;});
}
function enforceRefinementBoundary(instruction,boundary){
  if(!boundary)return instruction;const clean=JSON.parse(JSON.stringify(instruction||{})),temporal=intersectBoundaryTemporal(boundary.temporal,clean.temporal),operator=boundary.temporal?.operator;
  if(operator)temporal.operator=operator;if(boundary.temporal?.prefer)temporal.prefer=boundary.temporal.prefer;clean.temporal=temporal;return clean;
}
function assessmentForNodes(value,nodes,patientProfile=null){
  if(!value||typeof value!=='object')return null;
  const ids=new Set(array(nodes).map(node=>String(node?.memory_id||'')).filter(Boolean)),profileRefs=new Set(array(patientProfile?.sections).flatMap(section=>array(section?.items)).map(item=>String(item?.source_ref||'')).filter(Boolean)),copy=JSON.parse(JSON.stringify(value)),keepRef=ref=>!ref.startsWith('memory:')||profileRefs.has(ref)||ids.has(ref.slice(7));
  copy.relevant_memory_ids=array(copy.relevant_memory_ids).map(String).filter(id=>ids.has(id));
  copy.answer_focus=array(copy.answer_focus).map(item=>{const memory_ids=array(item?.memory_ids).map(String).filter(id=>ids.has(id)),source_refs=array(item?.source_refs).map(String).filter(keepRef);return{...item,memory_ids,source_refs};}).filter(item=>item.source_refs.length||item.memory_ids.length);
  copy.role_coverage=array(copy.role_coverage).map(item=>{const memory_ids=array(item?.memory_ids).map(String).filter(id=>ids.has(id)),source_refs=array(item?.source_refs).map(String).filter(keepRef);return{...item,memory_ids,source_refs};}).filter(item=>item.status==='missing'||item.source_refs.length||item.memory_ids.length);
  copy.connections=array(copy.connections).map(item=>({...item,supporting_memory_ids:array(item?.supporting_memory_ids).map(String).filter(id=>ids.has(id))})).filter(item=>ids.has(String(item?.from_memory_id||''))&&ids.has(String(item?.to_memory_id||'')));
  copy.reasoning_hypotheses=array(copy.reasoning_hypotheses).map(item=>{const supporting_memory_ids=array(item?.supporting_memory_ids).map(String).filter(id=>ids.has(id)),counter_memory_ids=array(item?.counter_memory_ids).map(String).filter(id=>ids.has(id)),supporting_source_refs=array(item?.supporting_source_refs).map(String).filter(keepRef),counter_source_refs=array(item?.counter_source_refs).map(String).filter(keepRef);return{...item,supporting_memory_ids,counter_memory_ids,supporting_source_refs,counter_source_refs};}).filter(item=>item.supporting_source_refs.length||item.supporting_memory_ids.length);
  const originalOccurrences=array(copy.occurrence_candidates),filteredOccurrences=originalOccurrences.map(item=>filterOccurrenceCandidate(item,ids,keepRef)),occurrence_candidates=filteredOccurrences.filter(Boolean),occurrencePruned=filteredOccurrences.some((item,index)=>!item||item.grounding_complete===false&&originalOccurrences[index]?.grounding_complete===true);
  copy.occurrence_candidates=occurrence_candidates;
  if(occurrencePruned){if(copy.counting&&typeof copy.counting==='object')copy.counting={...copy.counting,scope_complete:false};if(copy.assessment==='supported')copy.assessment='partial';}
  return copy;
}
function filterOccurrenceCandidate(value,ids,keepRef){
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const copy={...value},requestedMemoryIds=array(copy.memory_ids).map(String),requestedSourceRefs=array(copy.source_refs).map(String),requestedEndpointIds=array(copy.endpoint_memory_ids).map(String),requestedSupportingIds=array(copy.supporting_memory_ids).map(String),memory_ids=requestedMemoryIds.filter(id=>ids.has(id)),source_refs=requestedSourceRefs.filter(ref=>keepRef(ref)&&(!ref.startsWith('memory:')||ids.has(ref.slice(7)))),endpoint_memory_ids=requestedEndpointIds.filter(id=>ids.has(id)),supporting_memory_ids=requestedSupportingIds.filter(id=>ids.has(id)),from=ids.has(String(copy.from_memory_id||''))?String(copy.from_memory_id):'',to=ids.has(String(copy.to_memory_id||''))?String(copy.to_memory_id):'',retained=[...memory_ids,...source_refs.filter(ref=>ref.startsWith('memory:')).map(ref=>ref.slice(7)),...endpoint_memory_ids,...supporting_memory_ids,from,to].filter(Boolean),lostGrounding=requestedMemoryIds.length!==memory_ids.length||requestedSourceRefs.length!==source_refs.length||requestedEndpointIds.length!==endpoint_memory_ids.length||requestedSupportingIds.length!==supporting_memory_ids.length||Boolean(copy.from_memory_id&&!from)||Boolean(copy.to_memory_id&&!to);
  if(!retained.length)return null;
  return{...copy,memory_ids,source_refs,...(Object.hasOwn(copy,'endpoint_memory_ids')?{endpoint_memory_ids}:{}),...(Object.hasOwn(copy,'supporting_memory_ids')?{supporting_memory_ids}:{}),...(Object.hasOwn(copy,'from_memory_id')?{from_memory_id:from||null}:{}),...(Object.hasOwn(copy,'to_memory_id')?{to_memory_id:to||null}:{}),...(copy.grounding_complete===true&&lostGrounding?{grounding_complete:false,included:false}:{})};
}
function prepareDiscoveryInstruction(questionRequest,instruction,pool,currentNodes,temporalGate=null){
  const clean=instruction&&typeof instruction==='object'&&!Array.isArray(instruction)?JSON.parse(JSON.stringify(instruction)):{},families=array(clean.required_families).map(String),weights=array(clean.family_weights);
  // Family labels are noisy multi-label facets. During discovery they rank
  // candidates; only an explicit Refine operation may use them as a hard set
  // boundary. This prevents a correct fact tagged CS/PE from disappearing
  // because the policy guessed BC, PA, or another plausible family.
  if(families.length){
    const known=new Set(weights.map(item=>String(item?.family||item)));
    for(const family of families)if(!known.has(family))weights.push({family,weight:2});
    clean.family_weights=weights;delete clean.required_families;delete clean.family_match;
  }
  clean.temporal=temporalGate?temporalInstructionForGate(temporalGate):groundTemporalInstruction(questionText(questionRequest),clean.temporal,pool,currentNodes);
  if(!Object.keys(clean.temporal).length)delete clean.temporal;
  if(temporalGate)relaxConflictingGateScope(clean,pool,temporalGate);else relaxConflictingExactScope(clean,pool);
  // Required literal terms must be feasible inside the effective calendar
  // scope, not merely somewhere else in the patient's full graph. Otherwise a
  // later similarly worded note can make an exact-date search impossible.
  relaxImpossibleRequiredTerms(clean,temporalScopedPool(pool,clean.temporal));
  return clean;
}

/**
 * Deterministic safety scope derived only from explicit calendar expressions
 * in the original question. It is a hard retrieval boundary, not a semantic
 * query plan. A date that is merely a historical baseline for a current/latest
 * question must not become an exact-date gate: that would make every later
 * update unreachable. Dates joined by an explicit range expression form a
 * range; otherwise multiple discrete dates define only a conservative span.
 * Relative-day facts may be documented in a later Session, so the worker searches from the computed
 * target day through the following 30 days, never before the target day, and
 * ranks the earliest matching record first.
 */
export function deriveQuestionTemporalGate(questionRequest,{documentation_lag_days=30}={}){
  const question=questionText(questionRequest),dates=datesInText(question);
  if(!dates.length)return null;
  const lag=Math.max(1,Math.min(90,Number(documentation_lag_days)||30));
  if(dates.length===1){
    const anchor=dates[0],offset=relativeDateOffset(question);
    if(offset!=null){
      const target=addDays(anchor,offset),end=addDays(target,lag);
      return{version:'careharness-question-temporal-gate.v2-semantic-scope',hard:true,kind:'relative_documentation_window',anchor_date:anchor,target_date:target,start_date:target,end_date:end,prefer:'earliest',documentation_lag_days:lag};
    }
  }
  // All explicit dates are historical lower-bound anchors when the requested
  // target is current/latest. Never invent an upper bound from the last one.
  if(asksForLatestStatus(question))return null;
  if(dates.length>=2){
    const ordered=[...dates].sort(),start=ordered[0],end=ordered.at(-1),kind=hasExplicitDateRangeSyntax(question)?'explicit_date_range':'discrete_dates_span';
    return{version:'careharness-question-temporal-gate.v2-semantic-scope',hard:true,kind,anchor_date:start,target_date:start,start_date:start,end_date:end,prefer:'earliest',documentation_lag_days:0};
  }
  const anchor=dates[0];
  return{version:'careharness-question-temporal-gate.v2-semantic-scope',hard:true,kind:'explicit_date',anchor_date:anchor,target_date:anchor,start_date:anchor,end_date:anchor,prefer:'earliest',documentation_lag_days:0};
}

function normalizeTemporalGate(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||value.hard!==true)return null;
  const start=canonicalDate(value.start_date),end=canonicalDate(value.end_date),target=canonicalDate(value.target_date),anchor=canonicalDate(value.anchor_date);
  if(!start||!end||start>end||!target||target<start||target>end)return null;
  return{version:String(value.version||'careharness-question-temporal-gate.v2-semantic-scope'),hard:true,kind:String(value.kind||'explicit_date'),anchor_date:anchor||target,target_date:target,start_date:start,end_date:end,prefer:String(value.prefer||'earliest')==='latest'?'latest':'earliest',documentation_lag_days:Math.max(0,Number(value.documentation_lag_days)||0)};
}
function temporalInstructionForGate(gate){return gate.start_date===gate.end_date?{operator:'exact',date_keys:[gate.target_date]}:{operator:'range',start_date:gate.start_date,end_date:gate.end_date,prefer:gate.prefer};}
function relaxConflictingGateScope(instruction,pool,gate){
  const episodes=new Set(array(instruction.episode_ids).map(String));if(!episodes.size)return;
  const inGate=array(pool).filter(node=>{const date=canonicalDate(node?.event_time);return date&&date>=gate.start_date&&date<=gate.end_date;});
  if(inGate.length&&!inGate.some(node=>episodes.has(String(node?.episode_id||''))))delete instruction.episode_ids;
}
function relaxImpossibleRequiredTerms(instruction,pool){
  const required=array(instruction.required_terms).map(String).filter(Boolean);
  if(!required.length)return;
  const normalizeText=value=>String(value||'').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu,'');
  const possible=array(pool).some(node=>{const text=normalizeText([node?.text,node?.source_text].filter(Boolean).join(' '));return required.every(term=>text.includes(normalizeText(term)));});
  if(possible)return;
  instruction.search_terms=[...new Set([...array(instruction.search_terms).map(String),...required])];
  delete instruction.required_terms;
  instruction.term_match='any';
}
function temporalScopedPool(pool,temporal={}){
  const exact=new Set(resolvedExactDates(temporal)),months=new Set(array(temporal?.month_keys).map(value=>canonicalCalendarMonth(String(value).slice(0,7))).filter(Boolean)),start=canonicalDate(temporal?.start_date),end=canonicalDate(temporal?.end_date);
  if(!exact.size&&!months.size&&!start&&!end)return array(pool);
  return array(pool).filter(node=>{const date=canonicalDate(node?.event_time),month=date.slice(0,7);if(exact.size&&!exact.has(date))return false;if(months.size&&!months.has(month))return false;if(start&&(!date||date<start))return false;if(end&&(!date||date>end))return false;return true;});
}
function relaxConflictingExactScope(instruction,pool){
  const temporal=instruction.temporal||{},dates=resolvedExactDates(temporal);
  if(String(temporal.operator||'')!=='exact'||!dates.length)return;
  const dateSet=new Set(dates),dated=array(pool).filter(node=>dateSet.has(canonicalDate(node?.event_time)));
  const episodes=new Set(array(instruction.episode_ids).map(String));
  // A policy-generated Session ID is only a retrieval hint. When it conflicts
  // with an exact date copied from the question, preserve the auditable date
  // scope instead of turning the conjunction into guaranteed zero recall.
  if(dated.length&&episodes.size&&!dated.some(node=>episodes.has(String(node?.episode_id||''))))delete instruction.episode_ids;
  // Conversation-derived memories retain the Session date. A fact phrased as
  // "the next day" inside that Session may therefore have no row on the
  // computed calendar date; fall back to the visible base-date Session rather
  // than declaring the recorded value absent.
  if(!dated.length&&canonicalDate(temporal.base_date)&&Number.isInteger(Number(temporal.offset_days))){
    const base=canonicalDate(temporal.base_date);
    if(array(pool).some(node=>canonicalDate(node?.event_time)===base))instruction.temporal={operator:'exact',date_keys:[base]};
  }
}
function resolvedExactDates(temporal){
  const dates=array(temporal?.date_keys).map(canonicalDate).filter(Boolean),base=canonicalDate(temporal?.base_date),offset=Number(temporal?.offset_days);
  if(base&&Number.isInteger(offset)){const date=new Date(`${base}T00:00:00.000Z`);date.setUTCDate(date.getUTCDate()+offset);dates.push(date.toISOString().slice(0,10));}
  return[...new Set(dates)];
}
function groundTemporalInstruction(question,temporalValue,pool,currentNodes){
  const temporal=temporalValue&&typeof temporalValue==='object'&&!Array.isArray(temporalValue)?JSON.parse(JSON.stringify(temporalValue)):{},questionDates=datesInText(question),questionMonths=monthsInText(question,questionDates),currentDates=new Set(array(currentNodes).map(node=>canonicalDate(node?.event_time)).filter(Boolean));
  // The LLM policy owns semantic operators such as latest/current/earliest.
  // Deterministic grounding may override them only for an unambiguous calendar
  // expression in the question, never for a decimal clinical measurement.
  // A question can name a dated baseline and then ask for a different month
  // without repeating its year (for example, "2023 年 12 月底……1 月"). In
  // that case a policy range for the explicitly named target month is grounded;
  // do not replace it with the baseline month merely because only the baseline
  // has a four-digit year. The month marker is required, so measurements such
  // as 66.5 kg cannot authorize a calendar constraint.
  const suppliedDates=[...array(temporal.date_keys).map(canonicalDate),canonicalDate(temporal.base_date),canonicalDate(temporal.start_date),canonicalDate(temporal.end_date)].filter(Boolean),suppliedMonths=new Set(suppliedDates.map(date=>date.slice(0,7))),yearlessMonthNumbers=explicitYearlessMonthNumbers(question),grounded=suppliedDates.every(date=>questionDates.includes(date)||currentDates.has(date)||yearlessMonthNumbers.has(Number(date.slice(5,7))));
  // A year-month expression denotes the whole month. Do not let a policy turn
  // it into an invented exact first day merely because the month number agrees.
  if(!questionDates.length&&questionMonths.length&&suppliedMonths.size&&[...suppliedMonths].every(month=>questionMonths.includes(month)))return{operator:'range',month_keys:questionMonths};
  if(suppliedDates.length&&grounded)return temporal;
  if(!suppliedDates.length&&!questionDates.length&&questionMonths.length)return{operator:'range',month_keys:questionMonths};
  if(suppliedDates.length&&!grounded){
    if(!questionDates.length&&questionMonths.length)return{operator:'range',month_keys:questionMonths};
    // A vague phrase such as "recent two days" is not an executable calendar
    // boundary. Never repair an invented Policy range by anchoring it to the
    // newest graph record; keep the phrase semantic and searchable instead.
    return{};
  }
  return temporal;
}
function explicitYearlessMonthNumbers(value){
  const text=String(value||'').normalize('NFKC'),out=new Set();for(const match of text.matchAll(/(?<!\d)(\d{1,2})\s*月/gu)){const prefix=text.slice(Math.max(0,match.index-10),match.index);if(/(?:\d{4}|\d{2})\s*年\s*$/u.test(prefix))continue;const month=Number(match[1]);if(month>=1&&month<=12)out.add(month);}return out;
}
function boundedAnswerNodes(snapshot,limit,preferredNodes=[]){
  const nodes=array(snapshot.memory_nodes),byId=new Map(nodes.map(node=>[String(node?.memory_id||''),node])),assessment=snapshot.assessment||snapshot.answer_brief||{},priority=assessmentMemoryIds(assessment),preferred=array(preferredNodes).map(node=>String(node?.memory_id||'')),out=[],seen=new Set(),add=id=>{const key=String(id||'');if(key&&!seen.has(key)&&byId.has(key)&&out.length<limit){seen.add(key);out.push(byId.get(key));}},crossAdmissionScope=isMedLoCoMoCrossAdmissionScope(snapshot?.question_request),reasoningRequired=requiresClinicalReasoning(questionText(snapshot?.question||snapshot?.question_request||''),{medlocomo_cross_admission:crossAdmissionScope});
  if(String(snapshot?.question_request?.query_type||'')==='frequency_pattern'&&/\bhow\s+many\b|\bnumber\s+of\b/iu.test(questionText(snapshot?.question_request))){
    const prioritySet=new Set(priority),groups=new Map();
    for(const node of nodes){const key=String(node?.episode_id||node?.observation_id||node?.memory_id||''),values=groups.get(key)||[];values.push(node);groups.set(key,values);}
    const ordered=[...groups.values()].map(values=>values.sort((left,right)=>Number(prioritySet.has(String(right?.memory_id)))-Number(prioritySet.has(String(left?.memory_id))))).sort((left,right)=>Number(prioritySet.has(String(right[0]?.memory_id)))-Number(prioritySet.has(String(left[0]?.memory_id))));
    for(let depth=0;out.length<limit&&ordered.some(values=>depth<values.length);depth++)for(const values of ordered){if(values[depth])add(values[depth].memory_id);if(out.length>=limit)break;}
    return out;
  }
  if(crossAdmissionScope)return episodeDiverseAnswerNodes(nodes,limit,priority,preferred,{reasoning_required:reasoningRequired});
  if(!reasoningRequired&&!preferred.length){for(const id of priority)add(id);for(const node of nodes)add(node?.memory_id);return out;}
  const reserve=clinicalRoleCandidates(nodes,priority),priorityQuota=Math.max(4,limit-Math.min(7,reserve.length));
  for(const id of priority.slice(0,priorityQuota))add(id);
  for(const node of reserve)add(node.memory_id);
  for(const id of preferred)add(id);
  for(const id of priority)add(id);
  for(const node of nodes)add(node?.memory_id);
  return out;
}
function episodeDiverseAnswerNodes(nodes,limit,priorityIds=[],preferredIds=[],options={}){
  const priorityRank=new Map(priorityIds.map((id,index)=>[String(id),index])),preferredRank=new Map(preferredIds.map((id,index)=>[String(id),index])),groups=new Map();
  for(const node of array(nodes)){const key=String(node?.episode_id||node?.observation_id||node?.memory_id||''),values=groups.get(key)||[];values.push(node);groups.set(key,values);}
  const ordered=[...groups.values()].map(values=>{
    const result=[],seen=new Set(),add=node=>{const id=String(node?.memory_id||'');if(id&&!seen.has(id)){seen.add(id);result.push(node);}},priority=[...values].filter(node=>priorityRank.has(String(node?.memory_id||''))).sort((left,right)=>priorityRank.get(String(left.memory_id))-priorityRank.get(String(right.memory_id))),preferred=[...values].filter(node=>preferredRank.has(String(node?.memory_id||''))).sort((left,right)=>preferredRank.get(String(left.memory_id))-preferredRank.get(String(right.memory_id)));
    for(const node of priority)add(node);for(const node of preferred)add(node);
    if(options.reasoning_required===true)for(const node of clinicalRoleCandidates(values,priorityIds))add(node);
    for(const node of values)add(node);
    return result;
  }),out=[];
  for(let depth=0;out.length<limit&&ordered.some(values=>depth<values.length);depth++)for(const values of ordered){if(values[depth])out.push(values[depth]);if(out.length>=limit)break;}
  return out;
}
function assessmentMemoryIds(assessment){return[...new Set([
  ...array(assessment?.relevant_memory_ids),
  ...array(assessment?.answer_focus).flatMap(item=>[...array(item?.memory_ids),...sourceRefMemoryIds(item?.source_refs)]),
  ...array(assessment?.role_coverage).flatMap(item=>[...array(item?.memory_ids),...sourceRefMemoryIds(item?.source_refs)]),
  ...array(assessment?.connections).flatMap(item=>[item?.from_memory_id,item?.to_memory_id,...array(item?.supporting_memory_ids)]),
  ...array(assessment?.reasoning_hypotheses).flatMap(item=>[...array(item?.supporting_memory_ids),...array(item?.counter_memory_ids),...sourceRefMemoryIds(item?.supporting_source_refs),...sourceRefMemoryIds(item?.counter_source_refs)]),
  ...array(assessment?.occurrence_candidates).flatMap(item=>[...array(item?.memory_ids),...sourceRefMemoryIds(item?.source_refs),...array(item?.endpoint_memory_ids),...array(item?.supporting_memory_ids),item?.from_memory_id,item?.to_memory_id]),
].map(String).filter(Boolean))];}
function sourceRefMemoryIds(value){return array(value).map(String).filter(ref=>ref.startsWith('memory:')&&ref.length>7).map(ref=>ref.slice(7));}

function clinicalRoleCandidates(nodes,priorityIds=[]){
  const priority=new Set(priorityIds.map(String)),roles=[
    /(?:确诊|诊断|阳性|阴性|分型|病史|检查提示|评估为)/u,
    /(?:\d+(?:\.\d+)?\s*(?:%|[a-z]+(?:\/[a-z]+)?|次\/分|斤)|检查|检验|指标|测得|结果)/iu,
    /(?:药|治疗|剂量|注射|服用|停用|改用|加用|减量|方案)/u,
    /(?:失效|无效|改善|恶化|反弹|下降|升高|控制|执行|漏服|依从)/u,
    /(?:风险|禁用|禁忌|过敏|并发症|出血|急诊|晕厥|呼吸困难)/u,
    /(?:费用|成本|预算|经济|偏好|担心|无法|困难)/u,
  ],selected=[];
  for(const role of roles){const candidates=nodes.filter(node=>role.test(String(node?.text||''))).sort((a,b)=>roleUtility(b,priority)-roleUtility(a,priority));if(candidates[0]&&!selected.some(node=>node.memory_id===candidates[0].memory_id))selected.push(candidates[0]);}
  const dated=nodes.filter(node=>Date.parse(node?.event_time||''));if(dated.length){const earliest=[...dated].sort((a,b)=>Date.parse(a.event_time)-Date.parse(b.event_time))[0],latest=[...dated].sort((a,b)=>Date.parse(b.event_time)-Date.parse(a.event_time))[0];for(const node of[earliest,latest])if(node&&!selected.some(item=>item.memory_id===node.memory_id))selected.push(node);}
  return selected;
}
function roleUtility(node,priority){return(priority.has(String(node?.memory_id))?8:0)+(String(node?.memory_id||'').includes(':llm:')?2:0)+(/\d/.test(String(node?.text||''))?1:0);}
function requiresClinicalReasoning(value,options={}){const text=String(value||'');return/(?:为什么|原因|怎么回事|意味着|说明|导致|关系|要不要|需不需要|是否需要|该不该|能不能|可不可以|建议|调整|加量|减量|换药|停药|恢复|影响|风险|判断)/u.test(text)||(options.medlocomo_cross_admission===true&&/(?:\b(?:differ(?:ed)?|chang(?:e|ed)|compar(?:e|ed)|evolv(?:e|ed)|shift(?:ed)?)\b|\bfrom\b[\s\S]{0,160}\bto\b)/iu.test(text));}
function isMedLoCoMoCrossAdmissionScope(value){return String(value?.strategy_namespace||'')==='medlocomo'&&String(value?.scope||'')==='cross_admission';}
function questionText(value){return String(value?.question||value||'').normalize('NFKC');}
function relativeDateOffset(value){const text=String(value||'').normalize('NFKC');if(/(?:大前天|三天前)/u.test(text))return-3;if(/(?:大后天|三天后)/u.test(text))return 3;if(/(?:前天|两天前)/u.test(text))return-2;if(/(?:后天|两天后)/u.test(text))return 2;if(/(?:前一日|前一天|上一日|前日|previous day)/iu.test(text))return-1;if(/(?:次日|翌日|第二天|后一天|下一日|next day)/iu.test(text))return 1;return null;}
function asksForLatestStatus(value){return/(?:当前|目前|现在|如今|现今|现阶段|眼下|时下|最新|最近一次|至今|current(?:ly)?|now|today|latest|most\s+recent|at\s+present|since\s+then)/iu.test(String(value||'').normalize('NFKC'));}
function hasExplicitDateRangeSyntax(value){return/(?:\d(?:日)?\s*(?:至|到)\s*\d{4}|之间|期间|\bfrom\b[\s\S]*\bto\b|\bbetween\b[\s\S]*\band\b)/iu.test(String(value||'').normalize('NFKC'));}
function addDays(value,days){const date=new Date(`${value}T00:00:00.000Z`);date.setUTCDate(date.getUTCDate()+Number(days||0));return date.toISOString().slice(0,10);}
function mergeById(left,right,key){const out=[],seen=new Set();for(const item of[...array(left),...array(right)]){const id=String(item?.[key]||'');if(!id||seen.has(id))continue;seen.add(id);out.push(item);}return out;}
function changedIds(before,after,key='memory_id'){return array(before).map(item=>item?.[key]).join('|')!==array(after).map(item=>item?.[key]).join('|');}
function navigationPathSignature(value){return array(value).map(path=>JSON.stringify(stableSignatureValue(path))).sort().join('|');}
function stableSignatureValue(value){if(Array.isArray(value))return value.map(stableSignatureValue);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,stableSignatureValue(value[key])]));return value;}
function array(value){return Array.isArray(value)?value:[];}
