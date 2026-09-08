// MedLoCoMo evaluation protocol from Appendix B of the benchmark paper.
// Gold answers are used only after the candidate answer has been frozen.

const ARTICLES=/\b(a|an|the)\b/giu;
const PUNCTUATION=/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/gu;

export const MEDLOCOMO_CANONICAL_ABSTENTION='the question is not answerable';

// The released QA validator supplies the first five aliases. Appendix B also
// names the shorter normalized equivalents below. Matching remains exact after
// the official normalization; explanatory or fact-asserting answers do not pass.
export const MEDLOCOMO_ABSTENTION_PHRASES=Object.freeze([
  MEDLOCOMO_CANONICAL_ABSTENTION,
  'not answerable from the record',
  'not answerable from the provided context',
  'cannot be determined from the record',
  'no information available',
  'not answerable',
  'cannot be determined',
  'cannot be determined from the provided context',
  'not mentioned',
  'not mentioned in the record',
  'not mentioned in the provided context'
]);

const NORMALIZED_ABSTENTIONS=new Set(MEDLOCOMO_ABSTENTION_PHRASES.map(normalizeMedLoCoMoAnswer));

// Output-surface repair only: canonicalize text that already says the record
// is insufficient. This does not decide answerability or convert a clinical
// finding, negative finding, or ordinary short answer into refusal.
export function canonicalizeMedLoCoMoAbstention(value){
  const answer=String(value||'').trim(),normalized=normalizeMedLoCoMoAnswer(answer);
  if(!normalized)return answer;
  if(NORMALIZED_ABSTENTIONS.has(normalized))return MEDLOCOMO_CANONICAL_ABSTENTION;
  const refusalLike=[
    /^(?:i|we) (?:cannot|can t|am unable to|are unable to) (?:answer|determine|identify|confirm|find|tell)\b/iu,
    /^(?:unable to|cannot|can t) (?:answer|determine|identify|confirm|find|tell)\b/iu,
    /^(?:this )?question (?:cannot|can t|is not|isn t) (?:be )?answer(?:ed|able)\b/iu,
    /^(?:there is|there are) (?:no|not enough|insufficient) (?:information|evidence|documentation|detail|data)\b/iu,
    /^(?:no|not enough|insufficient) (?:information|evidence|documentation|detail|data) (?:is )?(?:available|provided|documented|present|given)?\b/iu,
    /^(?:(?:the|provided|available) )?(?:record|records|chart|context|documentation) (?:does not|do not|doesn t|don t) (?:mention|document|provide|contain|show|establish|specify|state|support|confirm)\b/iu,
    /^(?:based on|from) (?:the )?(?:provided|available)? ?(?:record|records|chart|context|documentation)[\s\S]{0,80}\b(?:cannot|can t|unable|not enough|insufficient|no information)\b/iu
  ];
  return refusalLike.some(pattern=>pattern.test(normalized))?MEDLOCOMO_CANONICAL_ABSTENTION:answer;
}

export function normalizeMedLoCoMoAnswer(value){
  return String(value||'').toLowerCase().replace(PUNCTUATION,' ').replace(ARTICLES,' ').replace(/\s+/gu,' ').trim();
}

export function medLoCoMoTokenF1(prediction,gold){
  const whole=wholeAnswerF1(prediction,gold);
  if(!String(prediction||'').includes(',')&&!String(gold||'').includes(','))return whole;
  const predictedParts=commaParts(prediction),goldParts=commaParts(gold);
  if(!predictedParts.length||!goldParts.length)return whole;
  const precision=average(predictedParts.map(part=>Math.max(...goldParts.map(candidate=>wholeAnswerF1(part,candidate)))));
  const recall=average(goldParts.map(part=>Math.max(...predictedParts.map(candidate=>wholeAnswerF1(candidate,part)))));
  const comma=harmonic(precision,recall);
  return Math.max(whole,comma);
}

