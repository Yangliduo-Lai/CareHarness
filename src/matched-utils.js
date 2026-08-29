import { createHash } from 'node:crypto';
import { MATCHED_EVALUATION_MODE } from './careharness-contract.js';

export function assertStaticCareHarnessMode(value) {
  if (value !== MATCHED_EVALUATION_MODE) {
    throw new Error(`Matched evaluation mode is fixed to ${MATCHED_EVALUATION_MODE}; legacy comparator modes have been removed`);
  }
  return value;
}

export function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${name} must be a positive integer`);
  return number;
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
