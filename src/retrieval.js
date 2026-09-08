import { MEMORY_FAMILIES } from './schema.js';
import { createQuestionRequest } from './investigation-contract.js';
import { canonicalCalendarDate as canonicalDate,canonicalCalendarMonth as canonicalMonthOnly } from './temporal-expressions.js';

/**
 * Build one worker-local retrieval request. The original question is retained
 * only for audit and policy context. Retrieval direction comes exclusively
 * from the instruction chosen on the current policy turn.
 */
export function createMemoryRetrievalRequest(questionRequest,instruction={}){
  return{
    question_request:createQuestionRequest(questionRequest),
    instruction:normalizeInstruction(instruction),
  };
}

export function retrieveMemoryCandidates(request,memoryNodes=[],options={}){
  const retrieval=createMemoryRetrievalRequest(request?.question_request||request?.request||request?.question||request,request?.instruction),spec=interpretInstruction(retrieval.instruction),nodes=dedupeNodes(memoryNodes),edges=array(options.memory_edges),limit=Math.min(positiveInteger(options.limit)||defaultLimit(spec),spec.max_results||Infinity),aspectTopK=Math.max(1,Math.min(8,positiveInteger(options.aspect_top_k)||1)),strictFactDiversity=options.strict_fact_diversity===true,terms=searchTerms(spec),semanticScores=normalizeSemanticScores(options.semantic_scores),semanticTopK=Math.max(0,positiveInteger(options.semantic_top_k)||0),byId=new Map(nodes.map(node=>[String(node.memory_id||''),node])),allSemanticRanked=[...semanticScores.entries()].filter(([id,score])=>{const node=byId.get(id);if(!node||!Number.isFinite(score))return false;const text=normalize([node.text,node.source_text].filter(Boolean).join(' ')),matched=terms.filter(term=>text.includes(normalize(term)));return matchesConstraints(node,text,matched,terms,spec,true);}).sort((left,right)=>right[1]-left[1]||left[0].localeCompare(right[0])),semanticRanked=allSemanticRanked.slice(0,semanticTopK),semanticTopIds=new Set(semanticRanked.map(([id])=>id)),semanticRanks=new Map(allSemanticRanked.map(([id],index)=>[id,index+1])),exactTemporalSemantic=spec.has_exact_temporal_scope&&allSemanticRanked.length>0,records=[];
  for(const node of nodes){
    const id=String(node.memory_id||''),rawText=[node.text,node.source_text].filter(Boolean).join(' '),text=normalize(rawText),matched=terms.filter(term=>text.includes(normalize(term))),numbers=numberSet(rawText),semanticScore=semanticScores.get(id),semanticRank=semanticRanks.get(id),semanticEligible=exactTemporalSemantic?Number.isFinite(semanticScore):semanticTopIds.has(id),reasons=[];
    if(!matchesConstraints(node,text,matched,terms,spec,semanticEligible))continue;
    let score=spec.has_hard_constraints?1:0;
    if(spec.has_hard_constraints)reasons.push('instruction_constraint');
    if(matched.length){score+=lexicalMatchScore(matched);reasons.push('instruction_term');}
    const date=canonicalDate(node.event_time),month=date.slice(0,7);
    if(date&&spec.date_keys.has(date)){score+=10;reasons.push('instruction_date');}
    if(month&&spec.month_keys.has(month)){score+=7;reasons.push('instruction_month');}
    const numericMatches=[...spec.numeric_signals].filter(value=>numbers.has(value));
    if(numericMatches.length){score+=6+numericMatches.length;reasons.push('instruction_numeric');}
    const familyWeight=familyScore(node,spec.family_weights);
    if(familyWeight){score+=familyWeight;reasons.push('instruction_family');}
    const lensMatches=spec.lenses.filter(lens=>lens.terms.some(term=>text.includes(normalize(term))));
    if(lensMatches.length){score+=5+lensMatches.length;reasons.push('instruction_lens');}
    if(semanticEligible){score+=4+6*Math.max(0,Math.min(1,semanticScore))+3*(1-(semanticRank-1)/Math.max(1,allSemanticRanked.length));reasons.push('embedding_similarity');}
    if(!reasons.length)continue;
    if(['latest','current'].includes(spec.temporal_operator))score+=recencyScore(node,nodes);
    // For earliest, relevance is primary and event time is the comparator
    // tie-breaker below. A recency-sized bonus here used to let a weak generic
    // precursor outrank the exact event the policy was trying to localize.
    const preferenceScore=temporalPreferenceScore(node,spec);if(preferenceScore){score+=preferenceScore;reasons.push('instruction_time_preference');}
    records.push({node,score:+score.toFixed(3),reasons,matched_terms:matched,numeric_matches:numericMatches,matched_lenses:lensMatches.map(item=>item.id),embedding_similarity:Number.isFinite(semanticScore)?+semanticScore.toFixed(6):null,embedding_rank:semanticRank||null});
  }
  if(isMedLoCoMoCrossAdmissionScope(retrieval.question_request))annotateLiteralAnchors(records,terms);
  const defaultRecordComparator=exactTemporalSemantic?compareExactTemporalSemantic:(left,right)=>right.score-left.score||compareTime(left.node,right.node,spec.temporal_preference||spec.temporal_operator)||String(left.node.memory_id).localeCompare(String(right.node.memory_id)),reranked=typeof options.candidate_reranker==='function'?options.candidate_reranker({question_request:retrieval.question_request,instruction:retrieval.instruction,records:[...records],memory_nodes:nodes,semantic_scores:semanticScores,dense_admission_features:options.dense_admission_features}):null,rerankerTrace=reranked?.trace||{status:'not_configured'};
  if(Array.isArray(reranked?.records)&&reranked.records.length===records.length)records.splice(0,records.length,...reranked.records);
  const pairwiseApplied=rerankerTrace.status==='applied'||rerankerTrace.ranking_applied===true,recordComparator=pairwiseApplied?(left,right)=>Number(left.pairwise_rank||Infinity)-Number(right.pairwise_rank||Infinity)||defaultRecordComparator(left,right):defaultRecordComparator;
  records.sort(recordComparator);
  // latest/current without an explicit calendar scope is a ranking preference,
  // not permission to discard every earlier answer-bearing record. Relevance
  // and payload-bearing matches remain available; exact dates/ranges were
  // already enforced as hard constraints by matchesConstraints above.
  const timeScoped=records,diversity=partitionNearDuplicateRecords(timeScoped,recordComparator),episodeDiversity=options.episode_diversity===true,medLoCoMoCrossAdmission=episodeDiversity&&isMedLoCoMoCrossAdmissionScope(retrieval.question_request),countAllRelevantAdmissions=String(retrieval.question_request.query_type||'')==='frequency_pattern',crossAdmissionSelection=medLoCoMoCrossAdmission?selectMedLoCoMoCrossAdmissionRelevant(diversity,limit,recordComparator,{count_all_relevant_admissions:countAllRelevantAdmissions,admission_shortlist_limit:medLoCoMoAdmissionShortlistLimit(retrieval.question_request,limit,countAllRelevantAdmissions)}):null,selected=crossAdmissionSelection?.records||(episodeDiversity?selectWithEpisodeDiversity(diversity,limit,recordComparator,{strict_fact_diversity:strictFactDiversity}):selectWithDiversityBackfill(diversity,spec,limit,exactTemporalSemantic,recordComparator,{aspect_top_k:aspectTopK,strict_fact_diversity:strictFactDiversity})),expanded=!crossAdmissionSelection&&!exactTemporalSemantic&&spec.expand_graph?expandGraph(selected,nodes,edges,limit):selected,ranked=expanded.map((entry,index)=>({...entry,rank:index+1})),ids=new Set(ranked.map(entry=>String(entry.node.memory_id))),selectedEdges=edges.filter(edge=>ids.has(String(edge.from_memory_id))&&ids.has(String(edge.to_memory_id)));
  return{
    memory_nodes:ranked.map(entry=>entry.node),
    memory_edges:selectedEdges,
    candidates:ranked.map(candidateTrace),
    trace:{version:'careharness-memory-retrieval.worker-v14-aspect-balanced-fact-clusters',memory_pool_size:nodes.length,candidate_count:records.length,near_duplicate_candidate_count:diversity.deferred.length,distinct_fact_candidate_count:diversity.primary.length,fact_clusters:diversity.groups,strict_fact_diversity:strictFactDiversity,aspect_top_k:aspectTopK,candidate_episode_count:new Set(records.map(entry=>String(entry.node?.episode_id||entry.node?.observation_id||entry.node?.memory_id||''))).size,selected_episode_count:new Set(ranked.map(entry=>String(entry.node?.episode_id||entry.node?.observation_id||entry.node?.memory_id||''))).size,episode_diversity:episodeDiversity,selected_memory_count:ranked.length,selected_edge_count:selectedEdges.length,selection_mode:crossAdmissionSelection&&pairwiseApplied?'medlocomo_cross_admission_shortlist_then_turn':episodeDiversity?'episode_diverse_'+(semanticRanked.length?'hybrid_lexical_embedding':'policy_instruction'):exactTemporalSemantic?'exact_temporal_embedding_top_k':semanticRanked.length?'policy_instruction_hybrid_lexical_embedding':'policy_instruction_only',lexical_filter_mode:spec.has_exact_scope?'rank_within_exact_scope':semanticRanked.length?'filter_by_terms_or_embedding_top_k':'filter_by_terms',ranking_primary:crossAdmissionSelection?(pairwiseApplied?'medlocomo_pairwise_admission_shortlist_then_global_turn':'medlocomo_relevance_then_episode_diversity'):pairwiseApplied?'medlocomo_pairwise_admission_then_turn':exactTemporalSemantic?'embedding_similarity':'composite_score',candidate_reranker:rerankerTrace,...(crossAdmissionSelection?{cross_admission_selection:crossAdmissionSelection.trace}:{}),embedding_candidate_count:semanticRanked.length,embedding_scored_scope_count:allSemanticRanked.length,resolved_temporal:spec.resolved_temporal,zero_recall:ranked.length===0,worker_instruction:retrieval.instruction,ranked:ranked.map(candidateTrace)},
  };
}

