import { aliasesIn } from './medical-terms.js';

export const EVIDENCE_INDEX_GATE_VERSION='evidence-index-chain-gate.v1';

const COMPLEX_TASKS=new Set(['inference_generation','multi_hop_clinical_deduction']);
const QUERY_STOP_TERMS=new Set(['患者','医生','用户','请问','目前','现在','当前','最近','近期','问题','情况','是否','什么','怎么','如何','patient','doctor','current','currently']);
const FACET_FAMILIES={
  medical_history:['BC'],diagnosis:['CS'],clinical_context:['BC','CS'],medication_status:['CS'],adherence:['PE'],objective_results:['CS'],
  symptoms:['PE'],symptoms_or_adverse_effects:['PE'],treatment_response:['LO'],longitudinal_change:['LO'],current_status:['CS','LO'],previous_state:['LO'],
  contraindications_and_allergies:['CS'],allergies_and_contraindications:['CS'],safety_constraints:['CS','CP'],serious_complications:['CS','PE'],
  patient_preference:['PA'],patient_appraisal:['PA'],goals:['PA','CP','LO'],care_plan:['CP'],monitoring:['CP','PE'],real_world_context:['BC'],sleep:['PE'],cross_episode:['LO']
};
const FACET_PATTERNS={
  medical_history:/既往|病史|曾患|history of|medical history/i,diagnosis:/确诊|诊断|临床评估|diagnos|clinical assessment/i,
  medication_status:/服药|用药|停药|停用|剂量|medication|taking|discontinu|dose/i,adherence:/规律|按时|漏服|漏药|依从|adherence|missed dose/i,
  objective_results:/\d|检查|检验|化验|血糖|糖化|UACR|血压|心率|量表|test|result|glucose|pressure|score/i,
  symptoms:/症状|疼|痛|恶心|口渴|多尿|头晕|乏力|模糊|symptom|pain|nause|thirst|dizz|fatigue|blur/i,
  symptoms_or_adverse_effects:/症状|不良反应|副作用|疼|恶心|头晕|乏力|心悸|symptom|adverse|side effect|pain|nause|dizz|fatigue|palpitation/i,
  treatment_response:/治疗|服药|用药|干预|改善|恶化|有效|无效|反应|treatment|medication|response|improv|wors/i,
  longitudinal_change:/从.*到|由.*变|较前|相比|改善|恶化|复发|升高|下降|previously|changed|improv|wors|recurr|increase|decrease/i,
  current_status:/目前|当前|现在|正在|已停|current|currently|now|active|stopped/i,previous_state:/此前|既往|曾经|原来|previous|formerly|history/i,
  contraindications_and_allergies:/禁忌|过敏|不得使用|避免.*药|contraindicat|allerg/i,allergies_and_contraindications:/禁忌|过敏|不得使用|避免.*药|contraindicat|allerg/i,
  safety_constraints:/风险|红旗|禁忌|过敏|安全计划|危机|急诊|risk|red flag|contraindicat|allerg|safety plan|crisis|emergency/i,
  serious_complications:/严重|并发症|DKA|酮症酸中毒|自伤|自杀|危重|complication|ketoacidosis|self[- ]?harm|suicid|critical/i,
  patient_preference:/偏好|愿意|承诺|选择|希望|prefer|willing|commit|choose|hope/i,patient_appraisal:/认为|觉得|担心|相信|理解|think|belie|worr|interpret/i,
  goals:/目标|希望|计划达成|goal|hope|target/i,care_plan:/建议|计划|治疗|监测|复诊|随访|recommend|plan|treat|monitor|follow/i,
  monitoring:/监测|测量|记录|复查|monitor|measure|track|check/i,real_world_context:/工作|项目|家庭|费用|保险|交通|住房|支持|work|family|cost|insurance|transport|housing|support/i,
  sleep:/睡眠|失眠|夜醒|入睡|sleep|insomnia/i,cross_episode:/上次|此前.*相比|跨.*(?:Session|Episode)|previous session|cross[- ]?episode|compared with/i
};

