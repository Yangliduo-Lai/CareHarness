import { randomUUID } from 'node:crypto';
import { inspectMemoryNodeSourceAlignment,MEMORY_FAMILIES } from './schema.js';
import { stripLeadingCalendarExpression } from './temporal-expressions.js';

/**
 * Memory Nodes are durable clinical facts. Episode membership is provenance on
 * each node, not a clinical relation between every pair of facts in a Session.
 */
export function updateMemoryGraph(incomingNodes,historicalNodes,historicalEdges,observation,options={}){
  const nodes=[],deltas=[],index=createMemoryIndex(historicalNodes),incoming=coalesceIncomingNodes(incomingNodes);
  for(const candidate of incoming){
    if(isLiteralProvenanceNode(candidate)){
      const node={
        ...candidate,subject_id:observation.subject_id,families:normalizeFamilies(candidate.families),
        factor_key:`literal_provenance:${observation.observation_id}:${candidate.turn_id||candidate.memory_id}`,
        factor_domains:['provenance'],status:'active',valid_from:candidate.event_time||null,version:1,
        version_chain:[],predecessor_memory_id:null,successor_memory_id:null,conflicts_with_memory_id:null,operation:'ADD'
      };
      nodes.push(node);deltas.push({operation:'ADD',memory_id:node.memory_id,prior_memory_id:null,families:[...node.families]});continue;
    }
    const factorKey=index.resolveFactorKey(candidate),owned=index.factorNodes(factorKey),ordered=[...owned].sort(compareChronology),newOrder=eventOrder(candidate),prior=Number.isFinite(newOrder)?[...ordered].reverse().find(node=>eventOrder(node)<=newOrder):ordered.at(-1),successor=Number.isFinite(newOrder)?ordered.find(node=>eventOrder(node)>newOrder):null,transition=classifyMemoryTransition(prior,candidate),conflictTarget=transition.operation==='CONFLICT'?(prior?.status==='conflict'?prior.conflicts_with_memory_id||prior.memory_id:prior?.memory_id||null):null;
    const node={
      ...candidate,
      subject_id:observation.subject_id,
      families:normalizeFamilies(candidate.families),
      factor_key:factorKey,
      factor_domains:factorDomains(candidate.text),
      status:transition.operation==='CONFLICT'?'conflict':'active',
      valid_from:candidate.event_time||null,
      version:Math.max(0,...owned.map(item=>Number(item.version)||0))+1,
      version_chain:[...(prior?.version_chain||[]),...(prior?[prior.memory_id]:[])],
      predecessor_memory_id:prior?.memory_id||null,
      successor_memory_id:successor?.memory_id||null,
      conflicts_with_memory_id:conflictTarget,
      operation:transition.operation
    };
    nodes.push(node);index.add(node);
    deltas.push({operation:node.operation,memory_id:node.memory_id,prior_memory_id:prior?.memory_id||null,families:[...node.families]});
  }
  return{
    version:nodes.some(isLiteralProvenanceNode)?'careharness-memory-graph-updater.v3-semantic-plus-literal-provenance':'careharness-memory-graph-updater.v2-semantic-longitudinal',
    nodes,
    edges:buildPersistentMemoryEdges(nodes,historicalNodes,historicalEdges,options.relationProposals),
    deltas,
    family_counts:familyCounts(nodes),
    episode_memberships:episodeMemberships(nodes)
  };
}

export function currentMemory(nodes){
  const latest=new Map();
  for(const node of nodes){const key=String(node.factor_key||memoryTopicKey(node.text)),prior=latest.get(key);if(!prior||compareChronology(prior,node)<=0)latest.set(key,node);}
  return[...latest.values()];
}

export function familyCounts(nodes){return Object.fromEntries(MEMORY_FAMILIES.map(family=>[family,nodes.filter(node=>(node.families||[]).includes(family)).length]));}

export function memoryTopicKey(text){
  const normalized=normalizeMemoryText(semanticCoreText(text));
  return`topic:${normalized.slice(0,48)||'empty'}`;
}

export function normalizeMemoryText(text){return String(text||'').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu,'');}

export function genericTextSimilarity(left,right){
  const a=new Set(characterGrams(normalizeMemoryText(left),2)),b=new Set(characterGrams(normalizeMemoryText(right),2));
  if(!a.size||!b.size)return 0;let hits=0;for(const gram of a)if(b.has(gram))hits++;return hits/Math.max(a.size,b.size);
}

