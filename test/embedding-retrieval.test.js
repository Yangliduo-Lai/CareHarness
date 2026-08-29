import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalBgeEmbeddingIndex,MEDMEMORY_EMBEDDING_BASE_MODEL,MEDMEMORY_EMBEDDING_MODEL } from '../src/embedding-retrieval.js';

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
