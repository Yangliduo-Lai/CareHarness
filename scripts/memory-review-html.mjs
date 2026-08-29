const list=value=>Array.isArray(value)?value:[];
const escapeHtml=value=>String(value??'').replace(/[&<>"']/gu,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const json=value=>escapeHtml(JSON.stringify(value,null,2));
const shown=value=>value==null||value===''?'—':Array.isArray(value)?value.join(', '):String(value);
const pills=values=>list(values).map(value=>`<span class="pill">${escapeHtml(value)}</span>`).join(' ');
const details=(title,value,open=false)=>`<details ${open?'open':''}><summary>${escapeHtml(title)}</summary><pre>${json(value)}</pre></details>`;

function memoryNodes(item){return list(item?.retrieval_context?.memory_nodes).length?item.retrieval_context.memory_nodes:list(item?.related_memory_nodes);}
function memoryEdges(item){return list(item?.retrieval_context?.memory_edges);}
function nodeTable(nodes){
  if(!nodes.length)return'<p class="muted">没有进入本题 Working Memory 的 Memory Node。</p>';
  const rows=nodes.map((node,index)=>`<tr><td>${index+1}</td><td><code>${escapeHtml(node.memory_id)}</code><br>${pills(node.families)}</td><td><b>${escapeHtml(node.text)}</b>${node.source_text&&node.source_text!==node.text?`<div class="source">原文：${escapeHtml(node.source_text)}</div>`:''}</td><td>${escapeHtml(shown(node.event_time))}<br>${escapeHtml(shown(node.episode_id))}<br>${escapeHtml(shown(node.source_type))}</td><td>${escapeHtml(shown(node.operation))}<br>v${escapeHtml(shown(node.version))}<br>${escapeHtml(shown(node.status))}</td><td>${escapeHtml(list(node.version_chain).join(' → ')||'—')}</td></tr>`).join('');
  return`<div class="scroll"><table><thead><tr><th>#</th><th>Memory ID / Families</th><th>内容</th><th>时间 / 来源</th><th>版本</th><th>版本链</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
function edgeTable(edges){
  if(!edges.length)return'<p class="muted">本题没有可见 Memory Edge。</p>';
  const rows=edges.map((edge,index)=>`<tr><td>${index+1}</td><td><code>${escapeHtml(edge.from_memory_id)}</code></td><td>${escapeHtml(edge.relation_type)}</td><td><code>${escapeHtml(edge.to_memory_id)}</code></td><td>${escapeHtml(shown(edge.status))}<br>${escapeHtml(shown(edge.confidence))}</td></tr>`).join('');
  return`<div class="scroll"><table><thead><tr><th>#</th><th>From Memory</th><th>关系</th><th>To Memory</th><th>状态</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
function investigation(item){
  const steps=list(item?.retrieval_context?.investigation_trace).length?item.retrieval_context.investigation_trace:list(item?.investigation_trace);
  if(!steps.length)return'<p class="muted">没有 Investigation 轨迹。</p>';
  return`<div class="steps">${steps.map(step=>`<article><h3>${escapeHtml(step.ordinal)} · ${escapeHtml(step.worker)}</h3><div><b>信息状态：</b>${escapeHtml(shown(step.information_status))}</div><div><b>理由：</b>${escapeHtml(shown(step.rationale))}</div>${details('本步指令',step.instruction)}<div><b>结果：</b>${escapeHtml(shown(step.result_summary))}</div></article>`).join('')}</div>`;
}
function resultView(item,index,notes={}){
  const nodes=memoryNodes(item),edges=memoryEdges(item),note=notes[item.score_id]||{};
  return`<section class="panel"><h1>${index+1}. ${escapeHtml(item.score_id||'未命名题目')}</h1><div class="badges"><span>${escapeHtml(item.task)}</span><span>score ${escapeHtml(shown(item.score))}</span><span>${item.is_correct?'正确':'错误'}</span></div><h2>问题</h2><div class="box">${escapeHtml(item.question)}</div><div class="columns"><div><h2>系统回答</h2><div class="box">${escapeHtml(item.system_output)}</div></div><div><h2>参考答案</h2><div class="box">${escapeHtml(shown(item.gold))}</div></div></div><h2>评分理由</h2><div class="box">${escapeHtml(shown(item.scoring_reason))}</div>${Object.keys(note).length?`<h2>人工讨论记录</h2>${details('讨论内容',note,true)}`:''}</section>
  <section class="panel"><h2>Investigation Action Sequence</h2>${investigation(item)}</section>
  <section class="panel"><h2>进入回答上下文的 Memory Nodes（${nodes.length}）</h2>${nodeTable(nodes)}</section>
  <section class="panel"><h2>进入回答上下文的 Memory Edges（${edges.length}）</h2>${edgeTable(edges)}</section>
  <section class="panel"><h2>Working Memory 与评分</h2>${details('Working Memory',item.retrieval_context?.working_memory,true)}${details('Verification',item.retrieval_context?.verification)}${details('Scoring details',item.scoring_details)}${details('Answer model trace',item.answer_model_trace)}${details('Judge model trace',item.judge_model_trace)}</section>
  <section class="panel"><h2>该题完整 JSON</h2><p class="muted">源 JSON 的全部字段都在下方，未截断。</p>${details('展开完整 JSON',item)}</section>`;
}

export function renderMemoryReviewDocument(data,{title='CareHarness 错题复盘',notes={}}={}){
  const items=list(data?.wrong_answers).length?data.wrong_answers:list(data?.results).filter(item=>item?.kind==='score');
  const nav=items.map((item,index)=>`<a href="#q-${index}">${escapeHtml(item.score_id||`题目 ${index+1}`)}</a>`).join('');
  const content=items.map((item,index)=>`<main id="q-${index}">${resultView(item,index,notes)}</main>`).join('');
  return`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>
  :root{font-family:Inter,"PingFang SC",sans-serif;color:#172033;background:#f4f6fa}body{margin:0}.layout{display:grid;grid-template-columns:250px minmax(0,1fr);min-height:100vh}nav{position:sticky;top:0;height:100vh;overflow:auto;background:#172033;padding:22px;box-sizing:border-box}nav h1{font-size:18px;color:white}nav a{display:block;color:#c9d4ea;text-decoration:none;padding:8px 0;border-bottom:1px solid #2b3852}.content{padding:24px;min-width:0}main{scroll-margin-top:16px}.panel{background:white;border:1px solid #dce2ec;border-radius:12px;padding:20px;margin:0 0 18px;box-shadow:0 4px 18px #1720330d}.badges span,.pill{display:inline-block;background:#e8eef9;border-radius:99px;padding:3px 8px;margin:0 5px 5px 0;font-size:12px}.columns{display:grid;grid-template-columns:1fr 1fr;gap:14px}.box{white-space:pre-wrap;background:#f7f9fc;border-radius:8px;padding:12px}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-size:13px}th,td{border-bottom:1px solid #e3e7ef;padding:9px;vertical-align:top;text-align:left}td:nth-child(3){min-width:340px}.source,.muted{color:#68758a;font-size:12px;margin-top:6px}.steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px}.steps article{border:1px solid #dce2ec;border-radius:9px;padding:12px}details{margin:10px 0}summary{cursor:pointer;font-weight:600}pre{white-space:pre-wrap;word-break:break-word;background:#111827;color:#dce7ff;padding:12px;border-radius:8px;max-height:none}@media(max-width:800px){.layout{display:block}nav{position:relative;height:auto}.columns{grid-template-columns:1fr}.content{padding:10px}}
  </style></head><body><div class="layout"><nav><h1>${escapeHtml(title)}</h1>${nav}</nav><div class="content"><section class="panel"><h1>${escapeHtml(title)}</h1><p>统一链路：Observation → Memory Node → Memory Graph → Working Memory → Answer。</p>${details('文档级完整 JSON',data)}</section>${content}</div></div></body></html>`;
}
