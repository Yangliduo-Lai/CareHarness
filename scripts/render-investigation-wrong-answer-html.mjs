import { mkdirSync,readFileSync,writeFileSync } from 'node:fs';
import { dirname,resolve } from 'node:path';

const STOP=new Set(['患者','医生','情况','出现','开始','目前','近期','已经','需要','说明','因为','对应','进行','以及','仍然','持续','一个','什么','是否','这个']);

const[inputArg,outputArg]=process.argv.slice(2);
if(!inputArg||!outputArg){
  console.error('Usage: node scripts/render-investigation-wrong-answer-html.mjs <wrong-answers.json> <output.html>');
  process.exit(1);
}
const input=resolve(inputArg),output=resolve(outputArg),data=JSON.parse(readFileSync(input,'utf8'));
mkdirSync(dirname(output),{recursive:true});
writeFileSync(output,renderDocument(data));
console.log(JSON.stringify({input,output,wrong_answer_count:list(data.wrong_answers).length},null,2));

function renderDocument(data){
  const items=list(data.wrong_answers),experiment=data.experiment||{},config=experiment.config||{},model=config.resolved_models?.investigation_policy||config.resolved_models?.judge||{},condition=config.noise?'Noise':'Clean';
  const nav=items.map((item,index)=>`<a href="#q-${index}" data-nav data-search="${h(searchText(item))}"><span>${h(item.score_id)}</span><small>${h(shortTask(item.task))} · ${formatScore(item.score)}</small></a>`).join('');
  const questions=items.map((item,index)=>renderQuestion(item,index)).join('');
  return`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CareHarness 最新实验错题调查复盘</title>${styles()}</head><body>
  <div class="layout"><aside><h1>错题调查复盘</h1><p>${h(experiment.id||'—')}</p><input id="search" placeholder="搜索题号、问题、题型"><div class="filters"><button data-filter="all" class="active">全部</button><button data-filter="IG">IG</button><button data-filter="MCD">MCD</button><button data-filter="other">其他</button></div><nav>${nav}</nav></aside>
  <div class="content"><header class="hero"><h1>Persona ${h(config.persona_id??'—')} / ${condition} · 最新实验错题</h1><div class="summary"><span>错题 ${items.length}</span><span>模型 ${h(model.model||'—')}</span><span>总分 ${formatScore(experiment.query_metrics?.average_score)}</span><span>实验 ${h(experiment.id||'—')}</span></div><p><b>阅读顺序：</b>官方要求覆盖 → Action 逐步操作 → 最终进入 Answer 的 State / Memory Node → 评分。节点召回匹配属于答案冻结后的离线复盘，不参与运行时。</p><div class="legend"><span class="ok">成功召回</span><span class="partial">部分召回</span><span class="bad">未召回</span><span class="neutral">无官方节点清单</span></div></header>${questions}</div></div>${script()}</body></html>`;
}

