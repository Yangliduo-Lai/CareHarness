import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { ModelGateway } from './gateway.js';
import { aliasesIn } from './medical-terms.js';
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
  for(const block of blocks){const blockText=o.raw_text.slice(block.content_start,block.content_end),re=/[^。！？!?;；\n]+[。！？!?;；]?/g;let match;
    while((match=re.exec(blockText))){const text=match[0].trim();if(!text)continue;const parts=text.split(/(?:，|,|\band\b|而且|并且|所以|because|but|但是)/i).map(x=>x.trim()).filter(x=>x.length>1);let cursor=block.content_start+match.index;
      for(const part of parts){const start=o.raw_text.indexOf(part,cursor);cursor=Math.max(start+part.length,cursor);if(start<0||isConversationalFiller(part,block.source_type))continue;segments.push({text:part,start,end:start+part.length,source_type:block.source_type,turn_id:block.turn_id,event_time:block.event_time});}
    }
  }
  return segments.map(s=>validateEvidence({evidence_id:randomUUID(),observation_id:o.observation_id,subject_id:o.subject_id,text:rewriteAtomic(s.text,s.source_type),source_text:o.raw_text.slice(s.start,s.end),span:[s.start,s.end],source_type:s.source_type,episode_id:o.episode_id,turn_id:s.turn_id,event_time:s.event_time,certainty:/可能|也许|maybe|might|不确定/i.test(s.text)?.55:1,polarity:/没有|否认|未|not |no /i.test(s.text)?'negated':/可能|也许|maybe|might/i.test(s.text)?'uncertain':'affirmed'}));
}

