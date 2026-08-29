import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Store } from '../src/db.js';
import { ExperimentHarness } from '../src/experiments.js';

const [experimentId, outputArg] = process.argv.slice(2);
if (!experimentId || !outputArg) {
  console.error('Usage: node --experimental-sqlite scripts/export-wrong-answers.mjs <experiment-id> <output.json>');
  process.exit(1);
}

const output = resolve(outputArg);
const store = new Store();
try {
  const harness = new ExperimentHarness(store);
  const exported = harness.wrongAnswerExport(experimentId);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(exported, null, 2));
  console.log(JSON.stringify({
    experiment_id: experimentId,
    output,
    wrong_answer_count: exported.summary?.wrong_answer_count ?? null,
    score_ids: exported.summary?.score_ids ?? []
  }, null, 2));
} finally {
  store.close();
}
