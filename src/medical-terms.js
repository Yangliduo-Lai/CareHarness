// Compatibility surface retained for callers outside this package. Runtime
// behavior is intentionally vocabulary-free: aliases must come from a model or
// caller-owned ontology, never from benchmark-shaped source code.
export const MEDICAL_ALIAS_GROUPS=Object.freeze([]);
export function aliasesIn(){return[];}
export function canonicalizeMedicalAliases(value){return String(value||'').normalize('NFKC').trim();}
