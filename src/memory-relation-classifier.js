import { inspectMemoryNodeSourceAlignment,SchemaError } from './schema.js';

export const MEMORY_RELATION_CLASSIFIER_VERSION='memory-relation-classifier-runtime.v1-source-grounded-bounded';
export const PERSISTENT_NON_CAUSAL_RELATIONS=Object.freeze(['persists','updates','supersedes','resolves','recurs','conflicts','informs','motivates','constrains','followed_by']);

const MODEL_RELATIONS=new Set(['none',...PERSISTENT_NON_CAUSAL_RELATIONS]);
const TEMPORAL_RELATIONS=new Set(['persists','updates','supersedes','resolves','recurs','conflicts','followed_by']);
const COMMON_HAN_GRAMS=new Set(['患者','医生','目前','当前','近期','最近','情况','出现','已经','还是','这个','那个','然后','现在','进行','可以','需要','没有','感觉','比较','明显','继续','以及','因为','所以']);
const DEFAULTS=Object.freeze({maxCandidates:48,maxCandidatesPerIncoming:4,indexBucketLimit:16,temporalNeighborLimit:8,minConfidence:.85,maxSourceCharacters:4000});

/**
 * Run the optional LLM classifier. The caller owns failure fallback so model
 * transport errors are deliberately not swallowed here.
 */
export async function classifyMemoryRelations(gateway,incomingNodes=[],historicalNodes=[],options={}){
  if(!gateway||typeof gateway.completeJSON!=='function')throw new TypeError('relation classifier requires a ModelGateway-compatible object');
  const settings=classifierSettings(options),candidates=buildMemoryRelationCandidates(incomingNodes,historicalNodes,settings),input=memoryRelationClassifierInput(candidates);
  if(!candidates.length)return{version:MEMORY_RELATION_CLASSIFIER_VERSION,candidates:[],decisions:[],relationProposals:[],trace:null};
  const response=await gateway.completeJSON('relation_classifier',input,value=>normalizeMemoryRelationOutput(value,candidates),()=>mockRelationOutput(candidates),{maxTokens:Math.min(3000,Math.max(600,180+candidates.length*70)),extractJsonObject:true});
  const decisions=response.value.relations,relationProposals=relationProposalsFromDecisions(decisions,candidates,settings);
  return{version:MEMORY_RELATION_CLASSIFIER_VERSION,candidates,decisions,relationProposals,trace:response.trace};
}

/**
 * Generate a small candidate set using bounded indexes. Historical nodes are
 * indexed once; for each incoming node only bounded factor, lexical,
 * provenance, family and temporal buckets are inspected.
 */
export function buildMemoryRelationCandidates(incomingNodes=[],historicalNodes=[],options={}){
  const settings=classifierSettings(options),indexes=new Map(),candidates=[],pairKeys=new Set();
  for(const node of array(historicalNodes)){
    if(!eligibleEndpoint(node,settings))continue;
    const subject=clean(node.subject_id);if(!subject)continue;
    let index=indexes.get(subject);if(!index){index=createSubjectIndex(settings);indexes.set(subject,index);}index.add(node);
  }
  for(const index of indexes.values())index.finalize();
  for(const incoming of array(incomingNodes)){
    if(!eligibleEndpoint(incoming,settings))continue;
    const subject=clean(incoming.subject_id);if(!subject)continue;
    let index=indexes.get(subject);if(!index){index=createSubjectIndex(settings);indexes.set(subject,index);}
    const ranked=index.matches(incoming).filter(item=>item.node.memory_id!==incoming.memory_id).map(item=>scorePair(item.node,incoming,item.reasons,index)).filter(item=>item.eligible).sort(compareScoredPairs).slice(0,settings.maxCandidatesPerIncoming);
    for(const item of ranked){
      const [from,to]=chronologicalPair(item.node,incoming),pairKey=`${from.memory_id}\u0000${to.memory_id}`;
      if(pairKeys.has(pairKey))continue;pairKeys.add(pairKey);
      candidates.push({pair_key:pairKey,from_node:from,to_node:to,selection_score:item.score,selection_reasons:item.reasons});
    }
    index.add(incoming);
  }
  return candidates.sort((left,right)=>right.selection_score-left.selection_score||compareNodes(left.from_node,right.from_node)||compareNodes(left.to_node,right.to_node)).slice(0,settings.maxCandidates).map((candidate,index)=>({...candidate,candidate_id:`relation_candidate_${String(index+1).padStart(3,'0')}`}));
}

/** Project candidates to the only fields the classifier may observe. */
export function memoryRelationClassifierInput(candidates=[]){
  return{
    version:MEMORY_RELATION_CLASSIFIER_VERSION,
    candidates:array(candidates).map(candidate=>({
      candidate_id:String(candidate.candidate_id),
      from:endpointModelView(candidate.from_node),
      to:endpointModelView(candidate.to_node)
    }))
  };
}

