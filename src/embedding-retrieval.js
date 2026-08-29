// 来源：MedMemoryBench 官方 Embedding RAG 配置；任务：用
// BGE-small-zh-v1.5 为当前 Search Action 扩展词义相近的候选 Memory Node。
// 向量模型仅在本机运行；时间、来源、Family 和 Refine 边界仍由检索器硬过滤。
export const MEDMEMORY_EMBEDDING_MODEL='Xenova/bge-small-zh-v1.5';
export const MEDMEMORY_EMBEDDING_BASE_MODEL='BAAI/bge-small-zh-v1.5';

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
      missing.forEach((item,batchIndex)=>{const pending=promise.then(result=>normalizeVector(result[batchIndex]));this.pendingVectors.set(item.key,pending);rows[item.index]=pending;pending.finally(()=>this.pendingVectors.delete(item.key));});
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

function nodeText(node){return normalizeText([node?.text,node?.source_text].filter(Boolean).join('\n'));}
function cacheKey(id,text){return`${id}\u0000${text}`;}
function normalizeText(value){return String(value||'').normalize('NFKC').trim().slice(0,4000);}
function normalizeVector(value){const vector=Array.from(value||[],Number),norm=Math.sqrt(vector.reduce((sum,item)=>sum+item*item,0));return norm>0?vector.map(item=>item/norm):vector;}
function dot(left=[],right=[]){const length=Math.min(left.length,right.length);let score=0;for(let index=0;index<length;index++)score+=Number(left[index]||0)*Number(right[index]||0);return+score.toFixed(8);}
function dedupeNodes(value){const out=[],seen=new Set();for(const node of Array.isArray(value)?value:[]){const id=String(node?.memory_id||'');if(!id||seen.has(id))continue;seen.add(id);out.push(node);}return out;}
