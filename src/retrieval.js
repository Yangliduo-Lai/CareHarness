import { STATE_FAMILIES } from './schema.js';
import { runEvidenceIndexGate } from './evidence-index-gate.js';

const PRIORITY_WEIGHT={primary:3,high:3,secondary:2,medium:2,support:1,supporting:1,low:1};
const TEMPORAL_OPERATORS=new Set(['none','event_time','earliest','latest','current','history','before','after','range']);

// Deterministic planning is used by the offline mock and is also merged into
// older/partial LLM outputs. It deliberately uses only the query item, never
// benchmark answers or reference key points.
export function analyzeQuery(item={}){
  return normalizeQueryPlan({},item);
}

export async function planQuery(item={},gateway=null){
  const fallback=analyzeQuery(item),question=String(item.question||'');
  if(!gateway||gateway.config?.provider==='mock')return{plan:{...fallback,planner_mode:'deterministic_fallback'},trace:null,fallback_used:true,error:null};
  try{
    const response=await gateway.completeJSON('query_planner',question,value=>validatePlannerOutput(value,item),()=>fallback);
    return{plan:{...response.value,planner_mode:'llm'},trace:response.trace,fallback_used:false,error:null};
  }catch(error){
    return{plan:{...fallback,planner_mode:'deterministic_fallback'},trace:error.gatewayTrace||null,fallback_used:true,error:String(error.message||error)};
  }
}

// Stage 1: build a scored, query-structure-aware candidate set. All supplied States are
// considered; state_scopes are priors and never exclude another family.
export function retrieveStateCandidates(queryPlan,states=[],evidence=[],options={}){
  const plan=coerceRuntimePlan(queryPlan),pool=dedupeStates(states.filter(Boolean)),evidenceById=new Map(evidence.filter(Boolean).map(item=>[item.evidence_id,item])),byId=new Map(pool.map(state=>[state.state_id,state])),searchTextById=new Map(pool.map(state=>[state.state_id,searchableStateText(state,evidenceById)])),optionSpecs=plan.options.length?plan.options:parseOptions(plan.question),queryTerms=lexicalQueryTerms(plan),records=[];
  const gate=runEvidenceIndexGate(plan,pool,evidence,{limit:options.gate_limit});
  for(const state of pool){
    const text=searchTextById.get(state.state_id),record=scoreState(state,text,plan,queryTerms,optionSpecs);
    if(gate?.state_annotations?.[state.state_id])applyEvidenceGateSignal(record,gate.state_annotations[state.state_id]);
    if(record.qualified)records.push(record);
  }
  expandVersionContext(records,byId,searchTextById,plan);
  records.sort((a,b)=>compareCandidates(a,b,plan));
  const provenanceSchedule=prioritizeSharedProvenance(records,plan),contentGroups=coalesceDuplicateCandidates(provenanceSchedule.records),limit=positiveInteger(options.limit)||candidateLimit(plan,optionSpecs.length),selected=selectStructuredCandidates(contentGroups.records,plan,optionSpecs,limit),assembled=assembleContext(selected.map(item=>item.state),evidenceById),ranked=selected.map(candidateTrace),channelCounts=countChannels(contentGroups.records),optionResults=buildOptionResults(optionSpecs,contentGroups.records,selected),familyDistribution=familyCounts(selected.flatMap(recordOriginalStates));
  const strategy=selectionStrategy(plan,limit,optionSpecs.length);
  const trace={
    retrieval_mode:'hybrid_state_retrieval_v1',query_plan:plan,state_pool_size:pool.length,
    candidate_count:selected.length,qualified_candidate_count:contentGroups.records.length,raw_qualified_state_count:records.length,candidate_limit:limit,
    selected_state_count:selected.length,selected_original_state_count:selected.reduce((total,record)=>total+recordOriginalStates(record).length,0),selected_evidence_count:assembled.evidence.length,
    candidate_stage:{mode:'evidence_index_chain_gate_union',channels:channelCounts,ranked,discarded_count:Math.max(0,contentGroups.records.length-selected.length),strategy,provenance_redundancy:provenanceSchedule.trace,content_dedup_gate:contentGroups.trace},
    selection_mode:'candidate_passthrough',selected:ranked,
    option_results:optionResults,family_distribution:familyDistribution,
    missing_evidence_ids:assembled.missingEvidenceIds,zero_recall:selected.length===0,
    fallback_used:Boolean(plan.planner_mode==='deterministic_fallback'),all_matches_returned:false,
    threshold_config:{lexical_ngram_min:0.42,scope_is_soft_prior:true},linked_state_expansion:selected.some(item=>item.reasons.includes('version_chain_context')),safety_cap:limit,
    evidence_index_gate:gate,
  };
  return{states:selected.map(item=>item.state),evidence:assembled.evidence,candidates:selected.map(candidateTrace),evidence_chains:gate?.chains||[],trace};
}

// Candidate retrieval is also the final answer context. There is deliberately
// no second model-selection stage: every candidate that survives the task-aware
// safety cap is passed through with its linked Evidence.
export function retrieveRelevantStates(queryPlan,states=[],evidence=[],options={}){
  return retrieveStateCandidates(queryPlan,states,evidence,options);
}

// State extraction is intentionally lossy. This bounded fallback keeps an
// atomic source fact queryable when no State node preserved its exact value,
// while using only visible Evidence and the runtime question.
export function retrieveEvidenceCandidates(queryPlan,evidence=[],options={}){
  const plan=coerceRuntimePlan(queryPlan),limit=positiveInteger(options.limit)||8,excluded=new Set((options.exclude_ids||[]).map(String)),neighborRadius=positiveInteger(options.neighbor_radius)||0,neighborSeedLimit=Math.min(limit,positiveInteger(options.neighbor_seed_limit)||3),latestQuestion=questionRequestsLatest(plan),requestedDates=latestQuestion?new Set():queryDateKeys(plan.question),requestedMonths=latestQuestion?new Set():queryMonthKeys(plan.question),requestedNumericValues=questionNumericSignals(plan),keywords=anchorKeywords(plan),target=shouldTreatQuestionNumbersAsBaseline(plan)?'':normalize(plan.target),records=[];
  for(const item of evidence){
    if(excluded.has(String(item.evidence_id)))continue;
    const text=normalize([item.text,item.source_text].filter(Boolean).join(' ')),reasons=[],matchedKeywords=[],matchedNumericValues=[];let score=0;
    const date=canonicalDateKey(item.event_time);if(date&&requestedDates.has(date)){reasons.push('event_time_match');score+=6;}
    const month=canonicalMonthKey(item.event_time);if(month&&requestedMonths.has(month)){reasons.push('event_month_match');score+=4;}
    const itemNumericValues=numericSignatures(text);for(const value of requestedNumericValues)if(itemNumericValues.has(value))matchedNumericValues.push(value);
    if(matchedNumericValues.length){reasons.push('numeric_value_match');score+=6+Math.min(1,matchedNumericValues.length*.25);}
    for(const term of nonRedundantKeywordMatches(keywords,text)){const key=normalize(term);matchedKeywords.push(term);score+=2+Math.min(1,key.length/20);}
    if(matchedKeywords.length)reasons.push('keyword_match');
    if(target&&text.includes(target)){reasons.push('target_match');score+=3;}
    if(!reasons.length)continue;
    records.push({item,score:+score.toFixed(4),reasons:[...new Set(reasons)],matched_keywords:[...new Set(matchedKeywords)],matched_aliases:[],matched_numeric_values:[...new Set(matchedNumericValues)]});
  }
  records.sort((a,b)=>b.score-a.score||compareEvidenceTime(a.item,b.item,plan)||String(a.item.evidence_id).localeCompare(String(b.item.evidence_id)));
  const seeds=records.slice(0,limit),selected=[],selectedIds=new Set(),bySequence=new Map();
  if(neighborRadius)for(const item of evidence){const key=evidenceSequenceKey(item);if(key)bySequence.set(key,item);}
  const add=record=>{const id=String(record.item.evidence_id);if(selectedIds.has(id)||excluded.has(id))return;selectedIds.add(id);selected.push(record);};
  for(let index=0;index<seeds.length;index++){
    const seed=seeds[index];add(seed);if(!neighborRadius||index>=neighborSeedLimit)continue;
    const sequence=evidenceSequence(seed.item);if(!sequence)continue;
    for(let distance=1;distance<=neighborRadius;distance++)for(const ordinal of[sequence.ordinal-distance,sequence.ordinal+distance]){const item=bySequence.get(`${sequence.observation}\u0000${ordinal}`);if(item)add({item,score:+Math.max(0,seed.score-.01*distance).toFixed(4),reasons:['adjacent_atomic_evidence'],matched_keywords:[],matched_aliases:[],matched_numeric_values:[],linked_to:seed.item.evidence_id});}
  }
  return{evidence:selected.map(record=>record.item),trace:{version:'careharness-direct-evidence-retrieval.v1',candidate_count:records.length,selected_count:selected.length,seed_count:seeds.length,adjacent_count:selected.filter(record=>record.reasons.includes('adjacent_atomic_evidence')).length,excluded_count:excluded.size,limit,ranked:selected.map(record=>({evidence_id:record.item.evidence_id,event_time:record.item.event_time||null,score:record.score,reasons:record.reasons,matched_keywords:record.matched_keywords,matched_aliases:record.matched_aliases,matched_numeric_values:record.matched_numeric_values,linked_to:record.linked_to||null}))}};
}

