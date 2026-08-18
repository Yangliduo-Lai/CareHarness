import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const report=readFileSync('docs/benchmark-literature.html','utf8');
const architecture=readFileSync('docs/model-adapter-architecture.html','utf8');

test('literature report covers the four visible longitudinal benchmarks only',()=>{
  for(const text of ['MedMemoryBench','MedLoCoMo','MediLongChat','CPCD-Bench'])assert.ok(report.includes(text),text);
  for(const text of ['data-target="medmemory"','data-target="medlocomo"','data-target="medilongchat"','data-target="cpcd"'])assert.ok(report.includes(text),text);
  assert.equal(/psych\s*eval/i.test(report),false);
});

test('MediLongChat preserves the paper model results and labels the local release limitation',()=>{
  const section=report.match(/<section id="medilongchat"[\s\S]*?<\/section>/)?.[0]||'';
  for(const text of ['IDR F1','IDR BLEU-1','CDR F1','CDR BLEU-1','SR Accuracy','Deepseek-R1','33.49','11.12','Qwen3-235B','ERNIE-4.5-turbo','GPT-4o mini','24.25','GPT-4.1 mini','83.75','论文 Table 6 的官方任务 annotation 并未出现在当前官方仓库'])assert.ok(section.includes(text),text);
  for(const url of ['https://arxiv.org/abs/2605.19766','https://github.com/HebinHu/MediLongChat'])assert.ok(section.includes(url),url);
});

test('CPCD-Bench shows the official system table, task dimensions, and scale boundaries',()=>{
  const section=report.match(/<section id="cpcd"[\s\S]*?<\/section>/)?.[0]||'';
  for(const text of ['159','99 道','40 道','20 道','SR · 1–5','MR · 0–5','TCR · 0–5','GPT-5.2','GPT-5.4','4.778','4.513','4.525','Gemini-3-flash-preview','DeepSeek V3.2','CPCD-Chat-8B'])assert.ok(section.includes(text),text);
  for(const text of ['Human SR','Human MR','Human TCR'])assert.equal(section.includes(text),false,text);
  for(const url of ['https://arxiv.org/abs/2605.22140','https://github.com/EdwinUSTB/Psy-Chronicle','https://huggingface.co/datasets/EdwinUstb/CPCD-Bench'])assert.ok(section.includes(url),url);
});

test('MedMemoryBench reports every task separately for clean and noise settings',()=>{
  const section=report.match(/<section id="medmemory"[\s\S]*?<\/section>/)?.[0]||'';
  for(const text of ['Clean · Efficient（无噪声）','Noise · Mixed（加噪声）','实体精确匹配（EEM）','时间定位（TLA）','状态更新（SUA）','选择题（MQ）','推理生成（IG）','多跳临床推理（MCD）'])assert.ok(section.includes(text),text);
  const clean=section.match(/<article id="medmemory-clean"[\s\S]*?<\/article>/)?.[0]||'',noise=section.match(/<article id="medmemory-noise"[\s\S]*?<\/article>/)?.[0]||'';
  for(const table of [clean,noise])for(const task of ['EEM','TLA','SUA','MQ','IG','MCD','Avg.'])assert.ok(table.includes(`>${task}<`),task);
  for(const row of [
    ['Long-Context','50.64','40.26','76.62','73.86','43.60','24.50','51.58','38.15','38.22','65.75','54.55','25.60','10.25','38.75'],
    ['Letta','58.95','40.74','68.52','66.97','52.87','19.20','51.21','40.50','23.00','52.00','70.35','49.50','13.97','41.55']
  ])for(const value of row)assert.ok(section.includes(value),value);
});

test('MedLoCoMo explains what each baseline controls',()=>{
  const section=report.match(/<section id="medlocomo"[\s\S]*?<\/section>/)?.[0]||'';
  for(const text of ['完整纵向病历直接放入模型上下文','不先构建外部记忆，也不做检索','固定使用同一个 Gemma3-27B','只替换前面的记忆或检索方法','分数差异主要反映 memory/retrieval 层'])assert.ok(section.includes(text),text);
});

