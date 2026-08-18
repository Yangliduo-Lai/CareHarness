import { STATE_FAMILIES } from './schema.js';

const ROUTER_TAXONOMY=JSON.stringify({families:STATE_FAMILIES});

// Single editing surface for every benchmark answer contract. Adapters select
// entries by benchmark + task; they must not carry prompt prose of their own.
export const BENCHMARK_ANSWER_PROMPTS=Object.freeze({
  default:Object.freeze({
    default:Object.freeze({
      language:'match the question language',
      grounding:'Use only the supplied State, Evidence, and visible benchmark protocol context. Never use Gold answers or hidden evaluator references.',
      format:'Answer the question directly and concisely, covering every necessary point without adding unsupported facts.'
    })
  }),
  medmemorybench:Object.freeze({
    default:Object.freeze({
      language:'zh-CN',
      grounding:'只能依据提供的 State 和 Evidence，不得使用 Gold、答案或 source key points。',
      format:'使用中文直接回答问题，内容简洁但覆盖所有必要要点。'
    }),
    entity_exact_match:Object.freeze({format:'只返回问题所问的中文实体名称，不要解释。'}),
    temporal_localization:Object.freeze({format:'只返回最精确的事件时间，格式必须为 YYYY-MM-DD HH:mm:ss；优先使用相关 State 的 event_time，不得只回答月份。'}),
    state_update:Object.freeze({format:'使用中文回答目标对象的最新状态。先明确给出当前状态，再用一句话简要说明支持该状态的患者历史记录或状态变化；不要复述无关病史或其他药物。'}),
    multiple_choice:Object.freeze({format:'只返回所有正确选项字母，使用英文逗号分隔，例如 A, B；多选不得遗漏。'}),
    inference_generation:Object.freeze({
      grounding:'患者特异性事实只能来自提供的 State 和 Evidence，不得使用 Gold、答案、source key points 或其他隐藏评判信息。可以使用一般医学知识解释已检索的患者信息并形成临床推理或候选建议，但不得用通用知识替代患者记忆、虚构患者病史，或违反输入中的禁忌和安全边界。',
      format:'使用中文直接回答问题。先给出明确结论或建议，再用简洁的患者特异性推理说明依据和可执行的下一步。必须综合 State 和 Evidence 中所有与决策直接相关的信息，并说明它们如何共同支持结论；根据问题特别检查既往风险与禁忌、当前治疗与依从性、治疗反应与纵向变化、当前症状与客观结果、患者偏好与照护计划，但只写与当前判断有关且输入中实际存在的内容。不得只给结论、只凭单一症状或检查值下判断，也不得用泛化医学常识或通用建议替代对患者记忆的分析。当纵向记录显示治疗失效、快速恶化、重要禁忌或其他与常见处理相冲突的情况时，必须显式处理该冲突，不得套用表面上合理的常见答案。如关键决策信息不足，不得编造患者事实或给出确定的自行用药、停药或调量指令；应说明限制并给出保守的评估或就医建议。'
    }),
    multi_hop_clinical_deduction:Object.freeze({
      grounding:'患者特异性事实只能来自提供的 State 和 Evidence，不得使用 Gold、标准答案、答案说明、source key points、隐藏推理链或其他评分信息。必须区分“患者证据锚点”和“临床机制桥梁”：患者的事件、时间、数值、诊断、用药、症状及变化只能作为可追溯的证据锚点；病理生理、药理或行为机制可以由一般医学知识补全，即使病历没有逐字写出，但只能用于连接链条前后的患者锚点，并且必须与患者的时间线、诊断、用药、依从性、治疗反应及客观结果一致。先静默筛选证据：只保留目标患者本人的记录，排除亲属、其他患者、通用病例、假设情形和泛化医学教育；严格区分肯定、否定与不确定表述，并结合时间和版本判断当前状态。优先采用 State 和 Evidence 已明确支持的诊断、药理或具体机制，不得用宽泛但不同的机制替代，不得据此补造患者未记录的诊断、检查结果、数值、时间、用药、症状或生活事件。先比较可能的解释，选择唯一一条能同时解释最多时间点、客观数值、治疗变化和反常表现且不与任何强证据冲突的主链；不得因单个较早改善、单次正常结果或表面相似症状忽略后续恶化与相反证据，也不得无证据新增其他诊断或后遗症。若关键患者锚点缺失、冲突或时序不明，必须明确证据边界，不能用医学常识填补；但不得仅因机制未在病历中逐字出现，就省略解释已知患者事实所必需的中间机制。',
      format:'传输层必须严格返回 {"answer":"非空字符串"}，JSON 外不得输出任何字符；下面三部分只能出现一次并全部位于 answer 字符串内。answer 使用中文，正文建议控制在 450–800 个汉字。作答前完整扫描全部 State 和 Evidence，先找出跨时间点、共同解释问题的最小充分患者证据集合，再比较因果路径，不要停在第一个表面合理的解释。严格按以下结构组织：\n1. 患者记忆：按“起始情况 → 关键转折 → 最新或终点表现”组织；在证据足够时只选 3–6 条最具因果判别力的患者事实，并至少覆盖两个不同时间点，优先纳入治疗或暴露、纵向变化、客观检查或诊断、终点症状。保留原有日期或时间、数值及单位、药名和剂量、检查结果、阴性信息与变化方向；题目刚提供的现状不能代替历史记忆证据。用日期加事实引用，不得复制内部 State/Evidence ID 或元数据。\n2. 推理链：只写一条从上游诱因、基础状态或治疗变化到题目所问当前表现或结局的连续主链；在证据足够时拆成 3–5 个因果 hop，每个 hop 都采用“患者具体事实 → 生理或病理机制 → 下一项患者具体事实”的形式。机制必须具体到相关药物作用、器官、代谢、激素、神经或微血管过程，并说明它如何导致下一步，避免只写“有关、影响、协同作用、后遗症、生活方式”等空泛连接。链条必须解释题目中的纵向变化和反常现象；不得从起点直接跳到结论，不得用常见但证据更弱的解释替代患者记录支持的主链。\n3. 结论：用 1–2 句话直接回答所问的关联或判断，第一句给出方向与核心机制，并用最关键的患者锚点限定证据强度和必要的不确定性。不得仅因缺少实验性因果证明就否定已有时间关联、重复模式和相容机制；除非问题明确询问处理方案，否则不要添加检查、复诊或治疗建议。\n输出前在内部从起点到结局、再从结局到起点核对：主体确为目标患者；早期、转折和最新事实没有倒置；每个患者事实均可追溯到输入；每个机制确实连接相邻事实；结论与最完整的纵向证据一致。不要输出这份核对过程，不要写前言、后记、自我修正、评分说明、Markdown 代码块或第二份答案/JSON。'
    })
  }),
  medlocomo:Object.freeze({
    default:Object.freeze({
      language:'en',
      grounding:'Use only the retrieved State and Evidence from the patient timeline. Do not use Gold answers, hidden benchmark evidence annotations, inspection-only summaries, or facts not supported by the patient record.',
      format:'Return only a short English answer of at most 10 words. Do not explain, restate the question, or add a wrapper.'
    }),
    adversarial:Object.freeze({format:'If the record does not support the requested answer, return exactly: the question is not answerable'}),
    longitudinal_progression:Object.freeze({format:'Return only the requested chronological progression, in at most 10 words.'}),
    care_plan_rationale:Object.freeze({format:'Return only the documented care-plan reason, in at most 10 words.'}),
    cross_admission_comparison:Object.freeze({format:'Return only the requested cross-admission comparison, in at most 10 words.'}),
    medical_reasoning:Object.freeze({format:'Return only the patient-specific clinical conclusion, in at most 10 words.'}),
    frequency_pattern:Object.freeze({format:'Return only the requested count or frequency, in at most 10 words.'})
  }),
  medilongchat:Object.freeze({
    default:Object.freeze({
      language:'en',
      grounding:'Use only the supplied State/Evidence and question. The public release does not expose the paper task annotations, so never claim this run is an official-paper result.',
      format:'Return a short direct answer without explanation.'
    }),
    in_dialogue_reasoning:Object.freeze({format:'Return only the requested fact from the single encounter.'}),
    cross_dialogue_reasoning:Object.freeze({format:'Return only the requested cross-encounter fact or comparison.'}),
    synthesis_reasoning:Object.freeze({format:'Return exactly one option letter: A, B, C, or D.'})
  }),
  cpcdbench:Object.freeze({
    default:Object.freeze({
      language:'zh-CN',
      grounding:'只能使用官方 input_to_model 和检索到的 State/Evidence。不得使用 reference_answer、evaluation_focus 或评分理由；这些内容只在答案冻结后提供给评分 Judge。',
      format:'直接用中文完成题目，不输出分析标题、评分或 JSON。'
    }),
    session_level_response_generation:Object.freeze({format:'只输出咨询师下一轮回复，保持温和、真诚、专业且有风险敏感性；优先深层共情并承接长期轨迹，避免说教、保证或越界替学生做决定。建议 1–2 段，可用一个开放式问题收束。'}),
    memory_recall:Object.freeze({format:'准确、完整地回答事实回忆问题，保留题目要求的时间、人物、地点、事件、数值和状态，不添加记录中不存在的信息。'}),
    temporal_causal_reasoning:Object.freeze({format:'按时间顺序说明关键事件，并明确连接诱因、放大因素、维持因素和结果；覆盖必要节点，不编造咨询历史之外的信息。'})
  }),
  muspsy:Object.freeze({
    default:Object.freeze({
      language:'match the benchmark protocol input',
      grounding:'Follow only the supplied MusPsy protocol_input and retrieved State/Evidence. Never use the gold output, and never treat Last Memory as a new patient quote or observation.',
      format:'Return only the artifact requested by the task instruction, with no scoring commentary or extra wrapper.'
    }),
    task_1:Object.freeze({format:'Produce the counseling-memory artifact requested by the Task 1 instruction. Preserve the requested structure and include only supported information.'}),
    task_2:Object.freeze({format:'Produce the counseling goal or planning artifact requested by the Task 2 instruction. Preserve the requested structure and ground it in the supplied context.'}),
    task_3:Object.freeze({format:'Produce only the counselor response requested by Task 3 for the latest User input. Use Last Memory only as protocol context and do not expose it as a patient quotation.'})
  }),
});

