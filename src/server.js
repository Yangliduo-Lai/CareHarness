import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { Store } from './db.js'; import { Pipeline } from './pipeline.js'; import { ExperimentHarness } from './experiments.js'; import { ModelGateway } from './gateway.js'; import { ModelRegistry } from './model-registry.js'; import { DebugRuns } from './debug-runs.js'; import { CareLifecycle } from './lifecycle.js'; import { buildVersion } from './version.js'; import { sanitizeSecrets } from './schema.js'; import { CAREHARNESS_METHOD_CONTRACT } from './careharness-contract.js'; import { FAILURE_TAXONOMY } from './failure-attribution.js'; import { MatchedSuiteController } from './matched-suite.js';

const port=Number(process.env.PORT||8766),store=new Store(),models=new ModelRegistry(store),harness=new ExperimentHarness(store,undefined,models),matchedSuites=new MatchedSuiteController(store,harness,models),debugRuns=new DebugRuns(store,models),lifecycle=new CareLifecycle(store,models),publicDir=resolve('public');
const json=(res,status,data)=>{const body=JSON.stringify(sanitizeSecrets(data));res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(body);};
const parse=async req=>{let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>10_000_000)throw new Error('Request too large');}return raw?JSON.parse(raw):{};};
const route=async(req,res)=>{const url=new URL(req.url,`http://${req.headers.host}`),path=url.pathname;
  try{
    if(req.method==='GET'&&path==='/api/health'){const state=models.state(),global=state.profiles.find(x=>x.id===state.assignments.global);return json(res,200,{ok:true,status:'healthy',database:store.path,version:buildVersion(),model:global?{provider:global.config.provider,model:global.config.model,credential:global.credential,label:global.name}:null,benchmarks:harness.catalog()});}
    if(req.method==='GET'&&path==='/api/catalog')return json(res,200,harness.catalog());
    if(req.method==='GET'&&path==='/api/careharness/method-contract')return json(res,200,{method_contract:CAREHARNESS_METHOD_CONTRACT,failure_taxonomy:FAILURE_TAXONOMY});
    if(req.method==='GET'&&path==='/api/optimization/rounds')return json(res,200,store.listOptimizationRounds(Number(url.searchParams.get('limit')||50)));
    if(req.method==='GET'&&/^\/api\/optimization\/rounds\/[^/]+$/.test(path)){const x=store.getOptimizationRound(path.split('/').at(-1));return x?json(res,200,x):json(res,404,{error:'Optimization round not found'});}
    if(req.method==='GET'&&path==='/api/runs')return json(res,200,store.listRuns(Number(url.searchParams.get('limit')||50)));
    if(req.method==='GET'&&/^\/api\/runs\/[^/]+$/.test(path)){const x=store.getRun(path.split('/').at(-1));return x?json(res,200,x):json(res,404,{error:'Run not found'});}
    if(req.method==='GET'&&/^\/api\/runs\/[^/]+\/bundle$/.test(path)){const id=path.split('/')[3],x=store.getRun(id);if(!x)return json(res,404,{error:'Run not found'});res.writeHead(200,{'content-type':'application/json','content-disposition':`attachment; filename="careharness-${id}.json"`});return res.end(JSON.stringify(sanitizeSecrets({bundle_version:1,run:x}),null,2));}
    if(req.method==='POST'&&path==='/api/pipeline/run'){const b=await parse(req),p=new Pipeline(store,b.model?{model:b.model}:models.pipelineOptions());return json(res,200,await p.run(b.observation,{seed:b.seed,branch_kind:b.branch_kind,dataset:b.dataset,phase:b.phase}));}
    if(req.method==='POST'&&path==='/api/memory/build'){const b=await parse(req);return json(res,200,await lifecycle.buildMemory(b.observations,{seed:b.seed,branch_kind:b.branch_kind,dataset:b.dataset,reset_memory:b.reset_memory===true}));}
    if(req.method==='POST'&&path==='/api/conversation/run'){const b=await parse(req);return json(res,200,await lifecycle.converse(b.observation,{seed:b.seed,branch_kind:b.branch_kind,dataset:b.dataset}));}
    if(req.method==='POST'&&path==='/api/debug/memory/start'){const b=await parse(req);return json(res,201,await debugRuns.startMemory(b.observations,{seed:b.seed,branch_kind:b.branch_kind,dataset:b.dataset,reset_memory:b.reset_memory===true}));}
    if(req.method==='POST'&&path==='/api/debug/conversation/start'){const b=await parse(req);return json(res,201,await debugRuns.startConversation(b.observation,{seed:b.seed,dataset:b.dataset}));}
    if(req.method==='POST'&&path==='/api/debug/start'){const b=await parse(req);return json(res,201,await debugRuns.start(b.observation,{seed:b.seed,branch_kind:b.branch_kind,dataset:b.dataset,phase:b.phase}));}
    if(req.method==='GET'&&/^\/api\/debug\/[^/]+$/.test(path))return json(res,200,debugRuns.view(path.split('/').at(-1)));
    if(req.method==='POST'&&/^\/api\/debug\/[^/]+\/(step|continue)$/.test(path)){const bits=path.split('/');return json(res,200,await debugRuns.advance(bits[3],bits[4]));}
    if(req.method==='POST'&&/^\/api\/runs\/[^/]+\/branch$/.test(path)){const prior=store.getRun(path.split('/')[3]);if(!prior)return json(res,404,{error:'Run not found'});const p=new Pipeline(store,models.pipelineOptions());return json(res,200,await p.run(prior.final.observation,{seed:prior.seed,branch_kind:'debug',dataset:prior.dataset,phase:prior.phase}));}
    if(req.method==='POST'&&path==='/api/replay'){const b=await parse(req),run=b.run||b.bundle?.run;if(!run?.final?.observation)throw new Error('Bundle lacks final.observation');const p=new Pipeline(store,b.model?{model:b.model}:models.pipelineOptions());return json(res,200,await p.run(run.final.observation,{seed:run.seed,branch_kind:'debug',dataset:run.dataset,phase:run.phase}));}
    if(req.method==='GET'&&path==='/api/memory-graphs')return json(res,200,{representation:'memory_graph',subjects:store.memorySubjects()});
    if(req.method==='GET'&&/^\/api\/memory-graphs\/[^/]+$/.test(path)){const subject_id=decodeURIComponent(path.split('/').at(-1));return json(res,200,{subject_id,memory_graph:store.memoryGraphFor(subject_id),memory_scope:store.memoryScope(subject_id)});}
    if(req.method==='GET'&&/^\/api\/memory\/scope\/[^/]+$/.test(path)){const subject_id=decodeURIComponent(path.split('/').at(-1));return json(res,200,{subject_id,memory_scope:store.memoryScope(subject_id)});}
    if(req.method==='DELETE'&&/^\/api\/memory\/[^/]+$/.test(path)){const subject_id=decodeURIComponent(path.split('/').at(-1)),before=store.memoryGraphFor(subject_id),removed_nodes=store.clearMemory(subject_id);return json(res,200,{ok:true,subject_id,removed_nodes,removed_edges:before.edges.length});}
    if(req.method==='GET'&&path==='/api/models/config')return json(res,200,models.state());
    if(req.method==='POST'&&path==='/api/models/profiles'){const b=await parse(req);return json(res,200,models.save(b));}
    if(req.method==='DELETE'&&/^\/api\/models\/profiles\/[^/]+$/.test(path))return json(res,200,models.delete(decodeURIComponent(path.split('/').at(-1))));
    if(req.method==='POST'&&path==='/api/models/assignments'){const b=await parse(req);return json(res,200,models.assign(b.assignments||b,{replace:b.replace!==false}));}
    if(req.method==='POST'&&path==='/api/model/test'){const b=await parse(req),g=b.profile_id?models.gatewayForProfile(b.profile_id):new ModelGateway(b.config||b,{apiKey:b.api_key});return json(res,200,await g.testConnection());}
    if(req.method==='POST'&&/^\/api\/benchmarks\/[^/]+\/preview$/.test(path)){const b=await parse(req),name=path.split('/')[3];return json(res,200,harness.preview(name,b));}
    if(req.method==='POST'&&/^\/api\/benchmarks\/[^/]+\/start$/.test(path)){const b=await parse(req),name=path.split('/')[3];return json(res,202,harness.launch(name,b));}
    if(req.method==='POST'&&path==='/api/matched-suites/preflight'){const b=await parse(req);return json(res,200,matchedSuites.preflight(b));}
    if(req.method==='POST'&&path==='/api/matched-suites'){const b=await parse(req);return json(res,202,matchedSuites.launch(b));}
    if(req.method==='GET'&&path==='/api/matched-suites')return json(res,200,matchedSuites.list(Number(url.searchParams.get('limit')||50)));
    if(req.method==='GET'&&/^\/api\/matched-suites\/[^/]+$/.test(path)){const x=matchedSuites.get(path.split('/').at(-1));return x?json(res,200,x):json(res,404,{error:'Matched suite not found'});}
    if(req.method==='POST'&&/^\/api\/matched-suites\/[^/]+\/cancel$/.test(path))return json(res,200,matchedSuites.cancel(path.split('/')[3]));
    if(req.method==='GET'&&path==='/api/experiments/summaries')return json(res,200,harness.listSummaries(url.searchParams.get('benchmark')||null,url.searchParams.get('limit')||50));
    if(req.method==='GET'&&path==='/api/experiments')return json(res,200,harness.listSummaries(null,url.searchParams.get('limit')||50));
    if(req.method==='GET'&&/^\/api\/experiments\/[^/]+\/wrong-answers\/export$/.test(path)){const id=path.split('/')[3],data=harness.wrongAnswerExport(id),safeId=String(id).replace(/[^a-zA-Z0-9_-]/g,'_');res.writeHead(200,{'content-type':'application/json; charset=utf-8','content-disposition':`attachment; filename="careharness-wrong-answers-${safeId}.json"`,'cache-control':'no-store'});return res.end(JSON.stringify(data,null,2));}
    if(req.method==='GET'&&/^\/api\/experiments\/[^/]+\/summary$/.test(path)){const x=harness.summary(path.split('/')[3]);return x?json(res,200,x):json(res,404,{error:'Experiment not found'});}
    if(req.method==='GET'&&/^\/api\/experiments\/[^/]+\/view$/.test(path)){const x=harness.view(path.split('/')[3]);return x?json(res,200,x):json(res,404,{error:'Experiment not found'});}
    if(req.method==='GET'&&/^\/api\/experiments\/[^/]+\/scores\/[^/]+$/.test(path)){const bits=path.split('/'),x=harness.scoreResult(bits[3],decodeURIComponent(bits[5]));return x?json(res,200,x):json(res,404,{error:'Score result not found'});}
    if(req.method==='GET'&&/^\/api\/experiments\/[^/]+$/.test(path)){const x=harness.get(path.split('/').at(-1));return x?json(res,200,x):json(res,404,{error:'Experiment not found'});}
    if(req.method==='POST'&&/^\/api\/experiments\/[^/]+\/(pause|resume|cancel)$/.test(path)){const bits=path.split('/');return json(res,200,harness.control(bits[3],bits[4]));}
    if(req.method==='POST'&&/^\/api\/experiments\/[^/]+\/retry-failed$/.test(path))return json(res,202,harness.retryFailed(path.split('/')[3]));
    if(req.method==='GET'&&path.startsWith('/api/'))return json(res,404,{error:'API route not found',path});
    return staticFile(path,res);
  }catch(error){const status=error.run_id?422:400;return json(res,status,{error:String(error.message||error),run_id:error.run_id||null,detail:error.publicError||null});}
};
function staticFile(path,res){let file=path==='/'?join(publicDir,'index.html'):join(publicDir,path);if(!file.startsWith(publicDir)||!existsSync(file)){file=join(publicDir,'index.html');}const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'};res.writeHead(200,{'content-type':types[extname(file)]||'application/octet-stream'});res.end(readFileSync(file));}
const server=createServer(route);server.listen(port,'127.0.0.1',()=>console.log(`CareHarness http://127.0.0.1:${port}`));
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>{server.close(()=>{store.close();process.exit(0);});});
