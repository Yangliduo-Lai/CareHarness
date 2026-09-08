#!/usr/bin/env node
/**
 * Patient-disjoint deployment gate for the MedLoCoMo Search-instruction prior.
 *
 * This evaluates the concrete runtime stack: the four frozen validation
 * Memory Graphs in SQLite, the production Search worker, local MiniLM
 * embeddings, and the accepted MedLoCoMo pairwise ranker. The sparse arm
 * supplies a deterministic one-term probe so the conditional gate activates.
 * The rich arm replays the first Search instruction emitted by the live LLM in
 * a completed 102-question experiment. No case content is serialized.
 */
import { createHash } from 'node:crypto';
import { readFileSync,renameSync,writeFileSync } from 'node:fs';
import { dirname,join,resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LocalMiniLmEmbeddingIndex,MEDLOCOMO_EMBEDDING_BASE_MODEL,MEDLOCOMO_EMBEDDING_BASE_MODEL_REVISION,MEDLOCOMO_EMBEDDING_CHUNK_TURNS,MEDLOCOMO_EMBEDDING_DIMENSION,MEDLOCOMO_EMBEDDING_MODEL,MEDLOCOMO_EMBEDDING_MODEL_REVISION,MEDLOCOMO_EMBEDDING_SNAPSHOT_FILE_HASHES,MEDLOCOMO_EMBEDDING_SNAPSHOT_HASH } from '../src/embedding-retrieval.js';
import { createMemoryInvestigationWorkers } from '../src/investigation-workers.js';
import { loadMedLoCoMoValidationGraphs } from '../src/medlocomo-action-validation-graph.js';
import {
  loadMedLoCoMoInstructionPolicy,
  medLoCoMoInstructionPolicyArtifactHash,
  medLoCoMoSearchInstructionPrior,
  validateMedLoCoMoInstructionPolicyArtifact,
} from '../src/medlocomo-instruction-policy.js';
import { createMedLoCoMoSearchReranker,loadMedLoCoMoPairwiseRanker } from '../src/medlocomo-pairwise-ranker.js';

const HOLDOUT=Object.freeze(['10913302','11021643','11441519','11826927']);
const DEFAULT_EXPERIMENT='a4477553-be2f-4ece-9051-92820925f688';
const METRICS=Object.freeze(['exact_turn_recall_at_24','all_exact_turns_at_24','evidence_admission_recall_at_24','all_evidence_admissions_at_24']);
const CONTENT_STOP=new Set('a an the and or of for to in on at by as was were is are be been being with from during which what when where why how did does do had has have his her their this that these those into after before over time patient hospitalization hospitalizations admission admissions across multiple because due while most primary main following according'.split(' '));
const args=parseArgs(process.argv.slice(2));
const teacherRoot=resolve(args.teacher_root||'data/medlocomo-full-distillation');
const artifactPath=resolve(args.artifact||'data/medlocomo-hierarchical-distillation/instruction-policy.json');
const databasePath=resolve(args.database||'data/careharness.sqlite');
const experimentId=String(args.experiment_id||DEFAULT_EXPERIMENT);
const loaded=loadMedLoCoMoInstructionPolicy({path:artifactPath,allow_pending:true});
const pairwise=loadMedLoCoMoPairwiseRanker();
const searchRanker=createMedLoCoMoSearchReranker(pairwise);
const db=new DatabaseSync(databasePath,{readOnly:true});

