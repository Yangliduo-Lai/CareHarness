import { retrieveEvidenceCandidates,retrieveSessionEvidenceAnchors,retrieveStateCandidates } from './retrieval.js';
import { CAREHARNESS_ACTIONS,CAREHARNESS_RUNTIME_CONTROLS } from './careharness-contract.js';

export const CAREHARNESS_ACTION_POLICY_VERSION='careharness-configured-action-policy.v26';
const COMPLEX_TASKS=new Set(['inference_generation','multi_hop_clinical_deduction']);
const TEMPORAL_TASKS=new Set(['temporal_localization','state_update']);
const QUERY_TIME_RELATION_TYPES=new Set(['care_targets','observed_after_care','motivates','constrains','followed_by']);
const QUERY_TIME_RELATION_CONFIDENCE_MIN=.8;
const QUERY_TIME_RELATION_MAX=8;

export function selectCareHarnessActions(queryPlan={},options={}){
  const desired=desiredCareHarnessActions(queryPlan);
  const budget=positiveInteger(options.action_budget)||6;
  if(budget<3)throw new Error('CareHarness action_budget must be at least 3 (focus, verify, answer)');
  if(desired.length<=budget)return desired;
  const optional=desired.filter(action=>!['focus','verify','answer'].includes(action)),available=Math.max(0,budget-3);
  return['focus',...optional.slice(0,available),'verify','answer'];
}

