import { Pipeline } from './pipeline.js';
import { validateObservation } from './schema.js';
import { groupSessionObservations } from './session-observation.js';

export class DebugRuns {
  constructor(store, modelRegistry) { this.store=store; this.modelRegistry=modelRegistry; this.active=new Map(); }

  async start(observation, options={}) {
    const session={kind:'single',id:null,currentRunId:null,mode:'step',status:'starting',waiters:[],resume:null,error:null};
    const firstEvent=this.#event(session);
    const pipeline=new Pipeline(this.store,this.modelRegistry.pipelineOptions());
    const breakpoint=async({run_id,traces})=>{
      session.id=run_id;session.currentRunId=run_id;session.currentTraces=traces;
      await this.#pause(session,run_id);
    };
    session.done=pipeline.run(observation,{seed:options.seed,branch_kind:options.branch_kind||'formal',dataset:options.dataset,phase:options.phase,breakpoint})
      .then(result=>{session.id=result.id;session.currentRunId=result.id;session.currentTraces=result.traces;session.status='completed';this.#signal(session);return result})
      .catch(error=>{session.id=error.run_id||session.id;session.currentRunId=session.id;session.status='failed';session.error=error;this.#signal(session);return null});
    await firstEvent;
    this.active.set(session.id,session);
    return this.view(session.id);
  }

  async startMemory(rawObservations, options={}) {
    if(!Array.isArray(rawObservations)||!rawObservations.length)throw new Error('memory breakpoint requires at least one observation');
    const validated=rawObservations.map(value=>validateObservation(value));
    const subjectId=validated[0].subject_id;
    if(validated.some(value=>value.subject_id!==subjectId))throw new Error('one memory breakpoint session can only contain observations for one patient');
    if(options.reset_memory)this.store.clearMemory(subjectId);
    const observations=groupSessionObservations(validated);
    const session={kind:'memory_build',id:null,currentRunId:null,currentIndex:0,boundary:false,observations,sourceObservationCount:validated.length,results:[],runIds:[],mode:'step',status:'starting',waiters:[],resume:null,error:null};
    const firstEvent=this.#event(session);
    const pipeline=new Pipeline(this.store,this.modelRegistry.pipelineOptions());
    session.done=(async()=>{
      for(let index=0;index<observations.length;index++){
        session.currentIndex=index;session.boundary=false;
        const breakpoint=async({run_id,traces})=>{
          session.currentRunId=run_id;session.currentTraces=traces;
          if(!session.id)session.id=run_id;
          if(!session.runIds.includes(run_id))session.runIds.push(run_id);
          await this.#pause(session,run_id);
        };
        const result=await pipeline.run(observations[index],{seed:options.seed,branch_kind:options.branch_kind||'formal',dataset:options.dataset,phase:'memory_build',breakpoint});
        session.currentRunId=result.id;
        session.currentTraces=result.traces;
        if(!session.runIds.includes(result.id))session.runIds.push(result.id);
        session.results.push(result);
        if(index<observations.length-1){
          session.currentIndex=index+1;session.boundary=true;
          await this.#pause(session,null);
        }
      }
      session.boundary=false;session.status='completed';this.#signal(session);
      return session.results;
    })().catch(error=>{
      session.currentRunId=error.run_id||session.currentRunId;
      session.status='failed';session.error=error;this.#signal(session);return null;
    });
    await firstEvent;
    this.active.set(session.id,session);
    return this.view(session.id);
  }

  async startConversation(rawObservation, options={}) {
    const observation=validateObservation(rawObservation);
    if(observation.source_type!=='patient')throw new Error('conversation breakpoint requires a patient observation');
    const session={kind:'conversation',id:null,currentRunId:null,currentStage:'patient',boundary:false,mode:'step',status:'starting',waiters:[],resume:null,error:null,runIds:[],patientResult:null,doctorResult:null,observation};
    const firstEvent=this.#event(session),pipeline=new Pipeline(this.store,this.modelRegistry.pipelineOptions());
    const runWithBreakpoints=async(input,phase,extra={})=>pipeline.run(input,{seed:options.seed,branch_kind:'formal',dataset:options.dataset,phase,...extra,breakpoint:async({run_id,traces})=>{
      session.currentRunId=run_id;session.currentTraces=traces;
      if(!session.id)session.id=run_id;
      if(!session.runIds.includes(run_id))session.runIds.push(run_id);
      await this.#pause(session,run_id);
    }});
    session.done=(async()=>{
      session.patientResult=await runWithBreakpoints(observation,'conversation');
      session.currentRunId=session.patientResult.id;session.currentTraces=session.patientResult.traces;
      session.currentStage='doctor';session.boundary=true;
      await this.#pause(session,null);
      session.boundary=false;
      const doctorObservation={subject_id:observation.subject_id,source_type:'doctor',episode_id:observation.episode_id,turn_id:`${observation.turn_id}:doctor`,event_time:observation.event_time,raw_text:session.patientResult.final.response};
      session.doctorResult=await runWithBreakpoints(doctorObservation,'memory_build',{feedback_of:session.patientResult.id});
      session.currentRunId=session.doctorResult.id;session.currentTraces=session.doctorResult.traces;
      session.status='completed';this.#signal(session);
      return {conversation:session.patientResult,feedback:session.doctorResult};
    })().catch(error=>{session.currentRunId=error.run_id||session.currentRunId;session.status='failed';session.error=error;this.#signal(session);return null;});
    await firstEvent;
    this.active.set(session.id,session);
    return this.view(session.id);
  }

  async advance(id, mode='step') {
    const session=this.active.get(id);
    if(!session)throw new Error('Debug run is not active; start a new breakpoint run');
    if(!['step','continue'].includes(mode))throw new Error('Debug mode must be step or continue');
    if(session.status!=='paused')throw new Error(`Debug run is ${session.status}, not paused`);
    session.mode=mode;
    const event=this.#event(session);
    session.resume?.();
    await event;
    return this.view(id);
  }

  view(id) {
    const session=this.active.get(id);
    const runId=session?.currentRunId||id;
    const run=runId?this.store.getRun(runId):null;
    if(!run)throw new Error('Debug run not found');
    const traces=session?.status!=='failed'&&session?.currentTraces?session.currentTraces:run.traces;
    if(session?.kind==='memory_build'){
      return {...run,phase:'memory_build',status:session.status,traces,debug:{
        kind:'memory_build',session_id:session.id,active:['starting','running','paused'].includes(session.status),paused:session.status==='paused',
        can_step:session.status==='paused',next_ordinal:run.traces.length,boundary:session.boundary,current_index:session.currentIndex,
        total_observations:session.observations.length,source_observations:session.sourceObservationCount,completed_observations:session.results.length,current_run_id:runId,
        current_observation:session.observations[session.currentIndex],run_ids:[...session.runIds],
        runs:session.runIds.map(runId=>{const item=this.store.getRun(runId);return {id:runId,status:item?.status||'starting',steps:item?.traces?.length||0,source_type:item?.final?.observation?.source_type||null};})
      }};
    }
    if(session?.kind==='conversation'){
      const patientCommitted=Boolean(session.patientResult?.final?.patient_memory_committed)||session.currentStage==='patient'&&traces.some(x=>x.component==='patient_memory_commit'&&x.output?.committed);
      const doctorCommitted=Boolean(session.doctorResult);
      const patientRunId=session.patientResult?.id||session.runIds[0]||null;
      const doctorRunId=session.doctorResult?.id||(session.currentStage==='doctor'&&session.currentRunId!==patientRunId?session.currentRunId:null);
      const priorRuns=[patientRunId,doctorRunId].filter((value,index,items)=>value&&value!==runId&&items.indexOf(value)===index).map(value=>this.store.getRun(value)).filter(Boolean);
      return {...run,status:session.status,traces,debug:{
        kind:'conversation',session_id:session.id,active:['starting','running','paused'].includes(session.status),paused:session.status==='paused',can_step:session.status==='paused',
        boundary:session.boundary,current_stage:session.currentStage,current_run_id:runId,run_ids:[...session.runIds],patient_memory_written:patientCommitted,doctor_memory_written:doctorCommitted,
        patient_run_id:patientRunId,doctor_run_id:doctorRunId,doctor_response:session.patientResult?.final?.response||null,prior_runs:priorRuns,
        runs:session.runIds.map(value=>{const item=this.store.getRun(value);return{id:value,status:item?.status||'starting',phase:item?.config?.phase||null,source_type:item?.final?.observation?.source_type||null,steps:item?.traces?.length||0};})
      }};
    }
    return {...run,status:session?.status||run.status,traces,debug:{active:Boolean(session&&['starting','running','paused'].includes(session.status)),paused:session?.status==='paused',next_ordinal:traces.length,can_step:session?.status==='paused'}};
  }

  async #pause(session,runId) {
    if(session.mode==='continue')return;
    session.status='paused';
    if(runId)this.store.setRunStatus(runId,'paused');
    this.#signal(session);
    await new Promise(resolve=>{session.resume=resolve});
    session.resume=null;session.status='running';
    if(runId)this.store.setRunStatus(runId,'running');
  }

  #event(session){return new Promise(resolve=>session.waiters.push(resolve));}
  #signal(session){for(const resolve of session.waiters.splice(0))resolve();}
}
