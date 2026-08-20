# CareHarness Studio 运行说明

本说明只介绍如何运行 **MedMemoryBench · dev · Persona 1 · Clean · 97 题**，以及运行后在哪里查看结果。

## 1. 准备代码和 Node.js

```bash
git clone --branch feature/careharness-implementation git@github.com:Yangliduo-Lai/CareHarness.git
cd CareHarness
node --version
```

需要 Node.js `22.9` 或更高版本。项目使用 Node 内置模块，通常不需要执行 `npm install`。

## 2. 准备 MedMemoryBench 数据

数据集不会随 Git 仓库上传。请确认本地至少存在：

```text
<DATA_ROOT>/MedMemoryBench/data/MedMemoryBench/persona_1/eval/
  generated_dialogues.json
  generated_queries.json
```

可以用下面的命令检查路径：

```bash
test -f "<DATA_ROOT>/MedMemoryBench/data/MedMemoryBench/persona_1/eval/generated_dialogues.json"
test -f "<DATA_ROOT>/MedMemoryBench/data/MedMemoryBench/persona_1/eval/generated_queries.json"
```

复制环境变量模板：

```bash
cp .env.example .env
```

编辑 `.env`：

```dotenv
PORT=8766
CAREHARNESS_DATA_ROOT=<DATA_ROOT>
CAREHARNESS_DB_PATH=./data/careharness.sqlite
OPENAI_API_KEY=
CAREHARNESS_MATCHED_API_KEY=
```

不要把真实 API Key、`.env`、本地 SQLite 或 benchmark 数据提交到 Git。

## 3. 运行检查并启动服务

先运行核心测试和 smoke test：

```bash
npm run test:core
npm run smoke
```

`test:core` 不要求安装全部 benchmark 数据集。`smoke` 会跳过本地未安装的数据集。只有安装了全部 benchmark corpus 时才需要运行完整的 `npm test`。

启动服务：

```bash
npm start
```

浏览器打开：

<http://127.0.0.1:8766>

也可以检查后端是否正常：

```bash
curl http://127.0.0.1:8766/api/health
curl http://127.0.0.1:8766/api/catalog
```

## 4. 在前端配置模型

1. 打开 **模型与 Provider**。
2. 选择 Provider，填写模型名称和 API Key，Temperature 设置为 `0`。
3. 点击 **测试当前表单**。
4. 测试成功后点击 **保存连接**。
5. 在 **实际模型分配** 中确认以下组件已有可用连接：
   - Query Planner
   - Benchmark Answer（`judge`）
   - MedMemory Official Judge（`scoring_judge`）
   - Evidence Extractor（需要新建 Patient Graph 时使用）
   - State Router（需要新建 Patient Graph 时使用）
6. 点击 **保存并立即应用**。

正式 97 题运行不能使用 Offline Mock。前端输入的 Key 只保存在当前后端进程内存中，服务重启后需要重新填写并测试。

## 5. 在前端运行 Persona 1 / Clean / 97 题

打开左侧 **MedMemoryBench**，在 **CareHarness-first · Static CareHarness 运行控制台** 中使用以下配置：

| 选项 | 设置 |
| --- | --- |
| Dev Persona | `1` |
| Seed | `42` |
| Candidate budget | `24` |
| Action budget | `6` |
| 准备缺失/过期 Patient Graph snapshot | 勾选 |
| Clean | 勾选 |
| Noise | 不勾选 |

然后按顺序操作：

1. 点击 **仅预检（不调用模型）**。
2. 确认页面显示 `1 个 scope × 97 题`、Persona 1 / Clean，并且数据和模型状态都是 ready。
3. 点击 **启动 1 个 CareHarness 运行**。
4. 保持后端服务运行，等待全部步骤完成；运行中不要重启服务。

如果兼容的 Patient Graph 已存在，系统会跳过重复构建；缺失或过期时会先调用 Extractor 和 Router 构建。

## 6. 可选：使用 CLI 运行

CLI 会读取同一个 SQLite 中保存的模型 profile 和 assignments。第一次运行前，应先通过前端完成模型配置。

如果缺少 Patient Graph snapshot：

```bash
npm run medmemory:persona1 -- --prepare-snapshots
```

如果已经有完整兼容的 snapshot：

```bash
npm run medmemory:persona1
```

CLI 使用真实模型时，可在 `.env` 中配置 `CAREHARNESS_MATCHED_API_KEY`，或者使用各模型 profile 指定的环境变量。不要让 CLI 和前端服务同时写同一个 SQLite 数据库。

查看全部 CLI 参数：

```bash
npm run medmemory:matched -- --help
```

Persona 1 / Clean 运行不要添加 `--noise noise|both`。

## 7. 在前端查看结果

运行完成后，仍在 **MedMemoryBench** 页面查看：

- **CareHarness 运行结果**：查看 97 题总体分数、各题型分数、Suite ID、Experiment ID 和 manifest hash。
- **Failure taxonomy 聚合**：查看错误分类数量和最高频 harness failure。
- **打开 Experiment：逐题看 action / prompt / scorer**：进入完整的逐题结果。
- **查看答题/评分详情**：查看某一道题的系统答案、标准答案、得分、Query Planner、候选内容、Working State、Action trace、Answer Prompt、Official Judge Prompt 和模型原始输出。
- **Patient Graph Explorer**：查看该 Persona 的 Patient Graph、节点、Evidence、版本链和边。
- **Runs & Errors**：查看构建或模型调用失败的具体步骤、原始响应和校验错误。
- **一键导出错题与完整诊断**：导出错题 JSON。文件包含 benchmark 原文、Gold 和完整 trace，只能通过授权的私密渠道分享，不能提交 Git。

一个可回传的正式结果应满足：

- Suite 状态为 `completed`；
- 97/97 全部完成；
- Answer 和 Official Judge 都不是 Mock；
- 页面显示 Suite ID、Experiment ID 和 manifest hash；
- Judge infrastructure failure 数量被单独记录。

## 8. 查看 CLI 结果

CLI 成功后默认生成：

```text
reports/medmemory-careharness-results.json
reports/medmemory-careharness-results.md
```

两个文件包含总体分数、各题型分数、manifest 和 failure taxonomy 汇总。`reports/` 是本地生成结果，不要直接提交 Git。

CLI 只会把 `completed`、97/97、非 Mock、manifest 可复现的运行当作成功；partial 运行会以失败退出。

## 9. 常见运行问题

| 问题 | 处理方法 |
| --- | --- |
| MedMemoryBench 显示 unavailable | 检查 `CAREHARNESS_DATA_ROOT` 和两个 Persona 1 JSON 文件，修改 `.env` 后重启 |
| 预检提示 Offline Mock | 回到 **模型与 Provider**，保存并分配真实模型连接 |
| API Key missing | 服务重启后重新填写、测试并保存 Key；CLI 还需检查 `.env` |
| 缺少 Patient Graph | 勾选准备 snapshot，或在 CLI 使用 `--prepare-snapshots` |
| Action budget 报错 | 保持默认 `6`，不能低于 `3` |
| 没有完成 97/97 | 在 Experiment 和 **Runs & Errors** 检查 Answer/Judge 调用及 memory 状态 |
| `EADDRINUSE` | 关闭旧服务，或用 `PORT=9000 npm start` |
| SQLite busy/locked | 不要让多个 CareHarness 进程同时写同一个数据库 |
