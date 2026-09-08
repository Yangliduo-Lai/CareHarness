import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalBgeEmbeddingIndex,LocalMiniLmEmbeddingIndex,MEDLOCOMO_EMBEDDING_BASE_MODEL,MEDLOCOMO_EMBEDDING_BASE_MODEL_REVISION,MEDLOCOMO_EMBEDDING_CHUNK_TURNS,MEDLOCOMO_EMBEDDING_DIMENSION,MEDLOCOMO_EMBEDDING_MODEL,MEDLOCOMO_EMBEDDING_MODEL_REVISION,MEDLOCOMO_EMBEDDING_SNAPSHOT_FILE_HASHES,MEDLOCOMO_EMBEDDING_SNAPSHOT_HASH,MEDMEMORY_EMBEDDING_BASE_MODEL,MEDMEMORY_EMBEDDING_MODEL } from '../src/embedding-retrieval.js';

test('local BGE index ranks normalized vectors and caches node/query embeddings across Search turns',async()=>{
  let calls=0,textsEmbedded=0;
  const embed_batch=async texts=>{calls++;textsEmbedded+=texts.length;return texts.map(text=>text.includes('无关')?[0,1]:[1,0]);},index=new LocalBgeEmbeddingIndex({embed_batch,batch_size:8}),nodes=[{memory_id:'vision',text:'患者眼睛时不时看不清。'},{memory_id:'other',text:'无关睡眠记录。'}];
  const first=await index.rank({query:'间歇性视物模糊',memory_nodes:nodes});
  assert.equal(first.scores.get('vision'),1);assert.equal(first.scores.get('other'),0);
  assert.equal(first.trace.model,MEDMEMORY_EMBEDDING_MODEL);assert.equal(first.trace.base_model,MEDMEMORY_EMBEDDING_BASE_MODEL);assert.equal(first.trace.embedded_node_count,2);assert.equal(first.trace.cached_node_count,0);
  const second=await index.rank({query:'间歇性视物模糊',memory_nodes:nodes});
  assert.equal(second.trace.query_cached,true);assert.equal(second.trace.embedded_node_count,0);assert.equal(second.trace.cached_node_count,2);
  assert.equal(calls,2);assert.equal(textsEmbedded,3);
});

test('local MiniLM index groups source Turns into six-Turn Admission chunks and emits ranker features',async()=>{
  const batches=[],vector=(first,second)=>[first,second,...Array(MEDLOCOMO_EMBEDDING_DIMENSION-2).fill(0)];
  const embed_batch=async texts=>{batches.push([...texts]);return texts.map(text=>{
    if(text==='renal question')return vector(5,0);
    if(text.includes('sleep'))return vector(0,3);
    if(text.includes('mixed'))return vector(3,4);
    return vector(2,0);
  });};
  const nodes=[];
  for(let turn=1;turn<=7;turn++)nodes.push({memory_id:`a-${turn}`,episode_id:'admission-a',turn_id:String(turn),source_type:turn%2?'doctor':'patient',source_text:turn===7?'sleep unrelated':`renal evidence ${turn}`,text:`fact ${turn}`});
  nodes.splice(1,0,{memory_id:'a-1-extra',episode_id:'admission-a',turn_id:'1',source_type:'doctor',source_text:'renal evidence 1',text:'second fact from the same source turn'});
  nodes.push({memory_id:'b-1',episode_id:'admission-b',turn_id:'1',source_type:'patient',source_text:'mixed signal'});
  const index=new LocalMiniLmEmbeddingIndex({embed_batch,batch_size:8}),first=await index.rank({query:'renal question',memory_nodes:nodes});

  assert.equal(first.trace.model,MEDLOCOMO_EMBEDDING_MODEL);assert.equal(first.trace.model_revision,MEDLOCOMO_EMBEDDING_MODEL_REVISION);assert.equal(first.trace.model_revision_verification,'local_snapshot_sha256');assert.equal(first.trace.base_model,MEDLOCOMO_EMBEDDING_BASE_MODEL);assert.equal(first.trace.base_model_revision,MEDLOCOMO_EMBEDDING_BASE_MODEL_REVISION);assert.equal(first.trace.snapshot_hash,null);assert.equal(first.trace.snapshot_file_hashes,null);assert.equal(MEDLOCOMO_EMBEDDING_SNAPSHOT_HASH.length,64);assert.equal(Object.keys(MEDLOCOMO_EMBEDDING_SNAPSHOT_FILE_HASHES).length,4);assert.equal(first.trace.pooling,'mean');assert.equal(first.trace.normalized,true);
  assert.equal(first.trace.admission_chunk_turn_count,MEDLOCOMO_EMBEDDING_CHUNK_TURNS);assert.equal(MEDLOCOMO_EMBEDDING_DIMENSION,384);assert.equal(first.trace.admission_count,2);assert.equal(first.trace.chunk_count,3);assert.equal(first.trace.embedded_chunk_count,3);
  assert.equal(batches.length,2);assert.equal(batches[1].length,3);
  assert.equal((batches[1][0].match(/(?:doctor|patient):/gu)||[]).length,6);
  assert.equal((batches[1][1].match(/(?:doctor|patient):/gu)||[]).length,1);
  assert.equal(first.scores.size,nodes.length);
  for(const node of nodes.filter(node=>node.episode_id==='admission-a'))assert.equal(first.scores.get(node.memory_id),1);
  assert.equal(first.scores.get('b-1'),.6);
  assert.deepEqual(first.admission_features.get('admission-a'),{dense_chunk_max_cosine:1,dense_chunk_top2_cosine:.5,dense_admission_centroid_cosine:.70710678});
  assert.deepEqual(first.admission_features.get('admission-b'),{dense_chunk_max_cosine:.6,dense_chunk_top2_cosine:.6,dense_admission_centroid_cosine:.6});

  const second=await index.rank({query:'renal question',memory_nodes:nodes});
  assert.equal(second.trace.query_cached,true);assert.equal(second.trace.embedded_chunk_count,0);assert.equal(second.trace.cached_chunk_count,3);assert.equal(batches.length,2);
  assert.deepEqual([...second.admission_features], [...first.admission_features]);
});

