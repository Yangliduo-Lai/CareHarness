import { createQuestionRequest } from './investigation-contract.js';
import { genericClinicalBridgeGrounding,normalizeHypothesisGroundingScope,patientClaimGrounding } from './claim-grounding.js';
import { minimalLiteralSupplement } from './literal-supplement.js';
import { INVESTIGATION_DOCUMENTATION_DATE_SEMANTICS,INVESTIGATION_UNGROUNDED_CLAIM_GAP,investigationAssessmentModelContract,investigationTemporalTargetModelContext } from './prompts.js';
import { retrieveMemoryCandidates,retrieveSessionMemoryAnchors } from './retrieval.js';
import { INVESTIGATION_WORKER_SET_VERSION } from './medmemory-policy.js';

export { INVESTIGATION_WORKER_SET_VERSION } from './medmemory-policy.js';
export const INVESTIGATION_WORKERS=Object.freeze(['search','context','trace','assess','refine','verify','answer']);

export function searchMemory(request,memoryNodes,memoryEdges,instruction,options={}){return retrieveMemoryCandidates({question_request:createQuestionRequest(request),instruction},memoryNodes,{memory_edges:memoryEdges,limit:options.limit,semantic_scores:options.semantic_scores,semantic_top_k:options.semantic_top_k});}
export function contextualizeMemory(request,memoryNodes,instruction,options={}){return retrieveSessionMemoryAnchors({question_request:createQuestionRequest(request),instruction},memoryNodes,{anchor_limit:options.anchor_limit,node_limit:options.node_limit});}
export function connectWorkingMemory(memoryNodes=[],memoryEdges=[]){const ids=new Set(memoryNodes.map(node=>String(node.memory_id)));return dedupeEdges(memoryEdges.filter(edge=>ids.has(String(edge.from_memory_id))&&ids.has(String(edge.to_memory_id))));}

