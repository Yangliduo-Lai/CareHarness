import { MEMORY_FAMILIES } from './schema.js';
import { genericClinicalBridgeGrounding,normalizeHypothesisGroundingScope,patientClaimGrounding } from './claim-grounding.js';
import { minimalLiteralSupplement,sanitizeLiteralSupplement } from './literal-supplement.js';
import { MEDLOCOMO_ANSWERABILITY_POLICY,MEDLOCOMO_POLICY_DISTILLATION_HASH,MEDLOCOMO_POLICY_QUESTION_TYPES,medLoCoMoPolicyRecommendation } from './medlocomo-policy.js';
import { MEDMEMORY_INVESTIGATION_STRATEGIES,MEDMEMORY_INVESTIGATION_STRATEGY_VERSION,medMemoryInvestigationStrategy } from './medmemory-policy.js';
export { MEDMEMORY_INVESTIGATION_STRATEGIES,MEDMEMORY_INVESTIGATION_STRATEGY_VERSION,medMemoryInvestigationStrategy };

const ROUTER_TAXONOMY=JSON.stringify({families:MEMORY_FAMILIES});

export const MEDLOCOMO_QUESTION_TYPES=MEDLOCOMO_POLICY_QUESTION_TYPES;
export const MEDLOCOMO_INVESTIGATION_STRATEGY_VERSION=`medlocomo-investigation-strategy.v4-answerability-first-${MEDLOCOMO_POLICY_DISTILLATION_HASH.slice(0,12)}`;
const MEDLOCOMO_ANSWERABILITY_FIRST_DIRECTIVE='First investigate whether the record supports every premise and the exact relation requested by the question. A nearby entity, co-occurrence, later treatment, or the question wording itself is not proof. If targeted verification leaves an essential premise or relation absent or contradicted, mark the question unsupported so the Answer uses canonical abstention. Only then determine the answer.';

/**
 * 来源：MedLoCoMo 全部 101-patient、17,892-question 的同源 oracle 聚合蒸馏；
 * 任务：只在 MedLoCoMo 命名空间内，按公开 question_type 告诉动态 Action Policy
 * 应建立什么证据合同。该产物不是 held-out；运行时不含病例、Gold 或 Evidence 原文。
 */
export const MEDLOCOMO_INVESTIGATION_STRATEGIES=Object.freeze({
  medical_reasoning:Object.freeze({
    strategy_id:'medlocomo_clinical_explanation',...medLoCoMoDistilledControls('medical_reasoning'),disabled_workers:[],
    evidence_contract:['the clinical event or decision named by the question','the documented cause, trigger, finding, or response that explains it','same-Admission context needed to bind cause to outcome'],
    preferred_path:['lock the Admission or date named by the question','search the target event, abnormality, or treatment change','open adjacent turns and search explicit explanatory language','assess the event-to-explanation chain','verify','answer'],
    stop_condition:'The target event and the best source-supported decisive explanation from the same Admission are present.',
    policy_directive:'Stay within the named Admission unless history is explicitly requested. Expand around the event before deciding whether the exact causal or finding relation is supported. When it is supported, freeze the best source-supported explanation.'
  }),
  care_plan_rationale:Object.freeze({
    strategy_id:'medlocomo_plan_rationale',...medLoCoMoDistilledControls('care_plan_rationale'),disabled_workers:[],
    evidence_contract:['the exact intervention, change, or discharge plan','the patient-specific problem or constraint that motivated it','the intended goal or documented response when asked'],
    preferred_path:['lock the named Admission','search the exact intervention or withheld action','search its indication, risk, constraint, goal, or response in adjacent turns','assess the plan-to-rationale pair','verify','answer'],
    stop_condition:'The requested plan and its patient-specific rationale are source-cited as one coherent pair.',
    policy_directive:'Distinguish what was done from why. Prefer the clinician-stated rationale and preserve avoidance, continuation, monitoring, and follow-up qualifiers. When the complete plan-to-rationale relation is supported, return its best source-supported rationale.'
  }),
  longitudinal_progression:Object.freeze({
    strategy_id:'medlocomo_longitudinal_trajectory',...medLoCoMoDistilledControls('longitudinal_progression'),disabled_workers:[],
    evidence_contract:['the requested factor and its documented changes or persistence','source-cited time points that determine the requested outcome','the resulting direction, persistence, resolution, or recurrence'],
    preferred_path:['search the factor across Admissions','retain each decisive time point and its contextual support','order the requested changes and outcome','assess the supported trajectory','verify','answer'],
    stop_condition:'The requested outcome or trajectory is established by the cited records; no unresolved gap could change that answer.',
    policy_directive:'Preserve time-separated endpoints and any intervening event that changes their interpretation. Do not require a record from every visit or reinterpret a background condition as an unstated causal claim. Keep names and dates attached to sources and resolve contradictions chronologically.'
  }),
  cross_admission_comparison:Object.freeze({
    strategy_id:'medlocomo_cross_admission_comparison',...medLoCoMoDistilledControls('cross_admission_comparison'),disabled_workers:[],
    evidence_contract:['the requested factor in each compared Admission','adjacent context for an elliptical or pronoun-dependent turn','a like-for-like comparison axis','the decisive similarity, difference, or change'],
    preferred_path:['identify every comparison side','search the same factor separately in each Admission','open local context for an incomplete turn','align the facts on one shared axis','assess the contrast','verify','answer'],
    stop_condition:'Both comparison sides are source-cited and aligned on the factor requested by the question.',
    policy_directive:'Never answer from one side only or treat retrieval absence as clinical absence. Keep facts separated by Admission until the final comparison, open Context for a reply or pronoun whose antecedent is missing, and preserve decisive paired values. Do not substitute a within-Admission diagnostic change for the requested between-Admission contrast.'
  }),
  frequency_pattern:Object.freeze({
    strategy_id:'medlocomo_frequency_enumeration',...medLoCoMoDistilledControls('frequency_pattern'),disabled_workers:[],
    evidence_contract:['every distinct occurrence of the requested event within scope','deduplication by Admission and event','the resulting count, frequency, or recurrence pattern'],
    preferred_path:['scan the event and its chart synonyms across the full history','build one occurrence-ledger entry per Admission, episode, or site requested','deduplicate repeated summaries','assess the count or pattern only after enumeration','verify','answer'],
    stop_condition:'The full Admission scope has been checked and a complete deduplicated occurrence ledger supports the count or pattern.',
    policy_directive:'Never count a top-k sample or stop at the first match. Search the target event across the full history, preserve at least one candidate from every matching Admission, and add local context when a candidate does not itself prove the event. Count distinct events rather than Memory Nodes, distinguish Admissions from occurrences and sites, and perform another scope-complete search if coverage is uncertain.'
  }),
  adversarial:Object.freeze({
    strategy_id:'medlocomo_answerability_verification',...medLoCoMoDistilledControls('adversarial'),disabled_workers:[],
    evidence_contract:['an exact source-supported answer to every premise required by the question','one orthogonal verification when the first search is empty or only partially supports the premise','canonical abstention when the requested relation or fact remains unsupported'],
    preferred_path:['treat the question as a claim to verify','search the exact claim and its entities inside the stated Admission scope','check negation, alternatives, and one orthogonal wording','assess answerability','verify','answer'],
    stop_condition:'The stated scope has been exhaustively checked for direct support of the requested fact or relation.',
    policy_directive:'Related background or partial premise support is not evidence for the requested relation. Do not infer an undocumented finding. Answer the requested fact when it is supported; otherwise use the canonical abstention only after evidence-based verification.'
  })
});

function medLoCoMoDistilledControls(task){
  const recommendation=medLoCoMoPolicyRecommendation(task);
  if(!recommendation)throw new Error(`No MedLoCoMo distilled policy recommendation for ${task}`);
  return{answer_memory_limit:recommendation.answer_memory_limit,answer_focus_limit:recommendation.answer_focus_limit,evidence_admission_p90:recommendation.derivation?.evidence_admission_p90,reasoning_hypotheses:recommendation.reasoning_hypotheses,target_only_assessment:recommendation.target_only_assessment};
}

export function medLoCoMoInvestigationStrategy(task){
  const profile=MEDLOCOMO_INVESTIGATION_STRATEGIES[String(task||'')];
  return profile?JSON.parse(JSON.stringify({version:MEDLOCOMO_INVESTIGATION_STRATEGY_VERSION,query_type:String(task),...profile,policy_directive:`${MEDLOCOMO_ANSWERABILITY_FIRST_DIRECTIVE} ${profile.policy_directive}`})):null;
}

export function registeredInvestigationStrategy(task,namespace){
  if(namespace==='medmemorybench')return medMemoryInvestigationStrategy(task);
  if(namespace==='medlocomo')return medLoCoMoInvestigationStrategy(task);
  return null;
}

/**
 * 来源：MedMemoryBench 官方附录的 Shared System Prompt。
 * 任务：作为 EEM、TLA、SUA、MQ、IG、MCD 六类 Answer Prompt 的统一 system message。
 */
export const MEDMEMORY_SHARED_SYSTEM_PROMPT=`You are the patient’s personalized medical assistant, capable of accurately memorizing the patient’s complete medical history. Please reason and respond based on patient information in memory, maintain a warm yet professional tone, answer directly, and avoid unnecessarily long explanations.`;

// 来源：CareHarness 本地可读性适配；任务：不改变 MedMemoryBench 的内容与格式要求，
// 仅把 Answer 中供人阅读的自然语言固定为简体中文。
export const MEDMEMORY_CHINESE_ANSWER_REQUIREMENT='Language Requirement: Write all natural-language answer text in Simplified Chinese. Preserve exact medication names, abbreviations, dates, measurements, units, and option letters from the source; for multiple-choice questions, still output option letters only.';

// 来源：CareHarness 针对 MedMemoryBench EEM 严格 string_contain metric 的输出格式补丁；
// 任务：规范数值、单位、限定词、并列形式与题干槽位后缀，不注入任何病例答案。
export const MEDMEMORY_EEM_NUMERIC_FORMAT_PATCH=`EEM Numeric Format Patch:

When the requested target is quantitative, output the value or range in exactly one line using the mandatory format below. Do not add an explanation, sentence prefix, Markdown, or trailing punctuation.

- Non-insulin medication dose → <number>mg
  Convert 毫克 to mg. Do not insert a space.
- Insulin dose → <number>U
  Convert 单位 or 个单位 to U. Do not insert a space. If the question explicitly asks which insulin and its dose, preserve the insulin name before <number>U.
- Blood glucose → <number or range> mmol/L
- eGFR → <number> mL/min/1.73m²
- UACR or ACR → <number> mg/g
- C-peptide → <number> nmol/L
- NT-proBNP → <number> pg/mL
- GADA titre → <number> U/mL
- Blood pressure → <systolic>/<diastolic> mmHg
- VPT → <number or range>V
- IMT → <number> mm
- cfPWV → <number> m/s
- LVMI → <number> g/m²
- HbA1c, oxygen saturation, ECV, or blood-pressure reduction percentage → <number>%
- pH and E/e' → number only
- Walking tolerance → <number>米
- Longitudinal strain → decimal fraction with an ASCII minus sign and no percent symbol; for example, convert -16% to -0.16.
- Repetition frequency per second → <number or range> Hz
  Convert 下/秒 or 次/秒 to Hz. Use an en dash “–” for a range and keep one space before Hz.

Use the exact unit capitalization, slash, superscript ², and spacing shown above. Never output 毫克, 个单位, ㎡, or a bare number for a measurement that requires a unit.

Preserve the original numeric magnitude, decimal places, comparison sign, negative sign, and whether the value is a single value or a range.

EEM Strict-Containment Surface Rules:

- Return only the shortest complete answer span. Do not paraphrase it into a sentence or add a subject such as “症状”, “患者”, or “检查显示”. If a concise chart phrase and a longer synonymous sentence are both visible, copy the concise phrase.
- Preserve every answer-bearing qualifier from the chart: “约/大约”, “以上/以下”, “每日/每次”, negation, direction, and range. Never drop an approximate marker merely because the number is unchanged.
- When the requested frequency is stated as a daily threshold, use the compact form “每日<number>次以上”; do not replace it with “十余次”, parentheses, an example maximum, or a longer explanation.
- For exactly two requested entities, join the two complete entity spans with “与”, with no list punctuation or surrounding prose.
- Match the semantic slot named by the question. If it asks for a region, segment, drug class, dosage form, or another typed entity, retain the explicit slot head/suffix supplied by the question or chart (for example “区”, “段”, “类”, or “片”); do not output only its modifier.
- For an explicitly documented unchanged outcome, prefer the chart’s compact polarity term such as “无改善” over a synonymous full sentence.

These are surface-form rules only. They never permit inventing a missing fact, number, qualifier, entity head, or suffix.`;

// 来源：CareHarness MQ 输出基数补丁，不是论文官方 Prompt；任务：区分题干明确要求的
// 单一最优选择与普通多选，避免“最适宜/最需要/最优先”题输出多个并列答案。
export const MEDMEMORY_MQ_CARDINALITY_PATCH=`MQ Selection Cardinality Patch:
If the question stem explicitly asks which one option is the single best, most appropriate, most necessary, highest-priority, most likely, or similar unique superlative choice (for example, “最适宜”, “最需要”, “最优先”, or “最合适”), output exactly one option letter: the best-supported choice after comparing all options. A superlative word appearing only inside an option does not trigger this rule.
Otherwise, treat the question as multiple-select: assess every option and output all correct option letters.
The option_state_index preserves which independent option investigation retrieved each historical State, while selected_states contains one deduplicated copy of every State. The index is not a verdict or an exclusivity rule: read every selected State and apply it to every option whose meaning it directly supports or contradicts, even when another option's investigation originally retrieved it. These are source States, not Assessor conclusions. Judge every visible option independently from the exact State text, the visible recent Sessions, and the patient profile.
You are explicitly allowed and expected to use established general medical knowledge as a decision source when evaluating each option, even when that general rule is not restated verbatim in a State. This includes standard indications, contraindications, drug-class effects and interactions, renal-risk precautions, and the appropriateness of routine non-drug measures. Combine that knowledge with patient-specific premises from the question and supplied memory. Do not require an otherwise correct option to have verbatim support in memory. General medical knowledge must not invent a patient diagnosis, measurement, medication exposure, preference, or event, and an explicit current patient-specific plan or constraint overrides a generic default.
For non-superlative questions, do not stop after finding one safe or directly documented option: complete the internal check for every option and return the full set that is clinically appropriate after combining the visible patient facts with general medical knowledge.`;

// 来源：CareHarness 对可见 Memory Node 的查询局部证据合同；任务：把 Assessor 已经用
// 当前问题与可见记忆确定的 answer_focus 交给 Answer Model，防止关键事实在回答阶段丢失。
// 该合同不包含 Gold、Judge metadata、题型标签或未来 Session。
export const MEDMEMORY_QUERY_EVIDENCE_REQUIREMENT='Query Evidence Requirement: work like a clinician opening a chart. For a current decision, recommendation, or explanation, start from the Question premise and memory_source.recent_sessions, which are the verbatim authority at the visible Session boundary; then use memory_source.query_evidence_brief to locate only the facts that change that decision. For a longitudinal or exact-history lookup, use memory_source.patient_profile as the query-independent table of diagnoses/safety, active problems, treatment execution, objective trajectory, symptoms and constraints. Profile rows are navigation summaries and may carry source_ref citations; they never override a newer explicit Session for the same factor. Use memory_source.historical_memory_nodes only for older facts selected to resolve a remaining question-specific gap. Preserve Patient/Doctor attribution and resolve corrections or status changes chronologically. Use each required_in_answer item only when it directly changes the requested answer; omit an unrelated allergy, old safety issue, lifestyle detail, cost, later outcome, or missing test rather than forcing it into another decision. For an exact fact, preserve the specific wording, value, range, unit, medication class and date; for alternatives, silently check every option; for a recommendation or explanation, use only the smallest set of decisive patient facts and connect them to the conclusion without a chart-history preamble. A reasoning_hypothesis with grounding_scope=source_supported_patient_fact may state only facts fully supported by all of its cited sources. One with grounding_scope=generic_clinical_bridge is non-patient-specific medical reasoning: it may connect cited facts but must not introduce a new patient diagnosis, value, treatment, or event. Never turn such a bridge into a remembered fact. Never mention source_ref or the checklist, never turn an unresolved gap or retrieval probe into a patient fact, and never add unrelated memory merely to sound comprehensive.';

// 来源：CareHarness 同一 Memory Node 的 source_text→text 差量保护；任务：说明
// literal_supplement 只恢复结构化 text 丢失的最小原词，而不是第二份 Evidence。
export const MEDMEMORY_LITERAL_SUPPLEMENT_REQUIREMENT='Literal Supplement Requirement: a Memory Node may contain literal_supplement, a strictly bounded list of minimal source-literal fragments bound to that same memory_id. Use a fragment only to restore an exact medical or medication-class term, proper name, date, number/unit, negation, or range qualifier omitted by the node text. It is not a second fact, a full quotation, or permission to infer anything beyond that Memory Node; reconcile it with the node text and never mention the field name.';