/**
 * Strict all-or-nothing validation: every supplied opaque candidate id must
 * occur exactly once, and no unknown relation, id, or output field survives.
 */
export function normalizeMemoryRelationOutput(value,candidates=[]){
  const errors=[],allowedTop=new Set(['relations']),allowedRow=new Set(['candidate_id','relation_type','confidence','reason']),expected=array(candidates).map(candidate=>String(candidate.candidate_id)),expectedSet=new Set(expected),relations=Array.isArray(value?.relations)?value.relations:null;
  if(!value||typeof value!=='object'||Array.isArray(value))errors.push('output must be an object');
  else{const extra=Object.keys(value).filter(key=>!allowedTop.has(key));if(extra.length)errors.push(`unsupported output fields: ${extra.join(', ')}`);}
  if(!relations)errors.push('relations must be an array');
  const normalized=[],seen=new Set();
  for(const [index,row] of (relations||[]).entries()){
    if(!row||typeof row!=='object'||Array.isArray(row)){errors.push(`relations[${index}] must be an object`);continue;}
    const extra=Object.keys(row).filter(key=>!allowedRow.has(key));if(extra.length)errors.push(`relations[${index}] has unsupported fields: ${extra.join(', ')}`);
    const candidateId=typeof row.candidate_id==='string'?row.candidate_id:'';
    if(!candidateId)errors.push(`relations[${index}].candidate_id must be a non-empty string`);
    else if(!expectedSet.has(candidateId))errors.push(`relations[${index}] has unknown candidate_id ${candidateId}`);
    else if(seen.has(candidateId))errors.push(`candidate_id ${candidateId} appears more than once`);
    seen.add(candidateId);
    const suppliedRelationType=typeof row.relation_type==='string'?row.relation_type.trim():'',forbiddenRelation=['causes','contributes_to','co_observed'].includes(suppliedRelationType),relationType=MODEL_RELATIONS.has(suppliedRelationType)?suppliedRelationType:forbiddenRelation?suppliedRelationType:'none';
    if(forbiddenRelation)errors.push(`relations[${index}] has forbidden or unknown relation_type ${suppliedRelationType}`);
    const confidence=row.confidence;if(typeof confidence!=='number'||!Number.isFinite(confidence)||confidence<0||confidence>1)errors.push(`relations[${index}].confidence must be a finite number from 0 to 1`);
    const rawReason=typeof row.reason==='string'?row.reason.trim():'',reason=rawReason.slice(0,500);if(!reason)errors.push(`relations[${index}].reason must be a non-empty string`);
    normalized.push({candidate_id:candidateId,relation_type:relationType,confidence,reason});
  }
  for(const id of expected)if(!seen.has(id))errors.push(`candidate_id ${id} is missing`);
  if((relations||[]).length!==expected.length)errors.push(`relations must contain exactly ${expected.length} rows`);
  if(errors.length)throw new SchemaError('MemoryRelationClassifierOutput',[...new Set(errors)],value);
  const byId=new Map(normalized.map(row=>[row.candidate_id,row]));
  return{relations:expected.map(id=>byId.get(id))};
}

export function relationProposalsFromDecisions(decisions=[],candidates=[],options={}){
  const settings=classifierSettings(options),candidateById=new Map(array(candidates).map(candidate=>[String(candidate.candidate_id),candidate])),proposals=[];
  for(const decision of array(decisions)){
    if(!PERSISTENT_NON_CAUSAL_RELATIONS.includes(decision?.relation_type)||Number(decision?.confidence)<settings.minConfidence)continue;
    const candidate=candidateById.get(String(decision.candidate_id||''));if(!candidate)continue;
    const from=candidate.from_node,to=candidate.to_node;if(!eligibleEndpoint(from,settings)||!eligibleEndpoint(to,settings))continue;
    proposals.push({
      candidate_id:String(decision.candidate_id),from_memory_id:String(from.memory_id),to_memory_id:String(to.memory_id),
      relation_type:decision.relation_type,edge_family:TEMPORAL_RELATIONS.has(decision.relation_type)?'temporal':'clinical_care',
      confidence:Number(decision.confidence),reason:String(decision.reason),support_memory_ids:[String(from.memory_id),String(to.memory_id)],
      source:'llm_source_grounded_relation_classifier',causal_claim:false
    });
  }
  return proposals;
}

