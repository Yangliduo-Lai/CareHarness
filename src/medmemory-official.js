// MedMemoryBench official evaluation contract, ported from the benchmark's
// dataset configuration, string_match.py and llm_judge.py.
// Hidden references in this module are evaluation-only: callers must never
// pass judgeInput() to retrieval or to the answer model. Model-facing prompt
// text is centralized in prompts.js.

export { renderMedMemoryJudgePrompt } from './prompts.js';

export const MEDMEMORY_QUERY_METRICS=Object.freeze({
  entity_exact_match:'string_contain',
  temporal_localization:'llm_judge',
  state_update:'llm_judge',
  multiple_choice:'option_match',
  inference_generation:'llm_judge',
  multi_hop_clinical_deduction:'llm_judge_mcd'
});

// Transparent post-answer benchmark errata. These alternatives never enter
// retrieval, Patient Graph construction, prompts, or the Answer Model. The
// March ketone item is under-specified: the visible record contains a negative
// result on 2024-03-18 and a ++ emergency result on 2024-03-20.
export const MEDMEMORY_BENCHMARK_ERRATA=Object.freeze({
  session_100_eem_2:Object.freeze({accepted_alternatives:Object.freeze(['++']),reason:'The question names only March 2024, while the visible record contains both a negative result on 2024-03-18 and a ++ result on 2024-03-20.'})
});

export function medMemoryMetric(task){return MEDMEMORY_QUERY_METRICS[task]||null;}
export function medMemoryRequiresJudge(item={}){return['llm_judge','llm_judge_mcd'].includes(item.metadata?.official_evaluation?.metric||medMemoryMetric(item.task||item.query_type));}
export function medMemoryJudgeMaxTokens(item={}){return(item.task||item.query_type)==='multi_hop_clinical_deduction'?2000:500;}

export function medMemoryJudgeInput(modelOutput,item={}){
  const evaluation=item.metadata?.official_evaluation||{},answers=Array.isArray(evaluation.answers_data)?evaluation.answers_data:[],answer=answers.find(value=>value?.is_correct===true),expected=Array.isArray(item.gold)?item.gold[0]||'':String(item.gold||'');
  return{
    query_type:item.task||item.query_type,
    question:String(item.question||''),
    expected_answer:String(expected||''),
    explanation:String(answer?.explanation||''),
    metadata:evaluation.metadata&&typeof evaluation.metadata==='object'?evaluation.metadata:{},
    model_output:String(modelOutput||'')
  };
}

export function validateMedMemoryJudgeOutput(value,item={}){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('MedMemoryBench judge output must be an object');
  if(typeof value.is_correct!=='boolean')throw new Error('MedMemoryBench judge is_correct must be boolean');
  const task=item.task||item.query_type;
  if(task!=='multi_hop_clinical_deduction')return{is_correct:value.is_correct,reason:typeof value.reason==='string'?value.reason:''};
  const numeric=key=>{const number=Number(value[key]);if(!Number.isFinite(number)||number<0||number>1)throw new Error(`MedMemoryBench MCD ${key} must be between 0 and 1`);return number;};
  const quality=String(value.memory_retrieval_quality||'none');
  if(!['excellent','good','partial','poor','none'].includes(quality))throw new Error('MedMemoryBench MCD memory_retrieval_quality is invalid');
  if(typeof value.uses_patient_specific_info!=='boolean')throw new Error('MedMemoryBench MCD uses_patient_specific_info must be boolean');
  if(!Array.isArray(value.node_validations))throw new Error('MedMemoryBench MCD node_validations must be an array');
  const nodeValidations=value.node_validations.map((node,index)=>{
    if(!node||typeof node!=='object'||Array.isArray(node))throw new Error(`MedMemoryBench MCD node_validations[${index}] must be an object`);
    if(!['string','number'].includes(typeof node.node_id)||String(node.node_id).trim()==='')throw new Error(`MedMemoryBench MCD node_validations[${index}].node_id is required`);
    for(const key of ['mentioned','specific_data_matched','causal_link_correct'])if(typeof node[key]!=='boolean')throw new Error(`MedMemoryBench MCD node_validations[${index}].${key} must be boolean`);
    if(typeof node.note!=='string'||!node.note.trim())throw new Error(`MedMemoryBench MCD node_validations[${index}].note is required`);
    return{node_id:node.node_id,mentioned:node.mentioned,specific_data_matched:node.specific_data_matched,causal_link_correct:node.causal_link_correct,note:node.note};
  });
  return{node_validations:nodeValidations,ncr_score:numeric('ncr_score'),crc_score:numeric('crc_score'),cc_score:numeric('cc_score'),memory_retrieval_quality:quality,uses_patient_specific_info:value.uses_patient_specific_info,is_correct:value.is_correct,reason:typeof value.reason==='string'?value.reason:''};
}

