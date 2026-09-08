import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MEDLOCOMO_PAIRWISE_RANKER_DEFAULT_PATH,
  MEDLOCOMO_PAIRWISE_RANKER_VERSION,
  createMedLoCoMoSearchReranker,
  loadMedLoCoMoPairwiseRanker,
  medLoCoMoPairwiseRankerArtifactHash,
  rankMedLoCoMoAdmissionCandidates,
  rankMedLoCoMoTurnCandidates,
  rerankMedLoCoMoSearchRecords,
  scoreMedLoCoMoAdmissionCandidate,
  validateMedLoCoMoDefaultPairwiseRankerArtifact,
  validateMedLoCoMoPairwiseRankerArtifact,
} from '../src/medlocomo-pairwise-ranker.js';
import { createMemoryInvestigationWorkers } from '../src/investigation-workers.js';
import { medLoCoMoInvestigationStrategy } from '../src/prompts.js';
import { MEDLOCOMO_EMBEDDING_BASE_MODEL,MEDLOCOMO_EMBEDDING_BASE_MODEL_REVISION,MEDLOCOMO_EMBEDDING_CHUNK_TURNS,MEDLOCOMO_EMBEDDING_DIMENSION,MEDLOCOMO_EMBEDDING_MODEL,MEDLOCOMO_EMBEDDING_MODEL_REVISION,MEDLOCOMO_EMBEDDING_SNAPSHOT_FILE_HASHES,MEDLOCOMO_EMBEDDING_SNAPSHOT_HASH } from '../src/embedding-retrieval.js';

const TYPES=['adversarial','care_plan_rationale','cross_admission_comparison','frequency_pattern','longitudinal_progression','medical_reasoning'];

test('pairwise ranker artifact is aggregate, hashed, and loadable',()=>{
  const artifact=fixture(),dir=mkdtempSync(join(tmpdir(),'careharness-pairwise-')),path=join(dir,'ranker.json');
  assert.equal(validateMedLoCoMoPairwiseRankerArtifact(artifact),true);
  writeFileSync(path,JSON.stringify(artifact));
  const loaded=loadMedLoCoMoPairwiseRanker({path});
  assert.equal(loaded.artifact.artifact_hash,artifact.artifact_hash);
  assert.equal(Object.isFrozen(loaded),true);
  assert.equal(MEDLOCOMO_PAIRWISE_RANKER_DEFAULT_PATH,'data/medlocomo-hierarchical-distillation/pairwise-rankers-97train-4validation.json');
  const serialized=JSON.stringify(artifact);
  assert.doesNotMatch(serialized,/"(?:patient_id|qa_id|gold_answer|source_ref|turn_ids)":|turn:/u);
});

test('Admission scorer combines the fixed lexical anchor with injected local dense features',async()=>{
  const artifact=fixture(),direct=scoreMedLoCoMoAdmissionCandidate(artifact,{
    question_type:'cross_admission_comparison',
    features:{best_turn_bm25_log:2,dense_admission_centroid_cosine:.5},
  });
  assert.equal(direct.components.anchor,2);
  assert.equal(direct.components.residual,1.5);
  assert.equal(direct.score,3.5);

  const ranked=await rankMedLoCoMoAdmissionCandidates(artifact,{
    question_type:'cross_admission_comparison',
    candidates:[
      {key:'lexical',features:{best_turn_bm25_log:2}},
      {key:'semantic',features:{best_turn_bm25_log:1.5}},
    ],
    dense_similarity:candidate=>({dense_admission_centroid_cosine:candidate.key==='semantic'?1:0}),
  });
  assert.deepEqual(ranked.map(row=>row.candidate.key),['semantic','lexical']);
  await assert.rejects(
    rankMedLoCoMoAdmissionCandidates(artifact,{question_type:'cross_admission_comparison',candidates:[{features:{best_turn_bm25_log:1}}]}),
    /requires local dense features/u,
  );
});