export function benchmarkAnswerContract(benchmark,task){
  const common=BENCHMARK_ANSWER_PROMPTS.default.default,group=BENCHMARK_ANSWER_PROMPTS[String(benchmark||'').toLowerCase()]||BENCHMARK_ANSWER_PROMPTS.default,specific=group[String(task||'')]||group.default||{};
  return{...common,...(group.default||{}),...specific};
}

export const BENCHMARK_QUESTION_PROMPTS=Object.freeze({});

export function benchmarkQuestionPrompt(benchmark,task){
  const template=BENCHMARK_QUESTION_PROMPTS[String(benchmark||'').toLowerCase()];
  if(!template)throw new Error(`No generated benchmark question prompt for ${benchmark||'unknown benchmark'}`);
  return template.replaceAll('{{task}}',String(task||''));
}

export const PROMPTS = Object.freeze({
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
  updater: { version: 'updater.family-owned.v2', description: 'Each State family independently maintains its own versioned memory.' },
  generator: { version: 'generator.policy-memory.compact.v4', description: 'Write the Doctor Agent response for the fixed Action Policy using only the current Patient message and supplied memory.', contract: `Return only {"response":"non-empty user-facing string"}. Do not change the action or invent facts. Code fixes action_type and citations.` },
  auditor: { version: 'auditor.policy.compact.v4', description: 'Audit the response against the Action Policy constraints.', contract: `Return only {"passed":true,"violations":[],"safe_response":"string"}. Do not assume any Gate output; Gates are disabled.` },
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
  medmemory_judge: { version: 'medmemorybench-official-judge.7227bc1', description: 'Official MedMemoryBench post-answer LLM-as-Judge prompt.', render: renderMedMemoryJudgePrompt },
  medlocomo_judge: { version: 'medlocomo-official-answerable-judge.v1', description: 'Official MedLoCoMo post-answer Judge prompt for answerable questions.', render: renderMedLoCoMoJudgePrompt, messages: medLoCoMoJudgeMessages },
  cpcd_judge:{version:'cpcd-bench-official-rubric.v1',description:'Official CPCD-Bench post-answer LLM-as-Judge rubric.',render:renderCpcdJudgePrompt},
  judge: { version: 'judge.task-contract.v4', description: 'Answer a benchmark task outside the core state pipeline using only the supplied visible State, Evidence, protocol context, and enabled decision-gate output. Follow answer_contract exactly when present, including its language and output format.', contract: `When decision_gates is present, use it as a grounded decision layer in this strict order: clinical_need_and_safety, understanding_and_clarification, preference_and_feasibility. Clinical hard constraints and must_escalate take precedence; clarification targets determine whether the answer should ask, verify, or educate; preference ranking may only choose from the clinically safe feasible set. Gate output never authorizes facts outside its cited visible State/Evidence, and internal State/Evidence IDs must not appear in the answer. Return {"answer":"non-empty string"}. Be concise, answer only what was asked, and do not return scores or explanations outside answer. Gold answers and hidden reference key points are never available; do not infer that they were supplied.` }
});

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

