import { retrieveEvidenceCandidates,retrieveSessionEvidenceAnchors,retrieveStateCandidates } from './retrieval.js';
import { CAREHARNESS_ACTIONS,CAREHARNESS_RUNTIME_CONTROLS } from './careharness-contract.js';

export const CAREHARNESS_ACTION_POLICY_VERSION='careharness-universal-action-policy.v29-type-blind';
const QUERY_TIME_RELATION_TYPES=new Set(['care_targets','observed_after_care','motivates','constrains','followed_by']);
const QUERY_TIME_RELATION_CONFIDENCE_MIN=.8;
const QUERY_TIME_RELATION_MAX=8;

export function selectCareHarnessActions(_queryPlan={},options={}){
  const desired=desiredCareHarnessActions();
  const budget=positiveInteger(options.action_budget)||6;
  if(budget<3)throw new Error('CareHarness action_budget must be at least 3 (focus, verify, answer)');
  if(desired.length<=budget)return desired;
  const optional=desired.filter(action=>!['focus','verify','answer'].includes(action)),available=Math.max(0,budget-3);
  return['focus',...optional.slice(0,available),'verify','answer'];
}

export function executeCareHarnessPolicy(queryPlan,states=[],evidence=[],options={}){
  const candidateBudget=positiveInteger(options.candidate_budget)||24,actionBudget=positiveInteger(options.action_budget)||6,desiredActions=desiredCareHarnessActions(),selectedActions=selectCareHarnessActions(queryPlan,options),budgetExhausted=selectedActions.length<desiredActions.length,evidenceById=new Map(evidence.map(item=>[String(item.evidence_id),item])),graphEdges=Array.isArray(options.graph_edges)?options.graph_edges:[];
  assertSingleRuntimeSubject(states,evidence,graphEdges);
  let context={states:[],evidence:[],candidates:[],evidence_chains:[],session_anchors:[],trace:{}},relations=[],proof=null,verification=null;
  const actionTrace=[];
  for(const action of selectedActions){
    const before={states:context.states.length,evidence:context.evidence.length,relations:relations.length};
    if(action==='focus'){
      context=retrieveStateCandidates(queryPlan,states,evidence,{limit:candidateBudget,gate_limit:candidateBudget,graph_edges:graphEdges});
    }
    else if(action==='anchor'){
      const focusedEvidenceIds=new Set(context.evidence.map(item=>String(item.evidence_id))),direct=retrieveEvidenceCandidates(queryPlan,evidence,directEvidenceOptions(candidateBudget)),anchored=retrieveSessionEvidenceAnchors(queryPlan,evidence,sessionAnchorOptions(candidateBudget)),contrasted=Array.isArray(queryPlan.options)&&queryPlan.options.length?retrieveOptionContrastEvidence(queryPlan,evidence,candidateBudget):{evidence:[],trace:{version:'careharness-option-contrast.v4',status:'not_applicable',selected_count:0,option_results:[]}},priority=mergeEvidence(anchored.evidence,direct.evidence,contrasted.evidence),recovered=priority.filter(item=>!focusedEvidenceIds.has(String(item.evidence_id)));
      context={...context,evidence:mergeEvidence(priority,context.evidence),session_anchors:anchored.anchors,direct_evidence_ids:recovered.map(item=>String(item.evidence_id)),priority_evidence_ids:priority.map(item=>String(item.evidence_id)),trace:{...context.trace,direct_evidence_fallback:direct.trace,session_anchor:anchored.trace,option_contrast:contrasted.trace}};
      context=discriminateEventStage(queryPlan,context,evidenceById);
      context=traceVersionsAndTime(queryPlan,context,states,evidenceById,candidateBudget,graphEdges);
    }
    else if(action==='connect')relations=buildQueryTimeRelations(context.states,evidenceById,graphEdges);
    else if(action==='evaluate')proof=evaluateHypothesis(queryPlan,context.states,relations,evidenceById);
    else if(action==='verify'){
      verification=verifyWorkingState(context.states,relations,evidenceById,{query_plan:queryPlan,full_visible_states:states});
      const directEvidence=(context.direct_evidence_ids||[]).map(id=>evidenceById.get(String(id))).filter(Boolean),priorityEvidence=(context.priority_evidence_ids||[]).map(id=>evidenceById.get(String(id))).filter(Boolean),answerStates=prioritizeVerifiedStates(verification.states,context.session_anchors,priorityEvidence,candidateBudget),answerStateEvidence=collectEvidence(answerStates,evidenceById),answerEvidence=mergeEvidence(priorityEvidence,answerStateEvidence,directEvidence).slice(0,genericAnswerEvidenceLimit(candidateBudget));
      context={...context,states:answerStates,evidence:answerEvidence};
      relations=verification.relations;
      if(proof)proof=verifyProof(queryPlan,context.states,relations,evidenceById);
    }
    const after={states:context.states.length,evidence:context.evidence.length,relations:relations.length};
    const outcome=action==='focus'?{selected_nodes:context.states.length,selected_state_evidence:context.evidence.length}:action==='anchor'?{selected_sessions:context.session_anchors?.length||0,selected_evidence:context.evidence.length,direct_evidence_fallback_count:context.direct_evidence_ids?.length||0,option_count:context.trace.option_contrast?.option_results?.length||0,covered_options:context.trace.option_contrast?.covered_option_count||0,refreshed_current_states:context.trace.trace_action?.refreshed_current_state_count||0,removed_stale_states:context.trace.trace_action?.removed_stale_state_count||0}:action==='connect'?{persistent_relations:relations.filter(item=>item.persistent===true).length,candidate_relations:relations.filter(item=>item.verified!==true||item.status==='candidate').length,verified_relations:relations.filter(item=>item.verified===true).length,no_link:relations.filter(item=>item.verified===true).length===0}:action==='evaluate'?{verdict:proof?.verdict||'unresolved',complete:Boolean(proof?.complete),missing_families:proof?.missing_families||[],disconnected_families:proof?.disconnected_families||[]}:action==='verify'?{accepted_nodes:context.states.length,accepted_relations:relations.length,rejected_nodes:verification?.rejected_states?.length||0,rejected_relations:verification?.rejected_relations?.length||0,hypothesis_verdict:proof?.verdict||null}:action==='answer'?answerOutcome({budgetExhausted,verification,proof,stateCount:context.states.length}):null;
    actionTrace.push({ordinal:actionTrace.length+1,action,control:actionControl(action),status:'completed',before,after,outcome,cost_units:action==='answer'?0:1});
  }
  const workingState={
    version:'careharness-working-subgraph.v2',
    controls:[...CAREHARNESS_RUNTIME_CONTROLS],
    control_decisions:{
      scope:{selected_families:[...new Set(context.states.map(item=>item.family))],requested_scopes:queryPlan.state_scopes||[],candidate_budget:candidateBudget,selected_node_count:context.states.length,policy:'evidence_first_factor_scope'},
      time:{operator:queryPlan.temporal_operator||'none',resolved_node_ids:context.states.filter(item=>item.event_time||item.episode_id).map(item=>item.state_id),stability_policy:'absence_of_update_is_unknown_not_stable'},
      relation:{selected_edge_ids:relations.map(item=>item.edge_id).filter(Boolean),verified_edge_count:relations.length,no_link:relations.length===0,causality_asserted:false}
    },
    session_anchors:context.session_anchors||[],
    problem:{target:queryPlan.target||null,clinical_question:queryPlan.question||null},
    temporal:{operator:queryPlan.temporal_operator||'none',resolved_state_ids:context.states.filter(item=>item.event_time).map(item=>item.state_id)},
    route:[...new Set(context.states.map(item=>item.family))],
    state_ids:context.states.map(item=>item.state_id),
    graph_subgraph:{patient_graph_version:'careharness-patient-graph.v1',node_ids:context.states.map(item=>item.state_id),edge_ids:relations.map(item=>item.edge_id).filter(Boolean),persistent_edge_count:relations.filter(item=>item.persistent===true).length,query_local_edge_count:relations.filter(item=>item.persistent===false).length},
    evidence:{evidence_ids:context.evidence.map(item=>item.evidence_id),verified_relations:relations,proof,verification}
  };
  return{
    states:context.states,evidence:context.evidence,candidates:context.candidates||[],evidence_chains:context.evidence_chains||[],session_anchors:context.session_anchors||[],
    working_state:workingState,relations,proof,verification,
    action_policy:{version:CAREHARNESS_ACTION_POLICY_VERSION,selective:false,type_blind:true,available_actions:[...CAREHARNESS_ACTIONS],selected_actions:selectedActions,action_budget:actionBudget,candidate_budget:candidateBudget,total_cost_units:actionTrace.reduce((sum,item)=>sum+item.cost_units,0)},
    action_trace:actionTrace,
    trace:{...context.trace,careharness_action_policy:{version:CAREHARNESS_ACTION_POLICY_VERSION,selected_actions:selectedActions,action_budget:actionBudget,candidate_budget:candidateBudget,total_cost_units:actionTrace.reduce((sum,item)=>sum+item.cost_units,0)},working_subgraph:{source:'persistent_patient_graph',persistent_graph_available:graphEdges.length>0,node_count:context.states.length,edge_count:relations.length},query_time_relations:{persistent_graph_edges:relations.filter(item=>item.persistent===true).length,query_local_edges:relations.filter(item=>item.persistent===false).length,count:relations.length,types:[...new Set(relations.map(item=>item.type))]},verification}
  };
}