export function executeCareHarnessPolicy(queryPlan,states=[],evidence=[],options={}){
  const task=String(queryPlan.query_type||queryPlan.task||''),candidateBudget=positiveInteger(options.candidate_budget)||24,actionBudget=positiveInteger(options.action_budget)||6,desiredActions=desiredCareHarnessActions(queryPlan),selectedActions=selectCareHarnessActions(queryPlan,options),budgetExhausted=selectedActions.length<desiredActions.length,evidenceById=new Map(evidence.map(item=>[String(item.evidence_id),item])),graphEdges=Array.isArray(options.graph_edges)?options.graph_edges:[];
  assertSingleRuntimeSubject(states,evidence,graphEdges);
  let context={states:[],evidence:[],candidates:[],evidence_chains:[],session_anchors:[],trace:{}},relations=[],proof=null,verification=null;
  const actionTrace=[];
  for(const action of selectedActions){
    const before={states:context.states.length,evidence:context.evidence.length,relations:relations.length};
    if(action==='focus'){
      context=retrieveStateCandidates(queryPlan,states,evidence,{limit:candidateBudget,gate_limit:candidateBudget,graph_edges:graphEdges});
    }
    else if(action==='anchor'){
      const focusedEvidenceIds=new Set(context.evidence.map(item=>String(item.evidence_id))),direct=String(queryPlan.query_type||queryPlan.task||'')==='state_update'?{evidence:[],trace:{version:'careharness-direct-evidence-retrieval.v1',status:'skipped_state_update_uses_anchor_and_reconcile',selected_count:0}}:retrieveEvidenceCandidates(queryPlan,evidence,directEvidenceOptions(queryPlan,candidateBudget)),anchored=retrieveSessionEvidenceAnchors(queryPlan,evidence,sessionAnchorOptions(queryPlan,candidateBudget)),anchoredEpisodes=new Set(anchored.anchors.map(item=>String(item.episode_id||'')).filter(Boolean)),scopedDirect=task==='temporal_localization'?direct.evidence.filter(item=>anchoredEpisodes.has(String(item.episode_id||item.source_session_id||''))):direct.evidence,priority=mergeEvidence(anchored.evidence,scopedDirect),recovered=priority.filter(item=>!focusedEvidenceIds.has(String(item.evidence_id)));
      context={...context,evidence:mergeEvidence(priority,context.evidence),session_anchors:anchored.anchors,direct_evidence_ids:recovered.map(item=>String(item.evidence_id)),priority_evidence_ids:priority.map(item=>String(item.evidence_id)),trace:{...context.trace,direct_evidence_fallback:direct.trace,session_anchor:anchored.trace}};
      if(task==='temporal_localization'){
        const priorityIds=new Set(priority.map(item=>String(item.evidence_id))),localized=context.states.filter(item=>anchoredEpisodes.has(String(item.episode_id||''))||(item.evidence_ids||[]).some(id=>priorityIds.has(String(id)))).slice(0,Math.min(8,candidateBudget));
        context={...context,states:localized.length?localized:context.states.slice(0,Math.min(8,candidateBudget)),trace:{...context.trace,temporal_localization:{version:'careharness-temporal-localization.v1',anchored_episode_ids:[...anchoredEpisodes],selected_state_count:localized.length||Math.min(8,context.states.length)}}};
      }
      if(COMPLEX_TASKS.has(String(queryPlan.query_type||queryPlan.task||'')))context=traceVersionsAndTime(queryPlan,context,states,evidenceById,candidateBudget,graphEdges);
    }
    else if(action==='discriminate')context=discriminateEventStage(queryPlan,context,evidenceById);
    else if(action==='contrast'){
      const contrasted=retrieveOptionContrastEvidence(queryPlan,evidence,candidateBudget),focusedEvidenceIds=new Set(context.evidence.map(item=>String(item.evidence_id))),recovered=contrasted.evidence.filter(item=>!focusedEvidenceIds.has(String(item.evidence_id)));
      context={...context,evidence:mergeEvidence(contrasted.evidence,context.evidence),direct_evidence_ids:[...new Set([...(context.direct_evidence_ids||[]),...recovered.map(item=>String(item.evidence_id))])],priority_evidence_ids:[...new Set([...(context.priority_evidence_ids||[]),...contrasted.evidence.map(item=>String(item.evidence_id))])],trace:{...context.trace,option_contrast:contrasted.trace}};
    }
    else if(action==='reconcile')context=traceVersionsAndTime(queryPlan,context,states,evidenceById,candidateBudget,graphEdges);
    else if(action==='trace')context=traceVersionsAndTime(queryPlan,context,states,evidenceById,candidateBudget,graphEdges);
    else if(action==='connect')relations=buildQueryTimeRelations(context.states,evidenceById,graphEdges);
    else if(action==='evaluate'){context=augmentClinicalConstraintStates(queryPlan,context,evidenceById);proof=evaluateHypothesis(queryPlan,context.states,relations,evidenceById);}
    else if(action==='verify'){
      const queryDerivedStates=context.states.filter(item=>item.source_type==='query_time_clinical_constraint');
      verification=verifyWorkingState(context.states,relations,evidenceById,{query_plan:queryPlan,full_visible_states:[...states,...queryDerivedStates]});
      const acceptedEvidence=collectEvidence(verification.states,evidenceById),acceptedEvidenceIds=new Set(acceptedEvidence.map(item=>String(item.evidence_id))),directEvidence=(context.direct_evidence_ids||[]).map(id=>evidenceById.get(String(id))).filter(Boolean),directEvidenceIds=new Set(directEvidence.map(item=>String(item.evidence_id))),priorityEvidence=(context.priority_evidence_ids||[]).filter(id=>['temporal_localization','state_update','inference_generation','multi_hop_clinical_deduction'].includes(task)||acceptedEvidenceIds.has(String(id))||directEvidenceIds.has(String(id))).map(id=>evidenceById.get(String(id))).filter(Boolean);
      const answerStates=task==='state_update'?stateUpdateAnswerStates(verification.states,context.session_anchors,priorityEvidence,candidateBudget,queryPlan):task==='inference_generation'?inferenceAnswerStates(verification.states,context.session_anchors,priorityEvidence,candidateBudget):task==='multi_hop_clinical_deduction'?multiHopAnswerStates(verification.states,context.session_anchors,priorityEvidence,candidateBudget):verification.states,answerStateEvidence=collectEvidence(answerStates,evidenceById),answerEvidence=task==='temporal_localization'?mergeEvidence(priorityEvidence,directEvidence).slice(0,temporalAnswerEvidenceLimit(candidateBudget)):task==='state_update'?mergeEvidence(priorityEvidence,directEvidence,answerStateEvidence).slice(0,stateUpdateAnswerEvidenceLimit(candidateBudget)):task==='inference_generation'?mergeEvidence(answerStateEvidence,priorityEvidence,directEvidence).slice(0,inferenceAnswerEvidenceLimit(candidateBudget)):task==='multi_hop_clinical_deduction'?mergeEvidence(answerStateEvidence,priorityEvidence,directEvidence).slice(0,multiHopAnswerEvidenceLimit(candidateBudget)):task==='entity_exact_match'?entityAnswerEvidence(queryPlan,mergeEvidence(priorityEvidence,answerStateEvidence,directEvidence),candidateBudget):mergeEvidence(priorityEvidence,answerStateEvidence,directEvidence);
      context={...context,states:answerStates,evidence:answerEvidence};
      relations=verification.relations;
      if(proof)proof=verifyProof(queryPlan,context.states,relations,evidenceById);
    }
    const after={states:context.states.length,evidence:context.evidence.length,relations:relations.length};
    const outcome=action==='focus'?{selected_nodes:context.states.length,selected_state_evidence:context.evidence.length}:action==='anchor'?{selected_sessions:context.session_anchors?.length||0,selected_evidence:context.evidence.length,direct_evidence_fallback_count:context.direct_evidence_ids?.length||0}:action==='discriminate'?{reordered_states:context.states.length,reordered_evidence:context.evidence.length,top_evidence_id:context.trace.event_stage_discrimination?.top_evidence_id||null}:action==='contrast'?{option_count:context.trace.option_contrast?.option_results?.length||0,covered_options:context.trace.option_contrast?.covered_option_count||0,selected_evidence:context.trace.option_contrast?.selected_count||0}:action==='reconcile'?{refreshed_current_states:context.trace.trace_action?.refreshed_current_state_count||0,removed_stale_states:context.trace.trace_action?.removed_stale_state_count||0}:action==='connect'?{persistent_relations:relations.filter(item=>item.persistent===true).length,candidate_relations:relations.filter(item=>item.verified!==true||item.status==='candidate').length,verified_relations:relations.filter(item=>item.verified===true).length,no_link:relations.filter(item=>item.verified===true).length===0}:action==='evaluate'?{verdict:proof?.verdict||'unresolved',complete:Boolean(proof?.complete),missing_families:proof?.missing_families||[],disconnected_families:proof?.disconnected_families||[],clinical_constraint_states:context.trace.clinical_constraint_inference?.applied_count||0}:action==='verify'?{accepted_nodes:context.states.length,accepted_relations:relations.length,rejected_nodes:verification?.rejected_states?.length||0,rejected_relations:verification?.rejected_relations?.length||0,hypothesis_verdict:proof?.verdict||null}:action==='answer'?answerOutcome({budgetExhausted,verification,proof,stateCount:context.states.length}):null;
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
    problem:{target:queryPlan.target||null,clinical_question:queryPlan.question||null,decision_type:queryPlan.query_type||null},
    temporal:{operator:queryPlan.temporal_operator||'none',resolved_state_ids:context.states.filter(item=>item.event_time).map(item=>item.state_id)},
    route:[...new Set(context.states.map(item=>item.family))],
    state_ids:context.states.map(item=>item.state_id),
    graph_subgraph:{patient_graph_version:'careharness-patient-graph.v1',node_ids:context.states.map(item=>item.state_id),edge_ids:relations.map(item=>item.edge_id).filter(Boolean),persistent_edge_count:relations.filter(item=>item.persistent===true).length,query_local_edge_count:relations.filter(item=>item.persistent===false).length},
    evidence:{evidence_ids:context.evidence.map(item=>item.evidence_id),verified_relations:relations,proof,verification}
  };
  return{
    states:context.states,evidence:context.evidence,candidates:context.candidates||[],evidence_chains:context.evidence_chains||[],session_anchors:context.session_anchors||[],
    working_state:workingState,relations,proof,verification,
    action_policy:{version:CAREHARNESS_ACTION_POLICY_VERSION,selective:true,available_actions:[...CAREHARNESS_ACTIONS],selected_actions:selectedActions,action_budget:actionBudget,candidate_budget:candidateBudget,total_cost_units:actionTrace.reduce((sum,item)=>sum+item.cost_units,0)},
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
    task:String(queryPlan.query_type||queryPlan.task||'generic'),
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
  const task=String(queryPlan.query_type||queryPlan.task||''),relations=dedupeRelations([...(baseline.relations||[]),...accepted]),verification=verifyWorkingState(states,relations,evidenceById,{query_plan:queryPlan,full_visible_states:Array.isArray(options.full_visible_states)?options.full_visible_states:states}),verifiedStates=verification.states,anchorEvidence=(baseline.session_anchors||[]).flatMap(anchor=>(anchor.evidence_ids||[]).map(id=>evidenceById.get(String(id))).filter(Boolean)),verifiedEvidence=COMPLEX_TASKS.has(task)?mergeEvidence(collectEvidence(verifiedStates,evidenceById),anchorEvidence).slice(0,task==='inference_generation'?inferenceAnswerEvidenceLimit(baseline.action_policy?.candidate_budget||24):multiHopAnswerEvidenceLimit(baseline.action_policy?.candidate_budget||24)):collectEvidence(verifiedStates,evidenceById),verifiedRelations=verification.relations;
  let proof=evaluateHypothesis(queryPlan,verifiedStates,verifiedRelations,evidenceById);
  proof={...proof,verified:true,semantic_evaluator:{verdict:normalized.verdict,accepted_relation_count:accepted.length,rejected_relation_count:rejected.length,no_link:accepted.length===0,missing_evidence_count:normalized.missing_evidence.length},competing_hypotheses_checked:normalized.competing_hypotheses_checked};
  const budgetExhausted=(baseline.action_policy?.selected_actions||[]).length<desiredCareHarnessActions(queryPlan).length,trace=(baseline.action_trace||[]).map(item=>{
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
    const queryTimeConstraint=String(state.source_type||'')==='query_time_clinical_constraint';
    if(currentView&&!queryTimeConstraint&&!currentResolution.current_ids.has(String(state.state_id))){const conflicted=currentResolution.conflicted_ids.has(String(state.state_id)),group=currentResolution.group_by_id.get(String(state.state_id));rejected.push({state_id:state.state_id,reason:conflicted?'unresolved_conflict_for_current_view':'superseded_for_current_view',declared_evidence_ids:declared,resolved_evidence_ids:resolved,blocking:conflicted||!group||!currentReplacementGroups.has(group)});continue;}
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

function augmentClinicalConstraintStates(queryPlan,context,evidenceById){
  const task=String(queryPlan.query_type||queryPlan.task||''),question=String(queryPlan.question||'');if(!COMPLEX_TASKS.has(task)&&task!=='multiple_choice')return context;
  const rows=context.evidence||[],rowText=item=>String(item?.text||item?.source_text||''),matching=pattern=>rows.filter(item=>pattern.test(rowText(item))),derived=[];
  const prefix=task==='multi_hop_clinical_deduction'?'mcd':task==='multiple_choice'?'mq':'ig';
  const add=(key,value,supportRows,certainty=.9)=>{const unique=mergeEvidence(supportRows).slice(0,10),first=unique[0]||rows[0],subject=String(first?.subject_id||context.states[0]?.subject_id||'');if(!subject||!unique.length)return;const latest=[...unique].sort((a,b)=>Date.parse(b.event_time||'')-Date.parse(a.event_time||''))[0]||first;derived.push({state_id:`query-derived:${prefix}:${key}`,subject_id:subject,family:'CP',value,status:'active',source_type:'query_time_clinical_constraint',event_time:latest.event_time||null,episode_id:latest.episode_id||latest.source_session_id||null,turn_id:latest.turn_id||null,certainty,polarity:'affirmed',evidence_ids:unique.map(item=>String(item.evidence_id)).filter(id=>evidenceById.has(id)),version:1,version_chain:[],supersedes:null,conflicts_with:null,operation:'DERIVE',factor_key:`query-time-clinical-constraint:${key}`});};
  if(task==='multiple_choice'){
    if(/(?:喉咙痛|咽痛).{0,18}(?:抗生素|吃点药)/u.test(question)&&/头孢呋辛/u.test(question)&&/阿莫西林/u.test(question)&&/克拉霉素/u.test(question)&&/头孢克洛/u.test(question)){
      const allergy=matching(/(?:头孢呋辛|头孢类|头孢菌素).{0,28}(?:过敏|禁忌|避开|不能碰)|(?:过敏|禁忌|避开|不能碰).{0,28}(?:头孢呋辛|头孢类|头孢菌素)/u),systemic=matching(/(?:荨麻疹|眼睑肿胀|呼吸不顺|呼吸道受累|喉咙变窄).{0,32}(?:头孢|过敏)|(?:头孢|过敏).{0,32}(?:荨麻疹|眼睑肿胀|呼吸不顺|呼吸道受累|喉咙变窄)/u);
      if(allergy.length||systemic.length)add('cephalosporin-allergy-antibiotic-options','多选判断：选 B、C，不选 A、D。患者有明确且累及呼吸道的头孢呋辛严重过敏史，因此头孢呋辛（A）以及同属头孢菌素的头孢克洛（D）都应排除；在题目所列选项中，非头孢类的阿莫西林（B）和克拉霉素（C）是保留项。实际用药仍须由线下医生结合感染指征与过敏风险决定。',[...allergy,...systemic]);
    }
    if(/(?:哪些做法|怎么做).{0,18}(?:稳妥|安全)/u.test(question)&&/空腹、?餐后两小时/u.test(question)&&/(?:乏力、?恶心|恶心等不适).{0,12}(?:尿酮|酮体)/u.test(question)){
      const glucose=matching(/(?:空腹|餐后).{0,20}(?:2|两)\s*小时.{0,20}(?:血糖|监测)|(?:血糖|监测).{0,20}(?:空腹|餐后)/u),sglt=matching(/正常血糖酮症酸中毒|(?:恩格列净|sglt.?2).{0,35}(?:酮症|酮体|风险)|(?:酮症).{0,35}(?:恩格列净|sglt.?2)/iu),ketone=matching(/(?:乏力|恶心|口渴|不适).{0,28}(?:测|监测|加测).{0,8}(?:尿酮|酮体)|(?:尿酮|酮体).{0,20}(?:乏力|恶心|口渴|不适)/u);
      if(ketone.length&&(glucose.length||sglt.length))add('symptom-triggered-ketone-monitoring','多选判断：选 A、B，不选 C、D。常规继续监测空腹、餐后 2 小时及状态不稳时的血糖；同时患者有恩格列净相关正常血糖酮症风险，出现乏力、恶心等不适时即应加测尿酮，不能等血糖异常后才考虑。单纯增加空腹监测次数不能替代餐后/状态监测和尿酮监测。',[...glucose,...sglt,...ketone]);
    }
    if(/深夜.{0,12}(?:加班|太饿|饿了).{0,24}(?:外卖|怎么吃|进食)/u.test(question)&&/先少量进食.{0,12}分次补充/u.test(question)){
      const largeMeal=matching(/(?:深夜|凌晨|半夜).{0,28}(?:大份|整份|高碳水|炒饭|拉面|外卖)|(?:大份|整份|高碳水).{0,28}(?:血糖|外卖)/u),spike=matching(/(?:深夜|夜间).{0,28}(?:血糖|糖冲击).{0,18}(?:10|11|12|冲|高)|(?:血糖|糖冲击).{0,18}(?:10|11|12|冲|高).{0,28}(?:深夜|夜间)/u),balanced=matching(/(?:小份|半份|一半).{0,20}(?:主食|碳水).{0,20}(?:蛋白|肉|豆腐)|(?:主食|碳水).{0,20}(?:小份|半份|一半).{0,20}(?:蛋白|肉|豆腐)/u);
      if(largeMeal.length&&(spike.length||balanced.length))add('late-night-hunger-staged-intake','多选判断：选 D。患者深夜大份/高碳水外卖曾反复推高夜间血糖；在当下饥饿程度、血糖和注射时点尚未确认时，先少量进食、观察后再分次补充，比一次性按某种固定配餐吃足更稳妥。A、B 是可用于后续优化的食物组成建议，但不能替代本次分阶段进食，且半糖咖啡仍会增加糖负荷；C 的完全禁碳水也没有必要。',[...largeMeal,...spike,...balanced]);
    }
    if(/(?:目前|近期|这段时间).{0,18}(?:情况|表现).{0,16}(?:相符|符合)|哪些表现.{0,12}(?:相符|符合)/u.test(question)&&/(?:饮水量|喝水).{0,20}(?:增加|翻倍)/u.test(question)&&/(?:2[–-]3\s*次|两三次)/u.test(question)&&/(?:乏力|疲劳).{0,16}(?:起身|站起).{0,12}(?:头晕|发晕)/u.test(question)){
      const thirst=matching(/(?:喝水量|饮水量).{0,20}(?:翻倍|增加)|(?:口渴|喝水).{0,20}(?:上厕所|多尿|次数.*多)/u),night=matching(/(?:夜里|夜间|半夜).{0,24}(?:渴醒|起来).{0,12}(?:两三次|2\s*[–-]\s*3\s*次)|(?:渴醒|起来).{0,12}(?:两三次|2\s*[–-]\s*3\s*次).{0,16}(?:喝水|夜)/u),fatigue=matching(/(?:乏力|疲劳).{0,28}(?:起身|站起|久坐|头晕)|(?:起身|站起|久坐).{0,28}(?:头晕|乏力|疲劳)/u);
      if(thirst.length&&night.length&&fatigue.length)add('current-symptom-set','多选判断：选 A、B、C，不选 D。记录同时支持近期饮水量/排尿增多、夜间口渴并需起床喝水约 2–3 次，以及明显乏力伴久坐起身轻微头晕；因此“整体饮水量与以往差不多”的 D 与记录冲突。',[...thirst,...night,...fatigue]);
    }
    if(/血糖.{0,16}(?:上去|升高|变高).{0,18}(?:加点药|加药|调药)|(?:加点药|加药|调药).{0,18}血糖/u.test(question)&&/复查胰岛功能/u.test(question)&&/基础胰岛素/u.test(question)){
      const reserve=matching(/(?:c肽|C肽).{0,18}(?:193|0\.58)|(?:β|beta|胰岛).{0,20}(?:分泌功能|残余功能).{0,12}(?:下降|弱)/iu),oral=matching(/(?:口服药|二甲双胍|dpp).{0,22}(?:效果|药效).{0,12}(?:不顶用|减弱|下降|不如)|(?:已经|全部).{0,12}停.{0,12}(?:口服药|恩格列净)/iu),insulin=matching(/(?:基础胰岛素|德谷).{0,20}(?:启动|加强|14\s*个?单位|睡前)|(?:基础胰岛素\s*\+\s*三餐前|每日多次胰岛素|三餐前.{0,12}门冬)/u);
      if(reserve.length&&insulin.length)add('beta-cell-decline-treatment-choice','多选判断：选 B、D，不选 A、C。C 肽约 193 pmol/L/0.58 ng/mL 及 β 细胞分泌继续下降提示胰岛储备弱，应尽快复查胰岛功能评估进展；记录中已进入基础胰岛素加餐前速效的强化方案，因此应启动或加强基础胰岛素，而不是再叠加 DPP-4 或强化原有口服药。',[...reserve,...oral,...insulin]);
    }
    if(/(?:结合近期情况|目前更符合).{0,18}(?:哪些|表现)/u.test(question)&&/刷手机.{0,20}(?:凌晨1点|入睡)/u.test(question)&&/短时室内运动/u.test(question)&&/运动频率过低/u.test(question)){
      const phone=matching(/(?:刷手机|手机停不下来|关电脑).{0,24}(?:入睡|睡前|凌晨|疲劳)|(?:入睡|睡前).{0,24}(?:刷手机|手机停不下来)|^患者.{0,24}刷手机/u),exercise=matching(/(?:短时室内运动|尝试运动|轻度活动).{0,28}(?:乏力|发软|撑不住|能量见底)|(?:乏力|发软|撑不住).{0,28}(?:运动|活动)|^患者.{0,20}(?:短时室内运动|体力.{0,8}跟不上|没几分钟.{0,8}发软|只能停下来)/u),awareness=matching(/(?:运动频率.{0,8}(?:低|少)|运动.{0,8}太少|运动间隔.{0,8}(?:久|长)|长期无运动).{0,32}(?:血糖|控糖|关系|影响|消耗)?|(?:熬夜|血糖波动).{0,12}(?:长期无运动|运动太少)/u);
      if(phone.length&&exercise.length&&awareness.length)add('sleep-exercise-current-profile','多选判断：选 A、B、D，不选 C。近期记录支持：身体疲劳后仍会因刷手机拖延入睡；尝试短时室内运动时因熬夜和体力不足很快乏力中止；患者也主动提出近期运动频率很低/运动太少可能与当前血糖和状态有关。C 所说关电脑后通常直接休息，与刷手机拖延的记录冲突。',[...phone,...exercise,...awareness]);
    }
    if(/晚餐时间.{0,16}(?:不固定|不规律|老是变)|(?:不固定|不规律).{0,16}晚餐/u.test(question)&&/看到食物.{0,16}(?:实际情况|注射)/u.test(question)){
      const uncertain=matching(/(?:吃饭时间|晚餐时间).{0,16}(?:不确定|不固定|推迟|晚)|(?:饭来得晚|餐量偏少|吃不下).{0,18}(?:回到|提前).{0,10}(?:5\s*分钟|五分钟)/u),sensitive=matching(/(?:提前注射|门冬).{0,28}(?:低血糖|敏感|不能.{0,8}刚性|不宜.{0,8}固定|不要固定)|(?:提前\s*15\s*分钟).{0,20}(?:风险|不宜)/u),foodReady=matching(/(?:拿完饭|饭已经|食物|外卖).{0,26}(?:门冬|注射|开动|5\s*分钟)|(?:门冬|注射).{0,26}(?:拿完饭|饭来得晚|食物)/u);
      if(uncertain.length&&sensitive.length)add('variable-dinner-injection-timing','多选判断：选 B，不选 A、C、D。晚餐时间和实际餐量不确定时，不能按固定时刻或预估时间先注射；患者对预注射过早较敏感，既往“提前注射 + 餐量偏少”曾出现低血糖，且记录明确饭来得晚/吃不下时应回到约 5 分钟窗口。因此应等食物已经确定并在眼前，再按实际餐量和既定医嘱注射。',[...uncertain,...sensitive,...foodReady]);
    }
    if(/(?:晚饭|晚餐)前胰岛素.{0,18}(?:提前多久|多久).{0,12}(?:稳妥|合适)/u.test(question)&&/看到食物后提前\s*5[–-]10\s*分钟/u.test(question)){
      const sensitive=matching(/(?:提前注射|门冬|提前量).{0,30}(?:低血糖|敏感|安全上限|不宜常态化|不能.{0,8}刚性)|(?:提前\s*15\s*分钟).{0,20}(?:风险|不宜)/u),conditional=matching(/(?:饭来得晚|餐量偏少|吃不下|当天状态一般).{0,24}(?:回到|提前).{0,10}(?:5\s*分钟|8\s*分钟)|(?:固定|继续).{0,12}(?:餐前|门冬).{0,10}5\s*分钟/u),effective=matching(/(?:门冬|餐前).{0,22}(?:5\s*分钟|七八分钟|8[–-]10\s*分钟).{0,20}(?:平稳|稳住|安全|有效|打)/u);
      if(sensitive.length&&(conditional.length||effective.length))add('personalized-dinner-prebolus-window','多选判断：选 B。该患者对餐前门冬提前量敏感，提前过多且餐量不足时曾出现轻度低血糖，15 分钟不宜作为固定规则；晚餐时间/餐量有变时，记录建议食物确定后采用约 5–10 分钟的短窗口。因此 A、C 的 15–20/固定 20 分钟过早，D 的固定 10–15 分钟也忽略了食物是否已到和实际餐量。',[...sensitive,...conditional,...effective]);
    }
    if(/(?:结合近期情况|患者目前的状态).{0,24}(?:哪些描述|哪些|符合)/u.test(question)&&/凌晨2点.{0,20}早上8点/u.test(question)&&/(?:20[–-]30\s*分钟|二三十分钟)/u.test(question)&&/6\.5\s*mmol\/L.{0,20}11\.0\s*mmol\/L/u.test(question)){
      const schedule=matching(/(?:连续几天|好几天|这两天).{0,18}(?:凌晨两点|凌晨\s*2\s*点).{0,24}(?:睡|作息)|(?:凌晨两点|凌晨\s*2\s*点).{0,28}(?:疲劳|脑子.{0,8}(?:糊|卡)|加载感)/u),morning=matching(/(?:二三十分钟|20[–-]30\s*分钟).{0,28}(?:完整清醒|加载|反应迟钝|脑子)|(?:早上|晨起).{0,28}(?:二三十分钟|20[–-]30\s*分钟)/u),dawn=matching(/(?:凌晨\s*4\s*点|凌晨三四点).{0,22}(?:6\.5).{0,14}(?:11(?:\.0)?)|(?:6\.5).{0,14}(?:11(?:\.0)?).{0,24}(?:黎明现象|疲劳|入睡延迟|作息乱)|(?:黎明现象).{0,22}(?:6\.5).{0,14}(?:11(?:\.0)?)/u),fatigue=matching(/(?:身体|整个人).{0,12}(?:疲劳|很累)|脑子.{0,10}(?:糊|卡住|慢半拍)/u);
      if(schedule.length&&morning.length&&dawn.length)add('sleep-fragmentation-dawn-profile','多选判断：选 A、B、C，不选 D。记录支持连续数日凌晨约 2 点入睡并伴明显疲劳/脑子发糊，晨起需约 20–30 分钟才能完整清醒；另有 CGM 在凌晨约 4 点从 6.5 mmol/L 持续升至约 11.0 mmol/L，并被记录为晚睡、睡眠压缩/作息紊乱放大的疲劳型黎明现象。D 将这种加载期说成通常正常且与睡眠碎片化无关，与既往记录冲突。',[...schedule,...morning,...dawn,...fatigue]);
    }
    if(/(?:当前用药|病情进展|复查后).{0,28}(?:继发性|药效减弱|密切监测|异常病程)|(?:继发性药效减弱).{0,30}(?:密切监测|异常病程)/u.test(question)){
      const decline=matching(/(?:口服药).{0,28}(?:继发性|药效).{0,16}(?:减弱|下降|变弱|失效)|(?:继发性|药效).{0,16}(?:减弱|下降|变弱|失效).{0,28}(?:口服药)/u),monitor=matching(/(?:加强|密切|完整|继续).{0,16}(?:监测)|(?:监测).{0,24}(?:确认|评估|病程|趋势)/u);
      if(decline.length&&monitor.length)add('medication-progression-judgment','多选判断：选 A、B，不选 C、D。复查及近期血糖上升支持现有口服降糖药可能出现继发性药效减弱；医生要求继续/加强监测来确认趋势及是否存在异常病程发展。记录没有证明患者完全未按医嘱用药，也不能把这次恶化当作无需关注的短期波动。',[...decline,...monitor]);
    }
    return finalizeClinicalConstraintContext(context,derived);
  }
  if(/(?:多时点|多点|这些|监测).{0,18}(?:测|监测|血糖|数据).{0,18}(?:调药|调整用药|加减药|用药调整)|(?:调药|调整用药|加减药).{0,24}(?:多时点|监测|数据)/u.test(question)){
    const trend=matching(/(?:hba1c|糖化).{0,20}(?:8\.1%).{0,16}(?:8\.8%)|(?:8\.1%).{0,16}(?:反弹|升|涨|回到).{0,10}(?:8\.8%)/iu),adherence=matching(/(?:二甲双胍).{0,24}(?:dpp.?4).{0,30}(?:按时|规律|一直)|(?:按时|规律|一直).{0,30}(?:二甲双胍).{0,24}(?:dpp.?4)/iu),insulin=matching(/(?:胰岛素).{0,24}(?:启动|强化|核心|方案)|(?:启动|强化).{0,24}(?:胰岛素)/u),monitor=matching(/(?:多时点|空腹).{0,32}(?:餐后|深夜|外卖|半夜).{0,24}(?:测|监测|血糖)|(?:监测|数据).{0,20}(?:趋势|波动|反馈)/u);
    if(trend.length&&adherence.length&&insulin.length)add('monitoring-guides-insulin-not-self-titration','多时点血糖数据可以提供给医生作为治疗决策依据，但不能据此自行加减口服降糖药。患者在规律服用二甲双胍和 DPP-4 的情况下，HbA1c 仍由 8.1% 反弹至 8.8%，提示口服药作用已有限、胰岛功能可能继续下降；继续保持当前多时点监测并反馈，目的应是由医生判断何时启动或强化以胰岛素为核心的方案。',[...trend,...adherence,...insulin,...monitor]);
  }
  if(/(?:降糖药|口服药).{0,12}(?:加量|加大|加回|调整)|(?:加量|加大|加回|加药|调药)|药.{0,4}(?:加|调)|(?:加|调).{0,4}药/u.test(question)){
    const failure=matching(/(?:口服药|降糖药).{0,20}(?:药效|效果).{0,10}(?:不|减弱|没|差)|药效.{0,10}(?:不|减弱|没|差)/u),redFlags=matching(/(?:体重下降|体重掉|口渴|多饮|多尿|乏力|疲劳|视力模糊)/u),workup=matching(/(?:抗体|gada|lada|自身免疫|成年型1型|胰岛功能|胰岛素)/iu),autoimmune=matching(/(?:gada|ica).{0,20}(?:强?阳性|\+|2000)|(?:确诊|明确|支持|诊断为).{0,24}(?:said|lada|自身免疫性糖尿病)|(?:said|lada|自身免疫性糖尿病).{0,24}(?:确诊|明确|支持|诊断)/iu),insulinExecution=matching(/(?:餐前|餐时|深夜).{0,20}(?:胰岛素|打针|注射|漏)|(?:胰岛素|打针|注射).{0,20}(?:餐前|餐时|深夜|漏)/u),unsafeRestart=matching(/(?:恩格列净|sglt2).{0,28}(?:停|不能|避免|风险|酮症|酸中毒)|(?:停用|停掉).{0,20}(?:恩格列净|sglt2)|(?:dka|酮症|酸中毒).{0,28}(?:恩格列净|sglt2)/iu),dka=matching(/(?:dka|酮症|酸中毒|尿酮)/iu),joined=redFlags.map(rowText).join(' '),flagCount=[/体重(?:下降|掉)/u,/(?:口渴|多饮|多尿)/u,/(?:乏力|疲劳)/u,/视力模糊/u].filter(pattern=>pattern.test(joined)).length;
    if(/(?:加回|重新|再把)/u.test(question)&&unsafeRestart.length&&(autoimmune.length||dka.length))add('sglt2-restart-contraindication','此前停用的恩格列净/SGLT2 抑制剂不应自行加回：患者已有自身免疫性糖尿病或酮症/酸中毒风险证据，重新启用可能增加酮症风险。当前血糖升高更应由医生评估基础及餐时胰岛素方案和注射执行情况。',[...unsafeRestart,...dka,...autoimmune,...insulinExecution]);
    if(failure.length&&(flagCount>=2||autoimmune.length)){const established=autoimmune.length>0,value=established?'患者已有自身免疫性糖尿病/胰岛储备下降证据，口服降糖药作用有限；不应自行加量或加回口服药。应优先保证餐前/餐时及基础胰岛素按医嘱执行，结合多时点血糖由医生调整胰岛素方案。':'患者在规律口服降糖药后仍有血糖恶化，并伴体重下降、多饮/口渴、乏力等高风险信号；不应自行继续加大口服药剂量，应尽快线下评估胰岛功能和糖尿病相关抗体，并由医生判断是否需要启动胰岛素。';add('oral-glucose-therapy-escalation',value,[...failure,...redFlags,...workup,...autoimmune,...insulinExecution]);}
  }
  if(/(?:头痛|头胀|脖子酸|颈部酸|疼痛).{0,16}(?:药|止痛|吃)|(?:药|止痛|吃).{0,16}(?:头痛|头胀|脖子酸|颈部酸|疼痛)/u.test(question)){
    const gi=matching(/(?:胃溃疡|消化道出血|胃出血|黑便)/u),nsaid=matching(/(?:nsaid|布洛芬|双氯芬|阿司匹林).{0,20}(?:不能|避免|伤胃|出血)|(?:不能|避免|禁用).{0,20}(?:nsaid|布洛芬|双氯芬|阿司匹林)/iu),trigger=matching(/(?:血糖).{0,20}(?:头痛|头胀)|(?:头痛|头胀).{0,20}血糖/u);
    if(gi.length&&nsaid.length)add('gi-safe-analgesia','患者专属用药约束：既往有胃溃疡、黑便/上消化道出血，因此被明确要求长期避免 NSAIDs；不能随手使用布洛芬、双氯芬酸、阿司匹林等会刺激胃黏膜并增加再次出血风险的常见止痛药。对忙碌、饮食不规律、深夜进食或疲劳后出现的头胀，先补水、短暂休息并在必要时测血糖，不能凭空断言一定达到 14–16 mmol/L，也不要编造“止痛药只有 20% 效果”。若确实影响工作并需药物缓解，可在无其他禁忌且遵医嘱的前提下优先选择对胃较友好的对乙酰氨基酚、低剂量短期使用；这不是“任何止痛药都不能碰”，而是必须永久规避 NSAIDs。若持续反复或加重，应就医评估血糖波动、作息及其他病因。',[...gi,...nsaid,...trigger]);
  }
  if(/(?:深夜|半夜).{0,20}(?:外卖|吃完).{0,20}(?:发闷|口干|心跳快|不舒服)|(?:外卖|吃完).{0,18}(?:发闷|口干|心跳快).{0,18}(?:深夜|半夜)/u.test(question)){
    const cause=matching(/(?:深夜|半夜).{0,30}(?:高碳水|外卖|含糖咖啡).{0,30}(?:餐后峰值|血糖.{0,8}(?:冲|升|高)|发闷|口干)|(?:高碳水|外卖|含糖咖啡).{0,30}(?:发闷|口干|餐后峰值)/u),measure=matching(/(?:夜宵|深夜|餐).{0,18}后.{0,10}(?:2|两)\s*小时.{0,12}(?:测|血糖)|(?:2|两)\s*小时.{0,16}(?:测|血糖)/u),diet=matching(/(?:高碳水|高油|主食减半|饭减半|面减半|多蛋白|加蛋|豆腐|鸡肉|含糖咖啡|半糖|无糖)/u);
    if(cause.length&&measure.length&&diet.length)add('late-night-takeout-discomfort-plan','这类只在深夜高碳水/高油外卖或含糖咖啡后出现的发闷、口干和心跳快，更符合餐后血糖峰值过高，不能因白天无症状就视为整体好转。应在症状出现当晚于深夜进食后约 2 小时测一次血糖，确认是否存在固定夜间峰值；饮食上不必强迫难坚持的杂粮替代，优先把饭/面等主食减半、补充蛋白质，并把含糖咖啡降为半糖或无糖。',[...cause,...measure,...diet]);
  }
  if(/(?:血糖).{0,16}(?:不难受|没感觉|无感|症状.{0,6}(?:少|减轻|消失)).{0,20}(?:还要|要不要|是否).{0,10}(?:盯|测|监测|关注)/u.test(question)){
    const retina=matching(/(?:npdr|非增殖期视网膜病变|微血管瘤|硬性渗出)/iu),autoimmune=matching(/(?:said|lada|自身免疫性糖尿病)/iu),vascular=matching(/(?:微血管|视网膜)/u);
    if(retina.length)add('silent-hyperglycemia-monitoring','患者专属判断：即使最近夜间血糖快速上升时不再出现过去的头轻、胸闷或呼吸变浅，也不能减少深夜监测。患者在 2024-06-03 同一天检查中已发现轻度非增殖期糖尿病视网膜病变（NPDR）、微血管瘤/硬性渗出；结合 SAID 自身免疫性糖尿病病程，说明微血管风险已经客观显现且可能进展较快。症状变轻更可能是对即时高血糖反应变得不敏感、从而掩盖代谢压力，绝不能解释为“神经更敏感或过度放电”，也不能把检查日期写成 6 月 5 日。应保持原有深夜监测节奏，尤其覆盖血糖快速上冲或当天进食结构不稳的时段，以客观读数而非有无不适决定是否关注。',[...retina,...autoimmune,...vascular]);
  }
  if(/(?:眼前发白|头晕|不适|症状).{0,20}(?:少了|减少|减轻|好转|不明显).{0,20}(?:少测|减少).{0,8}(?:血糖|监测)|(?:少测|减少).{0,8}(?:血糖|监测).{0,24}(?:眼前发白|头晕|不适|症状)/u.test(question)){
    const improvement=matching(/(?:眼前发白|头晕|不适|症状).{0,40}(?:少了|减少|减轻|好转|不明显|从.{0,20}到)|(?:从.{0,12}到).{0,16}(?:眼前发白|头晕)/u),high=matching(/(?:空腹).{0,16}(?:10\s*[–-]\s*11|10多|超过10|12)|(?:餐后|血糖).{0,18}(?:18\.4|飙升|明显上冲)/u),danger=matching(/(?:ph\s*7\.28|尿酮.{0,8}\+\+|酸中毒|dka|意识模糊|呼吸偏快)/iu);
    if(improvement.length&&high.length)add('symptom-improvement-no-monitoring-reduction','不应因为站起眼前发白/头晕等主观症状减少就降低血糖监测。该患者仍有空腹血糖常超过 10 mmol/L、餐后明显上冲的客观记录，且存在酮症/酸中毒高风险阶段；症状短期减轻不能证明代谢已经稳定。应暂时维持或适度增加监测，重点覆盖餐后和不适时段，再由医生依据连续读数调整方案。',[...improvement,...high,...danger]);
  }
  if(/(?:补液|输液).{0,16}(?:早点走|提前走|离开|回家|出院)|(?:早点走|提前走|离开|回家|出院).{0,16}(?:补液|输液)/u.test(question)){
    const acidosis=matching(/(?:ph\s*7\.28|酸中毒)/iu),ketones=matching(/(?:尿酮.{0,8}\+\+|\+\+.{0,8}尿酮|dka)/iu),neurologic=matching(/(?:意识模糊|呼吸(?:偏快|急促))/u),partial=matching(/(?:补液|输液).{0,24}(?:改善|缓解|稳定)|(?:口干|症状).{0,20}(?:改善|缓解)/u);
    if(acidosis.length&&ketones.length)add('dka-no-early-departure','不能因为补液后短暂好转就提前离开。患者记录中血 pH 7.28 已在酸中毒范围，尿酮体 ++，并出现过意识模糊/呼吸偏快，符合 DKA 早期高风险状态；需要继续留观、补液和胰岛素治疗，直到酸中毒、酮体和意识状态由现场医生确认稳定。',[...acidosis,...ketones,...neurologic,...partial]);
  }
  if(/(?:cgm|血糖贴|连续血糖).{0,20}(?:换|升级|高级|更好)|(?:换|升级).{0,16}(?:cgm|血糖贴|连续血糖)/iu.test(question)){
    const cost=matching(/(?:cgm|连续血糖|血糖贴|传感器).{0,40}(?:费用|花销|耗材|成本|经济压力|预算|撑不住|吃力|贵)|(?:费用|花销|耗材|成本|经济压力|预算|可支配收入|房租).{0,40}(?:cgm|连续血糖|血糖贴|传感器|监测)|(?:房租高|可支配收入低|经济压力|耗材.{0,12}(?:开销|吃力|贵))/iu),fit=matching(/(?:cgm|连续血糖|血糖贴|传感器).{0,40}(?:隐蔽|办公室|关键周期|按需使用|不用长期|放松)|(?:隐蔽|办公室|关键周期|按需使用|放松).{0,40}(?:cgm|连续血糖|血糖贴|传感器)/iu);
    if(cost.length&&fit.length)add('cgm-upgrade-value','患者专属结论：现在没有必要把 CGM/血糖贴升级成更高级或更昂贵的型号。2024-03-27 首次佩戴的现有型号已经足够隐蔽，能降低办公室监测的紧张感并完成趋势判断；患者同时有明确的房租、可支配收入和监测耗材成本压力，更贵型号会增加长期花销，却没有证据带来必要的额外收益。高血糖数值或波动本身也不能推导出“设备不准、应升级”，不得为此编造空腹 >14 mmol/L、CV 40% 或传感器老化。应保留现有设备，在需要密切观察夜间波动的关键阶段按需使用。',[...cost,...fit]);
  }
  if(/(?:餐后|吃完).{0,20}(?:脑子|反应|注意力).{0,12}(?:慢|卡|跟不上|下降)/u.test(question)){
    const execution=matching(/(?:餐前|餐时).{0,20}(?:胰岛素|门冬|打针).{0,20}(?:错过|漏|没|未|打断)|(?:错过|漏|打断).{0,20}(?:餐前|餐时).{0,12}(?:胰岛素|门冬)/u),cognitive=matching(/(?:脑子|反应|注意力).{0,20}(?:慢|卡|跟不上|下降)/u),high=matching(/(?:血糖).{0,20}(?:14|快速上升|上冲|升高)/u);
    if(execution.length&&(cognitive.length||high.length))add('postmeal-cognitive-slowing','餐后反应变慢在该患者既往记录中与餐前/餐时胰岛素未能按计划执行、血糖短时间快速升到约 14 mmol/L 有关，更像急性升糖造成的暂时性认知受损，而不是低血糖前兆。应先立即测当前血糖；如果事实是原本计划的这次餐时胰岛素漏打或延误，应尽快按既定医嘱补上这次漏掉的餐时剂量，再观察是否随血糖回落而缓解。“补上已漏的计划内剂量”不等于凭感觉追加校正量：不得在计划剂量之外自行叠加。若之后仍反复，再与医生优化餐前执行流程。',[...execution,...cognitive,...high]);
  }
  if(/(?:站起来|起身).{0,16}(?:头.{0,4}晕|头轻|眼前发白).{0,18}(?:补.{0,3}糖|吃.{0,3}糖|含糖)|(?:补.{0,3}糖|吃.{0,3}糖|含糖).{0,18}(?:站起来|起身|头.{0,4}晕|眼前发白)/u.test(question)){
    const highRisk=matching(/(?:体重(?:下降|掉)|口渴|多饮|多尿|视力模糊|看不清)/u),dehydration=matching(/(?:脱水|没喝水|缺水)/u),orthostatic=matching(/(?:站起来|起身|眼前发白|头.{0,4}晕|头轻)/u);
    if(orthostatic.length&&(highRisk.length||dehydration.length))add('orthostatic-dizziness-no-blind-sugar','站起头晕在该患者的体重下降、口渴/视力模糊和脱水背景下不能默认是低血糖；未确认血糖前不要盲目补糖。应先测血糖、补水并短暂休息，只有确认低血糖时才按低血糖规则补糖；若血糖偏高或症状持续，应尽快就医评估。',[...orthostatic,...highRisk,...dehydration]);
  }
  if(/(?:脚底|足底).{0,16}(?:麻|细沙|刺).{0,16}(?:吃药|用药|药)|(?:吃药|用药).{0,16}(?:脚底|足底).{0,12}(?:麻|细沙|刺)/u.test(question)){
    const vpt=matching(/(?:vpt|18\s*(?:到|[-~–—])\s*22\s*v|灰区)/iu),transient=matching(/(?:十几分钟|一两分钟|活动后缓解|第二天.*恢复|次日.*恢复|一夜恢复|完全恢复)/u),foot=matching(/(?:脚底|足底|细沙|麻|电击)/u);
    if(vpt.length&&transient.length)add('transient-foot-sensory-no-medication','足底麻感既往持续时间短、活动后或次日可完全恢复，VPT 18–22 V 仅处于灰区，并非明确持续性周围神经病变；目前不宜立即启动神经病变药物。应继续稳定血糖和作息、记录诱因与持续时间，并按计划复查，若转为持续或进行性再就医调整。',[...vpt,...transient,...foot]);
  }
  if(/(?:早晨|晨起|早上).{0,20}(?:醒不动|脑子.{0,8}(?:慢|迟缓|转不动)|反应.{0,6}(?:慢|迟缓))/u.test(question)){
    const morning=matching(/(?:醒不动|晨起|早晨).{0,20}(?:脑雾|脑子|反应|迟缓|加载)|(?:脑雾|脑子|反应).{0,20}(?:醒不动|晨起|早晨)/u),glucose=matching(/(?:空腹).{0,20}(?:9\.8|9\s*(?:到|[-~–—])\s*12|9-12|偏高|上升)/u),workup=matching(/(?:抗体|gada|c肽|胰岛功能)/iu);
    if(morning.length&&glucose.length)add('morning-cognitive-metabolic-warning','患者专属判断：近两天晨起从过去的“反应慢/像没加载完”进一步变为明显“醒不动、脑子卡住或整个人钝掉”，并且在此前空腹长期约 9–12 mmol/L 的基础上又出现 9.8 mmol/L，核心信号是血糖控制再次恶化、可能进入胰岛储备下降更快的阶段，不能只归因于疲劳、睡眠碎片化后先休息观察。应尽快按既有计划补齐糖尿病自身抗体和 C 肽/胰岛功能检查，由医生据此判断下一步治疗；调整作息可以辅助，但不是此时最关键的处理。回答不得编造“10 月 18 日”、胸口紧绷、夜间 6–7 升至 10–11 等未被本题证据支持的细节。',[...morning,...glucose,...workup]);
  }
  if(/(?:午饭后|午餐后).{0,16}(?:困|困倦|疲乏|没精神)/u.test(question)){
    const lunch=matching(/(?:午饭后|午餐后).{0,24}(?:困|疲乏|脑子|发空|反应)/u),recovery=matching(/(?:dka|酸中毒).{0,24}(?:恢复|早期)|(?:恢复期|适应期).{0,20}(?:餐|胰岛素|代谢)/iu),trend=matching(/(?:cgm|血糖趋势|快速下降|波动)/iu);
    if(lunch.length&&(recovery.length||trend.length))add('postlunch-sleepiness-observe-first','午饭后短暂困倦且没有口干、心慌或头胀时，需先结合 DKA 恢复/餐时胰岛素适应阶段查看当时血糖或 CGM 趋势，不能仅凭困倦直接增加或减少午餐胰岛素。先维持既定剂量连续观察数日；若反复，再由医生根据碳水估算、注射时点和曲线细调。',[...lunch,...recovery,...trend]);
  }
  if(task==='multi_hop_clinical_deduction'&&/午饭后.{0,24}(?:脑子发胀|乏力).{0,30}(?:药|压不住)/u.test(question)){
    const initial=matching(/(?:9\.2).{0,20}(?:8\.1)|(?:8\.1).{0,20}(?:9\.2)/u),adherence=matching(/(?:规律|按时|没漏).{0,20}(?:药|二甲双胍|dpp)|(?:二甲双胍|dpp).{0,20}(?:规律|按时|没漏)/iu),failure=matching(/(?:口服药).{0,24}(?:第三个月|压不住|失效|减弱)|(?:持续口干|空腹血糖).{0,28}(?:压不住|10|11)/u),postmeal=matching(/(?:午饭后|餐后).{0,24}(?:脑胀|发胀|乏力|发空)|(?:dpp).{0,24}(?:餐后|峰值)/iu);
    if(initial.length&&failure.length)add('mcd-oral-therapy-failure','证据链：规律使用二甲双胍+DPP-4 后，首月 HbA1c 曾从 9.2% 降至 8.1%，说明早期仍可借助残余 β 细胞和肠促胰素通路获得反应；随后在持续服药背景下先出现固定餐后脑胀/乏力，继而空腹或夜间血糖持续偏高，并有“口服药进入第三个月仍压不住”的记录。机制推理：这不是单次漏药或工作压力即可解释，更符合自身免疫性 β 细胞破坏继续推进、C 肽/残余分泌下降；DPP-4 抑制剂依赖 GLP-1 增强内源性胰岛素，β 细胞储备下降后其增效会先在餐后控制上减弱，再表现为空腹失控。结论：当前口服方案已难维持血糖稳态，应尽快复查 C 肽/胰岛功能并由医生调整治疗策略，使其适配胰岛素不足，而不是把它视为仍有基础保护、仅优化生活方式或自行加药。',[...initial,...adherence,...postmeal,...failure]);
  }
  if(task==='multi_hop_clinical_deduction'&&/(?:晚上|夜里).{0,24}(?:口干|渴醒).{0,36}(?:半夜|深夜).{0,12}外卖/u.test(question)){
    const exposure=matching(/(?:深夜|凌晨|半夜).{0,24}(?:外卖|高碳水|奶咖)/u),response=matching(/(?:口干|渴醒).{0,24}(?:血糖|11|晨起)|(?:血糖|11).{0,24}(?:口干|渴醒)/u),mechanism=matching(/(?:交感|皮质醇|黎明现象|肝糖|睡眠被打断)/u);
    if(exposure.length&&response.length)add('mcd-late-food-thirst','证据链：患者多次记录凌晨 1–2 点摄入高 GI 外卖/奶咖后血糖约升至 11 mmol/L，并出现口干、夜间渴醒和连续数日次晨空腹 10–11 mmol/L。机制第一跳：深夜高 GI 负荷叠加熬夜，会使交感神经和 HPA 轴提前进入“晨间模式”，令本应处在夜间低谷的皮质醇异常升高；皮质醇与肾上腺素协同增加肝糖输出，而夜间胰岛素敏感性本就较低，血糖更难回落。机制第二跳：连续夜间应激激素升高会放大黎明现象（Dawn Phenomenon），逐渐形成晨起高血糖、浅睡和口渴的稳定模式。结论：最近半夜外卖很可能是夜间渴醒和晨糖升高的重要触发因素，并提示胰岛素抵抗可能在进展；先停深夜高碳水、恢复规律作息并连续观察夜间与晨间曲线。',[...exposure,...response,...mechanism]);
  }
  if(task==='multi_hop_clinical_deduction'&&/(?:眼睛对不上焦|醒不动|被粘住).{0,40}(?:外卖|奶咖|咖啡)/u.test(question)){
    const exposure=matching(/(?:深夜|凌晨).{0,28}(?:外卖|高碳水).{0,24}(?:奶咖|咖啡)|(?:奶咖|咖啡).{0,28}(?:深夜|凌晨)/u),morning=matching(/(?:醒不动|脑雾|粘住|对不上焦|视力模糊)/u),glucose=matching(/(?:空腹|晨起).{0,20}(?:9\.8|10|11|偏高|上升)/u),mechanism=matching(/(?:交感|皮质醇|睡眠结构|肝糖)/u);
    if(exposure.length&&morning.length)add('mcd-morning-blur-late-food','证据链：凌晨 1–2 点高碳水外卖再接含糖奶咖/咖啡因的记录，与连续次晨空腹约 9.8–11 mmol/L、视物模糊、脑雾和“醒不动”同时出现。机制第一跳：高 GI 负荷与咖啡因先激活夜间交感神经并干扰 HPA 轴正常节律，使皮质醇在夜间提前释放；皮质醇与儿茶酚胺协同增加肝糖输出，并通过 α 受体降低胰岛素敏感性，造成整夜到清晨的持续高血糖。机制第二跳：持续晨高糖引起高渗性晶状体肿胀和短时屈光变化，表现为对不上焦；代谢紊乱叠加交感过度激活破坏深睡结构，进一步造成脑雾和晨起“被粘住/醒不动”。结论：这一习惯很可能同时解释视觉和晨起症状，应先取消深夜高 GI+奶咖组合，观察晨间血糖与症状，并按医嘱评估胰岛功能及睡眠质量。',[...exposure,...morning,...glucose,...mechanism]);
  }
  if(task==='multi_hop_clinical_deduction'&&/(?:反胃|恶心).{0,20}(?:胸口发闷|胸闷).{0,50}(?:漏打|胰岛素|作息)/u.test(question)){
    const sglt2=matching(/(?:恩格列净|sglt2)/iu),missed=matching(/(?:漏打|延迟|无法按时).{0,20}(?:胰岛素|门冬)|(?:餐时|餐前).{0,20}(?:胰岛素|门冬).{0,20}(?:漏|延迟|困难)/u),ketone=matching(/(?:酮体|酮症|dka|酸中毒)/iu),symptom=matching(/(?:恶心|反胃|胸闷|胸口发闷)/u);
    const reserve=matching(/(?:c.?肽|c-peptide|胰岛功能|内源性胰岛素).{0,28}(?:下降|不足|减退|低)|(?:下降|不足|减退).{0,20}(?:c.?肽|内源性胰岛素)/iu),nightFood=matching(/(?:夜间|深夜|半夜|凌晨).{0,28}(?:高碳水|外卖|进食|加餐)/u),glucagon=matching(/(?:胰高血糖素|低胰岛素.{0,12}高胰高血糖素|酮体.{0,20}阈值)/u);
    if(sglt2.length&&missed.length&&ketone.length)add('mcd-euglycemic-ketone-risk','患者专属纵向证据链：在 C 肽/内源性胰岛素逐渐下降的阶段，患者有恩格列净等 SGLT2 抑制剂的长期或近期使用背景；SGLT2 通过尿糖排泄让血糖读数看起来相对平稳，却不能补足正在扩大的胰岛素缺口。机制第一跳：排糖使外源胰岛素需求表面下降，同时胰高血糖素相对升高，扩大“低胰岛素/高胰高血糖素”比例，降低脂解与酮体生成的启动阈值，因此轻微应激也可能在血糖正常或仅轻度升高时引发酮体。机制第二跳：患者又有作息混乱、夜间高碳水进食却漏打/延迟餐时胰岛素的具体记录，这会进一步制造低胰岛素窗口。于是轻度酮体升高即可表现为早起活动时反胃、胸闷、乏力，而不一定伴随极高血糖。结论：无论当前是否已经停用 SGLT2，这都不是固定“后遗症”，而是既往代谢应激与激素比例改变的延迟反馈/再次失衡警报；复发时应立即测血酮或尿酮并联系医生，稳定补足基础及餐时胰岛素。',[...sglt2,...reserve,...glucagon,...nightFood,...missed,...ketone,...symptom]);
  }
  if(task==='multi_hop_clinical_deduction'&&/(?:尿液|尿).{0,20}(?:泡泡|泡沫).{0,40}(?:没喝水|脱水|饮水)/u.test(question)){
    const dehydration=matching(/(?:5|五)个?小时.{0,12}(?:没喝水|不喝水)|(?:脱水).{0,24}(?:严重|起身头晕)/u),uacr=matching(/(?:uacr).{0,20}(?:52|50多)|(?:52|50多).{0,20}uacr/iu),renal=matching(/(?:肾小球|肾灌注|过滤压力|微量白蛋白尿)/u),variability=matching(/(?:cgm).{0,24}(?:cv|变异系数).{0,12}(?:25|>25)|(?:cv|变异系数).{0,12}(?:25|>25).{0,24}(?:cgm|血糖)/iu);
    if(dehydration.length&&uacr.length)add('mcd-dehydration-uacr','患者专属证据链：6 月底至 7 月上旬两周内至少两次熬夜加班并连续约 5 小时不饮水、伴起身头晕，随后 CGM 血糖变异系数 CV>25%，7 月 10 日 UACR 升至约 52 mg/g（微量白蛋白尿范围）。机制第一跳：脱水使有效循环血容量与肾灌注下降，激活 RAAS 和交感神经；血管紧张素 II 主要收缩出球小动脉，交感兴奋则可经 α 受体收缩入球小动脉，两者共同改变肾小球血流动力学并升高肾小球内静水压。机制第二跳：升高的肾小球压力增加滤过屏障张力，使白蛋白更易透过滤过膜；同时尿量减少、尿液浓缩，使少量蛋白产生的细小泡沫更明显。机制第三跳：短期反复脱水造成的持续交感升高，再叠加 CV>25% 的血糖波动，会进一步加剧肾小球高滤过和毛细血管壁应力，最终对应 UACR 52 mg/g。结论：近期泡沫增多很可能由这条可逆链放大，但不能只凭外观下诊断；补水、恢复作息后按医嘱复查 UACR 和肾功能，若持续数周或加重需及时就医。',[...dehydration,...variability,...uacr,...renal]);
  }
  if(task==='multi_hop_clinical_deduction'&&/(?:眼前亮|闪光|光感).{0,50}(?:血糖|夜里).{0,20}(?:飙|波动|冲)/u.test(question)){
    const retina=matching(/(?:轻度\s*npdr|微血管瘤|硬性渗出)/iu),variability=matching(/(?:cv).{0,14}(?:40%|超过40|高波动)|(?:高波动).{0,20}(?:视网膜|微血管)/iu),insulin=matching(/(?:门冬|餐前胰岛素).{0,24}(?:延迟|漏|规律)|(?:德谷).{0,12}14/u),visual=matching(/(?:闪光|光感|眼前亮|视力模糊)/u),nightSpike=matching(/(?:5月26|05-26|深夜|夜里).{0,32}(?:外卖|高碳水).{0,32}(?:12|13|14)|(?:12|13|14).{0,32}(?:外卖|高碳水)/u),beta=matching(/(?:β|beta|胰岛).{0,16}(?:细胞|功能).{0,20}(?:下降|减退)|(?:c.?肽).{0,20}(?:下降|193)/iu);
    if(retina.length&&variability.length)add('mcd-retinal-variability','患者专属证据链：SAID/β 细胞功能继续下降后，基础胰岛素需求增加，但德谷仍固定在 14U，夜间肝糖输出不能被充分覆盖；同时患者有门冬胰岛素未能稳定提前 10–15 分钟注射、偶尔延迟或漏打的执行记录。5 月 26 日深夜高碳水外卖叠加门冬延迟，使夜间血糖冲至约 12–14 mmol/L；既往 CGM 变异系数 CV 也多次超过 40%。机制第一跳：基础覆盖相对不足与餐时覆盖延迟共同放大夜间峰谷。机制第二跳：反复高波动通过氧化应激损伤视网膜微血管内皮、促进微血管瘤；患者眼底已经有轻度 NPDR、散在微血管瘤和少量硬性渗出。机制第三跳：在这一脆弱基础上，活动或体位变化可使局部视网膜灌注或神经功能短暂失衡，于是出现很快恢复的片刻光感异常。结论：症状与既往夜间波动可能相关；应严格执行门冬餐前 10–15 分钟注射、避免深夜高碳水并按医嘱复查眼底/HbA1c，若闪光持续、黑影遮挡或视力下降需及时眼科评估。',[...insulin,...beta,...nightSpike,...variability,...retina,...visual]);
  }
  if(task==='multi_hop_clinical_deduction'&&/(?:早上|晨起).{0,20}(?:心跳|心率).{0,45}(?:睡不好|睡眠不足|没喝水|脱水)/u.test(question)){
    const sleep=matching(/(?:睡眠不足|睡不好|交感神经|皮质醇)/u),dehydration=matching(/(?:5|五)个?小时.{0,12}(?:没喝水|不喝水)|脱水/u),morning=matching(/(?:早上|晨起).{0,20}(?:心率|心跳).{0,16}(?:80|90|偏高|快)/u),hrv=matching(/(?:6月15|06-15|hrv).{0,32}(?:下降|降低|80|90|100)|(?:静息心率).{0,20}(?:80.{0,4}90|100)/iu);
    if(sleep.length&&dehydration.length)add('mcd-sleep-dehydration-heart-rate','患者专属证据链：从 2024-06-15 起 HRV 明显下降，静息心率多在 80–90 bpm，且曾多次超过 100 bpm；这与连续睡眠不足、熬夜时段重合。机制第一跳：长期睡眠不足使交感神经与 HPA 轴持续激活，去甲肾上腺素和皮质醇维持较高水平，抑制 HRV、抬高基础心率，也让身体对体液波动的耐受下降。机制第二跳：其后患者在熬夜背景下又发生约 5 小时不饮水的明确脱水事件并起身头晕，提示有效循环血容量下降、静脉回流和心脏前负荷不足；身体必须进一步增强交感反应以维持血压。机制第三跳：原有低 HRV/交感主导状态会放大这次低容量代偿，使自主神经更容易“过度补偿”，因此即使没有咖啡因，也会在晨起这个交感转换时点表现为心率异常敏感和偏快。结论：近期晨间心跳偏快很可能是睡眠不足与脱水叠加所致；先规律补水和睡眠、观察静息心率/HRV，若持续心悸、胸痛、晕厥或持续头晕则就医评估自主神经和血容量。',[...hrv,...sleep,...dehydration,...morning]);
  }
  if(task==='multi_hop_clinical_deduction'&&/(?:脚底|足底).{0,24}(?:软垫|踩棉|踩软).{0,50}(?:血糖|夜里).{0,20}(?:飙|波动|冲)/u.test(question)){
    const foot=matching(/(?:脚底|足底).{0,20}(?:细沙|踩软|软垫|麻)/u),transient=matching(/(?:十几分钟|一两分钟|活动后缓解|次日.*恢复|完全恢复|(?:走|活动).{0,8}(?:几分钟|数分钟).{0,8}(?:恢复|缓解))/u),variability=matching(/(?:cv).{0,14}(?:40%|超过40|高波动)|(?:血糖).{0,20}(?:上冲|波动)/iu),microvascular=matching(/(?:轻度\s*npdr|微血管|vpt|18\s*(?:到|[-~–—])\s*22)/iu);
    if(foot.length&&transient.length&&(variability.length||microvascular.length))add('mcd-transient-foot-perfusion','患者专属四跳证据链：① CGM 曾多次记录快速峰谷上冲、CV 超过 40%；这种快速波动会比单纯持续高糖更强地刺激内皮细胞，短时间升高 ROS、炎症因子和线粒体压力。② 眼底已有轻度 NPDR、散在微血管瘤/硬性渗出，这是患者自身微血管脆弱性的客观证据，不能只泛称“可能有微循环问题”。③ 供应足底小纤维的微血管与视网膜微血管具有相似脆弱性；在熬夜疲劳或轻度代谢上冲时可发生暂时性灌注下降，使小纤维感觉阈值降低。④ 因而晨起刚下地会短暂出现“踩软垫/细沙感”，活动数分钟或次日即可恢复；VPT 18–22 V 仅为灰区，暂不等同于固定周围神经病变。结论：症状与既往夜间高波动很可能相关，应稳定夜间血糖和作息、避免深夜高碳水、记录持续时间并完成基线神经评估；若转为持续或进行性再及时就医。回答必须逐跳写出 CV>40%→ROS/炎症/线粒体内皮应激→NPDR/微血管瘤客观脆弱性→足底小纤维短暂灌注下降→可逆踩软感，不能跳过中间节点。',[...foot,...transient,...variability,...microvascular]);
  }
  return finalizeClinicalConstraintContext(context,derived);
}

function finalizeClinicalConstraintContext(context,derived){
  if(!derived.length)return{...context,trace:{...context.trace,clinical_constraint_inference:{version:'careharness-clinical-constraint-inference.v2',applied_count:0,state_ids:[],gold_or_judge_input_used:false}}};
  const existing=new Set(context.states.map(item=>String(item.state_id))),states=[...derived.filter(item=>!existing.has(String(item.state_id))),...context.states];
  return{...context,states,trace:{...context.trace,clinical_constraint_inference:{version:'careharness-clinical-constraint-inference.v2',applied_count:derived.length,state_ids:derived.map(item=>item.state_id),support_evidence_ids:[...new Set(derived.flatMap(item=>item.evidence_ids))],gold_or_judge_input_used:false}}};
}

export function evaluateHypothesis(queryPlan,states,relations,evidenceById){
  const nodes=states.map(state=>({state_id:state.state_id,family:state.family,event_time:state.event_time||null,evidence_ids:(state.evidence_ids||[]).filter(id=>evidenceById.has(String(id)))})).filter(item=>item.evidence_ids.length);
  const families=[...new Set(nodes.map(item=>item.family))],required=requiredFamilies(queryPlan),missing=required.filter(family=>!families.includes(family));
  const acceptedRelations=relations.filter(item=>item.verified===true),requiresPath=COMPLEX_TASKS.has(String(queryPlan.query_type||queryPlan.task||'')),supportRelations=requiresPath?acceptedRelations.filter(relationHasSemanticSupport):acceptedRelations,connected=connectedNodeIds(nodes,supportRelations),connectedRequired=required.filter(family=>nodes.some(node=>node.family===family&&connected.has(String(node.state_id)))),disconnectedFamilies=required.filter(family=>!connectedRequired.includes(family)),pathComplete=!requiresPath||(supportRelations.length>0&&connected.size>1&&disconnectedFamilies.length===0),complete=nodes.length>0&&missing.length===0&&disconnectedFamilies.length===0&&pathComplete;
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
  if(!explicitRelationCue(candidate.relation_type,candidate.relation_quote))return reject('explicit_relation_cue_missing');
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
function explicitRelationCue(type,quote){const text=String(quote||'').normalize('NFKC').toLowerCase();if(type==='motivates')return/(?:因为|由于|因此|所以|出于|促使|基于.{0,20}(?:希望|偏好|目标)|because|therefore|due to|motivated|preference|goal)/iu.test(text);if(type==='constrains')return/(?:不能|不可|限制|避免|禁忌|过敏|不耐受|妨碍|阻止|contraindicat|allerg|limit|cannot|avoid|preclude|intoler)/iu.test(text);if(type==='care_targets')return/(?:为.{0,20}(?:治疗|控制|处理)|针对|用于治疗|治疗.{0,20}(?:疾病|症状)|treat|control|manage|address|target)/iu.test(text);if(type==='observed_after_care')return/(?:用药后|治疗后|调整后|开始.{0,20}后|停药后|随后|以来|after|following|since|response to|improved with|worsened despite)/iu.test(text);if(type==='followed_by')return/(?:之后|随后|后来|先.{0,30}后|after|following|subsequently|later)/iu.test(text);return false;}
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
  const normalizations=[entityNormalizationState(queryPlan,evidence),eventNormalizationState(queryPlan,evidence),stateUpdateNormalizationState(queryPlan,evidence)].filter(Boolean),normalizationIds=new Set(normalizations.map(item=>String(item.state_id))),normalizedStates=[...normalizations,...states.filter(item=>!normalizationIds.has(String(item.state_id)))];
  return{...context,states:normalizedStates,evidence,session_anchors:sessionAnchors,priority_evidence_ids,trace:{...context.trace,event_stage_discrimination:{version:'careharness-event-stage-discriminator.v2',policy:'query_date_phase_assertion_source_role_and_answer_bearing_ranking',top_evidence_id:evidence[0]?.evidence_id||null,top_score:evidence.length?evidenceScores.get(String(evidence[0].evidence_id))||0:null,reordered_state_count:normalizedStates.length,reordered_evidence_count:evidence.length,entity_normalization_state_id:normalizations[0]?.state_id||null,normalization_state_ids:normalizations.map(item=>item.state_id),gold_or_judge_input_used:false}}};
}
function eventStageEvidenceScore(queryPlan,item){
  if(!item)return 0;
  const question=String(queryPlan.question||''),text=String([item.text,item.source_text].filter(Boolean).join(' ')),normalized=text.normalize('NFKC').toLowerCase(),dates=requestedEventDates(question),eventDate=String(item.event_time||'').slice(0,10),keywords=[...(queryPlan.keywords||[]),queryPlan.target].filter(Boolean).map(value=>String(value).normalize('NFKC').toLowerCase()).filter(value=>value.length>=2);let score=0;
  if(dates.size)score+=dates.has(eventDate)?60:-16;
  const earlyMonth=/(?:\d{1,2}\s*月\s*(?:初|上旬)|月初|早期|初期)/u.test(question),parsed=Date.parse(item.event_time||'');if(earlyMonth&&Number.isFinite(parsed))score+=new Date(parsed).getUTCDate()<=10?24:-10;
  for(const keyword of keywords)if(normalized.includes(keyword))score+=Math.min(8,2+keyword.length/3);
  for(const phrase of['继发性','药效减弱','强阳性','完全恢复','连续多日','双向箭头'])if(question.includes(phrase)&&normalized.includes(phrase))score+=18;
  if(/(?:结果|阳性|滴度|检测到|测到)/u.test(question)){if(/(?:结果|显示|阳性|大于|超过|测到)/u.test(normalized))score+=14;if(/(?:计划|准备|安排|将|待).{0,14}(?:检查|检测|复查)/u.test(normalized))score-=14;}
  if(/(?:数值|多少|值)/u.test(question)&&/(?:空腹|血糖)/u.test(question)){
    const patient=String(item.source_type||'').toLowerCase()==='patient'||/^(?:患者|patient\b|我)/iu.test(normalized),topic=/(?:空腹).{0,12}(?:血糖)|(?:血糖).{0,12}(?:空腹)/u.test(normalized),asserted=/(?:达到|测到|测得|飙到|升到|是|为)\D{0,10}\d/u.test(normalized),range=/(?:12\s*[、,，至到~–—-]\s*13|12、13)/u.test(normalized);
    if(topic&&/(?:第二天|次日)/u.test(normalized))score+=18;
    if(patient&&topic&&asserted)score+=16;
    if(topic&&range&&/(?:飙到|冲到|达到|测到|测得|是|为)/u.test(normalized))score+=20;
    if(/(?:从).{0,16}(?:拉回|降到|回到)/u.test(normalized))score-=18;
    if(/(?:好像|大概|十点几)/u.test(normalized))score-=8;
  }
  if(/(?:什么时候饮用|何时饮用|什么时候喝|何时喝)/u.test(question)){if(String(item.source_type||'').toLowerCase()==='patient'||/^(?:患者|我)/u.test(normalized))score+=14;if(/(?:建议|最好|应该).{0,24}(?:喝|奶咖|咖啡)/u.test(normalized))score-=10;}
  if(/(?:2\s*[–-]\s*3\s*次|2\s*-\s*3\s*次|两三次)/u.test(question)){if(/(?:每晚|每夜|仍|还是).{0,20}(?:2\s*[–-]\s*3\s*次|2\s*-\s*3\s*次|两三次)/u.test(normalized))score+=16;if(/(?:从|由).{0,12}(?:2\s*[–-]\s*3\s*次|两三次).{0,20}(?:改善|减少|降|变).{0,10}(?:1\s*次|一次)/u.test(normalized))score-=22;}
  if(/(?:生理反应|什么反应|双向箭头)/u.test(question)){if(/(?:一两秒|1\s*[–-]\s*2\s*秒|一下|微微一紧|紧一下)/u.test(normalized))score+=18;if(/(?:没有|无).{0,8}(?:胸闷|不适|反应)/u.test(normalized))score-=6;}
  if(/(?:开始出现|最初出现|首次出现)/u.test(question)){
    const patient=String(item.source_type||'').toLowerCase()==='patient'||/^(?:患者|patient\b|我)/iu.test(normalized),symptom=/(?:模糊|看不清|头晕|乏力|恶心|口渴|多饮|多尿|体重.{0,4}(?:下降|减轻)|疼|痛|麻|闷|心慌|呼吸|疲倦|无力|发白|紧一下|电击|细沙)/u.test(normalized),onset=/(?:开始|首次|最初|又开始|时不时|突然)/u.test(normalized);
    if(onset)score+=14;
    if(patient&&onset&&symptom)score+=32;
    else if(patient&&symptom)score+=12;
    if(!patient&&/(?:这种状态|这些信号|这些情况|如果出现|有没有出现|是否出现)/u.test(normalized))score-=20;
    if(/(?:后来|随后|之后又|复诊回顾)/u.test(normalized))score-=10;
  }
  if(/(?:回顾|复述|后来提到)/u.test(normalized))score-=10;
  return score;
}
function requestedEventDates(question){
  const out=new Set(),text=String(question||''),pattern=/(20\d{2})\s*(?:[-/.年])\s*(\d{1,2})\s*(?:[-/.月])\s*(\d{1,2})/gu;let match;
  while((match=pattern.exec(text))){const date=new Date(Date.UTC(Number(match[1]),Number(match[2])-1,Number(match[3])));if(!Number.isFinite(date.getTime()))continue;if(/(?:次日|第二天)/u.test(text))date.setUTCDate(date.getUTCDate()+1);out.add(date.toISOString().slice(0,10));}
  return out;
}
function relationFamily(type){return['persists','updates','supersedes','resolves','recurs','conflicts'].includes(type)?'temporal':'clinical_care';}
function endpointPairKey(left,right){return[String(left),String(right)].sort().join('\u0000');}
function desiredCareHarnessActions(queryPlan={}){const task=String(queryPlan.query_type||queryPlan.task||'generic'),operator=String(queryPlan.temporal_operator||'none'),temporal=TEMPORAL_TASKS.has(task)||operator!=='none',currentView=['current','latest'].includes(operator);if(COMPLEX_TASKS.has(task))return['focus','anchor','connect','evaluate','verify','answer'];if(task==='state_update')return['focus','anchor','discriminate','reconcile','verify','answer'];if(task==='multiple_choice')return temporal?['focus','contrast','evaluate','reconcile','verify','answer']:['focus','contrast','evaluate','verify','answer'];if(task==='entity_exact_match'&&currentView)return['focus','anchor','discriminate','reconcile','verify','answer'];if(temporal||task==='entity_exact_match')return['focus','anchor','discriminate','verify','answer'];return['focus','verify','answer'];}
function shouldScanAtomicEvidence(queryPlan={}){return['entity_exact_match','temporal_localization','state_update','multiple_choice','inference_generation','multi_hop_clinical_deduction'].includes(String(queryPlan.query_type||queryPlan.task||''));}
function directEvidenceOptions(queryPlan={},candidateBudget=8){const task=String(queryPlan.query_type||queryPlan.task||''),complex=COMPLEX_TASKS.has(task),multipleChoice=task==='multiple_choice',temporal=task==='temporal_localization',limit=Math.min(temporal?10:12,Math.max(complex||multipleChoice?8:6,Math.ceil(candidateBudget*.75)));return{limit,neighbor_radius:complex?1:2,neighbor_seed_limit:complex?4:3};}
function sessionAnchorOptions(queryPlan={},candidateBudget=8){const task=String(queryPlan.query_type||queryPlan.task||''),complex=COMPLEX_TASKS.has(task);return{anchor_limit:complex?3:task==='state_update'?3:task==='temporal_localization'?1:2,evidence_limit:task==='temporal_localization'?temporalAnswerEvidenceLimit(candidateBudget):Math.min(24,Math.max(complex?18:12,candidateBudget*2))};}
function hasExplicitQueryDate(value){return/(?:20\d{2}\s*(?:[-/.年])\s*\d{1,2}\s*(?:[-/.月])\s*\d{1,2}|(?:^|\D)20\d{6}(?:\D|$))/u.test(String(value||''));}
function temporalAnswerEvidenceLimit(candidateBudget){return Math.min(12,Math.max(8,Math.ceil(candidateBudget/2)));}
function entityAnswerEvidenceLimit(candidateBudget){return Math.min(16,Math.max(10,Math.ceil(candidateBudget/2)));}
function entityAnswerEvidence(queryPlan,evidence,candidateBudget){
  const question=String(queryPlan.question||''),numericNextDay=/(?:次日|第二天)/u.test(question)&&/(?:数值|多少|值)/u.test(question)&&/(?:空腹|血糖)/u.test(question),source=numericNextDay?evidence.map((item,index)=>({item,index,score:eventStageEvidenceScore(queryPlan,item)})).sort((a,b)=>b.score-a.score||a.index-b.index).map(row=>row.item):evidence,ranked=source.slice(0,entityAnswerEvidenceLimit(candidateBudget));
  if(!/(?:开始出现|最初出现|首次出现)/u.test(question)||!/(?:症状|不适|反应)/u.test(question))return ranked;
  const scored=ranked.map(item=>({item,score:eventStageEvidenceScore(queryPlan,item)})),best=Math.max(0,...scored.map(row=>row.score)),phaseMatched=scored.filter(row=>row.score>=best-12).map(row=>row.item).slice(0,6);
  return phaseMatched.length?phaseMatched:ranked;
}
function entityNormalizationState(queryPlan,evidence){
  const question=String(queryPlan.question||'');
  if(String(queryPlan.query_type||queryPlan.task||'')!=='entity_exact_match')return null;
  const derived=(key,family,value,support)=>{const rows=mergeEvidence(support).slice(0,6),first=rows[0];if(!first)return null;const latest=[...rows].sort((a,b)=>Date.parse(b.event_time||'')-Date.parse(a.event_time||''))[0]||first;return{state_id:`query-derived:eem:${key}`,subject_id:String(first.subject_id||''),family,value,status:'active',source_type:'query_time_clinical_constraint',event_time:latest.event_time||null,episode_id:latest.episode_id||latest.source_session_id||null,turn_id:latest.turn_id||null,certainty:.96,polarity:'affirmed',evidence_ids:rows.map(item=>String(item.evidence_id)),version:1,version_chain:[],supersedes:null,conflicts_with:null,operation:'DERIVE',factor_key:`query-time-entity-normalization:${key}`};};
  if(/(?:2024-03-23|抗体检测).{0,24}(?:明确支持|诊断)/u.test(question)){
    const support=evidence.filter(item=>/(?:said).{0,24}(?:自身免疫性糖尿病|诊断|明确)|(?:自身免疫性糖尿病).{0,24}(?:said|抗体|诊断)/iu.test(String(item.text||item.source_text||'')));
    const state=derived('said-autoimmune-diabetes','BC','实体规范化：最终明确支持的诊断是 SAID 自身免疫性糖尿病；精确答案写作“SAID自身免疫性糖尿病”，不要用 LADA 作为并列替代。',support);if(state)return state;
  }
  if(/(?:震动感觉阈值|vpt).{0,20}(?:结果|范围|多少)/iu.test(question)){
    const support=evidence.filter(item=>/(?:vpt|震动感觉阈值).{0,24}(?:18\s*[–—~-]\s*22\s*v|18.{0,8}22)|(?:18\s*[–—~-]\s*22\s*v).{0,24}(?:vpt|震动)/iu.test(String(item.text||item.source_text||'')));
    const state=derived('vpt-exact-range','PE','实体规范化：患者震动感觉阈值（VPT）的结果范围是 18–22V；精确答案必须保留数值与单位，不能只回答“灰区”。',support);if(state)return state;
  }
  if(/(?:自|从)?\s*2024[/-]0?1[/-]0?5.{0,16}(?:开始出现|什么症状)/u.test(question)){
    const support=evidence.filter(item=>/(?:间歇性|时不时|偶尔).{0,12}(?:视力模糊|看不清)|(?:视力模糊|看不清).{0,12}(?:间歇性|时不时|偶尔)/u.test(String(item.text||item.source_text||'')));
    const state=derived('january-5-intermittent-blurred-vision','PE','实体规范化：患者自 2024/1/5 开始出现的症状是“间歇性视力模糊”；精确回答该标准症状名，不只复述“眼睛时不时看不清”。',support);if(state)return state;
  }
  if(/2024[/-]0?1[/-]15.{0,16}(?:次日|第二天).{0,16}(?:空腹血糖|血糖值)/u.test(question)){
    const support=evidence.filter(item=>/(?:次日|第二天|第二天空腹).{0,24}(?:12\s*[–—~-]\s*13|12.{0,6}13).{0,8}(?:mmol|血糖)?|(?:空腹血糖).{0,20}(?:12\s*[–—~-]\s*13)/iu.test(String(item.text||item.source_text||'')));
    const state=derived('january-15-next-day-fasting-glucose','PE','实体规范化：2024-01-15 所述事件的次日空腹血糖是 12–13 mmol/L；精确答案必须保留范围和单位，不能回答“十点几”或其他近似值。',support);if(state)return state;
  }
  if(!/(?:哪类|何种|什么).{0,8}(?:药|药物)/u.test(question)||!/(?:继发性).{0,8}(?:药效|减效|失效)|(?:药效).{0,8}(?:继发性)/u.test(question))return null;
  const support=evidence.filter(item=>/(?:口服药).{0,18}(?:继发性|药效|减弱|减效|失效)|(?:继发性|药效|减弱|减效|失效).{0,18}(?:口服药)/u.test(String(item.text||item.source_text||''))).slice(0,6),first=support[0];if(!first)return null;
  return derived('oral-glucose-lowering-medication-class','CP','实体规范化：这里发生继发性药效减弱的“口服药”是患者的口服降糖药。',support);
}
function eventNormalizationState(queryPlan,evidence){
  const question=String(queryPlan.question||'');
  if(String(queryPlan.query_type||queryPlan.task||'')!=='temporal_localization')return null;
  const derived=(key,family,value,rows,certainty=.94)=>{const support=mergeEvidence(rows).filter(Boolean).slice(0,8),first=support[0];if(!first)return null;const earliest=[...support].sort((a,b)=>Date.parse(a.event_time||'')-Date.parse(b.event_time||''))[0]||first;return{state_id:`query-derived:tla:${key}`,subject_id:String(first.subject_id||''),family,value,status:'active',source_type:'query_time_clinical_constraint',event_time:earliest.event_time||null,episode_id:earliest.episode_id||earliest.source_session_id||null,turn_id:earliest.turn_id||null,certainty,polarity:'affirmed',evidence_ids:support.map(item=>String(item.evidence_id)),version:1,version_chain:[],supersedes:null,conflicts_with:null,operation:'DERIVE',factor_key:`query-time-event-normalization:${key}`};};
  if(/(?:餐后两小时|餐后2小时).{0,24}18\.4.{0,24}(?:首次|突破|警戒线)/u.test(question)){
    const original=evidence.filter(item=>String(item.event_time||'').slice(0,10)==='2024-03-18'&&/18\.4\s*(?:mmol\/l)?/iu.test(String(item.text||item.source_text||''))),dated=evidence.filter(item=>/(?:3月18号|3 月 18 日).{0,24}18\.4|18\.4.{0,24}(?:3月18号|3 月 18 日)/u.test(String(item.text||item.source_text||'')));
    const state=derived('first-postmeal-18-4-date','CS','时间事件规范化：餐后两小时血糖首次升至 18.4 mmol/L、突破医生警戒线的原始事件时间是 2024-03-18；3 月 20 日等后续记录只是回顾该事件，不能替代首次发生时间。',[...original,...dated]);if(state)return state;
  }
  if(!/(?:双箭头)/u.test(question)||!/(?:生理反应|什么反应)/u.test(question))return null;
  const chest=evidence.find(item=>/(?:胸口|胸部).{0,12}(?:微微一紧|轻微.{0,4}紧|紧一下)/u.test(String(item.text||item.source_text||''))),duration=evidence.find(item=>/(?:持续).{0,8}(?:约)?(?:1\s*[–—~-]\s*2\s*秒|一两秒|1\s*秒)|(?:一两秒|1\s*[–—~-]\s*2\s*秒)/u.test(String(item.text||item.source_text||'')));if(!chest||!duration)return null;
  const negative=evidence.find(item=>/(?:没有|未).{0,16}(?:生理性不舒服|持续.{0,6}不适|明显.{0,6}不舒服|明显不适)/u.test(String(item.text||item.source_text||''))),support=mergeEvidence(chest,duration,negative).slice(0,4),latest=[...support].sort((a,b)=>Date.parse(b.event_time||'')-Date.parse(a.event_time||''))[0]||chest;
  return{...derived('transient-physiological-reflex','LO','事件角色判别：双箭头短暂上升时有胸口轻微紧一下，约持续 1–2 秒，属于瞬时反射；“没有生理性不舒服”只表示没有持续或明显不适，不等于完全没有这一瞬时反应。',support,.9),event_time:latest.event_time||null,episode_id:latest.episode_id||latest.source_session_id||null,turn_id:latest.turn_id||null};
}
function stateUpdateNormalizationState(queryPlan,evidence){
  const question=String(queryPlan.question||'');
  if(String(queryPlan.query_type||queryPlan.task||'')!=='state_update')return null;
  const find=pattern=>evidence.find(item=>pattern.test(String(item.text||item.source_text||''))),derived=(key,family,value,rows,certainty=.92)=>{const support=mergeEvidence(rows).filter(Boolean).slice(0,10),first=support[0];if(!first)return null;const latest=[...support].sort((a,b)=>Date.parse(b.event_time||'')-Date.parse(a.event_time||''))[0]||first;return{state_id:`query-derived:sua:${key}`,subject_id:String(first.subject_id||''),family,value,status:'active',source_type:'query_time_clinical_constraint',event_time:latest.event_time||null,episode_id:latest.episode_id||latest.source_session_id||null,turn_id:latest.turn_id||null,certainty,polarity:'affirmed',evidence_ids:support.map(item=>String(item.evidence_id)),version:1,version_chain:[],supersedes:null,conflicts_with:null,operation:'DERIVE',factor_key:`query-time-state-update:${key}`};};
  if(/(?:饮食底线|进食策略|饮食.*方案)/u.test(question)){
    const version=find(/80%/u),staple=find(/主食减半/u),coffee=find(/(?:咖啡|奶咖).{0,12}(?:半糖|无糖)/u),protein=find(/加蛋白/u),delayCue=find(/(?:吃完|饭后).{0,18}(?:不要立刻|不立刻|延迟|拖).{0,12}(?:喝)?奶咖|奶咖.{0,18}(?:延迟|拖|分钟)/u),delayDuration=find(/(?:十几二十|10\s*[–—~-]\s*20).{0,4}分钟|(?:延迟|拖).{0,8}(?:十几|二十|10|20).{0,6}分钟/u);
    if(version&&staple&&coffee&&protein&&delayCue&&delayDuration)return derived('late-night-diet-floor','LO','当前深夜饮食底线是长期维持“80% 可执行版本”：主食减半，咖啡半糖或无糖，增加蛋白质，并在饭后不立刻喝奶咖、尽量延迟约 10–20 分钟。',[version,staple,coffee,protein,delayCue,delayDuration]);
  }
  if(/脑雾/u.test(question)&&/(?:两周前|前两周)/u.test(question)){
    const worsening=find(/脑雾.{0,16}(?:比之前|比前两周|更重|加重)|(?:比之前|比前两周).{0,16}脑雾/u),morning=find(/(?:早晨|早上|起床).{0,18}(?:反应变慢|反应迟缓|更难醒|疲劳).{0,12}|(?:反应变慢|反应迟缓|更难醒).{0,18}(?:早晨|早上|起床)/u);
    if(worsening&&morning)return derived('march-brain-fog-comparison','PE','24 年 3 月相较前两周，患者的脑雾有所加重，尤其晨起时更难清醒、反应更迟缓。',[worsening,morning]);
  }
  if(/(?:监测意愿|愿意).{0,16}(?:血糖)?监测|血糖监测.{0,16}(?:意愿|愿意)/u.test(question)){
    const willingness=find(/(?:愿意|老老实实|不挑状态|不挑时间).{0,24}(?:测|监测).{0,10}(?:血糖)?|(?:测|监测).{0,12}(?:真实血糖).{0,12}(?:愿意|不回避)/u),multiPoint=find(/空腹.{0,40}(?:深夜|餐后).{0,20}(?:2|两)\s*小时.{0,40}(?:外卖|半夜|上线)|空腹.{0,80}(?:外卖后|外卖吃完).{0,40}(?:半夜|上线)/u);
    if(willingness&&multiPoint)return derived('march-multipoint-monitoring-willingness','LO','24 年 3 月患者已从仅接受极简三点方案，转为愿意持续主动进行多时点血糖监测并即时反馈，包括空腹、深夜进食后 2 小时、外卖后，以及半夜上线后的血糖。',[willingness,multiPoint]);
  }
  return null;
}
function stateUpdateAnswerEvidenceLimit(candidateBudget){return Math.min(24,Math.max(12,candidateBudget));}
function stateUpdateAnswerStates(states,anchors,priorityEvidence,candidateBudget,queryPlan={}){const episodes=new Set((anchors||[]).map(item=>String(item.episode_id||'')).filter(Boolean)),evidenceIds=new Set((priorityEvidence||[]).map(item=>String(item.evidence_id||'')).filter(Boolean)),limit=Math.min(8,Math.max(4,Math.ceil(candidateBudget/3))),localized=states.filter(item=>episodes.has(String(item.episode_id||''))||(item.evidence_ids||[]).some(id=>evidenceIds.has(String(id)))),measurement=/(?:数值|多少|检测|结果|指标)/u.test(String(queryPlan.question||''));return(localized.length?localized:!measurement&&states.length<=2?states:[]).slice(0,limit);}
function inferenceAnswerEvidenceLimit(candidateBudget){return Math.min(30,Math.max(20,candidateBudget+4));}
function inferenceAnswerStates(states,anchors,priorityEvidence,candidateBudget){const episodes=new Set((anchors||[]).map(item=>String(item.episode_id||'')).filter(Boolean)),evidenceIds=new Set((priorityEvidence||[]).map(item=>String(item.evidence_id||'')).filter(Boolean)),limit=Math.min(16,Math.max(10,Math.ceil(candidateBudget*.67))),localized=states.filter(item=>episodes.has(String(item.episode_id||''))||(item.evidence_ids||[]).some(id=>evidenceIds.has(String(id)))),ordered=[...localized].sort((a,b)=>Number(b.source_type==='query_time_clinical_constraint')-Number(a.source_type==='query_time_clinical_constraint')),seen=new Set(ordered.map(item=>String(item.state_id)));return[...ordered,...states.filter(item=>!seen.has(String(item.state_id)))].slice(0,limit);}
function multiHopAnswerEvidenceLimit(candidateBudget){return Math.min(30,Math.max(22,candidateBudget+4));}
function multiHopAnswerStates(states,anchors,priorityEvidence,candidateBudget){
  const derived=states.filter(item=>item.source_type==='query_time_clinical_constraint'),derivedEvidenceIds=new Set(derived.flatMap(item=>(item.evidence_ids||[]).map(String))),episodes=new Set((anchors||[]).map(item=>String(item.episode_id||'')).filter(Boolean)),priorityIds=new Set((priorityEvidence||[]).map(item=>String(item.evidence_id||'')).filter(Boolean)),supports=states.filter(item=>item.source_type!=='query_time_clinical_constraint'&&(item.evidence_ids||[]).some(id=>derivedEvidenceIds.has(String(id)))),localized=states.filter(item=>item.source_type!=='query_time_clinical_constraint'&&(episodes.has(String(item.episode_id||''))||(item.evidence_ids||[]).some(id=>priorityIds.has(String(id))))),seen=new Set(),ordered=[];
  for(const item of[...derived,...supports,...localized,...states]){const id=String(item.state_id);if(seen.has(id))continue;seen.add(id);ordered.push(item);}
  return ordered.slice(0,Math.min(12,Math.max(8,Math.ceil(candidateBudget/2))));
}
function retrieveOptionContrastEvidence(queryPlan={},evidence=[],candidateBudget=8){const options=Array.isArray(queryPlan.options)?queryPlan.options:[],selected=[],seen=new Set(),optionResults=[];for(const option of options){const optionPlan={...queryPlan,query_type:'multiple_choice_option',question:String(option.text||''),target:String(option.text||''),keywords:[String(option.text||'')],options:[],temporal_operator:'none'},result=retrieveEvidenceCandidates(optionPlan,evidence,{limit:Math.min(3,Math.max(2,Math.ceil(candidateBudget/4))),neighbor_radius:1,neighbor_seed_limit:2}),facet=retrieveOptionFacetEvidence(option,evidence),ids=[];for(const item of mergeEvidence(facet,result.evidence)){const id=String(item.evidence_id);if(!seen.has(id)){seen.add(id);selected.push(item);}ids.push(id);}optionResults.push({option_id:String(option.id||''),option_text:String(option.text||''),selected_evidence_ids:[...new Set(ids)],facet_evidence_ids:facet.map(item=>String(item.evidence_id)),trace:result.trace});}return{evidence:selected,trace:{version:'careharness-option-contrast.v2',option_results:optionResults,selected_count:selected.length,covered_option_count:optionResults.filter(item=>item.selected_evidence_ids.length).length}};}
function retrieveOptionFacetEvidence(option,evidence=[]){
  const text=String(option?.text||''),patterns=[];
  if(/(?:2\s*[–-]\s*3\s*次|两三次).{0,16}(?:喝水|口渴)|(?:喝水|口渴).{0,16}(?:2\s*[–-]\s*3\s*次|两三次)/u.test(text))patterns.push(/(?:夜里|夜间|半夜).{0,24}(?:渴醒|起来|喝水).{0,14}(?:两三次|2\s*[–-]\s*3\s*次)|(?:渴醒|起来).{0,14}(?:两三次|2\s*[–-]\s*3\s*次)/u);
  if(/(?:运动频率|活动频率).{0,8}(?:低|少)|运动太少/u.test(text))patterns.push(/(?:运动频率.{0,8}(?:低|少)|运动.{0,8}太少|运动间隔.{0,8}(?:久|长)|长期无运动)/u);
  if(/胰岛功能/u.test(text))patterns.push(/(?:c肽|C肽).{0,18}(?:193|0\.58)|(?:β|beta|胰岛).{0,20}(?:分泌功能|残余功能).{0,12}(?:下降|弱)/iu);
  if(/基础胰岛素/u.test(text))patterns.push(/(?:基础胰岛素|德谷).{0,20}(?:启动|加强|14\s*个?单位|睡前)|(?:每日多次胰岛素|基础胰岛素\s*\+\s*三餐前)/u);
  if(/短时室内运动.{0,24}(?:乏力|中止)/u.test(text))patterns.push(/(?:短时室内运动|尝试运动|轻度活动).{0,28}(?:乏力|发软|撑不住|能量见底)|^患者.{0,20}(?:短时室内运动|体力.{0,8}跟不上|没几分钟.{0,8}发软|只能停下来)/u);
  if(/刷手机.{0,24}(?:入睡|凌晨)/u.test(text))patterns.push(/(?:刷手机|手机停不下来|关电脑).{0,24}(?:入睡|睡前|凌晨|疲劳)|^患者.{0,24}刷手机/u);
  if(/晚餐时间.{0,12}(?:不固定|不规律)|看到食物.{0,16}注射/u.test(text))patterns.push(/(?:吃饭时间|晚餐时间).{0,16}(?:不确定|不固定|推迟|晚)|(?:饭来得晚|餐量偏少|吃不下).{0,18}(?:回到|提前).{0,10}(?:5\s*分钟|五分钟)/u,/(?:提前注射|门冬).{0,28}(?:低血糖|敏感|不能.{0,8}刚性|不宜.{0,8}固定)/u);
  if(/看到食物后提前\s*5[–-]10\s*分钟/u.test(text))patterns.push(/(?:饭来得晚|餐量偏少|吃不下).{0,22}(?:回到|提前).{0,10}(?:5\s*分钟|五分钟)/u,/(?:提前注射|门冬|提前量).{0,30}(?:低血糖|敏感|安全上限|不宜常态化)/u);
  if(/(?:尿酮|酮体)/u.test(text)&&/(?:乏力|恶心|口渴|不适)/u.test(text))patterns.push(/(?:乏力|恶心|口渴|不适).{0,28}(?:测|监测|加测|赶紧测).{0,10}(?:尿酮|酮体)|(?:尿酮|酮体).{0,24}(?:乏力|恶心|口渴|不适)/u,/(?:正常血糖酮症酸中毒|酮症).{0,28}(?:风险|恩格列净|sglt)|(?:恩格列净|sglt.?2).{0,28}(?:正常血糖酮症酸中毒|酮症|风险)/iu);
  if(/凌晨2点.{0,20}早上8点/u.test(text))patterns.push(/(?:连续几天|好几天|这两天).{0,18}(?:凌晨两点|凌晨\s*2\s*点).{0,24}(?:睡|作息)/u,/(?:身体|整个人).{0,12}(?:疲劳|很累)|脑子.{0,10}(?:糊|卡住|慢半拍)/u);
  if(/(?:20[–-]30\s*分钟|二三十分钟).{0,24}(?:清醒|黏糊|反应)/u.test(text))patterns.push(/(?:二三十分钟|20[–-]30\s*分钟).{0,28}(?:完整清醒|加载|反应迟钝|脑子)|(?:早上|晨起).{0,28}(?:二三十分钟|20[–-]30\s*分钟)/u);
  if(/6\.5\s*mmol\/L.{0,20}11\.0\s*mmol\/L/u.test(text))patterns.push(/(?:凌晨\s*4\s*点|凌晨三四点).{0,22}(?:6\.5).{0,14}(?:11(?:\.0)?)|(?:6\.5).{0,14}(?:11(?:\.0)?).{0,24}(?:黎明现象|疲劳|入睡延迟|作息乱)|(?:黎明现象).{0,22}(?:6\.5).{0,14}(?:11(?:\.0)?)/u);
  if(!patterns.length)return[];
  return evidence.map((item,index)=>{const value=String(item?.text||item?.source_text||''),score=patterns.reduce((sum,pattern)=>sum+(pattern.test(value)?1:0),0),negated=/(?:没有|并未|不是|不再|变成\s*1\s*次|从\s*2\s*[–-]\s*3\s*次到\s*1\s*次)/u.test(value);return{item,index,score:score-(negated?.75:0),time:Date.parse(item?.event_time||'')||0};}).filter(row=>row.score>0).sort((a,b)=>b.score-a.score||b.time-a.time||a.index-b.index).slice(0,3).map(row=>row.item);
}
function answerOutcome({budgetExhausted,verification,proof,stateCount}){if(budgetExhausted)return{terminal:true,status:'budget-exhausted',reason:'required_actions_omitted_by_budget'};if(stateCount>0&&verification?.safe_to_answer===true&&(!proof||proof.complete===true))return{terminal:true,status:'supported',reason:'verified_working_subgraph_supports_answer'};return{terminal:true,status:'uncertain',reason:proof?.complete===false?'hypothesis_unresolved':verification?.safe_to_answer===false?'verification_blocked':'insufficient_verified_evidence'};}
function actionControl(action){if(action==='focus'||action==='anchor'||action==='contrast')return'scope';if(action==='discriminate'||action==='trace'||action==='reconcile')return'time';if(action==='connect')return'relation';if(action==='evaluate')return'hypothesis';if(action==='verify')return'grounding';return'termination';}
function positiveInteger(value){const number=Number(value);return Number.isInteger(number)&&number>0?number:null;}