/**
 * Deterministic verifier for persistent longitudinal proposals. A future LLM
 * may rank candidate pairs, but it cannot persist a relation unsupported by
 * the two source-grounded endpoints.
 */
export function inspectLongitudinalRelation(fromNode,toNode,proposedRelation=null){
  if(!fromNode||!toNode)return{grounded:false,relation:null,reasons:['missing_endpoint']};
  if(isLiteralProvenanceNode(fromNode)||isLiteralProvenanceNode(toNode))return{grounded:false,relation:null,reasons:['literal_provenance_is_not_semantic_state']};
  if(String(fromNode.subject_id||'')!==String(toNode.subject_id||''))return{grounded:false,relation:null,reasons:['cross_subject']};
  if(!inspectMemoryNodeSourceAlignment(fromNode).aligned||!inspectMemoryNodeSourceAlignment(toNode).aligned)return{grounded:false,relation:null,reasons:['ungrounded_endpoint']};
  const sameFactor=String(fromNode.factor_key||'')&&String(fromNode.factor_key)===String(toNode.factor_key||''),similarity=factorSimilarity(fromNode,toNode);
  if(!sameFactor&&similarity<.58)return{grounded:false,relation:null,reasons:['different_clinical_factor']};
  const transition=classifyMemoryTransition(fromNode,toNode),relation=transition.relation;
  if(!relation)return{grounded:false,relation:null,reasons:['no_source_grounded_transition']};
  if(proposedRelation&&String(proposedRelation)!==relation)return{grounded:false,relation,reasons:['proposal_not_supported_by_endpoints']};
  return{grounded:true,relation,operation:transition.operation,reasons:[]};
}

function normalizeFamilies(value){const families=[...new Set((value||[]).map(String).filter(family=>MEMORY_FAMILIES.includes(family)))];if(!families.length)throw new Error('Memory Node requires at least one family label');return MEMORY_FAMILIES.filter(family=>families.includes(family));}

function classifyMemoryTransition(prior,next){
  if(!prior)return{operation:'ADD',relation:null};
  const priorPolarity=effectivePolarity(prior),nextPolarity=effectivePolarity(next),samePolarity=priorPolarity===nextPolarity;
  if(explicitContradictionCue(next.text)||(!samePolarity&&sameClinicalMoment(prior,next)&&!explicitTemporalChangeCue(next.text)))return{operation:'CONFLICT',relation:'conflicts'};
  if(explicitResolutionCue(next.text)&&priorPolarity!=='negated')return{operation:'RESOLVE',relation:'resolves'};
  if(explicitRecurrenceCue(next.text))return{operation:'UPDATE',relation:'recurs'};
  if(explicitSupersessionCue(next.text))return{operation:'SUPERSEDE',relation:'supersedes'};
  if(equivalentMemoryFact(prior,next)||explicitPersistenceCue(next.text)&&quantitativeSignature(prior.text)===quantitativeSignature(next.text))return{operation:'NOOP',relation:'persists'};
  return{operation:'UPDATE',relation:'updates'};
}

function buildPersistentMemoryEdges(nodes,historicalNodes,historicalEdges,relationProposals=[]){
  const edges=[],known=new Set((historicalEdges||[]).map(memoryEdgeKey)),nodeById=new Map([...(historicalNodes||[]),...nodes].map(node=>[String(node.memory_id),node]));
  const add=({from,to,relation_type,source})=>{
    if(!from||!to||from===to||!nodeById.has(String(from))||!nodeById.has(String(to)))return;
    const fromNode=nodeById.get(String(from)),toNode=nodeById.get(String(to)),inspection=inspectLongitudinalRelation(fromNode,toNode,relation_type);
    if(!inspection.grounded)return;
    const candidate={edge_id:randomUUID(),subject_id:fromNode.subject_id,from_memory_id:String(from),to_memory_id:String(to),edge_family:'temporal',relation_type,support_memory_ids:[String(from),String(to)],confidence:1,support_kind:'structural',status:'verified',verified:true,persistent:true,causal_claim:false,source,created_episode_id:toNode.episode_id||null},key=memoryEdgeKey(candidate);
    if(known.has(key))return;known.add(key);edges.push(candidate);
  };
  for(const node of nodes){
    if(isLiteralProvenanceNode(node))continue;
    const priorId=node.operation==='CONFLICT'?node.conflicts_with_memory_id:node.predecessor_memory_id,prior=nodeById.get(String(priorId||''));
    if(prior){const transition=classifyMemoryTransition(prior,node);if(transition.relation)add({from:prior.memory_id,to:node.memory_id,relation_type:transition.relation,source:'source_grounded_memory_transition'});}
    const successor=nodeById.get(String(node.successor_memory_id||''));
    if(successor&&node.status!=='conflict'&&successor.status!=='conflict'){
      const transition=classifyMemoryTransition(node,successor);
      if(transition.relation)add({from:node.memory_id,to:successor.memory_id,relation_type:transition.relation,source:'source_grounded_backfill_transition'});
    }
  }
  for(const proposal of relationProposals||[]){
    const candidate=verifiedRelationProposal(proposal,nodeById);
    if(!candidate)continue;
    const key=memoryEdgeKey(candidate);if(known.has(key))continue;known.add(key);edges.push(candidate);
  }
  return edges;
}