// Official MedMemoryBench post-answer Judge templates. Keep these here so all
// model-facing prompt prose has one source of truth. The scoring implementation
// remains in medmemory-official.js and re-exports this renderer for compatibility.
export function renderMedMemoryJudgePrompt(input={}){
  const task=input.query_type;
  if(task==='temporal_localization')return temporalJudgePrompt(input);
  if(task==='state_update')return stateJudgePrompt(input);
  if(task==='inference_generation')return inferenceJudgePrompt(input);
  if(task==='multi_hop_clinical_deduction')return multiHopJudgePrompt(input);
  throw new Error(`No official MedMemoryBench judge prompt for ${task||'unknown task'}`);
}

export function renderMedLoCoMoJudgePrompt(input={}){
  const messages=medLoCoMoJudgeMessages(input);
  return`=== System Message ===
${messages[0].content}

=== User Message ===
${messages[1].content}`;
}

export function renderCpcdJudgePrompt(input={}){
  const labels={session_level_response_generation:'会话级咨询回复生成',memory_recall:'长期记忆回忆',temporal_causal_reasoning:'时序—因果推理'},dimensions=Array.isArray(input.dimensions)?input.dimensions:[],isSrg=input.task_type==='session_level_response_generation',minimum=isSrg?1:0,sourceRule=isSrg?'按官方默认，只参考 SR task input、evaluation_focus、官方 rubric 与被测回复；不使用 reference_answer 或 full consultation history。':input.task_type==='memory_recall'?'按官方默认，参考问题、完整咨询历史、evaluation_focus、官方 rubric 与被测回答；不使用 reference_answer。':'参考 reference_answer、evaluation_focus、完整咨询历史、官方 rubric 与被测回答；reference_answer 是高分方向，不要求逐字相似。';
  return `你是严格、审慎的 CPCD-Bench 校园心理咨询评测员。任务类型：${labels[input.task_type]||input.task_type}。\n\n评分规则：\n1. 只按 dimensions 中的官方维度逐项评分；每项必须是 ${minimum}–5 的整数，并给出简短、可核验理由。\n2. ${sourceRule}\n3. 必须逐条遵循 official_rubric。不要因语言流畅或篇幅长自动给高分；事实、时序、长期连贯性、专业边界和幻觉须按任务 rubric 严格判断。\n4. ${minimum} 表示该量表最低档；5 表示完整满足。\n5. 只返回严格 JSON，不使用 Markdown。\n\n输出结构：\n{"task_id":"${String(input.task_id||'')}","scores":{${dimensions.map(key=>`"${key}":{"score":${minimum},"reason":"..."}`).join(',')}},"overall":{"average_score":${minimum},"summary":"..."},"risk_flags":[]}\n\n评分输入：\n${JSON.stringify(input)}`;
}

