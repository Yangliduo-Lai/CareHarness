import { minimalLiteralSupplement } from './literal-supplement.js';

export const PATIENT_PROFILE_VERSION = 'careharness-patient-profile-view.v4-historical-literal-delta';

const PROFILE_SECTIONS = Object.freeze([
  { key:'clinical_identity_and_safety', label:'诊断、病史与安全约束', limit:4, per_topic:1, matches:node=>/(?:诊断|确诊|病史|过敏|禁忌|并发症|阳性|阴性|既往.{0,12}(?:疾病|手术|溃疡|出血|感染)|diagnos|allerg|contraindicat|history)/iu.test(node.text) },
  { key:'active_problems_and_red_flags', label:'当前问题、恶化信号与未解决风险', limit:5, per_topic:2, matches:node=>/(?:恶化|加重|持续|反弹|失效|无效|不如|不太一样|效果不明显|撑不住|控制不佳|下降|升高|掉重|消瘦|出血|晕厥|呼吸困难|急诊|风险|异常|worsen|persist|failure|declin|increas|risk|abnormal)/iu.test(node.text) },
  { key:'current_treatment_and_execution', label:'当前治疗、实际执行与监测', limit:4, per_topic:1, matches:node=>/(?:治疗|用药|药物|服用|剂量|注射|停用|改用|加用|减量|方案|监测|复查|随访|漏服|按时|执行|treat|medicat|dose|inject|monitor|adher)/iu.test(node.text)&&!/(?:无法承担|费用|成本|预算|报销|自费|经济)/u.test(node.text) },
  { key:'objective_trajectory', label:'关键客观指标与变化', limit:4, per_topic:2, matches:node=>/(?:\d+(?:\.\d+)?\s*(?:%|mmol\/l|mg\/dl|mg\/g|pmol\/l|u\/ml|次\/分|bpm|kg|斤)|检查|检验|结果|指标|测得|检测|化验|上升|下降|改善|反弹|test|result|level|value)/iu.test(node.text)&&!/(?:费用|成本|预算|报销|自费|经济|元\/|每月)/u.test(node.text) },
  { key:'symptoms_and_function', label:'近期症状、体验与功能', limit:3, per_topic:1, matches:node=>hasFamily(node,'PE')&&/(?:症状|出现|不适|疼痛|头痛|睡眠|食欲|体重|疲劳|乏力|口渴|视力|心率|功能|没劲|尿|symptom|pain|sleep|appetite|weight|fatigue|function)/iu.test(node.text) },
  { key:'preferences_constraints_and_goals', label:'偏好、现实约束与目标', limit:3, per_topic:1, matches:node=>(hasFamily(node,'PA')||hasFamily(node,'BC'))&&/(?:偏好|担心|顾虑|费用|预算|工作|作息|执行|目标|意愿|希望|无法|困难|prefer|concern|cost|work|goal|willing|difficult)/iu.test(node.text) },
]);

/**
 * Query-independent chart-opening view, similar to the concise table a
 * clinician reads before investigating an older chart. When a historical ID
 * set is supplied, the Profile and the verbatim recent-Session window are
 * disjoint: recent records remain available only in `recent_sessions`. Every
 * Profile item retains an auditable source reference, while its historical
 * backing node leaves the retrieval pool.
 */
