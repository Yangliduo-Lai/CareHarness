const MAX_LITERAL_SUPPLEMENT_ITEMS=4;
const MAX_LITERAL_SUPPLEMENT_ITEM_CHARS=32;
const MAX_LITERAL_SUPPLEMENT_TOTAL_CHARS=80;

const UNIT_PATTERN='(?:mmol\\s*[/／]\\s*[lL]|mg\\s*[/／]\\s*d[lL]|mmHg|bpm|kg|mcg|mg|mL|ml|IU|U|%|％|单位|毫克|微克|千克|公斤|克|斤|毫升|升|次|分钟|小时|天)';
const NUMBER_PATTERN='(?:\\d+(?:\\.\\d+)?|[一二两三四五六七八九十百半]+)';
const NUMBER_RANGE_PATTERN=`${NUMBER_PATTERN}(?:\\s*[-‐‑‒–—~～至到]\\s*${NUMBER_PATTERN})?`;
const NUMERIC_LITERAL_RE=new RegExp(`(?:约|近|接近|超过|高于|低于|大于|小于|不足|至少|至多|不低于|不高于|不少于|不超过)?\\s*${NUMBER_RANGE_PATTERN}\\s*${UNIT_PATTERN}(?:以上|以下|以内|以外|左右|上下|出头)?`,'giu');
const DATE_LITERAL_RE=/(?:(?:19|20)\d{2}\s*[年/.\-]\s*\d{1,2}(?:\s*[月/.\-]\s*\d{1,2}\s*日?)?|\d{1,2}\s*月\s*\d{1,2}\s*日)/gu;
const UNIT_RE=new RegExp(UNIT_PATTERN,'iu');
const NUMBER_RANGE_RE=new RegExp(NUMBER_RANGE_PATTERN,'iu');
const NEGATION_RE=/(?:无任何|无明显|尚未|还未|不再|没再|从未|并无|没有|未见|否认|无需|不必|不能|无法|不可|并未|未|无)/gu;
const SCOPE_RE=/(?:不低于|不高于|不少于|不超过|至少|至多|超过|高于|低于|大于|小于|以上|以下|以内|以外|左右|上下|接近|不足|出头|仅仅|仅|只|约)/gu;
const ORAL_DRUG_CLASS_RE=/口服[\p{Script=Han}A-Za-z0-9+._\-‐‑‒–—]{1,10}?(?:药物|药)/gu;
const LATIN_TERM_RE=/[A-Za-z][A-Za-z0-9+._\-‐‑‒–—]{1,20}(?:\s*(?:抑制剂|激动剂|拮抗剂|受体|抗体|细胞|通路|综合征|糖尿病|病变|轴))?/gu;
const GREEK_TERM_RE=/[α-ωΑ-Ω]\s*(?:细胞|受体|通路|链|亚基|波|球蛋白|肽)/gu;
const MEDICAL_SUFFIX_RE=/[\p{Script=Han}A-Za-z0-9+._\-‐‑‒–—]{2,18}?(?:抑制剂|激动剂|拮抗剂|受体|抗体|胰岛素|细胞|神经|通路|综合征|糖尿病|视网膜病变|药物)/gu;
const DRUG_NAME_RE=/[\p{Script=Han}]{2,10}?(?:西林|沙星|洛尔|普利|沙坦|他汀|格列净|列汀|双胍)/gu;
const LATIN_METADATA_WORDS=new Set(['turn','role','patient','doctor','time','session','structured']);
const LITERAL_SUPPLEMENT_KINDS=new Set(['date','unit','number_unit','medical_term','proper_name','negation','scope']);

/**
 * Return only bounded literal fragments that occur in this Memory Node's own
 * source span but are absent from its structured text. The original source span
 * is never returned.
 */