function classifierSettings(options){
  return{
    maxCandidates:boundedInteger(options.maxCandidates,1,96,DEFAULTS.maxCandidates),
    maxCandidatesPerIncoming:boundedInteger(options.maxCandidatesPerIncoming,1,12,DEFAULTS.maxCandidatesPerIncoming),
    indexBucketLimit:boundedInteger(options.indexBucketLimit,2,48,DEFAULTS.indexBucketLimit),
    temporalNeighborLimit:boundedInteger(options.temporalNeighborLimit,0,24,DEFAULTS.temporalNeighborLimit),
    minConfidence:boundedNumber(options.minConfidence,.5,1,DEFAULTS.minConfidence),
    maxSourceCharacters:boundedInteger(options.maxSourceCharacters,80,12000,DEFAULTS.maxSourceCharacters)
  };
}

function createSubjectIndex(settings){
  const byFactor=new Map(),byObservation=new Map(),byEpisode=new Map(),byFamily=new Map(),byAnchor=new Map(),byId=new Map(),timeline=[];let timelineFinalized=false;
  const append=(map,key,node)=>{if(!key)return;const bucket=map.get(key)||[];bucket.push(node);map.set(key,bucket);};
  const add=node=>{
    const id=String(node.memory_id);if(byId.has(id))return;byId.set(id,node);
    append(byFactor,clean(node.factor_key),node);append(byObservation,clean(node.observation_id),node);append(byEpisode,clean(node.episode_id),node);
    for(const family of array(node.families).map(clean).filter(Boolean))append(byFamily,family,node);
    for(const anchor of lexicalAnchors(node))append(byAnchor,anchor,node);
    if(!timelineFinalized)timeline.push(node);
    else if(!timeline.length||compareNodes(timeline.at(-1),node)<=0)timeline.push(node);
    else insertChronological(timeline,node);
  };
  const finalize=()=>{if(timelineFinalized)return;timeline.sort(compareNodes);timelineFinalized=true;};
  const take=(map,key)=>array(map.get(key)).slice(-settings.indexBucketLimit);
  const matches=node=>{
    finalize();
    const found=new Map(),include=(candidate,reason)=>{const id=String(candidate?.memory_id||'');if(!id||id===String(node.memory_id||''))return;const record=found.get(id)||{node:candidate,reasons:new Set()};record.reasons.add(reason);found.set(id,record);};
    for(const candidate of take(byFactor,clean(node.factor_key)))include(candidate,'same_factor');
    for(const candidate of take(byObservation,clean(node.observation_id)))include(candidate,'same_observation');
    for(const candidate of take(byEpisode,clean(node.episode_id)))include(candidate,'same_episode');
    const anchors=lexicalAnchors(node).map(anchor=>({anchor,size:(byAnchor.get(anchor)||[]).length})).filter(item=>item.size).sort((a,b)=>a.size-b.size||b.anchor.length-a.anchor.length||a.anchor.localeCompare(b.anchor)).slice(0,8);
    for(const {anchor} of anchors)for(const candidate of take(byAnchor,anchor))include(candidate,`shared_anchor:${anchor}`);
    for(const family of array(node.families).slice(0,4))for(const candidate of take(byFamily,clean(family)).slice(-6))include(candidate,`shared_family:${clean(family)}`);
    for(const candidate of temporalNeighbors(timeline,node,settings.temporalNeighborLimit))include(candidate,'temporal_neighbor');
    return[...found.values()].map(item=>({...item,reasons:[...item.reasons]}));
  };
  return{add,finalize,matches,anchorFrequency:key=>(byAnchor.get(key)||[]).length};
}

function scorePair(prior,incoming,reasons,index){
  const sameFactor=clean(prior.factor_key)&&clean(prior.factor_key)===clean(incoming.factor_key),sameObservation=clean(prior.observation_id)&&clean(prior.observation_id)===clean(incoming.observation_id),sameEpisode=clean(prior.episode_id)&&clean(prior.episode_id)===clean(incoming.episode_id),families=intersection(array(prior.families),array(incoming.families)),anchors=intersection(lexicalAnchors(prior),lexicalAnchors(incoming)),days=distanceDays(prior.event_time,incoming.event_time),rolePair=clean(prior.source_type)!==clean(incoming.source_type),carePair=careFamilyPair(prior,incoming);
  let score=0;if(sameFactor)score+=100;if(sameObservation)score+=45;if(sameEpisode)score+=28;
  for(const anchor of anchors.slice(0,5))score+=Math.max(5,20-Math.min(15,index.anchorFrequency(anchor)));
  if(Number.isFinite(days))score+=Math.max(0,16-Math.min(16,days/7));score+=Math.min(12,families.length*5);if(rolePair)score+=4;if(carePair)score+=7;
  const related=sameFactor||anchors.length>0||sameObservation||sameEpisode&&Boolean(families.length||carePair)||Number.isFinite(days)&&days<=7&&families.length>0||carePair&&Number.isFinite(days)&&days<=90;
  return{node:prior,eligible:Boolean(related),score,reasons:[...new Set([...reasons,...(sameFactor?['same_factor']:[]),...(sameObservation?['same_observation']:[]),...(sameEpisode?['same_episode']:[]),...(anchors.length?[`shared_lexical_anchors:${anchors.slice(0,5).join('|')}`]:[]),...(Number.isFinite(days)?[`temporal_distance_days:${days}`]:[]),...(families.length?[`shared_families:${families.join('|')}`]:[]),...(carePair?['care_family_pair']:[])])]};
}

