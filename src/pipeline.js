import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { ModelGateway } from './gateway.js';
import { communicationActionRequirements } from './prompts.js';
import { buildVersion } from './version.js';
import { inspectMemoryNodeSourceAlignment, isAnswerableMemoryNode, validateAction, validateMemoryDelta, validateMemoryEdge, validateMemoryNode, validateObservation } from './schema.js';
import { transcriptBlocks,transcriptContextForSpan } from './session-observation.js';
import { bindSemanticSupport,buildSemanticContextUnits,semanticExtractorInput } from './semantic-state-builder.js';
import { currentMemory,familyCounts,genericTextSimilarity,memoryTopicKey,normalizeMemoryText,updateMemoryGraph } from './memory-graph-updater.js';
import { classifyMemoryRelations,MEMORY_RELATION_CLASSIFIER_VERSION } from './memory-relation-classifier.js';
import { attachRouterWarnings,materializeEmptyMemoryTags,normalizeMemoryTagsOutput,tagMemoryNodes,tagMemoryWithFallback,validateMemoryTags } from './memory-family-tagger.js';

const DESCRIPTIONS = {
  observation_ingest:'校验并固定 benchmark 共有的患者、来源、session、turn、时间与原文；query 和评分字段不会进入核心系统。',
  memory_node_extractor:'在完整 Session 语境中抽取原子 Memory Node；节点同时保留原文、规范化内容、来源、时间和不确定性。', multi_family_tagger:'为每个 Memory Node 添加一个或多个 BC/PE/PA/CS/CP/LO family 标签；标签是同一节点的属性，不复制节点。',
  memory_relation_classifier:'只在代码有界预筛出的同患者、原文对齐节点对之间，判断高置信的非因果纵向或照护关系；同 Session 共现本身不是关系。',
  memory_graph_updater:'把 Memory Node 直接写入持久化 Memory Graph，并建立版本与照护关系边。',
  action_policy:'直接根据当前 Patient 消息和统一 Memory Graph 选择结构化行动。',
  response_generator:'只表达 Action Policy 已选择的行动，并遵守当前可见 Memory Node 边界。',
  response_auditor:'检查回复是否遵守 Action Policy 和证据边界。',
  memory_commit:'历史 profile/对话只更新记忆，不生成 Doctor Agent 回复。',
  patient_memory_commit:'在任何回复生成前，先提交本轮 Patient observation 和 Memory Node；后续回复失败也不丢失患者输入。',
  conversation_commit:'提交通过 Auditor 的 Doctor Agent 回复；阶段 2 编排器随后将其作为下一条 doctor observation 写回记忆。'
};

export class Pipeline {
  constructor(store, config = {}) { this.store=store; this.config=config; this.gateway=config.gateway || new ModelGateway(config.model || {provider:'mock',model:'careharness-rules-v1'}); this.componentGateways=config.componentGateways || {}; }
  gatewayFor(component) { return this.componentGateways[component] || this.gateway; }

