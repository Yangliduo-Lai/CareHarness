import { randomUUID } from 'node:crypto';

export const STATE_FAMILIES = ['BC', 'PE', 'PA', 'CS', 'CP', 'LO'];
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

export function validateObservation(value, { allowDerivedContext = false } = {}) {
  const errors = [];
  requiredString(value, 'subject_id', errors);
  requiredString(value, 'source_type', errors);
  requiredString(value, 'speaker', errors);
  requiredString(value, 'episode_id', errors);
  requiredString(value, 'turn_id', errors);
  requiredString(value, 'raw_text', errors);
  if (!SOURCE_TYPES.includes(value?.source_type)) {
    const derivedAllowed = allowDerivedContext && value?.source_type === 'derived';
    if (!derivedAllowed) errors.push(`source_type must be one of ${SOURCE_TYPES.join(', ')}`);
  }
  if (FORBIDDEN_SOURCES.includes(value?.source_type) && !(allowDerivedContext && value?.source_type === 'derived')) {
    errors.push(`${value.source_type} is not a core observation source`);
  }
  if (value?.event_time && Number.isNaN(Date.parse(value.event_time))) errors.push('event_time must be ISO-compatible');
  if (errors.length) throw new SchemaError('Observation', errors, value);
  return {
    observation_id: value.observation_id || randomUUID(),
    subject_id: value.subject_id.trim(), source_type: value.source_type,
    speaker: value.speaker.trim(), episode_id: value.episode_id.trim(), turn_id: value.turn_id.trim(),
    event_time: value.event_time || null, record_time: value.record_time || new Date().toISOString(),
    raw_text: value.raw_text.trim(), dataset: value.dataset || 'core', checkpoint: value.checkpoint ?? null,
    metadata: value.metadata && typeof value.metadata === 'object' ? value.metadata : {}
  };
}

export function validateEvidence(value) {
  const errors = [];
  for (const key of ['evidence_id', 'observation_id', 'subject_id', 'text', 'source_type', 'speaker', 'episode_id']) requiredString(value, key, errors);
  if (!['affirmed', 'negated', 'uncertain'].includes(value?.polarity)) errors.push('invalid polarity');
  if (typeof value?.certainty !== 'number' || value.certainty < 0 || value.certainty > 1) errors.push('certainty must be 0..1');
  if (!Array.isArray(value?.span) || value.span.length !== 2 || value.span.some(Number.isNaN)) errors.push('span must be [start,end]');
  if (errors.length) throw new SchemaError('Evidence', errors, value);
  return value;
}

export function validateState(value) {
  const errors = [];
  for (const key of ['state_id', 'subject_id', 'family', 'subtype', 'entity', 'value', 'status']) requiredString(value, key, errors);
  if (!STATE_FAMILIES.includes(value?.family)) errors.push('invalid state family');
  if (!Array.isArray(value?.evidence_ids) || value.evidence_ids.length === 0) errors.push('state requires evidence_ids');
  if (!Array.isArray(value?.version_chain)) errors.push('version_chain must be an array');
  if (value?.source_type === 'derived' && (!Array.isArray(value?.derived_from) || value.derived_from.length === 0)) errors.push('derived state requires derived_from');
  if (errors.length) throw new SchemaError('State', errors, value);
  return value;
}

export function validateStateDelta(value) {
  const errors = [];
  if (!OPERATIONS.includes(value?.operation)) errors.push('invalid operation');
  if (!STATE_FAMILIES.includes(value?.family)) errors.push('invalid family');
  requiredString(value, 'reason', errors);
  requiredString(value, 'evidence_id', errors);
  if (errors.length) throw new SchemaError('StateDelta', errors, value);
  return value;
}

export function validateRelation(value) {
  const errors = [];
  for (const key of ['relation_id', 'type', 'source_id', 'target_id']) requiredString(value, key, errors);
  if (errors.length) throw new SchemaError('Relation', errors, value);
  return value;
}

export function validateGateTrace(value, gate) {
  const errors = [];
  if (value?.gate !== gate) errors.push(`gate must be ${gate}`);
  if (!Array.isArray(value?.evidence_ids)) errors.push('evidence_ids must be array');
  if (!value?.output || typeof value.output !== 'object') errors.push('output must be object');
  if (gate === 'G1' && !Array.isArray(value?.output?.safe_action_set)) errors.push('G1 safe_action_set required');
  if (gate === 'G2' && typeof value?.output?.sufficient_to_act !== 'boolean') errors.push('G2 sufficient_to_act required');
  if (gate === 'G3' && !Array.isArray(value?.output?.feasible_set)) errors.push('G3 feasible_set required');
  if (errors.length) throw new SchemaError('GateTrace', errors, value);
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
  if (!['mock', 'openai-compatible'].includes(value?.provider)) errors.push('unsupported provider');
  if (value?.api_key || value?.apiKey) errors.push('raw API keys are forbidden; use api_key_ref');
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
