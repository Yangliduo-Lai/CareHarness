import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { Store } from './db.js'; import { Pipeline } from './pipeline.js'; import { ExperimentHarness } from './experiments.js'; import { ModelGateway } from './gateway.js'; import { buildVersion } from './version.js'; import { sanitizeSecrets } from './schema.js';

const port=Number(process.env.PORT||8765),store=new Store(),harness=new ExperimentHarness(store),publicDir=resolve('public');
const json=(res,status,data)=>{const body=JSON.stringify(sanitizeSecrets(data));res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(body);};
const parse=async req=>{let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>10_000_000)throw new Error('Request too large');}return raw?JSON.parse(raw):{};};
const route=async(req,res)=>{const url=new URL(req.url,`http://${req.headers.host}`),path=url.pathname;
  try{
    if(req.method==='GET'&&path==='/api/health')return json(res,200,{ok:true,status:'healthy',database:store.path,version:buildVersion(),model:{provider:'mock',status:'ready',label:'OFFLINE MOCK — not a real benchmark result'},benchmarks:harness.catalog()});
    if(req.method==='GET'&&path==='/api/catalog')return json(res,200,harness.catalog());
    if(req.method==='GET'&&path==='/api/runs')return json(res,200,store.listRuns(Number(url.searchParams.get('limit')||50)));
    if(req.method==='GET'&&/^\/api\/runs\/[^/]+$/.test(path)){const x=store.getRun(path.split('/').at(-1));return x?json(res,200,x):json(res,404,{error:'Run not found'});}
    if(req.method==='GET'&&/^\/api\/runs\/[^/]+\/bundle$/.test(path)){const id=path.split('/')[3],x=store.getRun(id);if(!x)return json(res,404,{error:'Run not found'});res.writeHead(200,{'content-type':'application/json','content-disposition':`attachment; filename="careharness-${id}.json"`});return res.end(JSON.stringify(sanitizeSecrets({bundle_version:1,run:x}),null,2));}
    if(req.method==='POST'&&path==='/api/pipeline/run'){const b=await parse(req),p=new Pipeline(store,{model:b.model||{provider:'mock',model:'careharness-rules-v1'}});return json(res,200,await p.run(b.observation,{seed:b.seed,branch_kind:b.branch_kind}));}
    if(req.method==='POST'&&/^\/api\/runs\/[^/]+\/branch$/.test(path)){const prior=store.getRun(path.split('/')[3]);if(!prior)return json(res,404,{error:'Run not found'});const p=new Pipeline(store,{model:prior.config.model});return json(res,200,await p.run(prior.final.observation,{seed:prior.seed,branch_kind:'debug'}));}
    if(req.method==='POST'&&path==='/api/replay'){const b=await parse(req),run=b.run||b.bundle?.run;if(!run?.final?.observation)throw new Error('Bundle lacks final.observation');const p=new Pipeline(store,{model:b.model||run.config?.model||{provider:'mock',model:'careharness-rules-v1'}});return json(res,200,await p.run(run.final.observation,{seed:run.seed,branch_kind:'debug'}));}
    if(req.method==='GET'&&/^\/api\/states\/[^/]+$/.test(path))return json(res,200,{subject_id:decodeURIComponent(path.split('/').at(-1)),states:store.statesFor(decodeURIComponent(path.split('/').at(-1)))});
    if(req.method==='POST'&&path==='/api/model/test'){const b=await parse(req),g=new ModelGateway(b);return json(res,200,await g.testConnection());}
    if(req.method==='POST'&&/^\/api\/benchmarks\/[^/]+\/preview$/.test(path)){const b=await parse(req),name=path.split('/')[3];return json(res,200,harness.preview(name,b));}
    if(req.method==='POST'&&/^\/api\/benchmarks\/[^/]+\/start$/.test(path)){const b=await parse(req),name=path.split('/')[3];return json(res,202,harness.launch(name,b));}
    if(req.method==='GET'&&path==='/api/experiments')return json(res,200,harness.list());
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