test('Turn scorer applies non-negative learned residuals and preserves stable ties',()=>{
  const artifact=fixture(),ranked=rankMedLoCoMoTurnCandidates(artifact,{
    question_type:'medical_reasoning',
    candidates:[
      {key:'patient',features:{turn_bm25_log:1,doctor_speaker:0}},
      {key:'doctor',features:{turn_bm25_log:1,doctor_speaker:1}},
      {key:'doctor-second',features:{turn_bm25_log:1,doctor_speaker:1}},
    ],
  });
  assert.deepEqual(ranked.map(row=>row.candidate.key),['doctor','doctor-second','patient']);
  assert.equal(ranked[0].components.residual,.5);
});

test('hierarchical Search reranker routes Admissions before ranking Turns and bypasses other namespaces',()=>{
  const artifact=fixture(),nodes=[
    memory('lexical','admission-a','1','Aspirin treatment was continued.','doctor'),
    memory('semantic','admission-b','1','The regimen was changed.','doctor'),
  ],records=nodes.map((node,index)=>({node,score:2-index,reasons:['instruction_term']})),dense=new Map([
    ['admission-a',{dense_admission_centroid_cosine:0,dense_chunk_max_cosine:0,dense_chunk_top2_cosine:0}],
    ['admission-b',{dense_admission_centroid_cosine:1,dense_chunk_max_cosine:1,dense_chunk_top2_cosine:1}],
  ]),request={question:'How did aspirin treatment change?',query_type:'cross_admission_comparison',strategy_namespace:'medlocomo'};
  const ranked=createMedLoCoMoSearchReranker(artifact)({question_request:request,records,memory_nodes:nodes,dense_admission_features:dense});
  assert.equal(ranked.trace.status,'applied');
  assert.equal(ranked.trace.hierarchy[0],'admission');
  assert.deepEqual(ranked.records.map(row=>row.pairwise_admission_rank),[1,2]);
  assert.ok(ranked.records.every(row=>Number.isInteger(row.pairwise_turn_rank)&&Number.isInteger(row.pairwise_turn_rank_within_admission)));
  assert.deepEqual(ranked.records.map(row=>row.node.memory_id),['semantic','lexical']);
  const bypass=rerankMedLoCoMoSearchRecords(artifact,{question_request:{...request,strategy_namespace:'medmemorybench'},records,memory_nodes:nodes,dense_admission_features:dense});
  assert.equal(bypass.trace.status,'skipped_scope');
  assert.deepEqual(bypass.records,records);
});

test('embedding failure uses a validated lexical-only Admission ranker and reports degraded mode',async()=>{
  const artifact=fixture(),nodes=[
    memory('lexical','admission-a','1','Aspirin treatment was continued.','doctor'),
    memory('unrelated','admission-b','1','Unrelated follow-up.','patient'),
  ],request={question:'Was aspirin treatment continued?',task:'medical_reasoning',query_type:'medical_reasoning',strategy_namespace:'medlocomo',scope:'single_admission',strategy_profile:medLoCoMoInvestigationStrategy('medical_reasoning')},reranker=createMedLoCoMoSearchReranker(artifact);let embeddedNodeCount=0;
  const workers=createMemoryInvestigationWorkers({question_request:request,memory_nodes:nodes,candidate_budget:2,search_ranker:reranker,embedding_retriever:async input=>{embeddedNodeCount=input.memory_nodes.length;throw new Error('missing local ONNX');}}),state={snapshot:{memory_nodes:[],memory_edges:[],patient_profile:null,recent_sessions:[],refinement_boundary:{boundary_id:'r1',revision:1,excluded_memory_ids:['unrelated'],temporal:{},permanent:true}}},result=await workers.search.run({state,instruction:{search_terms:['aspirin','follow-up']}});
  assert.equal(embeddedNodeCount,2);
  assert.equal(result.trace.ranker_feature_pool_scope,'complete_question_visible_patient_graph');
  assert.equal(result.trace.embedding.status,'failed_open');
  assert.equal(result.trace.embedding.degraded_to,'validated_lexical_only_ranker');
  assert.equal(result.trace.candidate_reranker.status,'degraded_lexical_fallback');
  assert.equal(result.trace.candidate_reranker.ranking_applied,true);
  assert.equal(result.trace.candidate_reranker.admission_ranker,'admission_lexical_fallback');
  assert.equal(result.trace.ranking_primary,'medlocomo_pairwise_admission_then_turn');
  assert.equal(result.snapshot.memory_nodes[0].memory_id,'lexical');
  assert.equal(result.snapshot.memory_nodes.some(node=>node.memory_id==='unrelated'),false);
});