// Atomic Evidence can place a query cue and its answer hundreds of fragments
// apart inside one dated Session. Rank the complete visible Session first, then
// recover only answer-like spans from the strongest Session anchors.
export function retrieveSessionEvidenceAnchors(queryPlan,evidence=[],options={}){
  const plan=coerceRuntimePlan(queryPlan),anchorLimit=positiveInteger(options.anchor_limit)||3,evidenceLimit=positiveInteger(options.evidence_limit)||24,latestQuestion=questionRequestsLatest(plan),requestedDates=latestQuestion?new Set():queryDateKeys(plan.question),requestedMonthDays=latestQuestion?new Set():queryMonthDayKeys(plan.question),requestedMonths=latestQuestion?new Set():queryMonthKeys(plan.question),requestedNumericValues=questionNumericSignals(plan),baselineQuestion=shouldTreatQuestionNumbersAsBaseline(plan),keywords=anchorKeywords(plan),target=baselineQuestion?'':normalize(plan.target),groups=new Map();
  for(const item of evidence){const key=String(item.observation_id||item.episode_id||item.source_session_id||item.evidence_id),group=groups.get(key)||{key,event_time:item.event_time||null,episode_id:item.episode_id||item.source_session_id||null,items:[]};group.items.push(item);if(!group.event_time&&item.event_time)group.event_time=item.event_time;groups.set(key,group);}
  const ranked=[];
  for(const group of groups.values()){
    const text=normalize(group.items.flatMap(item=>[item.text,item.source_text]).filter(Boolean).join(' ')),matchedKeywords=nonRedundantKeywordMatches(keywords,text),matchedAliases=[],date=canonicalDateKey(group.event_time),monthDay=canonicalMonthDayKey(group.event_time),month=canonicalMonthKey(group.event_time),groupNumeric=numericSignatures(text),matchedNumeric=[...requestedNumericValues].filter(value=>groupNumeric.has(value)),answerSignal=Math.max(0,...group.items.map(item=>answerEvidenceScore(item,plan)));let score=0;
    if(date&&requestedDates.has(date))score+=30;
    if(monthDay&&requestedMonthDays.has(monthDay))score+=28;
    if(month&&requestedMonths.has(month))score+=12;
    if(target&&text.includes(target))score+=8;
    score+=matchedKeywords.reduce((sum,term)=>sum+Math.min(4,1.25+normalize(term).length/6),0);
    if(matchedNumeric.length)score+=6+matchedNumeric.length*.25;
    if(answerSignal>1)score+=Math.min(16,answerSignal*.7);
    if(!score)continue;
    ranked.push({...group,score:+score.toFixed(3),answer_signal:answerSignal,matched_keywords:matchedKeywords,matched_aliases:matchedAliases,matched_numeric_values:matchedNumeric});
  }
  ranked.sort((a,b)=>b.score-a.score||compareAnchorTime(a,b,plan)||a.key.localeCompare(b.key));
  const anchors=selectSessionAnchors(ranked,plan,anchorLimit),selected=[],selectedIds=new Set(),perAnchorLimit=Math.max(3,Math.floor(evidenceLimit/Math.max(1,anchors.length)));
  for(const anchor of anchors){
    const local=anchor.items.map(item=>{const score=sessionEvidenceScore(item,plan,{keywords,target,requestedDates,requestedMonthDays,requestedMonths,requestedNumericValues}),answer_score=answerEvidenceScore(item,plan);return{item,score,answer_score,total:score+answer_score};}).sort((a,b)=>b.total-a.total||b.answer_score-a.answer_score||evidenceOrdinal(a.item)-evidenceOrdinal(b.item)),seedLimit=Math.max(4,Math.ceil(perAnchorLimit*.67)),seeds=diverseEvidenceSeeds(local,seedLimit,plan),byOrdinal=new Map(anchor.items.map(item=>[evidenceOrdinal(item),item])),anchorStart=selected.length;
    const add=item=>{const id=String(item?.evidence_id||'');if(id&&!selectedIds.has(id)&&selected.length<evidenceLimit&&selected.length-anchorStart<perAnchorLimit){selectedIds.add(id);selected.push(item);}};
    for(const seed of seeds)add(seed.item);
    for(const seed of [...seeds].reverse()){const ordinal=evidenceOrdinal(seed.item);for(const nearby of[ordinal-1,ordinal+1])add(byOrdinal.get(nearby));}
    for(const candidate of local)if(selected.length-anchorStart<perAnchorLimit)add(candidate.item);
  }
  const compact=anchors.map(anchor=>({observation_id:anchor.key,episode_id:anchor.episode_id,event_time:anchor.event_time,score:anchor.score,matched_keywords:anchor.matched_keywords,matched_aliases:anchor.matched_aliases,matched_numeric_values:anchor.matched_numeric_values,evidence_ids:selected.filter(item=>String(item.observation_id||item.episode_id||item.source_session_id||item.evidence_id)===anchor.key).map(item=>item.evidence_id)}));
  return{evidence:selected,anchors:compact,trace:{version:'careharness-session-anchor.v1',candidate_session_count:ranked.length,selected_session_count:anchors.length,selected_evidence_count:selected.length,ranked_sessions:ranked.slice(0,12).map(anchor=>({observation_id:anchor.key,episode_id:anchor.episode_id,event_time:anchor.event_time,score:anchor.score,matched_keywords:anchor.matched_keywords,matched_aliases:anchor.matched_aliases,matched_numeric_values:anchor.matched_numeric_values}))}};
}