const LONGITUDINAL_PROPOSAL_RELATIONS=new Set(['persists','updates','supersedes','resolves','recurs','conflicts']);
const CARE_PROPOSAL_RELATIONS=new Set(['informs','motivates','constrains']);
const ALLOWED_PROPOSAL_FIELDS=new Set(['candidate_id','from_memory_id','to_memory_id','relation_type','edge_family','confidence','reason','support_memory_ids','source','causal_claim']);

/**
 * Treat classifier output as untrusted. A proposal can only add a verified,
 * non-causal edge between two already-existing, source-aligned Memory Nodes.
 * Longitudinal semantics remain owned by the deterministic endpoint verifier.
 */
function verifiedRelationProposal(proposal,nodeById){
  if(!proposal||typeof proposal!=='object'||Array.isArray(proposal))return null;
  if(Object.keys(proposal).some(key=>!ALLOWED_PROPOSAL_FIELDS.has(key)))return null;
  const candidateId=cleanString(proposal.candidate_id),fromId=cleanString(proposal.from_memory_id),toId=cleanString(proposal.to_memory_id),relationType=cleanString(proposal.relation_type),edgeFamily=cleanString(proposal.edge_family),reason=cleanString(proposal.reason);
  if(!candidateId||!fromId||!toId||fromId===toId||!relationType||!edgeFamily||!reason)return null;
  if(proposal.source!=='llm_source_grounded_relation_classifier'||proposal.causal_claim!==false)return null;
  const confidence=Number(proposal.confidence);if(!Number.isFinite(confidence)||confidence<.85||confidence>1)return null;
  if(!exactEndpointSupport(proposal.support_memory_ids,fromId,toId))return null;
  const fromNode=nodeById.get(fromId),toNode=nodeById.get(toId);
  if(isLiteralProvenanceNode(fromNode)||isLiteralProvenanceNode(toNode))return null;
  if(!strictSourceAlignedEndpoint(fromNode)||!strictSourceAlignedEndpoint(toNode))return null;
  if(String(fromNode.subject_id)!==String(toNode.subject_id))return null;

  if(LONGITUDINAL_PROPOSAL_RELATIONS.has(relationType)){
    if(edgeFamily!=='temporal'||!inspectLongitudinalRelation(fromNode,toNode,relationType).grounded)return null;
  }else if(relationType==='followed_by'){
    if(edgeFamily!=='temporal'||!strictlyPrecedes(fromNode,toNode)||!proposalEndpointsClinicallyRelated(fromNode,toNode))return null;
  }else if(CARE_PROPOSAL_RELATIONS.has(relationType)){
    if(edgeFamily!=='clinical_care'||!careProposalGrounded(relationType,fromNode,toNode))return null;
  }else return null;

  return{
    edge_id:randomUUID(),subject_id:String(fromNode.subject_id),from_memory_id:fromId,to_memory_id:toId,
    edge_family:edgeFamily,relation_type:relationType,support_memory_ids:[fromId,toId],confidence,
    support_kind:'asserted',status:'verified',verified:true,persistent:true,causal_claim:false,
    source:'llm_source_grounded_relation_classifier',created_episode_id:toNode.episode_id||null
  };
}