export function buildPatientProfile(memoryNodes=[], { historical_memory_ids=null } = {}) {
  const historicalIds=historical_memory_ids==null?null:new Set(historical_memory_ids.map(String));
  const original=memoryNodes.filter(node=>node?.memory_id&&node?.text),profilePool=historicalIds==null?original:original.filter(node=>historicalIds.has(String(node.memory_id))),eligible=dedupeExact(profilePool.filter(isEligibleProfileFact));
  const used=new Set(),sections=[];
  for(const definition of PROFILE_SECTIONS){
    const candidates=eligible.filter(node=>!used.has(String(node.memory_id))&&definition.matches(node)).sort(compareProfilePriority);
    const selected=selectDiverseFacts(candidates,definition.limit,definition.per_topic);
    if(!selected.length)continue;
    for(const node of selected)used.add(String(node.memory_id));
    sections.push({key:definition.key,label:definition.label,items:selected.map(profileItem)});
  }
  const dates=[...used].map(id=>eligible.find(node=>String(node.memory_id)===id)?.event_time).filter(Boolean).sort();
  const historicalBacking=[...used].filter(id=>historicalIds==null||historicalIds.has(id));
  return{
    patient_profile:{version:PATIENT_PROFILE_VERSION,as_of:dates.at(-1)||null,view_type:'query_independent_grounded_clinical_chart',query_independent:true,overlaps_recent_sessions:false,sections,item_count:used.size},
    backing_memory_ids:historicalBacking,
    selected_memory_ids:[...used],
    remaining_memory_nodes:original.filter(node=>(historicalIds==null||historicalIds.has(String(node.memory_id)))&&!historicalBacking.includes(String(node.memory_id))),
    policy:{version:PATIENT_PROFILE_VERSION,selection_uses_question:false,selection_uses_benchmark_task:false,profile_is_unranked:true,recent_facts_are_navigation_summary:false,recent_sessions_are_disjoint:true,profile_backing_nodes_excluded_from_historical_retrieval:true,section_limits:Object.fromEntries(PROFILE_SECTIONS.map(item=>[item.key,item.limit]))},
  };
}