function validatePlannerOutput(value,item){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('query planner output must be an object');
  const recognized=['intent','target','answer_slot','keywords','state_scopes','family_priors','temporal_operator','evidence_facets','options'];
  if(!recognized.some(key=>Object.hasOwn(value,key)))throw new Error('query planner output must contain a recognized retrieval field');
  for(const key of ['keywords','state_scopes','family_priors','evidence_facets','options'])if(Object.hasOwn(value,key)&&!Array.isArray(value[key]))throw new Error(`query planner ${key} must be an array`);
  const plan=normalizeQueryPlan(value,item);
  if(!plan.keywords.length&&!plan.target&&!plan.state_scopes.length&&!plan.evidence_facets.length&&!plan.options.length)throw new Error('query planner must return at least one retrieval signal');
  return plan;
}

function normalizeQueryPlan(value,item){
  const question=String(item.question||''),providedKeywords=Array.isArray(value.keywords)?cleanKeywords(value.keywords):null,providedScopes=Array.isArray(value.state_scopes)?cleanScopes(value.state_scopes):Array.isArray(value.family_priors)?cleanScopes(value.family_priors):[],providedFacets=Array.isArray(value.evidence_facets)?cleanFacets(value.evidence_facets):[],providedOptions=normalizeOptions(value.options,question),keywords=providedKeywords??surfaceTerms(question),temporalOperator=normalizeTemporalOperator(value.temporal_operator)||'none';
  return{
    question,intent:cleanScalar(value.intent)||'retrieve_relevant_patient_evidence',
    target:cleanScalar(value.target)||inferTarget(keywords),answer_slot:cleanScalar(value.answer_slot)||'fact',
    keywords,
    state_scopes:providedScopes,
    temporal_operator:temporalOperator,
    evidence_facets:providedFacets,
    options:providedOptions
  };
}

function coerceRuntimePlan(value={}){
  const item={question:String(value.question||'')},normalized=normalizeQueryPlan(value,item);
  return{...normalized,planner_mode:value.planner_mode||null};
}

function inferTarget(keywords){
  if(!keywords.length)return null;
  return[...keywords].sort((a,b)=>targetScore(b)-targetScore(a)||b.length-a.length)[0]||null;
}

function targetScore(value){const text=normalize(value);return Math.min(text.length,20)+(/\d/u.test(text)?2:0);}

function cleanScopes(value){
  const out=[];
  for(const raw of value||[]){
    if(!raw||typeof raw!=='object')continue;
    const family=String(raw.family||'').toUpperCase();if(!STATE_FAMILIES.includes(family))continue;
    mergeScope(out,{family,priority:normalizePriority(raw.priority)});
  }
  return out;
}

function combineScopes(...groups){
  const best=new Map();
  for(const scope of groups.flat()){
    if(!scope||!STATE_FAMILIES.includes(scope.family))continue;
    const priority=normalizePriority(scope.priority),weight=PRIORITY_WEIGHT[priority]||1,existing=best.get(scope.family);
    if(!existing||weight>(PRIORITY_WEIGHT[existing.priority]||1))best.set(scope.family,{family:scope.family,priority});
  }
  return[...best.values()];
}

function mergeScope(scopes,scope){
  const priority=normalizePriority(scope.priority),existing=scopes.find(item=>item.family===scope.family);
  if(existing){if((PRIORITY_WEIGHT[priority]||1)>(PRIORITY_WEIGHT[existing.priority]||1))existing.priority=priority;return;}
  scopes.push({family:scope.family,priority});
}

function normalizePriority(value){
  if(Number(value)>=3)return'primary';if(Number(value)===2)return'secondary';if(Number(value)===1)return'support';
  const key=normalize(value);return PRIORITY_WEIGHT[key]===3?'primary':PRIORITY_WEIGHT[key]===2?'secondary':'support';
}

function normalizeTemporalOperator(value){const key=normalize(value).replace(/\s+/g,'_');return TEMPORAL_OPERATORS.has(key)?key:null;}
function cleanFacets(value){if(!Array.isArray(value))return[];return[...new Set(value.map(cleanScalar).filter(Boolean))].slice(0,24);}
function cleanScalar(value){if(typeof value==='string')return value.normalize('NFKC').trim().slice(0,120)||null;if(value&&typeof value==='object')return cleanScalar(value.entity||value.name||value.text||value.value);return null;}
function normalizeOptions(value,question){const parsed=parseOptions(question);if(!Array.isArray(value)||!value.length)return parsed;const byId=new Map(parsed.map(item=>[item.id,item]));for(const item of value){if(!item||typeof item!=='object')continue;const id=String(item.id||item.option_id||'').toUpperCase(),text=cleanScalar(item.text||item.option_text);if(/^[A-Z]$/.test(id)&&text&&!byId.has(id))byId.set(id,{id,text});}return[...byId.values()].sort((a,b)=>a.id.localeCompare(b.id));}

function scoreState(state,text,plan,queryTerms,options){
  const reasons=[],matchedKeywords=[],matchedNumericValues=[],matchedFacets=[],matchedScopes=[],optionIds=[];
  let score=0,maxSimilarity=0;
  const requestedDates=queryDateKeys(plan.question),stateDate=canonicalDateKey(state.event_time);
  if(stateDate&&requestedDates.has(stateDate)){reasons.push('event_time_match');score+=6;}
  const requestedMonths=queryMonthKeys(plan.question),stateMonth=canonicalMonthKey(state.event_time);
  if(stateMonth&&requestedMonths.has(stateMonth)){reasons.push('event_month_match');score+=4;}
  const requestedNumericValues=questionNumericSignals(plan),stateNumericValues=numericSignatures(text);
  for(const value of requestedNumericValues)if(stateNumericValues.has(value))matchedNumericValues.push(value);
  if(matchedNumericValues.length){reasons.push('numeric_value_match');score+=6+Math.min(1,matchedNumericValues.length*.25);}
  for(const term of plan.keywords){const key=normalize(term);if(key&&text.includes(key)){matchedKeywords.push(term);score+=4+Math.min(1,key.length/20);}}
  if(plan.target){const target=normalize(plan.target);if(target&&text.includes(target)){reasons.push('target_match');score+=4.25;}}
  if(matchedKeywords.length)reasons.push('keyword_match');
  for(const term of queryTerms){if(text.includes(normalize(term)))continue;maxSimilarity=Math.max(maxSimilarity,lexicalSimilarity(term,text));}
  if(maxSimilarity>=.42){reasons.push('lexical_ngram_match');score+=maxSimilarity*2.7;}
  for(const facet of plan.evidence_facets){const terms=facetLexicalTerms(facet);if(terms.some(term=>text.includes(normalize(term)))){matchedFacets.push(facet);score+=.55;}}
  if(matchedFacets.length)reasons.push('evidence_facet_match');
  for(const scope of plan.state_scopes){
    if(scope.family!==state.family)continue;
    const priority=PRIORITY_WEIGHT[scope.priority]||1;matchedScopes.push({family:scope.family,priority:scope.priority});score+=.45+priority*.25;reasons.push('scope_family_prior');
  }
  for(const option of options){const optionMatch=scoreOption(option,text);if(optionMatch.matched){optionIds.push(option.id);score+=Math.min(2.4,optionMatch.score);}}
  if(optionIds.length)reasons.push('option_match');
  if(['current','latest'].includes(plan.temporal_operator)){
    if(state.status==='active')score+=.45;
    if(state.family==='LO')score+=.4;
  }
  if(plan.temporal_operator!=='none'&&Number.isFinite(eventOrder(state)))score+=.25;
  if(matchedFacets.length)score+=.3;
  const qualifyingReasons=new Set(['event_time_match','event_month_match','numeric_value_match','keyword_match','target_match','lexical_ngram_match','scope_family_prior','evidence_facet_match','option_match']),qualified=reasons.some(reason=>qualifyingReasons.has(reason));
  return{state,score:+score.toFixed(4),qualified,reasons:[...new Set(reasons)],matched_keywords:[...new Set(matchedKeywords)],matched_aliases:[],matched_concepts:[],matched_numeric_values:[...new Set(matchedNumericValues)],matched_scopes:matchedScopes,matched_facets:[...new Set(matchedFacets)],option_ids:[...new Set(optionIds)],lexical_similarity:+maxSimilarity.toFixed(4),linked_to:null};
}

