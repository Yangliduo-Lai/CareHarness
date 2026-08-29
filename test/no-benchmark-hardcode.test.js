import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync,readdirSync,statSync } from 'node:fs';
import { dirname,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adapters } from '../src/adapters/index.js';
import { scoreMedMemoryOfficial } from '../src/medmemory-official.js';
import { MEDMEMORY_INVESTIGATION_STRATEGIES,PROMPTS } from '../src/prompts.js';

const root=join(dirname(fileURLToPath(import.meta.url)),'..','src');
const runtimeFiles=['action-policy-learning.js','careharness-actions.js','retrieval.js','investigation-contract.js','investigation-runtime.js','investigation-workers.js','matched-runtime.js','memory-graph-updater.js','pipeline.js'];
const runtimeSource=()=>runtimeFiles.map(name=>readFileSync(join(root,name),'utf8')).join('\n');
function javascriptFiles(directory){return readdirSync(directory).flatMap(name=>{const path=join(directory,name),stat=statSync(path);return stat.isDirectory()?javascriptFiles(path):path.endsWith('.js')?[path]:[];});}

test('production runtime contains no benchmark-case answer overrides',()=>{
  const source=javascriptFiles(root).map(path=>readFileSync(path,'utf8')).join('\n');
  for(const[label,pattern]of [
    ['benchmark scoring exception',/MEDMEMORY_BENCHMARK_ERRATA|benchmark_erratum|accepted_alternatives/u],
    ['known case identifier',/session_100_eem_2/u],
    ['case constraint injection',/clinical_constraint_states|augmentClinicalConstraintStates/u],
    ['case-specific retrieval router',/retrieveOptionFacetEvidence|mcdQuestionKind|asksAboutGlucoseMedicationAdjustment/u]
  ])assert.doesNotMatch(source,pattern,label);
});

test('case-free runtime contains no case vocabulary or static Query Plan',()=>{
  const source=runtimeSource();
  for(const[label,pattern]of [
    ['static query plan',/query_plan|state_scopes|evidence_facets|target_slot_ids/u],
    ['benchmark-shaped vocabulary',/恩格列净|二甲双胍|头孢呋辛|克拉霉素|阿莫西林|GADA|SAID/u]
  ])assert.doesNotMatch(source,pattern,label);
});

test('transparent task strategies contain generic evidence contracts and no case facts',()=>{
  assert.deepEqual(Object.keys(MEDMEMORY_INVESTIGATION_STRATEGIES).sort(),['entity_exact_match','inference_generation','multi_hop_clinical_deduction','multiple_choice','state_update','temporal_localization'].sort());
  assert.deepEqual(Object.fromEntries(Object.entries(MEDMEMORY_INVESTIGATION_STRATEGIES).map(([type,profile])=>[type,profile.answer_focus_limit])),{entity_exact_match:1,temporal_localization:2,state_update:10,multiple_choice:8,inference_generation:10,multi_hop_clinical_deduction:16});
  const source=JSON.stringify(MEDMEMORY_INVESTIGATION_STRATEGIES);
  for(const pattern of[/session_[0-9]+_/u,/恩格列净|二甲双胍|头孢呋辛|克拉霉素|阿莫西林|GADA|SAID|HPA轴|β细胞/u,/required_patient_info|common_wrong_answer|nodes_for_validation|source_key_points/u])assert.doesNotMatch(source,pattern);
});

test('query-time semantic evidence contracts contain no benchmark labels or case vocabulary',()=>{
  const source=`${PROMPTS.investigation_policy.contract}\n${PROMPTS.careharness_evaluate.contract}`;
  for(const[label,pattern]of [
    ['benchmark task label',/entity_exact_match|temporal_localization|state_update|multiple_choice|inference_generation|multi_hop_clinical_deduction/u],
    ['case vocabulary',/恩格列净|二甲双胍|头孢呋辛|克拉霉素|阿莫西林|GADA|SAID|HPA轴|β细胞/u],
    ['case identifier',/session_[0-9]+_/u]
  ])assert.doesNotMatch(source,pattern,label);
});

test('runtime has one Memory Node vocabulary and no deleted compatibility APIs',()=>{
  const source=runtimeSource();
  for(const pattern of [/retrieved_states/u,/retrieved_evidence/u,/statesFor/u,/evidenceFor/u,/patientGraphFor/u,/from_state_id/u,/to_state_id/u])assert.doesNotMatch(source,pattern);
  assert.match(source,/memory_nodes/u);assert.match(source,/memory_id/u);
});

test('entity scoring depends on output and Gold only, never a case identifier',()=>{
  const item={score_id:'synthetic-case',task:'entity_exact_match',metadata:{official_evaluation:{metric:'string_contain'}}};
  assert.equal(scoreMedMemoryOfficial('beta',['alpha'],item).score,0);assert.equal(scoreMedMemoryOfficial('alpha',['alpha'],item).score,1);
});

test('runtime source contains no dataset questions, answers, or case identifiers',t=>{
  const rootPath=process.env.CAREHARNESS_DATA_ROOT;if(!rootPath)return t.skip('CAREHARNESS_DATA_ROOT is unavailable');
  // Include prompts and every other production module.  Type-level strategy
  // text is allowed, but a question/Gold string compiled into prompts.js would
  // still be a case-specific runtime override and must fail this audit.
  const adapter=adapters(rootPath).medmemorybench,source=normalizeForScan(javascriptFiles(root).map(path=>readFileSync(path,'utf8')).join('\n')),needles=[];
  for(const persona_id of Array.from({length:20},(_,index)=>index+1)){
    let data,rawQueries;
    try{
      data=adapter.load({persona_id,noise:false,start_session:1});
      rawQueries=JSON.parse(readFileSync(join(adapter.root,`persona_${persona_id}`,'eval','generated_queries.json'),'utf8')).queries||[];
    }catch{return t.skip('MedMemoryBench Persona data is unavailable');}
    for(const item of adapter.cases(data)){needles.push(['case_id',item.score_id],['question',item.question]);for(const gold of item.gold||[])needles.push(['gold',gold]);}
    for(const query of rawQueries)needles.push(...judgeOnlyNeedles(query));
  }
  for(const[kind,value]of needles){const normalized=normalizeForScan(value);if(normalized.length<12)continue;assert.equal(source.includes(normalized),false,`${kind} hash ${createHash('sha256').update(normalized).digest('hex').slice(0,12)} appears in runtime source`);}
});

function normalizeForScan(value){return String(value||'').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu,'');}

function judgeOnlyNeedles(query={}){
  const values=[],push=(kind,value)=>{if(value!=null&&String(value).trim())values.push([kind,String(value)]);},metadata=query.metadata||{},trap=metadata.trap_design||{},wrong=metadata.common_wrong_answer||{};
  for(const point of query.source_key_points||[]){push('source_key_point_name',point?.name);push('source_key_point_content',point?.content);}
  for(const answer of query.answers||[]){push('answer_content',answer?.content);push('answer_explanation',answer?.explanation);}
  push('trap_mechanism',trap.trap_mechanism);for(const item of trap.required_patient_info||[])push('required_patient_info',item);
  push('common_wrong_answer',wrong.content);push('common_wrong_reason',wrong.why_wrong);
  for(const item of metadata.required_memory_nodes||[])push('required_memory_node',item);
  for(const node of metadata.reasoning_chain||[]){push('reasoning_node',node?.content);push('reasoning_source_info',node?.source_info);}
  return values;
}
