import { existsSync,mkdirSync,readFileSync,renameSync,writeFileSync } from 'node:fs';
import { dirname,resolve } from 'node:path';
import { Store } from '../src/db.js';
import { ExperimentHarness } from '../src/experiments.js';

const args=parseArgs(process.argv.slice(2)),apiKey=process.env[args.api_key_env];
if(!apiKey)throw new Error(`Missing ${args.api_key_env}`);
const model={provider:'dashscope',base_url:'https://dashscope.aliyuncs.com/compatible-mode/v1',model:'qwen3.7-flash',temperature:0,max_tokens:1200,timeout_ms:300000,retries:1,api_key_ref:args.api_key_env};
const store=new Store(args.database),harness=new ExperimentHarness(store),catalog=harness.catalog().cpcdbench;
if(!catalog?.available)throw new Error(`CPCD-Bench dataset is unavailable at ${catalog?.path||'the configured data root'}`);
const caseIds=args.cases.length?args.cases:catalog.cases;
const rows=loadCompletedRows(args.output,caseIds);
const completedIds=new Set(rows.map(row=>row.case_id));
const pendingCaseIds=caseIds.filter(caseId=>!completedIds.has(caseId));
try{
  if(rows.length)process.stderr.write(`CPCD resume: reused ${rows.length}/${caseIds.length} completed cases from ${resolve(args.output)}\n`);
  await pool(pendingCaseIds,args.case_concurrency,async caseId=>{
    process.stderr.write(`CPCD case ${caseId} started\n`);
    let experiment=null,lastError=null;
    for(let attempt=0;attempt<=args.retries;attempt++){
      try{
        experiment=await harness.start('cpcdbench',{case_id:caseId,task_type:'all',seed:args.seed,query_concurrency:args.query_concurrency,preprocess_concurrency:args.preprocess_concurrency,model,cpcd_judge_model:model});
        if(experiment.status==='completed')break;
        lastError=new Error(`experiment ${experiment.id} ended with ${experiment.status}`);
      }catch(error){lastError=error;}
    }
    if(!experiment||experiment.status!=='completed'){
      const message=String(lastError?.message||`CPCD case ${caseId} did not complete`);
      process.stderr.write(`CPCD case ${caseId} failed after ${args.retries+1} attempts: ${message}\n`);
      return;
    }
    const scores=experiment.results.filter(item=>item.kind==='score'),row={case_id:caseId,experiment_id:experiment.id,status:experiment.status,query_count:scores.length,scored:scores.filter(item=>item.status==='scored').length,failed:scores.filter(item=>item.status==='failed').length,average_score:average(scores.filter(item=>item.status==='scored').map(item=>item.score)),by_task:summarizeByTask(scores)};
    rows.push(row);
    rows.sort((a,b)=>caseIds.indexOf(a.case_id)-caseIds.indexOf(b.case_id));
    writeReport(args.output,buildPayload(rows,model,caseIds.length));
    process.stderr.write(`CPCD case ${caseId} completed and checkpointed: ${row.scored}/${row.query_count}, score=${format(row.average_score)}\n`);
  });
  rows.sort((a,b)=>caseIds.indexOf(a.case_id)-caseIds.indexOf(b.case_id));
  const payload=buildPayload(rows,model,caseIds.length);
  writeReport(args.output,payload);process.stdout.write(`${JSON.stringify(payload,null,2)}\n`);
}finally{store.close();}

function buildPayload(rows,model,expectedCaseCount){return{report_version:'cpcd-careharness-results.v2-resumable',generated_at:new Date().toISOString(),benchmark:'cpcdbench',status:rows.length===expectedCaseCount?'completed':'partial',expected_case_count:expectedCaseCount,case_count:rows.length,remaining_case_count:Math.max(0,expectedCaseCount-rows.length),model:{provider:model.provider,base_url:model.base_url,model:model.model,temperature:model.temperature,max_tokens:model.max_tokens},query_count:rows.reduce((sum,row)=>sum+row.query_count,0),scored:rows.reduce((sum,row)=>sum+row.scored,0),failed:rows.reduce((sum,row)=>sum+row.failed,0),average_score:weightedAverage(rows,'average_score','scored'),by_task:mergeTaskSummaries(rows),cases:rows};}
function loadCompletedRows(path,caseIds){const jsonPath=resolve(path);if(!existsSync(jsonPath))return[];try{const payload=JSON.parse(readFileSync(jsonPath,'utf8')),allowed=new Set(caseIds);return Array.isArray(payload.cases)?payload.cases.filter(row=>row?.status==='completed'&&allowed.has(row.case_id)):[];}catch(error){process.stderr.write(`CPCD checkpoint ignored because it could not be parsed: ${error.message}\n`);return[];}}