function scoreOption(option,text){
  const terms=cleanKeywords([option.text,...surfaceTerms(option.text)]),direct=terms.filter(term=>text.includes(normalize(term))),similarity=Math.max(0,...terms.map(term=>lexicalSimilarity(term,text))),matched=direct.length>0||similarity>=.55;
  return{matched,score:direct.length?2.4:similarity*2};
}

function expandVersionContext(records,byId,searchTextById,plan){
  if(!records.length)return;
  const recordById=new Map(records.map(record=>[record.state.state_id,record])),reverse=new Map();
  for(const state of byId.values())for(const id of [state.supersedes,...(state.version_chain||[])].filter(Boolean)){const values=reverse.get(id)||[];values.push(state.state_id);reverse.set(id,values);}
  for(const record of [...records]){
    const related=new Set([record.state.supersedes,...(record.state.version_chain||[]),...(Array.isArray(record.state.conflicts_with)?record.state.conflicts_with:[record.state.conflicts_with]),...(reverse.get(record.state.state_id)||[])].filter(Boolean));
    for(const id of related){const existing=recordById.get(id);if(existing){existing.reasons=[...new Set([...(existing.reasons||[]),'version_chain_context'])];existing.linked_to=existing.linked_to||record.state.state_id;continue;}if(!byId.has(id))continue;const state=byId.get(id),linked={state,score:+Math.max(.7,record.score-1.25).toFixed(4),qualified:true,reasons:['version_chain_context'],matched_keywords:[],matched_aliases:[],matched_concepts:[],matched_numeric_values:[],matched_scopes:[],matched_facets:[],option_ids:[],lexical_similarity:0,linked_to:record.state.state_id};records.push(linked);recordById.set(id,linked);}
  }
}

function compareCandidates(a,b,plan){
  const temporal=plan.temporal_operator;
  if(['earliest','latest'].includes(temporal)){
    const tierDifference=relevanceTier(b)-relevanceTier(a);if(tierDifference)return tierDifference;
    const timeDifference=temporal==='earliest'?eventOrder(a.state)-eventOrder(b.state):eventOrder(b.state)-eventOrder(a.state);if(timeDifference)return timeDifference;
  }
  if(b.score!==a.score)return b.score-a.score;
  if(['current'].includes(temporal))return eventOrder(b.state)-eventOrder(a.state)||stableStateOrder(a.state,b.state)||idOrder(a.state,b.state);
  return eventOrder(b.state)-eventOrder(a.state)||stableStateOrder(a.state,b.state)||idOrder(a.state,b.state);
}

// State IDs are UUIDs, so they must be only the final tie-break for records
// that are otherwise semantically indistinguishable. In particular, sibling
// States emitted from one Evidence item commonly have the same score and time;
// choosing their provenance representative by UUID would make a rebuild change
// the selected family even when the underlying memory is identical.
function stableStateOrder(a,b){
  const familyDifference=STATE_FAMILIES.indexOf(a.family)-STATE_FAMILIES.indexOf(b.family);if(familyDifference)return familyDifference;
  for(const [left,right]of[[a.value,b.value],[evidenceKey(a),evidenceKey(b)],[a.episode_id,b.episode_id],[a.turn_id,b.turn_id],[a.source_type,b.source_type],[a.status,b.status],[a.polarity,b.polarity],[a.operation,b.operation],[a.event_time,b.event_time]]){const difference=scalarOrder(left,right);if(difference)return difference;}
  const versionDifference=finiteNumber(b.version)-finiteNumber(a.version);if(versionDifference)return versionDifference;
  return finiteNumber(b.certainty)-finiteNumber(a.certainty);
}
function evidenceKey(state){return[...new Set(state?.evidence_ids||[])].map(String).sort().join('\u0000');}
function scalarOrder(a,b){const left=String(a??'').normalize('NFKC').toLowerCase(),right=String(b??'').normalize('NFKC').toLowerCase();return left<right?-1:left>right?1:0;}
function finiteNumber(value){const number=Number(value);return Number.isFinite(number)?number:0;}

function relevanceTier(record){
  if(record.reasons.includes('numeric_value_match'))return 4;
  if(record.reasons.some(reason=>['event_time_match','keyword_match','target_match','medical_alias_match','option_match'].includes(reason)))return 3;
  if(record.reasons.some(reason=>['lexical_ngram_match','evidence_facet_match'].includes(reason)))return 2;
  return 1;
}

// One Evidence may legitimately produce States in several families. They remain
// separate candidates, but a broad Evidence-text match should not let one
// provenance component consume the whole top-k budget. Records connected by a
// shared Evidence ID form one component. New Evidence coverage is preserved,
// then remaining siblings are interleaved one per component per round.
function prioritizeSharedProvenance(records,plan){
  const frequency=evidenceFrequency(records),groups=provenanceComponents(records),groupByRecord=new Map(groups.flatMap(group=>group.records.map(record=>[record,group]))),sharedGroups=groups.filter(group=>group.records.length>1),preferred=[],queues=new Map(sharedGroups.map(group=>[group,[]])),seenEvidence=new Set(),seenGroups=new Set();let novelEvidencePreserved=0,deferredStateCount=0;
  for(const record of records){
    const group=groupByRecord.get(record),evidenceIds=recordEvidenceIds(record),sharedEvidenceIds=evidenceIds.filter(id=>(frequency.get(id)||0)>1),novelEvidenceIds=evidenceIds.filter(id=>!seenEvidence.has(id));
    record.novel_evidence_ids=novelEvidenceIds;
    if(group.records.length===1){record.provenance_priority='unique';preferred.push(record);for(const id of evidenceIds)seenEvidence.add(id);continue;}
    record.provenance_group=group.id;record.provenance_sibling_count=group.records.length-1;record.shared_evidence_ids=sharedEvidenceIds;
    const firstInGroup=!seenGroups.has(group);
    if(firstInGroup||novelEvidenceIds.length){
      record.provenance_priority=firstInGroup?'representative':'novel_evidence';preferred.push(record);seenGroups.add(group);if(!firstInGroup)novelEvidencePreserved++;
      for(const id of evidenceIds)seenEvidence.add(id);continue;
    }
    record.provenance_priority='deferred_sibling';queues.get(group).push(record);deferredStateCount++;
  }
  const interleaved=[];let roundRobinRoundCount=0;
  while(sharedGroups.some(group=>queues.get(group).length>roundRobinRoundCount)){
    for(const group of sharedGroups){const record=queues.get(group)[roundRobinRoundCount];if(record)interleaved.push(record);}
    roundRobinRoundCount++;
  }
  return{records:[...preferred,...interleaved],trace:{mode:'shared_evidence_round_robin',score_policy:'per_state_no_provenance_bonus',shared_evidence_group_count:sharedGroups.length,shared_evidence_id_count:[...frequency.values()].filter(count=>count>1).length,shared_state_count:sharedGroups.reduce((total,group)=>total+group.records.length,0),deferred_state_count:deferredStateCount,novel_evidence_preserved_count:novelEvidencePreserved,round_robin_round_count:roundRobinRoundCount}};
}

