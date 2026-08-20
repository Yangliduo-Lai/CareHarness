import { randomUUID } from 'node:crypto';

export const STATE_FAMILIES = ['BC', 'PE', 'PA', 'CS', 'CP', 'LO'];
export const PATIENT_GRAPH_EDGE_FAMILIES = ['temporal', 'clinical_care'];
export const PATIENT_GRAPH_RELATIONS = ['persists', 'updates', 'supersedes', 'resolves', 'recurs', 'conflicts', 'informs', 'motivates', 'constrains', 'followed_by', 'contributes_to'];
export const PATIENT_GRAPH_EDGE_STATUSES = ['candidate', 'verified', 'rejected'];
export const PATIENT_GRAPH_SUPPORT_KINDS = ['asserted', 'structural', 'hypothesized'];
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

export function validateEvidence(value) {
  const errors = [];
  for (const key of ['evidence_id', 'observation_id', 'subject_id', 'text', 'source_type', 'episode_id']) requiredString(value, key, errors);
  if (!SOURCE_TYPES.includes(value?.source_type)) errors.push('invalid evidence source_type');
  if (!['affirmed', 'negated', 'uncertain'].includes(value?.polarity)) errors.push('invalid polarity');
  if (typeof value?.certainty !== 'number' || value.certainty < 0 || value.certainty > 1) errors.push('certainty must be 0..1');
  if (value?.span != null && (!Array.isArray(value.span) || value.span.length !== 2 || value.span.some(x=>!Number.isInteger(x)) || value.span[0] < 0 || value.span[1] <= value.span[0])) errors.push('span must be null or integer [start,end) offsets');
  if (errors.length) throw new SchemaError('Evidence', errors, value);
  return value;
}

export function validateState(value) {
  const errors = [];
  for (const key of ['state_id', 'subject_id', 'family', 'value', 'status']) requiredString(value, key, errors);
  if (!STATE_FAMILIES.includes(value?.family)) errors.push('invalid state family');
  if (!Array.isArray(value?.evidence_ids) || value.evidence_ids.length === 0) errors.push('state requires evidence_ids');
  if (!Array.isArray(value?.version_chain)) errors.push('version_chain must be an array');
  if (errors.length) throw new SchemaError('State', errors, value);
  return value;
}

export function validateStateDelta(value) {
  const errors = [];
  if (!OPERATIONS.includes(value?.operation)) errors.push('invalid operation');
  if (!STATE_FAMILIES.includes(value?.family)) errors.push('invalid family');
  requiredString(value, 'evidence_id', errors);
  if (errors.length) throw new SchemaError('StateDelta', errors, value);
  return value;
}

export function validatePatientGraphEdge(value) {
  const errors = [];
  for (const key of ['edge_id', 'subject_id', 'from_state_id', 'to_state_id', 'edge_family', 'relation_type', 'status']) requiredString(value, key, errors);
  if (!PATIENT_GRAPH_EDGE_FAMILIES.includes(value?.edge_family)) errors.push('invalid edge_family');
  if (!PATIENT_GRAPH_RELATIONS.includes(value?.relation_type)) errors.push('invalid relation_type');
  if (!PATIENT_GRAPH_EDGE_STATUSES.includes(value?.status)) errors.push('invalid edge status');
  if (!PATIENT_GRAPH_SUPPORT_KINDS.includes(value?.support_kind)) errors.push('invalid support_kind');
  if (value?.from_state_id === value?.to_state_id) errors.push('graph edge cannot be a self-loop');
  if (!Array.isArray(value?.evidence_ids) || value.evidence_ids.length === 0) errors.push('graph edge requires evidence_ids');
  if (typeof value?.confidence !== 'number' || value.confidence < 0 || value.confidence > 1) errors.push('confidence must be 0..1');
  if (value?.persistent !== true) errors.push('patient graph edge must be persistent');
  if (value?.causal_claim !== false) errors.push('patient graph edge cannot claim causality');
  if (errors.length) throw new SchemaError('PatientGraphEdge', errors, value);
  return value;
}

export function validateAction(value) {
  const errors = [];
  if (!ACTION_TYPES.includes(value?.type)) errors.push('invalid action type');
  if (!Array.isArray(value?.required_evidence_ids)) errors.push('required_evidence_ids must be array');
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
  if (errors.length) throw new SchemaError('ProviderConfig', errors, value);
  return {
    provider: value.provider, base_url: value.base_url || '', model: value.model,
    api_key_ref: value.api_key_ref || '', temperature: value.temperature ?? 0,
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
