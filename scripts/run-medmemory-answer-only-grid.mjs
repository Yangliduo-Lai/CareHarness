import { spawn } from 'node:child_process';
import { Store } from '../src/db.js';

const args=parseArgs(process.argv.slice(2));

async function main(){
  const apiKey=(await readStdinLine()).trim();
  if(!apiKey)throw new Error('CloseAI API key was not supplied on stdin');
  const store=new Store(args.database),jobs=[];
  try{
    for(const persona of args.personas)for(const task of args.tasks){
      const row=store.db.prepare(`SELECT id,status FROM experiments WHERE benchmark='medmemorybench' AND json_extract(config_json,'$.evaluation_mode')=? AND json_extract(config_json,'$.persona_id')=? AND json_extract(config_json,'$.query_type')=? ORDER BY created_at DESC LIMIT 1`).get(args.source_label,persona,task);
      if(!row)throw new Error(`No source experiment for Persona ${persona} ${task} under ${args.source_label}`);
      jobs.push({persona,task,source_experiment:row.id,source_status:row.status});
    }
  }finally{store.close();}
  const results=Array(jobs.length);let next=0;
  const worker=async()=>{while(true){const index=next++;if(index>=jobs.length)return;const job=jobs[index];results[index]=await runJob(job,apiKey);process.stderr.write(`${JSON.stringify(results[index])}\n`);}};
  await Promise.all(Array.from({length:Math.min(args.scope_concurrency,jobs.length)},worker));
  const beforeCorrect=results.reduce((sum,item)=>sum+Number(item.before_correct||0),0),afterCorrect=results.reduce((sum,item)=>sum+Number(item.after_correct||0),0),total=results.reduce((sum,item)=>sum+Number(item.count||0),0),failed=results.reduce((sum,item)=>sum+Number(item.failed||0),0);
  process.stdout.write(`${JSON.stringify({source_label:args.source_label,profile:args.profile,results,summary:{total,before_correct:beforeCorrect,before_accuracy:total?beforeCorrect/total:null,after_correct:afterCorrect,after_accuracy:total?afterCorrect/total:null,delta_correct:afterCorrect-beforeCorrect,failed}},null,2)}\n`);
}

function runJob(job,apiKey){return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['--experimental-sqlite','scripts/run-medmemory-eem-answer-only.js','--database',args.database,'--persona',String(job.persona),'--task',job.task,'--profile',args.profile,'--concurrency',String(args.query_concurrency),'--source-experiment',job.source_experiment],{cwd:process.cwd(),env:{...process.env,CAREHARNESS_RUN_KEY:apiKey},stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});child.on('error',reject);child.on('close',code=>{if(code!==0)return reject(new Error(`Persona ${job.persona} ${job.task} failed: ${stderr.trim()||`exit ${code}`}`));try{resolve({...JSON.parse(stdout),source_status:job.source_status});}catch(error){reject(new Error(`Invalid result for Persona ${job.persona} ${job.task}: ${error.message}; ${stderr.trim()}`));}});
  });}

function parseArgs(argv){const out={database:process.env.CAREHARNESS_DB_PATH||'./data/careharness.sqlite',profile:'closeai-qwen3.5-flash',personas:[1,2,3,4,5,6],tasks:['state_update','multiple_choice'],source_label:'closeai_sua_mq_baseline_v2',query_concurrency:8,scope_concurrency:2};for(let index=0;index<argv.length;index++){const key=argv[index],value=argv[index+1];if(key==='--database'){out.database=required(value,key);index++;}else if(key==='--profile'){out.profile=required(value,key);index++;}else if(key==='--personas'){out.personas=csv(value).map(item=>positive(item,key));index++;}else if(key==='--tasks'){out.tasks=csv(value);index++;}else if(key==='--source-label'){out.source_label=required(value,key);index++;}else if(key==='--query-concurrency'){out.query_concurrency=positive(value,key);index++;}else if(key==='--scope-concurrency'){out.scope_concurrency=positive(value,key);index++;}else throw new Error(`Unknown argument: ${key}`);}return out;}
function readStdinLine(){return new Promise((resolve,reject)=>{let value='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{value+=chunk;if(value.includes('\n')){process.stdin.pause();resolve(value.split(/\r?\n/u)[0]);}});process.stdin.on('end',()=>resolve(value));process.stdin.on('error',reject);});}
function csv(value){return required(value,'CSV').split(',').map(item=>item.trim()).filter(Boolean);}
function positive(value,key){const number=Number(value);if(!Number.isInteger(number)||number<1)throw new Error(`${key} requires positive integers`);return number;}
function required(value,key){if(!value||String(value).startsWith('--'))throw new Error(`${key} requires a value`);return String(value);}

main().catch(error=>{process.stderr.write(`${error.stack||error.message||error}\n`);process.exitCode=1;});