export function traceMemoryGraph(memoryNodes=[],memoryEdges=[],currentMemoryNodes=[],instruction={},options={}){
  const temporalGate=normalizeTraceTemporalGate(options.temporal_gate),refinementBoundary=normalizeTraceRefinementBoundary(options.refinement_boundary),pool=applyTraceScopes(array(memoryNodes),temporalGate,refinementBoundary),byId=new Map(pool.map(node=>[String(node.memory_id),node])),includeContext=instruction.include_context===true,edges=array(memoryEdges).filter(edge=>edge?.status==='verified'&&(includeContext||edge.edge_family!=='context')&&byId.has(String(edge.from_memory_id))&&byId.has(String(edge.to_memory_id))),current=array(currentMemoryNodes).filter(node=>byId.has(String(node?.memory_id||''))),requested=strings(instruction.seed_memory_ids),seedIds=(requested.length?requested:current.map(node=>String(node.memory_id)).slice(0,6)).filter(id=>byId.has(id)),depth=Math.max(1,Math.min(4,Number(instruction.depth)||2)),limit=Math.max(1,Math.min(Number(options.limit)||32,Number(instruction.max_results)||Infinity)),selected=new Map(),frontier=[],targetTerms=strings(instruction.target_terms),explicitTargets=strings(instruction.target_memory_ids).filter(id=>byId.has(id)),rankedTargets=targetTerms.length?rankTraceTargets(pool,targetTerms).slice(0,Math.max(1,Math.min(6,Number(instruction.max_paths)||3))).map(item=>String(item.node.memory_id)):[],targetIds=unique([...explicitTargets,...rankedTargets]).filter(id=>!seedIds.includes(id)),pathRecords=[],pathEdgeIds=new Set(),connectedTargets=new Set();
  // A trace is an expansion operation, not another copy of the current packet.
  // Starting from every current node used to consume the whole limit before a
  // single neighbour could be visited. The worker later merges the traced
  // result back into the current packet, so only explicit/bounded seeds belong
  // in this local traversal.
  for(const id of seedIds)if(byId.has(id)&&!selected.has(id)){selected.set(id,byId.get(id));frontier.push(id);}
  // When Policy names a missing semantic endpoint, find the fewest verified
  // graph/factor/concept hops from an already visible anchor. Target terms are
  // generated on this turn from the question and visible chart; no hidden node
  // or evaluator content is available here.
  if(targetIds.length&&seedIds.length){
    const navigation=traceNavigationIndex(pool,edges,{include_context:includeContext,include_same_factor:instruction.include_same_factor!==false,include_same_concept:instruction.include_same_concept!==false});
    for(const targetId of targetIds){const path=shortestTracePath(seedIds,targetId,navigation,depth);if(!path)continue;connectedTargets.add(targetId);pathRecords.push({target_memory_id:targetId,memory_ids:path.memory_ids,edge_ids:path.edge_ids,navigation_links:path.navigation_links,navigation_step_count:path.memory_ids.length-1,semantics:'navigation_only_non_causal',establishes_patient_fact:false,establishes_causal_relation:false});for(const id of path.memory_ids)if(byId.has(id)&&selected.size<limit)selected.set(id,byId.get(id));for(const id of path.edge_ids)pathEdgeIds.add(id);if(pathRecords.length>=Math.max(1,Math.min(6,Number(instruction.max_paths)||3)))break;}
    // A semantically matched endpoint is still useful when the persistent graph
    // lacks a legitimate bridge. Keep it as an unconnected endpoint instead of
    // manufacturing a causal edge; Assess can label a medical bridge as inference.
    for(const id of targetIds)if(!connectedTargets.has(id)&&byId.has(id)&&selected.size<limit)selected.set(id,byId.get(id));
  }
  const traversed=[];let layer=[...new Set(frontier)];
  for(let level=0;level<depth&&layer.length&&selected.size<limit;level++){
    const next=[];
    for(const id of layer)for(const edge of edges){const neighbor=String(edge.from_memory_id)===id?String(edge.to_memory_id):String(edge.to_memory_id)===id?String(edge.from_memory_id):null;if(!neighbor||!byId.has(neighbor)||selected.has(neighbor))continue;selected.set(neighbor,byId.get(neighbor));next.push(neighbor);traversed.push(edge);if(selected.size>=limit)break;}
    layer=[...new Set(next)];
  }
  if(instruction.include_same_factor===true)for(const seedId of seedIds){const factor=byId.get(seedId)?.factor_key;if(!factor)continue;for(const node of pool)if(node.factor_key===factor&&!selected.has(String(node.memory_id))&&selected.size<limit)selected.set(String(node.memory_id),node);}
  if(instruction.include_same_concept!==false){
    const concepts=new Set(seedIds.flatMap(id=>clinicalConceptKeys(byId.get(id)?.text)));
    if(concepts.size)for(const node of pool){if(selected.size>=limit)break;const nodeConcepts=clinicalConceptKeys(node.text);if(nodeConcepts.some(key=>concepts.has(key))&&!selected.has(String(node.memory_id)))selected.set(String(node.memory_id),node);}
  }
  if(instruction.include_same_episode===true)for(const seedId of seedIds){const episode=byId.get(seedId)?.episode_id;if(!episode)continue;for(const node of pool)if(node.episode_id===episode&&!selected.has(String(node.memory_id))&&selected.size<limit)selected.set(String(node.memory_id),node);}
  const nodes=[...selected.values()].sort((left,right)=>Date.parse(left.event_time||'')-Date.parse(right.event_time||'')||String(left.memory_id).localeCompare(String(right.memory_id))),ids=new Set(nodes.map(node=>String(node.memory_id))),selectedEdges=dedupeEdges(edges.filter(edge=>ids.has(String(edge.from_memory_id))&&ids.has(String(edge.to_memory_id))));
  const unconnectedTargetIds=targetIds.filter(id=>!connectedTargets.has(id));
  return{memory_nodes:nodes,memory_edges:selectedEdges,trace:{version:'careharness-memory-trace.worker-v4-scoped-navigation-paths',seed_memory_ids:seedIds,target_terms:targetTerms,target_memory_ids:targetIds,shortest_paths:pathRecords.map(path=>({target_memory_id:path.target_memory_id,memory_ids:path.memory_ids,edge_ids:path.edge_ids,navigation_step_count:path.navigation_step_count})),navigation_paths:pathRecords,unconnected_target_memory_ids:unconnectedTargetIds,depth,include_same_factor:instruction.include_same_factor!==false,include_same_concept:instruction.include_same_concept!==false,include_same_episode:instruction.include_same_episode===true,include_context:includeContext,temporal_gate:temporalGate,refinement_boundary:refinementBoundary,traversed_edge_ids:unique([...traversed.map(edge=>edge.edge_id),...pathEdgeIds]),selected_memory_count:nodes.length,selected_edge_count:selectedEdges.length,path_count:pathRecords.length,unconnected_target_count:unconnectedTargetIds.length,zero_recall:nodes.length===0}};
}

