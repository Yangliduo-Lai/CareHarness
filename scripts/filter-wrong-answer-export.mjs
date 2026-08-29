import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const [inputArg, outputArg, taskArg = 'IG,MCD'] = process.argv.slice(2);
if (!inputArg || !outputArg) {
  console.error('Usage: node scripts/filter-wrong-answer-export.mjs <input.json> <output.json> [tasks]');
  process.exit(1);
}

const tasks = new Set(taskArg.split(',').map((value) => value.trim().toUpperCase()).filter(Boolean));
const input = resolve(inputArg);
const output = resolve(outputArg);
const data = JSON.parse(readFileSync(input, 'utf8'));
const wrongAnswers = Array.isArray(data.wrong_answers) ? data.wrong_answers : [];
data.wrong_answers = wrongAnswers.filter((item) => {
  const task = String(item.task || '').toUpperCase();
  const scoreId = String(item.score_id || '').toUpperCase();
  return [...tasks].some((wanted) => task === wanted || scoreId.includes(`_${wanted}_`));
});
data.document_filter = {
  tasks: [...tasks],
  source_wrong_answer_count: wrongAnswers.length,
  included_wrong_answer_count: data.wrong_answers.length
};
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(data));
console.log(JSON.stringify({ input, output, tasks: [...tasks], included: data.wrong_answers.length }, null, 2));
