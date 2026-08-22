import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { ModelGateway } from './gateway.js';
import { communicationActionRequirements } from './prompts.js';
import { buildVersion } from './version.js';
import { STATE_FAMILIES, validateAction, validateEvidence, validateObservation, validatePatientGraphEdge, validateState, validateStateDelta } from './schema.js';
import { transcriptBlocks,transcriptContextForSpan } from './session-observation.js';

const DESCRIPTIONS = {
  observation_ingest:'校验并固定 benchmark 共有的患者、来源、session、turn、时间与原文；query 和评分字段不会进入核心系统。',
  atomic_evidence_extractor:'在完整 Session 语境中筛选值得长期保留的事实，过滤寒暄、安慰和重复表达，再拆分并语义重写为原子 Evidence。', multi_label_router:'把每条原子事实分配给一个或多个 State family；重复 family 会被确定性去除并记录 warning。',
  patient_graph_updater:'在同一张持久化 Patient Graph 中创建 BC/PE/PA/CS/CP/LO typed nodes，并写入带 Evidence、置信度和验证状态的 temporal / clinical-care edges。',
  action_policy:'直接根据当前 Patient 消息和六类 State 的当前记忆选择结构化行动。',
  response_generator:'只表达 Action Policy 已选择的行动，并遵守当前可见 State/Evidence 边界。',
  response_auditor:'检查回复是否遵守 Action Policy 和证据边界。',
  memory_commit:'历史 profile/对话只更新记忆，不生成 Doctor Agent 回复。',
  patient_memory_commit:'在任何回复生成前，先提交本轮 Patient observation、Evidence 和 State；后续回复失败也不丢失患者输入。',
  conversation_commit:'提交通过 Auditor 的 Doctor Agent 回复；阶段 2 编排器随后将其作为下一条 doctor observation 写回记忆。'
};

export class Pipeline {
  constructor(store, config = {}) { this.store=store; this.config=config; this.gateway=config.gateway || new ModelGateway(config.model || {provider:'mock',model:'careharness-rules-v1'}); this.componentGateways=config.componentGateways || {}; }
  gatewayFor(component) { return this.componentGateways[component] || this.gateway; }

  async preprocess(rawObservation) {
    const observation=validateObservation(rawObservation),prepared={observation};
    try {
      const extracted=await extractEvidenceWithRecovery(this.gatewayFor('extractor'),observation);
      attachEvidenceWarnings(extracted);prepared.evidence=extracted.value;prepared.extractorTrace=extracted.trace;
      prepared.routerInput=prepared.evidence.map((item,index)=>({id:String(index),text:item.text,source:item.source_type}));
      const routed=await routeWithFallback(this.gatewayFor('router'),prepared.routerInput,prepared.evidence,observation);
      attachRouterWarnings(routed);
      prepared.routes=routed.value;prepared.routerTrace=routed.trace;
    } catch(error) { prepared.error=error; }
    return prepared;
  }

