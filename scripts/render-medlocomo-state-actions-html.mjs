import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

// Offline inspection only. These case-specific review cues are never loaded
// by the harness or sent to Policy/Answer; they are not official node labels.
const review={
 q01:[['慢性舒张性心衰及诊断重新分类','diastolic|heart failure|reclassif']],
 q02:[['铜绿假单胞菌感染及菌血症进展','pseudomon|bacteremia|bloodstream']],
 q03:[['磨玻璃影所对应的肺部记录','ground.glass'],['低氧性急性呼吸衰竭结局','respiratory failure|hypoxi']],
 q04:[['骨量减少的起点','osteopen|bone density'],['后续压缩性骨折','compression|fracture']],
 q05:[['Ruxolitinib 的肝酶相关减量','ruxolitinib|jakafi'],['Sirolimus 的肝酶相关减量','sirolimus|rapamune']],
 q07:[['伤口培养耐药及停用环丙沙星','ciprofloxacin|cipro|resistan']],
 q08:[['Ruxolitinib 开始、暂停与试验中重启的时间链','ruxolitinib|jakafi']],
 q09:[['感染期间 IL-2 暂停、好转后恢复的两端','IL[ -]?2|interleukin']],
 q10:[['加用或增加 Gabapentin 的疼痛治疗记录','gabapentin|neurontin|gabbio']],
 q12:[['预防用药背景下反复发生院内肺炎','pneumonia|hospital.acquired|prophyl']],
 q13:[['急性肾损伤的起点','acute kidney|acute renal|AKI'],['慢性肾病 2 期的结局','chronic kidney|chronic renal|CKD|stage 2']],
 q14:[['停用阿片后发生戒断、重启后缓解','withdrawal|opioid|oxycodone|oxycontin']],
 q15:[['射血分数下降的起点','ejection fraction|\\bEF\\b'],['慢性收缩性心力衰竭的结局','systolic|congestive|heart failure']],
 q20:[['贫血、化疗归因与输血的关联','anemia|anaemia|transfus|hemoglobin']],
 q22:[['两次 ICU 住院的 BiPAP 与高流量氧疗','bipap|bi.pap|high.flow|HFNC']],
 q23:[['血培养阴性后仍继续经验性抗生素','culture|empiric|antibiotic']],
 q24:[['抗生素相关腹泻和 GVHD 腹泻都使用洛哌丁胺','loperamide|imodium|diarrh']],
 q25:[['GVHD 发作的激素短疗程与肺炎时的对照','steroid|prednisone|methylpred|burst']],
 q27:[['怀疑感染时开始、排除感染后停用抗生素','antibiotic|infection|fever|discontinu']],
 q28:[['收缩性和舒张性心衰中均使用 Torsemide','torsemide|diastolic|systolic']],
 q29:[['低丙种球蛋白血症与感染两类住院均使用 IVIG','IVIG|immunoglobulin|hypogamma']],
 q30:[['肺炎和菌血症抗生素疗程的 7–10 天对照','antibiotic|7.day|10.day|seven.day|ten.day']],
 q31:[['跨住院反复出现铜绿假单胞菌，及与其他感染频次的比较','pseudomon|infection|bacteremia']],
 q32:[['跨住院反复出现呼吸困难','shortness of breath|dyspnea|dyspnoea|breathless|breathing']],
 q35:[['跨住院使用免疫抑制药（需核对类别与覆盖范围）','immunosupp|ruxolitinib|sirolimus|tacrolimus|prednisone|IL[ -]?2']],
 q38:[['下肢伤口反复出现恶臭分泌物','malodor|malodour|foul|odor|odour|drainage|discharge']],
 q40:[['多次住院的心动过速记录','tachycard|heart rate|fast heartbeat|racing heart']],
 q41:[['AML 缓解、复发、再缓解的有序记录','AML|leukemia|leukaemia|relaps|remission']],
 q42:[['阿片依赖或戒断后重启 Oxycodone','oxycodone|oxycontin|withdrawal']],
 q43:[['跨住院反复给予静脉补液（不是 IVIG）','IV fluid|intravenous fluid|hydration|saline|fluid bolus']],
 q44:[['难治性慢性 GVHD 开始 Abatacept','abatacept|orencia']],
 q45:[['病毒合并感染肺炎使用 Vancomycin 和 Cefepime','vancomycin|cefepime']]
};
const [experimentId='06b79e8f-8f81-40a8-b77e-dda2f30983ee',outputArg='reports/medlocomo-10913302-three-types-state-actions-06b79e8f.html']=process.argv.slice(2);
const output=resolve(outputArg);if(existsSync(output)&&!process.argv.includes('--replace'))throw new Error(`Refusing to overwrite ${output}; choose a new report filename.`);
const db=new DatabaseSync(resolve('data/careharness.sqlite'),{readOnly:true});
const row=db.prepare('SELECT config_json,results_json FROM experiments WHERE id=?').get(experimentId);if(!row)throw new Error('Experiment not found');
const config=JSON.parse(row.config_json),results=JSON.parse(row.results_json),patient=String(config.patient_id);
const base=resolve(process.env.CAREHARNESS_DATA_ROOT||'data/benchmarks','MedLoCoMo','MedLoCoMo',patient);
const official=new Map(JSON.parse(readFileSync(resolve(base,'benchmark_qa.json'),'utf8')).qas.map(q=>[q.qa_id,q]));
const types=['longitudinal_progression','cross_admission_comparison','frequency_pattern'];
const wrong=results.filter(r=>r.kind==='score'&&types.includes(r.task)&&r.status==='scored'&&r.is_correct===false).sort((a,b)=>types.indexOf(a.task)-types.indexOf(b.task)||a.score_id.localeCompare(b.score_id,undefined,{numeric:true}));
const nodes=new Map(),graphIds=new Set(),add=node=>{if(node?.memory_id)nodes.set(String(node.memory_id),node);};
for(const result of results.filter(r=>r.run_id)){
 const raw=db.prepare('SELECT final_json FROM runs WHERE id=?').get(result.run_id)?.final_json;
 if(!raw)throw new Error(`Frozen build run missing: ${result.run_id}`);
 for(const node of JSON.parse(raw).memory_nodes||[]){add(node);graphIds.add(String(node.memory_id));}
}
for(const r of wrong){for(const n of r.retrieval_context?.memory_nodes||[])add(n);for(const t of r.retrieval_trace?.investigation?.turns||[])for(const n of t.result?.snapshot?.memory_nodes||[])add(n);}
const ordered=[...nodes.values()].sort((a,b)=>String(a.event_time).localeCompare(String(b.event_time))||String(a.episode_id).localeCompare(String(b.episode_id))||Number(a.turn_id)-Number(b.turn_id));
const catalog=Object.fromEntries(ordered.map((n,i)=>[n.memory_id,{id:n.memory_id,label:`S${i+1}`,text:n.text||'',source:n.source_text||'',admission:String(n.episode_id||''),turn:String(n.turn_id||''),date:n.event_time||'',role:n.source_type||'',families:n.families||[],kind:n.construction_kind||''}]));
const arr=v=>Array.isArray(v)?v:[],ids=s=>arr(s?.memory_nodes).map(n=>String(n.memory_id)),key=n=>`${n.admission}\0${n.turn}`;
const questions=wrong.map(r=>{
 const qa=official.get(r.score_id);if(!qa)throw new Error(`Official query missing: ${r.score_id}`);
 const turns=r.retrieval_trace?.investigation?.turns;if(!turns?.length)throw new Error(`No full action snapshots: ${r.score_id}`);
 const admissions=arr(qa.evidence?.admissions).map(String),ever=new Set(),steps=[];
 let before=ids(turns[0].policy_trace?.model_input?.current_information),priorNodes=new Map(arr(turns[0].policy_trace?.model_input?.current_information?.memory_nodes).map(n=>[n.memory_id,n]));
 for(const t of turns){
   const s=t.result.snapshot,after=ids(s),old=new Set(before),now=new Set(after),changed=[];
   for(const n of s.memory_nodes||[]){if(priorNodes.has(n.memory_id)&&JSON.stringify(priorNodes.get(n.memory_id))!==JSON.stringify(n))changed.push(n.memory_id);ever.add(n.memory_id);}
   const tr=t.result.trace||{};
   steps.push({number:t.turn,action:t.decision.worker,rationale:t.decision.rationale,focus:t.decision.investigation_focus||null,instruction:t.decision.instruction,effective:tr.effective_instruction||t.decision.instruction,before,after,added:after.filter(id=>!old.has(id)),removed:before.filter(id=>!now.has(id)),kept:after.filter(id=>old.has(id)),changed,ranking:arr(tr.ranked).filter(x=>now.has(x.memory_id)).map(x=>({memory_id:x.memory_id,rank:x.rank,score:x.score,matched_terms:x.matched_terms,reasons:x.reasons})),assessment:t.decision.worker==='assess'?s.assessment:null,verification:['verify','answer'].includes(t.decision.worker)?s.verification:null,boundary:s.refinement_boundary||null,protected:tr.protected_assessment_memory_ids||[],fallback:t.fallback_used===true,error:t.error?.message||null,finalization:t.runtime_state||null});
   before=after;priorNodes=new Map(arr(s.memory_nodes).map(n=>[n.memory_id,n]));
 }
 const final=ids(r.retrieval_context),finalSet=new Set(final),everTurns=new Set([...ever].map(id=>catalog[id]).filter(Boolean).map(key)),finalTurns=new Set(final.map(id=>catalog[id]).filter(Boolean).map(key));
 const ledgerRows=r.answer_model_trace?.model_input?.evidence_ledger?.rows||r.retrieval_context?.evidence_ledger?.rows||[];
 const promptTurns=new Set(ledgerRows.map(n=>`${n.admission_id}\0${n.turn_id}`));
 const cues=review[r.score_id.split('_').at(-1)];if(!cues)throw new Error(`Review cues not defined: ${r.score_id}`);
 const requirements=cues.map(([label,pattern])=>{
   const re=new RegExp(pattern,'iu'),matching=ordered.filter(n=>re.test(n.source_text||n.text||''));
   return{label,pattern,official_ids:matching.filter(n=>admissions.includes(String(n.episode_id))).map(n=>n.memory_id),other_ids:matching.filter(n=>!admissions.includes(String(n.episode_id))).map(n=>n.memory_id)};
 });
 const scoped=ordered.filter(n=>admissions.includes(String(n.episode_id))).map(n=>n.memory_id);
 return{id:r.score_id,task:r.task,question:r.question,gold:r.gold,answer:r.system_output??'',admissions,requirements,scoped,steps,final,coverage:{ever:[...ever],ever_turns:[...everTurns],final_turns:[...finalTurns],prompt_turns:[...promptTurns]}};
});
db.close();
const data={patient,experimentId,nodes:catalog,questions};
const serialized=JSON.stringify(data).replace(/</gu,'\\u003c').replace(/\u2028/gu,'\\u2028').replace(/\u2029/gu,'\\u2029');
const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MedLoCoMo ${patient} · 错题 State / Action</title>
<style>
:root{font-family:system-ui,-apple-system,"PingFang SC",sans-serif;color:#21302d;background:#f5f6f4;font-size:15px}*{box-sizing:border-box}body{margin:0}aside{width:275px;position:fixed;inset:0 auto 0 0;background:#fff;border-right:1px solid #dce3df;padding:22px 16px;overflow:auto}main{margin-left:275px;padding:28px 36px;max-width:1450px}h1{font-size:24px}h2{font-size:20px;margin-top:30px}h3{font-size:16px}p{line-height:1.65}button,input,select{font:inherit;border:1px solid #cbd6d0;border-radius:6px;padding:9px;background:#fff}button{cursor:pointer}input,select{width:100%;margin-bottom:8px}nav a{display:block;padding:10px;border-radius:5px;margin:4px 0;text-decoration:none;color:inherit;overflow-wrap:anywhere}nav a.active{background:#e2eee7;color:#185235}nav small{display:block;color:#66776e}.box,.step{background:#fff;border:1px solid #dce3df;border-radius:9px;padding:18px;margin:14px 0}.gold{font-weight:650;color:#1b663d}.muted{color:#66776e;font-size:13px}.state{border-left:3px solid #cbd9d1;padding:10px 13px;margin:10px 0;background:#fafcf9;overflow-wrap:anywhere}.state p{margin:7px 0;white-space:pre-wrap}.tag{display:inline-block;font-size:12px;padding:3px 7px;margin:3px;border-radius:4px;background:#e8eee9}.warn{background:#fff0dc;color:#80541b}.ok{background:#ddefe1;color:#255838}.bad{background:#f7e4e1;color:#883e35}details{margin:10px 0}summary{cursor:pointer;line-height:1.7;font-weight:550}table{width:100%;border-collapse:collapse;margin:8px 0;font-size:13px}td,th{padding:9px;text-align:left;vertical-align:top;border-bottom:1px solid #e3e9e4;overflow-wrap:anywhere}th{background:#f2f5f1}dl{display:grid;grid-template-columns:145px 1fr;gap:8px}dt{color:#53675b}dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}code{font-size:12px;overflow-wrap:anywhere}.toolbar{display:flex;gap:10px;flex-wrap:wrap}.flow{display:flex;gap:7px;flex-wrap:wrap}.flow a{color:#315b45;text-decoration:none;padding:5px;background:#e7eee8;border-radius:4px}a{color:#206441}.none{padding:12px;color:#80612d;background:#fff6e7} @media(max-width:850px){aside{position:static;width:100%;max-height:260px}main{margin:0;padding:16px}dl{grid-template-columns:1fr}h1{font-size:20px}}@media print{aside,.toolbar{display:none}main{margin:0;padding:0;max-width:none}.step,.state{break-inside:avoid}details{display:block}}
</style>
<aside><h3>Patient ${patient}</h3><p class="muted">32 道错题 · Question / Gold / State / Action</p><input id="search" placeholder="搜索题号、Question 或 Gold" aria-label="搜索题目"><select id="type" aria-label="题型"><option value="">全部三类</option value="longitudinal_progression">Longitudinal progression</option><option value="cross_admission_comparison">Cross-admission comparison</option><option value="frequency_pattern">Frequency pattern</option></select><nav id="nav"></nav></aside>
<main><h1>错题的证据 State 与 Action 轨迹</h1><p class="muted">实验 ${experimentId}。仅离线整理，不运行模型，不改变原实验。</p><p class="muted">官方仅标注 Admission，没有“必需 State”清单。下方要点为人工离线拆解，State 为原文字词命中的候选，不能直接等同于 Gold 已被证明；未命中字词也不等于原文不存在。可展开官方住院范围全部 State 复核。所有列表完整保留，无前 N 条截断。</p><div class="toolbar"><button id="expand">展开当前题全部 State</button><button id="collapse">收起详情</button><button id="print">打印当前题</button></div><section id="content"></section></main>
<script id="report-data" type="application/json">${serialized}</script>
<script>
const DATA=JSON.parse(document.getElementById('report-data').textContent),N=DATA.nodes;let current=null;
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={longitudinal_progression:'Longitudinal progression',cross_admission_comparison:'Cross-admission comparison',frequency_pattern:'Frequency pattern',search:'检索',context:'补充上下文',trace:'沿图追踪',refine:'筛选 / 精简',assess:'语义评估',verify:'来源校验',answer:'冻结最终 State'};
const fields={objective:'目标',search_terms:'搜索词',expansion_terms:'扩展词',required_terms:'必须包含',excluded_terms:'排除词',term_match:'词匹配方式',source_types:'角色过滤',required_families:'Family 条件',family_weights:'Family 权重',family_match:'Family 匹配方式',episode_ids:'住院范围',memory_ids:'指定 State',temporal:'时间约束',numeric_signals:'数值线索',lenses:'搜索视角',expand_graph:'扩展图',max_results:'请求数量',assessment:'评估状态',covered_aspects:'已覆盖内容',relevant_memory_ids:'评估选中的 State',answer_focus:'回答要点标注',role_coverage:'证据角色标注',connections:'关系标注（非持久事实）',reasoning_hypotheses:'推理假设（非原文 State）',missing_information:'仍缺的信息',occurrence_candidates:'事件纳入 / 排除标注',counting:'计数范围声明',role:'证据角色',status:'状态',claim:'标注内容',source_refs:'来源引用',source_ref:'来源引用',missing_detail:'缺失内容',aspect:'要点',required_in_answer:'要求带入回答',relation_type:'关系',from_memory_id:'起点 State',to_memory_id:'终点 State',supporting_memory_ids:'支持 State',included:'是否计入',event_status:'事件状态',event_key:'事件',admission_id:'住院',event_time:'记录时间',site:'部位',exclusion_reason:'排除原因',scope_complete:'范围是否完整',unit:'计数单位',complete:'校验是否通过',rejected_memory_ids:'拒绝的 State',rejected_edge_ids:'拒绝的边',overflow:'是否超量',overflow_count:'超出数量',limit:'数量上限',requires_refine:'是否还需精简',target:'调查目标',scope:'范围',comparison_axis:'比较轴',covered_roles:'已覆盖角色',missing_roles:'缺失角色',excluded_interpretations:'排除的解释',stop_condition:'停止条件',permanent:'是否持久',excluded_memory_ids:'排除 State',start_date:'开始日期',end_date:'结束日期',operator:'时间操作',prefer:'日期偏好'};
function value(v){if(v==null)return '—';if(typeof v==='boolean')return v?'是':'否';if(Array.isArray(v))return v.length?v.map(x=>typeof x==='object'?'<div class="box">'+object(x)+'</div>':ref(x)).join('；'):'无';if(typeof v==='object')return object(v);return ref(v);}
function ref(v){const s=String(v??''),id=s.startsWith('memory:')?s.slice(7):s;return N[id]?'<span title="'+esc(id)+'">'+esc(N[id].label)+'</span>':esc(s);}
function object(o){return '<dl>'+Object.entries(o||{}).map(([k,v])=>'<dt>'+esc(fields[k]||k)+'</dt><dd>'+value(v)+'</dd>').join('')+'</dl>';}
function badge(text,cls=''){return '<span class="tag '+cls+'">'+esc(text)+'</span>';}
function state(id,q){const n=N[id];if(!n)return '<p class="none">未保存此 State 的正文：'+esc(id)+'</p>';const sets=q._sets||(q._sets={...Object.fromEntries(Object.entries(q.coverage).map(([k,v])=>[k,new Set(v)])),final:new Set(q.final)}),turn=n.admission+String.fromCharCode(0)+n.turn,c={ever:sets.ever.has(id),same_turn:sets.ever_turns.has(turn),final:sets.final.has(id),final_turn:sets.final_turns.has(turn),prompt_turn:sets.prompt_turns.has(turn)};return '<div class="state"><b>'+esc(n.label)+'</b> '+badge('Admission '+n.admission)+badge('Turn '+n.turn)+badge(n.date)+badge(n.role)+badge(n.families.join('/'))+'<div>'+badge(c.ever?'曾召回此 State':c.same_turn?'召回过同 Turn 的其他 State':'未召回',c.ever||c.same_turn?'ok':'bad')+badge(c.final?'在最终 State 中':c.final_turn?'最终有同 Turn State':'不在最终 State 中',c.final||c.final_turn?'ok':'')+badge(c.prompt_turn?'同 Turn 原文进入 Answer':'同 Turn 未进入 Answer',c.prompt_turn?'ok':'warn')+'</div><p>'+esc(n.text)+'</p>'+(n.source&&n.source!==n.text?'<details><summary>对应原文（完整）</summary><p>'+esc(n.source)+'</p></details>':'')+'<details><summary>State ID</summary><code>'+esc(n.id)+'</code></details></div>';}
function list(ids,q){return ids.length?ids.map(id=>state(id,q)).join(''):'<p class="muted">无</p>';}
function lazyList(title,ids,q){const e=document.createElement('details');e.innerHTML='<summary>'+esc(title)+'（'+ids.length+' 条）</summary>';e.addEventListener('toggle',()=>{if(e.open&&!e.dataset.loaded){e.dataset.loaded='1';const d=document.createElement('div');d.innerHTML=list(ids,q);e.append(d);}});return e;}
function addList(parent,title,ids,q){parent.append(lazyList(title,ids,q));}
function render(q){current=q;const root=document.getElementById('content');root.innerHTML='<h2>'+esc(q.id)+' · '+esc(labels[q.task])+'</h2><div class="box"><h3>Question</h3><p>'+esc(q.question)+'</p><h3>Gold</h3><p class="gold">'+q.gold.map(esc).join(' / ')+'</p><h3>Answer（本轮实际回答）</h3><p style="white-space:pre-wrap">'+esc(q.answer)+'</p></div><h2>回答 Gold 需要核对的 State</h2><p class="muted">官方标注住院：'+q.admissions.map(esc).join('、')+'。绿色仅表示进入了上下文，不表示已证明 Gold。</p>';
for(const req of q.requirements){const box=document.createElement('section');box.className='box';box.innerHTML='<h3>'+esc(req.label)+'</h3><p class="muted">离线查找线索：'+esc(req.pattern)+'</p>'+(req.official_ids.length?'':'<p class="none">官方标注的住院范围内，未找到这些字词对应的候选 State；不能据此编造证据。</p>');addList(box,'官方住院范围内的原文候选 State',req.official_ids,q);addList(box,'其他住院中命中相同线索的 State（非官方标注范围）',req.other_ids,q);root.append(box);}
addList(root,'官方标注住院范围的全部 State（用于复核漏选）',q.scoped,q);
const h=document.createElement('h2');h.textContent='每一步 Action 对 State 的操作';root.append(h);const flow=document.createElement('div');flow.className='flow';flow.innerHTML=q.steps.map(s=>'<a href="#step-'+s.number+'">'+s.number+' '+esc(s.action)+'</a>').join('');root.append(flow);
for(const s of q.steps){const el=document.createElement('section');el.className='step';el.id='step-'+s.number;el.innerHTML='<h3>第 '+s.number+' 步 · '+esc(s.action)+' — '+esc(labels[s.action]||s.action)+'</h3><p>'+esc(s.rationale||'')+'</p><p>'+badge('State '+s.before.length+' → '+s.after.length)+badge('新增 '+s.added.length,'ok')+badge('移除 '+s.removed.length,s.removed.length?'bad':'')+badge('保留 '+s.kept.length)+(s.fallback?badge('使用了回退动作','warn'):'')+'</p><details open><summary>本步实际执行的检索 / 操作参数</summary>'+object(s.effective)+'</details>'+(JSON.stringify(s.instruction)!==JSON.stringify(s.effective)?'<details><summary>Policy 原始参数（与执行参数不同）</summary>'+object(s.instruction)+'</details>':'')+(s.focus?'<details><summary>本步调查方向和停止条件</summary>'+object(s.focus)+'</details>':'');
addList(el,'新增进入工作集的 State',s.added,q);addList(el,'从工作集移除的 State',s.removed,q);addList(el,'保留的 State',s.kept,q);if(s.changed.length)addList(el,'同 ID 但内容 / 属性发生变化的 State',s.changed,q);if(s.protected.length)addList(el,'因证据链引用被保护的 State',s.protected,q);
if(s.ranking.length){const d=document.createElement('details');d.innerHTML='<summary>已返回 State 的排序及命中词</summary><table><thead><tr><th>State</th><th>名次</th><th>排序分</th><th>命中词</th><th>排序原因</th></tr></thead><tbody>'+s.ranking.map(r=>'<tr><td>'+ref(r.memory_id)+'</td><td>'+esc(r.rank)+'</td><td>'+esc(r.score)+'</td><td>'+value(r.matched_terms)+'</td><td>'+value(r.reasons)+'</td></tr>').join('')+'</tbody></table>';el.append(d);}
if(s.assessment){const d=document.createElement('details');d.open=true;d.innerHTML='<summary>Assess 对 State 的判断和关系标注（不是新增病历事实）</summary>'+object(s.assessment);el.append(d);}
if(s.verification){const d=document.createElement('details');d.innerHTML='<summary>State 来源 / 数量校验</summary>'+object(Object.fromEntries(Object.entries(s.verification).filter(([k])=>!['memory_nodes','memory_edges','relations','working_memory'].includes(k))));el.append(d);}
if(s.boundary){const d=document.createElement('details');d.innerHTML='<summary>本步之后仍生效的检索边界</summary>'+object(s.boundary);el.append(d);}
addList(el,s.action==='answer'?'最终选择的全部 State':'操作后的全部工作集 State（顺序按轨迹）',s.after,q);if(s.error){const p=document.createElement('p');p.className='none';p.textContent=s.error;el.append(p);}root.append(el);}
document.querySelectorAll('nav a').forEach(a=>a.classList.toggle('active',a.dataset.id===q.id));}
function nav(){const term=document.getElementById('search').value.toLowerCase(),type=document.getElementById('type').value;document.getElementById('nav').innerHTML=DATA.questions.filter(q=>(!type||q.task===type)&&[q.id,q.question,...q.gold].join(' ').toLowerCase().includes(term)).map(q=>'<a href="#'+esc(q.id)+'" data-id="'+esc(q.id)+'" class="'+(current?.id===q.id?'active':'')+'">'+esc(q.id.replace(DATA.patient+'_',''))+'<small>'+esc(labels[q.task])+'</small></a>').join('');}
document.getElementById('search').addEventListener('input',nav);document.getElementById('type').addEventListener('change',nav);
window.addEventListener('hashchange',()=>{const q=DATA.questions.find(q=>q.id===decodeURIComponent(location.hash.slice(1)));if(q){render(q);window.scrollTo(0,0);}});
document.getElementById('expand').onclick=()=>{document.querySelectorAll('#content details').forEach(d=>d.open=true);};document.getElementById('collapse').onclick=()=>document.querySelectorAll('#content details').forEach(d=>d.open=false);
document.getElementById('print').onclick=()=>{document.getElementById('expand').click();setTimeout(()=>window.print(),150);};
nav();render(DATA.questions.find(q=>q.id===decodeURIComponent(location.hash.slice(1)))||DATA.questions[0]);
</script></html>`;
mkdirSync(dirname(output),{recursive:true});writeFileSync(output,html);
console.log(JSON.stringify({output,questions:questions.length,actions:questions.reduce((n,q)=>n+q.steps.length,0),source_states:ordered.length,bytes:Buffer.byteLength(html),model_calls:0}));
