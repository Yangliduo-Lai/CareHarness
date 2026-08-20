export const CPCD_DIMENSIONS=Object.freeze({
  session_level_response_generation:['empathy','coherence','professionalism'],
  memory_recall:['accuracy','completeness','temporal_consistency','no_hallucination'],
  temporal_causal_reasoning:['temporal_accuracy','causal_coherence','completeness','no_hallucination']
});

export const CPCD_PROMPT_PROTOCOL=Object.freeze({
  repository:'Psy-Chronicle',
  commit:'ff812c9084b606631dac3a8c01f7be0d5cbc8c8d',
  session_level_response_generation:'official-online-script-exact',
  memory_recall:'official-online-template-adapted-careharness-memory',
  temporal_causal_reasoning:'official-online-template-adapted-careharness-memory'
});

export function cpcdAnswerInput(runtimeInput={},item={}){
  const taskType=String(item.task||''),dimensions=CPCD_DIMENSIONS[taskType];
  if(!dimensions)throw new Error(`Unsupported CPCD-Bench task: ${taskType}`);
  const metadata=item.metadata||{},memorySource=taskType==='session_level_response_generation'?null:{
    states:runtimeInput.retrieved_states||[],
    evidence:runtimeInput.retrieved_evidence||[],
    evidence_chains:runtimeInput.retrieved_evidence_chains||[],
    working_state:runtimeInput.working_state||null,
    verified_relations:runtimeInput.query_time_relations||[],
    evidence_proof:runtimeInput.evidence_proof||null,
    action_policy:runtimeInput.harness_action_policy||null
  };
  // This allow-list is the answer-time visibility boundary. Evaluator-only
  // representative/reference/answer_source/evaluation/rubric/history fields are omitted.
  return{
    task_id:item.score_id,
    task_type:taskType,
    case_id:metadata.case_id||null,
    task_file:metadata.task_file||null,
    full_session_file:metadata.full_session_file||null,
    question:item.question,
    input_to_model:metadata.official_input||{},
    memory_source:memorySource,
    prompt_protocol:CPCD_PROMPT_PROTOCOL[taskType]
  };
}

export function cpcdAnswerMaxTokens(item={}){
  return{session_level_response_generation:800,memory_recall:512,temporal_causal_reasoning:3000}[String(item.task||'')]||800;
}

export function cpcdJudgeMaxTokens(item={}){
  return{session_level_response_generation:1200,memory_recall:1200,temporal_causal_reasoning:2200}[String(item.task||'')]||1200;
}

export function cpcdJudgeInput(output,item={}){
  const taskType=String(item.task||''),dimensions=CPCD_DIMENSIONS[taskType];if(!dimensions)throw new Error(`Unsupported CPCD-Bench task: ${taskType}`);
  const metadata=item.metadata||{},reference=Array.isArray(item.gold)?item.gold[0]:item.gold;
  return{
    task_id:item.score_id,
    task_type:taskType,
    case_id:metadata.case_id||null,
    task_file:metadata.task_file||null,
    full_session_file:metadata.full_session_file||null,
    question:item.question,
    input_to_model:metadata.official_input||{},
    representative_point:taskType==='session_level_response_generation'?metadata.representative_point??null:null,
    reference_answer:taskType==='memory_recall'||taskType==='temporal_causal_reasoning'?reference??null:null,
    answer_source:taskType==='memory_recall'?metadata.answer_source??{}:null,
    evaluation_focus:taskType==='session_level_response_generation'||taskType==='temporal_causal_reasoning'?metadata.evaluation_focus??{}:null,
    full_consultation_history:taskType==='session_level_response_generation'?null:metadata.full_consultation_history||null,
    official_rubric:metadata.official_rubric||'',
    model_response:String(output||''),
    dimensions
  };
}

export function validateCpcdJudgeOutput(value,item={}){
  const task=String(item.task||'');
  if(task==='session_level_response_generation')return validateSessionResponseJudge(value,item);
  if(task==='memory_recall'||task==='temporal_causal_reasoning')return validateLongitudinalJudge(value,item);
  throw new Error(`Unsupported CPCD-Bench task: ${task}`);
}

