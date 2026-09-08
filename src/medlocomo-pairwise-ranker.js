import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  MEDLOCOMO_EMBEDDING_BASE_MODEL,
  MEDLOCOMO_EMBEDDING_BASE_MODEL_REVISION,
  MEDLOCOMO_EMBEDDING_CHUNK_TURNS,
  MEDLOCOMO_EMBEDDING_DIMENSION,
  MEDLOCOMO_EMBEDDING_MODEL,
  MEDLOCOMO_EMBEDDING_MODEL_REVISION,
  MEDLOCOMO_EMBEDDING_SNAPSHOT_FILE_HASHES,
  MEDLOCOMO_EMBEDDING_SNAPSHOT_HASH,
} from './embedding-retrieval.js';

export const MEDLOCOMO_PAIRWISE_RANKER_VERSION='medlocomo-pairwise-rankers.v3-runtime-feature-aligned-with-lexical-fallback';
export const MEDLOCOMO_PAIRWISE_RANKER_DEFAULT_PATH='data/medlocomo-hierarchical-distillation/pairwise-rankers-97train-4validation.json';
const DEFAULT_TRAIN_COMMITMENT='7144b5b71ac2f1284c406174215cb1fae0a3ccbc3b480d13812fd4782b20f999';
const DEFAULT_VALIDATION_COMMITMENT='166669200359c91649418b44453686a9a0a867e2e622001e4cc8666b81393912';

