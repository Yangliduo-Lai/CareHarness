export const CPCD_DIMENSIONS=Object.freeze({
  session_level_response_generation:['empathy','coherence','professionalism'],
  memory_recall:['accuracy','completeness','temporal_consistency','no_hallucination'],
  temporal_causal_reasoning:['temporal_accuracy','causal_coherence','completeness','no_hallucination']
});

export function cpcdJudgeInput(output,item={}){
  const taskType=String(item.task||''),dimensions=CPCD_DIMENSIONS[taskType];if(!dimensions)throw new Error(`Unsupported CPCD-Bench task: ${taskType}`);
  const reference=taskType==='temporal_causal_reasoning'?(Array.isArray(item.gold)?item.gold[0]:item.gold):null;
  return{task_id:item.score_id,task_type:taskType,question:item.question,input_to_model:item.metadata?.official_input||{},reference_answer:reference,evaluation_focus:item.metadata?.evaluation_focus||{},full_consultation_history:item.metadata?.full_consultation_history||null,official_rubric:item.metadata?.official_rubric||'',model_response:String(output||''),dimensions};
}

export function validateCpcdJudgeOutput(value,item={}){
  const task=String(item.task||''),dimensions=CPCD_DIMENSIONS[task]||[],scores=value?.scores;if(!scores||typeof scores!=='object'||Array.isArray(scores))throw new Error('CPCD-Bench Judge requires a scores object');
  const minimum=task==='session_level_response_generation'?1:0,normalized={};for(const dimension of dimensions){const entry=scores[dimension],score=Number(typeof entry==='object'?entry.score:entry),reason=typeof entry==='object'?entry.reason:'';if(!Number.isInteger(score)||score<minimum||score>5)throw new Error(`CPCD-Bench ${dimension} must be an integer from ${minimum} to 5`);normalized[dimension]={score,reason:String(reason||'')};}
  return{task_id:String(value.task_id||item.score_id||''),scores:normalized,overall:{average_score:dimensions.reduce((sum,key)=>sum+normalized[key].score,0)/dimensions.length,summary:String(value.overall?.summary||value.summary||'')},risk_flags:Array.isArray(value.risk_flags)?value.risk_flags.map(String):[]};
}

export function scoreCpcdJudge(value,item={}){
  const validated=validateCpcdJudgeOutput(value,item),raw=validated.overall.average_score;
  return{score:raw/5,is_correct:null,method:'cpcd_bench_official_llm_judge',reason:validated.overall.summary||'Official CPCD-Bench rubric dimensions scored by the configured Judge.',details:{raw_average_score:raw,scale:item.task==='session_level_response_generation'?'1-5':'0-5',dimension_scores:validated.scores,risk_flags:validated.risk_flags,judge_protocol:'official_repository_rubric',classification_threshold:null}};
}

export function scoreCpcdJudgeUnavailable(reason){return{score:null,is_correct:null,method:'cpcd_bench_official_judge_required',reason,details:{judge_protocol:'official_repository_rubric'}};}