function summarizeByTask(scores){const groups=new Map();for(const item of scores){const key=String(item.task||'unknown'),list=groups.get(key)||[];list.push(item);groups.set(key,list);}return Object.fromEntries([...groups].map(([task,items])=>{const scored=items.filter(item=>item.status==='scored'&&Number.isFinite(item.score));return[task,{query_count:items.length,scored:scored.length,failed:items.filter(item=>item.status==='failed').length,average_score:average(scored.map(item=>item.score))}];}));}
function mergeTaskSummaries(rows){const tasks=new Map();for(const row of rows)for(const[task,value]of Object.entries(row.by_task)){const aggregate=tasks.get(task)||{query_count:0,scored:0,failed:0,weighted_score:0};aggregate.query_count+=value.query_count;aggregate.scored+=value.scored;aggregate.failed+=value.failed;if(Number.isFinite(value.average_score))aggregate.weighted_score+=value.average_score*value.scored;tasks.set(task,aggregate);}return Object.fromEntries([...tasks].map(([task,value])=>[task,{query_count:value.query_count,scored:value.scored,failed:value.failed,average_score:value.scored?value.weighted_score/value.scored:null}]));}
function weightedAverage(rows,valueKey,weightKey){let sum=0,weight=0;for(const row of rows){const value=Number(row[valueKey]),count=Number(row[weightKey]);if(Number.isFinite(value)&&count>0){sum+=value*count;weight+=count;}}return weight?sum/weight:null;}
async function pool(items,limit,worker){let cursor=0;await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{for(;;){const index=cursor++;if(index>=items.length)return;await worker(items[index]);}}));}
function average(values){const valid=values.map(Number).filter(Number.isFinite);return valid.length?valid.reduce((sum,value)=>sum+value,0)/valid.length:null;}
function format(value){return Number.isFinite(value)?value.toFixed(4):'—';}
function writeReport(path,payload){const jsonPath=resolve(path),markdownPath=jsonPath.replace(/\.json$/i,'.md');mkdirSync(dirname(jsonPath),{recursive:true});atomicWrite(jsonPath,`${JSON.stringify(payload,null,2)}\n`);const lines=['# CPCD-Bench CareHarness 结果','',`状态：${payload.status==='completed'?'已完成':'部分完成（可用同一命令续跑）'}`,`生成时间：${payload.generated_at}`,`Model：${payload.model.model}`,`Cases：${payload.case_count}/${payload.expected_case_count}，题目：${payload.query_count}，已评分：${payload.scored}，失败：${payload.failed}`,`平均分：${format(payload.average_score)}`,'','| Task | Questions | Scored | Failed | Average |','| --- | ---: | ---: | ---: | ---: |',...Object.entries(payload.by_task).map(([task,value])=>`| ${task} | ${value.query_count} | ${value.scored} | ${value.failed} | ${format(value.average_score)} |`),'','| Case | Questions | Scored | Failed | Average |','| --- | ---: | ---: | ---: | ---: |',...payload.cases.map(row=>`| ${row.case_id} | ${row.query_count} | ${row.scored} | ${row.failed} | ${format(row.average_score)} |`)];atomicWrite(markdownPath,`${lines.join('\n')}\n`);}
function atomicWrite(path,contents){const temporaryPath=`${path}.tmp`;writeFileSync(temporaryPath,contents);renameSync(temporaryPath,path);}
function parseArgs(argv){const values={database:process.env.CAREHARNESS_DB_PATH||'./data/careharness.sqlite',output:'reports/cpcd-qwen37-full.json',api_key_env:'CAREHARNESS_MATCHED_API_KEY',case_concurrency:4,query_concurrency:4,preprocess_concurrency:4,retries:2,seed:42,cases:[]};for(let index=0;index<argv.length;index++){const key=argv[index],value=argv[index+1];if(key==='--database'){values.database=required(value,key);index++;}else if(key==='--output'){values.output=required(value,key);index++;}else if(key==='--api-key-env'){values.api_key_env=required(value,key);index++;}else if(key==='--case-concurrency'){values.case_concurrency=bounded(value,key,1,8);index++;}else if(key==='--query-concurrency'){values.query_concurrency=bounded(value,key,1,16);index++;}else if(key==='--preprocess-concurrency'){values.preprocess_concurrency=bounded(value,key,1,16);index++;}else if(key==='--retries'){values.retries=bounded(value,key,0,3);index++;}else if(key==='--seed'){values.seed=integer(value,key);index++;}else if(key==='--cases'){values.cases=required(value,key).split(',').map(item=>item.trim()).filter(Boolean);index++;}else throw new Error(`Unknown argument: ${key}`);}return values;}
function required(value,name){if(value==null||String(value).startsWith('--'))throw new Error(`${name} requires a value`);return String(value);}
function integer(value,name){const number=Number(value);if(!Number.isInteger(number))throw new Error(`${name} must be an integer`);return number;}
function bounded(value,name,min,max){const number=integer(value,name);if(number<min||number>max)throw new Error(`${name} must be between ${min} and ${max}`);return number;}