// This index is deliberately derived only from visible State/Evidence. It does
// not accept benchmark Gold, Judge metadata, or reference key points.
export function buildEvidenceIndex(states=[],evidence=[]){
  const evidenceById=new Map(evidence.filter(Boolean).map(item=>[String(item.evidence_id),item])),records=[],byStateId=new Map(),byFamily=new Map(),byEpisode=new Map(),byEvidence=new Map(),byEntity=new Map();
  for(const state of states.filter(Boolean)){
    const stateId=String(state.state_id||'');if(!stateId||byStateId.has(stateId))continue;
    const linked=(state.evidence_ids||[]).map(id=>evidenceById.get(String(id))).filter(Boolean),valueText=normalize(state.value),text=normalize([state.value,...linked.flatMap(item=>[item.text,item.source_text])].filter(Boolean).join(' ')),entityTerms=entityTermsFrom(valueText),facets=stateFacets(state),record={state,text,value_text:valueText,entity_terms:entityTerms,facets,event_order:eventOrder(state)};
    records.push(record);byStateId.set(stateId,record);pushMap(byFamily,state.family,record);pushMap(byEpisode,String(state.episode_id||''),record);
    for(const id of state.evidence_ids||[])pushMap(byEvidence,String(id),record);
    for(const term of entityTerms)pushMap(byEntity,term,record);
  }
  records.sort((a,b)=>b.event_order-a.event_order||semanticStateKey(a.state).localeCompare(semanticStateKey(b.state)));
  return{version:EVIDENCE_INDEX_GATE_VERSION,records,by_state_id:byStateId,by_family:byFamily,by_episode:byEpisode,by_evidence:byEvidence,by_entity:byEntity,evidence_by_id:evidenceById};
}

export function runEvidenceIndexGate(queryPlan,states=[],evidence=[],options={}){
  const plan=normalizePlan(queryPlan),index=buildEvidenceIndex(states,evidence),profile=coverageProfile(plan),queryTerms=queryExpansionTerms(plan),scored=index.records.map(record=>scoreIndexedRecord(record,plan,profile,queryTerms)).sort(compareIndexed),limit=positiveInteger(options.limit)||profile.candidate_limit;
  const direct=scored.filter(item=>item.lexical_hits.length||item.scope_hits.length||item.option_ids.length).slice(0,profile.direct_limit),selected=[],seen=new Set(),add=item=>{if(!item||seen.has(item.record.state.state_id)||selected.length>=limit)return false;seen.add(item.record.state.state_id);selected.push(item);return true;};
  for(const item of direct){item.coverage_relevant=Boolean(item.value_lexical_hits.length||item.option_ids.length||!profile.complex&&item.scope_hits.length);add(item);}
  // First-pass relation expansion keeps explicit versions, shared provenance,
  // and closely linked same-entity states near the direct anchors.
  for(const anchor of [...selected].filter(item=>item.coverage_relevant).slice(0,profile.anchor_limit))for(const related of relatedRecords(anchor.record,index,queryTerms).slice(0,profile.relation_limit)){const item=scored.find(candidate=>candidate.record.state.state_id===related.state.state_id);if(item){item.coverage_relevant=true;item.relation_to_anchor=related._relation;add(item);}}
  let coverage=measureCoverage(profile,selected,plan),secondPassFacets=[],secondPassStateIds=[];
  for(const facet of coverage.missing_facets){
    const candidate=scored.find(item=>!seen.has(item.record.state.state_id)&&facetCandidateRelevant(item,facet,plan,profile)&&coversFacet(item,facet,plan));
    if(candidate){candidate.coverage_relevant=true;if(add(candidate)){secondPassFacets.push(facet);secondPassStateIds.push(candidate.record.state.state_id);}}
  }
  // Preserve the existing high-relevance route as a fail-open union, then use
  // unused indexed records only when the gate still has room.
  for(const item of scored){if(selected.length>=limit)break;if(item.lexical_hits.length||item.scope_hits.length||item.option_ids.length)add(item);}
  coverage=measureCoverage(profile,selected,plan);
  const chains=buildChains(selected,profile,index,plan),annotations=Object.fromEntries(selected.map(item=>[item.record.state.state_id,{gate_score:item.score,facets:item.covered_facets.filter(facet=>facetCandidateRelevant(item,facet,plan,profile)),channels:item.channels,chain_ids:chains.filter(chain=>chain.node_state_ids.includes(item.record.state.state_id)).map(chain=>chain.chain_id)}]));
  return{enabled:true,version:EVIDENCE_INDEX_GATE_VERSION,candidate_limit:limit,candidate_state_ids:selected.map(item=>item.record.state.state_id),state_annotations:annotations,chains,coverage:{...coverage,second_pass_facets:secondPassFacets,second_pass_added_state_ids:secondPassStateIds},index_summary:{state_count:index.records.length,evidence_count:index.evidence_by_id.size,family_buckets:index.by_family.size,episode_buckets:index.by_episode.size,entity_buckets:index.by_entity.size},profile:{task:profile.task,required_facets:profile.required_facets,candidate_limit:profile.candidate_limit},query_channels:{terms:queryTerms.slice(0,64),temporal_operator:plan.temporal_operator||'none',state_scopes:plan.state_scopes||[]}};
}