export function retrieveSessionMemoryAnchors(request,memoryNodes=[],options={}){
  const retrieval=createMemoryRetrievalRequest(request?.question_request||request?.request||request?.question||request,request?.instruction),spec=interpretInstruction(retrieval.instruction),nodes=dedupeNodes(memoryNodes),anchorLimit=positiveInteger(options.anchor_limit)||3,nodeLimit=positiveInteger(options.node_limit)||30,terms=searchTerms(spec),groups=new Map();
  for(const node of nodes){const key=String(node.episode_id||node.observation_id||node.memory_id),group=groups.get(key)||{episode_id:node.episode_id||null,event_time:node.event_time||null,nodes:[]};group.nodes.push(node);if(!group.event_time&&node.event_time)group.event_time=node.event_time;groups.set(key,group);}
  const ranked=[];
  for(const group of groups.values()){
    const qualifying=group.nodes.map(node=>{const text=normalize([node.text,node.source_text].filter(Boolean).join(' ')),matched=terms.filter(term=>text.includes(normalize(term)));return{node,text,matched};}).filter(item=>matchesConstraints(item.node,item.text,item.matched,terms,spec));if(!qualifying.length)continue;
    const matched=unique(qualifying.flatMap(item=>item.matched)),familyWeight=Math.max(0,...qualifying.map(item=>familyScore(item.node,spec.family_weights)));let score=(spec.has_hard_constraints?1:0)+lexicalMatchScore(matched)+familyWeight;
    if(['latest','current'].includes(spec.temporal_operator))score+=recencyScore(group,[...groups.values()]);
    if(spec.temporal_operator==='earliest')score+=earlinessScore(group,[...groups.values()]);
    score+=temporalPreferenceScore(group,spec);
    if(!score)continue;
    ranked.push({...group,score:+score.toFixed(3),matched_terms:matched});
  }
  ranked.sort((left,right)=>right.score-left.score||compareTime(left,right,spec.temporal_preference||spec.temporal_operator));
  const anchors=ranked.slice(0,anchorLimit),selected=[];
  for(const group of anchors)for(const node of group.nodes.sort((left,right)=>compareTime(left,right,spec.temporal_preference||spec.temporal_operator)))if(selected.length<nodeLimit&&!selected.some(item=>item.memory_id===node.memory_id))selected.push(node);
  return{memory_nodes:selected,anchors:anchors.map(group=>({episode_id:group.episode_id,event_time:group.event_time,score:group.score,matched_terms:group.matched_terms,memory_ids:group.nodes.map(node=>node.memory_id)})),trace:{version:'careharness-session-memory-context.worker-v3',candidate_session_count:ranked.length,selected_session_count:anchors.length,selected_memory_count:selected.length,resolved_temporal:spec.resolved_temporal,worker_instruction:retrieval.instruction}};
}