// Exact duplicate content is a query-time presentation concern, not a memory
// mutation. Keep every stored State intact inside one merged candidate so
// family, version, time, provenance, and Evidence remain auditable,
// while the group consumes only one task-budget slot.
function coalesceDuplicateCandidates(records){
  const groups=new Map(),ordered=[];
  for(const record of records){
    const contentKey=duplicateContentKey(record.state),key=contentKey||`state:${record.state.state_id}`;
    let group=groups.get(key);if(!group){group=[];groups.set(key,group);ordered.push(group);}group.push(record);
  }
  const mergedGroups=ordered.filter(group=>group.length>1),coalesced=ordered.map(group=>group.length===1?group[0]:mergeCandidateGroup(group));
  return{records:coalesced,trace:{enabled:true,mode:'exact_normalized_state_content',input_state_count:records.length,output_candidate_count:coalesced.length,merged_group_count:mergedGroups.length,merged_state_count:mergedGroups.reduce((total,group)=>total+group.length,0),slots_saved:records.length-coalesced.length,groups:mergedGroups.map(group=>({representative_state_id:group[0].state.state_id,member_state_ids:group.flatMap(recordStateIds),families:[...new Set(group.flatMap(record=>recordOriginalStates(record).map(state=>state.family)))]}))}};
}

function duplicateContentKey(state){
  const value=String(state?.value??'').normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim();if(!value)return null;
  const evidenceIds=[...new Set(state?.evidence_ids||[])].filter(Boolean).map(String).sort(),provenance=evidenceIds.length?`evidence:${evidenceIds.join('|')}`:`source:${state?.episode_id||''}|${state?.turn_id||''}|${state?.event_time||''}|${state?.source_type||''}`;
  return`${normalize(state?.polarity||'affirmed')}\u0000${value}\u0000${provenance}`;
}

function mergeCandidateGroup(records){
  const representative=records[0],originalStates=dedupeOriginalStates(records.flatMap(recordOriginalStates)),mergedState={...representative.state,evidence_ids:[...new Set(originalStates.flatMap(state=>state.evidence_ids||[]))],merged_duplicate_group:true,merged_state_count:originalStates.length,merged_state_ids:originalStates.map(state=>state.state_id),merged_families:originalStates.map(state=>({state_id:state.state_id,family:state.family,status:state.status??null,version:state.version??null,event_time:state.event_time??null,episode_id:state.episode_id??null})),merged_states:originalStates};
  const merged={...representative,state:mergedState,score:Math.max(...records.map(record=>record.score)),qualified:true,reasons:[...new Set([...records.flatMap(record=>record.reasons||[]),'content_duplicate_merged'])],matched_keywords:[...new Set(records.flatMap(record=>record.matched_keywords||[]))],matched_aliases:[...new Set(records.flatMap(record=>record.matched_aliases||[]))],matched_concepts:[...new Set(records.flatMap(record=>record.matched_concepts||[]))],matched_numeric_values:[...new Set(records.flatMap(record=>record.matched_numeric_values||[]))],matched_scopes:uniqueObjects(records.flatMap(record=>record.matched_scopes||[])),matched_facets:[...new Set(records.flatMap(record=>record.matched_facets||[]))],option_ids:[...new Set(records.flatMap(record=>record.option_ids||[]))],lexical_similarity:Math.max(...records.map(record=>Number(record.lexical_similarity)||0)),member_records:records};
  const gateFacets=[...new Set(records.flatMap(record=>record.gate_facets||[]))];if(gateFacets.length){merged.gate_score=Math.max(...records.map(record=>Number(record.gate_score)||0));merged.gate_facets=gateFacets;merged.gate_channels=[...new Set(records.flatMap(record=>record.gate_channels||[]))];merged.gate_chain_ids=[...new Set(records.flatMap(record=>record.gate_chain_ids||[]))];}
  return merged;
}

function dedupeOriginalStates(states){const seen=new Set(),out=[];for(const state of states){const key=String(state?.state_id||'');if(key&&seen.has(key))continue;if(key)seen.add(key);out.push(state);}return out;}
function recordOriginalStates(record){return Array.isArray(record?.state?.merged_states)?record.state.merged_states:[record.state];}
function recordStateIds(record){return recordOriginalStates(record).map(state=>state.state_id).filter(Boolean);}
function recordFamilies(record){return[...new Set(recordOriginalStates(record).map(state=>state.family).filter(Boolean))];}
function uniqueObjects(values){const seen=new Set(),out=[];for(const value of values){const key=JSON.stringify(value);if(seen.has(key))continue;seen.add(key);out.push(value);}return out;}

function evidenceFrequency(records){const frequency=new Map();for(const record of records)for(const id of recordEvidenceIds(record))frequency.set(id,(frequency.get(id)||0)+1);return frequency;}
function recordEvidenceIds(record){return[...new Set(record?.state?.evidence_ids||[])].filter(Boolean).map(String).sort();}
function provenanceComponents(records){
  const parent=records.map((_,index)=>index),find=index=>{while(parent[index]!==index){parent[index]=parent[parent[index]];index=parent[index];}return index;},union=(left,right)=>{left=find(left);right=find(right);if(left!==right)parent[right]=left;},firstByEvidence=new Map();
  records.forEach((record,index)=>{for(const id of recordEvidenceIds(record)){const first=firstByEvidence.get(id);if(first==null)firstByEvidence.set(id,index);else union(first,index);}});
  const members=new Map();records.forEach((record,index)=>{const root=find(index),items=members.get(root)||[];items.push(record);members.set(root,items);});
  return[...members.values()].map(groupRecords=>{const evidenceIds=[...new Set(groupRecords.flatMap(recordEvidenceIds))].sort();return{records:groupRecords,evidence_ids:evidenceIds,id:`evidence:${evidenceIds.join('|')}`};});
}

function selectStructuredCandidates(records,plan,options,limit){
  if(records.length<=limit)return records;
  if(options.length){
    const selected=[],seen=new Set(),quota=Math.max(2,Math.floor(limit/options.length)),add=record=>{if(!record||selected.length>=limit||seen.has(record.state.state_id))return;selected.push(record);seen.add(record.state.state_id);};
    for(const option of options)for(const record of records.filter(item=>item.option_ids.includes(option.id)).slice(0,quota))add(record);
    for(const record of records)add(record);
    return selected.sort((a,b)=>compareCandidates(a,b,plan)).slice(0,limit);
  }
  if(plan.state_scopes.length>1||plan.evidence_facets.length>1)return diversifyStructuredCandidates(records,plan,limit);
  return records.slice(0,limit);
}

function applyEvidenceGateSignal(record,annotation){
  record.qualified=true;
  record.reasons=[...new Set([...record.reasons,'evidence_index_gate',...(annotation.chain_ids?.length?['evidence_chain_member']:[])])];
  record.gate_facets=[...(annotation.facets||[])];record.gate_channels=[...(annotation.channels||[])];record.gate_chain_ids=[...(annotation.chain_ids||[])];record.gate_score=Number(annotation.gate_score)||0;
}