function endpointModelView(node){return{text:String(node.text),source_text:String(node.source_text),role:String(node.source_type),event_time:node.event_time||null};}
function mockRelationOutput(candidates){return{relations:candidates.map(candidate=>({candidate_id:candidate.candidate_id,relation_type:'none',confidence:1,reason:'Offline mock does not infer persistent semantic relations.'}))};}

function eligibleEndpoint(node,settings){
  if(!node||typeof node!=='object'||!clean(node.memory_id)||!clean(node.subject_id)||!clean(node.text))return false;
  if(node.construction_kind==='literal_provenance')return false;
  const source=typeof node.source_text==='string'?node.source_text:'';if(!source.trim()||source.length>settings.maxSourceCharacters)return false;
  if(!inspectMemoryNodeSourceAlignment(node).aligned)return false;
  return Array.isArray(node.span)&&node.span[1]-node.span[0]===source.length;
}

function lexicalAnchors(node){
  const text=`${node?.text||''} ${node?.source_text||''}`.normalize('NFKC').toLowerCase(),anchors=new Set();
  for(const word of text.match(/[a-z][a-z0-9+./-]{2,31}|\d+(?:\.\d+)?(?:%|[a-z]+)?/giu)||[])anchors.add(word);
  for(const run of text.match(/[\p{Script=Han}]{2,40}/gu)||[]){
    for(const size of[2,3])for(let index=0;index<=run.length-size;index++){const gram=run.slice(index,index+size);if(!COMMON_HAN_GRAMS.has(gram))anchors.add(gram);}
  }
  return[...anchors].slice(0,96);
}

function careFamilyPair(left,right){const a=new Set(array(left.families)),b=new Set(array(right.families));return(a.has('CP')&&(b.has('CS')||b.has('PA')||b.has('BC')||b.has('PE')))||(b.has('CP')&&(a.has('CS')||a.has('PA')||a.has('BC')||a.has('PE')));}
function chronologicalPair(left,right){return compareNodes(left,right)<=0?[left,right]:[right,left];}
function compareScoredPairs(left,right){return right.score-left.score||compareNodes(left.node,right.node);}
function compareNodes(left,right){const a=eventOrder(left),b=eventOrder(right);if(Number.isFinite(a)&&Number.isFinite(b)&&a!==b)return a-b;if(Number.isFinite(a)!==Number.isFinite(b))return Number.isFinite(a)?-1:1;return String(left?.memory_id||'').localeCompare(String(right?.memory_id||''));}
function eventOrder(node){const value=Date.parse(node?.event_time||'');return Number.isFinite(value)?value:NaN;}
function distanceDays(left,right){const a=Date.parse(left||''),b=Date.parse(right||'');return Number.isFinite(a)&&Number.isFinite(b)?Math.abs(a-b)/86400000:NaN;}
function temporalNeighbors(timeline,node,limit){if(!limit||!timeline.length||!Number.isFinite(eventOrder(node)))return[];const at=lowerBound(timeline,node),half=Math.max(1,Math.ceil(limit/2));return timeline.slice(Math.max(0,at-half),Math.min(timeline.length,at+half)).sort((a,b)=>Math.abs(eventOrder(a)-eventOrder(node))-Math.abs(eventOrder(b)-eventOrder(node))).slice(0,limit);}
function lowerBound(items,node){let low=0,high=items.length;while(low<high){const mid=(low+high)>>1;if(compareNodes(items[mid],node)<0)low=mid+1;else high=mid;}return low;}
function insertChronological(items,node){items.splice(lowerBound(items,node),0,node);}
function intersection(left,right){const set=new Set(right);return[...new Set(left)].filter(value=>set.has(value));}
function array(value){return Array.isArray(value)?value:[];}
function clean(value){return String(value||'').trim();}
function boundedInteger(value,min,max,fallback){const number=Number(value);return Number.isInteger(number)?Math.max(min,Math.min(max,number)):fallback;}
function boundedNumber(value,min,max,fallback){const number=Number(value);return Number.isFinite(number)?Math.max(min,Math.min(max,number)):fallback;}
