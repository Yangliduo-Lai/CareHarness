const TOKEN=/[a-z][a-z0-9+.-]{2,}|\d+(?:\.\d+)?(?:%|mg|mcg|ml|mmhg|kg|bpm)?/giu;
const STOP=new Set(('the a an and or of to in on at by for from with without during was were is are be been being patient doctor ' +
  'admission hospital hospitalization history medical clinical treatment condition noted reported states stated also this that these those ' +
  'had has have did does do after before over time due because which what when where why how').split(/\s+/u));
const CLINICAL=/(?:\d|mg|mcg|ml|mmhg|bpm|diagnos|medicat|treat|therap|dialy|catheter|infect|pain|blood|count|test|scan|surgery|procedure|symptom|discharg|admit|started|stopped|changed|improved|worsened|positive|negative)/iu;
const DIAGNOSTIC=/(?:diagnos|confirm|positive|negative|disease|syndrome|disorder|infection|bacter|fung|viral|cancer|tumou?r|stenosis|thrombo|embol|fracture|colitis|neuralgia|folliculitis|arrhythm|failure)/iu;
const EVENT_STATUSES=new Set(['documented','planned','negated','uncertain']);
const COUNT_UNITS=new Set(['admission','event','site']);
const OVERVIEW_ANCHOR_LIMIT=3;
const OVERVIEW_ANCHOR_TERMS=4;
const OVERVIEW_ANCHOR_TEXT_LIMIT=120;

/**
 * Build a query-independent navigation table from the visible conversation
 * graph. It deliberately contains no benchmark Evidence, Gold, or answer
 * material and is never an answer source.
 */
export function buildMedLoCoMoAdmissionOverview(memoryNodes=[]){
  const turns=canonicalTurns(memoryNodes),groups=new Map();
  for(const turn of turns){const row=groups.get(turn.episode_id)||{episode_id:turn.episode_id,turns:[]};row.turns.push(turn);groups.set(turn.episode_id,row);}
  const documents=[...groups.values()].map(row=>new Set(row.turns.flatMap(turn=>tokens(turn.text)))),df=new Map();
  for(const doc of documents)for(const token of doc)df.set(token,(df.get(token)||0)+1);
  const count=Math.max(1,groups.size),admissions=[...groups.values()].map(row=>{
    row.turns.sort(compareTurn);
    const dates=row.turns.map(turn=>calendarDate(turn.event_time)).filter(Boolean).sort(),speaker_counts={patient:0,doctor:0};
    for(const turn of row.turns)speaker_counts[turn.source_type==='patient'?'patient':'doctor']++;
    const tf=new Map();for(const turn of row.turns)for(const token of tokens(turn.text))tf.set(token,(tf.get(token)||0)+1);
    const scoredTerms=[...tf.entries()].map(([term,frequency])=>({term,score:(1+Math.log(frequency))*Math.log(1+(count-(df.get(term)||0)+.5)/((df.get(term)||0)+.5))+termClinicalBoost(term,row.turns)})).sort((a,b)=>b.score-a.score||a.term.localeCompare(b.term));
    const key_terms=scoredTerms.slice(0,12).map(item=>item.term),topic_anchors=selectTopicAnchors(row.turns,scoredTerms);
    const representative=topic_anchors[0]||null;
    return{admission_id:row.episode_id,start_date:dates[0]||null,end_date:dates.at(-1)||null,turn_count:row.turns.length,speaker_counts,key_terms,representative_source_excerpt:representative?.excerpt||null,topic_anchors,navigation_only:true};
  }).sort((left,right)=>String(left.start_date||'').localeCompare(String(right.start_date||''))||left.admission_id.localeCompare(right.admission_id));
  return{version:'medlocomo-admission-overview.v2-multi-topic-source-anchors',navigation_only:true,answer_evidence:false,admission_count:admissions.length,admissions};
}

