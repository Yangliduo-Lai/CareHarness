import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync,readFileSync } from 'node:fs';
import { dirname,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const readme=readFileSync(resolve(root,'README.md'),'utf8');

test('README is the only documentation entry',()=>{
  assert.equal(readme.includes('docs/'),false);
  assert.equal(existsSync(resolve(root,'IMPLEMENTATION_REPORT.md')),false);
  for(const path of [
    'docs/COLLABORATOR_RUN_GUIDE.md',
    'docs/careharness-runtime-structure.html',
    'docs/benchmark-literature.html',
    'docs/model-adapter-architecture.html'
  ])assert.equal(existsSync(resolve(root,path)),false,path);
});

test('README contains only the required run instructions',()=>{
  for(const text of [
    'Node.js `22.9`','CAREHARNESS_DATA_ROOT','generated_dialogues.json','generated_queries.json',
    'npm run test:core','npm run smoke','npm start','模型与 Provider',
    'Persona 1','Clean','97 题','仅预检（不调用模型）','启动 1 个 CareHarness 运行',
    'npm run medmemory:persona1','--prepare-snapshots'
  ])assert.ok(readme.includes(text),text);
});

test('README says exactly where frontend and CLI results are shown',()=>{
  for(const text of [
    'CareHarness 运行结果','Failure taxonomy 聚合','打开 Experiment：逐题看 action / prompt / scorer',
    '查看答题/评分详情','Patient Graph Explorer','Runs & Errors','一键导出错题与完整诊断',
    'reports/medmemory-careharness-results.json','reports/medmemory-careharness-results.md',
    'Suite ID','Experiment ID','manifest hash','97/97'
  ])assert.ok(readme.includes(text),text);
});

test('README no longer contains research or architecture documentation sections',()=>{
  for(const heading of [
    '## 当前系统如何运行','### 一张长期 Patient Graph','## 信息隔离与安全边界',
    '## 提示词的唯一维护位置','## MedMemoryBench 评分方式','## 失败分类体系',
    '## 自动优化的实际边界','## 当前版本与诚实状态','## 数据边界与其他 benchmark',
    '## 持久化、快照与可复现性'
  ])assert.equal(readme.includes(heading),false,heading);
});