test('MedLoCoMo retrieval shortlists Admissions and gives near-duplicate fact clusters one slot',async()=>{
  const artifact=fixture(),nodes=[
    memory('a-1','admission-a','1','Aspirin treatment detail one.','doctor'),
    memory('a-2','admission-a','2','Aspirin treatment detail two.','doctor'),
    memory('a-3','admission-a','3','Aspirin treatment detail three.','doctor'),
    memory('a-4','admission-a','4','Aspirin treatment detail four.','doctor'),
    memory('b-1','admission-b','1','Aspirin treatment later changed.','doctor'),
    memory('b-2','admission-b','2','Aspirin treatment follow-up.','patient'),
    memory('c-1','admission-c','1','Aspirin was mentioned incidentally.','patient'),
  ],dense=new Map([
    ['admission-a',{dense_admission_centroid_cosine:1,dense_chunk_max_cosine:1,dense_chunk_top2_cosine:1}],
    ['admission-b',{dense_admission_centroid_cosine:.4,dense_chunk_max_cosine:.4,dense_chunk_top2_cosine:.4}],
    ['admission-c',{dense_admission_centroid_cosine:.2,dense_chunk_max_cosine:.2,dense_chunk_top2_cosine:.2}],
  ]),questionType='longitudinal_progression',makeRequest=scope=>({question:'How did aspirin treatment progress?',task:questionType,query_type:questionType,strategy_namespace:'medlocomo',scope,strategy_profile:medLoCoMoInvestigationStrategy(questionType)}),reranker=createMedLoCoMoSearchReranker(artifact),embedding_retriever=async()=>({scores:new Map(nodes.map(node=>[node.memory_id,.5])),admission_features:dense,trace:{status:'completed'}}),state={snapshot:{memory_nodes:[],memory_edges:[],patient_profile:null,recent_sessions:[]}};
  const crossWorkers=createMemoryInvestigationWorkers({question_request:makeRequest('cross_admission'),memory_nodes:nodes,candidate_budget:4,search_ranker:reranker,embedding_retriever}),cross=await crossWorkers.search.run({state,instruction:{search_terms:['aspirin']}});
  assert.equal(cross.trace.selection_mode,'medlocomo_cross_admission_shortlist_then_turn');
  assert.equal(cross.trace.cross_admission_selection.admission_shortlist_limit,2);
  assert.equal(cross.trace.cross_admission_selection.one_turn_quota_per_admission,true);
  assert.deepEqual(new Set(cross.snapshot.memory_nodes.slice(0,2).map(node=>node.episode_id)),new Set(['admission-a','admission-b']));
  assert.equal(cross.snapshot.memory_nodes.some(node=>node.episode_id==='admission-c'),false);

  const singleWorkers=createMemoryInvestigationWorkers({question_request:makeRequest('single_admission'),memory_nodes:nodes,candidate_budget:4,search_ranker:reranker,embedding_retriever}),single=await singleWorkers.search.run({state,instruction:{search_terms:['aspirin']}});
  assert.equal(single.trace.selection_mode,'policy_instruction_hybrid_lexical_embedding');
  assert.deepEqual(single.snapshot.memory_nodes.slice(0,2).map(node=>node.episode_id),['admission-a','admission-b']);
  assert.ok(single.trace.fact_clusters.some(cluster=>cluster.source_memory_ids.length>1));
  assert.equal(single.trace.ranking_primary,'medlocomo_pairwise_admission_then_turn');
});

