import { STATE_FAMILIES } from './schema.js';

const ROUTER_TAXONOMY=JSON.stringify({families:STATE_FAMILIES});

/**
 * 来源：MedMemoryBench 官方附录的 Shared System Prompt。
 * 任务：作为 EEM、TLA、SUA、MQ、IG、MCD 六类 Answer Prompt 的统一 system message。
 */
export const MEDMEMORY_SHARED_SYSTEM_PROMPT=`You are the patient’s personalized medical assistant, capable of accurately memorizing the patient’s complete medical history. Please reason and respond based on patient information in memory, maintain a warm yet professional tone, answer directly, and avoid unnecessarily long explanations.`;

/**
 * 来源：MedMemoryBench 官方附录的分题型 Answer Prompts。
 * 任务：在答案生成阶段，将冻结的 memory_source 与原始 question 填入对应题型模板。
 */
export const MEDMEMORY_ANSWER_PROMPT_TEMPLATES=Object.freeze({
  // 来源：MedMemoryBench EEM Answer Prompt；任务：实体精确记忆（Entity Exact Match）。
  entity_exact_match:`Context: Based on <memory_source>, accurately answer the following question.
Question: <question>
Answer Requirements: 1. Provide the target entity name directly. 2. Keep the answer brief and precise. 3. Do not include lengthy explanations.
Answer:`,
  // 来源：MedMemoryBench TLA Answer Prompt；任务：时间点或指定时间事件定位。
  temporal_localization:`Context: Based on <memory_source>, accurately answer the following question.
Question: <question>
Answer Requirements: 1. If the question asks about a time, answer in YYYY-MM-DD format (e.g., 2024-01-15). 2. If the question asks about an event at a specific time, clearly describe the event content and key details. 3. Keep the answer concise and directly grounded in memory.
Answer:`,
  // 来源：MedMemoryBench SUA Answer Prompt；任务：回答患者最新状态及必要的纵向变化。
  state_update:`Context: Based on <memory_source>, accurately answer the following question.
Question: <question>
Answer Requirements: 1. Describe the patient’s most recent status. 2. Reflect important changes over time when necessary. 3. Maintain a warm yet professional tone. 4. Be concise and direct.
Answer:`,
  // 来源：MedMemoryBench MQ Answer Prompt；任务：多项选择，仅输出选项字母。
  multiple_choice:`Context: Based on <memory_source>, and considering the patient’s allergy history, medical history, medications, and personal preferences, answer the following question.
Question: <question>
Answer Requirements:
1. Select all correct options. 2. Output only the option letter(s), such as B or B,D. 3. Do not provide any explanation.
Answer:`,
  // 来源：MedMemoryBench IG Answer Prompt；任务：基于患者特异记忆做个体化推断。
  inference_generation:`Context: Based on <memory_source>, and considering the patient’s allergy history, medical history, medications, and personal preferences, answer the following question.
Question: <question>
Answer Requirements: 1. Reason from this patient’s specific remembered information; do not give generic medical advice. 2. Maintain a warm yet professional tone. 3. Be concise, direct, and avoid boilerplate. 4. If recommending or advising against something, briefly explain the reason based on the patient’s specific situation.
Answer:`,
  // 来源：MedMemoryBench MCD Answer Prompt；任务：跨多次就诊进行多跳临床推理。
  multi_hop_clinical_deduction:`Context: Based on <memory_source>, carefully review the patient’s complete medical history and conduct a comprehensive analysis by combining information from multiple visits.
Question: <question>
Answer Requirements: 1. Clearly list the memory content you draw upon. 2. Present a clear reasoning path from evidence to conclusions. 3. Provide a final comprehensive judgment.
Answer:`
});

/**
 * 来源：MedMemoryBench 官方附录 Answer Prompts 的机器可读合同。
 * 任务：供 adapter/runtime 选择语言、grounding 与输出格式；不是额外的模型提示词副本。
 */
export const MEDMEMORY_APPENDIX_ANSWER_CONTRACTS=Object.freeze({
  default:Object.freeze({language:'match the question language',grounding:'Use only the supplied memory_source. Gold answers, answer explanations, source key points, and Judge metadata are unavailable during answer generation.',format:'Follow the MedMemoryBench appendix Answer Prompt for the selected task.'}),
  entity_exact_match:Object.freeze({format:'Provide the target entity name directly. Keep the answer brief and precise. Do not include lengthy explanations.'}),
  temporal_localization:Object.freeze({format:'If the question asks about a time, answer in YYYY-MM-DD format. If it asks about an event at a specific time, clearly describe the event content and key details. Keep the answer concise and directly grounded in memory.'}),
  state_update:Object.freeze({format:'Describe the patient’s most recent status. Reflect important changes over time when necessary. Maintain a warm yet professional tone. Be concise and direct.'}),
  multiple_choice:Object.freeze({format:'Select all correct options. Output only the option letter(s), such as B or B,D. Do not provide any explanation.'}),
  inference_generation:Object.freeze({format:'Reason from this patient’s specific remembered information; do not give generic medical advice. Maintain a warm yet professional tone. Be concise, direct, and avoid boilerplate. Briefly explain recommendations from the patient’s specific situation.'}),
  multi_hop_clinical_deduction:Object.freeze({format:'Clearly list the memory content used. Present a clear reasoning path from evidence to conclusions. Provide a final comprehensive judgment.'})
});

// 来源：各 benchmark 的任务协议或当前公开数据边界。
// 任务：统一登记所有 benchmark 的 Answer Model 输出合同；adapter 只能按 benchmark + task 选择，
// 不得自行保存另一份 model-facing prompt 文本。
export const BENCHMARK_ANSWER_PROMPTS=Object.freeze({
  // 来源：CareHarness 通用兜底合同；任务：未登记 benchmark/task 的安全直接回答。
  default:Object.freeze({
    default:Object.freeze({
      language:'match the question language',
      grounding:'Use only the supplied State, Evidence, and visible benchmark protocol context. Never use Gold answers or hidden evaluator references.',
      format:'Answer the question directly and concisely, covering every necessary point without adding unsupported facts.'
    })
  }),
  // 来源：MedMemoryBench 官方附录；任务：EEM/TLA/SUA/MQ/IG/MCD 回答格式与 grounding。
  medmemorybench:MEDMEMORY_APPENDIX_ANSWER_CONTRACTS,
  // 来源：MedLoCoMo 公开 QA 协议的机器可读适配（非论文逐字 Answer Prompt）；
  // 任务：answerable/adversarial 及各纵向问答类型共用公开的短答案边界。
  medlocomo:Object.freeze({
    default:Object.freeze({
      language:'en',
      grounding:'Use only the supplied memory_source. Gold answers, hidden benchmark evidence annotations, and inspection-only summaries are unavailable during answer generation.',
      format:'Return only a short open English answer, preferably 1 to 7 words and never more than 10 words. When possible, use exact wording from memory_source; otherwise use only light normalization. Do not explain, add a label, or return JSON.'
    }),
    // 任务：识别病历无法支持的问题并返回官方 abstention 短语。
    adversarial:Object.freeze({format:'If the requested information is unsupported by memory_source, return exactly: the question is not answerable'}),
    longitudinal_progression:Object.freeze({format:'Return only a short open English answer, preferably 1 to 7 words and never more than 10 words.'}),
    care_plan_rationale:Object.freeze({format:'Return only a short open English answer, preferably 1 to 7 words and never more than 10 words.'}),
    cross_admission_comparison:Object.freeze({format:'Return only a short open English answer, preferably 1 to 7 words and never more than 10 words.'}),
    medical_reasoning:Object.freeze({format:'Return only a short open English answer, preferably 1 to 7 words and never more than 10 words.'}),
    frequency_pattern:Object.freeze({format:'Return only a short open English answer, preferably 1 to 7 words and never more than 10 words.'})
  }),
  // 来源：CPCD-Bench 官方 SR/MR/TCR 协议；任务：咨询回复、长期记忆回忆、时序—因果推理。
  cpcdbench:Object.freeze({
    default:Object.freeze({
      language:'zh-CN',
      grounding:'只能使用官方 input_to_model 和检索到的 State/Evidence。不得使用 reference_answer、evaluation_focus 或评分理由；这些内容只在答案冻结后提供给评分 Judge。',
      format:'直接用中文完成题目，不输出分析标题、评分或 JSON。'
    }),
    // 任务：SR，会话级咨询回复生成。
    session_level_response_generation:Object.freeze({format:'只输出咨询师下一轮回复，保持温和、真诚、专业且有风险敏感性；优先深层共情并承接长期轨迹，避免说教、保证或越界替学生做决定。建议 1–2 段，可用一个开放式问题收束。'}),
    // 任务：MR，长期事实记忆回忆。
    memory_recall:Object.freeze({format:'准确、完整地回答事实回忆问题，保留题目要求的时间、人物、地点、事件、数值和状态，不添加记录中不存在的信息。'}),
    // 任务：TCR，按时间组织因果/维持因素链。
    temporal_causal_reasoning:Object.freeze({format:'按时间顺序说明关键事件，并明确连接诱因、放大因素、维持因素和结果；覆盖必要节点，不编造咨询历史之外的信息。'})
  }),
});

export function benchmarkAnswerContract(benchmark,task){
  const common=BENCHMARK_ANSWER_PROMPTS.default.default,group=BENCHMARK_ANSWER_PROMPTS[String(benchmark||'').toLowerCase()]||BENCHMARK_ANSWER_PROMPTS.default,specific=group[String(task||'')]||group.default||{};
  return{...common,...(group.default||{}),...specific};
}

