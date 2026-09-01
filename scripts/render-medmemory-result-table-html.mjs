import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const [databaseArg, experimentId, outputArg, correctedArg = ''] = process.argv.slice(2);
if (!databaseArg || !experimentId || !outputArg) {
  console.error('Usage: node --experimental-sqlite scripts/render-medmemory-result-table-html.mjs <database> <experiment-id> <output.html> [corrected_score_ids]');
  process.exit(1);
}

const correctedIds = new Set(correctedArg.split(',').map(value => value.trim()).filter(Boolean));
const database = new DatabaseSync(resolve(databaseArg), { readOnly: true });
const row = database.prepare(`
  SELECT status, config_json, progress_json, results_json, created_at, updated_at
  FROM experiments
  WHERE id = ?
`).get(experimentId);
database.close();
if (!row) throw new Error(`Experiment not found: ${experimentId}`);

const config = JSON.parse(row.config_json);
const results = JSON.parse(row.results_json)
  .filter(item => item?.kind === 'score')
  .map(item => correctedIds.has(String(item.score_id))
    ? { ...item, score: 1, is_correct: true, status: 'scored' }
    : item);

const taskOrder = ['EEM', 'TLA', 'SUA', 'MQ', 'IG', 'MCD'];
const taskNames = {
  EEM: '实体精确匹配',
  TLA: '时间定位',
  SUA: '状态更新',
  MQ: '选择题',
  IG: '推理生成',
  MCD: '多跳临床推理'
};
const taskCodes = {
  entity_exact_match: 'EEM',
  temporal_localization: 'TLA',
  state_update: 'SUA',
  multiple_choice: 'MQ',
  multiple_choice_question: 'MQ',
  inference_generation: 'IG',
  multi_hop_clinical_deduction: 'MCD'
};

function taskCode(item) {
  const explicit = taskCodes[String(item.task || '').toLowerCase()];
  if (explicit) return explicit;
  const match = String(item.score_id || '').match(/_(eem|tla|sua|mq|ig|mcd)_/i);
  return match ? match[1].toUpperCase() : String(item.task || 'OTHER').toUpperCase();
}

function average(values) {
  const numeric = values.map(Number).filter(Number.isFinite);
  return numeric.length ? numeric.reduce((sum, value) => sum + value, 0) / numeric.length : null;
}