try{
  const patients=loadValidationTeacher(teacherRoot);
  const expectedTurnRefs=new Map(patients.map(patient=>[patient.patient_id,patient.expected_turn_refs]));
  const graphs=loadMedLoCoMoValidationGraphs(databasePath,HOLDOUT,{migrate_literal_provenance:true,target_memory_version:'medlocomo-admission-node-completeness-v2-literal-turn-coverage',expected_turn_refs_by_patient:expectedTurnRefs});
  const sparse=await replaySparse({loaded,patients,graphs,searchRanker});
  const rich=await replayRich({loaded,patients,graphs,searchRanker,db,experimentId});
  const accepted=passesDeploymentGate(sparse,rich);
  const runtimeStack=runtimeStackReport(graphs,pairwise);
  const report={version:'medlocomo-instruction-production-gate.v1',pending_artifact_hash:loaded.artifact.artifact_hash,patient_disjoint_split:{train_patient_count:97,validation_patient_count:4,validation_question_count:sparse.case_count,train_set_commitment:loaded.artifact.split.train_set_commitment,validation_set_commitment:loaded.artifact.split.validation_set_commitment},runtime_stack:runtimeStack,production_search_sparse_heldout:sparse,real_llm_instruction_replay:rich,accepted};
  if(args.finalize){
    const artifact=structuredClone(loaded.artifact);
    artifact.validation.production_search_sparse_heldout=sparse;
    artifact.validation.real_llm_instruction_replay=rich;
    artifact.validation.production_runtime_stack=runtimeStack;
    artifact.acceptance={...artifact.acceptance,accepted,production_gate_version:report.version};
    artifact.deployment={...artifact.deployment,enabled_by_default:accepted};
    artifact.runtime_eligible=accepted;
    artifact.status=accepted?'offline_validated_runtime_wired':'offline_validated_pending_production_search_ab';
    artifact.artifact_hash=medLoCoMoInstructionPolicyArtifactHash(artifact);
    if(accepted)validateMedLoCoMoInstructionPolicyArtifact(artifact);
    else validateMedLoCoMoInstructionPolicyArtifact(artifact,{allow_pending:true});
    atomicJsonWrite(artifactPath,artifact);
    report.finalized=true;report.deployed_artifact_hash=artifact.artifact_hash;
  }
  process.stdout.write(`${JSON.stringify(report,null,2)}\n`);
  if(args.finalize&&!accepted)process.exitCode=2;
}finally{db.close();}

async function replaySparse({loaded,patients,graphs,searchRanker}){
  const aggregate=blankReport('deterministic_exactly_one_question_term_probe','frozen_validation_graphs');
  for(const patient of patients){
    const graph=graphs.get(patient.patient_id),embedding=new LocalMiniLmEmbeddingIndex();
    for(const item of patient.cases){
      const instruction={search_terms:[firstContentTerm(item.task.question)]};
      await compareOne({aggregate,loaded,graph,item,instruction,embedding,searchRanker});
    }
  }
  return finishReport(aggregate);
}

async function replayRich({loaded,patients,graphs,searchRanker,db,experimentId}){
  const row=db.prepare(`SELECT id,status,config_json,results_json FROM experiments WHERE id=? AND benchmark='medlocomo'`).get(experimentId);
  if(!row||row.status!=='completed')throw new Error(`Completed MedLoCoMo replay experiment not found: ${experimentId}`);
  const config=JSON.parse(row.config_json),patient=patients.find(item=>item.patient_id===String(config.patient_id||''));
  if(!patient)throw new Error('Replay experiment is not in the fixed validation split');
  const graph=graphs.get(patient.patient_id),embedding=new LocalMiniLmEmbeddingIndex(),byId=new Map(patient.cases.map(item=>[String(item.qa_id),item])),results=JSON.parse(row.results_json),aggregate=blankReport('first_live_llm_search_instruction','frozen_validation_graph');
  aggregate.source_experiment_id_hash=sha256(String(row.id));
  aggregate.source_run_commitment=sha256(`${row.config_json}\n${row.results_json}`);
  aggregate.source_graph_fingerprint=graph.fingerprint;
  aggregate.source_result_count=results.filter(item=>item?.kind==='score').length;
  for(const result of results){
    if(result?.kind!=='score')continue;
    const item=byId.get(String(result.score_id||''));if(!item)throw new Error(`Replay result has no teacher case: ${result.score_id}`);
    const turns=result.retrieval_trace?.investigation?.turns||[],searches=turns.map((turn,index)=>({turn,index})).filter(row=>String(row.turn?.decision?.worker||'')==='search');
    if(!searches.length)throw new Error(`Replay result has no live Search instruction: ${result.score_id}`);
    const selected=searches.find(row=>runtimeGateEligible(row.turn.decision.instruction,row.index?turns[row.index-1]?.result?.snapshot:null))||searches[0],stateSnapshot=selected.index?turns[selected.index-1]?.result?.snapshot:null;
    await compareOne({aggregate,loaded,graph,item,instruction:selected.turn.decision.instruction,state_snapshot:stateSnapshot,embedding,searchRanker});
  }
  return finishReport(aggregate);
}

