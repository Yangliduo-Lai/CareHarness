import { randomUUID } from 'node:crypto';

export const MEMORY_FAMILIES = ['BC', 'PE', 'PA', 'CS', 'CP', 'LO'];
export const MEMORY_EDGE_FAMILIES = ['temporal', 'clinical_care', 'context'];
export const MEMORY_RELATIONS = ['persists', 'updates', 'supersedes', 'resolves', 'recurs', 'conflicts', 'informs', 'motivates', 'constrains', 'followed_by', 'contributes_to', 'co_observed'];
export const MEMORY_EDGE_STATUSES = ['candidate', 'verified', 'rejected'];
export const MEMORY_SUPPORT_KINDS = ['asserted', 'structural', 'hypothesized'];
export const SOURCE_TYPES = ['patient', 'doctor', 'structured'];
export const FORBIDDEN_SOURCES = ['query', 'gold_answer', 'answer_options', 'judge_score', 'future_session', 'derived'];
export const OPERATIONS = ['ADD', 'UPDATE', 'SUPERSEDE', 'RESOLVE', 'CONFLICT', 'NOOP'];
export const ACTION_TYPES = ['ANSWER', 'ASK', 'VERIFY', 'EDUCATE', 'ESCALATE', 'REFUSE'];

export class SchemaError extends Error {
  constructor(schema, errors, value) {
    super(`${schema} validation failed: ${errors.join('; ')}`);
    this.name = 'SchemaError';
    this.schema = schema;
    this.errors = errors;
    this.value = value;
  }
}

const requiredString = (obj, key, errors) => {
  if (typeof obj?.[key] !== 'string' || !obj[key].trim()) errors.push(`${key} must be a non-empty string`);
};

export function validateObservation(value) {
  const errors = [];
  requiredString(value, 'subject_id', errors);
  requiredString(value, 'source_type', errors);
  requiredString(value, 'episode_id', errors);
  requiredString(value, 'turn_id', errors);
  requiredString(value, 'raw_text', errors);
  if (!SOURCE_TYPES.includes(value?.source_type)) {
    errors.push(`source_type must be one of ${SOURCE_TYPES.join(', ')}`);
  }
  if (FORBIDDEN_SOURCES.includes(value?.source_type)) {
    errors.push(`${value.source_type} is not a core observation source`);
  }
  if (value?.event_time && Number.isNaN(Date.parse(value.event_time))) errors.push('event_time must be ISO-compatible');
  const allowed = new Set(['observation_id','subject_id','source_type','episode_id','turn_id','event_time','raw_text']);
  const extra = Object.keys(value || {}).filter(key => !allowed.has(key));
  if (extra.length) errors.push(`unsupported observation fields: ${extra.join(', ')}`);
  if (errors.length) throw new SchemaError('Observation', errors, value);
  return {
    observation_id: value.observation_id || randomUUID(),
    subject_id: value.subject_id.trim(), source_type: value.source_type,
    episode_id: value.episode_id.trim(), turn_id: value.turn_id.trim(),
    event_time: value.event_time || null, raw_text: value.raw_text.trim()
  };
}

export function validateMemoryNode(value) {
  const errors = [];
  for (const key of ['memory_id', 'observation_id', 'subject_id', 'text', 'source_type', 'episode_id', 'status']) requiredString(value, key, errors);
  if (!SOURCE_TYPES.includes(value?.source_type)) errors.push('invalid memory source_type');
  if (!['affirmed', 'negated', 'uncertain'].includes(value?.polarity)) errors.push('invalid polarity');
  if (typeof value?.certainty !== 'number' || value.certainty < 0 || value.certainty > 1) errors.push('certainty must be 0..1');
  if (value?.span != null && (!Array.isArray(value.span) || value.span.length !== 2 || value.span.some(x=>!Number.isInteger(x)) || value.span[0] < 0 || value.span[1] <= value.span[0])) errors.push('span must be null or integer [start,end) offsets');
  if(value?.support_unit_ids!=null){
    if(!Array.isArray(value.support_unit_ids)||value.support_unit_ids.length===0||value.support_unit_ids.some(id=>typeof id!=='string'||!id.trim()))errors.push('support_unit_ids must be a non-empty string array when present');
    else if(new Set(value.support_unit_ids).size!==value.support_unit_ids.length)errors.push('support_unit_ids must not contain duplicates');
  }
  if(value?.construction_kind!=null&&!['semantic','fallback','literal_provenance'].includes(value.construction_kind))errors.push('construction_kind must be semantic, fallback, or literal_provenance when present');
  if (!Array.isArray(value?.families) || value.families.length === 0) errors.push('memory node requires at least one family');
  else {
    const seen=new Set();
    for(const family of value.families){if(!MEMORY_FAMILIES.includes(family))errors.push(`invalid memory family ${family}`);if(seen.has(family))errors.push(`duplicate memory family ${family}`);seen.add(family);}
  }
  if (!Array.isArray(value?.version_chain)) errors.push('version_chain must be an array');
  if (!Number.isInteger(value?.version) || value.version < 1) errors.push('version must be a positive integer');
  if (!OPERATIONS.includes(value?.operation)) errors.push('invalid memory operation');
  if (!['active','conflict'].includes(value?.status)) errors.push('invalid memory status');
  if (!Array.isArray(value?.factor_domains) || value.factor_domains.length===0) errors.push('factor_domains must be a non-empty array');
  const allowed=new Set(['memory_id','observation_id','subject_id','text','source_text','span','support_unit_ids','construction_kind','source_type','episode_id','turn_id','event_time','certainty','polarity','families','factor_key','factor_domains','status','valid_from','version','version_chain','predecessor_memory_id','successor_memory_id','conflicts_with_memory_id','operation']);
  const extra=Object.keys(value||{}).filter(key=>!allowed.has(key));
  if(extra.length)errors.push(`unsupported Memory Node fields: ${extra.join(', ')}`);
  if (errors.length) throw new SchemaError('MemoryNode', errors, value);
  return value;
}