function diversifyStructuredCandidates(records,plan,limit){
  const selected=[],seen=new Set(),coverage=new Map(),add=record=>{if(!record||seen.has(record.state.state_id)||selected.length>=limit)return false;selected.push(record);seen.add(record.state.state_id);for(const family of recordFamilies(record))coverage.set(family,(coverage.get(family)||0)+1);return true;};
  const strong=records.filter(record=>record.reasons.some(reason=>['keyword_match','target_match','medical_alias_match','semantic_concept_match','option_match'].includes(reason)));
  for(const record of strong.slice(0,Math.min(3,limit)))add(record);
  const keys=scopeCoverageKeys(plan,records),criticalKeys=keys.filter(key=>inferenceScopeImportance(key,plan)>=100),supportKeys=keys.filter(key=>inferenceScopeImportance(key,plan)<100);
  // First guarantee the decision-critical families. Direct/concept candidates
  // already selected count toward coverage.
  for(const key of criticalKeys){
    if(selected.length>=limit)break;
    if((coverage.get(key.id)||0)>0)continue;
    add(records.find(record=>keyMatchesRecord(key,record)&&!seen.has(record.state.state_id)));
  }
  // Spend budget on high-information facets that often require more than one
  // fact (symptom clusters, objective trends, and treatment response).
  for(const key of criticalKeys){
    const quota=inferenceCoverageQuota(key,plan);
    while(selected.length<limit&&(coverage.get(key.id)||0)<quota){const next=records.find(record=>keyMatchesRecord(key,record)&&!seen.has(record.state.state_id));if(!add(next))break;}
  }
  // Then cover contextual and supporting families with the remaining budget.
  for(const key of supportKeys){if(selected.length>=limit)break;if((coverage.get(key.id)||0)===0)add(records.find(record=>keyMatchesRecord(key,record)&&!seen.has(record.state.state_id)));}
  const coveredFamilies=new Set(selected.flatMap(recordFamilies)),coveredFacets=new Set(selected.flatMap(record=>record.matched_facets));
  for(const record of records){const families=recordFamilies(record);if(families.some(family=>!coveredFamilies.has(family))||record.matched_facets.some(facet=>!coveredFacets.has(facet))){if(add(record)){for(const family of families)coveredFamilies.add(family);for(const facet of record.matched_facets)coveredFacets.add(facet);}}}
  for(const record of records)add(record);
  return selected;
}

function scopeCoverageKeys(plan,records){
  const available=new Set(records.flatMap(recordFamilies)),keys=[];
  for(const scope of plan.state_scopes){const id=scope.family;if(available.has(id)&&!keys.some(key=>key.id===id))keys.push({id,family:scope.family,priority:scope.priority});}
  return keys.sort((a,b)=>inferenceScopeImportance(b,plan)-inferenceScopeImportance(a,plan)||a.id.localeCompare(b.id));
}

function inferenceScopeImportance(key,plan){
  const facets=new Set(plan.evidence_facets),id=key.id;
  let score=(PRIORITY_WEIGHT[key.priority]||1)*10;
  if(facets.has('objective_results')&&id==='CS')score+=100;
  if(facets.has('symptoms_or_adverse_effects')&&id==='PE')score+=98;
  if(facets.has('medication_status')&&id==='CS')score+=96;
  if(facets.has('adherence')&&id==='PE')score+=94;
  if(facets.has('treatment_response')&&id==='LO')score+=92;
  if(facets.has('contraindications_and_allergies')&&id==='CS')score+=90;
  if(facets.has('care_plan')&&key.family==='CP')score+=75;
  if(facets.has('medical_history')&&id==='BC')score+=70;
  if(facets.has('patient_preference')&&key.family==='PA')score+=65;
  return score;
}

function inferenceCoverageQuota(key,plan){
  const facets=new Set(plan.evidence_facets),id=key.id;
  if(facets.has('symptoms_or_adverse_effects')&&id==='PE')return 4;
  if(facets.has('objective_results')&&id==='CS')return 2;
  if(facets.has('treatment_response')&&id==='LO')return 2;
  if(facets.has('medication_status')&&id==='CS')return 2;
  return 1;
}

function keyMatchesRecord(key,record){return recordFamilies(record).includes(key.family);}

function candidateLimit(plan,optionCount){
  if(optionCount)return Math.min(24,Math.max(12,optionCount*4));
  if(plan.state_scopes.length>1||plan.evidence_facets.length>1)return 20;
  return 12;
}

function selectionStrategy(plan,limit,optionCount){
  const mode=optionCount?'per_option_balancing':['current','latest','earliest'].includes(plan.temporal_operator)?'relevance_then_temporal_order':plan.state_scopes.length>1||plan.evidence_facets.length>1?'family_and_facet_coverage':'relevance_rank';
  return{mode,temporal_operator:plan.temporal_operator,candidate_limit:limit,per_option_quota:optionCount?Math.max(2,Math.floor(limit/optionCount)):null};
}

function lexicalQueryTerms(plan){
  const raw=[...plan.keywords,plan.target,...plan.evidence_facets.flatMap(facetLexicalTerms),...plan.options.map(item=>item.text)].filter(Boolean);
  return[...new Set(raw.map(value=>String(value).normalize('NFKC').trim()).filter(value=>value.length>1))].slice(0,96);
}

function facetLexicalTerms(value){return String(value||'').split(/[_/|,，、\s-]+/).map(item=>item.trim()).filter(item=>item.length>2);}

function lexicalSimilarity(term,text){
  const query=compact(term),document=compact(text);if(!query||!document)return 0;if(document.includes(query))return 1;
  if(/[\p{Script=Han}]/u.test(query)){
    const size=query.length>=4?2:1,grams=ngrams(query,size);if(!grams.size)return 0;let hits=0;for(const gram of grams)if(document.includes(gram))hits++;return hits/grams.size;
  }
  const queryTokens=new Set(query.split(/[^a-z0-9]+/).filter(token=>token.length>1)),documentTokens=new Set(document.split(/[^a-z0-9]+/).filter(Boolean));if(!queryTokens.size)return 0;return[...queryTokens].filter(token=>documentTokens.has(token)).length/queryTokens.size;
}

function ngrams(value,size){const out=new Set();for(let index=0;index<=value.length-size;index++)out.add(value.slice(index,index+size));return out;}
function compact(value){return normalize(value).replace(/[\s\p{P}\p{S}]/gu,'');}

function assembleContext(states,evidenceById){
  const evidenceIds=[...new Set(states.flatMap(state=>state.evidence_ids||[]))],evidence=evidenceIds.map(id=>evidenceById.get(id)).filter(Boolean),missingEvidenceIds=evidenceIds.filter(id=>!evidenceById.has(id));return{evidence,missingEvidenceIds};
}

