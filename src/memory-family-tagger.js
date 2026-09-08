import { MEMORY_FAMILIES } from './schema.js';

const ROUTER_BATCH_SIZE=8;

export function normalizeMemoryTagsOutput(value,memoryNodes=[]){
  const familyMatrix=Array.isArray(value?.families)&&value.families.every(Array.isArray)?value.families:null;
  if(!familyMatrix)return value;
  const routes=familyMatrix.map(families=>({families}));
  const normalized=[],warnings=[];
  routes.forEach((rawRoute,index)=>{
    const route=rawRoute&&typeof rawRoute==='object'?rawRoute:{},source=memoryNodes[index];
    const rawFamilies=Array.isArray(route.families)?route.families.map(family=>String(family||'').trim()):route.families;
    const families=deduplicateRouteFamilies(rawFamilies,source,{routeIndex:index,routeId:String(index),warnings});
    normalized.push({...source,families});
  });
  Object.defineProperty(normalized,'warnings',{value:warnings,enumerable:false});
  return normalized;
}

function deduplicateRouteFamilies(families,memoryNode,{routeIndex,routeId,warnings}){
  if(!Array.isArray(families)||families.length<2)return families;
  if(families.some(item=>routeFamilyValidationError(item,memoryNode)))return families;
  const output=[],seen=new Map();
  for(let index=0;index<families.length;index++){
    const family=families[index];
    if(!seen.has(family)){seen.set(family,index);output.push(family);continue;}
    warnings.push({warning_type:'exact_family_label_deduplicated',route_index:routeIndex,route_id:routeId,memory_id:memoryNode?.memory_id||null,family,kept_label_index:seen.get(family),removed_label_index:index,selection_basis:'exact_family'});
  }
  return output;
}

export function attachRouterWarnings(result){if(result?.value?.warnings?.length&&result.trace)result.trace.validation_warnings=result.value.warnings;return result;}

export async function tagMemoryWithFallback(gateway,input,memoryNodes,observation,options={}){
  if(options.per_batch_fail_open===true||options.deterministic_literal_provenance===true)return tagMemoryWithBoundedBatchFallback(gateway,input,memoryNodes,observation,options);
  try{
    if(memoryNodes.length<=ROUTER_BATCH_SIZE)return await gateway.completeJSON('router',input,value=>validateMemoryTags(materializeEmptyMemoryTags(normalizeMemoryTagsOutput(value,memoryNodes),memoryNodes),memoryNodes),()=>tagMemoryNodes(memoryNodes,observation));
    const batches=[];
    for(let offset=0;offset<memoryNodes.length;offset+=ROUTER_BATCH_SIZE){
      const batchMemory=memoryNodes.slice(offset,offset+ROUTER_BATCH_SIZE),batchInput=input.slice(offset,offset+ROUTER_BATCH_SIZE);
      batches.push({offset,promise:gateway.completeJSON('router',batchInput,value=>validateMemoryTags(materializeEmptyMemoryTags(normalizeMemoryTagsOutput(value,batchMemory),batchMemory),batchMemory),()=>tagMemoryNodes(batchMemory,observation))});
    }
    const completed=await Promise.all(batches.map(batch=>batch.promise)),routes=[],warnings=[];
    completed.forEach((result,batchIndex)=>{
      const offset=batches[batchIndex].offset;
      warnings.push(...(result.value?.warnings||[]).map(warning=>({...warning,route_index:Number(warning.route_index)+offset,route_id:String(Number(warning.route_id)+offset)})));
      result.value.forEach(route=>routes.push(route));
    });
    Object.defineProperty(routes,'warnings',{value:warnings,enumerable:false});
    validateMemoryTags(routes,memoryNodes);
    return{value:routes,trace:mergeRouterBatchTraces(completed.map(result=>result.trace),input,routes)};
  }catch(error){
    const routed=validateMemoryTags(tagMemoryNodes(memoryNodes,observation),memoryNodes),fallback=routed.map(route=>route),gatewayTrace=error?.gatewayTrace||null,warnings=[...(routed.warnings||[]),{warning_type:'router_model_output_fallback',fallback_policy:'deterministic_multi_family_memory_tagger',failure_kind:gatewayTrace?.error?.kind||'router_error',message:String(error?.message||error)}];
    Object.defineProperty(fallback,'warnings',{value:warnings,enumerable:false});
    return{value:fallback,trace:{...(gatewayTrace||{}),component:'router',model_input:input,parsed_response:fallback,error:null,fallback_used:true,model_validation_error:gatewayTrace?.error||{kind:'router_error',message:String(error?.message||error)},validation_warnings:warnings}};
  }
}

