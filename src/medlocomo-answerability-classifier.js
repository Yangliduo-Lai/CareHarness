import { MEDLOCOMO_ANSWERABILITY_POLICY } from './medlocomo-policy.js';

export const MEDLOCOMO_ANSWERABILITY_CLASSIFIER_VERSION=`medlocomo-answerability-classifier.runtime.v2-confidence-semantics-${MEDLOCOMO_ANSWERABILITY_POLICY.source_artifact_hash.slice(0,12)}`;
export const MEDLOCOMO_ANSWERABILITY_REFUSAL_CONFIDENCE=MEDLOCOMO_ANSWERABILITY_POLICY.routing.refusal_confidence_threshold;

const ANSWERABLE_SUPPORT=new Set(['direct','composed']);
const NOT_ANSWERABLE_SUPPORT=new Set(['missing','contradicted']);
const MAX_AUDIT_REASON_CHARS=320;

/**
 * Build the complete inference input for the pre-answer classifier. Deliberately
 * omit the benchmark task label, Gold, Judge metadata, Assessor conclusions,
 * reasoning hypotheses, and any candidate answer.
 */
export function medLoCoMoAnswerabilityInput(input={}){
  const question=String(input.question||'').trim();
  if(!question)throw new Error('MedLoCoMo answerability classifier requires a non-empty question');
  if(Array.isArray(input.evidence))return{question,evidence:input.evidence.map((row,index)=>({
    evidence_id:`E${index+1}`,
    admission_id:textOrNull(row.admission_id),
    turn_id:textOrNull(row.turn_id),
    event_time:textOrNull(row.event_time),
    speaker:textOrNull(row.speaker),
    text:String(row.text||'').trim()
  })).filter(row=>row.text)};
  const ledgerRows=input.evidence_ledger?.source_grounded===true&&Array.isArray(input.evidence_ledger.rows)?input.evidence_ledger.rows:[];
  const evidence=ledgerRows.length?ledgerRows.map((row,index)=>({
    evidence_id:`E${index+1}`,
    admission_id:textOrNull(row.admission_id),
    turn_id:textOrNull(row.turn_id),
    event_time:textOrNull(row.event_time),
    speaker:textOrNull(row.speaker),
    text:String(row.evidence_text||'').trim()
  })).filter(row=>row.text):array(input.memory_nodes).map((node,index)=>({
    evidence_id:`E${index+1}`,
    admission_id:textOrNull(node.episode_id||node.admission_id),
    turn_id:textOrNull(node.turn_id),
    event_time:textOrNull(node.event_time||node.recorded_at),
    speaker:textOrNull(node.speaker),
    text:String(node.source_text||node.text||'').trim()
  })).filter(row=>row.text);
  return{question,evidence};
}

export function validateMedLoCoMoAnswerabilityClassification(value,input={}){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('MedLoCoMo answerability classification must be one JSON object');
  const allowed=new Set(['classification','support','decisive_evidence_ids','confidence','reason']);
  if(Object.keys(value).some(key=>!allowed.has(key)))throw new Error('MedLoCoMo answerability classification contains unsupported fields');
  const normalizedLabel=normalizeClassificationLabel(value.classification),classification=normalizedLabel.classification,explicitSupport=normalizeSupportLabel(value.support),support=explicitSupport||normalizedLabel.support,confidence=Number(value.confidence),reason=normalizeAuditReason(value.reason),reportedEvidenceIds=array(value.decisive_evidence_ids).map(String),decisiveEvidenceIds=[...new Set(reportedEvidenceIds)].slice(0,8);
  if(!['answerable','not_answerable'].includes(classification))throw new Error(`Unknown MedLoCoMo answerability class: ${classification||'<empty>'}`);
  if(normalizedLabel.support&&explicitSupport&&normalizedLabel.support!==explicitSupport)throw new Error('Combined classification label conflicts with the separate support field');
  if(classification==='answerable'&&!ANSWERABLE_SUPPORT.has(support))throw new Error('answerable requires direct or composed support');
  if(classification==='not_answerable'&&!NOT_ANSWERABLE_SUPPORT.has(support))throw new Error('not_answerable requires missing or contradicted support');
  if(!Array.isArray(value.decisive_evidence_ids))throw new Error('decisive_evidence_ids must be an array');
  const availableIds=new Set(array(input.evidence).map(row=>String(row.evidence_id||'')));if(reportedEvidenceIds.some(id=>!availableIds.has(id)))throw new Error('decisive_evidence_ids contains an ID outside the supplied evidence');
  if(((classification==='answerable'&&confidence>0)||support==='contradicted')&&!decisiveEvidenceIds.length)throw new Error(`${support} support requires at least one decisive evidence ID`);
  if(!Number.isFinite(confidence)||confidence<0||confidence>1)throw new Error('MedLoCoMo answerability confidence must be between 0 and 1');
  return{classification,support,decisive_evidence_ids:decisiveEvidenceIds,confidence,reason};
}