function rankTraceTargets(nodes,terms){
  const normalizedTerms=terms.map(normalizeTraceText).filter(Boolean),records=[];
  for(const node of nodes){const text=normalizeTraceText([node?.text,node?.source_text].filter(Boolean).join(' '));if(!text)continue;let score=0;for(const term of normalizedTerms){if(text.includes(term))score+=6+Math.min(6,term.length/2);else score+=4*traceGramOverlap(text,term);}if(score>1)records.push({node,score});}
  return records.sort((left,right)=>right.score-left.score||Date.parse(right.node.event_time||'')-Date.parse(left.node.event_time||'')||String(left.node.memory_id).localeCompare(String(right.node.memory_id)));
}
function traceNavigationIndex(nodes,edges,options={}){
  const adjacency=new Map(),add=(left,right,link)=>{if(!left||!right||left===right)return;const values=adjacency.get(left)||[],index=values.findIndex(item=>item.id===right),candidate={id:right,link};if(index<0)values.push(candidate);else if(values[index].link?.pseudo===true&&link?.pseudo===false)values[index]=candidate;adjacency.set(left,values);};
  for(const edge of edges){const left=String(edge.from_memory_id),right=String(edge.to_memory_id),link={link_kind:'verified_graph_edge',edge_id:String(edge.edge_id||''),edge_family:String(edge.edge_family||''),relation_type:String(edge.relation_type||''),pseudo:false,navigation_only:true,establishes_patient_fact:false,establishes_causal_relation:false,underlying_edge_causal_claim:edge.causal_claim===true};add(left,right,{...link,from_memory_id:left,to_memory_id:right});add(right,left,{...link,from_memory_id:right,to_memory_id:left});}
  const connectGroups=(groups,linkKind)=>{for(const[basisKey,ids]of groups.entries()){const bounded=unique(ids).slice(0,48),anchor=bounded[0];for(const id of bounded.slice(1)){const link={link_kind:linkKind,basis_key:basisKey,pseudo:true,navigation_only:true,establishes_patient_fact:false,establishes_causal_relation:false};add(anchor,id,{...link,from_memory_id:anchor,to_memory_id:id});add(id,anchor,{...link,from_memory_id:id,to_memory_id:anchor});}}};
  if(options.include_same_factor){const groups=new Map();for(const node of nodes){const key=String(node?.factor_key||'');if(!key)continue;const values=groups.get(key)||[];values.push(String(node.memory_id));groups.set(key,values);}connectGroups(groups,'same_factor_bridge');}
  if(options.include_context){const groups=new Map();for(const node of nodes){const key=String(node?.episode_id||'');if(!key)continue;const values=groups.get(key)||[];values.push(String(node.memory_id));groups.set(key,values);}connectGroups(groups,'same_episode_bridge');}
  if(options.include_same_concept){const concepts=new Map();for(const node of nodes)for(const key of clinicalConceptKeys(node?.text).slice(0,24)){const values=concepts.get(key)||[];if(values.length<24)values.push(String(node.memory_id));concepts.set(key,values);}connectGroups(concepts,'same_surface_concept_bridge');}
  return adjacency;
}
function shortestTracePath(seedIds,targetId,adjacency,maxDepth){
  const queue=seedIds.map(id=>({id,path:[id],edge_ids:[],navigation_links:[]})),seen=new Set(seedIds);
  while(queue.length){const current=queue.shift();if(current.id===targetId)return{memory_ids:current.path,edge_ids:current.edge_ids,navigation_links:current.navigation_links};if(current.path.length-1>=maxDepth)continue;for(const next of adjacency.get(current.id)||[]){if(seen.has(next.id))continue;seen.add(next.id);queue.push({id:next.id,path:[...current.path,next.id],edge_ids:next.link?.edge_id?[...current.edge_ids,next.link.edge_id]:current.edge_ids,navigation_links:[...current.navigation_links,next.link]});}}
  return null;
}

function applyTraceScopes(nodes,temporalGate,refinementBoundary){
  const excluded=new Set(array(refinementBoundary?.excluded_memory_ids).map(String)),boundaryStart=canonicalTraceDate(refinementBoundary?.temporal?.start_date),boundaryEnd=canonicalTraceDate(refinementBoundary?.temporal?.end_date),gateStart=canonicalTraceDate(temporalGate?.start_date),gateEnd=canonicalTraceDate(temporalGate?.end_date);
  return array(nodes).filter(node=>{const id=String(node?.memory_id||''),date=canonicalTraceDate(node?.event_time);if(excluded.has(id))return false;if(boundaryStart&&(!date||date<boundaryStart))return false;if(boundaryEnd&&(!date||date>boundaryEnd))return false;if(gateStart&&(!date||date<gateStart))return false;if(gateEnd&&(!date||date>gateEnd))return false;return true;});
}
function normalizeTraceTemporalGate(value){if(!value||typeof value!=='object'||value.hard!==true)return null;const start=canonicalTraceDate(value.start_date),end=canonicalTraceDate(value.end_date);if(!start||!end||start>end)return null;return{...value,start_date:start,end_date:end};}
function normalizeTraceRefinementBoundary(value){if(!value||typeof value!=='object'||Array.isArray(value))return null;const excluded_memory_ids=unique(array(value.excluded_memory_ids).map(String)),start=canonicalTraceDate(value.temporal?.start_date),end=canonicalTraceDate(value.temporal?.end_date);if(!excluded_memory_ids.length&&!start&&!end)return null;return{version:String(value.version||'careharness-refinement-boundary.v1'),boundary_id:String(value.boundary_id||'refinement-boundary'),revision:Math.max(1,Number(value.revision)||1),excluded_memory_ids,temporal:{...(start?{start_date:start}:{}),...(end?{end_date:end}:{})},permanent:true};}
function canonicalTraceDate(value){const raw=String(value||'').trim(),match=/^(?<year>20\d{2})[-/.](?<month>\d{1,2})[-/.](?<day>\d{1,2})(?:$|[T\s])/u.exec(raw);if(!match)return'';const year=Number(match.groups.year),month=Number(match.groups.month),day=Number(match.groups.day),date=new Date(Date.UTC(year,month-1,day));return date.getUTCFullYear()===year&&date.getUTCMonth()===month-1&&date.getUTCDate()===day?date.toISOString().slice(0,10):'';}
function traceGramOverlap(left,right){const grams=value=>{const out=new Set();for(let index=0;index<value.length-1;index++)out.add(value.slice(index,index+2));return out;},a=grams(left),b=grams(right);if(!a.size||!b.size)return 0;let hits=0;for(const gram of b)if(a.has(gram))hits++;return hits/Math.max(1,b.size);}
function normalizeTraceText(value){return String(value||'').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu,'');}