/**
 * Inspect whether a Memory Node has the minimum immutable provenance required
 * to be used as a patient fact. `span` is the source span: a half-open offset
 * into the corresponding visible Observation. The Observation is optional so
 * legacy snapshots can be screened without making their schema unreadable;
 * ingestion supplies it and therefore performs the stronger byte-for-byte
 * slice check.
 */
export function inspectMemoryNodeSourceAlignment(value, observation=null) {
  const reasons=[],sourceText=typeof value?.source_text==='string'?value.source_text:'',span=value?.span;
  if(!sourceText.trim())reasons.push('missing_source_text');
  const validSpan=Array.isArray(span)&&span.length===2&&span.every(Number.isInteger)&&span[0]>=0&&span[1]>span[0];
  if(span==null)reasons.push('missing_source_span');
  else if(!validSpan)reasons.push('invalid_source_span');
  if(observation&&typeof observation==='object'){
    if(value?.observation_id&&observation.observation_id&&String(value.observation_id)!==String(observation.observation_id))reasons.push('observation_id_mismatch');
    const rawText=typeof observation.raw_text==='string'?observation.raw_text:null;
    if(validSpan&&rawText!=null){
      if(span[1]>rawText.length)reasons.push('source_span_out_of_bounds');
      else if(sourceText&&rawText.slice(span[0],span[1])!==sourceText)reasons.push('source_span_text_mismatch');
    }
  }
  return{aligned:reasons.length===0,reasons:[...new Set(reasons)]};
}

// Deliberately separate from validateMemoryNode: old snapshots remain readable
// and can be rebuilt, but an ungrounded legacy node is not answer-eligible.
export function isAnswerableMemoryNode(value){return inspectMemoryNodeSourceAlignment(value).aligned;}

export function sourceGroundedMemoryGraph(memoryNodes=[],memoryEdges=[],{observations=[]}={}){
  const observationById=observations instanceof Map?observations:new Map((Array.isArray(observations)?observations:[]).filter(item=>item?.observation_id&&typeof item.raw_text==='string').map(item=>[String(item.observation_id),item])),eligible=[],quarantined=[];let observationVerified=0,shapeOnly=0;
  for(const node of Array.isArray(memoryNodes)?memoryNodes:[]){
    const observation=observationById.get(String(node?.observation_id||''))||null,report=inspectMemoryNodeSourceAlignment(node,observation);
    if(observation)observationVerified++;else shapeOnly++;
    if(report.aligned)eligible.push(node);else quarantined.push({memory_id:String(node?.memory_id||''),reasons:report.reasons});
  }
  const ids=new Set(eligible.map(node=>String(node.memory_id))),edges=(Array.isArray(memoryEdges)?memoryEdges:[]).filter(edge=>ids.has(String(edge?.from_memory_id||''))&&ids.has(String(edge?.to_memory_id||''))&&(edge?.support_memory_ids||[]).every(id=>ids.has(String(id))));
  const reason_counts={};for(const item of quarantined)for(const reason of item.reasons)reason_counts[reason]=(reason_counts[reason]||0)+1;
  return{nodes:eligible,edges,audit:{version:'careharness-source-grounding-gate.v2-observation-recheck',policy:'answer_requires_source_text_span_and_exact_observation_slice_when_observation_available',inspected_memory_node_count:(Array.isArray(memoryNodes)?memoryNodes:[]).length,observation_verified_memory_node_count:observationVerified,shape_only_memory_node_count:shapeOnly,eligible_memory_node_count:eligible.length,quarantined_memory_node_count:quarantined.length,quarantined_memory_ids:quarantined.map(item=>item.memory_id).filter(Boolean),reason_counts}};
}