export async function classifyMedLoCoMoAnswerability(input,gateway){
  const modelInput=medLoCoMoAnswerabilityInput(input),fallback=()=>answerabilityFallback('Classifier unavailable; let the fallback answer prompt make the evidence-only answerability decision.');
  if(!gateway||typeof gateway.completeJSON!=='function')return{...fallback(),version:MEDLOCOMO_ANSWERABILITY_CLASSIFIER_VERSION,policy_version:MEDLOCOMO_ANSWERABILITY_POLICY.version,method:'answerability_fallback',model_trace:null,route:'answer_with_answerability_check',threshold:MEDLOCOMO_ANSWERABILITY_REFUSAL_CONFIDENCE};
  try{
    const response=await gateway.completeJSON('medlocomo_answerability_classifier',modelInput,value=>validateMedLoCoMoAnswerabilityClassification(value,modelInput),fallback,{maxTokens:320,extractJsonObject:true,maxRetries:2}),classification=response.value,shouldRefuse=classification.classification==='not_answerable'&&classification.confidence>=MEDLOCOMO_ANSWERABILITY_REFUSAL_CONFIDENCE,needsAnswerabilityFallback=classification.classification==='not_answerable'&&!shouldRefuse;
    return{...classification,version:MEDLOCOMO_ANSWERABILITY_CLASSIFIER_VERSION,policy_version:MEDLOCOMO_ANSWERABILITY_POLICY.version,method:response.trace?.mock===true||gateway.config?.provider==='mock'?'answerability_fallback':'llm_evidence_only',model_trace:response.trace||null,route:shouldRefuse?'refuse':needsAnswerabilityFallback?'answer_with_answerability_check':'answer',threshold:MEDLOCOMO_ANSWERABILITY_REFUSAL_CONFIDENCE};
  }catch(error){
    return{...fallback(),version:MEDLOCOMO_ANSWERABILITY_CLASSIFIER_VERSION,policy_version:MEDLOCOMO_ANSWERABILITY_POLICY.version,method:'answerability_fallback_after_model_error',model_trace:error?.gatewayTrace||{error:{message:String(error?.message||error)}},route:'answer_with_answerability_check',threshold:MEDLOCOMO_ANSWERABILITY_REFUSAL_CONFIDENCE};
  }
}

function normalizeClassificationLabel(value){
  const label=String(value||'').normalize('NFKC').trim().toLowerCase().replace(/[\s-]+/gu,'_'),match=label.match(/^(answerable|not_answerable)(?:\/(direct|composed|missing|contradicted))?$/u);
  return match?{classification:match[1],support:match[2]||''}:{classification:label,support:''};
}
function normalizeSupportLabel(value){return String(value||'').normalize('NFKC').trim().toLowerCase().replace(/[\s-]+/gu,'_');}
function normalizeAuditReason(value){const reason=String(value||'').normalize('NFKC').replace(/\s+/gu,' ').trim()||'No classifier rationale was returned.';return reason.slice(0,MAX_AUDIT_REASON_CHARS);}
function answerabilityFallback(reason){return{classification:'undetermined',support:'unavailable',decisive_evidence_ids:[],confidence:0,reason};}
function array(value){return Array.isArray(value)?value:[];}
function textOrNull(value){const text=String(value??'').trim();return text||null;}