function medLoCoMoJudgeMessages(input={}){
  return[{role:'system',content:`You are grading candidate answers for short-answer medical benchmark questions.
Judge only from the provided question, gold_answer, and candidate_answer.
Score 1 when the candidate answer is correct.
Score 0 when the candidate answer is false, incorrect, unsupported, incomplete enough to be wrong, or only says it is not answerable.
Return strict JSON with the schema {"judgments": [{"qa_id": "...", "score": 1}]}.
Each score must be exactly one of: 0, 1.
Return exactly one judgment per provided qa_id.`},{role:'user',content:JSON.stringify(input)}];
}

function temporalJudgePrompt({question,expected_answer,explanation,model_output}){return`你是一个严格的医疗对话评测裁判。请判断模型的回答是否正确回答了时间相关的问题。

【问题】
${question}

【标准答案】
${expected_answer}

【答案说明】
${explanation}

【模型回答】
${model_output}

【评判标准】
这是一个时间定位类问题，可能是以下两种形式之一：
1. 询问某事件发生的时间 → 模型需要正确回答时间点
2. 询问某时间发生了什么事件 → 模型需要正确回答事件内容

请严格判断：
- 如果模型回答包含了正确的时间点或正确的事件内容，判定为【正确】
- 如果模型回答的时间/事件与标准答案不符或未能回答，判定为【错误】
- 时间格式可以不完全一致，但必须指向同一时间点（如"2024年1月1日"和"2024-01-01"视为相同）

请按以下 JSON 格式输出：
{"is_correct": true/false, "reason": "简要判断理由"}

只输出 JSON，不要有其他内容。`;}