  async run(rawObservation, options={}) {
    const prepared=options.prepared||null,observation=validateObservation(prepared?.observation||rawObservation);
    const phase=options.phase||'conversation';
    if(!['memory_build','conversation'].includes(phase))throw new Error('phase must be memory_build or conversation');
    const runContext={dataset:options.dataset||'core'};
    const now=new Date().toISOString(), version=buildVersion();
    const run={ id:randomUUID(), subject_id:observation.subject_id, dataset:runContext.dataset,
      status:'running', branch_kind:options.branch_kind || 'formal', seed:options.seed ?? 42,
      phase,config:{phase,feedback_of:options.feedback_of||null,model:this.gateway.publicConfig(),component_models:Object.fromEntries(Object.entries(this.componentGateways).map(([k,g])=>[k,g.publicConfig()]))}, version, created_at:now, updated_at:now };
    this.store.createRun(run); let ordinal=0; const traces=[];
    const step=(component,input,output,status='completed',gateway=null,error=null)=>{
      const trace={ordinal:ordinal++,component,description:DESCRIPTIONS[component] || `${component} typed updater`,status,input,output,diff:diff(input,output),gateway,error};
      traces.push(trace); this.store.saveTrace(run.id,trace); return output;
    };
    const breakpoint=async()=>{if(options.breakpoint)await options.breakpoint({run_id:run.id,traces:[...traces]});};
    try {
      const packet=step('observation_ingest',rawObservation,observation);
      await breakpoint();
      if(prepared?.error&&!prepared.evidence)throw prepared.error;
      const extracted=prepared?{value:prepared.evidence,trace:prepared.extractorTrace}:await extractEvidenceWithRecovery(this.gatewayFor('extractor'),packet);
      attachEvidenceWarnings(extracted);
      const evidence=step('atomic_evidence_extractor',{model_input:packet.raw_text,code_context:{observation_id:packet.observation_id,source_type:packet.source_type}},extracted.value,'completed',extracted.trace);
      await breakpoint();
      if(prepared?.error)throw prepared.error;
      const routerInput=prepared?.routerInput||evidence.map((item,index)=>({id:String(index),text:item.text,source:item.source_type}));
      const routedResult=prepared?{value:prepared.routes,trace:prepared.routerTrace}:await routeWithFallback(this.gatewayFor('router'),routerInput,evidence,observation);
      attachRouterWarnings(routedResult);
      const routes=step('multi_label_router',routerInput,routedResult.value,'completed',routedResult.trace);
      await breakpoint();
      const graphSnapshot=readPatientGraphSnapshot(this.store,observation.subject_id),historical=graphSnapshot.nodes,historicalEdges=graphSnapshot.edges;
      const graphInput={routes,graph:{node_count:historical.length,edge_count:historicalEdges.length,typed_node_counts:familyCounts(historical)}};
      let graphDelta;
      try{
        graphDelta=updatePatientGraph(routes,historical,historicalEdges,observation);
        graphDelta.nodes.forEach(validateState);graphDelta.edges.forEach(validatePatientGraphEdge);graphDelta.deltas.forEach(validateStateDelta);
      }catch(error){const failure={kind:'schema_error',message:String(error.message),validation_errors:error.errors||[],suggestion:'Inspect routed Evidence and Patient Graph node/edge invariants; every node and edge must remain patient-specific and Evidence-bound.'};step('patient_graph_updater',graphInput,null,'failed',null,failure);throw Object.assign(error,{publicError:{step:'patient_graph_updater',input:graphInput,raw_model_output:'',parsed_output:null,validation_errors:error.errors||[],message:String(error.message),suggestion:failure.suggestion}});}
      const built=graphDelta.nodes,builtEdges=graphDelta.edges,deltas=graphDelta.deltas;
      step('patient_graph_updater',graphInput,graphDelta);
      await breakpoint();
      const memory=currentMemory([...historical,...built]);
      const patientGraph={version:'careharness-patient-graph.v1',subject_id:observation.subject_id,node_count:historical.length+built.length,edge_count:historicalEdges.length+builtEdges.length,typed_node_counts:familyCounts([...historical,...built]),delta:{node_ids:built.map(node=>node.state_id),edge_ids:builtEdges.map(edge=>edge.edge_id)}};
      const isMock=[this.gateway,...Object.values(this.componentGateways)].every(g=>g.config.provider==='mock');
      if(phase==='memory_build'){
        const final={phase,observation,run_context:runContext,evidence,states:built,graph_edges:builtEdges,patient_graph:patientGraph,deltas,memory,response:null,version,mock:isMock};
        const commitInput={phase,observation_id:observation.observation_id,node_delta_count:deltas.length,edge_delta_count:builtEdges.length};let receipt=null;
        try{if(run.branch_kind==='formal')receipt=this.store.commitMemory(run.id,observation,evidence,built,builtEdges,{expected_graph_revision:graphSnapshot.revision});}
        catch(error){const failure=memoryCommitFailure(error);step('memory_commit',commitInput,{committed:false},'failed',null,failure);throw Object.assign(error,{publicError:{step:'memory_commit',input:commitInput,raw_model_output:'',parsed_output:{committed:false},message:failure.message,suggestion:failure.suggestion}});}
        step('memory_commit',commitInput,{committed:Boolean(receipt),receipt,next:'The versioned Patient Graph snapshot is ready for a future query.'});
        this.store.completeRun(run.id,final);
        return {...run,status:'completed',traces,final};
      }
      const patientCommitInput={observation_id:observation.observation_id,source_type:observation.source_type,node_delta_count:deltas.length,edge_delta_count:builtEdges.length};let patientReceipt=null;
      try{if(run.branch_kind==='formal')patientReceipt=this.store.commitMemory(run.id,observation,evidence,built,builtEdges,{expected_graph_revision:graphSnapshot.revision});}
      catch(error){const failure=memoryCommitFailure(error);step('patient_memory_commit',patientCommitInput,{committed:false,sequence:1},'failed',null,failure);throw Object.assign(error,{publicError:{step:'patient_memory_commit',input:patientCommitInput,raw_model_output:'',parsed_output:{committed:false},message:failure.message,suggestion:failure.suggestion}});}
      const patientCommit=step('patient_memory_commit',patientCommitInput,{committed:Boolean(patientReceipt),receipt:patientReceipt,sequence:1,next:'Action Policy reads the Patient Graph after the Patient observation has been committed.'});
      await breakpoint();
      const action=step('action_policy',{current_patient_message:observation.raw_text,memory:compactStates(memory)},actionPolicy(observation,memory));validateAction(action);
      await breakpoint();
      const generatorInput={action:action.type,current_patient_message:observation.raw_text,required_content:action.required_content,forbidden_content:action.forbidden_content,memory:compactStates(memory)};
      const genResult=await this.gatewayFor('generator').completeJSON('generator',generatorInput,x=>validateGenerated(normalizeGenerated(x,action)),()=>generateFromMemory(action,generatorInput));
      const generated=step('response_generator',generatorInput,genResult.value,'completed',genResult.trace);
      await breakpoint();
      const auditorInput={action:action.type,response:generated.response,required_content:action.required_content,forbidden_content:action.forbidden_content};
      const auditResult=await this.gatewayFor('auditor').completeJSON('auditor',auditorInput,x=>validateAudit(normalizeAudit(x,action,generated)),()=>audit(action,generated));
      const audited=step('response_auditor',auditorInput,auditResult.value,auditResult.value.passed?'completed':'failed',auditResult.trace);
      await breakpoint();
      if(!audited.passed)throw Object.assign(new Error('Response blocked by Auditor'),{publicError:{step:'response_auditor',input:auditorInput,raw_model_output:auditResult.trace.raw_model_response,parsed_output:audited,suggestion:'Inspect the Action Policy constraints and regenerate the response.'}});
      const final={phase,observation,run_context:runContext,evidence,states:built,graph_edges:builtEdges,patient_graph:patientGraph,deltas,memory,patient_memory_committed:patientCommit.committed,action,response:generated.response,audit:audited,response_evidence_ids:generated.citations,version,mock:isMock};
      step('conversation_commit',{action:action.type,response:generated.response,branch_kind:run.branch_kind},{response_ready:true,doctor_memory_pending:run.branch_kind==='formal',sequence:2});
      this.store.completeRun(run.id,final);
      return {...run,status:'completed',traces,final};
    } catch(error) {
      if(error.gatewayTrace && traces.at(-1)?.status!=='failed'){
        const names={extractor:'atomic_evidence_extractor',router:'multi_label_router',generator:'response_generator',auditor:'response_auditor',judge:'benchmark_judge'},component=names[error.gatewayTrace.component]||error.gatewayTrace.component;
        step(component,error.gatewayTrace.input,error.gatewayTrace.parsed_response||null,'failed',error.gatewayTrace,error.gatewayTrace.error);
      }
      const basePublicError=error.publicError ?? (error.gatewayTrace ? { step:error.gatewayTrace.component || 'pipeline', input:error.gatewayTrace.input || rawObservation,
        raw_model_output:error.gatewayTrace?.raw_model_response || '', parsed_output:error.gatewayTrace?.parsed_response || null,
        validation_errors:error.gatewayTrace?.error?.validation_errors || [], message:String(error.message), suggestion:error.gatewayTrace?.error?.suggestion || 'Inspect this step input/output, correct the data or model configuration, then rerun.' } :
        {step:'pipeline',input:rawObservation,raw_model_output:'',parsed_output:null,message:String(error.message),suggestion:'Inspect the last completed trace and retry from that step.'});
      const patientMemoryWritten=phase==='conversation'&&run.branch_kind==='formal'&&traces.some(trace=>trace.component==='patient_memory_commit'&&trace.output?.committed===true);
      const publicError=phase==='conversation'?{...basePublicError,write_progress:{sequence:1,role:'patient',committed:patientMemoryWritten,next_role:'doctor',doctor_committed:false},write_explanation:patientMemoryWritten?'Patient 消息已先写入记忆；失败发生在 Doctor 回复生成或审核阶段，无需重新写入 Patient 消息。':'Patient 消息尚未写入记忆。'}:basePublicError;
      this.store.failRun(run.id,publicError); throw Object.assign(error,{run_id:run.id,publicError});
    }
  }
}