export function minimalLiteralSupplement(node={}){
  const text=clean(node.text),source=clean(node.source_text);
  if(!text||!source||equivalentLiteral(text,source))return[];
  const candidates=[];
  const add=(raw,kind,start=source.indexOf(raw),priority=0)=>{
    const value=cleanFragment(raw);
    if(!value||literalLength(value)>MAX_LITERAL_SUPPLEMENT_ITEM_CHARS)return;
    if(equivalentLiteral(text,value)||isEquivalentProtectedValue(text,value,kind))return;
    const actualStart=start>=0?start:source.indexOf(value);
    if(actualStart<0||!locallyBoundToStructuredText(source,text,value,actualStart,kind))return;
    candidates.push({text:value,kind,start:actualStart,priority});
  };

  for(const match of source.matchAll(DATE_LITERAL_RE))if(!hasEquivalentDate(text,match[0]))add(match[0],'date',match.index,110);
  for(const match of source.matchAll(NUMERIC_LITERAL_RE)){
    const value=match[0].trim(),number=value.match(NUMBER_RANGE_RE)?.[0]?.trim(),unit=value.match(UNIT_RE)?.[0]?.trim();
    const textHasNumber=number&&equivalentLiteral(text,number),textUnit=text.match(UNIT_RE)?.[0];
    if(textHasNumber&&!textUnit&&unit)add(unit,'unit',match.index+value.indexOf(unit),105);
    else if(!equivalentLiteral(text,value))add(value,'number_unit',match.index,108);
  }

  addRegexMatches(source,ORAL_DRUG_CLASS_RE,(value,start)=>add(value,'medical_term',start,100));
  addRegexMatches(source,LATIN_TERM_RE,(value,start)=>{
    const key=normalizeLiteral(value);
    if(!LATIN_METADATA_WORDS.has(key)&&(/[A-Z\d+._\-‐‑‒–—]/u.test(value)||/[α-ωΑ-Ω]/u.test(value)))add(value,'medical_term',start,98);
  });
  addRegexMatches(source,GREEK_TERM_RE,(value,start)=>add(value,'medical_term',start,98));
  addRegexMatches(source,MEDICAL_SUFFIX_RE,(value,start)=>{
    const trimmed=trimMedicalPrefix(value),offset=value.indexOf(trimmed);
    add(trimmed,'medical_term',start+Math.max(0,offset),96);
  });
  addRegexMatches(source,DRUG_NAME_RE,(value,start)=>{
    const trimmed=trimMedicalPrefix(value),offset=value.indexOf(trimmed);
    add(trimmed,'proper_name',start+Math.max(0,offset),96);
  });
  addRegexMatches(source,NEGATION_RE,(value,start)=>add(value,'negation',start,92));
  addRegexMatches(source,SCOPE_RE,(value,start)=>add(value,'scope',start,88));

  const selected=[];
  let total=0;
  for(const candidate of candidates.sort((a,b)=>b.priority-a.priority||b.text.length-a.text.length||a.start-b.start)){
    const key=normalizeLiteral(candidate.text);
    if(!key||selected.some(item=>{
      const prior=normalizeLiteral(item.text);
      return prior===key||prior.includes(key)||key.includes(prior);
    }))continue;
    const length=literalLength(candidate.text);
    if(total+length>MAX_LITERAL_SUPPLEMENT_TOTAL_CHARS)continue;
    selected.push({kind:candidate.kind,text:candidate.text});total+=length;
    if(selected.length===MAX_LITERAL_SUPPLEMENT_ITEMS)break;
  }
  return sanitizeLiteralSupplement(selected);
}

export function sanitizeLiteralSupplement(value){
  const selected=[];let total=0;
  for(const item of Array.isArray(value)?value:[]){
    const kind=String(item?.kind||''),text=cleanFragment(item?.text);
    if(!LITERAL_SUPPLEMENT_KINDS.has(kind)||!text||literalLength(text)>MAX_LITERAL_SUPPLEMENT_ITEM_CHARS)continue;
    const key=normalizeLiteral(text),length=literalLength(text);
    if(!key||selected.some(prior=>normalizeLiteral(prior.text)===key)||total+length>MAX_LITERAL_SUPPLEMENT_TOTAL_CHARS)continue;
    selected.push({kind,text});total+=length;
    if(selected.length===MAX_LITERAL_SUPPLEMENT_ITEMS)break;
  }
  return selected;
}

export const LITERAL_SUPPLEMENT_LIMITS=Object.freeze({
  max_items:MAX_LITERAL_SUPPLEMENT_ITEMS,
  max_item_chars:MAX_LITERAL_SUPPLEMENT_ITEM_CHARS,
  max_total_chars:MAX_LITERAL_SUPPLEMENT_TOTAL_CHARS
});

