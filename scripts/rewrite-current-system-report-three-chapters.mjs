#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sourcePath=resolve(process.argv[2]||'/Users/cqmrl/Desktop/medmemory-current-system-and-results.html');
const outputPath=resolve(process.argv[3]||'reports/medmemory-current-system-and-results-three-chapters.html');
const source=readFileSync(sourcePath,'utf8');

const architecture=sectionBody(source,'architecture');
const policy=sectionBody(source,'policy');
const results=sectionBody(source,'results');
const persona=sectionBody(source,'persona');
const medlocomo=sectionBody(source,'medlocomo');
const policyStrategyMarker='<h3>六类题型的公共策略合同</h3>';
const strategyIndex=policy.indexOf(policyStrategyMarker);
if(strategyIndex<0)throw new Error('MedMemoryBench strategy table marker was not found');

const originalFlow=requiredMatch(architecture,/<div class="flow">[\s\S]*?<\/div>\s*<\/div>/u,'shared architecture flow');
const sharedWorkerPolicy=requiredMatch(policy,/<div class="policy">[\s\S]*?<\/div>\s*<\/div>/u,'shared worker policy');
const medMemoryStrategy=policy.slice(strategyIndex);
const originalStyle=requiredMatch(source,/<style>([\s\S]*?)<\/style>/u,'style',1);