function exactEndpointSupport(value,fromId,toId){return Array.isArray(value)&&value.length===2&&String(value[0])===fromId&&String(value[1])===toId&&fromId!==toId;}
function strictSourceAlignedEndpoint(node){const source=typeof node?.source_text==='string'?node.source_text:'';return Boolean(node?.memory_id&&node?.subject_id&&node?.observation_id&&node?.text&&inspectMemoryNodeSourceAlignment(node).aligned&&Array.isArray(node.span)&&node.span[1]-node.span[0]===source.length);}
function strictlyPrecedes(fromNode,toNode){const from=Date.parse(fromNode?.event_time||''),to=Date.parse(toNode?.event_time||'');return Number.isFinite(from)&&Number.isFinite(to)&&from<to;}

function proposalEndpointsClinicallyRelated(fromNode,toNode){
  const sameFactor=cleanString(fromNode?.factor_key)&&cleanString(fromNode.factor_key)===cleanString(toNode?.factor_key);
  if(sameFactor||factorSimilarity(fromNode,toNode)>=.28)return true;
  const left=clinicalTerms(fromNode),right=clinicalTerms(toNode);return left.some(term=>right.includes(term));
}

function careProposalGrounded(relationType,fromNode,toNode){
  if(proposalEndpointsClinicallyRelated(fromNode,toNode))return true;
  const pair=careFamilyPair(fromNode,toNode),combined=`${fromNode?.text||''} ${toNode?.text||''}`;
  if(!pair)return false;
  if(relationType==='informs')return/(?:根据|依据|基于|结合|参考|检查结果|检验结果|提示|显示|据此|based on|according to|informed by)/iu.test(combined);
  if(relationType==='motivates')return/(?:因此|因而|于是|促使|决定|考虑到|鉴于|为了|担心|顾虑|therefore|thus|prompted|motivated|because of)/iu.test(combined);
  return/(?:限制|受限|不能|不宜|避免|禁忌|过敏|风险|拒绝|不愿|顾虑|constraint|cannot|avoid|contraindicat|allerg|risk|refus)/iu.test(combined);
}

function careFamilyPair(left,right){
  const a=new Set(Array.isArray(left?.families)?left.families:[]),b=new Set(Array.isArray(right?.families)?right.families:[]),clinical=new Set(['CS','PA','BC','PE']);
  return a.has('CP')&&[...clinical].some(family=>b.has(family))||b.has('CP')&&[...clinical].some(family=>a.has(family));
}

function clinicalTerms(node){
  const text=`${node?.text||''} ${node?.source_text||''}`.normalize('NFKC').toLowerCase(),terms=new Set();
  for(const token of text.match(/[a-z][a-z0-9+./-]{2,31}|[\p{Script=Han}]{2,12}/giu)||[]){
    const normalized=normalizeMemoryText(token);if(normalized.length>=2&&!/^(?:患者|医生|目前|当前|近期|最近|出现|情况|已经|仍然|继续)$/u.test(normalized))terms.add(normalized);
  }
  return[...terms];
}

function cleanString(value){return typeof value==='string'?value.trim():'';}

function episodeMemberships(nodes){
  const byEpisode=new Map();
  for(const node of nodes){const episodeId=String(node.episode_id||'').trim();if(!episodeId)continue;const ids=byEpisode.get(episodeId)||[];ids.push(String(node.memory_id));byEpisode.set(episodeId,ids);}
  return[...byEpisode].map(([episode_id,memory_ids])=>({episode_id,memory_ids}));
}

function coalesceIncomingNodes(nodes){
  const out=[],byProvenance=new Map();
  for(const node of nodes){
    const key=provenanceKey(node),priorIndex=key?byProvenance.get(key):null;
    if(priorIndex==null){if(key)byProvenance.set(key,out.length);out.push(node);continue;}
    const prior=out[priorIndex];
    if(!equivalentSemanticOccurrence(prior,node)){out.push(node);continue;}
    const preferred=canonicalOccurrence(prior,node),families=normalizeFamilies([...(prior.families||[]),...(node.families||[])]);
    out[priorIndex]={...prior,text:preferred.text,source_text:preferred.source_text,span:preferred.span,source_type:preferred.source_type,turn_id:preferred.turn_id,event_time:preferred.event_time,certainty:Math.max(Number(prior.certainty)||0,Number(node.certainty)||0),polarity:preferred.polarity,families};
  }
  return out;
}

