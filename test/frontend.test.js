import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync,readFileSync } from 'node:fs';

const js=readFileSync(new URL('../public/app.js',import.meta.url),'utf8'),html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8'),css=readFileSync(new URL('../public/styles.css',import.meta.url),'utf8');

test('frontend exposes the unified Memory Graph and keyword search',()=>{
  for(const text of ['Memory Graph Explorer','搜索 Memory Node','memorySearchForm','/api/memory-graphs','memory_graph','Memory Nodes','Memory Edges'])assert.ok(js.includes(text),text);
  assert.ok(js.includes('BC / PE / PA / CS / CP / LO 是该节点的多值标签'));
});

test('Memory Graph emphasizes semantic state without duplicating equivalent source text',()=>{
  for(const text of ['graphSubstantiveText','graphTextsEquivalent','graphNodeSourceEntries','graph-semantic-text','展开不同的原文证据','节点元数据（不重复正文与原文）'])assert.ok(js.includes(text),text);
  assert.ok(js.includes("filter(item=>!graphTextsEquivalent(node.text,item.text))"));
  assert.ok(js.includes('包含折叠的原文证据'));
});

test('Memory Graph separates context membership from reasoning relations',()=>{
  for(const text of ['graphEdgeIsContext','showContextEdges=false','显示 co_observed 上下文边','默认隐藏且不计入临床推理关系','仅表示同一 Session 上下文，不是临床推理关系'])assert.ok(js.includes(text),text);
  for(const text of ['Family','Relation（不含 co_observed）','Status','Fallback States','Provenance refs'])assert.ok(js.includes(text),text);
});

test('Memory Graph limits DOM previews while searching all source provenance',()=>{
  assert.ok(js.includes('GRAPH_NODE_PREVIEW_LIMIT=180,GRAPH_EDGE_PREVIEW_LIMIT=120'));
  assert.ok(js.includes('JSON.stringify([node.source_refs,node.provenance,node.supporting_source_refs])'));
  assert.ok(js.includes('搜索与统计在截断前执行'));
});

test('policy page explains adaptive investigation without static query decomposition',()=>{
  for(const text of ['Benchmark Investigation Policy','Patient Profile','原始问题、Patient Profile、近期原文、已选历史信息、此前 Worker 结果和剩余预算','最近 3 个完整 Patient/Doctor Session','不参与 query 排序','独立题型分类器只读取原始问题','预测结果只决定 Investigation Policy 的证据合同与检索策略','官方题型不进入检索 Policy','最终 Answer 阶段选择对应的官方 Answer Prompt','动态选择 Worker 与具体关键词、时间、语义端点'])assert.ok(js.includes(text),text);
  for(const old of ['Query Planner 模型输出','Evidence Index Gate','evidence_need_graph','target_slot_ids'])assert.equal(js.includes(old),false,old);
});

test('model settings expose Investigation Policy and no Query Planner assignment',()=>{
  assert.ok(js.includes("investigation_policy:'Investigation Policy'"));assert.equal(js.includes("query_planner:'"),false);
});

test('query detail lazily loads Question Request, Investigation steps and frozen Memory context',()=>{
  for(const text of ['题型分类器（只读取原始问题）','query_classification','Question Request（未预解析）','Investigation Policy 每一步','完整 Investigation State','investigation_trace','patient_profile','recent_sessions','historical_memory_nodes','working_memory','memory_nodes','memory_edges','/scores/'])assert.ok(js.includes(text),text);
  assert.ok(js.includes('只加载当前题目的完整 trace'));
});

test('runtime visualization is derived from the current investigation rather than a fixed action sequence',()=>{
  assert.ok(js.includes('Patient Profile → 近期原文 → 按需检索旧史'));assert.ok(js.includes('investigationTrace.map'));
  assert.equal(js.includes('focus → anchor → connect → evaluate → verify → answer'),false);
});

test('MedMemory matched panel uses the v6 adaptive suite and unified snapshot preparation',()=>{
  for(const text of ['Adaptive Investigation Policy 运行控制台','Investigation budget','Query concurrency','准备缺失/过期 Memory Graph snapshot','medmemory-matched-suite.v9'])assert.ok(js.includes(text),text);
  assert.equal(js.includes('medmemory-matched-suite.v5'),false);
});

test('MedMemory latest results compare the current run with the previous matching scope',()=>{
  for(const text of ['medMemoryExperimentScope','medMemoryLatestPair','上一轮同范围实验','当前 − 上轮','较上一轮','百分点（pp）','limit=200'])assert.ok(js.includes(text),text);
  assert.ok(js.includes("item.status==='completed'&&medMemoryExperimentScope(item)===scope"));
  for(const text of ['score-delta.positive','score-delta.negative','experiment-delta-row'])assert.ok(html.includes(text),text);
});

test('experiment list stays lightweight and fetches heavy score details on demand',()=>{
  for(const text of ['result_payload','result_counts','EXPERIMENT_INITIAL_ROWS','show-all-scores','open-score'])assert.ok(js.includes(text),text);
  assert.ok(js.includes('/api/experiments/${encodeURIComponent(x.id)}/scores/'));
});

test('frontend keeps operational status notices but removes the old standalone method document',()=>{
  assert.equal(existsSync(new URL('../public/method-report.html',import.meta.url)),false);assert.ok(js.includes('notice'));assert.ok(html.includes('app.js'));
});

test('responsive styles preserve scrolling for large traces and graph results',()=>{
  assert.ok(css.includes('overflow'));assert.ok(css.includes('@media'));
});