function addRegexMatches(source,pattern,visit){for(const match of source.matchAll(pattern))visit(match[0],match.index);}

function clean(value){return String(value||'').replace(/\s+/gu,' ').trim();}
function cleanFragment(value){return clean(value).replace(/^[,，。；;：:\s]+|[,，。；;：:\s]+$/gu,'');}
function literalLength(value){return[...String(value||'')].length;}
function normalizeLiteral(value){return clean(value).normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu,'');}
function equivalentLiteral(container,value){const needle=normalizeLiteral(value);return Boolean(needle&&normalizeLiteral(container).includes(needle));}

function isEquivalentProtectedValue(text,value,kind){
  if(kind==='negation')return equivalentGroupPresent(text,value,[['无任何','无明显','并无','没有','未见','否认','无'],['尚未','还未','并未','未'],['不再','没再'],['无需','不必'],['不能','无法','不可']]);
  if(kind==='scope')return equivalentGroupPresent(text,value,[['仅仅','仅','只'],['约','左右','上下','接近'],['至少','不低于','不少于'],['至多','不高于','不超过']]);
  return false;
}

function equivalentGroupPresent(text,value,groups){
  const group=groups.find(items=>items.some(item=>value.includes(item)));
  return Boolean(group&&group.some(item=>text.includes(item)));
}

function hasEquivalentDate(text,value){
  const target=dateKey(value);if(!target)return equivalentLiteral(text,value);
  return[...text.matchAll(DATE_LITERAL_RE)].some(match=>dateKey(match[0])===target);
}

function dateKey(value){
  const numbers=String(value||'').match(/\d+/gu)?.map(Number)||[];
  if(numbers.length===3)return`${numbers[0]}-${String(numbers[1]).padStart(2,'0')}-${String(numbers[2]).padStart(2,'0')}`;
  if(numbers.length===2&&numbers[0]>1900)return`${numbers[0]}-${String(numbers[1]).padStart(2,'0')}`;
  if(numbers.length===2)return`--${String(numbers[0]).padStart(2,'0')}-${String(numbers[1]).padStart(2,'0')}`;
  return null;
}

function trimMedicalPrefix(value){
  let output=String(value||'');
  const prefixes=/^(?:患者|医生|医师|目前|近期|此前|已经|正在|开始|继续|规律|考虑|认为|怀疑|提示|确诊|诊断为|使用|服用|加用|停用|改用|建议|给予|出现|存在|伴有|属于|可能|相关)+/u;
  output=output.replace(prefixes,'');
  return output||value;
}

function locallyBoundToStructuredText(source,text,value,start,kind){
  if(sharedSpecificToken(value,text))return true;
  if(kind==='negation'||kind==='scope'){
    const following=source.slice(start+value.length,start+value.length+14).split(/[，,。；;：:]/u)[0];
    return specificTokens(following).some(token=>equivalentLiteral(text,token));
  }
  const end=start+value.length,window=source.slice(Math.max(0,start-18),Math.min(source.length,end+18)),context=`${window.slice(0,Math.max(0,start-Math.max(0,start-18)))} ${window.slice(Math.max(0,end-Math.max(0,start-18)))}`;
  const tokens=specificTokens(context);
  return tokens.some(token=>equivalentLiteral(text,token));
}

function sharedSpecificToken(left,right){return specificTokens(left).some(token=>equivalentLiteral(right,token));}

function specificTokens(value){
  const normalized=clean(value),tokens=[];
  for(const match of normalized.matchAll(/[A-Za-z0-9α-ωΑ-Ω][A-Za-z0-9α-ωΑ-Ω+._\-‐‑‒–—]*/gu))if(match[0].length>=2)tokens.push(match[0]);
  for(const match of normalized.matchAll(/[\p{Script=Han}]{2,}/gu)){
    const run=match[0].replace(/(?:患者|医生|医师|目前|近期|已经|正在|出现|存在|表示|认为|说明)/gu,'');
    for(let index=0;index<run.length-1;index++)tokens.push(run.slice(index,index+2));
  }
  return tokens;
}
