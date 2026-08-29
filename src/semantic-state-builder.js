import { transcriptBlocks } from './session-observation.js';

// Context Units are a source-only intermediate representation.  They are not
// Memory Nodes and never contain benchmark queries, answers, or evaluator data.
// A Unit is always contained by one immutable Turn/Role/Time block, while soft
// layout such as a single newline remains inside the same semantic passage.
export function buildSemanticContextUnits(observation){
  const rawText=String(observation?.raw_text||''),transcript=transcriptBlocks(rawText),blocks=transcript.length?transcript:[{content_start:0,content_end:rawText.length,source_type:observation.source_type,turn_id:observation.turn_id,event_time:observation.event_time}],units=[];
  blocks.forEach((block,blockIndex)=>{
    const rawSegments=segmentTurn(rawText,block),merged=mergeDependentSegments(rawText,rawSegments);
    let unitIndex=0;
    for(const segment of merged){
      const sourceText=rawText.slice(segment.start,segment.end),text=displayText(sourceText);
      if(!isCompleteContextText(text)||isStandaloneMarkdownHeading(sourceText))continue;
      units.push({
        unit_id:`turn_${blockIndex+1}_unit_${++unitIndex}`,
        block_index:blockIndex,
        unit_index:unitIndex-1,
        text,
        source_text:sourceText,
        span:[segment.start,segment.end],
        source_type:block.source_type,
        turn_id:block.turn_id,
        event_time:block.event_time,
        section_heading:nearestMarkdownHeading(rawText,block,segment.start)
      });
    }
  });
  return units;
}

export function semanticExtractorInput(observation){
  const contextUnits=buildSemanticContextUnits(observation);
  return{
    session_text:String(observation?.raw_text||''),
    context_units:contextUnits.map(unit=>({
      unit_id:unit.unit_id,
      source_type:unit.source_type,
      turn_id:unit.turn_id,
      event_time:unit.event_time,
      section_heading:unit.section_heading,
      text:unit.text
    }))
  };
}

export function bindSemanticSupport(rawItem,observation,contextUnits=buildSemanticContextUnits(observation)){
  const ids=normalizeSupportUnitIds(rawItem),explicit=ids.length>0||hasSupportUnitField(rawItem);
  if(!explicit)return{explicit:false,bound:false,support_unit_ids:[],reasons:['legacy_text_only_output']};
  if(!ids.length)return{explicit:true,bound:false,support_unit_ids:[],reasons:['empty_support_unit_ids'],repairable:true};
  const byId=new Map(contextUnits.map(unit=>[unit.unit_id,unit])),selected=[],unknown=[];
  for(const id of ids){const unit=byId.get(id);if(unit)selected.push(unit);else unknown.push(id);}
  const reasons=[];
  if(unknown.length)reasons.push('unknown_support_unit_id');
  if(selected.length!==ids.length)reasons.push('support_unit_count_mismatch');
  if(selected.length){
    const hardBoundaries=new Set(selected.map(unit=>`${unit.block_index}\u0000${unit.source_type}\u0000${unit.turn_id||''}\u0000${unit.event_time||''}`));
    if(hardBoundaries.size!==1)reasons.push('support_crosses_turn_role_or_time_boundary');
    const indexes=[...new Set(selected.map(unit=>unit.unit_index))].sort((a,b)=>a-b);
    if(indexes.some((value,index)=>index>0&&value!==indexes[index-1]+1))reasons.push('support_units_are_not_contiguous');
  }
  if(reasons.length||!selected.length)return{explicit:true,bound:false,support_unit_ids:ids,reasons:[...new Set(reasons)],repairable:true};
  const ordered=[...selected].sort((a,b)=>a.span[0]-b.span[0]),start=ordered[0].span[0],end=ordered.at(-1).span[1],sourceText=String(observation.raw_text).slice(start,end),text=String(rawItem?.text||'').trim(),supportReasons=semanticSupportReasons(text,sourceText,ordered[0].source_type);
  if(supportReasons.length)return{explicit:true,bound:false,support_unit_ids:ids,reasons:supportReasons,repairable:true,proposed_span:[start,end]};
  return{explicit:true,bound:true,support_unit_ids:ids,reasons:[],source_text:sourceText,span:[start,end],source_type:ordered[0].source_type,turn_id:ordered[0].turn_id,event_time:ordered[0].event_time};
}