function renderQuestion(item,index){
  const task=shortTask(item.task),turns=investigationTurns(item),finalNodes=finalMemoryNodes(item),finalEdges=list(item.retrieval_context?.memory_edges),requirements=officialRequirements(item),diagnostics=requirements.map(req=>diagnoseRequirement(req,item,turns,finalNodes)),details=item.scoring_details||{},search=searchText(item),originalOutput=String(item.system_output||''),translatedOutput=translateSystemOutput(originalOutput),outputWasTranslated=translatedOutput!==originalOutput;
  return`<main id="q-${index}" data-question data-task="${h(task)}" data-search="${h(search)}">
    <section class="panel question"><div class="title-row"><div><h1>${index+1}. ${h(item.score_id)}</h1><div class="badges"><span>${h(task)}</span><span>score ${formatScore(item.score)}</span><span class="bad">错误</span></div></div><a class="top" href="#">返回顶部</a></div>
      <h2>问题</h2><div class="box strong">${h(item.question)}</div>
      <div class="two"><div><h2>系统回答（中文）</h2><div class="box">${h(translatedOutput)}</div>${outputWasTranslated?`<details><summary>查看模型原始输出</summary><pre>${h(originalOutput)}</pre></details>`:''}</div><div><h2>参考答案（Gold）</h2><div class="box">${h(item.gold)}</div></div></div>
      <h2>官方答案解析</h2><div class="box emphasis">${boldImportant(item.answer_explanation||details.explanation||'—')}</div>
      <h2>Judge 错因</h2><div class="box emphasis">${boldImportant(item.scoring_reason||details.judge_reason||'—')}</div>
      ${trapView(item)}
    </section>
    <section class="panel"><h2>官方要求节点 / 患者信息覆盖</h2><p class="muted">“召回”指该信息对应的 Memory Node 是否曾出现在任一步 Action 的 Working Memory；“最终进入”指是否保留到 Answer 上下文。匹配结果是离线文本诊断，并列出实际节点供人工确认。</p>${requirements.length?diagnostics.map(renderRequirement).join(''):'<div class="notice neutral">该题型的官方 Judge metadata 没有逐节点清单；请直接检查下面的 Action 和最终 Memory Nodes。</div>'}${mcdScoreSummary(item)}</section>
    <section class="panel"><h2>Investigation Action Sequence（${turns.length} 步）</h2>${turns.length?renderActionTimeline(turns):'<p class="muted">没有保存 Investigation 轨迹。</p>'}</section>
    <section class="panel"><h2>最终进入 Answer 的 State / Memory Nodes（${finalNodes.length}）</h2>${nodeTable(finalNodes,{empty:'最终 Answer 上下文没有 Memory Node。'})}<h2>最终 Memory Edges（${finalEdges.length}）</h2>${edgeTable(finalEdges)}</section>
    <section class="panel"><h2>最终 Working Memory、Verification 与评分详情</h2>${jsonDetails('Working Memory',item.retrieval_context?.working_memory,true)}${jsonDetails('Semantic Assessment',item.retrieval_context?.semantic_evaluation)}${jsonDetails('Verification',item.retrieval_context?.verification)}${jsonDetails('Scoring details',item.scoring_details,true)}${jsonDetails('Failure attribution',item.failure_attribution)}</section>
  </main>`;
}

function officialRequirements(item){
  const metadata=item.judge_metadata||{};
  if(shortTask(item.task)==='MCD'){
    const stateNeeds=list(metadata.required_memory_nodes),validations=new Map(list(item.scoring_details?.node_validations).map(value=>[String(value.node_id),value]));
    return list(metadata.reasoning_chain).map((node,index)=>({kind:'MCD Node',id:String(node.node_id??index+1),role:node.role||'',session_id:node.session_id,content:String(node.content||''),state_requirement:String(stateNeeds[index]||node.content||''),validation:validations.get(String(node.node_id??index+1))||null}));
  }
  if(shortTask(item.task)==='IG'){
    return list(metadata.trap_design?.required_patient_info).map((content,index)=>({kind:'Required patient info',id:String(index+1),role:'患者特异信息',session_id:null,content:String(content),state_requirement:String(content),validation:null}));
  }
  return[];
}

function diagnoseRequirement(requirement,item,turns,finalNodes){
  const appearances=new Map(),all=new Map();
  for(const turn of turns){
    for(const node of snapshotNodes(turn)){
      const id=String(node.memory_id||'');if(!id)continue;
      if(!all.has(id))all.set(id,node);
      const entry=appearances.get(id)||{first_turn:turn.turn,workers:[]};entry.workers.push(turn.decision?.worker||'unknown');appearances.set(id,entry);
    }
  }
  const target=requirement.state_requirement||requirement.content,matches=[...all.values()].map(node=>({node,...matchText(target,nodeText(node))})).filter(value=>value.score>=0.055).sort((a,b)=>b.score-a.score).slice(0,6),combined=combinedCoverage(target,matches.map(value=>value.node)),best=matches[0]?.score||0;
  const recallStatus=combined>=.34||best>=.31?'hit':combined>=.15||best>=.12?'partial':'miss',finalIds=new Set(finalNodes.map(node=>String(node.memory_id))),finalMatches=matches.filter(value=>finalIds.has(String(value.node.memory_id))),answerMatch=matchText(requirement.content,item.system_output||''),answerStatus=requirement.validation?requirement.validation.specific_data_matched||requirement.validation.mentioned?'hit':'miss':answerMatch.score>=.25?'hit':answerMatch.score>=.11?'partial':'miss';
  return{...requirement,recall_status:recallStatus,coverage:combined,best_score:best,matches:matches.map(value=>({...value,appearance:appearances.get(String(value.node.memory_id))})),first_turn:matches.length?Math.min(...matches.map(value=>appearances.get(String(value.node.memory_id))?.first_turn||Infinity)):null,final_status:finalMatches.length?'hit':recallStatus==='miss'?'miss':'partial',final_matches:finalMatches,answer_status:answerStatus,answer_score:answerMatch.score};
}