/** Convert the Assessor handoff into an auditable table of covered and missing roles. */
export function buildMedLoCoMoRoleCoverage({assessment=null,memory_nodes=[]}={}){
  const value=assessment&&typeof assessment==='object'?assessment:{},byId=new Map(array(memory_nodes).map(node=>[String(node?.memory_id||''),node])),rows=[];
  const add=row=>{const normalized=normalizeCoverageRow(row,byId);if(normalized&&!rows.some(item=>coverageKey(item)===coverageKey(normalized)))rows.push(normalized);};
  for(const row of array(value.role_coverage))add(row);
  if(!rows.some(row=>row.status!=='missing'))for(const item of array(value.answer_focus))add({role:item?.role||'target',status:'covered',claim:item?.aspect||'',source_refs:item?.source_refs,source_ref:item?.source_ref,memory_ids:item?.memory_ids});
  for(const gap of array(value.missing_information))add({role:'unresolved',status:'missing',claim:'',missing_detail:String(gap||'')});
  const covered=rows.filter(row=>row.status==='covered'),missing=rows.filter(row=>row.status==='missing'||row.status==='partial');
  return{version:'medlocomo-role-coverage.v1',assessment:String(value.assessment||'unresolved'),complete:value.assessment==='supported'&&!missing.length,covered_role_count:covered.length,missing_role_count:missing.length,rows};
}

/**
 * Freeze only source-grounded answer-bearing rows. The literal source excerpt
 * is carried inside each row, so Answer does not need a second duplicate copy
 * of the complete candidate State packet.
 */
export function buildMedLoCoMoEvidenceLedger({question_request=null,assessment=null,memory_nodes=[]}={}){
  const nodes=array(memory_nodes),coverage=buildMedLoCoMoRoleCoverage({assessment,memory_nodes:nodes}),pool=buildCanonicalSourcePool(nodes),role_annotations=buildRoleAnnotations(coverage,pool),roleBySource=new Map();
  for(const annotation of role_annotations){
    if(annotation.status==='missing')continue;
    for(const ref of annotation.canonical_source_refs){const items=roleBySource.get(ref)||[];items.push({role:annotation.role,status:annotation.status,source_refs:annotation.source_refs,memory_ids:annotation.memory_ids,interpretation_only:true});roleBySource.set(ref,items);}
  }
  const rows=pool.rows.map(source=>{
    const roles=dedupeRoles(roleBySource.get(source.source_ref)||[]),primary=roles[0]||null;
    return{role:primary?.role||'source_packet',status:primary?.status||'covered',role_interpretation_only:true,claim:source.evidence_text,admission_id:source.admission_id,turn_id:source.turn_id,event_time:source.event_time,speaker:source.speaker,source_ref:source.source_ref,source_refs:source.source_refs,memory_ids:source.memory_ids,evidence_text:source.evidence_text,source_fragment_count:source.source_fragments.length,roles};
  });
  const interpretation_links=buildInterpretationLinks(assessment,pool),task_structure=buildTaskStructure({question_request,assessment,coverage,pool,role_annotations});
  return{version:'medlocomo-evidence-ledger.v3-admission-aligned-source-pool',question:String(question_request?.question||question_request||''),source_grounded:true,admission_count:new Set(rows.map(row=>row.admission_id).filter(Boolean)).size,row_count:rows.length,coverage,rows,role_annotations,interpretation_links,task_structure,audit:pool.audit};
}