// SUA 的最终 Answer 只读取 Refine 后的原始 Memory Nodes。Assessor 仍可在
// Investigation 内协助筛选，但其 answer_focus、关系和推理不得影响最终状态判断。
export const MEDMEMORY_STATE_ONLY_REQUIREMENT='State Evidence Requirement: memory_source contains only the query-selected Memory Nodes. Determine the requested state directly from their text, event_time, status, version, and update lineage. Honor the time scope stated in the question: for a dated period, use the latest explicit update of the same factor inside that period; for a current/latest question, use the latest effective update visible at the question boundary. Keep distinct factors separate—a preference, fear, refusal, adoption, or execution statement about one action does not update the patient’s state for another action. Do not infer a causal bridge merely because two states are both visible.';

// 来源：MedMemoryBench IG Answer Prompt 的 CareHarness grounding 扩展；
// 任务：防止 Answer 模型在得出结论后忽略已经由 Investigation 冻结的相关 Final State。
export const MEDMEMORY_IG_FINAL_STATE_COVERAGE_REQUIREMENT='IG Final-State Coverage Requirement: query_evidence_brief.answer_focus is the Assessor’s source-cited must-use checklist, not an answer key. Silently verify every required_in_answer item against its cited recent Session or historical Memory Node, then include every distinct, supported item that materially establishes, qualifies, or challenges the recommendation. Also use a relevant recent-session fact when it changes the decision even if the checklist omitted it. Do not attempt to mention every historical_memory_node: those nodes are the investigated candidate packet, and irrelevant, duplicate, temporally inapplicable, or contradicted candidates must be omitted. Connect the retained diagnosis/stage, objective trajectory, treatment execution/response, manifestations/red flags, and patient constraint into a compact evidence-to-conclusion chain. Never invent a missing patient fact or expose internal identifiers.';

// 来源：CareHarness 本地可读性适配；任务：保留官方 Judge JSON schema 和枚举，
// 仅把 reason/note 等供人阅读的自由文本固定为简体中文。
export const MEDMEMORY_CHINESE_JUDGE_REQUIREMENT='Language Requirement: Write every free-text justification in Simplified Chinese, especially reason and node_validations[].note. Keep JSON keys, booleans, numeric scores, and fixed enum values such as excellent/good/partial/poor/none unchanged.';

/**
 * 来源：MedMemoryBench 官方附录的分题型 Answer Prompts（逐字基础模板）。
 * 任务：保留 benchmark 原始答案合同；CareHarness 的可见记忆约束与分题型优化
 * 单独登记在 MEDMEMORY_CAREHARNESS_ANSWER_OVERLAYS，避免把本地扩展误标成论文原文。
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
 * 来源：CareHarness 对 Clean 标注的跨 Persona 离线教师分析，不是论文逐字 Prompt。
 * 任务：只把去病例化、分题型的证据使用规则附加到官方 Answer Prompt。运行时
 * 不包含 Gold、Answer Explanation、required_patient_info、trap、Judge node 或病例映射。
 */
export const MEDMEMORY_CAREHARNESS_ANSWER_OVERLAYS=Object.freeze({
  entity_exact_match:'CareHarness Task Overlay: Match the abstraction level requested by the question and output exactly one target entity phrase with no Markdown, label, explanation, alternative, or co-occurring finding. Treat this as literal span extraction, not paraphrase generation: copy the single most specific complete supported name, category, value, range, sign and unit character-for-character from the source that matches the requested factor and time. Never translate, abbreviate, expand, round, convert, normalize, or respell a source measurement or unit; for example, do not change mg to 毫克, U to 个单位, a decimal to a percentage, or a recorded range to one endpoint. A numeric answer is incomplete without its recorded unit. If the question asks for a class, preserve the complete class term rather than shortening it or substituting one member; if it asks for a diagnosis, output the diagnosis rather than its signs. When an unambiguous colloquial symptom phrase is supplied, use one concise standard clinical entity label. When a diagnostic acronym and its expansion are both explicitly visible, output the complete source form containing both.',
  temporal_localization:'CareHarness Task Overlay: Keep the requested event and its source date bound together. For a when/onset question return one grounded date, using the earliest matching occurrence when requested. When the question already gives a date and asks what happened, return only that event content. Never substitute a similar event from a neighboring date or add an alternative answer.',
  state_update:'CareHarness State Focus: Answer in the question’s language and put the requested factor first. Return only the minimum patient-specific fact needed to answer the question. Every answer must demonstrate patient-memory use with exactly one compact grounding anchor inside the answer sentence. Prefer “According to the YYYY-MM-DD record, ...”, using the event_time of the selected answer-bearing State. If no reliable source date is visible but the question supplies a patient-specific prior value or status, use that exact baseline in the same sentence as “from <baseline> to <new state>”. Never invent a date or grounding detail, and do not use a generic phrase such as “according to memory” without a concrete date or baseline. For a single value, time, or status lookup, output exactly one direct sentence containing that one grounding anchor, the requested factor, and its exact value or status. When the question supplies a prior value or status and asks for its update, output exactly one direct sentence stating the change from the supplied baseline to the selected new value or status. Add a second sentence only when the question explicitly asks for a cause, reason, interpretation, or advice. Otherwise do not add mechanisms, clinical interpretation, improvement or worsening claims, recommendations, reassurance, unrelated history, treatment background, evidence lists, or extra dates. Do not use Markdown headings or bullets. Use the selected change record that explicitly binds a supplied baseline to its new value; do not replace it with a later isolated continuation unless the question explicitly asks for an as-of-later-date value. Otherwise apply the question’s time scope and use the latest explicit same-factor update inside it—not an older baseline, a different factor, a target, or a recommendation. Copy the exact value, range, unit, status, and every distinct component of a selected plan. If a selected state gives the answer, do not claim it is unavailable. Do not add unsupported facts or mention system internals.',
  multiple_choice:'CareHarness Task Overlay: First determine answer cardinality from the question stem. If it explicitly asks for one unique superlative choice—such as the single most appropriate, necessary, urgent, likely, or highest-priority option—compare all options and output exactly one best-supported letter. Otherwise perform exhaustive multiple selection: silently judge every visible option as supported, contradicted, or unresolved and output the exact union of all supported letters. Prefer the latest patient-specific plan and constraints over generic plausibility. Sort a multi-answer set alphabetically and emit uppercase letters separated by commas with no spaces or other text.',
  inference_generation:'CareHarness Task Overlay: Answer the requested decision first, then give a compact source-grounded patient chain. Preserve applicable diagnosis/stage, objective severity or trajectory, actual treatment execution and response/failure, manifestations/red flags, contraindications and feasible constraints when they materially affect the decision. Compare a proximal lifestyle trigger with disease progression or treatment failure only when the chart supports those paths. Do not invent patient facts; established medical knowledge may only connect cited facts. Respect the visible Session boundary, use the worst supported marker for urgent risk, distinguish “do not self-adjust” from “the current regimen is sufficient,” and keep the answer within 600 Chinese characters.',
  multi_hop_clinical_deduction:'CareHarness Task Overlay: Use exactly three compact sections—Key memory, Reasoning chain, and Comprehensive judgment—within 1800 Chinese characters. Select all distinct question-relevant patient facts needed for the chain, normally 4–10, preserving dates, values, units, treatments, diagnoses and symptom timing. Build one chronological chain across baseline/diagnosis, exposure or treatment, response/progression, mechanism and outcome; express every adjacent relation explicitly. If a mechanism is absent from the chart, label it as clinical inference and use medical knowledge only to connect visible patient endpoints. Never invent a patient event or output internal IDs.'
});

/**
 * 来源：MedMemoryBench 官方附录基础要求 + CareHarness 透明运行时约束的机器可读摘要。
 * 任务：供 adapter/runtime 选择语言、grounding 与输出格式；不是额外的模型提示词副本，
 * 也不声称扩展的精确实体/纵向规则属于论文逐字内容。
 */