function renderRequirement(req){
  const validation=req.validation;
  return`<article class="requirement"><div class="requirement-head"><h3>${h(req.kind)} ${h(req.id)} · ${h(req.role)} ${req.session_id!=null?`· Session ${h(req.session_id)}`:''}</h3><div class="status-row">${statusPill('任一步召回',req.recall_status)}${statusPill('最终进入 Answer',req.final_status)}${statusPill('答案体现',req.answer_status)}</div></div>
    <div class="req-grid"><div><b>官方节点/要求</b><div class="box emphasis">${boldImportant(req.content)}</div></div>${req.state_requirement!==req.content?`<div><b>对应的具体 State 要求</b><div class="box">${h(req.state_requirement)}</div></div>`:''}</div>
    <div class="metrics"><span>合并文本覆盖 ${(req.coverage*100).toFixed(1)}%</span><span>最佳单节点 ${(req.best_score*100).toFixed(1)}%</span><span>首次候选 Action ${Number.isFinite(req.first_turn)?req.first_turn:'—'}</span></div>
    ${validation?`<div class="judge-node"><b>Judge 小分：</b>${booleanPill('mentioned',validation.mentioned)} ${booleanPill('specific_data_matched',validation.specific_data_matched)} ${booleanPill('causal_link_correct',validation.causal_link_correct)}<div>${boldImportant(validation.note||'—')}</div></div>`:''}
    <details ${req.recall_status==='miss'?'':'open'}><summary>匹配到的召回 State / Memory Nodes（${req.matches.length}）</summary>${req.matches.length?nodeMatchTable(req.matches):'<p class="bad-text">任一步 Working Memory 中都没有找到足够相似的节点。</p>'}</details>
  </article>`;
}

function renderActionTimeline(turns){
  let beforeNodes=[],beforeEdges=[];
  return`<div class="timeline">${turns.map((turn,index)=>{
    const decision=turn.decision||{},result=turn.result||{},afterNodes=snapshotNodes(turn),afterEdges=list(result.snapshot?.memory_edges),beforeIds=new Set(beforeNodes.map(node=>String(node.memory_id))),afterIds=new Set(afterNodes.map(node=>String(node.memory_id))),beforeEdgeIds=new Set(beforeEdges.map(edge=>edgeKey(edge))),afterEdgeIds=new Set(afterEdges.map(edge=>edgeKey(edge))),added=afterNodes.filter(node=>!beforeIds.has(String(node.memory_id))),removed=beforeNodes.filter(node=>!afterIds.has(String(node.memory_id))),retained=afterNodes.filter(node=>beforeIds.has(String(node.memory_id))),addedEdges=afterEdges.filter(edge=>!beforeEdgeIds.has(edgeKey(edge))),removedEdges=beforeEdges.filter(edge=>!afterEdgeIds.has(edgeKey(edge))),assessment=result.snapshot?.assessment||result.snapshot?.semantic_evaluation||null,trace=result.trace||result.snapshot?.worker_state?.trace||null,worker=decision.worker||'unknown';
    const html=`<article class="step ${h(worker)}"><div class="step-head"><div class="step-no">${turn.turn??index+1}</div><div><h3>${h(worker)} · ${h(actionName(worker))}</h3><div>${statusPill(decision.information_status||'unknown',decision.information_status==='sufficient'?'hit':decision.information_status==='insufficient'?'bad':'partial')} ${turn.fallback_used?'<span class="pill bad">fallback</span>':''}</div></div></div>
      <div class="operation"><b>对 State 的操作：</b>${h(actionOperation(worker))}<br><b>变化：</b>前 ${beforeNodes.length} → 后 ${afterNodes.length}；新增 ${added.length}，移除 ${removed.length}，保留 ${retained.length}；边 +${addedEdges.length}/-${removedEdges.length}</div>
      <div><b>Policy 理由：</b>${h(decision.rationale||'—')}</div>${jsonDetails('本步 Action 指令',decision.instruction,true)}
      <div><b>Worker 结果：</b>${h(result.summary||'—')}</div>${traceSummary(trace)}
      ${added.length?`<details open><summary>新增 State（${added.length}）</summary>${nodeTable(added)}</details>`:''}
      ${removed.length?`<details open><summary>移除 State（${removed.length}）</summary>${nodeTable(removed)}</details>`:''}
      ${addedEdges.length?`<details><summary>新增边（${addedEdges.length}）</summary>${edgeTable(addedEdges)}</details>`:''}
      ${removedEdges.length?`<details><summary>移除边（${removedEdges.length}）</summary>${edgeTable(removedEdges)}</details>`:''}
      ${assessment?jsonDetails('本步 Assessment',assessment,true):''}
      <details><summary>本步结束后的完整 State（${afterNodes.length}）</summary>${nodeTable(afterNodes)}</details>
      ${turn.error?`<div class="notice bad">${h(turn.error)}</div>`:''}</article>`;
    beforeNodes=afterNodes;beforeEdges=afterEdges;return html;
  }).join('')}</div>`;
}

