// Deterministic, benchmark-agnostic grounding checks for assessor-authored
// claims. These checks are deliberately conservative: citations must support
// the whole patient-specific statement, not merely share one short token.

import { canonicalCalendarDate,canonicalCalendarMonth } from './temporal-expressions.js';

const PATIENT_ASSERTION_PATTERN=/(?:患者|该患者|此患者|本人|您|你|目前|当前|近期|最近|既往|曾经|已经|已确诊|确诊为|诊断为|开始|加用|停用|改用|增加剂量|减少剂量|检查显示|结果为|升至|降至|发生了|出现了)/iu;
const NEGATION_GROUPS=[['无','没有','未','否认','不存在'],['不再','停止','停用','取消'],['未见','未发现','没发现']];
const DIRECTIONAL_SEMANTIC_GROUPS=[
  [['升高','上升','升至','增加','增多','反弹'],['下降','降低','降至','减少','减少了']],
  [['加重','恶化','变差','进展'],['减轻','改善','好转','缓解']],
  [['开始使用','开始','启用','加用','恢复使用','继续使用'],['停止使用','停止','停用','撤掉','取消','不再使用']],
  [['不足','不够','偏低','缺乏'],['过量','过多','偏高','超量']]
];
const GENERIC_HAN_STOP_WORDS=['患者','该患者','医生','近期','最近','目前','当前','已经','进行','情况','相关','显示','记录','表明','提示','自述','反映','约'];
const GENERIC_LATIN_WORDS=new Set(['patient','patients','doctor','current','recent','with','without','after','before','from','into','that','this','likely','possible','possibly']);

export function patientClaimGrounding(claim,sources=[]){
  const text=String(claim||'').trim(),sourceTexts=normalizeSources(sources);
  if(!text||!sourceTexts.length)return{grounded:false,reason:'missing_claim_or_source'};
  const joined=sourceTexts.join('\n'),statements=claimStatements(text);
  if(!statements.length)return{grounded:false,reason:'empty_patient_claim'};
  const failed=statements.filter(statement=>!statementSupported(statement,joined));
  return{grounded:failed.length===0,reason:failed.length?'unsupported_statement':'fully_supported',unsupported_statements:failed};
}

export function genericClinicalBridgeGrounding(claim,sources=[]){
  const text=String(claim||'').trim(),sourceTexts=normalizeSources(sources),joined=sourceTexts.join('\n');
  if(!text||!sourceTexts.length)return{grounded:false,reason:'missing_claim_or_source'};
  // A bridge may contribute generic pathophysiology, but it may not smuggle in
  // a new patient diagnosis, treatment, measurement, date, or event.
  if(patientClaimGrounding(text,sourceTexts).grounded)return{grounded:true,reason:'source_supported_statement',establishes_patient_fact:true};
  if(PATIENT_ASSERTION_PATTERN.test(text))return{grounded:false,reason:'ungrounded_patient_assertion'};
  const protectedResult=protectedFactsSupported(text,joined,{generic_bridge:true});
  if(!protectedResult.grounded)return protectedResult;
  return{grounded:true,reason:'explicit_generic_clinical_bridge',establishes_patient_fact:false};
}

export function normalizeHypothesisGroundingScope(value){
  const normalized=String(value||'').trim().toLowerCase().replace(/[\s-]+/g,'_');
  return['generic_clinical_bridge','generic_bridge'].includes(normalized)?'generic_clinical_bridge':'source_supported_patient_fact';
}

function statementSupported(statement,source){
  const compactStatement=compact(statement),compactSource=compact(source);
  if(!compactStatement||!compactSource)return false;
  if(compactSource.includes(compactStatement))return true;
  if(!protectedFactsSupported(statement,source).grounded)return false;
  const claimContent=contentText(statement),sourceContent=contentText(source);
  if(!claimContent||!sourceContent)return false;
  if(sourceContent.includes(claimContent))return true;
  const subsequence=orderedSubsequenceCoverage(claimContent,sourceContent);
  if(claimContent.length>=3&&subsequence>=0.72)return true;
  if(claimContent.length>=5&&characterMultisetCoverage(claimContent,sourceContent)>=0.82)return true;
  const grams=ngrams(claimContent,Math.min(3,Math.max(2,claimContent.length-1)));
  if(!grams.length)return false;
  const covered=grams.filter(token=>sourceContent.includes(token)).length/grams.length;
  return covered>=0.68&&grams.filter(token=>sourceContent.includes(token)).length>=2;
}

