// 来源：MedMemoryBench 官方 Embedding RAG 配置；任务：用
// BGE-small-zh-v1.5 为当前 Search Action 扩展词义相近的候选 Memory Node。
// 向量模型仅在本机运行；时间、来源、Family 和 Refine 边界仍由检索器硬过滤。
export const MEDMEMORY_EMBEDDING_MODEL='Xenova/bge-small-zh-v1.5';
export const MEDMEMORY_EMBEDDING_BASE_MODEL='BAAI/bge-small-zh-v1.5';
export const MEDLOCOMO_EMBEDDING_MODEL='Xenova/all-MiniLM-L6-v2';
export const MEDLOCOMO_EMBEDDING_BASE_MODEL='sentence-transformers/all-MiniLM-L6-v2';
export const MEDLOCOMO_EMBEDDING_MODEL_REVISION='751bff37182d3f1213fa05d7196b954e230abad9';
export const MEDLOCOMO_EMBEDDING_BASE_MODEL_REVISION='1110a243fdf4706b3f48f1d95db1a4f5529b4d41';
export const MEDLOCOMO_EMBEDDING_DIMENSION=384;
export const MEDLOCOMO_EMBEDDING_CHUNK_TURNS=6;
export const MEDLOCOMO_EMBEDDING_SNAPSHOT_FILE_HASHES=Object.freeze({
  'config.json':'7135149f7cffa1a573466c6e4d8423ed73b62fd2332c575bf738a0d033f70df7',
  'onnx/model.onnx':'759c3cd2b7fe7e93933ad23c4c9181b7396442a2ed746ec7c1d46192c469c46e',
  'tokenizer.json':'da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0',
  'tokenizer_config.json':'9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3',
});
export const MEDLOCOMO_EMBEDDING_SNAPSHOT_HASH='52969911136eb2bdc5a922ec66ee0f5e633c5d8f3281cfbe0174387fbf2af2d3';