test('literature report preserves existing official score tables and sources',()=>{
  for(const text of ['Long-Context','51.58','Letta','41.55','Gemini 3 Flash Preview','GPT-5.1','72.8','mem0','57.6','https://arxiv.org/abs/2605.11814','https://arxiv.org/abs/2607.22566'])assert.ok(report.includes(text),text);
});

test('literature tables highlight the latest compatible local experiments without hiding their scope',()=>{
  assert.equal((report.match(/<tr class="latest">/g)||[]).length,5);
  for(const text of ['latest-badge','本地最新','06ef32f4','f446ebbc','565e53ae','c8323281','e25758e9'])assert.ok(report.includes(text),text);
  const medmemory=report.match(/<section id="medmemory"[\s\S]*?<\/section>/)?.[0]||'';
  for(const row of [
    ['06ef32f4','75.00','45.00','70.00','57.89','20.00','10.77','48.31'],
    ['f446ebbc','75.00','55.00','90.00','57.89','25.00','1.69','52.72']
  ])for(const value of row)assert.ok(medmemory.includes(value),value);
  const medlocomo=report.match(/<section id="medlocomo"[\s\S]*?<\/section>/)?.[0]||'';
  for(const text of ['565e53ae','8.1','9.8','100.0','39.9','42.0','37.7','92 道 answerable','46 道 adversarial'])assert.ok(medlocomo.includes(text),text);
  const medilongchat=report.match(/<section id="medilongchat"[\s\S]*?<\/section>/)?.[0]||'';
  for(const text of ['c8323281','release-derived','23 道 IDR、1 道 CDR、1 道 SR','不能与论文行横向比较'])assert.ok(medilongchat.includes(text),text);
  const cpcd=report.match(/<section id="cpcd"[\s\S]*?<\/section>/)?.[0]||'';
  for(const text of ['e25758e9','4.333','4.500','3.750','5 道 SR、2 道 MR、1 道 TCR','不代表官方 159 题总体'])assert.ok(cpcd.includes(text),text);
});

test('local Gate comparison tables preserve every supplied configuration and classification',()=>{
  const medmemory=report.match(/<section id="medmemory"[\s\S]*?<\/section>/)?.[0]||'';
  for(const text of ['710942e7','c12014ef','f3dc415b','7fa1504a','06ef32f4','三个决策门关闭','G1 + G2 + G3','关闭 G1（G2 + G3）','关闭 G2（G1 + G3）','关闭 G3（G1 + G2）','46.31','51.92','51.12','54.56','48.31'])assert.ok(medmemory.includes(text),text);
  const medlocomo=report.match(/<section id="medlocomo"[\s\S]*?<\/section>/)?.[0]||'';
  for(const text of ['Overall · 全部 Single 与 Cross','Single · 答案证据位于单次 admission','Cross · 答案需要跨 admissions 证据','32727cb2','feea24c6','aa816e35','05df3f63','565e53ae','45.7','47.8','43.5','44.2','44.9','37.7'])assert.ok(medlocomo.includes(text),text);
  const cpcd=report.match(/<section id="cpcd"[\s\S]*?<\/section>/)?.[0]||'';
  for(const text of ['f1ff3856','dc31d5af','be63ca8e','b676eb7f','c0629664','69a1acc9','e2bfeed4','e25758e9','仅 G1','仅 G2','仅 G3','Empathy 4.80','Temporal Consistency 5.00','Causal Coherence 5.00'])assert.ok(cpcd.includes(text),text);
  for(const section of [medmemory,medlocomo,cpcd])assert.ok(section.includes('固定 Evidence Index Gate'),section.slice(0,80));
});