async function compareOne({aggregate,loaded,graph,item,instruction,state_snapshot=null,embedding,searchRanker}){
  const request={question:item.task.question,query_type:item.task.question_type,strategy_namespace:'medlocomo',scope:item.task.scope};
  const prior=medLoCoMoSearchInstructionPrior(loaded,{question:item.task.question,question_type:item.task.question_type});
  const snapshot=state_snapshot&&typeof state_snapshot==='object'?structuredClone(state_snapshot):{memory_nodes:[],memory_edges:[]},run=async searchInstructionPrior=>createMemoryInvestigationWorkers({question_request:request,memory_nodes:graph.nodes,memory_edges:graph.edges,candidate_budget:24,embedding_retriever:input=>embedding.rank(input),search_ranker:searchRanker,search_instruction_prior:searchInstructionPrior}).search.run({state:{snapshot:structuredClone(snapshot)},instruction});
  const baseline=await run(null),learned=await run(prior),official=item.supervision.official_evidence;
  addCoverage(aggregate.baseline,coverage(baseline.snapshot.memory_nodes,official),aggregate);
  addCoverage(aggregate.learned,coverage(learned.snapshot.memory_nodes,official),aggregate);
  aggregate.case_count++;
  if(learned.trace?.learned_instruction_prior?.status==='applied')aggregate.activation_count++;
  if(ids(baseline.snapshot.memory_nodes)!==ids(learned.snapshot.memory_nodes))aggregate.changed_packet_count++;
  const embeddingTraces=[baseline.trace?.embedding,learned.trace?.embedding],pairwiseTraces=[baseline.trace?.candidate_reranker,learned.trace?.candidate_reranker],embeddingCompleted=embeddingTraces.every(trace=>trace?.status==='completed'),embeddingMatched=embeddingTraces.every(matchesEmbeddingContract),pairwiseCompleted=pairwiseTraces.every(trace=>trace?.ranking_applied===true||trace?.status==='skipped_empty');
  aggregate.embedding_completed_count+=Number(embeddingCompleted);aggregate.embedding_contract_match_count+=Number(embeddingMatched);aggregate.embedding_failed_count+=Number(!embeddingCompleted||!embeddingMatched);
  aggregate.pairwise_completed_count+=Number(pairwiseCompleted);aggregate.pairwise_applied_nonempty_count+=Number(pairwiseTraces.some(trace=>trace?.ranking_applied===true));aggregate.pairwise_failed_count+=Number(!pairwiseCompleted);
}

function loadValidationTeacher(root){
  const manifest=JSON.parse(readFileSync(join(root,'manifest.json'),'utf8')),byPatient=new Map();
  for(const shard of manifest.shards||[]){
    const id=String(shard.patient_id||'');if(!HOLDOUT.includes(id))continue;
    const raw=JSON.parse(readFileSync(join(root,shard.path),'utf8'));
    byPatient.set(id,{patient_id:id,expected_turn_refs:(raw.source_turns||[]).filter(turn=>String(turn?.text||'').trim()).map(turn=>String(turn.source_ref)),cases:(raw.cases||[]).map(item=>({qa_id:String(item.qa_id),task:item.task,supervision:{official_evidence:item.supervision.official_evidence}}))});
  }
  const result=HOLDOUT.map(id=>byPatient.get(id));
  if(result.some(item=>!item)||result.reduce((sum,item)=>sum+item.cases.length,0)!==516)throw new Error('Expected the fixed four-patient, 516-question validation teacher split');
  return result;
}