function provenanceKey(node){
  const span=Array.isArray(node?.span)&&node.span.length===2?`${node.span[0]}:${node.span[1]}`:'';
  if(!node?.observation_id||!span)return'';
  return`${isLiteralProvenanceNode(node)?'literal_provenance':'semantic_state'}\u0000${node.observation_id}\u0000${span}`;
}

function equivalentSemanticOccurrence(left,right){
  if(effectivePolarity(left)!==effectivePolarity(right)||quantitativeSignature(left.text)!==quantitativeSignature(right.text))return false;
  const a=normalizeMemoryText(semanticCoreText(left.text)),b=normalizeMemoryText(semanticCoreText(right.text));
  if(a===b)return true;
  return Math.min(a.length,b.length)>=6&&(a.includes(b)||b.includes(a)||genericTextSimilarity(a,b)>=.9);
}

function canonicalOccurrence(left,right){
  const score=node=>{const text=String(node?.text||''),core=semanticCoreText(text);return(/(?:患者|医生)原话[：:]/u.test(text)?0:20)+(String(node?.memory_id||'').includes(':llm:')?10:0)+Math.min(20,normalizeMemoryText(core).length);};
  return score(right)>score(left)?right:left;
}

function createMemoryIndex(nodes){
  const byFactor=new Map(),identities=new Map(),all=[];
  const add=node=>{
    if(isLiteralProvenanceNode(node))return;
    all.push(node);
    const factor=String(node.factor_key||memoryTopicKey(node.text)),members=byFactor.get(factor)||[];members.push(node);byFactor.set(factor,members);
    const identity=clinicalIdentity(node.text);if(identity){const values=identities.get(identity)||[];values.push(node);identities.set(identity,values);}
  };
  for(const node of nodes)add(node);
  return{
    add,
    factorNodes(factor){return byFactor.get(String(factor))||[];},
    resolveFactorKey(node){
      const supplied=String(node?.factor_key||'').trim();if(supplied&&supplied!=='topic:empty')return supplied;
      const identity=clinicalIdentity(node.text),identityNodes=identity?identities.get(identity)||[]:[];
      if(identityNodes.length){const closest=identityNodes.sort((a,b)=>factorSimilarity(b,node)-factorSimilarity(a,node))[0];return String(closest.factor_key||memoryTopicKey(closest.text));}
      let closest=null,best=0;
      for(const historical of all){
        if(!familyCompatible(node,historical))continue;
        const score=factorSimilarity(node,historical),threshold=String(node.episode_id||'')===String(historical.episode_id||'')?.76:explicitTemporalChangeCue(node.text)?.5:.6;
        if(score>=threshold&&score>best){closest=historical;best=score;}
      }
      if(closest)return String(closest.factor_key||memoryTopicKey(closest.text));
      return identity?`factor:${identity}`:memoryTopicKey(node.text);
    }
  };
}

function isLiteralProvenanceNode(node){return node?.construction_kind==='literal_provenance';}

function familyCompatible(left,right){const a=new Set(left?.families||[]),b=right?.families||[];return!a.size||!b.length||b.some(family=>a.has(family));}

function factorSimilarity(left,right){
  const a=semanticCoreText(left?.text),b=semanticCoreText(right?.text),na=normalizeMemoryText(a),nb=normalizeMemoryText(b),ia=clinicalIdentity(left?.text),ib=clinicalIdentity(right?.text);
  if(ia&&ib&&ia===ib)return 1;
  if(!na||!nb)return 0;
  if(na===nb)return 1;
  if(Math.min(na.length,nb.length)>=4&&(na.includes(nb)||nb.includes(na)))return.9;
  return genericTextSimilarity(a,b);
}

function clinicalIdentity(text){
  const medication=medicationEntity(text);if(medication)return`medication:${normalizeMemoryText(medication)}`;
  const measurement=measurementEntity(text);if(measurement)return`measurement:${normalizeMemoryText(measurement)}`;
  const state=stateEntity(text);return state?`state:${normalizeMemoryText(state)}`:null;
}