  async preprocess(rawObservation, options={}) {
    const observation=validateObservation(rawObservation),prepared={observation};
    try {
      const extracted=await extractMemoryNodesWithRecovery(this.gatewayFor('extractor'),observation,{requireNonEmpty:requiresNonEmptyExtraction(options.dataset,observation),preserveMedLoCoMoSourceTurns:usesMedLoCoMoSourceTurnFallback(options.dataset,observation)});
      attachMemoryWarnings(extracted);prepared.memory_nodes=extracted.value;prepared.extractorTrace=extracted.trace;
      prepared.routerInput=prepared.memory_nodes.map((item,index)=>({id:String(index),text:item.text,source:item.source_type}));
      const routed=await tagMemoryWithFallback(this.gatewayFor('router'),prepared.routerInput,prepared.memory_nodes,observation,medLoCoMoRouterOptions(options.dataset,observation));
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
      if(prepared?.error&&!prepared.memory_nodes)throw prepared.error;
      const extracted=prepared?quarantineUnalignedMemoryNodes({value:prepared.memory_nodes,trace:prepared.extractorTrace},packet):await extractMemoryNodesWithRecovery(this.gatewayFor('extractor'),packet,{requireNonEmpty:requiresNonEmptyExtraction(runContext.dataset,packet),preserveMedLoCoMoSourceTurns:usesMedLoCoMoSourceTurnFallback(runContext.dataset,packet)});
      assertRequiredExtraction(extracted,packet,runContext.dataset);
      attachMemoryWarnings(extracted);
      const extractedNodes=step('memory_node_extractor',{model_input:packet.raw_text,code_context:{observation_id:packet.observation_id,source_type:packet.source_type}},extracted.value,'completed',extracted.trace);
      await breakpoint();
      if(prepared?.error)throw prepared.error;
      const preparedRoutesReusable=Boolean(prepared)&&extractedNodes.length===prepared.memory_nodes.length&&extractedNodes.every((node,index)=>node.memory_id===prepared.memory_nodes[index]?.memory_id),routerInput=preparedRoutesReusable?prepared.routerInput:extractedNodes.map((item,index)=>({id:String(index),text:item.text,source:item.source_type}));
      const routedResult=preparedRoutesReusable?{value:prepared.routes,trace:prepared.routerTrace}:await tagMemoryWithFallback(this.gatewayFor('router'),routerInput,extractedNodes,observation,medLoCoMoRouterOptions(runContext.dataset,observation));
      attachRouterWarnings(routedResult);
      const taggedNodes=step('multi_family_tagger',routerInput,routedResult.value,'completed',routedResult.trace);
      await breakpoint();
      const graphSnapshot=readMemoryGraphSnapshot(this.store,observation.subject_id),historical=graphSnapshot.nodes,historicalEdges=graphSnapshot.edges;
      const graphInput={memory_nodes:taggedNodes,graph:{node_count:historical.length,edge_count:historicalEdges.length,family_counts:familyCounts(historical)}};
      let graphPreview;
      try{
        graphPreview=updateMemoryGraph(taggedNodes,historical,historicalEdges,observation);
        graphPreview.nodes.forEach(validateMemoryNode);graphPreview.edges.forEach(validateMemoryEdge);graphPreview.deltas.forEach(validateMemoryDelta);
      }catch(error){const failure={kind:'schema_error',message:String(error.message),validation_errors:error.errors||[],suggestion:'Inspect Memory Node invariants before relation classification; every semantic fact must remain source-grounded and patient-specific.'};step('memory_graph_updater',graphInput,null,'failed',null,failure);throw Object.assign(error,{publicError:{step:'memory_graph_updater',input:graphInput,raw_model_output:'',parsed_output:null,validation_errors:error.errors||[],message:String(error.message),suggestion:failure.suggestion}});}
      const relationInput={incoming_memory_ids:graphPreview.nodes.map(node=>node.memory_id),historical_node_count:historical.length,historical_edge_count:historicalEdges.length,candidate_policy:'bounded_same-patient_source-grounded_pairs_only'};
      let classifiedRelations;
      try{
        classifiedRelations=await classifyMemoryRelations(this.gatewayFor('relation_classifier'),graphPreview.nodes,historical);
        const relationOutput={version:classifiedRelations.version,candidate_count:classifiedRelations.candidates.length,decisions:classifiedRelations.decisions,relation_proposals:classifiedRelations.relationProposals,degraded:false};
        step('memory_relation_classifier',relationInput,relationOutput,'completed',classifiedRelations.trace);
      }catch(error){
        const gatewayTrace=error.gatewayTrace||null,failure=gatewayTrace?.error||{kind:'relation_classifier_error',message:String(error.message||error),validation_errors:error.errors||[],suggestion:'Memory Nodes remain valid; continue without optional persistent relation proposals.'};
        classifiedRelations={version:MEMORY_RELATION_CLASSIFIER_VERSION,candidates:[],decisions:[],relationProposals:[],trace:gatewayTrace};
        step('memory_relation_classifier',relationInput,{version:MEMORY_RELATION_CLASSIFIER_VERSION,candidate_count:0,decisions:[],relation_proposals:[],degraded:true,fallback:'continue_without_optional_relation_proposals'},'failed',gatewayTrace,failure);
      }
      await breakpoint();
      let graphDelta;
      try{
        graphDelta=updateMemoryGraph(graphPreview.nodes,historical,historicalEdges,observation,{relationProposals:classifiedRelations.relationProposals});
        graphDelta.nodes.forEach(validateMemoryNode);graphDelta.edges.forEach(validateMemoryEdge);graphDelta.deltas.forEach(validateMemoryDelta);
      }catch(error){const failure={kind:'schema_error',message:String(error.message),validation_errors:error.errors||[],suggestion:'Inspect Memory Node and Memory Edge invariants; every fact, family label and provenance field must live on one patient-specific node.'};step('memory_graph_updater',graphInput,null,'failed',null,failure);throw Object.assign(error,{publicError:{step:'memory_graph_updater',input:graphInput,raw_model_output:'',parsed_output:null,validation_errors:error.errors||[],message:String(error.message),suggestion:failure.suggestion}});}
      const built=graphDelta.nodes,builtEdges=graphDelta.edges,deltas=graphDelta.deltas;
      step('memory_graph_updater',graphInput,graphDelta);
      await breakpoint();
      const memory=currentMemory([...historical,...built]);
      const graphNodes=[...historical,...built],memoryGraph={version:graphNodes.some(node=>node.construction_kind==='literal_provenance')?'careharness-memory-graph.v3-semantic-state-with-literal-provenance':'careharness-memory-graph.v2-semantic-state',subject_id:observation.subject_id,node_count:graphNodes.length,edge_count:historicalEdges.length+builtEdges.length,episode_membership_count:new Set(graphNodes.map(node=>String(node.episode_id||'')).filter(Boolean)).size,family_counts:familyCounts(graphNodes),delta:{memory_ids:built.map(node=>node.memory_id),edge_ids:builtEdges.map(edge=>edge.edge_id),episode_memberships:graphDelta.episode_memberships}};
      const isMock=[this.gateway,...Object.values(this.componentGateways)].every(g=>g.config.provider==='mock');
      if(phase==='memory_build'){
        const final={phase,observation,run_context:runContext,memory_nodes:built,memory_edges:builtEdges,memory_graph:memoryGraph,deltas,memory,response:null,version,mock:isMock};
        const commitInput={phase,observation_id:observation.observation_id,node_delta_count:deltas.length,edge_delta_count:builtEdges.length};let receipt=null;
        try{if(run.branch_kind==='formal')receipt=this.store.commitMemory(run.id,observation,built,builtEdges,{expected_graph_revision:graphSnapshot.revision});}
        catch(error){const failure=memoryCommitFailure(error);step('memory_commit',commitInput,{committed:false},'failed',null,failure);throw Object.assign(error,{publicError:{step:'memory_commit',input:commitInput,raw_model_output:'',parsed_output:{committed:false},message:failure.message,suggestion:failure.suggestion}});}
        step('memory_commit',commitInput,{committed:Boolean(receipt),receipt,next:'The versioned Memory Graph snapshot is ready for a future query.'});
        this.store.completeRun(run.id,final);
        return {...run,status:'completed',traces,final};
      }
      const patientCommitInput={observation_id:observation.observation_id,source_type:observation.source_type,node_delta_count:deltas.length,edge_delta_count:builtEdges.length};let patientReceipt=null;
      try{if(run.branch_kind==='formal')patientReceipt=this.store.commitMemory(run.id,observation,built,builtEdges,{expected_graph_revision:graphSnapshot.revision});}
      catch(error){const failure=memoryCommitFailure(error);step('patient_memory_commit',patientCommitInput,{committed:false,sequence:1},'failed',null,failure);throw Object.assign(error,{publicError:{step:'patient_memory_commit',input:patientCommitInput,raw_model_output:'',parsed_output:{committed:false},message:failure.message,suggestion:failure.suggestion}});}
      const patientCommit=step('patient_memory_commit',patientCommitInput,{committed:Boolean(patientReceipt),receipt:patientReceipt,sequence:1,next:'Action Policy reads the Memory Graph after the Patient observation has been committed.'});
      await breakpoint();
      const action=step('action_policy',{current_patient_message:observation.raw_text,memory:compactMemory(memory)},actionPolicy(observation,memory));validateAction(action);
      await breakpoint();
      const generatorInput={action:action.type,current_patient_message:observation.raw_text,required_content:action.required_content,forbidden_content:action.forbidden_content,memory:compactMemory(memory)};
      const genResult=await this.gatewayFor('generator').completeJSON('generator',generatorInput,x=>validateGenerated(normalizeGenerated(x,action)),()=>generateFromMemory(action,generatorInput));
      const generated=step('response_generator',generatorInput,genResult.value,'completed',genResult.trace);
      await breakpoint();
      const auditorInput={action:action.type,response:generated.response,required_content:action.required_content,forbidden_content:action.forbidden_content};
      const auditResult=await this.gatewayFor('auditor').completeJSON('auditor',auditorInput,x=>validateAudit(normalizeAudit(x,action,generated)),()=>audit(action,generated));
      const audited=step('response_auditor',auditorInput,auditResult.value,auditResult.value.passed?'completed':'failed',auditResult.trace);
      await breakpoint();
      if(!audited.passed)throw Object.assign(new Error('Response blocked by Auditor'),{publicError:{step:'response_auditor',input:auditorInput,raw_model_output:auditResult.trace.raw_model_response,parsed_output:audited,suggestion:'Inspect the Action Policy constraints and regenerate the response.'}});
      const final={phase,observation,run_context:runContext,memory_nodes:built,memory_edges:builtEdges,memory_graph:memoryGraph,deltas,memory,patient_memory_committed:patientCommit.committed,action,response:generated.response,audit:audited,response_memory_ids:generated.citations,version,mock:isMock};
      step('conversation_commit',{action:action.type,response:generated.response,branch_kind:run.branch_kind},{response_ready:true,doctor_memory_pending:run.branch_kind==='formal',sequence:2});
      this.store.completeRun(run.id,final);
      return {...run,status:'completed',traces,final};
    } catch(error) {
      if(error.gatewayTrace && traces.at(-1)?.status!=='failed'){
        const names={extractor:'memory_node_extractor',router:'multi_family_tagger',relation_classifier:'memory_relation_classifier',generator:'response_generator',auditor:'response_auditor',judge:'benchmark_judge'},component=names[error.gatewayTrace.component]||error.gatewayTrace.component;
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

function extractMemoryNodes(o) {
  return buildSemanticContextUnits(o).map(unit=>validateExtractedMemoryNode({memory_id:randomUUID(),observation_id:o.observation_id,subject_id:o.subject_id,text:unit.text,source_text:unit.source_text,span:[...unit.span],source_type:unit.source_type,episode_id:o.episode_id,turn_id:unit.turn_id,event_time:unit.event_time,certainty:1,polarity:inferSemanticPolarity(unit.text),support_unit_ids:[unit.unit_id],construction_kind:'fallback'}));
}

function validateExtractedMemoryNode(value){
  for(const key of ['memory_id','observation_id','subject_id','text','source_type','episode_id'])if(typeof value?.[key]!=='string'||!value[key].trim())throw new Error(`extracted Memory Node requires ${key}`);
  if(typeof value.certainty!=='number'||value.certainty<0||value.certainty>1)throw new Error('extracted Memory Node certainty must be 0..1');
  if(!['affirmed','negated','uncertain'].includes(value.polarity))throw new Error('extracted Memory Node polarity is invalid');
  return value;
}

function isConversationalFiller(text){
  const value=String(text||'').trim();
  if((value.match(/[\p{L}\p{N}]/gu)||[]).length<2)return true;
  return /(?:不会|不再会|别怕).{0,12}(?:让|留)(?:你|您|患者).{0,10}(?:一个人|独自).{0,12}(?:黑暗里摸索|面对|承受)|(?:我|我们)会一直陪着(?:你|您|患者)/u.test(value);
}

function normalizeMemoryNodeOutput(value, observation) {
  const items = Array.isArray(value?.memory_nodes) ? value.memory_nodes : null;
  if (!Array.isArray(items)) return value;
  const memoryNodes=[],warnings=[],supportBindings=[],contextUnits=buildSemanticContextUnits(observation),visibleSourceText=contextUnits.map(unit=>unit.text).join('\n')||observation.raw_text;
  items.forEach((item, index) => {
    const rawItem=item&&typeof item==='object'?item:typeof item==='string'?{text:item}:{};
    const rewritten=String(rawItem.text||'').trim();
    if(!rewritten){warnings.push({item_index:index,failure_reason:'missing_atomic_text'});return;}
    if(isConversationalFiller(rewritten,observation.source_type)){warnings.push({item_index:index,failure_reason:'filtered_non_memory_dialogue'});return;}
    if(languageMismatch(visibleSourceText,rewritten))warnings.push({item_index:index,failure_reason:'output_language_mismatch',expected_language:dominantLanguage(visibleSourceText)});
    const semanticBinding=bindSemanticSupport(rawItem,observation,contextUnits),quoteCandidate=rewritten.replace(/^(?:患者|医生)(?:原话|陈述|报告|建议|解释|评估|认为)?[：:]?/u,'').trim(),alignment=semanticBinding.explicit?null:locateContiguousQuote(observation.raw_text,quoteCandidate),span=semanticBinding.bound?semanticBinding.span:alignment?.span||null,context=semanticBinding.bound?semanticBinding:span?transcriptContextForSpan(observation.raw_text,span[0],span[1]):null,legacyUnit=semanticBinding.explicit||!span?null:contextUnits.filter(unit=>unit.span[0]<=span[0]&&unit.span[1]>=span[1]).sort((a,b)=>(a.span[1]-a.span[0])-(b.span[1]-b.span[0]))[0]||null,supportUnitIds=semanticBinding.bound?semanticBinding.support_unit_ids:legacyUnit?[legacyUnit.unit_id]:[];
    if(semanticBinding.explicit&&!semanticBinding.bound)warnings.push({warning_type:'semantic_state_support_repair_required',item_index:index,failure_reason:'invalid_support_unit_binding',failure_reasons:semanticBinding.reasons,support_unit_ids:semanticBinding.support_unit_ids,repairable:true,answer_eligible:false});
    else if(!span)warnings.push(alignmentWarning(index,rewritten,alignment?.failure_reason,alignment?.attempted_match_levels));
    supportBindings.push({item_index:index,memory_id:`${observation.observation_id}:llm:${index}`,support_unit_ids:supportUnitIds,binding_mode:semanticBinding.bound?'context_unit':span?'legacy_contiguous_quote':'unbound',bound:Boolean(span),failure_reasons:semanticBinding.bound?[]:semanticBinding.explicit?semanticBinding.reasons:[alignment?.failure_reason].filter(Boolean)});
    memoryNodes.push({
      memory_id: `${observation.observation_id}:llm:${index}`,
      observation_id: observation.observation_id,
      subject_id: observation.subject_id,
      text: rewritten,
      source_text:semanticBinding.bound?semanticBinding.source_text:span?observation.raw_text.slice(span[0],span[1]):null,
      span:span||null,
      source_type: context?.source_type||observation.source_type,
      episode_id: observation.episode_id,
      turn_id: context?.turn_id||observation.turn_id,
      event_time: context?.event_time||observation.event_time,
      certainty: typeof rawItem.certainty === 'number' ? rawItem.certainty : 1,
      polarity: ['affirmed','negated','uncertain'].includes(rawItem.polarity) ? rawItem.polarity : inferSemanticPolarity(rewritten),
      ...(supportUnitIds.length?{support_unit_ids:[...supportUnitIds]}:{}),construction_kind:'semantic'
    });
  });
  addExplicitMedicationStopCoverage(memoryNodes,warnings,observation);
  Object.defineProperty(memoryNodes,'warnings',{value:warnings,enumerable:false});
  Object.defineProperty(memoryNodes,'support_bindings',{value:supportBindings,enumerable:false});
  return memoryNodes;
}

// The model owns extraction. This narrow guard only protects an explicitly
// completed, first-person Chinese medication stop that is otherwise easy to
// lose in a long Session. It deliberately abstains on advice, hypotheses,
// uncertainty, reversals, corrections, third parties and reminder settings.
function addExplicitMedicationStopCoverage(memoryNodes,warnings,observation){
  const sources=extractMemoryNodes(observation).filter(item=>item.source_type==='patient');
  let added=0;
  for(const source of sources){
    const sentence=source.text;
    if(/(?:不对|说错|记错|其实(?:我)?没停|前面说错|等等.{0,8}没停|后来|之后|现在|今天|昨晚).{0,10}(?:又|重新|恢复|继续|再次|吃上|服用|用上|服上)/u.test(sentence))continue;
    const match=/(?:所以)?我(?<time>这两天|这几天|最近|近期|前几天)把(?<drug>[^，。！？!?；;]{1,32}?)停了之后/u.exec(sentence);
    if(!match)continue;
    const drug=String(match.groups?.drug||'').trim();
    if(!drug||/(?:提醒|群聊|讨论|功能|相关|包含|剂量|方案|建议|打算|考虑)/u.test(drug))continue;
    if(/(?:可能|好像|也许|大概).{0,8}(?:停|没再服)/u.test(sentence))continue;
    if(memoryNodes.some(item=>sameStoppedMedication(item.text,drug)))continue;
    memoryNodes.push(validateExtractedMemoryNode({
      memory_id:`${observation.observation_id}:coverage:status-change:${added++}`,
      observation_id:observation.observation_id,subject_id:observation.subject_id,
      text:`患者${match.groups.time}把${drug}停用。`,source_text:source.source_text,span:source.span,
      source_type:source.source_type,episode_id:observation.episode_id,
      turn_id:source.turn_id,event_time:source.event_time,certainty:1,polarity:'affirmed',
      support_unit_ids:[...(source.support_unit_ids||[])],construction_kind:'fallback'
    }));
  }
  if(added)warnings.push({warning_type:'coverage_guard_added',statuses:['stopped'],added_count:added,selection_basis:'explicit_completed_first_person_medication_stop'});
}

function sameStoppedMedication(text,drug){
  const value=normalizeMemoryText(text),entity=normalizeMemoryText(drug);
  return entity.length>1&&value.includes(entity)&&/(?:停用|停药|停止服用|不再服用|stoppedtaking|discontinued)/iu.test(String(text));
}

function inferSemanticPolarity(text){
  const value=String(text||'');
  if(/(?:可能|也许|似乎|不确定|怀疑|考虑|倾向|大概|probably|possibly|uncertain|suspect)/iu.test(value))return'uncertain';
  // Confirmation-style rhetorical questions and affirmative adherence claims
  // must not make the whole Memory Node negative merely because their surface
  // form contains "不是" or "没有".
  const proposition=value
    .replace(/不是([^。！？!?；;\n]{1,160}?)(?:嘛|吗)[？?]?/gu,'$1')
    .replace(/((?:按时|规律|固定|一直|每天|继续)[^。！？!?；;\n]{0,100}?)(?:没有|没)(?:漏服|漏药|漏吃|漏掉|中断)/gu,'$1');
  if(/(?:没有|并无|尚无|未见|否认|不再|没再|无明显|无任何|不是|从未|not|no\s|without|denies|never)/iu.test(proposition))return'negated';
  return'affirmed';
}

function normalizeAndValidateMemoryNodes(value,observation){
  const normalized=normalizeMemoryNodeOutput(value,observation);
  if(!Array.isArray(normalized))return normalized;
  const validated=normalized.map(validateExtractedMemoryNode);
  Object.defineProperty(validated,'warnings',{value:normalized.warnings||[],enumerable:false});
  Object.defineProperty(validated,'support_bindings',{value:normalized.support_bindings||[],enumerable:false});
  return validated;
}
function attachMemoryWarnings(result){
  if(result?.value?.warnings?.length&&result.trace)result.trace.validation_warnings=result.value.warnings;
  if(result?.trace&&result?.value?.support_bindings?.length){
    const literal=result.value.support_bindings.filter(binding=>binding?.binding_mode==='exact_source_turn'),semantic=result.value.support_bindings.filter(binding=>binding?.binding_mode!=='exact_source_turn');
    result.trace.semantic_state_source_bindings=semantic;
    if(literal.length)result.trace.literal_provenance_source_bindings=literal;
  }
  return result;
}
async function extractMemoryNodesWithRecovery(gateway,observation,options={}){
  const requireNonEmpty=options.requireNonEmpty===true,validate=value=>{
    const nodes=normalizeAndValidateMemoryNodes(value,observation);
    if(requireNonEmpty&&(!Array.isArray(nodes)||nodes.length===0))throw new Error('MedLoCoMo non-empty Admission extraction must return a non-empty Memory Node array');
    return nodes;
  },extractorInput=semanticExtractorInput(observation),mockOutput=()=>({memory_nodes:buildSemanticContextUnits(observation).map(unit=>({text:unit.text,support_unit_ids:[unit.unit_id]}))});
  const withSessionCoverage=(result,{literalOnly=false}={})=>{
    let covered=!literalOnly&&transcriptBlocks(observation.raw_text).length?augmentExtractorCoverage(result,observation):result;
    if(options.preserveMedLoCoMoSourceTurns)covered=augmentMedLoCoMoSourceTurnCoverage(covered,observation);
    return quarantineUnalignedMemoryNodes(covered,observation);
  };
  try{const primary=await gateway.completeJSON('extractor',extractorInput,validate,mockOutput);return withSessionCoverage(await repairInvalidSemanticStates(gateway,observation,extractorInput,primary,validate));}
  catch(error){
    const trace=error?.gatewayTrace,attempts=Array.isArray(trace?.raw_model_attempts)?trace.raw_model_attempts:[];
    if(trace?.component==='extractor'&&trace?.error?.kind==='truncated_output'){
      let best=null;
      for(const attempt of attempts){
        const recoveredPayload=recoverCompleteMemoryNodePrefix(attempt?.raw);
        if(!recoveredPayload.memory_nodes.length)continue;
        try{const value=validate(recoveredPayload);if(!best||value.length>best.value.length)best={value,attempt:Number(attempt.attempt)||0,recovered_item_count:recoveredPayload.memory_nodes.length};}catch{}
      }
      if(best?.value.length){
        best.value.warnings.push({warning_type:'truncated_extractor_prefix_recovered',recovery_policy:'validated_complete_memory_nodes_only',source_attempt:best.attempt,recovered_item_count:best.recovered_item_count,accepted_memory_node_count:best.value.length,discarded_incomplete_suffix:true});
        const recovered={value:best.value,trace:{...trace,finish_reason:'length_recovered',parsed_response:best.value,error:null,recovery:{mode:'validated_complete_memory_node_prefix',source_attempt:best.attempt,recovered_item_count:best.recovered_item_count,accepted_memory_node_count:best.value.length,discarded_incomplete_suffix:true}}};
        return withSessionCoverage(await repairInvalidSemanticStates(gateway,observation,extractorInput,recovered,validate));
      }
    }
    if(options.preserveMedLoCoMoSourceTurns){
      const value=[];Object.defineProperty(value,'warnings',{value:[{warning_type:'semantic_extractor_failed_open_to_literal_provenance',failure_kind:trace?.error?.kind||'extractor_error',message:String(error?.message||error)}],enumerable:false});Object.defineProperty(value,'support_bindings',{value:[],enumerable:false});
      return withSessionCoverage({value,trace:{...(trace||{}),component:'extractor',model_input:extractorInput,parsed_response:value,error:null,fallback_used:true,semantic_extraction_status:'failed_open_to_literal_provenance',model_validation_error:trace?.error||{kind:'extractor_error',message:String(error?.message||error)}}},{literalOnly:true});
    }
    throw error;
  }
}

function requiresNonEmptyExtraction(dataset,observation){
  return String(dataset||'').toLowerCase()==='medlocomo'&&buildSemanticContextUnits(observation).some(unit=>(String(unit?.text||'').match(/[\p{L}\p{N}]/gu)||[]).length>=2);
}

function usesMedLoCoMoSourceTurnFallback(dataset,observation){
  return String(dataset||'').toLowerCase()==='medlocomo'&&transcriptBlocks(observation?.raw_text).length>0;
}

function medLoCoMoRouterOptions(dataset,observation){
  return usesMedLoCoMoSourceTurnFallback(dataset,observation)?{bounded_batch_concurrency:3,deterministic_literal_provenance:true,per_batch_fail_open:true}:{};
}

function assertRequiredExtraction(result,observation,dataset){
  if(!requiresNonEmptyExtraction(dataset,observation)||result?.value?.length)return result;
  const error=new Error('MedLoCoMo non-empty Admission produced no source-aligned Memory Nodes; the Admission was not committed');
  if(result?.trace)error.gatewayTrace={...result.trace,error:{kind:'empty_memory_extraction',message:error.message,validation_errors:[],suggestion:'Retry this Admission. A non-empty MedLoCoMo Admission must produce at least one source-aligned Memory Node before graph commit.'}};
  throw error;
}

async function repairInvalidSemanticStates(gateway,observation,extractorInput,result,validate){
  const warnings=result?.value?.warnings||[],failures=warnings.filter(warning=>warning?.warning_type==='semantic_state_support_repair_required'),failedIds=new Set(failures.map(warning=>`${observation.observation_id}:llm:${warning.item_index}`));
  if(!failures.length)return result;
  const originalNodes=Array.isArray(result?.value)?result.value:[],validNodes=originalNodes.filter(node=>!failedIds.has(node.memory_id)),failedNodes=failures.map(warning=>{const node=originalNodes.find(item=>item.memory_id===`${observation.observation_id}:llm:${warning.item_index}`);return{text:String(node?.text||''),support_unit_ids:[...(warning.support_unit_ids||[])],failure_reasons:[...(warning.failure_reasons||[])]};}).filter(item=>item.text),baseBindings=(result?.value?.support_bindings||[]).filter(binding=>!failedIds.has(binding.memory_id));
  const finish=(replacementNodes=[],replacementBindings=[],repairTrace={})=>{
    const value=[...validNodes,...replacementNodes];
    Object.defineProperty(value,'warnings',{value:[...warnings,...(repairTrace.validation_warnings||[])],enumerable:false});
    Object.defineProperty(value,'support_bindings',{value:[...baseBindings,...replacementBindings],enumerable:false});
    return{...result,value,trace:{...(result?.trace||{}),parsed_response:value,semantic_state_repair:{version:'careharness-semantic-state-repair.v1',failed_candidate_count:failures.length,...repairTrace}}};
  };
  if(!failedNodes.length)return finish([],[],{attempted:false,accepted_replacement_count:0,discarded_replacement_count:failures.length,skip_reason:'failed_candidate_text_unavailable'});
  if(gateway?.config?.provider==='mock')return finish([],[],{attempted:false,accepted_replacement_count:0,discarded_replacement_count:failures.length,skip_reason:'mock_primary_output_is_code_generated'});
  const repairInput={...extractorInput,repair_request:{mode:'replace_invalid_semantic_states',failed_nodes:failedNodes}};
  try{
    const repaired=await gateway.completeJSON('extractor',repairInput,validate,()=>({memory_nodes:[]})),repairWarnings=repaired?.value?.warnings||[],repairFailureIds=new Set(repairWarnings.filter(warning=>warning?.warning_type==='semantic_state_support_repair_required').map(warning=>`${observation.observation_id}:llm:${warning.item_index}`)),candidates=(Array.isArray(repaired?.value)?repaired.value:[]).filter(node=>!repairFailureIds.has(node.memory_id)&&Array.isArray(node.support_unit_ids)&&node.support_unit_ids.length&&inspectMemoryNodeSourceAlignment(node,observation).aligned).slice(0,failures.length),idMap=new Map(),replacementNodes=candidates.map((node,index)=>{const memory_id=`${observation.observation_id}:repair:${index}`;idMap.set(node.memory_id,memory_id);return{...node,memory_id};}),replacementBindings=(repaired?.value?.support_bindings||[]).filter(binding=>idMap.has(binding.memory_id)).map(binding=>({...binding,memory_id:idMap.get(binding.memory_id),repair_replacement:true})),discarded=Math.max(0,(Array.isArray(repaired?.value)?repaired.value.length:0)-replacementNodes.length);
    return finish(replacementNodes,replacementBindings,{attempted:true,accepted_replacement_count:replacementNodes.length,discarded_replacement_count:discarded,gateway:repaired.trace,validation_warnings:repairWarnings.map(warning=>({...warning,repair_attempt:true}))});
  }catch(error){
    return finish([],[],{attempted:true,accepted_replacement_count:0,discarded_replacement_count:failures.length,error:{message:String(error?.message||error),kind:error?.gatewayTrace?.error?.kind||'repair_call_failed'},gateway:error?.gatewayTrace||null});
  }
}

function quarantineUnalignedMemoryNodes(result,observation){
  if(result?.trace?.source_alignment_gate)return result;
  const input=Array.isArray(result?.value)?result.value:[],eligible=[],quarantined=[];
  input.forEach((node,index)=>{
    const report=inspectMemoryNodeSourceAlignment(node,observation);
    if(report.aligned)eligible.push(node);else quarantined.push({item_index:index,memory_id:String(node?.memory_id||''),reasons:report.reasons});
  });
  const warnings=[...(result?.value?.warnings||[]),...quarantined.map(item=>({warning_type:'memory_node_quarantined_unaligned_source',item_index:item.item_index,memory_id:item.memory_id||null,failure_reasons:item.reasons,answer_eligible:false}))],reasonCounts={};
  for(const item of quarantined)for(const reason of item.reasons)reasonCounts[reason]=(reasonCounts[reason]||0)+1;
  Object.defineProperty(eligible,'warnings',{value:warnings,enumerable:false});
  Object.defineProperty(eligible,'support_bindings',{value:(result?.value?.support_bindings||[]).filter(binding=>eligible.some(node=>node.memory_id===binding.memory_id)),enumerable:false});
  return{...result,value:eligible,trace:{...(result?.trace||{}),parsed_response:eligible,source_alignment_gate:{version:'careharness-source-grounding-gate.v1',policy:'quarantine_before_family_tagging_and_active_graph_write',inspected_memory_node_count:input.length,eligible_memory_node_count:eligible.length,quarantined_memory_node_count:quarantined.length,quarantined_memory_ids:quarantined.map(item=>item.memory_id).filter(Boolean),reason_counts:reasonCounts}}};
}

// A long Session can contain many distinct Patient disclosures and attributed
// Doctor explanations. Even a faithful extractor may summarize only the most
// salient few. Preserve a bounded, role-diverse lexical ledger directly from
// the visible transcript so a later query can still retrieve an omitted fact.
// This is benchmark-agnostic and never sees a query, Gold, or Judge metadata.
function augmentExtractorCoverage(result,observation){
  const supportBindings=result?.value?.support_bindings||[];
  const sourceExtracted=Array.isArray(result?.value)?result.value.map(item=>({...item,span:Array.isArray(item.span)?[...item.span]:item.span||null})):[],deduplicated=deduplicateExtractedMemoryNodes(sourceExtracted),extracted=deduplicated.nodes;
  const candidates=coverageLedgerCandidates(observation),accepted=[],citedUnitIds=new Set(extracted.flatMap(node=>node.support_unit_ids||[]));let attached=0,skippedCitedUnit=0;
  for(const candidate of candidates){
    if(isConversationalFiller(candidate.text))continue;
    if(candidate.support_unit_ids?.length&&candidate.support_unit_ids.every(id=>citedUnitIds.has(id))){skippedCitedUnit++;continue;}
    const stoppedEntity=stoppedMedicationEntity(candidate.text);
    if(stoppedEntity&&[...extracted,...accepted].some(item=>sameStoppedMedication(item.text,stoppedEntity)))continue;
    const extractedIndex=extracted.findIndex(item=>clearlyEquivalentCoverageFact(item,candidate));
    if(extractedIndex>=0){
      if(!extracted[extractedIndex].source_text&&candidate.source_text){extracted[extractedIndex]=attachCoverageFragment(extracted[extractedIndex],candidate);attached++;}
      continue;
    }
    if(accepted.some(item=>clearlyEquivalentCoverageFact(item,candidate)))continue;
    accepted.push(candidate);
  }
  const value=[...extracted,...accepted];
  Object.defineProperty(value,'warnings',{value:[...(result?.value?.warnings||[])],enumerable:false});
  const retainedBindings=supportBindings.filter(binding=>value.some(node=>node.memory_id===binding.memory_id));
  Object.defineProperty(value,'support_bindings',{value:retainedBindings,enumerable:false});
  return{...result,value,trace:{...(result?.trace||{}),parsed_response:value,semantic_state_source_bindings:retainedBindings,coverage_ledger:{version:'careharness-visible-session-coverage-ledger.v4-complete-context-unit',policy:'supplement_only_uncited_high_value_complete_context_units',model_memory_node_count:sourceExtracted.length,model_duplicate_collapsed_count:deduplicated.collapsed,candidate_count:candidates.length,skipped_already_cited_context_unit_count:skippedCitedUnit,attached_source_fragment_count:attached,added_count:accepted.length,patient_added_count:accepted.filter(item=>item.source_type==='patient').length,doctor_added_count:accepted.filter(item=>item.source_type==='doctor').length,gold_or_judge_input_used:false}}};
}

// MedLoCoMo source evidence is an English dialogue whose individual Turns can
// contain several independently useful facts. An extractor may cite one
// Context Unit and omit another, while a failed semantic repair deliberately
// discards its candidate. Preserve one exact, source-sliced fallback per
// nonempty Turn after repair so those omitted words remain searchable.
//
// This supplement is code-generated from the visible Observation only. It
// never joins Turns and still passes through the ordinary source-alignment gate
// below, so it cannot make an ungrounded model node answer-eligible.
function augmentMedLoCoMoSourceTurnCoverage(result,observation){
  const existing=Array.isArray(result?.value)?result.value.map(node=>({...node,span:Array.isArray(node.span)?[...node.span]:node.span||null})):[],candidates=medLoCoMoSourceTurnFallbackCandidates(observation),added=[],skipped=[];
  for(const candidate of candidates){
    if(existing.some(node=>exactSourceTurnAlreadyRepresented(node,candidate,observation))){skipped.push(candidate);continue;}
    added.push(candidate);
  }
  const value=[...existing,...added],priorBindings=result?.value?.support_bindings||[],fallbackBindings=added.map(node=>({memory_id:node.memory_id,support_unit_ids:[...(node.support_unit_ids||[])],binding_mode:'exact_source_turn',bound:true,failure_reasons:[]})),supportBindings=[...priorBindings,...fallbackBindings];
  Object.defineProperty(value,'warnings',{value:[...(result?.value?.warnings||[])],enumerable:false});
  Object.defineProperty(value,'support_bindings',{value:supportBindings,enumerable:false});
  return{...result,value,trace:{...(result?.trace||{}),parsed_response:value,semantic_state_source_bindings:priorBindings,literal_provenance_source_bindings:fallbackBindings,medlocomo_source_turn_fallback:{version:'careharness-medlocomo-source-turn-fallback.v2-literal-provenance',policy:'supplement_every_nonempty_visible_turn_after_semantic_repair_before_source_alignment_gate',candidate_count:candidates.length,skipped_existing_literal_provenance_count:skipped.length,added_count:added.length,patient_added_count:added.filter(node=>node.source_type==='patient').length,doctor_added_count:added.filter(node=>node.source_type==='doctor').length,boundary_policy:'one_turn_role_time_block',source_text_policy:'exact_observation_slice',representation_policy:'retrievable_literal_provenance_not_semantic_clinical_state',gold_or_judge_input_used:false}}};
}

function medLoCoMoSourceTurnFallbackCandidates(observation){
  const rawText=String(observation?.raw_text||''),blocks=transcriptBlocks(rawText),units=buildSemanticContextUnits(observation),unitsByBlock=new Map();
  for(const unit of units){const values=unitsByBlock.get(unit.block_index)||[];values.push(unit);unitsByBlock.set(unit.block_index,values);}
  const candidates=[];
  blocks.forEach((block,index)=>{
    let start=block.content_start,end=block.content_end;
    while(start<end&&/\s/u.test(rawText[start]))start++;
    while(end>start&&/\s/u.test(rawText[end-1]))end--;
    const sourceText=rawText.slice(start,end);
    if(!['patient','doctor'].includes(block.source_type)||!sourceText)return;
    const context=transcriptContextForSpan(rawText,start,end);
    if(!context||context.crosses_turn_boundary||context.source_type!==block.source_type||String(context.turn_id||'')!==String(block.turn_id||'')||String(context.event_time||'')!==String(block.event_time||''))return;
    const supportUnitIds=(unitsByBlock.get(index)||[]).map(unit=>unit.unit_id);
    candidates.push(validateExtractedMemoryNode({
      memory_id:`${observation.observation_id}:source-turn:${index}`,observation_id:observation.observation_id,
      subject_id:observation.subject_id,text:sourceText,source_text:sourceText,span:[start,end],
      source_type:block.source_type,episode_id:observation.episode_id,turn_id:block.turn_id,event_time:block.event_time,
      certainty:1,polarity:inferSemanticPolarity(sourceText),...(supportUnitIds.length?{support_unit_ids:supportUnitIds}:{}),construction_kind:'literal_provenance'
    }));
  });
  return candidates;
}

function exactSourceTurnAlreadyRepresented(node,candidate,observation){
  return node?.construction_kind==='literal_provenance'&&inspectMemoryNodeSourceAlignment(node,observation).aligned&&String(node?.source_type||'')===String(candidate.source_type||'')&&String(node?.turn_id||'')===String(candidate.turn_id||'')&&String(node?.event_time||'')===String(candidate.event_time||'')&&canonicalSourceTurnText(node?.text)===canonicalSourceTurnText(candidate.text);
}

function canonicalSourceTurnText(value){return String(value||'').normalize('NFKC').replace(/\r\n?/gu,'\n').replace(/[ \t\f\v]+/gu,' ').replace(/ *\n */gu,'\n').trim().toLowerCase();}

function deduplicateExtractedMemoryNodes(nodes){
  const kept=[];let collapsed=0;
  for(const node of nodes){
    const index=kept.findIndex(existing=>clearlyEquivalentCoverageFact(existing,node));
    if(index<0){kept.push(node);continue;}
    collapsed++;
    if(!kept[index].source_text&&node.source_text)kept[index]=node;
  }
  return{nodes:kept,collapsed};
}

function coverageLedgerCandidates(observation){
  const segments=buildSemanticContextUnits(observation).filter(item=>['patient','doctor'].includes(item.source_type)).map(unit=>({...unit,certainty:1,polarity:inferSemanticPolarity(unit.text),support_unit_ids:[unit.unit_id]})),byTurn=new Map();
  for(const item of segments){
    const scored=coverageLedgerScore(item);if(scored<=0)continue;
    const key=`${item.source_type}\u0000${item.turn_id||''}`,group=byTurn.get(key)||[];group.push({...item,coverage_score:scored});byTurn.set(key,group);
  }
  for(const group of byTurn.values())group.sort((a,b)=>b.coverage_score-a.coverage_score||a.span[0]-b.span[0]);
  const patient=roundRobinCoverage([...byTurn.entries()].filter(([key])=>key.startsWith('patient\u0000')).map(([,items])=>items),24,3),doctor=roundRobinCoverage([...byTurn.entries()].filter(([key])=>key.startsWith('doctor\u0000')).map(([,items])=>items),14,2),ordered=[...patient,...doctor].sort((a,b)=>a.span[0]-b.span[0]);
  return ordered.map((item,index)=>validateExtractedMemoryNode({
    memory_id:`${observation.observation_id}:coverage:${index}`,observation_id:observation.observation_id,
    subject_id:observation.subject_id,text:item.text,
    source_text:item.source_text,span:Array.isArray(item.span)?[...item.span]:null,
    source_type:item.source_type,episode_id:observation.episode_id,
    turn_id:item.turn_id,event_time:item.event_time,certainty:item.certainty,polarity:item.polarity,
    support_unit_ids:[...(item.support_unit_ids||[])],construction_kind:'fallback'
  }));
}

function attachCoverageFragment(node,candidate){
  return{...node,source_text:candidate.source_text,span:Array.isArray(candidate.span)?[...candidate.span]:null,source_type:node.source_type==='structured'?candidate.source_type:node.source_type,turn_id:node.turn_id||candidate.turn_id,event_time:node.event_time||candidate.event_time,support_unit_ids:[...(candidate.support_unit_ids||[])]};
}

// Attachment deliberately requires a strong lexical match in the same visible
// Session and refuses numeric, polarity or role conflicts. Ambiguous pairs stay
// as separate Memory Nodes so coverage never erases a potentially distinct fact.
function clearlyEquivalentCoverageFact(left,right){
  if(!sameCoverageRole(left,right)||coveragePolarity(left)!==coveragePolarity(right)||coverageQuantitiesConflict(left,right))return false;
  const leftTexts=coverageFactTexts(left),rightTexts=coverageFactTexts(right);let best=0,contained=false;
  for(const a of leftTexts)for(const b of rightTexts){
    if(a===b)return true;
    const shorter=Math.min(a.length,b.length),longer=Math.max(a.length,b.length);
    if(shorter>=8&&(a.includes(b)||b.includes(a))&&shorter/Math.max(1,longer)>=.64)contained=true;
    best=Math.max(best,coverageTextSimilarity(a,b));
  }
  return contained||best>=.88;
}

function sameCoverageRole(left,right){const a=coverageRole(left),b=coverageRole(right);return!a||!b||a===b;}
function coverageRole(node){const source=String(node?.source_type||'').toLowerCase();if(['patient','doctor'].includes(source))return source;const text=String(node?.text||'');if(/^(?:患者|患者原话)[：:]?/u.test(text))return'patient';if(/^(?:医生|医生原话)[：:]?/u.test(text))return'doctor';return'';}
function coveragePolarity(node){const text=coverageFactTexts(node).join(' ');if(String(node?.polarity)==='negated'||/(?:没有|并无|尚无|未见|否认|不再|没再|无明显|无任何)/u.test(text))return'negated';if(String(node?.polarity)==='uncertain'||/(?:可能|也许|似乎|不确定)/u.test(text))return'uncertain';return'affirmed';}
function coverageFactTexts(node){return[node?.text,node?.source_text].filter(Boolean).map(coverageComparableText).filter(Boolean);}
function coverageComparableText(value){return normalizeMemoryText(String(value||'').replace(/^(?:患者|医生)(?:原话|陈述|报告|建议|解释|评估|认为)?[：:]?/u,'').replace(/^(?:我|本人|该患者)/u,''));}
function coverageQuantitiesConflict(left,right){const a=coverageQuantitySignature(left),b=coverageQuantitySignature(right);return a.size>0&&b.size>0&&(a.size!==b.size||[...a].some(value=>!b.has(value)));}
function coverageQuantitySignature(node){const values=new Set();for(const text of[node?.text,node?.source_text])for(const match of String(text||'').normalize('NFKC').matchAll(/[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:\s*[-–~至]\s*\d+(?:\.\d+)?)?\s*(?:%|mmol\/?l|mg\/?dl|mg|mcg|g|kg|ml|l|mmhg|bpm|iu|u|单位|毫克|微克|克|千克|毫升|升|次|分钟|小时|天)?/giu))values.add(match[0].replace(/\s+/gu,'').toLowerCase().replace(/[~至–]/gu,'-'));return values;}

function stoppedMedicationEntity(text){
  const match=/(?:把)?([^，。！？!?；;：:]{2,32}?)(?:停用|停药|停了|停止服用|不再服用)/u.exec(String(text||''));
  return match?.[1]?.replace(/^(?:患者|患者原话|医生原话)[：:]?/u,'').trim()||null;
}

function roundRobinCoverage(groups,limit,perTurn){
  const selected=[],seen=new Set();
  for(let rank=0;rank<perTurn&&selected.length<limit;rank++)for(const group of groups){const item=group[rank];if(!item)continue;const key=normalizeMemoryText(item.text);if(!key||seen.has(key))continue;seen.add(key);selected.push(item);if(selected.length>=limit)break;}
  const rest=groups.flat().sort((a,b)=>b.coverage_score-a.coverage_score||a.span[0]-b.span[0]);
  for(const item of rest){const key=normalizeMemoryText(item.text);if(selected.length>=limit)break;if(!key||seen.has(key))continue;seen.add(key);selected.push(item);}
  return selected;
}

function coverageLedgerScore(item){
  const text=String(item?.text||'').trim(),meaningful=(text.match(/[\p{L}\p{N}]/gu)||[]).length;if(meaningful<6||meaningful>360)return 0;
  const question=/[?？]\s*$/u.test(text),personalAppraisal=/(?:我|患者).*(?:担心|感觉|觉得|认为|希望|愿意|打算|决定|能不能|是不是|会不会)/u.test(text);
  if(question&&!personalAppraisal)return 0;
  if(item.source_type==='patient'){
    let score=1;
    if(/\d|%|mmol|mg|kg|毫克|单位|分钟|小时|凌晨|早上|晚上|昨天|今天|最近|近期|目前/iu.test(text))score+=3;
    if(/(?:症状|感觉|出现|没有|没|不再|加重|减轻|改善|下降|升高|波动|疼|痛|晕|乏力|没劲|发软|口渴|醒|睡|吃|喝|运动|工作|加班|刷手机|用药|服药|停药|注射|监测|检查|结果)/u.test(text))score+=3;
    if(/(?:担心|意识到|觉得|认为|希望|愿意|打算|决定|接受|拒绝|偏好|目标|承诺)/u.test(text))score+=2;
    return score>=4?score:0;
  }
  let score=0;
  if(/(?:医生|建议|需要|应当|可以|不要|避免|监测|复查|检查|治疗|用药|剂量|注射|就医|急诊|风险|诊断|评估|判断)/u.test(text))score+=3;
  if(/(?:因为|所以|导致|引起|意味着|说明|机制|病理|神经|激素|受体|血管|肾脏|胰岛|药效|代谢|交感|副交感|HPA|皮质醇|RAAS|ROS)/iu.test(text))score+=3;
  if(/\d|%|mmol|mg|kg|毫克|单位|分钟|小时|日期|近期|目前/u.test(text))score+=2;
  return score>=5?score:0;
}

function coverageTextSimilarity(left,right){return genericTextSimilarity(String(left||'').replace(/^(?:患者|医生)(?:原话|陈述)?[：:]/u,''),String(right||'').replace(/^(?:患者|医生)(?:原话|陈述)?[：:]/u,''));}
function recoverCompleteMemoryNodePrefix(raw){
  const text=String(raw||''),match=/"memory_nodes"\s*:\s*\[/u.exec(text);if(!match)return{memory_nodes:[]};
  const memoryNodes=[];let objectStart=-1,depth=0,inString=false,escaped=false;
  for(let index=match.index+match[0].length;index<text.length;index++){
    const character=text[index];
    if(escaped){escaped=false;continue;}
    if(character==='\\'&&inString){escaped=true;continue;}
    if(character==='"'){inString=!inString;continue;}
    if(inString)continue;
    if(character==='{'){if(depth===0)objectStart=index;depth++;continue;}
    if(character==='}'&&depth>0){depth--;if(depth===0&&objectStart>=0){try{const item=JSON.parse(text.slice(objectStart,index+1));if(item&&typeof item==='object'&&!Array.isArray(item))memoryNodes.push(item);}catch{}objectStart=-1;}continue;}
    if(character===']'&&depth===0)break;
  }
  return{memory_nodes:memoryNodes};
}
function alignmentWarning(index,sourceText,failureReason,attempted){return{item_index:index,model_source_text:sourceText,failure_reason:failureReason,attempted_match_levels:attempted};}

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

function compactMemory(nodes=[]) {
  return nodes.filter(isAnswerableMemoryNode).map((node,index)=>({
    id:String(index),memory_id:node.memory_id,families:node.families,text:node.text,source_text:node.source_text||null,event_time:node.event_time||null,polarity:node.polarity,status:node.status
  }));
}

function modelOutput(value){return value?.output&&typeof value.output==='object'?value.output:value||{};}
function strings(value,fallback=[]){return Array.isArray(value)?value.filter(item=>typeof item==='string'&&item.trim()):fallback;}

function normalizeGenerated(value,action){
  const output=modelOutput(value);
  return {action_type:action.type,response:String(output.response||'').trim(),citations:action.required_memory_ids};
}

function normalizeAudit(value,action,generated){
  const deterministic=audit(action,generated), output=modelOutput(value);
  const violations=[...new Set([...deterministic.violations,...strings(output.violations)])];
  const passed=deterministic.passed&&output.passed===true&&violations.length===0;
  return {passed,violations,grounded_memory_ids:generated.citations||[],blocked_response:passed?null:generated.response,
    safe_response:passed?(typeof output.safe_response==='string'&&output.safe_response.trim()?output.safe_response:generated.response):deterministic.safe_response};
}

function rewriteAtomic(text){return String(text||'').normalize('NFKC').trim();}

function actionPolicy(observation,memory){const conflict=memory.some(item=>item.status==='conflict'),uncertain=memory.some(item=>item.polarity==='uncertain'||Number(item.certainty)<.8)||/(?:不确定|不清楚|不知道|是否|要不要|能不能|可以吗|吗[？?]?\s*$)/u.test(observation.raw_text),type=conflict?'VERIFY':uncertain?'ASK':'ANSWER',ids=[...new Set(memory.map(item=>item.memory_id).filter(Boolean))],requirements=communicationActionRequirements(type,{rememberedRisk:false,currentRisk:false});return{type,explanation:requirements.explanation,required_memory_ids:ids,required_content:requirements.required_content,forbidden_content:requirements.forbidden_content};}
function validateGenerated(x){if(!x||typeof x.response!=='string'||!x.response.trim())throw new Error('generated response required');if(!x.action_type)throw new Error('action_type required');return x;}
function generateFromMemory(action,input){const response={ESCALATE:'你现在的安全最重要。请立即联系当地急救或危机支持，并尽快让一位可信任的人陪在你身边。你现在是否安全？是否有具体计划、可用手段或马上行动的可能？',VERIFY:'现有记忆中有冲突或时间不清。我们先核对具体来源和发生时间，再继续会更可靠。',ASK:'我想先确认一个关键信息：你说的不确定部分具体发生在什么时候，现在仍然如此吗？',ANSWER:input.memory.length?'我记得你之前提供的信息。结合你刚才说的内容，我们可以继续围绕当前变化和下一步安排来谈。':'我听到了你刚才说的内容。我们可以先从你现在最希望解决的部分开始。',REFUSE:'这个请求超出当前可安全处理的范围。'}[action.type]||'我听到了你刚才说的内容。';return{action_type:action.type,response,citations:action.required_memory_ids};}
function validateAudit(x){if(typeof x?.passed!=='boolean'||!Array.isArray(x?.violations))throw new Error('invalid AuditResult');return x;}
function audit(action,g){const v=[];if(g.action_type!==action.type)v.push('Generator changed the Action Policy decision.');for(const x of action.forbidden_content)if(x&&g.response.includes(x))v.push(`Response includes forbidden content: ${x}`);if(action.type==='ESCALATE'&&!/急救|危机|emergency|crisis/i.test(g.response))v.push('Action Policy requires escalation language.');return{passed:v.length===0,violations:v,grounded_memory_ids:g.citations||[],blocked_response:v.length?g.response:null,safe_response:v.length?'系统已阻止不符合 Action Policy 的回复。':g.response};}
function diff(a,b){const aa=JSON.stringify(a)??'null',bb=JSON.stringify(b)??'null';return {changed:aa!==bb,input_bytes:aa.length,output_bytes:bb.length,summary:aa===bb?'No structured change.':'Output produced or transformed fields; inspect raw JSON for exact values.'};}
function readMemoryGraphSnapshot(store,subjectId){for(let attempt=0;attempt<3;attempt++){const before=store.memoryGraphRevisionFor(subjectId),nodes=store.memoryNodesFor(subjectId),edges=store.memoryEdgesFor(subjectId),after=store.memoryGraphRevisionFor(subjectId);if(before===after)return{revision:after,nodes,edges};}throw new Error(`Memory Graph for ${subjectId} changed repeatedly while being read; retry the observation`);}
function memoryCommitFailure(error){return{kind:/changed concurrently/i.test(String(error?.message||''))?'graph_revision_conflict':'memory_commit_error',message:String(error?.message||error),suggestion:/changed concurrently/i.test(String(error?.message||''))?'Retry this observation so graph versioning is recomputed from the latest patient revision.':'The Memory Graph transaction rolled back. Inspect Memory Node, Memory Edge, provenance and database constraints before retrying; no successful commit is claimed.'};}

export const pipelineInternals={extractMemoryNodes,buildSemanticContextUnits,semanticExtractorInput,bindSemanticSupport,normalizeMemoryNodeOutput,normalizeMemoryTagsOutput,materializeEmptyMemoryTags,validateMemoryTags,locateContiguousQuote,tagMemoryNodes,tagMemoryWithFallback,updateMemoryGraph,currentMemory,actionPolicy,generateFromMemory,audit,augmentExtractorCoverage,augmentMedLoCoMoSourceTurnCoverage,medLoCoMoSourceTurnFallbackCandidates,coverageLedgerCandidates,quarantineUnalignedMemoryNodes,memoryTopicKey,inferSemanticPolarity};