export function scoreMedLoCoMoAbstention(output){
  const normalized=normalizeMedLoCoMoAnswer(output),isCorrect=NORMALIZED_ABSTENTIONS.has(normalized);
  return{score:isCorrect?1:0,is_correct:isCorrect,method:'medlocomo_official_adversarial_abstention_matcher',reason:isCorrect?'The normalized answer is an accepted abstention phrase.':'The normalized answer is not in the accepted abstention set.',details:{metric:'adversarial_abstention_accuracy',normalized_answer:normalized,canonical_answer:MEDLOCOMO_CANONICAL_ABSTENTION}};
}

export function medLoCoMoJudgeInput(output,item={}){
  return{items:[{qa_id:String(item.score_id||item.qa_id||''),question:String(item.question||''),gold_answer:String(Array.isArray(item.gold)?item.gold[0]||'':item.gold||''),candidate_answer:String(output||'')}]};
}

export function validateMedLoCoMoJudgeOutput(value,item={}){
  if(!value||typeof value!=='object'||Array.isArray(value)||!Array.isArray(value.judgments))throw new Error('MedLoCoMo judge output must contain a judgments array');
  if(value.judgments.length!==1)throw new Error('MedLoCoMo judge must return exactly one judgment');
  const judgment=value.judgments[0],expectedId=String(item.score_id||item.qa_id||'');
  if(!judgment||typeof judgment!=='object'||Array.isArray(judgment))throw new Error('MedLoCoMo judgment must be an object');
  if(String(judgment.qa_id||'')!==expectedId)throw new Error(`MedLoCoMo judgment qa_id must equal ${expectedId}`);
  if(judgment.score!==0&&judgment.score!==1)throw new Error('MedLoCoMo judgment score must be exactly 0 or 1');
  return{judgments:[{qa_id:expectedId,score:judgment.score}]};
}

export function scoreMedLoCoMoJudge(value,output,item={}){
  const validated=validateMedLoCoMoJudgeOutput(value,item),judgment=validated.judgments[0],gold=Array.isArray(item.gold)?item.gold[0]||'':item.gold||'',f1=medLoCoMoTokenF1(output,gold),isCorrect=judgment.score===1;
  return{score:judgment.score,is_correct:isCorrect,method:'medlocomo_official_answerable_llm_judge',reason:isCorrect?'The answerable-question Judge returned 1.':'The answerable-question Judge returned 0.',details:{metric:'answerable_llm_judge',answerable_token_f1:f1,answerable_judge_score:judgment.score,judgment}};
}

export function scoreMedLoCoMoJudgeUnavailable(output,item={},reason='A live MedLoCoMo Judge model is required'){
  const gold=Array.isArray(item.gold)?item.gold[0]||'':item.gold||'';
  return{score:null,is_correct:null,method:'medlocomo_official_answerable_judge_required',reason,details:{metric:'answerable_llm_judge',answerable_token_f1:medLoCoMoTokenF1(output,gold),answerable_judge_score:null}};
}

function wholeAnswerF1(left,right){
  const predicted=tokens(left),gold=tokens(right);
  if(!predicted.length||!gold.length)return 0;
  const counts=new Map();for(const token of gold)counts.set(token,(counts.get(token)||0)+1);
  let overlap=0;for(const token of predicted){const count=counts.get(token)||0;if(count){overlap++;counts.set(token,count-1);}}
  return harmonic(overlap/predicted.length,overlap/gold.length);
}
function commaParts(value){return String(value||'').split(',').map(part=>part.trim()).filter(Boolean);}
function tokens(value){const normalized=normalizeMedLoCoMoAnswer(value);return normalized?normalized.split(' '):[];}
function harmonic(precision,recall){return precision+recall>0?2*precision*recall/(precision+recall):0;}
function average(values){return values.length?values.reduce((sum,value)=>sum+value,0)/values.length:0;}