function extractEvidence(o) {
  const transcript=transcriptBlocks(o.raw_text),blocks=transcript.length?transcript:[{content_start:0,content_end:o.raw_text.length,source_type:o.source_type,turn_id:o.turn_id,event_time:o.event_time}],segments=[];
  for(const block of blocks){const blockText=o.raw_text.slice(block.content_start,block.content_end),re=/[^。！？!?;；\n]+[。！？!?;；]?/gu;let match;while((match=re.exec(blockText))){const text=match[0].trim(),start=block.content_start+match.index;if(text.length>1)segments.push({text,start,end:start+text.length,source_type:block.source_type,turn_id:block.turn_id,event_time:block.event_time});}}
  return segments.map(s=>validateEvidence({evidence_id:randomUUID(),observation_id:o.observation_id,subject_id:o.subject_id,text:s.text,source_text:o.raw_text.slice(s.start,s.end),span:[s.start,s.end],source_type:s.source_type,episode_id:o.episode_id,turn_id:s.turn_id,event_time:s.event_time,certainty:1,polarity:'affirmed'}));
}

function isConversationalFiller(text){return(String(text).match(/[\p{L}\p{N}]/gu)||[]).length<2;}

function normalizeEvidenceOutput(value, observation) {
  let items = Array.isArray(value?.evidence) ? value.evidence : Array.isArray(value) ? value : null;
  if (items?.length === 1 && Array.isArray(items[0]?.atomic_evidence)) items = items[0].atomic_evidence;
  if (!items && Array.isArray(value?.atomic_evidence)) items = value.atomic_evidence;
  if (!Array.isArray(items)) return value;
  const evidence=[],warnings=[];
  items.forEach((item, index) => {
    const rawItem=item&&typeof item==='object'?item:{};
    let rewritten=String(typeof item==='string'?item:rawItem.text||rawItem.statement||'').trim();
    if(!rewritten){warnings.push({item_index:index,failure_reason:'missing_atomic_text'});return;}
    if(isConversationalFiller(rewritten,observation.source_type)){warnings.push({item_index:index,failure_reason:'filtered_non_memory_dialogue'});return;}
    if(languageMismatch(observation.raw_text,rewritten))warnings.push({item_index:index,failure_reason:'output_language_mismatch',expected_language:dominantLanguage(observation.raw_text)});
    evidence.push({
      evidence_id: `${observation.observation_id}:llm:${index}`,
      observation_id: observation.observation_id,
      subject_id: observation.subject_id,
      text: rewritten,
      source_type: observation.source_type,
      episode_id: observation.episode_id,
      source_session_id: observation.episode_id,
      turn_id: observation.turn_id,
      event_time: observation.event_time,
      certainty: typeof rawItem.certainty === 'number' ? rawItem.certainty : 1,
      polarity: ['affirmed','negated','uncertain'].includes(rawItem.polarity) ? rawItem.polarity : 'affirmed'
    });
  });
  Object.defineProperty(evidence,'warnings',{value:warnings,enumerable:false});
  return evidence;
}