const html=`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CareHarness 总体实现与双基准结果</title>
  <style>
${originalStyle}
    .hero{background:linear-gradient(135deg,#10244f,#2355c8 62%,#2b7a78)}
    .chapter{scroll-margin-top:18px}
    .chapter-kicker{display:inline-flex;align-items:center;gap:8px;margin-bottom:9px;color:var(--blue);font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase}
    .chapter-kicker:before{content:"";width:24px;height:3px;border-radius:9px;background:var(--blue)}
    .chapter>h2{font-size:27px;margin-bottom:7px}
    .subsection{margin-top:26px;padding-top:2px}
    .subsection>h3{font-size:19px;margin:0 0 8px}
    .module-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:16px}
    .module{border:1px solid var(--line);border-radius:14px;padding:15px 16px;background:linear-gradient(180deg,#fbfdff,#f7f9fd)}
    .module code{display:inline-block;margin-bottom:6px;color:var(--blue);font-weight:700}
    .module b{display:block;margin-bottom:4px}.module p{margin:0;color:var(--muted);font-size:13px}
    .invariants{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:16px}
    .invariant{border-left:4px solid var(--green);background:var(--green-soft);border-radius:0 12px 12px 0;padding:13px 15px;color:#155c49}
    .preserved{border-left-color:var(--blue);background:var(--blue-soft);color:#1d438f}
    .chapter h4{font-size:16px;margin:22px 0 8px}
    .policy-cycle{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:15px 0}
    .cycle-step{position:relative;border:1px solid var(--line);border-radius:14px;padding:15px 15px 14px 46px;background:#fff}
    .cycle-step .step-no{position:absolute;left:14px;top:14px;display:grid;place-items:center;width:24px;height:24px;border-radius:50%;background:var(--blue);color:#fff;font-size:12px;font-weight:800}
    .cycle-step b{display:block;margin-bottom:4px}.cycle-step p{margin:0;color:var(--muted);font-size:13px}
    .state-strip{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:13px 0}
    .state-item{padding:11px 12px;border:1px solid var(--line);border-radius:11px;background:#f8faff;font-size:12px;color:var(--muted)}
    .state-item b{display:block;color:var(--ink);margin-bottom:3px}
    .decision-schema{margin:14px 0;border:1px solid #c9d7f5;border-radius:14px;overflow:hidden;background:#0d1b37;color:#dce8ff}
    .decision-schema .schema-title{padding:9px 13px;background:#183361;color:#fff;font-size:12px;font-weight:800;letter-spacing:.04em}
    .decision-schema pre{margin:0;padding:14px 16px;overflow:auto;font-size:12px;line-height:1.55;white-space:pre-wrap}
    .gate-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:13px 0}
    .gate{border-left:4px solid var(--blue);border-radius:0 11px 11px 0;padding:12px 14px;background:var(--blue-soft);font-size:13px}
    .gate b{display:block;color:#183b7a;margin-bottom:3px}.gate span{color:var(--muted)}
    .worker-effects{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:13px 0}
    .worker-effect{border:1px solid var(--line);border-radius:12px;padding:12px 14px;background:#fff;font-size:13px}
    .worker-effect code{color:var(--blue);font-weight:800}.worker-effect span{color:var(--muted)}
    .policy-callout{border:1px solid #bfe3d8;background:var(--green-soft);border-radius:13px;padding:14px 16px;margin:14px 0;color:#155c49}
    .policy-callout b{display:block;margin-bottom:4px}
    @media(max-width:900px){.module-grid,.policy-cycle{grid-template-columns:1fr 1fr}.state-strip{grid-template-columns:1fr 1fr}}
    @media(max-width:650px){.module-grid,.invariants,.policy-cycle,.state-strip,.gate-grid,.worker-effects{grid-template-columns:1fr}.chapter>h2{font-size:23px}}
  </style>
</head>
<body>
<main class="wrap">
  <header class="hero">
    <div class="eyebrow">CareHarness · System &amp; Benchmarks</div>
    <h1>CareHarness 总体实现与双基准结果</h1>
    <p>全文固定为三章：先说明共享的 Memory Graph 与动态调查框架，再分别说明 MedMemoryBench 和 MedLoCoMo 的专用实现、运行口径与实验分数。</p>
    <div class="meta"><span class="chip">三章结构</span><span class="chip">表格数值原样保留</span><span class="chip">不重算、不替换历史结果</span></div>
    <nav><a href="#chapter-overall">第一章 · 总体实现</a><a href="#chapter-medmemory">第二章 · MedMemoryBench</a><a href="#chapter-medlocomo">第三章 · MedLoCoMo</a></nav>
  </header>

  <section id="chapter-overall" class="chapter">
    <div class="chapter-kicker">Chapter 01</div>
    <h2>第一章 · 总体实现</h2>
    <p class="lead">CareHarness 的公共主线是“先形成可追溯的患者纵向图，再围绕问题逐步调查，最后冻结证据包并按 benchmark 官方协议评分”。两套 benchmark 共用这条主线，但各自拥有独立 Adapter、策略合同、检索增强和评分器。</p>
    ${originalFlow}

    <div class="subsection">
      <h3>1.1 共享模块</h3>
      <div class="module-grid">
        <article class="module"><code>SessionObservation</code><b>角色与时间边界</b><p>把 Patient、Doctor、结构化内容和日期保留在可审计的 Session/Turn 边界内，避免跨时间拼接来源。</p></article>
        <article class="module"><code>Pipeline</code><b>记忆构建流水线</b><p>依次完成预处理、Memory Node 提取、Family 标注、关系分类、图更新和提交；失败步骤保留结构化诊断。</p></article>
        <article class="module"><code>Store / Memory Graph</code><b>持久化纵向状态</b><p>节点、边、来源、版本和实验快照统一写入 SQLite；每条可用于回答的患者事实都能回到原始 observation。</p></article>
        <article class="module"><code>Question Request</code><b>问题信息边界</b><p>运行时只接收问题和公开任务控制信息；Gold、官方 Evidence 与 Judge metadata 不进入检索或回答链路。</p></article>
        <article class="module"><code>Investigation Runtime</code><b>闭环 Action Policy</b><p>Policy 根据当前 State 逐步选择 Worker，不在开始阶段硬编码完整检索计划；每步结果会改变下一步可见状态。</p></article>
        <article class="module"><code>Experiment Harness</code><b>冻结、评分与续跑</b><p>固定模型配置和 Memory Graph 指纹，逐题保存答案与评分；已完成结果可复用，未完成或失败问题可单独续跑。</p></article>
      </div>
    </div>

    <div class="subsection">
      <h3>1.2 Action 如何控制调查</h3>
      <p class="note">Policy 不是一个固定的“先 Search、再 Assess、最后 Answer”脚本，而是一个逐轮决策器。每一轮先由 Runtime 根据硬规则缩小可选动作，再由 Policy 在这些动作中选择一个 Worker，并为它生成本轮指令；Worker 改写 State 后，下一轮重新决策。</p>

      <h4>Policy 每轮实际能看到什么</h4>
      <p>Runtime 会构造一个只包含公开运行信息的 <code>PolicyView</code>。它让 Policy 知道当前已经查到了什么、还缺什么、还剩多少预算，以及本轮法律上允许调用哪些 Worker，但不会暴露 Gold、官方 Evidence、Judge 结论或未来 Session。</p>
      <div class="state-strip">
        <div class="state-item"><b>问题与公开路由</b>原始问题、预测题型、策略命名空间和公开 scope。</div>
        <div class="state-item"><b>Current Information</b>当前节点/边、最近 Session、Admission 概览、覆盖角色、调查焦点、时间 Gate、Assessment 与 Verification 状态。</div>
        <div class="state-item"><b>过程与预算</b>此前动作及结果摘要、最后一次 Worker 信号、剩余 turn 数；MedLoCoMo 仅带最近的必要步骤。</div>
        <div class="state-item"><b>动作边界</b>本轮 allowed_workers、每个 Worker 的能力和指令格式，以及“不得使用隐藏信息”的边界声明。</div>
      </div>

      <h4>Policy 必须返回什么</h4>
      <p>Policy 只返回一个结构化 Action。<code>worker</code> 决定下一步做什么，<code>information_status</code> 表示当前证据是否足够，<code>instruction</code> 是交给该 Worker 的参数；<code>investigation_focus</code> 用来持续记录目标、已覆盖角色、缺失角色、排除解释和停止条件。</p>
      <div class="decision-schema">
        <div class="schema-title">单轮决策结构（示意，不含任何患者答案）</div>
        <pre><code>{
  "version": "v1",
  "worker": "search | context | trace | assess | refine | verify | answer",
  "information_status": "unknown | insufficient | sufficient",
  "instruction": { "本 Worker 所需参数": "由当前问题与 State 生成" },
  "investigation_focus": {
    "target": "本题要确认的临床目标",
    "scope": "时间、Session 或 Admission 范围",
    "covered_roles": ["已经找到的证据角色"],
    "missing_roles": ["仍需补齐的证据角色"],
    "stop_condition": "什么证据出现后可以停止"
  },
  "rationale": "为什么此刻选择该动作"
}</code></pre>
      </div>

      <h4>一次完整调查循环</h4>
      <div class="policy-cycle">
        <article class="cycle-step"><span class="step-no">1</span><b>初始化 State</b><p>从问题、公开任务配置、Profile/Admission 概览和允许直接可见的近期上下文创建起始状态。</p></article>
        <article class="cycle-step"><span class="step-no">2</span><b>计算 Allowed Workers</b><p>Runtime 先应用时间、预算、证据新鲜度、无进展次数和题型合同等硬 Gate，得到本轮动作集合。</p></article>
        <article class="cycle-step"><span class="step-no">3</span><b>Policy 选一个 Action</b><p>模型只能从动作集合中选择一个 Worker，并结合当前缺口产生定向 instruction，不能自行越过 Gate。</p></article>
        <article class="cycle-step"><span class="step-no">4</span><b>校验或安全回退</b><p>Runtime 校验 JSON schema、Worker 是否获准及参数是否合法；格式错误、越权或重复无效搜索会改走确定性 fallback。</p></article>
        <article class="cycle-step"><span class="step-no">5</span><b>执行并改写 State</b><p>Worker 只通过公开接口增补、筛选或核验证据；系统记录 packet 是否变化，以及 Assessment/Verification 是否仍然新鲜。</p></article>
        <article class="cycle-step"><span class="step-no">6</span><b>重算或结束</b><p>若尚未满足停止条件，就用新 State 进入下一轮；只有 Answer/terminal 动作或预算边界触发时才冻结当前证据包。</p></article>
      </div>

      <h4>硬 Gate 怎样限制动作选择</h4>
      <div class="gate-grid">
        <div class="gate"><b>空证据 Gate</b><span>尚无可用信息时优先开放 Search；Policy 不能在没有证据的情况下直接把主观推断当作答案。</span></div>
        <div class="gate"><b>时间 Gate</b><span>问题出现明确日期或相对日期时，先形成检索上下界；明显早于目标时点的记录不进入候选，命中邻近时间证据后可停止继续扩张。</span></div>
        <div class="gate"><b>证据变更 Gate</b><span>Search、Context、Trace 或 Refine 改变证据包后，旧 Assessment/Verification 立即视为过期，必须基于新包重做必要检查。</span></div>
        <div class="gate"><b>容量 Gate</b><span>候选过多、角色混杂或语义选择尚未完成时，优先开放 Assess/Refine，把宽候选压缩成可回答的来源集合。</span></div>
        <div class="gate"><b>无进展 Gate</b><span>连续发现动作没有新增有效信息时，不再允许反复 Search；系统转向 Verify，或在现有证据边界内 Answer/拒答。</span></div>
        <div class="gate"><b>预算 Gate</b><span>剩余轮数会影响动作集合。接近终点时必须为 Assessment、Verification 和 Answer 留出闭环空间，最后一轮只能处理现有证据。</span></div>
      </div>

      <h4>每个 Worker 如何改变 State</h4>
      ${sharedWorkerPolicy}
      <div class="worker-effects">
        <div class="worker-effect"><code>Search</code>：<span>按实体、同义词、数值、日期、Family 或 Admission 范围取回候选节点；只增加候选，不宣布答案正确。</span></div>
        <div class="worker-effect"><code>Context</code>：<span>围绕已命中的来源补同一 Session/Turn 邻域，恢复指代、问答配对、否定和局部时间语境。</span></div>
        <div class="worker-effect"><code>Trace</code>：<span>沿 Memory Graph 的显式边补充相关节点与路径，路径中的每一步仍保留原始 provenance。</span></div>
        <div class="worker-effect"><code>Assess</code>：<span>判断覆盖是否足够、角色是否齐全，并更新 investigation_focus；它产生选择判断，不创造新的患者事实。</span></div>
        <div class="worker-effect"><code>Refine</code>：<span>只从已有候选中保留与目标相关的节点，并可固化时间/范围边界；除非明确不可能相关，否则不应激进删除。</span></div>
        <div class="worker-effect"><code>Verify</code>：<span>检查每项候选是否有可见来源、证据包是否超限、是否仍有冲突；验证结果与当时的 packet 版本绑定。</span></div>
        <div class="worker-effect"><code>Answer</code>：<span>冻结最终选择并生成回答输入。Answer 不再检索，也不能把 Policy rationale 或 Assessor 副产物冒充病历证据。</span></div>
      </div>

      <h4>何时真正允许停止</h4>
      <p>基础终止条件是 Policy 选择 <code>answer</code>、Worker 返回 terminal，或轮数预算到达边界。运行记录会保存最终 packet、最后一次改写位置、Assessment/Verification 新鲜度、停止原因和逐轮 trace。对要求更严格的 MedLoCoMo 正式评测，答案就绪还要求：证据包已经冻结，最后一次证据变更之后完成了语义 Assessment，并且基于同一版本完成来源 Verification；任一条件不满足都会形成 blocker，而不是假装证据充分。</p>
      <div class="policy-callout"><b>Policy 控制的是“下一步动作”，不是“预先写好的答案”。</b>题型 profile 和 preferred path 只是条件式提示；具体检索词、日期范围、缺失证据角色和停止点都由当前问题与运行 State 生成。Action 不合法时由 Runtime 拦截，因此即使 Foundation Model 偶尔输出坏 JSON 或选择越权动作，也不会直接突破信息边界。</div>
    </div>

    <div class="subsection">
      <h3>1.3 公共安全与可复现约束</h3>
      <div class="invariants">
        <div class="invariant"><b>来源约束</b><br>患者特异事实必须绑定原始来源；通用医学知识只能作为显式临床桥，不能伪造成病历事实。</div>
        <div class="invariant"><b>时间约束</b><br>问题中的明确日期可形成硬 Gate；Refine 确认的时间边界会持续约束后续 Search、Context 与 Trace。</div>
        <div class="invariant"><b>信息隔离</b><br>Gold、Evidence 标注和 Judge 内容只允许在答案冻结后的评分与离线诊断阶段出现。</div>
        <div class="invariant"><b>实验隔离</b><br>每次实验保存模型、Prompt、策略、图指纹和逐题 trace；不把运行中断点混充为完整结果。</div>
      </div>
    </div>
  </section>

  <section id="chapter-medmemory" class="chapter">
    <div class="chapter-kicker">Chapter 02</div>
    <h2>第二章 · MedMemoryBench：专用实现与分数</h2>
    <p class="lead">MedMemoryBench 按 Persona 和 Session 组织长期患者记录，覆盖实体、时间、状态、多选、个体化推理和多跳临床推理。该章只集中呈现这套 benchmark 的专用模块与原报告分数。</p>

    <div class="subsection">
      <h3>2.1 专用模块</h3>
      <div class="module-grid">
        <article class="module"><code>MedMemoryAdapter</code><b>Persona / Session 装载</b><p>按 Clean/Noise 命名空间读取完整 Session，保持 Patient/Doctor 原文，并为不同 Session 范围生成可复用图快照。</p></article>
        <article class="module"><code>Patient Profile + Recent Sessions</code><b>医生式起始视图</b><p>提供 query-independent Profile 与最近 Session 原文；较旧信息进入历史检索池，减少近期事实被 top-k 挤出。</p></article>
        <article class="module"><code>MedMemory Query Classifier</code><b>题型路由</b><p>分类器只读问题文本；预测题型选择检索策略，官方题型继续控制最终 Answer Prompt 和 metric。</p></article>
        <article class="module"><code>BGE Retrieval</code><b>混合历史检索</b><p>把字面词、同义词、数值、Family、角色、日期范围与本地 embedding 组合，并执行确定性时间 Gate。</p></article>
        <article class="module"><code>MQ / SUA Specialization</code><b>选项与状态处理</b><p>MQ 对选项分别调查后合并；SUA 只把最终选中的来源 State 交给回答器，不附带 Assessor 的其他副产物。</p></article>
        <article class="module"><code>IG / MCD Contracts</code><b>推理与链式评分</b><p>IG 构建患者特异决策链；MCD 区分来源事实与通用医学桥，并由官方 NCR、CRC、CC 和 Judge 共同评价。</p></article>
      </div>
    </div>

    <div class="subsection">
      <h3>2.2 MedMemoryBench 中如何套用 Policy</h3>
      <p>MedMemoryBench 在公共 Policy 上增加“题型合同”，但不把官方答案写进策略。执行顺序是：只读问题文本的分类器预测 EEM/TLA/SUA/MQ/IG/MCD；Runtime 据此挂载公开 strategy profile；Policy 从 Patient Profile、允许可见的近期 Session 和历史图候选开始调查；最后仍由官方题型决定 Answer Prompt 与评分 metric。也就是说，预测题型影响怎样找证据，不会改写题目的官方评价口径。</p>
      <div class="policy-cycle">
        <article class="cycle-step"><span class="step-no">1</span><b>问题级路由</b><p>提取实体、日期、相对时间、选项和推理目标，选择一种公开策略；分类器看不到 Gold 与 Judge。</p></article>
        <article class="cycle-step"><span class="step-no">2</span><b>建立起始视图</b><p>Profile 提供稳定纵向背景，Recent Sessions 提供合法近期原文；更早记录必须经 Search/Trace 主动取回。</p></article>
        <article class="cycle-step"><span class="step-no">3</span><b>执行题型合同</b><p>Policy 依据目标角色与 stop condition 循环调用 Worker；证据足够就停止，缺口明确才继续扩张。</p></article>
      </div>
      <div class="gate-grid">
        <div class="gate"><b>EEM</b><span>围绕精确实体、属性和值搜索；找到有来源的直接回答后即可停止，避免把无关长期史带入答案。</span></div>
        <div class="gate"><b>TLA</b><span>把事件锚点、相对日期和永久边界转成硬时间 Gate。先查目标日期附近，再按需扩大，不让其他月份的高相似结果占满候选。</span></div>
        <div class="gate"><b>SUA</b><span>区分历史 baseline、当前更新和最终状态；Refine 仅剔除明确时间不符或确定无关的 State，回答器只接收最终来源 State。</span></div>
        <div class="gate"><b>MQ</b><span>每个选项拥有独立的支持/反对/缺失证据格，分别调查后再合并；某一选项命中不能替代其他选项的核验。</span></div>
        <div class="gate"><b>IG</b><span>按诊断/轨迹、既往暴露、治疗反应、约束和患者偏好补齐决策链；信息角色齐全即停，而不是无限延伸医学解释。</span></div>
        <div class="gate"><b>MCD</b><span>先固定有日期和来源的两端事实及显式关系；病历缺少中间关系时，才允许把通用医学知识作为显式标注的 bridge。</span></div>
      </div>
      <div class="policy-callout"><b>时间问题的具体例子</b>若问题问“2024-01-15 次日测得的空腹血糖”，Policy 会把目标锚定在 2024-01-16：早于该日期的候选由硬 Gate 排除，Search 同时使用“空腹血糖、FBG”等词并优先覆盖紧邻日期；一旦出现来源明确且符合目标窗口的值，就进入 Assess/Verify，而不是继续让其他月份的结果填满 top-k。</div>
    </div>

    <div class="subsection">
      <h3>2.3 六类题型的调查合同</h3>
      ${demoteHeadings(medMemoryStrategy)}
    </div>

    <div class="subsection">
      <h3>2.4 总体成绩与运行效率</h3>
      ${demoteHeadings(stripFirstH2(results))}
    </div>

    <div class="subsection">
      <h3>2.5 Persona 明细与题型路由诊断</h3>
      ${demoteHeadings(stripFirstH2(persona))}
    </div>
  </section>

  <section id="chapter-medlocomo" class="chapter">
    <div class="chapter-kicker">Chapter 03</div>
    <h2>第三章 · MedLoCoMo：专用实现与分数</h2>
    <p class="lead">MedLoCoMo 以真实住院 Admission 为纵向边界，既包含单次住院问题，也包含跨住院比较、进展和频率问题；Adversarial 题则要求在证据不足时可靠拒答。</p>

    <div class="subsection">
      <h3>3.1 专用模块</h3>
      <div class="module-grid">
        <article class="module"><code>MedLoCoMoAdapter</code><b>Admission 可见边界</b><p>只使用 combined conversation 中可见的 Patient/Doctor Turn 建图；患者摘要、Admission 摘要和官方 Evidence 不进入正式运行输入。</p></article>
        <article class="module"><code>Literal Turn Coverage</code><b>完整原文补强</b><p>语义节点之外保留逐 Turn 的 literal provenance，使药名、数值、否定和角色原话能够被再次检索与核验。</p></article>
        <article class="module"><code>Admission Overview</code><b>跨住院导航</b><p>建立 Admission 概览、角色覆盖和 Evidence Ledger，帮助 Policy 先定位住院范围，再选择对应 Turn。</p></article>
        <article class="module"><code>MiniLM + Pairwise Ranker</code><b>层级检索</b><p>先对 Admission 排序，再在 Admission 内选择 Turn，并与字面检索、时间和来源约束共同形成候选集。</p></article>
        <article class="module"><code>Distilled Typed Policy</code><b>MedLoCoMo 独立策略</b><p>五类可回答问题使用独立的证据合同与停止条件；策略 artifact 不保留患者、题目、答案或 Evidence 文本。</p></article>
        <article class="module"><code>Answerability Guard</code><b>答案面控制</b><p>回答冻结后检查候选是否被当前来源支持；Adversarial 题使用规范拒答，其他题再交给官方 answerable Judge。</p></article>
      </div>
    </div>

    <div class="subsection">
      <h3>3.2 MedLoCoMo 中如何套用 Policy</h3>
      <p>MedLoCoMo 复用同一个逐轮 Action 机制，但把调查单位换成 Admission 与 Turn，并使用独立的 typed strategy。Policy 先决定需要覆盖哪些 Admission 和证据角色，再在 Admission 内选择具体 Turn；候选包每次变化都会让旧的语义判断和来源核验失效，因此正式回答必须在最后一次改写之后重新闭环。</p>
      <div class="policy-cycle">
        <article class="cycle-step"><span class="step-no">1</span><b>确定调查形态</b><p>从问题区分单次事件/原因、治疗计划、纵向进展、跨住院比较、频率统计或 adversarial 核验。</p></article>
        <article class="cycle-step"><span class="step-no">2</span><b>Admission → Turn</b><p>先用 Admission Overview 选择住院范围，再用字面检索与语义 ranker 找到具体 Patient/Doctor Turn。</p></article>
        <article class="cycle-step"><span class="step-no">3</span><b>冻结并闭环</b><p>Refine 后冻结证据包，依次确认语义覆盖和来源支持；只有同一 packet 同时通过才进入 Answer。</p></article>
      </div>
      <div class="gate-grid">
        <div class="gate"><b>Medical reasoning / Care plan</b><span>要求同一 Admission 内同时找到事件或干预及其解释/理由，不能用另一住院的相似信息拼成因果链。</span></div>
        <div class="gate"><b>Longitudinal progression</b><span>必须保留至少两个时间分离的端点，并明确变化方向；只命中其中一次记录时 information_status 仍为 insufficient。</span></div>
        <div class="gate"><b>Cross-admission comparison</b><span>两侧 Admission 必须都被覆盖，并在同一比较轴上对齐；任一侧缺失时不能直接 Verify/Answer。</span></div>
        <div class="gate"><b>Frequency pattern</b><span>先开放全历史 Search，再按 Admission/事件形成 ledger 并去重；局部 top-k 不能直接代表全程频次。</span></div>
        <div class="gate"><b>Adversarial</b><span>先核验问题中的直接主张；若可见来源仍不支持，就走规范拒答，而不是用常识补出患者特异事实。</span></div>
        <div class="gate"><b>末段预算保护</b><span>接近 turn 上限时，Runtime 为 Assess → Verify → Answer 保留动作；若 assessor 预算耗尽，则只核验并封闭现有 packet。</span></div>
      </div>
      <div class="policy-callout"><b>Distilled Typed Policy 的边界</b>它只保存跨训练样例聚合出的、与具体病例无关的题型先验，例如“比较题要覆盖两侧”“频率题要做全历史 ledger”。其中不保存患者文本、原问题、Gold、官方 Evidence 或可反查个案的答案，因此它提供的是调查方法，不是检索答案的旁路。</div>
    </div>

    <div class="subsection">
      <h3>3.3 实验分数</h3>
      <div class="warning preserved">本章以下所有表格均从原 HTML 原样迁移；Patient、题数、F1、J、Acc、Overall Score、论文参照和 Token 数值均未重算或替换。</div>
      ${demoteHeadings(stripFirstH2(medlocomo))}
    </div>
  </section>

  <footer>CareHarness · 三章结构重写版 · 所有原表格数值保持不变</footer>
</main>
</body>
</html>
`;

