import { Store } from '../src/db.js';
import { ModelRegistry } from '../src/model-registry.js';
import { ExperimentHarness } from '../src/experiments.js';

const args=parseArgs(process.argv.slice(2));

async function main(){
  const apiKey=(await readStdinLine()).trim();
  if(!apiKey)throw new Error('CloseAI API key was not supplied on stdin');
  const store=new Store(args.database);
  try{
    const models=new ModelRegistry(store),profile=models.state().profiles.find(item=>item.id===args.profile);
    if(!profile)throw new Error(`Missing model profile ${args.profile}`);
    process.env[profile.config.api_key_ref||'CAREHARNESS_CLOSEAI_RUN_KEY']=apiKey;
    const harness=new ExperimentHarness(store,undefined,models),results=[];
    if(args.prepare_snapshots){
      for(const persona of args.personas){
        process.stderr.write(`${JSON.stringify({persona,phase:'prepare_memory',status:'starting'})}\n`);
        const prepared=await harness.start('medmemorybench',{persona_id:persona,noise:false,start_session:1,max_session:100,query_type:'__memory_build_only__',resume_incomplete:true,seed:42,preprocess_concurrency:args.query_concurrency,model:profile.config});
        if(prepared.status!=='completed'||prepared.progress?.memory_build_completeness?.memory_incomplete)throw new Error(`Memory Graph preparation failed for Persona ${persona} (${prepared.id})`);
        process.stderr.write(`${JSON.stringify({persona,phase:'prepare_memory',status:'completed',experiment_id:prepared.id})}\n`);
      }
    }
    let next=0;
    const worker=async()=>{while(true){const personaIndex=next++;if(personaIndex>=args.personas.length)return;const persona=args.personas[personaIndex];
      for(const task of args.tasks){let result;
        try{
          const allTasks=task==='all';
          const experiment=await harness.start('medmemorybench',{persona_id:persona,noise:false,max_session:100,...(allTasks?{}:{query_type:task}),score_only_current_memory:true,resume_incomplete:true,...(args.resume_source_experiment?{resume_source_experiment_id:args.resume_source_experiment}:{}),matched_experiment:false,evaluation_mode:args.label,seed:42,candidate_budget:args.candidate_budget,investigation_budget:args.investigation_budget,query_concurrency:args.query_concurrency,model:profile.config});
          const metrics=experiment.progress.retrieval_metrics||{},group=allTasks?metrics:metrics.by_query_type?.[task]||{},byType=Object.values(metrics.by_query_type||{});
          result={persona,task,experiment_id:experiment.id,status:experiment.status,count:Number(allTasks?metrics.query_count:group.count||experiment.progress.query_total||0),correct:Number(allTasks?byType.reduce((sum,item)=>sum+Number(item.correct||0),0):group.correct||0),accuracy:group.accuracy??null,failed:Number(allTasks?metrics.failed_query_count:group.failed||experiment.progress.query_failed||0)};
        }catch(error){result={persona,task,status:'failed',error:String(error.message||error),count:0,correct:0,accuracy:null,failed:1};}
        results.push(result);process.stderr.write(`${JSON.stringify(result)}\n`);
      }
    }};
    await Promise.all(Array.from({length:Math.min(args.scope_concurrency,args.personas.length)},worker));
    results.sort((left,right)=>left.persona-right.persona||args.tasks.indexOf(left.task)-args.tasks.indexOf(right.task));
    const scored=results.filter(item=>Number.isFinite(item.accuracy)),total=scored.reduce((sum,item)=>sum+item.count,0),correct=scored.reduce((sum,item)=>sum+item.correct,0);
    process.stdout.write(`${JSON.stringify({label:args.label,profile:args.profile,model:profile.config.model,results,summary:{scope_count:results.length,scored_scope_count:scored.length,total,correct,accuracy:total?correct/total:null}},null,2)}\n`);
  }finally{store.close();}
}

function parseArgs(argv){
  const out={database:process.env.CAREHARNESS_DB_PATH||'./data/careharness.sqlite',profile:'closeai-qwen3.5-flash',personas:[1,2,3,4,5,6],tasks:['state_update','multiple_choice'],label:'closeai_sua_mq_grid',candidate_budget:24,investigation_budget:6,query_concurrency:4,scope_concurrency:2,prepare_snapshots:false,resume_source_experiment:null};
  for(let index=0;index<argv.length;index++){const key=argv[index],value=argv[index+1];
    if(key==='--database'){out.database=required(value,key);index++;}
    else if(key==='--profile'){out.profile=required(value,key);index++;}
    else if(key==='--personas'){out.personas=csv(value).map(item=>positive(item,key));index++;}
    else if(key==='--tasks'){out.tasks=csv(value);index++;}
    else if(key==='--label'){out.label=required(value,key);index++;}
    else if(key==='--candidate-budget'){out.candidate_budget=positive(value,key);index++;}
    else if(key==='--investigation-budget'){out.investigation_budget=positive(value,key);index++;}
    else if(key==='--query-concurrency'){out.query_concurrency=positive(value,key);index++;}
    else if(key==='--scope-concurrency'){out.scope_concurrency=positive(value,key);index++;}
    else if(key==='--resume-source-experiment'){out.resume_source_experiment=required(value,key);index++;}
    else if(key==='--prepare-snapshots'){out.prepare_snapshots=true;}
    else throw new Error(`Unknown argument: ${key}`);
  }
  return out;
}

function readStdinLine(){return new Promise((resolve,reject)=>{let value='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{value+=chunk;if(value.includes('\n')){process.stdin.pause();resolve(value.split(/\r?\n/u)[0]);}});process.stdin.on('end',()=>resolve(value));process.stdin.on('error',reject);});}
function csv(value){return required(value,'CSV').split(',').map(item=>item.trim()).filter(Boolean);}
function positive(value,key){const number=Number(value);if(!Number.isInteger(number)||number<1)throw new Error(`${key} requires positive integers`);return number;}
function required(value,key){if(!value||String(value).startsWith('--'))throw new Error(`${key} requires a value`);return String(value);}

main().catch(error=>{process.stderr.write(`${error.stack||error.message||error}\n`);process.exitCode=1;});
