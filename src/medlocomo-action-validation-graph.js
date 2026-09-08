import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
import { tagMemoryNodes } from './memory-family-tagger.js';
import { updateMemoryGraph } from './memory-graph-updater.js';
import { pipelineInternals } from './pipeline.js';

export const MEDLOCOMO_VALIDATION_EMBEDDING_CONTRACT=Object.freeze({
  provider:'local',
  model:MEDLOCOMO_EMBEDDING_MODEL,
  model_revision:MEDLOCOMO_EMBEDDING_MODEL_REVISION,
  model_revision_verification:'local_snapshot_sha256',
  base_model:MEDLOCOMO_EMBEDDING_BASE_MODEL,
  base_model_revision:MEDLOCOMO_EMBEDDING_BASE_MODEL_REVISION,
  snapshot_hash:MEDLOCOMO_EMBEDDING_SNAPSHOT_HASH,
  snapshot_file_hashes:MEDLOCOMO_EMBEDDING_SNAPSHOT_FILE_HASHES,
  normalized:true,
  dimension:MEDLOCOMO_EMBEDDING_DIMENSION,
  admission_chunk_turn_count:MEDLOCOMO_EMBEDDING_CHUNK_TURNS,
});

/**
 * Load a frozen, read-only production Memory Graph for Action-policy
 * validation.  The returned source-ref map is reconstructed only from public
 * Admission/Turn coordinates; no Gold or Judge material is read from SQLite.
 */
export function loadMedLoCoMoValidationGraphs(path,patientIds=[],options={}){
  const databasePath=resolve(String(path||'')),ids=[...new Set(patientIds.map(String).filter(Boolean))];
  if(!path||!existsSync(databasePath))throw new Error(`MedLoCoMo validation graph database not found: ${databasePath}`);
  if(!ids.length)throw new Error('MedLoCoMo validation graph loader requires Patient IDs');
  const db=new DatabaseSync(databasePath,{readOnly:true}),graphs=new Map();
  try{
    for(const patientId of ids){
      const subjectId=`medlocomo-${patientId}`,nodeRows=db.prepare(`SELECT rowid,payload_json FROM memory_nodes WHERE subject_id=? ORDER BY rowid`).all(subjectId),edgeRows=db.prepare(`SELECT rowid,payload_json FROM memory_edges WHERE subject_id=? ORDER BY rowid`).all(subjectId);
      if(!nodeRows.length)throw new Error(`No frozen production Memory Graph for ${subjectId}`);
      const semanticNodes=latestPayloads(nodeRows,'memory_id').filter(node=>String(node?.status||'active')==='active'),frozenVersion=detectedMemoryVersion(db,patientId),expectedTurnRefs=options.expected_turn_refs_by_patient?.get?.(patientId)||[],migration=options.migrate_literal_provenance===true?literalMigration(db,subjectId,semanticNodes,{frozenVersion,expectedTurnRefs}):null,nodes=migration?[...semanticNodes,...migration.nodes]:semanticNodes,nodeIds=new Set(nodes.map(node=>String(node.memory_id))),edges=latestPayloads(edgeRows,'edge_id').filter(edge=>String(edge?.status||'')==='verified'&&nodeIds.has(String(edge.from_memory_id))&&nodeIds.has(String(edge.to_memory_id))),refByMemory=new Map(nodes.map(node=>[String(node.memory_id),turnRef(node)]).filter(([,ref])=>Boolean(ref))),nodeById=new Map(nodes.map(node=>[String(node.memory_id),node])),fingerprint=sha256(JSON.stringify({nodes:nodes.map(node=>String(node.memory_id)).sort(),edges:edges.map(edge=>String(edge.edge_id)).sort()})),source=migration?'frozen_production_sqlite_v1_plus_deterministic_v2_literal_migration':'frozen_production_sqlite';
      if(nodes.length!==nodeIds.size)throw new Error(`Validation Graph contains duplicate Memory IDs for ${subjectId}`);
      graphs.set(patientId,{patient_id:patientId,subject_id:subjectId,nodes,edges,refByMemory,nodeById,source,fingerprint,frozen_graph_memory_version:frozenVersion,target_memory_version:migration?String(options.target_memory_version||'medlocomo-admission-node-completeness-v2-literal-turn-coverage'):null,...(migration?{literal_migration:migration.metadata}:{})});
    }
  }finally{db.close();}
  return graphs;
}