function medicationEntity(text){
  const value=stripAttribution(String(text||'').normalize('NFKC'));
  const action=/(?:服用|口服|停用|停服|漏服|使用|注射|加用|减用|改用|换用|恢复服用|继续服用|开始使用|taking|stopped taking|discontinued|using|injecting|switched to|resumed)(?:\s+the)?\s*(?<entity>[\p{Script=Han}A-Za-z][\p{Script=Han}A-Za-z0-9+\-‑—/]{1,31}?)(?=已|后|前|控制|治疗|用于|以便|剂量|药效|[\s，,。！？!?；;]|$)/iu.exec(value);
  if(action?.groups?.entity)return action.groups.entity;
  const named=/(?<entity>[\p{Script=Han}A-Za-z][\p{Script=Han}A-Za-z0-9+\-‑—/]{1,24}(?:药物|降糖药|抑制剂|激动剂|拮抗剂|胰岛素|胶囊|注射液|片剂|药|剂|片))(?=已|仍|的|后|前|[\s，,。！？!?；;]|$)/iu.exec(value);
  return named?.groups?.entity||null;
}

function measurementEntity(text){
  const value=semanticCoreText(text),chinese=/^(?<entity>[\p{Script=Han}A-Za-z][\p{Script=Han}A-Za-z0-9+\-\s]{1,31}?)(?:为|是|达到|升至|降至|维持在|多在|约为|接近|超过|低于|高于)\s*[-+]?\d/u.exec(value);
  if(chinese?.groups?.entity)return cleanEntity(chinese.groups.entity);
  const english=/^(?<entity>[a-z][a-z\s-]{1,31}?)(?:is|was|at|of|rose to|fell to)\s*[-+]?\d/iu.exec(value);
  return english?.groups?.entity?cleanEntity(english.groups.entity):null;
}

function stateEntity(text){
  const value=semanticCoreText(text),match=/^(?<entity>.{2,36}?)(?:仍然?|依然|持续|再次|又|重新)?(?:开始|出现|发生|存在|加重|恶化|减轻|改善|缓解|消失|恢复|复发|升高|降低|下降|偏高|偏低|正常|稳定|异常|停止|中断|完成|有效|失效|减弱)(?:了|着|至|为|到|约|，|,|。|$)/u.exec(value);
  return match?.groups?.entity?cleanEntity(match.groups.entity):null;
}

function cleanEntity(value){return String(value||'').replace(/^(?:目前|当前|近期|最近|现在|此前|之前|后来|今天|昨日|昨晚|早晨|晨起|患者|医生)+/u,'').replace(/(?:已经|曾经|一直|逐渐|明显|轻微|显著|大约|约)$/u,'').trim();}

function stripAttribution(value){return String(value||'').replace(/^(?:(?:患者|医生)(?:原话|陈述|报告|记录|建议|解释|评估|认为|指出|告知)?[：:]?)+/u,'').trim();}

function semanticCoreText(text){
  return stripLeadingCalendarExpression(stripAttribution(String(text||'').normalize('NFKC')))
    .replace(/^(?:目前|当前|近期|最近|现在|此前|之前|后来|今天|昨日|昨晚)[，,:：\s]*/u,'')
    .trim();
}

function explicitTemporalChangeCue(text){return explicitSupersessionCue(text)||explicitResolutionCue(text)||explicitRecurrenceCue(text)||/(?:较前|相比|转为|变为|升至|降至|增加到|减少到|逐渐|进一步|继续|仍然|持续|worsen|improv|increase|decrease|remain|continue)/iu.test(String(text||''));}
function explicitSupersessionCue(text){return/(?:改为|换为|换成|改用|换用|调整为|替代|取代|不再.{0,24}而(?:是|改)|由.{1,32}(?:改|换|调整)为|switched? (?:from|to)|replaced? (?:by|with)|instead of)/iu.test(String(text||''));}
function explicitResolutionCue(text){const value=String(text||'');if(/(?:没有|未见|不再).{0,8}(?:改善|缓解|好转)/u.test(value))return false;return/(?:症状|疼痛|不适|问题|反应|表现|发作|异常)?.{0,10}(?:已经|已|完全|基本)?(?:消失|缓解|解决|恢复正常|未再出现|不再出现|停止发作|痊愈)|(?:resolved?|subsided?|disappeared?|returned to normal|no longer (?:has|experiences?))/iu.test(value);}
function explicitRecurrenceCue(text){return/(?:再次|再度|又一次|重新)(?:出现|发生|发作|升高|降低|恶化)|(?:复发|再发|反复出现|recurr|reappeared|returned again)/iu.test(String(text||''));}
function explicitPersistenceCue(text){return/(?:仍然?|依然|继续|持续|维持|一直|照旧|没有变化|未改变|remain|persist|continue|unchanged|still)/iu.test(String(text||''));}
function explicitContradictionCue(text){return/(?:与.{0,24}(?:矛盾|不符|相反)|更正(?:为|：)|前述.{0,12}(?:有误|错误)|contradict|correction|contrary to)/iu.test(String(text||''));}