test('MedLoCoMo Search writes the pairwise order into Investigation State without touching generic Search',async()=>{
  const artifact=fixture(),nodes=[
    memory('lexical','admission-a','1','Aspirin treatment was continued.','doctor'),
    memory('semantic','admission-b','1','The regimen was changed.','doctor'),
  ],dense=new Map([
    ['admission-a',{dense_admission_centroid_cosine:0,dense_chunk_max_cosine:0,dense_chunk_top2_cosine:0}],
    ['admission-b',{dense_admission_centroid_cosine:1,dense_chunk_max_cosine:1,dense_chunk_top2_cosine:1}],
  ]),questionType='cross_admission_comparison',request={question:'How did aspirin treatment change?',task:questionType,query_type:questionType,strategy_namespace:'medlocomo',strategy_profile:medLoCoMoInvestigationStrategy(questionType)},reranker=createMedLoCoMoSearchReranker(artifact);
  const workers=createMemoryInvestigationWorkers({question_request:request,memory_nodes:nodes,candidate_budget:2,search_ranker:reranker,embedding_retriever:async()=>({scores:new Map(nodes.map(node=>[node.memory_id,.5])),admission_features:dense,trace:{status:'completed'}})}),state={snapshot:{memory_nodes:[],memory_edges:[],patient_profile:null,recent_sessions:[]}},result=await workers.search.run({state,instruction:{search_terms:['aspirin','regimen']}});
  assert.deepEqual(result.snapshot.memory_nodes.map(node=>node.memory_id),['semantic','lexical']);
  assert.equal(result.trace.candidate_reranker.status,'applied');
  assert.equal(result.trace.ranking_primary,'medlocomo_pairwise_admission_then_turn');

  let genericCalls=0;
  const generic=createMemoryInvestigationWorkers({question_request:{question:'Find aspirin'},memory_nodes:nodes,candidate_budget:2,search_ranker:input=>{genericCalls++;return reranker(input);}}),genericResult=await generic.search.run({state,instruction:{search_terms:['aspirin']}});
  assert.equal(genericCalls,0);
  assert.deepEqual(genericResult.snapshot.memory_nodes.map(node=>node.memory_id),['lexical']);
});

test('MedLoCoMo dense ranking embeds only the raw Question while generic Search may include its instruction',async()=>{
  const node=memory('m','admission-a','1','Aspirin was continued.','doctor'),queries=[],embedding_retriever=async input=>{queries.push(input.query);return{scores:new Map([['m',1]]),admission_features:new Map(),trace:{status:'completed'}};},state={snapshot:{memory_nodes:[],memory_edges:[],patient_profile:null,recent_sessions:[]}},instruction={objective:'LLM objective must stay lexical',search_terms:['aspirin'],expansion_terms:['antiplatelet']};
  const medlocomo=createMemoryInvestigationWorkers({question_request:{question:'Was aspirin continued?',task:'medical_reasoning',query_type:'medical_reasoning',strategy_namespace:'medlocomo',scope:'single_admission',strategy_profile:medLoCoMoInvestigationStrategy('medical_reasoning')},memory_nodes:[node],embedding_retriever});
  await medlocomo.search.run({state,instruction});assert.equal(queries[0],'Was aspirin continued?');assert.doesNotMatch(queries[0],/objective|antiplatelet/iu);
  const generic=createMemoryInvestigationWorkers({question_request:{question:'Was aspirin continued?'},memory_nodes:[node],embedding_retriever});
  await generic.search.run({state,instruction});assert.match(queries[1],/LLM objective/iu);assert.match(queries[1],/antiplatelet/iu);
});

