import { MEMORY_FAMILIES } from './schema.js';
import { createQuestionRequest } from './investigation-contract.js';

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
  const retrieval=createMemoryRetrievalRequest(request?.question_request||request?.request||request?.question||request,request?.instruction),spec=interpretInstruction(retrieval.instruction),nodes=dedupeNodes(memoryNodes),edges=array(options.memory_edges),limit=Math.min(positiveInteger(options.limit)||defaultLimit(spec),spec.max_results||Infinity),terms=searchTerms(spec),semanticScores=normalizeSemanticScores(options.semantic_scores),semanticTopK=Math.max(0,positiveInteger(options.semantic_top_k)||0),byId=new Map(nodes.map(node=>[String(node.memory_id||''),node])),allSemanticRanked=[...semanticScores.entries()].filter(([id,score])=>{const node=byId.get(id);if(!node||!Number.isFinite(score))return false;const text=normalize([node.text,node.source_text].filter(Boolean).join(' ')),matched=terms.filter(term=>text.includes(normalize(term)));return matchesConstraints(node,text,matched,terms,spec,true);}).sort((left,right)=>right[1]-left[1]||left[0].localeCompare(right[0])),semanticRanked=allSemanticRanked.slice(0,semanticTopK),semanticTopIds=new Set(semanticRanked.map(([id])=>id)),semanticRanks=new Map(allSemanticRanked.map(([id],index)=>[id,index+1])),exactTemporalSemantic=spec.has_exact_temporal_scope&&allSemanticRanked.length>0,records=[];
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
  const recordComparator=exactTemporalSemantic?compareExactTemporalSemantic:(left,right)=>right.score-left.score||compareTime(left.node,right.node,spec.temporal_preference||spec.temporal_operator)||String(left.node.memory_id).localeCompare(String(right.node.memory_id));
  records.sort(recordComparator);
  // latest/current without an explicit calendar scope is a ranking preference,
  // not permission to discard every earlier answer-bearing record. Relevance
  // and payload-bearing matches remain available; exact dates/ranges were
  // already enforced as hard constraints by matchesConstraints above.
  const timeScoped=records,diversity=partitionNearDuplicateRecords(timeScoped,recordComparator),selected=selectWithDiversityBackfill(diversity,spec,limit,exactTemporalSemantic,recordComparator),expanded=!exactTemporalSemantic&&spec.expand_graph?expandGraph(selected,nodes,edges,limit):selected,ranked=expanded.map((entry,index)=>({...entry,rank:index+1})),ids=new Set(ranked.map(entry=>String(entry.node.memory_id))),selectedEdges=edges.filter(edge=>ids.has(String(edge.from_memory_id))&&ids.has(String(edge.to_memory_id)));
  return{
    memory_nodes:ranked.map(entry=>entry.node),
    memory_edges:selectedEdges,
    candidates:ranked.map(candidateTrace),
    trace:{version:'careharness-memory-retrieval.worker-v9-objective-literal-anchors',memory_pool_size:nodes.length,candidate_count:records.length,near_duplicate_candidate_count:diversity.deferred.length,distinct_fact_candidate_count:diversity.primary.length,selected_memory_count:ranked.length,selected_edge_count:selectedEdges.length,selection_mode:exactTemporalSemantic?'exact_temporal_embedding_top_k':semanticRanked.length?'policy_instruction_hybrid_lexical_embedding':'policy_instruction_only',lexical_filter_mode:spec.has_exact_scope?'rank_within_exact_scope':semanticRanked.length?'filter_by_terms_or_embedding_top_k':'filter_by_terms',ranking_primary:exactTemporalSemantic?'embedding_similarity':'composite_score',embedding_candidate_count:semanticRanked.length,embedding_scored_scope_count:allSemanticRanked.length,resolved_temporal:spec.resolved_temporal,zero_recall:ranked.length===0,worker_instruction:retrieval.instruction,ranked:ranked.map(candidateTrace)},
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
  const primary=[],deferred=[];
  for(const group of groups){
    const representative=[...group].sort(compareDuplicateRepresentative)[0];primary.push(representative);
    deferred.push(...group.filter(item=>item!==representative));
  }
  primary.sort(comparator);deferred.sort(comparator);
  return{primary,deferred};
}
function selectWithDiversityBackfill(partition,spec,limit,exactTemporalSemantic,comparator){
  const primary=exactTemporalSemantic?partition.primary.slice(0,limit):balancedSelect(partition.primary,spec,limit),selected=[...primary],seen=new Set(selected.map(item=>String(item.node.memory_id)));
  if(selected.length<limit)for(const record of partition.deferred){const id=String(record.node.memory_id);if(!seen.has(id)){seen.add(id);selected.push(record);if(selected.length>=limit)break;}}
  return exactTemporalSemantic?selected.sort(comparator):selected;
}
function compareDuplicateRepresentative(left,right){
  const leftQuality=duplicateRepresentativeQuality(left),rightQuality=duplicateRepresentativeQuality(right);
  for(let index=0;index<leftQuality.length;index++)if(leftQuality[index]!==rightQuality[index])return rightQuality[index]-leftQuality[index];
  return String(left.node.memory_id).localeCompare(String(right.node.memory_id));
}
function duplicateRepresentativeQuality(entry){
  const source=String(entry?.node?.source_text||''),literalProtected=(source.match(/\d+(?:\.\d+)?|%|mmol\/?L|mg\/?dL|mg|kg|mmHg|bpm|单位|毫克|千克|分钟|小时/giu)||[]).length,similarity=Number.isFinite(entry.embedding_similarity)?entry.embedding_similarity:-1,literalCompleteness=(source?2:0)+Math.min(3,literalProtected)*.5+Math.min(360,normalize(source||entry?.node?.text).length)/1000,combined=(Number(entry.score)||0)+literalCompleteness;
  return[(entry.numeric_matches||[]).length,(entry.matched_terms||[]).length,(entry.matched_lenses||[]).length,combined,similarity,literalCompleteness];
}
function obviousNearDuplicateFact(left,right){
  const leftSession=String(left?.episode_id||left?.observation_id||''),rightSession=String(right?.episode_id||right?.observation_id||'');
  if(!leftSession||leftSession!==rightSession||!compatibleSourceRole(left,right)||retrievalPolarity(left)!==retrievalPolarity(right)||retrievalQuantitiesConflict(left,right))return false;
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
function balancedSelect(records,spec,limit){const selected=[],seen=new Set(),add=record=>{const id=String(record?.node?.memory_id||'');if(id&&!seen.has(id)&&selected.length<limit){seen.add(id);selected.push(record);}};for(const lens of spec.lenses)add(records.find(record=>record.matched_lenses.includes(lens.id)));for(const family of [...spec.family_weights].sort((a,b)=>b.weight-a.weight))add(records.find(record=>array(record.node.families).includes(family.family)));for(const record of records)add(record);return selected;}
function expandGraph(selected,nodes,edges,limit){const out=[...selected],deferred=[],byId=new Map(nodes.map(node=>[String(node.memory_id),node])),seen=new Set(out.map(entry=>String(entry.node.memory_id))),frontier=[...seen];for(let depth=0;depth<2&&frontier.length&&out.length<limit;depth++){const next=[];for(const id of frontier)for(const edge of edges){const neighbor=String(edge.from_memory_id)===id?String(edge.to_memory_id):String(edge.to_memory_id)===id?String(edge.from_memory_id):null;if(!neighbor||seen.has(neighbor)||!byId.has(neighbor))continue;seen.add(neighbor);next.push(neighbor);const entry={node:byId.get(neighbor),score:Math.max(0,4-depth),reasons:['memory_graph_neighbor'],matched_terms:[],numeric_matches:[],matched_lenses:[],expanded_from:id};if(out.some(current=>obviousNearDuplicateFact(current.node,entry.node)))deferred.push(entry);else out.push(entry);if(out.length>=limit)break;}frontier.splice(0,frontier.length,...next);}for(const entry of deferred)if(out.length<limit)out.push(entry);return out;}
function candidateTrace(entry){return{memory_id:entry.node.memory_id,episode_id:entry.node.episode_id||null,event_time:entry.node.event_time||null,families:entry.node.families||[],score:entry.score,reasons:entry.reasons,matched_terms:entry.matched_terms||[],numeric_matches:entry.numeric_matches||[],matched_lenses:entry.matched_lenses||[],embedding_similarity:entry.embedding_similarity??null,embedding_rank:entry.embedding_rank??null,expanded_from:entry.expanded_from||null,rank:entry.rank||null};}
function normalizeSemanticScores(value){if(value instanceof Map)return new Map([...value].map(([id,score])=>[String(id),Number(score)]));if(!value||typeof value!=='object'||Array.isArray(value))return new Map();return new Map(Object.entries(value).map(([id,score])=>[String(id),Number(score)]));}
function recencyScore(node,nodes){const values=nodes.map(item=>Date.parse(item.event_time||'')).filter(Number.isFinite),time=Date.parse(node.event_time||'');return values.length&&Number.isFinite(time)?4*Math.max(0,(time-Math.min(...values))/Math.max(1,Math.max(...values)-Math.min(...values))):0;}
function earlinessScore(node,nodes){const values=nodes.map(item=>Date.parse(item.event_time||'')).filter(Number.isFinite),time=Date.parse(node.event_time||'');return values.length&&Number.isFinite(time)?4*Math.max(0,(Math.max(...values)-time)/Math.max(1,Math.max(...values)-Math.min(...values))):0;}
function temporalPreferenceScore(node,spec){
  if(!spec.temporal_preference||!spec.start_date||!spec.end_date||spec.start_date===spec.end_date)return 0;
  const time=Date.parse(node?.event_time||''),start=Date.parse(`${spec.start_date}T00:00:00.000Z`),end=Date.parse(`${spec.end_date}T00:00:00.000Z`);if(!Number.isFinite(time)||!Number.isFinite(start)||!Number.isFinite(end)||end<=start)return 0;
  const progress=Math.max(0,Math.min(1,(time-start)/(end-start)));return 4*(spec.temporal_preference==='earliest'?1-progress:progress);
}
function compareTime(left,right,operator){const a=Date.parse(left?.event_time||''),b=Date.parse(right?.event_time||'');if(!Number.isFinite(a)||!Number.isFinite(b)||a===b)return 0;return operator==='earliest'?a-b:b-a;}
function canonicalDate(value){const raw=String(value||'').trim(),match=/^(?<year>20\d{2})[-/.](?<month>\d{1,2})[-/.](?<day>\d{1,2})(?:$|[T\s])/u.exec(raw);if(!match)return'';const year=Number(match.groups.year),month=Number(match.groups.month),day=Number(match.groups.day),date=new Date(Date.UTC(year,month-1,day));return date.getUTCFullYear()===year&&date.getUTCMonth()===month-1&&date.getUTCDate()===day?date.toISOString().slice(0,10):'';}
function canonicalMonth(value){const match=/^(20\d{2})[-/.年](\d{1,2})/.exec(String(value||''));return match?`${match[1]}-${String(match[2]).padStart(2,'0')}`:'';}
function canonicalMonthOnly(value){const match=/^(20\d{2})[-/.年](\d{1,2})(?:月)?$/u.exec(String(value||'').trim());if(!match)return'';const month=Number(match[2]);return month>=1&&month<=12?`${match[1]}-${String(month).padStart(2,'0')}`:'';}
function resolveDateKeys(temporal){const dates=new Set(unique(temporal.date_keys).map(canonicalDate).filter(Boolean)),base=canonicalDate(temporal.base_date),offset=Number(temporal.offset_days??0);if(base&&Number.isInteger(offset)&&Math.abs(offset)<=3660){const value=new Date(`${base}T00:00:00.000Z`);value.setUTCDate(value.getUTCDate()+offset);dates.add(value.toISOString().slice(0,10));}return dates;}
function numberSet(value){return new Set((String(value||'').match(/\d+(?:\.\d+)?/g)||[]).map(item=>String(Number(item))));}
function defaultLimit(spec){return spec.expand_graph?42:spec.lenses.length?36:28;}
function dedupeNodes(nodes){const out=[],seen=new Set();for(const node of array(nodes)){const id=String(node?.memory_id||'');if(!id||seen.has(id))continue;seen.add(id);out.push(node);}return out;}
function unique(values){return[...new Set(toArray(values).map(value=>String(value||'').normalize('NFKC').trim()).filter(Boolean))];}
function toArray(value){return Array.isArray(value)?value:value==null?[]:[value];}
function array(value){return Array.isArray(value)?value:[];}
function plainObject(value){return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}
function positiveInteger(value){const number=Number(value);return Number.isInteger(number)&&number>0?number:null;}
function bounded(value,limit){return String(value||'').normalize('NFKC').trim().slice(0,limit);}
function normalize(value){return String(value||'').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu,'');}