function interpretInstruction(instruction){
  const temporal=plainObject(instruction.temporal),relation=plainObject(instruction.relation);
  const explicitTerms=expandLiteralTerms([...toArray(instruction.search_terms),...toArray(instruction.expansion_terms),...toArray(instruction.required_terms)]),dateKeys=resolveDateKeys(temporal),monthKeys=new Set(unique(temporal.month_keys).map(canonicalMonth).filter(Boolean)),memoryIds=new Set(unique(instruction.memory_ids)),episodeIds=new Set(unique(instruction.episode_ids)),sourceTypes=new Set(unique(instruction.source_types).map(value=>value.toLowerCase()).filter(value=>['patient','doctor','structured'].includes(value))),requiredFamilies=normalizeFamilies(instruction.required_families),hasExactScope=Boolean(dateKeys.size||memoryIds.size||episodeIds.size),hasTemporalScope=Boolean(monthKeys.size||canonicalDate(temporal.start_date)||canonicalDate(temporal.end_date)),hasStructuralSelectors=Boolean(hasExactScope||hasTemporalScope||sourceTypes.size||requiredFamilies.length),temporalPreference=['earliest','latest'].includes(String(temporal.prefer||'').toLowerCase())?String(temporal.prefer).toLowerCase():'';
  return{
    terms:explicitTerms.length?explicitTerms:hasExactScope?[]:objectiveTerms(instruction.objective),
    required_terms:unique(instruction.required_terms),
    excluded_terms:unique(instruction.excluded_terms),
    term_match:String(instruction.term_match||'any').toLowerCase()==='all'?'all':'any',
    memory_ids:memoryIds,
    episode_ids:episodeIds,
    source_types:sourceTypes,
    required_families:requiredFamilies,
    family_match:String(instruction.family_match||'any').toLowerCase()==='all'?'all':'any',
    family_weights:normalizeFamilyWeights(instruction.family_weights),
    temporal_operator:String(temporal.operator||'none').toLowerCase(),
    temporal_preference:temporalPreference,
    date_keys:dateKeys,
    month_keys:monthKeys,
    start_date:canonicalDate(temporal.start_date),
    end_date:canonicalDate(temporal.end_date),
    resolved_temporal:{operator:String(temporal.operator||'none').toLowerCase(),date_keys:[...dateKeys],month_keys:[...monthKeys],start_date:canonicalDate(temporal.start_date)||null,end_date:canonicalDate(temporal.end_date)||null,...(temporalPreference?{prefer:temporalPreference}:{})},
    // The Action Policy's objective is part of its executable direction. Keep
    // numeric literals copied into that objective as soft ranking anchors even
    // when broad explicit search terms are also present; otherwise a baseline
    // value named by the Policy is silently ignored by the worker.
    numeric_signals:new Set([...unique(instruction.numeric_signals).map(value=>String(Number(value))).filter(value=>value!=='NaN'),...numberSet(instruction.objective)]),
    lenses:normalizeLenses(instruction.lenses),
    expand_graph:instruction.expand_graph===true||relation.expand_graph===true,
    max_results:positiveInteger(instruction.max_results),
    has_hard_constraints:hasStructuralSelectors,
    has_exact_scope:hasExactScope,
    has_exact_temporal_scope:dateKeys.size>0,
  };
}

function normalizeInstruction(value){
  if(value==null)return{};
  if(typeof value==='string')return{objective:bounded(value,500)};
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('retrieval worker instruction must be an object or string');
  const serialized=JSON.stringify(value);if(serialized.length>4000)throw new Error('retrieval worker instruction exceeds bounded size');
  const normalized=JSON.parse(serialized);
  if(normalized.temporal&&typeof normalized.temporal==='object'&&!Array.isArray(normalized.temporal))normalized.temporal=normalizeTemporalInstruction(normalized.temporal);
  return normalized;
}

function normalizeTemporalInstruction(value){
  const temporal={...value},rawDateKeys=unique(temporal.date_keys),dateKeys=rawDateKeys.map(canonicalDate).filter(Boolean),inferredMonthKeys=rawDateKeys.map(canonicalMonthOnly).filter(Boolean),monthKeys=unique([...toArray(temporal.month_keys),...inferredMonthKeys]).map(canonicalMonth).filter(Boolean);
  if(rawDateKeys.length){if(dateKeys.length)temporal.date_keys=dateKeys;else delete temporal.date_keys;}
  if(monthKeys.length)temporal.month_keys=[...new Set(monthKeys)];else if(Object.hasOwn(temporal,'month_keys'))delete temporal.month_keys;
  if(inferredMonthKeys.length&&!dateKeys.length&&String(temporal.operator||'').toLowerCase()==='exact')temporal.operator='range';
  return temporal;
}

