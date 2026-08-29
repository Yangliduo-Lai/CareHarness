import { mkdirSync,readFileSync,writeFileSync } from 'node:fs';
import { dirname,resolve } from 'node:path';
import { renderMemoryReviewDocument } from './memory-review-html.mjs';

const[sourceArg,notesArg,outputArg]=process.argv.slice(2);
if(!sourceArg||!notesArg||!outputArg){console.error('Usage: node scripts/render-wrong-answer-research-notebook.mjs <wrong-answers.json> <notes.json> <output.html>');process.exit(1);}
const source=JSON.parse(readFileSync(resolve(sourceArg),'utf8')),rawNotes=JSON.parse(readFileSync(resolve(notesArg),'utf8')),notes=rawNotes.notes||rawNotes.by_score_id||rawNotes;
const output=resolve(outputArg);mkdirSync(dirname(output),{recursive:true});writeFileSync(output,renderMemoryReviewDocument(source,{title:'CareHarness 错题研究记录',notes}));
console.log(JSON.stringify({output,wrong_answer_count:source.wrong_answers?.length||0,note_count:Object.keys(notes||{}).length},null,2));
