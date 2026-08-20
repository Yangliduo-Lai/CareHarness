export const FAILURE_TAXONOMY_VERSION='careharness-failure-taxonomy.v1';

export const FAILURE_TAXONOMY=deepFreeze({
  H1:{axis:'harness',name:'evidence_extraction_or_indexing',component:'Evidence'},
  H2:{axis:'harness',name:'state_construction_or_versioning',component:'State'},
  H3:{axis:'harness',name:'working_state_focus_or_retrieval',component:'focus'},
  H4:{axis:'harness',name:'temporal_trace_or_version_resolution',component:'trace'},
  H5:{axis:'harness',name:'relation_or_hypothesis_evaluation',component:'connect/evaluate'},
  H6:{axis:'harness',name:'verification_or_claim_evidence_binding',component:'verify'},
  H7:{axis:'harness',name:'action_policy_budget_or_termination',component:'action_policy'},
  M1:{axis:'model_foundation',name:'action_or_tool_execution',component:'model_policy'},
  M2:{axis:'model_foundation',name:'instruction_or_output_format',component:'answer_model'},
  M3:{axis:'model_foundation',name:'reasoning_with_sufficient_context',component:'answer_model'},
  M4:{axis:'model_foundation',name:'medical_domain_knowledge',component:'answer_model'},
  M5:{axis:'model_foundation',name:'safety_judgment',component:'answer_model'},
  X1:{axis:'external',name:'source_memory_or_benchmark_insufficiency',component:'dataset'},
  X2:{axis:'external',name:'scorer_or_judge_disagreement',component:'scorer'},
  X3:{axis:'external',name:'infrastructure_or_implementation_failure',component:'runtime'}
});

const TEMPORAL_TASKS=new Set(['temporal_localization','state_update']);
const COMPLEX_TASKS=new Set(['inference_generation','multi_hop_clinical_deduction']);
const DIAGNOSTIC_STOP_TERMS=new Set(['患者','问题','回答','答案','正确','错误','需要','信息','根据','没有','这个','什么','应该','可以','进行','the','and','answer','patient','question','correct','incorrect']);

export function attributeFailure({score,raw_observations=[],all_evidence=[],all_states=[],runtime_context=null}){
  if(!score)throw new Error('score record is required');
  const context=runtime_context||score.retrieval_context||{},diagnostic=postAnswerDiagnosticInput(score),terms=diagnosticTerms(diagnostic),task=String(score.task||''),isFailure=score.status==='failed'||score.is_correct===false||Number(score.score)<1;
  const rawCheck=stageCheck('raw_session',raw_observations,item=>item.raw_text,terms,item=>item.observation_id||`${item.episode_id}/${item.turn_id}`),
    evidenceCheck=stageCheck('Evidence',all_evidence,item=>item.text,terms,item=>item.evidence_id),
    stateCheck=stageCheck('State',all_states,item=>item.value,terms,item=>item.state_id),
    workingStates=context.retrieved_states||context.states||[],workingCheck=stageCheck('Working_State',workingStates,item=>item.value,terms,item=>item.state_id),
    relationCheck=relationStage(context,task,score),verifyCheck=verifyStage(context),answerCheck=answerStage(score,terms),scorerCheck=scorerStage(score,diagnostic),relationEvaluatorFailure=semanticRelationEvaluatorFailure(context,score);
  const checks=[rawCheck,evidenceCheck,stateCheck,workingCheck,relationCheck,verifyCheck,answerCheck,scorerCheck];
  if(!isFailure)return envelope(null,score,checks,diagnostic,'not_a_failure',1);
  let code,reason,confidence=.78;
  if(score.status==='failed'||score.judge_infrastructure_failure){code='X3';reason='answer/scorer runtime did not complete';confidence=.98;}
  else if(relationEvaluatorFailure){code=relationEvaluatorFailure.code;reason=relationEvaluatorFailure.reason;confidence=relationEvaluatorFailure.confidence;}
  else if(scorerCheck.disagreement){code='X2';reason='system output matches the available post-answer reference but the scorer marked it wrong';confidence=.9;}
  else if(score.memory_incomplete||(!rawCheck.supported&&terms.length)){code='X1';reason=score.memory_incomplete?'visible memory build was incomplete':'diagnostic target is not supported by the visible raw sessions';confidence=.88;}
  else if(rawCheck.supported&&!evidenceCheck.supported){code='H1';reason='support exists in a visible raw session but is absent from Evidence';}
  else if(evidenceCheck.supported&&!stateCheck.supported){code='H2';reason='support exists in Evidence but is absent from persistent versioned State';}
  else if(stateCheck.supported&&!workingCheck.supported){code='H3';reason='support exists in State but focus did not place it in Working State';}
  else if(TEMPORAL_TASKS.has(task)&&!relationCheck.trace_satisfied){code='H4';reason='temporal/version trace required by the task was absent or unresolved';}
  else if(COMPLEX_TASKS.has(task)&&!relationCheck.support_chain_satisfied){code='H5';reason='the complex task lacked a verified query-time relation/support set';}
  else if(!verifyCheck.satisfied){code='H6';reason='Working State or claims failed evidence binding verification';}
  else if(!policySatisfied(context,task)){code='H7';reason='the selected action policy omitted a required action, exhausted its budget, or failed to terminate';}
  else if(formatFailure(score)){code='M2';reason='the answer violated the task output contract despite sufficient context';confidence=.9;}
  else if(safetyFailure(score)){code='M5';reason='the answer violated an explicit safety constraint despite sufficient context';confidence=.82;}
  else if(actionExecutionFailure(context)){code='M1';reason='the model failed to execute a selected action';confidence=.86;}
  else if(medicalKnowledgeFailure(score)){code='M4';reason='the post-answer diagnosis indicates a medical-mechanism or domain-knowledge error after context verification';confidence=.68;}
  else{code='M3';reason='the answer remained wrong after the required context and verification stages were satisfied';confidence=.66;}
  return envelope(code,score,checks,diagnostic,reason,confidence);
}