function coverageProfile(plan){
  const task=String(plan.query_type||'generic'),required=[...(plan.evidence_facets||[])];
  if(task==='entity_exact_match')required.push('direct_facts');
  else if(task==='temporal_localization')required.push('direct_facts','event_time');
  else if(task==='state_update')required.push('direct_facts','current_status','previous_state','longitudinal_change');
  else if(task==='multiple_choice')required.push('option_evidence');
  else if(COMPLEX_TASKS.has(task))required.push('direct_facts','diagnosis','medication_status','adherence','treatment_response','objective_results','symptoms_or_adverse_effects','serious_complications','contraindications_and_allergies','longitudinal_change','patient_preference','care_plan');
  else if(task==='task_2'||task==='task_3')required.push('direct_facts','patient_appraisal','goals','patient_preference','longitudinal_change','care_plan');
  else if(/^(wai|htais|ctrs|rro|custom|panas|scl-90|srs|bdi-ii)$/i.test(task))required.push('direct_facts','patient_appraisal','symptoms_or_adverse_effects','care_plan');
  else required.push('direct_facts');
  if(/为什么|为何|原因|依据|变化|进展|why|reason|change|progress/i.test(plan.question||''))required.push('longitudinal_change','clinical_context');
  const deduped=[...new Set(required.filter(Boolean))].slice(0,24),complex=COMPLEX_TASKS.has(task)||deduped.length>7;
  return{task,complex,required_facets:deduped,candidate_limit:complex?40:task==='multiple_choice'?32:24,direct_limit:complex?14:10,anchor_limit:complex?8:5,relation_limit:complex?3:2};
}

function scoreIndexedRecord(record,plan,profile,queryTerms){
  const lexicalHits=queryTerms.filter(term=>record.text.includes(normalize(term))).slice(0,24),valueLexicalHits=queryTerms.filter(term=>record.value_text.includes(normalize(term))).slice(0,24),scopeHits=[];
  for(const scope of plan.state_scopes||[])if(scope.family===record.state.family)scopeHits.push(record.state.family);
  const optionIds=(plan.options||[]).filter(option=>termsFrom(option.text).some(term=>record.text.includes(term))).map(option=>option.id),coveredFacets=profile.required_facets.filter(facet=>recordCoversFacet(record,facet,plan,{lexicalHits,optionIds}));
  let score=lexicalHits.length*5+scopeHits.length*3+optionIds.length*5+coveredFacets.length*1.25;
  if(plan.target&&record.text.includes(normalize(plan.target)))score+=6;
  if(['current','latest'].includes(plan.temporal_operator)&&record.state.status==='active')score+=1;
  if(plan.temporal_operator==='history'&&record.state.family==='BC')score+=1;
  const channels=[];if(lexicalHits.length)channels.push('entity_topic_index');if(scopeHits.length)channels.push('family_index');if(optionIds.length)channels.push('option_index');if(coveredFacets.length)channels.push('coverage_facet_index');if(Number.isFinite(record.event_order))channels.push('temporal_index');
  return{record,score:+score.toFixed(3),lexical_hits:lexicalHits,value_lexical_hits:valueLexicalHits,scope_hits:scopeHits,option_ids:optionIds,covered_facets:coveredFacets,channels};
}

function compareIndexed(a,b){return b.score-a.score||b.record.event_order-a.record.event_order||semanticStateKey(a.record.state).localeCompare(semanticStateKey(b.record.state));}