export function buildQueryTimeRelations(states=[],evidenceById=new Map(),persistentEdges=[]){
  const stateById=new Map(states.map(state=>[String(state.state_id),state])),byEvidence=new Map(),relations=[],keys=new Set(),canonicalTemporalPairs=new Set();
  const add=(from,to,type,evidenceIds=[],metadata={})=>{
    from=String(from||'');to=String(to||'');
    if(!from||!to||from===to||!stateById.has(from)||!stateById.has(to))return;
    const fromState=stateById.get(from),toState=stateById.get(to),subject=String(fromState.subject_id||'');if(subject!==String(toState.subject_id||''))return;
    const declared=[...new Set((evidenceIds||[]).filter(Boolean).map(String))];
    if(!declared.length||declared.some(id=>!evidenceById.has(id)||String(evidenceById.get(id)?.subject_id||'')!==subject))return;
    const key=[from,to,type].join('\u0000');if(keys.has(key))return;keys.add(key);
    relations.push({edge_id:metadata.edge_id||null,from_state_id:from,to_state_id:to,type,edge_family:metadata.edge_family||relationFamily(type),evidence_ids:declared,confidence:Number(metadata.confidence??1),support_kind:metadata.support_kind||'structural',semantic_support:metadata.semantic_support===true,verified:metadata.verified??true,persistent:metadata.persistent??false,causal_claim:false,status:metadata.status||'verified',source:metadata.source||'query_local'});
  };
  for(const edge of persistentEdges){
    if(!stateById.has(String(edge.from_state_id))||!stateById.has(String(edge.to_state_id)))continue;
    if(edge.causal_claim===true)continue;
    if(edge.edge_family==='temporal')canonicalTemporalPairs.add(endpointPairKey(edge.from_state_id,edge.to_state_id));
    add(edge.from_state_id,edge.to_state_id,edge.relation_type||edge.type,edge.evidence_ids,{edge_id:edge.edge_id,edge_family:edge.edge_family,confidence:edge.confidence,support_kind:edge.support_kind,semantic_support:false,verified:edge.status==='verified'&&edge.verified!==false,persistent:true,status:edge.status,source:edge.source||'patient_graph'});
  }
  for(const state of states){
    for(const evidenceId of state.evidence_ids||[]){const id=String(evidenceId),items=byEvidence.get(id)||[];items.push(state);byEvidence.set(id,items);}
    const predecessor=state.conflicts_with||state.supersedes||(state.version_chain||[]).at(-1),prior=stateById.get(String(predecessor||''));
    if(!prior||canonicalTemporalPairs.has(endpointPairKey(prior.state_id,state.state_id)))continue;
    const operation=String(state.operation||'').toUpperCase(),evidenceIds=[...(prior.evidence_ids||[]),...(state.evidence_ids||[])];
    if(operation==='CONFLICT'||state.conflicts_with)add(state.state_id,prior.state_id,'conflicts',evidenceIds);
    else if(operation==='SUPERSEDE'||state.supersedes)add(state.state_id,prior.state_id,'supersedes',evidenceIds);
    else if(operation==='RESOLVE')add(state.state_id,prior.state_id,'resolves',evidenceIds);
    else if(operation==='NOOP')add(prior.state_id,state.state_id,'persists',evidenceIds);
    else if(operation==='UPDATE'||(!operation&&(state.version_chain||[]).length))add(prior.state_id,state.state_id,'updates',evidenceIds);
  }
  for(const[evidenceId,items]of byEvidence)for(let i=0;i<items.length;i++)for(let j=i+1;j<items.length;j++)add(items[i].state_id,items[j].state_id,'informs',[evidenceId],{confidence:.35,support_kind:'hypothesized',verified:false,status:'candidate',source:'query_local_shared_evidence_candidate'});
  return relations;
}