// 来源：CareHarness Static runtime；任务：在 benchmark Answer 合同上追加运行时 Evidence/Gold 隔离约束。
export function careHarnessAnswerContract(contract,mode){
  if(!mode)return contract||null;
  return{...(contract||{}),grounding:'Use only the supplied CareHarness memory_source. Gold answers, Judge reasons, hidden Persona information, and source key points are unavailable during answer generation.'};
}

/**
 * 来源：CareHarness 核心对话运行时，不属于任何 benchmark。
 * 任务：把 Conversation Action Policy 的 ANSWER/ASK/VERIFY/ESCALATE 决定转换为 Generator/Auditor 约束。
 */
export const COMMUNICATION_ACTION_REQUIREMENTS=Object.freeze({
  // 任务：证据充分时直接回应当前患者。
  ANSWER:Object.freeze({
    explanation:'Answer from the current message and the current memory maintained by each State family.',
    required_content:Object.freeze(['回应当前患者信息，并仅使用可追溯记忆'])
  }),
  // 任务：当前患者陈述有显式不确定性时提出澄清问题。
  ASK:Object.freeze({
    explanation:'The current Patient message is explicitly uncertain, so clarification is required.',
    required_content:Object.freeze(['提出一个澄清问题'])
  }),
  // 任务：跨来源 State 冲突未解决时要求核实。
  VERIFY:Object.freeze({
    explanation:'A State family has an unresolved cross-source conflict that must be verified.',
    required_content:Object.freeze(['说明需要核对的冲突信息'])
  }),
  // 任务：当前消息包含安全披露时给出升级支持与即时安全询问。
  ESCALATE:Object.freeze({
    explanation:'The current Patient message contains a safety disclosure, so the Action Policy escalates.',
    required_content:Object.freeze(['明确建议立即联系当地急救/危机支持或可信任的人','直接询问当前安全、计划与手段可及性'])
  })
});

// 来源：CareHarness 核心安全合同；任务：所有 Conversation Action 共用的禁止内容。
export const COMMUNICATION_FORBIDDEN_CONTENT=Object.freeze(['编造诊断','泄露密钥']);

export function communicationActionRequirements(action,{rememberedRisk=false,currentRisk=false}={}){
  const type=String(action||'').toUpperCase(),requirements=COMMUNICATION_ACTION_REQUIREMENTS[type];
  if(!requirements)throw new Error(`No communication requirements for action ${action||'unknown action'}`);
  return{
    explanation:requirements.explanation,
    required_content:[...requirements.required_content],
    forbidden_content:[...COMMUNICATION_FORBIDDEN_CONTENT,...(rememberedRisk&&!currentRisk?['把历史风险直接说成当前风险']:[])]
  };
}

// 来源：MedMemoryBench 官方附录；任务：渲染六类 Answer user prompt 中的 memory_source 和 question。
export function renderMedMemoryAnswerPrompt(input={}){
  const template=MEDMEMORY_ANSWER_PROMPT_TEMPLATES[input.task];
  if(!template)throw new Error(`No MedMemoryBench appendix Answer Prompt for ${input.task||'unknown task'}`);
  const memorySource=compactMedMemorySource(input);
  return template.replace('<memory_source>',JSON.stringify(memorySource)).replace('<question>',String(input.question||''));
}

// The runtime objects contain audit-only duplicates (full verifier payloads,
// graph metadata, and repeated State/Evidence copies). The Answer Model only
// needs the grounded claims, their time/provenance, and verified relations.
// Keeping this projection small reduces latency and prevents audit structure
// from competing with the actual medical facts for model attention.
export function compactMedMemorySource(input={}){
  const states=(input.retrieved_states||[]).map(item=>pick(item,['state_id','family','value','event_time','episode_id','status','version','operation','evidence_ids']));
  const evidence=(input.retrieved_evidence||[]).map(item=>pick(item,['evidence_id','text','event_time','episode_id','source_session_id','source_type','polarity','certainty']));
  const evidenceChains=(input.retrieved_evidence_chains||[]).map(chain=>({chain_id:chain.chain_id||null,purpose:chain.purpose||null,covered_facets:chain.covered_facets||[],nodes:(chain.nodes||[]).map(node=>pick(node,['state_id','role','facets']))}));
  const working=input.working_state||null,verification=working?.evidence?.verification||null,proof=input.evidence_proof||working?.evidence?.proof||null;
  return{
    states,evidence,evidence_chains:evidenceChains,
    working_state:working?{route:working.route||[],temporal_operator:working.temporal?.operator||working.control_decisions?.time?.operator||'none',state_ids:working.state_ids||[],session_anchors:(working.session_anchors||[]).map(anchor=>pick(anchor,['episode_id','event_time','score','matched_keywords','matched_aliases','matched_numeric_values','evidence_ids'])),safe_to_answer:verification?.safe_to_answer??null}:null,
    verified_relations:(input.query_time_relations||[]).map(item=>pick(item,['from_state_id','to_state_id','type','event_time','relation_quote','evidence_ids'])),
    evidence_proof:proof?pick(proof,['verdict','complete','covered_families','missing_families','path_complete']):null,
    action_policy:input.harness_action_policy?pick(input.harness_action_policy,['version','selected_actions','candidate_budget']):null
  };
}

function pick(value,keys){const out={};for(const key of keys)if(value?.[key]!=null)out[key]=value[key];return out;}

// 来源：MedMemoryBench 官方附录；任务：组装 Shared System Prompt + 分题型 Answer user prompt。
export function medMemoryAnswerMessages(input={}){
  return[{role:'system',content:MEDMEMORY_SHARED_SYSTEM_PROMPT},{role:'user',content:renderMedMemoryAnswerPrompt(input)}];
}

/**
 * 来源：MedLoCoMo 公开 QA 协议（health_benchmark/scripts/qa_prompting.py 与
 * qa_validation.py）所规定的短答案边界。论文没有发布可逐字复用的 Answer
 * Model prompt，因此这是 protocol-derived CareHarness 适配，不是论文原文。
 * 任务：只从 inference-time memory_source 回答；保持官方的短答案上限、
 * 尽量复用记录原词，以及 adversarial 固定拒答短语。
 */
export const MEDLOCOMO_PROTOCOL_DERIVED_ANSWER_SYSTEM_PROMPT=`You answer MedLoCoMo short-answer medical benchmark questions using only the supplied memory source.
Return only one short open answer in English, preferably 1 to 7 words and never more than 10 words.
When possible, use exact wording from the memory source; otherwise use only light normalization.
If the requested information is not supported by the memory source, return exactly: the question is not answerable
Do not use outside knowledge to invent facts. Do not explain, restate the question, add a label, or return JSON.`;

// 来源：上述 MedLoCoMo protocol-derived Answer 适配；任务：只序列化可见记忆和原始问题。
export function renderMedLoCoMoAnswerPrompt(input={}){
  const memorySource={
    states:chronologicalMedLoCoMoMemories(input.retrieved_states||[]),
    evidence:chronologicalMedLoCoMoMemories(input.retrieved_evidence||[]),
    evidence_chains:input.retrieved_evidence_chains||[],
    working_state:input.working_state||null,
    verified_relations:input.query_time_relations||[],
    evidence_proof:input.evidence_proof||null,
    action_policy:input.harness_action_policy||null
  };
  return`Memory source:\n${JSON.stringify(memorySource)}\n\nQuestion: ${String(input.question||'')}\nAnswer:`;
}

// 来源：上述 MedLoCoMo protocol-derived Answer 适配；任务：组装纯文本 Answer system/user messages。
export function medLoCoMoAnswerMessages(input={}){
  return[{role:'system',content:MEDLOCOMO_PROTOCOL_DERIVED_ANSWER_SYSTEM_PROMPT},{role:'user',content:renderMedLoCoMoAnswerPrompt(input)}];
}

// MedLoCoMo Appendix B.4 orders selected memories by visible timestamp. Selection/budgeting
// remains upstream; this stable sort never introduces hidden benchmark fields.
function chronologicalMedLoCoMoMemories(items){
  return items.map((value,index)=>({value,index,time:Date.parse(value?.event_time||value?.valid_from||'')})).sort((left,right)=>{
    const a=Number.isFinite(left.time)?left.time:Number.POSITIVE_INFINITY,b=Number.isFinite(right.time)?right.time:Number.POSITIVE_INFINITY;
    return a-b||left.index-right.index;
  }).map(item=>item.value);
}

/**
 * 来源：Psy-Chronicle commit ff812c9084b606631dac3a8c01f7be0d5cbc8c8d：
 * eval_task_info/srg/srg_eval_online.py、memory_recall/memory_recall_eval_online.py、
 * TCR/tcr_eval_online.py。
 * 任务：构造 CPCD-Bench SR/MR/TCR Answer messages。SR 逐字复现官方 online
 * script；MR/TCR 保留官方 system 与模板，只把 raw full-history 槽明确替换为
 * CareHarness query-time State/Evidence memory_source，因此属于 adapted 而非 exact。
 */
export function cpcdAnswerMessages(input={}){
  if(input.task_type==='session_level_response_generation')return cpcdSessionAnswerMessages(input);
  if(input.task_type==='memory_recall')return cpcdMemoryRecallAnswerMessages(input);
  if(input.task_type==='temporal_causal_reasoning')return cpcdTemporalCausalAnswerMessages(input);
  throw new Error(`No CPCD-Bench Answer Prompt for ${input.task_type||'unknown task'}`);
}