export const MEDMEMORY_EFFECTIVE_ANSWER_CONTRACTS=Object.freeze({
  default:Object.freeze({language:'match the question language',grounding:'Use only the supplied memory_source. Gold answers, answer explanations, source key points, and Judge metadata are unavailable during answer generation.',format:'Follow the MedMemoryBench appendix Answer Prompt for the selected task.'}),
  entity_exact_match:Object.freeze({format:'Provide the target entity name directly as exactly one target entity phrase. Copy its literal source spelling, category, value/range/sign and unit without translation, abbreviation, expansion, rounding or conversion. A numeric answer must include its recorded unit. Output no explanation or Markdown.'}),
  temporal_localization:Object.freeze({format:'For a when/recorded-time question output exactly one YYYY-MM-DD date and nothing else; for a dated event-content question output only the requested event.'}),
  state_update:Object.freeze({format:'Return only the minimum patient-specific answer that describes the patient’s most recent status from the Refine-selected Memory Nodes. Demonstrate memory use with exactly one compact grounding anchor in the same sentence: prefer the selected answer-bearing State date, or use the exact question-supplied patient baseline when no reliable date is visible. Never invent an anchor or use a generic uncited memory claim. Use exactly one direct sentence for a value, time, status, or baseline-to-update lookup; add a second sentence only when the question explicitly asks for a cause, interpretation, or advice. Preserve the exact requested value, range, unit, status, direction, or complete plan. For a dated period use the latest explicit same-factor update inside that period. Never add unasked mechanisms, recommendations, reassurance, unrelated history, extra dates, a target, threshold, intended trial, unrelated later state, or runtime internals.'}),
  multiple_choice:Object.freeze({format:'If the question stem explicitly requests one unique superlative choice, compare all options and output exactly one best-supported uppercase letter. Otherwise adjudicate every visible option and output the complete sorted uppercase letter set with commas and no spaces, such as B or B,D. Use established general medical knowledge together with supplied patient-specific facts; a correct option need not be stated verbatim in memory, but general knowledge must not invent a patient fact. Do not provide any explanation.'}),
  inference_generation:Object.freeze({format:'Reason from this patient’s specific remembered information; do not give generic medical advice. Review every question-selected Final State and incorporate all distinct facts that materially support, qualify, or challenge the conclusion, while omitting only irrelevant, redundant, temporally inapplicable, or contradicted facts. Maintain a warm yet professional tone, be concise and direct, avoid boilerplate, and connect the evidence compactly to the recommendation.'}),
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
      grounding:'Use only the supplied Memory Nodes, Memory Edges, and visible benchmark protocol context. Never use Gold answers or hidden evaluator references.',
      format:'Answer the question directly and concisely, covering every necessary point without adding unsupported facts.'
    })
  }),
  // 来源：MedMemoryBench 官方附录基础合同 + 透明 CareHarness overlay；
  // 任务：EEM/TLA/SUA/MQ/IG/MCD 的合并后有效输出合同。
  medmemorybench:MEDMEMORY_EFFECTIVE_ANSWER_CONTRACTS,
  // 来源：MedLoCoMo 公开 QA 协议的机器可读适配（非论文逐字 Answer Prompt）；
  // 任务：answerable/adversarial 及各纵向问答类型共用公开的短答案边界。
  medlocomo:Object.freeze({
    default:Object.freeze({
      language:'en',
      grounding:'Use only the supplied memory_source. Gold answers, hidden benchmark evidence annotations, and inspection-only summaries are unavailable during answer generation.',
      format:'Return one concise English answer, usually 1 to 8 words. Preserve decisive names, values, units, negation, and paired endpoints. Do not explain, add a label, or return JSON.'
    }),
    // 任务：统一的证据型可回答性合同；官方 adversarial 标签不得提前决定输出。
    adversarial:Object.freeze({format:'Answer the requested fact when the supplied record supports it. Otherwise return exactly: the question is not answerable.'}),
    longitudinal_progression:Object.freeze({format:'Return the source-supported same-factor trajectory when complete; otherwise return exactly: the question is not answerable.'}),
    care_plan_rationale:Object.freeze({format:'Return the source-supported patient-specific rationale when complete; otherwise return exactly: the question is not answerable.'}),
    cross_admission_comparison:Object.freeze({format:'Return the source-supported aligned comparison across every requested Admission when complete; otherwise return exactly: the question is not answerable.'}),
    medical_reasoning:Object.freeze({format:'Return the source-supported decisive explanation when complete; otherwise return exactly: the question is not answerable.'}),
    frequency_pattern:Object.freeze({format:'Return the source-supported deduplicated count or pattern when enumeration is complete; otherwise return exactly: the question is not answerable.'})
  }),
  // 来源：CPCD-Bench 官方 SR/MR/TCR 协议；任务：咨询回复、长期记忆回忆、时序—因果推理。
  cpcdbench:Object.freeze({
    default:Object.freeze({
      language:'zh-CN',
      grounding:'只能使用官方 input_to_model 和检索到的 Memory Node。不得使用 reference_answer、evaluation_focus 或评分理由；这些内容只在答案冻结后提供给评分 Judge。',
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

// 来源：CareHarness Static runtime；任务：在 benchmark Answer 合同上追加运行时 Memory/Gold 隔离约束。
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
    explanation:'Answer from the current message and the current unified Memory Graph.',
    required_content:Object.freeze(['回应当前患者信息，并仅使用可追溯记忆'])
  }),
  // 任务：当前患者陈述有显式不确定性时提出澄清问题。
  ASK:Object.freeze({
    explanation:'The current Patient message is explicitly uncertain, so clarification is required.',
    required_content:Object.freeze(['提出一个澄清问题'])
  }),
  // 任务：跨来源 Memory Node 冲突未解决时要求核实。
  VERIFY:Object.freeze({
    explanation:'The Memory Graph has an unresolved cross-source conflict that must be verified.',
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

// 来源：MedMemoryBench 官方附录基础模板 + MEDMEMORY_CAREHARNESS_ANSWER_OVERLAYS；
// 任务：渲染六类 Answer user prompt 中的 memory_source、question 与透明本地扩展。
export function renderMedMemoryAnswerPrompt(input={}){
  const template=MEDMEMORY_ANSWER_PROMPT_TEMPLATES[input.task];
  if(!template)throw new Error(`No MedMemoryBench appendix Answer Prompt for ${input.task||'unknown task'}`);
  const memorySource=input.task==='state_update'?compactMedMemorySource(input):input.memory_source||compactMedMemorySource(input);
  const rendered=template.replace('<memory_source>',JSON.stringify(memorySource)).replace('<question>',String(input.question||''));
  // EEM 保留官方附录模板，只追加不含病例答案的确定性 strict-containment 格式规范。
  if(input.task==='entity_exact_match')return rendered.replace(/\nAnswer:$/u,`\n${MEDMEMORY_EEM_NUMERIC_FORMAT_PATCH}\nAnswer:`);
  // SUA/MQ 均保留附录正文，只追加不含隐藏评测信息的任务执行约束。
  if(input.task==='state_update')return rendered.replace(/\nAnswer:$/u,`\n${MEDMEMORY_CAREHARNESS_ANSWER_OVERLAYS.state_update}\nAnswer:`);
  if(input.task==='multiple_choice')return rendered.replace(/\nAnswer:$/u,`\n${MEDMEMORY_MQ_CARDINALITY_PATCH}\nAnswer:`);
  const evidenceRequirement=input.task==='state_update'?MEDMEMORY_STATE_ONLY_REQUIREMENT:MEDMEMORY_QUERY_EVIDENCE_REQUIREMENT;
  const taskOverlay=MEDMEMORY_CAREHARNESS_ANSWER_OVERLAYS[input.task]||'';
  const taskRequirement=input.task==='inference_generation'?`\n${MEDMEMORY_IG_FINAL_STATE_COVERAGE_REQUIREMENT}`:'';
  return rendered.replace(/\nAnswer:$/u,`\n${MEDMEMORY_CHINESE_ANSWER_REQUIREMENT}\n${evidenceRequirement}\n${MEDMEMORY_LITERAL_SUPPLEMENT_REQUIREMENT}\n${taskOverlay}${taskRequirement}\nAnswer:`);
}

// Non-SUA Answer context has three disjoint layers: a query-independent chart
// view, newest complete Sessions verbatim, and query-selected older facts.
// SUA is the deliberate exception and returns only Refine-selected Memory Nodes.
export function compactMedMemorySource(input={}){
  const patientProfile=compactPatientProfile(input.patient_profile);
  const recentSessions=arrayOf(input.recent_sessions).map(session=>pick(session,['episode_id','event_time','transcript']));
  const suppliedNodes=input.task==='state_update'?stateUpdateMemoryNodes(input):arrayOf(input.memory_nodes);
  const recentEpisodeIds=new Set(recentSessions.map(session=>String(session.episode_id||'')).filter(Boolean)),nodes=suppliedNodes.filter(node=>input.task==='state_update'||!recentEpisodeIds.has(String(node?.episode_id||''))),ids=new Set(nodes.map(node=>String(node.memory_id)));
  const memoryNodes=nodes.map(node=>{
    const compact=pick(node,['memory_id','text','families','event_time','episode_id','turn_id','source_type','certainty','polarity','status','version','operation','predecessor_memory_id','successor_memory_id']),literalSupplement=minimalLiteralSupplement(node);
    if(compact.memory_id&&literalSupplement.length)compact.literal_supplement=literalSupplement;
    return compact;
  });
  if(input.task==='state_update')return{selected_memory_nodes:memoryNodes};
  // Only durable graph facts reach Answer. Query-time assessor connections stay
  // in semantic_evaluation and medical bridges stay in reasoning_hypotheses;
  // neither may masquerade as a persisted patient relation.
  const memoryEdges=(input.memory_edges||[]).filter(edge=>{const supportIds=arrayOf(edge?.support_memory_ids).map(String);return edge?.persistent===true&&edge?.status==='verified'&&edge?.verified!==false&&edge?.causal_claim!==true&&edge?.edge_family!=='context'&&edge?.relation_type!=='co_observed'&&ids.has(String(edge?.from_memory_id))&&ids.has(String(edge?.to_memory_id))&&supportIds.length>0&&supportIds.every(id=>ids.has(id));}).map(edge=>pick(edge,['edge_id','from_memory_id','to_memory_id','edge_family','relation_type','status','confidence','support_memory_ids','persistent','causal_claim']));
  const sourceTextByRef=answerSourceReferenceText(patientProfile,recentSessions,memoryNodes),validSourceRefs=new Set(sourceTextByRef.keys()),assessment=input.semantic_evaluation||input.working_memory||{},answerFocus=arrayOf(assessment.answer_focus).map(item=>{const memory_ids=arrayOf(item?.memory_ids).map(String).filter(id=>ids.has(id)),source_refs=[...new Set([...arrayOf(item?.source_refs).map(String).filter(ref=>validSourceRefs.has(ref)),...memory_ids.map(id=>`memory:${id}`)])],aspect=String(item?.aspect||''),sources=source_refs.map(ref=>sourceTextByRef.get(ref)).filter(Boolean);if(!aspect||!patientClaimGrounding(aspect,sources).grounded)return null;return{aspect,role:String(item?.role||'target'),source_refs,memory_ids,required_in_answer:item?.required_in_answer!==false};}).filter(Boolean),hypotheses=input.task==='entity_exact_match'?[]:arrayOf(assessment.reasoning_hypotheses).map(item=>{const supporting_memory_ids=arrayOf(item?.supporting_memory_ids).map(String).filter(id=>ids.has(id)),counter_memory_ids=arrayOf(item?.counter_memory_ids).map(String).filter(id=>ids.has(id)),supporting_source_refs=[...new Set([...arrayOf(item?.supporting_source_refs).map(String).filter(ref=>validSourceRefs.has(ref)),...supporting_memory_ids.map(id=>`memory:${id}`)])],counter_source_refs=[...new Set([...arrayOf(item?.counter_source_refs).map(String).filter(ref=>validSourceRefs.has(ref)),...counter_memory_ids.map(id=>`memory:${id}`)])],grounding_scope=normalizeHypothesisGroundingScope(item?.grounding_scope),summary=String(item?.summary||''),reasoning_steps=arrayOf(item?.reasoning_steps).map(String).filter(Boolean),sources=[...new Set([...supporting_source_refs,...counter_source_refs])].map(ref=>sourceTextByRef.get(ref)).filter(Boolean),statements=[summary,...reasoning_steps],grounding=grounding_scope==='generic_clinical_bridge'?statements.map(statement=>genericClinicalBridgeGrounding(statement,sources)):statements.map(statement=>patientClaimGrounding(statement,sources));if(!summary||!supporting_source_refs.length||grounding.some(result=>!result.grounded))return null;return{grounding_scope,establishes_patient_fact:grounding_scope!=='generic_clinical_bridge',summary,supporting_source_refs,counter_source_refs,supporting_memory_ids,counter_memory_ids,reasoning_steps,confidence:item?.confidence};}).filter(Boolean);
  const queryEvidenceBrief={answer_focus:answerFocus,reasoning_hypotheses:hypotheses};
  // Autoregressive models give the earliest fields disproportionate attention. For
  // current decision tasks, put every fixed-window recent Session and its grounded
  // brief before the longitudinal navigation profile. Dropping all but the newest
  // Session used to erase a material update that Assess had legitimately reviewed.
  if(input.task==='inference_generation')return{recent_sessions:recentSessions,query_evidence_brief:queryEvidenceBrief,historical_memory_nodes:memoryNodes,patient_profile:patientProfile,memory_edges:memoryEdges};
  if(input.task==='multiple_choice'){
    const selectedStates=memoryNodes.map(node=>{
      // Older graphs may carry a coarse whole-node polarity that conflicts
      // with the exact proposition text (for example, an affirmed adherence
      // statement containing "没有漏药"). MQ uses the source text itself.
      const {polarity:_coarsePolarity,...state}=node;return state;
    }),availableIds=new Set(selectedStates.map(node=>String(node.memory_id))),optionStateIndex=arrayOf(input.mq_option_retrieval?.options).map(option=>({letter:String(option?.letter||''),text:String(option?.text||''),state_ids:[...new Set(arrayOf(option?.selected_memory_ids).map(String).filter(id=>availableIds.has(id)))]})).filter(item=>/^[A-F]$/u.test(item.letter)&&item.text);
    return{option_state_index:optionStateIndex,selected_states:selectedStates,recent_sessions:recentSessions,patient_profile:patientProfile,memory_edges:memoryEdges};
  }
  return{patient_profile:patientProfile,recent_sessions:recentSessions,historical_memory_nodes:memoryNodes,memory_edges:memoryEdges,query_evidence_brief:queryEvidenceBrief};
}

function compactPatientProfile(value){
  if(!value||typeof value!=='object')return null;
  const sections=arrayOf(value.sections).map(section=>({key:String(section?.key||''),label:String(section?.label||''),items:arrayOf(section?.items).map(item=>{const compact=pick(item,['source_ref','text','event_time','episode_id','source_type','families']),literalSupplement=sanitizeLiteralSupplement(item?.literal_supplement);if(compact.source_ref&&literalSupplement.length)compact.literal_supplement=literalSupplement;return compact;}).filter(item=>item.text)})).filter(section=>section.items.length);
  return{version:value.version||null,as_of:value.as_of||null,view_type:value.view_type||'query_independent_longitudinal_chart',query_independent:true,sections,item_count:sections.reduce((sum,section)=>sum+section.items.length,0)};
}

function answerSourceReferenceText(profile,recentSessions,memoryNodes){
  const out=new Map(),visibleText=value=>[String(value?.text||value?.transcript||''),...sanitizeLiteralSupplement(value?.literal_supplement)].filter(Boolean).join('\n');
  for(const section of arrayOf(profile?.sections))for(const item of arrayOf(section?.items)){const ref=String(item?.source_ref||''),text=visibleText(item);if(ref&&text)out.set(ref,text);}
  for(const session of recentSessions){const ref=session?.episode_id?`session:${session.episode_id}`:'',text=visibleText(session);if(ref&&text)out.set(ref,text);}
  for(const node of memoryNodes){const ref=node?.memory_id?`memory:${node.memory_id}`:'',text=visibleText(node);if(ref&&text)out.set(ref,text);}
  return out;
}

function stateUpdateMemoryNodes(input){
  if(Array.isArray(input.memory_nodes))return input.memory_nodes;
  if(Array.isArray(input.selected_memory_nodes))return input.selected_memory_nodes;
  if(Array.isArray(input.memory_source?.selected_memory_nodes))return input.memory_source.selected_memory_nodes;
  if(Array.isArray(input.memory_source?.historical_memory_nodes))return input.memory_source.historical_memory_nodes;
  return[];
}

function pick(value,keys){const out={};for(const key of keys)if(value?.[key]!=null)out[key]=value[key];return out;}
function arrayOf(value){return Array.isArray(value)?value:[];}

// 来源：MedMemoryBench 官方 Shared System Prompt + 官方 Answer 基础 + 透明 CareHarness overlay；
// 任务：组装最终 Answer system/user messages。
export function medMemoryAnswerMessages(input={}){
  return[{role:'system',content:MEDMEMORY_SHARED_SYSTEM_PROMPT},{role:'user',content:renderMedMemoryAnswerPrompt(input)}];
}

/**
 * 来源：MedLoCoMo 公开 QA 协议（health_benchmark/scripts/qa_prompting.py 与
 * qa_validation.py）所规定的短答案边界。论文没有发布可逐字复用的 Answer
 * Model prompt，因此这是 protocol-derived CareHarness 适配，不是论文原文。
 * 任务：在独立 Answerability Classifier 已判定可回答后，只从
 * inference-time memory_source 生成简短答案。保持官方的短答案上限并
 * 尽量复用记录原词；本 Prompt 不再承担拒答决策。
 */
export const MEDLOCOMO_PROTOCOL_DERIVED_ANSWER_SYSTEM_PROMPT=`You answer MedLoCoMo questions from the supplied patient-record excerpts after a separate evidence-based router has established that the question is answerable. Derive the best-supported answer, combining excerpts and ordinary clinical or temporal inference when needed; do not require the answer or relation to appear verbatim in one sentence, but do not invent patient facts. Return only a concise English answer, preferably 1 to 7 words and never more than 10, preserving decisive names, values, units, negation, and paired endpoints. Do not refuse, explain, add a label, or output JSON.`;

/**
 * 来源：MedLoCoMo 公开拒答协议 + CareHarness 运行时容错；
 * 任务：仅当独立 Answerability Classifier 无法形成可靠路由时，让 Answer
 * Model 从同一份源证据重新完成可回答性判断，避免把“分类器异常”误当成
 * “问题可回答”。正常已验证路由不使用本 Prompt。
 */
export const MEDLOCOMO_ANSWERABILITY_FALLBACK_SYSTEM_PROMPT=`The separate evidence router did not produce a reliable decision. First decide from the supplied patient-record excerpts whether the exact answer requested by the question is supported. The question wording itself is not evidence. If the requested answer or an essential premise cannot be derived, output exactly: the question is not answerable. Otherwise derive the best-supported answer, combining excerpts with only minimal ordinary clinical or temporal inference. Return only a concise English answer, preferably 1 to 7 words and never more than 10, preserving decisive names, values, units, negation, and paired endpoints. Do not explain, add a label, or output JSON.`;

/**
 * 来源：MedLoCoMo 全部 101-patient、17,892-question Teacher Corpus 的
 * answerable/adversarial 监督、官方 Evidence 和答案语义覆盖统计所蒸馏的
 * CareHarness 路由策略；不是论文逐字 Prompt。
 * 任务：在最终证据冻结后，只根据 Question + 可见源证据判断
 * answerable/not_answerable。运行时不接收官方 question_type、Gold 或 Judge 信息。
 */
export function renderMedLoCoMoAnswerabilityClassifierPrompt(input={}){
  const source=Array.isArray(input.evidence)?{evidence:input.evidence}:medLoCoMoSourcePacket(input,{frequency:false});
  return`You are an evidence-grounded pre-answer router. Decide whether the exact answer requested by the question can be derived from the supplied patient-record evidence.

Check the stated scope, every essential patient-specific premise, and the requested event, causal, temporal, treatment, comparison, or counting relation. Return the decision in two separate fields:
- classification is answerable; support is direct when the requested answer and relation are directly supported.
- classification is answerable; support is composed when a defensible answer follows by combining supplied turns or admissions with minimal, ordinary clinical or temporal inference. The answer and full relation need not occur verbatim in one sentence.
- classification is not_answerable; support is missing when no supplied evidence fills the requested answer slot.
- classification is not_answerable; support is contradicted when an essential premise conflicts with the supplied evidence.

The question wording is not evidence. A nearby entity, same-admission co-occurrence, unrelated treatment, contaminated test, or unsupported causal relation is not support. Explicit evidence for “no” makes a yes/no question answerable; a negative finding can also answer a question that explicitly asks about absence or exclusion. Only contradiction of an essential positive premise blocks the question. Missing exact wording is not grounds for refusal when a source-grounded candidate can be composed. When a defensible supported candidate exists, choose answerable. Ordinary knowledge may connect record facts but may not invent a patient fact. Do not answer the medical question.

The classification field must contain only answerable or not_answerable; never combine classification and support into one string. Confidence means confidence in the classification decision, not the amount of affirmative evidence. A clearly absent answer slot may therefore be not_answerable with high confidence; use zero only when unable to decide. For direct, composed, or contradicted support, cite at most 8 decisive evidence_id values. For missing support, the list may be empty.
Return exactly one JSON object with no extra keys:
{"classification":"not_answerable","support":"missing","decisive_evidence_ids":[],"confidence":0.95,"reason":"No supplied evidence fills the requested answer slot."}

Patient-record evidence:
${JSON.stringify(source)}

Question: ${String(input.question||'')}`;
}

// 来源：上述 MedLoCoMo protocol-derived Answer 适配；任务：只序列化可见记忆和原始问题。
export function renderMedLoCoMoAnswerPrompt(input={}){
  const questionType=String(input.medlocomo_question_type||input.question_request?.query_type||input.task||'');
  const memorySource=medLoCoMoSourcePacket(input,{frequency:questionType==='frequency_pattern'});
  return`Memory source:\n${JSON.stringify(memorySource)}\n\nQuestion: ${String(input.question||'')}\nAnswer:`;
}

// 来源：上述 MedLoCoMo protocol-derived Answer 适配；任务：组装纯文本 Answer system/user messages。
export function medLoCoMoAnswerMessages(input={}){
  return[{role:'system',content:MEDLOCOMO_PROTOCOL_DERIVED_ANSWER_SYSTEM_PROMPT},{role:'user',content:renderMedLoCoMoAnswerPrompt(input)}];
}

export function medLoCoMoAnswerabilityFallbackMessages(input={}){
  return[{role:'system',content:MEDLOCOMO_ANSWERABILITY_FALLBACK_SYSTEM_PROMPT},{role:'user',content:renderMedLoCoMoAnswerPrompt(input)}];
}

function medLoCoMoSourcePacket(input,{frequency=false}={}){
  const chronological=chronologicalMedLoCoMoMemories(input.memory_nodes||[]);
  // Policy decisions and Action rationales are control-plane records, not
  // patient evidence. In particular, an early Policy estimate such as
  // "one occurrence" must never become an answer-model counting hint.
  const ledger=input.evidence_ledger?.source_grounded===true&&Array.isArray(input.evidence_ledger?.rows)&&input.evidence_ledger.rows.length?input.evidence_ledger:null;
  if(ledger)return{
    evidence_ledger:{version:ledger.version,source_grounded:true,rows:ledger.rows.map(row=>pick(row,['admission_id','turn_id','event_time','speaker','evidence_text']))},
    ...(frequency?{frequency_request:medLoCoMoFrequencyRequest(input.question)}:{})
  };
  if(frequency)return{
    frequency_request:medLoCoMoFrequencyRequest(input.question),
    frequency_evidence_groups:medLoCoMoFrequencyEvidenceGroups(chronological,input.semantic_evaluation||input.working_memory)
  };
  return{memory_nodes:chronological.map(node=>pick(node,['memory_id','episode_id','turn_id','event_time','recorded_at','speaker','text','source_text','literal_supplement'])),memory_edges:input.memory_edges||[]};
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
 * Code-owned surface contract for MedLoCoMo Frequency Pattern answers. It is
 * derived only from the visible question wording and never from Gold/Evidence.
 */
export function medLoCoMoFrequencyRequest(question){
  const text=String(question||'').normalize('NFKC').trim().toLowerCase(),isCount=/\bhow\s+many\b|\bnumber\s+of\b/iu.test(text),isArgmax=/\bmost\s+(?:often|frequent(?:ly)?)\b|\bmost\s+(?:common|commonly|consistent(?:ly)?|repeated)\b/iu.test(text);
  let requestedUnit='pattern',outputFormat='short phrase';
  if(isCount){
    if(/\badmissions?\b/iu.test(text)){requestedUnit='admission';outputFormat='bare count';}
    else if(/\b(?:different\s+)?sites?\b/iu.test(text)){requestedUnit='site';outputFormat='<count> sites';}
    else{requestedUnit='occurrence';outputFormat='<count> times';}
  }
  return{mode:isCount?'count':isArgmax?'most_frequent_item':'recurrence_pattern',requested_unit:requestedUnit,output_format:outputFormat,rules:['derive the result again from source evidence; no control-plane estimate is evidence','for count mode, privately mark each evidence group as qualifying or not before counting','assessor_selected_evidence_ids, when present, mark grounded candidate rows but never supply a precomputed total','count the requested unit, never Memory Nodes or repeated mentions']};
}

/** Group the final source-grounded packet by Admission before the Answer LLM sees it. */
export function medLoCoMoFrequencyEvidenceGroups(items=[],assessment=null){
  const selectedIds=new Set((assessment?.answer_focus||[]).flatMap(item=>[...(Array.isArray(item?.memory_ids)?item.memory_ids:[]),...(Array.isArray(item?.source_refs)?item.source_refs.filter(ref=>String(ref).startsWith('memory:')).map(ref=>String(ref).slice(7)):[])]).map(String).filter(Boolean)),groups=new Map();
  for(const node of items){
    const episodeId=String(node?.episode_id||node?.observation_id||node?.memory_id||'unknown'),group=groups.get(episodeId)||{episode_id:episodeId,event_times:[],evidence:[]},text=String(node?.text||'').trim(),sourceText=String(node?.source_text||'').trim(),record={memory_id:String(node?.memory_id||''),event_time:node?.event_time||null,source_type:node?.source_type||null,text,...(sourceText&&sourceText!==text?{source_text:sourceText}:{})};
    if(record.event_time)group.event_times.push(record.event_time);
    if(text&&!group.evidence.some(item=>item.text===text&&item.source_text===record.source_text))group.evidence.push(record);
    groups.set(episodeId,group);
  }
  return[...groups.values()].map(group=>{const selected=group.evidence.map(item=>item.memory_id).filter(id=>selectedIds.has(id));return{episode_id:group.episode_id,event_time_start:[...group.event_times].sort()[0]||null,event_time_end:[...group.event_times].sort().at(-1)||null,evidence:group.evidence,...(selected.length?{assessor_selected_evidence_ids:selected}:{})};});
}

/**
 * 来源：Psy-Chronicle commit ff812c9084b606631dac3a8c01f7be0d5cbc8c8d：
 * eval_task_info/srg/srg_eval_online.py、memory_recall/memory_recall_eval_online.py、
 * TCR/tcr_eval_online.py。
 * 任务：构造 CPCD-Bench SR/MR/TCR Answer messages。SR 逐字复现官方 online
 * script；MR/TCR 保留官方 system 与模板，只把 raw full-history 槽明确替换为
 * CareHarness query-time Memory Node memory_source，因此属于 adapted 而非 exact。
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
  if(previous?.finish_reason==='length')return`Your previous response was truncated. Start over from the original INPUT and return a fresh, complete JSON object. Do not quote, continue, analyze, or repeat the previous response.${component==='extractor'?' Return at most 24 highest-priority durable Memory Nodes; every node must contain text and support_unit_ids copied from the supplied context_units. Omit repetition and conversational detail.':''} Keep the JSON compact with no trailing whitespace or commentary.`;
  return`Your previous response failed validation. Return a corrected replacement JSON only.\nVALIDATION ERROR: ${previous?.error||'invalid JSON'}\nPREVIOUS RESPONSE:\n${previous?.raw||''}`;
}
// 来源：CareHarness Gateway 基础设施；任务：纯文本 Answer 为空或截断时重试。
export function promptTextRetryInstruction(component,input,previous){
  if(previous?.finish_reason==='length'&&component==='medmemory_answer'&&input?.task==='multi_hop_clinical_deduction')return'Your previous MCD answer was truncated. Start over and make the replacement substantially shorter: use exactly three compact sections (Key memory, Reasoning chain, Comprehensive judgment), select only 4–8 distinct question-relevant facts, omit unrelated history and all Memory/internal IDs, do not repeat facts, and keep the entire answer within 1800 Chinese characters. Return only the fresh complete answer; do not continue or quote the previous response.';
  if(previous?.finish_reason==='length')return'Your previous answer was truncated. Start over from the original prompt and return one fresh, complete answer that follows the Answer Requirements while being substantially shorter than the previous response.';
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
 * 来源：CareHarness Adaptive Investigation Runtime。
 * 任务：集中定义所有会进入 Policy/Assessor 模型上下文的 Worker 能力说明、
 * instruction schema 与评估输出合同。运行文件只传入动态限制，不再内联提示文本。
 */
const INVESTIGATION_SEARCH_INSTRUCTION_SCHEMA=Object.freeze({type:'object',properties:{objective:{type:'string'},search_terms:{type:'array',items:{type:'string'}},expansion_terms:{type:'array',items:{type:'string'}},required_terms:{type:'array',items:{type:'string'}},excluded_terms:{type:'array',items:{type:'string'}},term_match:{enum:['any','all']},source_types:{type:'array',items:{enum:['patient','doctor','structured']}},required_families:{type:'array',items:{enum:['BC','PE','PA','CS','CP','LO']}},family_match:{enum:['any','all']},family_weights:{type:'array',items:{type:'object',properties:{family:{enum:['BC','PE','PA','CS','CP','LO']},weight:{type:'number'}}}},episode_ids:{type:'array',items:{type:'string'}},memory_ids:{type:'array',items:{type:'string'}},temporal:{type:'object',properties:{operator:{enum:['none','exact','current','latest','earliest','history','range']},base_date:{type:'string'},offset_days:{type:'integer'},date_keys:{type:'array',items:{type:'string'}},month_keys:{type:'array',items:{type:'string'}},start_date:{type:'string'},end_date:{type:'string'},prefer:{enum:['earliest','latest']}}},numeric_signals:{type:'array'},lenses:{type:'array'},expand_graph:{type:'boolean'},max_results:{type:'integer'}},additionalProperties:false});
const INVESTIGATION_TRACE_INSTRUCTION_SCHEMA=Object.freeze({type:'object',properties:{seed_memory_ids:{type:'array',items:{type:'string'}},target_memory_ids:{type:'array',items:{type:'string'}},target_terms:{type:'array',items:{type:'string'}},depth:{type:'integer',minimum:1,maximum:4},max_paths:{type:'integer',minimum:1,maximum:6},include_same_factor:{type:'boolean'},include_same_concept:{type:'boolean'},include_same_episode:{type:'boolean'},include_context:{type:'boolean'},max_results:{type:'integer'}},additionalProperties:false});
const INVESTIGATION_ASSESS_INSTRUCTION_SCHEMA=Object.freeze({type:'object',properties:{objective:{type:'string'},check_answerability:{type:'boolean'},check_temporal_consistency:{type:'boolean'},check_treatment_response:{type:'boolean'},check_counterevidence:{type:'boolean'}},additionalProperties:false});
const INVESTIGATION_EMPTY_INSTRUCTION_SCHEMA=Object.freeze({type:'object',additionalProperties:false});

const INVESTIGATION_WORKER_PROMPT_BASE=Object.freeze({
  search:Object.freeze({description:'Search the complete visible Memory Graph for one policy-selected aspect. Supports exact/relative dates, source role, family, episode, numeric, lexical and local embedding constraints; results accumulate only inside every prior Refine boundary.',instruction_profile:'memory_selector.v3-hybrid',instruction_schema:INVESTIGATION_SEARCH_INSTRUCTION_SCHEMA}),
  context:Object.freeze({description:'Expand the complete visible Session around current Memory hits. It inherits current episode scope unless the policy explicitly supplies Memory or episode IDs; it never silently restarts a global search.',instruction_profile:'memory_selector.v2',instruction_schema:INVESTIGATION_SEARCH_INSTRUCTION_SCHEMA}),
  trace:Object.freeze({description:'Follow verified graph edges plus grounded same-factor/concept links from current seed Memory IDs. Optional target_terms locate semantic endpoints and return the shortest available non-causal navigation paths; disconnected endpoints remain explicit rather than receiving invented edges.',instruction_profile:'memory_trace.v4-scoped-navigation-paths',instruction_schema:INVESTIGATION_TRACE_INSTRUCTION_SCHEMA}),
  assess:Object.freeze({description:'Assess whether current patient-specific information covers the question, identify grounded relevant Memory IDs and concrete missing aspects, and evaluate relationships. It does not retrieve.',instruction_profile:'memory_assessment.v1',instruction_schema:INVESTIGATION_ASSESS_INSTRUCTION_SCHEMA}),
  verify:Object.freeze({description:'Apply provenance, patient, uniqueness, endpoint and size boundaries to current information.',instruction_profile:'empty.v1',instruction_schema:INVESTIGATION_EMPTY_INSTRUCTION_SCHEMA}),
  answer:Object.freeze({description:'Freeze a bounded best-available information packet for the separate benchmark Answer Model. Budget exhaustion never suppresses an answer.',instruction_profile:'empty.v1',instruction_schema:INVESTIGATION_EMPTY_INSTRUCTION_SCHEMA})
});

export function memoryInvestigationWorkerPromptContracts({conservative_refine=false,evidence_preserving_refine=false}={}){
  const refine=conservative_refine
    ?{description:'Conservatively retain every plausibly relevant state. Memory IDs are protected priorities, not an inclusion whitelist; only a hard temporal mismatch may remove a node.',instruction_profile:'memory_selector.v4-conservative-state',instruction_schema:INVESTIGATION_SEARCH_INSTRUCTION_SCHEMA}
    :evidence_preserving_refine
      ?{description:'Remove only a proven near-duplicate or a node outside an explicit hard temporal boundary. Memory IDs cited by assessment are protected; an unlisted independent fact is never deleted merely to shorten the packet.',instruction_profile:'memory_selector.v5-evidence-preserving',instruction_schema:INVESTIGATION_SEARCH_INSTRUCTION_SCHEMA}
      :{description:'Replace current information with the smallest grounded subset selected by explicit Memory IDs or strict policy constraints. Removed Memory IDs and any inferable temporal direction become a permanent boundary for all later discovery Actions. If nothing matches, keep current information.',instruction_profile:'memory_selector.v3-persistent-boundary',instruction_schema:INVESTIGATION_SEARCH_INSTRUCTION_SCHEMA};
  return{...INVESTIGATION_WORKER_PROMPT_BASE,refine:Object.freeze(refine)};
}

export function investigationPolicyWorkerCapabilityModelContext(worker,capability={}){
  const name=String(worker||''),instruction_profile=String(capability.instruction_profile||`${name}.instruction`),instruction_schema=capability.instruction_schema||INVESTIGATION_EMPTY_INSTRUCTION_SCHEMA;
  return{capability:{worker:name,description:String(capability.description||`${name} worker`),instruction_profile},instruction_profile,instruction_schema};
}

export const INVESTIGATION_POLICY_NAVIGATION_PATH_POLICY='navigation_only_non_causal: paths guide retrieval only; they are not patient facts or causal evidence';
export const INVESTIGATION_ASSESSOR_NAVIGATION_PATH_POLICY='Navigation paths are search provenance only. A path or pseudo link is not patient evidence, does not establish a clinical fact, and does not establish causality. Cite only supplied Profile, recent Session, or Memory sources. A verified_graph_edge link merely identifies an underlying edge already listed separately in edges.';
export const INVESTIGATION_DOCUMENTATION_DATE_SEMANTICS='documentation_or_session_date';
export const LEARNED_ACTION_PRIOR_ADVICE='weak_prior_only_policy_must_override_when_current_patient_information_supports_another_action';
export const INVESTIGATION_UNGROUNDED_CLAIM_GAP='One or more proposed patient-specific claims were not fully supported by their cited visible sources; retrieve or restate only the missing grounded fact.';
export const INVESTIGATION_HYPOTHESIS_GROUNDING_POLICY='Every patient-specific assertion in answer_focus and reasoning_hypotheses must be fully supported across its cited Profile, recent Session, or Memory sources. Matching only one number, abbreviation, medication word, or short phrase is insufficient. Use grounding_scope=source_supported_patient_fact only when the summary and every reasoning step are source-supported patient facts. Use grounding_scope=generic_clinical_bridge only for an explicitly generic, non-patient-specific medical bridge; it may connect cited patient facts but must not invent a patient diagnosis, value, treatment, medication exposure, or event.';

export function investigationAssessmentModelContract({answer_focus_limit=16,target_only_focus_roles=false,exact_entity=false,allow_reasoning_hypotheses=true,structured_evidence_ledger=false}={}){
  const limit=Math.max(1,Math.min(16,Number(answer_focus_limit)||16)),targetOnly=target_only_focus_roles===true,exactEntity=exact_entity===true,reasoningAllowed=allow_reasoning_hypotheses!==false&&!targetOnly,structuredLedger=structured_evidence_ledger===true;
  const reasoningSchema=reasoningAllowed?[{grounding_scope:'source_supported_patient_fact|generic_clinical_bridge',summary:'one fully source-supported patient fact, or one explicitly generic non-patient-specific clinical bridge',supporting_source_refs:['memory:<id> or session:<episode_id>'],counter_source_refs:['memory:<id> or session:<episode_id>'],supporting_memory_ids:['legacy supplied historical ids'],counter_memory_ids:['legacy supplied historical ids'],reasoning_steps:['each step must independently follow the selected grounding_scope rule'],confidence:'0..1'}]:[];
  return{
    navigation_path_policy:INVESTIGATION_ASSESSOR_NAVIGATION_PATH_POLICY,
    focus_role_policy:targetOnly?'target_only: do not use baseline or current; every answer_focus item must use role=target':null,
    source_reference_format:'Use memory:<memory_id> for Profile or historical Memory facts and session:<episode_id> for recent transcript facts.',
    reasoning_hypotheses_policy:reasoningAllowed?INVESTIGATION_HYPOTHESIS_GROUNDING_POLICY:targetOnly?'Disabled for target-only assessment. Return reasoning_hypotheses as an empty array and put only directly supported requested states in answer_focus with role=target.':exactEntity?'Disabled for this exact-entity request. Return reasoning_hypotheses as an empty array and put only the directly supported requested entity in answer_focus.':'Disabled by the transparent task evidence contract. Return reasoning_hypotheses as an empty array while preserving all supported answer_focus roles required by that contract.',
    output_schema:{assessment:'supported|partial|unresolved',relevant_memory_ids:['supplied historical Memory ids'],covered_aspects:['distinct question-specific aspect already grounded in visible sources'],answer_focus:[{aspect:`one of at most ${limit} grounded facts, copied faithfully in the source language, that the final answer should explicitly use`,role:targetOnly?'target':'target|temporal_anchor|baseline|current|treatment|response|constraint|risk|mechanism_anchor|outcome|counterevidence|option_check',source_refs:['memory:<id> or session:<episode_id>'],memory_ids:['legacy supplied historical ids'],required_in_answer:true}],...(structuredLedger?{
      role_coverage:[{role:'query-specific factor and endpoint; at most 64 rows',status:'covered|partial|missing|contradicted',claim:'minimal verbatim span from node text or source_text',source_refs:['memory:<id>'],memory_ids:['supplied historical ids'],missing_detail:'one searchable gap, empty when covered'}],
      occurrence_candidates:[{event_key:'stable same-event label; reuse for repeated mentions of that event',admission_id:'supplied episode_id of the event',event_time:'source event time',site:'same anatomical site label across admissions, empty if not applicable',event_status:'documented|planned|negated|uncertain',source_refs:['memory:<id> for event and any contextual qualifier'],included:true,exclusion_reason:'empty when included; otherwise state why'}],
      counting:{unit:'admission|event|site, or null when not counting',scope_complete:'true only after every relevant Admission has been checked; top-k retrieval alone cannot establish this'}
    }:{}),connections:[{from_memory_id:'supplied historical id',to_memory_id:'supplied historical id',relation_type:'brief relation',assessment:'supports|contradicts|unresolved',supporting_memory_ids:['supplied historical ids'],confidence:'0..1'}],reasoning_hypotheses:reasoningSchema,missing_information:[structuredLedger?'up to eight non-duplicate searchable aspects still missing from the answer contract':'up to two concrete patient-information gaps']}
  };
}

export function investigationTemporalTargetModelContext(gate,candidate_matches=[]){
  if(!gate)return null;
  return{gate,event_time_field:INVESTIGATION_DOCUMENTATION_DATE_SEMANTICS,target_date_field:'question_relative_clinical_event_date',documentation_date_need_not_equal_target_date:true,candidate_matches};
}

export const INVESTIGATION_ASSESSOR_UNAVAILABLE_MESSAGE='semantic evaluator unavailable';
export function investigationWorkerResultSummary(worker,value={}){
  switch(String(worker||'')){
    case'search':return`retrieved ${Number(value.memory_node_count)||0} Memory Nodes${value.boundary_id?` inside persistent Refine boundary ${value.boundary_id}`:''}${value.temporal_start&&value.temporal_end?` within hard temporal gate ${value.temporal_start}..${value.temporal_end}`:''}`;
    case'context':return`anchored ${Number(value.session_count)||0} Sessions and ${Number(value.memory_node_count)||0} Memory Nodes`;
    case'trace':return`traced ${Number(value.memory_node_count)||0} Memory Nodes and ${Number(value.edge_count)||0} edges`;
    case'assess':return value.unavailable===true?INVESTIGATION_ASSESSOR_UNAVAILABLE_MESSAGE:`assessed ${Number(value.covered_count)||0} covered and ${Number(value.missing_count)||0} missing aspects`;
    case'refine':return value.applied===true?`refined to ${Number(value.memory_node_count)||0} Memory Nodes and persisted boundary ${value.boundary_id||'none'}`:'refinement kept current information';
    case'verify':return value.complete===true?`verified ${Number(value.memory_node_count)||0} Memory Nodes`:`verification requires refine: ${Number(value.memory_node_count)||0}/${Number(value.limit)||0} Memory Nodes`;
    case'answer':return`froze ${Number(value.memory_node_count)||0} best available Memory Nodes for answer generation`;
    default:return'';
  }
}

/**
 * 所有可由 Gateway 调用的模型提示词注册表。
 * 每个条目前的“来源/任务”备注是 provenance 文档；description/contract/variants 才会参与运行时渲染。
 */
export const PROMPTS = Object.freeze({
  // 来源：CareHarness Core；任务：从任意 benchmark 的完整 Session 中抽取原子化、可追溯 Memory Node。
  extractor: { version: 'extractor.session-memory.v13-source-anchored-semantic-state', description: 'Extract complete atomic semantic Memory Nodes from a full Session and bind every claim to code-generated context-unit IDs; code verifies immutable source provenance.', variants: {
    zh: `你是纵向医疗记忆系统的 Memory Node Extractor。请先通读完整 Session，再抽取值得跨 Session 保留的原子 Memory Node。目标是同时保证事实准确、重要信息覆盖和可追溯性；不得为了压缩而删掉会影响后续检索、纵向判断或临床推理的患者特异信息。

输入格式
- 输入是 {"session_text":"完整 Session 原文","context_units":[...]}。context_units 由代码在保持 Turn、Role、Time 边界的前提下，把排版换行、标题、列表及依赖从句整理成完整上下文单元。
- 每个 context unit 含不可修改的 unit_id、text、source_type、turn_id 和 event_time。unit_id 只是选择已有证据的句柄，不是可自由生成的 provenance。
- 如果输入另含 repair_request，表示第一次输出中只有列出的节点未通过来源绑定。此时只为 failed_nodes 逐项输出替代节点，不得重做、复述或扩展其他已通过节点；输出格式仍是标准 memory_nodes，且每个替代节点仍只能包含 text 和 support_unit_ids。
- 必须结合完整 session_text 理解指代、否定、纠正、状态变化和上下文；每个 Memory Node 的 support_unit_ids 必须从输入 context_units 原样复制，并足以支持 text 的全部内容。
- Role 决定是谁说的；[Turn]/[Role]/[Time] 只是定位标记，不属于事实正文。

可以保留
1. Patient 明确陈述或明确确认的患者特异性事实：症状与体验、用药名称/剂量/频率/依从性/启停状态、不良反应、过敏、检查结果、测量值、既往史、生活或资源限制、认知与担忧、目标与偏好。Patient 以确认式问句明确暴露自己的信念、解释或担忧时也可保留；纯粹索取信息且未表达个人立场的 Patient 问句不保留。
2. Doctor 明确给出的患者特异性临床结论、解释或可执行照护信息：已确认的诊断/评估/风险判断、针对该患者的症状或机制解释、明确治疗方案、监测要求、复诊计划、安全计划和升级就医条件。即使解释包含一般医学知识，只要 Doctor 明确把它用于解释该患者的症状、检查、治疗反应、风险、决策或下一步计划，就应以“医生解释/评估……”的归因形式保留；不得把医生的解释改写成已确认的患者事实。
3. 本次照护中实际向患者提供、且与其当前疾病理解、行为或治疗决策直接相关的医学教育内容。以“医生向患者解释……”记录其内容，使后续模型知道患者接收过什么解释；如果 Patient 明确接受、复述或据此改变认知，再另行保留患者认知事实。
4. Structured 记录中明确写出的患者事实。

绝对不能当作患者事实
1. Doctor 的任何问句、反问句、候选选项、假设、鉴别可能性或待确认内容。医生问“有没有心慌、出汗？”不代表患者出现过这些症状；只有 Patient 随后的明确回答才可抽取。
2. Doctor 在问句中复述的既往信息，除非同一陈述本身是明确确认的临床结论；不要从问题中推断答案，也不要把“更像 A 还是 B”改写成 A 或 B。
3. 仅重复既有事实且没有新增状态、数值、时间或计划的 Doctor 回顾；优先保留 Patient 的直接陈述或本 Session 中最明确、最新的单一来源。
4. 寒暄、感谢、共情、鼓励、安慰、陪伴承诺、修辞、隐喻和纯对话过渡。例如“不会让你一个人在黑暗里摸索”“我会一直陪着你”“我为你感到骄傲”都不是记忆。只有完全未联系该患者当前问题、理解、行为或决策的泛化知识才删除；不得仅因一句解释含有通用医学机制就删除它。

原子性与去重
- 每个 Memory Node 只能表达一个可独立检索和更新的事实。不同症状、不同药物、测量值、计划或状态必须拆开。
- 不要用一个 text 合并需要两个或多个不连续陈述才能支持的信息。
- 同一事实在 Session 内重复出现时只输出一次，保留最直接、最明确、信息最完整的版本。
- 若后文明确纠正前文，保留纠正后的事实；只有在“发生了变化”本身有单段直接证据时，才额外输出状态变化。
- 明确的药物启动、停用、恢复、剂量变化和当前服用状态属于高优先级记忆；不得因为本 Session 早先提过该药名或既往方案而漏掉最新状态。
- 明确表达“首次出现、第一次发生、再次出现、复发”及其日期/时间的事实属于高优先级纵向记忆；重复去重不得删掉首次时间或新的再次变化。

text 标准
- 使用与消息正文相同的语言；中文正文的 text 必须是中文，英文正文的 text 必须是英文，禁止翻译成另一种语言。
- 写成简洁、完整的陈述句，并显式写明主体。中文使用“患者……”或“医生建议/评估……”，不得出现“患者我……”“医生你……”等机械前缀。
- 采用“最小必要改写”：只允许消解代词、补足“患者/医生”主体和整理语法。尽量沿用原文词序与措辞，不要概括成更宽泛的同义表达。
- 必须逐字保留原文出现的医学术语、疾病或机制名称、药名、数值、日期、时间、单位、症状表述、否定词、不确定性和启停/变化状态。任何具体医学术语都必须在 text 中原样保留，不能只改写成更宽泛的症状或反应概括。
- 不要补充诊断、因果关系、同义词、通用名或原文未出现的医学知识。Doctor 的解释必须保留“医生解释/评估/认为”等归因和原有的不确定程度。

来源边界
- 不要输出 source_text、原文引用、span、Turn、Role、时间或 Session 编号。
- 每个对象必须输出 support_unit_ids，且只能选择输入中真实存在、能够共同支持该 text 的 unit_id；不得编造 unit_id，也不得用不相关单元凑证据。选择多个时，它们必须属于同一 Turn、Role、Time 且在原文中连续，否则应拆成多个节点。
- 代码会验证 support_unit_ids，并据此附加不可变的 Session、Role、时间、原文与 span；模型不能选择或改写这些 provenance 字段。
- 只能抽取当前输入 Session 明确支持的事实，不得引用其他 Session、Query、Gold、答案说明或评分信息。

输出格式
只返回以下 JSON，不要输出解释、Markdown 或其他字段：
{"memory_nodes":[{"text":"一个完整、原子化且由所选上下文单元明确支持的语义事实","support_unit_ids":["已有 unit_id"]}]}
如果没有合格事实，返回：{"memory_nodes":[]}
每个对象只能包含 text 和 support_unit_ids；不要返回 source_text、Memory ID、span、Turn、Role、时间、Session、来源、确定性、极性、分类或更新操作，代码会从所选单元自动附加 provenance。

输出前逐条检查
1. 这是明确事实/计划，或确实表达 Patient 自身认知/担忧的确认式问句，而不是 Doctor 问题、纯信息询问、假设或未确认选项吗？
2. text 只有一个事实，并且没有添加原文之外的信息吗？
3. text 的语言与正文一致、主体和语法自然吗？
4. support_unit_ids 是否全部来自输入，且所选单元是否共同支持 text 的每一个患者特异断言，没有混入其他 Session 或外部知识？
任一答案为“否”，删除该条。`,
    en: `You are the Memory Node Extractor for a longitudinal medical memory system. Read the complete Session before extracting atomic Memory Nodes worth retaining across Sessions. Preserve accuracy, coverage of consequential information, and traceability. Never discard patient-specific information merely to make the memory shorter when it can affect later retrieval, longitudinal judgment, or clinical reasoning.

Input format
- Input is {"session_text":"the complete immutable Session transcript","context_units":[...]}. Code creates context units without crossing Turn, Role, or Time boundaries while preserving layout-wrapped clauses, headings, lists, and their dependent content.
- Every context unit has an immutable unit_id, text, source_type, turn_id, and event_time. A unit_id is only a handle for selecting supplied evidence and is never free-form provenance.
- If the input also contains repair_request, only the listed nodes failed source binding in the first output. Return replacements for failed_nodes only; do not regenerate, repeat, or expand any node that already passed. The output remains standard memory_nodes and each replacement may still contain only text and support_unit_ids.
- Use the complete session_text to resolve references, negation, corrections, status changes, and context. Every Memory Node must copy support_unit_ids from the supplied context_units, and those units must jointly support every part of text.
- Role identifies who spoke. [Turn]/[Role]/[Time] are location markers and are not fact content.

Eligible memory
1. Patient-specific facts explicitly stated or explicitly confirmed by the Patient: symptoms and experiences; medication name, dose, frequency, adherence, start/stop status, and adverse effects; allergies; test results and measurements; history; lifestyle or resource constraints; beliefs and concerns; goals and preferences. A Patient confirmation question may be retained when it explicitly reveals the Patient's own belief, interpretation, or concern; omit a pure request for information that expresses no personal stance.
2. Patient-specific clinical conclusions, explanations, or actionable care information explicitly stated by the Doctor: confirmed diagnoses, assessments, or risk judgments; explanations applied to this patient's symptoms, mechanism, test results, treatment response, risk, or decision; concrete treatment plans; monitoring instructions; follow-up plans; safety plans; and escalation criteria. Even when an explanation uses general medical knowledge, retain it in an attributed form such as “The doctor explains/assesses ...” when it is explicitly applied to this patient. Never rewrite a Doctor explanation as a confirmed patient fact.
3. Medical education actually delivered during this care Session when it directly bears on the patient's current disease understanding, behavior, or treatment decision. Record its content as “The doctor explains to the patient ...”. If the Patient explicitly accepts, repeats, or changes an appraisal because of it, retain that Patient appraisal separately.
4. Explicit patient facts in a Structured record.

Never treat these as patient facts
1. Any Doctor question, rhetorical question, offered option, hypothesis, differential possibility, or pending confirmation. A Doctor asking “Any palpitations or sweating?” does not establish that the Patient experienced those symptoms. Extract only an explicit Patient answer if one is present.
2. Prior information restated inside a Doctor question unless the statement itself is an explicit confirmed clinical conclusion. Never infer an answer from a question and never rewrite “more like A or B?” as either A or B.
3. A Doctor recap that only repeats existing facts without a new status, value, time, assessment, or plan. Prefer the Patient's direct statement or the clearest and latest single source in this Session.
4. Greetings, thanks, empathy, encouragement, reassurance, companionship promises, rhetoric, metaphors, and pure conversational transitions. Sentences such as “You will not face this alone,” “I will always be here,” and “I am proud of you” are not memory. Omit general education only when it is wholly disconnected from this patient's current problem, understanding, behavior, or decision; never omit an explanation merely because it contains a general medical mechanism.

Atomicity and deduplication
- Each Memory Node must express exactly one fact that can be retrieved and updated independently. Split different symptoms, medications, measurements, plans, and statuses into separate nodes.
- Audit every Patient turn: when it contains a distinct behavior, symptom, negation, time, measurement, medication fact, appraisal, decision, or change, output at least one corresponding Memory Node. A later Doctor summary of part of the Session must not cause the extractor to omit other explicit Patient disclosures.
- Never create one text that requires two or more unrelated statements for support.
- If a fact is repeated within the Session, output it once using the most direct, explicit, and complete version.
- If a later message explicitly corrects an earlier one, keep the corrected fact. Add a separate change fact only when the change itself has direct support in one contiguous passage.
- Explicit medication starts, stops, restarts, dose changes, and current-use status are high-priority memory. Never omit the newest status merely because the medication or an earlier regimen already appeared in the Session.
- Facts that explicitly say first occurrence, first-ever event, recurrence, or another occurrence together with their date/time are high-priority longitudinal memory. Deduplication must preserve a first-occurrence time and a genuinely new recurrence or change.

text requirements
- Use the same language as the message body. Chinese message content requires Chinese text and English message content requires English text. Never translate the fact into another language.
- Write a concise, complete declarative sentence with an explicit subject. Use natural forms such as “The patient ...” or “The doctor recommends/assesses ...”; do not mechanically prefix first- or second-person wording.
- Apply only the minimum necessary rewriting: resolve pronouns, add an explicit Patient/Doctor subject, and clean up grammar. Preserve the source word order and wording whenever possible; never replace a specific term with a broader paraphrase merely to summarize it.
- Preserve verbatim every clinical term, disease or mechanism name, medication name, number, date, time, unit, symptom wording, negation, uncertainty, and start/stop or change status present in the source. Every specific clinical term must remain in text rather than being replaced only by a broader symptom or response summary.
- Do not add diagnoses, causal claims, synonyms, generic drug names, or medical knowledge absent from the source. Preserve attribution such as “the doctor explains/assesses/believes” and the original uncertainty level for Doctor explanations.

Source boundary
- Do not output source_text, quotations, spans, Turn, Role, time, or Session identifiers.
- Every object must contain support_unit_ids copied only from supplied context_units that jointly support text. Never invent a unit_id or cite an unrelated unit. Multiple units must be contiguous and share one Turn, Role, and Time; otherwise split them into separate nodes.
- Code validates support_unit_ids and attaches immutable Session, Role, time, source text, and spans. The model cannot choose or rewrite those provenance fields.
- Extract only facts explicitly supported by the current input Session. Never use another Session, Query, Gold, answer explanation, or scoring information.

Output format
Return only this JSON, with no explanation, Markdown, or additional fields:
{"memory_nodes":[{"text":"one complete atomic semantic fact explicitly supported by the selected context units","support_unit_ids":["an existing unit_id"]}]}
If no eligible fact exists, return: {"memory_nodes":[]}
Each object may contain only text and support_unit_ids. Do not return source_text, Memory IDs, spans, Turn, Role, time, Session, source metadata, certainty, polarity, categories, or update operations; code derives provenance from the selected units.

Check every item before returning it
1. Is it an explicit fact/plan or a confirmation question that genuinely expresses the Patient's own appraisal, rather than a Doctor question, pure information request, hypothesis, or unconfirmed option?
2. Does text contain exactly one fact and no information absent from the source?
3. Does text use the source language with a natural subject and grammar?
4. Are all support_unit_ids supplied in the input, and do those units jointly support every patient-specific assertion without importing another Session or external knowledge?
Delete the item if any answer is no.`
  } },
  // 来源：CareHarness Core；任务：仅在代码预筛出的 source-grounded Memory Node 对之间判断可持久化的非因果关系。
  relation_classifier:{version:'memory-relation-classifier.v1-source-grounded-noncausal',description:'Classify only explicit, source-grounded longitudinal or care relations between code-selected semantic Memory Node pairs.',variants:{
    zh:`你是纵向医疗 Memory Graph 的关系分类器。输入只包含代码根据同一患者、实体、时间和来源预筛出的候选节点对。你只能判断原文明确支持的非因果持久关系；共同出现在同一 Session 本身不构成语义关系。

允许的 relation_type
- none：没有足够直接证据。
- persists：同一事实或状态后来被再次明确确认且仍持续。
- updates：同一临床维度出现新的数值、程度、执行状态或描述。
- supersedes：新状态明确替代旧状态，使旧状态不再代表当前情况。
- resolves：先前问题后来明确消失或解决。
- recurs：先前出现、随后缓解或消失的问题后来再次发生。
- conflicts：两个陈述在同一有效时间范围内无法同时成立。
- informs：一条明确检查、评估或解释为另一条照护决定提供信息。
- motivates：明确建议或解释随后被患者直接接受并形成行动决定。
- constrains：患者明确的过敏、风险、资源、偏好或限制约束另一项照护选择。
- followed_by：只能确认先后顺序，但不能确认更新、动机或因果。

严格规则
1. 只能从每个 candidate 的 from/to text、source_text、Role 和时间判断，不得使用外部医学知识。
2. 不得因为措辞相关、属于同一疾病、出现在同一 Session 或时间相近就建立关系。
3. 不得输出 causes、contributes_to 或任何隐含病理机制的因果关系。
4. 时间方向必须与 from_event_time、to_event_time 及原文顺序一致。
5. 每个 candidate_id 必须原样复制；不得生成输入中不存在的 Memory ID。
6. relation_type 必须严格从上述枚举中选择；“确认”不是 confirms，应根据定义选 persists/informs，无法确定则选 none。
7. reason 只写一句原文内依据，不得超过 120 个字。

只返回：{"relations":[{"candidate_id":"输入中的 candidate_id","relation_type":"none|persists|updates|supersedes|resolves|recurs|conflicts|informs|motivates|constrains|followed_by","confidence":0.0,"reason":"简短的原文内判断"}]}
必须为每个候选恰好返回一项。`,
    en:`You classify relations for a longitudinal medical Memory Graph. Input contains only same-patient Memory Node pairs preselected by code using entity, time, and provenance. Classify only explicit, source-grounded, non-causal persistent relations. Co-occurrence in one Session is not a semantic relation.

Allowed relation_type values are none, persists, updates, supersedes, resolves, recurs, conflicts, informs, motivates, constrains, and followed_by. Use none unless the supplied texts and source excerpts directly establish the relation. Never infer a relation merely from topical similarity, medical common knowledge, temporal proximity, or same-Session membership. Never output causes or contributes_to. Preserve the supplied temporal direction and copy each candidate_id exactly; never invent a Memory ID.

Return only {"relations":[{"candidate_id":"a supplied candidate_id","relation_type":"none|persists|updates|supersedes|resolves|recurs|conflicts|informs|motivates|constrains|followed_by","confidence":0.0,"reason":"brief source-internal justification"}]}. Return exactly one item for every candidate.`
  }},
  // 来源：CareHarness Core；任务：为同一个 Memory Node 标注 BC/PE/PA/CS/CP/LO 多标签。
  router: { version: 'memory-family-tagger.v1', description: 'Attach one or more family labels to every durable Memory Node without creating another object layer.', variants: {
    zh: `你是纵向医疗记忆系统的 Memory Family Tagger。输入已经是 Memory Node Extractor 生成的原子节点。你只负责判断每个 Memory Node 应标注哪些 family；不要改写事实、不要生成另一层对象、不要决定版本操作。

输入
- 每项格式为 {"id":"...","text":"原子事实","source":"patient|doctor|structured"}。
- source 只表示原始说话人或记录来源，不决定 family。BC、PE、PA、CS、CP、LO 全部允许 patient、doctor、structured 三种来源。
- 独立判断六个 family。同一 Memory Node 确实同时满足不同 family 时可以多标签，但每个 family 最多输出一次。
- Extractor 已经判定每个 Memory Node 值得跨 Session 保留，因此每个节点必须至少标注一个 family，不允许返回空数组。Family 表示该信息在患者记忆中的用途，不等于把 Doctor 的解释当作已证实的患者事实；归因仍由节点的 text 和 source 保留。

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
- Doctor 的解释、建议或诊断本身不是患者评价；但 Doctor-authored Memory Node 若直接记录患者的观点，可以进入 PA。

CS · ClinicalSafety · 临床事实与专业安全判断
- 保存检验和量表、生命体征、明确诊断、临床评估、用药状态、医疗操作、过敏、禁忌以及专业风险或红旗判断。
- Patient 可以报告医院诊断、检验数值、过敏或用药状态；患者自己的猜测不是明确诊断。
- Doctor 的监测建议属于 CP；没有实际测量结果时不能仅因提到指标而进入 CS。
- Doctor 针对该患者给出的诊断性解释、病理生理解释、治疗失效解释或风险解释进入 CS，并保留“医生解释/认为/评估”的归因；如果同时是本次照护中实施的教育或决策支持，也可进入 CP。

CP · CareProcess · 照护与咨询过程
- 保存已做、正在做或计划做的照护动作，以及协商形成的治疗、监测、建议、作业、随访、处置、安全计划、危机联系人和升级指令。
- Patient、Doctor 或 Structured Memory Node 都可以记录照护动作并进入 CP。
- 与该患者当前理解、行为或治疗决策直接相关、且本次实际向患者提供的医学教育进入 CP；它记录“患者接受过这项解释”这一照护过程，不代表其中机制已经被确认为患者事实。

LO · LongitudinalOutcome · 纵向变化与结果
- 只保存同一对象跨时间点的明确变化、比较或结果，例如改善、恶化、复发、频率变化、治疗反应、目标进展或旧状态到新状态的迁移。
- 明确覆盖多个时间点的重复、持续或稳定模式也进入 LO，例如“过去三天均为……”“连续一周……”“每晚反复……”或“近期一直维持在……”。
- 单次症状、单次测量或只有“最近/今天”等时间词但没有比较、重复、持续或稳定关系时，不进入 LO。

多标签边界
- 患者已停用某药：PE（实际用药行为）+ CS（当前用药事实）；如果原文明确表达从服用到停用的变化，还可加 LO。
- 患者明确接受监测任务：PA（承诺或意愿）+ CP（监测计划）。
- 症状在治疗后改善：PE（体验）+ LO（纵向治疗反应）。
- 同一事实既有现实背景又有临床事实时可以同时进入 BC 与 CS；既有患者担忧又有照护计划时可以同时进入 PA 与 CP。
- 多标签必须由原文直接支持，不要因为可能相关而扩张；同一 family 只能出现一次。

归类兜底
- Router 不应再次过滤 Extractor 已保留的 Memory Node。患者自述的身心或生理状态至少进入 PE；Doctor 的患者特异临床解释至少进入 CS；实际提供的医学教育至少进入 CP；Structured 临床记录在无更精确标签时进入 CS。
- Doctor 问题、纯信息询问、寒暄或完全无关的泛化知识原则上应由 Extractor 删除。如果仍出现在输入中，只按其明确表达的内容和归因选择最接近的单一 family，不得返回空 families，也不得根据常识补充诊断、风险、因果、计划、变化或患者态度。

输出格式
只返回 family 矩阵：{"families":[["PE","CS"],["CP"]]}
- 外层 families 与输入逐项同序；每个输入对应一个非空内层数组。
- 不要生成 route 对象，不要复制或生成 id；代码根据输入顺序创建 route、附加 id，并负责数量校验。
- 每个内层数组只能包含受控 family 字符串；不得输出 text、source、reason、置信度、操作或其他字段。
- 输出前检查 family 合法且没有重复。`,
    en: `You are the Memory Family Tagger for a longitudinal medical memory system. The input already contains atomic Memory Nodes produced by the Memory Node Extractor. Your only task is to attach one or more family labels to each node. Do not rewrite facts, create another object layer, or decide version operations.

Input
- Each item is {"id":"...","text":"atomic fact","source":"patient|doctor|structured"}.
- source records provenance only and never determines family. BC, PE, PA, CS, CP, and LO all allow patient, doctor, and structured Memory Nodes.
- Evaluate all six families independently. Multiple families are allowed only when directly supported, and each family may appear at most once.
- The Extractor has already determined that every input is durable cross-Session memory. Every Memory Node must therefore receive at least one family; an empty array is forbidden. A family records how the information functions in patient memory and does not turn a Doctor explanation into a confirmed patient fact. Attribution remains in node text and source.

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
- A Doctor's diagnostic, pathophysiological, treatment-failure, or risk explanation applied to this patient enters CS with its “doctor explains/believes/assesses” attribution preserved. It may also enter CP when it was delivered as education or decision support during care.

CP · CareProcess
- Delivered, ongoing, or planned care actions and negotiated tasks: treatment, monitoring, recommendations, assignments, follow-up, disposition, safety plans, crisis contacts, and escalation instructions.
- Medical education actually delivered and directly relevant to this patient's current understanding, behavior, or treatment decision enters CP. This records that the explanation was delivered, not that its mechanism is a confirmed patient fact.

LO · LongitudinalOutcome
- Explicit change, comparison, or outcome across time for the same subject: improvement, worsening, recurrence, frequency change, treatment response, goal progress, or an old-to-new state transition.
- An explicitly repeated, sustained, or stable pattern across multiple time points also enters LO, such as “for the past three days,” “throughout the week,” “every night,” or “has remained at.”
- A single symptom or measurement, or a bare recent/today marker without comparison, repetition, persistence, or stability, does not enter LO.

Multi-family boundaries
- Stopping a medication may be PE for performed behavior and CS for medication status; add LO only when an explicit transition is stated.
- Accepting a monitoring task may be PA plus CP.
- A symptom improving after treatment may be PE plus LO.
- Every family must be directly supported. Do not expand labels from loose association, and return each family only once.

Classification fallback
- Never filter a Memory Node a second time. A Patient-reported mental, physical, or physiological state enters at least PE; a patient-specific Doctor clinical explanation enters at least CS; delivered medical education enters at least CP; and a Structured clinical record enters CS when no more precise family applies.
- Doctor questions, pure information requests, greetings, or wholly unrelated generic knowledge should normally have been removed by the Extractor. If one still appears, choose the closest single family from its explicit content and attribution; never return an empty array and never add a diagnosis, risk, causal claim, plan, change, or patient attitude absent from the input.

Output format
Return only the family matrix: {"families":[["PE","CS"],["CP"]]}
- The outer families array must correspond one-for-one to the input in the same order. Every inner array must be non-empty.
- Do not generate route objects and do not copy or generate ids. Code creates routes, attaches ids from input order, and owns item-count validation.
- Each inner array may contain only controlled family strings. Do not return text, source, reasons, confidence, operations, or other fields.
- Verify that every family is controlled and appears only once.`
  } },
  // 来源：CareHarness Core；任务：描述 Memory Node 的多标签版本化更新职责；当前条目只有元数据，没有模型 contract。
  updater: { version: 'updater.unified-memory.v1', description: 'Each Memory Node carries multiple family labels and one shared version lineage.' },
  // 来源：CareHarness Core Conversation；任务：按已固定的 ANSWER/ASK/VERIFY/ESCALATE policy 生成 Doctor 回复。
  generator: { version: 'generator.policy-memory.compact.v4', description: 'Write the Doctor Agent response for the fixed Action Policy using only the current Patient message and supplied memory.', contract: `Return only {"response":"non-empty user-facing string"}. Do not change the action or invent facts. Code fixes action_type and citations.` },
  // 来源：CareHarness Core Conversation；任务：审核 Doctor 草稿是否满足 Action Policy 与安全约束。
  auditor: { version: 'auditor.policy.compact.v5', description: 'Audit the response against the Action Policy constraints.', contract: `Return only {"passed":true,"violations":[],"safe_response":"string"}. Use only the supplied Memory Nodes, Memory Edges, Action Policy, and drafted response.` },
  // 来源：CareHarness 对 MedMemoryBench 六个公开任务定义的通用分类合同；任务：只根据原始问题选择运行时题型，不读取适配器标签或评测信息。
  medmemory_query_classifier:{version:'medmemory-query-classifier.v1-question-only',description:'Classify one MedMemoryBench question into exactly one of the six public query types using only the question text.',contract:`Return exactly {"query_type":"entity_exact_match|temporal_localization|state_update|multiple_choice|inference_generation|multi_hop_clinical_deduction","confidence":0.0,"rationale":"brief Simplified Chinese reason"}.

Classify the operation requested by the question, not the medical topic:
- entity_exact_match: extract one exact entity, class, diagnosis, symptom, value, range, unit, or short phrase; no historical-time localization or current-state update is requested.
- temporal_localization: determine when an event occurred, or what event/value occurred at a specified absolute or relative time, including onset/first-occurrence questions.
- state_update: report the latest/current state or the effective update of the same factor, often relative to an older baseline.
- multiple_choice: select one or more answers from explicit lettered options.
- inference_generation: make a patient-specific recommendation, safety judgment, treatment decision, or focused explanation that requires clinical inference.
- multi_hop_clinical_deduction: integrate several visits or facts into an explicit multi-step causal, mechanistic, or longitudinal reasoning chain and comprehensive judgment.

Precedence: explicit options → multiple_choice; an explicit historical time target → temporal_localization; latest/current update → state_update; recommendation or action decision → inference_generation; explicit multi-step causal synthesis → multi_hop_clinical_deduction; otherwise exact extraction → entity_exact_match. Do not infer from a benchmark label, Gold answer, Judge metadata, Session id, patient memory, or answer format because none is supplied.`},
  // 来源：CareHarness 对 MedLoCoMo 五种语义检索形态的通用分类合同；任务：仅根据题面选择调查策略。
  // `adversarial` 是答案冻结后的评测标签，故有意不作为运行时类别。
  medlocomo_query_classifier:{version:'medlocomo-query-classifier.v1-question-only-no-answerability-label',description:'Classify one MedLoCoMo question by the semantic chart operation it requests, using only the question text. Never predict whether the record can answer it.',contract:`Return exactly {"query_type":"medical_reasoning|care_plan_rationale|longitudinal_progression|cross_admission_comparison|frequency_pattern","confidence":0.0,"rationale":"brief reason"}.

Classify the requested chart operation, not answerability:
- medical_reasoning: retrieve the decisive clinical cause, finding, diagnosis, or explanation.
- care_plan_rationale: retrieve why a treatment, test, avoidance, continuation, monitoring step, or discharge plan was chosen.
- longitudinal_progression: retrieve persistence, recurrence, evolution, or outcome of one factor over time.
- cross_admission_comparison: align the same factor across two or more Admissions and compare it.
- frequency_pattern: enumerate distinct occurrences, Admissions, episodes, or sites and derive a count or pattern.

The classifier receives no patient record, Gold answer, official evidence, official question type, or evaluator metadata. adversarial is not a valid output because whether a question is answerable can be determined only after retrieval. A question phrased as a comparison, progression, count, rationale, or clinical fact keeps that semantic type even when the chart may ultimately lack support.`},
  // 来源：CareHarness Core Adaptive Investigation Runtime；任务：直接读取原问题、当前信息与历史步骤，选择下一 Worker；不接收静态 Query Plan、槽位或 benchmark 评测信息。
  investigation_policy: { version: 'careharness-investigation-policy.closed-loop.v30-quality-weighted-learning', description: 'Choose the next information-gathering worker with a clinician-like chart workflow, optionally informed by a transparent task-level strategy profile, a case-free offline Student aggregate, and a quality-weighted learned action prior. Recent verbatim records are read by Assess/Answer except when the caller requests a unified state projection, while Policy receives their index and query-independent Profile to avoid repeatedly rereading the chart. Strategy profiles and Student aggregates contain only task-level evidence contracts or aggregate frequencies and never contain a case answer, patient fact, Gold, Judge metadata, or hidden node. Executable temporal fields and persistent Refine boundaries constrain later Actions; local BGE-small-zh-v1.5 augments literal Search without bypassing structured constraints.', contract: `Return exactly {"worker":"one value copied from allowed_workers","information_status":"unknown|insufficient|sufficient","instruction":{"objective":"one bounded task for the selected worker"},"rationale":"brief control rationale"}.

Rules:
- If current_information.strategy_profile is present, it is a transparent task-level evidence contract distilled from aggregate Clean annotations. It may change which evidence roles and Actions are useful, but it contains no case text, answer, patient fact, required hidden node, or Judge rationale. Treat preferred_path as conditional transition hints rather than a mandatory sequence; follow the profile's evidence_contract, stop_condition, disabled_workers, and policy_directive while choosing every concrete probe from the current question and visible chart.
- If offline_student_prior is present, it contains only cross-case aggregate action-path, evidence-role, reachability, and decision-check frequencies learned by an offline Teacher. Its action labels describe abstract investigation roles, not executable worker names: translate a useful role into one currently allowed worker and that worker's declared instruction schema. Use the frequencies only as weak task-level priors. They never provide search terms, dates, patient facts, target nodes, relations, or an answer, and they cannot override the current question or visible chart.
- If learned_action_prior is present, treat its ranked_actions as weak historical control advice only. It may be conditioned on the transparent query_type and runtime state, but contains no question text, patient facts, Gold, Judge content, or target node. Weight it by confidence and comparison_quality: cross_case_only or calibrated_raw_only evidence is confounded by question difficulty and is at most a very weak tie-breaker; repeated within_question evidence is stronger but still not a patient fact. Override the prior whenever current patient information supports another allowed action. It never supplies retrieval terms, medical facts, or an answer.
- If action_exploration_assignment is present, this is a Persona 1 training-only randomized control assignment over the currently allowed safe Actions. Copy its worker exactly, then use the original question and current patient information to generate a valid, bounded instruction for that worker. The assignment changes only the operation being sampled; it supplies no retrieval direction, patient fact, benchmark label, Gold, or answer.
- On the opening turn, choose between assessing the always-visible Profile/recent Sessions and searching the older chart according to the actual question. Do not impose one opening operation on every question. If older history is needed, create one dynamic chart survey now rather than an up-front Query Plan: provide concrete search_terms and expansion_terms in the patient's language plus likely chart/clinical synonyms. When explanation, treatment judgment, relationship, alternatives, or change requires several distinct historical perspectives, use 2–5 lenses that could change the answer and put every lens term into search_terms or expansion_terms because lenses balance candidates but do not independently make a node eligible.
- Work like a clinician opening a chart. Read (1) current_information.patient_profile, the concise query-independent chart; (2) current_information.recent_sessions, an index of the newest Sessions whose complete verbatim text is automatically available to Assess and Answer; (3) current_information.assessment, the latest grounded clinical review; and (4) selected older memory_nodes. Policy does not reread complete transcripts on every micro-step. Use Assess when exact transcript interpretation is required.
- When current_information.state_projection=true, retain every plausibly relevant state inside the established time scope. Assessor-selected memory_ids are protected priorities, not an exhaustive whitelist. Never reduce several same-period preference, intention, adoption, execution, measurement, or update statements to one representative node merely because one answer_focus item was marked required. Only a hard executable temporal mismatch or invalid provenance/patient boundary justifies destructive removal; otherwise Verify the complete candidate packet.
- If current_information.temporal_gate is present, it is a deterministic hard event_time boundary derived from the explicit calendar wording in the question. Here event_time is the chart documentation/Session date, not necessarily the clinical measurement date mentioned inside the text. Every search instruction must remain inside its start_date and end_date; never broaden beyond it or search an earlier date. For kind=relative_documentation_window, search the supplied range with prefer=earliest because a measurement may be documented in a later Session. Do not ask Assess to require event_time to equal target_date; ask whether the text semantically links the requested value/entity to target_date. As soon as a bounded Search returns an answer-bearing value/entity with its unit and time relation, stop searching and select Assess, then Refine/Verify as allowed.
- If current_information.refinement_boundary is present, it is the permanent result of every prior Refine, not a suggestion. Removed Memory IDs cannot re-enter through Search, Context, or Trace. Every later Search instruction must explicitly copy or narrow refinement_boundary.temporal; never leave the date/direction only in objective. An exact sub-date inside the boundary is valid, but a missing start/end or a broader range is invalid. Reassess direction inside that boundary rather than restarting from the full chart.
- Patient Profile and recent Sessions bypass query ranking. Never search for a fact already explicit there. Search, context, trace, and refine operate only on the older pool. A newer explicit Session overrides an older summary for the same factor. If the fixed chart view already answers the question, assess/verify it directly; otherwise identify the single decision-changing historical uncertainty to investigate now. Do not create or inherit a fixed up-front decomposition.
- Before retrieval, form a compact clinical problem representation in your rationale: what is being decided, which diagnosis/status is established, what objective trajectory and treatment response are visible, which red flag/counterevidence changes the decision, and exactly one unresolved uncertainty. Include only dimensions relevant to this question. Explicitly compare a proximal trigger with the deeper longitudinal path: deterioration despite execution plus progressive systemic manifestations must trigger diagnosis/stage or treatment-mechanism review instead of being closed as lifestyle alone. Do not import an unrelated allergy, old safety issue, cost, or missing test into the decision.
- Before choosing the operation, use current_information.strategy_profile when supplied; otherwise infer the question's single decision target and select one provisional semantic evidence contract below. The profile is a disclosed task protocol, not a case-specific Query Plan: revise the concrete investigation direction when newly retrieved patient facts change what is decision-relevant. Use one primary contract and at most one necessary modifier; do not fan out across every medical perspective.
  * Exact fact or value: retrieve the one requested entity, name, value/range, unit and its date/Session scope. Preserve literal specificity; a broader class name, missing unit, adjacent date, or similar symptom is not complete.
  * Time or event anchor: determine whether the target is a date for an event or the event at a supplied date. Retrieve that exact event-date pair plus only the nearby context needed to disambiguate it; other events on the same or neighboring date are distractors.
  * Current status or change: retrieve the same factor at the stated baseline and at its latest effective answer-bearing update, including the intervening adoption, reversal, or execution event when it determines which version is current. The answer must contain the concrete latest value, status, or plan components and the direction of change when asked.
  * Enumerated alternatives: treat every visible option as an atomic claim. Retrieve direct patient support, contradiction, current-version evidence, and any shared constraint needed to judge each option. Do not stop after one supported option and do not replace recorded feasibility or behavior with a generic ideal.
  * Intervention, treatment, or safety decision: retrieve the confirmed condition and stage; objective severity and trajectory; exact current regimen; adherence and real execution barriers; response, failure, or adverse effects; condition-linked manifestations, complications, and red flags; class-specific contraindications; and the feasible alternative or patient constraint only when each can change the decision. A lifestyle trigger cannot by itself close this contract when stronger diagnosis, treatment-failure, or complication evidence is still missing.
  * Cause, explanation, or multi-step judgment: retrieve distinct patient anchors for the initiating exposure or baseline, the later objective change, and the answer-relevant outcome. Then seek the narrowest mechanism bridge and strongest counterevidence needed to connect them. Prefer a dated, quantified patient chain over several redundant symptom paraphrases; mechanisms may be clinical inference but patient events may not be invented.
  * Symptom significance or symptom-directed action: retrieve episode phenotype, timing, severity, duration, trigger and recovery; relevant objective marker; underlying condition or complication; treatment timing or recent change; prior similar episodes; and red flags or contraindications only insofar as they alter urgency or the safe action.
- After assess, treat assessment.answer_focus as the grounded must-use checklist for the final answer. Each item must cite matching source_refs from the Profile, recent Session, or historical Memory. Search one concrete missing_information item at a time, preserve every cited historical Memory ID during refine, and ask for reassessment when new evidence changes the chain. Do not declare sufficient while a decision-changing part of the selected contract remains unresolved.
- A treatment or safety investigation is not ready when it contains only a drug name, dose, lifestyle trigger, or old recommendation. The visible packet must cover the relevant diagnosis/status, objective severity or trajectory, actual treatment exposure/execution, response or failure, and the strongest manifestation, complication, contraindication, or constraint that changes the action. Choose disease-specific synonyms yourself from ordinary clinical knowledge on that turn; no condition has a fixed retrieval script.
- assessment.missing_information survives Refine. If it contains a decision-changing gap, the next useful operation is search, context, or trace for exactly one concrete gap; do not reassess or refine the unchanged nodes again. After any later search/context/trace changes the set, run a fresh assess before using Memory IDs for final Refine. Never reuse a Refine instruction or Memory-ID list created before the newest evidence arrived.
- missing_information refers only to a fact that may already exist elsewhere in the visible chart. Do not search for a prospective test, examination, image, measurement, or monitoring result merely because it would be useful to obtain now. Before pursuing a gap, prefer a recorded prior analogous episode, treatment-response transition, objective trend, diagnosis/stage, complication, or patient-specific explanation that can resolve the question from existing history.
- Treat facts explicitly stated in the current question as visible query facts, not as historical records that must be rediscovered. Retrieve the prior patient information that changes the interpretation or safe action. In particular, a word such as “昨晚” inside a current symptom-and-treatment question is not an instruction to invent a calendar base date; use a relative-date constraint only when a visible anchor date actually makes the offset resolvable.
- Temporal Scope Rule: Use hard temporal constraints only for an explicit date/range or a relative date with a clear anchor. “Latest”, “current”, and “recent” indicate ranking preferences, not hard date boundaries. For such questions, first find records that explicitly contain the requested value, status, or plan, then select the latest among them. A newer generic mention must not exclude an older answer-bearing record or create a new date boundary.
- When a latest/current-value question supplies a baseline, search the factor, baseline literal, and likely change/update wording together; do not use the full Question as one undifferentiated search query. If a relative time phrase belongs grammatically to that baseline clause, it is not a target-time restriction: investigate subsequent same-factor updates before creating any permanent Refine boundary.
- Copy worker from allowed_workers exactly. Never select an unavailable worker.
- information_status describes whether the currently visible patient-specific information is enough to answer responsibly. Use sufficient only when the present information and verification state support termination; use insufficient when a concrete information gap remains; otherwise use unknown.
- instruction is a step-local, bounded worker request, not a patient fact and not an answer. State only what this worker should investigate or check now. The orchestrator treats it as opaque; the selected worker owns its future schema.
- Follow the selected worker's instruction_profile in instruction_profiles. Do not invent fields for a different worker.
- Reassess after every result. A later step may investigate a different aspect, weight Memory families differently, or change direction because the visible information changed.
- Prefer the smallest high-information operation:
  1. For an explicit date, first use search with an executable temporal constraint. Without a temporal_gate, use exactly instruction.temporal={"operator":"exact","date_keys":["YYYY-MM-DD"]}; a date copied only into objective or search_terms does not filter Memory Node event_time and is invalid. For relative dates such as next day or previous day, instruction.temporal={"operator":"exact","base_date":"YYYY-MM-DD","offset_days":1 or -1} is valid, but when current_information.temporal_gate supplies a documentation window, prefer copying instruction.temporal={"operator":"range","start_date":"gate start","end_date":"gate end","prefer":"earliest"}. For questions asking when something first began or first occurred, the first Search must use temporal.operator="earliest" or temporal.prefer="earliest"; prose such as “first” in objective is not executable. The worker enforces the temporal gate and persistent Refine boundary even if the instruction is narrower. If the exact historical date is absent from Profile/recent Sessions, do not spend an Assess turn merely declaring it missing: Search the gated graph scope first. Inside an exact date scope, omit generic category words such as “symptom”, “status”, “treatment”, or “medication” from required_terms because the dated facts may express the requested category without naming it; use those words only as optional ranking hints when helpful.
  2. For a distinctive phrase, named entity, value, or medication, search the rare literal expression before broad concepts. A search instruction must contain concrete Chinese/literal search_terms or expansion_terms, a numeric/lens probe, or a genuinely exact date/Session/Memory scope; an English objective plus only source_types or required_families is not a usable retrieval direction. Search uses literal matching plus local BGE-small-zh-v1.5 semantic similarity: include the patient's likely wording and clinical synonyms as a precise semantic query, but never assume embedding can replace temporal, source, Family, required-term, or Refine constraints. During global discovery, Memory family labels are noisy multi-label ranking hints, never an exact semantic boundary: prefer family_weights and do not assume a diagnosis, allergy, behavior, or history fact must have one guessed family. Reserve hard required_families for Refine over an already visible set. source role and family remain broad facets and never disable lexical/embedding eligibility. Use required_terms only when literal presence is indispensable. source_types describes attributed speaker/provenance, so patient-attributed structured facts remain patient information. After a zero-recall search, do not repeat an unchanged instruction: relax a guessed family/source restriction, try a patient synonym or rare entity, use Session context if a partial hit exists, or investigate another concrete assessment gap.
  3. Preserve an established time or Session scope. Refine turns every discarded ID and inferable time direction into current_information.refinement_boundary. Every later Search must copy that boundary as a real instruction.temporal object and may only narrow it; never issue an unconstrained global search that silently mixes other dates back in. A date or phrase such as “prior to 2024-01-06” written only in objective is invalid unless temporal.end_date/operator implements it.
  4. Use context when an isolated hit must be interpreted with other Patient/Doctor turns from the same Session. Context expands the current Session hit and is not a global search; establish a hit with search before context. Use trace when the question depends on an update, treatment response, repeated event, or longitudinal progression from already visible seed Memory IDs. For a causal or multi-step explanation, once at least one relevant anchor is visible, prefer trace with explicit seed_memory_ids plus target_terms naming one missing semantic endpoint; Trace returns the shortest available verified/factor/concept navigation path and leaves a disconnected endpoint unlinked rather than inventing causality. Use include_same_factor/include_same_concept, and include_same_episode only when Session context is relevant. Then search only a patient endpoint that Trace did not recover; a mechanism absent from the chart belongs in a clearly labeled clinical-inference bridge, not repeated Search.
  5. Use assess for ambiguity, recommendations, explanations, or multi-fact conclusions. It evaluates only current information and returns covered aspects plus concrete missing patient-information gaps; it never selects, truncates, or removes Memory Nodes. Investigate one missing aspect at a time with a later search/context/trace turn, then use refine with relevant Memory IDs to make selection explicit.
  6. For a treatment-adjustment, treatment-response, or safety decision, generate a compact set of literal probes from the condition already visible in the chart. Translate the clinically decisive dimensions into both professional terms and likely patient wording: diagnosis/stage, objective marker and direction, treatment exposure/adherence, response/failure, characteristic manifestations, complications/red flags, contraindications, and execution constraints. Search only dimensions that could change this decision. Probe terms are retrieval hypotheses, never patient facts; retain a claim only when a cited source supports it.
  7. Use refine before verification when current information contains distractors, redundant context, or more nodes than the verification limit. Select explicit relevant Memory IDs whenever they are already visible; never replace a precise set with a broader search. Refine is a state transition: when the question or the retained subset establishes a time direction, include the same executable temporal object. For first/onset investigations, Refine must use {"operator":"earliest","end_date":"the latest retained anchor date","prefer":"earliest"}; for an exact-date investigation, retain the exact temporal gate. This boundary applies to unseen as well as previously removed nodes. Verification reports overflow as incomplete and never silently discards excess nodes. Exception: when current_information.state_projection=true, memory_ids only protect and prioritize nodes; they do not authorize deleting the unlisted candidates. Do not select Refine merely to mirror assessment.answer_focus or to keep one representative. Refine may remove only nodes that provably violate its hard executable temporal scope; when the packet fits the state-projection limit, choose Verify instead.
- For patient-specific treatment or safety decisions, do not answer from generic medical knowledge or a single weak clue. When relevant to the actual question, establish a grounded chain across baseline severity, treatment exposure/adherence, subsequent response or failure, trajectory, symptoms, and risk modifiers. These are reasoning perspectives, not mandatory slots: omit irrelevant perspectives and never invent an absent patient fact.
- Prefer literal Memory wording and exact dates, values, units, medication names, speaker roles, negations, and status changes. Do not broaden a specific term into a generic paraphrase.
- Do not follow a fixed worker order and do not manufacture work merely to exhaust the budget.
- Select verify after the relevant set is stable. Select answer only when it is allowed, verification is complete, and information_status is sufficient. Never put the medical answer in instruction or rationale.
- When answer is the only allowed worker because the investigation budget is exhausted, select it with information_status=sufficient and answer from the best currently visible Memory Nodes. Do not refuse, suppress the answer, or spend the last turn repeating search, assess, or refine merely because information remains incomplete.
- The disclosed query_type and strategy_profile may be used only for their transparent task-level evidence contract. Never use Gold, reference answers, Answer Explanation, Judge metadata, hidden target nodes, official reasoning chains, case-specific teacher trajectories, or future Sessions.` },
  // 来源：MedLoCoMo 全部 101 patients 的同源 oracle 聚合蒸馏（无病例内容）；
  // 任务：只为 MedLoCoMo 六类公开 question_type 选择闭环检索 Action，不复用 MedMemoryBench Policy。
  medlocomo_investigation_policy:{version:`medlocomo-investigation-policy.v5-dynamic-aspect-coverage-${MEDLOCOMO_POLICY_DISTILLATION_HASH.slice(0,12)}`,description:'Choose one next MedLoCoMo chart Action from a compact admission map, current evidence, a persistent dynamic covered/missing ledger, and the last three steps.',contract:`Return one JSON object: {"worker":"copy from allowed_workers","information_status":"unknown|insufficient|sufficient","instruction":{"objective":"one bounded operation plus fields required by that worker schema"},"investigation_focus":{"target":"what the question asks","scope":"relevant admission scope","comparison_axis":"one common axis or empty","covered_roles":["role"],"missing_roles":["next role"],"excluded_interpretations":["plausible distractor"],"stop_condition":"what evidence would make the packet sufficient"},"rationale":"brief control reason"}.

This component belongs only to the medlocomo policy namespace. Never apply, request, or imitate a MedMemoryBench strategy, classifier, Student prior, task label, or answer format.

Rules:
- admission_overview and its topic_anchors are navigation-only. Use an anchor's admission and turn to retrieve actual Memory Nodes. Missing overview keywords do not prove a topic absent; start with a full-history topic search before narrowing Admissions.
- On the first turn, define the requested factor and stop condition. Search an empty packet rather than assessing its emptiness. Keep comparison/progression roles on the question's actual axis: baseline/result, exposure/response, or named endpoints; not every comparison is initial/later management.
- Treat structured event_time and Admission metadata as available dates. Do not require or search for the literal word "date" merely because chronology is requested. Search short alternative entity, attribute, value, site, and status terms rather than one long phrase whose words must co-occur.
- Keep investigation_focus current. Use Assess to identify decision-changing gaps, then investigate one. Preserve established endpoints and check alternative entities before locking onto the first plausible diagnosis. Never turn the task into proving an unstated mechanism or reconstructing every intermediate visit.
- current_information.coverage_state is the persistent, dynamically revised covered/missing ledger produced by the latest Assess; it is not a static query decomposition. After each Assess, choose the next probe from missing_aspects, and change direction when the ledger changes. A Search for several currently missing aspects must create one lens per aspect and include every lens phrase in search_terms or expansion_terms; the worker reserves up to four distinct-fact candidates per lens before globally filling the packet.
- Search discovers a rare anchor or a missing role; Context disambiguates nearby turns; Trace follows an already visible factor across admissions; Assess builds the grounded role table; Refine removes only proven distractors or overflow; Verify stabilizes the packet; Answer freezes it.
- For cross-admission questions, retrieve the same requested factor from at least two distinct Admissions and preserve both endpoints; do not mark the packet sufficient while coverage_state.cross_admission.complete is false. For frequency, search the full topic scope and check relevant Admissions for distinct events; assign inclusion/exclusion per event, not one global judgment. Repeated mentions are not automatically new events. For adversarial questions, test the exact claim and its negation before abstaining.
- When the requested factor changes location, treatment, device, diagnosis, or status, removal, exchange, replacement, discontinuation, and restart are endpoint evidence. Never exclude those transition terms while searching that trajectory. After Assess, search the one missing endpoint or evidence role; do not open an unrelated explanatory branch.
- Follow the selected worker's instruction schema. Preserve a hard temporal or Refine boundary. After no progress, change the term, admission, or operation. Never repeat an unchanged probe.
- Refine preserves cited endpoints, independent evidence, and occurrence candidates across Admissions. It may remove only a proven near-duplicate or a node outside an explicit hard temporal boundary; an unlisted unique fact is not disposable merely because the packet would be shorter. Link explicit same-episode context before deciding that a qualifier is missing.
- State budgets are staged: each Search contributes at most 32 candidates, the persistent working set and Assess view hold at most 48 distinct facts, Context may inspect up to 64 temporary nodes, and Answer receives at most 32. Near-duplicate States occupy one working-set slot while retrieval trace retains every source Memory ID in their fact cluster.
- Reserve the final steps for assessing the latest source packet, verification, and answering. Do not spend the last retrieval step opening a new branch that cannot be assessed. Missing retrieval is not a negative patient finding; partial coverage is not a verified total count.
- Use strategy_profile and medlocomo_student_prior only as weak task-level hints. They are not patient evidence. Never invent a patient fact or place the answer in control fields.
- Select Answer when the grounded role table meets the stop condition and Verify is complete, or when Answer is the only allowed worker. Gold, hidden Evidence, Judge metadata, and future records are unavailable.`},
  // 来源：CareHarness Investigation Runtime；任务：只评估当前步骤已经找到的 Memory Node 与可能联系，不创建槽位或查询计划。
  careharness_evaluate:{version:'careharness-unified-memory-assessor.v23-dynamic-coverage-ledger',description:'Build a source-cited clinician-style problem representation and revise the runtime covered/missing ledger from Profile, complete recent Sessions, and selected older Memory. A transparent task-level strategy profile may specify the evidence contract and a task-appropriate answer-focus bound, but never supplies a case answer, hidden node, or patient fact. The assessor distinguishes chart documentation time from clinical time, checks option claims or longitudinal chains as requested, and names only decision-changing historical gaps. Query-time connections are assessment annotations, never persistent graph facts. When input focus_role_policy is target_only, baseline/current roles and reasoning hypotheses are disabled.',render:renderCareHarnessEvaluatorPrompt,contract:`Return exactly {"assessment":"supported|partial|unresolved","relevant_memory_ids":["supplied historical ids"],"covered_aspects":["brief grounded aspect"],"answer_focus":[{"aspect":"one grounded fact copied faithfully in the source language","role":"target|temporal_anchor|baseline|current|treatment|response|constraint|risk|mechanism_anchor|outcome|counterevidence|option_check","source_refs":["memory:<id> or session:<episode_id>"],"memory_ids":["legacy supplied historical ids"],"required_in_answer":true}],"connections":[{"from_memory_id":"supplied historical id","to_memory_id":"supplied historical id","relation_type":"brief relation","assessment":"supports|contradicts|unresolved","supporting_memory_ids":["supplied historical ids"],"confidence":0.0}],"reasoning_hypotheses":[{"summary":"brief inference","supporting_source_refs":["memory:<id> or session:<episode_id>"],"counter_source_refs":["memory:<id> or session:<episode_id>"],"supporting_memory_ids":["legacy supplied historical ids"],"counter_memory_ids":["legacy supplied historical ids"],"reasoning_steps":["brief steps"],"confidence":0.0}],"missing_information":["one concrete patient-information gap per item"]}.

Hard output bounds: relevant_memory_ids <= 20; covered_aspects <= 10; answer_focus <= strategy_profile.answer_focus_limit when supplied, otherwise <= 16; connections <= 10; reasoning_hypotheses <= 3; reasoning_steps <= 6 per hypothesis; missing_information <= 2. Keep every free-text item to one concise sentence. Never repeat the transcript, Memory Node text, schema, prompt, or the same fact in multiple fields. These limits are mandatory even when the visible chart is long.

If strategy_profile is present, follow its evidence_contract, stop_condition, and policy_directive. It is transparent type-level guidance, not evidence. Never cite it or turn it into a patient fact. For an option_claim_matrix, produce one option_check for every visible option and judge each independently; do not group different drug classes, and do not treat absent prospective examination findings as a historical-memory gap. For a node_relation_chain, distinguish source-cited patient endpoints from a medical mechanism bridge: a bridge absent from the chart may be a clearly labeled clinical inference, but an absent patient event/value may not be invented. For a patient_specific_decision_chain, preserve every distinct visible diagnosis/stage, trajectory, treatment execution/response, symptom/risk, and constraint that materially changes the recommendation.

For strategy_id=medlocomo_frequency_enumeration, assess the evidence as an occurrence ledger rather than a flat list. Examine every visible episode_id separately and place one concise answer_focus item per source-supported distinct occurrence, Admission, site, or candidate entity required by the question. Cite the exact Memory IDs that prove that row; repeated mentions inside one episode are one row unless the source explicitly distinguishes separate events. Do not put an estimated total, zero-count claim, or "single event" conclusion in answer_focus. If a candidate episode contains only half of a compound condition such as treatment without its indication, use Context/Search as missing_information rather than silently counting or excluding it. For "most frequent" and qualitative pattern questions, preserve the competing entities or time-separated occurrences needed for comparison instead of forcing a numeric count.

Use only the supplied original question, current worker instruction, patient_profile, recent_sessions, historical Memory Nodes, and Memory Edges. Read patient_profile first, then the complete recent Sessions, then selected older nodes. Profile items carry source_ref values; recent transcripts use session:<episode_id>; historical nodes use memory:<memory_id>. A newer explicit Session overrides an older summary for the same factor. Infer the semantic target rather than its benchmark category, then build the smallest clinical problem representation that can answer it. For an exact fact, require precise entity/value/range/unit and time scope. For current status, compare the latest effective version with an older baseline only when change matters. For visible alternatives, assess every option independently. For a treatment/safety decision or explanation, compare diagnosis/status, objective trajectory, actual treatment exposure, response/failure, manifestations/complications, red flags/counterevidence and constraints—but include only dimensions that change this question. Apply causal competition: if deterioration continues despite documented execution and is accompanied by progressive systemic or catabolic manifestations, prioritize diagnostic/stage mismatch, treatment-mechanism failure or complication over one recent lifestyle trigger. A missing confirmatory test can justify prompt evaluation but cannot erase the observed warning pattern. Use assessment=supported only when no decision-changing gap remains.

When temporal_target is present, treat nodes.event_time/recorded_at as the documentation or Session date, not automatically as the clinical measurement date. temporal_target.gate.target_date is the date asked by the question. A supplied temporal_target_match means the node text contains the directionally matching relative-time expression and a nearby measured value inside the allowed documentation window. Judge that cited value by its textual time relation; do not require recorded_at to equal target_date. If the requested entity/value, range and unit are directly present in such a match, label it role=target, omit the same value from missing_information, and do not simultaneously call it baseline or temporal_anchor.

relevant_memory_ids must be the smallest supplied historical set that matters. covered_aspects states what the whole visible chart establishes. answer_focus is the must-use handoff: include only the distinct patient facts that directly determine the requested answer, including Profile/recent facts, and cite each with source_refs. Use the task profile's bounded focus capacity: exact and temporal lookups normally need one event/entity, option tasks need one independent check per visible option, patient-specific decisions commonly need several distinct factors, and multi-node chains may need more non-duplicate endpoints. Before adding a fact, ask whether removing it could change the conclusion; if not, omit it. Never include an unrelated allergy, old safety issue, cost, lifestyle detail or missing test. Copy facts faithfully in the source language and preserve material dates, values, ranges, units, medication names/classes, negation, attribution, uncertainty and temporal version. For visible alternatives, create one option_check item per option. For causal answers, put patient endpoints in answer_focus and only the bridge in reasoning_hypotheses. missing_information names at most two concrete searchable historical gaps that could reverse the conclusion; do not request an unavailable measurement merely to postpone a supported judgment. assessment=supported is valid only when missing_information is empty; otherwise return partial or unresolved.

For an explanation or longitudinal treatment-response judgment, do not reduce the assessment to whether a measurement exists at the exact query moment. First preserve the strongest visible historical chain across baseline/diagnosis, exposure or treatment, objective response/progression, and outcome. A missing current measurement may limit certainty, but it does not erase an established historical trajectory. Put directly observed node-to-node relations in connections, but treat every connection as a query-time assessment annotation: it is not a persistent graph fact, is not sent to Answer as memory_edges, and cannot establish causality. Cite only supplied historical Memory IDs in supporting_memory_ids. Put medical mechanisms only in reasoning_hypotheses, with 3–6 ordered reasoning_steps that explicitly state what changes what and why; attach every patient-specific endpoint used by those steps. If a bridge is missing, missing_information should name searchable historical endpoints or mechanism anchors rather than repeatedly asking for the same unavailable current log.

Every patient-specific statement must be grounded in cited source_refs. General medical knowledge may connect grounded facts only inside reasoning_hypotheses and must not create a patient diagnosis, value, treatment, behavior or event. Cite only supplied source_ref values; never invent an ID. The runtime discards an answer_focus item when its wording does not match its cited source. A chronological edge does not prove causation. Prefer nonredundant sources spanning the needed chain over repeated paraphrases. Preserve uncertainty, attribution and counterevidence. When strategy_profile.strategy_id starts with medlocomo_, use the cited source language and make each answer_focus.aspect and each non-missing role_coverage.claim a minimal verbatim span from its cited source: do not add prefixes such as "Patient" or "Doctor states", change tense, paraphrase, or resolve a pronoun inside the span; express any cross-node link only in connections; otherwise write them in Simplified Chinese. Do not answer the user, retrieve information, select the next worker, create fixed query slots, or use Gold, Answer Explanation, Judge metadata, hidden nodes, official reasoning chains, or future Sessions.`},
  // 来源：MedMemoryBench 官方附录基础模板 + 透明 CareHarness 题型 overlay；任务：EEM/TLA/SUA/MQ/IG/MCD 的答案生成入口。
  medmemory_answer:{version:'medmemorybench-answer.appendix-v1-careharness-overlay-v41-mq-general-medical-knowledge',description:'MedMemoryBench EEM uses the official appendix prompt plus a deterministic strict-containment surface-format patch covering units, qualifiers, paired entities, and typed-slot suffixes; SUA returns a minimal one-sentence patient-specific value, status, time, or baseline-bound transition with exactly one concrete memory grounding anchor unless the question explicitly requests explanation; MQ receives a deduplicated source-only State pool plus an option retrieval index and explicitly combines supplied patient facts with established general medical knowledge without allowing generic knowledge to invent patient facts; the other tasks retain their transparent CareHarness overlays.',render:renderMedMemoryAnswerPrompt,messages:medMemoryAnswerMessages},
  // 来源：MedMemoryBench 官方附录 Judge 基础 + 本地中文理由 overlay；任务：答案冻结后的 TLA/SUA/IG/MCD 评分；EEM/MQ 不走此提示词。
  medmemory_judge: { version: 'medmemorybench-official-judge.appendix-v1-zh-rationale-v2', description: 'MedMemoryBench appendix post-answer LLM-as-Judge criteria and JSON schema with free-text reason/note values constrained to Simplified Chinese.', render: renderMedMemoryJudgePrompt },
  // 来源：MedLoCoMo 全数据 Teacher Corpus 的 answerable/adversarial、Gold 语义和官方 Evidence 离线蒸馏；任务：在 Answer 前独立判断证据是否支持所问槽位。
  medlocomo_answerability_classifier:{version:`medlocomo-answerability-classifier.prompt.v2-separate-enums-${MEDLOCOMO_POLICY_DISTILLATION_HASH.slice(0,12)}`,description:'Evidence-conditioned binary routing policy distilled from all 17,892 MedLoCoMo questions; receives no official type, Gold, Judge metadata, or candidate answer.',render:renderMedLoCoMoAnswerabilityClassifierPrompt},
  // 来源：MedLoCoMo 公开 QA 协议派生（论文未给出逐字 Answer Prompt）；任务：只对已路由为可回答的问题生成 ≤10 词纯文本答案。
  medlocomo_answer:{version:`medlocomo-answer.protocol-derived-v14-routed-answer-only-${MEDLOCOMO_POLICY_DISTILLATION_HASH.slice(0,12)}`,description:'Answer-only MedLoCoMo instruction distilled from all 17,892 questions; answerability is decided by the separate evidence-conditioned classifier.',render:renderMedLoCoMoAnswerPrompt,messages:medLoCoMoAnswerMessages},
  // 来源：MedLoCoMo 公开拒答协议 + CareHarness 容错；任务：分类器失败或低置信时，从同一份源证据同时判断可回答性并生成答案。
  medlocomo_answerability_fallback:{version:`medlocomo-answer.protocol-derived-v15-answerability-fallback-${MEDLOCOMO_POLICY_DISTILLATION_HASH.slice(0,12)}`,description:'Fallback MedLoCoMo answer prompt used only when the separate evidence classifier did not yield a reliable route.',render:renderMedLoCoMoAnswerPrompt,messages:medLoCoMoAnswerabilityFallbackMessages},
  // 来源：MedLoCoMo 官方评测协议；任务：答案冻结后的 answerable-question 二元 Judge。
  medlocomo_judge: { version: 'medlocomo-official-answerable-judge.v1', description: 'MedLoCoMo Appendix B.2 first-attempt post-answer Judge messages; any Gateway repair retry is CareHarness-adapted.', render: renderMedLoCoMoJudgePrompt, messages: medLoCoMoJudgeMessages },
  // 来源：Psy-Chronicle ff812c9 online scripts；任务：SR exact、MR/TCR template-adapted 纯文本答案。
  cpcd_answer:{version:'cpcd-bench-online-answer.ff812c9-unified-memory-v2',description:'CPCD-Bench online-script Answer messages; MR/TCR replace raw full history with CareHarness Memory Nodes and are explicitly marked adapted.',render:renderCpcdAnswerPrompt,messages:cpcdAnswerMessages},
  // 来源：Psy-Chronicle ff812c9 online scripts；任务：答案冻结后的 SR/MR/TCR 专用 Judge messages/schema。
  cpcd_judge:{version:'cpcd-bench-online-judge.ff812c9-v1',description:'CPCD-Bench first-attempt post-answer Judge messages copied from each official online evaluation script; any Gateway repair retry is CareHarness-adapted.',render:renderCpcdJudgePrompt,messages:cpcdJudgeMessages},
  // 来源：CareHarness Core；任务：除 MedMemory 专用纯文本入口外，按各 benchmark answer_contract 生成 JSON answer。
  judge: { version: 'judge.unified-memory.v8', description: 'Answer a benchmark task using only the supplied visible Memory Nodes, verified Memory Edges, runtime action output, and protocol context.', contract: `Use only the supplied visible context. A verified followed_by edge establishes ordering, not causation; candidate or rejected edges cannot support a claim. If verification/evaluation is unresolved, do not invent a patient-specific conclusion. Internal Memory IDs must not appear in the answer. Return {"answer":"non-empty string"}. Be concise. Gold answers and hidden reference key points are never available.` }
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

function renderCareHarnessEvaluatorPrompt(input={}){
  const entry=PROMPTS.careharness_evaluate;
  if(input?.admission_overview?.version){
    return`Assess the supplied MedLoCoMo source records against the exact question. Admission Overview and Policy focus are navigation, not evidence or conclusions.
Use node text AND source_text. Preserve decisive records in relevant_memory_ids even when a role is partial. Copy short verbatim spans into answer_focus and role_coverage; cite every source needed for a relationship. Resolve pronouns or split qualifiers using explicit contextual turns, with the link in connections; do not require the whole chain in one sentence.
Comparison/progression: retain each requested factor at its distinct time points, including the decisive update or outcome. A source's uncertainty about a cause does not negate its documented diagnosis or event. Missing intermediate visits do not erase known endpoints. A shared treatment strategy can be the answer; do not invent a requirement that management must differ. Treat a question premise as a retrieval cue, not a new fact and not an obligation to prove an unstated mechanism.
Frequency: fill occurrence_candidates for each candidate event, including exclusions, and counting.unit from the requested Admission/event/site unit. Reuse event_key for repeated mentions of one event. Use documented for explicit diagnoses, treatment initiation/continuation or performed actions as applicable; distinguish these from a merely possible future plan, negation, and unresolved uncertainty. Do not demand an extra confirmatory test unless needed to distinguish the question's events. Preserve compound-event support across cited turns. Never emit a total in answer_focus; code groups the event rows. Set scope_complete only after every relevant Admission is checked, never from a top-k sample or the number of retrieved Admissions.
Set supported only when the requested answer is supported without a decision-changing gap. Otherwise mark partial and name at most two searchable gaps. Failure to retrieve an event is not evidence that it did not occur. Keep occurrence_candidates empty and counting.unit null when not needed.
Return the supplied output_schema as valid JSON. Limits: relevant_memory_ids 80, role_coverage 64, occurrence_candidates 80, connections 40; answer_focus obeys its supplied limit. Keep text concise, in the source language, without duplicating full excerpts.
INPUT:
${typeof input==='string'?input:JSON.stringify(input)}`;
  }
  return `${entry.description}\n${entry.contract}\nReturn valid JSON only.\nINPUT:\n${typeof input==='string'?input:JSON.stringify(input)}`;
}

function promptLanguage(input){const raw=typeof input==='string'?input:typeof input?.session_text==='string'?input.session_text:Array.isArray(input?.context_units)?input.context_units.map(item=>item?.text||'').join('\n'):Array.isArray(input)?input.map(item=>item?.text||'').join('\n'):JSON.stringify(input),value=raw.replace(/^\[Turn=[^\n]*\]\n/gmu,''),han=(value.match(/[\p{Script=Han}]/gu)||[]).length,latin=(value.match(/[A-Za-z]/g)||[]).length;return han>0&&han>=latin*.2?'zh':'en';}

// 来源：MedMemoryBench 官方附录 Judge Prompts。
// 任务：答案冻结后按 TLA/SUA/IG/MCD 题型选择 LLM-as-Judge；评分实现仍在 medmemory-official.js。
// EEM 使用 string containment，MQ 使用 option match，因此不进入此 renderer。
export function renderMedMemoryJudgePrompt(input={}){
  const task=input.query_type;
  let official;
  if(task==='temporal_localization')official=appendixTemporalJudgePrompt(input);
  else if(task==='state_update')official=appendixStateJudgePrompt(input);
  else if(task==='inference_generation')official=appendixInferenceJudgePrompt(input);
  else if(task==='multi_hop_clinical_deduction')official=appendixMultiHopJudgePrompt(input);
  else throw new Error(`No official MedMemoryBench judge prompt for ${task||'unknown task'}`);
  return official.replace(/\nOutput JSON only, no other content\.$/u,`\n${MEDMEMORY_CHINESE_JUDGE_REQUIREMENT}\n\nOutput JSON only, no other content.`);
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
The official raw full-history slot is replaced by query-time retrieved CareHarness Memory Nodes:
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
官方 raw full-history 槽位已替换为 query-time 检索得到的 CareHarness Memory Nodes：
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