export function failureTaxonomyReport(attributions=[]){
  const failures=attributions.filter(item=>item.code),counts=Object.fromEntries(Object.keys(FAILURE_TAXONOMY).map(code=>[code,failures.filter(item=>item.code===code).length])),axis={harness:0,model_foundation:0,external:0};
  for(const item of failures)axis[item.axis]++;
  return{version:FAILURE_TAXONOMY_VERSION,total:attributions.length,failure_count:failures.length,counts,axis,high_frequency_harness_failure:Object.entries(counts).filter(([code])=>code.startsWith('H')).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))[0]?.[0]||null,post_answer_only:true,runtime_gold_or_judge_metadata_used:false};
}

function envelope(code,score,checks,diagnostic,reason,confidence){const taxonomy=code?FAILURE_TAXONOMY[code]:null;return{version:FAILURE_TAXONOMY_VERSION,score_id:score.score_id||null,task:score.task||null,code,axis:taxonomy?.axis||null,name:taxonomy?.name||null,component:taxonomy?.component||null,reason,confidence,counterfactual_checks:checks,diagnostic_boundary:{phase:'post_answer_offline_only',answer_frozen:true,gold_or_judge_metadata_opened:true,runtime_input_modified:false,metadata_fields_used:diagnostic.fields_used}};}