function buildCanonicalSourcePool(nodes){
  const groups=new Map(),dropped=[];
  for(let index=0;index<array(nodes).length;index++){
    const node=nodes[index],memory_id=String(node?.memory_id||''),admission_id=String(node?.episode_id||''),turn_id=String(node?.turn_id||''),evidence_text=String(node?.source_text||'').trim();
    if(!memory_id||!admission_id||!turn_id||!evidence_text){dropped.push({memory_id:memory_id||null,reason:!evidence_text?'missing_source_text':'missing_source_identity'});continue;}
    const key=`${admission_id}\u0000${turn_id}`,candidate={node,memory_id,admission_id,turn_id,evidence_text,index},group=groups.get(key)||{key,candidates:[]};group.candidates.push(candidate);groups.set(key,group);
  }
  const rows=[],aliasToSourceRef=new Map(),sourceRefToRow=new Map(),retained_memory_ids=[];
  for(const group of groups.values()){
    group.candidates.sort((left,right)=>sourceNodePriority(right.node)-sourceNodePriority(left.node)||right.evidence_text.length-left.evidence_text.length||left.index-right.index);
    const canonical=group.candidates[0],memory_ids=unique(group.candidates.map(item=>item.memory_id)),source_refs=memory_ids.map(id=>`memory:${id}`),source_ref=`memory:${canonical.memory_id}`,source_fragments=mergeSourceFragments(group.candidates),evidence_text=source_fragments.join('\n');
    const row={admission_id:canonical.admission_id,turn_id:canonical.turn_id,event_time:canonical.node?.event_time||null,speaker:String(canonical.node?.source_type||''),source_ref,source_refs,memory_ids,evidence_text,source_fragments,index:canonical.index};
    rows.push(row);sourceRefToRow.set(source_ref,row);retained_memory_ids.push(canonical.memory_id);
    for(const item of group.candidates){aliasToSourceRef.set(item.memory_id,source_ref);aliasToSourceRef.set(`memory:${item.memory_id}`,source_ref);if(item!==canonical)dropped.push({memory_id:item.memory_id,reason:'duplicate_source_turn',retained_as:canonical.memory_id});}
  }
  rows.sort((left,right)=>String(left.event_time||'').localeCompare(String(right.event_time||''))||left.admission_id.localeCompare(right.admission_id)||numeric(left.turn_id)-numeric(right.turn_id)||left.index-right.index);
  return{rows,aliasToSourceRef,sourceRefToRow,audit:{version:'medlocomo-evidence-ledger-audit.v1',retention_policy:'all_valid_final_packet_source_turns_once',input_memory_count:array(nodes).length,retained_source_row_count:rows.length,retained_memory_ids,retained_alias_memory_count:rows.reduce((sum,row)=>sum+row.memory_ids.length,0),retained_source_fragment_count:rows.reduce((sum,row)=>sum+row.source_fragments.length,0),merged_fragment_row_count:rows.filter(row=>row.source_fragments.length>1).length,dropped_memory_count:dropped.length,dropped_memory_ids:dropped.map(item=>item.memory_id).filter(Boolean),dropped,duplicate_source_turn_count:dropped.filter(item=>item.reason==='duplicate_source_turn').length,invalid_source_count:dropped.filter(item=>item.reason!=='duplicate_source_turn').length,all_valid_source_turns_retained:true}};
}

function buildRoleAnnotations(coverage,pool){
  return array(coverage?.rows).map(row=>{
    const canonical_source_refs=unique(sourceIds(row).map(id=>pool.aliasToSourceRef.get(id)||pool.aliasToSourceRef.get(`memory:${id}`)).filter(Boolean)),source_refs=unique(canonical_source_refs.flatMap(ref=>pool.sourceRefToRow.get(ref)?.source_refs||[ref])),memory_ids=unique(source_refs.map(ref=>ref.slice(7)));
    return{role:row.role,status:row.status,interpretation_only:true,source_refs,memory_ids,canonical_source_refs,admission_ids:unique(canonical_source_refs.map(ref=>pool.sourceRefToRow.get(ref)?.admission_id).filter(Boolean)),event_times:unique(canonical_source_refs.map(ref=>pool.sourceRefToRow.get(ref)?.event_time).filter(Boolean)).sort(),...(row.missing_detail?{missing_detail:row.missing_detail}:{})};
  });
}

function mergeSourceFragments(candidates){
  const fragments=[];
  for(const candidate of candidates){
    const text=String(candidate?.evidence_text||'').trim(),normalized=normalizeSourceText(text);if(!normalized)continue;
    if(fragments.some(item=>item.normalized.includes(normalized)))continue;
    for(let index=fragments.length-1;index>=0;index--)if(normalized.includes(fragments[index].normalized))fragments.splice(index,1);
    fragments.push({text,normalized,priority:sourceNodePriority(candidate.node),index:candidate.index});
  }
  fragments.sort((left,right)=>right.priority-left.priority||right.text.length-left.text.length||left.index-right.index);
  return fragments.map(item=>item.text);
}

