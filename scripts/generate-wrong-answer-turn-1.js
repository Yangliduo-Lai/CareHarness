import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';

const args=process.argv.slice(2),outputIndex=args.indexOf('--output');
if(outputIndex>=0&&(!args[outputIndex+1]||args[outputIndex+1].startsWith('--')))throw new Error('--output requires a file path');
const OUTPUT=resolve(outputIndex>=0?args.splice(outputIndex,2)[1]:'docs/wrong answer turn 1.html'),SOURCES=args.map(source=>resolve(source));
if(!SOURCES.length)throw new Error('Usage: node scripts/generate-wrong-answer-turn-1.js <wrong-answer.json> [...] [--output <report.html>]');
const benchmarkNames = { cpcdbench:'CPCD-Bench', medlocomo:'MedLoCoMo', medmemorybench:'MedMemoryBench' };
const taskNames = {
  session_level_response_generation:'Session-level response', temporal_causal_reasoning:'Temporal causal reasoning',
  adversarial:'Adversarial', care_plan_rationale:'Care-plan rationale', cross_admission_comparison:'Cross-admission comparison',
  frequency_pattern:'Frequency pattern', longitudinal_progression:'Longitudinal progression', medical_reasoning:'Medical reasoning',
  entity_exact_match:'EEM · Entity exact match', temporal_localization:'TLA · Temporal localization', state_update:'SUA · State update',
  inference_generation:'IG · Inference generation', multiple_choice:'MQ · Multiple choice', multi_hop_clinical_deduction:'MCD · Multi-hop deduction'
};