function candidateTrace(record){return{state_id:record.state.state_id,family:record.state.family,score:record.score,reasons:record.reasons,matched_keywords:record.matched_keywords,matched_aliases:record.matched_aliases,matched_concepts:record.matched_concepts,matched_numeric_values:record.matched_numeric_values||[],matched_scopes:record.matched_scopes,matched_facets:record.matched_facets,option_ids:record.option_ids,lexical_similarity:record.lexical_similarity,linked_to:record.linked_to,...(record.gate_facets?{gate_score:record.gate_score,gate_facets:record.gate_facets,gate_channels:record.gate_channels||[],gate_chain_ids:record.gate_chain_ids||[]}:{}),provenance_group:record.provenance_group||null,provenance_priority:record.provenance_priority||'unique',provenance_sibling_count:record.provenance_sibling_count||0,shared_evidence_ids:record.shared_evidence_ids||[],novel_evidence_ids:record.novel_evidence_ids||[],merged_duplicate_group:Boolean(record.state.merged_duplicate_group),merged_state_count:record.state.merged_state_count||1,merged_state_ids:record.state.merged_state_ids||[record.state.state_id],merged_families:record.state.merged_families||[{state_id:record.state.state_id,family:record.state.family,status:record.state.status??null,version:record.state.version??null,event_time:record.state.event_time??null,episode_id:record.state.episode_id??null}],value:record.state.value,event_time:record.state.event_time||null,status:record.state.status||null};}
function countChannels(records){const counts={event_time_match:0,event_month_match:0,numeric_value_match:0,keyword_match:0,target_match:0,medical_alias_match:0,semantic_concept_match:0,lexical_ngram_match:0,scope_family_prior:0,evidence_facet_match:0,option_match:0,version_chain_context:0};if(records.some(record=>record.gate_facets)){counts.evidence_index_gate=0;counts.evidence_chain_member=0;}for(const record of records)for(const reason of record.reasons)if(reason in counts)counts[reason]++;return counts;}
function buildOptionResults(options,records,selected){return options.map(option=>{const qualified=records.filter(item=>item.option_ids.includes(option.id)),candidates=selected.filter(item=>item.option_ids.includes(option.id));return{option_id:option.id,option_text:option.text,candidate_state_ids:candidates.map(item=>item.state.state_id),candidate_evidence_ids:[...new Set(candidates.flatMap(item=>item.state.evidence_ids||[]))],qualified_state_count:qualified.length,selected_state_ids:candidates.map(item=>item.state.state_id),selected_evidence_ids:[...new Set(candidates.flatMap(item=>item.state.evidence_ids||[]))]};});}
function familyCounts(states){return Object.fromEntries(STATE_FAMILIES.map(family=>[family,states.filter(state=>state.family===family).length]));}

function cleanKeywords(value){
  if(!Array.isArray(value))return[];
  return[...new Set(value.map(term=>String(term||'').normalize('NFKC').trim()).filter(term=>term.length>1&&term.length<=40))].slice(0,48);
}

function searchableStateText(state,evidenceById){
  const linked=(state.evidence_ids||[]).map(id=>evidenceById.get(id)).filter(Boolean).flatMap(item=>[item.text,item.source_text]);
  return normalize([state.value,state.family,state.status,state.polarity,...linked].filter(Boolean).join(' '));
}

function surfaceTerms(value){
  const text=normalize(value),terms=text.match(/[a-z][a-z0-9.+-]{1,}|\d+(?:\.\d+)?(?:\s*[-–—~～]\s*\d+(?:\.\d+)?)?|[\p{Script=Han}]{2,12}/gu)||[];
  return cleanKeywords(terms);
}