test('every score column bolds exactly its highest value, including ties',()=>{
  assert.equal(report.includes('<tr class="best">'),false);
  const strip=value=>value.replace(/<[^>]+>/g,' ').replace(/&[^;]+;/g,' ').replace(/\s+/g,' ').trim(),tables=[...report.matchAll(/<table[\s\S]*?<\/table>/g)].map(match=>match[0]);
  for(const table of tables){
    const rows=[...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(row=>[...row[1].matchAll(/<t[hd]([^>]*)>([\s\S]*?)<\/t[hd]>/g)].map(cell=>({attributes:cell[1],text:strip(cell[2])})));
    const headers=rows[0].map(cell=>cell.text),body=rows.slice(1);
    for(let column=1;column<headers.length;column++){
      if(headers[column]==='Context')continue;
      const values=body.map(row=>({cell:row[column],value:Number.parseFloat(row[column]?.text)})).filter(item=>Number.isFinite(item.value)),maximum=Math.max(...values.map(item=>item.value));
      for(const item of values)assert.equal(/class="[^"]*best/.test(item.cell.attributes),item.value===maximum,`${headers[column]}: ${item.value} / max ${maximum}`);
    }
  }
});

test('literature report is standalone and responsive',()=>{
  assert.ok(report.includes('@media(max-width:800px)'));
  assert.ok(report.includes('overflow:auto'));
  assert.equal(/<(link|script)[^>]+(?:src|href)=["']https?:/i.test(report),false);
});

test('model and adapter implementation map covers every visible non-MediLongChat query contract',()=>{
  for(const text of [
    '模型与 Benchmark Adapter 实现图','Extractor','Router','Query Planner','scoring_judge','medlocomo_judge','评分 Judge 可见内容',
    'entity_exact_match','temporal_localization','state_update','multiple_choice','inference_generation','multi_hop_clinical_deduction',
    'adversarial','longitudinal_progression','care_plan_rationale','cross_admission_comparison','medical_reasoning','frequency_pattern',
    'task_1','task_2','task_3','session_level_response_generation','memory_recall','temporal_causal_reasoning',
    'candidate_passthrough','protocol-only','冻结答案后'
  ])assert.ok(architecture.includes(text),text);
  assert.equal(architecture.includes('data-panel="medilongchat"'),false);
});

test('model and adapter implementation map is standalone, interactive and responsive',()=>{
  assert.ok(architecture.includes('@media(max-width:700px)'));
  assert.ok(architecture.includes('id="query-filter"'));
  assert.ok(architecture.includes('IntersectionObserver'));
  assert.equal(/<(link|script)[^>]+(?:src|href)=["']https?:/i.test(architecture),false);
});

test('architecture separates data adapters, direct benchmark answering and output cleanup',()=>{
  for(const text of ['Data to Observation','题目 Adapter','统一 Observation','Hybrid Retrieval','最终答案生成','读取 question、task、answer contract、Query Plan、检索到的 State/Evidence','共享 Prompt 与题型 contract 合成后，调用一次模型'])assert.ok(architecture.includes(text),text);
  assert.equal(architecture.includes('所有 adapter 共享的记忆核心'),false);
  assert.equal(architecture.includes('<section id="models">'),false);
});

test('architecture gives Hybrid Retrieval its own implementation section',()=>{
  const section=architecture.match(/<section id="retrieval">[\s\S]*?<\/section>/)?.[0]||'';
  for(const text of ['retrieveStateCandidates(queryPlan, states, evidence, options)','词面','alias','ngram','scope','facet','Evidence','version','Content Dedup Gate','一个合并组只占一个候选名额','保留全部原始 State','固定 Evidence Index Gate','前端和 API 均没有关闭选项','family','coverage','Evidence chain','三个门','Clinical Need &amp; Safety','Understanding &amp; Clarification','Preference &amp; Feasibility','CS + PE','PA + BC','candidate_passthrough','题型安全上限','结构化输出'])assert.ok(section.includes(text),text);
  for(const text of ['可选 Evidence Index Gate','Gate 关闭','Gate 启用'])assert.equal(section.includes(text),false,text);
  assert.ok(architecture.includes('data-target="retrieval"'));
});