function traceSummary(trace){
  if(!trace)return'';
  const parts=[];
  for(const[key,label]of[['memory_pool_size','全图节点'],['candidate_count','候选'],['selected_memory_count','本步选中'],['selected_edge_count','选中边'],['selected_session_count','Session'],['depth','追踪深度']])if(trace[key]!=null)parts.push(`${label} ${trace[key]}`);
  if(trace.zero_recall===true)parts.push('零召回');
  const temporal=trace.resolved_temporal?.operator&&trace.resolved_temporal.operator!=='none'?`时间 ${JSON.stringify(trace.resolved_temporal)}`:'';
  return parts.length||temporal?`<div class="trace-summary">${parts.map(value=>`<span>${h(value)}</span>`).join('')}${temporal?`<span>${h(temporal)}</span>`:''}</div>`:'';
}

function trapView(item){
  const metadata=item.judge_metadata||{},trap=metadata.trap_design,wrong=metadata.common_wrong_answer;
  if(!trap&&!wrong&&!metadata.core_mechanism)return'';
  return`<h2>官方陷阱与机制</h2><div class="two">${trap?`<div class="box"><b>${h(trap.trap_type||'陷阱')}</b><br>${boldImportant(trap.trap_mechanism||'—')}</div>`:''}${metadata.core_mechanism?`<div class="box"><b>Core mechanism</b><br>${boldImportant(metadata.core_mechanism)}</div>`:''}${wrong?`<div class="box"><b>常见错误答案</b><br>${h(wrong.content||'—')}<hr><b>为什么错：</b>${boldImportant(wrong.why_wrong||'—')}</div>`:''}</div>`;
}

function mcdScoreSummary(item){
  if(shortTask(item.task)!=='MCD')return'';const d=item.scoring_details||{};
  return`<div class="score-grid"><div><b>NCR</b><strong>${formatScore(d.ncr_score)}</strong><small>具体节点覆盖率</small></div><div><b>CRC</b><strong>${formatScore(d.crc_score)}</strong><small>因果关系正确率</small></div><div><b>CC</b><strong>${formatScore(d.cc_score)}</strong><small>推理链完整度</small></div><div><b>Memory</b><strong>${h(d.memory_retrieval_quality||'—')}</strong><small>uses patient info: ${h(String(d.uses_patient_specific_info??'—'))}</small></div></div>`;
}