function measureCoverage(profile,selected,plan){const required=profile.required_facets,covered=required.filter(facet=>selected.some(item=>item.coverage_relevant&&facetCandidateRelevant(item,facet,plan,profile)&&coversFacet(item,facet,plan))),missing=required.filter(facet=>!covered.includes(facet));return{required_facets:required,covered_facets:covered,missing_facets:missing,coverage_ratio:required.length?covered.length/required.length:1,complete:missing.length===0};}
function coversFacet(item,facet,plan){return item.covered_facets.includes(facet)||recordCoversFacet(item.record,facet,plan,item);}
function facetCandidateRelevant(item,facet,plan,profile){const direct=Boolean(item.value_lexical_hits.length||item.option_ids.length);if(direct)return true;if(new Set(['diagnosis','objective_results','contraindications_and_allergies','allergies_and_contraindications','safety_constraints','serious_complications','medical_history','patient_preference','care_plan']).has(facet))return false;if(item.relation_to_anchor)return true;if(!profile.complex&&item.scope_hits.length)return true;if(['current_status','previous_state','event_time'].includes(facet))return item.scope_hits.length>0;return false;}
function recordCoversFacet(record,facet,plan,signals={}){
  if(facet==='direct_facts')return Boolean(signals.lexicalHits?.length||signals.lexical_hits?.length||plan.target&&record.text.includes(normalize(plan.target)));
  if(facet==='event_time')return Boolean(record.state.event_time);
  if(facet==='option_evidence')return Boolean(signals.optionIds?.length||signals.option_ids?.length);
  if(facet==='current_status')return record.state.status==='active'||record.state.operation==='UPDATE'||record.state.operation==='SUPERSEDE'||FACET_PATTERNS.current_status.test(record.text);
  if(facet==='previous_state')return Boolean(record.state.supersedes||(record.state.version_chain||[]).length||record.state.status&&record.state.status!=='active');
  const families=FACET_FAMILIES[facet],pattern=FACET_PATTERNS[facet];return families?families.includes(record.state.family)&&(!pattern||pattern.test(record.text)):record.facets.includes(facet);
}

function relatedRecords(record,index,queryTerms){
  const out=[],seen=new Set([record.state.state_id]),add=(candidate,relation)=>{if(!candidate||seen.has(candidate.state.state_id))return;seen.add(candidate.state.state_id);out.push({...candidate,_relation:relation});};
  for(const id of [record.state.supersedes,...(record.state.version_chain||[])].filter(Boolean))add(index.by_state_id.get(String(id)),'state_transition');
  for(const id of record.state.evidence_ids||[])for(const sibling of index.by_evidence.get(String(id))||[])add(sibling,'same_evidence');
  const entities=record.entity_terms.filter(term=>queryTerms.includes(term)).slice(0,4);for(const term of entities)for(const sibling of (index.by_entity.get(term)||[]).slice(0,4))add(sibling,'same_entity');
  return out.sort((a,b)=>b.event_order-a.event_order||semanticStateKey(a.state).localeCompare(semanticStateKey(b.state)));
}

function buildChains(selected,profile,index,plan){
  if(!selected.length)return[];const nodeIds=selected.map(item=>item.record.state.state_id),nodeSet=new Set(nodeIds),edges=[],edgeKeys=new Set(),addEdge=(from,to,type)=>{if(!from||!to||from===to||!nodeSet.has(from)||!nodeSet.has(to))return;const key=`${from}\u0000${to}\u0000${type}`;if(edgeKeys.has(key))return;edgeKeys.add(key);edges.push({from_state_id:from,to_state_id:to,type});};
  for(const item of selected){const state=item.record.state;for(const id of [state.supersedes,...(state.version_chain||[])].filter(Boolean))addEdge(String(id),state.state_id,'state_transition');for(const evidenceId of state.evidence_ids||[])for(const sibling of index.by_evidence.get(String(evidenceId))||[])addEdge(state.state_id,sibling.state.state_id,'same_evidence');}
  const root=selected.find(item=>item.lexical_hits.length)?.record.state.state_id||nodeIds[0];for(const item of selected){const id=item.record.state.state_id;if(id!==root&&!edges.some(edge=>edge.from_state_id===id||edge.to_state_id===id))addEdge(root,id,COMPLEX_TASKS.has(profile.task)?'supports_decision':'supports_answer');}
  return[{chain_id:'query-evidence-chain-1',purpose:chainPurpose(profile.task),node_state_ids:nodeIds,nodes:selected.map(item=>({state_id:item.record.state.state_id,role:item.value_lexical_hits.length?'direct':item.record.state.supersedes||(item.record.state.version_chain||[]).length?'bridge':'support',facets:item.covered_facets.filter(facet=>facetCandidateRelevant(item,facet,plan,profile))})),edges,covered_facets:measureCoverage(profile,selected,plan).covered_facets}];
}