const text = value => Array.isArray(value) ? value.map(text).filter(Boolean).join(' / ') : value && typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
const compactState = state => ({
  family:state?.family ?? '', value:text(state?.value ?? state?.text),
  event_time:state?.event_time ?? null, episode_id:state?.episode_id ?? null, source_type:state?.source_type ?? null
});
const compactEvidence = evidence => ({
  text:text(evidence?.text), source_text:text(evidence?.source_text), event_time:evidence?.event_time ?? null,
  episode_id:evidence?.episode_id ?? null, source_type:evidence?.source_type ?? null
});
const terms = value => {
  const normalized=text(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
  const words=normalized.split(/\s+/u).filter(token=>token.length>2),han=[...normalized.matchAll(/[\p{Script=Han}]{2,}/gu)].flatMap(match=>{
    const value=match[0],items=[];for(let index=0;index<value.length-1;index++)items.push(value.slice(index,index+2));return items;
  });
  return [...new Set([...words,...han])];
};
const goldSupport = (gold, states, evidence) => {
  const expected=terms(gold);if(!expected.length)return null;
  const haystack=new Set(terms([...states.map(item=>item.value),...evidence.flatMap(item=>[item.text,item.source_text])].join(' ')));
  return expected.filter(token=>haystack.has(token)).length/expected.length;
};
const judgeReason = item => text(item?.judge_model_trace?.parsed_response?.reason || item?.score_result?.scoring_details?.judgment?.reason || item?.scoring_reason);
const dimensions = item => item?.scoring_details?.dimension_scores || item?.score_result?.scoring_details?.dimension_scores || {};

function classify(item, benchmark, gate, support) {
  const task=item.task,missing=gate?.missing_facets || [],candidate=Number(item?.retrieval_trace?.candidate_count ?? 0);
  if(item.memory_incomplete || item.status==='failed')return{code:'memory_or_query_failure',label:'构建/查询失败',reason:'该题没有进入正常可评分链路；应先修复 Memory 或模型调用失败。'};
  if(benchmark==='cpcdbench'){
    const weak=Object.entries(dimensions(item)).filter(([,value])=>Number(value?.score)<5).sort((a,b)=>Number(a[1]?.score)-Number(b[1]?.score));
    const labels=weak.map(([name,value])=>`${name} ${value.score}/5`);
    return{code:'rubric_gap',label:'CPCD rubric 未满分',reason:labels.length?`未满分维度：${labels.join('、')}。${weak.map(([,value])=>value.reason).filter(Boolean).join(' ')}`:'官方 rubric 总分未满，需查看 Judge 分项理由。'};
  }
  if(benchmark==='medlocomo'&&task==='adversarial')return{code:'abstention_failure',label:'对抗题拒答失败',reason:'不可回答问题没有输出官方 matcher 可接受的规范短拒答，或额外解释破坏了精确拒答匹配。'};
  if(candidate===0)return{code:'zero_recall',label:'候选零召回',reason:'检索阶段没有返回任何候选 State，答案缺少可用患者证据。'};
  const incomplete=gate && gate.complete===false;
  const evidencePresent=support!==null&&support>=.42;
  if(task==='entity_exact_match')return evidencePresent
    ?{code:'strict_expression_mismatch',label:'严格实体/格式不匹配',reason:'相关事实已出现在检索上下文，但输出未严格复现 Gold 所需实体、单位、符号或限定词。'}
    :{code:'entity_retrieval_gap',label:'实体证据未命中',reason:`Gold 关键实体在所选 State/Evidence 中覆盖较低${incomplete?'，且 Gate 仍缺少 '+missing.join('、'):''}。`};
  if(task==='temporal_localization')return evidencePresent
    ?{code:'temporal_selection_error',label:'时间/事件选择错误',reason:'相关内容已有一定证据覆盖，但模型混淆了事件发生时间、对话时间、相似事件或题目要求的事件内容。'}
    :{code:'temporal_retrieval_gap',label:'时序证据不足',reason:`目标时间或目标事件没有被稳定召回${missing.length?'；缺失 '+missing.join('、'):''}。`};
  if(task==='state_update')return{code:'state_freshness_error',label:'当前状态/版本链错误',reason:evidencePresent?'检索到了相关状态，但没有稳定选择同一实体的最新 authoritative State。':'最新状态没有进入当前证据上下文，旧状态或冲突状态主导了回答。'};
  if(task==='multiple_choice')return evidencePresent
    ?{code:'option_reasoning_error',label:'选项核验错误',reason:'支持信息已有一定覆盖，但模型没有逐项验证整句是否完全受证据支持，导致漏选或误选。'}
    :{code:'option_evidence_gap',label:'选项证据不完整',reason:'至少一个正确选项所需事实未进入检索上下文，或相似旧事实产生了干扰。'};
  if(task==='multi_hop_clinical_deduction')return incomplete||!evidencePresent
    ?{code:'causal_chain_gap',label:'多跳证据链不完整',reason:`因果链的起点、机制桥接、纵向客观证据或终点中至少一环缺失${missing.length?'；Gate 缺少 '+missing.join('、'):''}。`}
    :{code:'causal_reasoning_error',label:'多跳推理未完成',reason:'关键患者事实已有一定覆盖，但生成答案没有把事实组织成完整的因果链。'};
  if(task==='inference_generation'||benchmark==='medlocomo')return incomplete&&!evidencePresent
    ?{code:'decision_evidence_gap',label:'决策性证据覆盖不足',reason:`答案所需的诊断、治疗反应、风险、禁忌或长期轨迹没有完整进入上下文${missing.length?'；Gate 缺少 '+missing.join('、'):''}。`}
    :{code:'reasoning_or_use_error',label:'证据利用/推理错误',reason:'检索上下文对 Gold 有一定代理覆盖，但模型没有使用决定性事实、遗漏必要结论，或引入了旁支解释。'};
  return{code:'answer_mismatch',label:'答案与官方要求不一致',reason:judgeReason(item)||'系统输出与 Gold 或官方 rubric 不一致。'};
}

const records=[],sourceMeta=[];
for(const source of SOURCES){
  const payload=JSON.parse(readFileSync(source,'utf8')),benchmark=payload.experiment?.benchmark || 'unknown',config=payload.experiment?.config || {};
  const variant=benchmark==='medmemorybench'?(config.noise?'Noise':'Clean / current State'):benchmarkNames[benchmark] || benchmark;
  sourceMeta.push({file:basename(source),experiment_id:payload.experiment?.id,benchmark,variant,count:payload.wrong_answers?.length || 0,generated_at:payload.generated_at});
  for(const item of payload.wrong_answers || []){
    const trace=item.retrieval_trace || {},gate=trace.evidence_index_gate?.coverage || null,states=(item.related_states || []).map(compactState),evidence=(item.related_evidence || []).map(compactEvidence),support=goldSupport(item.gold,states,evidence),diagnosis=classify(item,benchmark,gate,support);
    records.push({
      key:`${payload.experiment?.id}:${item.score_id}`,experiment_id:payload.experiment?.id,benchmark,benchmark_label:benchmarkNames[benchmark] || benchmark,variant,
      score_id:item.score_id,task:item.task,task_label:taskNames[item.task] || item.task,status:item.status,score:item.score,is_correct:item.is_correct,
      question:text(item.question),gold:text(item.gold),answer:text(item.system_output),official_metric:item.official_metric,scoring_method:item.scoring_method,
      scoring_reason:text(item.scoring_reason),judge_reason:judgeReason(item),scoring_details:item.scoring_details || null,diagnosis,
      retrieval:{candidate_count:trace.candidate_count ?? null,selected_state_count:trace.selected_state_count ?? states.length,selected_evidence_count:trace.selected_evidence_count ?? evidence.length,zero_recall:Boolean(trace.zero_recall),gate_enabled:Boolean(trace.evidence_index_gate?.enabled),coverage_ratio:gate?.coverage_ratio ?? null,coverage_complete:gate?.complete ?? null,missing_facets:gate?.missing_facets || [],gold_support_proxy:support},
      states,evidence,memory_incomplete:Boolean(item.memory_incomplete),query_session:item.query_session ?? null
    });
  }
}

const payload={title:'wrong answer turn 1',generated_at:new Date().toISOString(),sources:sourceMeta,records};
const serialized=JSON.stringify(payload).replaceAll('<','\\u003c');
const html=`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>wrong answer turn 1</title>
<style>
:root{--ink:#12232f;--muted:#60717b;--paper:#f6f4ed;--card:#fffdfa;--line:#d9ddd8;--teal:#0f6b68;--teal2:#d9eeea;--orange:#d46836;--red:#a44136;--shadow:0 14px 40px #18303b12}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:linear-gradient(145deg,#edf3ef 0,#f8f4ea 35%,#f2eee6 100%);color:var(--ink);font:15px/1.6 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}.shell{width:min(1460px,calc(100% - 32px));margin:auto}.hero{padding:56px 0 28px}.eyebrow{color:var(--teal);font-weight:800;letter-spacing:.12em;text-transform:uppercase}.hero h1{font:800 clamp(38px,7vw,82px)/.98 ui-serif,Georgia,"Songti SC",serif;letter-spacing:-.045em;margin:8px 0 18px}.hero p{max-width:900px;color:var(--muted);font-size:17px}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:24px 0}.stat,.panel,.case{background:#fffdfacc;border:1px solid #fff;box-shadow:var(--shadow);border-radius:18px}.stat{padding:18px}.stat b{display:block;font:800 30px/1 ui-serif,Georgia,serif}.stat span{color:var(--muted)}.dashboard{display:grid;grid-template-columns:1fr 1fr;gap:14px}.panel{padding:20px}.panel h2{font-size:15px;margin:0 0 14px}.sources{grid-column:1/-1}.source-list{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}.source-item{background:#f1f4ef;border-radius:10px;padding:9px 11px;overflow-wrap:anywhere}.bar-row{display:grid;grid-template-columns:minmax(130px,1.4fr) 3fr 38px;gap:10px;align-items:center;margin:8px 0}.bar{height:9px;background:#e7ebe7;border-radius:9px;overflow:hidden}.bar i{display:block;height:100%;background:linear-gradient(90deg,var(--teal),#55a99f);border-radius:inherit}.controls{position:sticky;top:0;z-index:10;margin:24px 0 18px;padding:14px;background:#f8f8f3ee;border:1px solid #fff;border-radius:18px;box-shadow:0 10px 30px #18303b18;backdrop-filter:blur(14px);display:grid;grid-template-columns:2fr repeat(4,1fr) auto;gap:10px}.controls input,.controls select,.controls button{width:100%;border:1px solid var(--line);border-radius:11px;background:white;color:var(--ink);padding:10px 12px;font:inherit}.controls button{width:auto;background:var(--ink);color:white;border:0;cursor:pointer}.result-head{display:flex;justify-content:space-between;align-items:end;margin:18px 2px}.result-head h2{margin:0}.result-head span{color:var(--muted)}.cases{display:grid;gap:14px}.case{overflow:hidden}.case summary{list-style:none;cursor:pointer;padding:18px 20px}.case summary::-webkit-details-marker{display:none}.case-top{display:grid;grid-template-columns:auto auto minmax(0,1fr) auto;gap:9px;align-items:center}.badge{display:inline-flex;align-items:center;width:max-content;padding:3px 9px;border-radius:999px;background:var(--teal2);color:#075653;font-size:12px;font-weight:750}.badge.cause{background:#f6e3d5;color:#91431e}.score{font-weight:850;color:var(--red)}.question{grid-column:1/-1;font-weight:720;font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:4px}.case[open] .question{white-space:normal}.case-body{border-top:1px solid var(--line);padding:20px;display:grid;gap:16px}.compare{display:grid;grid-template-columns:1fr 1fr;gap:12px}.box{background:#f7f8f5;border:1px solid var(--line);border-radius:13px;padding:14px;white-space:pre-wrap;overflow-wrap:anywhere}.box h3,.diagnosis h3{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:0 0 8px}.diagnosis{border-left:4px solid var(--orange);padding:5px 0 5px 14px}.official{border-left-color:var(--teal)}.metrics{display:flex;gap:8px;flex-wrap:wrap}.metric{background:#eef1ee;border-radius:9px;padding:7px 9px;font-size:12px}.missing{color:var(--red)}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;vertical-align:top;padding:8px;border-bottom:1px solid var(--line)}th{color:var(--muted)}.empty{text-align:center;padding:70px;color:var(--muted)}.load{display:block;margin:24px auto 60px;padding:11px 24px;border:0;border-radius:999px;background:var(--teal);color:#fff;cursor:pointer}.note{font-size:13px;color:var(--muted)}@media(max-width:900px){.stats{grid-template-columns:1fr 1fr}.dashboard,.compare{grid-template-columns:1fr}.source-list{grid-template-columns:1fr}.controls{position:static;grid-template-columns:1fr 1fr}.controls input{grid-column:1/-1}.case-top{grid-template-columns:auto 1fr auto}.case-top .badge:nth-child(2){display:none}}@media(max-width:560px){.shell{width:min(100% - 18px,1460px)}.hero{padding-top:30px}.stats{grid-template-columns:1fr 1fr}.controls{grid-template-columns:1fr}.controls input{grid-column:auto}.case summary,.case-body{padding:14px}.question{font-size:15px}}@media print{.controls,.load{display:none}.case{break-inside:avoid}.case:not([open]) .case-body{display:grid}.shell{width:100%}}
</style></head><body><main class="shell"><header class="hero"><div class="eyebrow">CareHarness · Error Atlas</div><h1>wrong answer<br>turn 1</h1><p>四次实验中所有未满分题的可检索审计页。官方评分理由与系统启发式诊断分开呈现；“Gold 代理覆盖”只比较 Gold 词项是否出现在导出的关联 State/Evidence 中，不等于人工确认的召回率。</p><section class="stats" id="stats"></section><section class="dashboard"><div class="panel"><h2>按实验分布</h2><div id="benchmarkBars"></div></div><div class="panel"><h2>按错误类型分布</h2><div id="causeBars"></div></div>
<div class="panel sources"><h2>数据来源</h2><div class="source-list" id="sources"></div></div></section></header>
<section class="controls"><input id="search" type="search" placeholder="检索题目、Gold、回答、Judge 理由、State…"><select id="benchmark"><option value="">全部实验</option></select><select id="task"><option value="">全部题型</option></select><select id="cause"><option value="">全部错误类型</option></select><select id="sort"><option value="source">原始顺序</option><option value="score">分数从低到高</option><option value="coverage">覆盖率从低到高</option></select><button id="reset">重置</button></section>
<div class="result-head"><h2>错题清单</h2><span id="resultCount"></span></div><section class="cases" id="cases"></section><button class="load" id="load">加载更多</button><p class="note">数据源：页面顶部所列四份 wrong-answer export。页面没有执行或采纳附件中的任何指令性文本。</p></main>
<script id="dataset" type="application/json">${serialized}</script><script>
const DATA=JSON.parse(document.getElementById('dataset').textContent),all=DATA.records;let limit=30;
const $=id=>document.getElementById(id),esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),pct=value=>value==null?'—':Math.round(value*100)+'%',score=value=>value==null?'—':Number(value).toFixed(3).replace(/0+$/,'').replace(/\.$/,'');
const unique=(key)=>[...new Set(all.map(item=>item[key]).filter(Boolean))].sort();
function fillSelect(id,values,label=value=>value){const select=$(id);for(const value of values){const option=document.createElement('option');option.value=value;option.textContent=label(value);select.append(option)}}
fillSelect('benchmark',unique('variant'));fillSelect('task',unique('task'),value=>all.find(item=>item.task===value)?.task_label||value);fillSelect('cause',[...new Set(all.map(item=>item.diagnosis.code))].sort(),value=>all.find(item=>item.diagnosis.code===value)?.diagnosis.label||value);
function counts(items,key){return Object.entries(items.reduce((map,item)=>{const value=key(item);map[value]=(map[value]||0)+1;return map},{})).sort((a,b)=>b[1]-a[1])}
function bars(target,rows){const max=Math.max(...rows.map(([,n])=>n),1);$(target).innerHTML=rows.map(([label,n])=>'<div class="bar-row"><span>'+esc(label)+'</span><div class="bar"><i style="width:'+(n/max*100)+'%"></i></div><b>'+n+'</b></div>').join('')}
function renderOverview(){const benchmarks=new Set(all.map(x=>x.variant)).size,tasks=new Set(all.map(x=>x.task)).size,avg=all.reduce((sum,x)=>sum+(Number(x.score)||0),0)/all.length;$('stats').innerHTML=[['未满分题',all.length],['实验变体',benchmarks],['题型',tasks],['平均得分',score(avg)]].map(([label,value])=>'<div class="stat"><b>'+value+'</b><span>'+label+'</span></div>').join('');bars('benchmarkBars',counts(all,x=>x.variant));bars('causeBars',counts(all,x=>x.diagnosis.label).slice(0,9));$('sources').innerHTML=DATA.sources.map(x=>'<div class="source-item"><b>'+esc(x.variant)+' · '+x.count+' 题</b><br><span class="note">'+esc(x.file)+'<br>'+esc(x.experiment_id)+'</span></div>').join('')}
function stateTable(items){if(!items.length)return'<div class="note">导出中没有关联 State。</div>';return'<table><thead><tr><th>Family</th><th>时间 / Session</th><th>State</th></tr></thead><tbody>'+items.slice(0,12).map(x=>'<tr><td>'+esc(x.family)+'</td><td>'+esc(x.event_time||'—')+'<br>'+esc(x.episode_id||'')+'</td><td>'+esc(x.value)+'</td></tr>').join('')+'</tbody></table>'+(items.length>12?'<div class="note">另有 '+(items.length-12)+' 条 State 未展开。</div>':'')}
function details(value){if(!value)return'';return'<details><summary>查看评分结构</summary><pre class="box">'+esc(JSON.stringify(value,null,2))+'</pre></details>'}
function card(item,index){const r=item.retrieval,missing=r.missing_facets||[],official=item.judge_reason||item.scoring_reason||'该指标没有提供自然语言理由；请对照 Gold 与系统答案。';return'<details class="case" data-key="'+esc(item.key)+'"><summary><div class="case-top"><span class="badge">'+esc(item.variant)+'</span><span class="badge">'+esc(item.task_label)+'</span><span class="badge cause">'+esc(item.diagnosis.label)+'</span><span class="score">'+score(item.score)+'</span><div class="question">'+esc(item.question)+'</div></div></summary><div class="case-body"><div class="note">#'+(index+1)+' · '+esc(item.score_id)+' · '+esc(item.experiment_id)+' · '+esc(item.official_metric||item.scoring_method||'')+'</div><div class="compare"><div class="box"><h3>Gold / Reference</h3>'+esc(item.gold||'—')+'</div><div class="box"><h3>System output</h3>'+esc(item.answer||'—')+'</div></div><div class="diagnosis"><h3>系统诊断 · 启发式</h3><b>'+esc(item.diagnosis.label)+'</b><div>'+esc(item.diagnosis.reason)+'</div></div><div class="diagnosis official"><h3>官方指标 / Judge 理由</h3><div>'+esc(official)+'</div></div><div class="metrics"><span class="metric">候选 '+esc(r.candidate_count??'—')+'</span><span class="metric">最终 State '+esc(r.selected_state_count??'—')+'</span><span class="metric">Evidence '+esc(r.selected_evidence_count??'—')+'</span><span class="metric">Gate 覆盖 '+pct(r.coverage_ratio)+'</span><span class="metric">Gold 代理覆盖 '+pct(r.gold_support_proxy)+'</span><span class="metric">Zero recall '+(r.zero_recall?'是':'否')+'</span></div>'+(missing.length?'<div class="missing">缺失 facets：'+esc(missing.join('、'))+'</div>':'')+'<details><summary>关联 State（'+item.states.length+'）</summary>'+stateTable(item.states)+'</details>'+details(item.scoring_details)+'</div></details>'}
function filtered(){const q=$('search').value.trim().toLowerCase(),benchmark=$('benchmark').value,task=$('task').value,cause=$('cause').value;let items=all.filter(item=>(!benchmark||item.variant===benchmark)&&(!task||item.task===task)&&(!cause||item.diagnosis.code===cause));if(q)items=items.filter(item=>[item.score_id,item.question,item.gold,item.answer,item.judge_reason,item.scoring_reason,item.diagnosis.label,item.diagnosis.reason,...item.states.map(x=>x.value)].join(' ').toLowerCase().includes(q));if($('sort').value==='score')items.sort((a,b)=>(a.score??-1)-(b.score??-1));if($('sort').value==='coverage')items.sort((a,b)=>(a.retrieval.coverage_ratio??-1)-(b.retrieval.coverage_ratio??-1));return items}
function render(){const items=filtered(),visible=items.slice(0,limit);$('resultCount').textContent='显示 '+visible.length+' / '+items.length+'（总计 '+all.length+'）';$('cases').innerHTML=visible.length?visible.map(card).join(''):'<div class="empty">没有符合当前条件的错题。</div>';$('load').hidden=visible.length>=items.length}
for(const id of ['search','benchmark','task','cause','sort'])$(id).addEventListener(id==='search'?'input':'change',()=>{limit=30;render()});$('reset').onclick=()=>{for(const id of ['search','benchmark','task','cause'])$(id).value='';$('sort').value='source';limit=30;render()};$('load').onclick=()=>{limit+=30;render()};renderOverview();render();
</script></body></html>`;

writeFileSync(OUTPUT,html);
console.log(JSON.stringify({output:OUTPUT,records:records.length,sources:sourceMeta},null,2));
