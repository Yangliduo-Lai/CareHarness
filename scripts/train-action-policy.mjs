import { mkdirSync,writeFileSync } from 'node:fs';
import { dirname,resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { learnActionPolicyModel } from '../src/action-policy-learning.js';

const args=parseArgs(process.argv.slice(2)),db=new DatabaseSync(args.database,{readOnly:true});
try{
  const experiments=args.experiments.map(id=>{const row=db.prepare('SELECT * FROM experiments WHERE id=?').get(id);if(!row)throw new Error(`Experiment not found: ${id}`);return{id:row.id,benchmark:row.benchmark,status:row.status,config:JSON.parse(row.config_json),results:JSON.parse(row.results_json)};});
  const model=learnActionPolicyModel(experiments,{prior_strength:args.prior_strength}),target=resolve(args.output);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,`${JSON.stringify(model,null,2)}\n`);
  process.stdout.write(`${JSON.stringify({output:target,model_hash:model.model_hash,training_scope:model.training_scope,exact_context_count:Object.keys(model.contexts).length,backoff_context_count:Object.keys(model.backoff_contexts).length,global_actions:model.global_actions},null,2)}\n`);
}finally{db.close();}

function parseArgs(argv){const output={database:'data/careharness.sqlite',output:'data/investigation-action-values.json',experiments:[],prior_strength:4};for(let index=0;index<argv.length;index++){const key=argv[index],value=argv[index+1];if(key==='--database'){output.database=required(value,key);index++;}else if(key==='--output'){output.output=required(value,key);index++;}else if(key==='--experiment'){output.experiments.push(required(value,key));index++;}else if(key==='--prior-strength'){output.prior_strength=Number(required(value,key));index++;}else throw new Error(`Unknown argument: ${key}`);}if(!output.experiments.length)throw new Error('At least one --experiment is required');if(!Number.isFinite(output.prior_strength)||output.prior_strength<1)throw new Error('--prior-strength must be >= 1');return output;}
function required(value,key){if(value==null||String(value).startsWith('--'))throw new Error(`${key} requires a value`);return String(value);}