test('artifact validator rejects case identifiers, negative residuals, and tampering',()=>{
  const unsafe=fixture();unsafe.patient_id='12345678';unsafe.artifact_hash=medLoCoMoPairwiseRankerArtifactHash(unsafe);
  assert.throws(()=>validateMedLoCoMoPairwiseRankerArtifact(unsafe),/forbidden field patient_id/u);
  const negative=fixture();negative.models.turn.parameters_by_question_type.adversarial.residual_coefficients.doctor_speaker=-1;negative.artifact_hash=medLoCoMoPairwiseRankerArtifactHash(negative);
  assert.throws(()=>validateMedLoCoMoPairwiseRankerArtifact(negative),/must be non-negative/u);
  const tampered=fixture();tampered.models.turn.anchor_coefficients.turn_bm25_log=2;
  assert.throws(()=>validateMedLoCoMoPairwiseRankerArtifact(tampered),/hash mismatch/u);
  const featureMismatch=fixture();featureMismatch.feature_contract.dense_embedding_query='llm_expanded_query';featureMismatch.artifact_hash=medLoCoMoPairwiseRankerArtifactHash(featureMismatch);
  assert.throws(()=>validateMedLoCoMoPairwiseRankerArtifact(featureMismatch),/feature contract does not match runtime/u);
  const chunkMismatch=fixture();chunkMismatch.embedding.admission_chunk_turn_count=8;chunkMismatch.artifact_hash=medLoCoMoPairwiseRankerArtifactHash(chunkMismatch);
  assert.throws(()=>validateMedLoCoMoPairwiseRankerArtifact(chunkMismatch),/embedding contract does not match runtime/u);
  for(const [field,value] of [['model','other/model'],['model_revision','main'],['model_revision_verification','declared_only'],['base_model','other/base'],['base_model_revision','main'],['revision','main'],['snapshot_hash','0'.repeat(64)],['dimension',768]]){
    const mismatch=fixture();mismatch.embedding[field]=value;mismatch.artifact_hash=medLoCoMoPairwiseRankerArtifactHash(mismatch);
    assert.throws(()=>validateMedLoCoMoPairwiseRankerArtifact(mismatch),/embedding contract does not match runtime/u,field);
  }
  const snapshotFileMismatch=fixture();snapshotFileMismatch.embedding.snapshot_file_hashes={'config.json':'0'.repeat(64)};snapshotFileMismatch.artifact_hash=medLoCoMoPairwiseRankerArtifactHash(snapshotFileMismatch);
  assert.throws(()=>validateMedLoCoMoPairwiseRankerArtifact(snapshotFileMismatch),/embedding contract does not match runtime/u);
  const transductive=fixture();transductive.split.serialized_coefficients_match_fixed_validation_model=false;transductive.split.final_refit={enabled:true,validation_patients_included:true,valid_for_held_out_claims:false};transductive.artifact_hash=medLoCoMoPairwiseRankerArtifactHash(transductive);
  assert.equal(validateMedLoCoMoPairwiseRankerArtifact(transductive),true);
});

test('default runtime artifact boundary accepts only the committed fixed 97/4 pre-refit split',()=>{
  const artifact=fixture();
  artifact.split.train_set_commitment='7144b5b71ac2f1284c406174215cb1fae0a3ccbc3b480d13812fd4782b20f999';
  artifact.split.validation_set_commitment='166669200359c91649418b44453686a9a0a867e2e622001e4cc8666b81393912';
  assert.doesNotThrow(()=>validateMedLoCoMoDefaultPairwiseRankerArtifact(artifact));
  artifact.split.final_refit={enabled:true,validation_patients_included:true,valid_for_held_out_claims:false};
  artifact.split.serialized_coefficients_match_fixed_validation_model=false;
  assert.throws(()=>validateMedLoCoMoDefaultPairwiseRankerArtifact(artifact),/fixed 97\/4 patient-disjoint pre-refit/u);
});