async function tagMemoryWithBoundedBatchFallback(gateway,input,memoryNodes,observation,options){
  const routes=new Array(memoryNodes.length),warnings=[],modelEntries=[];let literalProvenanceCount=0;
  for(let index=0;index<memoryNodes.length;index++){
    const node=memoryNodes[index];
    if(options.deterministic_literal_provenance===true&&node?.construction_kind==='literal_provenance'){
      routes[index]=tagMemoryNodes([node],observation)[0];literalProvenanceCount++;
      warnings.push({warning_type:'literal_provenance_family_tags_materialized',route_index:index,route_id:String(index),memory_id:node.memory_id,families:[...routes[index].families],selection_basis:'deterministic_source_attributed_taxonomy_no_llm'});
    }else modelEntries.push({index,node,input:input[index]});
  }
  const batches=[];
  for(let offset=0;offset<modelEntries.length;offset+=ROUTER_BATCH_SIZE)batches.push({batch_index:batches.length,entries:modelEntries.slice(offset,offset+ROUTER_BATCH_SIZE)});
  const concurrency=boundedInteger(options.bounded_batch_concurrency,1,8,3),completed=await mapWithConcurrency(batches,concurrency,async batch=>{
    const batchMemory=batch.entries.map(entry=>entry.node),batchInput=batch.entries.map(entry=>entry.input);
    try{
      const result=await gateway.completeJSON('router',batchInput,value=>validateMemoryTags(materializeEmptyMemoryTags(normalizeMemoryTagsOutput(value,batchMemory),batchMemory),batchMemory),()=>tagMemoryNodes(batchMemory,observation));
      return{...batch,value:result.value,trace:result.trace,failed:false};
    }catch(error){
      const value=validateMemoryTags(tagMemoryNodes(batchMemory,observation),batchMemory),gatewayTrace=error?.gatewayTrace||null;
      return{...batch,value,trace:gatewayTrace,failed:true,error:gatewayTrace?.error||{kind:'router_error',message:String(error?.message||error)}};
    }
  });
  for(const batch of completed){
    batch.entries.forEach((entry,localIndex)=>{routes[entry.index]=batch.value[localIndex];});
    warnings.push(...(batch.value?.warnings||[]).map(warning=>remapBatchWarning(warning,batch.entries)));
    if(batch.failed)warnings.push({warning_type:'router_model_output_batch_fallback',batch_index:batch.batch_index,route_indexes:batch.entries.map(entry=>entry.index),memory_ids:batch.entries.map(entry=>entry.node.memory_id),fallback_policy:'deterministic_multi_family_memory_tagger_for_failed_batch_only',failure_kind:batch.error?.kind||'router_error',message:String(batch.error?.message||'router batch failed')});
  }
  Object.defineProperty(routes,'warnings',{value:warnings,enumerable:false});
  validateMemoryTags(routes,memoryNodes);
  const failed=completed.filter(batch=>batch.failed),traces=completed.map(batch=>batch.trace).filter(Boolean),trace=mergeRouterBatchTraces(traces,input,routes);
  return{value:routes,trace:{...trace,component:'router',model_input:input,parsed_response:routes,error:null,fallback_used:failed.length>0,router_batch_size:ROUTER_BATCH_SIZE,router_batch_count:batches.length,router_batch_concurrency:batches.length?Math.min(concurrency,batches.length):0,router_successful_batch_count:batches.length-failed.length,router_failed_batch_count:failed.length,router_failed_batch_indexes:failed.map(batch=>batch.batch_index),literal_provenance_count:literalProvenanceCount,literal_provenance_routing:'deterministic_no_llm',batch_failure_policy:'failed_batch_only',validation_warnings:warnings}};
}

async function mapWithConcurrency(items,concurrency,fn){
  const output=new Array(items.length);let next=0;
  const workers=Array.from({length:Math.min(concurrency,items.length)},async()=>{while(true){const index=next++;if(index>=items.length)return;output[index]=await fn(items[index],index);}});
  await Promise.all(workers);return output;
}