function nodeTable(nodes,{empty='没有节点。'}={}){
  if(!nodes.length)return`<p class="muted">${h(empty)}</p>`;
  return`<div class="scroll"><table><thead><tr><th>Memory ID</th><th>State 内容</th><th>时间 / Session / 角色</th><th>Family / 版本操作</th></tr></thead><tbody>${nodes.map(node=>`<tr><td><code>${h(node.memory_id)}</code></td><td><b>${h(node.text)}</b>${node.source_text&&node.source_text!==node.text?`<div class="source">原文：${h(node.source_text)}</div>`:''}</td><td>${h(node.event_time||'—')}<br>${h(node.episode_id||'—')}<br>${h(node.source_type||'—')}</td><td>${pills(node.families)}<br>${h(node.operation||'—')} · v${h(node.version??'—')} · ${h(node.status||'—')}</td></tr>`).join('')}</tbody></table></div>`;
}
function nodeMatchTable(matches){return`<div class="scroll"><table><thead><tr><th>匹配</th><th>首次出现</th><th>State / Memory Node</th><th>时间 / Family</th></tr></thead><tbody>${matches.map(value=>`<tr><td>${(value.score*100).toFixed(1)}%<br><small>${h(value.matched.slice(0,10).join(', '))}</small></td><td>Action ${h(value.appearance?.first_turn??'—')}<br>${h(unique(value.appearance?.workers).join(' → '))}</td><td><code>${h(value.node.memory_id)}</code><br><b>${h(value.node.text)}</b></td><td>${h(value.node.event_time||'—')}<br>${h(value.node.episode_id||'—')}<br>${pills(value.node.families)}</td></tr>`).join('')}</tbody></table></div>`;}
function edgeTable(edges){if(!edges.length)return'<p class="muted">没有 Memory Edge。</p>';return`<div class="scroll"><table><thead><tr><th>From</th><th>关系</th><th>To</th><th>状态</th></tr></thead><tbody>${edges.map(edge=>`<tr><td><code>${h(edge.from_memory_id)}</code></td><td>${h(edge.relation_type||edge.edge_family||'—')}</td><td><code>${h(edge.to_memory_id)}</code></td><td>${h(edge.status||'—')} · ${h(edge.confidence??'—')}</td></tr>`).join('')}</tbody></table></div>`;}

function investigationTurns(item){return list(item.retrieval_trace?.investigation?.turns);}
function snapshotNodes(turn){return list(turn?.result?.snapshot?.memory_nodes);}
function finalMemoryNodes(item){return Array.isArray(item.retrieval_context?.memory_nodes)?item.retrieval_context.memory_nodes:list(item.related_memory_nodes);}
function translateSystemOutput(value){return String(value||'')
  .replace(/(^|\n)(\s*\*{0,2})Key memory(\*{0,2})(?=\s*(?:\n|$))/giu,'$1$2关键记忆$3')
  .replace(/(^|\n)(\s*\*{0,2})Reasoning chain(\*{0,2})(?=\s*(?:\n|$))/giu,'$1$2推理链$3')
  .replace(/(^|\n)(\s*\*{0,2})Comprehensive judgment(\*{0,2})(?=\s*(?:\n|$))/giu,'$1$2综合判断$3')
  .replace(/\bBrain Fog\b/giu,'脑雾')
  .replace(/\s+vs\.?\s+/giu,' 与 ')
  .replace(/\/day\b/giu,'/天');}
function nodeText(node){return[node.text,node.source_text].filter(Boolean).join(' ');}
function edgeKey(edge){return String(edge.edge_id||`${edge.from_memory_id}|${edge.relation_type}|${edge.to_memory_id}`);}
function actionName(worker){return({search:'全图约束检索',context:'Session 上下文扩展',trace:'图与时间链追踪',assess:'证据覆盖/缺口评估',refine:'最小相关集合筛选',verify:'来源与边界核验',answer:'冻结回答上下文'})[worker]||worker;}
function actionOperation(worker){return({search:'从完整 Memory Graph 检索并累加命中节点。',context:'围绕命中点加入同一 Session 的上下文节点。',trace:'沿已验证图边、版本链或同一因子扩展当前节点。',assess:'不主动检索；评估当前节点覆盖、缺口和关系，可能生成查询期关系。',refine:'用明确 Memory IDs 或严格条件替换当前集合，删除干扰节点。',verify:'不检索；检查来源、患者一致性、重复、节点上限和边端点。',answer:'不修改事实；冻结已核验节点供 Answer Model 使用。'})[worker]||'执行注册 Worker。';}

