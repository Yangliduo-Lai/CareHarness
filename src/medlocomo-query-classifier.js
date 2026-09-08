export const MEDLOCOMO_QUERY_CLASSIFIER_VERSION='medlocomo-query-classifier.v1-question-only-no-answerability-label';

// `adversarial` is intentionally absent. It is an evaluator label describing
// whether the released record can answer a question, not a semantic operation
// that an inference-time system may read before retrieval.
export const MEDLOCOMO_RUNTIME_QUERY_TYPES=Object.freeze([
  'medical_reasoning',
  'care_plan_rationale',
  'longitudinal_progression',
  'cross_admission_comparison',
  'frequency_pattern'
]);

export function validateMedLoCoMoQueryClassification(value){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('MedLoCoMo query classification must be one JSON object');
  const allowed=new Set(['query_type','confidence','rationale']);
  if(Object.keys(value).some(key=>!allowed.has(key)))throw new Error('MedLoCoMo query classification contains unsupported fields');
  const queryType=String(value.query_type||'').trim(),confidence=Number(value.confidence),rationale=String(value.rationale||'').normalize('NFKC').trim();
  if(!MEDLOCOMO_RUNTIME_QUERY_TYPES.includes(queryType))throw new Error(`Unknown MedLoCoMo runtime query type: ${queryType||'<empty>'}`);
  if(!Number.isFinite(confidence)||confidence<0||confidence>1)throw new Error('MedLoCoMo query classification confidence must be between 0 and 1');
  if(!rationale||rationale.length>240)throw new Error('MedLoCoMo query classification rationale must contain 1-240 characters');
  return{query_type:queryType,confidence,rationale};
}

export function fallbackMedLoCoMoQueryClassification(question){
  const text=String(question||'').normalize('NFKC').toLowerCase();
  if(/\bhow many\b|\bhow often\b|\bfrequency\b|\bnumber of (?:times|episodes|admissions|occurrences|sites)\b/u.test(text))return classification('frequency_pattern',.9,'The question asks for a count or recurrence pattern.');
  if(/\bcompar|\bdiffer|\bsimilar|\bversus\b|\bvs\.?\b|\bbetween (?:admissions|hospitalizations)\b/u.test(text))return classification('cross_admission_comparison',.82,'The question asks to align a factor across admissions.');
  if(/\bover time\b|\bacross (?:admissions|hospitalizations|time)\b|\bprogress|\bchange|\btrend|\brecurr|\bsubsequent|\bprevious/u.test(text))return classification('longitudinal_progression',.78,'The question asks for a longitudinal trajectory or persistent outcome.');
  if(/\bwhy (?:was|were|did|is|are)|\brationale\b|\breason for (?:choosing|continuing|stopping|holding|avoiding|initiating|starting)|\bgoal of\b/u.test(text))return classification('care_plan_rationale',.74,'The question asks for the patient-specific rationale of a care decision.');
  return classification('medical_reasoning',.62,'The question asks for the best source-supported clinical fact or explanation.');
}

export async function classifyMedLoCoMoQuery(question,gateway){
  const input={question:String(question||'').trim()};
  if(!input.question)throw new Error('MedLoCoMo query classifier requires a non-empty question');
  const fallback=()=>fallbackMedLoCoMoQueryClassification(input.question);
  if(!gateway||typeof gateway.completeJSON!=='function')return{...fallback(),version:MEDLOCOMO_QUERY_CLASSIFIER_VERSION,method:'deterministic_fallback',model_trace:null};
  try{
    const response=await gateway.completeJSON('medlocomo_query_classifier',input,validateMedLoCoMoQueryClassification,fallback,{maxTokens:220,extractJsonObject:true});
    return{...response.value,version:MEDLOCOMO_QUERY_CLASSIFIER_VERSION,method:response.trace?.mock===true||gateway.config?.provider==='mock'?'deterministic_fallback':'llm_question_only',model_trace:response.trace||null};
  }catch(error){
    return{...fallback(),version:MEDLOCOMO_QUERY_CLASSIFIER_VERSION,method:'deterministic_fallback_after_model_error',model_trace:error?.gatewayTrace||{error:{message:String(error?.message||error)}}};
  }
}

function classification(query_type,confidence,rationale){return{query_type,confidence,rationale};}