function stateJudgePrompt({question,expected_answer,explanation,model_output}){return`你是一个非常严格的医疗对话评测裁判。请判断模型的回答是否正确反映了患者的最新状态。

【问题】
${question}

【标准答案】
${expected_answer}

【答案说明】
${explanation}

【模型回答】
${model_output}

【评判标准】
这是一个状态更新类问题，考察模型是否基于记忆中的患者历史信息正确回答最新状态。

⚠️ 核心评判原则（极其重要）：
1. **必须基于记忆回答**：模型的回答必须体现出对患者过往记忆信息的使用，而不是凭猜测或通用医学知识回答。
2. **禁止猜测回答**：如果模型没有检索到相关记忆信息，却给出了"碰巧正确"的答案，应判定为【错误】。
3. **信息来源要求**：正确的回答应该能让人感受到模型是"记得"这个患者的具体情况，而不是在猜测。

请严格判断：
- 如果模型回答体现了对患者历史记忆的使用，且核心内容与标准答案一致，判定为【正确】
- 如果模型回答包含了标准答案的关键信息点，且这些信息明显来自对患者记忆的检索，判定为【正确】
- 如果模型回答与标准答案有明显矛盾、遗漏关键信息、或给出了过时的状态，判定为【错误】
- 如果模型表示不知道或无法回答，判定为【错误】
- ⚠️ 如果模型的回答看起来过于泛泛、缺乏具体患者信息的支撑、像是凭猜测给出的答案，即使内容碰巧与标准答案相近，也应判定为【错误】

请按以下 JSON 格式输出：
{"is_correct": true/false, "reason": "简要判断理由，需说明模型是否体现了对患者记忆的使用"}

只输出 JSON，不要有其他内容。`;}

