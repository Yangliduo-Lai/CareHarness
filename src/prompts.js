export const PROMPTS = Object.freeze({
  extractor: { version: 'extractor.v1', description: 'Split source text into directly supported atomic evidence.' },
  router: { version: 'router.six-state.v1', description: 'Link entities and route evidence to BC/PE/PA/CS/CP/LO.' },
  updater: { version: 'updater.temporal.v1', description: 'Apply typed longitudinal update contracts without deleting evidence.' },
  validity: { version: 'validity.v1', description: 'Exclude future, stale, conflicting, incomparable, or ungrounded state.' },
  g1: { version: 'gate.clinical-safety.v1', description: 'Build safety set, prohibitions, monitoring, and escalation.' },
  g2: { version: 'gate.sufficiency.v1', description: 'Find belief gaps, missing facts, conflicts, and verification needs.' },
  g3: { version: 'gate.feasibility.v1', description: 'Rank feasible continuity-aware options within G1 and G2 limits.' },
  generator: { version: 'generator.governed.v1', description: 'Express the structured action without changing it.' },
  auditor: { version: 'auditor.v1', description: 'Block ungrounded or gate-violating replies.' },
  judge: { version: 'judge.compat.v1', description: 'Benchmark-compatible scoring outside the core state pipeline.' }
});

export function promptFor(component, input) {
  const entry = PROMPTS[component];
  if (!entry) throw new Error(`Unknown prompt component: ${component}`);
  return `${entry.description}\nReturn valid JSON only.\nINPUT:\n${JSON.stringify(input)}`;
}