function isEligibleProfileFact(node){
  if(!node?.memory_id||!node?.text||node.status&&node.status!=='active')return false;
  const text=String(node.text).trim();
  if(text.length<8)return false;
  return !/(?:谢谢你|感谢你|逐条帮你梳理|帮你梳理一下|让你听了|心里踏实|不会慌|这个信息.*(?:关键|重要)|这几点.*(?:关键|重要)|方向应该是选择[:：]?\s*$|你说得很清楚|我理解你的担心)/u.test(text);
}
function dedupeExact(nodes){
  const byText=new Map();
  for(const node of nodes){const key=normalize(node.text),prior=byText.get(key);if(!prior||compareProfilePriority(node,prior)<0)byText.set(key,node);}
  const ordered=[...byText.values()].sort(compareProfilePriority),out=[],byDate=new Map();
  for(const node of ordered){const date=String(node.event_time||''),peers=byDate.get(date)||[];if(peers.some(prior=>nearDuplicate(prior,node)))continue;peers.push(node);byDate.set(date,peers);out.push(node);}
  return out;
}
function nearDuplicate(left,right){
  const a=normalize(left.text),b=normalize(right.text),shorter=a.length<=b.length?a:b,longer=a.length<=b.length?b:a;
  if(shorter.length>=14&&longer.includes(shorter))return true;
  const numbers=value=>[...String(value).normalize('NFKC').toLowerCase().matchAll(/\d+(?:\.\d+)?(?:\s*[-–~至]\s*\d+(?:\.\d+)?)?\s*(?:%|mmol\/l|mg\/dl|mg\/g|pmol\/l|u\/ml|kg|公斤|斤)?/giu)].map(match=>match[0].replace(/\s+/g,'')).sort(),an=numbers(left.text),bn=numbers(right.text);
  if(!an.length||!bn.length)return false;
  const tokens=value=>{const han=String(value).replace(/[^\p{Script=Han}]/gu,''),set=new Set();for(let index=0;index<han.length-1;index++)set.add(han.slice(index,index+2));return set;},at=tokens(left.text),bt=tokens(right.text);let shared=0;for(const token of at)if(bt.has(token))shared++;
  if(an.join('|')===bn.join('|'))return shared>=Math.min(4,Math.max(2,Math.floor(Math.min(at.size,bt.size)*.25)));
  const simpleNumbers=value=>new Set([...String(value).matchAll(/\d+(?:\.\d+)?/gu)].map(match=>match[0])),leftNumbers=simpleNumbers(left.text),rightNumbers=simpleNumbers(right.text),sharesNumber=[...leftNumbers].some(number=>rightNumbers.has(number));return sharesNumber&&shared>=6&&shared/Math.max(1,Math.min(at.size,bt.size))>=.3;
}
function selectDiverseFacts(candidates,limit,perTopic=1){
  const out=[],perTopicCounts=new Map();
  for(const node of candidates){const topic=topicKey(node),count=perTopicCounts.get(topic)||0;if(count>=perTopic)continue;out.push(node);perTopicCounts.set(topic,count+1);if(out.length>=limit)break;}
  return out;
}
function topicKey(node){
  const factor=String(node.factor_key||'').trim();
  if(factor&&!/^(?:memory|state|fact|node)[-_:]/iu.test(factor))return normalize(factor);
  const concepts=clinicalConceptKeys(node.text);
  return concepts[0]||normalize(node.text).slice(0,32);
}
function profileItem(node){
  const item={source_ref:`memory:${node.memory_id}`,memory_id:String(node.memory_id),text:String(node.text),event_time:node.event_time||null,episode_id:node.episode_id||null,source_type:node.source_type||null,families:Array.isArray(node.families)?node.families:[]},literalSupplement=minimalLiteralSupplement(node);
  if(literalSupplement.length)item.literal_supplement=literalSupplement;
  return item;
}
function compareProfilePriority(left,right){return profileScore(right)-profileScore(left)||compareDate(right,left)||String(left.memory_id).localeCompare(String(right.memory_id));}
function profileScore(node){
  const text=String(node.text||''),families=new Set(node.families||[]),source=node.source_type;
  const attributedDoctor=/^医生(?:原话|解释|评估|建议|认为|指出|向患者)/u.test(text),hypothetical=/(?:若|如果|可能|预计|建议.*(?:超过|低于|高于)|可望|should|may|if\b)/iu.test(text),observedMeasure=/(?:\d+(?:\.\d+)?\s*(?:%|mmol\/l|mg\/dl|mg\/g|pmol\/l|u\/ml|次\/分|bpm|kg|公斤|斤)|[一二三四五六七八九十]+公斤)/iu.test(text)&&!attributedDoctor&&!hypothetical;
  return(node.status==='active'?5:0)+(source==='structured'?5:source==='patient'?4:1)+(families.has('LO')?4:0)+(families.has('CS')?3:0)+(/(?:恶化|加重|持续|反弹|失效|无效|不如|效果不明显|撑不住|掉重|消瘦|风险|异常|worsen|failure|declin|risk)/iu.test(text)?6:0)+(/(?:确诊|诊断|过敏|禁忌|并发症|阳性)/u.test(text)?4:0)+(observedMeasure?7:/\d/u.test(text)?1:0)+(/^(?:患者|患者原话)/u.test(text)?2:0)+(/(?:服用|注射|停用|改用|加用|减量|漏服|按时)/u.test(text)&&!attributedDoctor?4:0)+(/(?:当前|目前|正在|现阶段|继续|维持|最近|近期|current|currently|ongoing)/iu.test(text)?2:0)+(text.length>=16&&text.length<=140?2:0)-(attributedDoctor?4:0)-(hypothetical?3:0);
}
function clinicalConceptKeys(value){
  const text=String(value||'').normalize('NFKC').toLowerCase(),patterns=[
    ['diagnosis',/(?:诊断|确诊|分型|diagnos)/u],['allergy',/(?:过敏|allerg)/u],['treatment',/(?:治疗|用药|服用|注射|剂量|medicat|dose)/u],['objective',/(?:检查|检验|指标|血糖|血压|心率|体温|体重|test|result|level)/u],['symptom',/(?:疼痛|头痛|疲劳|乏力|口渴|视力|睡眠|症状|不适|symptom|pain|fatigue|sleep)/u],['risk',/(?:风险|禁忌|出血|晕厥|急诊|risk|contraindicat)/u],['constraint',/(?:费用|预算|工作|作息|无法|困难|cost|work|difficult)/u],
  ];
  return patterns.filter(([,pattern])=>pattern.test(text)).map(([key])=>key);
}
function compareDate(left,right){const a=Date.parse(left?.event_time||''),b=Date.parse(right?.event_time||'');return(Number.isFinite(a)?a:0)-(Number.isFinite(b)?b:0);}
function hasFamily(node,family){return Array.isArray(node?.families)&&node.families.includes(family);}
function normalize(value){return String(value||'').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu,'');}