export function refineWorkingMemory(request,memoryNodes=[],memoryEdges=[],instruction={},options={}){
  if(options.conservative===true){
    const hardInstruction=conservativeRefineInstruction(instruction),hasHardTemporal=Object.keys(hardInstruction).length>0,result=hasHardTemporal?searchMemory(request,memoryNodes,memoryEdges,hardInstruction,{limit:Math.max(memoryNodes.length,Number(options.limit)||0)}):{memory_nodes:[...memoryNodes],memory_edges:connectWorkingMemory(memoryNodes,memoryEdges),trace:{version:'careharness-conservative-refine.v1'}},ids=new Set(result.memory_nodes.map(node=>String(node.memory_id))),removed=memoryNodes.filter(node=>!ids.has(String(node.memory_id))).map(node=>node.memory_id),applied=removed.length>0;
    if(!result.memory_nodes.length)return{memory_nodes:memoryNodes,memory_edges:connectWorkingMemory(memoryNodes,memoryEdges),trace:{...result.trace,conservative_refine:true,refinement_applied:false,removed_memory_ids:[],protected_memory_ids:strings(instruction.memory_ids),removal_policy:'hard_temporal_mismatch_only',reason:'hard temporal filter produced no grounded Memory Node'}};
    return{memory_nodes:result.memory_nodes,memory_edges:connectWorkingMemory(result.memory_nodes,result.memory_edges),trace:{...result.trace,conservative_refine:true,refinement_applied:applied,removed_memory_ids:removed,protected_memory_ids:strings(instruction.memory_ids),removal_policy:'hard_temporal_mismatch_only'}};
  }
  const result=searchMemory(request,memoryNodes,memoryEdges,instruction,{limit:options.limit});
  if(!result.memory_nodes.length)return{memory_nodes:memoryNodes,memory_edges:connectWorkingMemory(memoryNodes,memoryEdges),trace:{...result.trace,refinement_applied:false,reason:'refinement produced no grounded Memory Node'}};
  const ids=new Set(result.memory_nodes.map(node=>String(node.memory_id))),edges=connectWorkingMemory(result.memory_nodes,memoryEdges).filter(edge=>ids.has(String(edge.from_memory_id))&&ids.has(String(edge.to_memory_id)));
  return{memory_nodes:result.memory_nodes,memory_edges:edges,trace:{...result.trace,refinement_applied:true,removed_memory_ids:memoryNodes.filter(node=>!ids.has(String(node.memory_id))).map(node=>node.memory_id)}};
}

function conservativeRefineInstruction(instruction={}){
  const temporal=instruction?.temporal&&typeof instruction.temporal==='object'&&!Array.isArray(instruction.temporal)?instruction.temporal:{},dateKeys=array(temporal.date_keys).map(String).filter(Boolean),monthKeys=array(temporal.month_keys).map(String).filter(Boolean),baseDate=String(temporal.base_date||''),offset=Number(temporal.offset_days),startDate=String(temporal.start_date||''),endDate=String(temporal.end_date||'');
  if(dateKeys.length||baseDate&&Number.isInteger(offset))return{temporal:{operator:'exact',...(dateKeys.length?{date_keys:dateKeys}:{}),...(baseDate?{base_date:baseDate,offset_days:offset}:{})}};
  if(monthKeys.length)return{temporal:{operator:'range',month_keys:monthKeys}};
  if(startDate||endDate)return{temporal:{operator:'range',...(startDate?{start_date:startDate}:{}),...(endDate?{end_date:endDate}:{})}};
  return{};
}

export function deriveTemporalTargetMatches(questionRequest={},runtime={}){
  const gate=runtime.temporal_gate;
  if(!gate?.hard||gate.kind!=='relative_documentation_window'||!gate.anchor_date||!gate.target_date)return[];
  const anchor=Date.parse(gate.anchor_date),target=Date.parse(gate.target_date),direction=Number.isFinite(anchor)&&Number.isFinite(target)?Math.sign(target-anchor):0;
  if(!direction)return[];
  const matches=[];
  for(const node of array(runtime.memory_nodes)){
    const text=unique([node?.text,node?.source_text]).join('\n'),relative=relativeDateExpression(text,direction);
    if(!relative)continue;
    const tail=text.slice(relative.index),boundary=tail.search(/[，。；;!?！？\n]/u),clause=boundary>=0?tail.slice(0,boundary):tail,measurements=measurementTokens(clause);
    if(!measurements.length)continue;
    matches.push({memory_id:String(node.memory_id),recorded_at:node.event_time||null,target_date:gate.target_date,basis:'relative_expression_within_documentation_window',relative_expression:relative.expression,measurements});
  }
  return matches;
}