function postAnswerDiagnosticInput(score){
  if(score.system_output==null)throw new Error('Failure attribution is post-answer only: system_output must already be frozen');
  const parts=[],fields=[];
  const add=(field,value)=>{if(value==null)return;fields.push(field);parts.push(typeof value==='string'?value:JSON.stringify(value));};
  add('gold',score.gold);add('scoring_reason',score.scoring_reason);add('scoring_details',score.scoring_details);
  return{text:parts.join(' '),fields_used:fields};
}
function diagnosticTerms(diagnostic){return tokens(diagnostic.text).filter(term=>term.length>1&&!DIAGNOSTIC_STOP_TERMS.has(term)).slice(0,96);}
function stageCheck(stage,items,textOf,terms,idOf){
  const scored=items.map(item=>{const hits=overlapTerms(textOf(item),terms);return{id:idOf(item),hits};}).filter(item=>item.hits.length).sort((a,b)=>b.hits.length-a.hits.length),threshold=terms.length?Math.min(2,terms.length):0;
  return{stage,item_count:items.length,supported:terms.length?Boolean(scored[0]&&scored[0].hits.length>=threshold):items.length>0,matched_ids:scored.slice(0,12).map(item=>item.id),matched_terms:[...new Set(scored.slice(0,12).flatMap(item=>item.hits))].slice(0,24),post_answer_reference_used:true};
}
function relationStage(context,task,score){const relations=context.relations||context.working_state?.evidence?.verified_relations||[],trace=context.action_trace||context.action_policy?.trace||[],proof=context.proof||context.working_state?.evidence?.proof||null,selected=new Set(trace.map(item=>item.action)),semanticTrace=semanticRelationEvaluatorTrace(context,score),traceSatisfied=!TEMPORAL_TASKS.has(task)||(selected.has('trace')&&(context.working_state?.temporal?.resolved_state_ids||[]).length>0),supportSatisfied=!COMPLEX_TASKS.has(task)||(selected.has('connect')&&selected.has('evaluate')&&relations.every(item=>item.verified===true&&item.causal_claim!==true)&&Boolean(proof?.complete));return{stage:'relation/verify-route',relation_count:relations.length,relation_types:[...new Set(relations.map(item=>item.type))],trace_satisfied:traceSatisfied,support_chain_satisfied:supportSatisfied,semantic_evaluator_status:semanticTrace?.status||'not_run',semantic_evaluator_error_kind:semanticTrace?.error_kind||semanticTrace?.model_trace?.error?.kind||null,pre_semantic_verification_safe_to_answer:semanticTrace?.pre_semantic_verification?.safe_to_answer??context.pre_semantic_verification?.safe_to_answer??null,persistent_graph_used:relations.some(item=>item.persistent===true),persistent_relation_count:relations.filter(item=>item.persistent===true).length,query_local_relation_count:relations.filter(item=>item.persistent===false).length,causal_relation_claimed:relations.some(item=>item.causal_claim===true),post_answer_reference_used:false};}
function verifyStage(context){const verification=context.verification||context.working_state?.evidence?.verification||null,trace=context.action_trace||[],verifyAction=trace.find(item=>item.action==='verify');return{stage:'verify',satisfied:Boolean(verifyAction&&verification&&verification.gold_or_judge_input_used===false),rejected_state_count:verification?.rejected_states?.length??null,unsupported_claims_removed:verification?.unsupported_claims_removed??null,post_answer_reference_used:false};}
function answerStage(score,terms){const hits=overlapTerms(score.system_output,terms);return{stage:'answer',answer_frozen:true,supported:terms.length?hits.length>=Math.min(2,terms.length):Boolean(String(score.system_output||'').trim()),matched_terms:hits.slice(0,24),post_answer_reference_used:true};}
function scorerStage(score,diagnostic){const output=normalizeAnswer(score.system_output),gold=normalizeAnswer(score.gold),disagreement=Boolean(output&&gold&&output===gold&&score.is_correct===false);return{stage:'scorer',status:score.status,method:score.scoring_method||null,score:score.score??null,is_correct:score.is_correct??null,disagreement,judge_infrastructure_failure:Boolean(score.judge_infrastructure_failure),diagnostic_fields:diagnostic.fields_used,post_answer_reference_used:true};}
function policySatisfied(context,task){const selected=context.action_policy?.selected_actions||context.action_trace?.map(item=>item.action)||[],required=['focus','verify','answer'];if(TEMPORAL_TASKS.has(task))required.push('trace');if(COMPLEX_TASKS.has(task))required.push('trace','connect','evaluate');return required.every(action=>selected.includes(action))&&selected.at(-1)==='answer'&&selected.length<=Number(context.action_policy?.action_budget||Infinity);}
function actionExecutionFailure(context){return(context.action_trace||[]).some(item=>item.status!=='completed');}
function semanticRelationEvaluatorTrace(context,score){return context.semantic_relation_evaluator||context.trace?.semantic_relation_evaluator||score?.retrieval_trace?.semantic_relation_evaluator||null;}
function semanticRelationEvaluatorFailure(context,score){const trace=semanticRelationEvaluatorTrace(context,score);if(trace?.status!=='failed')return null;const kind=String(trace.error_kind||trace.model_trace?.error?.kind||''),message=String(trace.error||trace.model_trace?.error?.message||''),external=['transport_error','timeout','configuration_error','provider_error'].includes(kind)||/no api key|provider|transport|network|socket|timeout|aborted|econn|enotfound|unavailable|configuration/i.test(message);return external?{code:'X3',reason:'the query-time relation evaluator failed because its provider, transport, or runtime configuration was unavailable',confidence:.97}:{code:'M1',reason:'the Answer Model failed to execute the query-time relation-evaluation action or return a valid evaluator payload',confidence:.9};}
function formatFailure(score){const output=String(score.system_output||'').trim();if(score.task==='multiple_choice')return!/^[A-Z](?:,\s*[A-Z])*$/u.test(output);if(score.task==='temporal_localization')return!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(output);if(score.task==='multi_hop_clinical_deduction')return output.length===0;return/格式|format|选项字母|timestamp|json/i.test(String(score.scoring_reason||''));}
function safetyFailure(score){return/安全|禁忌|过敏|危险|伤害|safety|contraindicat|allerg|harm/i.test(String(score.scoring_reason||''));}
function medicalKnowledgeFailure(score){return/机制|病理|药理|诊断|临床知识|medical|mechanism|pathophysi|pharmacol/i.test(String(score.scoring_reason||''));}
function overlapTerms(value,terms){const available=new Set(tokens(value));return terms.filter(term=>available.has(term));}
function tokens(value){const text=String(value||'').normalize('NFKC').toLowerCase(),english=text.match(/[a-z][a-z0-9.+-]{1,}/g)||[],han=text.match(/[\p{Script=Han}]+/gu)||[],grams=[];for(const block of han)for(let i=0;i<block.length-1;i++)grams.push(block.slice(i,i+2));return[...new Set([...english,...grams])];}
function normalizeAnswer(value){return String(value??'').normalize('NFKC').toLowerCase().replace(/[\s，,。.!！?？:：;；"'“”‘’()（）\[\]{}]/g,'');}
function deepFreeze(value){if(!value||typeof value!=='object'||Object.isFrozen(value))return value;for(const child of Object.values(value))deepFreeze(child);return Object.freeze(value);}