function matchText(target,candidate){
  const wanted=weightedTokens(target),available=new Set(weightedTokens(candidate).map(value=>value.token)),matched=wanted.filter(value=>available.has(value.token)),total=wanted.reduce((sum,value)=>sum+value.weight,0),hit=matched.reduce((sum,value)=>sum+value.weight,0);
  return{score:total?hit/total:0,matched:matched.map(value=>value.token)};
}
function combinedCoverage(target,nodes){return matchText(target,nodes.map(node=>nodeText(node)).join(' ')).score;}
function weightedTokens(value){
  const text=normalize(value),out=new Map(),add=(token,weight)=>{token=token.trim();if(token.length<2||STOP.has(token))return;out.set(token,Math.max(out.get(token)||0,weight));};
  for(const token of text.match(/\d+(?:\.\d+)?(?:\s*[-–~至]\s*\d+(?:\.\d+)?)?\s*(?:mmol\/l|mg|kg|%|u\/ml|pmol\/l|天|月|周|次|分钟|小时)?/gu)||[])add(token.replace(/\s+/gu,''),4);
  for(const token of text.match(/[a-z][a-z0-9+.-]{1,}|c肽/gu)||[])add(token,3);
  for(const block of text.match(/[\p{Script=Han}]{2,}/gu)||[]){for(let size=Math.min(4,block.length);size>=2;size--)for(let index=0;index<=block.length-size;index++)add(block.slice(index,index+size),size===4?1.8:size===3?1.3:1);}
  return[...out].map(([token,weight])=>({token,weight}));
}
function normalize(value){return String(value||'').normalize('NFKC').toLowerCase().replace(/β/gu,'beta').replace(/‑|–|—/gu,'-').replace(/\s+/gu,'');}