export function investigationAssessmentInput(questionRequest={},runtime={},instruction={},options={}){
  const request=createQuestionRequest(questionRequest),targetMatches=deriveTemporalTargetMatches(request,runtime),targetMatchById=new Map(targetMatches.map(match=>[match.memory_id,match])),nodes=array(runtime.memory_nodes).map(node=>({memory_id:node.memory_id,text:node.text,source_text:node.source_text||null,families:node.families||[],event_time:node.event_time||null,recorded_at:node.event_time||null,event_time_semantics:INVESTIGATION_DOCUMENTATION_DATE_SEMANTICS,temporal_target_match:targetMatchById.get(String(node.memory_id))||null,episode_id:node.episode_id||null,source_type:node.source_type,certainty:node.certainty,polarity:node.polarity,status:node.status,version:node.version})),visibleIds=new Set(nodes.map(node=>String(node.memory_id))),edges=verifiedPersistentReasoningEdges(runtime.memory_edges,visibleIds).map(edge=>({edge_id:edge.edge_id,from_memory_id:edge.from_memory_id,to_memory_id:edge.to_memory_id,relation_type:edge.relation_type,edge_family:edge.edge_family,confidence:edge.confidence,status:edge.status,support_memory_ids:edge.support_memory_ids||[]}));
  const patient_profile=runtime.patient_profile||null,recent_sessions=array(runtime.recent_sessions).map(session=>({episode_id:session.episode_id,event_time:session.event_time||null,transcript:String(session.transcript||'')})),navigation_paths=sanitizeNavigationPaths(runtime.navigation_paths||runtime.worker_state?.trace?.navigation_paths),answerFocusLimit=boundedInteger(options.answer_focus_limit,1,16,16),temporal_target=investigationTemporalTargetModelContext(runtime.temporal_gate,targetMatches),modelContract=investigationAssessmentModelContract({...options,answer_focus_limit:answerFocusLimit});
  return{question:request.question,query_type:request.query_type||null,strategy_profile:runtime.strategy_profile||request.strategy_profile||null,instruction,patient_profile,recent_sessions,nodes,edges,navigation_paths,navigation_path_policy:modelContract.navigation_path_policy,temporal_target,answer_focus_limit:answerFocusLimit,focus_role_policy:modelContract.focus_role_policy,source_reference_format:modelContract.source_reference_format,reasoning_hypotheses_policy:modelContract.reasoning_hypotheses_policy,output_schema:modelContract.output_schema};
}

function sanitizeNavigationPaths(value){
  return array(value).slice(0,6).map(path=>({target_memory_id:String(path?.target_memory_id||''),memory_ids:strings(path?.memory_ids).slice(0,6),navigation_step_count:Math.max(0,Number(path?.navigation_step_count)||0),semantics:'navigation_only_non_causal',establishes_patient_fact:false,establishes_causal_relation:false,navigation_links:array(path?.navigation_links).slice(0,5).map(link=>({from_memory_id:String(link?.from_memory_id||''),to_memory_id:String(link?.to_memory_id||''),link_kind:String(link?.link_kind||'unknown_navigation_link'),edge_id:link?.edge_id?String(link.edge_id):null,pseudo:link?.pseudo===true,navigation_only:true,establishes_patient_fact:false,establishes_causal_relation:false})).filter(link=>link.from_memory_id&&link.to_memory_id)})).filter(path=>path.target_memory_id&&path.memory_ids.length);
}

export function validateInvestigationAssessment(value,options={}){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('investigation evaluator must return one JSON object');
  const assessment=['supported','partial','unresolved'].includes(value.assessment||value.verdict)?String(value.assessment||value.verdict):'unresolved';
  const missing_information=array(value.missing_information||value.missing_memory).map(String).filter(Boolean).slice(0,2),consistentAssessment=assessment==='supported'&&missing_information.length?'partial':assessment;
  const answerFocusLimit=boundedInteger(options.answer_focus_limit,1,16,16);
  return{assessment:consistentAssessment,relevant_memory_ids:strings(value.relevant_memory_ids).slice(0,20),covered_aspects:strings(value.covered_aspects).slice(0,10),answer_focus:array(value.answer_focus).slice(0,answerFocusLimit),connections:array(value.connections||value.relations).slice(0,10),reasoning_hypotheses:array(value.reasoning_hypotheses).slice(0,3),missing_information};
}

export function sanitizeInvestigationAssessment(value,options={}){
  const clean=validateInvestigationAssessment(value,options);
  return{...clean,answer_focus:clean.answer_focus.filter(Boolean).map(item=>({aspect:String(item.aspect||''),role:String(item.role||'target'),source_refs:strings(item.source_refs).slice(0,8),memory_ids:strings(item.memory_ids).slice(0,8),required_in_answer:item.required_in_answer!==false})).filter(item=>item.aspect&&(item.source_refs.length||item.memory_ids.length)),connections:clean.connections.filter(Boolean).map(item=>({from_memory_id:String(item.from_memory_id||''),to_memory_id:String(item.to_memory_id||''),relation_type:String(item.relation_type||'associated_with'),assessment:['supports','contradicts','unresolved'].includes(item.assessment)?item.assessment:'unresolved',supporting_memory_ids:strings(item.supporting_memory_ids).slice(0,8),confidence:probability(item.confidence)})).filter(item=>item.from_memory_id&&item.to_memory_id&&item.from_memory_id!==item.to_memory_id),reasoning_hypotheses:clean.reasoning_hypotheses.filter(Boolean).map((item,index)=>({hypothesis_id:String(item.hypothesis_id||`hypothesis_${index+1}`),grounding_scope:normalizeHypothesisGroundingScope(item.grounding_scope),summary:String(item.summary||''),supporting_source_refs:strings(item.supporting_source_refs).slice(0,8),counter_source_refs:strings(item.counter_source_refs).slice(0,8),supporting_memory_ids:strings(item.supporting_memory_ids).slice(0,8),counter_memory_ids:strings(item.counter_memory_ids).slice(0,8),reasoning_steps:strings(item.reasoning_steps).slice(0,6),confidence:probability(item.confidence)}))};
}

