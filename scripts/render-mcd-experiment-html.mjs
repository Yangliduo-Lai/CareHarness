import { mkdirSync,writeFileSync } from 'node:fs';
import { dirname,resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { renderMemoryReviewDocument } from './memory-review-html.mjs';

const[databaseArg,experimentId,outputArg]=process.argv.slice(2);
if(!databaseArg||!experimentId||!outputArg){console.error('Usage: node --experimental-sqlite scripts/render-mcd-experiment-html.mjs <database> <experiment-id> <output.html>');process.exit(1);}
const database=new DatabaseSync(resolve(databaseArg),{readOnly:true}),row=database.prepare('SELECT results_json FROM experiments WHERE id=?').get(experimentId);database.close();
if(!row)throw new Error(`Experiment not found: ${experimentId}`);
const results=JSON.parse(row.results_json).filter(item=>item?.kind==='score'&&item?.task==='multi_hop_clinical_deduction'),output=resolve(outputArg);
mkdirSync(dirname(output),{recursive:true});writeFileSync(output,renderMemoryReviewDocument({results},{title:`MCD Experiment ${experimentId}`}));
console.log(JSON.stringify({experiment_id:experimentId,output,question_count:results.length},null,2));