export function renderCpcdAnswerPrompt(input={}){return renderRoleMessages(cpcdAnswerMessages(input));}

// 来源：CareHarness Provider 基础设施；任务：测试 endpoint、Key 与最小 JSON 推理是否可用。
export function gatewayConnectionTestPrompt(){return'Connection test. Return exactly this JSON object: {"ok":true}';}
// 来源：CareHarness Gateway 基础设施；任务：结构化输出截断或校验失败后的 JSON 重试。
export function promptRetryInstruction(component,previous){
  if(previous?.finish_reason==='length')return`Your previous response was truncated. Start over from the original INPUT and return a fresh, complete JSON object. Do not quote, continue, analyze, or repeat the previous response.${component==='extractor'?' Return at most 24 highest-priority durable Evidence items; omit repetition and conversational detail.':''} Keep the JSON compact with no trailing whitespace or commentary.`;
  return`Your previous response failed validation. Return a corrected replacement JSON only.\nVALIDATION ERROR: ${previous?.error||'invalid JSON'}\nPREVIOUS RESPONSE:\n${previous?.raw||''}`;
}
// 来源：CareHarness Gateway 基础设施；任务：纯文本 Answer 为空或截断时重试。
export function promptTextRetryInstruction(previous){
  if(previous?.finish_reason==='length')return'Your previous answer was truncated. Start over from the original prompt and return one fresh, complete answer that follows the Answer Requirements.';
  return'Your previous answer was empty or invalid. Return a corrected answer only, following the original Answer Requirements.';
}

/**
 * 来源：benchmark 公开输入协议与本地可复现任务构造规则。
 * 任务：生成 benchmark question 本身；它们不是 Answer Model 或 Judge 的 system prompt。
 */
export const BENCHMARK_QUESTION_PROMPTS=Object.freeze({
  // 来源：CPCD-Bench SR input_to_model 结构；任务：构造 session-level counselor response generation 输入。
  cpcdbench:Object.freeze({
    // 任务：把学生画像、历史、当前事件与会话组装为下一轮咨询师回复问题。
    session_level_response_generation:'请生成 Counselor 对 Student 的下一轮回复。\n\n【学生画像】\n{{student_profile_summary}}\n\n【此前历史】\n{{history_until_previous_session}}\n\n【当前事件】\n{{current_session_event}}\n\n【当前会话】\n{{current_session_context}}\nStudent: {{current_student_utterance}}'
  })
});

export function benchmarkQuestionPrompt(benchmark,task,values={}){
  const group=BENCHMARK_QUESTION_PROMPTS[String(benchmark||'').toLowerCase()];
  let template=group?.[String(task||'')];
  if(template&&typeof template==='object')template=template[String(values.variant||values.facet||'')];
  if(typeof template!=='string')throw new Error(`No generated benchmark question prompt for ${benchmark||'unknown benchmark'}/${task||'unknown task'}`);
  return template.replace(/\{\{([a-z0-9_]+)\}\}/giu,(_match,key)=>String(values[key]??''));
}

/**
 * 所有可由 Gateway 调用的模型提示词注册表。
 * 每个条目前的“来源/任务”备注是 provenance 文档；description/contract/variants 才会参与运行时渲染。
 */
