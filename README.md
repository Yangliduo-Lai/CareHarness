# CareHarness

## 运行

把下面这段任务直接交给 Codex 执行：


> 1. 先确认本机安装了 Node.js 22.9 或更高版本，然后执行 `npm install`。
> 2. 如果 `.env` 不存在，执行 `cp .env.example .env`；如果已经存在，不要覆盖。真实 API Key 只能保存在本地 `.env` 中，不要打印、复制到 README、写入源码或提交到 Git。CareHarness 使用 `CAREHARNESS_MATCHED_API_KEY`；CloseAI 官方 baseline 包装器单独使用 `CAREHARNESS_RUN_KEY`。其余默认配置可参考 `.env.example`。
> 3. 确认 MedMemoryBench 数据位于 `data/benchmarks/MedMemoryBench/data/MedMemoryBench/`。如果数据不存在，停止运行并告诉我缺少的准确路径，不要自行生成替代数据。
> 4. 执行 `npm test`。如果测试失败，先报告失败项，不要直接改动 Benchmark 数据或评分规则。
> 5. 执行 `npm start` 启动本地服务，并在另一个终端运行 `curl -s http://127.0.0.1:8766/api/health | jq` 检查服务状态。
> 6. 本次实验统一使用 CloseAI `qwen3.7-plus`。不要沿用数据库中可能残留的其他模型分配。请通过命令行请求 `/api/models/profiles` 创建或更新该连接，再请求 `/api/models/assignments`，只保留一个指向该连接的 `global` 分配，使 Extractor、Router、Relation Classifier、Investigation Policy、Answer 和 Judge 全部继承同一模型。配置中只写 `"api_key_ref":"CAREHARNESS_MATCHED_API_KEY"`，不要在请求正文中传递真实 Key。完成后调用 `/api/models/config`，确认所有实际分配均解析为 `qwen3.7-plus`，否则不要启动实验。
> 7. 首次运行或 Memory Graph 不完整时，执行：
>
>    ```bash
>    npm run medmemory:matched -- \
>      --prepare-snapshots \
>      --persona 1 \
>      --split dev \
>      --noise clean
>    ```
>
> 8. 如果任务是“随机抽取 MedMemoryBench 中 XX 个 Persona 并答题”，请先从数据目录列出全部可用 Persona ID，再使用固定随机种子 42 进行无放回抽样。在抽样名单确定并记录之前，不要读取题目、Gold、Answer Explanation、Judge metadata 或节点标注，也不要根据题目内容调整抽样结果。将 `XX` 替换为我指定的数量；如果未指定数量，先向我确认。
> 9. 对抽中的每个 Persona 运行 Clean 条件下的完整题集，不挑题、不跳题，也不因得分或失败而重新抽取 Persona。已有完整 Memory Graph 时直接复用；缺失或不完整时才为该 Persona 执行 `--prepare-snapshots`。每个 Persona 使用 `npm run medmemory:matched -- --persona <编号> --split heldout --noise clean --query-concurrency 16 --output reports/medmemory-persona<编号>-results.json`，并分别保存结果。
> 10. 运行期间持续观察终端输出；如果中断，保留原抽样名单并优先使用项目已有的断点恢复机制，从同一 Persona 的断点继续，不要删除数据库、重新抽样或无故从头重建完整 Memory Graph。
> 11. 全部运行结束后，汇报固定随机种子、抽中的 Persona ID、每个 Persona 的完成状态和分数、跨 Persona 平均分、六类题型分数以及全部输出文件路径。未经我明确要求，不要 commit、push、改分支或修改远端仓库。

将下面这段任务继续交给 Codex，即可在本地运行 Long-Context、A-Mem 和 Letta：

