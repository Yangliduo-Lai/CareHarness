# CareHarness

## 运行

需要 Node.js 22.9 或更高版本。在项目根目录执行：

```bash
npm start
```

然后打开：

```text
http://127.0.0.1:8766
```

需要真实模型时，在前端“模型与 Provider”页面保存连接，并为 Extractor、Memory Family Tagger、Investigation Policy、Benchmark Answer 和对应 Judge 分配模型。

运行 MedMemoryBench：

```bash
npm run medmemory:persona1
```

独立题目默认以 4 路并发运行；可在前端设置 `Query concurrency`，或在 CLI 使用 `--query-concurrency 1` 到 `--query-concurrency 16`。

如需先构建统一 Memory Graph：

```bash
npm run medmemory:matched -- --prepare-snapshots --persona 1 --split dev --noise clean
```

运行完整 CPCD-Bench：

```bash
npm run cpcd:run
```

重新生成 MedMemoryBench Clean 的离线教师与无病例 Student 策略摘要：

```bash
npm run medmemory:distill-policy -- --data-root "<MedMemoryBench/data/MedMemoryBench>" --no-lopo
```

## 查看结果

- 前端“Experiments”：查看实验总分、各题结果、Investigation 轨迹、Working Memory 和评分详情。
- 前端“Memory Graph”：搜索并查看同一批 Memory Nodes 及其 Memory Edges。
- CLI 报告：默认写入 `reports/medmemory-careharness-results.json`，同时生成同名 `.md` 摘要。
- CPCD-Bench 报告：`reports/cpcd-qwen37-full.json` 及同名 `.md` 摘要。
- 离线教师报告：`reports/medmemory-oracle-teacher.json`；运行时安全摘要：`reports/medmemory-student-strategy.json`。
- 错题 JSON：在 Experiment 详情页导出。