function effectivePolarity(node){
  const declared=String(node?.polarity||'affirmed');if(declared!=='affirmed')return declared;
  const text=String(node?.text||'');
  if(/(?:无|没有|未见|未出现|不再出现|否认).{0,24}(?:症状|疼痛|不适|异常|反应|发作)|(?:denies?|no longer|without)\b/iu.test(text))return'negated';
  return declared;
}

function sameClinicalMoment(left,right){
  if(String(left?.episode_id||'')&&String(left.episode_id)===String(right?.episode_id||''))return true;
  const a=Date.parse(left?.event_time||''),b=Date.parse(right?.event_time||'');return Number.isFinite(a)&&Number.isFinite(b)&&a===b;
}

function factorDomains(text){const value=String(text||'').normalize('NFKC'),domains=[],add=domain=>{if(!domains.includes(domain))domains.push(domain);};if(clinicalIdentity(value)||/(?:病史|诊断|症状|疼痛|不适|检查|检验|药|过敏|生理|神经|激素|代谢|风险|disease|diagnos|symptom|pain|test|medication|allerg|physiolog|metabol)/iu.test(value))add('biological');if(/(?:担心|焦虑|抑郁|情绪|信念|认为|觉得|希望|顾虑|偏好|信心|心理|worr|anxi|depress|emotion|belief|think|hope|concern|preference|confidence|psycholog)/iu.test(value))add('psychological');if(/(?:漏服|停药|停用|服用|注射|依从|饮食|运动|监测|执行|坚持|作息|吸烟|饮酒|adher|missed|stopped|taking|inject|diet|exercise|monitor|behavior|smok|alcohol)/iu.test(value))add('behavioral');if(/(?:工作|职业|家庭|家人|支持|经济|费用|自费|医保|教育|居住|交通|资源|work|job|family|support|financial|cost|insurance|school|education|housing|transport|resource|social)/iu.test(value))add('social');if(/(?:医生|建议|计划|方案|复诊|随访|治疗|处置|指导|教育|调整|doctor|recommend|plan|follow-up|treatment|instruction|counsel|care)/iu.test(value))add('care');if(!domains.length)add('biological');return domains;}
function eventOrder(node){const parsed=Date.parse(node?.event_time||'');if(Number.isFinite(parsed))return parsed;const match=/(?:session|episode|admission|encounter)[-_]?(\d+)/i.exec(node?.episode_id||'');return match?Number(match[1]):NaN;}
function compareChronology(a,b){const left=eventOrder(a),right=eventOrder(b);if(Number.isFinite(left)&&Number.isFinite(right)&&left!==right)return left-right;if(Number.isFinite(left)!==Number.isFinite(right))return Number.isFinite(left)?1:-1;return(Number(a?.version)||0)-(Number(b?.version)||0);}
function quantitativeSignature(text){return[...String(text||'').normalize('NFKC').toLowerCase().matchAll(/[-+]?(?:\d+(?:\.\d+)?|\.\d+)\s*(?:%|mg|mcg|g|kg|ml|l|mmol\/?l|mg\/?dl|mmhg|bpm|iu|u|单位|毫克|微克|克|千克|毫升|升)?/giu)].map(match=>match[0].replace(/\s+/gu,'')).join('|');}
function equivalentMemoryFact(prior,next){return effectivePolarity(prior)===effectivePolarity(next)&&normalizeMemoryText(semanticCoreText(prior?.text))===normalizeMemoryText(semanticCoreText(next?.text))&&quantitativeSignature(prior?.text)===quantitativeSignature(next?.text);}
function characterGrams(value,size){const out=[];for(let index=0;index<=value.length-size;index++)out.push(value.slice(index,index+size));return[...new Set(out)];}
function memoryEdgeKey(edge){return[edge.from_memory_id,edge.to_memory_id,edge.edge_family,edge.relation_type].map(String).join('\u0000');}