function buildInterpretationLinks(assessment,pool){
  const links=[];
  for(const [index,item] of array(assessment?.connections).entries()){
    if(!item||typeof item!=='object')continue;
    const from=resolveCanonicalRefs([item.from_memory_id,...sourceValues(item.from_source_refs,item.from_source_ref)],pool),to=resolveCanonicalRefs([item.to_memory_id,...sourceValues(item.to_source_refs,item.to_source_ref)],pool),support=resolveCanonicalRefs([...array(item.supporting_memory_ids),...sourceValues(item.supporting_source_refs,item.supporting_source_ref),...sourceValues(item.source_refs,item.source_ref)],pool);
    if(!from.length||!to.length)continue;
    const relation_type=clip(item.relation_type||'',80);if(!relation_type)continue;
    const source_refs=unique([...from,...to,...support]),memory_ids=unique(source_refs.flatMap(ref=>pool.sourceRefToRow.get(ref)?.memory_ids||[]));
    links.push({link_id:`interpretation_link_${index+1}`,relation_type,assessment:clip(item.assessment||'uncertain',40),confidence:boundedConfidence(item.confidence),from_source_refs:from,to_source_refs:to,support_source_refs:source_refs,source_refs,memory_ids,interpretation_only:true,establishes_clinical_fact:false});
  }
  return links;
}

function buildTaskStructure({question_request=null,assessment,coverage,pool,role_annotations=[]}){
  const value=assessment&&typeof assessment==='object'?assessment:{},rawCandidates=array(value.occurrence_candidates).length?array(value.occurrence_candidates):array(value.task_structure?.occurrence_candidates),requestedCounting=value.counting&&typeof value.counting==='object'?value.counting:(value.task_structure?.counting||{}),unit=COUNT_UNITS.has(String(requestedCounting?.unit))?String(requestedCounting.unit):null;
  const candidates=rawCandidates.map((item,index)=>normalizeOccurrenceCandidate(item,index,pool,unit)),statusByTurn=new Map();
  for(const candidate of candidates){if(!candidate.verified_source_refs)continue;for(const ref of candidate.canonical_source_refs){const key=turnStatusKey(candidate,ref,unit),statuses=statusByTurn.get(key)||new Set();statuses.add(candidate.event_status);statusByTurn.set(key,statuses);}}
  for(const candidate of candidates){const conflict=candidate.canonical_source_refs.some(ref=>(statusByTurn.get(turnStatusKey(candidate,ref,unit))?.size||0)>1);if(conflict){candidate.event_status='uncertain';candidate.included=false;candidate.exclusion_reason='conflicting_event_status';}else if(candidate.event_status!=='documented'){candidate.included=false;candidate.exclusion_reason=candidate.exclusion_reason||`event_status_${candidate.event_status}`;}}
  const included=dedupeOccurrences(candidates.filter(item=>item.included)),groups=[];
  for(const [key,items] of groupBy(included,item=>item.normalized_event_key)){
    const observed_count=countOccurrences(items,unit),sites=unique(items.map(item=>item.site).filter(Boolean)),admission_ids=unique(items.map(item=>item.admission_id).filter(Boolean)),event_times=unique(items.map(item=>item.event_time).filter(Boolean)).sort();
    groups.push({group_key:key,event_key:items[0]?.event_key||key,interpretation_only:true,occurrence_ids:items.map(item=>item.occurrence_id),admission_ids,event_times,sites,observed_count,total_count:null});
  }
  const noMissing=array(value.missing_information).filter(Boolean).length===0&&coverage?.missing_role_count===0,forced=Boolean(requestedCounting?.budget_forced_answer||requestedCounting?.forced_answer||value.budget_forced_answer),blockingCandidates=candidates.filter(candidate=>candidateBlocksCompleteCount(candidate,unit)),scope_complete=Boolean(unit)&&requestedCounting?.scope_complete===true&&value.assessment==='supported'&&noMissing&&!forced&&!blockingCandidates.length,observed_count=unit?countOccurrences(included,unit):null;
  for(const group of groups)if(scope_complete)group.total_count=group.observed_count;
  return{version:'medlocomo-task-structure.v2-admission-aligned',interpretation_only:true,cross_admission_alignment:buildCrossAdmissionAlignment({question_request,pool,role_annotations}),occurrence_candidates:candidates,groups,counting:{unit,requested_scope_complete:requestedCounting?.scope_complete===true,scope_complete,observed_count,total_count:scope_complete?observed_count:null,blocking_candidate_count:blockingCandidates.length,count_semantics:!unit?'not_requested':scope_complete?'complete_scope_total':'observed_sources_only'}};
}

