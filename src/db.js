import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sanitizeSecrets,validateEvidence,validateObservation,validatePatientGraphEdge,validateState } from './schema.js';

export class Store {
  constructor(path = process.env.CAREHARNESS_DB_PATH || './data/careharness.sqlite') {
    this.path = path === ':memory:' ? path : resolve(path); if (this.path !== ':memory:') mkdirSync(dirname(this.path), { recursive: true });
    for(let attempt=0;;attempt++){
      try{
        this.db = new DatabaseSync(this.path);
        // Set the wait policy before any pragma or migration that may need a lock.
        this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
        // Re-applying journal_mode=WAL needs a schema lock. Avoid doing that when
        // an existing database is already in WAL mode (notably during fast restart).
        const journalMode=this.db.prepare('PRAGMA journal_mode').get()?.journal_mode;
        if(String(journalMode).toLowerCase()!=='wal')this.db.exec('PRAGMA journal_mode=WAL;');
        this.migrate();
        break;
      }catch(error){
        try{this.db?.close();}catch{}
        if(!isDatabaseBusy(error)||attempt>=3)throw error;
        sleepSync(250*(2**attempt));
      }
    }
  }
  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, subject_id TEXT NOT NULL, dataset TEXT NOT NULL,
        status TEXT NOT NULL, branch_kind TEXT NOT NULL, seed INTEGER NOT NULL, config_json TEXT NOT NULL, version_json TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, final_json TEXT, error_json TEXT);
      CREATE TABLE IF NOT EXISTS traces(id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL, component TEXT NOT NULL, status TEXT NOT NULL, input_json TEXT NOT NULL, output_json TEXT,
        gateway_json TEXT, error_json TEXT, UNIQUE(run_id, ordinal));
      CREATE TABLE IF NOT EXISTS observations(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), subject_id TEXT NOT NULL,
        episode_id TEXT NOT NULL, turn_id TEXT NOT NULL, source_type TEXT NOT NULL, payload_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS evidence(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), subject_id TEXT NOT NULL,
        observation_id TEXT NOT NULL, payload_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS patient_graph_nodes(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), subject_id TEXT NOT NULL,
        family TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL, payload_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS patient_graph_edges(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), subject_id TEXT NOT NULL,
        edge_family TEXT NOT NULL, relation_type TEXT NOT NULL, from_node_id TEXT NOT NULL REFERENCES patient_graph_nodes(id) ON DELETE CASCADE,
        to_node_id TEXT NOT NULL REFERENCES patient_graph_nodes(id) ON DELETE CASCADE, status TEXT NOT NULL, confidence REAL NOT NULL,
        payload_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS patient_graph_revisions(subject_id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS experiments(id TEXT PRIMARY KEY, benchmark TEXT NOT NULL, status TEXT NOT NULL, config_json TEXT NOT NULL,
        progress_json TEXT NOT NULL, results_json TEXT NOT NULL, version_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_checkpoints(id INTEGER PRIMARY KEY AUTOINCREMENT, benchmark TEXT NOT NULL, subject_id TEXT NOT NULL,
        scope_key TEXT NOT NULL, session_no INTEGER NOT NULL, prefix_hash TEXT NOT NULL, state_json TEXT NOT NULL,
        progress_json TEXT, experiment_id TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(benchmark,subject_id,scope_key,session_no,prefix_hash));
      CREATE TABLE IF NOT EXISTS memory_state_scopes(subject_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS model_profiles(id TEXT PRIMARY KEY, name TEXT NOT NULL, config_json TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS model_assignments(component TEXT PRIMARY KEY, profile_id TEXT NOT NULL,
        updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS optimization_rounds(id TEXT PRIMARY KEY, status TEXT NOT NULL, target_code TEXT NOT NULL,
        component TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS matched_suites(id TEXT PRIMARY KEY, status TEXT NOT NULL, payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_patient_graph_nodes_subject ON patient_graph_nodes(subject_id,family);
      CREATE INDEX IF NOT EXISTS idx_patient_graph_edges_subject ON patient_graph_edges(subject_id,edge_family,relation_type);
      CREATE INDEX IF NOT EXISTS idx_patient_graph_edges_from ON patient_graph_edges(from_node_id);
      CREATE INDEX IF NOT EXISTS idx_patient_graph_edges_to ON patient_graph_edges(to_node_id);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_patient_graph_edge_semantics ON patient_graph_edges(subject_id,from_node_id,to_node_id,edge_family,relation_type);
      CREATE INDEX IF NOT EXISTS idx_traces_run ON traces(run_id,ordinal);
      CREATE INDEX IF NOT EXISTS idx_optimization_rounds_created ON optimization_rounds(created_at);
      CREATE INDEX IF NOT EXISTS idx_matched_suites_created ON matched_suites(created_at);
    `);
    if(this.db.prepare(`PRAGMA table_info(runs)`).all().some(x=>x.name==='checkpoint'))this.db.exec(`ALTER TABLE runs DROP COLUMN checkpoint`);
    const legacyStates=this.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='states'`).get();
    if(legacyStates){
      const legacyColumns=this.db.prepare(`PRAGMA table_info(states)`).all();
      if(legacyColumns.some(x=>x.name==='entity'))this.db.exec(`ALTER TABLE states DROP COLUMN entity`);
      this.db.exec(`INSERT OR IGNORE INTO patient_graph_nodes(id,run_id,subject_id,family,status,version,payload_json)
        SELECT id,run_id,subject_id,family,status,version,payload_json FROM states; DROP TABLE states;`);
    }
    if(!this.db.prepare(`PRAGMA table_info(memory_checkpoints)`).all().some(x=>x.name==='progress_json'))this.db.exec(`ALTER TABLE memory_checkpoints ADD COLUMN progress_json TEXT`);
    if(!this.db.prepare(`PRAGMA table_info(memory_checkpoints)`).all().some(x=>x.name==='edge_json'))this.db.exec(`ALTER TABLE memory_checkpoints ADD COLUMN edge_json TEXT NOT NULL DEFAULT '[]'`);
    this.db.exec(`INSERT OR IGNORE INTO patient_graph_revisions(subject_id,revision) SELECT DISTINCT subject_id,1 FROM patient_graph_nodes`);
    // Historical payloads are normalized lazily by the read APIs. Rewriting every
    // JSON payload here made startup proportional to the entire database and, for
    // large experiment histories, loaded several gigabytes through Statement.all().
    // Very early prototypes stored unvalidated relation blobs in `relations`.
    // They are not imported: only evidence-bound patient_graph_edges are canonical.
    this.db.exec(`DROP TABLE IF EXISTS relations`);
  }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const value = fn(); this.db.exec('COMMIT'); return value; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  createRun(run) { this.db.prepare(`INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(run.id, run.subject_id, run.dataset, run.status, run.branch_kind, run.seed, j(run.config), j(run.version), run.created_at, run.updated_at, null, null); }
  saveTrace(runId, trace) { this.db.prepare(`INSERT OR REPLACE INTO traces(run_id,ordinal,component,status,input_json,output_json,gateway_json,error_json) VALUES(?,?,?,?,?,?,?,?)`).run(runId, trace.ordinal, trace.component, trace.status, j(trace.input), j(trace.output), j(trace.gateway), j(trace.error)); }
  commitMemory(runId, observation, evidence, states, edges=[], options={}) { return this.transaction(() => {
    const run=this.db.prepare(`SELECT subject_id FROM runs WHERE id=?`).get(runId);if(!run)throw new Error(`Run ${runId} does not exist`);
    validateObservation(observation);for(const item of evidence)validateEvidence(item);for(const item of states)validateState(item);for(const item of edges)validatePatientGraphEdge(item);
    const subject=String(observation.subject_id);if(run.subject_id!==subject)throw new Error(`Run ${runId} and Observation belong to different patients`);
    if(options.expected_graph_revision!=null&&String(options.expected_graph_revision)!==this.graphRevisionFor(subject))throw new Error(`Patient Graph for ${subject} changed concurrently; retry this observation against the latest revision`);
    for(const item of evidence)if(item.subject_id!==subject||item.observation_id!==observation.observation_id)throw new Error(`Evidence ${item.evidence_id} is not bound to the committed Observation and patient`);
    for(const item of states)if(item.subject_id!==subject)throw new Error(`Patient Graph node ${item.state_id} belongs to another patient`);
    for(const item of edges)if(item.subject_id!==subject)throw new Error(`Patient Graph edge ${item.edge_id} belongs to another patient`);
    this.db.prepare(`INSERT INTO observations VALUES(?,?,?,?,?,?,?)`).run(observation.observation_id, runId, subject, observation.episode_id, observation.turn_id, observation.source_type, j(observation));
    const ei = this.db.prepare(`INSERT INTO evidence VALUES(?,?,?,?,?)`); evidence.forEach(x => ei.run(x.evidence_id, runId, x.subject_id, x.observation_id, j(x)));
    const evidenceSubject=this.db.prepare(`SELECT subject_id FROM evidence WHERE id=?`);for(const state of states)for(const evidenceId of state.evidence_ids||[]){const bound=evidenceSubject.get(evidenceId);if(!bound||bound.subject_id!==subject)throw new Error(`Patient Graph node ${state.state_id} has unresolved Evidence ${evidenceId}`);}
    const si = this.db.prepare(`INSERT INTO patient_graph_nodes VALUES(?,?,?,?,?,?,?)`); states.forEach(x => si.run(x.state_id, runId, x.subject_id, x.family, x.status, x.version, j(x)));
    const nodeSubject=this.db.prepare(`SELECT subject_id FROM patient_graph_nodes WHERE id=?`);for(const state of states)for(const lineageId of stateLineageIds(state))if(nodeSubject.get(lineageId)?.subject_id!==subject)throw new Error(`Patient Graph node ${state.state_id} has missing or cross-patient lineage node ${lineageId}`);
    const gi=this.db.prepare(`INSERT INTO patient_graph_edges VALUES(?,?,?,?,?,?,?,?,?,?)`);edges.forEach(x=>{const from=nodeSubject.get(x.from_state_id),to=nodeSubject.get(x.to_state_id);if(!from||!to||from.subject_id!==subject||to.subject_id!==subject)throw new Error(`Patient Graph edge ${x.edge_id} has a missing or cross-patient endpoint`);for(const evidenceId of x.evidence_ids||[]){const bound=evidenceSubject.get(evidenceId);if(!bound||bound.subject_id!==subject)throw new Error(`Patient Graph edge ${x.edge_id} has unresolved Evidence ${evidenceId}`);}gi.run(x.edge_id,runId,subject,x.edge_family,x.relation_type,x.from_state_id,x.to_state_id,x.status,x.confidence,j(x));});
    if(states.length||edges.length)this.bumpGraphRevision(subject);
    return{committed:true,subject_id:subject,observation_id:observation.observation_id,node_count:states.length,edge_count:edges.length,graph_revision:this.graphRevisionFor(subject)};
  }); }
  completeRun(runId, final) { this.transaction(() => {
    this.db.prepare(`UPDATE runs SET status='completed',final_json=?,updated_at=? WHERE id=?`).run(j(final), new Date().toISOString(), runId);
  }); }
  failRun(runId, error) { this.db.prepare(`UPDATE runs SET status='failed',error_json=?,updated_at=? WHERE id=?`).run(j(error), new Date().toISOString(), runId); }
  setRunStatus(runId, status) { this.db.prepare(`UPDATE runs SET status=?,updated_at=? WHERE id=?`).run(status, new Date().toISOString(), runId); }
  listRuns(limit = 50) { return this.db.prepare(`SELECT id,subject_id,dataset,status,branch_kind,seed,created_at,updated_at,version_json,config_json FROM runs ORDER BY created_at DESC LIMIT ?`).all(limit).map(row => {const config=p(row.config_json);return {...row,phase:config?.phase||'conversation',config:undefined,config_json:undefined,version:p(row.version_json)}}); }
  getRun(id) { const row = this.db.prepare(`SELECT * FROM runs WHERE id=?`).get(id); if (!row) return null; const traces=this.db.prepare(`SELECT * FROM traces WHERE run_id=? ORDER BY ordinal`).all(id).map(t=>cleanLegacy({ordinal:t.ordinal,component:t.component,status:t.status,input:p(t.input_json),output:p(t.output_json),gateway:p(t.gateway_json),error:p(t.error_json)})); return {...row,config:p(row.config_json),version:p(row.version_json),final:cleanLegacy(p(row.final_json)),error:p(row.error_json),traces}; }
  memorySubjects() { return this.db.prepare(`SELECT n.subject_id,COUNT(*) AS node_count,MAX(n.rowid) AS latest_row,(SELECT COUNT(*) FROM patient_graph_edges e WHERE e.subject_id=n.subject_id) AS edge_count FROM patient_graph_nodes n GROUP BY n.subject_id ORDER BY latest_row DESC`).all().map(({subject_id,node_count,edge_count})=>({subject_id,node_count,edge_count,state_count:node_count})); }
  statesFor(subjectId) { return this.graphNodesFor(subjectId); }
  graphRevisionFor(subjectId) { const revision=this.db.prepare(`SELECT revision FROM patient_graph_revisions WHERE subject_id=?`).get(subjectId)?.revision||0,nodes=this.db.prepare(`SELECT COUNT(*) AS count,COALESCE(MAX(rowid),0) AS max_row FROM patient_graph_nodes WHERE subject_id=?`).get(subjectId),edges=this.db.prepare(`SELECT COUNT(*) AS count,COALESCE(MAX(rowid),0) AS max_row FROM patient_graph_edges WHERE subject_id=?`).get(subjectId);return`${revision}:${nodes.count}:${nodes.max_row}:${edges.count}:${edges.max_row}`; }
  bumpGraphRevision(subjectId) { this.db.prepare(`INSERT INTO patient_graph_revisions(subject_id,revision) VALUES(?,1) ON CONFLICT(subject_id) DO UPDATE SET revision=revision+1`).run(subjectId);return this.graphRevisionFor(subjectId); }
  graphNodesFor(subjectId) { return this.db.prepare(`SELECT payload_json FROM patient_graph_nodes WHERE subject_id=? ORDER BY rowid`).all(subjectId).map(r=>cleanMemory(p(r.payload_json))); }
  graphEdgesFor(subjectId) { return this.db.prepare(`SELECT payload_json FROM patient_graph_edges WHERE subject_id=? ORDER BY rowid`).all(subjectId).map(r=>cleanMemory(p(r.payload_json))); }
  patientGraphFor(subjectId) { const nodes=this.graphNodesFor(subjectId),edges=this.graphEdgesFor(subjectId),by_family=Object.fromEntries(['BC','PE','PA','CS','CP','LO'].map(family=>[family,nodes.filter(node=>node.family===family).length]));return{version:'careharness-patient-graph.v1',subject_id:subjectId,nodes,edges,summary:{node_count:nodes.length,edge_count:edges.length,by_family,temporal_edge_count:edges.filter(edge=>edge.edge_family==='temporal').length,clinical_care_edge_count:edges.filter(edge=>edge.edge_family==='clinical_care').length}}; }
  evidenceFor(subjectId) { return this.db.prepare(`SELECT payload_json FROM evidence WHERE subject_id=? ORDER BY rowid`).all(subjectId).map(r=>cleanMemory(p(r.payload_json))); }
  observationsForIds(ids=[]) { const get=this.db.prepare(`SELECT payload_json FROM observations WHERE id=?`),seen=new Set();return ids.filter(id=>typeof id==='string'&&id&&!seen.has(id)&&(seen.add(id),true)).map(id=>get.get(id)).filter(Boolean).map(row=>cleanMemory(p(row.payload_json))); }
  clearMemory(subjectId) { if(typeof subjectId!=='string'||!subjectId.trim())throw new Error('subject_id is required');const subject=subjectId.trim();return this.transaction(()=>{const removed=this.db.prepare(`DELETE FROM patient_graph_nodes WHERE subject_id=?`).run(subject).changes;if(removed)this.bumpGraphRevision(subject);this.db.prepare(`DELETE FROM memory_state_scopes WHERE subject_id=?`).run(subject);return removed;}); }
  saveMemoryStateScope(scope) { if(!scope?.subject_id)throw new Error('State scope subject_id is required');const now=new Date().toISOString(),value={...scope,updated_at:now};this.db.prepare(`INSERT INTO memory_state_scopes(subject_id,payload_json,updated_at) VALUES(?,?,?) ON CONFLICT(subject_id) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at`).run(scope.subject_id,j(value),now);return value; }
  memoryStateScope(subjectId) { const row=this.db.prepare(`SELECT payload_json FROM memory_state_scopes WHERE subject_id=?`).get(subjectId);if(row)return p(row.payload_json);const match=/^medmemory-persona-(\d+)(?:-(clean|with-noise))?$/.exec(subjectId),persona=match?.[1];if(!persona)return null;const states=this.statesFor(subjectId),sessions=states.map(state=>/^session-(\d+)$/.exec(state.episode_id)?.[1]).filter(Boolean).map(Number);if(!sessions.length)return null;const end=Math.max(...sessions),noise=match?.[2]?match[2]==='with-noise':states.some(state=>/^noise-/.test(state.episode_id)),memoryNamespace=noise?'with-noise':'clean',stateRuns=new Set(this.db.prepare(`SELECT DISTINCT run_id FROM patient_graph_nodes WHERE subject_id=?`).all(subjectId).map(item=>item.run_id)),experiments=this.db.prepare(`SELECT config_json,progress_json,results_json FROM experiments WHERE benchmark='medmemorybench' ORDER BY created_at DESC LIMIT 50`).all();let matched=null;for(const item of experiments){const config=p(item.config_json)||{},progress=p(item.progress_json)||{},windowEnd=Number(config.max_session??((config.start_session||1)+(config.session_count||1)-1));if(Number(config.persona_id||1)!==Number(persona)||Boolean(config.noise)!==noise||Number(config.start_session||1)!==1||windowEnd!==end||progress.completed+progress.failed!==progress.total||progress.total!==progress.available)continue;const allowed=new Set((p(item.results_json)||[]).filter(result=>result.status==='completed'&&result.run_id).map(result=>result.run_id));if(stateRuns.size&&[...stateRuns].every(id=>allowed.has(id))){matched=progress;break;}}return{subject_id:subjectId,logical_subject_id:`medmemory-persona-${persona}`,memory_namespace:memoryNamespace,benchmark:'medmemorybench',source_start_session:1,source_end_session:end,complete_through_session:end,noise,status:'inferred',inferred:true,observation_total:matched?.total??null,observation_succeeded:matched?.completed??null,observation_failed:matched?.failed??null}; }
  saveMemoryCheckpoint({benchmark,subject_id,scope_key,session_no,prefix_hash,experiment_id,progress=null}) { const states=this.db.prepare(`SELECT run_id,payload_json FROM patient_graph_nodes WHERE subject_id=? ORDER BY rowid`).all(subject_id).map(row=>({run_id:row.run_id,state:cleanMemory(p(row.payload_json))})),edges=this.db.prepare(`SELECT run_id,payload_json FROM patient_graph_edges WHERE subject_id=? ORDER BY rowid`).all(subject_id).map(row=>({run_id:row.run_id,edge:cleanMemory(p(row.payload_json))})),now=new Date().toISOString();this.db.prepare(`INSERT INTO memory_checkpoints(benchmark,subject_id,scope_key,session_no,prefix_hash,state_json,progress_json,experiment_id,created_at,edge_json) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(benchmark,subject_id,scope_key,session_no,prefix_hash) DO UPDATE SET state_json=excluded.state_json,edge_json=excluded.edge_json,progress_json=excluded.progress_json,experiment_id=excluded.experiment_id,created_at=excluded.created_at`).run(benchmark,subject_id,scope_key,session_no,prefix_hash,j(states),j(progress),experiment_id,now,j(edges));return{session_no,state_count:states.length,edge_count:edges.length,progress}; }
  getMemoryCheckpoint({benchmark,subject_id,scope_key,session_no,prefix_hash}) { const row=this.db.prepare(`SELECT * FROM memory_checkpoints WHERE benchmark=? AND subject_id=? AND scope_key=? AND session_no=? AND prefix_hash=? ORDER BY id DESC LIMIT 1`).get(benchmark,subject_id,scope_key,session_no,prefix_hash);return row&&{...row,states:p(row.state_json),edges:p(row.edge_json)||[],progress:p(row.progress_json)}; }
  restoreMemoryCheckpoint(checkpoint) { if(!checkpoint)throw new Error('Memory checkpoint is required');const subject=String(checkpoint.subject_id||''),states=Array.isArray(checkpoint.states)?checkpoint.states:[],edges=Array.isArray(checkpoint.edges)?checkpoint.edges:[],nodeIds=new Set(states.map(item=>String(item?.state?.state_id||''))),evidenceSubject=this.db.prepare(`SELECT subject_id FROM evidence WHERE id=?`),runSubject=this.db.prepare(`SELECT subject_id FROM runs WHERE id=?`);if(!subject||nodeIds.has('')||nodeIds.size!==states.length)throw new Error('Memory checkpoint has invalid or duplicate Patient Graph nodes');for(const item of states){const state=cleanMemory(item.state);validateState(state);if(state.subject_id!==subject||runSubject.get(item.run_id)?.subject_id!==subject)throw new Error(`Checkpoint node ${state.state_id} has a cross-patient or missing Run binding`);for(const evidenceId of state.evidence_ids||[])if(evidenceSubject.get(evidenceId)?.subject_id!==subject)throw new Error(`Checkpoint node ${state.state_id} has unresolved Evidence ${evidenceId}`);for(const lineageId of stateLineageIds(state))if(!nodeIds.has(lineageId))throw new Error(`Checkpoint node ${state.state_id} has missing lineage node ${lineageId}`);}for(const item of edges){const edge=cleanMemory(item.edge);validatePatientGraphEdge(edge);if(edge.subject_id!==subject||runSubject.get(item.run_id)?.subject_id!==subject||!nodeIds.has(String(edge.from_state_id))||!nodeIds.has(String(edge.to_state_id)))throw new Error(`Checkpoint edge ${edge.edge_id} has a cross-patient, missing Run, or missing endpoint binding`);for(const evidenceId of edge.evidence_ids||[])if(evidenceSubject.get(evidenceId)?.subject_id!==subject)throw new Error(`Checkpoint edge ${edge.edge_id} has unresolved Evidence ${evidenceId}`);}return this.transaction(()=>{const removed=this.db.prepare(`DELETE FROM patient_graph_nodes WHERE subject_id=?`).run(subject).changes,insertNode=this.db.prepare(`INSERT INTO patient_graph_nodes(id,run_id,subject_id,family,status,version,payload_json) VALUES(?,?,?,?,?,?,?)`);for(const item of states){const state=cleanMemory(item.state);insertNode.run(state.state_id,item.run_id,state.subject_id,state.family,state.status,state.version,j(state));}const insertEdge=this.db.prepare(`INSERT INTO patient_graph_edges(id,run_id,subject_id,edge_family,relation_type,from_node_id,to_node_id,status,confidence,payload_json) VALUES(?,?,?,?,?,?,?,?,?,?)`);for(const item of edges){const edge=cleanMemory(item.edge);insertEdge.run(edge.edge_id,item.run_id,edge.subject_id,edge.edge_family,edge.relation_type,edge.from_state_id,edge.to_state_id,edge.status,edge.confidence,j(edge));}const graph_revision=this.bumpGraphRevision(subject);return{removed,restored:states.length,restored_edges:edges.length,session_no:checkpoint.session_no,graph_revision};}); }
  deleteMemoryCheckpointsAfter({benchmark,subject_id,scope_key,session_no}) { return this.db.prepare(`DELETE FROM memory_checkpoints WHERE benchmark=? AND subject_id=? AND scope_key=? AND session_no>?`).run(benchmark,subject_id,scope_key,session_no).changes; }
  saveModelProfile(profile) { this.db.prepare(`INSERT INTO model_profiles(id,name,config_json,created_at,updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,config_json=excluded.config_json,updated_at=excluded.updated_at`).run(profile.id, profile.name, j(profile.config), profile.created_at, profile.updated_at); }
  listModelProfiles() { return this.db.prepare(`SELECT * FROM model_profiles ORDER BY created_at`).all().map(row=>({id:row.id,name:row.name,config:p(row.config_json),created_at:row.created_at,updated_at:row.updated_at})); }
  getModelProfile(id) { const row=this.db.prepare(`SELECT * FROM model_profiles WHERE id=?`).get(id); return row&&{id:row.id,name:row.name,config:p(row.config_json),created_at:row.created_at,updated_at:row.updated_at}; }
  deleteModelProfile(id) { return this.db.prepare(`DELETE FROM model_profiles WHERE id=?`).run(id).changes > 0; }
  replaceModelAssignments(assignments) { const now=new Date().toISOString(),stmt=this.db.prepare(`INSERT INTO model_assignments(component,profile_id,updated_at) VALUES(?,?,?) ON CONFLICT(component) DO UPDATE SET profile_id=excluded.profile_id,updated_at=excluded.updated_at`); this.transaction(()=>{this.db.exec('DELETE FROM model_assignments');Object.entries(assignments).forEach(([component,profileId])=>stmt.run(component,profileId,now));}); }
  saveModelAssignments(assignments) { const now=new Date().toISOString(),stmt=this.db.prepare(`INSERT INTO model_assignments(component,profile_id,updated_at) VALUES(?,?,?) ON CONFLICT(component) DO UPDATE SET profile_id=excluded.profile_id,updated_at=excluded.updated_at`); this.transaction(()=>Object.entries(assignments).forEach(([component,profileId])=>stmt.run(component,profileId,now))); }
  modelAssignments() { return Object.fromEntries(this.db.prepare(`SELECT component,profile_id FROM model_assignments`).all().map(row=>[row.component,row.profile_id])); }
  saveOptimizationRound(round) { const now=new Date().toISOString(),created=round.created_at||now,value={...round,created_at:created,updated_at:now};this.db.prepare(`INSERT INTO optimization_rounds(id,status,target_code,component,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,target_code=excluded.target_code,component=excluded.component,payload_json=excluded.payload_json,updated_at=excluded.updated_at`).run(value.id,value.status,value.target_code,value.component,j(value),created,now);return value; }
  getOptimizationRound(id) { const row=this.db.prepare(`SELECT payload_json FROM optimization_rounds WHERE id=?`).get(id);return row?p(row.payload_json):null; }
  listOptimizationRounds(limit=50) { return this.db.prepare(`SELECT payload_json FROM optimization_rounds ORDER BY created_at DESC LIMIT ?`).all(limit).map(row=>p(row.payload_json)); }
  saveMatchedSuite(suite) { const now=new Date().toISOString(),created=suite.created_at||now,value={...suite,created_at:created,updated_at:now};this.db.prepare(`INSERT INTO matched_suites(id,status,payload_json,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,payload_json=excluded.payload_json,updated_at=excluded.updated_at`).run(value.id,value.status,j(value),created,now);return value; }
  getMatchedSuite(id) { const row=this.db.prepare(`SELECT payload_json FROM matched_suites WHERE id=?`).get(id);return row?p(row.payload_json):null; }
  listMatchedSuites(limit=50) { return this.db.prepare(`SELECT payload_json FROM matched_suites ORDER BY created_at DESC LIMIT ?`).all(limit).map(row=>p(row.payload_json)); }
  close() { this.db.close(); }
}
const j = value => JSON.stringify(sanitizeSecrets(value ?? null));
const p = value => value ? JSON.parse(value) : null;
const isDatabaseBusy=error=>error?.errcode===5||/database is (?:locked|busy)/i.test(String(error?.message||''));
const sleepSync=milliseconds=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,milliseconds);
const REMOVED_MEMORY_FIELDS=new Set(['derived','normalization','speaker','normalized_entity','numbers','relation_hints','checkpoint','entity','operation_reason','derived_from']);
function cleanMemory(value){return cleanLegacy(value);}
function stateLineageIds(state){return[...(state?.version_chain||[]),state?.predecessor_state_id,state?.successor_state_id,state?.supersedes,state?.conflicts_with,state?.resolves].filter(Boolean).map(String);}
function cleanLegacy(value,parent=''){if(Array.isArray(value))return value.map(item=>cleanLegacy(item,parent));if(!value||typeof value!=='object')return value;return Object.fromEntries(Object.entries(value).filter(([key])=>!REMOVED_MEMORY_FIELDS.has(key)&&!(parent==='families'&&key==='reason')).map(([key,item])=>[key,cleanLegacy(item,key)]));}