export function semanticSupportReasons(text,sourceText,sourceType){
  const reasons=[],state=String(text||''),source=String(sourceText||'');
  const stateQuantities=protectedQuantityTokens(state),sourceQuantities=protectedQuantityTokens(source);
  if(stateQuantities.some(token=>!sourceQuantities.includes(token)))reasons.push('unsupported_or_changed_number_date_or_unit');
  const sourceTerms=new Set(protectedClinicalTerms(source));
  if(protectedClinicalTerms(state).some(term=>!sourceTerms.has(term)))reasons.push('unsupported_or_changed_clinical_term');
  const stateNegated=qualifiedClaimTargets(state,'negation'),sourceNegated=qualifiedClaimTargets(source,'negation');
  if(stateNegated.length&&!stateNegated.every(target=>sourceNegated.some(sourceTarget=>claimTargetsMatch(target,sourceTarget))))reasons.push('unsupported_negation');
  else if(!stateNegated.length&&sourceNegated.some(target=>claimTargetsMatch(plainClaimTarget(state),target)))reasons.push('omitted_source_negation');
  const stateUncertain=qualifiedClaimTargets(state,'uncertainty'),sourceUncertain=qualifiedClaimTargets(source,'uncertainty');
  if(stateUncertain.length&&!stateUncertain.every(target=>sourceUncertain.some(sourceTarget=>claimTargetsMatch(target,sourceTarget))))reasons.push('unsupported_uncertainty');
  else if(!stateUncertain.length&&sourceUncertain.some(target=>claimTargetsMatch(plainClaimTarget(state),target)))reasons.push('omitted_source_uncertainty');
  if(sourceType==='patient'&&/^\s*医生(?:建议|解释|评估|认为|指出|告知)/u.test(state))reasons.push('role_attribution_mismatch');
  if(sourceType==='doctor'&&/^\s*患者(?:自述|表示|确认|认为|觉得|报告)/u.test(state))reasons.push('role_attribution_mismatch');
  return[...new Set(reasons)];
}