export const PROMPTS = Object.freeze({
  // 来源：CareHarness Core；任务：从任意 benchmark 的完整 Session 中抽取原子化、可追溯 Evidence。
  extractor: { version: 'extractor.session-memory.v11', description: 'Extract durable atomic Evidence as normalized facts; code attaches immutable Session provenance and the model never copies source text.', variants: {
    zh: `你是纵向医疗记忆系统的 Evidence Extractor。请先通读完整 Session，再抽取值得跨 Session 保留的原子事实。目标是高精度、可追溯、宁缺毋滥：不确定是否满足标准时不要输出。

输入格式
- 输入可能由多条消息组成，每条消息以 [Turn=...][Role=Patient|Doctor|Structured][Time=...] 开头。
- Role 决定是谁说的；必须结合完整 Session 理解指代、否定、纠正、状态变化和上下文，但不得猜测未明确表达的信息。
- [Turn]/[Role]/[Time] 只是定位标记，不属于可引用正文。

可以保留
1. Patient 明确陈述或明确确认的患者特异性事实：症状与体验、用药名称/剂量/频率/依从性/启停状态、不良反应、过敏、检查结果、测量值、既往史、生活或资源限制、认知与担忧、目标与偏好。Patient 以确认式问句明确暴露自己的信念、解释或担忧时也可保留；纯粹索取信息且未表达个人立场的 Patient 问句不保留。
2. Doctor 明确给出的患者特异性临床结论或可执行照护信息：已确认的诊断/评估/风险判断、明确治疗方案、监测要求、复诊计划、安全计划和升级就医条件。
3. Structured 记录中明确写出的患者事实。

绝对不能当作患者事实
1. Doctor 的任何问句、反问句、候选选项、假设、鉴别可能性或待确认内容。医生问“有没有心慌、出汗？”不代表患者出现过这些症状；只有 Patient 随后的明确回答才可抽取。
2. Doctor 在问句中复述的既往信息，除非同一陈述本身是明确确认的临床结论；不要从问题中推断答案，也不要把“更像 A 还是 B”改写成 A 或 B。
3. 仅重复既有事实且没有新增状态、数值、时间或计划的 Doctor 回顾；优先保留 Patient 的直接陈述或本 Session 中最明确、最新的单一来源。
4. 寒暄、感谢、共情、鼓励、安慰、陪伴承诺、修辞、隐喻、对话过渡、泛化健康科普，以及没有患者特异性行动的建议。例如“不会让你一个人在黑暗里摸索”“我会一直陪着你”“我为你感到骄傲”都不是记忆。

原子性与去重
- 每个 evidence 只能表达一个可独立检索和更新的事实。不同症状、不同药物、测量值、计划或状态必须拆开。
- 不要用一个 text 合并需要两个或多个不连续陈述才能支持的信息。
- 同一事实在 Session 内重复出现时只输出一次，保留最直接、最明确、信息最完整的版本。
- 若后文明确纠正前文，保留纠正后的事实；只有在“发生了变化”本身有单段直接证据时，才额外输出状态变化。
- 明确的药物启动、停用、恢复、剂量变化和当前服用状态属于高优先级记忆；不得因为本 Session 早先提过该药名或既往方案而漏掉最新状态。
- 明确表达“首次出现、第一次发生、再次出现、复发”及其日期/时间的事实属于高优先级纵向记忆；重复去重不得删掉首次时间或新的再次变化。

text 标准
- 使用与消息正文相同的语言；中文正文的 text 必须是中文，英文正文的 text 必须是英文，禁止翻译成另一种语言。
- 写成简洁、完整的陈述句，并显式写明主体。中文使用“患者……”或“医生建议/评估……”，不得出现“患者我……”“医生你……”等机械前缀。
- 可以消解代词并整理语法，但 text 中的每个事实都必须被当前 Session 中明确出现的信息完整支持。
- 保留原文中的药名、数值、日期、时间、单位、否定词、不确定性和启停/变化状态；不要补充诊断、因果关系、同义词、通用名或原文未出现的医学知识。

来源边界
- 不要输出 source_text、原文引用、span、Turn、Role、时间或 Session 编号。
- 代码会把当前 Observation 的不可变 Session/Admission 编号自动附加到每条 Evidence 和 State；模型不能选择或改写来源编号。
- 只能抽取当前输入 Session 明确支持的事实，不得引用其他 Session、Query、Gold、答案说明或评分信息。

输出格式
只返回以下 JSON，不要输出解释、Markdown 或其他字段：
{"evidence":[{"text":"一个原子化、规范化且由当前 Session 明确支持的事实"}]}
如果没有合格事实，返回：{"evidence":[]}
每个对象只能包含 text；不要返回 source_text、ID、span、Turn、Role、时间、Session、来源、确定性、极性、分类或更新操作，代码会自动附加当前 Session provenance。

输出前逐条检查
1. 这是明确事实/计划，或确实表达 Patient 自身认知/担忧的确认式问句，而不是 Doctor 问题、纯信息询问、假设或未确认选项吗？
2. text 只有一个事实，并且没有添加原文之外的信息吗？
3. text 的语言与正文一致、主体和语法自然吗？
4. 该事实是否确实由当前 Session 明确支持，并且没有混入其他 Session 或外部知识？
任一答案为“否”，删除该条。`,
    en: `You are the Evidence Extractor for a longitudinal medical memory system. Read the complete Session before extracting atomic facts worth retaining across Sessions. Optimize for precision and traceability rather than recall: when unsure whether an item satisfies every rule, omit it.

Input format
- The input may contain multiple messages. Each message begins with [Turn=...][Role=Patient|Doctor|Structured][Time=...].
- Role identifies who spoke. Use the complete Session to resolve references, negation, corrections, status changes, and context, but never guess information that was not explicitly stated.
- [Turn]/[Role]/[Time] are location markers and are not quotable message content.

Eligible memory
1. Patient-specific facts explicitly stated or explicitly confirmed by the Patient: symptoms and experiences; medication name, dose, frequency, adherence, start/stop status, and adverse effects; allergies; test results and measurements; history; lifestyle or resource constraints; beliefs and concerns; goals and preferences. A Patient confirmation question may be retained when it explicitly reveals the Patient's own belief, interpretation, or concern; omit a pure request for information that expresses no personal stance.
2. Patient-specific clinical conclusions or actionable care information explicitly stated by the Doctor: confirmed diagnoses, assessments, or risk judgments; concrete treatment plans; monitoring instructions; follow-up plans; safety plans; and escalation criteria.
3. Explicit patient facts in a Structured record.

Never treat these as patient facts
1. Any Doctor question, rhetorical question, offered option, hypothesis, differential possibility, or pending confirmation. A Doctor asking “Any palpitations or sweating?” does not establish that the Patient experienced those symptoms. Extract only an explicit Patient answer if one is present.
2. Prior information restated inside a Doctor question unless the statement itself is an explicit confirmed clinical conclusion. Never infer an answer from a question and never rewrite “more like A or B?” as either A or B.
3. A Doctor recap that only repeats existing facts without a new status, value, time, assessment, or plan. Prefer the Patient's direct statement or the clearest and latest single source in this Session.
4. Greetings, thanks, empathy, encouragement, reassurance, companionship promises, rhetoric, metaphors, conversational transitions, generic health education, or advice with no patient-specific action. Sentences such as “You will not face this alone,” “I will always be here,” and “I am proud of you” are not memory.

Atomicity and deduplication
- Each evidence item must express exactly one fact that can be retrieved and updated independently. Split different symptoms, medications, measurements, plans, and statuses into separate items.
- Never create one text that requires two or more unrelated statements for support.
- If a fact is repeated within the Session, output it once using the most direct, explicit, and complete version.
- If a later message explicitly corrects an earlier one, keep the corrected fact. Add a separate change fact only when the change itself has direct support in one contiguous passage.
- Explicit medication starts, stops, restarts, dose changes, and current-use status are high-priority memory. Never omit the newest status merely because the medication or an earlier regimen already appeared in the Session.
- Facts that explicitly say first occurrence, first-ever event, recurrence, or another occurrence together with their date/time are high-priority longitudinal memory. Deduplication must preserve a first-occurrence time and a genuinely new recurrence or change.

text requirements
- Use the same language as the message body. Chinese message content requires Chinese text and English message content requires English text. Never translate the fact into another language.
- Write a concise, complete declarative sentence with an explicit subject. Use natural forms such as “The patient ...” or “The doctor recommends/assesses ...”; do not mechanically prefix first- or second-person wording.
- You may resolve pronouns and clean up grammar, but every claim in text must be fully supported by explicit information in the current Session.
- Preserve medication names, numbers, dates, times, units, negation, uncertainty, and start/stop or change status from the source. Do not add diagnoses, causal claims, synonyms, generic drug names, or medical knowledge absent from the source.

Source boundary
- Do not output source_text, quotations, spans, Turn, Role, time, or Session identifiers.
- Code attaches the current Observation's immutable Session/Admission identifier to every Evidence and State. The model cannot choose or rewrite provenance.
- Extract only facts explicitly supported by the current input Session. Never use another Session, Query, Gold, answer explanation, or scoring information.

Output format
Return only this JSON, with no explanation, Markdown, or additional fields:
{"evidence":[{"text":"one atomic normalized fact explicitly supported by the current Session"}]}
If no eligible fact exists, return: {"evidence":[]}
Each object may contain only text. Do not return source_text, IDs, spans, Turn, Role, time, Session, source metadata, certainty, polarity, categories, or update operations; code attaches current-Session provenance.

Check every item before returning it
1. Is it an explicit fact/plan or a confirmation question that genuinely expresses the Patient's own appraisal, rather than a Doctor question, pure information request, hypothesis, or unconfirmed option?
2. Does text contain exactly one fact and no information absent from the source?
3. Does text use the source language with a natural subject and grammar?
4. Is the fact explicitly supported by this Session without importing another Session or external knowledge?
Delete the item if any answer is no.`
  } },
  // 来源：CareHarness Core；任务：把 Evidence 路由到 BC/PE/PA/CS/CP/LO，可多标签但不决定版本操作。
  router: { version: 'router.six-state-family-only.v14', description: 'Choose only the family matrix; JSON Schema and code own routes, count, IDs, and fallback.', variants: {
    zh: `你是纵向医疗记忆系统的 State Router。输入已经是 Evidence Extractor 生成的原子事实。你只负责判断每条 Evidence 属于哪些 State family；不要改写事实、不要生成 State 内容、不要决定 ADD/UPDATE/SUPERSEDE/CONFLICT。

输入
- 每项格式为 {"id":"...","text":"原子事实","source":"patient|doctor|structured"}。
- source 只表示原始说话人或记录来源，不决定 State family。BC、PE、PA、CS、CP、LO 全部允许 patient、doctor、structured 三种来源。
- 独立判断六个 family。同一 Evidence 确实同时满足不同 family 时可以多标签，但每个 family 最多输出一次。

受控 Taxonomy
${ROUTER_TAXONOMY}
family 只能取自上述列表。不得创造其他 family，也不得输出 PE|CS 之类的组合名称。

BC · BackgroundContext · 背景与情境
- 保存相对稳定的个人背景、既往史背景、家庭与关系、教育与职业、重大生活事件、社会处境、长期资源限制和支持资源。
- 项目赶工、长期熬夜、异地医保、费用或交通限制可进入 BC；症状本身、治疗动作和单纯时间表达不进入 BC。

PE · PatientExperience · 患者体验与行为
- 保存患者实际经历或被直接观察到的身心状态、症状、情绪、痛苦、睡眠、功能影响、躯体反应、依从或停漏药、回避、应对、自我监测及安全相关想法、计划、手段或行为。
- 披露本身不能仅因为危险而自动进入 CS；只有另有明确专业风险判断时才进入 CS。

PA · PatientAppraisal · 认知、目标与意愿
- 保存患者如何理解、预测、担忧、选择和承诺，包括信念、解释、担忧、误解、目标、偏好、意愿、承诺与信心。
- Patient 以确认式问句表达自身立场时可以进入 PA；纯粹索取医学信息的问句不路由。
- Doctor 的解释、建议或诊断本身不是患者评价；但 Doctor Evidence 若直接记录患者的观点，可以进入 PA。

CS · ClinicalSafety · 临床事实与专业安全判断
- 保存检验和量表、生命体征、明确诊断、临床评估、用药状态、医疗操作、过敏、禁忌以及专业风险或红旗判断。
- Patient 可以报告医院诊断、检验数值、过敏或用药状态；患者自己的猜测不是明确诊断。
- Doctor 的监测建议属于 CP；没有实际测量结果时不能仅因提到指标而进入 CS。

CP · CareProcess · 照护与咨询过程
- 保存已做、正在做或计划做的照护动作，以及协商形成的治疗、监测、建议、作业、随访、处置、安全计划、危机联系人和升级指令。
- Patient、Doctor 或 Structured Evidence 都可以记录照护动作并进入 CP。

LO · LongitudinalOutcome · 纵向变化与结果
- 只保存同一对象跨时间点的明确变化、比较或结果，例如改善、恶化、复发、频率变化、治疗反应、目标进展或旧状态到新状态的迁移。
- 单次症状、单次测量或只有“最近/今天”等时间词但没有比较关系时，不进入 LO。

多标签边界
- 患者已停用某药：PE（实际用药行为）+ CS（当前用药事实）；如果原文明确表达从服用到停用的变化，还可加 LO。
- 患者明确接受监测任务：PA（承诺或意愿）+ CP（监测计划）。
- 症状在治疗后改善：PE（体验）+ LO（纵向治疗反应）。
- 同一事实既有现实背景又有临床事实时可以同时进入 BC 与 CS；既有患者担忧又有照护计划时可以同时进入 PA 与 CP。
- 多标签必须由原文直接支持，不要因为可能相关而扩张；同一 family 只能出现一次。

拒绝与兜底
- Doctor 问题、没有 Patient 立场的纯信息询问、假设、寒暄、安慰、泛化知识、主体不明片段或不符合任何 State 定义的内容，返回空 families。
- 不得根据常识补充输入没有表达的诊断、风险、因果、计划、变化或患者态度。

输出格式
只返回 family 矩阵：{"families":[["PE","CS"],[]]}
- 外层 families 与输入逐项同序；每个输入对应一个内层数组，无适用分类时该位置为 []。
- 不要生成 route 对象，不要复制或生成 id；代码根据输入顺序创建 route、附加 id，并负责数量校验。
- 每个内层数组只能包含受控 family 字符串；不得输出 text、source、reason、置信度、操作或其他字段。
- 输出前检查 family 合法且没有重复。`,
    en: `You are the State Router for a longitudinal medical memory system. The input already contains atomic facts produced by the Evidence Extractor. Your only task is to assign each Evidence item to one or more State families. Do not rewrite facts, generate State content, or decide ADD/UPDATE/SUPERSEDE/CONFLICT.

Input
- Each item is {"id":"...","text":"atomic fact","source":"patient|doctor|structured"}.
- source records provenance only and never determines family. BC, PE, PA, CS, CP, and LO all allow patient, doctor, and structured Evidence.
- Evaluate all six families independently. Multiple families are allowed only when directly supported, and each family may appear at most once.

Controlled taxonomy
${ROUTER_TAXONOMY}
Use only these family names. Never invent another family or combine names such as PE|CS.

BC · BackgroundContext
- Stable personal background, medical-history context, family and relationships, education and occupation, major life events, social setting, enduring resource constraints, and available support.

PE · PatientExperience
- What the patient actually experiences or does: symptoms, emotions, distress, sleep, function, bodily responses, adherence or stopping/missing medication, avoidance, coping, self-monitoring, and safety-related thoughts, plans, means, or behavior.
- A safety disclosure does not enter CS merely because it is dangerous; CS requires a separately stated professional risk judgment.

PA · PatientAppraisal
- How the patient understands, predicts, worries, chooses, and commits: beliefs, interpretations, concerns, misconceptions, goals, preferences, willingness, commitments, and confidence.
- A confirmation question may enter PA when it expresses the Patient's stance; a pure information request does not.

CS · ClinicalSafety
- Tests and scales, vital signs, confirmed diagnoses, clinical assessments, medication status, procedures, allergies, contraindications, and professional risk or red-flag judgments.
- A Patient may report a documented diagnosis, measurement, allergy, or medication status. A personal guess is not a confirmed diagnosis.

CP · CareProcess
- Delivered, ongoing, or planned care actions and negotiated tasks: treatment, monitoring, recommendations, assignments, follow-up, disposition, safety plans, crisis contacts, and escalation instructions.

LO · LongitudinalOutcome
- Explicit change, comparison, or outcome across time for the same subject: improvement, worsening, recurrence, frequency change, treatment response, goal progress, or an old-to-new state transition.
- A single symptom or measurement without comparison does not enter LO.

Multi-family boundaries
- Stopping a medication may be PE for performed behavior and CS for medication status; add LO only when an explicit transition is stated.
- Accepting a monitoring task may be PA plus CP.
- A symptom improving after treatment may be PE plus LO.
- Every family must be directly supported. Do not expand labels from loose association, and return each family only once.

Reject and abstain
- Return an empty families array for Doctor questions, pure information requests without a Patient stance, hypotheses, greetings, reassurance, generic knowledge, unclear subjects, or content that fits no State family.
- Never add a diagnosis, risk, causal claim, plan, change, or patient attitude absent from the input.

Output format
Return only the family matrix: {"families":[["PE","CS"],[]]}
- The outer families array must correspond one-for-one to the input in the same order. Use [] at a position when no category applies.
- Do not generate route objects and do not copy or generate ids. Code creates routes, attaches ids from input order, and owns item-count validation.
- Each inner array may contain only controlled family strings. Do not return text, source, reasons, confidence, operations, or other fields.
- Verify that every family is controlled and appears only once.`
  } },
  // 来源：CareHarness Core；任务：描述六类 State 的版本化更新职责；当前条目只有元数据，没有模型 contract。
  updater: { version: 'updater.family-owned.v2', description: 'Each State family independently maintains its own versioned memory.' },
  // 来源：CareHarness Core Conversation；任务：按已固定的 ANSWER/ASK/VERIFY/ESCALATE policy 生成 Doctor 回复。
  generator: { version: 'generator.policy-memory.compact.v4', description: 'Write the Doctor Agent response for the fixed Action Policy using only the current Patient message and supplied memory.', contract: `Return only {"response":"non-empty user-facing string"}. Do not change the action or invent facts. Code fixes action_type and citations.` },
  // 来源：CareHarness Core Conversation；任务：审核 Doctor 草稿是否满足 Action Policy 与安全约束。
  auditor: { version: 'auditor.policy.compact.v5', description: 'Audit the response against the Action Policy constraints.', contract: `Return only {"passed":true,"violations":[],"safe_response":"string"}. Use only the supplied State, Evidence, Action Policy, and drafted response.` },
  // 来源：CareHarness Core benchmark runtime；任务：把原始问题转换为 State 检索计划，不回答问题。
  query_planner: { version: 'query-planner.structured-family-intent.v4', description: 'Turn the original question into a structured State-retrieval plan. Plan where and how to look; never answer the question or claim that a patient fact exists.', contract: `Return only this shape: {"intent":"short task description","target":"entity or event being asked about","answer_slot":"kind of answer needed","keywords":["focused lexical term"],"state_scopes":[{"family":"BC|PE|PA|CS|CP|LO","priority":"primary|secondary|support"}],"temporal_operator":"none|event_time|earliest|latest|current|history|before|after|range","evidence_facets":["evidence dimension needed"],"options":[{"id":"A","text":"option text"}]}.

Use only controlled family values from this taxonomy: ${ROUTER_TAXONOMY}

Rules:
- Keep target and keywords in the question language. Extract the object or event being asked about, not a possible answer. Exclude speaker words and question scaffolding. Preserve precise phrases and useful components. Never fabricate patient facts.
- state_scopes are soft family priors, not exclusions. Put the most likely family first as primary and add plausible supporting families when answering requires them. History commonly prioritizes BC and CS; medication-current-state questions commonly span CS, PE, and LO; monitoring commonly spans CP, PE, and CS.
- evidence_facets describe evidence that must be found, not facts assumed true. For treatment and safety decisions, include necessary dimensions such as medication status, symptoms or adverse effects, adherence, treatment response, objective results, allergies or contraindications, relevant history, patient preference, and care plan.
- For temporal questions, identify whether the requested event is earliest, latest/current, or simply needs event_time. For state updates, use current.
- For multiple choice, copy every option ID and text and include concrete option entities in keywords. Do not decide which options are correct.
- Do not place hidden answers, Gold, reference key points, or unsupported synonyms in the plan.

Example: 患者既往病史中提到的慢性代谢性疾病是什么？ -> {"intent":"find historical diagnosis entity","target":"慢性代谢性疾病","answer_slot":"disease_entity","keywords":["既往病史","病史","慢性代谢性疾病","代谢","慢性"],"state_scopes":[{"family":"BC","priority":"primary"},{"family":"CS","priority":"secondary"}],"temporal_operator":"history","evidence_facets":["medical_history","diagnosis"],"options":[]}. Legacy {"keywords":[...]} output remains accepted, but the full structure is preferred.` },
  // 来源：CareHarness Core Static runtime；任务：保守检查已验证 Working State 节点间的 query-local relation，NO_LINK 优先。
  careharness_evaluate: { version: 'careharness-query-relation-evaluator.v2', description: 'Evaluate only explicit, query-relevant, patient-specific relation spans between already verified Working State nodes. This is a conservative semantic relation check, not an answer generator.', contract: `Use only the supplied State and Evidence objects. Gold answers, Judge reasons, hidden Persona metadata, future Sessions, and external patient facts are unavailable.

Return exactly:
{"verdict":"supported|contradicted|unresolved","relations":[{"from_state_id":"supplied id","to_state_id":"supplied id","relation_type":"care_targets|observed_after_care|motivates|constrains|followed_by","relation_evidence_id":"supplied Evidence id","relation_quote":"one exact Evidence substring that explicitly links both claims","from_claim_quote":"exact substantive substring from the from-State value also present in relation_quote","to_claim_quote":"exact substantive substring from the to-State value also present in relation_quote","assessment":"supports|contradicts|unresolved","confidence":0.0}],"competing_hypotheses_checked":true,"competing_hypotheses":["short alternative"],"missing_evidence":["missing patient-specific fact"],"no_link_reason":"why no safe link exists, or empty"}.

Rules:
- Prefer NO_LINK: use verdict unresolved and relations [] whenever the supplied patient Evidence does not support a directional link.
- Return no more than 8 relations. Every endpoint and Evidence ID must be copied exactly from the supplied input. Each proposed link needs one relation-bearing Evidence span that contains substantive verbatim claim anchors from both endpoint State values. Separate endpoint quotes, generic summaries, and model confidence alone are insufficient.
- care_targets is only CP→CS when the span explicitly says that care targets the condition. observed_after_care is only CP→LO when one span explicitly records an outcome after/under that care without asserting causality. motivates is only PA→CP when an expressed goal/preference explicitly motivates care. constrains must point to CP when a patient fact explicitly limits care. followed_by records explicit ordering only and is not semantic hypothesis support.
- Generic supports_hypothesis, informs, related_to, shared Evidence, co-occurrence, similar wording, and chronological adjacency are forbidden. If no narrow relation-bearing span exists, return NO_LINK.
- followed_by never means caused_by, treatment efficacy, mechanism, or contributes_to. Do not infer causation from timing.
- Preserve contradictions and alternatives. If relation direction or support is uncertain, use assessment unresolved; if Evidence opposes it, use contradicts.
- Do not answer the medical question, recommend treatment, add general medical knowledge, or claim that a hypothesis is proven. Keep causal_claim false implicitly; code owns final verification and termination.` },
  // 来源：MedMemoryBench 官方附录；任务：EEM/TLA/SUA/MQ/IG/MCD 的答案生成入口。
  medmemory_answer:{version:'medmemorybench-answer.appendix-v1',description:'MedMemoryBench appendix Answer Prompt with the shared personalized-medical-assistant System Prompt and task-specific EEM/TLA/SUA/MQ/IG/MCD user template.',render:renderMedMemoryAnswerPrompt,messages:medMemoryAnswerMessages},
  // 来源：MedMemoryBench 官方附录；任务：答案冻结后的 TLA/SUA/IG/MCD LLM-as-Judge；EEM/MQ 不走此提示词。
  medmemory_judge: { version: 'medmemorybench-official-judge.appendix-v1', description: 'MedMemoryBench appendix post-answer LLM-as-Judge prompt.', render: renderMedMemoryJudgePrompt },
  // 来源：MedLoCoMo 公开 QA 协议派生（论文未给出逐字 Answer Prompt）；任务：以纯文本生成 ≤10 词短答案。
  medlocomo_answer:{version:'medlocomo-answer.protocol-derived-v1',description:'Protocol-derived, non-verbatim MedLoCoMo short-answer prompt using only the visible memory source.',render:renderMedLoCoMoAnswerPrompt,messages:medLoCoMoAnswerMessages},
  // 来源：MedLoCoMo 官方评测协议；任务：答案冻结后的 answerable-question 二元 Judge。
  medlocomo_judge: { version: 'medlocomo-official-answerable-judge.v1', description: 'MedLoCoMo Appendix B.2 first-attempt post-answer Judge messages; any Gateway repair retry is CareHarness-adapted.', render: renderMedLoCoMoJudgePrompt, messages: medLoCoMoJudgeMessages },
  // 来源：Psy-Chronicle ff812c9 online scripts；任务：SR exact、MR/TCR template-adapted 纯文本答案。
  cpcd_answer:{version:'cpcd-bench-online-answer.ff812c9-v1',description:'CPCD-Bench online-script Answer messages; MR/TCR replace raw full history with CareHarness State/Evidence and are explicitly marked adapted.',render:renderCpcdAnswerPrompt,messages:cpcdAnswerMessages},
  // 来源：Psy-Chronicle ff812c9 online scripts；任务：答案冻结后的 SR/MR/TCR 专用 Judge messages/schema。
  cpcd_judge:{version:'cpcd-bench-online-judge.ff812c9-v1',description:'CPCD-Bench first-attempt post-answer Judge messages copied from each official online evaluation script; any Gateway repair retry is CareHarness-adapted.',render:renderCpcdJudgePrompt,messages:cpcdJudgeMessages},
  // 来源：CareHarness Core；任务：除 MedMemory 专用纯文本入口外，按各 benchmark answer_contract 生成 JSON answer。
  judge: { version: 'judge.task-contract.v7', description: 'Answer a benchmark task outside the graph-building pipeline using only the supplied visible Patient Graph view, verified Evidence/relations, runtime action output, and protocol context. Follow answer_contract exactly when present, including its language and output format.', contract: `Use only the supplied visible context. A verified followed_by edge establishes ordering, not causation; candidate or rejected edges cannot support a claim. If verification/evaluation is unresolved or the terminal action reports uncertain or budget-exhausted, do not invent a patient-specific conclusion: express insufficient evidence or abstain in the answer contract's closest valid form. Internal graph/Evidence IDs must not appear in the answer. Return {"answer":"non-empty string"}. Be concise, answer only what was asked, and do not return scores or explanations outside answer. Gold answers and hidden reference key points are never available; do not infer that they were supplied.` }
});