function literalMigration(db,subjectId,semanticNodes,{frozenVersion,expectedTurnRefs=[]}={}){
  if(frozenVersion!=='medlocomo-admission-node-completeness-v1')throw new Error(`Deterministic literal migration requires a verified v1 frozen graph for ${subjectId}; found ${frozenVersion}`);
  const runIds=[...new Set(semanticNodes.map(node=>String(node.run_id||'')).filter(Boolean))];
  // Older payloads do not retain run_id inside JSON; use the relational rows
  // that own the currently visible graph instead.
  const relationalRunIds=db.prepare(`SELECT DISTINCT run_id FROM memory_nodes WHERE subject_id=?`).all(subjectId).map(row=>String(row.run_id)),activeRunIds=runIds.length?runIds:relationalRunIds,observations=[];
  for(const runId of activeRunIds){const row=db.prepare(`SELECT payload_json FROM observations WHERE subject_id=? AND run_id=? ORDER BY rowid DESC LIMIT 1`).get(subjectId,runId);if(row?.payload_json)observations.push(JSON.parse(String(row.payload_json)));}
  const nodes=[],refs=new Set();
  for(const observation of observations){
    const candidates=pipelineInternals.medLoCoMoSourceTurnFallbackCandidates(observation),tagged=tagMemoryNodes(candidates,observation),migrated=updateMemoryGraph(tagged,[],[],observation).nodes;
    for(const node of migrated){const ref=turnRef(node);if(!ref||refs.has(ref))throw new Error(`Invalid or duplicate deterministic literal Turn during migration: ${ref||'<missing>'}`);refs.add(ref);nodes.push(node);}
  }
  if(!nodes.length)throw new Error(`No deterministic literal Turn could be migrated for ${subjectId}`);
  const expected=new Set(array(expectedTurnRefs).map(String).filter(Boolean)),missing=[...expected].filter(ref=>!refs.has(ref)),unexpected=[...refs].filter(ref=>!expected.has(ref)),complete=expected.size>0&&missing.length===0&&unexpected.length===0&&refs.size===nodes.length;
  const metadata={version:'medlocomo-validation-literal-migration.v1',source_memory_version:'medlocomo-admission-node-completeness-v1',target_memory_version:'medlocomo-admission-node-completeness-v2-literal-turn-coverage',source_observation_count:observations.length,added_literal_node_count:nodes.length,expected_nonempty_turn_ref_count:expected.size,unique_turn_ref_count:refs.size,missing_expected_turn_ref_count:missing.length,unexpected_turn_ref_count:unexpected.length,all_nonempty_turns_retrievable:complete,source_observation_commitment:sha256(observations.map(item=>sha256(String(item.raw_text||''))).sort().join('\n')),expected_turn_ref_commitment:sha256([...expected].sort().join('\n')),migration_code_path:'current pipeline literal-provenance candidate + deterministic family tagger + graph updater'};
  return{nodes,metadata};
}

function detectedMemoryVersion(db,patientId){
  let rows=[];try{rows=db.prepare(`SELECT config_json FROM experiments WHERE benchmark='medlocomo' ORDER BY datetime(updated_at) DESC`).all();}catch{return'unknown';}
  for(const row of rows)try{const config=JSON.parse(String(row.config_json||'{}'));if(String(config.patient_id||'')===String(patientId)&&config.medlocomo_memory_completeness_version)return String(config.medlocomo_memory_completeness_version);}catch{}
  return'unknown';
}

/** Build the diagnostic training projection with exactly one Node per Turn. */
export function buildMedLoCoMoSourceLiteralActionGraph(shard={}){
  const nodes=[],refByMemory=new Map(),nodeById=new Map();
  for(const turn of Array.isArray(shard.source_turns)?shard.source_turns:[]){
    const sourceRef=String(turn?.source_ref||''),id=`literal:${sha256(sourceRef).slice(0,20)}`;
    if(!sourceRef)throw new Error('MedLoCoMo source Turn requires source_ref');
    if(nodeById.has(id))throw new Error(`Duplicate MedLoCoMo source Turn memory_id: ${id}`);
    const node={memory_id:id,observation_id:`admission:${turn.admission_id}`,subject_id:'medlocomo-training-subject',text:String(turn.text),source_text:String(turn.text),source_type:String(turn.speaker).toLowerCase()==='patient'?'patient':'doctor',episode_id:String(turn.admission_id),turn_id:String(turn.turn_number),event_time:String(turn.time||''),families:[],factor_key:null,status:'active',certainty:1,polarity:'affirmed',version:1,operation:'ADD'};
    nodes.push(node);refByMemory.set(id,sourceRef);nodeById.set(id,node);
  }
  if(nodes.length!==nodeById.size)throw new Error('MedLoCoMo source-Turn projection contains duplicate Memory IDs');
  return{nodes,edges:[],refByMemory,nodeById,source:'diagnostic_source_turn_projection'};
}