// The semantic evaluator is optional and query-local. It never mutates the
// persistent Patient Graph. Its output is still checked here against the
// frozen Working State, patient identity, and Evidence bindings before a
// relation is allowed to participate in evaluate/verify.
export function queryTimeRelationEvaluatorInput(queryPlan={},runtime={}){
  const states=Array.isArray(runtime.states)?runtime.states:[],evidence=Array.isArray(runtime.evidence)?runtime.evidence:[];
  return{
    question:String(queryPlan.question||''),
    target:queryPlan.target||null,
    temporal_operator:queryPlan.temporal_operator||'none',
    required_families:requiredFamilies(queryPlan),
    states:states.map(item=>({state_id:String(item.state_id),family:item.family,value:item.value,event_time:item.event_time||null,status:item.status||null,evidence_ids:[...(item.evidence_ids||[])].map(String)})),
    evidence:evidence.map(item=>({evidence_id:String(item.evidence_id),text:item.text,source_type:item.source_type||null,event_time:item.event_time||null,polarity:item.polarity||null,certainty:item.certainty??null}))
  };
}

export function validateQueryTimeRelationEvaluation(value){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('CareHarness relation evaluation must be an object');
  if(!Array.isArray(value.relations))throw new Error('CareHarness relation evaluation relations must be an array');
  const verdict=String(value.verdict||'unresolved').toLowerCase();if(!['supported','contradicted','unresolved'].includes(verdict))throw new Error('CareHarness relation evaluation verdict is invalid');
  if(value.relations.length>QUERY_TIME_RELATION_MAX)throw new Error(`CareHarness relation evaluation may return at most ${QUERY_TIME_RELATION_MAX} relations`);
  const relations=value.relations.map((item,index)=>{
    if(!item||typeof item!=='object'||Array.isArray(item))throw new Error(`CareHarness relation evaluation relation ${index} must be an object`);
    const from=String(item.from_state_id||''),to=String(item.to_state_id||''),type=String(item.relation_type||item.type||'').toLowerCase(),assessment=String(item.assessment||'unresolved').toLowerCase(),confidence=Number(item.confidence);
    if(!from||!to||from===to)throw new Error(`CareHarness relation evaluation relation ${index} has invalid endpoints`);
    if(!QUERY_TIME_RELATION_TYPES.has(type))throw new Error(`CareHarness relation evaluation relation ${index} has invalid relation_type`);
    if(!['supports','contradicts','unresolved'].includes(assessment))throw new Error(`CareHarness relation evaluation relation ${index} has invalid assessment`);
    const relationEvidenceId=String(item.relation_evidence_id||''),relationQuote=String(item.relation_quote||''),fromClaimQuote=String(item.from_claim_quote||''),toClaimQuote=String(item.to_claim_quote||'');
    if(!relationEvidenceId||!relationQuote||!fromClaimQuote||!toClaimQuote)throw new Error(`CareHarness relation evaluation relation ${index} requires one relation-bearing Evidence quote and both endpoint claim quotes`);
    if(!Number.isFinite(confidence)||confidence<0||confidence>1)throw new Error(`CareHarness relation evaluation relation ${index} has invalid confidence`);
    return{from_state_id:from,to_state_id:to,relation_type:type,relation_evidence_id:relationEvidenceId,relation_quote:relationQuote.slice(0,800),from_claim_quote:fromClaimQuote.slice(0,300),to_claim_quote:toClaimQuote.slice(0,300),assessment,confidence};
  });
  return{verdict,relations,competing_hypotheses_checked:value.competing_hypotheses_checked===true,competing_hypotheses:Array.isArray(value.competing_hypotheses)?value.competing_hypotheses.map(item=>String(item).slice(0,300)).slice(0,6):[],missing_evidence:Array.isArray(value.missing_evidence)?value.missing_evidence.map(item=>String(item).slice(0,300)).slice(0,12):[],no_link_reason:String(value.no_link_reason||'').slice(0,500)};
}