function normalizeFamilyWeights(value){const out=[],seen=new Set();for(const raw of array(value)){const family=String(typeof raw==='string'?raw:raw?.family||'').toUpperCase();if(!MEMORY_FAMILIES.includes(family)||seen.has(family))continue;seen.add(family);const weight=typeof raw==='string'?1:Number(raw.weight??raw.priority??1);out.push({family,weight:Number.isFinite(weight)?Math.max(0,Math.min(8,weight)):1});}return out;}
function normalizeFamilies(value){return unique(value).map(item=>item.toUpperCase()).filter(item=>MEMORY_FAMILIES.includes(item));}
function normalizeLenses(value){return array(value).slice(0,24).map((item,index)=>typeof item==='string'?{id:`lens_${index+1}`,terms:objectiveTerms(item)}:{id:String(item?.id||`lens_${index+1}`),terms:unique([...toArray(item?.terms),...objectiveTerms(item?.objective)])}).filter(item=>item.terms.length);}
function objectiveTerms(value){const text=bounded(value,500),chunks=text.match(/[\p{Script=Han}]{2,}|[A-Za-z][A-Za-z0-9+.-]{1,}|\d+(?:\.\d+)?(?:\s*[-–~至]\s*\d+(?:\.\d+)?)?\s*(?:mmol\/L|mg|kg|%|U\/mL|pmol\/L|次|分钟|小时|天)?/gu)||[],terms=[];for(const chunk of chunks){terms.push(chunk,...decimalIntegerTerms(chunk));if(/[\p{Script=Han}]/u.test(chunk)&&chunk.length>=4)for(let size=Math.min(6,chunk.length-1);size>=2;size--)for(let index=0;index<=chunk.length-size;index++)terms.push(chunk.slice(index,index+size));}return unique(terms).filter(term=>!STOP_TERMS.has(term)&&normalize(term).length>=2).slice(0,80);}
function expandLiteralTerms(value){const originals=unique(value),expanded=[];for(const term of originals){expanded.push(term,...decimalIntegerTerms(term));for(const piece of String(term).split(/[\s,，;；|/]+/u)){const clean=piece.trim();if(normalize(clean).length>=2&&!STOP_TERMS.has(clean))expanded.push(clean,...decimalIntegerTerms(clean));}if(expanded.length>=160)break;}return unique(expanded).slice(0,160);}
function decimalIntegerTerms(value){const terms=[];for(const match of String(value||'').matchAll(/(?<!\d)(\d+)\.\d+(?!\d)/gu))if(match[1].length>=2)terms.push(match[1]);return terms;}
function lexicalMatchScore(value){const entries=unique(value).map(term=>({term,key:normalize(term),score:Math.min(5,1+normalize(term).length/3)})).filter(item=>item.key),groups=[];for(const entry of entries){const linked=[];for(let index=0;index<groups.length;index++)if(groups[index].some(item=>item.key.includes(entry.key)||entry.key.includes(item.key)))linked.push(index);if(!linked.length){groups.push([entry]);continue;}const merged=[entry];for(const index of linked.reverse())merged.push(...groups.splice(index,1)[0]);groups.push(merged);}return groups.reduce((sum,group)=>sum+group.reduce((groupSum,item)=>groupSum+item.score,0)/group.length,0);}
const STOP_TERMS=new Set(['医生','患者','什么','怎么','为什么','是否','需要','可以','应该','目前','现在','最近','一下','这个','那个','情况','问题','查找','调查','确认','寻找','相关']);
function searchTerms(spec){return spec.terms.filter(term=>normalize(term).length>=2);}
function matchesConstraints(node,text,matched,terms,spec,semanticEligible=false){
  const id=String(node.memory_id||''),episode=String(node.episode_id||''),sources=attributedSourceTypes(node,text),families=array(node.families),date=canonicalDate(node.event_time),month=date.slice(0,7);
  if(spec.memory_ids.size&&!spec.memory_ids.has(id))return false;
  if(spec.episode_ids.size&&!spec.episode_ids.has(episode))return false;
  if(spec.source_types.size&&![...spec.source_types].some(source=>sources.has(source)))return false;
  if(spec.required_families.length){const hits=spec.required_families.filter(family=>families.includes(family));if(spec.family_match==='all'?hits.length!==spec.required_families.length:hits.length===0)return false;}
  if(spec.date_keys.size&&!spec.date_keys.has(date))return false;
  if(spec.month_keys.size&&!spec.month_keys.has(month))return false;
  if(spec.start_date&&(!date||date<spec.start_date))return false;
  if(spec.end_date&&(!date||date>spec.end_date))return false;
  if(spec.excluded_terms.some(term=>text.includes(normalize(term))))return false;
  if(spec.required_terms.some(term=>!text.includes(normalize(term))))return false;
  // One exact date, Session, or explicit Memory ID defines a narrow candidate
  // set in which ordinary terms may rank synonymous wording. A month or date
  // range is still broad and therefore keeps lexical filtering enabled. Source
  // role and Memory family are broad facets too: none of these broad facets may
  // crowd the requested fact out with an almost whole-graph candidate set.
  if(!spec.has_exact_scope&&terms.length&&!semanticEligible&&(spec.term_match==='all'?matched.length!==terms.length:matched.length===0))return false;
  return true;
}