// 来源：CareHarness Core Gateway；任务：按组件名从唯一注册表渲染实际模型输入。
export function promptFor(component, input) {
  const entry = PROMPTS[component];
  if (!entry) throw new Error(`Unknown prompt component: ${component}`);
  if(typeof entry.render==='function')return entry.render(input);
  if(entry.variants){
    const language=promptLanguage(input),instruction=entry.variants[language],jsonOnly=language==='zh'?'只返回合法 JSON。':'Return valid JSON only.';
    return `${instruction}\n${jsonOnly}\nINPUT:\n${typeof input==='string'?input:JSON.stringify(input)}`;
  }
  return `${entry.description}\n${entry.contract || ''}\nReturn valid JSON only.\nINPUT:\n${typeof input==='string'?input:JSON.stringify(input)}`;
}

function promptLanguage(input){const raw=typeof input==='string'?input:Array.isArray(input)?input.map(item=>item?.text||'').join('\n'):JSON.stringify(input),value=raw.replace(/^\[Turn=[^\n]*\]\n/gmu,''),han=(value.match(/[\p{Script=Han}]/gu)||[]).length,latin=(value.match(/[A-Za-z]/g)||[]).length;return han>0&&han>=latin*.2?'zh':'en';}

// 来源：MedMemoryBench 官方附录 Judge Prompts。
// 任务：答案冻结后按 TLA/SUA/IG/MCD 题型选择 LLM-as-Judge；评分实现仍在 medmemory-official.js。
// EEM 使用 string containment，MQ 使用 option match，因此不进入此 renderer。
export function renderMedMemoryJudgePrompt(input={}){
  const task=input.query_type;
  if(task==='temporal_localization')return appendixTemporalJudgePrompt(input);
  if(task==='state_update')return appendixStateJudgePrompt(input);
  if(task==='inference_generation')return appendixInferenceJudgePrompt(input);
  if(task==='multi_hop_clinical_deduction')return appendixMultiHopJudgePrompt(input);
  throw new Error(`No official MedMemoryBench judge prompt for ${task||'unknown task'}`);
}