function blankReport(instructionSource,graphSource){return{case_count:0,activation_count:0,changed_packet_count:0,embedding_completed_count:0,embedding_contract_match_count:0,embedding_failed_count:0,pairwise_completed_count:0,pairwise_applied_nonempty_count:0,pairwise_failed_count:0,instruction_source:instructionSource,graph_source:graphSource,candidate_budget:24,baseline:blank(),learned:blank(),exact_case_count:0,admission_case_count:0};}
function addCoverage(total,value,aggregate){for(const key of Object.keys(total))if(value[key]!=null)total[key]+=value[key];if(value.turn_recall!=null)aggregate.exact_case_count++;if(value.admission_recall!=null)aggregate.admission_case_count++;}
function finishReport(value){
  const exact=Math.max(1,value.exact_case_count/2),admission=Math.max(1,value.admission_case_count/2),finish=side=>({exact_turn_recall_at_24:round(side.turn_recall/exact),all_exact_turns_at_24:round(side.turn_all/exact),evidence_admission_recall_at_24:round(side.admission_recall/admission),all_evidence_admissions_at_24:round(side.admission_all/admission)}),baseline=finish(value.baseline),learned=finish(value.learned),delta=Object.fromEntries(METRICS.map(key=>[key,round(learned[key]-baseline[key])]));
  return{case_count:value.case_count,activation_count:value.activation_count,activation_rate:round(value.activation_count/Math.max(1,value.case_count)),changed_packet_count:value.changed_packet_count,embedding_completed_count:value.embedding_completed_count,embedding_contract_match_count:value.embedding_contract_match_count,embedding_failed_count:value.embedding_failed_count,pairwise_completed_count:value.pairwise_completed_count,pairwise_applied_nonempty_count:value.pairwise_applied_nonempty_count,pairwise_failed_count:value.pairwise_failed_count,instruction_source:value.instruction_source,graph_source:value.graph_source,candidate_budget:value.candidate_budget,exact_turn_case_count:exact,admission_case_count:admission,baseline,learned,delta,...(value.source_run_commitment?{source_run_commitment:value.source_run_commitment,source_experiment_id_hash:value.source_experiment_id_hash,source_graph_fingerprint:value.source_graph_fingerprint,source_result_count:value.source_result_count}:{})};
}
function coverage(nodes,official){const selectedRefs=new Set(nodes.map(node=>`turn:${node.episode_id}:${Number(node.turn_id)}`)),selectedAdmissions=new Set(nodes.map(node=>String(node.episode_id))),targets=new Set(official.turn_refs||[]),admissions=new Set((official.admission_ids||[]).map(String)),turnHits=[...targets].filter(ref=>selectedRefs.has(ref)).length,admissionHits=[...admissions].filter(id=>selectedAdmissions.has(id)).length;return{turn_recall:targets.size?turnHits/targets.size:null,turn_all:targets.size?Number(turnHits===targets.size):null,admission_recall:admissions.size?admissionHits/admissions.size:null,admission_all:admissions.size?Number(admissionHits===admissions.size):null};}
function passesDeploymentGate(sparse,rich){return sparse.case_count===516&&sparse.activation_count>0&&rich.case_count===102&&rich.activation_count>0&&[sparse,rich].every(report=>report.embedding_completed_count===report.case_count&&report.embedding_contract_match_count===report.case_count&&report.embedding_failed_count===0&&report.pairwise_completed_count===report.case_count&&report.pairwise_applied_nonempty_count>0&&report.pairwise_failed_count===0)&&METRICS.every(key=>sparse.delta[key]>=0&&rich.delta[key]>=0)&&(sparse.delta.exact_turn_recall_at_24>0||sparse.delta.evidence_admission_recall_at_24>0);}
function firstContentTerm(question){return(question.match(/[A-Za-z]+(?:[-'][A-Za-z]+)*|\d+(?:\.\d+)?/gu)||[]).find(term=>term.length>1&&!CONTENT_STOP.has(term.toLowerCase()))||'record';}
function runtimeGateEligible(instruction,snapshot){const value=instruction&&typeof instruction==='object'?instruction:{},terms=[...(value.search_terms||[]),...(value.expansion_terms||[]),...(value.required_terms||[])].filter(term=>String(term).trim()),hasControls=(value.numeric_signals||[]).length>0||(value.lenses||[]).length>0,sparse=terms.length===1&&!hasControls&&String(value.term_match||'any').toLowerCase()!=='all',signal=snapshot?.worker_state?.trace?.result_signal,noProgress=signal?.zero_recall===true||signal?.new_node_count===0;return sparse||noProgress;}
function graphCommitment(graphs){return sha256(stableJson([...graphs.values()].map(item=>item.fingerprint).sort()));}
function runtimeStackReport(graphs,pairwise){const rows=[...graphs.values()],sources=[...new Set(rows.map(item=>item.source))],migrations=rows.map(item=>item.literal_migration).filter(Boolean);return{search_worker:'createMemoryInvestigationWorkers.search',embedding:{provider:'local',model:MEDLOCOMO_EMBEDDING_MODEL,model_revision:MEDLOCOMO_EMBEDDING_MODEL_REVISION,model_revision_verification:'local_snapshot_sha256',base_model:MEDLOCOMO_EMBEDDING_BASE_MODEL,base_model_revision:MEDLOCOMO_EMBEDDING_BASE_MODEL_REVISION,snapshot_hash:MEDLOCOMO_EMBEDDING_SNAPSHOT_HASH,snapshot_file_hashes:MEDLOCOMO_EMBEDDING_SNAPSHOT_FILE_HASHES,dimension:MEDLOCOMO_EMBEDDING_DIMENSION,normalized:true,admission_chunk_turn_count:MEDLOCOMO_EMBEDDING_CHUNK_TURNS},pairwise_ranker_hash:pairwise.artifact.artifact_hash,candidate_budget:24,graph_snapshot_commitment:graphCommitment(graphs),graph_source:sources.length===1?sources[0]:'mixed',target_memory_version:[...new Set(rows.map(item=>item.target_memory_version).filter(Boolean))].join(','),literal_migration_complete:migrations.length===rows.length&&migrations.every(item=>item.all_nonempty_turns_retrievable===true),literal_turn_count:migrations.reduce((sum,item)=>sum+Number(item.added_literal_node_count||0),0)};}
function matchesEmbeddingContract(trace){return trace?.provider==='local'&&trace?.model===MEDLOCOMO_EMBEDDING_MODEL&&trace?.model_revision===MEDLOCOMO_EMBEDDING_MODEL_REVISION&&trace?.model_revision_verification==='local_snapshot_sha256'&&trace?.base_model===MEDLOCOMO_EMBEDDING_BASE_MODEL&&trace?.base_model_revision===MEDLOCOMO_EMBEDDING_BASE_MODEL_REVISION&&trace?.snapshot_hash===MEDLOCOMO_EMBEDDING_SNAPSHOT_HASH&&stableJson(trace?.snapshot_file_hashes)===stableJson(MEDLOCOMO_EMBEDDING_SNAPSHOT_FILE_HASHES)&&trace?.dimensions===MEDLOCOMO_EMBEDDING_DIMENSION&&trace?.normalized===true&&trace?.admission_chunk_turn_count===MEDLOCOMO_EMBEDDING_CHUNK_TURNS;}
function ids(nodes){return nodes.map(node=>String(node.memory_id)).join('|');}
function blank(){return{turn_recall:0,turn_all:0,admission_recall:0,admission_all:0};}
function round(value){return+Number(value||0).toFixed(6);}
function atomicJsonWrite(path,value){const temp=join(dirname(path),`.${path.split('/').at(-1)}.${process.pid}.tmp`);writeFileSync(temp,`${JSON.stringify(value,null,2)}\n`);renameSync(temp,path);}
function sha256(value){return createHash('sha256').update(String(value)).digest('hex');}
function stableJson(value){if(Array.isArray(value))return`[${value.map(stableJson).join(',')}]`;if(value&&typeof value==='object')return`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;return JSON.stringify(value);}
function parseArgs(argv){const out={};for(let index=0;index<argv.length;index++){const raw=argv[index];if(raw==='--finalize'){out.finalize=true;continue;}if(!raw.startsWith('--'))continue;out[raw.slice(2).replaceAll('-','_')]=argv[++index];}return out;}