export function applyQueryTimeRelationEvaluation(queryPlan,baseline,evaluation,options={}){
  if(baseline?.verification?.safe_to_answer!==true)throw new Error('Semantic relation evaluation requires a deterministically verified, non-blocking Working State');
  const normalized=validateQueryTimeRelationEvaluation(evaluation),states=Array.isArray(baseline?.states)?baseline.states:[],evidence=Array.isArray(baseline?.evidence)?baseline.evidence:[],evidenceById=new Map(evidence.map(item=>[String(item.evidence_id),item])),stateById=new Map(states.map(item=>[String(item.state_id),item])),accepted=[],rejected=[];
  const overallCanSupport=normalized.verdict==='supported'&&normalized.competing_hypotheses_checked===true&&normalized.missing_evidence.length===0;
  for(let index=0;index<normalized.relations.length;index++){
    const candidate=normalized.relations[index],chronologyOnly=candidate.relation_type==='followed_by'&&candidate.assessment==='supports',checked=overallCanSupport||chronologyOnly?checkedSemanticRelation(candidate,stateById,evidenceById,index):{relation:null,rejection:{index,from_state_id:candidate.from_state_id,to_state_id:candidate.to_state_id,relation_type:candidate.relation_type,reason:normalized.verdict!=='supported'?`overall_verdict_${normalized.verdict}`:normalized.competing_hypotheses_checked!==true?'competing_hypotheses_not_checked':'blocking_missing_evidence'}};
    if(checked.relation)accepted.push(checked.relation);else rejected.push(checked.rejection);
  }
  const relations=dedupeRelations([...(baseline.relations||[]),...accepted]),verification=verifyWorkingState(states,relations,evidenceById,{query_plan:queryPlan,full_visible_states:Array.isArray(options.full_visible_states)?options.full_visible_states:states}),verifiedStates=verification.states,anchorEvidence=(baseline.session_anchors||[]).flatMap(anchor=>(anchor.evidence_ids||[]).map(id=>evidenceById.get(String(id))).filter(Boolean)),candidateBudget=baseline.action_policy?.candidate_budget||24,verifiedEvidence=mergeEvidence(collectEvidence(verifiedStates,evidenceById),anchorEvidence).slice(0,genericAnswerEvidenceLimit(candidateBudget)),verifiedRelations=verification.relations;
  let proof=evaluateHypothesis(queryPlan,verifiedStates,verifiedRelations,evidenceById);
  proof={...proof,verified:true,semantic_evaluator:{verdict:normalized.verdict,accepted_relation_count:accepted.length,rejected_relation_count:rejected.length,no_link:accepted.length===0,missing_evidence_count:normalized.missing_evidence.length},competing_hypotheses_checked:normalized.competing_hypotheses_checked};
  const budgetExhausted=(baseline.action_policy?.selected_actions||[]).length<desiredCareHarnessActions().length,trace=(baseline.action_trace||[]).map(item=>{
    if(item.action==='connect')return{...item,after:{...item.after,relations:verifiedRelations.length},outcome:{...item.outcome,semantic_evaluator_used:true,semantic_verified_relations:accepted.length,rejected_semantic_relations:rejected.length,verified_relations:verifiedRelations.length,no_link:verifiedRelations.length===0}};
    if(item.action==='evaluate')return{...item,after:{...item.after,relations:verifiedRelations.length},outcome:{verdict:proof.verdict,complete:Boolean(proof.complete),missing_families:proof.missing_families||[],disconnected_families:proof.disconnected_families||[],semantic_evaluator_verdict:normalized.verdict}};
    if(item.action==='verify')return{...item,after:{states:verifiedStates.length,evidence:verifiedEvidence.length,relations:verifiedRelations.length},outcome:{accepted_nodes:verifiedStates.length,accepted_relations:verifiedRelations.length,rejected_nodes:verification.rejected_states.length,rejected_relations:verification.rejected_relations.length,hypothesis_verdict:proof.verdict}};
    if(item.action==='answer')return{...item,before:{states:verifiedStates.length,evidence:verifiedEvidence.length,relations:verifiedRelations.length},after:{states:verifiedStates.length,evidence:verifiedEvidence.length,relations:verifiedRelations.length},outcome:answerOutcome({budgetExhausted,verification,proof,stateCount:verifiedStates.length})};
    return item;
  });
  const workingState={...baseline.working_state,route:[...new Set(verifiedStates.map(item=>item.family))],state_ids:verifiedStates.map(item=>item.state_id),control_decisions:{...baseline.working_state?.control_decisions,relation:{...(baseline.working_state?.control_decisions?.relation||{}),selected_edge_ids:verifiedRelations.map(item=>item.edge_id).filter(Boolean),verified_edge_count:verifiedRelations.length,no_link:verifiedRelations.length===0,causality_asserted:false}},graph_subgraph:{...(baseline.working_state?.graph_subgraph||{}),node_ids:verifiedStates.map(item=>item.state_id),edge_ids:verifiedRelations.map(item=>item.edge_id).filter(Boolean),persistent_edge_count:verifiedRelations.filter(item=>item.persistent===true).length,query_local_edge_count:verifiedRelations.filter(item=>item.persistent===false).length},evidence:{...(baseline.working_state?.evidence||{}),evidence_ids:verifiedEvidence.map(item=>item.evidence_id),verified_relations:verifiedRelations,proof,verification,semantic_relation_evaluation:{verdict:normalized.verdict,accepted_relations:accepted,rejected_relations:rejected,competing_hypotheses_checked:normalized.competing_hypotheses_checked,missing_evidence_count:normalized.missing_evidence.length,no_link:accepted.length===0}}};
  return{...baseline,states:verifiedStates,evidence:verifiedEvidence,relations:verifiedRelations,proof,verification,working_state:workingState,action_trace:trace,trace:{...baseline.trace,query_time_relations:{persistent_graph_edges:verifiedRelations.filter(item=>item.persistent===true).length,query_local_edges:verifiedRelations.filter(item=>item.persistent===false).length,count:verifiedRelations.length,types:[...new Set(verifiedRelations.map(item=>item.type))]},semantic_relation_evaluator:{verdict:normalized.verdict,accepted_relation_count:accepted.length,rejected_relation_count:rejected.length,rejected,no_link:accepted.length===0,no_link_reason:normalized.no_link_reason||null,competing_hypotheses_checked:normalized.competing_hypotheses_checked},verification}};
}

export function verifyWorkingState(states=[],relations=[],evidenceById=new Map(),options={}){
  const rejected=[],accepted=[],operator=String(options.query_plan?.temporal_operator||'none').toLowerCase(),currentView=['current','latest'].includes(operator),historicalView=['history','earliest','first','event_time','before','after','range','trajectory','interval','before_after','before-after','as_of','as-of'].includes(operator),selectedSubjects=new Set(states.map(state=>String(state.subject_id||''))),fullVisibleStates=(Array.isArray(options.full_visible_states)?options.full_visible_states:states).filter(state=>{
    const declared=[...new Set((state.evidence_ids||[]).filter(Boolean).map(String))];
    return declared.length>0&&declared.every(id=>evidenceMatchesState(evidenceById.get(id),state))&&(!selectedSubjects.size||selectedSubjects.has(String(state.subject_id||'')));
  }),currentResolution=currentView?resolveCurrentStates(fullVisibleStates):null,currentReplacementGroups=currentView?new Set(states.filter(state=>currentResolution.current_ids.has(String(state.state_id))&&stateCanAssertCurrent(state,evidenceById)).map(state=>currentResolution.group_by_id.get(String(state.state_id))).filter(Boolean)):new Set();
  for(const state of states){
    const declared=[...new Set((state.evidence_ids||[]).map(String))],resolved=declared.filter(id=>evidenceMatchesState(evidenceById.get(id),state));
    if(!declared.length||resolved.length!==declared.length){rejected.push({state_id:state.state_id,reason:!declared.length?'missing_evidence_binding':'unresolved_or_cross_patient_evidence_id',declared_evidence_ids:declared,resolved_evidence_ids:resolved,blocking:true});continue;}
    if(String(state.status)==='conflict'){rejected.push({state_id:state.state_id,reason:'unresolved_conflict_not_a_verified_fact',declared_evidence_ids:declared,resolved_evidence_ids:resolved,blocking:true});continue;}
    if(currentView&&!currentResolution.current_ids.has(String(state.state_id))){const conflicted=currentResolution.conflicted_ids.has(String(state.state_id)),group=currentResolution.group_by_id.get(String(state.state_id));rejected.push({state_id:state.state_id,reason:conflicted?'unresolved_conflict_for_current_view':'superseded_for_current_view',declared_evidence_ids:declared,resolved_evidence_ids:resolved,blocking:conflicted||!group||!currentReplacementGroups.has(group)});continue;}
    if(String(state.status)==='rejected'){rejected.push({state_id:state.state_id,reason:'state_not_valid_for_requested_temporal_view',declared_evidence_ids:declared,resolved_evidence_ids:resolved,blocking:true});continue;}
    accepted.push(state);
  }
  const acceptedById=new Map(accepted.map(item=>[String(item.state_id),item])),selectedById=new Map(states.map(item=>[String(item.state_id),item])),rejectedStateById=new Map(rejected.map(item=>[String(item.state_id),item])),verifiedRelations=relations.filter(item=>relationCanSupport(item,acceptedById,evidenceById)),rejectedRelations=relations.filter(item=>!verifiedRelations.includes(item)).map(item=>{const candidate=item.verified!==true||['candidate','rejected'].includes(item.status),expectedStaleEndpoint=!candidate&&relationRejectedOnlyForNonblockingStale(item,selectedById,acceptedById,rejectedStateById,evidenceById);return{edge_id:item.edge_id||null,from_state_id:item.from_state_id,to_state_id:item.to_state_id,reason:candidate?'edge_not_verified':expectedStaleEndpoint?'edge_endpoint_superseded_for_current_view':'edge_endpoint_or_evidence_missing',blocking:!candidate&&!expectedStaleEndpoint}}),safeToAnswer=!rejected.some(item=>item.blocking)&&!rejectedRelations.some(item=>item.blocking);
  return{version:'careharness-subgraph-verifier.v2',states:accepted,relations:verifiedRelations,rejected_states:rejected,rejected_relations:rejectedRelations,complete:rejected.length===0&&rejectedRelations.length===0,safe_to_answer:safeToAnswer,unsupported_claims_removed:rejected.length+rejectedRelations.length,gold_or_judge_input_used:false};
}

