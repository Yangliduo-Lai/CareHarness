import { mkdirSync,readFileSync,writeFileSync } from 'node:fs';
import { dirname,resolve } from 'node:path';
import { renderMemoryReviewDocument } from './memory-review-html.mjs';

const[inputArg,outputArg]=process.argv.slice(2);
if(!inputArg||!outputArg){console.error('Usage: node scripts/render-wrong-answer-html.mjs <wrong-answers.json> <output.html>');process.exit(1);}
const input=resolve(inputArg),output=resolve(outputArg),data=JSON.parse(readFileSync(input,'utf8'));
mkdirSync(dirname(output),{recursive:true});writeFileSync(output,renderMemoryReviewDocument(data));
console.log(JSON.stringify({input,output,wrong_answer_count:data.wrong_answers?.length||0},null,2));