export function applyInvestigationAssessment(questionRequest,baseline,evaluation,options={}){
  const clean=sanitizeInvestigationAssessment(evaluation,options),nodeById=new Map(array(baseline.memory_nodes).map(node=>[String(node.memory_id),node])),validIds=new Set(nodeById.keys()),sourceText=sourceReferenceText(baseline),validRefs=new Set(sourceText.keys());clean.relevant_memory_ids=clean.relevant_memory_ids.filter(id=>validIds.has(id));
  if(options.target_only_focus_roles===true){clean.answer_focus=clean.answer_focus.map(item=>({...item,role:'target'}));clean.reasoning_hypotheses=[];}
  let rejectedGroundedClaims=0;
  clean.answer_focus=clean.answer_focus.map(item=>{const citedIds=item.source_refs.filter(ref=>ref.startsWith('memory:')).map(ref=>ref.slice(7)).filter(id=>validIds.has(id)),memory_ids=unique([...item.memory_ids.filter(id=>validIds.has(id)),...citedIds]),source_refs=unique([...item.source_refs.filter(ref=>validRefs.has(ref)),...memory_ids.map(id=>`memory:${id}`)]),sources=source_refs.map(ref=>sourceText.get(ref)).filter(Boolean);if(!claimMatchesSource(item.aspect,sources)){rejectedGroundedClaims++;return null;}return{...item,memory_ids,source_refs};}).filter(Boolean);
  const temporalMatches=deriveTemporalTargetMatches(questionRequest,baseline),temporalMatchById=new Map(temporalMatches.map(match=>[match.memory_id,match])),directTargetFocus=clean.answer_focus.filter(item=>focusMatchesTemporalTarget(item,questionRequest,temporalMatchById));
  if(directTargetFocus.length){
    clean.answer_focus=clean.answer_focus.map(item=>directTargetFocus.includes(item)?{...item,role:'target'}:item);
    clean.temporal_target_matches=temporalMatches.filter(match=>directTargetFocus.some(item=>item.memory_ids.includes(match.memory_id)));
    if(options.exact_entity===true){
      clean.answer_focus=clean.answer_focus.filter(item=>focusMatchesTemporalTarget(item,questionRequest,temporalMatchById)).map(item=>({...item,role:'target',required_in_answer:true}));
      clean.relevant_memory_ids=unique(clean.answer_focus.flatMap(item=>item.memory_ids));
      clean.covered_aspects=unique(clean.answer_focus.map(item=>item.aspect)).slice(0,8);
      clean.reasoning_hypotheses=[];
      clean.missing_information=[];
      clean.assessment='supported';
    }
  }
  clean.reasoning_hypotheses=clean.reasoning_hypotheses.map(item=>{const supporting_memory_ids=item.supporting_memory_ids.filter(id=>validIds.has(id)),counter_memory_ids=item.counter_memory_ids.filter(id=>validIds.has(id)),supporting_source_refs=unique([...item.supporting_source_refs.filter(ref=>validRefs.has(ref)),...supporting_memory_ids.map(id=>`memory:${id}`)]),counter_source_refs=unique([...item.counter_source_refs.filter(ref=>validRefs.has(ref)),...counter_memory_ids.map(id=>`memory:${id}`)]),allRefs=unique([...supporting_source_refs,...counter_source_refs]),sources=allRefs.map(ref=>sourceText.get(ref)).filter(Boolean),statements=[item.summary,...item.reasoning_steps].filter(Boolean),grounding=item.grounding_scope==='generic_clinical_bridge'?statements.map(statement=>genericClinicalBridgeGrounding(statement,sources)):statements.map(statement=>patientClaimGrounding(statement,sources));if(!supporting_source_refs.length||!statements.length||grounding.some(result=>!result.grounded)){rejectedGroundedClaims++;return null;}return{...item,supporting_memory_ids,counter_memory_ids,supporting_source_refs,counter_source_refs,establishes_patient_fact:item.grounding_scope!=='generic_clinical_bridge'};}).filter(Boolean);
  if(rejectedGroundedClaims){if(clean.assessment==='supported')clean.assessment='partial';clean.missing_information=unique([...clean.missing_information,INVESTIGATION_UNGROUNDED_CLAIM_GAP]).slice(0,2);}
  clean.connections=clean.connections.map(relation=>{const from=nodeById.get(relation.from_memory_id),to=nodeById.get(relation.to_memory_id);if(!from||!to||String(from.subject_id)!==String(to.subject_id))return null;const supporting_memory_ids=unique(relation.supporting_memory_ids.map(String).filter(id=>validIds.has(id)&&String(nodeById.get(id)?.subject_id)===String(from.subject_id)));return{...relation,supporting_memory_ids,provenance_scope:'query_time_assessment_only',persistent:false,establishes_graph_fact:false};}).filter(Boolean);
  // Assessor connections are query-local interpretations. Keep them in the
  // semantic assessment, but never append them to the persistent Memory Graph
  // or expose them to Answer as if they were stored clinical facts.
  const memoryNodes=array(baseline.memory_nodes),memoryEdges=dedupeEdges(array(baseline.memory_edges)),working=buildWorkingMemory(questionRequest,memoryNodes,memoryEdges,clean);
  return{...baseline,memory_nodes:memoryNodes,memory_edges:memoryEdges,relations:memoryEdges,working_memory:working,verification:null,semantic_evaluation:clean};
}