const MEDLOCOMO_TOKEN=/[a-z]+(?:'[a-z]+)?|\d+(?:\.\d+)?/giu;
const MEDLOCOMO_STOP=new Set(('a an the and or of for to in on at by as was were is are be been being with '+
  'from during which what when where why how did does do had has have his her their '+
  'this that these those into after before over time patient hospitalization '+
  'hospitalizations admission admissions across multiple because due while most '+
  'primary main following according record records tell describe explain compare '+
  'between regarding related').split(' '));

export class LocalBgeEmbeddingIndex{
  constructor({model=MEDMEMORY_EMBEDDING_MODEL,base_model=MEDMEMORY_EMBEDDING_BASE_MODEL,dtype='fp32',batch_size=32,remote_host=process.env.CAREHARNESS_HF_HOST||'https://hf-mirror.com/',embed_batch=null}={}){
    this.model=String(model);this.baseModel=String(base_model);this.dtype=String(dtype||'fp32');this.remoteHost=String(remote_host||'https://huggingface.co/');this.batchSize=Math.max(1,Math.min(128,Number(batch_size)||32));this.injectedEmbedBatch=typeof embed_batch==='function'?embed_batch:null;this.extractorPromise=null;this.vectorCache=new Map();this.pendingVectors=new Map();this.queryCache=new Map();
  }

  async rank({query,memory_nodes=[]}={}){
    const normalizedQuery=normalizeText(query),nodes=dedupeNodes(memory_nodes);
    if(!normalizedQuery||!nodes.length)return{scores:new Map(),trace:this.#trace({status:'skipped_empty',node_count:nodes.length,embedded_node_count:0,cached_node_count:0,dimensions:0})};
    const queryKey=`query\u0000${normalizedQuery}`,queryCached=this.queryCache.has(queryKey),queryVector=queryCached?this.queryCache.get(queryKey):await this.#embedTexts([normalizedQuery]).then(rows=>rows[0]);
    if(!queryCached)this.queryCache.set(queryKey,queryVector);
    const vectors=new Map(),missing=[];let cached=0;
    for(const node of nodes){
      const id=String(node.memory_id||''),text=nodeText(node),key=cacheKey(id,text);
      if(this.vectorCache.has(key)){vectors.set(id,this.vectorCache.get(key));cached++;}
      else missing.push({id,key,text});
    }
    for(let offset=0;offset<missing.length;offset+=this.batchSize){
      const batch=missing.slice(offset,offset+this.batchSize),rows=await this.#embedTexts(batch.map(item=>item.text));
      batch.forEach((item,index)=>{const vector=rows[index]||[];this.vectorCache.set(item.key,vector);vectors.set(item.id,vector);});
    }
    const scores=new Map();for(const node of nodes){const id=String(node.memory_id||''),vector=vectors.get(id);if(vector?.length)scores.set(id,dot(queryVector,vector));}
    return{scores,trace:this.#trace({status:'completed',node_count:nodes.length,embedded_node_count:missing.length,cached_node_count:cached,query_cached:queryCached,dimensions:queryVector?.length||0})};
  }

  async #embedTexts(texts){
    const values=texts.map(normalizeText),missing=[],rows=new Array(values.length);
    for(let index=0;index<values.length;index++){
      const key=`text\u0000${values[index]}`;
      if(this.pendingVectors.has(key))rows[index]=this.pendingVectors.get(key);
      else{
        const placeholder={key,index,text:values[index]};missing.push(placeholder);
      }
    }
    if(missing.length){
      const promise=this.#runEmbedding(missing.map(item=>item.text));
      missing.forEach((item,batchIndex)=>{const pending=promise.then(result=>normalizeVector(result[batchIndex]));this.pendingVectors.set(item.key,pending);rows[item.index]=pending;pending.then(()=>this.pendingVectors.delete(item.key),()=>this.pendingVectors.delete(item.key));});
    }
    return Promise.all(rows.map(row=>Promise.resolve(row)));
  }

  async #runEmbedding(texts){
    if(this.injectedEmbedBatch)return this.injectedEmbedBatch(texts);
    if(!this.extractorPromise)this.extractorPromise=import('@huggingface/transformers').then(({pipeline,env})=>{env.remoteHost=this.remoteHost.endsWith('/')?this.remoteHost:`${this.remoteHost}/`;return pipeline('feature-extraction',this.model,{dtype:this.dtype});});
    const extractor=await this.extractorPromise,output=await extractor(texts,{pooling:'cls',normalize:true});
    return typeof output?.tolist==='function'?output.tolist():output;
  }

  #trace(fields){return{version:'careharness-local-embedding.v1',provider:'local',model:this.model,base_model:this.baseModel,pooling:'cls',normalized:true,dtype:this.dtype,remote_host:this.remoteHost,...fields};}
}

/**
 * Local dense index for the MedLoCoMo Admission router.
 *
 * Memory Nodes are first collapsed to their source Turn, then grouped into
 * non-overlapping six-Turn Admission chunks. Every node in an Admission gets
 * its maximum chunk cosine as its semantic retrieval score; the three
 * aggregate values consumed by the pairwise Admission ranker are returned in
 * `admission_features`.
 */
export class LocalMiniLmEmbeddingIndex{
  constructor({model=MEDLOCOMO_EMBEDDING_MODEL,model_revision=MEDLOCOMO_EMBEDDING_MODEL_REVISION,base_model=MEDLOCOMO_EMBEDDING_BASE_MODEL,base_model_revision=MEDLOCOMO_EMBEDDING_BASE_MODEL_REVISION,dtype='fp32',batch_size=32,remote_host=process.env.CAREHARNESS_HF_HOST||'https://hf-mirror.com/',embed_batch=null}={}){
    this.model=String(model);this.modelRevision=String(model_revision);this.baseModel=String(base_model);this.baseModelRevision=String(base_model_revision);this.dtype=String(dtype||'fp32');this.remoteHost=String(remote_host||'https://huggingface.co/');this.batchSize=Math.max(1,Math.min(128,Number(batch_size)||32));this.injectedEmbedBatch=typeof embed_batch==='function'?embed_batch:null;this.extractorPromise=null;this.vectorCache=new Map();this.pendingVectors=new Map();this.queryCache=new Map();this.snapshotHash=null;this.snapshotFileHashes=null;
  }

  async rank({query,memory_nodes=[]}={}){
    const normalizedQuery=normalizeText(query),nodes=dedupeNodes(memory_nodes),admissionFeatures=new Map();
    if(!normalizedQuery||!nodes.length)return{scores:new Map(),admission_features:admissionFeatures,trace:this.#trace({status:'skipped_empty',node_count:nodes.length,admission_count:0,chunk_count:0,embedded_chunk_count:0,cached_chunk_count:0,dimensions:0})};
    const admissions=medLoCoMoAdmissionChunks(nodes);
    if(!admissions.length)return{scores:new Map(),admission_features:admissionFeatures,trace:this.#trace({status:'skipped_empty',node_count:nodes.length,admission_count:0,chunk_count:0,embedded_chunk_count:0,cached_chunk_count:0,dimensions:0})};
    const queryKey=`query\u0000${normalizedQuery}`,queryCached=this.queryCache.has(queryKey),queryVector=queryCached?this.queryCache.get(queryKey):await this.#embedTexts([normalizedQuery]).then(rows=>rows[0]);
    assertMedLoCoMoEmbeddingDimension(queryVector,'query');
    if(!queryCached)this.queryCache.set(queryKey,queryVector);
    const chunks=admissions.flatMap(admission=>admission.chunks.map((text,index)=>({episode:admission.episode,index,text,key:cacheKey(`${admission.episode}:${index}`,text)}))),vectors=new Map(),missing=[];let cached=0;
    for(const chunk of chunks){if(this.vectorCache.has(chunk.key)){vectors.set(chunk.key,this.vectorCache.get(chunk.key));cached++;}else missing.push(chunk);}
    for(let offset=0;offset<missing.length;offset+=this.batchSize){
      const batch=missing.slice(offset,offset+this.batchSize),rows=await this.#embedTexts(batch.map(item=>item.text));
      batch.forEach((item,index)=>{const vector=rows[index]||[];assertMedLoCoMoEmbeddingDimension(vector,`Admission chunk ${item.episode}:${item.index}`);this.vectorCache.set(item.key,vector);vectors.set(item.key,vector);});
    }
    const scores=new Map();
    for(const admission of admissions){
      const admissionChunks=chunks.filter(chunk=>chunk.episode===admission.episode),chunkVectors=admissionChunks.map(chunk=>vectors.get(chunk.key)).filter(vector=>vector?.length),similarities=chunkVectors.map(vector=>dot(queryVector,vector)).sort((left,right)=>right-left),centroid=normalizeVector(meanVector(chunkVectors)),features={
        dense_chunk_max_cosine:similarities[0]||0,
        dense_chunk_top2_cosine:mean(similarities.slice(0,2)),
        dense_admission_centroid_cosine:centroid.length?dot(queryVector,centroid):0,
      };
      admissionFeatures.set(admission.episode,features);
      for(const id of admission.memoryIds)scores.set(id,features.dense_chunk_max_cosine);
    }
    return{scores,admission_features:admissionFeatures,trace:this.#trace({status:'completed',node_count:nodes.length,admission_count:admissions.length,chunk_count:chunks.length,embedded_chunk_count:missing.length,cached_chunk_count:cached,query_cached:queryCached,dimensions:queryVector?.length||0})};
  }

  async #embedTexts(texts){
    const values=texts.map(normalizeText),missing=[],rows=new Array(values.length);
    for(let index=0;index<values.length;index++){
      const key=`text\u0000${values[index]}`;
      if(this.pendingVectors.has(key))rows[index]=this.pendingVectors.get(key);
      else missing.push({key,index,text:values[index]});
    }
    if(missing.length){
      const promise=this.#runEmbedding(missing.map(item=>item.text));
      missing.forEach((item,batchIndex)=>{const pending=promise.then(result=>normalizeVector(result[batchIndex]));this.pendingVectors.set(item.key,pending);rows[item.index]=pending;pending.then(()=>this.pendingVectors.delete(item.key),()=>this.pendingVectors.delete(item.key));});
    }
    return Promise.all(rows.map(row=>Promise.resolve(row)));
  }

  async #runEmbedding(texts){
    if(this.injectedEmbedBatch)return this.injectedEmbedBatch(texts);
    if(!this.extractorPromise)this.extractorPromise=import('@huggingface/transformers').then(({pipeline,env})=>{
      env.remoteHost=this.remoteHost.endsWith('/')?this.remoteHost:`${this.remoteHost}/`;
      const snapshot=verifyMedLoCoMoEmbeddingSnapshot(env.cacheDir,this.model);this.snapshotHash=snapshot.snapshot_hash;this.snapshotFileHashes=snapshot.snapshot_file_hashes;
      // Transformers.js treats an explicit revision as a distinct remote cache
      // lookup. The byte-level snapshot check above is the stronger offline
      // contract and lets pipeline consume the already verified local cache.
      return pipeline('feature-extraction',this.model,{dtype:this.dtype});
    });
    const extractor=await this.extractorPromise,output=await extractor(texts,{pooling:'mean',normalize:true});
    return typeof output?.tolist==='function'?output.tolist():output;
  }

  #trace(fields){return{version:'careharness-medlocomo-local-embedding.v1',provider:'local',model:this.model,model_revision:this.modelRevision,model_revision_verification:'local_snapshot_sha256',base_model:this.baseModel,base_model_revision:this.baseModelRevision,snapshot_hash:this.snapshotHash,snapshot_file_hashes:this.snapshotFileHashes,pooling:'mean',normalized:true,dtype:this.dtype,remote_host:this.remoteHost,admission_chunk_turn_count:MEDLOCOMO_EMBEDDING_CHUNK_TURNS,...fields};}
}

function nodeText(node){return normalizeText([node?.text,node?.source_text].filter(Boolean).join('\n'));}
function cacheKey(id,text){return`${id}\u0000${text}`;}
function normalizeText(value){return String(value||'').normalize('NFKC').trim().slice(0,4000);}
function normalizeVector(value){const vector=Array.from(value||[],Number),norm=Math.sqrt(vector.reduce((sum,item)=>sum+item*item,0));return norm>0?vector.map(item=>item/norm):vector;}
function dot(left=[],right=[]){const length=Math.min(left.length,right.length);let score=0;for(let index=0;index<length;index++)score+=Number(left[index]||0)*Number(right[index]||0);return+score.toFixed(8);}
function dedupeNodes(value){const out=[],seen=new Set();for(const node of Array.isArray(value)?value:[]){const id=String(node?.memory_id||'');if(!id||seen.has(id))continue;seen.add(id);out.push(node);}return out;}
function medLoCoMoAdmissionChunks(nodes){
  const admissions=new Map();
  for(let index=0;index<nodes.length;index++){
    const node=nodes[index],memoryId=String(node?.memory_id||''),episode=String(node?.episode_id||node?.observation_id||memoryId),turnId=String(node?.turn_id||node?.event_time||memoryId),turnKey=`${episode}\u0000${turnId}`,admission=admissions.get(episode)||{episode,memoryIds:[],turns:new Map(),order:index};
    admission.memoryIds.push(memoryId);
    const turn=admission.turns.get(turnKey)||{order:index,turnId:String(node?.turn_id||''),eventTime:String(node?.event_time||''),sourceType:String(node?.source_type||'').toLowerCase(),sourceTexts:new Set(),texts:new Set()};
    const sourceText=normalizeText(node?.source_text),text=normalizeText(node?.text);
    if(sourceText)turn.sourceTexts.add(sourceText);if(text)turn.texts.add(text);if(/doctor|clinician/u.test(String(node?.source_type||'').toLowerCase()))turn.sourceType='doctor';
    admission.turns.set(turnKey,turn);admissions.set(episode,admission);
  }
  return[...admissions.values()].sort((left,right)=>left.order-right.order).map(admission=>{
    const turns=[...admission.turns.values()].sort(compareMedLoCoMoSourceTurn).map(turn=>{
      // The MedLoCoMo source-Turn fallback contributes the complete verbatim
      // source span; semantic nodes from the same Turn may contain shorter
      // overlapping spans.  Selecting the longest value prevents duplicate
      // fragments from changing the chunk seen during training.
      const values=turn.sourceTexts.size?[...turn.sourceTexts]:[...turn.texts],source=[...values].sort((left,right)=>right.length-left.length)[0]||'',tokens=medLoCoMoContentTokens(source),role=/doctor|clinician/u.test(turn.sourceType)?'doctor':'patient';
      return`${role}: ${tokens.join(' ')}`;
    }),chunks=[];
    for(let offset=0;offset<turns.length;offset+=MEDLOCOMO_EMBEDDING_CHUNK_TURNS)chunks.push(normalizeText(turns.slice(offset,offset+MEDLOCOMO_EMBEDDING_CHUNK_TURNS).join(' ')));
    if(!chunks.length)chunks.push('empty admission');
    return{episode:admission.episode,memoryIds:[...new Set(admission.memoryIds)],chunks};
  });
}
function compareMedLoCoMoSourceTurn(left,right){
  const leftTurn=numericTurn(left.turnId),rightTurn=numericTurn(right.turnId);
  if(leftTurn!==rightTurn)return leftTurn-rightTurn;
  const leftTime=Date.parse(left.eventTime||''),rightTime=Date.parse(right.eventTime||''),safeLeft=Number.isFinite(leftTime)?leftTime:Infinity,safeRight=Number.isFinite(rightTime)?rightTime:Infinity;
  return safeLeft-safeRight||left.order-right.order;
}
function numericTurn(value){const number=Number(String(value||'').trim());return Number.isFinite(number)?number:Infinity;}
function medLoCoMoContentTokens(value){return[...String(value||'').toLowerCase().matchAll(MEDLOCOMO_TOKEN)].map(match=>match[0]).filter(token=>!MEDLOCOMO_STOP.has(token)&&(token.length>1||/^\d/u.test(token)));}
function mean(values=[]){return values.length?values.reduce((sum,value)=>sum+Number(value||0),0)/values.length:0;}
function meanVector(vectors=[]){if(!vectors.length)return[];const dimensions=Math.max(0,...vectors.map(vector=>vector.length)),result=new Array(dimensions).fill(0);for(const vector of vectors)for(let index=0;index<dimensions;index++)result[index]+=Number(vector[index]||0);return result.map(value=>value/vectors.length);}
function assertMedLoCoMoEmbeddingDimension(vector,label){if(!Array.isArray(vector)||vector.length!==MEDLOCOMO_EMBEDDING_DIMENSION)throw new Error(`${label} embedding dimension ${Array.isArray(vector)?vector.length:0} does not match ${MEDLOCOMO_EMBEDDING_DIMENSION}`);}
function verifyMedLoCoMoEmbeddingSnapshot(cacheDirectory,model){
  if(model!==MEDLOCOMO_EMBEDDING_MODEL)throw new Error(`MedLoCoMo embedding model ${model} does not match the pinned runtime snapshot`);
  const root=resolve(String(cacheDirectory||''),model),actual={};
  for(const[name,expected]of Object.entries(MEDLOCOMO_EMBEDDING_SNAPSHOT_FILE_HASHES)){
    let bytes;try{bytes=readFileSync(resolve(root,name));}catch(error){throw new Error(`MedLoCoMo embedding snapshot is missing ${name}: ${String(error?.message||error)}`);}
    const digest=createHash('sha256').update(bytes).digest('hex');if(digest!==expected)throw new Error(`MedLoCoMo embedding snapshot hash mismatch for ${name}`);actual[name]=digest;
  }
  const snapshotHash=createHash('sha256').update(Object.entries(actual).sort(([left],[right])=>left<right?-1:left>right?1:0).map(([name,digest])=>`${name}\u0000${digest}`).join('\n')).digest('hex');
  if(snapshotHash!==MEDLOCOMO_EMBEDDING_SNAPSHOT_HASH)throw new Error('MedLoCoMo embedding aggregate snapshot hash mismatch');
  return{snapshot_hash:snapshotHash,snapshot_file_hashes:Object.freeze(actual)};
}
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