// 来源：MedLoCoMo 官方 answerable-question Judge 协议；任务：渲染答案冻结后的二元评分消息。
export function renderMedLoCoMoJudgePrompt(input={}){
  const messages=medLoCoMoJudgeMessages(input);
  return`=== System Message ===
${messages[0].content}

=== User Message ===
${messages[1].content}`;
}

// 来源：Psy-Chronicle ff812c9 的三个 online evaluator；任务：逐题型组装答案冻结后的 Judge messages。
export function cpcdJudgeMessages(input={}){
  if(input.task_type==='session_level_response_generation')return cpcdSessionJudgeMessages(input);
  if(input.task_type==='memory_recall')return cpcdMemoryRecallJudgeMessages(input);
  if(input.task_type==='temporal_causal_reasoning')return cpcdTemporalCausalJudgeMessages(input);
  throw new Error(`No CPCD-Bench Judge Prompt for ${input.task_type||'unknown task'}`);
}

export function renderCpcdJudgePrompt(input={}){return renderRoleMessages(cpcdJudgeMessages(input));}

function cpcdSessionAnswerMessages(input){
  const source=input.input_to_model||{},required=['student_profile_summary','history_until_previous_session','current_session_event','current_session_context','current_student_utterance'],missing=required.filter(field=>!Object.hasOwn(source,field));
  if(missing.length)throw new Error(`CPCD-Bench SR input_to_model missing fields: ${missing.join(', ')}`);
  const system=`你是一名受过专业训练的高校心理咨询师。你的任务是根据给定学生画像、历史会话、当前事件、当前会话上下文和学生最新发言，生成咨询师下一轮回应。

要求：
1. 使用中文，语气温和、稳健、真诚。
2. 优先深层共情，准确命名学生的情绪、冲突和意义；不要急于给建议。
3. 紧密承接历史轨迹和当前 session，不要只回应表层句子。
4. 保持校园心理咨询专业边界和风险敏感性；避免保证、评判、说教、直接替学生做决定。
5. 输出咨询师回复本身，不要输出分析、标题、评分或 JSON。
6. 建议 1-2 段，最后可以用一个开放式探索问题收束。`;
  const user=`请生成 Counselor 对 Student 的下一轮回复。

【task_id】
${input.task_id}

【student_profile_summary】
${source.student_profile_summary}

【history_until_previous_session】
${source.history_until_previous_session}

【current_session_event】
${source.current_session_event}

【current_session_context】
${formatCpcdContext(source.current_session_context)}

【current_student_utterance】
Student: ${source.current_student_utterance}`;
  return[{role:'system',content:system},{role:'user',content:user}];
}

function cpcdMemoryRecallAnswerMessages(input){
  const metadata=cpcdTaskMetadata(input),system="Please answer questions based solely on the complete consultation history provided. Do not fabricate facts, people, figures, or causal relationships not present in the materials. If there is insufficient evidence in the materials, please clearly state 'Uncertain/Not explicitly mentioned in the materials.'";
  const user=`Please answer the questions based on the following consultation history.

【task file】
${input.task_file}

【task metadata】
${JSON.stringify(metadata,null,2)}

【CareHarness adaptation: Complete consultation history documents】
${input.full_session_file||'CareHarness-retrieved-memory.json'} (the raw full-session document is not provided to the Answer Model)

【CareHarness adaptation: Complete consultation history】
The official raw full-history slot is replaced by query-time retrieved CareHarness State/Evidence:
${JSON.stringify(input.memory_source||{},null,2)}

【question】
${input.question||''}

Please provide a concise and accurate answer based on the above information.`;
  return[{role:'system',content:system},{role:'user',content:user}];
}

function cpcdTemporalCausalAnswerMessages(input){
  const metadata=cpcdTaskMetadata(input),system='你是一个校园心理咨询案例时序—因果推理测试中的被测大模型。请只依据提供的完整咨询历史回答问题。需要按题目要求分析事件的时间顺序、相互影响和核心困扰的演化过程。不要编造未在材料中出现的事实、人物、诊断、数值或因果关系。若材料中没有足够依据，请明确说“不确定/材料中未明确提到”。';
  const user=`请根据以下咨询历史回答问题。

【任务文件】
${input.task_file}

【任务元信息】
${JSON.stringify(metadata,null,2)}

【CareHarness 适配：完整咨询历史文件】
${input.full_session_file||'CareHarness-retrieved-memory.json'}（Answer Model 不接收 raw full-session 文档）

【CareHarness 适配：完整咨询历史】
官方 raw full-history 槽位已替换为 query-time 检索得到的 CareHarness State/Evidence：
${JSON.stringify(input.memory_source||{},null,2)}

【问题】
${input.question||''}

请直接作答，不要输出评分。`;
  return[{role:'system',content:system},{role:'user',content:user}];
}