function sourceReferenceText(baseline){
  const out=new Map();
  for(const section of array(baseline.patient_profile?.sections))for(const item of array(section?.items)){const ref=String(item?.source_ref||item?.memory_id&&`memory:${item.memory_id}`||''),text=visibleSourceText(item);if(ref&&text)out.set(ref,text);}
  for(const session of array(baseline.recent_sessions)){const ref=`session:${session?.episode_id||''}`;if(session?.episode_id&&session?.transcript)out.set(ref,String(session.transcript));}
  for(const node of array(baseline.memory_nodes)){const text=visibleSourceText(node,{derive_literal_supplement:true});if(node?.memory_id&&text)out.set(`memory:${node.memory_id}`,text);}
  return out;
}
function visibleSourceText(value,{derive_literal_supplement=false}={}){const supplements=array(value?.literal_supplement).map(String),derived=derive_literal_supplement?minimalLiteralSupplement(value):[];return unique([String(value?.text||''),...supplements,...derived]).join('\n');}
function claimMatchesSource(claim,sources){return patientClaimGrounding(claim,array(sources)).grounded;}
function relativeDateExpression(text,direction){
  const pattern=direction>0?/(次日|翌日|第二天|第二日|隔日|次晨|next\s+day|following\s+day|day\s+after)/iu:/(前日|前一天|上一天|头一天|previous\s+day|day\s+before)/iu,match=pattern.exec(String(text||''));
  return match?{expression:match[0],index:match.index}:null;
}
function measurementTokens(text){
  const pattern=/\d+(?:\.\d+)?(?:\s*[-–—~～至到、]\s*\d+(?:\.\d+)?)?\s*(?:%|mmol\s*\/\s*l|mg\s*\/\s*d(?:l|L)|mg\s*\/\s*g|pmol\s*\/\s*l|u\s*\/\s*ml|mmhg|kg|斤|次\s*\/\s*分|bpm|℃|°c)/giu;
  return unique([...String(text||'').matchAll(pattern)].map(match=>match[0].replace(/\s*\/\s*/g,'/').replace(/\s+/g,' ').trim()));
}
function focusMatchesTemporalTarget(item,questionRequest,targetMatchById){
  const question=createQuestionRequest(questionRequest).question,aspect=String(item?.aspect||'');
  if(!semanticQuestionOverlap(question,aspect))return false;
  for(const id of array(item?.memory_ids).map(String)){
    const match=targetMatchById.get(id);if(!match)continue;
    const normalizedAspect=normalizeMeasurement(aspect);if(match.measurements.some(value=>normalizedAspect.includes(normalizeMeasurement(value))))return true;
  }
  return false;
}
function semanticQuestionOverlap(question,aspect){
  const left=String(question||'').normalize('NFKC').toLowerCase(),right=String(aspect||'').normalize('NFKC').toLowerCase(),ignored=new Set(['患者','请问','多少','什么','测得','数值','值是','日期','次日','翌日','第二','一天','时候','记录','显示','结果']);
  for(const match of left.matchAll(/[a-z][a-z0-9+.-]{1,}/giu))if(right.includes(match[0]))return true;
  const han=left.replace(/[^\p{Script=Han}]/gu,'');
  for(let index=0;index<han.length-1;index++){const token=han.slice(index,index+2);if(!ignored.has(token)&&right.includes(token))return true;}
  return false;
}
function normalizeMeasurement(value){return String(value||'').normalize('NFKC').toLowerCase().replace(/[–—~～至到、]/gu,'-').replace(/\s+/g,'');}