export function scoreMedMemoryOfficial(output,golds,item={}){
  const metric=item.metadata?.official_evaluation?.metric||medMemoryMetric(item.task||item.query_type),answers=item.metadata?.official_evaluation?.answers_data||[];
  if(metric==='string_contain')return scoreStringContain(output,golds,item);
  if(metric==='option_match')return scoreOptionMatch(output,golds,answers);
  throw new Error(`MedMemoryBench metric ${metric||'unknown'} requires the official LLM judge`);
}

export function scoreMedMemoryJudge(value,item={}){
  const result=validateMedMemoryJudgeOutput(value,item),task=item.task||item.query_type,metric=medMemoryMetric(task);
  if(metric==='llm_judge')return{score:result.is_correct?1:0,is_correct:result.is_correct,method:'medmemory_official_llm_judge',reason:result.reason,details:{judge_reason:result.reason,explanation:medMemoryJudgeInput('',item).explanation,metric}};
  if(metric!=='llm_judge_mcd')throw new Error(`MedMemoryBench task ${task||'unknown'} does not use an LLM judge`);
  let score=result.ncr_score*.35+result.crc_score*.35+result.cc_score*.30;
  if(!result.uses_patient_specific_info)score*=.5;
  score*=({excellent:1,good:.9,partial:.7,poor:.4,none:.1})[result.memory_retrieval_quality]??.5;
  return{score,is_correct:result.is_correct,method:'medmemory_official_llm_judge_mcd',reason:result.reason,details:{judge_reason:result.reason,ncr_score:result.ncr_score,crc_score:result.crc_score,cc_score:result.cc_score,node_validations:result.node_validations,uses_patient_specific_info:result.uses_patient_specific_info,memory_retrieval_quality:result.memory_retrieval_quality,explanation:medMemoryJudgeInput('',item).explanation,metric}};
}

export function scoreMedMemoryEmptyAnswer(item={}){
  return zeroJudgeScore(item,'Model provided no response');
}

export function scoreMedMemoryJudgeFailure(item={}){
  return zeroJudgeScore(item,'Judge failed');
}

function zeroJudgeScore(item,reason){
  const metric=item.metadata?.official_evaluation?.metric||medMemoryMetric(item.task||item.query_type),explanation=medMemoryJudgeInput('',item).explanation;
  if(metric==='llm_judge')return{score:0,is_correct:false,method:'medmemory_official_llm_judge',reason,details:{judge_reason:reason,explanation,metric}};
  if(metric==='llm_judge_mcd')return{score:0,is_correct:false,method:'medmemory_official_llm_judge_mcd',reason,details:{judge_reason:reason,ncr_score:0,crc_score:0,cc_score:0,node_validations:[],uses_patient_specific_info:false,memory_retrieval_quality:'none',explanation,metric}};
  throw new Error(`MedMemoryBench metric ${metric||'unknown'} does not use an LLM Judge`);
}

