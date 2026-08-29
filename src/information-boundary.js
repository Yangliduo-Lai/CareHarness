const HIDDEN_BENCHMARK_KEYS=new Set([
  'gold','answer','answers','answer_key','expected_answer','reference','reference_answer',
  'source_key_point','source_key_points','knowledge_point','knowledge_points',
  'judge_reason','judge_metadata','official_evaluation','scoring_reason','explanation',
  'answer_explanation','answers_data','nodes_for_validation','required_nodes_str',
  'required_patient_info','common_wrong_answer','metadata_info','hop_count',
  'reasoning_pattern','reasoning_chain','required_memory_nodes','trap_design',
  'trap_mechanism','inference_type','why_wrong','rubric','evaluation_focus',
  'representative_point','representative_points','answer_source'
]);

export function normalizedBoundaryKey(value){
  return String(value||'').replace(/([a-z0-9])([A-Z])/g,'$1_$2').replace(/[\s-]+/g,'_').toLowerCase();
}

export function isHiddenBenchmarkKey(value){return HIDDEN_BENCHMARK_KEYS.has(normalizedBoundaryKey(value));}

export function assertNoHiddenBenchmarkInput(value,path='runtime'){
  if(Array.isArray(value)){value.forEach((item,index)=>assertNoHiddenBenchmarkInput(item,`${path}[${index}]`));return true;}
  if(!value||typeof value!=='object')return true;
  for(const[key,item]of Object.entries(value)){
    if(isHiddenBenchmarkKey(key))throw new Error(`Benchmark leakage: Forbidden post-answer field in runtime input: ${path}.${key}`);
    assertNoHiddenBenchmarkInput(item,`${path}.${key}`);
  }
  return true;
}