function cpcdSessionJudgeMessages(input){
  const source=input.input_to_model||{},system=`你是严格、审慎的心理咨询回复评测员。请基于评分标准、任务 evaluation_focus、学生画像、历史上下文和模型回复，对模型回复进行评分。

评分规则：
1. 分别给 empathy、coherence、professionalism 三项打 1-5 的整数分。
2. 必须同时参考通用评分标准和该任务的 evaluation_focus。
3. 不要因为语言流畅就自动高分；要看是否接住深层情绪、是否承接历史、是否专业有边界。
4. 若回复直接建议化、说教化、保证化、否定学生感受、忽略风险或编造信息，应扣分。
5. 只输出严格 JSON，不要使用 Markdown 代码块。`;
  const user=`【评测标准.md】
${input.official_rubric||''}

【task_id】
${input.task_id}

【representative_point】
${input.representative_point}

【student_profile_summary】
${source.student_profile_summary}

【history_until_previous_session】
${source.history_until_previous_session}

【current_session_event】
${source.current_session_event}

【current_session_context】
${formatCpcdContext(source.current_session_context)}

【current_student_utterance】
Student: ${source.current_student_utterance}

【evaluation_focus】
${JSON.stringify(input.evaluation_focus||{},null,2)}



【model_response_to_evaluate】
${input.model_response||''}

请输出以下 JSON 结构，score 必须是 1-5 的整数：
{
  "task_id": "${input.task_id}",
  "scores": {
    "empathy": {"score": 1, "reason": "..."},
    "coherence": {"score": 1, "reason": "..."},
    "professionalism": {"score": 1, "reason": "..."}
  },
  "overall": {
    "average_score": 1.0,
    "summary": "..."
  },
  "risk_flags": ["如无风险写：无"]
}`;
  return[{role:'system',content:system},{role:'user',content:user}];
}

function cpcdMemoryRecallJudgeMessages(input){
  const taskBrief={task_file:input.task_file??null,task_id:input.task_id??null,task_type:input.task_type??null,case_id:input.case_id??null,question:input.question??null,input_to_model:input.input_to_model||{},reference_answer:input.reference_answer??null,answer_source:input.answer_source||{}},evidence=cpcdJudgeEvidenceBlock(input),system='你是严格的事实回忆评测员。你需要根据评分规则，评估被测模型回答是否准确回忆咨询历史。请特别关注事实准确性、覆盖关键点、时间顺序、以及是否编造不存在的信息。不要因为答案简短就自动扣分；只在关键点缺失、事实错误、顺序混乱或编造时扣分。必须只输出 JSON，不要输出 Markdown 或额外解释。';
  const user=`请评测下面的被测模型回答。

【评分规则】
${input.official_rubric||''}

【任务信息】
${JSON.stringify(taskBrief,null,2)}
${evidence}

【被测模型回答】
${input.model_response||''}

请严格输出以下 JSON 结构，四项分数必须是 0 到 5 的整数：
{
  "scores": {
    "accuracy": 0,
    "completeness": 0,
    "temporal_consistency": 0,
    "no_hallucination": 0
  },
  "rationales": {
    "accuracy": "...",
    "completeness": "...",
    "temporal_consistency": "...",
    "no_hallucination": "..."
  },
  "overall_comment": "..."
}
`;
  return[{role:'system',content:system},{role:'user',content:user}];
}

function cpcdTemporalCausalJudgeMessages(input){
  const taskBrief={task_file:input.task_file??null,task_id:input.task_id??null,task_type:input.task_type??null,case_id:input.case_id??null,question:input.question??null,input_to_model:input.input_to_model||{},reference_answer:input.reference_answer??null,evaluation_focus:input.evaluation_focus||{}},evidence=cpcdJudgeEvidenceBlock(input),system='你是严格的校园心理咨询案例时序—因果推理评测员。你需要根据评分规则、reference_answer、evaluation_focus 和咨询历史，评估被测模型回答。重点关注：事件时间顺序是否正确、因果链条是否合理、关键阶段是否完整、是否编造不存在的信息。不要因为答案风格和参考答案不同就扣分；只在事实错误、顺序混乱、因果断裂、关键遗漏或幻觉时扣分。必须只输出 JSON，不要输出 Markdown 或额外解释。';
  const user=`请评测下面的被测模型回答。

【评分规则】
${input.official_rubric||''}

【任务信息】
${JSON.stringify(taskBrief,null,2)}
${evidence}

【被测模型回答】
${input.model_response||''}

请严格输出以下 JSON 结构，四项分数必须是 0 到 5 的整数：
{
  "scores": {
    "temporal_accuracy": 0,
    "causal_coherence": 0,
    "completeness": 0,
    "no_hallucination": 0
  },
  "rationales": {
    "temporal_accuracy": "...",
    "causal_coherence": "...",
    "completeness": "...",
    "no_hallucination": "..."
  },
  "overall_comment": "..."
}
`;
  return[{role:'system',content:system},{role:'user',content:user}];
}

function cpcdTaskMetadata(input){return{task_id:input.task_id??null,task_type:input.task_type??null,case_id:input.case_id??null,input_to_model:input.input_to_model||{}};}
function cpcdJudgeEvidenceBlock(input){return Array.isArray(input.full_consultation_history)?`\n\n【完整咨询历史证据】\n文件：${input.full_session_file||'unknown'}\n${formatCpcdFullSession(input.full_consultation_history)}\n`:'';}
function formatCpcdContext(context){if(!context)return'无';if(!Array.isArray(context))return String(context);return context.map(turn=>turn&&typeof turn==='object'?`${turn.role||'Unknown'}: ${turn.content||''}`:String(turn)).join('\n');}
function formatCpcdFullSession(messages){if(!Array.isArray(messages))return JSON.stringify(messages,null,2);return messages.map((message,index)=>message&&typeof message==='object'?`[${String(index+1).padStart(4,'0')}] ${message.role||'Unknown'}: ${message.content||''}`:`[${String(index+1).padStart(4,'0')}] ${JSON.stringify(message)}`).join('\n');}
function renderRoleMessages(messages){return`=== System Message ===\n${messages[0].content}\n\n=== User Message ===\n${messages[1].content}`;}

/**
 * 来源：MedLoCoMo 论文 Appendix B.2，逐字 system message。
 * 任务：答案冻结后对 answerable question 做 0/1 LLM-as-Judge。
 * 注意：不得修改文本；官方 user message 是评分输入的紧凑 JSON 序列化。
 */
export const MEDLOCOMO_APPENDIX_B2_JUDGE_SYSTEM_PROMPT=`You are grading candidate answers for short-answer medical benchmark questions.
Judge only from the provided question, gold_answer, and candidate_answer.
Score 1 when the candidate answer is correct.
Score 0 when the candidate answer is false, incorrect, unsupported, incomplete enough to be wrong, or only says it is not answerable.
Return strict JSON with the schema {"judgments": [{"qa_id": "...", "score": 1}]}.
Each score must be exactly one of: 0, 1.
Return exactly one judgment per provided qa_id.`;

// 来源：MedLoCoMo 论文 Appendix B.2；任务：逐字组装首轮 official system/user Judge messages。
export function medLoCoMoJudgeMessages(input={}){
  return[{role:'system',content:MEDLOCOMO_APPENDIX_B2_JUDGE_SYSTEM_PROMPT},{role:'user',content:JSON.stringify(input)}];
}

// 来源：MedMemoryBench 附录 TLA Judge Prompt；任务：判断时间点或指定时间事件是否正确。
function appendixTemporalJudgePrompt({question,expected_answer,explanation,model_output}){return`You are a strict medical dialogue evaluation judge. Determine whether the model’s answer correctly addresses the time-related question.

Question: ${question}

Reference Answer: ${expected_answer}

Answer Explanation: ${explanation}

Model’s Answer: ${model_output}

Evaluation Criteria: This is a temporal localization question, which may take one of the following two forms:
1. Asking when a certain event occurred. The model must correctly provide the time point.
2. Asking what happened at a certain time. The model must correctly describe the event content.

Judge strictly:
- If the model’s answer contains the correct time point or the correct event content, judge as [CORRECT].
- If the model’s answer about the time/event does not match the reference answer or fails to answer, judge as [INCORRECT].
- Date formats do not need to be identical, but must refer to the same time point (e.g., “January 1, 2024” and “2024-01-01” are considered equivalent).

Output in the following JSON format:
{"is_correct":true/false,"reason":"brief justification"}

Output JSON only, no other content.`;}

// 来源：MedMemoryBench 附录 SUA Judge Prompt；任务：判断答案是否基于记忆反映患者最新状态。
function appendixStateJudgePrompt({question,expected_answer,explanation,model_output}){return`You are a very strict medical dialogue evaluation judge. Determine whether the model’s answer correctly reflects the patient’s most recent status.

Question: ${question}

Reference Answer: ${expected_answer}

Answer Explanation: ${explanation}

Model’s Answer: ${model_output}

Evaluation Criteria: This is a state update question, testing whether the model correctly answers the latest status based on the patient’s historical information in memory.

Core Evaluation Principles (critically important):
1. Must be based on memory: The model’s answer must demonstrate the use of the patient’s past memory information, not guessing or generic medical knowledge.
2. No guessing allowed: If the model has not retrieved relevant memory information but gives a “coincidentally correct” answer, it should be judged as [INCORRECT].
3. Information source requirement: A correct answer should convey that the model “remembers” this patient’s specific situation, rather than guessing.

Judge strictly:
- If the model’s answer demonstrates the use of patient historical memory and the core content is consistent with the reference answer, judge as [CORRECT].
- If the model’s answer contains key information points from the reference answer, and these clearly originate from patient memory retrieval, judge as [CORRECT].
- If the model’s answer clearly contradicts the reference answer, omits key information, or provides outdated status, judge as [INCORRECT].
- If the model states it does not know or cannot answer, judge as [INCORRECT].
- If the model’s answer appears too generic, lacks specific patient information support, or seems like a guess, even if the content happens to be close to the reference answer, judge as [INCORRECT].

Output in the following JSON format:
{"is_correct":true/false,"reason":"brief justification, must indicate whether the model demonstrated use of patient memory"}

Output JSON only, no other content.`;}