function percent(value) {
  return Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(2)}%` : '—';
}

function shown(value) {
  if (value == null) return '—';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(shown).join('\n');
  return JSON.stringify(value, null, 2);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

const scored = results.filter(item => item.status === 'scored' && Number.isFinite(Number(item.score)));
const correct = scored.filter(item => item.is_correct === true).length;
const overallScore = average(scored.map(item => item.score));
const overallAccuracy = scored.length ? correct / scored.length : null;
const grouped = new Map(taskOrder.map(code => [code, []]));
for (const item of results) {
  const code = taskCode(item);
  if (!grouped.has(code)) grouped.set(code, []);
  grouped.get(code).push(item);
}

const summaryRows = [...grouped.entries()].filter(([, items]) => items.length).map(([code, items]) => {
  const taskScored = items.filter(item => item.status === 'scored' && Number.isFinite(Number(item.score)));
  const taskCorrect = taskScored.filter(item => item.is_correct === true).length;
  const accuracy = taskScored.length ? taskCorrect / taskScored.length : null;
  return `<tr>
    <td><b>${escapeHtml(code)}</b></td>
    <td>${escapeHtml(taskNames[code] || code)}</td>
    <td>${items.length}</td>
    <td>${taskCorrect}</td>
    <td>${items.length - taskCorrect}</td>
    <td>${percent(accuracy)}</td>
    <td><b>${percent(average(taskScored.map(item => item.score)))}</b></td>
  </tr>`;
}).join('');

const detailRows = results.map((item, index) => {
  const code = taskCode(item);
  const isCorrect = item.is_correct === true;
  const resultClass = isCorrect ? 'correct' : 'wrong';
  const resultLabel = item.status === 'scored' ? (isCorrect ? '正确' : '错误') : item.status;
  return `<tr data-row data-task="${escapeHtml(code)}" data-result="${isCorrect ? 'correct' : 'wrong'}">
    <td>${index + 1}</td>
    <td><code>${escapeHtml(item.score_id)}</code></td>
    <td><span class="task">${escapeHtml(code)}</span></td>
    <td class="long">${escapeHtml(item.question)}</td>
    <td class="long answer">${escapeHtml(shown(item.system_output))}</td>
    <td class="long gold">${escapeHtml(shown(item.gold))}</td>
    <td><b>${percent(item.score)}</b></td>
    <td><span class="status ${resultClass}">${escapeHtml(resultLabel)}</span></td>
  </tr>`;
}).join('');

const personaId = config?.matched_manifest?.persona_id ?? config?.persona_id ?? '—';
const model = config?.matched_manifest?.models?.answer?.model || config?.models?.answer?.model || '—';
const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Persona ${escapeHtml(personaId)} 实验结果</title>
<style>
:root{color-scheme:light;--bg:#f4f7fb;--panel:#fff;--line:#dbe3ee;--text:#172033;--muted:#64748b;--blue:#2563eb;--green:#15803d;--green-bg:#dcfce7;--red:#b91c1c;--red-bg:#fee2e2}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}.page{max-width:1800px;margin:auto;padding:28px}.hero,.panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;box-shadow:0 6px 22px rgba(15,23,42,.05)}.hero{padding:24px;margin-bottom:20px}h1{font-size:26px;margin:0 0 8px}.meta{color:var(--muted)}.cards{display:grid;grid-template-columns:repeat(4,minmax(150px,1fr));gap:12px;margin-top:20px}.card{padding:16px;border:1px solid var(--line);border-radius:10px}.card span{display:block;color:var(--muted);font-size:12px}.card strong{font-size:24px}.panel{padding:20px;margin-bottom:20px}h2{font-size:18px;margin:0 0 14px}.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:10px}table{width:100%;border-collapse:separate;border-spacing:0;background:#fff}th,td{padding:11px 12px;border-bottom:1px solid var(--line);border-right:1px solid var(--line);vertical-align:top;text-align:left}th:last-child,td:last-child{border-right:0}tr:last-child td{border-bottom:0}th{position:sticky;top:0;z-index:1;background:#eef3f9;white-space:nowrap}tbody tr:hover{background:#f8fafc}.summary-table{max-width:980px}.controls{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px}.controls input,.controls select{height:38px;border:1px solid var(--line);border-radius:8px;background:#fff;padding:0 10px;font:inherit}.controls input{min-width:320px;flex:1}.detail-table{min-width:1600px}.detail-table .long{min-width:280px;max-width:440px;white-space:pre-wrap}.detail-table .answer,.detail-table .gold{min-width:360px}.task{display:inline-block;padding:2px 8px;border-radius:999px;background:#dbeafe;color:#1d4ed8;font-weight:700}.status{display:inline-block;padding:3px 9px;border-radius:999px;font-weight:700;white-space:nowrap}.status.correct{color:var(--green);background:var(--green-bg)}.status.wrong{color:var(--red);background:var(--red-bg)}code{font-size:12px;white-space:nowrap}@media(max-width:800px){.page{padding:12px}.cards{grid-template-columns:repeat(2,1fr)}.controls input{min-width:100%}}
</style>
</head>
<body><div class="page">
  <section class="hero">
    <h1>Persona ${escapeHtml(personaId)} · 实验结果表</h1>
    <div class="meta">实验 ${escapeHtml(experimentId)} · ${escapeHtml(row.status)} · 模型 ${escapeHtml(model)} · 更新时间 ${escapeHtml(row.updated_at)}</div>
    <div class="cards">
      <div class="card"><span>总题数</span><strong>${results.length}</strong></div>
      <div class="card"><span>正确题数</span><strong>${correct}</strong></div>
      <div class="card"><span>准确率</span><strong>${percent(overallAccuracy)}</strong></div>
      <div class="card"><span>平均得分</span><strong>${percent(overallScore)}</strong></div>
    </div>
  </section>
  <section class="panel">
    <h2>按题型汇总</h2>
    <div class="table-wrap summary-table"><table><thead><tr><th>题型</th><th>任务</th><th>题数</th><th>正确</th><th>错误</th><th>准确率</th><th>平均得分</th></tr></thead><tbody>${summaryRows}</tbody></table></div>
  </section>
  <section class="panel">
    <h2>逐题结果</h2>
    <div class="controls"><input id="search" placeholder="搜索题号、问题、答案或 Gold"><select id="task"><option value="all">全部题型</option>${[...grouped.entries()].filter(([,items])=>items.length).map(([code])=>`<option value="${escapeHtml(code)}">${escapeHtml(code)}</option>`).join('')}</select><select id="result"><option value="all">全部结果</option><option value="correct">正确</option><option value="wrong">错误</option></select></div>
    <div class="table-wrap"><table class="detail-table"><thead><tr><th>#</th><th>Score ID</th><th>题型</th><th>问题</th><th>模型答案</th><th>Gold</th><th>得分</th><th>结果</th></tr></thead><tbody>${detailRows}</tbody></table></div>
  </section>
</div>
<script>
const search=document.getElementById('search'),task=document.getElementById('task'),result=document.getElementById('result'),rows=[...document.querySelectorAll('[data-row]')];
function apply(){const query=search.value.trim().toLowerCase();for(const row of rows){const matchesText=!query||row.textContent.toLowerCase().includes(query);const matchesTask=task.value==='all'||row.dataset.task===task.value;const matchesResult=result.value==='all'||row.dataset.result===result.value;row.hidden=!(matchesText&&matchesTask&&matchesResult)}}
search.addEventListener('input',apply);task.addEventListener('change',apply);result.addEventListener('change',apply);
</script></body></html>`;

const output = resolve(outputArg);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, html);
console.log(JSON.stringify({
  experiment_id: experimentId,
  output,
  question_count: results.length,
  correct_count: correct,
  accuracy: overallAccuracy,
  average_score: overallScore,
  by_task: Object.fromEntries([...grouped.entries()].filter(([, items]) => items.length).map(([code, items]) => [code, {
    count: items.length,
    correct: items.filter(item => item.is_correct === true).length,
    average_score: average(items.map(item => item.score))
  }]))
}, null, 2));
