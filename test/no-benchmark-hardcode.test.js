import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,readdirSync,statSync } from 'node:fs';
import { dirname,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreMedMemoryOfficial } from '../src/medmemory-official.js';
import { selectCareHarnessActions } from '../src/careharness-actions.js';

const root=join(dirname(fileURLToPath(import.meta.url)),'..','src');

function javascriptFiles(directory){
  return readdirSync(directory).flatMap(name=>{
    const path=join(directory,name),stat=statSync(path);
    return stat.isDirectory()?javascriptFiles(path):path.endsWith('.js')?[path]:[];
  });
}

test('production runtime contains no benchmark-case answer overrides',()=>{
  const source=javascriptFiles(root).map(path=>readFileSync(path,'utf8')).join('\n');
  const forbidden=[
    ['query-created answer State',/query-derived:/u],
    ['benchmark scoring exception',/MEDMEMORY_BENCHMARK_ERRATA|benchmark_erratum|accepted_alternatives/u],
    ['known case identifier',/session_100_eem_2/u],
    ['case constraint injection',/clinical_constraint_states|augmentClinicalConstraintStates/u],
    ['case-specific normalization',/entityNormalizationState|eventNormalizationState|stateUpdateNormalizationState/u],
    ['case-specific retrieval router',/retrieveOptionFacetEvidence|mcdQuestionKind|asksAboutGlucoseMedicationAdjustment/u]
  ];
  for(const[label,pattern]of forbidden)assert.doesNotMatch(source,pattern,label);
});

test('query and state runtime contains no semantic keyword routing',()=>{
  const files=['careharness-actions.js','retrieval.js','evidence-index-gate.js','pipeline.js','medical-terms.js'];
  const source=files.map(name=>readFileSync(join(root,name),'utf8')).join('\n');
  const forbidden=[
    ['question-text semantic branch',/\.test\((?:String\()?\s*(?:question|plan\.question|queryPlan\.question)/u],
    ['medical alias behavior',/import\s*\{\s*aliasesIn\s*\}|aliasesIn\([^)]/u],
    ['semantic query inference helper',/inferQueryIntent|inferTemporalOperator|inferAnswerSlot|semanticExpansionTerms|domainTerms|FACET_PATTERNS/u],
    ['benchmark-shaped medical vocabulary',/恩格列净|二甲双胍|头孢呋辛|克拉霉素|阿莫西林|甲状腺|滴度/u],
    ['case-shaped medication coverage',/coverage:medication|MEDICATION_COVERAGE|explicitPatientMedicationClaims/u]
  ];
  for(const[label,pattern]of forbidden)assert.doesNotMatch(source,pattern,label);
});

test('Action policy is type-blind and contains no benchmark task routing',()=>{
  const files=['careharness-actions.js','retrieval.js','evidence-index-gate.js','matched-experiment.js'];
  const source=files.map(name=>readFileSync(join(root,name),'utf8')).join('\n');
  const forbidden=[
    ['benchmark task label',/entity_exact_match|temporal_localization|state_update|multiple_choice|inference_generation|multi_hop_clinical_deduction/u],
    ['query type access',/queryPlan\s*(?:\.\s*(?:query_type|task)|\[\s*['"](?:query_type|task)['"]\s*\])/u],
    ['type-dependent policy description',/configured_task_class_policy|task[_ -]specific|type[_ -]specific/iu]
  ];
  for(const[label,pattern]of forbidden)assert.doesNotMatch(source,pattern,label);
  const expected=['focus','anchor','connect','evaluate','verify','answer'];
  for(const query_type of ['unknown-a','unknown-b','unknown-c'])assert.deepEqual(selectCareHarnessActions({query_type}),expected);
});

test('entity scoring depends on output and gold only, never a case identifier',()=>{
  const item={score_id:'synthetic-case',task:'entity_exact_match',metadata:{official_evaluation:{metric:'string_contain'}}};
  assert.equal(scoreMedMemoryOfficial('beta',['alpha'],item).score,0);
  assert.equal(scoreMedMemoryOfficial('alpha',['alpha'],item).score,1);
});