export function verifyWorkingMemory(memoryNodes=[],memoryEdges=[],options={}){
  const limit=Math.max(1,Number(options.limit)||32),fixedContextCount=Math.max(0,Number(options.fixed_context_count)||0),valid=memoryNodes.filter(node=>node&&typeof node.memory_id==='string'&&typeof node.text==='string'&&node.text.trim()&&node.subject_id&&node.observation_id),subject=valid[0]?.subject_id||null,selected=[],seen=new Set();
  for(const node of valid){const id=String(node.memory_id);if(seen.has(id)||(subject&&node.subject_id!==subject))continue;seen.add(id);selected.push(node);}
  const ids=new Set(selected.map(node=>String(node.memory_id))),candidateEdges=dedupeEdges(memoryEdges),edges=candidateEdges.filter(edge=>ids.has(String(edge.from_memory_id))&&ids.has(String(edge.to_memory_id))&&(!subject||edge.subject_id===subject)&&array(edge.support_memory_ids).every(id=>ids.has(String(id)))),acceptedEdgeIds=new Set(edges.map(edge=>String(edge.edge_id||''))),rejectedEdgeIds=candidateEdges.filter(edge=>!acceptedEdgeIds.has(String(edge.edge_id||''))).map(edge=>String(edge.edge_id||'')).filter(Boolean);
  const overflow=selected.length>limit;
  return{memory_nodes:selected,memory_edges:edges,rejected_memory_ids:valid.filter(node=>!ids.has(String(node.memory_id))).map(node=>node.memory_id),rejected_edge_ids:rejectedEdgeIds,complete:(selected.length>0||fixedContextCount>0)&&!overflow,overflow,overflow_count:Math.max(0,selected.length-limit),limit,requires_refine:overflow,fixed_context_count:fixedContextCount,policy:overflow?'provenance_valid_but_refine_required':fixedContextCount?'fixed_chart_context_plus_historical_provenance':'provenance_and_patient_boundary'};
}

export function buildWorkingMemory(questionRequest,memoryNodes,memoryEdges,evaluation={}){
  const request=createQuestionRequest(questionRequest);
  const ids=new Set(array(memoryNodes).map(node=>String(node?.memory_id||'')));
  return{version:'careharness-working-memory.v7-claim-grounded',question:request.question,memory_ids:memoryNodes.map(node=>node.memory_id),memory_edges:verifiedPersistentReasoningEdges(memoryEdges,ids).map(edge=>({edge_id:edge.edge_id,from_memory_id:edge.from_memory_id,to_memory_id:edge.to_memory_id,relation_type:edge.relation_type,status:edge.status,confidence:edge.confidence})),assessed_connections:evaluation.connections||[],relevant_memory_ids:evaluation.relevant_memory_ids||[],covered_aspects:evaluation.covered_aspects||[],answer_focus:evaluation.answer_focus||[],reasoning_hypotheses:evaluation.reasoning_hypotheses||[],missing_information:evaluation.missing_information||[],assessment:evaluation.assessment||null};
}

// Same-Session membership is useful for provenance/context expansion, but it is
// not a clinical or temporal relation and must never be presented as a link in
// a reasoning chain.
function reasoningEdges(value){return array(value).filter(edge=>edge?.edge_family!=='context'&&edge?.relation_type!=='co_observed');}
function verifiedPersistentReasoningEdges(value,visibleIds){
  const ids=visibleIds instanceof Set?visibleIds:new Set(array(visibleIds).map(String));
  return reasoningEdges(value).filter(edge=>edge?.persistent===true&&edge?.status==='verified'&&edge?.verified!==false&&ids.has(String(edge.from_memory_id))&&ids.has(String(edge.to_memory_id))&&array(edge.support_memory_ids).length>0&&array(edge.support_memory_ids).every(id=>ids.has(String(id))));
}

// Surface-derived concept keys let Trace recover repeated terminology without
// a disease-, benchmark-, or question-specific vocabulary. Verified graph
// edges and factor lineage remain the primary path; these keys are a fallback.
function clinicalConceptKeys(value){
  const text=String(value||'').normalize('NFKC').toLowerCase(),keys=[];
  for(const match of text.matchAll(/[a-z][a-z0-9+.-]{2,}/giu))keys.push(`latin:${match[0]}`);
  for(const match of text.matchAll(/\d+(?:\.\d+)?\s*(?:%|[a-z]+(?:\/[a-z]+)?|次\/分|斤)/giu))keys.push(`measure:${match[0].replace(/\s+/g,'')}`);
  const chunks=text.match(/[\p{Script=Han}]{4,}/gu)||[];
  for(const chunk of chunks)for(let index=0;index<=chunk.length-4;index++)keys.push(`han4:${chunk.slice(index,index+4)}`);
  return[...new Set(keys)].slice(0,80);
}

function dedupeEdges(edges){const out=[],seen=new Set();for(const edge of edges){const key=[edge?.from_memory_id,edge?.to_memory_id,edge?.relation_type].map(String).join('\u0000');if(!edge?.from_memory_id||!edge?.to_memory_id||seen.has(key))continue;seen.add(key);out.push(edge);}return out;}
function probability(value){const number=Number(value);return Number.isFinite(number)?Math.max(0,Math.min(1,number)):0.5;}
function boundedInteger(value,min,max,fallback){const number=Number(value);return Number.isInteger(number)?Math.max(min,Math.min(max,number)):fallback;}
function strings(value){return unique(array(value).map(String));}
function array(value){return Array.isArray(value)?value:[];}
function unique(values){return[...new Set(values.filter(Boolean))];}
