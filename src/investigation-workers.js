import { applyInvestigationAssessment,contextualizeMemory,investigationAssessmentInput,refineWorkingMemory,searchMemory,traceMemoryGraph,verifyWorkingMemory } from './careharness-actions.js';
import { assertNoHiddenBenchmarkInput } from './information-boundary.js';
import { INVESTIGATION_ASSESSOR_UNAVAILABLE_MESSAGE,investigationWorkerResultSummary,memoryInvestigationWorkerPromptContracts } from './prompts.js';

/**
 * Default worker plug-ins for a Memory Graph investigation. The closed-loop
 * runtime does not know these names or schemas; replacing this registry does
 * not require changing the orchestrator or Question Request boundary.
 */
export function createMemoryInvestigationWorkers({question_request,memory_nodes=[],memory_edges=[],candidate_budget=24,answer_memory_limit=Math.min(candidate_budget,16),answer_focus_limit=16,relation_evaluator=null,embedding_retriever=null,temporal_gate=null,allow_reasoning_hypotheses=true,target_only_focus_roles=false,exact_entity=false,conservative_refine=false}={}){
  const pool=[...memory_nodes],persistentEdges=[...memory_edges],finalLimit=Math.max(1,Math.min(candidate_budget,Number(answer_memory_limit)||16)),temporalGate=normalizeTemporalGate(temporal_gate)||deriveQuestionTemporalGate(question_request),promptContracts=memoryInvestigationWorkerPromptContracts({conservative_refine});
  return{
    search:descriptor(promptContracts.search,({state,instruction})=>{
      const boundary=normalizeRefinementBoundary(state.snapshot.refinement_boundary),boundedPool=applyRefinementBoundary(pool,boundary),prepared=enforceRefinementBoundary(prepareDiscoveryInstruction(question_request,instruction,boundedPool,state.snapshot.memory_nodes,temporalGate),boundary),complete=embedding=>{
        const result=searchMemory(question_request,boundedPool,persistentEdges,prepared,{limit:candidate_budget,semantic_scores:embedding?.scores,semantic_top_k:Math.max(candidate_budget,16)}),trace=discoveryTrace('search',{...result.trace,effective_instruction:prepared,temporal_gate:temporalGate,refinement_boundary:boundary,embedding:embedding?.trace||{status:'not_configured'}},state.snapshot.memory_nodes,result.memory_nodes),candidate=mergeSnapshot(state.snapshot,{temporal_gate:temporalGate,refinement_boundary:boundary,memory_nodes:result.memory_nodes,memory_edges:result.memory_edges,verification:null,assessment:null,worker_state:{last_worker:'search',trace}}),changed=changedIds(state.snapshot.memory_nodes,candidate.memory_nodes),snapshot=changed?candidate:{...candidate,verification:state.snapshot.verification,assessment:state.snapshot.assessment,answer_brief:state.snapshot.answer_brief};
        return{snapshot,summary:investigationWorkerResultSummary('search',{memory_node_count:result.memory_nodes.length,boundary_id:boundary?.boundary_id,temporal_start:temporalGate?.start_date,temporal_end:temporalGate?.end_date}),changed,trace};
      };
      if(typeof embedding_retriever!=='function')return complete(null);
      const query=embeddingQuery(question_request,prepared);return Promise.resolve(embedding_retriever({query,memory_nodes:boundedPool,instruction:prepared})).then(complete,error=>complete({scores:null,trace:{status:'failed_open',error:String(error?.message||error)}}));
    }),
    context:descriptor(promptContracts.context,({state,instruction})=>{
      const boundary=normalizeRefinementBoundary(state.snapshot.refinement_boundary),boundedPool=applyRefinementBoundary(pool,boundary),prepared=enforceRefinementBoundary(prepareDiscoveryInstruction(question_request,instruction,boundedPool,state.snapshot.memory_nodes,temporalGate),boundary),scoped=scopeContextInstruction(prepared,state.snapshot.memory_nodes),result=contextualizeMemory(question_request,boundedPool,scoped.instruction,{anchor_limit:3,node_limit:candidate_budget}),trace=discoveryTrace('context',{...result.trace,effective_instruction:scoped.instruction,inherited_episode_ids:scoped.inherited_episode_ids,temporal_gate:temporalGate,refinement_boundary:boundary},state.snapshot.memory_nodes,result.memory_nodes),candidate=mergeSnapshot(state.snapshot,{temporal_gate:temporalGate,refinement_boundary:boundary,memory_nodes:result.memory_nodes,verification:null,assessment:null,worker_state:{last_worker:'context',trace}}),changed=changedIds(state.snapshot.memory_nodes,candidate.memory_nodes),snapshot=changed?candidate:{...candidate,verification:state.snapshot.verification,assessment:state.snapshot.assessment,answer_brief:state.snapshot.answer_brief};
      return{snapshot,summary:investigationWorkerResultSummary('context',{session_count:result.anchors.length,memory_node_count:result.memory_nodes.length}),changed,trace};
    }),
    trace:descriptor(promptContracts.trace,({state,instruction})=>{
      const boundary=normalizeRefinementBoundary(state.snapshot.refinement_boundary),activeTemporalGate=normalizeTemporalGate(state.snapshot.temporal_gate)||temporalGate,boundedPool=applyTemporalGate(applyRefinementBoundary(pool,boundary),activeTemporalGate),scopedCurrent=applyTemporalGate(applyRefinementBoundary(state.snapshot.memory_nodes,boundary),activeTemporalGate),scopedIds=new Set(scopedCurrent.map(node=>String(node.memory_id))),scopedEdges=state.snapshot.memory_edges.filter(edge=>scopedIds.has(String(edge.from_memory_id))&&scopedIds.has(String(edge.to_memory_id))),baseSnapshot={...state.snapshot,temporal_gate:activeTemporalGate,refinement_boundary:boundary,memory_nodes:scopedCurrent,memory_edges:scopedEdges},suppliedSeeds=array(instruction?.seed_memory_ids),assessmentSeeds=assessmentMemoryIds(state.snapshot.assessment||state.snapshot.answer_brief),traceInstruction={...instruction,seed_memory_ids:suppliedSeeds.length?suppliedSeeds:(assessmentSeeds.length?assessmentSeeds:scopedCurrent.map(node=>node.memory_id)).slice(0,6),include_same_factor:instruction?.include_same_factor!==false,include_same_concept:instruction?.include_same_concept!==false,include_context:instruction?.include_context===true},result=traceMemoryGraph(boundedPool,persistentEdges,scopedCurrent,traceInstruction,{limit:candidate_budget,temporal_gate:activeTemporalGate,refinement_boundary:boundary}),trace=discoveryTrace('trace',{...result.trace,effective_instruction:traceInstruction,temporal_gate:activeTemporalGate,refinement_boundary:boundary},state.snapshot.memory_nodes,result.memory_nodes),candidate=mergeSnapshot(baseSnapshot,{temporal_gate:activeTemporalGate,refinement_boundary:boundary,navigation_paths:result.trace.navigation_paths,memory_nodes:result.memory_nodes,memory_edges:result.memory_edges,verification:null,assessment:null,worker_state:{last_worker:'trace',trace}}),changed=changedIds(state.snapshot.memory_nodes,candidate.memory_nodes)||changedIds(state.snapshot.memory_edges,candidate.memory_edges,'edge_id')||navigationPathSignature(state.snapshot.navigation_paths)!==navigationPathSignature(candidate.navigation_paths),snapshot=changed?candidate:{...candidate,verification:state.snapshot.verification,assessment:state.snapshot.assessment,answer_brief:state.snapshot.answer_brief};
      return{snapshot,summary:investigationWorkerResultSummary('trace',{memory_node_count:result.memory_nodes.length,edge_count:result.memory_edges.length}),changed,trace};
    }),
    assess:descriptor(promptContracts.assess,async({state,instruction})=>{
      if(typeof relation_evaluator!=='function')return{snapshot:{...state.snapshot,assessment:{assessment:'unresolved',relevant_memory_ids:[],covered_aspects:[],missing_information:[INVESTIGATION_ASSESSOR_UNAVAILABLE_MESSAGE]},worker_state:{last_worker:'assess'}},summary:investigationWorkerResultSummary('assess',{unavailable:true}),changed:false};
      const input=investigationAssessmentInput(question_request,state.snapshot,instruction,{allow_reasoning_hypotheses,target_only_focus_roles,exact_entity,answer_focus_limit});assertNoHiddenBenchmarkInput(input,'investigation_assessor');
      try{
        const response=await relation_evaluator(input),raw=response?.value??response,constrained=allow_reasoning_hypotheses?raw:{...raw,reasoning_hypotheses:[]},evaluated=applyInvestigationAssessment(question_request,state.snapshot,constrained,{exact_entity:exact_entity===true,target_only_focus_roles,answer_focus_limit});
        return{snapshot:{...state.snapshot,...evaluated,assessment:evaluated.semantic_evaluation,answer_brief:evaluated.semantic_evaluation,worker_state:{last_worker:'assess',model_trace:response?.trace||null}},summary:investigationWorkerResultSummary('assess',{covered_count:evaluated.semantic_evaluation.covered_aspects.length,missing_count:evaluated.semantic_evaluation.missing_information.length}),changed:true,trace:response?.trace||null};
      }catch(error){
        const trace=error?.gatewayTrace||{component:'careharness_evaluate',error:{kind:'assessment_error',message:String(error?.message||error)}},assessment={assessment:'unresolved',relevant_memory_ids:[],covered_aspects:[],answer_focus:[],connections:[],reasoning_hypotheses:[],missing_information:['Semantic assessment was unavailable; preserve retrieved source-grounded information and continue.']};
        return{snapshot:{...state.snapshot,assessment,answer_brief:assessment,worker_state:{last_worker:'assess',model_trace:trace}},summary:investigationWorkerResultSummary('assess',{unavailable:true,memory_node_count:state.snapshot.memory_nodes.length}),changed:true,trace};
      }
    }),
    refine:descriptor(promptContracts.refine,({state,instruction})=>{
      const result=refineWorkingMemory(question_request,state.snapshot.memory_nodes,state.snapshot.memory_edges,instruction,{limit:finalLimit,conservative:conservative_refine}),preserved=result.memory_nodes,preservedIds=new Set(preserved.map(node=>String(node.memory_id))),preservedEdges=state.snapshot.memory_edges.filter(edge=>preservedIds.has(String(edge.from_memory_id))&&preservedIds.has(String(edge.to_memory_id))),boundary=result.trace.refinement_applied?extendRefinementBoundary(state.snapshot.refinement_boundary,state.snapshot.memory_nodes,preserved,instruction):normalizeRefinementBoundary(state.snapshot.refinement_boundary),trace={...result.trace,effective_instruction:instruction,reasoning_coverage_preserved:preserved.map(node=>node.memory_id),refinement_boundary:boundary},snapshot={...state.snapshot,refinement_boundary:boundary,memory_nodes:preserved,memory_edges:preservedEdges,verification:null,assessment:assessmentForNodes(state.snapshot.assessment,preserved,state.snapshot.patient_profile),worker_state:{last_worker:'refine',trace}};
      return{snapshot,summary:investigationWorkerResultSummary('refine',{applied:result.trace.refinement_applied,memory_node_count:result.memory_nodes.length,boundary_id:boundary?.boundary_id}),changed:changedIds(state.snapshot.memory_nodes,snapshot.memory_nodes),trace};
    }),
    verify:descriptor(promptContracts.verify,({state})=>{
      const verification=verifyWorkingMemory(state.snapshot.memory_nodes,state.snapshot.memory_edges,{limit:finalLimit,fixed_context_count:array(state.snapshot.recent_sessions).length+Number(state.snapshot.patient_profile?.item_count||0)}),snapshot={...state.snapshot,...verification,verification,worker_state:{last_worker:'verify'}};
      return{snapshot,summary:investigationWorkerResultSummary('verify',{complete:verification.complete,memory_node_count:verification.memory_nodes.length,limit:verification.limit}),changed:true};
    }),
    answer:descriptor(promptContracts.answer,({state})=>{
      const nodes=boundedAnswerNodes({...state.snapshot,question_request},finalLimit),verification=verifyWorkingMemory(nodes,state.snapshot.memory_edges,{limit:finalLimit,fixed_context_count:array(state.snapshot.recent_sessions).length+Number(state.snapshot.patient_profile?.item_count||0)}),sourceAssessment=state.snapshot.assessment||state.snapshot.answer_brief||null,assessment=assessmentForNodes(sourceAssessment,verification.memory_nodes,state.snapshot.patient_profile),snapshot={...state.snapshot,...verification,verification,assessment:state.snapshot.assessment?assessment:null,answer_brief:assessment,worker_state:{last_worker:'answer'}};
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
function mergeSnapshot(current,addition){const nodes=mergeById(current.memory_nodes,addition.memory_nodes,'memory_id'),ids=new Set(nodes.map(node=>String(node.memory_id))),edges=mergeById(current.memory_edges,addition.memory_edges,'edge_id').filter(edge=>ids.has(String(edge.from_memory_id))&&ids.has(String(edge.to_memory_id)));return{...current,...addition,memory_nodes:nodes,memory_edges:edges};}
function embeddingQuery(questionRequest,instruction={}){
  const parts=[questionText(questionRequest),instruction.objective,...array(instruction.search_terms),...array(instruction.expansion_terms),...array(instruction.required_terms)].map(value=>String(value||'').trim()).filter(Boolean);
  return[...new Set(parts)].join('；').slice(0,1600);
}
function normalizeRefinementBoundary(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const temporal=value.temporal&&typeof value.temporal==='object'&&!Array.isArray(value.temporal)?value.temporal:{},start=canonicalDate(temporal.start_date),end=canonicalDate(temporal.end_date),operator=['earliest','latest','range','exact'].includes(String(temporal.operator||''))?String(temporal.operator):'',excluded=[...new Set(array(value.excluded_memory_ids).map(String).filter(Boolean))];
  if(!excluded.length&&!start&&!end&&!operator)return null;
  return{version:'careharness-refinement-boundary.v1',boundary_id:String(value.boundary_id||`refine-${Math.max(1,Number(value.revision)||1)}`),revision:Math.max(1,Number(value.revision)||1),excluded_memory_ids:excluded,temporal:{...(operator?{operator}:{}),...(start?{start_date:start}:{}),...(end?{end_date:end}:{}),...(['earliest','latest'].includes(String(temporal.prefer||''))?{prefer:String(temporal.prefer)}:{})},permanent:true};
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
  copy.connections=array(copy.connections).map(item=>({...item,supporting_memory_ids:array(item?.supporting_memory_ids).map(String).filter(id=>ids.has(id))})).filter(item=>ids.has(String(item?.from_memory_id||''))&&ids.has(String(item?.to_memory_id||'')));
  copy.reasoning_hypotheses=array(copy.reasoning_hypotheses).map(item=>{const supporting_memory_ids=array(item?.supporting_memory_ids).map(String).filter(id=>ids.has(id)),counter_memory_ids=array(item?.counter_memory_ids).map(String).filter(id=>ids.has(id)),supporting_source_refs=array(item?.supporting_source_refs).map(String).filter(keepRef),counter_source_refs=array(item?.counter_source_refs).map(String).filter(keepRef);return{...item,supporting_memory_ids,counter_memory_ids,supporting_source_refs,counter_source_refs};}).filter(item=>item.supporting_source_refs.length||item.supporting_memory_ids.length);
  return copy;
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
  relaxImpossibleRequiredTerms(clean,pool);
  clean.temporal=temporalGate?temporalInstructionForGate(temporalGate):groundTemporalInstruction(questionText(questionRequest),clean.temporal,pool,currentNodes);
  if(!Object.keys(clean.temporal).length)delete clean.temporal;
  if(temporalGate)relaxConflictingGateScope(clean,pool,temporalGate);else relaxConflictingExactScope(clean,pool);
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
  if(!questionDates.length&&questionMonths.length)return{operator:'range',month_keys:questionMonths};
  const suppliedDates=[...array(temporal.date_keys).map(canonicalDate),canonicalDate(temporal.base_date),canonicalDate(temporal.start_date),canonicalDate(temporal.end_date)].filter(Boolean),grounded=suppliedDates.every(date=>questionDates.includes(date)||currentDates.has(date));
  if(suppliedDates.length&&!grounded){
    const lookback=relativeLookbackDays(question),anchor=latestDate(pool);
    if(lookback&&anchor){const start=new Date(`${anchor}T00:00:00.000Z`);start.setUTCDate(start.getUTCDate()-(lookback-1));return{operator:'range',start_date:start.toISOString().slice(0,10),end_date:anchor};}
    return{};
  }
  if(String(temporal.operator||'')==='range'&&!suppliedDates.length){
    const lookback=relativeLookbackDays(question),anchor=latestDate(pool);
    if(lookback&&anchor){const start=new Date(`${anchor}T00:00:00.000Z`);start.setUTCDate(start.getUTCDate()-(lookback-1));return{operator:'range',start_date:start.toISOString().slice(0,10),end_date:anchor};}
  }
  return temporal;
}
function boundedAnswerNodes(snapshot,limit,preferredNodes=[]){
  const nodes=array(snapshot.memory_nodes),byId=new Map(nodes.map(node=>[String(node?.memory_id||''),node])),assessment=snapshot.assessment||snapshot.answer_brief||{},priority=assessmentMemoryIds(assessment),preferred=array(preferredNodes).map(node=>String(node?.memory_id||'')),out=[],seen=new Set(),add=id=>{const key=String(id||'');if(key&&!seen.has(key)&&byId.has(key)&&out.length<limit){seen.add(key);out.push(byId.get(key));}};
  if(!requiresClinicalReasoning(questionText(snapshot?.question||snapshot?.question_request||''))&&!preferred.length){for(const id of priority)add(id);for(const node of nodes)add(node?.memory_id);return out;}
  const reserve=clinicalRoleCandidates(nodes,priority),priorityQuota=Math.max(4,limit-Math.min(7,reserve.length));
  for(const id of priority.slice(0,priorityQuota))add(id);
  for(const node of reserve)add(node.memory_id);
  for(const id of preferred)add(id);
  for(const id of priority)add(id);
  for(const node of nodes)add(node?.memory_id);
  return out;
}
function assessmentMemoryIds(assessment){return[...new Set([
  ...array(assessment?.relevant_memory_ids),
  ...array(assessment?.answer_focus).flatMap(item=>array(item?.memory_ids)),
  ...array(assessment?.connections).flatMap(item=>[item?.from_memory_id,item?.to_memory_id,...array(item?.supporting_memory_ids)]),
  ...array(assessment?.reasoning_hypotheses).flatMap(item=>[...array(item?.supporting_memory_ids),...array(item?.counter_memory_ids)]),
].map(String).filter(Boolean))];}

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
function requiresClinicalReasoning(value){return/(?:为什么|原因|怎么回事|意味着|说明|导致|关系|要不要|需不需要|是否需要|该不该|能不能|可不可以|建议|调整|加量|减量|换药|停药|恢复|影响|风险|判断)/u.test(String(value||''));}
function questionText(value){return String(value?.question||value||'').normalize('NFKC');}
function datesInText(value){const text=String(value||'').normalize('NFKC'),out=[];for(const match of text.matchAll(/(?<year>20\d{2}|\d{2})\s*(?:年|[-/.])\s*(?<month>\d{1,2})\s*(?:月|[-/.])\s*(?<day>\d{1,2})(?:日)?/gu)){const year=Number(match.groups.year)<100?2000+Number(match.groups.year):Number(match.groups.year),month=Number(match.groups.month),day=Number(match.groups.day),date=canonicalDate(`${year}-${month}-${day}`);if(date)out.push(date);}return[...new Set(out)];}
function monthsInText(value,exactDates=[]){const text=String(value||'').normalize('NFKC'),out=[];for(const match of text.matchAll(/(?<year>20\d{2}|[2-9]\d)\s*(?:年|[-/.])\s*(?<month>\d{1,2})(?:月)?(?!\s*[-/.年]?\s*\d)/gu)){const rawYear=Number(match.groups.year),year=rawYear<100?2000+rawYear:rawYear,month=Number(match.groups.month);if(month>=1&&month<=12)out.push(`${year}-${String(month).padStart(2,'0')}`);}for(const date of exactDates){const index=out.indexOf(date.slice(0,7));if(index>=0)out.splice(index,1);}return[...new Set(out)];}
function relativeDateOffset(value){const text=String(value||'').normalize('NFKC');if(/(?:大前天|三天前)/u.test(text))return-3;if(/(?:大后天|三天后)/u.test(text))return 3;if(/(?:前天|两天前)/u.test(text))return-2;if(/(?:后天|两天后)/u.test(text))return 2;if(/(?:前一日|前一天|上一日|前日|previous day)/iu.test(text))return-1;if(/(?:次日|翌日|第二天|后一天|下一日|next day)/iu.test(text))return 1;return null;}
function asksForLatestStatus(value){return/(?:当前|目前|现在|如今|现今|现阶段|眼下|时下|最新|最近一次|至今|current(?:ly)?|now|today|latest|most\s+recent|at\s+present|since\s+then)/iu.test(String(value||'').normalize('NFKC'));}
function hasExplicitDateRangeSyntax(value){return/(?:\d(?:日)?\s*(?:至|到)\s*20\d{2}|之间|期间|\bfrom\b[\s\S]*\bto\b|\bbetween\b[\s\S]*\band\b)/iu.test(String(value||'').normalize('NFKC'));}
function relativeLookbackDays(value){const text=String(value||''),arabic=/(\d+)\s*(周|天)/u.exec(text);if(arabic)return Math.max(1,Math.min(90,Number(arabic[1])*(arabic[2]==='周'?7:1)));const chinese=/([一二两三四五六七八九十]+)\s*(周|天)/u.exec(text);if(chinese){const number=chineseNumber(chinese[1]);return Math.max(1,Math.min(90,number*(chinese[2]==='周'?7:1)));}return/(?:这几天|近几天)/u.test(text)?7:null;}
function chineseNumber(value){const digit=character=>({一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9}[character]||0);if(value==='十')return 10;if(value.startsWith('十'))return 10+digit(value[1]);if(value.includes('十')){const[a,b='']=value.split('十');return digit(a)*10+digit(b);}return Math.max(1,digit(value));}
function latestDate(nodes){return array(nodes).map(node=>canonicalDate(node?.event_time)).filter(Boolean).sort().at(-1)||'';}
function canonicalDate(value){const raw=String(value||'').trim(),match=/^(?<year>20\d{2})[-/.](?<month>\d{1,2})[-/.](?<day>\d{1,2})(?:$|T)/u.exec(raw);if(match){const year=Number(match.groups.year),month=Number(match.groups.month),day=Number(match.groups.day),date=new Date(Date.UTC(year,month-1,day));return date.getUTCFullYear()===year&&date.getUTCMonth()===month-1&&date.getUTCDate()===day?date.toISOString().slice(0,10):'';}return'';}
function addDays(value,days){const date=new Date(`${value}T00:00:00.000Z`);date.setUTCDate(date.getUTCDate()+Number(days||0));return date.toISOString().slice(0,10);}
function mergeById(left,right,key){const out=[],seen=new Set();for(const item of[...array(left),...array(right)]){const id=String(item?.[key]||'');if(!id||seen.has(id))continue;seen.add(id);out.push(item);}return out;}
function changedIds(before,after,key='memory_id'){return array(before).map(item=>item?.[key]).join('|')!==array(after).map(item=>item?.[key]).join('|');}
function navigationPathSignature(value){return array(value).map(path=>JSON.stringify(stableSignatureValue(path))).sort().join('|');}
function stableSignatureValue(value){if(Array.isArray(value))return value.map(stableSignatureValue);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,stableSignatureValue(value[key])]));return value;}
function array(value){return Array.isArray(value)?value:[];}