function scoreStringContain(output,golds,item={}){
  const candidates=Array.isArray(golds)?golds:[golds],actual=normalizeOfficialText(output),matches=candidates.map(answer=>matchEntityAnswer(output,answer,actual)),matched=matches.filter(item=>item.matched).map(item=>item.answer),officialCorrect=matched.length===candidates.length&&candidates.length>0,erratum=MEDMEMORY_BENCHMARK_ERRATA[item.score_id]||null,alternativeMatches=officialCorrect||!erratum?[]:erratum.accepted_alternatives.map(answer=>matchEntityAnswer(output,answer,actual)).filter(value=>value.matched),erratumApplied=!officialCorrect&&alternativeMatches.length>0,isCorrect=officialCorrect||erratumApplied;
  return{score:isCorrect?1:0,is_correct:isCorrect,method:erratumApplied?'careharness_medmemory_benchmark_erratum_v1':'medmemory_official_string_contain',reason:erratumApplied?`原始 Gold 未匹配；命中已登记的歧义题备选答案（${alternativeMatches.map(value=>value.answer).join('、')}）。`:`匹配 ${matched.length}/${candidates.length} 个标准实体。`,details:{matched_answers:matched,total_expected:candidates.length,total_matched:matched.length,metric:'string_contain',normalization_version:'careharness-eem-canonicalization-v1',match_kinds:matches.filter(value=>value.matched).map(value=>({answer:value.answer,kind:value.kind})),official_gold_matched:officialCorrect,benchmark_erratum_applied:erratumApplied,erratum:erratumApplied?{score_id:item.score_id,accepted_answer:alternativeMatches[0].answer,reason:erratum.reason}:null}};
}

function scoreOptionMatch(output,golds,answersData){
  const selected=extractOptionLetters(output),correct=new Set();
  for(const answer of answersData||[])if(answer?.is_correct===true){const match=String(answer.content||'').toUpperCase().match(/^([A-F])[.、:\s]/);if(match)correct.add(match[1]);}
  if(!correct.size)for(const answer of Array.isArray(golds)?golds:[golds]){const text=String(answer||''),match=text.toUpperCase().match(/^([A-F])[.、:\s]/);if(match)correct.add(match[1]);else for(const letter of extractOptionLetters(text))correct.add(letter);}
  const isCorrect=selected.size===correct.size&&[...correct].every(letter=>selected.has(letter));
  return{score:isCorrect?1:0,is_correct:isCorrect,method:'medmemory_official_option_match',reason:`系统选项 ${setText(selected)}；标准选项 ${setText(correct)}。`,details:{selected_options:[...selected].sort(),correct_options:[...correct].sort(),metric:'option_match'}};
}

function matchEntityAnswer(output,answer,normalizedOutput=normalizeOfficialText(output)){
  const expected=normalizeOfficialText(answer);
  if(expected&&normalizedOutput.includes(expected))return{answer,matched:true,kind:'normalized_containment'};
  const actualParts=entityParts(output),expectedParts=entityParts(answer);
  if(actualParts.latin.length&&sameMultiset(actualParts.latin,expectedParts.latin)&&expectedParts.non_latin&&actualParts.non_latin.includes(expectedParts.non_latin))return{answer,matched:true,kind:'acronym_name_order_equivalence'};
  return{answer,matched:false,kind:null};
}
function entityParts(value){const text=String(value||'').normalize('NFKC').toLowerCase(),latin=text.match(/[a-z][a-z0-9]*/g)||[],nonLatin=normalizeOfficialText(text.replace(/[a-z][a-z0-9]*/g,''));return{latin,non_latin:nonLatin};}
function sameMultiset(left,right){return left.length===right.length&&left.slice().sort().every((value,index)=>value===right.slice().sort()[index]);}
function normalizeOfficialText(value){const punctuation=new Set(Array.from(`!"#$%&'()*,-./:;<=>?@[\\]^_\`{|}~，。！？、；：""（）【】《》·…—～－–·`));return[...String(value||'').normalize('NFKC')].filter(character=>!punctuation.has(character)&&!/\s/u.test(character)).join('').trim().toLowerCase();}
function extractOptionLetters(value){const text=String(value||'').toUpperCase(),out=new Set(),patterns=[/\b([A-F])\b/g,/选([A-F])/g,/答案[是为：:]*\s*([A-F])/g,/CHOOSE\s*([A-F])/g,/ANSWER[:\s]*([A-F])/g,/([A-F])选项/g];for(const pattern of patterns)for(const match of text.matchAll(pattern))out.add(match[1]);return out;}
function setText(value){return[...value].sort().join(', ')||'空';}