function inferenceJudgePrompt({question,expected_answer,explanation,metadata={},model_output}){let metadataInfo='';if(metadata.inference_type)metadataInfo+=`\nInference type: ${metadata.inference_type}`;const trap=metadata.trap_design;if(trap?.trap_mechanism)metadataInfo+=`\nTrap mechanism: ${trap.trap_mechanism}`;if(Array.isArray(trap?.required_patient_info))metadataInfo+=`\nRequired patient info: ${trap.required_patient_info.join(', ')}`;const wrong=metadata.common_wrong_answer;if(wrong){metadataInfo+=`\nCommon wrong answer: ${wrong.content||''}`;metadataInfo+=`\nError reason: ${wrong.why_wrong||''}`;}return`你是一个非常严格的医疗对话评测裁判。请判断模型的推理回答是否正确。

【问题】
${question}

【标准答案】
${expected_answer}

【答案说明】
${explanation}
${metadataInfo}

【模型回答】
${model_output}

【评判标准】
这是一个推理生成类问题，考察模型是否能基于患者个人信息进行正确的医学推理。

核心评判要点：

1. **患者信息利用（关键）**
   - 模型必须体现对记忆中患者特定信息的使用
   - 如果metadata中提供了required_patient_info，模型回答必须反映出对这些关键信息的理解（重要）
   - 患者的具体情况和过往记忆如有忽略和缺漏，则判定为【错误】

2. **推理质量**
   - 模型必须基于检索到的患者历史信息展开推理，而不是单纯根据自己的医学常识见解
   - 仅给出结论，而对患者信息和记忆的引用不够充分，判定为【错误】
   - 如果模型给出了"常见错误答案"类型的回答（通用建议），判定为【错误】

3. **结论正确性**
   - 最终建议/结论应与标准答案方向完全一致
   - 即使结论正确，但如果缺乏基于患者信息的推理，仍判定为【错误】

判定规则：
- 【正确】：回答使用了患者的特定信息，包含了所需的患者信息要点，且得出了准确无误的结论
- 【错误】：回答未考虑充分患者的具体情况
- 【错误】：回答忽略了required_patient_info中的某些关键信息
- 【错误】：回答符合common_wrong_answer的模式
- 【错误】：模型拒绝回答或声称没有信息

请按以下 JSON 格式输出：
{"is_correct": true/false, "reason": "简要判断理由"}

只输出 JSON，不要有其他内容。`;}

