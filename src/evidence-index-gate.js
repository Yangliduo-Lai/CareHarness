export const EVIDENCE_INDEX_GATE_VERSION='evidence-index-chain-gate.v3-type-blind';

// The gate indexes only protocol fields and literal query-plan signals. It has
// no disease, symptom, medication, intent, or benchmark vocabulary.
export function buildEvidenceIndex(states=[],evidence=[]){
  const evidenceById=new Map(evidence.filter(Boolean).map(item=>[String(item.evidence_id),item])),records=[],byStateId=new Map(),byFamily=new Map(),byEpisode=new Map(),byEvidence=new Map(),byEntity=new Map();
  for(const state of states.filter(Boolean)){
    const stateId=String(state.state_id||'');if(!stateId||byStateId.has(stateId))continue;
    const linked=(state.evidence_ids||[]).map(id=>evidenceById.get(String(id))).filter(Boolean),valueText=normalize(state.value),text=normalize([state.value,...linked.flatMap(item=>[item.text,item.source_text])].filter(Boolean).join(' ')),entityTerms=termsFrom(valueText),facets=[state.family,...array(state.factor_domains),...array(state.facets)].filter(Boolean),record={state,text,value_text:valueText,entity_terms:entityTerms,facets:[...new Set(facets)],event_order:eventOrder(state)};
    records.push(record);byStateId.set(stateId,record);pushMap(byFamily,state.family,record);pushMap(byEpisode,String(state.episode_id||''),record);
    for(const id of state.evidence_ids||[])pushMap(byEvidence,String(id),record);
    for(const term of entityTerms)pushMap(byEntity,term,record);
  }
  records.sort((a,b)=>b.event_order-a.event_order||semanticStateKey(a.state).localeCompare(semanticStateKey(b.state)));
  return{version:EVIDENCE_INDEX_GATE_VERSION,records,by_state_id:byStateId,by_family:byFamily,by_episode:byEpisode,by_evidence:byEvidence,by_entity:byEntity,evidence_by_id:evidenceById};
}

export function runEvidenceIndexGate(queryPlan,states=[],evidence=[],options={}){
  const plan=normalizePlan(queryPlan),index=buildEvidenceIndex(states,evidence),profile=coverageProfile(plan),queryTerms=queryExpansionTerms(plan),scored=index.records.map(record=>scoreIndexedRecord(record,plan,profile,queryTerms)).sort(compareIndexed),limit=positiveInteger(options.limit)||profile.candidate_limit,selected=[],seen=new Set();
  const add=item=>{const id=String(item?.record?.state?.state_id||'');if(!id||seen.has(id)||selected.length>=limit)return false;seen.add(id);selected.push(item);return true;};
  for(const item of scored)if(item.lexical_hits.length||item.scope_hits.length||item.option_ids.length)add(item);
  for(const anchor of selected.slice(0,profile.anchor_limit))for(const related of relatedRecords(anchor.record,index,queryTerms))add(scored.find(candidate=>candidate.record.state.state_id===related.state.state_id));
  const coverage=measureCoverage(profile,selected,plan);
  for(const facet of coverage.missing_facets){const item=scored.find(candidate=>!seen.has(candidate.record.state.state_id)&&coversFacet(candidate,facet,plan));add(item);}
  const finalCoverage=measureCoverage(profile,selected,plan),chains=buildChains(selected,index),annotations=Object.fromEntries(selected.map(item=>[item.record.state.state_id,{gate_score:item.score,facets:item.covered_facets,channels:item.channels,chain_ids:chains.map(chain=>chain.chain_id)}]));
  return{enabled:true,version:EVIDENCE_INDEX_GATE_VERSION,candidate_limit:limit,candidate_state_ids:selected.map(item=>item.record.state.state_id),state_annotations:annotations,chains,coverage:{...finalCoverage,second_pass_facets:[],second_pass_added_state_ids:[]},index_summary:{state_count:index.records.length,evidence_count:index.evidence_by_id.size,family_buckets:index.by_family.size,episode_buckets:index.by_episode.size,entity_buckets:index.by_entity.size},profile:{required_facets:profile.required_facets,candidate_limit:profile.candidate_limit},query_channels:{terms:queryTerms.slice(0,64),temporal_operator:plan.temporal_operator,state_scopes:plan.state_scopes}};
}

function coverageProfile(plan){
  const required=[...array(plan.evidence_facets),'direct_facts'],temporal=String(plan.temporal_operator||'none'),multiScope=array(plan.state_scopes).filter(scope=>['primary','high'].includes(String(scope.priority))).length>1;
  if(temporal!=='none')required.push('event_time');
  if(['current','latest'].includes(temporal))required.push('current_state','previous_state');
  if(array(plan.options).length)required.push('option_evidence');
  if(multiScope)required.push('relation_support');
  const broad=multiScope||array(plan.evidence_facets).length>1;
  return{required_facets:[...new Set(required)].slice(0,24),candidate_limit:broad?40:array(plan.options).length?32:24,anchor_limit:broad?8:5};
}

