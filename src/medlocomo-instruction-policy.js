import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MEDLOCOMO_EMBEDDING_BASE_MODEL,MEDLOCOMO_EMBEDDING_BASE_MODEL_REVISION,MEDLOCOMO_EMBEDDING_CHUNK_TURNS,MEDLOCOMO_EMBEDDING_DIMENSION,MEDLOCOMO_EMBEDDING_MODEL,MEDLOCOMO_EMBEDDING_MODEL_REVISION,MEDLOCOMO_EMBEDDING_SNAPSHOT_FILE_HASHES,MEDLOCOMO_EMBEDDING_SNAPSHOT_HASH } from './embedding-retrieval.js';

export const MEDLOCOMO_INSTRUCTION_POLICY_VERSION='medlocomo-instruction-salience.v1-patient-disjoint';
export const MEDLOCOMO_INSTRUCTION_POLICY_DEFAULT_PATH='data/medlocomo-hierarchical-distillation/instruction-policy.json';

const QUESTION_TYPES=Object.freeze(['adversarial','care_plan_rationale','cross_admission_comparison','frequency_pattern','longitudinal_progression','medical_reasoning']);
const TYPE_INDEX=new Map(QUESTION_TYPES.map((value,index)=>[value,index]));
const TOKEN=/[A-Za-z]+(?:[-'][A-Za-z]+)*|\d+(?:\.\d+)?/gu;
const STOP=new Set(('a an the and or of for to in on at by as was were is are be been being with from during which what when where why how did does do had has have his her their this that these those into after before over time patient patients hospitalization hospitalizations admission admissions across multiple because due while most primary main following according record records tell describe explain compare between regarding related all').split(' '));
const QUESTION_WORDS=new Set('what which when where why how who whose whom did does do is are was were can could would should'.split(' '));
const TEMPORAL=new Set('initial initially earliest first baseline final finally latest last eventually ultimately discharge progression progressed over time'.split(' '));
const COMPARISON=new Set('compare comparison compared differ difference different similar versus vs between change changed increase decrease higher lower'.split(' '));
const CAUSAL=new Set('why reason rationale explains explain cause caused because due despite'.split(' '));
const NEGATION=new Set('no not never none without denied denies negative absent cannot unable unlikely'.split(' '));
const GENERIC_FEATURE_COUNT=30,TOKEN_BUCKETS=512,CHAR_BUCKETS=256,FEATURE_COUNT=GENERIC_FEATURE_COUNT+TOKEN_BUCKETS+CHAR_BUCKETS,SHA256=/^[a-f0-9]{64}$/u;
const FIXED_TRAIN_COMMITMENT='7144b5b71ac2f1284c406174215cb1fae0a3ccbc3b480d13812fd4782b20f999',FIXED_VALIDATION_COMMITMENT='166669200359c91649418b44453686a9a0a867e2e622001e4cc8666b81393912';
const FORBIDDEN_KEYS=new Set(['patient_id','patient_ids','qa_id','qa_ids','question','questions','gold','gold_answer','answer','answers','evidence','evidence_text','source_ref','source_refs','turn_id','turn_ids','admission_id','admission_ids','case_lookup','question_lookup']);

export function loadMedLoCoMoInstructionPolicy({path=MEDLOCOMO_INSTRUCTION_POLICY_DEFAULT_PATH,allow_pending=false}={}){
  const artifactPath=resolve(path),artifact=JSON.parse(readFileSync(artifactPath,'utf8'));
  validateMedLoCoMoInstructionPolicyArtifact(artifact,{allow_pending});
  return deepFreeze({artifact_path:artifactPath,artifact:structuredClone(artifact),pending_allowed:allow_pending===true});
}

export function validateMedLoCoMoInstructionPolicyArtifact(artifact,{allow_pending=false}={}){
  if(!plain(artifact)||artifact.version!==MEDLOCOMO_INSTRUCTION_POLICY_VERSION||artifact.benchmark!=='medlocomo')throw new Error('Unsupported MedLoCoMo instruction-policy artifact');
  assertSafeAggregate(artifact);
  const boundary=plain(artifact.training_boundary)?artifact.training_boundary:{};
  for(const key of ['retains_patient_ids','retains_qa_ids','retains_question_text','retains_gold_or_answer_text','retains_evidence_text_or_source_refs'])if(boundary[key]!==false)throw new Error(`MedLoCoMo instruction-policy ${key} must be false`);
  if(boundary.official_evidence_used_as_offline_labels!==true||boundary.runtime_reads_official_evidence!==false||boundary.runtime_terms_are_copied_only_from_current_question!==true)throw new Error('MedLoCoMo instruction-policy training boundary is invalid');
  const split=artifact.split||{};
  if(split.method!=='fixed_patient_disjoint_97_train_4_validation'||split.train_patient_count!==97||split.validation_patient_count!==4||split.serialized_coefficients_match_validation_model!==true||split.final_refit!==false||split.train_set_commitment!==FIXED_TRAIN_COMMITMENT||split.validation_set_commitment!==FIXED_VALIDATION_COMMITMENT)throw new Error('MedLoCoMo instruction-policy split is invalid');
  const contract=artifact.feature_contract||{},model=artifact.model||{};
  if(contract.candidate_source!=='unique_tokens_copied_from_runtime_question'||contract.stop_component!=='not_trained_no_runtime_gate'||contract.max_augmented_terms<1||contract.max_augmented_terms>8)throw new Error('MedLoCoMo instruction-policy feature contract is invalid');
  if(!Array.isArray(model.coefficients)||model.coefficients.length!==FEATURE_COUNT||model.coefficients.some(value=>!Number.isFinite(Number(value)))||!Number.isFinite(Number(model.intercept)))throw new Error('MedLoCoMo instruction-policy coefficients are invalid');
  const pending=artifact.status==='offline_validated_pending_production_search_ab'&&artifact.runtime_eligible===false&&artifact.acceptance?.accepted===false&&artifact.deployment?.enabled_by_default===false;
  if(!(allow_pending&&pending))validateDeploymentGate(artifact);
  const body=structuredClone(artifact);delete body.artifact_hash;
  if(!SHA256.test(String(artifact.artifact_hash||''))||sha256(stableJson(body))!==artifact.artifact_hash)throw new Error('MedLoCoMo instruction-policy artifact hash mismatch');
  return true;
}

/** Return a bounded, inspectable prior whose terms are literal spans from Question. */
export function medLoCoMoSearchInstructionPrior(loaded,{question,question_type}={}){
  const artifact=resolveArtifact(loaded),rows=questionTokens(question),type=String(question_type||''),candidates=rows.filter(row=>!STOP.has(row.token)&&!QUESTION_WORDS.has(row.token)).map(row=>({...row,score:scoreRow(artifact,row,type)})).sort((left,right)=>right.score-left.score||left.position-right.position),limit=Math.max(1,Math.min(8,Number(artifact.feature_contract.max_augmented_terms)||4)),selected=candidates.slice(0,limit);
  return deepFreeze({version:'medlocomo-runtime-search-instruction-prior.v1',artifact_hash:artifact.artifact_hash,question_type:type,search_terms:selected.map(row=>row.surface),ranked_terms:selected.map((row,index)=>({term:row.surface,rank:index+1,score:+row.score.toFixed(6)})),term_source:'literal_runtime_question_spans_only',max_augmented_terms:limit,stop_prior:{status:'not_trained',runtime_gate_applied:false}});
}

/**
 * Deterministically add only missing learned Question spans.  The LLM remains
 * free to choose a different Search objective, temporal boundary, or later
 * direction; this helper never removes its terms or creates a hard filter.
 */
export function augmentMedLoCoMoSearchInstruction(instruction,prior,{prior_discovery_no_progress=false}={}){
  const clean=plain(instruction)?structuredClone(instruction):{},literalFields=[...array(clean.search_terms),...array(clean.expansion_terms),...array(clean.required_terms)].map(String).filter(value=>normalize(value)),existing=literalFields.map(normalize),hasOtherRankingControls=array(clean.numeric_signals).length>0||array(clean.lenses).length>0,sparseInstruction=literalFields.length===1&&!hasOtherRankingControls&&String(clean.term_match||'any').toLowerCase()!=='all',retryAfterNoProgress=prior_discovery_no_progress===true,eligible=Boolean(prior)&&(sparseInstruction||retryAfterNoProgress),added=[];
  if(prior?.status==='rejected'||prior?.status==='disabled')return{instruction:clean,trace:{status:prior.status,artifact_hash:prior.artifact_hash||null,added_terms:[],added_term_count:0,activation_reason:null,term_source:prior.term_source||null,rejection_reason:prior.rejection_reason||null,stop_prior:prior.stop_prior||{status:'not_trained',runtime_gate_applied:false}}};
  if(!eligible){const status=!prior?'not_configured':literalFields.length===0?'skipped_objective_already_executable':'skipped_sufficient_instruction';return{instruction:clean,trace:{status,artifact_hash:prior?.artifact_hash||null,added_terms:[],added_term_count:0,activation_reason:null,term_source:prior?.term_source||null,stop_prior:prior?.stop_prior||{status:'not_trained',runtime_gate_applied:false}}};}
  for(const term of array(prior?.search_terms)){const key=normalize(term);if(!key||existing.some(value=>value===key)){continue;}existing.push(key);added.push(String(term));if(added.length>=Math.max(1,Math.min(8,Number(prior?.max_augmented_terms)||4)))break;}
  if(added.length)clean.expansion_terms=[...array(clean.expansion_terms).map(String),...added];
  return{instruction:clean,trace:{status:added.length?'applied':'skipped_no_new_terms',artifact_hash:prior?.artifact_hash||null,added_terms:added,added_term_count:added.length,activation_reason:added.length?(prior_discovery_no_progress?'search_after_prior_no_progress':'sparse_search_instruction'):null,term_source:prior?.term_source||null,stop_prior:prior?.stop_prior||{status:'not_trained',runtime_gate_applied:false}}};
}

export function medLoCoMoInstructionPolicyArtifactHash(value){const body=structuredClone(value);delete body.artifact_hash;return sha256(stableJson(body));}

function scoreRow(artifact,row,type){const weights=artifact.model.coefficients,features=featureValues(row,type);let score=Number(artifact.model.intercept)||0;for(const[index,value]of features)score+=Number(weights[index]||0)*value;return score;}
function validateDeploymentGate(artifact){
  if(artifact.runtime_eligible!==true||artifact.status!=='offline_validated_runtime_wired'||artifact.acceptance?.accepted!==true||artifact.acceptance?.patient_disjoint!==true||artifact.deployment?.enabled_by_default!==true||artifact.deployment?.mode!=='conditional_sparse_or_prior_no_progress_augmentation'||artifact.deployment?.blind_augmentation_for_rich_llm_instructions!==false||artifact.deployment?.stop_gate_enabled!==false)throw new Error('MedLoCoMo instruction-policy did not pass its held-out deployment gate');
  const sparse=artifact.validation?.production_search_sparse_heldout,rich=artifact.validation?.real_llm_instruction_replay;
  if(!plain(sparse)||Number(sparse.case_count)!==516||Number(sparse.activation_count)<1||!plain(rich)||Number(rich.case_count)!==102||Number(rich.activation_count)<1)throw new Error('MedLoCoMo instruction-policy is missing production Search deployment evidence');
  for(const report of[sparse,rich]){
    const cases=Number(report.case_count);
    if(Number(report.embedding_completed_count)!==cases||Number(report.embedding_contract_match_count)!==cases||Number(report.embedding_failed_count)!==0||Number(report.pairwise_completed_count)!==cases||Number(report.pairwise_applied_nonempty_count)<1||Number(report.pairwise_failed_count)!==0)throw new Error('MedLoCoMo instruction-policy production retrieval stack was not fully exercised');
    for(const key of['exact_turn_recall_at_24','all_exact_turns_at_24','evidence_admission_recall_at_24','all_evidence_admissions_at_24']){
      const before=Number(report.baseline?.[key]),after=Number(report.learned?.[key]),delta=Number(report.delta?.[key]);if(!Number.isFinite(before)||!Number.isFinite(after)||!Number.isFinite(delta)||Math.abs((after-before)-delta)>2e-6||delta<0)throw new Error(`MedLoCoMo instruction-policy production gate failed ${key}`);
    }
  }
  const runtime=artifact.validation?.production_runtime_stack,embedding=runtime?.embedding;
  if(runtime?.search_worker!=='createMemoryInvestigationWorkers.search'||runtime?.graph_source!=='frozen_production_sqlite_v1_plus_deterministic_v2_literal_migration'||runtime?.target_memory_version!=='medlocomo-admission-node-completeness-v2-literal-turn-coverage'||runtime?.literal_migration_complete!==true||!SHA256.test(String(runtime?.graph_snapshot_commitment||''))||!SHA256.test(String(runtime?.pairwise_ranker_hash||''))||embedding?.provider!=='local'||embedding?.model!==MEDLOCOMO_EMBEDDING_MODEL||embedding?.model_revision!==MEDLOCOMO_EMBEDDING_MODEL_REVISION||embedding?.model_revision_verification!=='local_snapshot_sha256'||embedding?.base_model!==MEDLOCOMO_EMBEDDING_BASE_MODEL||embedding?.base_model_revision!==MEDLOCOMO_EMBEDDING_BASE_MODEL_REVISION||embedding?.snapshot_hash!==MEDLOCOMO_EMBEDDING_SNAPSHOT_HASH||stableJson(embedding?.snapshot_file_hashes)!==stableJson(MEDLOCOMO_EMBEDDING_SNAPSHOT_FILE_HASHES)||embedding?.dimension!==MEDLOCOMO_EMBEDDING_DIMENSION||embedding?.normalized!==true||embedding?.admission_chunk_turn_count!==MEDLOCOMO_EMBEDDING_CHUNK_TURNS)throw new Error('MedLoCoMo instruction-policy production runtime stack contract is invalid');
  if(Number(sparse.delta.exact_turn_recall_at_24)<=0&&Number(sparse.delta.evidence_admission_recall_at_24)<=0)throw new Error('MedLoCoMo instruction-policy sparse Search did not strictly improve retrieval');
}
function featureValues(row,type){const token=row.token,values=new Map([[0,1],[1,row.relative_position],[2,1-row.relative_position],[3,Math.log1p(token.length)/Math.log(24)],[4,Number(/^\d+(?:\.\d+)?$/u.test(token))],[5,Number(token.includes('-'))],[6,Number(row.surface.length>1&&row.surface===row.surface.toUpperCase())],[7,Number(STOP.has(token))],[8,Number(QUESTION_WORDS.has(token))],[9,Number(TEMPORAL.has(token))],[10,Number(COMPARISON.has(token))],[11,Number(CAUSAL.has(token))],[12,Number(NEGATION.has(token))],[13,Number(token.endsWith('ing'))],[14,Number(token.endsWith('ed'))],[15,Number(token.endsWith('ion'))],[16,Number(token.endsWith('ity'))],[17,Number(token.endsWith('osis'))],[18,Number(token.endsWith('emia'))],[19,Number(token.endsWith('ectomy'))],[20,Number(token.endsWith('therapy'))],[21,Number(token.startsWith('anti'))],[22,Number(token.startsWith('hyper'))],[23,Number(token.startsWith('hypo'))]]),typeIndex=TYPE_INDEX.get(type);if(typeIndex!=null)values.set(24+typeIndex,1);values.set(GENERIC_FEATURE_COUNT+fnv1a(`t:${token}`)%TOKEN_BUCKETS,1);const grams=[...new Set(characterGrams(token))];for(const gram of grams){const index=GENERIC_FEATURE_COUNT+TOKEN_BUCKETS+fnv1a(`g:${gram}`)%CHAR_BUCKETS;values.set(index,(values.get(index)||0)+1/Math.max(1,grams.length));}return[...values].filter(([,value])=>value);}
function questionTokens(value){const matches=[...String(value||'').normalize('NFKC').matchAll(TOKEN)],rows=[],seen=new Set();for(const match of matches){const surface=match[0],token=surface.toLowerCase();if(token.length<2||seen.has(token))continue;seen.add(token);rows.push({surface,token,position:rows.length});}const denominator=Math.max(1,rows.length-1);return rows.map(row=>({...row,relative_position:row.position/denominator}));}
function characterGrams(token){const value=`^${token}$`,out=[];for(let index=0;index<=value.length-3;index++)out.push(value.slice(index,index+3));return out;}
function fnv1a(value){let hash=2166136261;for(const byte of new TextEncoder().encode(value)){hash^=byte;hash=Math.imul(hash,16777619)>>>0;}return hash>>>0;}
function resolveArtifact(value){const artifact=value?.artifact||value;validateMedLoCoMoInstructionPolicyArtifact(artifact,{allow_pending:value?.pending_allowed===true});return artifact;}
function assertSafeAggregate(value,path='artifact'){if(Array.isArray(value)){for(let index=0;index<value.length;index++)assertSafeAggregate(value[index],`${path}[${index}]`);return;}if(!plain(value))return;for(const[key,child]of Object.entries(value)){if(FORBIDDEN_KEYS.has(key))throw new Error(`MedLoCoMo instruction-policy retains forbidden field ${path}.${key}`);assertSafeAggregate(child,`${path}.${key}`);}}
function stableJson(value){if(Array.isArray(value))return`[${value.map(stableJson).join(',')}]`;if(plain(value))return`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;return JSON.stringify(value);}
function sha256(value){return createHash('sha256').update(String(value)).digest('hex');}
function normalize(value){return String(value||'').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu,'');}
function array(value){return Array.isArray(value)?value:[];}
function plain(value){return Boolean(value)&&typeof value==='object'&&!Array.isArray(value);}
function deepFreeze(value){if(!value||typeof value!=='object'||Object.isFrozen(value))return value;for(const child of Object.values(value))deepFreeze(child);return Object.freeze(value);}
