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
  const reasons=[],matchedKeywords=[],matchedAliases=[],matchedConcepts=[],matchedFacets=[],matchedScopes=[],optionIds=[];
  let score=0,maxSimilarity=0;
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
  const qualifyingReasons=new Set(['keyword_match','target_match','medical_alias_match','semantic_concept_match','lexical_ngram_match','scope_family_prior','evidence_facet_match','option_match']),qualified=reasons.some(reason=>qualifyingReasons.has(reason));
  return{state,score:+score.toFixed(4),qualified,reasons:[...new Set(reasons)],matched_keywords:[...new Set(matchedKeywords)],matched_aliases:[...new Set(matchedAliases)],matched_concepts:[...new Set(matchedConcepts)],matched_scopes:matchedScopes,matched_facets:[...new Set(matchedFacets)],option_ids:[...new Set(optionIds)],lexical_similarity:+maxSimilarity.toFixed(4),linked_to:null};
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
    for(const id of related){const existing=recordById.get(id);if(existing){existing.reasons=[...new Set([...(existing.reasons||[]),'version_chain_context'])];existing.linked_to=existing.linked_to||record.state.state_id;continue;}if(!byId.has(id))continue;const state=byId.get(id),linked={state,score:+Math.max(.7,record.score-1.25).toFixed(4),qualified:true,reasons:['version_chain_context'],matched_keywords:[],matched_aliases:[],matched_concepts:[],matched_scopes:[],matched_facets:[],option_ids:[],lexical_similarity:0,linked_to:record.state.state_id};records.push(linked);recordById.set(id,linked);}
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
  if(record.reasons.some(reason=>['keyword_match','target_match','medical_alias_match','option_match'].includes(reason)))return 3;
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
  const merged={...representative,state:mergedState,score:Math.max(...records.map(record=>record.score)),qualified:true,reasons:[...new Set([...records.flatMap(record=>record.reasons||[]),'content_duplicate_merged'])],matched_keywords:[...new Set(records.flatMap(record=>record.matched_keywords||[]))],matched_aliases:[...new Set(records.flatMap(record=>record.matched_aliases||[]))],matched_concepts:[...new Set(records.flatMap(record=>record.matched_concepts||[]))],matched_scopes:uniqueObjects(records.flatMap(record=>record.matched_scopes||[])),matched_facets:[...new Set(records.flatMap(record=>record.matched_facets||[]))],option_ids:[...new Set(records.flatMap(record=>record.option_ids||[]))],lexical_similarity:Math.max(...records.map(record=>Number(record.lexical_similarity)||0)),member_records:records};
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
    const selected=[],seen=new Set(),quota=Math.max(2,Math.floor(limit/options.length));
    for(const option of options)for(const record of records.filter(item=>item.option_ids.includes(option.id)).slice(0,quota)){if(!seen.has(record.state.state_id)){selected.push(record);seen.add(record.state.state_id);}}
    for(const record of records){if(selected.length>=limit)break;if(!seen.has(record.state.state_id)){selected.push(record);seen.add(record.state.state_id);}}
    return selected.sort((a,b)=>compareCandidates(a,b,plan)).slice(0,limit);
  }
  if(plan.query_type==='inference_generation'||plan.query_type==='multi_hop_clinical_deduction')return diversifyInferenceCandidates(records,plan,limit);
  return records.slice(0,limit);
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

function candidateTrace(record){return{state_id:record.state.state_id,family:record.state.family,score:record.score,reasons:record.reasons,matched_keywords:record.matched_keywords,matched_aliases:record.matched_aliases,matched_concepts:record.matched_concepts,matched_scopes:record.matched_scopes,matched_facets:record.matched_facets,option_ids:record.option_ids,lexical_similarity:record.lexical_similarity,linked_to:record.linked_to,...(record.gate_facets?{gate_score:record.gate_score,gate_facets:record.gate_facets,gate_channels:record.gate_channels||[],gate_chain_ids:record.gate_chain_ids||[]}:{}),provenance_group:record.provenance_group||null,provenance_priority:record.provenance_priority||'unique',provenance_sibling_count:record.provenance_sibling_count||0,shared_evidence_ids:record.shared_evidence_ids||[],novel_evidence_ids:record.novel_evidence_ids||[],merged_duplicate_group:Boolean(record.state.merged_duplicate_group),merged_state_count:record.state.merged_state_count||1,merged_state_ids:record.state.merged_state_ids||[record.state.state_id],merged_families:record.state.merged_families||[{state_id:record.state.state_id,family:record.state.family,status:record.state.status??null,version:record.state.version??null,event_time:record.state.event_time??null,episode_id:record.state.episode_id??null}],value:record.state.value,event_time:record.state.event_time||null,status:record.state.status||null};}
function countChannels(records){const counts={keyword_match:0,target_match:0,medical_alias_match:0,semantic_concept_match:0,lexical_ngram_match:0,scope_family_prior:0,evidence_facet_match:0,option_match:0,version_chain_context:0};if(records.some(record=>record.gate_facets)){counts.evidence_index_gate=0;counts.evidence_chain_member=0;}for(const record of records)for(const reason of record.reasons)if(reason in counts)counts[reason]++;return counts;}
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
function eventOrder(state){const time=Date.parse(state?.event_time||'');if(Number.isFinite(time))return time;const session=/session-(\d+)/.exec(state?.episode_id||'');return session?Number(session[1]):0;}
function idOrder(a,b){return String(a.state_id).localeCompare(String(b.state_id));}
function parseOptions(question){const options=[];for(const match of String(question||'').matchAll(/(?:^|\n)\s*([A-Z])[.、)]\s*([^\n]+)/g))options.push({id:match[1].toUpperCase(),text:match[2].trim()});return options;}
function positiveInteger(value){const number=Number(value);return Number.isInteger(number)&&number>0?number:null;}
function answerFormat(task,contract){const formats={entity_exact_match:'short_entity',temporal_localization:'YYYY-MM-DD',state_update:'latest_state_with_change',multiple_choice:'choice_letters',inference_generation:'patient_specific_concise_explanation',multi_hop_clinical_deduction:'memory_nodes_reasoning_path_and_conclusion'};return contract?.format||formats[task]||null;}