function isConversationalFiller(text,sourceType){
  const value=String(text).replace(/[*_~`>#•·]/gu,'').trim();
  if(/^(你好|您好|谢谢|感谢|不客气|再见|hello|hi|thanks?|thank you|you'?re welcome)[！!。.]*$/iu.test(value))return true;
  if(sourceType!=='doctor'&&!/^(?:医生|Doctor)/iu.test(value))return false;
  const supportive=/不会让你一个人|一个人在黑暗里摸索|我会(?:一直)?(?:在这里)?陪|我会一直在|替你松了?一口气|为你(?:感到)?骄傲|真的很不容易|我能感受到|我听得出来|你不是一个人|按你自己的节奏|不用(?:太)?紧张|不要给自己施加压力|我们可以继续围绕当前变化和下一步安排来谈/iu.test(value);
  const durable=/诊断|症状|疼|恶心|口渴|多尿|体重|视力|血糖|血压|检查|化验|数值|药|服用|停用|剂量|过敏|禁忌|风险|复诊|随访|监测|尿酮|急诊|安全计划|治疗|方案|建议|需要|应该|diagnos|symptom|pain|glucose|test|medicat|dose|allerg|risk|follow.?up|monitor|emergency|treatment|plan/iu.test(value);
  return supportive&&!durable;
}

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
    if(languageMismatch(observation.raw_text,rewritten)){
      warnings.push({item_index:index,failure_reason:'output_language_mismatch_repaired',expected_language:dominantLanguage(observation.raw_text)});
      rewritten=rewriteAtomic(rewritten,observation.source_type);
    }
    const uncertain = /可能|也许|不确定|maybe|might|possibly/i.test(rewritten);
    const negated = /没有|否认|从未|未曾|\bnot\b|\bno\b|never/i.test(rewritten);
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
      certainty: typeof rawItem.certainty === 'number' ? rawItem.certainty : uncertain ? 0.55 : 1,
      polarity: ['affirmed','negated','uncertain'].includes(rawItem.polarity) ? rawItem.polarity : uncertain ? 'uncertain' : negated ? 'negated' : 'affirmed'
    });
  });
  addExplicitMedicationCoverage(evidence,warnings,observation);
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

// The LLM remains the general-purpose extractor. This guard only closes a
// particularly costly silent-failure mode: an explicit, completed medication
// stop statement made by the Patient in the current Turn. Its only accepted
// grammar is the verified Session 6 shape: “我[时间词]把 <单一药名> 停了[之后]”.
// Every other language or medication-status grammar remains with the LLM.
function addExplicitMedicationCoverage(evidence,warnings,observation){
  const covered=new Set();
  for(const item of evidence){
    const source=String(item.text||'');
    if(/[?？]/u.test(source)||nonConfirmedMedicationStatement(source))continue;
    const statuses=explicitMedicationStatuses(source),medications=medicationTopicTokens(source);
    for(const medication of medications)for(const status of statuses)covered.add(`${medication}|${status}`);
  }
  for(const claim of explicitPatientMedicationClaims(observation)){
    const missing=claim.statuses.filter(status=>!covered.has(`${claim.medication}|${status}`));
    if(!missing.length)continue;
    const sourceText=observation.raw_text.slice(claim.start,claim.end),evidenceId=`${observation.observation_id}:coverage:medication:${claim.start}-${claim.end}:${claim.medication.slice('medication:'.length)}`;
    evidence.push({
      evidence_id:evidenceId,observation_id:observation.observation_id,subject_id:observation.subject_id,
      text:medicationCoverageText(sourceText,claim.statuses),
      source_type:observation.source_type,episode_id:observation.episode_id,source_session_id:observation.episode_id,
      turn_id:observation.turn_id,event_time:observation.event_time,certainty:1,polarity:'affirmed'
    });
    for(const status of claim.statuses)covered.add(`${claim.medication}|${status}`);
    warnings.push({
      warning_type:'coverage_guard_added',failure_reason:'model_omitted_explicit_patient_medication_fact',
      evidence_id:evidenceId,source_session_id:observation.episode_id,
      medication:claim.medication,statuses:claim.statuses,uncovered_statuses:missing
    });
  }
}

function explicitPatientMedicationClaims(observation){
  const transcript=transcriptBlocks(observation.raw_text),blocks=transcript.length?transcript:[{content_start:0,content_end:observation.raw_text.length,source_type:observation.source_type,turn_id:observation.turn_id,event_time:observation.event_time}],claims=[];
  for(const block of blocks){
    if(block.source_type!=='patient')continue;
    const blockText=observation.raw_text.slice(block.content_start,block.content_end),blockClaims=[];
    for(const sentenceMatch of blockText.matchAll(/[^。！？!?\n]+[。！？!?]?/gu)){
      const sentenceStart=block.content_start+sentenceMatch.index,sentence=sentenceMatch[0],clauseClaims=[];
      if(unsafeMedicationCoverageSentence(sentence))continue;
      for(const clauseMatch of sentence.matchAll(/[^，,；;]+[，,；;]?/gu)){
        const claim=explicitMedicationClaim(clauseMatch[0],sentenceStart+clauseMatch.index,block);
        if(claim)clauseClaims.push(...claim);
      }
      if(clauseClaims.length)blockClaims.push(...clauseClaims);
      else{const claim=explicitMedicationClaim(sentence,sentenceStart,block);if(claim)blockClaims.push(...claim);}
    }
    for(const claim of blockClaims)if(!unsafeMedicationCoverageContinuation(observation.raw_text.slice(claim.end,block.content_end)))claims.push(claim);
  }
  const shortestByFact=new Map();
  for(const claim of claims){
    const key=`${claim.turn_id}|${claim.medication}|${claim.statuses.join(',')}`,prior=shortestByFact.get(key);
    if(!prior||claim.end-claim.start<prior.end-prior.start)shortestByFact.set(key,claim);
  }
  return[...shortestByFact.values()].sort((a,b)=>a.start-b.start||a.medication.localeCompare(b.medication));
}

function explicitMedicationClaim(rawWindow,offset,block){
  const leading=rawWindow.search(/\S/u);if(leading<0)return null;
  const source=rawWindow.slice(leading).trimEnd(),start=offset+leading,end=start+source.length;
  if(!source||/[?？]/u.test(source)||nonConfirmedMedicationStatement(source))return null;
  const statuses=explicitMedicationStatuses(source),medications=medicationTopicTokens(source);
  // Never project one action across multiple drug entities. Ambiguous multi-drug
  // clauses stay with the LLM extractor instead of being rule-completed.
  if(!statuses.length||medications.length!==1||!directChineseMedicationStop(source,medications[0]))return null;
  return[{medication:medications[0],statuses,start,end,turn_id:block.turn_id,event_time:block.event_time}];
}

function explicitMedicationStatuses(value){
  const text=String(value||'');
  const stopped=/(?:已|已经|刚|刚刚|最近|这两天|前几天|今天|昨天|昨晚|本周|上周).{0,28}(?:停用|停服|停药|停止(?:服用|使用|用药)|停(?:了|掉了))|把.{0,30}停(?:了|掉了)|(?:停用|停服|停药|停止(?:服用|使用|用药)|停(?:了|掉了))(?:后|之后|以来|至今)|(?:停用|停服|停药).{0,20}了(?:[，,。；;！!]|$)|不再(?:吃|服用|使用|用药)/u.test(text);
  return stopped?['stopped']:[];
}

function nonConfirmedMedicationStatement(value){
  const text=String(value||'');
  const negatedAction=/(?:没有|没|未|并未|从未).{0,10}(?:停|开始|恢复|重启|服用|吃|使用)|\b(?:did not|didn't|have not|haven't|never)\b.{0,24}\b(?:stop|start|restart|resume|take|use)\b/iu.test(text);
  const intendedOrUncertain=/(?:可能|也许|或许|考虑|打算|计划|准备|是否|是不是|要不要|该不该).{0,18}(?:停|开始|恢复|重启|服用|吃|使用)|(?:想|希望).{0,10}(?:停|开始|恢复|重启|服用|吃|使用)|\b(?:maybe|might|perhaps|consider(?:ing)?|plan(?:ning)?|intend|want to|should|could|whether)\b.{0,28}\b(?:stop|start|restart|resume|take|use)\b/iu.test(text);
  const conditional=/(?:如果|假如|倘若|一旦|若|若是|要是|假设|假定|只要|除非|万一).{0,24}(?:停|开始|恢复|重启|服用|吃|使用)|(?:停|开始|恢复|重启|服用|吃|使用).{0,8}(?:的话|才会)|\b(?:if|unless|suppose|supposing|assuming|as long as|in case|provided that)\b.{0,32}\b(?:stop|start|restart|resume|take|use|discontinue|cease)\b/iu.test(text);
  const unrealized=/(?:差点|险些|差一点|几乎|本来(?:想|要)|原本(?:想|要)).{0,20}(?:停|开始|恢复|重启|服用|吃|使用)|\b(?:almost|nearly)\b.{0,24}\b(?:stopped?|started?|restarted?|resumed?|took|take|used?|using|discontinued?|ceased?)\b/iu.test(text);
  const unknown=/(?:不知道|不清楚|不确定).{0,16}(?:停|开始|恢复|重启|服用|吃|使用|剂量)|(?:停|开始|恢复|重启|服用|吃|使用|剂量).{0,16}(?:不知道|不清楚|不确定)|\b(?:do not know|don't know|unsure|uncertain)\b/iu.test(text);
  const epistemic=/(?:可能|大概|大约|也许|或许|估计|猜测|好像|似乎|据说|听说)|\b(?:maybe|possibly|probably|approximately|apparently|seem(?:s|ed)?|I think)\b/iu.test(text);
  const reportedDirective=/(?:医生|大夫|药师|护士).{0,12}(?:建议|让|要求|叫|说)|(?:医嘱|建议我|让我|要求我).{0,12}(?:停|开始|恢复|重启|服用|吃|使用)|\b(?:doctor|clinician|pharmacist|nurse)\b.{0,24}\b(?:recommended|suggested|told|asked)\b/iu.test(text);
  return negatedAction||intendedOrUncertain||conditional||unrealized||unknown||epistemic||reportedDirective;
}

function directChineseMedicationStop(value,medication){
  const names=MEDICATION_COVERAGE_NAMES[medication]||[],drug=names.map(escapeRegex).join('|');
  if(!drug)return false;
  const prefix='(?:(?:所以|然后|后来|但|不过)\\s*)?我(?!们)(?:自己)?',completed='(?:(?:已经|已|刚|刚刚|最近|这两天|前几天|今天|昨天|昨晚|本周|上周)\\s*)?',end='(?=$|[，,。；;！!])';
  return new RegExp(`^${prefix}${completed}把\\s*(?:${drug})\\s*停(?:了|掉了)(?:后|之后)?${end}`,'iu').test(String(value||''));
}

const MEDICATION_COVERAGE_NAMES=Object.freeze({
  'medication:empagliflozin':['恩格列净','empagliflozin'],'medication:metformin':['二甲双胍','metformin'],'medication:cefuroxime':['头孢呋辛','cefuroxime'],
  'medication:clarithromycin':['克拉霉素','clarithromycin'],'medication:amoxicillin':['阿莫西林','amoxicillin'],'medication:insulin':['胰岛素','insulin'],
  'medication:penicillin':['青霉素','penicillin'],'medication:omeprazole':['奥美拉唑','omeprazole'],'medication:sertraline':['舍曲林','sertraline'],
  'medication:acetaminophen':['对乙酰氨基酚','扑热息痛','acetaminophen'],'medication:ibuprofen':['布洛芬','ibuprofen']
});
function escapeRegex(value){return String(value).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}

function unsafeMedicationCoverageSentence(value){
  const text=String(value||'');
  if(medicationTopicTokens(text).length!==1)return true;
  if(medicationCoverageCorrection(text))return true;
  const kinds=[];
  if(/停用|停服|停药|停止(?:服用|使用|用药)|停(?:了|掉了)|不再(?:吃|服用|使用|用药)|\b(?:stopped|discontinued|ceased|no longer taking)\b/iu.test(text))kinds.push('stopped');
  if(medicationCoverageRestart(text))kinds.push('restarted');
  if(/(?:开始(?:吃|服用|使用|用药|用)|加用|启用)|\b(?:started taking|began taking|initiated)\b/iu.test(text)&&!kinds.includes('restarted'))kinds.push('started');
  if(/(?:正在|目前|现在|仍在|还在|一直|每天|每次|规律|按时).{0,16}(?:服用|吃|使用|用药)|\b(?:currently|still) taking\b/iu.test(text))kinds.push('current_use');
  return new Set(kinds).size>1;
}
function unsafeMedicationCoverageContinuation(value){const text=String(value||'');return medicationCoverageCorrection(text)||medicationCoverageRestart(text);}
function medicationCoverageCorrection(text){return/不对|说错(?:了)?|记错(?:了)?|更正|纠正|(?:其实)?(?:没有|没)\s*停/u.test(String(text||''));}
function medicationCoverageRestart(text){return/(?:重新开始|重新|恢复了?|继续|再次|又)(?:开始|重新)?(?:吃|服用|服|使用|用药|用)(?:上|了)?|(?:吃|服)上了|重启(?:服用|用药)?|\b(?:restart|resum)/iu.test(String(text||''));}

function medicationCoverageKey(turnId,medication,status){return`${turnId}|${medication}|${status}`;}
function medicationCoverageText(sourceText,statuses){
  let text=String(sourceText).replace(/[，,。；;]+$/u,'').replace(/^(?:所以|然后|后来|但|不过)\s*/u,'').trim();
  if(statuses.includes('stopped'))text=text.replace(/停了之后/gu,'停用后').replace(/停掉了|停了/gu,'停用');
  return rewriteAtomic(text,'patient');
}

function normalizeRoutesOutput(value, evidence=[]) {
  const familyMatrix=Array.isArray(value?.families)&&value.families.every(Array.isArray)?value.families:null;
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

async function routeWithFallback(gateway,input,evidence,observation){
  try{return await gateway.completeJSON('router',input,value=>validateRoutes(normalizeRoutesOutput(value,evidence),evidence),()=>routeEvidence(evidence,observation));}
  catch(error){
    if(!recoverableRouterModelFailure(error))throw error;
    const value=validateRoutes(routeEvidence(evidence,observation),evidence),modelError=error.gatewayTrace?.error||{kind:'model_or_parse_error',message:String(error.message||error)},warning={warning_type:'router_model_output_fallback',selection_basis:'deterministic_family_router',message:String(error.message||error)};
    return{value,trace:{...(error.gatewayTrace||{}),component:'router',parsed_response:value,error:null,model_validation_error:modelError,fallback_used:true,fallback_reason:warning.message,validation_warnings:[warning]}};
  }
}
function recoverableRouterModelFailure(error){return!/Provider HTTP|No API key|timeout|aborted|fetch failed|network|socket|ECONN|ENOTFOUND|truncated|max_tokens/i.test(String(error?.message||error));}

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
  const signature=value=>{const normalized=String(value).normalize('NFKC').toLowerCase(),numbers=normalized.match(/\d+(?:[.:/\-～~]\d+)*(?:%|mg\/g|mmol\/l|u\/ml)?/gu)||[],negations=normalized.match(/没有|并非|不是|未曾|从未|不再|否认|停用|停药|停止服用|\bnot\b|\bno\b|\bnever\b|without|discontinu\w*/giu)||[],certainty=normalized.match(/可能|也许|不确定|确定|明确|\bmaybe\b|\bmight\b|\bpossible\b|\bpossibly\b|\bconfirmed\b|\bdefinite(?:ly)?\b/giu)||[],medications=aliasesIn(normalized).filter(term=>/恩格列净|empagliflozin|二甲双胍|metformin|头孢呋辛|cefuroxime|克拉霉素|clarithromycin|阿莫西林|amoxicillin/i.test(term)).sort();return JSON.stringify({numbers,negations,certainty,medications});};
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

function rewriteAtomic(text,sourceType){const normalized=String(text).replace(/Prilosec/gi,'omeprazole').replace(/Zoloft/gi,'sertraline').replace(/Tylenol/gi,'acetaminophen').replace(/Advil/gi,'ibuprofen').trim(),chinese=dominantLanguage(normalized)==='zh';if(/^(患者|医生|记录|Profile|Patient|Doctor)[:：]/i.test(normalized))return normalized.replace(/^(Profile|Patient|Doctor)[:：]\s*/i,'');const subject=chinese?(sourceType==='doctor'?'医生':'患者'):(sourceType==='doctor'?'Doctor':'Patient');if(chinese)return /^(我|本人)/.test(normalized)?normalized.replace(/^(我|本人)/,subject):/^(患者|医生)/.test(normalized)?normalized:`${subject}${normalized}`;return /^I\b/i.test(normalized)?normalized.replace(/^I\b/i,subject):/^(Patient|Doctor)\b/i.test(normalized)?normalized:`${subject} ${normalized}`;}

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

function routeEvidence(evidence,o){return evidence.map((e,index)=>{
  const text=String(e.text||''),sourceType=e.source_type||o.source_type,families=[];
  const add=family=>{if(!families.includes(family))families.push(family);};
  const isQuestion=/[?？]/u.test(text),patientSource=sourceType==='patient',patientSubject=patientSource||/患者|来访者|当事人|\bpatient\b|\bclient\b/i.test(text);
  const confirmationQuestion=patientSubject&&isQuestion&&/(?:所以|那|也就是说|真的|是不是|难道|so\b|really|does that mean|is(?:n['’]t)? it)/i.test(text);
  if(isQuestion){if(confirmationQuestion)add('PA');return{...e,id:String(index),families};}

  const futureIntent=/愿意|计划|打算|准备|将会|我会|患者会|会按|承诺|希望|[Ww]ill|willing|plan(?:s|ned)? to|intend|commit/i.test(text);
  const patientAgreement=patientSubject&&/(?:我|患者)(?:愿意|同意|接受|承诺|会|将|可以|按.*(?:建议|计划))|(?:Patient|I) (?:will|agree|accept|am willing|can follow)/i.test(text);
  const doctorObservation=/观察到|会谈中|咨询中|表现为|显得|哭泣|observed|during (?:the )?session|appeared|was tearful/i.test(text);
  const thirdPartyObservation=/(?:家人|父母|母亲|父亲|伴侣|女友|男友|朋友|室友|同事|照护者).{0,18}(?:提到|发现|注意到|观察到|报告)|(?:family|parent|mother|father|partner|girlfriend|boyfriend|friend|roommate|colleague|caregiver).{0,30}(?:mentioned|noticed|observed|reported)/i.test(text);

  if(/既往史|既往病史|病史|既往患有|曾患有|家庭成员|家庭构成|家中有|已婚|未婚|关系|争执|冲突|矛盾|疏远|在校|学生|学校|大学|专业|学业|考试|工作|职业|项目赶工|赶工|加班|长期熬夜|独居|社交环境|生活处境|照顾负担|失业|离职|搬家|离婚|分手|丧亲|copay|付不起|无法承担|费用|异地医保|医保|保险|CGM|收入|房租|交通不便|家人支持|朋友支持|支持系统|支持资源|可求助|有人陪同|medical history|history of|family|relationship|student|school|college|university|education|academic|work|job|occupation|project deadline|overtime|lives alone|social context|life event|afford|cost|insurance|financial constraint|housing constraint|transport constraint|support system|trusted person/i.test(text))add('BC');

  const experienceSource=patientSubject||doctorObservation||thirdPartyObservation;
  if(experienceSource&&/症状|不舒服|疼|恶心|口渴|多尿|头晕|乏力|视力模糊|呼吸困难|焦虑|紧张|抑郁|难过|情绪|哭泣|痛苦|崩溃|不堪重负|睡眠|失眠|入睡|夜间醒来|功能受限|无法.*(?:工作|学习|生活)|身体反应|躯体反应|出汗|手抖|心慌|肌肉紧绷|服药|用药|吃药|服用|停药|停用|停服|漏服|漏药|未服|没有服药|测了|测过|监测了|自测|回避|逃避|不敢|应对|正念|呼吸练习|自伤|自杀|轻生|具体计划|手段|冲动|symptom|pain|nause|thirst|urinat|dizz|fatigue|blurred vision|shortness of breath|anxi|depress|sad|emotion|tearful|distress|overwhelm|sleep|insomnia|function|somatic response|sweat|trembl|palpitation|medication|taking|stopped|discontinued|missed dose|checked|monitored|tracked|avoid|coping|mindful|self[- ]?harm|suicid/i.test(text)&&!(futureIntent&&!patientAgreement))add('PE');

  if(patientSubject&&/自动想法|脑子里.*冒出|第一反应|误以为|错误地认为|一直以为|误解|担心|害怕|愿意|可以试试|偏好|更偏向|信心|可能性.*(?:%|％)|目标|希望|想要|相信|坚信|认定|认为|觉得|理解|意味着|看来|承诺|会按|坚持|automatic thought|first thought|misconception|mistakenly believed|worr|fear|concern|willing|open to|prefer|would rather|confiden|chance.*%|goal|hope|want|belie|think|interpret|means that|commit|will follow/i.test(text))add('PA');

  const clinicalJudgment=/红旗评估|红旗信号|危险信号|高风险|中风险|低风险|风险等级|自杀风险评估|自伤风险评估|风险评估|过敏|禁忌|不能碰|不得使用|量表|评分|PHQ-?9|GAD-?7|确诊|诊断为|查出来是|临床评估|综合评估|专业评估|临床判断|腰椎穿刺|眼底检查|手术|导管|透析|(?:检查|检验|化验)(?:显示|发现|结果|证实)|血糖.{0,16}(?:持续)?(?:偏高|偏低|恢复正常|控制欠佳|控制良好|异常)|(?:血压|心率|体温|脉搏|BMI|UACR|HbA1c|糖化血红蛋白|空腹血糖|餐后血糖|血糖|尿酮|酮体).{0,16}(?:为|是|达到|升至|降至|阳性|阴性|\+{1,4}|\d)|red.?flag assessment|risk level|high risk|moderate risk|low risk|risk assessment|allerg|contraindicat|scale|score|diagnosed|diagnosis|clinical assessment|clinical impression|procedure|surgery|(?:test|exam|laboratory) (?:showed|found|result|confirmed)|(?:blood pressure|heart rate|temperature|blood sugar|glucose|ketone).{0,16}(?:was|is|at|rose|fell|positive|negative|high|low|normal|abnormal|\d)/i.test(text);
  const medicationDirective=/建议|推荐|应该|计划|安排|要求|考虑|打算|是否|要不要|recommend|suggest|should|plan|consider|whether/i.test(text),medicationStatus=/正在(?:服用|使用)|目前(?:服用|使用)|当前(?:服用|使用)|已(?:经)?(?:停用|停服|停药)|用药状态|当前剂量|\b(?:currently taking|taking|stopped taking|discontinued|medication status|current dose)\b/i.test(text)||(!medicationDirective&&/(?:停用|停服|停药)(?:后|之后|了|至今|$)/i.test(text));
  if(clinicalJudgment||medicationStatus)add('CS');

  const documentedCareAction=/建议|推荐|应该|计划|安排|要求|制定|重启|开始|治疗|监测|测量|记录|练习|作业|联系|立即就医|转诊|出院|入院|住院|收治|随访|安全计划|危机热线|预警信号|解释|说明|告知|健康教育|recommend|suggest|should|plan|arrange|restart|start|follow.?up|treat|monitor|measure|track|assignment|contact|emergency|discharg|admit|hospital|refer|safety plan|crisis contact|hotline|warning sign|educat|explain|informed/i.test(text);
  if(documentedCareAction||patientAgreement)add('CP');

  if(/从.*(?:到|至|降至|升至|变为)|由.*(?:变为|转为)|→|比之前|较前|相比|改善|恶化|缓解|复发|再次出现|又出现|重新出现|越来越|频率.*(?:增加|减少)|次数.*(?:增加|减少)|治疗.*(?:有效|无效|反应)|服药.*(?:有效|无效|反应)|作业.*(?:完成|没完成|效果|结果)|目标.*(?:进展|完成|达成|接近)|上一次|跨.*(?:Session|Episode)|previously.*now|changed from.*to|decreas|increas|improv|wors|recurr|returned|again|frequency|more often|less often|treatment response|goal progress|cross[- ]?episode|compared with/i.test(text))add('LO');

  return{...e,id:String(index),families};
});}

function updatePatientGraph(routes,historicalNodes,historicalEdges,o){
  const nodes=[],deltas=[];
  for(const family of STATE_FAMILIES)for(const route of routes.filter(item=>item.families.includes(family))){
    const factorKey=memoryTopicKey(route.text),owned=[...historicalNodes,...nodes].filter(node=>node.family===family&&stateFactorKey(node)===factorKey),ordered=[...owned].sort(compareGraphChronology),newOrder=graphEventOrder(route),prior=Number.isFinite(newOrder)?[...ordered].reverse().find(node=>graphEventOrder(node)<=newOrder):ordered.at(-1),successor=Number.isFinite(newOrder)?ordered.find(node=>graphEventOrder(node)>newOrder):null;let operation='ADD';
    const correction=/纠正|更正|不是.*而是|actually|correction/i.test(route.text);
    if(prior){
      if(prior.status==='conflict')operation=correction||explicitConflictReconciliation(route.text)?'RESOLVE':'CONFLICT';
      else if(correction&&prior.source_type===route.source_type)operation='SUPERSEDE';
      else if(prior.source_type!==route.source_type&&opposite(prior.value,route.text))operation='CONFLICT';
      else if(resolvesPrior(prior,route))operation='RESOLVE';
      else if(equivalentStateFact(prior,route))operation='NOOP';
      else operation='UPDATE';
    }
    const conflictTarget=operation==='CONFLICT'?(prior?.status==='conflict'?prior.conflicts_with||prior.state_id:prior?.state_id||null):null;
    const state={state_id:randomUUID(),subject_id:o.subject_id,family,factor_key:factorKey,factor_domains:factorDomains(family,route.text),value:route.text,status:operation==='CONFLICT'?'conflict':operation==='RESOLVE'?'resolved':'active',source_type:route.source_type,event_time:route.event_time,valid_from:route.event_time||null,episode_id:route.episode_id,source_session_id:route.source_session_id||route.episode_id,turn_id:route.turn_id,certainty:route.certainty,polarity:route.polarity,evidence_ids:[route.evidence_id],version:Math.max(0,...owned.map(item=>Number(item.version)||0))+1,version_chain:[...(prior?.version_chain||[]),...(prior?[prior.state_id]:[])],predecessor_state_id:prior?.state_id||null,successor_state_id:successor?.state_id||null,supersedes:operation==='SUPERSEDE'?prior.state_id:null,conflicts_with:conflictTarget,resolves:operation==='RESOLVE'?prior?.state_id||null:null,operation};
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
      const from=sorted[left],to=sorted[right];let relation_type='informs';
      if(to.family==='CP'&&from.family==='BC')relation_type='constrains';
      else if(to.family==='CP'&&from.family==='PA')relation_type='motivates';
      else if(from.family==='CP'&&to.family==='LO'&&/(?:后|随后|之后|after|following)/i.test(to.value))relation_type='followed_by';
      else if(to.family==='LO'&&/(?:导致|促成|because|caused|due to)/i.test(to.value))relation_type='contributes_to';
      const asserted=relationExplicitlyAsserted(relation_type,`${from.value} ${to.value}`);
      add({from:from.state_id,to:to.state_id,edge_family:'clinical_care',relation_type,evidence_ids:[evidenceId],confidence:asserted?.confidence??.35,support_kind:asserted?'asserted':'hypothesized',status:'candidate',source:asserted?'unverified_explicit_relation_candidate':'shared_atomic_evidence_candidate'});
    }
  }
  for(const node of nodes){
    if(node.family!=='LO')continue;const currentOrder=graphEventOrder(node);if(!Number.isFinite(currentOrder))continue;
    const prior=[...historicalNodes].reverse().find(item=>item.family==='CP'&&sameMemoryTopic(item,node)&&Number.isFinite(graphEventOrder(item))&&graphEventOrder(item)<currentOrder);if(!prior)continue;
    add({from:prior.state_id,to:node.state_id,edge_family:'clinical_care',relation_type:'followed_by',evidence_ids:[...(prior.evidence_ids||[]),...(node.evidence_ids||[])],confidence:.55,support_kind:'hypothesized',status:'candidate',source:'time_ordered_same_factor_candidate'});
  }
  return edges;
}
function graphEdgeKey(edge){return[edge.from_state_id,edge.to_state_id,edge.edge_family,edge.relation_type].map(String).join('\u0000');}
function familyCounts(nodes){return Object.fromEntries(STATE_FAMILIES.map(family=>[family,nodes.filter(node=>node.family===family).length]));}
function relationExplicitlyAsserted(type,text){
  if(type==='followed_by'&&/(?:之后|随后|以后|服用后|治疗后|after|following|subsequent)/i.test(text))return{confidence:.95};
  if(type==='constrains'&&/(?:限制|无法|不能|妨碍|阻止|因为.{0,30}(?:无法|不能)|prevent|constrain|unable to|cannot|because.{0,40}(?:cannot|unable))/i.test(text))return{confidence:.9};
  if(type==='motivates'&&/(?:因此|所以|促使|出于.{0,30}(?:希望|偏好)|therefore|motivated|because.{0,30}(?:prefer|want|goal))/i.test(text))return{confidence:.85};
  return null;
}
function factorDomains(family,text){
  const value=String(text||''),domains=new Set(),biological=/病史|疾病|诊断|确诊|过敏|症状|疼|血糖|血压|检查|检验|化验|体重|medical history|disease|diagnos|allerg|symptom|pain|glucose|blood pressure|test result|weight/i.test(value),behavioral=/服药|用药|监测|饮食|运动|依从|漏服|停药|睡眠习惯|adher|taking|monitor|diet|exercise|sleep habit/i.test(value),social=/工作|家庭|照护者|经济|费用|住房|交通|支持|职业|保险|work|family|caregiver|financial|cost|housing|transport|support|occupation|insurance/i.test(value),psychological=/焦虑|担心|抑郁|情绪|害怕|偏好|目标|意愿|认为|anxi|worr|depress|fear|prefer|goal|willing|belie/i.test(value);
  if(['CS','LO'].includes(family)||biological)domains.add('biological');
  if(family==='PA'||psychological)domains.add('psychological');
  if(behavioral)domains.add('behavioral');
  if(social)domains.add('social');
  if(family==='CP')domains.add('care');
  if(!domains.size)domains.add(family==='BC'?'social':family==='PE'?'biological':family==='PA'?'psychological':family==='CP'?'care':'biological');
  return[...domains];
}
function graphEventOrder(node){const parsed=Date.parse(node?.event_time||'');if(Number.isFinite(parsed))return parsed;const match=/(?:session|episode|admission|encounter)-(\d+)/i.exec(node?.episode_id||'');return match?Number(match[1]):NaN;}
function compareGraphChronology(a,b){const left=graphEventOrder(a),right=graphEventOrder(b);if(Number.isFinite(left)&&Number.isFinite(right)&&left!==right)return left-right;if(Number.isFinite(left)!==Number.isFinite(right))return Number.isFinite(left)?1:-1;return(Number(a?.version)||0)-(Number(b?.version)||0);}
function hasNumber(x){return /\d/.test(String(x||''));} function opposite(a,b){return /(stop|停|未|没有|否认|not|no )/i.test(a)!==/(stop|停|未|没有|否认|not|no )/i.test(b);}
function sameMemoryTopic(a,b){
  return stateFactorKey(a)===memoryTopicKey(b.text||b.value);
}
function topicTokens(text){
  const value=String(text),medications=medicationTopicTokens(value),rules=[['self_harm',/自伤|自杀|轻生|self[- ]?harm|suicid/i],['medication',/服药|用药|吃药|停药|停用|停服|漏服|漏药|medication|medicine|taking|stopped|discontinued/i],['nausea',/恶心|nause/i],['anxiety',/焦虑|紧张|anxi/i],['sleep',/睡眠|失眠|sleep/i],['glucose',/血糖|glucose/i],['uacr',/UACR/i],['cost',/copay|付不起|费用|保险/i],['followup',/复诊|随访|follow.?up/i]];
  const general=rules.filter(([,pattern])=>pattern.test(value)).map(([key])=>key).filter(key=>key!=='medication'||medications.length===0);
  return[...medications,...general];
}
function medicationTopicTokens(text){
  const value=String(text||''),aliasSet=new Set(aliasesIn(value).map(term=>term.toLowerCase())),aliased=[
    ['empagliflozin',['恩格列净','empagliflozin']],['metformin',['二甲双胍','metformin']],['cefuroxime',['头孢呋辛','cefuroxime']],
    ['clarithromycin',['克拉霉素','clarithromycin']],['amoxicillin',['阿莫西林','amoxicillin']]
  ],explicit=[
    ['insulin',/胰岛素|\binsulin\b/i],['penicillin',/青霉素|\bpenicillin\b/i],['omeprazole',/奥美拉唑|\bomeprazole\b/i],
    ['sertraline',/舍曲林|\bsertraline\b/i],['acetaminophen',/对乙酰氨基酚|扑热息痛|\bacetaminophen\b/i],['ibuprofen',/布洛芬|\bibuprofen\b/i]
  ];
  const tokens=[];
  for(const [canonical,aliases]of aliased)if(aliases.some(alias=>aliasSet.has(alias.toLowerCase())))tokens.push(`medication:${canonical}`);
  for(const [canonical,pattern]of explicit)if(pattern.test(value))tokens.push(`medication:${canonical}`);
  return[...new Set(tokens)];
}
function isMedicationTopic(token){return String(token).startsWith('medication:');}
function normalizeTopic(text){return String(text||'').toLowerCase().replace(/患者|医生|记录|目前|最近|现在|[\s\p{P}\d]/gu,'');}
function memoryTopicKey(text){const value=String(text||''),tokens=topicTokens(value),medications=tokens.filter(isMedicationTopic);if(medications.length)return medications.join(',');const refined=tokens.map(token=>token==='glucose'?`glucose:${/空腹|fasting/i.test(value)?'fasting':/餐后|post.?prandial/i.test(value)?'postprandial':/糖化|hba1c/i.test(value)?'hba1c':'general'}`:token);return refined.join(',')||normalizeTopic(value);}
function stateFactorKey(state){return String(state?.factor_key||memoryTopicKey(state?.value||''));}
function normalizeFactAssertion(text){
  return String(text||'').normalize('NFKC').toLowerCase()
    .replace(/患者|医生|记录|目前|最近|现在/gu,'')
    .replace(/\b(?:patient|doctor|currently|current|recently|now)\b/gu,'')
    .replace(/[\s\p{P}\p{S}]/gu,'');
}
function quantitativeFactSignature(text){
  return [...String(text||'').normalize('NFKC').toLowerCase().matchAll(/[-+]?(?:\d+(?:\.\d+)?|\.\d+)\s*(?:%|mg|mcg|g|kg|ml|l|mmol\/?l|mg\/?dl|mmhg|bpm|iu|u|单位|毫克|微克|克|千克|毫升|升)?/giu)]
    .map(match=>match[0].replace(/\s+/gu,'')).join('|');
}
function medicationStatusSignature(text){
  const value=String(text||'').normalize('NFKC').toLowerCase(),statuses=[];
  const add=status=>{if(!statuses.includes(status))statuses.push(status);};
  if(/(?:正在|当前|目前).{0,8}(?:服用|使用)|\b(?:taking|currently using)\b/iu.test(value))add('taking');
  if(/停用|停服|停药|停止.{0,6}(?:服用|使用)|\b(?:stopped|discontinued|ceased)\b/iu.test(value))add('stopped');
  if(/漏服|漏药|未按时|\bmissed (?:a )?dose\b/iu.test(value))add('missed');
  if(/重启|重新开始|恢复.{0,6}(?:服用|使用)|\b(?:restarted|resumed)\b/iu.test(value))add('restarted');
  return statuses.sort().join('|');
}
function equivalentStateFact(prior,next){
  const left=String(prior?.value||''),right=String(next?.text||next?.value||'');
  return String(prior?.polarity||'affirmed')===String(next?.polarity||'affirmed')
    &&normalizeFactAssertion(left)===normalizeFactAssertion(right)
    &&quantitativeFactSignature(left)===quantitativeFactSignature(right)
    &&medicationStatusSignature(left)===medicationStatusSignature(right);
}
function explicitConflictReconciliation(text){return/(?:经|已)?(?:核实|核对|复核)(?:后)?(?:确认|证实)|双方(?:已经)?确认|冲突(?:已经)?(?:澄清|解决)|reconcil(?:ed|iation)|clarif(?:ied|ication)|(?:verified|confirmed) after (?:review|checking)/iu.test(String(text||''));}
function resolvesPrior(prior,next){return prior?.polarity!=='negated'&&(next?.polarity==='negated'||/(?:已|已经|目前)?(?:缓解|消失|恢复|解决|不再|没有)|resolved|no longer|went away/i.test(next?.text||next?.value||''));}
function currentMemory(states){const latest=new Map();for(const state of states){const key=`${state.family}|${stateFactorKey(state)}`,prior=latest.get(key);if(!prior||compareGraphChronology(prior,state)<=0)latest.set(key,state);}return [...latest.values()];}

function actionPolicy(observation,states){const conflict=states.some(x=>x.status==='conflict'),riskPattern=/自伤|自杀|轻生|具体计划|可用手段|self[- ]?harm|suicid/i,currentRisk=riskPattern.test(observation.raw_text),rememberedRisk=states.some(s=>s.family==='PE'&&riskPattern.test(s.value)&&s.polarity!=='negated');let type='ANSWER';if(currentRisk)type='ESCALATE';else if(conflict)type='VERIFY';else if(/不确定|不清楚|maybe|might/i.test(observation.raw_text))type='ASK';const ids=[...new Set(states.flatMap(s=>s.evidence_ids||[]))],requirements=communicationActionRequirements(type,{rememberedRisk,currentRisk});return{type,explanation:requirements.explanation,required_evidence_ids:ids,required_content:requirements.required_content,forbidden_content:requirements.forbidden_content};}
function validateGenerated(x){if(!x||typeof x.response!=='string'||!x.response.trim())throw new Error('generated response required');if(!x.action_type)throw new Error('action_type required');return x;}
function generateFromMemory(action,input){const response={ESCALATE:'你现在的安全最重要。请立即联系当地急救或危机支持，并尽快让一位可信任的人陪在你身边。你现在是否安全？是否有具体计划、可用手段或马上行动的可能？',VERIFY:'现有记忆中有冲突或时间不清。我们先核对具体来源和发生时间，再继续会更可靠。',ASK:'我想先确认一个关键信息：你说的不确定部分具体发生在什么时候，现在仍然如此吗？',ANSWER:input.memory.length?'我记得你之前提供的信息。结合你刚才说的内容，我们可以继续围绕当前变化和下一步安排来谈。':'我听到了你刚才说的内容。我们可以先从你现在最希望解决的部分开始。',REFUSE:'这个请求超出当前可安全处理的范围。'}[action.type]||'我听到了你刚才说的内容。';return{action_type:action.type,response,citations:action.required_evidence_ids};}
function validateAudit(x){if(typeof x?.passed!=='boolean'||!Array.isArray(x?.violations))throw new Error('invalid AuditResult');return x;}
function audit(action,g){const v=[];if(g.action_type!==action.type)v.push('Generator changed the Action Policy decision.');for(const x of action.forbidden_content)if(x&&g.response.includes(x))v.push(`Response includes forbidden content: ${x}`);if(action.type==='ESCALATE'&&!/急救|危机|emergency|crisis/i.test(g.response))v.push('Action Policy requires escalation language.');return{passed:v.length===0,violations:v,grounded_evidence_ids:g.citations||[],blocked_response:v.length?g.response:null,safe_response:v.length?'系统已阻止不符合 Action Policy 的回复。':g.response};}
function diff(a,b){const aa=JSON.stringify(a)??'null',bb=JSON.stringify(b)??'null';return {changed:aa!==bb,input_bytes:aa.length,output_bytes:bb.length,summary:aa===bb?'No structured change.':'Output produced or transformed fields; inspect raw JSON for exact values.'};}
function readPatientGraphSnapshot(store,subjectId){for(let attempt=0;attempt<3;attempt++){const before=store.graphRevisionFor(subjectId),nodes=store.graphNodesFor(subjectId),edges=store.graphEdgesFor(subjectId),after=store.graphRevisionFor(subjectId);if(before===after)return{revision:after,nodes,edges};}throw new Error(`Patient Graph for ${subjectId} changed repeatedly while being read; retry the observation`);}
function memoryCommitFailure(error){return{kind:/changed concurrently/i.test(String(error?.message||''))?'graph_revision_conflict':'memory_commit_error',message:String(error?.message||error),suggestion:/changed concurrently/i.test(String(error?.message||''))?'Retry this observation so graph versioning is recomputed from the latest patient revision.':'The Patient Graph transaction rolled back. Inspect node, edge, Evidence, and database constraints before retrying; no successful commit is claimed.'};}

export const pipelineInternals={extractEvidence,normalizeEvidenceOutput,normalizeRoutesOutput,validateRoutes,locateContiguousQuote,routeEvidence,updatePatientGraph,currentMemory,actionPolicy,generateFromMemory,audit};