function attributedSourceTypes(node,normalizedText){
  const source=String(node.source_type||'').toLowerCase(),types=new Set(source?[source]:[]),text=normalizedText||normalize([node.text,node.source_text].filter(Boolean).join(' '));
  if(source==='structured'){
    if(text.startsWith('患者')||text.includes('患者自述')||text.includes('患者表示')||text.includes('患者报告'))types.add('patient');
    if(text.startsWith('医生')||text.includes('医生向患者')||text.includes('医生告知')||text.includes('医生建议'))types.add('doctor');
  }
  return types;
}
function familyScore(node,weights){let best=0;for(const item of weights)if(array(node.families).includes(item.family))best=Math.max(best,item.weight);return best;}
function compareExactTemporalSemantic(left,right){
  const leftSimilarity=Number.isFinite(left.embedding_similarity)?left.embedding_similarity:-Infinity,rightSimilarity=Number.isFinite(right.embedding_similarity)?right.embedding_similarity:-Infinity;
  return rightSimilarity-leftSimilarity||right.score-left.score||String(left.node.memory_id).localeCompare(String(right.node.memory_id));
}
function partitionNearDuplicateRecords(records,comparator){
  const groups=[];
  for(const record of records){const group=groups.find(items=>items.some(item=>obviousNearDuplicateFact(item.node,record.node)));if(group)group.push(record);else groups.push([record]);}
  const primary=[],deferred=[],clusterRows=[];
  for(const group of groups){
    const representative=[...group].sort(compareDuplicateRepresentative)[0];primary.push(representative);
    deferred.push(...group.filter(item=>item!==representative));
    clusterRows.push({representative_memory_id:String(representative.node.memory_id),source_memory_ids:group.map(item=>String(item.node.memory_id)),source_refs:group.map(item=>`memory:${String(item.node.memory_id)}`),episode_ids:[...new Set(group.map(item=>episodeKey(item.node)))]});
  }
  primary.sort(comparator);deferred.sort(comparator);
  return{primary,deferred,groups:clusterRows};
}
function selectWithDiversityBackfill(partition,spec,limit,exactTemporalSemantic,comparator,options={}){
  const primary=exactTemporalSemantic?partition.primary.slice(0,limit):balancedSelect(partition.primary,spec,limit,options.aspect_top_k),selected=[...primary],seen=new Set(selected.map(item=>String(item.node.memory_id)));
  if(options.strict_fact_diversity!==true&&selected.length<limit)for(const record of partition.deferred){const id=String(record.node.memory_id);if(!seen.has(id)){seen.add(id);selected.push(record);if(selected.length>=limit)break;}}
  return exactTemporalSemantic?selected.sort(comparator):selected;
}
function selectWithEpisodeDiversity(partition,limit,comparator,options={}){
  const ranked=[...partition.primary,...(options.strict_fact_diversity===true?[]:partition.deferred)].sort(comparator),groups=new Map();
  for(const record of ranked){const key=String(record.node?.episode_id||record.node?.observation_id||record.node?.memory_id||''),values=groups.get(key)||[];values.push(record);groups.set(key,values);}
  const ordered=[...groups.values()].sort((left,right)=>comparator(left[0],right[0])),selected=[];
  // Round-robin selection prevents repeated summaries from one Admission from
  // exhausting the packet before another matching Admission is represented.
  for(let depth=0;selected.length<limit&&ordered.some(values=>depth<values.length);depth++)for(const values of ordered){if(values[depth])selected.push(values[depth]);if(selected.length>=limit)break;}
  return selected;
}
function selectMedLoCoMoCrossAdmissionRelevant(partition,limit,recordComparator,options={}){
  const decorated=partition.primary.map(record=>({record,duplicate_tier:0})),groups=new Map();
  for(const item of decorated){const episode=episodeKey(item.record.node),values=groups.get(episode)||[];values.push(item);groups.set(episode,values);}
  const allRecords=decorated.map(item=>item.record),semanticFrontier=Math.max(1,Math.min(allRecords.length,Math.max(4,Math.ceil(limit/2)))),orderedAdmissions=[...groups.entries()].map(([episode,values])=>{
    const byTurn=new Map();for(const item of values){const key=turnKey(item.record.node),items=byTurn.get(key)||[];items.push(item);byTurn.set(key,items);}
    const turnCandidates=[],duplicates=[];for(const items of byTurn.values()){items.sort(compareCrossAdmissionTurnCandidate);turnCandidates.push(items[0]);duplicates.push(...items.slice(1));}
    turnCandidates.sort(compareCrossAdmissionTurnCandidate);duplicates.sort(compareCrossAdmissionTurnCandidate);
    const directlyRelevant=values.some(item=>recordHasDirectRelevance(item.record)),semanticRelevant=values.some(item=>Number(item.record.embedding_rank)>0&&Number(item.record.embedding_rank)<=semanticFrontier),literalAnchorCount=values.filter(item=>item.record.literal_anchor===true).length;
    return{episode,turn_candidates:turnCandidates,duplicates,directly_relevant:directlyRelevant,semantic_relevant:semanticRelevant,literal_anchor_count:literalAnchorCount,admission_rank:minimumFinite(values.map(item=>item.record.pairwise_admission_rank)),admission_score:maximumFinite(values.map(item=>item.record.pairwise_admission_score)),best_score:maximumFinite(values.map(item=>item.record.score)),first_index:Math.min(...values.map(item=>Number(item.record.pairwise_original_index)||0))};
  }).sort(compareCrossAdmissionShortlist),relevantAdmissions=orderedAdmissions.filter(item=>item.directly_relevant||item.semantic_relevant||item.literal_anchor_count>0).sort(compareRelevantAdmission),fallbackCount=Math.max(1,Math.min(orderedAdmissions.length,Math.ceil(Math.sqrt(orderedAdmissions.length)))),eligible=relevantAdmissions.length?relevantAdmissions:orderedAdmissions.slice(0,fallbackCount),shortlistTarget=positiveInteger(options.admission_shortlist_limit)||(options.count_all_relevant_admissions===true?Math.max(4,Math.ceil(limit/3)):Math.max(2,Math.ceil(Math.sqrt(limit)))),shortlistLimit=Math.min(eligible.length,shortlistTarget),shortlist=eligible.slice(0,shortlistLimit),selected=[],seen=new Set(),add=item=>{const record=item?.record,id=String(record?.node?.memory_id||''),literalDuplicate=record&&selected.some(chosen=>(chosen.literal_anchor===true||record.literal_anchor===true)&&obviousNearDuplicateFact(chosen.node,record.node));if(id&&!seen.has(id)&&!literalDuplicate&&selected.length<limit){seen.add(id);selected.push(record);}};
  // Exact source-literal matches are evidence anchors, not just another State
  // for the learned reranker to discard.  Select at most one anchor for each
  // source Turn before applying Admission diversity.
  const literalByTurn=new Map();
  for(const item of shortlist.flatMap(admission=>[...admission.turn_candidates,...admission.duplicates]).filter(item=>item.record.literal_anchor===true)){
    const key=turnKey(item.record.node),prior=literalByTurn.get(key);if(!prior||compareLiteralAnchor(item,prior)<0)literalByTurn.set(key,item);
  }
  for(const item of[...literalByTurn.values()].sort(compareLiteralAnchor))add(item);
  // Diversity is now a tie-breaker inside the relevance-qualified Admission
  // set. An Admission with only a low-ranked embedding candidate no longer
  // receives an unconditional slot at the expense of a direct match.
  for(const admission of shortlist)add(admission.turn_candidates[0]);
  const remaining=shortlist.flatMap(admission=>admission.turn_candidates).filter(item=>!seen.has(String(item.record?.node?.memory_id||''))).sort((left,right)=>compareRelevanceBeforePairwise(left.record,right.record)||compareCrossAdmissionTurnCandidate(left,right)||recordComparator(left.record,right.record));
  for(const item of remaining)add(item);
  return{records:selected,trace:{version:'medlocomo-cross-admission-selection.v3-distilled-admission-budget',scope:'cross_admission',candidate_admission_count:orderedAdmissions.length,relevant_candidate_count:allRecords.filter(record=>recordHasDirectRelevance(record)||Number(record.embedding_rank)>0&&Number(record.embedding_rank)<=semanticFrontier).length,relevant_admission_count:relevantAdmissions.length,semantic_frontier_rank:semanticFrontier,admission_shortlist_target:shortlistTarget,admission_shortlist_limit:shortlistLimit,shortlisted_admission_count:shortlist.length,shortlisted_admission_ranks:shortlist.map(item=>item.admission_rank),one_turn_quota_per_admission:true,one_turn_quota_scope:'relevance_qualified_admissions_only',count_all_relevant_admissions:options.count_all_relevant_admissions===true,protected_literal_anchor_count:selected.filter(record=>record.literal_anchor===true).length,remaining_fill:'global_relevance_then_pairwise_turn_within_shortlist',near_duplicate_backfill:false,unique_turns_before_duplicate_states:true,selected_admission_count:new Set(selected.map(item=>episodeKey(item.node))).size,selected_memory_count:selected.length}};
}
function medLoCoMoAdmissionShortlistLimit(questionRequest,limit,countAllRelevantAdmissions){
  const learned=positiveInteger(questionRequest?.strategy_profile?.evidence_admission_p90);
  if(learned)return Math.min(limit,countAllRelevantAdmissions?Math.max(learned,Math.ceil(learned*4/3)):Math.max(2,Math.min(Math.ceil(limit/2),learned*2)));
  return Math.min(limit,countAllRelevantAdmissions?Math.max(4,Math.ceil(limit/3)):Math.max(2,Math.ceil(Math.sqrt(limit))));
}
function compareCrossAdmissionShortlist(left,right){return compareFiniteAscending(left.admission_rank,right.admission_rank)||compareFiniteDescending(left.admission_score,right.admission_score)||left.first_index-right.first_index||left.episode.localeCompare(right.episode);}
function compareRelevantAdmission(left,right){return compareFiniteDescending(left.literal_anchor_count,right.literal_anchor_count)||Number(right.directly_relevant)-Number(left.directly_relevant)||Number(right.semantic_relevant)-Number(left.semantic_relevant)||compareFiniteDescending(left.best_score,right.best_score)||compareCrossAdmissionShortlist(left,right);}
function compareCrossAdmissionTurnCandidate(left,right){return compareFiniteAscending(left.record.pairwise_turn_rank,right.record.pairwise_turn_rank)||compareFiniteDescending(left.record.pairwise_turn_score,right.record.pairwise_turn_score)||left.duplicate_tier-right.duplicate_tier||compareFiniteDescending(left.record.score,right.record.score)||Number(left.record.pairwise_original_index||0)-Number(right.record.pairwise_original_index||0);}
function compareLiteralAnchor(left,right){return compareFiniteDescending(left.record.literal_anchor_strength,right.record.literal_anchor_strength)||compareRelevanceBeforePairwise(left.record,right.record)||compareCrossAdmissionTurnCandidate(left,right);}
function compareRelevanceBeforePairwise(left,right){return compareFiniteDescending(relevanceTier(left),relevanceTier(right))||compareFiniteDescending(left.literal_anchor_strength,right.literal_anchor_strength)||compareFiniteDescending(left.score,right.score);}
function relevanceTier(record){if(record?.literal_anchor===true)return 4;if(array(record?.numeric_matches).length)return 3;if(array(record?.matched_terms).length)return 2;if(array(record?.matched_lenses).length)return 1;return 0;}
function recordHasDirectRelevance(record){return relevanceTier(record)>0;}
function compareFiniteAscending(left,right){const a=Number(left),b=Number(right),safeA=Number.isFinite(a)?a:Infinity,safeB=Number.isFinite(b)?b:Infinity;return safeA===safeB?0:safeA<safeB?-1:1;}
function compareFiniteDescending(left,right){const a=Number(left),b=Number(right),safeA=Number.isFinite(a)?a:-Infinity,safeB=Number.isFinite(b)?b:-Infinity;return safeA===safeB?0:safeA>safeB?-1:1;}
function minimumFinite(values){const finite=values.map(Number).filter(Number.isFinite);return finite.length?Math.min(...finite):Infinity;}
function maximumFinite(values){const finite=values.map(Number).filter(Number.isFinite);return finite.length?Math.max(...finite):-Infinity;}
function episodeKey(node){return String(node?.episode_id||node?.observation_id||node?.memory_id||'');}
function turnKey(node){return`${episodeKey(node)}\u0000${String(node?.turn_id||node?.memory_id||'')}`;}
function annotateLiteralAnchors(records,terms){
  const episodes=new Set(records.map(record=>episodeKey(record.node))),turns=new Set(records.map(record=>turnKey(record.node))),episodeFrequency=new Map(),turnFrequency=new Map();
  for(const term of terms){const key=normalize(term);if(!key)continue;const matching=records.filter(record=>array(record.matched_terms).some(value=>normalize(value)===key));episodeFrequency.set(key,new Set(matching.map(record=>episodeKey(record.node))).size);turnFrequency.set(key,new Set(matching.map(record=>turnKey(record.node))).size);}
  const rareEpisodeLimit=Math.max(2,Math.ceil(episodes.size*.25)),rareTurnLimit=Math.max(2,Math.ceil(turns.size*.1));
  for(const record of records){
    if(!isLiteralProvenanceNode(record.node)){record.literal_anchor=false;record.literal_anchor_strength=0;continue;}
    const strong=array(record.matched_terms).map(term=>({term,key:normalize(term),episode_frequency:episodeFrequency.get(normalize(term))||Infinity,turn_frequency:turnFrequency.get(normalize(term))||Infinity})).filter(item=>isSpecificLiteralTerm(item.term,item.key)&&item.episode_frequency<=rareEpisodeLimit&&item.turn_frequency<=rareTurnLimit);
    record.literal_anchor=strong.length>0;
    record.literal_anchor_strength=record.literal_anchor?Math.max(...strong.map(item=>Math.min(12,item.key.length)+1/Math.max(1,item.episode_frequency)+1/Math.max(1,item.turn_frequency))):0;
    if(record.literal_anchor&&!record.reasons.includes('protected_literal_anchor'))record.reasons.push('protected_literal_anchor');
  }
}
function isLiteralProvenanceNode(node){return String(node?.construction_kind||'')==='literal_provenance'||String(node?.memory_id||'').includes(':source-turn:')||node?.literal_provenance===true;}
function isSpecificLiteralTerm(term,key=normalize(term)){return key.length>=4&&(/[\d+]/u.test(key)||/[.\-_/]/u.test(String(term||''))||/[A-Z].*[A-Z]/u.test(String(term||''))||key.length>=6);}
function compareDuplicateRepresentative(left,right){
  const leftQuality=duplicateRepresentativeQuality(left),rightQuality=duplicateRepresentativeQuality(right);
  for(let index=0;index<leftQuality.length;index++)if(leftQuality[index]!==rightQuality[index])return rightQuality[index]-leftQuality[index];
  return String(left.node.memory_id).localeCompare(String(right.node.memory_id));
}
function duplicateRepresentativeQuality(entry){
  const source=String(entry?.node?.source_text||''),literalProtected=(source.match(/\d+(?:\.\d+)?|%|mmol\/?L|mg\/?dL|mg|kg|mmHg|bpm|单位|毫克|千克|分钟|小时/giu)||[]).length,similarity=Number.isFinite(entry.embedding_similarity)?entry.embedding_similarity:-1,literalCompleteness=(source?2:0)+Math.min(3,literalProtected)*.5+Math.min(360,normalize(source||entry?.node?.text).length)/1000,combined=(Number(entry.score)||0)+literalCompleteness;
  return[entry.literal_anchor===true?1:0,Number(entry.literal_anchor_strength)||0,(entry.numeric_matches||[]).length,(entry.matched_terms||[]).length,(entry.matched_lenses||[]).length,combined,similarity,literalCompleteness];
}
function obviousNearDuplicateFact(left,right){
  const leftSession=String(left?.episode_id||left?.observation_id||''),rightSession=String(right?.episode_id||right?.observation_id||'');
  if(String(left?.subject_id||'')!==String(right?.subject_id||'')||!leftSession||leftSession!==rightSession||!compatibleSourceRole(left,right)||retrievalPolarity(left)!==retrievalPolarity(right)||retrievalQuantitiesConflict(left,right))return false;
  const leftTexts=retrievalFactTexts(left),rightTexts=retrievalFactTexts(right);let best=0;
  for(const a of leftTexts)for(const b of rightTexts){
    if(a===b)return true;
    const shorter=Math.min(a.length,b.length),longer=Math.max(a.length,b.length);
    if(shorter>=10&&(a.includes(b)||b.includes(a))&&shorter/Math.max(1,longer)>=.72)return true;
    best=Math.max(best,textGramSimilarity(a,b));
  }
  return best>=.86;
}
function compatibleSourceRole(left,right){const a=retrievalRole(left),b=retrievalRole(right);return!a||!b||a===b;}
function retrievalRole(node){const source=String(node?.source_type||'').toLowerCase();if(['patient','doctor'].includes(source))return source;const text=String(node?.text||'');if(/^\s*患者/u.test(text))return'patient';if(/^\s*医生/u.test(text))return'doctor';return'';}
function retrievalPolarity(node){const text=[node?.text,node?.source_text].filter(Boolean).join(' ');if(String(node?.polarity)==='negated'||/(?:没有|并无|尚无|未见|否认|不再|没再|无明显|无任何)/u.test(text))return'negated';if(String(node?.polarity)==='uncertain'||/(?:可能|也许|似乎|不确定)/u.test(text))return'uncertain';return'affirmed';}
function retrievalFactTexts(node){return[node?.text,node?.source_text].filter(Boolean).map(value=>normalize(String(value).replace(/^(?:患者|医生)(?:原话|陈述|报告|建议|解释|评估|认为)?[：:]?/u,'').replace(/^(?:我|本人|该患者)/u,''))).filter(Boolean);}
function retrievalQuantitiesConflict(left,right){const a=retrievalQuantitySignature(left),b=retrievalQuantitySignature(right);return a.size>0&&b.size>0&&(a.size!==b.size||[...a].some(value=>!b.has(value)));}
function retrievalQuantitySignature(node){const values=new Set();for(const text of[node?.text,node?.source_text])for(const match of String(text||'').normalize('NFKC').matchAll(/[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:\s*[-–~至]\s*\d+(?:\.\d+)?)?\s*(?:%|mmol\/?l|mg\/?dl|mg|mcg|g|kg|ml|l|mmhg|bpm|iu|u|单位|毫克|微克|克|千克|毫升|升|次|分钟|小时|天)?/giu))values.add(match[0].replace(/\s+/gu,'').toLowerCase().replace(/[~至–]/gu,'-'));return values;}
function textGramSimilarity(left,right){const a=new Set(characterGrams(left,2)),b=new Set(characterGrams(right,2));if(!a.size||!b.size)return 0;let hits=0;for(const gram of a)if(b.has(gram))hits++;return hits/Math.max(a.size,b.size);}
function characterGrams(value,size){const out=[];for(let index=0;index<=value.length-size;index++)out.push(value.slice(index,index+size));return out;}
function balancedSelect(records,spec,limit,aspectTopK=1){const selected=[],seen=new Set(),add=record=>{const id=String(record?.node?.memory_id||'');if(id&&!seen.has(id)&&selected.length<limit){seen.add(id);selected.push(record);}};for(const lens of spec.lenses)for(const record of records.filter(item=>item.matched_lenses.includes(lens.id)).slice(0,Math.max(1,Number(aspectTopK)||1)))add(record);for(const family of [...spec.family_weights].sort((a,b)=>b.weight-a.weight))add(records.find(record=>array(record.node.families).includes(family.family)));for(const record of records)add(record);return selected;}
function expandGraph(selected,nodes,edges,limit){const out=[...selected],deferred=[],byId=new Map(nodes.map(node=>[String(node.memory_id),node])),seen=new Set(out.map(entry=>String(entry.node.memory_id))),frontier=[...seen];for(let depth=0;depth<2&&frontier.length&&out.length<limit;depth++){const next=[];for(const id of frontier)for(const edge of edges){const neighbor=String(edge.from_memory_id)===id?String(edge.to_memory_id):String(edge.to_memory_id)===id?String(edge.from_memory_id):null;if(!neighbor||seen.has(neighbor)||!byId.has(neighbor))continue;seen.add(neighbor);next.push(neighbor);const entry={node:byId.get(neighbor),score:Math.max(0,4-depth),reasons:['memory_graph_neighbor'],matched_terms:[],numeric_matches:[],matched_lenses:[],expanded_from:id};if(out.some(current=>obviousNearDuplicateFact(current.node,entry.node)))deferred.push(entry);else out.push(entry);if(out.length>=limit)break;}frontier.splice(0,frontier.length,...next);}for(const entry of deferred)if(out.length<limit)out.push(entry);return out;}
function candidateTrace(entry){return{memory_id:entry.node.memory_id,episode_id:entry.node.episode_id||null,event_time:entry.node.event_time||null,families:entry.node.families||[],score:entry.score,reasons:entry.reasons,matched_terms:entry.matched_terms||[],numeric_matches:entry.numeric_matches||[],matched_lenses:entry.matched_lenses||[],literal_anchor:entry.literal_anchor===true,literal_anchor_strength:Number(entry.literal_anchor_strength)||0,embedding_similarity:entry.embedding_similarity??null,embedding_rank:entry.embedding_rank??null,...(Number.isFinite(entry.pairwise_admission_score)?{pairwise_admission_score:+entry.pairwise_admission_score.toFixed(6),pairwise_admission_rank:entry.pairwise_admission_rank,pairwise_turn_score:+entry.pairwise_turn_score.toFixed(6),pairwise_turn_rank:entry.pairwise_turn_rank,pairwise_turn_rank_within_admission:entry.pairwise_turn_rank_within_admission,pairwise_rank:entry.pairwise_rank}:{}),expanded_from:entry.expanded_from||null,rank:entry.rank||null};}
function normalizeSemanticScores(value){if(value instanceof Map)return new Map([...value].map(([id,score])=>[String(id),Number(score)]));if(!value||typeof value!=='object'||Array.isArray(value))return new Map();return new Map(Object.entries(value).map(([id,score])=>[String(id),Number(score)]));}
function recencyScore(node,nodes){const values=nodes.map(item=>Date.parse(item.event_time||'')).filter(Number.isFinite),time=Date.parse(node.event_time||'');return values.length&&Number.isFinite(time)?4*Math.max(0,(time-Math.min(...values))/Math.max(1,Math.max(...values)-Math.min(...values))):0;}
function earlinessScore(node,nodes){const values=nodes.map(item=>Date.parse(item.event_time||'')).filter(Number.isFinite),time=Date.parse(node.event_time||'');return values.length&&Number.isFinite(time)?4*Math.max(0,(Math.max(...values)-time)/Math.max(1,Math.max(...values)-Math.min(...values))):0;}
function temporalPreferenceScore(node,spec){
  if(!spec.temporal_preference||!spec.start_date||!spec.end_date||spec.start_date===spec.end_date)return 0;
  const time=Date.parse(node?.event_time||''),start=Date.parse(`${spec.start_date}T00:00:00.000Z`),end=Date.parse(`${spec.end_date}T00:00:00.000Z`);if(!Number.isFinite(time)||!Number.isFinite(start)||!Number.isFinite(end)||end<=start)return 0;
  const progress=Math.max(0,Math.min(1,(time-start)/(end-start)));return 4*(spec.temporal_preference==='earliest'?1-progress:progress);
}
function compareTime(left,right,operator){const a=Date.parse(left?.event_time||''),b=Date.parse(right?.event_time||'');if(!Number.isFinite(a)||!Number.isFinite(b)||a===b)return 0;return operator==='earliest'?a-b:b-a;}
function canonicalMonth(value){const match=/^(?<year>\d{4})[-/.年](?<month>\d{1,2})/u.exec(String(value||'').normalize('NFKC').trim());return match?canonicalMonthOnly(`${match.groups.year}-${match.groups.month}`):'';}
function resolveDateKeys(temporal){const dates=new Set(unique(temporal.date_keys).map(canonicalDate).filter(Boolean)),base=canonicalDate(temporal.base_date),offset=Number(temporal.offset_days??0);if(base&&Number.isInteger(offset)&&Math.abs(offset)<=3660){const value=new Date(`${base}T00:00:00.000Z`);value.setUTCDate(value.getUTCDate()+offset);dates.add(value.toISOString().slice(0,10));}return dates;}
function numberSet(value){return new Set((String(value||'').match(/\d+(?:\.\d+)?/g)||[]).map(item=>String(Number(item))));}
function defaultLimit(spec){return spec.expand_graph?42:spec.lenses.length?36:28;}
function dedupeNodes(nodes){const out=[],seen=new Set();for(const node of array(nodes)){const id=String(node?.memory_id||'');if(!id||seen.has(id))continue;seen.add(id);out.push(node);}return out;}
function isMedLoCoMoCrossAdmissionScope(request){return String(request?.strategy_namespace||'')==='medlocomo'&&String(request?.scope||'')==='cross_admission';}
function unique(values){return[...new Set(toArray(values).map(value=>String(value||'').normalize('NFKC').trim()).filter(Boolean))];}
function toArray(value){return Array.isArray(value)?value:value==null?[]:[value];}
function array(value){return Array.isArray(value)?value:[];}
function plainObject(value){return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}
function positiveInteger(value){const number=Number(value);return Number.isInteger(number)&&number>0?number:null;}
function bounded(value,limit){return String(value||'').normalize('NFKC').trim().slice(0,limit);}
function normalize(value){return String(value||'').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu,'');}