const sourceTables=tables(source),outputTables=tables(html);
if(sourceTables.length!==outputTables.length)throw new Error(`Table count changed: source=${sourceTables.length}, output=${outputTables.length}`);
for(let index=0;index<sourceTables.length;index++){
  if(sourceTables[index]!==outputTables[index])throw new Error(`Table ${index+1} changed during structural rewrite`);
}
const chapterCount=(html.match(/<section id="chapter-[^"]+" class="chapter">/gu)||[]).length;
if(chapterCount!==3)throw new Error(`Expected exactly three chapters, found ${chapterCount}`);

writeFileSync(outputPath,html,'utf8');
process.stdout.write(`${JSON.stringify({source:sourcePath,output:outputPath,chapters:chapterCount,tables:outputTables.length,tables_byte_identical:true},null,2)}\n`);

function sectionBody(text,id){
  const match=new RegExp(`<section id="${id}">([\\s\\S]*?)<\\/section>`,'u').exec(text);
  if(!match)throw new Error(`Section ${id} was not found`);
  return match[1];
}
function stripFirstH2(value){return value.replace(/\s*<h2>[\s\S]*?<\/h2>\s*/u,'\n');}
function demoteHeadings(value){return value.replaceAll('<h3>','<h4>').replaceAll('</h3>','</h4>');}
function requiredMatch(text,pattern,label,group=0){const match=pattern.exec(text);if(!match)throw new Error(`${label} was not found`);return match[group];}
function tables(text){return[...text.matchAll(/<table>[\s\S]*?<\/table>/gu)].map(match=>match[0]);}