function buildCrossAdmissionAlignment({question_request=null,pool,role_annotations=[]}={}){
  if(String(question_request?.scope||'')!=='cross_admission')return null;
  const roleByRef=new Map();
  for(const annotation of array(role_annotations)){
    if(annotation.status==='missing')continue;
    for(const ref of array(annotation.canonical_source_refs)){const roles=roleByRef.get(ref)||[];roles.push(annotation.role);roleByRef.set(ref,unique(roles));}
  }
  const grouped=groupBy(pool.rows,row=>row.admission_id),admissions=[];
  for(const [admission_id,rows] of grouped){
    const ordered=[...rows].sort((left,right)=>String(left.event_time||'').localeCompare(String(right.event_time||''))||numeric(left.turn_id)-numeric(right.turn_id)),source_refs=ordered.map(row=>row.source_ref),answer_relevant_source_refs=source_refs.filter(ref=>(roleByRef.get(ref)||[]).length),covered_roles=unique(answer_relevant_source_refs.flatMap(ref=>roleByRef.get(ref)||[])),times=ordered.map(row=>row.event_time).filter(Boolean).sort();
    admissions.push({admission_id,start_time:times[0]||null,end_time:times.at(-1)||null,covered_roles,answer_relevant_source_refs,source_refs,row_count:ordered.length});
  }
  admissions.sort((left,right)=>String(left.start_time||'').localeCompare(String(right.start_time||''))||left.admission_id.localeCompare(right.admission_id));
  const relevant=admissions.filter(row=>row.answer_relevant_source_refs.length),role_alignment=[];
  for(const role of unique(relevant.flatMap(row=>row.covered_roles))){const sides=relevant.filter(row=>row.covered_roles.includes(role));role_alignment.push({role,admission_ids:sides.map(row=>row.admission_id),source_refs:unique(sides.flatMap(row=>row.answer_relevant_source_refs.filter(ref=>(roleByRef.get(ref)||[]).includes(role))))});}
  return{version:'medlocomo-cross-admission-alignment.v1-source-index',navigation_only:true,establishes_clinical_fact:false,requested_factor_terms:tokens(question_request?.question||'').slice(0,12),source_admission_count:admissions.length,answer_relevant_admission_count:relevant.length,has_multiple_grounded_sides:relevant.length>=2,comparison_side_admission_ids:relevant.map(row=>row.admission_id),admissions,role_alignment};
}

function normalizeOccurrenceCandidate(item,index,pool,unit){
  const value=item&&typeof item==='object'?item:{},event_key=clip(value.event_key||'',120),normalized_event_key=normalizeLabel(event_key),providedRefs=unique([...sourceValues(value.source_refs,value.source_ref),...array(value.memory_ids).map(String)]),unresolved=providedRefs.filter(ref=>!resolveCanonicalRefs([ref],pool).length),canonical_source_refs=resolveCanonicalRefs(providedRefs,pool),sourceRows=canonical_source_refs.map(ref=>pool.sourceRefToRow.get(ref)).filter(Boolean),admissions=unique(sourceRows.map(row=>row.admission_id)),times=unique(sourceRows.map(row=>row.event_time).filter(Boolean)).sort(),providedAdmission=String(value.admission_id||''),admissionMismatch=Boolean(providedAdmission)&&!admissions.includes(providedAdmission),admission_id=admissionMismatch?'':(providedAdmission||(admissions.length===1?admissions[0]:'')),providedTime=String(value.event_time||''),event_time=providedTime&&times.includes(providedTime)?providedTime:(times.length===1?times[0]:null),site=normalizeSite(value.site),event_status=EVENT_STATUSES.has(String(value.event_status))?String(value.event_status):'uncertain',verified_source_refs=value.grounding_complete!==false&&Boolean(providedRefs.length)&&!unresolved.length&&Boolean(canonical_source_refs.length)&&!admissionMismatch,source_refs=unique(canonical_source_refs.flatMap(ref=>pool.sourceRefToRow.get(ref)?.source_refs||[ref])),memory_ids=unique(source_refs.map(ref=>ref.slice(7))),requestedIncluded=value.included!==false;
  let exclusion_reason=clip(value.exclusion_reason||'',160),included=requestedIncluded&&verified_source_refs&&Boolean(normalized_event_key)&&Boolean(admission_id);
  if(value.grounding_complete===false)exclusion_reason='incomplete_grounding';else if(!providedRefs.length)exclusion_reason='missing_source_refs';else if(unresolved.length)exclusion_reason='unverified_source_ref';else if(admissionMismatch)exclusion_reason='admission_source_mismatch';else if(!normalized_event_key)exclusion_reason='missing_event_key';else if(!admission_id)exclusion_reason='ambiguous_admission';else if(unit==='site'&&!site){included=false;exclusion_reason='missing_site';}else if(!requestedIncluded)exclusion_reason=exclusion_reason||'excluded_by_assessor';
  const turnIdentity=canonical_source_refs.slice().sort().join(','),siteIdentity=unit==='site'?site:'',occurrence_identity=`${normalized_event_key}\u0000${admission_id}\u0000${siteIdentity}\u0000${turnIdentity||event_time||index}`;
  return{occurrence_id:`occurrence_${index+1}`,event_key,normalized_event_key,admission_id,event_time,site,event_status,source_ref:canonical_source_refs[0]||null,source_refs,memory_ids,canonical_source_refs,verified_source_refs,grounding_complete:verified_source_refs,included,exclusion_reason:included?null:(exclusion_reason||`event_status_${event_status}`),occurrence_identity,interpretation_only:true};
}