export function isCompleteContextText(value){
  const text=String(value||'').trim(),meaningful=(text.match(/[\p{L}\p{N}]/gu)||[]).length;
  if(meaningful<4)return false;
  if(/^(?:#{1,6}\s*)?[^。！？!?；;]{1,36}[：:]\s*$/u.test(text))return false;
  if(/^(?:而且|并且|但是|不过|所以|因此|其中|另外|同时|然后|这种|这个|这些|那些|它|这也|也就是说)(?:[，,、\s]|$)/u.test(text)&&meaningful<14)return false;
  if(/[，,:：—-]\s*$/u.test(text))return false;
  return true;
}

function segmentTurn(rawText,block){
  const text=rawText.slice(block.content_start,block.content_end),segments=[];let localStart=0;
  const push=(rawStart,rawEnd)=>{
    let start=rawStart,end=rawEnd;
    while(start<end&&/\s/u.test(rawText[start]))start++;
    while(end>start&&/\s/u.test(rawText[end-1]))end--;
    if(end>start)segments.push({start,end});
  };
  for(let index=0;index<text.length;index++){
    const char=text[index];
    if(/[。！？!?；;]/u.test(char)){
      let end=index+1;
      while(end<text.length&&/[”’"'）)】\]]/u.test(text[end]))end++;
      push(block.content_start+localStart,block.content_start+end);localStart=end;index=end-1;continue;
    }
    // A blank line is an explicit paragraph boundary.  A single newline is
    // only layout and therefore never terminates a Context Unit by itself.
    if(char==='\n'&&/^\n[\t \r]*\n/u.test(text.slice(index))){
      push(block.content_start+localStart,block.content_start+index);
      let end=index+1;while(end<text.length&&/[\t \r\n]/u.test(text[end]))end++;
      localStart=end;index=end-1;
    }
  }
  push(block.content_start+localStart,block.content_end);
  return segments;
}

function mergeDependentSegments(rawText,segments){
  const merged=[];
  for(const segment of segments){
    const rawSegment=rawText.slice(segment.start,segment.end),text=displayText(rawSegment),previous=merged.at(-1),previousText=previous?displayText(rawText.slice(previous.start,previous.end)):'';
    const needsPrior=startsDependent(text)||looksLikeMarkdownListContinuation(rawSegment),priorNeedsNext=endsDependent(previousText)||isMarkdownHeading(previousText);
    if(previous&&(needsPrior||priorNeedsNext)&&segment.end-previous.start<=900){previous.end=segment.end;continue;}
    merged.push({...segment});
  }
  // A final lead-in without a continuation cannot stand as patient memory.
  return merged.filter(segment=>!endsDependent(displayText(rawText.slice(segment.start,segment.end))));
}

function displayText(value){
  return String(value||'').replace(/\r\n?/gu,'\n').split('\n').map(line=>line.replace(/^\s*#{1,6}\s+/u,'').replace(/^\s*(?:[-*+]\s+|\d+[.、)]\s+|[（(]\d+[）)]\s*)/u,'').replace(/\*\*([^*]+)\*\*/gu,'$1').replace(/__([^_]+)__/gu,'$1').trim()).filter(Boolean).join(' ').replace(/\s+/gu,' ').trim();
}
function startsDependent(text){return /^(?:而且|并且|但是|但|不过|所以|因此|其中|另外|同时|然后|这种|这个|这些|那些|其|它|这也|上述|前者|后者|也就是说|尤其是|包括|以及|且|而|and\b|but\b|therefore\b|however\b|also\b|this\b|these\b|it\b)/iu.test(String(text||''));}
function endsDependent(text){return /(?:[，,:：]|——|—|以及|包括|分别为|如下|表现为|提示)$|(?:第[一二三四五六七八九十\d]+(?:个)?(?:点|项|条))(?:出现)?$/u.test(String(text||'').trim());}
function isMarkdownHeading(text){return /^(?:\*\*|__)?[^。！？!?；;]{1,40}(?:\*\*|__)?[：:]?$/u.test(String(text||'').trim())&&/[：:]$|^(?:第[一二三四五六七八九十\d]+(?:个)?(?:点|项|条))/u.test(String(text||'').trim());}
function looksLikeMarkdownListContinuation(text){return /^(?:[-*+]\s+|\d+[.、)]\s+|[（(]\d+[）)]\s*)/u.test(String(text||''));}
function isStandaloneMarkdownHeading(value){const text=String(value||'').trim();return/^#{1,6}\s+[^\n]+$/u.test(text)||/^\*\*[^*]+\*\*\s*[：:]?$/u.test(text)||/^__[^_]+__\s*[：:]?$/u.test(text);}

function nearestMarkdownHeading(rawText,block,position){
  const before=rawText.slice(block.content_start,position),lines=before.split('\n');
  for(let index=lines.length-1;index>=0&&index>=lines.length-12;index--){
    const line=lines[index].trim();if(!line)continue;
    const markdown=/^#{1,6}\s+(.+)$/u.exec(line)||/^\*\*([^*]+)\*\*\s*[：:]?$/u.exec(line)||/^__([^_]+)__\s*[：:]?$/u.exec(line);
    if(markdown)return markdown[1].trim();
    if(/[。！？!?；;]/u.test(line))break;
  }
  return null;
}

function normalizeSupportUnitIds(rawItem){
  const value=rawItem?.support_unit_ids??(rawItem?.support_unit_id?[rawItem.support_unit_id]:[]);
  return[...new Set((Array.isArray(value)?value:[]).map(String).map(item=>item.trim()).filter(Boolean))];
}
function hasSupportUnitField(rawItem){return rawItem&&typeof rawItem==='object'&&(Object.hasOwn(rawItem,'support_unit_ids')||Object.hasOwn(rawItem,'support_unit_id'));}
function normalizedProtected(value){return String(value||'').normalize('NFKC').toLowerCase().replace(/[‐‑‒–—−]/gu,'-').replace(/\s+/gu,'');}
function protectedQuantityTokens(value){const normalizedDashes=String(value||'').normalize('NFKC').replace(/[‐‑‒–—−]/gu,'-');return[...normalizedDashes.matchAll(/[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:\s*[-–~～至]\s*\d+(?:\.\d+)?)?\s*(?:%|mmol\/?l|mg\/?dl|mmhg|bpm|iu|u|mg|mcg|kg|g|ml|l|单位|毫克|微克|千克|克|毫升|升|次|分钟|小时|天|日|月|年)?/giu)].map(match=>normalizedProtected(match[0]).replace(/[~～至–]/gu,'-'));}
function protectedClinicalTerms(value){
  const terms=[];
  for(const match of String(value||'').normalize('NFKC').matchAll(/[A-Za-zΑ-Ωα-ωβ][A-Za-zΑ-Ωα-ωβ0-9+_.\-‐‑‒–—−/]{0,31}/gu)){
    const raw=match[0],token=normalizedProtected(raw),hasTechnicalShape=/[0-9+_.\-\/Α-Ωα-ωβ]/u.test(raw)||((raw.match(/[A-Z]/gu)||[]).length>=2),hasMedicalSuffix=/(?:formin|gliptin|gliflozin|insulin|cillin|mycin|statin|sartan|pril|azole|mab|nib)$/iu.test(raw);
    if((hasTechnicalShape||hasMedicalSuffix)&&!/^(?:patient|doctor|the|and|with|without|from|into|about|this|that)$/u.test(token))terms.push(token);
  }
  terms.push(...protectedChineseClinicalTerms(value));
  return[...new Set(terms)];
}
function protectedChineseClinicalTerms(value){
  const text=String(value||'').normalize('NFKC'),suffixes='视网膜病变|糖化血红蛋白|非增殖性病变|抑制剂|激动剂|胰岛素|综合征|糖尿病|药物|受体|抗体|激素|神经|细胞|病变|药',pattern=new RegExp(`(?:${suffixes})`,'gu'),terms=[];
  for(const match of text.matchAll(pattern)){
    const clauseStart=Math.max(text.lastIndexOf('。',match.index),text.lastIndexOf('；',match.index),text.lastIndexOf('，',match.index),text.lastIndexOf(',',match.index),text.lastIndexOf('\n',match.index))+1,prefix=text.slice(clauseStart,match.index),boundaries=[...prefix.matchAll(/(?:患者|医生)(?:目前|近期|最近|已经|仍然|正在)?(?:自述|表示|确认|认为|觉得|报告|解释|评估|建议|指出|告知)?|(?:目前|近期|最近|已经|仍然|正在|继续|规律|开始|停止|停用|恢复|加用|换用|改用|使用|服用|注射|采用|给予|接受|中|因|由|使|把|将)/gu)],after=boundaries.at(-1)?.index!=null?boundaries.at(-1).index+boundaries.at(-1)[0].length:0,stem=prefix.slice(after).replace(/^(?:的|该|一种|这类|此类)/u,'').trim(),term=`${stem}${match[0]}`.replace(/\s+/gu,'');
    if(term.length>=2&&term.length<=24)terms.push(normalizedProtected(term));
  }
  return terms;
}
function hasNegation(value){return/(?:没有|并无|尚无|未见|否认|不再|没再|无明显|无任何|不是|不能|从未|not|no\s|without|denies|never)/iu.test(String(value||''));}
function hasUncertainty(value){return/(?:可能|也许|似乎|不确定|怀疑|考虑|倾向|大概|约|左右|probably|possibly|uncertain|suspect|about|approximately)/iu.test(String(value||''));}
function qualifiedClaimTargets(value,kind){
  const text=String(value||''),targets=[],pattern=kind==='negation'
    ?/(?:没有|并无|尚无|未见|否认|不再|没再|无明显|无任何|不是|不能|从未|\bnot\b|\bno\b|\bwithout\b|\bdenies?\b|\bnever\b)\s*([^，,。！？!?；;但而\n]{1,48})/giu
    :/(?:可能|也许|似乎|不确定|怀疑|考虑|倾向|大概|约|左右|probably|possibly|uncertain|suspect|about|approximately)\s*([^，,。！？!?；;但而\n]{1,48})/giu;
  for(const match of text.matchAll(pattern)){const target=plainClaimTarget(match[1]);if(target.length>=2)targets.push(target);}
  if(!targets.length&&((kind==='negation'&&hasNegation(text))||(kind==='uncertainty'&&hasUncertainty(text))))targets.push(plainClaimTarget(text));
  return[...new Set(targets.filter(Boolean))];
}
function plainClaimTarget(value){return normalizedProtected(value).replace(/^(?:患者|医生|本人|我|thepatient|thedoctor)/u,'').replace(/(?:没有|并无|尚无|未见|否认|不再|没再|无明显|无任何|不是|不能|从未|可能|也许|似乎|不确定|怀疑|考虑|倾向|大概|约|左右|not|no|without|denies|never|probably|possibly|uncertain|suspect|about|approximately)/giu,'');}
function claimTargetsMatch(left,right){
  const a=String(left||''),b=String(right||'');if(!a||!b)return false;
  const shorter=a.length<=b.length?a:b,longer=a.length<=b.length?b:a;if(shorter.length>=2&&longer.includes(shorter))return true;
  const grams=value=>{const out=new Set();for(let index=0;index<value.length-1;index++)out.add(value.slice(index,index+2));return out;},x=grams(a),y=grams(b);if(!x.size||!y.size)return false;let overlap=0;for(const gram of x)if(y.has(gram))overlap++;return overlap/Math.min(x.size,y.size)>=.72;
}