> 请使用与 CareHarness 完全相同的 Persona 抽样名单，分别运行 MedMemoryBench 官方 Long-Context、A-Mem 和 Letta baseline，不要重新抽样，也不要改变题目范围。三种方法的回答模型和 Judge 都统一使用 CloseAI `qwen3.7-plus`。
>
> 先确认 `MEDMEMORYBENCH_REPO` 指向完整的 MedMemoryBench 官方仓库，而不只是数据目录；该目录中必须存在 `benchmarks/medmemorybench/`。使用独立的 Python 3.11 环境 `.venv-medmemory-baselines`。如果环境不存在，请读取官方仓库自己的依赖文件并安装到该环境，不要修改系统 Python，也不要自行猜测或锁定一套不同的依赖版本。
>
> A-Mem 和 Letta 还需要本地 `BGE-small-zh-v1.5`，默认路径为 `.cache/models/bge-small-zh-v1.5`。确认模型文件完整后再运行；Long-Context 不使用 Embedding。真实 Key 仍只从本地环境变量读取。运行前加载 `.env`，确认其中存在有效的 CloseAI `CAREHARNESS_RUN_KEY`，不要输出 Key，也不要把其他 Provider 的 Key 映射给 CloseAI。
>
> 将同一份逗号分隔的 Persona ID 写入 `BASELINE_PERSONAS`，然后依次执行下面三条命令。每一种方法都必须带 `--resume`；进程中断时从各自 checkpoint 继续，不能删除输出目录或重跑已经完成的问题。A-Mem、Letta 和 Long-Context 的结果必须保存到彼此独立的目录。

```bash
set -a
source .env
set +a

export MEDMEMORYBENCH_REPO="${MEDMEMORYBENCH_REPO:-$PWD/data/benchmarks/MedMemoryBench}"

BASELINE_PERSONAS="<抽中的 Persona ID，使用逗号分隔>"
BASELINE_OUTPUT_ROOT="reports/official-baselines/qwen3.7-plus/random-seed-42"
BASELINE_PYTHON=".venv-medmemory-baselines/bin/python"
BGE_MODEL=".cache/models/bge-small-zh-v1.5"

"${BASELINE_PYTHON}" -u scripts/run-official-medmemory-baseline.py \
  --repo "${MEDMEMORYBENCH_REPO}" \
  --method long_context \
  --personas "${BASELINE_PERSONAS}" \
  --model qwen3.7-plus \
  --judge-model qwen3.7-plus \
  --base-url https://api.openai-proxy.org/v1 \
  --output-dir "${BASELINE_OUTPUT_ROOT}/long_context" \
  --resume

"${BASELINE_PYTHON}" -u scripts/run-official-medmemory-baseline.py \
  --repo "${MEDMEMORYBENCH_REPO}" \
  --method amem \
  --personas "${BASELINE_PERSONAS}" \
  --model qwen3.7-plus \
  --judge-model qwen3.7-plus \
  --base-url https://api.openai-proxy.org/v1 \
  --embedding-model "${BGE_MODEL}" \
  --amem-request-timeout-seconds 300 \
  --output-dir "${BASELINE_OUTPUT_ROOT}/amem" \
  --resume

"${BASELINE_PYTHON}" -u scripts/run-official-medmemory-baseline.py \
  --repo "${MEDMEMORYBENCH_REPO}" \
  --method letta \
  --personas "${BASELINE_PERSONAS}" \
  --model qwen3.7-plus \
  --judge-model qwen3.7-plus \
  --base-url https://api.openai-proxy.org/v1 \
  --embedding-model "${BGE_MODEL}" \
  --output-dir "${BASELINE_OUTPUT_ROOT}/letta" \
  --resume
```

如果恰好运行 Persona 1、3、5、7，也可以直接执行现成的顺序运行脚本：

```bash
zsh scripts/run-official-medmemory-baselines-all.sh
```

如需手动创建 CloseAI `qwen3.7-plus` 模型连接，可执行：