function protectedFactsSupported(claim,source,{generic_bridge=false}={}){
  const normalizedSource=normalize(source),compactSource=compact(source),missing=[];
  for(const token of numericTokens(claim))if(!protectedTokenSupported(token,source))missing.push(token);
  for(const token of latinTokens(claim))if(!normalizedSource.includes(normalize(token)))missing.push(token);
  for(const group of NEGATION_GROUPS){if(!group.some(token=>String(claim).includes(token)))continue;if(!group.some(token=>String(source).includes(token)))missing.push(group.find(token=>String(claim).includes(token)));}
  if(!generic_bridge)for(const alternatives of DIRECTIONAL_SEMANTIC_GROUPS)for(const side of alternatives){const claimTerm=side.find(token=>String(claim).includes(token));if(claimTerm&&!side.some(token=>String(source).includes(token)))missing.push(claimTerm);}
  if(generic_bridge)for(const token of namedClinicalEntities(claim))if(!compactSource.includes(compact(token)))missing.push(token);
  return{grounded:missing.length===0,reason:missing.length?'protected_fact_missing':'protected_facts_supported',missing_protected_facts:[...new Set(missing)]};
}

function claimStatements(value){
  return String(value||'').split(/[\n。；;!?！？]+/u).flatMap(sentence=>sentence.split(/(?:，|,|并且|同时|随后|之后|但是|但|以及|从而|进而|并伴有|并出现|并已|并于)/u)).map(item=>item.trim()).filter(item=>contentText(item).length>=2);
}

function numericTokens(value){
  return[...String(value||'').matchAll(/(?:\d{4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?|\d+(?:\.\d+)?(?:\s*[-–—~～至到]\s*\d+(?:\.\d+)?)?\s*(?:%|mmol\s*\/\s*l|mg\s*\/\s*d(?:l|L)|mg\s*\/\s*g|pmol\s*\/\s*l|u\s*\/\s*ml|mmhg|kg|斤|次\s*\/\s*分|bpm|℃|°c|毫克|克|片|单位|次|天|月|年)?)/giu)].map(match=>match[0].trim()).filter(token=>/\d/u.test(token));
}

function latinTokens(value){
  return[...String(value||'').matchAll(/[a-z][a-z0-9]*(?:[+.-][a-z0-9+.-]+)*/giu)].map(match=>match[0]).filter(token=>token.length>=3&&!GENERIC_LATIN_WORDS.has(token.toLowerCase())&&!/^mmol|mg|pmol|bpm$/iu.test(token));
}

function namedClinicalEntities(value){
  const matches=[];
  // Morphology only: no benchmark diseases, medications, or case vocabulary.
  // The short terminal surface is enough to prevent an entirely new named
  // clinical category from entering a generic bridge while allowing generic
  // mechanism wording around an already cited category.
  const pattern=/[\p{Script=Han}]{2,16}(?:病变|综合征|抑制剂|激动剂|[病症炎癌瘤药剂素酚林胍])(?=$|[^\p{Script=Han}]|[可会能的后时与和或])/gu;
  for(const match of String(value||'').matchAll(pattern)){const surface=match[0],terminal=/(病变|综合征|抑制剂|激动剂)$/u.exec(surface)?.[1]||surface.slice(-2);if(terminal.length>=2)matches.push(terminal);}
  return[...new Set(matches)];
}

function protectedTokenSupported(token,source){
  const date=canonicalDate(token);
  if(date){for(const candidate of numericTokens(source))if(canonicalDate(candidate)===date)return true;return false;}
  return compact(source).includes(compact(token));
}

function canonicalDate(value){
  return canonicalCalendarDate(value)||canonicalCalendarMonth(value);
}

function contentText(value){
  let text=normalize(value);
  for(const word of GENERIC_HAN_STOP_WORDS)text=text.replaceAll(word,'');
  return text.replace(/[^\p{Script=Han}a-z0-9+.%/-]+/gu,'');
}
function normalizeSources(values){return values.map(item=>typeof item==='string'?item:item?.text).map(value=>String(value||'').trim()).filter(Boolean);}
function normalize(value){return String(value||'').normalize('NFKC').toLowerCase().replace(/\s+/gu,'').replace(/[–—~～至到]/gu,'-');}
function compact(value){return normalize(value).replace(/[^\p{Script=Han}a-z0-9+.%/-]+/gu,'');}
function ngrams(value,size){const out=[];for(let index=0;index<=value.length-size;index++)out.push(value.slice(index,index+size));return[...new Set(out)];}
function orderedSubsequenceCoverage(needle,haystack){let matched=0;for(const character of haystack){if(character===needle[matched])matched++;if(matched===needle.length)break;}return matched/Math.max(1,needle.length);}
function characterMultisetCoverage(needle,haystack){const counts=new Map();for(const character of haystack)counts.set(character,(counts.get(character)||0)+1);let matched=0;for(const character of needle){const count=counts.get(character)||0;if(!count)continue;matched++;counts.set(character,count-1);}return matched/Math.max(1,needle.length);}