function chainPurpose(task){if(task==='state_update')return'current state plus prior transition';if(task==='temporal_localization')return'target event occurrences with time';if(task==='multiple_choice')return'per-option support or contradiction';if(COMPLEX_TASKS.has(task))return'patient-specific decision evidence across clinical dimensions';return'query-specific grounded evidence';}

function stateFacets(state){const text=normalize(state.value),out=[state.family];for(const[facet,families]of Object.entries(FACET_FAMILIES))if(families.includes(state.family)&&(!FACET_PATTERNS[facet]||FACET_PATTERNS[facet].test(text)))out.push(facet);return[...new Set(out)];}
function queryExpansionTerms(plan){const raw=[plan.question,plan.target,...(plan.keywords||[]),...(plan.options||[]).map(item=>item.text)].filter(Boolean).join(' '),terms=new Set([...termsFrom(raw),...aliasesIn(raw).map(normalize),...domainTerms(raw)]);return[...terms].filter(term=>term.length>1&&!QUERY_STOP_TERMS.has(term)).slice(0,128);}
function domainTerms(value){const text=normalize(value),out=[];if(/糖尿病|血糖|降糖|胰岛素|二甲双胍|恩格列净|diabet|glucose|insulin|metformin|empagliflozin/.test(text))out.push('糖尿病','血糖','糖化血红蛋白','hba1c','胰岛素','二甲双胍','恩格列净','gada','抗体','c肽','酮体','酮症酸中毒','视网膜病变','多饮','多尿','体重下降','乏力','治疗失效');if(/头痛|疼痛|pain|headache/.test(text))out.push('头痛','疼痛','止痛','对乙酰氨基酚','nsaid','过敏','禁忌');if(/心理|情绪|焦虑|抑郁|治疗关系|咨询|therapy|anxi|depress/.test(text))out.push('情绪','焦虑','抑郁','目标','偏好','担忧','治疗','干预','进展');return out.map(normalize);}
function termsFrom(value){const text=normalize(value),out=text.match(/[a-z][a-z0-9.+-]{2,}|\d+(?:\.\d+)?(?:%|mg|kg|mmol\/l)?|[\p{Script=Han}]{2,8}/gu)||[];return[...new Set(out.map(normalize))];}
function entityTermsFrom(value){return termsFrom(value).filter(term=>term.length>=2&&term.length<=24&&!/^(患者|医生|目前|当前|近期|情况|问题|建议|记录)$/.test(term)).slice(0,80);}
function normalizePlan(plan={}){return{query_type:String(plan.query_type||plan.task||'generic'),question:String(plan.question||''),target:plan.target||null,keywords:Array.isArray(plan.keywords)?plan.keywords:[],state_scopes:Array.isArray(plan.state_scopes)?plan.state_scopes:[],temporal_operator:String(plan.temporal_operator||'none'),evidence_facets:Array.isArray(plan.evidence_facets)?plan.evidence_facets:[],options:Array.isArray(plan.options)?plan.options:[]};}
function semanticStateKey(state){return[state.family,state.value,state.episode_id,state.turn_id,state.event_time].map(value=>String(value??'')).join('\u0000');}
function eventOrder(state){const parsed=Date.parse(state?.event_time||'');if(Number.isFinite(parsed))return parsed;const match=/session-(\d+)/i.exec(state?.episode_id||'');return match?Number(match[1]):0;}
function pushMap(map,key,value){if(!key)return;const items=map.get(key)||[];items.push(value);map.set(key,items);}
function normalize(value){return String(value||'').normalize('NFKC').toLowerCase();}
function positiveInteger(value){const number=Number(value);return Number.isInteger(number)&&number>0?number:null;}