const QUESTION_TYPES=Object.freeze([
  'adversarial','care_plan_rationale','cross_admission_comparison',
  'frequency_pattern','longitudinal_progression','medical_reasoning',
]);
const QUESTION_TYPE_SET=new Set(QUESTION_TYPES);
const FORBIDDEN_KEYS=new Set([
  'patient_id','patient_ids','qa_id','qa_ids','question','questions','query','queries',
  'gold','gold_answer','answer','evidence','evidence_text','source_ref','source_refs',
  'turn_id','turn_ids','admission_id','admission_ids','case_lookup','question_lookup',
]);
const SHA256=/^[a-f0-9]{64}$/u;
const TOKEN=/[a-z]+(?:'[a-z]+)?|\d+(?:\.\d+)?/giu;
const DATE=/\b(\d{4}-\d{2}-\d{2})\b/gu;
const EARLY=/\b(initial(?:ly)?|earliest|first|at first|baseline|on presentation)\b/iu;
const LATE=/\b(final(?:ly)?|latest|last|eventually|ultimately|at discharge|outcome)\b/iu;
const NEGATIONS=new Set('no not never none without denied denies negative absent cannot unable unlikely'.split(' '));
const STOP=new Set(('a an the and or of for to in on at by as was were is are be been being with '+
  'from during which what when where why how did does do had has have his her their '+
  'this that these those into after before over time patient hospitalization '+
  'hospitalizations admission admissions across multiple because due while most '+
  'primary main following according record records tell describe explain compare '+
  'between regarding related').split(' '));

/** Load and validate the aggregate, case-free pairwise ranker artifact. */
export function loadMedLoCoMoPairwiseRanker({path=MEDLOCOMO_PAIRWISE_RANKER_DEFAULT_PATH}={}){
  const artifactPath=resolve(path),artifact=JSON.parse(readFileSync(artifactPath,'utf8'));
  validateMedLoCoMoPairwiseRankerArtifact(artifact);
  if(artifactPath===resolve(MEDLOCOMO_PAIRWISE_RANKER_DEFAULT_PATH))validateMedLoCoMoDefaultPairwiseRankerArtifact(artifact);
  return deepFreeze({artifact_path:artifactPath,artifact:structuredClone(artifact)});
}

/** Validate the safety boundary, model schema, and deterministic artifact hash. */
export function validateMedLoCoMoPairwiseRankerArtifact(artifact){
  if(!plain(artifact)||artifact.version!==MEDLOCOMO_PAIRWISE_RANKER_VERSION||artifact.benchmark!=='medlocomo')throw new Error('Unsupported MedLoCoMo pairwise ranker artifact');
  if(artifact.runtime_eligible!==true||!['offline_validated_not_wired','offline_validated_runtime_wired'].includes(artifact.status))throw new Error('MedLoCoMo pairwise ranker artifact has an invalid runtime boundary');
  assertSafeAggregate(artifact);
  const boundary=object(artifact.training_boundary,'training_boundary');
  for(const key of ['retains_patient_ids','retains_qa_ids','retains_question_text','retains_gold_text','retains_evidence_text','retains_source_refs','retains_case_lookup'])if(boundary[key]!==false)throw new Error(`MedLoCoMo pairwise ranker training_boundary.${key} must be false`);
  if(boundary.official_admission_labels_used!==true||boundary.official_exact_turn_labels_used!==true||boundary.same_patient_hard_negatives_used!==true)throw new Error('MedLoCoMo pairwise ranker must disclose its supervised labels and hard negatives');
  const split=object(artifact.split,'split');
  if(split.method!=='patient_disjoint'||!positive(split.train_patient_count)||!positive(split.validation_patient_count)||!SHA256.test(String(split.train_set_commitment||''))||!SHA256.test(String(split.validation_set_commitment||'')))throw new Error('MedLoCoMo pairwise ranker split is invalid');
  const contract=object(artifact.feature_contract,'feature_contract');
  if(contract.lexical_document_frequency_scope!=='complete_question_visible_patient_admissions'||contract.average_length_scope!=='complete_question_visible_patient_admissions_and_turns'||contract.dense_embedding_query!=='raw_question_nfkc_trimmed_only'||contract.admission_chunk_order!=='numeric_turn_id_then_event_time_then_source_order'||contract.admission_time_source!=='first_and_last_visible_source_turn'||contract.admission_chunk_turn_count!==MEDLOCOMO_EMBEDDING_CHUNK_TURNS||contract.embedding_failure_behavior!=='validated_lexical_only_ranker')throw new Error('MedLoCoMo pairwise ranker feature contract does not match runtime');
  const embedding=object(artifact.embedding,'embedding');
  if(embedding.provider!=='local'||embedding.model!==MEDLOCOMO_EMBEDDING_MODEL||embedding.model_revision!==MEDLOCOMO_EMBEDDING_MODEL_REVISION||embedding.model_revision_verification!=='local_snapshot_sha256'||embedding.base_model!==MEDLOCOMO_EMBEDDING_BASE_MODEL||embedding.base_model_revision!==MEDLOCOMO_EMBEDDING_BASE_MODEL_REVISION||embedding.revision!==MEDLOCOMO_EMBEDDING_BASE_MODEL_REVISION||embedding.snapshot_hash!==MEDLOCOMO_EMBEDDING_SNAPSHOT_HASH||stableJson(embedding.snapshot_file_hashes)!==stableJson(MEDLOCOMO_EMBEDDING_SNAPSHOT_FILE_HASHES)||embedding.pooling!=='mean'||embedding.normalized!==true||embedding.dtype!=='fp32'||embedding.dimension!==MEDLOCOMO_EMBEDDING_DIMENSION||embedding.admission_chunk_turn_count!==MEDLOCOMO_EMBEDDING_CHUNK_TURNS||embedding.admission_chunk_turn_count!==contract.admission_chunk_turn_count)throw new Error('MedLoCoMo pairwise ranker embedding contract does not match runtime');
  const finalRefit=object(split.final_refit,'split.final_refit'),matchesValidation=split.serialized_coefficients_match_fixed_validation_model===true;
  if(finalRefit.validation_patients_included===true&&finalRefit.valid_for_held_out_claims!==false)throw new Error('A transductive MedLoCoMo pairwise ranker cannot support held-out claims');
  if(matchesValidation&&(finalRefit.enabled!==false||finalRefit.validation_patients_included!==false||finalRefit.valid_for_held_out_claims!==true))throw new Error('MedLoCoMo fixed-validation coefficient boundary is inconsistent');
  if(!matchesValidation&&finalRefit.enabled!==true)throw new Error('MedLoCoMo serialized coefficients must disclose whether they match fixed validation');
  validateRanker(artifact.models?.admission,'admission');validateRanker(artifact.models?.admission_lexical_fallback,'admission lexical fallback');validateRanker(artifact.models?.turn,'turn');
  const body=structuredClone(artifact);delete body.artifact_hash;
  if(!SHA256.test(String(artifact.artifact_hash||''))||sha256(stableJson(body))!==artifact.artifact_hash)throw new Error('MedLoCoMo pairwise ranker artifact hash mismatch');
  return true;
}

/** Compute the content hash used by generated artifacts (excluding artifact_hash). */
export function medLoCoMoPairwiseRankerArtifactHash(value){
  const body=structuredClone(value);delete body.artifact_hash;return sha256(stableJson(body));
}

export function validateMedLoCoMoDefaultPairwiseRankerArtifact(artifact){
  const split=artifact.split||{},refit=split.final_refit||{};
  if(split.train_patient_count!==97||split.validation_patient_count!==4||split.train_set_commitment!==DEFAULT_TRAIN_COMMITMENT||split.validation_set_commitment!==DEFAULT_VALIDATION_COMMITMENT||split.serialized_coefficients_match_fixed_validation_model!==true||refit.enabled!==false||refit.validation_patients_included!==false||refit.valid_for_held_out_claims!==true)throw new Error('Default MedLoCoMo pairwise artifact must be the fixed 97/4 patient-disjoint pre-refit model');
}

/**
 * Score one Admission from already-computed, query/candidate-local features.
 * Dense values can be supplied in `features` or by the batch callback below.
 */
export function scoreMedLoCoMoAdmissionCandidate(loaded,{question_type,features}={}){
  return scoreCandidate(resolveArtifact(loaded),question_type,features,'admission');
}

/** Score one Turn from already-computed, query/candidate-local features. */
export function scoreMedLoCoMoTurnCandidate(loaded,{question_type,features}={}){
  return scoreCandidate(resolveArtifact(loaded),question_type,features,'turn');
}

/**
 * Rank Admission candidates. `dense_similarity` is an optional local embedding
 * callback: `(candidate) => {dense_chunk_max_cosine, ...}` (sync or async).
 * It is required only when a candidate does not already contain those features.
 */
export async function rankMedLoCoMoAdmissionCandidates(loaded,{question_type,candidates,dense_similarity}={}){
  const artifact=resolveArtifact(loaded),ranker=rankerFor(artifact,'admission'),rows=array(candidates,'candidates');
  const output=[];
  for(let index=0;index<rows.length;index++){
    const candidate=object(rows[index],`candidate ${index}`),baseFeatures=object(candidate.features,`candidate ${index} features`),missing=ranker.required_dense_features.filter(name=>!finite(baseFeatures[name]));
    let dense={};
    if(missing.length){
      if(typeof dense_similarity!=='function')throw new Error(`Admission candidate ${index} requires local dense features: ${missing.join(', ')}`);
      dense=object(await dense_similarity(candidate),`candidate ${index} dense_similarity result`);
    }
    const features={...baseFeatures,...dense},scored=scoreCandidate(artifact,question_type,features,'admission');
    output.push({candidate,index,score:scored.score,components:scored.components});
  }
  return output.sort((left,right)=>right.score-left.score||left.index-right.index);
}

/** Rank Turn candidates without changing the caller's candidate objects. */
export function rankMedLoCoMoTurnCandidates(loaded,{question_type,candidates}={}){
  const artifact=resolveArtifact(loaded),rows=array(candidates,'candidates');
  return rows.map((row,index)=>{
    const candidate=object(row,`candidate ${index}`),scored=scoreCandidate(artifact,question_type,object(candidate.features,`candidate ${index} features`),'turn');
    return{candidate,index,score:scored.score,components:scored.components};
  }).sort((left,right)=>right.score-left.score||left.index-right.index);
}

/**
 * Build the synchronous callback consumed by the Search worker.  The callback
 * is deliberately scoped to a public MedLoCoMo question type; other benchmark
 * namespaces are returned byte-for-byte in their original order.
 */
export function createMedLoCoMoSearchReranker(loaded){
  const artifact=resolveArtifact(loaded);
  return input=>rerankMedLoCoMoSearchRecords(artifact,input);
}

/**
 * Apply the learned Admission router first and the Turn ranker second to the
 * concrete Search candidates that will become Investigation State.  Runtime
 * lexical features are computed solely from the visible question and the
 * complete question-visible patient Memory Graph. Dense Admission features
 * come from the local embedding callback. If that callback is unavailable or
 * incomplete, a separately trained lexical-only Admission ranker is used.
 */
export function rerankMedLoCoMoSearchRecords(loaded,{question_request,records,memory_nodes,semantic_scores,dense_admission_features}={}){
  const artifact=resolveArtifact(loaded),request=object(question_request,'question_request'),rows=array(records,'records');
  if(request.strategy_namespace!=='medlocomo'||!QUESTION_TYPE_SET.has(String(request.query_type||'')))return{records:[...rows],trace:{version:'medlocomo-pairwise-search.v1',status:'skipped_scope'}};
  if(!rows.length)return{records:[],trace:{version:'medlocomo-pairwise-search.v1',status:'skipped_empty'}};
  const features=runtimeFeatures({question:String(request.question||''),memoryNodes:array(memory_nodes,'memory_nodes'),semanticScores:semantic_scores,denseAdmissionFeatures:dense_admission_features});
  const qtype=String(request.query_type),admissionRanker=features.denseSource==='local_embedding_admission_chunks'?'admission':'admission_lexical_fallback',degraded=admissionRanker==='admission_lexical_fallback',scoredRows=rows.map((record,index)=>{
    const value=object(record,`record ${index}`),node=object(value.node,`record ${index} node`),episode=episodeKey(node),turn=turnKey(node),admissionFeatures=features.admission.get(episode),turnFeatures=features.turn.get(turn)||features.turnByMemory.get(String(node.memory_id||''));
    if(!admissionFeatures||!turnFeatures)return{...value,pairwise_original_index:index,pairwise_admission_score:-Infinity,pairwise_turn_score:-Infinity};
    const admission=scoreResolved(artifact,qtype,admissionFeatures,admissionRanker),turnScore=scoreResolved(artifact,qtype,turnFeatures,'turn');
    return{...value,pairwise_original_index:index,pairwise_admission_score:admission.score,pairwise_turn_score:turnScore.score,pairwise_components:{admission:admission.components,turn:turnScore.components}};
  }),admissionRanks=rankAdmissions(scoredRows),globalTurnRanks=rankTurns(scoredRows),withinAdmissionTurnRanks=rankTurnsWithinAdmissions(scoredRows),scored=scoredRows.map(record=>({...record,pairwise_admission_rank:admissionRanks.get(episodeKey(record.node)),pairwise_turn_rank:globalTurnRanks.get(record),pairwise_turn_rank_within_admission:withinAdmissionTurnRanks.get(record)})).sort(comparePairwiseRecord).map((record,index)=>({...record,pairwise_rank:index+1}));
  return{records:scored,trace:{version:'medlocomo-pairwise-search.v3-explicit-degraded-mode',status:degraded?'degraded_lexical_fallback':'applied',ranking_applied:true,artifact_hash:artifact.artifact_hash,question_type:qtype,hierarchy:['admission','turn','existing_search_score'],admission_ranker:admissionRanker,ranking_fields:{admission:'pairwise_admission_rank',turn_global:'pairwise_turn_rank',turn_within_admission:'pairwise_turn_rank_within_admission'},candidate_count:scored.length,admission_count:new Set(scored.map(row=>episodeKey(row.node))).size,dense_source:features.denseSource,runtime_feature_pool_scope:'complete_question_visible_patient_graph',runtime_idf_scope:'complete_question_visible_patient_admissions'}};
}

function scoreCandidate(artifact,questionType,features,kind){
  return scoreResolved(resolveArtifact(artifact),questionType,features,kind);
}
function scoreResolved(artifact,questionType,features,kind){
  const ranker=rankerFor(artifact,kind),type=requiredQuestionType(questionType),values=object(features,'features'),parameters=object(ranker.parameters_by_question_type?.[type],`${kind} parameters for ${type}`);
  const anchor=dot(ranker.anchor_coefficients,values,`${kind} anchor`),residual=dot(parameters.residual_coefficients,values,`${kind} residual`),score=anchor+residual;
  return deepFreeze({score,components:{anchor,residual},question_type:type,ranker:kind});
}

function runtimeFeatures({question,memoryNodes,denseAdmissionFeatures}){
  const qinfo=questionInfo(question),turnRows=visibleTurns(memoryNodes),admissions=groupAdmissions(turnRows),idf=localIdf(admissions),averageAdmissionLength=mean([...admissions.values()].map(row=>row.doc.length))||1,averageTurnLength=mean(turnRows.map(row=>row.doc.length))||1,orderedAdmissions=[...admissions.values()].sort(compareAdmissionTime),lastAdmission=Math.max(1,orderedAdmissions.length-1),providedDense=mapLike(denseAdmissionFeatures),denseComplete=orderedAdmissions.length>0&&orderedAdmissions.every(row=>providedDense.has(row.episode)),admission=new Map(),turn=new Map(),turnByMemory=new Map();
  for(let index=0;index<orderedAdmissions.length;index++){
    const row=orderedAdmissions[index],dense=denseComplete?providedDense.get(row.episode):null,feature=admissionFeatureValues(qinfo,row,idf,averageAdmissionLength,averageTurnLength,index/lastAdmission,dense);
    admission.set(row.episode,feature);
  }
  for(const row of orderedAdmissions){
    for(let index=0;index<row.turns.length;index++){
      const source=row.turns[index],local=mergeDocs(row.turns.slice(Math.max(0,index-1),Math.min(row.turns.length,index+2)).map(item=>item.doc)),position=index/Math.max(1,row.turns.length-1),values=turnFeatureValues(qinfo,source,local,idf,averageTurnLength,position);
      turn.set(source.key,values);for(const memoryId of source.memoryIds)turnByMemory.set(memoryId,values);
    }
  }
  return{admission,turn,turnByMemory,denseSource:denseComplete?'local_embedding_admission_chunks':'lexical_only_embedding_unavailable_or_incomplete'};
}

function visibleTurns(nodes){
  const selected=new Map();
  for(let index=0;index<nodes.length;index++){
    const node=nodes[index];if(!plain(node))continue;
    const episode=episodeKey(node),key=turnKey(node,index),text=String(node.source_text||node.text||'').normalize('NFKC').trim();if(!episode||!text)continue;
    const prior=selected.get(key),candidate={key,episode,turnId:String(node.turn_id||''),eventTime:String(node.event_time||''),speaker:String(node.source_type||'').toLowerCase(),text,memoryIds:[String(node.memory_id||'')].filter(Boolean),order:index};
    if(!prior){selected.set(key,candidate);continue;}
    prior.memoryIds.push(...candidate.memoryIds);
    if(text.length>prior.text.length){candidate.memoryIds=[...new Set(prior.memoryIds)];selected.set(key,candidate);}
  }
  return[...selected.values()].map(row=>({...row,memoryIds:[...new Set(row.memoryIds)],doc:document(contentTokens(row.text))})).sort(compareTurnTime);
}
function groupAdmissions(turns){
  const groups=new Map();for(const turn of turns){const row=groups.get(turn.episode)||{episode:turn.episode,turns:[],start:'',end:'',nodeIds:[]};row.turns.push(turn);row.nodeIds.push(...turn.memoryIds);if(turn.eventTime&&(!row.start||turn.eventTime<row.start))row.start=turn.eventTime;if(turn.eventTime&&(!row.end||turn.eventTime>row.end))row.end=turn.eventTime;groups.set(turn.episode,row);}
  for(const row of groups.values()){row.turns.sort(compareTurnTime);row.doc=mergeDocs(row.turns.map(turn=>turn.doc));row.nodeIds=[...new Set(row.nodeIds)];}
  return groups;
}
function localIdf(admissions){
  const frequency=new Map(),count=Math.max(1,admissions.size);for(const admission of admissions.values())for(const token of admission.doc.set)frequency.set(token,(frequency.get(token)||0)+1);
  const values=new Map();for(const[token,hits]of frequency)values.set(token,Math.log(1+(count-hits+.5)/(hits+.5)));values.set('__default__',Math.log(1+(count+.5)/.5));return values;
}
function admissionFeatureValues(q,admission,idf,averageAdmissionLength,averageTurnLength,position,dense){
  const perTurn=admission.turns.map(turn=>({turn,bm25:bm25(q.terms,turn.doc,idf,averageTurnLength),coverage:weightedCoverage(q,turn.doc,idf),cosine:tfidfCosine(q,turn.doc,idf)})),bm25Values=perTurn.map(row=>row.bm25).sort((a,b)=>b-a),best=bm25Values[0]||0,top3=mean(bm25Values.slice(0,3)),doctor=Math.max(0,...perTurn.filter(row=>/doctor|clinician/u.test(row.turn.speaker)).map(row=>row.bm25)),patient=Math.max(0,...perTurn.filter(row=>row.turn.speaker.includes('patient')).map(row=>row.bm25)),dates=q.dates.map(Date.parse).filter(Number.isFinite),start=Date.parse(admission.start),end=Date.parse(admission.end),overlap=dates.length&&Number.isFinite(start)&&Number.isFinite(end)?Number(start<=Math.max(...dates)&&end>=Math.min(...dates)):0,boundary=dates.length&&Number.isFinite(start)&&Number.isFinite(end)?(Number(dates.includes(start))+Number(dates.includes(end)))/2:0;
  return{adm_bm25_log:Math.log1p(bm25(q.terms,admission.doc,idf,averageAdmissionLength)),best_turn_bm25_log:Math.log1p(best),top3_turn_bm25_log:Math.log1p(top3),adm_tfidf_cosine:tfidfCosine(q,admission.doc,idf),best_turn_tfidf_cosine:Math.max(0,...perTurn.map(row=>row.cosine)),adm_idf_query_coverage:weightedCoverage(q,admission.doc,idf),best_turn_idf_query_coverage:Math.max(0,...perTurn.map(row=>row.coverage)),stem_query_coverage:fraction(q.stems,admission.doc.stems),prefix_query_coverage:fraction(q.prefixes,admission.doc.prefixes),query_bigram_coverage:fractionPairs(q.bigrams,admission.doc.bigrams),clinical_number_coverage:fraction(q.numbers,new Set([...admission.doc.set].filter(value=>/^\d/u.test(value)))),explicit_date_interval_overlap:overlap,explicit_date_boundary_match:boundary,doctor_best_bm25_log:Math.log1p(doctor),patient_best_bm25_log:Math.log1p(patient),cue_conditioned_temporal_position:temporalFeature(q,position),negation_coverage:fraction(q.negations,admission.doc.set),log_turn_count:Math.log1p(admission.turns.length),dense_chunk_max_cosine:finiteOrZero(dense?.dense_chunk_max_cosine),dense_chunk_top2_cosine:finiteOrZero(dense?.dense_chunk_top2_cosine),dense_admission_centroid_cosine:finiteOrZero(dense?.dense_admission_centroid_cosine)};
}
function turnFeatureValues(q,turn,local,idf,averageTurnLength,position){const doc=turn.doc,numbers=new Set([...doc.set].filter(value=>/^\d/u.test(value)));return{turn_bm25_log:Math.log1p(bm25(q.terms,doc,idf,averageTurnLength)),turn_tfidf_cosine:tfidfCosine(q,doc,idf),turn_idf_query_coverage:weightedCoverage(q,doc,idf),turn_stem_query_coverage:fraction(q.stems,doc.stems),turn_prefix_query_coverage:fraction(q.prefixes,doc.prefixes),turn_query_bigram_coverage:fractionPairs(q.bigrams,doc.bigrams),turn_clinical_number_coverage:fraction(q.numbers,numbers),local_context_bm25_log:Math.log1p(bm25(q.terms,local,idf,averageTurnLength*3)),local_context_idf_query_coverage:weightedCoverage(q,local,idf),doctor_speaker:Number(/doctor|clinician/u.test(turn.speaker)),patient_speaker:Number(turn.speaker.includes('patient')),cue_conditioned_turn_position:temporalFeature(q,position),negation_coverage:fraction(q.negations,doc.set),log_token_count:Math.log1p(doc.length)};}
function denseFromNodeScores(admission,scores){const values=admission.nodeIds.map(id=>Number(scores.get(id))).filter(Number.isFinite).sort((a,b)=>b-a);return{dense_chunk_max_cosine:values[0]||0,dense_chunk_top2_cosine:mean(values.slice(0,2)),dense_admission_centroid_cosine:mean(values)};}
function questionInfo(text){const raw=tokenize(text),terms=raw.filter(token=>!STOP.has(token)&&(token.length>1||/^\d/u.test(token))),dates=[...String(text||'').matchAll(DATE)].map(match=>match[1]);return{terms,set:new Set(terms),stems:new Set(terms.map(stem)),prefixes:new Set(terms.filter(token=>token.length>=5).map(token=>token.slice(0,5))),bigrams:pairs(terms),numbers:new Set(terms.filter(token=>/^\d/u.test(token)&&token.length<4&&!dates.some(date=>date.includes(token)))),dates,early:EARLY.test(text),late:LATE.test(text),negations:new Set(terms.filter(token=>NEGATIONS.has(token)))};}
function contentTokens(value){return tokenize(value).filter(token=>!STOP.has(token)&&(token.length>1||/^\d/u.test(token)));}
function tokenize(value){return[...String(value||'').toLowerCase().matchAll(TOKEN)].map(match=>match[0]);}
function stem(token){if(/^\d/u.test(token)||token.length<5)return token;if(token.endsWith('ies')&&token.length>5)return token.slice(0,-3)+'y';for(const suffix of['ingly','edly','ing','ed'])if(token.endsWith(suffix)&&token.length>suffix.length+3)return token.slice(0,-suffix.length);if(token.endsWith('es')&&token.length>6)return token.slice(0,-2);if(token.endsWith('s')&&token.length>6&&!/(sis|ous)$/u.test(token))return token.slice(0,-1);return token;}
function document(sequence){const counts=new Map();for(const token of sequence)counts.set(token,(counts.get(token)||0)+1);return{sequence,counts,length:sequence.length,set:new Set(counts.keys()),stems:new Set(sequence.map(stem)),prefixes:new Set(sequence.filter(token=>token.length>=5).map(token=>token.slice(0,5))),bigrams:pairs(sequence)};}
function mergeDocs(docs){return document(docs.flatMap(doc=>doc.sequence));}
function bm25(qterms,doc,idf,averageLength){if(!qterms.length||!doc.length)return 0;const norm=1.2*(1-.72+.72*doc.length/Math.max(1,averageLength));let score=0;for(const term of new Set(qterms)){const frequency=doc.counts.get(term)||0;if(frequency)score+=(idf.get(term)||idf.get('__default__')||1)*frequency*2.2/(frequency+norm);}return score;}
function tfidfCosine(q,doc,idf){if(!q.terms.length||!doc.length)return 0;const query=document(q.terms),fallback=idf.get('__default__')||1;let dotProduct=0,queryNorm=0,docNorm=0;for(const[token,count]of query.counts){const weight=(1+Math.log(count))*(idf.get(token)||fallback),documentWeight=doc.counts.has(token)?(1+Math.log(doc.counts.get(token)))*(idf.get(token)||fallback):0;dotProduct+=weight*documentWeight;queryNorm+=weight*weight;}for(const[token,count]of doc.counts){const weight=(1+Math.log(count))*(idf.get(token)||fallback);docNorm+=weight*weight;}return dotProduct/Math.max(1e-9,Math.sqrt(queryNorm)*Math.sqrt(docNorm));}
function weightedCoverage(q,doc,idf){if(!q.set.size)return 0;const fallback=idf.get('__default__')||1,denominator=[...q.set].reduce((sum,token)=>sum+(idf.get(token)||fallback),0),numerator=[...q.set].reduce((sum,token)=>sum+(doc.set.has(token)?idf.get(token)||fallback:0),0);return numerator/Math.max(1e-9,denominator);}
function temporalFeature(q,position){return q.early&&!q.late?1-position:q.late&&!q.early?position:0;}
function pairs(values){const out=new Set();for(let index=0;index<values.length-1;index++)out.add(`${values[index]}\u0000${values[index+1]}`);return out;}
function fraction(wanted,present){if(!wanted.size)return 0;let hits=0;for(const value of wanted)if(present.has(value))hits++;return hits/wanted.size;}
function fractionPairs(wanted,present){return fraction(wanted,present);}
function rankAdmissions(rows){
  const byEpisode=new Map();for(const row of rows){const episode=episodeKey(row.node),prior=byEpisode.get(episode);if(!prior||comparePairwiseAdmissionRecord(row,prior)<0)byEpisode.set(episode,row);}
  return new Map([...byEpisode.entries()].sort((left,right)=>comparePairwiseAdmissionRecord(left[1],right[1])).map(([episode],index)=>[episode,index+1]));
}
function rankTurnsWithinAdmissions(rows){
  const groups=new Map(),ranks=new Map();for(const row of rows){const episode=episodeKey(row.node),values=groups.get(episode)||[];values.push(row);groups.set(episode,values);}
  for(const values of groups.values()){const local=rankTurns(values);for(const row of values)ranks.set(row,local.get(row));}
  return ranks;
}
function rankTurns(rows){
  const groups=new Map(),ranks=new Map();for(const row of rows){const key=turnKey(row.node,row.pairwise_original_index),values=groups.get(key)||[];values.push(row);groups.set(key,values);}
  const ordered=[...groups.values()].map(values=>[...values].sort(comparePairwiseTurnRecord)).sort((left,right)=>comparePairwiseTurnRecord(left[0],right[0]));
  for(let index=0;index<ordered.length;index++)for(const row of ordered[index])ranks.set(row,index+1);
  return ranks;
}
function comparePairwiseAdmissionRecord(left,right){return compareDescending(left.pairwise_admission_score,right.pairwise_admission_score)||Number(left.pairwise_original_index||0)-Number(right.pairwise_original_index||0);}
function comparePairwiseTurnRecord(left,right){return compareDescending(left.pairwise_turn_score,right.pairwise_turn_score)||compareDescending(left.score,right.score)||compareDescending(left.pairwise_admission_score,right.pairwise_admission_score)||Number(left.pairwise_original_index||0)-Number(right.pairwise_original_index||0);}
function comparePairwiseRecord(left,right){return compareDescending(left.pairwise_admission_score,right.pairwise_admission_score)||compareDescending(left.pairwise_turn_score,right.pairwise_turn_score)||compareDescending(left.score,right.score)||Number(left.pairwise_original_index||0)-Number(right.pairwise_original_index||0);}
function compareDescending(left,right){const a=Number(left),b=Number(right),safeA=Number.isFinite(a)?a:-Infinity,safeB=Number.isFinite(b)?b:-Infinity;return safeA===safeB?0:safeA>safeB?-1:1;}
function compareAdmissionTime(left,right){return Date.parse(left.start||'')-Date.parse(right.start||'')||left.episode.localeCompare(right.episode);}
function compareTurnTime(left,right){const leftNumber=Number(left.turnId),rightNumber=Number(right.turnId);return(Number.isFinite(leftNumber)&&Number.isFinite(rightNumber)?leftNumber-rightNumber:0)||Date.parse(left.eventTime||'')-Date.parse(right.eventTime||'')||left.order-right.order;}
function episodeKey(node){return String(node?.episode_id||node?.observation_id||node?.memory_id||'');}
function turnKey(node,fallback=''){return`${episodeKey(node)}\u0000${String(node?.turn_id||node?.memory_id||fallback)}`;}
function mapLike(value){if(value instanceof Map)return value;if(!value||typeof value!=='object'||Array.isArray(value))return new Map();return new Map(Object.entries(value));}
function mean(values){return values.length?values.reduce((sum,value)=>sum+Number(value||0),0)/values.length:0;}
function finiteOrZero(value){const number=Number(value);return Number.isFinite(number)?number:0;}

function validateRanker(ranker,label){
  const value=object(ranker,`${label} ranker`);
  if(!['fixed_lexical_anchor_plus_nonnegative_pairwise_dense_residual','fixed_lexical_anchor_plus_nonnegative_pairwise_residual'].includes(value.kind))throw new Error(`Unsupported MedLoCoMo ${label} ranker kind`);
  const anchor=weights(value.anchor_coefficients,`${label} anchor_coefficients`);if(!Object.keys(anchor).length)throw new Error(`${label} ranker has no anchor coefficients`);
  const requiredDense=array(value.required_dense_features,`${label} required_dense_features`);for(const name of requiredDense)requiredText(name,`${label} dense feature`);
  const parameters=object(value.parameters_by_question_type,`${label} parameters_by_question_type`);
  if(stableJson(Object.keys(parameters).sort())!==stableJson(QUESTION_TYPES))throw new Error(`${label} ranker must contain exactly the six public question types`);
  for(const type of QUESTION_TYPES){
    const row=object(parameters[type],`${label} ${type}`);nonnegative(row.l2,`${label} ${type} l2`);nonnegative(row.residual_gain,`${label} ${type} residual_gain`);const residual=weights(row.residual_coefficients,`${label} ${type} residual_coefficients`);for(const [name,weight] of Object.entries(residual))if(weight<0)throw new Error(`${label} ${type} residual coefficient ${name} must be non-negative`);
  }
}

function weights(value,label){const out=object(value,label);for(const[name,weight]of Object.entries(out)){requiredText(name,`${label} feature`);finiteNumber(weight,`${label}.${name}`);}return out;}
function dot(coefficients,features,label){let score=0;for(const[name,weight]of Object.entries(coefficients)){const value=finiteNumber(features[name],`${label} feature ${name}`);score+=weight*value;}return score;}
function rankerFor(artifact,kind){return object(artifact.models?.[kind],`${kind} ranker`);}
function resolveArtifact(value){const artifact=value?.artifact||value;validateMedLoCoMoPairwiseRankerArtifact(artifact);return artifact;}
function requiredQuestionType(value){const type=String(value||'');if(!QUESTION_TYPE_SET.has(type))throw new Error(`Unsupported MedLoCoMo question type ${type||'<missing>'}`);return type;}

function assertSafeAggregate(value){
  const stack=[value];
  while(stack.length){const current=stack.pop();if(Array.isArray(current)){stack.push(...current);continue;}if(!plain(current))continue;for(const[key,child]of Object.entries(current)){if(FORBIDDEN_KEYS.has(key))throw new Error(`MedLoCoMo pairwise ranker artifact retained forbidden field ${key}`);if(typeof child==='string'&&(child.startsWith('turn:')||/^\d{8}$/u.test(child)))throw new Error('MedLoCoMo pairwise ranker artifact retained a case-specific identifier');stack.push(child);}}
}
function stableJson(value){if(Array.isArray(value))return`[${value.map(stableJson).join(',')}]`;if(plain(value))return`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;return JSON.stringify(value);}
function sha256(value){return createHash('sha256').update(String(value)).digest('hex');}
function deepFreeze(value){if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.freeze(value);for(const child of Object.values(value))deepFreeze(child);}return value;}
function plain(value){return Boolean(value)&&typeof value==='object'&&!Array.isArray(value);}
function object(value,label){if(!plain(value))throw new Error(`${label} must be an object`);return value;}
function array(value,label){if(!Array.isArray(value))throw new Error(`${label} must be an array`);return value;}
function requiredText(value,label){const text=String(value||'').trim();if(!text)throw new Error(`${label} must be non-empty`);return text;}
function finite(value){return Number.isFinite(Number(value));}
function finiteNumber(value,label){const number=Number(value);if(!Number.isFinite(number))throw new Error(`${label} must be finite`);return number;}
function nonnegative(value,label){const number=finiteNumber(value,label);if(number<0)throw new Error(`${label} must be non-negative`);return number;}
function positive(value){return Number.isInteger(Number(value))&&Number(value)>0;}
