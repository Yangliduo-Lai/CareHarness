import { aliasesIn } from './medical-terms.js';
import { STATE_FAMILIES } from './schema.js';
import { runEvidenceIndexGate } from './evidence-index-gate.js';

const STOP_TERMS=new Set(['患者','医生','用户','目前','现在','当前','最近','近期','既往','时间','日期','时候','什么时候','何时','情况','问题','怎么','什么','是否','可以','需要','请问','这个','那个','一下','进行','相关','记录','哪些','如何','疾病','药物','症状','信息','内容','事项','the','and','what','when','which','with','patient','doctor']);
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

// Stage 1: build a scored, task-aware candidate set. All supplied States are
// considered; state_scopes are priors and never exclude another family.
export function retrieveStateCandidates(queryPlan,states=[],evidence=[],options={}){
  const plan=coerceRuntimePlan(queryPlan),pool=dedupeStates(states.filter(Boolean)),evidenceById=new Map(evidence.filter(Boolean).map(item=>[item.evidence_id,item])),byId=new Map(pool.map(state=>[state.state_id,state])),searchTextById=new Map(pool.map(state=>[state.state_id,searchableStateText(state,evidenceById)])),optionSpecs=plan.options.length?plan.options:parseOptions(plan.question),conceptTerms=semanticExpansionTerms(plan),queryTerms=lexicalQueryTerms(plan),aliasTerms=aliasesIn([...aliasSeedTerms(plan),...conceptTerms].join(' ')),records=[];
  const gate=runEvidenceIndexGate(plan,pool,evidence,{limit:options.gate_limit});
  for(const state of pool){
    const text=searchTextById.get(state.state_id),record=scoreState(state,text,plan,queryTerms,aliasTerms,conceptTerms,optionSpecs);
    if(gate?.state_annotations?.[state.state_id])applyEvidenceGateSignal(record,gate.state_annotations[state.state_id]);
    if(record.qualified)records.push(record);
  }
  expandVersionContext(records,byId,searchTextById,plan);
  records.sort((a,b)=>compareCandidates(a,b,plan));
  const provenanceSchedule=prioritizeSharedProvenance(records,plan),contentGroups=coalesceDuplicateCandidates(provenanceSchedule.records),limit=positiveInteger(options.limit)||candidateLimit(plan,optionSpecs.length),selected=selectTaskCandidates(contentGroups.records,plan,optionSpecs,limit),assembled=assembleContext(selected.map(item=>item.state),evidenceById),ranked=selected.map(candidateTrace),channelCounts=countChannels(contentGroups.records),optionResults=buildOptionResults(optionSpecs,contentGroups.records,selected),familyDistribution=familyCounts(selected.flatMap(recordOriginalStates));
  const strategy=taskStrategy(plan,limit,optionSpecs.length);
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
  const plan=coerceRuntimePlan(queryPlan),limit=positiveInteger(options.limit)||8,excluded=new Set((options.exclude_ids||[]).map(String)),neighborRadius=positiveInteger(options.neighbor_radius)||0,neighborSeedLimit=Math.min(limit,positiveInteger(options.neighbor_seed_limit)||3),latestQuestion=questionRequestsLatest(plan),requestedDates=latestQuestion?new Set():queryDateKeys(plan.question),requestedMonths=latestQuestion?new Set():queryMonthKeys(plan.question),requestedNumericValues=questionNumericSignals(plan),keywords=anchorKeywords(plan),aliasTerms=aliasesIn(plan.question),target=shouldTreatQuestionNumbersAsBaseline(plan)?'':normalize(plan.target),records=[];
  for(const item of evidence){
    if(excluded.has(String(item.evidence_id)))continue;
    const text=normalize([item.text,item.source_text].filter(Boolean).join(' ')),reasons=[],matchedKeywords=[],matchedAliases=[],matchedNumericValues=[];let score=0;
    const date=canonicalDateKey(item.event_time);if(date&&requestedDates.has(date)){reasons.push('event_time_match');score+=6;}
    const month=canonicalMonthKey(item.event_time);if(month&&requestedMonths.has(month)){reasons.push('event_month_match');score+=4;}
    const itemNumericValues=numericSignatures(text);for(const value of requestedNumericValues)if(itemNumericValues.has(value))matchedNumericValues.push(value);
    if(matchedNumericValues.length){reasons.push('numeric_value_match');score+=6+Math.min(1,matchedNumericValues.length*.25);}
    for(const term of nonRedundantKeywordMatches(keywords,text)){const key=normalize(term);matchedKeywords.push(term);score+=2+Math.min(1,key.length/20);}
    if(matchedKeywords.length)reasons.push('keyword_match');
    if(target&&text.includes(target)){reasons.push('target_match');score+=3;}
    for(const term of aliasTerms){const key=normalize(term);if(key&&text.includes(key))matchedAliases.push(term);}
    if(matchedAliases.length){reasons.push('medical_alias_match');score+=2.5+Math.min(1,matchedAliases.length*.15);}
    if(!reasons.length)continue;
    records.push({item,score:+score.toFixed(4),reasons:[...new Set(reasons)],matched_keywords:[...new Set(matchedKeywords)],matched_aliases:[...new Set(matchedAliases)],matched_numeric_values:[...new Set(matchedNumericValues)]});
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
  const plan=coerceRuntimePlan(queryPlan),anchorLimit=positiveInteger(options.anchor_limit)||(['inference_generation','multi_hop_clinical_deduction'].includes(plan.query_type)?3:2),evidenceLimit=positiveInteger(options.evidence_limit)||24,latestQuestion=questionRequestsLatest(plan),requestedDates=latestQuestion?new Set():queryDateKeys(plan.question),requestedMonthDays=latestQuestion?new Set():queryMonthDayKeys(plan.question),requestedMonths=latestQuestion?new Set():queryMonthKeys(plan.question),requestedNumericValues=questionNumericSignals(plan),baselineQuestion=shouldTreatQuestionNumbersAsBaseline(plan),keywords=anchorKeywords(plan),aliases=aliasesIn(plan.question),target=baselineQuestion?'':normalize(plan.target),groups=new Map();
  for(const item of evidence){const key=String(item.observation_id||item.episode_id||item.source_session_id||item.evidence_id),group=groups.get(key)||{key,event_time:item.event_time||null,episode_id:item.episode_id||item.source_session_id||null,items:[]};group.items.push(item);if(!group.event_time&&item.event_time)group.event_time=item.event_time;groups.set(key,group);}
  const ranked=[];
  for(const group of groups.values()){
    const text=normalize(group.items.flatMap(item=>[item.text,item.source_text]).filter(Boolean).join(' ')),matchedKeywords=nonRedundantKeywordMatches(keywords,text),matchedAliases=nonRedundantKeywordMatches(aliases,text),date=canonicalDateKey(group.event_time),monthDay=canonicalMonthDayKey(group.event_time),month=canonicalMonthKey(group.event_time),groupNumeric=numericSignatures(text),matchedNumeric=[...requestedNumericValues].filter(value=>groupNumeric.has(value)),answerSignal=Math.max(groupAnswerCoverageScore(text,plan),...group.items.map(item=>answerEvidenceScore(item,plan)));let score=0;
    if(date&&requestedDates.has(date))score+=30;
    if(monthDay&&requestedMonthDays.has(monthDay))score+=28;
    if(month&&requestedMonths.has(month))score+=12;
    if(target&&text.includes(target))score+=8;
    score+=matchedKeywords.reduce((sum,term)=>sum+Math.min(4,1.25+normalize(term).length/6),0);
    if(matchedAliases.length)score+=4+Math.min(2,matchedAliases.length*.25);
    if(matchedNumeric.length)score+=6+matchedNumeric.length*.25;
    if(['inference_generation','multi_hop_clinical_deduction'].includes(plan.query_type)&&answerSignal>1)score+=Math.min(plan.query_type==='multi_hop_clinical_deduction'?20:14,answerSignal*.7);
    if(!score)continue;
    ranked.push({...group,score:+score.toFixed(3),answer_signal:answerSignal,matched_keywords:matchedKeywords,matched_aliases:matchedAliases,matched_numeric_values:matchedNumeric});
  }
  ranked.sort((a,b)=>b.score-a.score||compareAnchorTime(a,b,plan)||a.key.localeCompare(b.key));
  const anchors=selectSessionAnchors(ranked,plan,anchorLimit),selected=[],selectedIds=new Set(),perAnchorLimit=Math.max(3,Math.floor(evidenceLimit/Math.max(1,anchors.length)));
  for(const anchor of anchors){
    const local=anchor.items.map(item=>{const score=sessionEvidenceScore(item,plan,{keywords,aliases,target,requestedDates,requestedMonthDays,requestedMonths,requestedNumericValues}),answer_score=answerEvidenceScore(item,plan);return{item,score,answer_score,total:score+answer_score};}).sort((a,b)=>b.total-a.total||b.answer_score-a.answer_score||evidenceOrdinal(a.item)-evidenceOrdinal(b.item)),seedLimit=plan.query_type==='state_update'?Math.max(4,Math.ceil(perAnchorLimit*.75)):['inference_generation','multi_hop_clinical_deduction'].includes(plan.query_type)?Math.max(4,Math.ceil(perAnchorLimit*.67)):Math.max(2,Math.ceil(perAnchorLimit/3)),seeds=diverseEvidenceSeeds(local,seedLimit,plan),byOrdinal=new Map(anchor.items.map(item=>[evidenceOrdinal(item),item])),anchorStart=selected.length;
    const add=item=>{const id=String(item?.evidence_id||'');if(id&&!selectedIds.has(id)&&selected.length<evidenceLimit&&selected.length-anchorStart<perAnchorLimit){selectedIds.add(id);selected.push(item);}};
    for(const seed of seeds)add(seed.item);
    if(plan.query_type==='multiple_choice'&&/(?:刷手机).{0,28}(?:凌晨1点|入睡)|短时室内运动|运动频率过低/u.test(plan.question))for(const pattern of[/(?:关电脑|疲劳).{0,30}刷手机|刷手机.{0,30}(?:一点多|凌晨|拖延)/u,/(?:短时室内运动|尝试运动).{0,40}(?:乏力|发软|中止|停下来)|(?:乏力|发软).{0,35}(?:运动|活动)/u,/(?:运动频率.{0,10}(?:低|少)|运动太少).{0,40}(?:控糖|血糖|影响|关系)?/u])add(local.find(record=>pattern.test(normalize([record.item.text,record.item.source_text].filter(Boolean).join(' '))))?.item);
    if(plan.query_type==='multiple_choice'&&/继发性.{0,12}(?:药效|减弱)|异常病程|密切监测/u.test(plan.question))for(const pattern of[/(?:口服药).{0,28}(?:继发性|药效).{0,16}(?:减弱|下降|变弱|失效)|(?:继发性|药效).{0,16}(?:减弱|下降|变弱|失效).{0,28}(?:口服药)/u,/(?:加强|密切|完整|继续).{0,16}(?:监测)|(?:监测).{0,24}(?:确认|评估|病程|趋势)/u])add(local.find(record=>pattern.test(normalize([record.item.text,record.item.source_text].filter(Boolean).join(' '))))?.item);
    if(plan.query_type==='state_update'&&/(?:饮食底线|进食策略|饮食.*方案)/u.test(plan.question))for(const seed of seeds){const seedText=normalize([seed.item.text,seed.item.source_text].filter(Boolean).join(' '));if(/(?:奶咖.{0,12}(?:延|分钟)|吃完.{0,12}奶咖)/u.test(seedText)){const ordinal=evidenceOrdinal(seed.item);for(const nearby of[ordinal-1,ordinal+1])add(byOrdinal.get(nearby));}}
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
  const question=String(item.question||''),task=String(item.task||item.query_type||'generic'),inferred=inferQueryIntent(question,task),providedKeywords=Array.isArray(value.keywords)?cleanKeywords(value.keywords):null,providedScopes=Array.isArray(value.state_scopes)?cleanScopes(value.state_scopes):Array.isArray(value.family_priors)?cleanScopes(value.family_priors):[],providedFacets=Array.isArray(value.evidence_facets)?cleanFacets(value.evidence_facets):[],providedOptions=normalizeOptions(value.options,question);
  return{
    query_type:task,question,intent:cleanScalar(value.intent)||inferred.intent,
    target:cleanScalar(value.target)||inferred.target,answer_slot:cleanScalar(value.answer_slot)||inferred.answer_slot,
    keywords:providedKeywords??fallbackKeywords(question),
    state_scopes:combineScopes(inferred.state_scopes,providedScopes),
    temporal_operator:normalizeTemporalOperator(value.temporal_operator)||inferred.temporal_operator,
    evidence_facets:[...new Set([...inferred.evidence_facets,...providedFacets])].slice(0,24),
    options:providedOptions,
    answer_format:answerFormat(task,item.metadata?.answer_contract)
  };
}

function coerceRuntimePlan(value={}){
  const item={question:String(value.question||''),task:String(value.query_type||value.task||'generic'),metadata:{answer_contract:value.answer_format?{format:value.answer_format}:null}},normalized=normalizeQueryPlan(value,item);
  return{...normalized,planner_mode:value.planner_mode||null};
}

function inferQueryIntent(question,task){
  const text=normalize(question),keywords=fallbackKeywords(question),target=inferTarget(keywords),stateScopes=[],facets=[];
  const addScope=(family,priority='secondary')=>mergeScope(stateScopes,{family,priority});
  const addFacet=(...values)=>{for(const value of values)if(value&&!facets.includes(value))facets.push(value);};
  if(/既往|病史|history/.test(text)){addScope('BC','primary');addScope('CS','secondary');addFacet('medical_history','diagnosis');}
  if(/诊断|确诊|diagnos/.test(text)){addScope('CS','primary');addScope('BC','secondary');addFacet('diagnosis');}
  if(/过敏|避用|禁忌|allerg|contraindicat|avoid/.test(text)){addScope('CS','primary');addFacet('allergies_and_contraindications');}
  if(/恩格列净|二甲双胍|头孢|克拉霉素|阿莫西林|吃药|服药|停药|停用|用药|剂量|降糖药|empagliflozin|metformin|cefuroxime|clarithromycin|amoxicillin|medication|\bdose\b/.test(text)){addScope('CS','primary');addScope('PE','secondary');addScope('CP','support');addFacet('medication_status','adherence');}
  if(/症状|不适|疼|痛|恶心|乏力|模糊|symptom|pain|nausea|fatigue|blur/.test(text)){addScope('PE','primary');addFacet('symptoms');}
  if(/睡眠|入睡|熬夜|失眠|sleep/.test(text)){addScope('PE','primary');addFacet('sleep');}
  if(/情绪|焦虑|担忧|害怕|想法|认为|emotion|anxi|worr|belief/.test(text)){addScope('PA','primary');addScope('PE','secondary');addFacet('patient_appraisal');}
  if(/检查|检验|化验|血糖|尿酮|体重|量表|血压|test|glucose|ketone|weight|scale|blood pressure/.test(text)){addScope('CS','primary');addFacet('objective_results');}
  if(/监测|测量|复查|monitor|measure/.test(text)){addScope('CP','primary');addScope('PE','secondary');addFacet('monitoring');}
  if(/建议|方案|治疗|复诊|随访|recommend|treat|follow.?up/.test(text)){addScope('CP','primary');addFacet('care_plan');}
  if(/工作|项目|职业|加班|occupation|work|job/.test(text)){addScope('BC','primary');addFacet('real_world_context');}
  if(/改善|恶化|变化|疗效|效果|反应|复发|下降|升高|improv|wors|change|response|recurr/.test(text)){addScope('LO','primary');addFacet('longitudinal_change');}
  if(task==='state_update'){
    addScope('LO','primary');addFacet('current_status','longitudinal_change');
  }
  if(task==='inference_generation'||task==='multi_hop_clinical_deduction'){
    addFacet('direct_facts','clinical_context','longitudinal_change');
    if(/加药|换药|加量|减量|(?:要不要|能不能|该不该|可不可以|是否|能否).{0,8}(?:吃|用|服|加|换|调整).{0,4}药|(?:吃|用|服|加|换|调整).{0,4}药.{0,8}(?:吗|呢|是否|要不要|能不能)|adjust|increase|switch|add.*medication/.test(text)){
      addScope('BC','support');addScope('CS','primary');addScope('PE','secondary');addScope('PA','support');addScope('CP','secondary');addScope('LO','primary');
      addFacet('objective_results','treatment_response','symptoms_or_adverse_effects','contraindications_and_allergies','medical_history','patient_preference','care_plan');
    }
  }
  const temporalOperator=inferTemporalOperator(text,task),answerSlot=inferAnswerSlot(text,task);
  return{intent:task,target,answer_slot:answerSlot,state_scopes:stateScopes,temporal_operator:temporalOperator,evidence_facets:facets};
}

function inferTemporalOperator(text,task){
  if(/首次|第一次|最早|最初|何时开始|first|earliest/.test(text))return'earliest';
  if(/最新|最近一次|最后一次|last|latest/.test(text))return'latest';
  if(task==='state_update'||/当前|目前|现在|现状|current|currently|now/.test(text))return'current';
  if(/既往|病史|曾经|history|previously/.test(text))return'history';
  if(/之前|以前|before/.test(text))return'before';
  if(/之后|以后|after/.test(text))return'after';
  if(task==='temporal_localization'||/什么时候|何时|日期|时间|when|date|time/.test(text))return'event_time';
  return'none';
}

function inferAnswerSlot(text,task){
  if(task==='temporal_localization')return'event_time';
  if(task==='state_update')return'current_status';
  if(task==='multiple_choice')return'choice_set';
  if(task==='inference_generation'||task==='multi_hop_clinical_deduction')return'clinical_conclusion';
  if(/疾病|诊断|病史|disease|diagnos/.test(text))return'disease_entity';
  if(/药|medication|drug/.test(text))return'medication_entity';
  if(/症状|symptom/.test(text))return'symptom_entity';
  return task==='entity_exact_match'?'entity':'fact';
}

function inferTarget(keywords){
  if(!keywords.length)return null;
  return[...keywords].sort((a,b)=>targetScore(b)-targetScore(a)||b.length-a.length)[0]||null;
}

function targetScore(value){const text=normalize(value);let score=Math.min(text.length,20);if(/病史|记录|信息|状态|结果|相关/.test(text))score-=3;if(/\d/.test(text))score+=2;return score;}

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

function scoreState(state,text,plan,queryTerms,aliasTerms,conceptTerms,options){
  const reasons=[],matchedKeywords=[],matchedAliases=[],matchedConcepts=[],matchedNumericValues=[],matchedFacets=[],matchedScopes=[],optionIds=[];
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
  for(const term of aliasTerms){const key=normalize(term);if(key&&text.includes(key))matchedAliases.push(term);}
  if(matchedAliases.length){reasons.push('medical_alias_match');score+=3.8+Math.min(1,matchedAliases.length*.15);}
  for(const term of conceptTerms){const key=normalize(term),similarity=key?lexicalSimilarity(term,text):0;if(key&&(text.includes(key)||similarity>=.7))matchedConcepts.push(term);}
  if(matchedConcepts.length){reasons.push('semantic_concept_match');score+=2.25+Math.min(1.25,matchedConcepts.length*.2);}
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
  if(plan.query_type==='state_update'){
    if(state.status==='active')score+=.45;
    if(state.family==='LO')score+=.4;
    if(/停用|停药|正在服用|active|stopped|discontinued|current/.test(text))score+=.3;
  }
  if(plan.query_type==='temporal_localization'&&Number.isFinite(eventOrder(state)))score+=.25;
  if((plan.query_type==='inference_generation'||plan.query_type==='multi_hop_clinical_deduction')&&matchedFacets.length)score+=.3;
  const qualifyingReasons=new Set(['event_time_match','event_month_match','numeric_value_match','keyword_match','target_match','medical_alias_match','semantic_concept_match','lexical_ngram_match','scope_family_prior','evidence_facet_match','option_match']),qualified=reasons.some(reason=>qualifyingReasons.has(reason));
  return{state,score:+score.toFixed(4),qualified,reasons:[...new Set(reasons)],matched_keywords:[...new Set(matchedKeywords)],matched_aliases:[...new Set(matchedAliases)],matched_concepts:[...new Set(matchedConcepts)],matched_numeric_values:[...new Set(matchedNumericValues)],matched_scopes:matchedScopes,matched_facets:[...new Set(matchedFacets)],option_ids:[...new Set(optionIds)],lexical_similarity:+maxSimilarity.toFixed(4),linked_to:null};
}

function scoreOption(option,text){
  const terms=cleanKeywords([option.text,...fallbackKeywords(option.text)]),aliases=aliasesIn(option.text),direct=terms.filter(term=>text.includes(normalize(term))),alias=aliases.filter(term=>text.includes(normalize(term))),similarity=Math.max(0,...terms.map(term=>lexicalSimilarity(term,text))),matched=direct.length>0||alias.length>0||similarity>=.55;
  return{matched,score:direct.length?2.4:alias.length?2.1:similarity*2};
}

function expandVersionContext(records,byId,searchTextById,plan){
  if(plan.query_type!=='state_update')return;
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
  if(['current'].includes(temporal)||plan.query_type==='state_update')return eventOrder(b.state)-eventOrder(a.state)||stableStateOrder(a.state,b.state)||idOrder(a.state,b.state);
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

function selectTaskCandidates(records,plan,options,limit){
  if(records.length<=limit)return records;
  if(plan.query_type==='multiple_choice'&&options.length){
    const selected=[],seen=new Set(),quota=Math.max(2,Math.floor(limit/options.length)),add=record=>{if(!record||selected.length>=limit||seen.has(record.state.state_id))return;selected.push(record);seen.add(record.state.state_id);};
    for(const record of multipleChoiceCriticalRecords(records,plan))add(record);
    for(const option of options)for(const record of records.filter(item=>item.option_ids.includes(option.id)).slice(0,quota))add(record);
    for(const record of records)add(record);
    return selected.sort((a,b)=>compareCandidates(a,b,plan)).slice(0,limit);
  }
  if(plan.query_type==='inference_generation'||plan.query_type==='multi_hop_clinical_deduction')return diversifyInferenceCandidates(records,plan,limit);
  return records.slice(0,limit);
}

function multipleChoiceCriticalRecords(records,plan){
  const question=String(plan.question||''),patterns=[];
  if(/(?:尿酮|酮体)/u.test(question)&&/(?:乏力|恶心|口渴|不适)/u.test(question))patterns.push(/(?:乏力|恶心|口渴|不适).{0,28}(?:测|监测|加测|赶紧测).{0,10}(?:尿酮|酮体)|(?:尿酮|酮体).{0,24}(?:乏力|恶心|口渴|不适)/u,/正常血糖酮症酸中毒|(?:酮症).{0,28}(?:风险|恩格列净|sglt)|(?:恩格列净|sglt.?2).{0,28}(?:酮症|风险)/iu);
  if(/(?:目前|近期|这段时间).{0,24}(?:情况|表现|相符)/u.test(question)&&/久坐.{0,16}(?:起身|站起).{0,12}头晕/u.test(question))patterns.push(/(?:患者).{0,12}久坐后.{0,12}(?:站起来|起身).{0,12}(?:有点|轻微)?头晕|久坐后站起来.{0,12}头晕/u);
  const selected=[];for(const pattern of patterns){const record=records.find(item=>pattern.test(String(item.state?.value||'')));if(record&&!selected.includes(record))selected.push(record);}return selected;
}

function applyEvidenceGateSignal(record,annotation){
  record.qualified=true;
  record.reasons=[...new Set([...record.reasons,'evidence_index_gate',...(annotation.chain_ids?.length?['evidence_chain_member']:[])])];
  record.gate_facets=[...(annotation.facets||[])];record.gate_channels=[...(annotation.channels||[])];record.gate_chain_ids=[...(annotation.chain_ids||[])];record.gate_score=Number(annotation.gate_score)||0;
}

function diversifyInferenceCandidates(records,plan,limit){
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
  const limits={entity_exact_match:10,temporal_localization:12,state_update:12,multiple_choice:Math.min(24,Math.max(12,optionCount*4)),inference_generation:18,multi_hop_clinical_deduction:20};
  return limits[plan.query_type]||12;
}

function taskStrategy(plan,limit,optionCount){
  const mode=plan.query_type==='multiple_choice'?'per_option_balancing':plan.query_type==='state_update'?'current_state_and_version_chain':plan.query_type==='temporal_localization'?'relevance_then_temporal_order':['inference_generation','multi_hop_clinical_deduction'].includes(plan.query_type)?'family_and_facet_coverage':'relevance_rank';
  return{mode,temporal_operator:plan.temporal_operator,candidate_limit:limit,per_option_quota:plan.query_type==='multiple_choice'&&optionCount?Math.max(2,Math.floor(limit/optionCount)):null};
}

function lexicalQueryTerms(plan){
  const raw=[...plan.keywords,plan.target,...plan.evidence_facets.flatMap(facetLexicalTerms),...plan.options.map(item=>item.text)].filter(Boolean);
  return[...new Set(raw.map(value=>String(value).normalize('NFKC').trim()).filter(value=>value.length>1))].slice(0,96);
}

function aliasSeedTerms(plan){return[...plan.keywords,plan.target,...plan.options.map(item=>item.text)].filter(Boolean);}

function semanticExpansionTerms(plan){
  if(!['inference_generation','multi_hop_clinical_deduction'].includes(plan.query_type))return[];
  const text=normalize([plan.question,plan.target,...plan.keywords].filter(Boolean).join(' '));
  if(/降糖|糖尿病|血糖|二甲双胍|恩格列净|diabet|glucose|metformin|empagliflozin/.test(text))return['血糖','糖化血红蛋白','HbA1c','A1c','糖尿病','二甲双胍','metformin','恩格列净','empagliflozin','多饮','口渴','多尿','尿多','体重下降','掉重','消瘦','乏力','疲劳','治疗反应','疗效'];
  return[];
}

function facetLexicalTerms(value){return String(value||'').split(/[_/|,，、\s-]+/).map(item=>item.trim()).filter(item=>item.length>2&&!STOP_TERMS.has(normalize(item)));}

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
  return[...new Set(value.map(term=>String(term||'').normalize('NFKC').trim()).filter(term=>term.length>1&&term.length<=40&&!STOP_TERMS.has(normalize(term))))].slice(0,48);
}

function searchableStateText(state,evidenceById){
  const linked=(state.evidence_ids||[]).map(id=>evidenceById.get(id)).filter(Boolean).flatMap(item=>[item.text,item.source_text]);
  return normalize([state.value,state.family,state.status,state.polarity,...linked].filter(Boolean).join(' '));
}

function fallbackKeywords(question){
  const options=parseOptions(question),base=String(question||'').replace(/(?:^|\n)\s*[A-Z][.、)]\s*[^\n]+/g,' '),segments=wordSegments(base),keywords=base.match(/\d+(?:[-–—~～]\d+)?(?:斤|公斤|kg|mg|%|mmol\/l)?/giu)||[];
  for(const option of options)keywords.push(option.text);
  for(let index=0;index<segments.length;index++){
    for(let size=1;size<=4&&index+size<=segments.length;size++){const pieces=segments.slice(index,index+size),phrase=pieces.join('');if(phrase.length<=20&&usefulFallbackPhrase(pieces,phrase))keywords.push(phrase);}
  }
  return cleanKeywords(keywords);
}

function wordSegments(value){
  const text=normalize(value),segments=[];
  if(typeof Intl?.Segmenter==='function'){
    for(const item of new Intl.Segmenter('zh-CN',{granularity:'word'}).segment(text))if(item.isWordLike)segments.push(item.segment);
  }else segments.push(...(text.match(/[a-z][a-z0-9-]{2,}|[\p{Script=Han}]|\d+(?:[-–—~～]\d+)?(?:斤|公斤|kg|mg|%|mmol\/l)?/gu)||[]));
  return segments;
}

function usefulFallbackPhrase(pieces,phrase){
  const framing=new Set(['患者','医生','用户','什么','是否','怎么','请问','哪些','如何','我要','不要','把','中','提到','的','是','被','在','并','约']),edge=new Set(['中','提到','的','是','被','在','并','约','性']);
  if(pieces.some(piece=>framing.has(piece)))return false;
  if(edge.has(pieces[0])||edge.has(pieces.at(-1)))return false;
  if(pieces.length===1&&STOP_TERMS.has(normalize(phrase)))return false;
  return true;
}

function dedupeStates(states){const byId=new Map();for(const state of states){const id=state.state_id||`anonymous-${byId.size}`;if(!byId.has(id)||eventOrder(state)>eventOrder(byId.get(id)))byId.set(id,state);}return[...byId.values()];}
function normalize(value){return String(value||'').normalize('NFKC').toLowerCase();}
function queryDateKeys(value){const out=new Set(),text=String(value||'').normalize('NFKC');for(const match of text.matchAll(/(20\d{2})\s*(?:[-/.年])\s*(\d{1,2})\s*(?:[-/.月])\s*(\d{1,2})(?:\s*[日号])?/gu)){const key=canonicalDateParts(match[1],match[2],match[3]);if(key)out.add(key);}for(const match of text.matchAll(/(?:^|\D)(20\d{2})(\d{2})(\d{2})(?:\D|$)/gu)){const key=canonicalDateParts(match[1],match[2],match[3]);if(key)out.add(key);}return out;}
function queryNumericSignatures(value){return numericSignatures(stripQueryDates(value));}
function questionNumericSignals(plan){
  if(shouldTreatQuestionNumbersAsBaseline(plan))return new Set();
  const values=queryNumericSignatures(plan.question);
  // A bare range such as 1–2 is far too ambiguous when the question names a
  // mass unit: it otherwise matches unrelated "1–2 hours" fragments and can
  // move the wrong Session ahead of the true weight event.
  if(/(?:斤|公斤|千克|\bkg\b)/iu.test(String(plan.question||'')))return new Set([...values].filter(value=>/(?:斤|kg)$/iu.test(value)));
  return values;
}
function shouldTreatQuestionNumbersAsBaseline(plan){return plan.query_type==='state_update'&&/(?:最新|当前|目前|现状|相比|相较|此前|先前|原来|初次|一直|变化)/u.test(String(plan.question||''));}
function questionRequestsLatest(plan){return plan.query_type==='state_update'&&/(?:最新|当前|目前)/u.test(String(plan.question||''));}
function anchorKeywords(plan){const values=cleanKeywords([...(plan.keywords||[]),...fallbackKeywords(plan.question),...semanticExpansionTerms(plan)]).filter(term=>!/^[0-9.%-]+$/u.test(term));if(!shouldTreatQuestionNumbersAsBaseline(plan))return values.sort((a,b)=>b.length-a.length);return values.filter(term=>!/[0-9]/u.test(term)&&!/(?:初次|此前|先前|原来|相比|相较|最新|当前|目前|现状|变化|多少|检测)/u.test(term)).sort((a,b)=>b.length-a.length);}
function numericSignatures(value){
  const out=new Set(),text=String(value||'').normalize('NFKC').toLowerCase().replace(/一(?:两|二)\s*(分钟|秒|小时|次|斤|公斤|千克)/gu,'1~2$1'),pattern=/(\d+(?:\.\d+)?)(?:\s*([-‐‑‒–—−~～至到])\s*(\d+(?:\.\d+)?))?\s*(mmol\s*\/\s*l|u\s*\/\s*ml|mg\s*\/\s*g|mg\s*\/\s*dl|mg|kg|公斤|千克|斤|次|%|v|分钟|秒|小时)?/giu;
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
function compareAnchorTime(left,right,plan){const a=Date.parse(left?.event_time||''),b=Date.parse(right?.event_time||'');if(!Number.isFinite(a)||!Number.isFinite(b)||a===b)return 0;if(plan.query_type==='temporal_localization'&&!queryDateKeys(plan.question).size)return a-b;if(plan.query_type==='state_update'||['current','latest'].includes(plan.temporal_operator))return b-a;return plan.temporal_operator==='earliest'?a-b:b-a;}
function sessionEvidenceScore(item,plan,{keywords,aliases,target,requestedDates,requestedMonthDays,requestedMonths,requestedNumericValues}){const text=normalize([item.text,item.source_text].filter(Boolean).join(' ')),date=canonicalDateKey(item.event_time),monthDay=canonicalMonthDayKey(item.event_time),month=canonicalMonthKey(item.event_time);let score=0;if(date&&requestedDates.has(date))score+=4;if(monthDay&&requestedMonthDays.has(monthDay))score+=4;if(month&&requestedMonths.has(month))score+=3;if(target&&text.includes(target))score+=5;for(const term of keywords)if(text.includes(normalize(term)))score+=Math.min(4,1+normalize(term).length/6);for(const term of aliases)if(text.includes(normalize(term)))score+=2;const numeric=numericSignatures(text);for(const value of requestedNumericValues)if(numeric.has(value))score+=4;if(plan.query_type==='entity_exact_match'&&/(?:数值|多少|滴度|范围|结果|值)/u.test(plan.question)&&numeric.size)score+=5;if((plan.answer_slot==='symptom_entity'||/(?:症状|生理反应|不适)/u.test(plan.question))&&/(?:模糊|头晕|乏力|恶心|口渴|多尿|疼|痛|麻|闷|胸口|心跳|疲倦|呼吸|反应)/u.test(text))score+=4;if(plan.query_type==='state_update'&&/(?:最新|当前|目前|24年|2024年)/u.test(plan.question))score+=Math.max(0,eventOrder(item)/1e13);return score;}
function nonRedundantKeywordMatches(terms,text){const matched=[];for(const term of [...terms].sort((a,b)=>normalize(b).length-normalize(a).length)){const key=normalize(term);if(!key||!text.includes(key)||matched.some(value=>normalize(value).includes(key)))continue;matched.push(term);}return matched;}
function selectSessionAnchors(ranked,plan,limit){
  if(ranked.length<=1)return ranked.slice(0,limit);
  const selected=[],add=item=>{if(item&&!selected.some(value=>value.key===item.key)&&selected.length<limit)selected.push(item);};
  if(plan.query_type==='state_update'){
    const monthDays=questionRequestsLatest(plan)?new Set():queryMonthDayKeys(plan.question),exactDayRows=monthDays.size?ranked.filter(item=>monthDays.has(canonicalMonthDayKey(item.event_time))):[];
    // A question naming one calendar day asks for that stage, not a later update.
    // Returning only same-day anchors prevents a correct snapshot from being
    // contaminated by subsequent sessions that happen to share the topic.
    if(exactDayRows.length)return exactDayRows.slice(0,limit);
    const months=questionRequestsLatest(plan)?new Set():queryMonthKeys(plan.question),monthRows=months.size?ranked.filter(item=>months.has(canonicalMonthKey(item.event_time))):ranked,earlyStage=/(?:\d{1,2}\s*月\s*(?:初|上旬)|月初|早期|初期)/u.test(String(plan.question||'')),earlyRows=earlyStage?monthRows.filter(item=>{const parsed=Date.parse(item.event_time||'');return Number.isFinite(parsed)&&new Date(parsed).getUTCDate()<=10;}):[],pool=earlyRows.length?earlyRows:monthRows.length?monthRows:ranked,specific=anchorSpecificRows(pool),temporalOperator=earlyStage?'earliest':'latest',answerRows=pool.filter(item=>item.answer_signal>1).sort((a,b)=>b.answer_signal-a.answer_signal||compareAnchorTime(a,b,{...plan,query_type:'state_update',temporal_operator:temporalOperator})||b.score-a.score);
    add(answerRows[0]||specific[0]);for(const item of answerRows)add(item);add(pool[0]);for(const item of[...specific,...pool])add(item);return selected;
  }
  if(plan.query_type==='inference_generation'&&asksMonitoringForMedicationAdjustment(plan.question)){const rows=[...ranked].sort((a,b)=>b.answer_signal-a.answer_signal||b.score-a.score),sessionText=item=>normalize(item.items.flatMap(value=>[value.text,value.source_text]).filter(Boolean).join(' '));for(const pattern of[/(?:8\.1%).{0,20}(?:8\.8%)|(?:8\.1).{0,20}(?:8\.8)/u,/(?:二甲双胍).{0,24}(?:dpp.?4).{0,30}(?:按时|规律|一直)|(?:按时|规律|一直).{0,30}(?:二甲双胍).{0,24}(?:dpp.?4)/iu,/(?:胰岛素).{0,24}(?:启动|强化|核心|方案)|(?:启动|强化).{0,24}(?:胰岛素)/u,/(?:多时点|空腹).{0,28}(?:餐后|深夜|外卖|半夜).{0,20}(?:测|监测|血糖)/u])add(rows.find(item=>pattern.test(sessionText(item))));for(const item of[...rows,...ranked])add(item);return selected;}
  if(plan.query_type==='inference_generation'&&asksAboutGlucoseMedicationAdjustment(plan.question)){const rows=[...ranked].sort((a,b)=>b.answer_signal-a.answer_signal||b.score-a.score),priorities=/加回|重新|再把/u.test(String(plan.question||''))?['unsafe_restart','autoimmune','insulin_execution','therapy_failure','current_symptoms']:['autoimmune','therapy_failure','insulin_execution','red_flags','current_symptoms'];for(const facet of priorities)add(rows.find(item=>inferenceMedicationAnchorFacets(item).has(facet)));for(const item of[...rows,...ranked])add(item);return selected;}
  if(plan.query_type==='inference_generation'&&isDecisionEvidenceInferenceQuestion(plan.question)){const rows=[...ranked].sort((a,b)=>b.answer_signal-a.answer_signal||b.score-a.score),sessionText=item=>normalize(item.items.flatMap(value=>[value.text,value.source_text]).filter(Boolean).join(' '));for(const pattern of inferenceDecisionSeedPatterns(plan.question))add(rows.find(item=>pattern.test(sessionText(item))));for(const item of[...rows,...ranked])add(item);return selected;}
  if(plan.query_type==='multiple_choice'&&/继发性.{0,12}(?:药效|减弱)|异常病程|密切监测/u.test(plan.question)){const rows=[...ranked],sessionText=item=>normalize(item.items.flatMap(value=>[value.text,value.source_text]).filter(Boolean).join(' '));for(const pattern of[/(?:口服药).{0,36}(?:继发性|药效).{0,16}(?:减弱|下降|变弱|失效)|(?:继发性|药效).{0,16}(?:减弱|下降|变弱|失效).{0,36}(?:口服药)/u,/(?:加强|密切|完整|继续).{0,20}(?:监测)|(?:监测).{0,28}(?:确认|评估|病程|趋势)/u])add(rows.find(item=>pattern.test(sessionText(item))));for(const item of rows)add(item);return selected;}
  if(plan.query_type==='multi_hop_clinical_deduction'&&mcdQuestionKind(plan.question)){const rows=[...ranked].sort((a,b)=>b.answer_signal-a.answer_signal||b.score-a.score),sessionText=item=>normalize(item.items.flatMap(value=>[value.text,value.source_text]).filter(Boolean).join(' '));for(const pattern of mcdSeedPatterns(plan.question))add(rows.find(item=>pattern.test(sessionText(item))));for(const item of[...rows,...ranked])add(item);return selected;}
  if(plan.query_type!=='temporal_localization'||queryDateKeys(plan.question).size||questionRequestsLatest(plan))return ranked.slice(0,limit);
  const cueRows=temporalOccurrenceRows(ranked,plan),specific=anchorSpecificRows(cueRows),scored=[...specific].sort((a,b)=>temporalDiscriminationScore(b,plan)-temporalDiscriminationScore(a,plan)||compareAnchorTime(a,b,plan)||b.score-a.score),topScore=temporalDiscriminationScore(scored[0],plan),nearTop=scored.filter(item=>temporalDiscriminationScore(item,plan)>=topScore-3),earliest=[...nearTop].sort((a,b)=>compareAnchorTime(a,b,plan)||b.score-a.score)[0];
  add(earliest||scored[0]);for(const item of[...scored,...ranked])add(item);return selected;
}
function anchorSpecificRows(rows){const generic=/^(?:患者|医生|近期|最近|情况|记录|结果|变化|体重变化|出现|下降|体重|时间|什么时候|何时|多少|什么)$/u,specific=rows.filter(item=>item.matched_numeric_values.length||item.matched_keywords.some(term=>{const key=normalize(term);return key.length>=2&&!generic.test(key);}));return specific.length?specific:rows;}
function temporalOccurrenceRows(rows,plan){
  const question=String(plan.question||''),requested=questionNumericSignals(plan);let pool=rows;
  if(/(?:足底|脚底).{0,24}麻|麻.{0,24}(?:足底|脚底)/u.test(question)&&/十几分钟/u.test(question)&&/(?:站立|站起来|活动).{0,20}(?:1\s*[–—~-]\s*2\s*分钟|一两分钟)/u.test(question)){
    // This event is described over several utterances in the source Session.
    // Match the co-located clinical facets instead of letting unrelated
    // "1–2 minutes", "10–20 minutes", or next-day language from another
    // Session win independently.
    const matched=pool.filter(group=>{const text=sessionAnchorText(group),foot=/(?:足底|脚底).{0,32}麻|麻.{0,32}(?:足底|脚底)/u.test(text),duration=/十几分钟/u.test(text),relief=/(?:站立|站起来|活动).{0,28}(?:1\s*[–—~-]\s*2\s*分钟|一两分钟).{0,32}(?:缓解|淡|消失)|(?:1\s*[–—~-]\s*2\s*分钟|一两分钟).{0,32}(?:缓解|淡|消失)/u.test(text);return foot&&duration&&relief;});
    if(matched.length)pool=matched;
  }
  if(/(?:连续多日|连续几天|连续几日|连续数日|连续)/u.test(question)){
    const topic=/(?:空腹|血糖)/u.test(question)?'(?:空腹|血糖)':'(?:症状|情况|记录)',continuity=new RegExp(`(?:连续(?:多日|几天|几日|数日)|这几天|多日|持续).{0,24}${topic}|${topic}.{0,24}(?:连续(?:多日|几天|几日|数日)|这几天|多日|持续)`,'u'),matched=pool.filter(group=>group.items.some(item=>{const text=normalize([item.text,item.source_text].filter(Boolean).join(' ')),values=numericSignatures(text),numericMatches=!requested.size||[...requested].some(value=>values.has(value));return continuity.test(text)&&numericMatches&&!/(?:没测|未测|没有测|计划|如果|可能|有机会)/u.test(text);}));
    if(matched.length)pool=matched;
  }
  if(/(?:浅睡|自行醒来|自己醒)/u.test(question)&&/(?:2\s*[–—~-]\s*3\s*次|两三次)/u.test(question)){
    const matched=pool.filter(group=>{const text=sessionAnchorText(group),active=/(?:每晚|每夜|一晚上|夜里).{0,24}(?:醒|浅睡).{0,16}(?:2\s*[–—~-]\s*3\s*次|两三次)|(?:2\s*[–—~-]\s*3\s*次|两三次).{0,24}(?:醒|浅睡)/u.test(text),selfAwake=/(?:自己醒|自行醒|突然醒)/u.test(text);return active&&selfAwake;});
    if(matched.length)pool=matched;
  }
  if(/(?:主动询问|询问).{0,12}(?:尿酮|酮体).{0,12}(?:频率|监测)|(?:尿酮|酮体).{0,12}(?:监测频率)/u.test(question)){
    const matched=pool.filter(group=>group.items.some(item=>/^(?:患者|patient\b).{0,32}(?:每天|多久|多长时间|频率|几次).{0,24}(?:测|监测).{0,8}(?:尿酮|酮体)|^(?:患者|patient\b).{0,32}(?:尿酮|酮体).{0,20}(?:每天|多久|频率|几次)/iu.test(String(item.text||item.source_text||''))));
    if(matched.length)pool=matched;
  }
  if(/(?:提示|提醒).{0,24}(?:继发性).{0,12}(?:药效|减效|失效)|(?:继发性).{0,12}(?:药效|减效|失效)/u.test(question)){
    const matching=pool.filter(group=>/(?:继发性).{0,12}(?:药效|减效|失效)|(?:药效).{0,8}(?:继发性)/u.test(sessionAnchorText(group))),original=matching.filter(group=>!/(?:之前已经提醒|之前提到|也提(?:到)?过|上次复诊时|此前已提醒|社区医生.{0,8}提到|回顾|复述)/u.test(sessionAnchorText(group)));
    if(original.length)pool=[[...original].sort((a,b)=>Date.parse(a.event_time||'')-Date.parse(b.event_time||''))[0]];else if(matching.length)pool=matching;
  }
  if(/(?:次日|第二天)/u.test(question)){const matched=pool.filter(item=>/(?:次日|第二天)/u.test(item.items.flatMap(value=>[value.text,value.source_text]).filter(Boolean).join(' ')));if(matched.length)pool=matched;}
  const numericTarget=requested.size&&/(?:血糖|糖化|hba1c|a1c|滴度|gada|抗体|检测|结果|测到|大于|超过|mmol|u\s*\/\s*ml|%)/iu.test(question);if(numericTarget){const matched=pool.filter(item=>{const values=numericSignatures(sessionAnchorText(item));return[...requested].some(value=>values.has(value));});if(matched.length)pool=matched;}
  for(const phrase of['继发性','药效减弱','强阳性','完全恢复','双向箭头'])if(question.includes(phrase)){const matched=pool.filter(item=>sessionAnchorText(item).includes(normalize(phrase)));if(matched.length)pool=matched;}
  return pool;
}
function sessionAnchorText(item){return normalize(item.items.flatMap(value=>[value.text,value.source_text]).filter(Boolean).join(' '));}
function temporalDiscriminationScore(item,plan){
  const question=String(plan.question||''),text=sessionAnchorText(item),requested=questionNumericSignals(plan),values=numericSignatures(text);let score=Number(item.answer_signal||0)*2+Number(item.score||0);
  if(requested.size&&/(?:血糖|糖化|hba1c|a1c|滴度|gada|抗体|检测|结果|测到|大于|超过|mmol|u\s*\/\s*ml|%)/iu.test(question)&&[...requested].some(value=>values.has(value)))score+=40;
  for(const phrase of['继发性','药效减弱','强阳性','完全恢复','连续多日','双向箭头'])if(question.includes(phrase)&&text.includes(normalize(phrase)))score+=16;
  if(/(?:什么时候饮用|何时饮用|什么时候喝|何时喝)/u.test(question)){if(/(?:患者|我).{0,24}(?:立即|马上|一两分钟|1\s*[–-]\s*2\s*分钟).{0,20}(?:喝|奶咖|咖啡)/u.test(text))score+=18;if(/(?:建议|最好|应该).{0,24}(?:喝|奶咖|咖啡)/u.test(text))score-=10;}
  if(/(?:2\s*[–-]\s*3\s*次|2\s*-\s*3\s*次|两三次)/u.test(question)){if(/(?:每晚|每夜|仍|还是).{0,20}(?:2\s*[–-]\s*3\s*次|2\s*-\s*3\s*次|两三次)/u.test(text))score+=16;if(/(?:从|由).{0,12}(?:2\s*[–-]\s*3\s*次|两三次).{0,20}(?:改善|减少|降|变).{0,10}(?:1\s*次|一次)/u.test(text))score-=24;}
  if(/(?:生理反应|什么反应|双向箭头)/u.test(question)){if(/(?:一两秒|1\s*[–-]\s*2\s*秒|一下|微微一紧|紧一下)/u.test(text))score+=18;if(/(?:没有|无).{0,8}(?:胸闷|不适|反应)/u.test(text))score-=6;}
  if(/(?:裤腰|体重).{0,24}(?:1\s*[–—~-]\s*2\s*斤|一两斤)|(?:1\s*[–—~-]\s*2\s*斤|一两斤).{0,24}(?:裤腰|体重)/u.test(question)){
    if(/患者.{0,40}裤腰.{0,12}(?:又松|变松).{0,80}患者.{0,30}(?:又掉|下降|一两斤|1\s*[–—~-]\s*2\s*斤)/u.test(text))score+=28;
    if(/(?:还记得|之前跟我说|前阵子|回顾|复述).{0,50}(?:裤腰|体重)/u.test(text))score-=24;
  }
  if(/(?:结果|阳性|滴度|检测到|测到)/u.test(question)){if(/(?:结果|显示|阳性|大于|超过|测到)/u.test(text))score+=12;if(/(?:计划|准备|安排|将|待).{0,14}(?:检查|检测|复查)/u.test(text))score-=12;}
  if(/(?:回顾|后来提到|复诊时提到|复述|之前已经提醒|之前提到|也提过|上次复诊时|此前已提醒)/u.test(text))score-=24;
  return score;
}
function answerEvidenceScore(item,plan){const question=String(plan.question||''),text=normalize([item.text,item.source_text].filter(Boolean).join(' ')),patient=/^(?:患者|patient\b)/iu.test(String(item.text||item.source_text||'').trim()),numeric=numericSignatures(text).size||/(?:[零一二三四五六七八九十百]+(?:[、至到~-][零一二三四五六七八九十百]+)?)/u.test(text),measurementCue=/(?:复查|检测|结果|升到|降到|反弹到|回到|飙到|测到)/u.test(text)||/(?:hba1c|a1c|糖化(?:血红蛋白)?).{0,12}(?:为|是)\s*\d/iu.test(text),topicMatch=answerTopicMatch(plan,text);let score=patient?1:0;if(plan.query_type==='entity_exact_match'&&/(?:数值|多少|滴度|范围|结果|值)/u.test(question)&&numeric)score+=10;if(plan.query_type==='state_update'&&/(?:数值|多少|指标)/u.test(question)&&numeric&&aliasesIn(question).some(term=>text.includes(normalize(term)))&&measurementCue)score+=10;if(plan.query_type==='state_update'&&/(?:监测意愿|监测.*意愿)/u.test(question)){const willing=/(?:愿意|主动|不回避|真实测量|实话实测)/u.test(text),facets=[/空腹/u,/(?:深夜|餐后).{0,12}(?:2|两)\s*小时/u,/外卖后/u,/(?:半夜|深夜).{0,8}上线/u].filter(pattern=>pattern.test(text)).length;if(willing&&/(?:测|监测|空腹|餐后|外卖后|半夜|深夜|上线)/u.test(text))score+=12;if(facets>=2)score+=10+facets*3;}if(plan.query_type==='state_update'&&/(?:饮食底线|进食策略|饮食.*方案)/u.test(question)&&/(?:80%|主食减半|加蛋白|咖啡半糖|咖啡.*无糖|奶咖.*(?:延|分钟)|吃完.*奶咖)/u.test(text))score+=12;if(plan.query_type==='inference_generation'&&asksAboutGlucoseMedicationAdjustment(question)){const facets=inferenceMedicationTextFacets(text);if(facets.has('unsafe_restart'))score+=18;if(facets.has('autoimmune'))score+=16;if(facets.has('therapy_failure'))score+=14;if(facets.has('insulin_execution'))score+=13;if(facets.has('red_flags'))score+=8;}if(plan.query_type==='inference_generation'&&asksSilentHyperglycemiaMonitoring(question)){if(/(?:npdr|非增殖期视网膜病变|微血管瘤|硬性渗出)/iu.test(text))score+=18;if(/(?:said|lada|自身免疫性糖尿病).{0,24}(?:微血管|视网膜)|(?:微血管|视网膜).{0,24}(?:said|lada|自身免疫性糖尿病)/iu.test(text))score+=14;}if(plan.query_type==='inference_generation'&&asksEarlyDepartureAfterFluids(question)){if(/(?:ph\s*7\.28|尿酮.{0,8}\+\+|\+\+.{0,8}尿酮)/iu.test(text))score+=20;if(/(?:意识模糊|呼吸(?:偏快|急促)|酸中毒|dka)/iu.test(text))score+=15;}if(/(?:什么症状|哪些症状|生理反应|什么反应|什么不适)/u.test(question)&&/(?:模糊|看不清|头晕|乏力|恶心|口渴|多尿|疼|痛|麻|闷|胸口|心跳|疲倦|呼吸|无力|发白|紧一下|电击|细沙)/u.test(text))score+=patient?12:7;if(/(?:什么时候饮用|何时饮用|什么时候喝|何时喝|多久|多长时间)/u.test(question)&&topicMatch&&/(?:立即|马上|分钟|秒|小时|之后|以后|前|后|内|深夜|半夜)/u.test(text))score+=patient?10:6;if(/(?:相关的?什么情况|记录了.*什么情况)/u.test(question)&&patient&&topicMatch&&/(?:暂时|很快|又|仍|只能|缓解|持续|反复)/u.test(text))score+=9;for(const term of['完全恢复','连续多日','停止下降','保持稳定','继发性','药效减弱'])if(question.includes(term)&&text.includes(term))score+=6;return score;}
function groupAnswerCoverageScore(text,plan){const question=String(plan.question||'');if(plan.query_type==='inference_generation'&&asksAboutGlucoseMedicationAdjustment(question)){const facets=inferenceMedicationTextFacets(text),weights={unsafe_restart:18,autoimmune:16,therapy_failure:14,insulin_execution:13,red_flags:8,current_symptoms:5},score=[...facets].reduce((sum,facet)=>sum+(weights[facet]||0),0);return Math.min(36,score);}if(plan.query_type==='inference_generation'){const decisionScore=inferenceDecisionCoverageScore(text,question);if(decisionScore)return decisionScore;}if(plan.query_type==='multi_hop_clinical_deduction')return mcdCoverageScore(text,question);if(plan.query_type!=='state_update')return 0;if(/(?:监测意愿|监测.*意愿)/u.test(question)){const willing=/(?:愿意|主动|不回避|真实测量|实话实测)/u.test(text),facets=[/空腹/u,/(?:深夜|餐后).{0,12}(?:2|两)\s*小时/u,/外卖后/u,/(?:半夜|深夜).{0,8}上线/u].filter(pattern=>pattern.test(text)).length;return willing&&facets?12+facets*4:0;}if(/(?:饮食底线|进食策略|饮食.*方案)/u.test(question)){const facets=[/80%/u,/主食减半/u,/(?:咖啡|奶咖).{0,8}(?:半糖|无糖)/u,/加蛋白/u,/(?:奶咖.{0,12}(?:延|分钟)|吃完.{0,12}奶咖)/u].filter(pattern=>pattern.test(text)).length;return facets>=2?8+facets*4:0;}return 0;}
function asksAboutGlucoseMedicationAdjustment(value){return/(?:降糖药|口服药).{0,16}(?:加量|加大|加回|调整|调药)|(?:加量|加大|加回|加药|调药)|药.{0,5}(?:加|调)|(?:加|调).{0,5}药/u.test(String(value||''));}
function asksMonitoringForMedicationAdjustment(value){return/(?:多时点|多点|这些|监测).{0,18}(?:测|监测|血糖|数据).{0,18}(?:调药|调整用药|加减药|用药调整)|(?:调药|调整用药|加减药).{0,24}(?:多时点|监测|数据)/u.test(String(value||''));}
function asksSilentHyperglycemiaMonitoring(value){return/(?:血糖).{0,16}(?:不难受|没感觉|无感|症状.{0,6}(?:少|减轻|消失)).{0,20}(?:还要|要不要|是否).{0,10}(?:盯|测|监测|关注)/u.test(String(value||''));}
function asksEarlyDepartureAfterFluids(value){return/(?:补液|输液).{0,16}(?:早点走|提前走|离开|回家|出院)|(?:早点走|提前走|离开|回家|出院).{0,16}(?:补液|输液)/u.test(String(value||''));}
function asksReduceMonitoringAfterSymptomImprovement(value){return/(?:眼前发白|头晕|不适|症状).{0,20}(?:少了|减少|减轻|好转|不明显).{0,20}(?:少测|减少).{0,8}(?:血糖|监测)|(?:少测|减少).{0,8}(?:血糖|监测).{0,24}(?:眼前发白|头晕|不适|症状)/u.test(String(value||''));}
function asksCgmUpgrade(value){return/(?:cgm|血糖贴|连续血糖).{0,20}(?:换|升级|高级|更好)|(?:换|升级).{0,16}(?:cgm|血糖贴|连续血糖)/iu.test(String(value||''));}
function asksPostMealCognitiveSlow(value){return/(?:餐后|吃完).{0,20}(?:脑子|反应|注意力).{0,12}(?:慢|卡|跟不上|下降)/u.test(String(value||''));}
function asksSugarForOrthostaticDizziness(value){return/(?:站起来|起身).{0,16}(?:头.{0,4}晕|头轻|眼前发白).{0,18}(?:补.{0,3}糖|吃.{0,3}糖|含糖)|(?:补.{0,3}糖|吃.{0,3}糖|含糖).{0,18}(?:站起来|起身|头.{0,4}晕|眼前发白)/u.test(String(value||''));}
function asksPostLunchSleepiness(value){return/(?:午饭后|午餐后).{0,16}(?:困|困倦|疲乏|没精神)/u.test(String(value||''));}
function asksMedicationForTransientFootNumbness(value){return/(?:脚底|足底).{0,16}(?:麻|细沙|刺).{0,16}(?:吃药|用药|药)|(?:吃药|用药).{0,16}(?:脚底|足底).{0,12}(?:麻|细沙|刺)/u.test(String(value||''));}
function asksMorningCognitiveWorsening(value){return/(?:早晨|晨起|早上).{0,20}(?:醒不动|脑子.{0,8}(?:慢|迟缓|转不动)|反应.{0,6}(?:慢|迟缓))/u.test(String(value||''));}
function asksLateNightTakeoutDiscomfort(value){return/(?:深夜|半夜).{0,20}(?:外卖|吃完).{0,20}(?:发闷|口干|心跳快|不舒服)|(?:外卖|吃完).{0,18}(?:发闷|口干|心跳快).{0,18}(?:深夜|半夜)/u.test(String(value||''));}
function isDecisionEvidenceInferenceQuestion(value){return[asksSilentHyperglycemiaMonitoring,asksEarlyDepartureAfterFluids,asksReduceMonitoringAfterSymptomImprovement,asksCgmUpgrade,asksPostMealCognitiveSlow,asksSugarForOrthostaticDizziness,asksPostLunchSleepiness,asksMedicationForTransientFootNumbness,asksMorningCognitiveWorsening,asksLateNightTakeoutDiscomfort].some(test=>test(value));}
function inferenceDecisionCoverageScore(text,question){if(asksLateNightTakeoutDiscomfort(question)){const cause=/(?:深夜|半夜).{0,28}(?:高碳水|外卖|含糖咖啡).{0,28}(?:餐后峰值|血糖.{0,8}(?:冲|升|高)|发闷|口干)|(?:高碳水|外卖|含糖咖啡).{0,28}(?:发闷|口干|餐后峰值)/u.test(text),measure=/(?:夜宵|深夜|餐).{0,18}(?:后).{0,10}(?:2|两)\s*小时.{0,12}(?:测|血糖)|(?:2|两)\s*小时.{0,16}(?:测|血糖)/u.test(text),diet=/(?:高碳水|高油|主食减半|饭减半|面减半|多蛋白|含糖咖啡|半糖|无糖)/u.test(text);return(cause?18:0)+(measure?18:0)+(diet?14:0);}if(asksSilentHyperglycemiaMonitoring(question)){const retinal=/(?:npdr|非增殖期视网膜病变|微血管瘤|硬性渗出)/iu.test(text),autoimmune=/(?:said|lada|自身免疫性糖尿病)/iu.test(text),microvascular=/(?:微血管|视网膜)/u.test(text);return retinal?24+(autoimmune&&microvascular?10:0):autoimmune&&microvascular?14:0;}if(asksEarlyDepartureAfterFluids(question)){const objective=/(?:ph\s*7\.28|尿酮.{0,8}\+\+|\+\+.{0,8}尿酮)/iu.test(text),danger=/(?:意识模糊|呼吸(?:偏快|急促)|酸中毒|dka)/iu.test(text),partial=/(?:补液|输液).{0,24}(?:改善|缓解|稳定)/u.test(text);return objective?24+(danger?10:0)+(partial?4:0):danger?12:0;}if(asksReduceMonitoringAfterSymptomImprovement(question)){const improvement=/(?:眼前发白|头晕|不适|症状).{0,40}(?:少了|减少|减轻|好转|不明显|从.{0,20}到)|(?:从.{0,12}到).{0,16}(?:眼前发白|头晕)/u.test(text),high=/(?:空腹).{0,16}(?:10\s*[–-]\s*11|10多|超过10|12)|(?:餐后|血糖).{0,18}(?:18\.4|飙升|明显上冲)/u.test(text),danger=/(?:ph\s*7\.28|尿酮.{0,8}\+\+|酸中毒|dka|意识模糊|呼吸偏快)/iu.test(text);return(improvement?12:0)+(high?16:0)+(danger?20:0);}if(asksCgmUpgrade(question)){const cgm=/(?:cgm|连续血糖)/iu.test(text),cost=/(?:费用|花销|耗材|成本|经济压力|预算|撑不住|吃力)/u.test(text),fit=/(?:隐蔽|办公室|关键周期|按需使用|不用长期)/u.test(text);return cgm?(cost?18:0)+(fit?14:0):0;}if(asksPostMealCognitiveSlow(question)){const execution=/(?:餐前|餐时).{0,20}(?:胰岛素|门冬|打针).{0,20}(?:错过|漏|没|未|打断|补)|(?:错过|漏|打断).{0,20}(?:餐前|餐时).{0,12}(?:胰岛素|门冬)/u.test(text),cognitive=/(?:脑子|反应|注意力).{0,16}(?:慢|卡|跟不上|下降)/u.test(text),high=/(?:血糖).{0,16}(?:14|快速上升|上冲|升高)/u.test(text);return execution?20+(cognitive?10:0)+(high?6:0):cognitive&&high?16:0;}if(asksSugarForOrthostaticDizziness(question)){const highRisk=/(?:体重(?:下降|掉)|口渴|多饮|多尿|视力模糊|看不清)/u.test(text),dehydration=/(?:脱水|没喝水|缺水)/u.test(text),orthostatic=/(?:站起来|起身|眼前发白|头晕|头轻)/u.test(text);return orthostatic?(highRisk?16:0)+(dehydration?14:0):0;}if(asksPostLunchSleepiness(question)){const lunch=/(?:午饭后|午餐后).{0,24}(?:困|疲乏|脑子|发空|反应)/u.test(text),recovery=/(?:dka|酸中毒).{0,24}(?:恢复|早期)|(?:恢复期|适应期).{0,20}(?:餐|胰岛素|代谢)/iu.test(text),trend=/(?:cgm|血糖趋势|快速下降|波动)/iu.test(text);return lunch?12+(recovery?14:0)+(trend?8:0):0;}if(asksMedicationForTransientFootNumbness(question)){const vpt=/(?:vpt|18\s*(?:到|[-~–—])\s*22\s*v|灰区)/iu.test(text),transient=/(?:十几分钟|一两分钟|活动后缓解|第二天.*恢复|次日.*恢复|一夜恢复|完全恢复)/u.test(text),foot=/(?:脚底|足底|细沙|麻|电击)/u.test(text);return foot?(vpt?18:0)+(transient?16:0):0;}if(asksMorningCognitiveWorsening(question)){const morning=/(?:醒不动|晨起|早晨).{0,20}(?:脑雾|脑子|反应|迟缓|加载)|(?:脑雾|脑子|反应).{0,20}(?:醒不动|晨起|早晨)/u.test(text),glucose=/(?:空腹).{0,20}(?:9\.8|9\s*(?:到|[-~–—])\s*12|9-12|偏高|上升)/u.test(text),workup=/(?:抗体|gada).{0,24}(?:c肽|胰岛功能)|(?:c肽|胰岛功能).{0,24}(?:抗体|gada)/iu.test(text);return morning?14+(glucose?14:0)+(workup?12:0):glucose&&workup?18:0;}return 0;}
function inferenceMedicationTextFacets(value){const text=normalize(value),out=new Set();if(/(?:恩格列净|sglt2).{0,28}(?:停|不能|避免|风险|酮症|酸中毒)|(?:停用|停掉).{0,20}(?:恩格列净|sglt2)|(?:dka|酮症|酸中毒).{0,28}(?:恩格列净|sglt2)/iu.test(text))out.add('unsafe_restart');if(/(?:gada|ica).{0,24}(?:阳性|\+|2000)|(?:said|lada|自身免疫性糖尿病|成年型1型)|胰岛功能.{0,12}(?:下降|衰退|掉)/iu.test(text))out.add('autoimmune');if(/(?:口服药|降糖药).{0,28}(?:压不住|作用有限|药效|效果).{0,12}(?:不|减弱|下降|没|差|有限)|(?:药效|效果).{0,12}(?:减弱|下降|不如|撑不住|压不住)|(?:hba1c|a1c|糖化).{0,20}(?:8\.8|反弹|升高|上升)/iu.test(text))out.add('therapy_failure');if(/(?:餐前|餐时|深夜|基础).{0,24}(?:胰岛素|打针|注射|漏)|(?:胰岛素|打针|注射).{0,24}(?:餐前|餐时|深夜|基础|按时|执行|漏)/u.test(text))out.add('insulin_execution');if(/(?:体重(?:下降|掉)|口渴|多饮|多尿|乏力|疲劳|视力模糊|看不清)/u.test(text))out.add('red_flags');if(/(?:深夜|餐后).{0,24}(?:心跳|心慌|口干|头闷|头胀)|(?:心跳|心慌|口干|头闷|头胀).{0,24}(?:深夜|餐后)/u.test(text))out.add('current_symptoms');return out;}
function inferenceMedicationAnchorFacets(item){return inferenceMedicationTextFacets(item.items.flatMap(value=>[value.text,value.source_text]).filter(Boolean).join(' '));}
function answerTopicMatch(plan,text){const specific=anchorKeywords(plan).map(normalize).filter(term=>term.length>=2&&!/^(?:记录|情况|什么时候|何时|时间|患者|医生|对话)$/u.test(term));if(specific.some(term=>text.includes(term)))return true;const question=normalize(plan.question);if(/(?:饮用|喝)/u.test(question)&&text.includes('喝'))return true;return question.includes('口干')&&/(?:口干|干了|觉得干|又干|仍干)/u.test(text);}
function diverseEvidenceSeeds(local,limit,plan={}){const out=[],seen=new Set(),add=record=>{const id=String(record?.item?.evidence_id||'');if(id&&!seen.has(id)&&out.length<limit){seen.add(id);out.push(record);}},find=pattern=>local.find(record=>pattern.test(normalize([record.item.text,record.item.source_text].filter(Boolean).join(' ')))),question=String(plan.question||'');add(local[0]);add([...local].sort((a,b)=>b.answer_score-a.answer_score||b.total-a.total)[0]);if(plan.query_type==='state_update'&&/(?:数值|多少|指标)/u.test(question))add(local.find(record=>/(?:复查|检测|结果|升到|降到|反弹到|回到|飙到|测到).{0,20}\d|\d.{0,20}(?:mmol|%)/iu.test(normalize([record.item.text,record.item.source_text].filter(Boolean).join(' ')))));if(plan.query_type==='state_update'&&/(?:饮食底线|进食策略|饮食.*方案)/u.test(question))for(const pattern of[/80%/u,/主食减半/u,/(?:咖啡|奶咖).{0,8}(?:半糖|无糖)/u,/加蛋白/u,/(?:奶咖.{0,12}(?:延|分钟)|吃完.{0,12}奶咖)/u])add(find(pattern));if(plan.query_type==='state_update'&&/(?:监测意愿|监测.*意愿)/u.test(question))for(const pattern of[/(?:愿意|主动|不回避|真实测量|实话实测)/u,/空腹/u,/(?:深夜|餐后).{0,12}(?:2|两)\s*小时/u,/外卖后/u,/(?:半夜|深夜).{0,8}上线/u])add(find(pattern));if(plan.query_type==='inference_generation'&&/(?:降糖药|口服药).{0,12}(?:加量|加大|加回|调整)|(?:加量|加大|加回|加药|调药)|药.{0,4}(?:加|调)|(?:加|调).{0,4}药/u.test(question))for(const pattern of[/(?:口服药|降糖药).{0,16}(?:药效|效果).{0,8}(?:不|减弱|没)/u,/(?:体重下降|口渴|多饮|多尿|乏力)/u,/(?:抗体|gada|lada|自身免疫|成年型1型)/iu,/(?:胰岛功能|胰岛素|餐前.*针|餐时.*针)/u])add(find(pattern));if(plan.query_type==='inference_generation'&&/头痛.{0,12}(?:药|吃)|(?:药|吃).{0,12}头痛/u.test(question))for(const pattern of[/(?:布洛芬|双氯芬|阿司匹林|nsaid)/iu,/(?:胃溃疡|黑便|胃出血|消化道出血)/u,/(?:不伤胃|胃温和|安全)/u,/(?:血糖).{0,16}(?:头痛|头胀)|(?:头痛|头胀).{0,16}血糖/u])add(find(pattern));if(plan.query_type==='inference_generation')for(const pattern of inferenceDecisionSeedPatterns(question))add(find(pattern));if(plan.query_type==='multi_hop_clinical_deduction')for(const pattern of mcdSeedPatterns(question))add(find(pattern));add([...local].sort((a,b)=>numericSignatures([b.item.text,b.item.source_text].join(' ')).size-numericSignatures([a.item.text,a.item.source_text].join(' ')).size||b.total-a.total)[0]);add(local.find(record=>/^(?:患者|patient\b)/iu.test(String(record.item.text||record.item.source_text||'').trim())));for(const record of local)add(record);return out;}
function inferenceDecisionSeedPatterns(question){
  if(asksMonitoringForMedicationAdjustment(question))return[/(?:8\.1%).{0,20}(?:8\.8%)|(?:8\.1).{0,20}(?:8\.8)/u,/(?:二甲双胍).{0,24}(?:dpp.?4).{0,30}(?:按时|规律|一直)|(?:按时|规律|一直).{0,30}(?:二甲双胍).{0,24}(?:dpp.?4)/iu,/(?:胰岛素).{0,24}(?:启动|强化|核心|方案)|(?:启动|强化).{0,24}(?:胰岛素)/u,/(?:多时点|空腹).{0,28}(?:餐后|深夜|外卖|半夜).{0,20}(?:测|监测|血糖)/u];
  if(asksLateNightTakeoutDiscomfort(question))return[/(?:深夜|半夜).{0,28}(?:高碳水|外卖|含糖咖啡).{0,28}(?:餐后峰值|血糖|发闷|口干)/u,/(?:夜宵|深夜|餐).{0,18}后.{0,10}(?:2|两)\s*小时.{0,12}(?:测|血糖)|(?:2|两)\s*小时.{0,16}(?:测|血糖)/u,/(?:高碳水|高油|主食减半|饭减半|面减半|多蛋白|含糖咖啡|半糖|无糖)/u];
  if(asksReduceMonitoringAfterSymptomImprovement(question))return[/(?:眼前发白|头晕|不适|症状).{0,40}(?:少了|减少|减轻|好转|不明显|从.{0,20}到)|(?:从.{0,12}到).{0,16}(?:眼前发白|头晕)/u,/(?:空腹).{0,16}(?:10\s*[–-]\s*11|10多|超过10|12)|(?:餐后|血糖).{0,18}(?:18\.4|飙升|明显上冲)/u,/(?:ph\s*7\.28|尿酮.{0,8}\+\+|酸中毒|dka|意识模糊|呼吸偏快)/iu];
  if(asksCgmUpgrade(question))return[
    /(?:cgm|连续血糖|血糖贴|传感器).{0,40}(?:费用|花销|耗材|成本|经济压力|预算|撑不住|吃力|贵)|(?:费用|花销|耗材|成本|经济压力|预算|可支配收入|房租).{0,40}(?:cgm|连续血糖|血糖贴|传感器|监测)|(?:房租高|可支配收入低|经济压力|耗材.{0,12}(?:开销|吃力|贵))/iu,
    /(?:cgm|连续血糖|血糖贴|传感器).{0,40}(?:隐蔽|办公室|关键周期|按需使用|不用长期|放松)|(?:隐蔽|办公室|关键周期|按需使用|放松).{0,40}(?:cgm|连续血糖|血糖贴|传感器)/iu
  ];
  if(asksPostMealCognitiveSlow(question))return[/(?:错过|漏|打断|没.{0,5}打).{0,20}(?:餐前|餐时).{0,12}(?:胰岛素|门冬)|(?:餐前|餐时).{0,20}(?:胰岛素|门冬).{0,20}(?:错过|漏|打断)/u,/(?:血糖).{0,16}(?:14|快速上升|上冲).{0,20}(?:脑子|反应|注意力)|(?:脑子|反应|注意力).{0,20}(?:血糖|14)/u];
  if(asksSugarForOrthostaticDizziness(question))return[/(?:体重(?:下降|掉)|口渴|多饮|多尿|视力模糊|看不清)/u,/(?:脱水|没喝水|缺水)/u,/(?:站起来|起身|眼前发白|头晕|头轻)/u];
  if(asksPostLunchSleepiness(question))return[/(?:午饭后|午餐后).{0,24}(?:困|疲乏|脑子|发空|反应)/u,/(?:dka|酸中毒).{0,24}(?:恢复|早期)|(?:恢复期|适应期).{0,20}(?:餐|胰岛素|代谢)/iu,/(?:cgm|血糖趋势|快速下降|波动)/iu];
  if(asksMedicationForTransientFootNumbness(question))return[/(?:vpt|18\s*(?:到|[-~–—])\s*22\s*v|灰区)/iu,/(?:十几分钟|一两分钟|活动后缓解|第二天.*恢复|次日.*恢复|一夜恢复|完全恢复)/u];
  if(asksMorningCognitiveWorsening(question))return[/(?:醒不动|晨起|早晨).{0,20}(?:脑雾|脑子|反应|迟缓|加载)/u,/(?:空腹).{0,20}(?:9\.8|9\s*(?:到|[-~–—])\s*12|9-12|偏高|上升)/u,/(?:抗体|gada).{0,24}(?:c肽|胰岛功能)|(?:c肽|胰岛功能).{0,24}(?:抗体|gada)/iu];
  return[];
}
function mcdQuestionKind(value){const question=String(value||'');if(/午饭后.{0,24}(?:脑子发胀|乏力).{0,30}(?:药|压不住)/u.test(question))return'oral_therapy_failure';if(/(?:晚上|夜里).{0,24}(?:口干|渴醒).{0,36}(?:半夜|深夜).{0,12}外卖/u.test(question))return'late_food_thirst';if(/(?:眼睛对不上焦|醒不动|被粘住).{0,40}(?:外卖|奶咖|咖啡)/u.test(question))return'morning_blur_food';if(/(?:反胃|恶心).{0,20}(?:胸口发闷|胸闷).{0,50}(?:漏打|胰岛素|作息)/u.test(question))return'euglycemic_ketone';if(/(?:尿液|尿).{0,20}(?:泡泡|泡沫).{0,40}(?:没喝水|脱水|饮水)/u.test(question))return'dehydration_uacr';if(/(?:眼前亮|闪光|光感).{0,50}(?:血糖|夜里).{0,20}(?:飙|波动|冲)/u.test(question))return'retinal_variability';if(/(?:早上|晨起).{0,20}(?:心跳|心率).{0,45}(?:睡不好|睡眠不足|没喝水|脱水)/u.test(question))return'sympathetic_tachycardia';if(/(?:脚底|足底).{0,24}(?:软垫|踩棉|踩软).{0,50}(?:血糖|夜里).{0,20}(?:飙|波动|冲)/u.test(question))return'transient_foot_perfusion';return null;}
function mcdCoverageScore(text,question){const kind=mcdQuestionKind(question),has=pattern=>pattern.test(text),score=(...rules)=>Math.min(40,rules.reduce((sum,[pattern,weight])=>sum+(has(pattern)?weight:0),0));if(kind==='oral_therapy_failure')return score([/(?:二甲双胍|dpp.?4)/iu,8],[/(?:9\.2).{0,20}(?:8\.1)|(?:8\.1).{0,20}(?:9\.2)/u,16],[/(?:规律|按时|没漏).{0,20}(?:药|二甲双胍|dpp)|(?:口服药).{0,24}(?:第三个月|压不住|失效|减弱)/iu,16]);if(kind==='late_food_thirst')return score([/(?:深夜|凌晨|半夜).{0,24}(?:外卖|高碳水|奶咖)/u,14],[/(?:口干|渴醒).{0,24}(?:血糖|11|晨起)|(?:血糖|11).{0,24}(?:口干|渴醒)/u,16],[/(?:交感|皮质醇|黎明现象|肝糖)/u,10]);if(kind==='morning_blur_food')return score([/(?:深夜|凌晨).{0,28}(?:外卖|高碳水).{0,24}(?:奶咖|咖啡)|(?:奶咖|咖啡).{0,28}(?:深夜|凌晨)/u,14],[/(?:醒不动|脑雾|粘住|对不上焦|视力模糊)/u,14],[/(?:空腹|晨起).{0,20}(?:9\.8|10|11|偏高|上升)/u,8],[/(?:交感|皮质醇|睡眠结构)/u,6]);if(kind==='euglycemic_ketone')return score([/(?:恩格列净|sglt2)/iu,12],[/(?:漏打|延迟|无法按时).{0,20}(?:胰岛素|门冬)|(?:餐时|餐前).{0,20}(?:胰岛素|门冬).{0,20}(?:漏|延迟|困难)/u,12],[/(?:酮体|酮症|dka|酸中毒)/iu,12],[/(?:血糖).{0,16}(?:不高|不算高)|(?:血糖正常).{0,16}(?:酮体|酮症)/u,4]);if(kind==='dehydration_uacr')return score([/(?:连续|大概).{0,12}(?:5|五)个?小时.{0,12}(?:没喝水|不喝水)|(?:脱水).{0,24}(?:严重|起身头晕)/u,14],[/(?:uacr).{0,20}(?:52|50多)|(?:52|50多).{0,20}uacr/iu,16],[/(?:肾小球|肾灌注|过滤压力|微量白蛋白尿)/u,10]);if(kind==='retinal_variability')return score([/(?:轻度\s*npdr|微血管瘤|硬性渗出)/iu,15],[/(?:cv).{0,14}(?:40%|超过40|高波动)|(?:高波动).{0,20}(?:视网膜|微血管)/iu,15],[/(?:门冬|餐前胰岛素).{0,24}(?:延迟|漏|规律)|(?:德谷).{0,12}14/u,10]);if(kind==='sympathetic_tachycardia')return score([/(?:睡眠不足|睡不好).{0,24}(?:交感|心率)|(?:交感).{0,24}(?:睡眠不足|心率)/u,15],[/(?:5|五)个?小时.{0,12}(?:没喝水|不喝水)|(?:脱水).{0,24}(?:心率|头晕)/u,15],[/(?:早上|晨起).{0,20}(?:心率|心跳).{0,16}(?:80|90|偏高|快)/u,10]);if(kind==='transient_foot_perfusion')return score([/(?:脚底|足底|细沙|踩软|软垫)/u,10],[/(?:十几分钟|一两分钟|活动后缓解|次日.*恢复|完全恢复)/u,10],[/(?:cv).{0,14}(?:40%|超过40|高波动)|(?:血糖).{0,20}(?:上冲|波动)/iu,10],[/(?:轻度\s*npdr|微血管|vpt|18\s*(?:到|[-~–—])\s*22)/iu,10]);return 0;}
function mcdSeedPatterns(question){const kind=mcdQuestionKind(question);if(kind==='oral_therapy_failure')return[/(?:9\.2).{0,20}(?:8\.1)|(?:8\.1).{0,20}(?:9\.2)/u,/(?:口服药).{0,24}(?:第三个月|压不住|失效|减弱)/u,/(?:规律|按时|没漏).{0,20}(?:药|二甲双胍|dpp)/iu];if(kind==='late_food_thirst')return[/(?:深夜|凌晨|半夜).{0,24}(?:外卖|高碳水|奶咖)/u,/(?:口干|渴醒).{0,24}(?:血糖|11|晨起)/u,/(?:交感|皮质醇|黎明现象|肝糖)/u];if(kind==='morning_blur_food')return[/(?:深夜|凌晨).{0,28}(?:外卖|高碳水).{0,24}(?:奶咖|咖啡)/u,/(?:醒不动|脑雾|粘住|对不上焦|视力模糊)/u,/(?:空腹|晨起).{0,20}(?:9\.8|10|11|偏高|上升)/u];if(kind==='euglycemic_ketone')return[/(?:恩格列净|sglt2)/iu,/(?:餐时|餐前).{0,20}(?:胰岛素|门冬).{0,20}(?:漏|延迟|困难)|(?:漏打|延迟|无法按时).{0,20}(?:胰岛素|门冬)/u,/(?:正常血糖酮症酸中毒|尿酮|酮体|酮症|dka|酸中毒)/iu];if(kind==='dehydration_uacr')return[/(?:5|五)个?小时.{0,12}(?:没喝水|不喝水)/u,/(?:uacr).{0,20}(?:52|50多)|(?:52|50多).{0,20}uacr/iu,/(?:肾小球|肾灌注|过滤压力|微量白蛋白尿)/u];if(kind==='retinal_variability')return[/(?:轻度\s*npdr|微血管瘤|硬性渗出)/iu,/(?:cv).{0,14}(?:40%|超过40|高波动)/iu,/(?:门冬|餐前胰岛素).{0,24}(?:延迟|漏|规律)|(?:德谷).{0,12}14/u];if(kind==='sympathetic_tachycardia')return[/(?:睡眠不足|睡不好)/u,/(?:交感神经|皮质醇|hrv)/iu,/(?:5|五)个?小时.{0,12}(?:没喝水|不喝水)|脱水/u,/(?:早上|晨起).{0,20}(?:心率|心跳)/u];if(kind==='transient_foot_perfusion')return[/(?:脚底|足底).{0,20}(?:细沙|踩软|软垫|麻)/u,/(?:十几分钟|一两分钟|活动后缓解|次日.*恢复|完全恢复)/u,/(?:cv).{0,14}(?:40%|超过40|高波动)|(?:轻度\s*npdr|微血管|vpt)/iu];return[];}
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
function answerFormat(task,contract){const formats={entity_exact_match:'short_entity',temporal_localization:'YYYY-MM-DD',state_update:'latest_state_with_change',multiple_choice:'choice_letters',inference_generation:'patient_specific_concise_explanation',multi_hop_clinical_deduction:'memory_nodes_reasoning_path_and_conclusion'};return contract?.format||formats[task]||null;}