```bash
curl -sS -X POST http://127.0.0.1:8766/api/models/profiles \
  -H 'Content-Type: application/json' \
  -d '{
    "id": "closeai-qwen3.7-plus",
    "name": "CloseAI Qwen3.7 Plus",
    "config": {
      "provider": "openai-compatible",
      "base_url": "https://api.openai-proxy.org/v1",
      "model": "qwen3.7-plus",
      "api_key_ref": "CAREHARNESS_MATCHED_API_KEY",
      "temperature": 0.3,
      "max_tokens": 10240,
      "timeout_ms": 300000,
      "retries": 2
    }
  }' | jq

curl -sS -X POST http://127.0.0.1:8766/api/models/assignments \
  -H 'Content-Type: application/json' \
  -d '{"assignments":{"global":"closeai-qwen3.7-plus"}}' | jq

curl -s http://127.0.0.1:8766/api/models/config | jq
```

## 查看结果

把下面这段任务直接交给 Codex 执行：

> 请仅使用命令行检查本次 MedMemoryBench 实验。先读取 `reports/medmemory-careharness-results.json` 和同名 Markdown；如果使用了自定义 `--output`，则读取对应文件。然后调用实验 API 核对最近实验及其逐题结果。最后用中文汇报实验是否完整结束、总分、六类题型分数、失败题数量、实验 ID 和报告路径。
>
> EEM 的官方 `string_contain` 指标对字面格式敏感，因此 EEM 分数偏低并不一定表示答案内容错误；常见情况是实体或数值正确，但单位写法、空格、大小写、标点或等价格式与 Gold 不完全一致。保留官方原始 EEM 分数，同时额外计算并明确标为“格式容错调整分”：逐题检查官方判错的 EEM，如果答案的实体、数值、范围和单位语义均正确，差异仅为格式，则在调整分中按正确计算。不要把缺少关键实体、数值、范围或单位的答案算对。
>
> 可以通过硬编码的确定性格式规范化解决这类问题，但规则必须是对所有 EEM 通用的格式规则，例如统一空格、大小写、全角/半角标点和等价单位写法；不得按 Persona、题目 ID、Question、Gold 或某一道答案写特例。报告调整分时同时列出每个被修正题目的 ID、原答案、Gold 和所应用的通用规则，不要覆盖或伪装成官方分数。
>
> 对 Long-Context、A-Mem 和 Letta，分别读取各输出目录中的 `run-manifest.json`、checkpoint、`process.log` 和最终 `*_result.json`。确认三者使用相同 Persona、模型和 Judge 后，再与 CareHarness 汇总到同一张表；至少报告六类题型分数、平均分、完成题数、平均每题 Token 和平均延迟。未完成的 baseline 必须标为 partial，不能把当前局部平均分当作最终分数。

常用命令：

```bash
jq '.careharness_rows' reports/medmemory-careharness-results.json
less reports/medmemory-careharness-results.md

curl -s http://127.0.0.1:8766/api/experiments/summaries | jq

CAREHARNESS_EXPERIMENT_ID="实验 ID"
curl -s "http://127.0.0.1:8766/api/experiments/${CAREHARNESS_EXPERIMENT_ID}/view" | jq
```

导出错题 JSON：

```bash
curl -sS \
  "http://127.0.0.1:8766/api/experiments/${CAREHARNESS_EXPERIMENT_ID}/wrong-answers/export" \
  -o careharness-wrong-answers.json
```

查看患者列表及指定患者的 Memory Graph：

```bash
curl -s http://127.0.0.1:8766/api/memory-graphs | jq

CAREHARNESS_SUBJECT_ID="患者 ID"
curl -s \
  "http://127.0.0.1:8766/api/memory-graphs/${CAREHARNESS_SUBJECT_ID}" | jq
```

查看三种 baseline 的进度和结果文件：

```bash
BASELINE_OUTPUT_ROOT="reports/official-baselines/qwen3.7-plus/random-seed-42"

".venv-medmemory-baselines/bin/python" \
  scripts/monitor-official-medmemory-baselines.py \
  --root "${BASELINE_OUTPUT_ROOT}" \
  --once

find "${BASELINE_OUTPUT_ROOT}" -name '*_result.json' -print
```