function remapBatchWarning(warning,entries){
  const local=Number(warning?.route_index),entry=Number.isInteger(local)?entries[local]:null;
  return entry?{...warning,route_index:entry.index,route_id:String(entry.index),memory_id:entry.node.memory_id}:{...warning};
}

function boundedInteger(value,min,max,fallback){const number=Number(value);return Number.isInteger(number)?Math.max(min,Math.min(max,number)):fallback;}

function mergeRouterBatchTraces(traces,input,routes){
  const first=traces[0]||{},sum=key=>traces.reduce((total,trace)=>total+Number(trace?.[key]||0),0);
  return{...first,model_input:input,parsed_response:routes,latency_ms:Math.max(0,...traces.map(trace=>Number(trace?.latency_ms||0))),token_input:sum('token_input'),token_output:sum('token_output'),estimated_cost_usd:sum('estimated_cost_usd'),retries:sum('retries'),raw_model_response:JSON.stringify(traces.map(trace=>trace?.raw_model_response||'')),raw_model_attempts:traces.flatMap((trace,batch_index)=>(trace?.raw_model_attempts||[]).map(attempt=>({...attempt,batch_index}))),router_batch_size:ROUTER_BATCH_SIZE,router_batch_count:traces.length,router_batch_traces:traces};
}

export function validateMemoryTags(value,memoryNodes=[]){
  if(!Array.isArray(value))throw new Error('routes must be an array');
  if(value.length!==memoryNodes.length)throw new Error(`memory family tagger must return exactly ${memoryNodes.length} rows`);
  const seen=new Set();
  for(let index=0;index<value.length;index++){
    const route=value[index];
    if(!route?.memory_id||!Array.isArray(route.families))throw new Error('invalid memory family row');
    if(route.families.length===0)throw new Error('Memory Node requires at least one family label');
    if(route.memory_id!==memoryNodes[index]?.memory_id||seen.has(route.memory_id))throw new Error('Memory Nodes must appear exactly once in input order');
    seen.add(route.memory_id);
  }
  for(let index=0;index<value.length;index++)for(const family of value[index].families){const error=routeFamilyValidationError(family,memoryNodes[index]);if(error)throw new Error(error);}
  for(const route of value){const labelSeen=new Set();for(const family of route.families){if(labelSeen.has(family))throw new Error(`duplicate route family ${family}`);labelSeen.add(family);}}
  return value;
}

function routeFamilyValidationError(family){return MEMORY_FAMILIES.includes(family)?null:'invalid memory family';}

export function materializeEmptyMemoryTags(routes,memoryNodes=[]){
  if(!Array.isArray(routes))return routes;
  const warnings=[...(routes.warnings||[])],materialized=routes.map((route,index)=>{
    if(Array.isArray(route?.families)&&route.families.length)return route;
    const families=fallbackFamiliesForMemory(memoryNodes[index]||route);
    warnings.push({warning_type:'empty_family_tags_materialized',route_index:index,route_id:String(index),memory_id:memoryNodes[index]?.memory_id||route?.memory_id||null,families,selection_basis:'source_attributed_memory_taxonomy'});
    return{...route,families};
  });
  Object.defineProperty(materialized,'warnings',{value:warnings,enumerable:false});
  return materialized;
}

export function tagMemoryNodes(memoryNodes){
  const routes=memoryNodes.map(item=>{const declared=Array.isArray(item.families)?item.families.filter(family=>MEMORY_FAMILIES.includes(family)):[];return{...item,families:declared.length?declared:fallbackFamiliesForMemory(item)};});
  return materializeEmptyMemoryTags(routes,memoryNodes);
}