function statusPill(label,status){const css=status==='hit'?'ok':status==='partial'||status==='unknown'?'partial':status==='miss'||status==='bad'?'bad':'neutral',text=status==='hit'?'成功':status==='partial'?'部分':status==='miss'?'未命中':status;return`<span class="pill ${css}">${h(label)}：${h(text)}</span>`;}
function booleanPill(label,value){return`<span class="pill ${value?'ok':'bad'}">${h(label)}=${h(String(Boolean(value)))}</span>`;}
function pills(values){return list(values).map(value=>`<span class="mini">${h(value)}</span>`).join(' ');}
function jsonDetails(title,value,open=false){if(value==null)return'';return`<details ${open?'open':''}><summary>${h(title)}</summary><pre>${h(JSON.stringify(value,null,2))}</pre></details>`;}
function boldImportant(value){const escaped=h(value);return escaped.replace(/(未能|没有|缺少|忽略|错误|矛盾|零召回|不一致|关键|必须|failed|incorrect|missing|contradict[^\s，。；]*)/giu,'<strong>$1</strong>');}
function formatScore(value){const number=Number(value);return Number.isFinite(number)?`${(number*100).toFixed(2)}%`:'—';}
function shortTask(value){const text=String(value||'').toLowerCase();if(text.includes('multi_hop'))return'MCD';if(text.includes('inference'))return'IG';if(text.includes('multiple_choice'))return'MQ';if(text.includes('state_update'))return'SUA';if(text.includes('temporal'))return'TLA';if(text.includes('entity'))return'EEM';return String(value||'—').toUpperCase();}
function searchText(item){return[item.score_id,item.task,item.question,item.system_output,translateSystemOutput(item.system_output)].join(' ').toLowerCase();}
function unique(value){return[...new Set(list(value))];}
function list(value){return Array.isArray(value)?value:[];}
function h(value){return String(value??'').replace(/[&<>"']/gu,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));}

function script(){return`<script>
const input=document.querySelector('#search'),questions=[...document.querySelectorAll('[data-question]')],links=[...document.querySelectorAll('[data-nav]')];let filter='all';
function apply(){const q=input.value.trim().toLowerCase();for(const element of [...questions,...links]){const task=element.dataset.task||document.querySelector(element.getAttribute?.('href')||'x')?.dataset.task||'';const taskOK=filter==='all'||(filter==='other'?!['IG','MCD'].includes(task):task===filter);element.hidden=!(taskOK&&element.dataset.search.includes(q));}}
input.addEventListener('input',apply);document.querySelectorAll('[data-filter]').forEach(button=>button.onclick=()=>{filter=button.dataset.filter;document.querySelectorAll('[data-filter]').forEach(item=>item.classList.toggle('active',item===button));apply();});
</script>`;}
function styles(){return`<style>
:root{font-family:Inter,"PingFang SC","Microsoft YaHei",sans-serif;color:#182033;background:#f3f5f9}*{box-sizing:border-box}body{margin:0}.layout{display:grid;grid-template-columns:280px minmax(0,1fr);min-height:100vh}aside{position:sticky;top:0;height:100vh;overflow:auto;padding:20px;background:#162036;color:#fff}aside h1{margin:0 0 6px;font-size:19px}aside p{font-size:11px;color:#9eacc5;word-break:break-all}aside input{width:100%;padding:10px;border:0;border-radius:8px;margin:8px 0}.filters{display:flex;gap:5px;margin:4px 0 12px}.filters button{border:1px solid #52627e;background:transparent;color:#cbd5e8;border-radius:99px;padding:4px 9px}.filters button.active{background:#fff;color:#162036}nav a{display:flex;justify-content:space-between;gap:8px;color:#cbd5e8;text-decoration:none;padding:8px 0;border-bottom:1px solid #2d3951;font-size:12px}nav a small{white-space:nowrap;color:#8fa0bd}.content{padding:24px;min-width:0}.hero,.panel{background:#fff;border:1px solid #dce2ec;border-radius:13px;padding:20px;margin-bottom:18px;box-shadow:0 3px 14px #1720330b}.hero{border-top:5px solid #445bd3}.summary,.badges,.legend,.status-row,.metrics,.trace-summary{display:flex;flex-wrap:wrap;gap:7px}.summary span,.badges span,.legend span,.pill,.metrics span,.trace-summary span,.mini{display:inline-block;border-radius:99px;background:#edf1f7;padding:4px 9px;font-size:12px}.legend span,.pill{border:1px solid transparent}.ok{background:#e8f7ee!important;color:#14733a;border-color:#bce8ca!important}.partial{background:#fff3d6!important;color:#895b00;border-color:#f1d48e!important}.bad{background:#fde9e9!important;color:#a52d2d;border-color:#efbcbc!important}.neutral{background:#edf1f7!important;color:#536176;border-color:#d8dfe9!important}.title-row,.requirement-head,.step-head{display:flex;justify-content:space-between;gap:14px;align-items:flex-start}.top{font-size:12px}.two,.req-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.box{white-space:pre-wrap;background:#f7f9fc;border-radius:8px;padding:12px;line-height:1.65}.box.strong{font-size:17px}.emphasis strong,.judge-node strong{color:#b22828;background:#fff0a8}.muted,.source,small{color:#6d788b}.notice{padding:12px;border-radius:8px}.requirement{border:1px solid #d9e0eb;border-left:5px solid #6677d9;border-radius:10px;padding:15px;margin:12px 0}.requirement h3{margin:0}.metrics{margin:9px 0}.judge-node{background:#fff8e8;border-radius:8px;padding:11px;line-height:1.6}.score-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:14px}.score-grid>div{background:#f5f7fb;border-radius:9px;padding:12px}.score-grid strong{display:block;font-size:23px;margin:5px 0}.timeline{display:grid;gap:14px}.step{border:1px solid #d9e0eb;border-left:6px solid #6575d5;border-radius:10px;padding:14px}.step.search{border-left-color:#2477d4}.step.context{border-left-color:#02a3a3}.step.trace{border-left-color:#7d52c7}.step.assess{border-left-color:#d27b18}.step.refine{border-left-color:#b43b7a}.step.verify{border-left-color:#1d8e4f}.step.answer{border-left-color:#172033}.step-no{width:34px;height:34px;border-radius:50%;background:#172033;color:#fff;display:grid;place-items:center;font-weight:700}.step h3{margin:0 0 5px}.operation{background:#f3f6fb;border-radius:8px;padding:10px;margin:10px 0;line-height:1.6}.scroll{overflow:auto}table{width:100%;border-collapse:collapse;font-size:12px}th,td{border-bottom:1px solid #e0e5ee;padding:8px;text-align:left;vertical-align:top}td:nth-child(2){min-width:250px}code{font-size:10px;word-break:break-all}.mini{padding:2px 6px;background:#e9edf5}details{margin:9px 0}summary{cursor:pointer;font-weight:650}pre{white-space:pre-wrap;word-break:break-word;background:#111827;color:#dce7ff;padding:12px;border-radius:8px;max-height:500px;overflow:auto}hr{border:0;border-top:1px solid #dfe4ec}[hidden]{display:none!important}@media(max-width:900px){.layout{display:block}aside{position:relative;height:auto}.two,.req-grid,.score-grid{grid-template-columns:1fr}.content{padding:9px}.title-row,.requirement-head{display:block}}
</style>`;}