// 来源：MedMemoryBench 附录 IG Judge Prompt；任务：评估患者特异信息使用、推理质量与结论方向。
function appendixInferenceJudgePrompt({question,expected_answer,explanation,metadata={},model_output}){return`You are a very strict medical dialogue evaluation judge. Determine whether the model’s reasoning answer is correct.

Question: ${question}

Reference Answer: ${expected_answer}

Answer Explanation: ${explanation}
${inferenceMetadataInfo(metadata)}

Model’s Answer: ${model_output}

Evaluation Criteria: This is an inference generation question, testing whether the model can perform correct medical reasoning based on patient-specific information.

Core evaluation points:
1. Patient Information Utilization (Key)
- The model must demonstrate the use of patient-specific information from memory.
- If required_patient_info is provided in metadata, the model’s answer must reflect understanding of these key pieces of information (important).
- If the patient’s specific circumstances and past memories are ignored or missing, judge as [INCORRECT].

2. Reasoning Quality
- The model must reason based on retrieved patient historical information, not purely from its own medical common sense.
- If only a conclusion is given without sufficient reference to patient information and memory, judge as [INCORRECT].
- If the model gives a “common wrong answer” type of response (generic advice), judge as [INCORRECT].

3. Conclusion Correctness
- The final recommendation/conclusion should be fully consistent with the reference answer in direction.
- Even if the conclusion is correct, if it lacks reasoning based on patient information, still judge as [INCORRECT].

Judgment rules:
- [CORRECT]: Answer uses patient-specific information, contains required patient information points, and reaches an accurate conclusion.
- [INCORRECT]: Answer does not adequately consider the patient’s specific circumstances.
- [INCORRECT]: Answer ignores certain key information in required_patient_info.
- [INCORRECT]: Answer matches the common_wrong_answer pattern.
- [INCORRECT]: Model refuses to answer or claims no information.

Output in the following JSON format:
{"is_correct":true/false,"reason":"brief justification"}

Output JSON only, no other content.`;}

// 来源：MedMemoryBench 附录 MCD Judge Prompt；任务：逐节点评估 NCR、CRC、CC 与多跳链完整性。
function appendixMultiHopJudgePrompt({question,expected_answer,explanation,metadata={},model_output}){return`You are an extremely strict medical multi-hop reasoning evaluation judge. Your task is to rigorously verify whether the model truly retrieved and used specific information from the patient’s historical memory to perform multi-hop clinical reasoning.

Question: ${question}

Reference Answer: ${expected_answer}

Answer Explanation: ${explanation}
${reasoningNodesForValidation(metadata)}
${requiredMemoryNodes(metadata)}
Reasoning Hops: ${metadata.hop_count||0}
Reasoning Pattern: ${metadata.reasoning_pattern||''}

Model’s Answer: ${model_output}

Evaluation Task: Strict Node-by-Node Reasoning Chain Verification

This is a multi-hop clinical reasoning question. The core assessment is whether the model can accurately retrieve and use specific personalized medical information from the patient’s historical memory.

Key Evaluation Principles (must be strictly followed)
1. Patient-Specific Information Principle: The model must explicitly reference the patient’s specific data (such as specific test values, medication dosages, specific timing of symptom onset, particular diagnostic results), rather than giving generic medical common sense.
- “Poor blood sugar control may lead to...” is generic medical knowledge, not patient-specific information.
- “Your fasting blood glucose rose from 6.8 to 8.2...” is patient-specific information.
2. Memory Retrieval Evidence Principle: If the model fails to demonstrate specific references to the patient’s historical records, even if the reasoning direction is correct, it should be judged as inadequate. The model must show it “remembers” the patient’s specific situation.
3. Strict Causal Chain Correspondence Principle: The causal relationships established by the model must precisely correspond to the causal mechanisms described in the reasoning chain nodes. Similar but different mechanisms cannot substitute.
4. Node Content Precise Matching Principle: During node verification, it is not sufficient to judge as “covered” merely because the model mentioned a related concept. You must verify whether the model referenced the core specific content within the node.

Evaluation Steps

Step 1: Strict Node-by-Node Check
For each node in the reasoning chain, all of the following conditions must be verified:

Condition A - Specific Information Match:
- Did the model mention the specific data/time/event in this node?
- If the node contains specific values (e.g., “TSH 0.02”), the model must mention the same or equivalent value.
- If the node contains a specific time (e.g., “October 2024”), the model must demonstrate awareness of that time point.
- Merely mentioning the related concept (e.g., “thyroid function”) without specific data does not count as coverage.

Condition B - Correct Causal Mechanism:
- Does the causal mechanism described by the model exactly match the reference reasoning chain?
- Using a different pathophysiological explanation (even if it sounds reasonable) does not count as correct.
- Skipping intermediate steps to reach a conclusion directly does not count as correct.

Condition C - Clear Information Source:
- Does the model’s answer clearly demonstrate that this information comes from the patient’s historical memory?
- Inferences based purely on medical common sense cannot receive credit.

Step 2: Calculate Three Scoring Dimensions (Strict Standards)

NCR (Node Coverage Rate) = Number of nodes fully satisfying Condition A / Total number of nodes
- Mentioning concept only without specific data: node not counted as covered.
- Incorrect data or mismatched timeline: node not counted as covered.

CRC (Causal Relation Correctness) = Number of correctly established causal links / Number of expected causal links
- Must be the causal mechanism described in the reference answer; equivalent substitutions are not accepted.
- Causal links skipping intermediate nodes receive no credit.

CC (Chain Completeness)
- 1.0 = Complete coverage of all nodes with correct causal relations.
- 0.7 = Coverage of 80%+ nodes, core causal relations correct.
- 0.5 = Coverage of 60%+ nodes, main causal relations correct.
- 0.3 = Partial node coverage, causal relations have gaps.
- 0.0 = No valid reasoning chain or completely wrong direction.

Step 3: Comprehensive Judgment (High Standards)

[CORRECT] Conditions (all must be satisfied simultaneously):
- NCR >= 0.75.
- CRC >= 0.75.
- CC >= 0.7.
- Final conclusion consistent with the reference answer.

[PARTIALLY CORRECT] Conditions:
- NCR >= 0.5 and CRC >= 0.5 and CC >= 0.5.
- Main reasoning direction correct, but with notable gaps.

[INCORRECT] Conditions (any one triggers incorrect judgment):
- Model failed to retrieve patient-specific information from memory.
- Reasoning based on generic medical knowledge rather than patient-specific situation.
- Causal mechanism inconsistent with reference answer.
- Conclusion direction incorrect.
- NCR < 0.5 or CRC < 0.5 or CC < 0.5.

Output Format
Output your strict evaluation result in the following JSON format:
{"node_validations":[{"node_id":1,"mentioned":true/false,"specific_data_matched":true/false,"causal_link_correct":true/false,"note":"Must state: 1) What specific data the model mentioned 2) Whether it precisely matches node content 3) Whether the causal relation is correct"}],"ncr_score":0.0,"crc_score":0.0,"cc_score":0.0,"memory_retrieval_quality":"excellent/good/partial/poor/none","uses_patient_specific_info":true/false,"is_correct":true/false,"reason":"Comprehensive justification, must state: 1) Whether the model used patient-specific information 2) Which nodes were not covered 3) Whether the causal chain is complete"}

Output JSON only, no other content.`;}

function inferenceMetadataInfo(metadata={}){const lines=[];if(metadata.inference_type)lines.push(`Inference type: ${metadata.inference_type}`);const trap=metadata.trap_design;if(trap?.trap_mechanism)lines.push(`Trap mechanism: ${trap.trap_mechanism}`);if(Array.isArray(trap?.required_patient_info))lines.push(`Required patient info: ${trap.required_patient_info.join(', ')}`);const wrong=metadata.common_wrong_answer;if(wrong){lines.push(`Common wrong answer: ${wrong.content||''}`);lines.push(`Error reason: ${wrong.why_wrong||''}`);}return lines.join('\n');}
function reasoningNodesForValidation(metadata={}){const chain=Array.isArray(metadata.reasoning_chain)?metadata.reasoning_chain:[];if(!chain.length)return'';return`Nodes for validation:\n${chain.map((node,index)=>`Node ${node?.node_id??index+1}: Source Session ${node?.session_id??'?'} (${node?.source_info||''}); Role: ${node?.role||''}; Content: ${node?.content||''}`).join('\n')}`;}
function requiredMemoryNodes(metadata={}){const required=Array.isArray(metadata.required_memory_nodes)?metadata.required_memory_nodes:[];return required.length?`Required memory nodes:\n${required.map(node=>`- ${node}`).join('\n')}`:'';}