function fixture(){
  const parameters=Object.fromEntries(TYPES.map(type=>[type,{l2:.1,residual_gain:type==='cross_admission_comparison'?1:0,residual_coefficients:{dense_admission_centroid_cosine:type==='cross_admission_comparison'?3:0}}]));
  const turnParameters=Object.fromEntries(TYPES.map(type=>[type,{l2:.1,residual_gain:type==='medical_reasoning'?1:0,residual_coefficients:{doctor_speaker:type==='medical_reasoning'?.5:0}}]));
  const core={
    version:MEDLOCOMO_PAIRWISE_RANKER_VERSION,
    benchmark:'medlocomo',runtime_eligible:true,status:'offline_validated_not_wired',
    feature_contract:{lexical_document_frequency_scope:'complete_question_visible_patient_admissions',average_length_scope:'complete_question_visible_patient_admissions_and_turns',dense_embedding_query:'raw_question_nfkc_trimmed_only',admission_chunk_order:'numeric_turn_id_then_event_time_then_source_order',admission_time_source:'first_and_last_visible_source_turn',admission_chunk_turn_count:6,embedding_failure_behavior:'validated_lexical_only_ranker'},
    embedding:{provider:'local',model:MEDLOCOMO_EMBEDDING_MODEL,model_revision:MEDLOCOMO_EMBEDDING_MODEL_REVISION,model_revision_verification:'local_snapshot_sha256',base_model:MEDLOCOMO_EMBEDDING_BASE_MODEL,base_model_revision:MEDLOCOMO_EMBEDDING_BASE_MODEL_REVISION,revision:MEDLOCOMO_EMBEDDING_BASE_MODEL_REVISION,snapshot_hash:MEDLOCOMO_EMBEDDING_SNAPSHOT_HASH,snapshot_file_hashes:MEDLOCOMO_EMBEDDING_SNAPSHOT_FILE_HASHES,pooling:'mean',normalized:true,dtype:'fp32',dimension:MEDLOCOMO_EMBEDDING_DIMENSION,admission_chunk_turn_count:MEDLOCOMO_EMBEDDING_CHUNK_TURNS,training_chunk_count:100,runtime_contract:'precompute normalized chunk vectors and inject three cosine features'},
    split:{method:'patient_disjoint',train_patient_count:97,validation_patient_count:4,train_set_commitment:'a'.repeat(64),validation_set_commitment:'b'.repeat(64),serialized_coefficients_match_fixed_validation_model:true,final_refit:{enabled:false,validation_patients_included:false,valid_for_held_out_claims:true}},
    training_boundary:{official_admission_labels_used:true,official_exact_turn_labels_used:true,same_patient_hard_negatives_used:true,retains_patient_ids:false,retains_qa_ids:false,retains_question_text:false,retains_gold_text:false,retains_evidence_text:false,retains_source_refs:false,retains_case_lookup:false},
    models:{
      admission:{kind:'fixed_lexical_anchor_plus_nonnegative_pairwise_dense_residual',anchor_coefficients:{best_turn_bm25_log:1},required_dense_features:['dense_admission_centroid_cosine'],parameters_by_question_type:parameters},
      admission_lexical_fallback:{kind:'fixed_lexical_anchor_plus_nonnegative_pairwise_residual',anchor_coefficients:{best_turn_bm25_log:1},required_dense_features:[],parameters_by_question_type:Object.fromEntries(TYPES.map(type=>[type,{l2:.1,residual_gain:0,residual_coefficients:{}}]))},
      turn:{kind:'fixed_lexical_anchor_plus_nonnegative_pairwise_residual',anchor_coefficients:{turn_bm25_log:1},required_dense_features:[],parameters_by_question_type:turnParameters},
    },
  };
  return{...core,artifact_hash:medLoCoMoPairwiseRankerArtifactHash(core)};
}
function memory(memory_id,episode_id,turn_id,text,source_type){return{memory_id,observation_id:`o-${memory_id}`,subject_id:'p',episode_id,turn_id,event_time:'2130-01-01',text,source_text:text,source_type,certainty:1,polarity:'affirmed',families:['TM'],status:'active',version:1};}