function dedupeStates(states){const byId=new Map();for(const state of states){const id=state.state_id||`anonymous-${byId.size}`;if(!byId.has(id)||eventOrder(state)>eventOrder(byId.get(id)))byId.set(id,state);}return[...byId.values()];}
function normalize(value){return String(value||'').normalize('NFKC').toLowerCase();}
function queryDateKeys(value){const out=new Set(),text=String(value||'').normalize('NFKC');for(const match of text.matchAll(/(20\d{2})\s*(?:[-/.年])\s*(\d{1,2})\s*(?:[-/.月])\s*(\d{1,2})(?:\s*[日号])?/gu)){const key=canonicalDateParts(match[1],match[2],match[3]);if(key)out.add(key);}for(const match of text.matchAll(/(?:^|\D)(20\d{2})(\d{2})(\d{2})(?:\D|$)/gu)){const key=canonicalDateParts(match[1],match[2],match[3]);if(key)out.add(key);}return out;}
function queryNumericSignatures(value){return numericSignatures(stripQueryDates(value));}
function questionNumericSignals(plan){
  if(shouldTreatQuestionNumbersAsBaseline(plan))return new Set();
  return queryNumericSignatures(plan.question);
}
function shouldTreatQuestionNumbersAsBaseline(plan){return['current','latest'].includes(plan.temporal_operator);}
function questionRequestsLatest(plan){return['current','latest'].includes(plan.temporal_operator);}
function anchorKeywords(plan){const supplied=cleanKeywords([...(plan.keywords||[]),plan.target,...(plan.options||[]).map(item=>item.text)]),values=supplied.length?supplied:surfaceTerms(plan.question);return values.filter(term=>!/^[0-9.%-]+$/u.test(term)).sort((a,b)=>b.length-a.length);}
function numericSignatures(value){
  const out=new Set(),text=String(value||'').normalize('NFKC').toLowerCase(),pattern=/(\d+(?:\.\d+)?)(?:\s*([-‐‑‒–—−~～至到])\s*(\d+(?:\.\d+)?))?\s*([\p{L}%]+(?:\s*\/\s*[\p{L}]+)?)?/giu;
  for(const match of text.matchAll(pattern)){
    const range=Boolean(match[2]&&match[3]),unit=canonicalNumericUnit(match[4]),first=canonicalNumber(match[1]),second=range?canonicalNumber(match[3]):null;
    if(!range&&!match[1].includes('.')&&!unit)continue;
    const core=range?`${first}~${second}`:first;out.add(core);if(unit)out.add(`${core}${unit}`);
  }
  return out;
}
function stripQueryDates(value){return String(value||'').normalize('NFKC').replace(/20\d{2}\s*(?:[-/.年])\s*\d{1,2}\s*(?:[-/.月])\s*\d{1,2}(?:\s*[日号])?/gu,' ').replace(/(?:^|\D)20\d{6}(?=\D|$)/gu,' ');}
function canonicalNumber(value){const number=Number(value);return Number.isFinite(number)?String(number):String(value);}
function canonicalNumericUnit(value){const unit=String(value||'').replace(/\s+/g,'').toLowerCase();if(['kg','公斤','千克'].includes(unit))return'kg';return unit;}
function compareEvidenceTime(left,right,plan){const a=Date.parse(left?.event_time||''),b=Date.parse(right?.event_time||'');if(!Number.isFinite(a)||!Number.isFinite(b)||a===b)return 0;return plan.temporal_operator==='earliest'?a-b:b-a;}
function compareAnchorTime(left,right,plan){const a=Date.parse(left?.event_time||''),b=Date.parse(right?.event_time||'');if(!Number.isFinite(a)||!Number.isFinite(b)||a===b)return 0;return plan.temporal_operator==='earliest'?a-b:b-a;}
function sessionEvidenceScore(item,plan,{keywords,target,requestedDates,requestedMonthDays,requestedMonths,requestedNumericValues}){const text=normalize([item.text,item.source_text].filter(Boolean).join(' ')),date=canonicalDateKey(item.event_time),monthDay=canonicalMonthDayKey(item.event_time),month=canonicalMonthKey(item.event_time);let score=0;if(date&&requestedDates.has(date))score+=4;if(monthDay&&requestedMonthDays.has(monthDay))score+=4;if(month&&requestedMonths.has(month))score+=3;if(target&&text.includes(target))score+=5;for(const term of keywords)if(text.includes(normalize(term)))score+=Math.min(4,1+normalize(term).length/6);const numeric=numericSignatures(text);for(const value of requestedNumericValues)if(numeric.has(value))score+=4;if(['current','latest'].includes(plan.temporal_operator))score+=Math.max(0,eventOrder(item)/1e13);return score;}
function nonRedundantKeywordMatches(terms,text){const matched=[];for(const term of [...terms].sort((a,b)=>normalize(b).length-normalize(a).length)){const key=normalize(term);if(!key||!text.includes(key)||matched.some(value=>normalize(value).includes(key)))continue;matched.push(term);}return matched;}
function selectSessionAnchors(ranked,plan,limit){
  if(ranked.length<=1)return ranked.slice(0,limit);
  const selected=[],add=item=>{if(item&&!selected.some(value=>value.key===item.key)&&selected.length<limit)selected.push(item);};
  const dateConstrained=queryDateKeys(plan.question).size||queryMonthDayKeys(plan.question).size||queryMonthKeys(plan.question).size;
  if(['current','latest'].includes(plan.temporal_operator)){
    const pool=anchorSpecificRows(ranked),ordered=[...pool].sort((a,b)=>b.answer_signal-a.answer_signal||compareAnchorTime(a,b,plan)||b.score-a.score);
    for(const item of ordered)add(item);
    return selected;
  }
  if(plan.temporal_operator==='earliest'&&!dateConstrained){
    const pool=temporalOccurrenceRows(ranked,plan),specific=anchorSpecificRows(pool),ordered=[...specific].sort((a,b)=>temporalDiscriminationScore(b,plan)-temporalDiscriminationScore(a,plan)||compareAnchorTime(a,b,plan)||b.score-a.score);
    for(const item of ordered)add(item);
    return selected;
  }
  for(const item of ranked)add(item);
  return selected;
}
function anchorSpecificRows(rows){const specific=rows.filter(item=>item.matched_numeric_values.length||item.matched_keywords.some(term=>normalize(term).length>=2));return specific.length?specific:rows;}
function temporalOccurrenceRows(rows,plan){
  const requested=questionNumericSignals(plan),keywords=anchorKeywords(plan).map(normalize).filter(term=>term.length>=2);
  let pool=rows;
  if(requested.size){const numeric=pool.filter(group=>{const values=numericSignatures(sessionAnchorText(group));return[...requested].some(value=>values.has(value));});if(numeric.length)pool=numeric;}
  if(keywords.length){const lexical=pool.map(group=>({group,count:keywords.filter(term=>sessionAnchorText(group).includes(term)).length})),best=Math.max(0,...lexical.map(item=>item.count)),matched=lexical.filter(item=>item.count===best&&item.count>0).map(item=>item.group);if(matched.length)pool=matched;}
  return pool;
}
function sessionAnchorText(item){return normalize(item.items.flatMap(value=>[value.text,value.source_text]).filter(Boolean).join(' '));}
function temporalDiscriminationScore(item,plan){
  const text=sessionAnchorText(item),requested=questionNumericSignals(plan),values=numericSignatures(text),keywords=anchorKeywords(plan).map(normalize);
  let score=Number(item.answer_signal||0)*2+Number(item.score||0);
  if(requested.size&&[...requested].some(value=>values.has(value)))score+=24;
  score+=keywords.filter(term=>term.length>=2&&text.includes(term)).length*4;
  return score;
}
function answerEvidenceScore(item,plan){
  const question=String(plan.question||''),text=normalize([item.text,item.source_text].filter(Boolean).join(' ')),keywords=anchorKeywords(plan).map(normalize),requestedNumbers=questionNumericSignals(plan),itemNumbers=numericSignatures(text);
  let score=String(item.source_type||'').toLowerCase()==='patient'?1:0;
  score+=keywords.filter(term=>term.length>=2&&text.includes(term)).length*3;
  if([...requestedNumbers].some(value=>itemNumbers.has(value)))score+=8;
  if(queryDateKeys(question).has(canonicalDateKey(item.event_time)))score+=12;
  return score;
}
function answerTopicMatch(plan,text){return anchorKeywords(plan).map(normalize).some(term=>term.length>=2&&text.includes(term));}
function diverseEvidenceSeeds(local,limit,plan={}){
  const out=[],seen=new Set(),add=record=>{const id=String(record?.item?.evidence_id||'');if(id&&!seen.has(id)&&out.length<limit){seen.add(id);out.push(record);}};
  add(local[0]);
  add([...local].sort((a,b)=>b.answer_score-a.answer_score||b.total-a.total)[0]);
  if(questionNumericSignals(plan).size)add(local.find(record=>numericSignatures([record.item.text,record.item.source_text].join(' ')).size));
  add(local.find(record=>String(record.item.source_type||'').toLowerCase()==='patient'));
  for(const record of local)add(record);
  return out;
}
function evidenceSequence(item){const match=/:llm:(\d+)$/.exec(String(item?.evidence_id||'')),observation=String(item?.observation_id||'');return match&&observation?{observation,ordinal:Number(match[1])}:null;}
function evidenceSequenceKey(item){const value=evidenceSequence(item);return value?`${value.observation}\u0000${value.ordinal}`:null;}
function evidenceOrdinal(item){return evidenceSequence(item)?.ordinal??Number.MAX_SAFE_INTEGER;}
function canonicalDateKey(value){const match=/^(20\d{2})-(\d{1,2})-(\d{1,2})/.exec(String(value||''));return match?canonicalDateParts(match[1],match[2],match[3]):null;}
function canonicalMonthDayKey(value){const match=/^20\d{2}-(\d{1,2})-(\d{1,2})/.exec(String(value||''));return match?`${String(Number(match[1])).padStart(2,'0')}-${String(Number(match[2])).padStart(2,'0')}`:null;}
function canonicalMonthKey(value){const match=/^(20\d{2})-(\d{1,2})/.exec(String(value||''));return match?`${match[1]}-${String(Number(match[2])).padStart(2,'0')}`:null;}
function queryMonthKeys(value){const out=new Set(),text=String(value||'').normalize('NFKC');for(const match of text.matchAll(/(?:(20)?(\d{2})\s*年\s*)?(\d{1,2})\s*月/gu)){const year=match[2]?Number(`${match[1]||'20'}${match[2]}`):null,month=Number(match[3]);if(year>=2000&&year<=2099&&month>=1&&month<=12)out.add(`${year}-${String(month).padStart(2,'0')}`);}for(const date of queryDateKeys(text))out.add(date.slice(0,7));return out;}
function queryMonthDayKeys(value){const out=new Set(),text=String(value||'').normalize('NFKC');for(const match of text.matchAll(/(?:20\d{2}\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/gu)){const month=Number(match[1]),day=Number(match[2]);if(month>=1&&month<=12&&day>=1&&day<=31)out.add(`${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`);}return out;}
function canonicalDateParts(year,month,day){const y=Number(year),m=Number(month),d=Number(day);if(y<2000||y>2099||m<1||m>12||d<1||d>31)return null;return`${String(y).padStart(4,'0')}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;}
function eventOrder(state){const time=Date.parse(state?.event_time||'');if(Number.isFinite(time))return time;const session=/session-(\d+)/.exec(state?.episode_id||'');return session?Number(session[1]):0;}
function idOrder(a,b){return String(a.state_id).localeCompare(String(b.state_id));}
function parseOptions(question){const options=[];for(const match of String(question||'').matchAll(/(?:^|\n)\s*([A-Z])[.、)]\s*([^\n]+)/g))options.push({id:match[1].toUpperCase(),text:match[2].trim()});return options;}
function positiveInteger(value){const number=Number(value);return Number.isInteger(number)&&number>0?number:null;}
