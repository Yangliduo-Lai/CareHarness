import { Pipeline } from './pipeline.js';
import { validateObservation } from './schema.js';
import { groupSessionObservations } from './session-observation.js';

export class CareLifecycle {
  constructor(store,modelRegistry){this.store=store;this.modelRegistry=modelRegistry;}

  async buildMemory(observations,options={}){
    if(!Array.isArray(observations)||!observations.length)throw new Error('memory build requires at least one observation');
    const cleared=options.reset_memory?this.store.clearMemory(observations[0]?.subject_id):0;
    const pipeline=new Pipeline(this.store,this.modelRegistry.pipelineOptions()),runs=[],sessions=groupSessionObservations(observations);
    for(const observation of sessions)runs.push(await pipeline.run(observation,{...options,phase:'memory_build'}));
    const patient_graph=this.store.patientGraphFor(runs[0].subject_id);return {phase:'memory_build',subject_id:runs[0].subject_id,cleared,processed:runs.length,source_observations:observations.length,runs,patient_graph,memory:patient_graph.nodes};
  }

  async converse(rawObservation,options={}){
    const observation=validateObservation(rawObservation);
    if(observation.source_type!=='patient')throw new Error('conversation phase requires a patient observation');
    const pipeline=new Pipeline(this.store,this.modelRegistry.pipelineOptions());
    const conversation=await pipeline.run(observation,{...options,phase:'conversation'});
    let feedback=null;
    if((options.branch_kind||'formal')==='formal'){
      const doctorObservation={subject_id:observation.subject_id,source_type:'doctor',episode_id:observation.episode_id,
        turn_id:`${observation.turn_id}:doctor`,event_time:observation.event_time,raw_text:conversation.final.response};
      try { feedback=await pipeline.run(doctorObservation,{...options,phase:'memory_build',feedback_of:conversation.id}); }
      catch(error){
        error.publicError={...(error.publicError||{}),write_progress:[{sequence:1,role:'patient',run_id:conversation.id,committed:true},{sequence:2,role:'doctor',run_id:error.run_id||null,committed:false}],write_explanation:'Patient 消息已经写入记忆；Doctor 回复写回失败。修复 Doctor 写回失败步骤后重试。'};
        throw error;
      }
    }
    const writes=[{sequence:1,role:'patient',source_type:'patient',run_id:conversation.id,committed:conversation.final.patient_memory_committed===true},
      {sequence:2,role:'doctor',source_type:'doctor',run_id:feedback?.id||null,committed:Boolean(feedback)}];
    const patient_graph=this.store.patientGraphFor(observation.subject_id);return {phase:'conversation',conversation,feedback,writes,patient_memory_written:writes[0].committed,doctor_memory_written:writes[1].committed,memory_ready_for_next_turn:writes.every(x=>x.committed),patient_graph,memory:patient_graph.nodes};
  }
}