function multiHopJudgePrompt({question,expected_answer,explanation,metadata={},model_output}){const chain=Array.isArray(metadata.reasoning_chain)?metadata.reasoning_chain:[],required=Array.isArray(metadata.required_memory_nodes)?metadata.required_memory_nodes:[];let nodes='';if(chain.length){nodes='\n[Reasoning chain nodes (to be verified one by one)]\n';for(let index=0;index<chain.length;index++){const node=chain[index]||{};nodes+=`\nNode ${node.node_id??index+1}:\n  - Source: Session ${node.session_id??'?'} (${node.source_info||''})\n  - Role: ${node.role||''}\n  - Content: ${node.content||''}\n`;}}let requiredText='';if(required.length){requiredText='\n[Information that must be recalled from memory]\n';for(const node of required)requiredText+=`- ${node}\n`;}return`你是一个**极其严格**的医疗多跳推理评测裁判。你的任务是严格验证模型是否真正从患者历史记忆中检索并使用了具体信息来进行多跳临床推理。

【问题】
${question}

【标准答案】
${expected_answer}

【答案说明】
${explanation}
${nodes}
${requiredText}
【推理跳数】: ${metadata.hop_count||0}
【推理模式】: ${metadata.reasoning_pattern||''}

【模型回答】
${model_output}

---

## 评测任务：严格逐节点验证推理链

这是一个多跳临床推理问题，**核心考察点是模型是否能从患者历史记忆中准确检索并使用具体的个人化医疗信息**。

### ⚠️ 关键评判原则（必须严格遵守）

1. **患者特定信息原则**：模型必须明确引用患者的**具体数据**（如具体的检查数值、用药剂量、症状出现的具体时间、特定的诊断结果等），而不是给出泛泛的医学常识。
   - ❌ "血糖控制不好可能导致..." → 这是通用医学知识，不是患者特定信息
   - ✅ "您的空腹血糖从6.8升高到8.2..." → 这是患者特定信息

2. **记忆检索证据原则**：如果模型未能体现出对患者历史记录的具体引用，即使推理方向正确，也应判定为**不合格**。模型必须展示它"记得"患者的具体情况。

3. **因果链严格对应原则**：模型建立的因果关系必须与【推理链节点】中描述的因果机制**精确对应**，不能用相似但不同的机制替代。

4. **节点内容精确匹配原则**：节点验证时，不能仅因为模型提到了相关概念就判定为"covered"，必须验证模型是否提及了节点中的**核心具体内容**。

---

## 评判步骤

### 步骤1：严格逐节点检查
对【推理链节点】中的每个节点，必须验证以下所有条件：

**条件A - 具体信息匹配**：
- 模型是否提及了该节点中的**具体数据/时间/事件**？
- 如果节点包含具体数值（如"TSH 0.02"），模型必须提及相同或等价的数值
- 如果节点包含具体时间（如"2024年10月"），模型必须体现对该时间点的认知
- 仅提及相关概念（如"甲状腺功能"）而无具体数据，**不算覆盖**

**条件B - 因果机制正确**：
- 模型描述的因果机制是否与标准推理链**完全一致**？
- 使用了不同的病理生理解释（即使听起来合理）**不算正确**
- 跳过中间环节直接得出结论**不算正确**

**条件C - 信息来源明确**：
- 模型的回答是否明确体现了这是来自患者历史记忆的信息？
- 纯粹基于医学常识的推断**不能得分**

### 步骤2：计算三个评分维度（严格标准）

**NCR (节点覆盖率)** = 完全满足条件A的节点数 / 总节点数
- 仅提及概念但无具体数据 → 该节点不计入覆盖
- 数据有误或时间对不上 → 该节点不计入覆盖

**CRC (因果关系正确性)** = 正确建立的因果链接数 / 应有的因果链接数
- 必须是标准答案中描述的因果机制，不接受"等效替代"
- 跳过中间节点的因果链接 → 不计分

**CC (推理链完整性)**
- 1.0 = 完整覆盖所有节点且因果关系正确
- 0.7 = 覆盖80%以上节点，核心因果关系正确
- 0.5 = 覆盖60%以上节点，主要因果关系正确
- 0.3 = 部分节点覆盖，因果关系有缺失
- 0.0 = 无有效推理链或方向完全错误

### 步骤3：综合判定（高标准）

**【正确】条件（必须同时满足）**：
- NCR >= 0.75（至少覆盖四分之三的节点的具体内容）
- CRC >= 0.75（因果关系基本完整且正确）
- CC >= 0.7（推理链基本完整）
- 最终结论与标准答案一致

**【部分正确】条件**：
- NCR >= 0.5 且 CRC >= 0.5 且 CC >= 0.5
- 主要推理方向正确，但有明显缺失

**【错误】条件（满足任一即判错）**：
- 模型未能从记忆中检索出患者的具体信息
- 推理基于通用医学知识而非患者特定情况
- 因果机制与标准答案不符
- 结论方向错误
- NCR < 0.5 或 CRC < 0.5 或 CC < 0.5

---

## 输出格式

请按以下 JSON 格式输出你的严格评判结果：
{
    "node_validations": [
        {
            "node_id": 1,
            "mentioned": true/false,
            "specific_data_matched": true/false,
            "causal_link_correct": true/false,
            "note": "必须说明：1)模型提及了哪些具体数据 2)是否与节点内容精确匹配 3)因果关系是否正确"
        }
    ],
    "ncr_score": 0.0-1.0,
    "crc_score": 0.0-1.0,
    "cc_score": 0.0-1.0,
    "memory_retrieval_quality": "excellent/good/partial/poor/none",
    "uses_patient_specific_info": true/false,
    "is_correct": true/false,
    "reason": "综合评判理由，必须说明：1)模型是否使用了患者特定信息 2)哪些节点未被覆盖 3)因果链是否完整"
}

只输出 JSON，不要有其他内容。`;}