function normalizeAndValidateEvidence(value,observation){
  const normalized=normalizeEvidenceOutput(value,observation);
  if(!Array.isArray(normalized))return normalized;
  const validated=normalized.map(validateEvidence);
  Object.defineProperty(validated,'warnings',{value:normalized.warnings||[],enumerable:false});
  return validated;
}
function attachEvidenceWarnings(result){if(result?.value?.warnings?.length&&result.trace)result.trace.validation_warnings=result.value.warnings;return result;}
async function extractEvidenceWithRecovery(gateway,observation){
  const validate=value=>normalizeAndValidateEvidence(value,observation);
  try{return await gateway.completeJSON('extractor',observation.raw_text,validate,()=>extractEvidence(observation));}
  catch(error){
    const trace=error?.gatewayTrace,attempts=Array.isArray(trace?.raw_model_attempts)?trace.raw_model_attempts:[];
    if(trace?.component!=='extractor'||trace?.error?.kind!=='truncated_output')throw error;
    let best=null;
    for(const attempt of attempts){
      const recoveredPayload=recoverCompleteEvidencePrefix(attempt?.raw);
      if(!recoveredPayload.evidence.length)continue;
      try{const value=validate(recoveredPayload);if(!best||value.length>best.value.length)best={value,attempt:Number(attempt.attempt)||0,recovered_item_count:recoveredPayload.evidence.length};}catch{}
    }
    if(!best?.value.length)throw error;
    best.value.warnings.push({warning_type:'truncated_extractor_prefix_recovered',recovery_policy:'validated_complete_evidence_items_only',source_attempt:best.attempt,recovered_item_count:best.recovered_item_count,accepted_evidence_count:best.value.length,discarded_incomplete_suffix:true});
    return{value:best.value,trace:{...trace,finish_reason:'length_recovered',parsed_response:best.value,error:null,recovery:{mode:'validated_complete_evidence_prefix',source_attempt:best.attempt,recovered_item_count:best.recovered_item_count,accepted_evidence_count:best.value.length,discarded_incomplete_suffix:true}}};
  }
}
function recoverCompleteEvidencePrefix(raw){
  const text=String(raw||''),match=/"evidence"\s*:\s*\[/u.exec(text);if(!match)return{evidence:[]};
  const evidence=[];let objectStart=-1,depth=0,inString=false,escaped=false;
  for(let index=match.index+match[0].length;index<text.length;index++){
    const character=text[index];
    if(escaped){escaped=false;continue;}
    if(character==='\\'&&inString){escaped=true;continue;}
    if(character==='"'){inString=!inString;continue;}
    if(inString)continue;
    if(character==='{'){if(depth===0)objectStart=index;depth++;continue;}
    if(character==='}'&&depth>0){depth--;if(depth===0&&objectStart>=0){try{const item=JSON.parse(text.slice(objectStart,index+1));if(item&&typeof item==='object'&&!Array.isArray(item))evidence.push(item);}catch{}objectStart=-1;}continue;}
    if(character===']'&&depth===0)break;
  }
  return{evidence};
}
function alignmentWarning(index,sourceText,failureReason,attempted){return{item_index:index,model_source_text:sourceText,failure_reason:failureReason,attempted_match_levels:attempted};}

function normalizeRoutesOutput(value, evidence=[]) {
  const familyMatrix=Array.isArray(value)&&value.every(Array.isArray)?value:Array.isArray(value?.families)&&value.families.every(Array.isArray)?value.families:null;
  const legacy=value?.routes??value;
  const routes=familyMatrix?familyMatrix.map(families=>({families})):Array.isArray(legacy)&&legacy.length===1&&Array.isArray(legacy[0]?.routes)&&legacy[0].routes.length>1?legacy[0].routes:Array.isArray(legacy)&&legacy.every(item=>item&&typeof item==='object'&&Array.isArray(item.routes)&&item.routes.length<=1)?legacy.map(item=>item.routes[0]||{families:[]}):legacy;
  if(!Array.isArray(routes))return routes;
  const normalized=[],warnings=[];
  routes.forEach((rawRoute,index)=>{
    const route=rawRoute&&typeof rawRoute==='object'?rawRoute:{},source=evidence[index];
    const rawFamilies=Array.isArray(route.families)?route.families.map(f=>String(f||'').trim()):route.families;
    const families=deduplicateRouteFamilies(rawFamilies,source,{routeIndex:index,routeId:String(index),warnings});
    normalized.push({...source,id:String(index),families});
  });
  Object.defineProperty(normalized,'warnings',{value:warnings,enumerable:false});
  return normalized;
}

function deduplicateRouteFamilies(families,evidence,{routeIndex,routeId,warnings}){
  if(!Array.isArray(families)||families.length<2)return families;
  // Never repair around an illegal taxonomy label. validateRoutes must still
  // reject every invalid candidate, including one that would be dropped.
  if(families.some(item=>routeFamilyValidationError(item,evidence)))return families;
  const output=[],seen=new Map();
  for(let index=0;index<families.length;index++){
    const family=families[index];
    if(!seen.has(family)){seen.set(family,index);output.push(family);continue;}
    warnings.push({
      warning_type:'exact_route_label_deduplicated',route_index:routeIndex,route_id:routeId,evidence_id:evidence?.evidence_id||null,
      family,kept_label_index:seen.get(family),removed_label_index:index,selection_basis:'exact_family'
    });
  }
  return output;
}

function attachRouterWarnings(result){if(result?.value?.warnings?.length&&result.trace)result.trace.validation_warnings=result.value.warnings;return result;}

const ROUTER_BATCH_SIZE=8;

async function routeWithFallback(gateway,input,evidence,observation){
  try{
    if(evidence.length<=ROUTER_BATCH_SIZE)return await gateway.completeJSON('router',input,value=>validateRoutes(normalizeRoutesOutput(value,evidence),evidence),()=>routeEvidence(evidence,observation));
    const batches=[];
    for(let offset=0;offset<evidence.length;offset+=ROUTER_BATCH_SIZE){
      const batchEvidence=evidence.slice(offset,offset+ROUTER_BATCH_SIZE),batchInput=input.slice(offset,offset+ROUTER_BATCH_SIZE);
      batches.push({offset,promise:gateway.completeJSON('router',batchInput,value=>validateRoutes(normalizeRoutesOutput(value,batchEvidence),batchEvidence),()=>routeEvidence(batchEvidence,observation))});
    }
    const completed=await Promise.all(batches.map(batch=>batch.promise)),routes=[],warnings=[];
    completed.forEach((result,batchIndex)=>{
      const offset=batches[batchIndex].offset;
      warnings.push(...(result.value?.warnings||[]).map(warning=>({...warning,route_index:Number(warning.route_index)+offset,route_id:String(Number(warning.route_id)+offset)})));
      result.value.forEach((route,index)=>routes.push({...route,id:String(offset+index)}));
    });
    Object.defineProperty(routes,'warnings',{value:warnings,enumerable:false});
    validateRoutes(routes,evidence);
    return{value:routes,trace:mergeRouterBatchTraces(completed.map(result=>result.trace),input,routes)};
  }catch(error){
    throw error;
  }
}

function mergeRouterBatchTraces(traces,input,routes){
  const first=traces[0]||{},sum=key=>traces.reduce((total,trace)=>total+Number(trace?.[key]||0),0);
  return{...first,model_input:input,parsed_response:routes,latency_ms:Math.max(0,...traces.map(trace=>Number(trace?.latency_ms||0))),token_input:sum('token_input'),token_output:sum('token_output'),estimated_cost_usd:sum('estimated_cost_usd'),retries:sum('retries'),raw_model_response:JSON.stringify(traces.map(trace=>trace?.raw_model_response||'')),raw_model_attempts:traces.flatMap((trace,batch_index)=>(trace?.raw_model_attempts||[]).map(attempt=>({...attempt,batch_index}))),router_batch_size:ROUTER_BATCH_SIZE,router_batch_count:traces.length,router_batch_traces:traces};
}

function locateContiguousQuote(input,quote){
  const attempted=['exact'],direct=input.indexOf(quote),second=direct<0?-1:input.indexOf(quote,direct+1);if(direct>=0&&second<0)return{span:[direct,direct+quote.length],level:'exact',score:1,attempted_match_levels:attempted};
  attempted.push('formatting');const source=formatNormalized(input),target=formatNormalized(quote),formatted=uniqueNormalizedMatch(source,target);
  if(formatted&&paragraphGapCount(input.slice(...formatted))<=1)return{span:formatted,level:'formatting',score:1,attempted_match_levels:attempted};
  attempted.push('fuzzy');const fuzzy=fuzzyQuoteMatch(input,quote);
  if(fuzzy.span)return{...fuzzy,level:'fuzzy',attempted_match_levels:attempted};
  return{span:null,failure_reason:fuzzy.failure_reason||'fuzzy_match_below_threshold',attempted_match_levels:attempted};
}

function formatNormalized(value){return normalizeMapped(value,{punctuation:false});}
function fuzzyNormalized(value){return normalizeMapped(value,{punctuation:true});}
function normalizeMapped(value,{punctuation}){
  const ignored=markdownIgnoredRanges(value),textParts=[],positions=[];
  for(let i=0;i<value.length;i++){
    if(ignored[i]||/\s/u.test(value[i]))continue;
    if(punctuation&&isIgnorablePunctuation(value,i))continue;
    const normalized=punctuation?value[i].normalize('NFKC'):value[i];
    for(const char of normalized){textParts.push(char.toLowerCase());positions.push(i);}
  }
  return{text:textParts.join(''),positions};
}
function markdownIgnoredRanges(value){
  const ignored=new Uint8Array(value.length),mark=(start,end)=>{for(let i=Math.max(0,start);i<Math.min(value.length,end);i++)ignored[i]=1;};
  const structural=/(^|\n)[ \t]*(?:[-*+][ \t]+\[[ xX]\][ \t]+|#{1,6}[ \t]+|>[ \t]?|[•·][ \t]+|[-*+][ \t]+|(?:\d{1,3}[.)、]|[（(]\d{1,3}[）)]|[一二三四五六七八九十]+、|[（(][一二三四五六七八九十]+[）)])[ \t]*)/gu;
  for(const match of value.matchAll(structural)){const prefix=match[0],offset=match.index+(prefix.startsWith('\n')?1:0);for(let i=offset;i<match.index+prefix.length;i++)if(!/\s/u.test(value[i]))ignored[i]=1;}
  for(const match of value.matchAll(/<\/?(?:br|strong|em|b|i|s|del|code|pre|ul|ol|li|p)(?:\s[^>]*)?\s*\/?>/giu))mark(match.index,match.index+match[0].length);
  for(const match of value.matchAll(/!?\[([^\]\n]+)\]\(([^)\n]+)\)/gu)){const label=match[1],labelOffset=match[0].indexOf(label),start=match.index;mark(start,start+labelOffset);mark(start+labelOffset+label.length,start+match[0].length);}
  for(const match of value.matchAll(/(?:\*\*|__|~~|```|`)/gu))mark(match.index,match.index+match[0].length);
  for(const re of [/(?<!\*)\*([^*\n]+)\*(?!\*)/gu,/(?<!_)_([^_\n]+)_(?!_)/gu])for(const match of value.matchAll(re)){mark(match.index,match.index+1);mark(match.index+match[0].length-1,match.index+match[0].length);}
  for(const match of value.matchAll(/\\(?=[\\`*_[\]{}()#+.!>~-])/gu))mark(match.index,match.index+1);
  return ignored;
}
function uniqueNormalizedMatch(source,target){
  if(!target.text)return null;const first=source.text.indexOf(target.text);if(first<0)return null;
  const second=source.text.indexOf(target.text,first+1);if(second>=0)return null;
  return[source.positions[first],source.positions[first+target.text.length-1]+1];
}
function isIgnorablePunctuation(value,index){
  const char=value[index],prev=value[index-1]||'',next=value[index+1]||'';
  if(/[.:：/\-+~～]/u.test(char)&&/\d/u.test(prev)&&/\d/u.test(next))return false;
  if(/[%％]/u.test(char)||(/[+\-−]/u.test(char)&&/\d/u.test(next)))return false;
  return /[，,.。:：！？!?；;“”"'‘’（）()【】\[\]《》<>、…—–]/u.test(char);
}
function fuzzyQuoteMatch(input,quote){
  const source=fuzzyNormalized(input),target=fuzzyNormalized(quote),threshold=.92;
  if(!source.text)return{span:null,failure_reason:'fuzzy_match_below_threshold'};const punctuationOnly=uniqueNormalizedMatch(source,target);if(punctuationOnly){const raw=input.slice(...punctuationOnly);return protectedTokensMatch(quote,raw)?{span:punctuationOnly,score:1}:{span:null,failure_reason:'protected_medical_token_mismatch'};}if(target.text.length<8)return{span:null,failure_reason:'fuzzy_match_below_threshold'};
  const anchors=[],anchorLength=Math.min(6,Math.max(3,Math.floor(target.text.length/4))),offsets=[0,Math.max(0,Math.floor((target.text.length-anchorLength)/2)),Math.max(0,target.text.length-anchorLength)];
  for(const offset of new Set(offsets)){const anchor=target.text.slice(offset,offset+anchorLength);let at=source.text.indexOf(anchor);while(at>=0){anchors.push(at-offset);at=source.text.indexOf(anchor,at+1);}}
  const candidates=new Map(),delta=Math.max(2,Math.min(8,Math.ceil(target.text.length*.08)));let protectedMismatch=false;
  for(const approximate of anchors)for(let start=Math.max(0,approximate-delta);start<=Math.min(source.text.length-1,approximate+delta);start++)for(let length=Math.max(1,target.text.length-delta);length<=target.text.length+delta&&start+length<=source.text.length;length++){
    const key=`${start}:${length}`;if(candidates.has(key))continue;const candidate=source.text.slice(start,start+length),score=1-levenshtein(target.text,candidate)/Math.max(target.text.length,candidate.length),rawStart=source.positions[start],rawEnd=source.positions[start+length-1]+1,raw=input.slice(rawStart,rawEnd);
    if(score>=threshold&&!protectedTokensMatch(quote,raw)){protectedMismatch=true;continue;}if(score>=threshold&&paragraphGapCount(raw)<=2)candidates.set(key,{span:[rawStart,rawEnd],score});
  }
  const ranked=[...candidates.values()].sort((a,b)=>b.score-a.score||a.span[0]-b.span[0]),best=ranked[0];
  if(!best)return{span:null,failure_reason:protectedMismatch?'protected_medical_token_mismatch':anchors.length?'fuzzy_match_below_threshold':'formatting_tolerant_match_failed'};
  const materiallyDifferent=ranked.find(item=>item!==best&&(item.span[0]!==best.span[0]||item.span[1]!==best.span[1]));
  if(materiallyDifferent&&best.score-materiallyDifferent.score<.03)return{span:null,failure_reason:'ambiguous_fuzzy_match'};
  return best;
}
function levenshtein(a,b){const previous=Array.from({length:b.length+1},(_,i)=>i),current=new Array(b.length+1);for(let i=1;i<=a.length;i++){current[0]=i;for(let j=1;j<=b.length;j++)current[j]=Math.min(current[j-1]+1,previous[j]+1,previous[j-1]+(a[i-1]===b[j-1]?0:1));for(let j=0;j<=b.length;j++)previous[j]=current[j];}return previous[b.length];}
function paragraphGapCount(value){return(value.match(/\n\s*\n/gu)||[]).length;}
function protectedTokensMatch(quote,candidate){
  const signature=value=>JSON.stringify(String(value).normalize('NFKC').toLowerCase().match(/[-+]?\d+(?:\.\d+)?(?:\s*[.:/\-～~]\s*\d+(?:\.\d+)?)?/gu)||[]);
  return signature(quote)===signature(candidate);
}
function dominantLanguage(value){const han=(String(value).match(/[\p{Script=Han}]/gu)||[]).length,latin=(String(value).match(/[A-Za-z]/g)||[]).length;return han>latin*.3?'zh':'en';}
function languageMismatch(input,output){if(!String(output).trim())return false;const expected=dominantLanguage(input),actual=dominantLanguage(output);return expected!==actual&&((expected==='zh'&&(output.match(/[A-Za-z]/g)||[]).length>8)||(expected==='en'&&(output.match(/[\p{Script=Han}]/gu)||[]).length>2));}

function compactStates(states=[]) {
  return states.map((state,index)=>({
    id:String(index),family:state.family,value:state.value,polarity:state.polarity,status:state.status
  }));
}

function modelOutput(value){return value?.output&&typeof value.output==='object'?value.output:value||{};}
function strings(value,fallback=[]){return Array.isArray(value)?value.filter(item=>typeof item==='string'&&item.trim()):fallback;}

function normalizeGenerated(value,action){
  const output=modelOutput(value);
  return {action_type:action.type,response:String(output.response||'').trim(),citations:action.required_evidence_ids};
}

function normalizeAudit(value,action,generated){
  const deterministic=audit(action,generated), output=modelOutput(value);
  const violations=[...new Set([...deterministic.violations,...strings(output.violations)])];
  const passed=deterministic.passed&&output.passed===true&&violations.length===0;
  return {passed,violations,grounded_evidence_ids:generated.citations||[],blocked_response:passed?null:generated.response,
    safe_response:passed?(typeof output.safe_response==='string'&&output.safe_response.trim()?output.safe_response:generated.response):deterministic.safe_response};
}

function rewriteAtomic(text){return String(text||'').normalize('NFKC').trim();}

function validateRoutes(value,evidence=[]){
  if(!Array.isArray(value))throw new Error('routes must be an array');
  if(value.length!==evidence.length)throw new Error(`router must return exactly ${evidence.length} routes`);
  const seen=new Set();
  for(let index=0;index<value.length;index++){
    const route=value[index],expectedId=String(index);
    if(!route?.evidence_id||!Array.isArray(route.families))throw new Error('invalid route');
    if(route.id!==expectedId||route.evidence_id!==evidence[index]?.evidence_id||seen.has(route.id))throw new Error('router ids must appear exactly once in input order');
    seen.add(route.id);
  }
  // Validate every candidate label before checking duplicates, so
  // deduplication can never conceal an illegal family.
  for(let index=0;index<value.length;index++)for(const item of value[index].families){const validationError=routeFamilyValidationError(item,evidence[index]);if(validationError)throw new Error(validationError);}
  for(const route of value){
    const labelSeen=new Set();
    for(const family of route.families){if(labelSeen.has(family))throw new Error(`duplicate route family ${family}`);labelSeen.add(family);}
  }
  return value;
}

function routeFamilyValidationError(family,evidence={}){
  if(!STATE_FAMILIES.includes(family))return'invalid route family';
  return null;
}

function routeEvidence(evidence){return evidence.map((item,index)=>({...item,id:String(index),families:Array.isArray(item.families)?item.families.filter(family=>STATE_FAMILIES.includes(family)):[]}));}

function updatePatientGraph(routes,historicalNodes,historicalEdges,o){
  const nodes=[],deltas=[];
  for(const family of STATE_FAMILIES)for(const route of routes.filter(item=>item.families.includes(family))){
    const sameFamily=[...historicalNodes,...nodes].filter(node=>node.family===family),closest=[...sameFamily].sort((a,b)=>genericTextSimilarity(route.text,b.value)-genericTextSimilarity(route.text,a.value))[0],factorKey=closest&&genericTextSimilarity(route.text,closest.value)>=.62?stateFactorKey(closest):memoryTopicKey(route.text),owned=sameFamily.filter(node=>stateFactorKey(node)===factorKey),ordered=[...owned].sort(compareGraphChronology),newOrder=graphEventOrder(route),prior=Number.isFinite(newOrder)?[...ordered].reverse().find(node=>graphEventOrder(node)<=newOrder):ordered.at(-1),successor=Number.isFinite(newOrder)?ordered.find(node=>graphEventOrder(node)>newOrder):null;let operation='ADD';
    if(prior){
      if(String(prior.polarity||'affirmed')!==String(route.polarity||'affirmed'))operation='CONFLICT';else operation=equivalentStateFact(prior,route)?'NOOP':'UPDATE';
    }
    const conflictTarget=operation==='CONFLICT'?(prior?.status==='conflict'?prior.conflicts_with||prior.state_id:prior?.state_id||null):null;
    const state={state_id:randomUUID(),subject_id:o.subject_id,family,factor_key:factorKey,factor_domains:factorDomains(family),value:route.text,status:operation==='CONFLICT'?'conflict':'active',source_type:route.source_type,event_time:route.event_time,valid_from:route.event_time||null,episode_id:route.episode_id,source_session_id:route.source_session_id||route.episode_id,turn_id:route.turn_id,certainty:route.certainty,polarity:route.polarity,evidence_ids:[route.evidence_id],version:Math.max(0,...owned.map(item=>Number(item.version)||0))+1,version_chain:[...(prior?.version_chain||[]),...(prior?[prior.state_id]:[])],predecessor_state_id:prior?.state_id||null,successor_state_id:successor?.state_id||null,supersedes:null,conflicts_with:conflictTarget,resolves:null,operation};
    nodes.push(state);deltas.push({operation,family,state_id:state.state_id,prior_state_id:prior?.state_id||null,evidence_id:route.evidence_id});
  }
  return{version:'patient-graph-updater.v1',nodes,edges:buildPersistentGraphEdges(nodes,historicalNodes,historicalEdges),deltas,typed_node_counts:familyCounts(nodes)};
}

function buildPersistentGraphEdges(nodes,historicalNodes,historicalEdges){
  const edges=[],known=new Set(historicalEdges.map(edge=>graphEdgeKey(edge))),nodeById=new Map([...historicalNodes,...nodes].map(node=>[String(node.state_id),node]));
  const add=({from,to,edge_family,relation_type,evidence_ids,status='verified',confidence=1,support_kind='structural',source})=>{
    if(!from||!to||from===to||!nodeById.has(String(from))||!nodeById.has(String(to)))return;
    const evidenceIds=[...new Set((evidence_ids||[]).filter(Boolean).map(String))];if(!evidenceIds.length)return;
    const candidate={edge_id:randomUUID(),subject_id:nodeById.get(String(from)).subject_id,from_state_id:String(from),to_state_id:String(to),edge_family,relation_type,evidence_ids:evidenceIds,confidence:Math.max(0,Math.min(1,Number(confidence)||0)),support_kind,status,verified:status==='verified',persistent:true,causal_claim:false,source,created_episode_id:nodeById.get(String(to)).episode_id||null};
    const key=graphEdgeKey(candidate);if(known.has(key))return;known.add(key);edges.push(candidate);
  };
  for(const node of nodes){
    const priorId=node.operation==='CONFLICT'?node.conflicts_with:node.predecessor_state_id||node.supersedes||node.resolves||(node.version_chain||[]).at(-1),prior=nodeById.get(String(priorId||''));
    if(prior){
      const base={evidence_ids:[...(prior.evidence_ids||[]),...(node.evidence_ids||[])],edge_family:'temporal',confidence:1,support_kind:'structural',source:'version_transition'};
      if(node.operation==='SUPERSEDE')add({...base,from:node.state_id,to:prior.state_id,relation_type:'supersedes'});
      else if(node.operation==='CONFLICT')add({...base,from:node.state_id,to:prior.state_id,relation_type:'conflicts'});
      else if(node.operation==='RESOLVE')add({...base,from:node.state_id,to:prior.state_id,relation_type:'resolves'});
      else if(node.operation==='NOOP')add({...base,from:prior.state_id,to:node.state_id,relation_type:'persists'});
      else add({...base,from:prior.state_id,to:node.state_id,relation_type:'updates'});
    }
    const successor=nodeById.get(String(node.successor_state_id||''));
    if(successor&&node.status!=='conflict'&&successor.status!=='conflict')add({from:node.state_id,to:successor.state_id,edge_family:'temporal',relation_type:'updates',evidence_ids:[...(node.evidence_ids||[]),...(successor.evidence_ids||[])],confidence:1,support_kind:'structural',source:'backfill_successor_transition'});
  }
  const byEvidence=new Map();for(const node of nodes)for(const evidenceId of node.evidence_ids||[]){const group=byEvidence.get(String(evidenceId))||[];group.push(node);byEvidence.set(String(evidenceId),group);}
  const order=new Map(STATE_FAMILIES.map((family,index)=>[family,index]));
  for(const[evidenceId,group]of byEvidence){
    const sorted=[...group].sort((a,b)=>order.get(a.family)-order.get(b.family));
    for(let left=0;left<sorted.length;left++)for(let right=left+1;right<sorted.length;right++){
      const from=sorted[left],to=sorted[right];
      add({from:from.state_id,to:to.state_id,edge_family:'clinical_care',relation_type:'informs',evidence_ids:[evidenceId],confidence:.35,support_kind:'hypothesized',status:'candidate',source:'shared_atomic_evidence_candidate'});
    }
  }
  return edges;
}
function graphEdgeKey(edge){return[edge.from_state_id,edge.to_state_id,edge.edge_family,edge.relation_type].map(String).join('\u0000');}
function familyCounts(nodes){return Object.fromEntries(STATE_FAMILIES.map(family=>[family,nodes.filter(node=>node.family===family).length]));}
function factorDomains(family){return[family.toLowerCase()];}
function graphEventOrder(node){const parsed=Date.parse(node?.event_time||'');if(Number.isFinite(parsed))return parsed;const match=/(?:session|episode|admission|encounter)-(\d+)/i.exec(node?.episode_id||'');return match?Number(match[1]):NaN;}
function compareGraphChronology(a,b){const left=graphEventOrder(a),right=graphEventOrder(b);if(Number.isFinite(left)&&Number.isFinite(right)&&left!==right)return left-right;if(Number.isFinite(left)!==Number.isFinite(right))return Number.isFinite(left)?1:-1;return(Number(a?.version)||0)-(Number(b?.version)||0);}
function memoryTopicKey(text){const normalized=normalizeFactAssertion(text),grams=characterGrams(normalized,2);return grams.slice(0,12).join('')||normalized.slice(0,48)||'empty';}
function stateFactorKey(state){return String(state?.factor_key||memoryTopicKey(state?.value||''));}
function normalizeFactAssertion(text){
  return String(text||'').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu,'');
}
function quantitativeFactSignature(text){
  return [...String(text||'').normalize('NFKC').toLowerCase().matchAll(/[-+]?(?:\d+(?:\.\d+)?|\.\d+)\s*(?:%|mg|mcg|g|kg|ml|l|mmol\/?l|mg\/?dl|mmhg|bpm|iu|u|单位|毫克|微克|克|千克|毫升|升)?/giu)]
    .map(match=>match[0].replace(/\s+/gu,'')).join('|');
}
function equivalentStateFact(prior,next){
  const left=String(prior?.value||''),right=String(next?.text||next?.value||'');
  return String(prior?.polarity||'affirmed')===String(next?.polarity||'affirmed')
    &&normalizeFactAssertion(left)===normalizeFactAssertion(right)
    &&quantitativeFactSignature(left)===quantitativeFactSignature(right);
}
function characterGrams(value,size){const out=[];for(let index=0;index<=value.length-size;index++)out.push(value.slice(index,index+size));return[...new Set(out)];}
function genericTextSimilarity(left,right){const a=new Set(characterGrams(normalizeFactAssertion(left),2)),b=new Set(characterGrams(normalizeFactAssertion(right),2));if(!a.size||!b.size)return 0;let hits=0;for(const gram of a)if(b.has(gram))hits++;return hits/Math.max(a.size,b.size);}
function currentMemory(states){const latest=new Map();for(const state of states){const key=`${state.family}|${stateFactorKey(state)}`,prior=latest.get(key);if(!prior||compareGraphChronology(prior,state)<=0)latest.set(key,state);}return [...latest.values()];}

function actionPolicy(observation,states){const conflict=states.some(item=>item.status==='conflict'),uncertain=states.some(item=>item.polarity==='uncertain'||Number(item.certainty)<.8),type=conflict?'VERIFY':uncertain?'ASK':'ANSWER',ids=[...new Set(states.flatMap(item=>item.evidence_ids||[]))],requirements=communicationActionRequirements(type,{rememberedRisk:false,currentRisk:false});return{type,explanation:requirements.explanation,required_evidence_ids:ids,required_content:requirements.required_content,forbidden_content:requirements.forbidden_content};}
function validateGenerated(x){if(!x||typeof x.response!=='string'||!x.response.trim())throw new Error('generated response required');if(!x.action_type)throw new Error('action_type required');return x;}
function generateFromMemory(action,input){const response={ESCALATE:'你现在的安全最重要。请立即联系当地急救或危机支持，并尽快让一位可信任的人陪在你身边。你现在是否安全？是否有具体计划、可用手段或马上行动的可能？',VERIFY:'现有记忆中有冲突或时间不清。我们先核对具体来源和发生时间，再继续会更可靠。',ASK:'我想先确认一个关键信息：你说的不确定部分具体发生在什么时候，现在仍然如此吗？',ANSWER:input.memory.length?'我记得你之前提供的信息。结合你刚才说的内容，我们可以继续围绕当前变化和下一步安排来谈。':'我听到了你刚才说的内容。我们可以先从你现在最希望解决的部分开始。',REFUSE:'这个请求超出当前可安全处理的范围。'}[action.type]||'我听到了你刚才说的内容。';return{action_type:action.type,response,citations:action.required_evidence_ids};}
function validateAudit(x){if(typeof x?.passed!=='boolean'||!Array.isArray(x?.violations))throw new Error('invalid AuditResult');return x;}
function audit(action,g){const v=[];if(g.action_type!==action.type)v.push('Generator changed the Action Policy decision.');for(const x of action.forbidden_content)if(x&&g.response.includes(x))v.push(`Response includes forbidden content: ${x}`);if(action.type==='ESCALATE'&&!/急救|危机|emergency|crisis/i.test(g.response))v.push('Action Policy requires escalation language.');return{passed:v.length===0,violations:v,grounded_evidence_ids:g.citations||[],blocked_response:v.length?g.response:null,safe_response:v.length?'系统已阻止不符合 Action Policy 的回复。':g.response};}
function diff(a,b){const aa=JSON.stringify(a)??'null',bb=JSON.stringify(b)??'null';return {changed:aa!==bb,input_bytes:aa.length,output_bytes:bb.length,summary:aa===bb?'No structured change.':'Output produced or transformed fields; inspect raw JSON for exact values.'};}
function readPatientGraphSnapshot(store,subjectId){for(let attempt=0;attempt<3;attempt++){const before=store.graphRevisionFor(subjectId),nodes=store.graphNodesFor(subjectId),edges=store.graphEdgesFor(subjectId),after=store.graphRevisionFor(subjectId);if(before===after)return{revision:after,nodes,edges};}throw new Error(`Patient Graph for ${subjectId} changed repeatedly while being read; retry the observation`);}
function memoryCommitFailure(error){return{kind:/changed concurrently/i.test(String(error?.message||''))?'graph_revision_conflict':'memory_commit_error',message:String(error?.message||error),suggestion:/changed concurrently/i.test(String(error?.message||''))?'Retry this observation so graph versioning is recomputed from the latest patient revision.':'The Patient Graph transaction rolled back. Inspect node, edge, Evidence, and database constraints before retrying; no successful commit is claimed.'};}

export const pipelineInternals={extractEvidence,normalizeEvidenceOutput,normalizeRoutesOutput,validateRoutes,locateContiguousQuote,routeEvidence,routeWithFallback,updatePatientGraph,currentMemory,actionPolicy,generateFromMemory,audit};