/** A configured callback is insufficient: require evidence that both stages ran. */
export function medLoCoMoValidationRuntimeStatus({has_production_graph=false,stats=null,embedding_contract=null}={}){
  const value=stats&&typeof stats==='object'?stats:{},embeddingAttempted=strictNumber(value.embedding_attempted??value.embedding_calls),pairwiseAttempted=strictNumber(value.pairwise_attempted??value.pairwise_calls),contract=embedding_contract&&typeof embedding_contract==='object'?embedding_contract:{},contractMatched=Object.entries(MEDLOCOMO_VALIDATION_EMBEDDING_CONTRACT).every(([key,expected])=>stableEqual(contract[key],expected)),observedMatched=singletonEquals(value.embedding_observed_providers,MEDLOCOMO_VALIDATION_EMBEDDING_CONTRACT.provider)&&singletonEquals(value.embedding_observed_models,MEDLOCOMO_VALIDATION_EMBEDDING_CONTRACT.model)&&singletonEquals(value.embedding_observed_model_revisions,MEDLOCOMO_VALIDATION_EMBEDDING_CONTRACT.model_revision)&&singletonEquals(value.embedding_observed_model_revision_verifications,MEDLOCOMO_VALIDATION_EMBEDDING_CONTRACT.model_revision_verification)&&singletonEquals(value.embedding_observed_base_models,MEDLOCOMO_VALIDATION_EMBEDDING_CONTRACT.base_model)&&singletonEquals(value.embedding_observed_base_model_revisions,MEDLOCOMO_VALIDATION_EMBEDDING_CONTRACT.base_model_revision)&&singletonEquals(value.embedding_observed_snapshot_hashes,MEDLOCOMO_VALIDATION_EMBEDDING_CONTRACT.snapshot_hash)&&singletonEquals(value.embedding_observed_snapshot_file_hash_commitments,sha256(stableJson(MEDLOCOMO_VALIDATION_EMBEDDING_CONTRACT.snapshot_file_hashes)))&&singletonEquals(value.embedding_observed_normalized,true)&&singletonEquals(value.embedding_observed_dimensions,MEDLOCOMO_VALIDATION_EMBEDDING_CONTRACT.dimension)&&singletonEquals(value.embedding_observed_chunk_turn_counts,MEDLOCOMO_VALIDATION_EMBEDDING_CONTRACT.admission_chunk_turn_count),embeddingUsed=embeddingAttempted>0&&strictNumber(value.embedding_completed)===embeddingAttempted&&strictNumber(value.embedding_failed)===0&&strictNumber(value.embedding_expected_dimensions)===MEDLOCOMO_VALIDATION_EMBEDDING_CONTRACT.dimension&&contractMatched&&observedMatched,pairwiseUsed=pairwiseAttempted>0&&strictNumber(value.pairwise_applied)===pairwiseAttempted&&strictNumber(value.pairwise_failed)===0;
  return{production_embedding_selector_used:embeddingUsed,production_pairwise_ranker_used:pairwiseUsed,embedding_runtime_contract_matched:contractMatched&&observedMatched,runtime_environment_parity:Boolean(has_production_graph&&embeddingUsed&&pairwiseUsed)};
}

function latestPayloads(rows,idKey){
  const latest=new Map();
  for(const row of rows){const value=JSON.parse(String(row.payload_json||'null'));if(!value||typeof value!=='object')continue;const id=String(value[idKey]||'');if(id)latest.set(id,{rowid:Number(row.rowid)||0,value});}
  return[...latest.values()].sort((left,right)=>left.rowid-right.rowid).map(row=>row.value);
}
function turnRef(node){const admission=String(node?.episode_id||''),raw=String(node?.turn_id||''),match=raw.match(/\d+/u);return admission&&match?`turn:${admission}:${Number(match[0])}`:'';}
function sha256(value){return createHash('sha256').update(value).digest('hex');}
function array(value){return Array.isArray(value)?value:[];}
function strictNumber(value){return typeof value==='number'&&Number.isFinite(value)?value:NaN;}
function singletonEquals(values,expected){return Array.isArray(values)&&values.length===1&&values[0]===expected;}
function stableEqual(left,right){return stableJson(left)===stableJson(right);}
function stableJson(value){if(Array.isArray(value))return`[${value.map(stableJson).join(',')}]`;if(value&&typeof value==='object')return`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;return JSON.stringify(value);}