export function scoreCpcdJudge(value,item={}){
  const validated=validateCpcdJudgeOutput(value,item),task=String(item.task||''),dimensions=CPCD_DIMENSIONS[task],isSession=task==='session_level_response_generation',raw=isSession?validated.overall.average_score:validated.average_score;
  const dimensionScores=Object.fromEntries(dimensions.map(key=>isSession?[key,validated.scores[key]]:[key,{score:validated.scores[key],reason:validated.rationales[key]||''}]));
  const reason=isSession?validated.overall.summary:validated.overall_comment;
  return{score:Number.isFinite(raw)?raw/5:null,is_correct:null,method:'cpcd_bench_official_llm_judge',reason:reason||'Official CPCD-Bench online-script rubric dimensions scored by the configured Judge.',details:{raw_average_score:raw,scale:isSession?'1-5':'0-5',dimension_scores:dimensionScores,risk_flags:isSession?validated.risk_flags:[],judge_protocol:'official_repository_online_scripts_ff812c9',classification_threshold:null}};
}

export function scoreCpcdJudgeUnavailable(reason){return{score:null,is_correct:null,method:'cpcd_bench_official_judge_required',reason,details:{judge_protocol:'official_repository_online_scripts_ff812c9'}};}

function validateSessionResponseJudge(value,item){
  const dimensions=CPCD_DIMENSIONS.session_level_response_generation,scores=value?.scores&&typeof value.scores==='object'&&!Array.isArray(value.scores)?value.scores:{},normalized={},valid=[];
  for(const dimension of dimensions){
    const entry=scores[dimension]&&typeof scores[dimension]==='object'&&!Array.isArray(scores[dimension])?scores[dimension]:{},score=officialSessionInteger(entry.score);
    normalized[dimension]={score,reason:String(entry.reason||'')};if(Number.isInteger(score))valid.push(score);
  }
  return{task_id:String(value?.task_id||item.score_id||''),scores:normalized,overall:{average_score:valid.length?Math.round(valid.reduce((sum,score)=>sum+score,0)/valid.length*100)/100:null,summary:String(value?.overall?.summary||'')},risk_flags:Array.isArray(value?.risk_flags)?value.risk_flags.map(String):['无']};
}

function validateLongitudinalJudge(value,item){
  const task=String(item.task||''),dimensions=CPCD_DIMENSIONS[task],scores=value?.scores;
  if(!scores||typeof scores!=='object'||Array.isArray(scores))throw new Error('CPCD-Bench Judge requires a scores object');
  const alternatives=task==='memory_recall'?{
    accuracy:['Accuracy'],completeness:['Completeness'],temporal_consistency:['Temporal Consistency','temporal consistency','TemporalConsistency'],no_hallucination:['No Hallucination','no hallucination','NoHallucination']
  }:{
    temporal_accuracy:['Temporal Accuracy','temporal accuracy','TemporalAccuracy'],causal_coherence:['Causal Coherence','causal coherence','CausalCoherence'],completeness:['Completeness'],no_hallucination:['No Hallucination','no hallucination','NoHallucination']
  };
  const normalized={};for(const dimension of dimensions){let raw=scores[dimension];if(raw===undefined)for(const alias of alternatives[dimension])if(Object.hasOwn(scores,alias)){raw=scores[alias];break;}const score=officialStrictInteger(raw);if(!Number.isInteger(score)||score<0||score>5)throw new Error(`CPCD-Bench ${dimension} must be an integer from 0 to 5`);normalized[dimension]=score;}
  const rationales=value?.rationales&&typeof value.rationales==='object'&&!Array.isArray(value.rationales)?Object.fromEntries(dimensions.map(key=>[key,String(value.rationales[key]||'')])):Object.fromEntries(dimensions.map(key=>[key,'']));
  return{scores:normalized,rationales,overall_comment:String(value?.overall_comment||''),average_score:Math.round(normalizedAverage(normalized,dimensions)*1000)/1000};
}

function officialSessionInteger(value){
  let parsed=null;if(typeof value==='boolean')parsed=Number(value);else if(typeof value==='number'&&Number.isFinite(value))parsed=Math.trunc(value);else if(typeof value==='string'&&/^[+-]?\d+$/u.test(value.trim()))parsed=Number(value.trim());
  return Number.isInteger(parsed)?Math.max(1,Math.min(5,parsed)):null;
}
// Python's official online normalizers call int(value): finite JSON numbers are
// truncated, booleans become 0/1, and decimal strings remain invalid.
function officialStrictInteger(value){if(typeof value==='boolean')return Number(value);if(typeof value==='number'&&Number.isFinite(value))return Math.trunc(value);if(typeof value==='string'&&/^[+-]?\d+$/u.test(value.trim()))return Number(value.trim());return null;}
function normalizedAverage(scores,dimensions){return dimensions.reduce((sum,key)=>sum+scores[key],0)/dimensions.length;}