function traceVersionsAndTime(queryPlan,context,allStates,evidenceById,limit,graphEdges=[]){
  const operator=String(queryPlan.temporal_operator||'none').toLowerCase(),currentView=['current','latest'].includes(operator),resolution=currentView?resolveCurrentStates(allStates):null,currentByGroup=new Map();
  if(resolution)for(const item of allStates){const id=String(item.state_id),group=resolution.group_by_id.get(id);if(group&&resolution.current_ids.has(id))currentByGroup.set(group,item);}
  const selected=new Map();let refreshedCurrentStateCount=0,removedStaleStateCount=0;
  for(const item of context.states){
    const id=String(item.state_id),group=resolution?.group_by_id.get(id),current=group?currentByGroup.get(group):null,next=current||item,nextId=String(next.state_id);
    if(current&&nextId!==id){refreshedCurrentStateCount++;removedStaleStateCount++;}
    selected.set(nextId,next);
  }
  const byId=new Map(allStates.map(item=>[String(item.state_id),item])),selectedEvidence=new Set([...selected.values()].flatMap(item=>(item.evidence_ids||[]).map(String)));
  const selectedGraphIds=new Set([...selected.keys(),...context.states.flatMap(item=>(item.merged_state_ids||[]).map(String))]),traversableEdges=graphEdges.filter(edge=>relationCanSupport(edge,byId,evidenceById)),adjacentIds=new Set();for(const edge of traversableEdges)if(selectedGraphIds.has(String(edge.from_state_id)))adjacentIds.add(String(edge.to_state_id));else if(selectedGraphIds.has(String(edge.to_state_id)))adjacentIds.add(String(edge.from_state_id));
  const related=allStates.filter(item=>{
    if(selected.has(String(item.state_id)))return false;
    if(currentView){const group=resolution.group_by_id.get(String(item.state_id));if(group&&!resolution.current_ids.has(String(item.state_id)))return false;}
    if(adjacentIds.has(String(item.state_id)))return true;
    if(item.supersedes&&selected.has(String(item.supersedes)))return true;
    if((item.version_chain||[]).some(id=>selected.has(String(id))))return true;
    if([...selected.values()].some(current=>current.supersedes===item.state_id||(current.version_chain||[]).includes(item.state_id)))return true;
    return(item.evidence_ids||[]).some(id=>selectedEvidence.has(String(id)));
  }).sort((a,b)=>temporalPreference(queryPlan,b)-temporalPreference(queryPlan,a));
  for(const item of related){if(selected.size>=limit)break;selected.set(String(item.state_id),item);}
  const states=[...selected.values()],originalIds=new Set(context.states.map(item=>String(item.state_id))),expandedStateCount=states.filter(item=>!originalIds.has(String(item.state_id))).length;
  return{...context,states,evidence:mergeEvidence(context.evidence,collectEvidence(states,evidenceById)),trace:{...context.trace,trace_action:{expanded_state_count:expandedStateCount,refreshed_current_state_count:refreshedCurrentStateCount,removed_stale_state_count:removedStaleStateCount,temporal_operator:queryPlan.temporal_operator||'none',persistent_graph_used:traversableEdges.length>0,traversed_edge_count:traversableEdges.filter(edge=>selectedGraphIds.has(String(edge.from_state_id))||selectedGraphIds.has(String(edge.to_state_id))).length,rejected_edge_count:graphEdges.length-traversableEdges.length}}};
}

export function evaluateHypothesis(queryPlan,states,relations,evidenceById){
  const nodes=states.map(state=>({state_id:state.state_id,family:state.family,event_time:state.event_time||null,evidence_ids:(state.evidence_ids||[]).filter(id=>evidenceById.has(String(id)))})).filter(item=>item.evidence_ids.length);
  const families=[...new Set(nodes.map(item=>item.family))],required=requiredFamilies(queryPlan),missing=required.filter(family=>!families.includes(family));
  const acceptedRelations=relations.filter(item=>item.verified===true),requiresPath=required.length>1,supportRelations=requiresPath?acceptedRelations.filter(relationHasSemanticSupport):acceptedRelations,connected=connectedNodeIds(nodes,supportRelations),connectedRequired=required.filter(family=>nodes.some(node=>node.family===family&&connected.has(String(node.state_id)))),disconnectedFamilies=requiresPath?required.filter(family=>!connectedRequired.includes(family)):[],pathComplete=!requiresPath||(supportRelations.length>0&&connected.size>1&&disconnectedFamilies.length===0),complete=nodes.length>0&&missing.length===0&&disconnectedFamilies.length===0&&pathComplete;
  return{version:'careharness-hypothesis-evaluation.v3',kind:'evidence_backed_hypothesis_evaluation',verdict:complete?'supported':'unresolved',node_state_ids:nodes.map(item=>item.state_id),nodes,relation_ids:supportRelations.map(item=>item.edge_id||[item.from_state_id,item.to_state_id,item.type].join(':')),observed_relation_ids:acceptedRelations.map(item=>item.edge_id||[item.from_state_id,item.to_state_id,item.type].join(':')),covered_families:families,required_families:required,missing_families:missing,disconnected_families:disconnectedFamilies,path_required:requiresPath,path_complete:pathComplete,complete,competing_hypotheses_checked:false,mechanism_inferred:false,causality_asserted:false,gold_or_judge_input_used:false};
}