function dedupeOccurrences(values){const seen=new Set(),out=[];for(const item of values){if(seen.has(item.occurrence_identity))continue;seen.add(item.occurrence_identity);out.push(item);}return out;}
function turnStatusKey(candidate,ref,unit){return`${candidate.normalized_event_key}\u0000${candidate.admission_id}\u0000${unit==='site'?candidate.site:''}\u0000${ref}`;}
function candidateBlocksCompleteCount(candidate,unit){if(!candidate.grounding_complete)return true;if(candidate.exclusion_reason==='conflicting_event_status'||candidate.event_status==='uncertain')return true;if(unit==='site'&&!candidate.site)return true;return['missing_source_refs','unverified_source_ref','admission_source_mismatch','missing_event_key','ambiguous_admission','missing_site','incomplete_grounding'].includes(candidate.exclusion_reason);}
function countOccurrences(values,unit){if(unit==='admission')return new Set(values.map(item=>item.admission_id).filter(Boolean)).size;if(unit==='site')return new Set(values.map(item=>normalizeSite(item.site)).filter(Boolean)).size;return new Set(values.map(item=>item.occurrence_identity).filter(Boolean)).size;}
function groupBy(values,keyOf){const map=new Map();for(const value of values){const key=keyOf(value);const group=map.get(key)||[];group.push(value);map.set(key,group);}return map;}

