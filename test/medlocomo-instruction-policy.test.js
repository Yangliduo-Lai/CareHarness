import test from 'node:test';
import assert from 'node:assert/strict';
import { augmentMedLoCoMoSearchInstruction,medLoCoMoInstructionPolicyArtifactHash,medLoCoMoSearchInstructionPrior,validateMedLoCoMoInstructionPolicyArtifact } from '../src/medlocomo-instruction-policy.js';
import { createMemoryInvestigationWorkers } from '../src/investigation-workers.js';
import { createInvestigationState,policyView } from '../src/investigation-contract.js';
import { MEDLOCOMO_EMBEDDING_BASE_MODEL,MEDLOCOMO_EMBEDDING_BASE_MODEL_REVISION,MEDLOCOMO_EMBEDDING_CHUNK_TURNS,MEDLOCOMO_EMBEDDING_DIMENSION,MEDLOCOMO_EMBEDDING_MODEL,MEDLOCOMO_EMBEDDING_MODEL_REVISION,MEDLOCOMO_EMBEDDING_SNAPSHOT_FILE_HASHES,MEDLOCOMO_EMBEDDING_SNAPSHOT_HASH } from '../src/embedding-retrieval.js';

function artifact(){
  const coefficients=Array(798).fill(0);coefficients[3]=5;
  const report=(case_count,activation_count,delta=0)=>({case_count,activation_count,embedding_completed_count:case_count,embedding_contract_match_count:case_count,embedding_failed_count:0,pairwise_completed_count:case_count,pairwise_applied_nonempty_count:1,pairwise_failed_count:0,baseline:{exact_turn_recall_at_24:.2,all_exact_turns_at_24:.1,evidence_admission_recall_at_24:.3,all_evidence_admissions_at_24:.2},learned:{exact_turn_recall_at_24:.2+delta,all_exact_turns_at_24:.1,evidence_admission_recall_at_24:.3,all_evidence_admissions_at_24:.2},delta:{exact_turn_recall_at_24:delta,all_exact_turns_at_24:0,evidence_admission_recall_at_24:0,all_evidence_admissions_at_24:0}});
  const runtime={search_worker:'createMemoryInvestigationWorkers.search',graph_source:'frozen_production_sqlite_v1_plus_deterministic_v2_literal_migration',target_memory_version:'medlocomo-admission-node-completeness-v2-literal-turn-coverage',literal_migration_complete:true,graph_snapshot_commitment:'d'.repeat(64),pairwise_ranker_hash:'e'.repeat(64),embedding:{provider:'local',model:MEDLOCOMO_EMBEDDING_MODEL,model_revision:MEDLOCOMO_EMBEDDING_MODEL_REVISION,model_revision_verification:'local_snapshot_sha256',base_model:MEDLOCOMO_EMBEDDING_BASE_MODEL,base_model_revision:MEDLOCOMO_EMBEDDING_BASE_MODEL_REVISION,snapshot_hash:MEDLOCOMO_EMBEDDING_SNAPSHOT_HASH,snapshot_file_hashes:MEDLOCOMO_EMBEDDING_SNAPSHOT_FILE_HASHES,dimension:MEDLOCOMO_EMBEDDING_DIMENSION,normalized:true,admission_chunk_turn_count:MEDLOCOMO_EMBEDDING_CHUNK_TURNS}};
  const value={version:'medlocomo-instruction-salience.v1-patient-disjoint',benchmark:'medlocomo',status:'offline_validated_runtime_wired',runtime_eligible:true,training_boundary:{teacher_manifest_version:'teacher.v1',teacher_manifest_hash:'a'.repeat(64),official_evidence_used_as_offline_labels:true,runtime_reads_official_evidence:false,runtime_terms_are_copied_only_from_current_question:true,retains_patient_ids:false,retains_qa_ids:false,retains_question_text:false,retains_gold_or_answer_text:false,retains_evidence_text_or_source_refs:false,valid_for_held_out_claims:true},split:{method:'fixed_patient_disjoint_97_train_4_validation',train_patient_count:97,validation_patient_count:4,train_question_count:10,validation_question_count:2,train_set_commitment:'7144b5b71ac2f1284c406174215cb1fae0a3ccbc3b480d13812fd4782b20f999',validation_set_commitment:'166669200359c91649418b44453686a9a0a867e2e622001e4cc8666b81393912',serialized_coefficients_match_validation_model:true,final_refit:false},feature_contract:{candidate_source:'unique_tokens_copied_from_runtime_question',stop_component:'not_trained_no_runtime_gate',max_augmented_terms:2},acceptance:{accepted:true,patient_disjoint:true},deployment:{enabled_by_default:true,mode:'conditional_sparse_or_prior_no_progress_augmentation',blind_augmentation_for_rich_llm_instructions:false,stop_gate_enabled:false},model:{intercept:0,coefficients},validation:{production_search_sparse_heldout:report(516,516,.1),real_llm_instruction_replay:report(102,1,0),production_runtime_stack:runtime}};
  value.artifact_hash=medLoCoMoInstructionPolicyArtifactHash(value);return value;
}

function node(memory_id,text){return{memory_id,subject_id:'medlocomo-fixture',episode_id:'admission-1',turn_id:memory_id,event_time:'2122-01-01',source_type:'doctor',status:'active',families:['PE'],text,source_text:text};}