function verifyProof(queryPlan,states,relations,evidenceById){
  return{...evaluateHypothesis(queryPlan,states,relations,evidenceById),verified:true};
}

function requiredFamilies(plan){
  const scopes=(plan.state_scopes||[]).filter(item=>['primary','high'].includes(item.priority)).map(item=>item.family);
  return[...new Set(scopes)].slice(0,6);
}
function connectedNodeIds(nodes,relations){
  if(nodes.length===1)return new Set([String(nodes[0].state_id)]);
  const adjacency=new Map(nodes.map(node=>[String(node.state_id),new Set()]));for(const relation of relations){const from=String(relation.from_state_id),to=String(relation.to_state_id);if(adjacency.has(from)&&adjacency.has(to)){adjacency.get(from).add(to);adjacency.get(to).add(from);}}
  const seen=new Set(),components=[];for(const id of adjacency.keys()){if(seen.has(id))continue;const component=new Set(),queue=[id];while(queue.length){const current=queue.shift();if(seen.has(current))continue;seen.add(current);component.add(current);for(const next of adjacency.get(current)||[])if(!seen.has(next))queue.push(next);}components.push(component);}return components.sort((a,b)=>b.size-a.size)[0]||new Set();
}
function resolveCurrentStates(states){
  const byId=new Map(states.map(state=>[String(state.state_id),state])),parent=new Map([...byId.keys()].map(id=>[id,id])),find=id=>{const value=parent.get(id);if(value==null)return null;if(value===id)return id;const root=find(value);parent.set(id,root);return root;},union=(left,right)=>{left=String(left||'');right=String(right||'');if(!byId.has(left)||!byId.has(right))return;const a=byId.get(left),b=byId.get(right);if(String(a.subject_id||'')!==String(b.subject_id||'')||a.family!==b.family)return;const ar=find(left),br=find(right);if(ar&&br&&ar!==br)parent.set(br,ar);};
  for(const state of states)for(const prior of [state.supersedes,state.conflicts_with,...(state.version_chain||[])].filter(Boolean))union(state.state_id,prior);
  const factorRepresentative=new Map();for(const state of states){const factor=String(state.factor_key||'').trim();if(!factor)continue;const key=[state.subject_id,state.family,factor].map(String).join('\u0000'),prior=factorRepresentative.get(key);if(prior)union(state.state_id,prior);else factorRepresentative.set(key,String(state.state_id));}
  const groups=new Map();for(const state of states){const root=find(String(state.state_id))||String(state.state_id),items=groups.get(root)||[];items.push(state);groups.set(root,items);}
  const currentIds=new Set(),conflictedIds=new Set(),groupById=new Map();for(const[root,items]of groups){for(const item of items)groupById.set(String(item.state_id),root);
    const latest=[...items].sort(compareStateRecency).at(-1);if(!latest)continue;
    if(String(latest.status)==='conflict'){for(const item of items)conflictedIds.add(String(item.state_id));continue;}
    currentIds.add(String(latest.state_id));
  }
  return{current_ids:currentIds,conflicted_ids:conflictedIds,group_by_id:groupById};
}
function compareStateRecency(left,right){
  const leftTime=Date.parse(left?.event_time||''),rightTime=Date.parse(right?.event_time||'');if(Number.isFinite(leftTime)&&Number.isFinite(rightTime)&&leftTime!==rightTime)return leftTime-rightTime;
  const leftEpisode=episodeOrder(left),rightEpisode=episodeOrder(right);if(Number.isFinite(leftEpisode)&&Number.isFinite(rightEpisode)&&leftEpisode!==rightEpisode)return leftEpisode-rightEpisode;
  const leftVersion=Number(left?.version||0),rightVersion=Number(right?.version||0);if(leftVersion!==rightVersion)return leftVersion-rightVersion;
  return String(left?.state_id||'').localeCompare(String(right?.state_id||''));
}
function episodeOrder(state){const match=/(?:session|episode|admission|encounter)[-_ ]?(\d+)/i.exec(state?.episode_id||'');return match?Number(match[1]):NaN;}
function evidenceMatchesState(item,state){return Boolean(item)&&String(item.subject_id||'')===String(state?.subject_id||'');}
function stateCanAssertCurrent(state,evidenceById){const declared=[...new Set((state?.evidence_ids||[]).filter(Boolean).map(String))];return declared.length>0&&declared.every(id=>evidenceMatchesState(evidenceById.get(id),state))&&!['conflict','rejected'].includes(String(state?.status||''));}
function relationCanSupport(relation,stateById,evidenceById){
  if(relation?.verified===false||String(relation?.status||'verified')!=='verified'||relation?.causal_claim===true)return false;
  const from=stateById.get(String(relation?.from_state_id||'')),to=stateById.get(String(relation?.to_state_id||''));if(!from||!to)return false;
  const subject=String(from.subject_id||'');if(!subject||subject!==String(to.subject_id||'')||(relation.subject_id&&String(relation.subject_id)!==subject))return false;
  const declared=[...new Set((relation.evidence_ids||[]).filter(Boolean).map(String))];return declared.length>0&&declared.every(id=>{const item=evidenceById.get(id);return Boolean(item)&&String(item.subject_id||'')===subject;});
}
function checkedSemanticRelation(candidate,stateById,evidenceById,index){
  const reject=reason=>({relation:null,rejection:{index,from_state_id:candidate.from_state_id,to_state_id:candidate.to_state_id,relation_type:candidate.relation_type,reason}}),from=stateById.get(candidate.from_state_id),to=stateById.get(candidate.to_state_id);
  if(candidate.assessment!=='supports')return reject(`assessment_${candidate.assessment}`);
  if(candidate.confidence<QUERY_TIME_RELATION_CONFIDENCE_MIN)return reject('confidence_below_threshold');
  if(!from||!to)return reject('endpoint_not_in_verified_working_state');
  const subject=String(from.subject_id||'');if(!subject||subject!==String(to.subject_id||''))return reject('cross_patient_endpoint');
  if(['conflict','rejected'].includes(String(from.status||''))||['conflict','rejected'].includes(String(to.status||'')))return reject('invalid_endpoint_status');
  const evidenceIds=[candidate.relation_evidence_id],items=evidenceIds.map(id=>evidenceById.get(id));
  if(items.some(item=>!item||String(item.subject_id||'')!==subject))return reject('missing_or_cross_patient_relation_evidence');
  const fromEvidence=new Set((from.evidence_ids||[]).map(String)),toEvidence=new Set((to.evidence_ids||[]).map(String));
  if(!fromEvidence.has(candidate.relation_evidence_id)&&!toEvidence.has(candidate.relation_evidence_id))return reject('relation_evidence_not_bound_to_an_endpoint');
  if(!substantiveQuote(candidate.from_claim_quote)||!substantiveQuote(candidate.to_claim_quote))return reject('endpoint_claim_quote_too_short');
  if(!String(from.value||'').includes(candidate.from_claim_quote)||!String(to.value||'').includes(candidate.to_claim_quote))return reject('endpoint_claim_quote_not_verbatim');
  const relationEvidence=String(items[0]?.text||'');
  if(!relationEvidence.includes(candidate.relation_quote))return reject('relation_quote_not_verbatim');
  if(!candidate.relation_quote.includes(candidate.from_claim_quote)||!candidate.relation_quote.includes(candidate.to_claim_quote))return reject('relation_quote_does_not_bind_both_claims');
  if(normalizeClaim(from.value)===normalizeClaim(to.value))return reject('duplicate_claim_endpoints');
  if(items.some(item=>Number.isFinite(Number(item.certainty))&&Number(item.certainty)<.8))return reject('uncertain_evidence');
  if(candidate.relation_type==='motivates'&&!(from.family==='PA'&&to.family==='CP'))return reject('motivates_family_direction_invalid');
  if(candidate.relation_type==='constrains'&&!(to.family==='CP'&&['BC','PE','CS','PA'].includes(from.family)))return reject('constrains_family_direction_invalid');
  if(candidate.relation_type==='care_targets'&&!(from.family==='CP'&&to.family==='CS'))return reject('care_targets_family_direction_invalid');
  if(candidate.relation_type==='observed_after_care'&&!(from.family==='CP'&&to.family==='LO'))return reject('observed_after_care_family_direction_invalid');
  if(candidate.relation_type==='followed_by'){
    const left=eventOrder(from),right=eventOrder(to);if(!Number.isFinite(left)||!Number.isFinite(right)||left>right)return reject('followed_by_temporal_order_invalid');
  }
  const semanticSupport=candidate.relation_type!=='followed_by';
  return{relation:{edge_id:`query-eval:${index}:${candidate.from_state_id}:${candidate.to_state_id}:${candidate.relation_type}`,subject_id:subject,from_state_id:candidate.from_state_id,to_state_id:candidate.to_state_id,type:candidate.relation_type,edge_family:'clinical_care',evidence_ids:evidenceIds,evidence_quotes:[{evidence_id:candidate.relation_evidence_id,quote:candidate.relation_quote}],relation_evidence_id:candidate.relation_evidence_id,relation_quote:candidate.relation_quote,from_claim_quote:candidate.from_claim_quote,to_claim_quote:candidate.to_claim_quote,confidence:candidate.confidence,support_kind:'model_verified_explicit_relation_span',semantic_support:semanticSupport,verified:true,persistent:false,causal_claim:false,status:'verified',source:'query_time_relation_evaluator'}};
}
function dedupeRelations(relations){const seen=new Set();return relations.filter(item=>{const key=[item.from_state_id,item.to_state_id,item.type||item.relation_type].map(String).join('\u0000');if(seen.has(key))return false;seen.add(key);return true;});}
function normalizeClaim(value){return String(value||'').normalize('NFKC').toLowerCase().replace(/[\s，,。.!！?？:：;；"'“”‘’()（）\[\]{}]/g,'');}
function relationHasSemanticSupport(item){if(item?.verified!==true||item.edge_family!=='clinical_care'||item.semantic_support!==true||item.type==='followed_by')return false;return item.source==='query_time_relation_evaluator'&&item.persistent===false&&item.support_kind==='model_verified_explicit_relation_span'&&Boolean(item.relation_evidence_id&&item.relation_quote&&item.from_claim_quote&&item.to_claim_quote);}
function substantiveQuote(value){return(String(value||'').match(/[\p{L}\p{N}]/gu)||[]).length>=4;}
function relationRejectedOnlyForNonblockingStale(relation,selectedById,acceptedById,rejectedStateById,evidenceById){
  if(!relationCanSupport(relation,selectedById,evidenceById))return false;
  const removed=[String(relation.from_state_id||''),String(relation.to_state_id||'')].filter(id=>!acceptedById.has(id));
  return removed.length>0&&removed.every(id=>{const rejected=rejectedStateById.get(id);return Boolean(rejected)&&rejected.blocking===false&&rejected.reason==='superseded_for_current_view';});
}
function assertSingleRuntimeSubject(states,evidence,graphEdges){
  const groups=[['State',states],['Evidence',evidence],['Patient Graph edge',graphEdges]],subjects=new Set();
  for(const[label,items]of groups)for(const item of items){const subject=String(item?.subject_id||'').trim();if(!subject)throw new Error(`${label} subject_id is required in the CareHarness runtime context`);subjects.add(subject);}
  if(subjects.size>1)throw new Error('CareHarness runtime context must contain exactly one patient subject');
}
function collectEvidence(states,evidenceById){const seen=new Set(),out=[];for(const state of states)for(const id of state.evidence_ids||[]){const key=String(id),item=evidenceById.get(key);if(item&&!seen.has(key)){seen.add(key);out.push(item);}}return out;}
function mergeEvidence(...groups){const seen=new Set(),out=[];for(const item of groups.flat()){const id=String(item?.evidence_id||'');if(id&&!seen.has(id)){seen.add(id);out.push(item);}}return out;}
function eventOrder(state){const parsed=Date.parse(state?.event_time||'');if(Number.isFinite(parsed))return parsed;const match=/(?:session|episode|admission|encounter)[-_ ]?(\d+)/i.exec(state?.episode_id||'');return match?Number(match[1]):NaN;}
function temporalPreference(plan,state){const order=eventOrder(state);if(!Number.isFinite(order))return 0;return['earliest','history','before'].includes(plan.temporal_operator)?-order:order;}
function discriminateEventStage(queryPlan,context,evidenceById){
  const evidenceScores=new Map(context.evidence.map(item=>[String(item.evidence_id),eventStageEvidenceScore(queryPlan,item)])),stableSort=(items,score)=>items.map((item,index)=>({item,index,score:score(item)})).sort((a,b)=>b.score-a.score||a.index-b.index).map(record=>record.item),evidence=stableSort(context.evidence,item=>evidenceScores.get(String(item.evidence_id))||0),states=stableSort(context.states,item=>Math.max(0,...(item.evidence_ids||[]).map(id=>evidenceScores.get(String(id))||eventStageEvidenceScore(queryPlan,evidenceById.get(String(id))))));
  const anchorScore=anchor=>Math.max(0,...(anchor.evidence_ids||[]).map(id=>evidenceScores.get(String(id))||eventStageEvidenceScore(queryPlan,evidenceById.get(String(id))))),sessionAnchors=stableSort(context.session_anchors||[],anchorScore),priorityIds=new Set(context.priority_evidence_ids||[]),priority_evidence_ids=evidence.filter(item=>priorityIds.has(String(item.evidence_id))).map(item=>String(item.evidence_id));
  return{...context,states,evidence,session_anchors:sessionAnchors,priority_evidence_ids,trace:{...context.trace,event_stage_discrimination:{version:'careharness-event-stage-discriminator.v3',policy:'query_date_keyword_assertion_and_source_role_ranking',top_evidence_id:evidence[0]?.evidence_id||null,top_score:evidence.length?evidenceScores.get(String(evidence[0].evidence_id))||0:null,reordered_state_count:states.length,reordered_evidence_count:evidence.length,gold_or_judge_input_used:false}}};
}
function eventStageEvidenceScore(queryPlan,item){
  if(!item)return 0;
  const question=String(queryPlan.question||''),text=String([item.text,item.source_text].filter(Boolean).join(' ')),normalized=text.normalize('NFKC').toLowerCase(),dates=requestedEventDates(question),eventDate=String(item.event_time||'').slice(0,10),keywords=[...(queryPlan.keywords||[]),queryPlan.target].filter(Boolean).map(value=>String(value).normalize('NFKC').toLowerCase()).filter(value=>value.length>=2);let score=0;
  if(dates.size)score+=dates.has(eventDate)?60:-16;
  for(const keyword of keywords)if(normalized.includes(keyword))score+=Math.min(8,2+keyword.length/3);
  if(String(item.source_type||'').toLowerCase()==='patient')score+=1;
  return score;
}
function requestedEventDates(question){
  const out=new Set(),text=String(question||''),pattern=/(20\d{2})\s*(?:[-/.年])\s*(\d{1,2})\s*(?:[-/.月])\s*(\d{1,2})/gu;let match;
  while((match=pattern.exec(text))){const date=new Date(Date.UTC(Number(match[1]),Number(match[2])-1,Number(match[3])));if(Number.isFinite(date.getTime()))out.add(date.toISOString().slice(0,10));}
  return out;
}
function relationFamily(type){return['persists','updates','supersedes','resolves','recurs','conflicts'].includes(type)?'temporal':'clinical_care';}
function endpointPairKey(left,right){return[String(left),String(right)].sort().join('\u0000');}
function desiredCareHarnessActions(){return[...CAREHARNESS_ACTIONS];}
function directEvidenceOptions(candidateBudget=8){return{limit:Math.min(16,Math.max(8,Math.ceil(candidateBudget*.75))),neighbor_radius:2,neighbor_seed_limit:4};}
function sessionAnchorOptions(candidateBudget=8){return{anchor_limit:3,evidence_limit:genericAnswerEvidenceLimit(candidateBudget)};}
function genericAnswerEvidenceLimit(candidateBudget){return Math.min(48,Math.max(16,candidateBudget*2));}
function prioritizeVerifiedStates(states,anchors,priorityEvidence,candidateBudget){
  const episodes=new Set((anchors||[]).map(item=>String(item.episode_id||'')).filter(Boolean)),evidenceIds=new Set((priorityEvidence||[]).map(item=>String(item.evidence_id||'')).filter(Boolean)),seen=new Set(),ordered=[];
  const prioritized=states.filter(item=>episodes.has(String(item.episode_id||''))||(item.evidence_ids||[]).some(id=>evidenceIds.has(String(id))));
  for(const item of[...prioritized,...states]){const id=String(item.state_id);if(seen.has(id))continue;seen.add(id);ordered.push(item);}
  return ordered.slice(0,candidateBudget);
}
function retrieveOptionContrastEvidence(queryPlan={},evidence=[],candidateBudget=8){const options=Array.isArray(queryPlan.options)?queryPlan.options:[],selected=[],seen=new Set(),optionResults=[];for(const option of options){const optionPlan={...queryPlan,question:String(option.text||''),target:String(option.text||''),keywords:[String(option.text||'')],options:[],temporal_operator:'none'},result=retrieveEvidenceCandidates(optionPlan,evidence,{limit:Math.min(3,Math.max(2,Math.ceil(candidateBudget/4))),neighbor_radius:1,neighbor_seed_limit:2}),ids=[];for(const item of result.evidence){const id=String(item.evidence_id);if(!seen.has(id)){seen.add(id);selected.push(item);}ids.push(id);}optionResults.push({option_id:String(option.id||''),option_text:String(option.text||''),selected_evidence_ids:[...new Set(ids)],trace:result.trace});}return{evidence:selected,trace:{version:'careharness-option-contrast.v4',option_results:optionResults,selected_count:selected.length,covered_option_count:optionResults.filter(item=>item.selected_evidence_ids.length).length}};}
function answerOutcome({budgetExhausted,verification,proof,stateCount}){if(budgetExhausted)return{terminal:true,status:'budget-exhausted',reason:'required_actions_omitted_by_budget'};if(stateCount>0&&verification?.safe_to_answer===true&&(!proof||proof.complete===true))return{terminal:true,status:'supported',reason:'verified_working_subgraph_supports_answer'};return{terminal:true,status:'uncertain',reason:proof?.complete===false?'hypothesis_unresolved':verification?.safe_to_answer===false?'verification_blocked':'insufficient_verified_evidence'};}
function actionControl(action){if(action==='focus'||action==='anchor')return'scope';if(action==='connect')return'relation';if(action==='evaluate')return'hypothesis';if(action==='verify')return'grounding';return'termination';}
function positiveInteger(value){const number=Number(value);return Number.isInteger(number)&&number>0?number:null;}