function canonicalTurns(nodes){
  const selected=new Map();
  for(let index=0;index<array(nodes).length;index++){
    const node=nodes[index];
    if(node?.raw_text){for(const turn of parseObservationTurns(node,index))selectCanonicalTurn(selected,turn);continue;}
    const episode=String(node?.episode_id||''),turn=String(node?.turn_id||''),text=String(node?.source_text||node?.text||'').trim();if(!episode||!text)continue;
    const key=`${episode}\u0000${turn||node?.observation_id||index}`,candidate={episode_id:episode,turn_id:turn,event_time:node?.event_time||null,source_type:String(node?.source_type||'').toLowerCase(),text,construction_kind:String(node?.construction_kind||''),index},prior=selected.get(key);
    if(!prior||canonicalPriority(candidate)>canonicalPriority(prior)||(canonicalPriority(candidate)===canonicalPriority(prior)&&candidate.text.length>prior.text.length))selected.set(key,candidate);
  }
  return[...selected.values()].sort(compareTurn);
}
function parseObservationTurns(observation,index){
  const raw=String(observation?.raw_text||''),episode_id=String(observation?.episode_id||''),pattern=/\[Turn=(?<turn>[^\]]+)\]\[Role=(?<role>[^\]]+)\]\[Time=(?<time>[^\]]+)\]\s*\n(?<text>[\s\S]*?)(?=\n\n\[Turn=|$)/gu,out=[];
  for(const match of raw.matchAll(pattern))out.push({episode_id,turn_id:String(match.groups.turn||''),event_time:String(match.groups.time||observation?.event_time||''),source_type:String(match.groups.role||'').toLowerCase(),text:String(match.groups.text||'').trim(),construction_kind:'literal_provenance',index:index*10000+out.length});
  if(!out.length&&episode_id&&raw.trim())out.push({episode_id,turn_id:String(observation?.turn_id||'session'),event_time:observation?.event_time||null,source_type:String(observation?.source_type||'structured').toLowerCase(),text:raw.trim(),construction_kind:'literal_provenance',index:index*10000});
  return out;
}
function selectCanonicalTurn(selected,candidate){const key=`${candidate.episode_id}\u0000${candidate.turn_id||candidate.index}`,prior=selected.get(key);if(!prior||canonicalPriority(candidate)>canonicalPriority(prior)||(canonicalPriority(candidate)===canonicalPriority(prior)&&candidate.text.length>prior.text.length))selected.set(key,candidate);}
function canonicalPriority(value){return value.construction_kind==='literal_provenance'?3:value.text?2:1;}
function compareTurn(left,right){return String(left.event_time||'').localeCompare(String(right.event_time||''))||numeric(left.turn_id)-numeric(right.turn_id)||left.index-right.index;}
function representativeScore(turn){const text=String(turn?.text||'');return Math.min(20,(text.match(/\d/gu)||[]).length)*2+(CLINICAL.test(text)?8:0)+(turn?.source_type==='doctor'?2:0)+Math.min(6,text.length/80);}
function sourceNodePriority(node){const kind=String(node?.construction_kind||''),id=String(node?.memory_id||'');return kind==='literal_provenance'?5:id.includes(':source-turn:')?4:node?.source_text?3:node?.text?2:1;}
function termClinicalBoost(term,turns){let score=CLINICAL.test(term)?1.5:0;if(DIAGNOSTIC.test(term))score+=2.5;if(/\d/u.test(term))score+=1.5;const acronym=turns.some(turn=>acronyms(turn.text).includes(term));if(acronym)score+=3;return score;}
function selectTopicAnchors(turns,scoredTerms){
  const globalScore=new Map(scoredTerms.map(item=>[item.term,item.score])),candidates=turns.map(turn=>{const terms=unique(tokens(turn.text)),termSet=new Set(terms),text=String(turn.text||''),base=representativeScore(turn)+(DIAGNOSTIC.test(text)?8:0)+Math.min(8,acronyms(text).length*3)+Math.min(6,(text.match(/\d+(?:\.\d+)?(?:%|\s*(?:mg|mcg|ml|mmhg|kg|bpm))?/giu)||[]).length*1.5)+terms.slice(0,8).reduce((sum,term)=>sum+Math.min(2,globalScore.get(term)||0),0);return{turn,terms,termSet,base};}),selected=[];
  while(selected.length<OVERVIEW_ANCHOR_LIMIT&&selected.length<candidates.length){
    const used=new Set(selected.flatMap(item=>item.terms)),remaining=candidates.filter(item=>!selected.includes(item));
    remaining.sort((left,right)=>anchorScore(right,used,selected)-anchorScore(left,used,selected)||compareTurn(left.turn,right.turn));selected.push(remaining[0]);
  }
  return selected.map(item=>{const key_terms=[...item.terms].sort((left,right)=>(globalScore.get(right)||0)-(globalScore.get(left)||0)||left.localeCompare(right)).slice(0,OVERVIEW_ANCHOR_TERMS),turn=item.turn;return{turn_id:String(turn.turn_id||''),source_ref:`turn:${turn.episode_id}:${turn.turn_id}`,event_time:turn.event_time||null,speaker:String(turn.source_type||''),key_terms,excerpt:clip(turn.text,OVERVIEW_ANCHOR_TEXT_LIMIT),navigation_only:true};});
}
function anchorScore(candidate,used,selected){const novel=candidate.terms.filter(term=>!used.has(term)).length,overlap=selected.length?Math.max(...selected.map(item=>jaccard(candidate.termSet,item.termSet))):0;return candidate.base+Math.min(12,novel*1.5)-overlap*12;}
function jaccard(left,right){const union=new Set([...left,...right]);if(!union.size)return 0;let intersection=0;for(const value of left)if(right.has(value))intersection++;return intersection/union.size;}
function acronyms(value){return unique([...String(value||'').matchAll(/\b[A-Z][A-Z0-9.-]{1,9}\b/gu)].map(match=>match[0].toLowerCase()));}
function tokens(value){return[...String(value||'').toLowerCase().matchAll(TOKEN)].map(match=>match[0].replace(/^[.+-]+|[.+-]+$/gu,'')).filter(token=>!STOP.has(token)&&token.length>2&&!/^\d+$/u.test(token));}
function normalizeCoverageRow(row,byId){
  if(!row||typeof row!=='object')return null;const role=clip(row.role||'target',80),status=['covered','partial','missing','contradicted'].includes(String(row.status))?String(row.status):'partial',claim=clip(row.claim||row.aspect||'',300),missing_detail=clip(row.missing_detail||'',240),memory_ids=unique(array(row.memory_ids).map(String).filter(id=>byId.has(id))),cited=sourceValues(row.source_refs,row.source_ref).map(String).filter(ref=>ref.startsWith('memory:')&&byId.has(ref.slice(7))),source_refs=unique([...cited,...memory_ids.map(id=>`memory:${id}`)]),resolvedIds=unique([...memory_ids,...source_refs.map(ref=>ref.slice(7))]),admission_ids=unique(resolvedIds.map(id=>String(byId.get(id)?.episode_id||'')).filter(Boolean)),event_times=unique(resolvedIds.map(id=>String(byId.get(id)?.event_time||'')).filter(Boolean)).sort();
  if(status!=='missing'&&!claim)return null;if(status==='missing'&&!missing_detail&&!claim)return null;
  return{role,status,claim,source_refs,memory_ids:resolvedIds,admission_ids,event_times,...(missing_detail?{missing_detail}:{})};
}
function coverageKey(row){return`${row.role}\u0000${row.status}\u0000${row.claim}\u0000${row.admission_ids.join(',')}`;}
function sourceValues(plural,singular){return unique([...(Array.isArray(plural)?plural:(plural==null?[]:[plural])),...(singular==null?[]:[singular])].map(String));}
function sourceIds(value){return unique([...array(value?.memory_ids).map(String),...sourceValues(value?.source_refs,value?.source_ref).map(ref=>ref.startsWith('memory:')?ref.slice(7):ref)]);}
function resolveCanonicalRefs(values,pool){return unique(array(values).flatMap(value=>{const raw=String(value||''),id=raw.startsWith('memory:')?raw.slice(7):raw,ref=pool.aliasToSourceRef.get(raw)||pool.aliasToSourceRef.get(id)||pool.aliasToSourceRef.get(`memory:${id}`);return ref?[ref]:[];}));}
function dedupeRoles(values){const seen=new Set(),out=[];for(const value of array(values)){const key=`${value.role}\u0000${value.status}`;if(seen.has(key))continue;seen.add(key);out.push(value);}return out;}
function boundedConfidence(value){const number=Number(value);return Number.isFinite(number)?Math.max(0,Math.min(1,number)):null;}
function normalizeLabel(value){return String(value||'').normalize('NFKC').trim().replace(/\s+/gu,' ').toLowerCase();}
function normalizeSourceText(value){return String(value||'').normalize('NFKC').replace(/\s+/gu,' ').trim().toLowerCase();}
function normalizeSite(value){return normalizeLabel(value);}
function calendarDate(value){const match=String(value||'').match(/^\d{4}-\d{2}-\d{2}/u);return match?match[0]:'';}
function numeric(value){const number=Number(String(value||'').match(/\d+/u)?.[0]);return Number.isFinite(number)?number:Number.MAX_SAFE_INTEGER;}
function clip(value,limit){return String(value||'').normalize('NFKC').trim().slice(0,limit);}
function array(value){return Array.isArray(value)?value:[];}
function unique(values){return[...new Set(values.filter(Boolean))];}