test('local MiniLM index skips empty requests without loading an embedding model',async()=>{
  let called=false;const index=new LocalMiniLmEmbeddingIndex({embed_batch:async()=>{called=true;return[];}}),result=await index.rank({query:'',memory_nodes:[{memory_id:'node'}]});
  assert.equal(called,false);assert.equal(result.trace.status,'skipped_empty');assert.deepEqual([...result.scores],[]);assert.deepEqual([...result.admission_features],[]);
});

test('local MiniLM index fails closed when an injected or loaded model is not 384-dimensional',async()=>{
  const index=new LocalMiniLmEmbeddingIndex({embed_batch:async texts=>texts.map(()=>[1,0])});
  await assert.rejects(index.rank({query:'renal question',memory_nodes:[{memory_id:'m',episode_id:'a',turn_id:'1',source_text:'renal evidence'}]}),/embedding dimension 2 does not match 384/u);
});

test('local embedding indexes propagate provider failure without creating an unhandled rejection',async()=>{
  const failure=new Error('embedding unavailable'),node={memory_id:'m',episode_id:'a',turn_id:'1',source_text:'renal evidence'};
  for(const index of[new LocalBgeEmbeddingIndex({embed_batch:async()=>{throw failure;}}),new LocalMiniLmEmbeddingIndex({embed_batch:async()=>{throw failure;}})]){
    await assert.rejects(index.rank({query:'renal question',memory_nodes:[node]}),/embedding unavailable/u);
  }
});

test('local MiniLM chunks MedLoCoMo Turns in source turn order, not Memory Node insertion order',async()=>{
  const batches=[],labels=new Map([[1,'alpha'],[2,'bravo'],[3,'charlie'],[4,'delta'],[5,'echo'],[6,'foxtrot'],[7,'golf']]),nodes=[5,1,7,3,2,6,4].map(turn=>({memory_id:`m-${turn}`,episode_id:'admission-a',turn_id:String(turn),event_time:`2130-01-${String(turn).padStart(2,'0')}`,source_type:turn%2?'doctor':'patient',source_text:`${labels.get(turn)} clinical marker`,text:`summary ${turn}`}));
  nodes.unshift({memory_id:'m-1-summary',episode_id:'admission-a',turn_id:'1',event_time:'2130-01-01',source_type:'doctor',text:'short alpha summary'});
  const index=new LocalMiniLmEmbeddingIndex({batch_size:16,embed_batch:async texts=>{batches.push([...texts]);return texts.map(()=>[1,...Array(MEDLOCOMO_EMBEDDING_DIMENSION-1).fill(0)]);}});await index.rank({query:'ordering question',memory_nodes:nodes});
  const chunks=batches[1];assert.equal(chunks.length,2);
  for(let turn=1;turn<6;turn++)assert.ok(chunks[0].indexOf(labels.get(turn))<chunks[0].indexOf(labels.get(turn+1)),`${labels.get(turn)} must precede ${labels.get(turn+1)}`);
  assert.doesNotMatch(chunks[0],/golf/u);assert.match(chunks[1],/golf/u);
});