test('trained MedLoCoMo instruction prior retains no case content and copies only Question spans',()=>{
  const model=artifact();assert.equal(validateMedLoCoMoInstructionPolicyArtifact(model),true);
  const prior=medLoCoMoSearchInstructionPrior(model,{question:'Why was anticoagulation withheld after fever?',question_type:'medical_reasoning'});
  assert.deepEqual(prior.search_terms,['anticoagulation','withheld']);
  assert.equal(prior.stop_prior.status,'not_trained');assert.equal(prior.stop_prior.runtime_gate_applied,false);
  for(const term of prior.search_terms)assert.ok('Why was anticoagulation withheld after fever?'.includes(term));
  assert.doesNotThrow(()=>JSON.stringify(model));
});

test('Search augmentation is bounded, additive, and does not duplicate the LLM direction',()=>{
  const prior={artifact_hash:'a'.repeat(64),search_terms:['anticoagulation','fever'],max_augmented_terms:2,term_source:'literal_runtime_question_spans_only',stop_prior:{status:'not_trained',runtime_gate_applied:false}},result=augmentMedLoCoMoSearchInstruction({search_terms:['anticoagulation'],temporal:{operator:'latest'}},prior);
  assert.deepEqual(result.instruction.search_terms,['anticoagulation']);assert.deepEqual(result.instruction.expansion_terms,['fever']);assert.deepEqual(result.instruction.temporal,{operator:'latest'});assert.deepEqual(result.trace.added_terms,['fever']);
});

test('the Action Policy can inspect the learned term prior without receiving teacher content',()=>{
  const prior={version:'medlocomo-runtime-search-instruction-prior.v1',artifact_hash:'a'.repeat(64),question_type:'medical_reasoning',search_terms:['anticoagulation'],ranked_terms:[{term:'anticoagulation',rank:1,score:.8}],term_source:'literal_runtime_question_spans_only',max_augmented_terms:1,stop_prior:{status:'not_trained',runtime_gate_applied:false}},state=createInvestigationState({request:{question:'Why was anticoagulation withheld?',query_type:'medical_reasoning',strategy_namespace:'medlocomo',scope:'single_admission'},snapshot:{search_instruction_prior:prior}}),view=policyView(state,{allowed_workers:['search'],worker_capabilities:{search:{}},remaining_budget:4});
  assert.deepEqual(view.current_information.search_instruction_prior,prior);assert.equal(JSON.stringify(prior).includes('gold'),false);assert.equal(JSON.stringify(prior).includes('source_ref'),false);
});

test('a rejected default artifact is traceable but never mutates Search',()=>{
  const rejected={version:'medlocomo-runtime-search-instruction-prior.v1',status:'rejected',artifact_hash:null,search_terms:[],rejection_reason:'held-out deployment gate failed',stop_prior:{status:'not_trained',runtime_gate_applied:false}},result=augmentMedLoCoMoSearchInstruction({search_terms:['anticoagulation']},rejected);
  assert.deepEqual(result.instruction,{search_terms:['anticoagulation']});assert.equal(result.trace.status,'rejected');assert.match(result.trace.rejection_reason,/deployment gate/u);
});

test('production MedLoCoMo Search consumes learned terms and changes the recalled State',async()=>{
  const request={question:'Why was antibiotic treatment withheld despite cough?',query_type:'medical_reasoning',strategy_namespace:'medlocomo',scope:'single_admission'},nodes=[node('target','Antibiotic treatment was withheld while cultures were pending despite cough.'),node('distractor','Routine physical therapy continued.')],state={snapshot:{memory_nodes:[],memory_edges:[]}},instruction={search_terms:['routine']};
  const baselineWorkers=createMemoryInvestigationWorkers({question_request:request,memory_nodes:nodes,candidate_budget:2,search_instruction_prior:null}),baseline=await baselineWorkers.search.run({state,instruction});
  const learnedPrior={artifact_hash:'d'.repeat(64),search_terms:['antibiotic','cough'],max_augmented_terms:2,term_source:'literal_runtime_question_spans_only',stop_prior:{status:'not_trained',runtime_gate_applied:false}},learnedWorkers=createMemoryInvestigationWorkers({question_request:request,memory_nodes:nodes,candidate_budget:2,search_instruction_prior:learnedPrior}),learned=await learnedWorkers.search.run({state,instruction});
  assert.deepEqual(baseline.snapshot.memory_nodes.map(item=>item.memory_id),['distractor']);
  assert.deepEqual(learned.snapshot.memory_nodes.map(item=>item.memory_id),['target','distractor']);
  assert.deepEqual(learned.trace.learned_instruction_prior.added_terms,['antibiotic','cough']);
  assert.deepEqual(learned.trace.effective_instruction.expansion_terms,['antibiotic','cough']);
});

test('the same prior is ignored outside the MedLoCoMo namespace',async()=>{
  const nodes=[node('target','Antibiotic treatment was withheld.'),node('distractor','Routine physical therapy continued.')],workers=createMemoryInvestigationWorkers({question_request:{question:'Q',strategy_namespace:'medmemorybench'},memory_nodes:nodes,candidate_budget:2,search_instruction_prior:{search_terms:['antibiotic'],max_augmented_terms:1}}),result=await workers.search.run({state:{snapshot:{memory_nodes:[],memory_edges:[]}},instruction:{search_terms:['routine']}});
  assert.deepEqual(result.snapshot.memory_nodes.map(item=>item.memory_id),['distractor']);assert.equal(result.trace.learned_instruction_prior.status,'skipped_scope');
});