function fallbackFamiliesForMemory(item={}){
  const text=String(item.text||'').normalize('NFKC'),source=String(item.source_type||'structured').toLowerCase(),isQuestion=/[?？]\s*$/u.test(text),families=[],add=family=>{if(!families.includes(family))families.push(family);};
  const careCue=/(?:医生建议|医生要求|医生安排|医生决定|医生向患者解释|共同制定|治疗方案|监测要求|复诊|随访|计划|处置|调整|开始|继续|停止|重启|教育|告知|指导|建议|每天监测|按医生建议|doctor (?:recommends|advises|asks|arranges|decides|explains to the patient)|treatment plan|monitoring|follow-up|plan|education|instruction|counsel)/iu.test(text);
  const assessmentCue=/(?:医生诊断|医生评估|医生判断|医生认为|医生解释|临床评估|临床判断|综合证据评定|诊断为|检查(?:显示|发现|结果)|检验(?:显示|发现|结果)|量表(?:显示|结果)|\d\s*(?:%|mmol|mg|kg|mmhg|bpm|单位)|过敏|禁忌|并发症|病理生理|机制|doctor (?:diagnoses|assesses|judges|believes|explains)|clinical assessment|diagnos|test result|laboratory result|allerg|contraindication|complication|pathophysiolog|mechanism)/iu.test(text);
  const clinicalFactCue=/(?:血糖|血压|心率|体温|剂量|用药|服用|停用|停药|过敏|禁忌|风险|红旗|并发症|glucose|blood pressure|heart rate|dose|medication|stopped taking|allerg|contraindication|risk|complication)/iu.test(text);
  if(/(?:既往|病史|家庭|家人|职业|工作|教育|居住|经济|费用|自费|copay|医保|交通|资源|支持|生活事件|长期|history|family|work|job|school|education|housing|financial|insurance|transport|support|resource)/iu.test(text))add('BC');
  if(/(?:患者自述|患者报告|患者表示|患者披露|患者(?:最近|近期|目前|持续|反复|偶尔|有时|经常|仍然|已经|未|没有)|观察到患者|记录显示患者|感到|感觉|出现|未出现|没有出现|症状|疼痛|不适|恶心|呕吐|多尿|睡眠|入睡|醒来|乏力|无力|没劲|口渴|头晕|头痛|胸闷|心慌|出汗|呼吸|紧绷|流泪|视力|体重|食欲|情绪|焦虑|抑郁|依从|漏服|服用|停用|停药|注射|自我监测|生理状态|身体状态|patient (?:reports|describes|experiences|feels)|observed the patient|symptom|pain|nausea|vomit|polyuria|sleep|fatigue|thirst|dizz|headache|palpitation|sweat|breath|tearful|vision|weight|appetite|anxiety|depress|adher|missed|taking|stopped taking|inject|physiological state)/iu.test(text))add('PE');
  if(/(?:患者认为|患者觉得|患者担心|患者希望|患者目标|患者偏好|患者愿意|患者决定|患者理解|患者意识到|患者接受|患者同意|患者回应|患者承诺|我(?:觉得|认为|担心|希望|愿意|决定|意识到|接受|同意|承诺|会按)|真的不是.+吗|是不是.+[吗？?]|会不会|信念|误解|顾虑|意愿|信心|the patient (?:believes|thinks|worries|hopes|prefers|intends|understands|realizes|accepts|agrees|commits)|belief|concern|goal|preference|willingness|confidence)/iu.test(text))add('PA');
  if(assessmentCue||clinicalFactCue&&!careCue)add('CS');
  if(careCue)add('CP');
  if(!isQuestion&&/(?:改善|恶化|加重|减轻|下降|升高|恢复|复发|再次|首次|不再|未再|由.+(?:变为|变成|到|→)|从.+(?:变为|降至|升至)|较前|比以前|相比|更低|更高|频率.+(?:增加|减少)|治疗后|调整后|连续.+(?:天|周|月|次)|过去.+(?:天|周|月).+(?:均|多在|一直|持续|反复|维持|稳定)|每(?:天|晚|周|月).*(?:反复|持续|均|多在)|近期.+(?:一直|持续|反复|维持|稳定)|improv|worsen|increase|decrease|recover|recur|again|first|no longer|compared with|after treatment|after adjustment|consecutive|for the past .+(?:days?|weeks?|months?)|every (?:day|night|week|month)|remain(?:ed|s)? stable|persist(?:ed|s|ent)?|repeated(?:ly)?|→)/iu.test(text))add('LO');
  if(!families.length){if(source==='doctor')add('CP');else if(source==='patient')add(isQuestion?'PA':'PE');else add('CS');}
  return MEMORY_FAMILIES.filter(family=>families.includes(family));
}
