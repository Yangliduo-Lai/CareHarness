import { mkdirSync,writeFileSync } from 'node:fs';
import { dirname,resolve } from 'node:path';
import { Store } from '../src/db.js';
import { ModelRegistry } from '../src/model-registry.js';
import { compactMedMemorySource } from '../src/prompts.js';
import { medMemoryJudgeMaxTokens,medMemoryMetric,scoreMedMemoryJudge,validateMedMemoryJudgeOutput } from '../src/medmemory-official.js';

const args=parseArgs(process.argv.slice(2)),store=new Store(args.database),models=new ModelRegistry(store);
try{
  hydrateCredentials(models,args.api_key_env);
  const answerGateway=models.gateway('judge'),judgeGateway=models.gateway('scoring_judge');
  assertQwenFlash(answerGateway.publicConfig(),'answer');assertQwenFlash(judgeGateway.publicConfig(),'scoring_judge');
  const row=store.db.prepare('SELECT results_json FROM experiments WHERE id=?').get(args.experiment);
  if(!row)throw new Error(`Experiment not found: ${args.experiment}`);
  const scores=JSON.parse(row.results_json).filter(item=>item?.kind==='score'&&(!args.task||item.task===args.task));
  if(!scores.length)throw new Error('No matching score rows');
  const results=await parallelMap(scores,args.concurrency,async(item,index)=>{
    const context=item.retrieval_context||{},withoutAssessor=args.variant==='without_assessor',sourceInput={...context,semantic_evaluation:withoutAssessor?null:context.semantic_evaluation,working_memory:withoutAssessor?null:context.working_memory};
    const answerInput={task:item.task,question:item.question,memory_source:compactMedMemorySource(sourceInput)};
    const answerResponse=await answerGateway.completeText('medmemory_answer',answerInput,()=>'',{maxTokens:answerMaxTokens(item.task)}),answer=answerResponse.value;
    const official=item.official_judge_input||{},judgeInput={...official,query_type:item.task,question:item.question,model_output:answer},validationItem=minimalJudgeItem(item,official);
    const judgeResponse=await judgeGateway.completeJSON('medmemory_judge',judgeInput,value=>validateMedMemoryJudgeOutput(value,validationItem),()=>{throw new Error('Live Judge required')},{maxTokens:medMemoryJudgeMaxTokens(validationItem),extractJsonObject:true}),scored=scoreMedMemoryJudge(judgeResponse.value,validationItem);
    process.stderr.write(`[${index+1}/${scores.length}] ${item.score_id} ${scored.score.toFixed(3)}\n`);
    return{score_id:item.score_id,task:item.task,question:item.question,answer,score:scored.score,is_correct:scored.is_correct,reason:scored.reason,details:scored.details,answer_trace:answerResponse.trace,judge_trace:judgeResponse.trace};
  });
  const average=results.reduce((sum,item)=>sum+item.score,0)/results.length,payload={version:'medmemory-frozen-answer-rescore.v1',source_experiment_id:args.experiment,variant:args.variant,models:{answer:answerGateway.publicConfig(),judge:judgeGateway.publicConfig()},query_count:results.length,average_score:average,by_task:Object.fromEntries([...new Set(results.map(item=>item.task))].map(task=>{const rows=results.filter(item=>item.task===task);return[task,rows.reduce((sum,item)=>sum+item.score,0)/rows.length]})),results};
  const path=resolve(args.output);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,`${JSON.stringify(payload,null,2)}\n`);process.stdout.write(`${JSON.stringify({output:path,query_count:results.length,average_score:average,by_task:payload.by_task},null,2)}\n`);
}finally{store.close();}

function parseArgs(argv){const out={database:process.env.CAREHARNESS_DB_PATH||'./data/careharness.sqlite',experiment:'',task:'',variant:'without_assessor',concurrency:4,api_key_env:'CAREHARNESS_MATCHED_API_KEY',output:'reports/medmemory-frozen-answer-rescore.json'};for(let index=0;index<argv.length;index++){const key=argv[index],value=argv[index+1];if(key==='--database'){out.database=required(value,key);index++;}else if(key==='--experiment'){out.experiment=required(value,key);index++;}else if(key==='--task'){out.task=required(value,key);index++;}else if(key==='--variant'){out.variant=required(value,key);index++;}else if(key==='--concurrency'){out.concurrency=positive(value,key);index++;}else if(key==='--api-key-env'){out.api_key_env=required(value,key);index++;}else if(key==='--output'){out.output=required(value,key);index++;}else throw new Error(`Unknown argument: ${key}`);}if(!out.experiment)throw new Error('--experiment is required');if(!['with_assessor','without_assessor'].includes(out.variant))throw new Error('--variant must be with_assessor or without_assessor');return out;}
function required(value,key){if(value==null||String(value).startsWith('--'))throw new Error(`${key} requires a value`);return String(value);}
function positive(value,key){const number=Number(value);if(!Number.isInteger(number)||number<1||number>16)throw new Error(`${key} must be between 1 and 16`);return number;}
function hydrateCredentials(models,environmentName){const key=process.env[environmentName];if(!key)throw new Error(`Missing ${environmentName}`);const state=models.state(),ids=new Set(Object.values(state.assignments));for(const id of ids){const profile=state.profiles.find(item=>item.id===id);if(profile&&profile.config.provider!=='mock')models.save({id:profile.id,name:profile.name,config:profile.config,api_key:key});}}
function assertQwenFlash(config,label){if(config.provider!=='dashscope'||config.model!=='qwen3.7-flash')throw new Error(`${label} must use DashScope qwen3.7-flash`);}
function answerMaxTokens(task){return({inference_generation:360,multi_hop_clinical_deduction:1200})[task]||500;}
function minimalJudgeItem(item,official){return{task:item.task,question:item.question,gold:[String(official.expected_answer||'')],metadata:{official_evaluation:{metric:medMemoryMetric(item.task),answers_data:[{is_correct:true,content:String(official.expected_answer||''),explanation:String(official.explanation||'')}],metadata:official.metadata||{}}}};}
async function parallelMap(values,limit,fn){const output=new Array(values.length),queue=values.map((value,index)=>({value,index}));await Promise.all(Array.from({length:Math.min(limit,values.length)},async()=>{while(queue.length){const next=queue.shift();output[next.index]=await fn(next.value,next.index);}}));return output;}