function scoreIndexedRecord(record,plan,profile,queryTerms){
  const lexicalHits=queryTerms.filter(term=>record.text.includes(term)).slice(0,24),valueLexicalHits=queryTerms.filter(term=>record.value_text.includes(term)).slice(0,24),scopeHits=array(plan.state_scopes).filter(scope=>scope.family===record.state.family).map(scope=>scope.family),optionIds=array(plan.options).filter(option=>termsFrom(option.text).some(term=>record.text.includes(term))).map(option=>option.id),coveredFacets=profile.required_facets.filter(facet=>recordCoversFacet(record,facet,plan,{lexical_hits:lexicalHits,option_ids:optionIds}));let score=lexicalHits.length*5+scopeHits.length*3+optionIds.length*5+coveredFacets.length*1.25;
  if(plan.target&&record.text.includes(normalize(plan.target)))score+=6;if(['current','latest'].includes(plan.temporal_operator)&&record.state.status==='active')score+=1;
  const channels=[];if(lexicalHits.length)channels.push('literal_term_index');if(scopeHits.length)channels.push('family_index');if(optionIds.length)channels.push('option_index');if(coveredFacets.length)channels.push('structured_facet_index');if(Number.isFinite(record.event_order))channels.push('temporal_index');
  return{record,score:+score.toFixed(3),lexical_hits:lexicalHits,value_lexical_hits:valueLexicalHits,scope_hits:scopeHits,option_ids:optionIds,covered_facets:coveredFacets,channels};
}

function recordCoversFacet(record,facet,plan,signals={}){
  if(facet==='direct_facts')return Boolean(array(signals.lexical_hits).length||plan.target&&record.text.includes(normalize(plan.target)));
  if(facet==='event_time')return Boolean(record.state.event_time);
  if(facet==='option_evidence')return Boolean(array(signals.option_ids).length);
  if(facet==='current_state')return record.state.status==='active';
  if(facet==='previous_state')return Boolean(record.state.supersedes||array(record.state.version_chain).length||record.state.status&&record.state.status!=='active');
  if(facet==='relation_support')return array(record.state.evidence_ids).length>0;
  return record.facets.includes(facet);
}
function coversFacet(item,facet,plan){return item.covered_facets.includes(facet)||recordCoversFacet(item.record,facet,plan,item);}
function measureCoverage(profile,selected,plan){const covered=profile.required_facets.filter(facet=>selected.some(item=>coversFacet(item,facet,plan))),missing=profile.required_facets.filter(facet=>!covered.includes(facet));return{required_facets:profile.required_facets,covered_facets:covered,missing_facets:missing,coverage_ratio:profile.required_facets.length?covered.length/profile.required_facets.length:1,complete:missing.length===0};}
function relatedRecords(record,index,queryTerms){const out=[],seen=new Set([record.state.state_id]),add=value=>{if(value&&!seen.has(value.state.state_id)){seen.add(value.state.state_id);out.push(value);}};for(const id of [record.state.supersedes,...array(record.state.version_chain)].filter(Boolean))add(index.by_state_id.get(String(id)));for(const id of array(record.state.evidence_ids))for(const sibling of index.by_evidence.get(String(id))||[])add(sibling);for(const term of record.entity_terms.filter(value=>queryTerms.includes(value)).slice(0,4))for(const sibling of(index.by_entity.get(term)||[]).slice(0,4))add(sibling);return out;}
function buildChains(selected,index){if(!selected.length)return[];const ids=selected.map(item=>item.record.state.state_id),idSet=new Set(ids),edges=[],seen=new Set(),add=(from,to,type)=>{const key=`${from}\u0000${to}\u0000${type}`;if(from&&to&&from!==to&&idSet.has(String(from))&&idSet.has(String(to))&&!seen.has(key)){seen.add(key);edges.push({from_state_id:String(from),to_state_id:String(to),type});}};for(const item of selected){const state=item.record.state;for(const id of [state.supersedes,...array(state.version_chain)].filter(Boolean))add(id,state.state_id,'state_transition');for(const evidenceId of array(state.evidence_ids))for(const sibling of index.by_evidence.get(String(evidenceId))||[])add(state.state_id,sibling.state.state_id,'same_evidence');}return[{chain_id:'query-evidence-chain-1',purpose:'structured query evidence',node_state_ids:ids,nodes:selected.map(item=>({state_id:item.record.state.state_id,role:item.value_lexical_hits.length?'direct':'support',facets:item.covered_facets})),edges,covered_facets:[...new Set(selected.flatMap(item=>item.covered_facets))]}];}
function queryExpansionTerms(plan){const provided=[...array(plan.keywords),plan.target,...array(plan.options).map(item=>item.text)].filter(Boolean),raw=provided.length?provided.join(' '):plan.question;return termsFrom(raw).slice(0,128);}
function termsFrom(value){const matches=normalize(value).match(/[a-z][a-z0-9.+-]{1,}|\d+(?:\.\d+)?|[\p{Script=Han}]{2,12}/gu)||[];return[...new Set(matches.map(normalize).filter(term=>term.length>1&&term.length<=24))];}
function normalizePlan(plan={}){return{question:String(plan.question||''),target:plan.target||null,keywords:array(plan.keywords),state_scopes:array(plan.state_scopes),temporal_operator:String(plan.temporal_operator||'none'),evidence_facets:array(plan.evidence_facets),options:array(plan.options)};}
function compareIndexed(a,b){return b.score-a.score||b.record.event_order-a.record.event_order||semanticStateKey(a.record.state).localeCompare(semanticStateKey(b.record.state));}
function semanticStateKey(state){return[state.family,state.value,state.episode_id,state.turn_id,state.event_time].map(value=>String(value??'')).join('\u0000');}
function eventOrder(state){const parsed=Date.parse(state?.event_time||'');if(Number.isFinite(parsed))return parsed;const match=/(\d+)/u.exec(String(state?.episode_id||''));return match?Number(match[1]):0;}
function pushMap(map,key,value){if(!key)return;const items=map.get(key)||[];items.push(value);map.set(key,items);}
function normalize(value){return String(value||'').normalize('NFKC').toLowerCase();}
function positiveInteger(value){const number=Number(value);return Number.isInteger(number)&&number>0?number:null;}
function array(value){return Array.isArray(value)?value:[];}