export function validateMemoryDelta(value) {
  const errors = [];
  if (!OPERATIONS.includes(value?.operation)) errors.push('invalid operation');
  requiredString(value, 'memory_id', errors);
  if (!Array.isArray(value?.families) || value.families.some(family=>!MEMORY_FAMILIES.includes(family))) errors.push('invalid families');
  if (errors.length) throw new SchemaError('MemoryDelta', errors, value);
  return value;
}

export function validateMemoryEdge(value) {
  const errors = [];
  for (const key of ['edge_id', 'subject_id', 'from_memory_id', 'to_memory_id', 'edge_family', 'relation_type', 'status']) requiredString(value, key, errors);
  if (!MEMORY_EDGE_FAMILIES.includes(value?.edge_family)) errors.push('invalid edge_family');
  if (!MEMORY_RELATIONS.includes(value?.relation_type)) errors.push('invalid relation_type');
  if (!MEMORY_EDGE_STATUSES.includes(value?.status)) errors.push('invalid edge status');
  if (!MEMORY_SUPPORT_KINDS.includes(value?.support_kind)) errors.push('invalid support_kind');
  if (value?.from_memory_id === value?.to_memory_id) errors.push('memory edge cannot be a self-loop');
  if (!Array.isArray(value?.support_memory_ids) || value.support_memory_ids.length === 0) errors.push('memory edge requires support_memory_ids');
  if (typeof value?.confidence !== 'number' || value.confidence < 0 || value.confidence > 1) errors.push('confidence must be 0..1');
  if (value?.persistent !== true) errors.push('memory graph edge must be persistent');
  if (value?.causal_claim !== false) errors.push('memory graph edge cannot claim causality');
  const allowed=new Set(['edge_id','subject_id','from_memory_id','to_memory_id','edge_family','relation_type','support_memory_ids','confidence','support_kind','status','verified','persistent','causal_claim','source','created_episode_id']);
  const extra=Object.keys(value||{}).filter(key=>!allowed.has(key));
  if(extra.length)errors.push(`unsupported Memory Edge fields: ${extra.join(', ')}`);
  if (errors.length) throw new SchemaError('MemoryEdge', errors, value);
  return value;
}

export function validateAction(value) {
  const errors = [];
  if (!ACTION_TYPES.includes(value?.type)) errors.push('invalid action type');
  if (!Array.isArray(value?.required_memory_ids)) errors.push('required_memory_ids must be array');
  if (!Array.isArray(value?.required_content) || !Array.isArray(value?.forbidden_content)) errors.push('content constraints must be arrays');
  requiredString(value, 'explanation', errors);
  if (errors.length) throw new SchemaError('Action', errors, value);
  return value;
}

export function validateProviderConfig(value) {
  const errors = [];
  requiredString(value, 'provider', errors); requiredString(value, 'model', errors);
  if (!['mock', 'openai', 'dashscope', 'deepseek', 'openrouter', 'openai-compatible'].includes(value?.provider)) errors.push('unsupported provider');
  if (value?.provider !== 'mock' && (!value?.base_url || typeof value.base_url !== 'string')) errors.push('base_url is required');
  if (value?.base_url) {
    try { const url=new URL(value.base_url); if (!['http:','https:'].includes(url.protocol)) errors.push('base_url must use http or https'); }
    catch { errors.push('base_url must be a valid URL'); }
  }
  if (value?.api_key || value?.apiKey) errors.push('raw API keys must be submitted separately and kept in server memory');
  if (value?.temperature != null && (value.temperature < 0 || value.temperature > 2)) errors.push('temperature must be 0..2');
  if (value?.enable_thinking != null && typeof value.enable_thinking !== 'boolean') errors.push('enable_thinking must be boolean');
  if (value?.seed != null && (!Number.isInteger(Number(value.seed)) || Number(value.seed) < 0 || Number(value.seed) > 2147483647)) errors.push('seed must be an integer from 0 to 2147483647');
  if (errors.length) throw new SchemaError('ProviderConfig', errors, value);
  return {
    provider: value.provider, base_url: value.base_url || '', model: value.model,
    api_key_ref: value.api_key_ref || '', temperature: value.temperature ?? 0, seed: value.seed == null ? 42 : Number(value.seed),
    enable_thinking: value.enable_thinking ?? (value.provider === 'dashscope' ? false : null),
    max_tokens: value.max_tokens ?? 1200, timeout_ms: value.timeout_ms ?? 30000,
    retries: value.retries ?? 1, capabilities: value.capabilities || ['json'], context_length: value.context_length ?? null
  };
}

export function sanitizeSecrets(value) {
  if (Array.isArray(value)) return value.map(sanitizeSecrets);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => {
    if (/^(api_?key|authorization|token|secret)$/i.test(k)) return [k, '[REDACTED]'];
    return [k, sanitizeSecrets(v)];
  }));
}
