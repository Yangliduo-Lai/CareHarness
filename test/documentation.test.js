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
    '直接交给 Codex','Node.js 22.9','npm start','/api/models/profiles',
    'npm run medmemory:matched','--prepare-snapshots','无放回抽样','固定随机种子 42',
    'qwen3.7-plus','格式容错调整分','硬编码的确定性格式规范化',
    'Long-Context','A-Mem','Letta','run-official-medmemory-baseline.py','--resume'
  ])assert.ok(readme.includes(text),text);
  for(const text of ['前端','浏览器','CPCD','Psy-Chronicle'])assert.equal(readme.includes(text),false,text);
});

test('README says exactly where CLI results are shown',()=>{
  for(const text of [
    '/api/experiments/summaries','/wrong-answers/export','/api/memory-graphs',
    'reports/medmemory-careharness-results.json','错题 JSON'
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
