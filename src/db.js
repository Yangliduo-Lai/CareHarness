import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sanitizeSecrets,validateMemoryEdge,validateMemoryNode,validateObservation } from './schema.js';

export class Store {
  constructor(path = process.env.CAREHARNESS_DB_PATH || './data/careharness.sqlite') {
    this.path = path === ':memory:' ? path : resolve(path); if (this.path !== ':memory:') mkdirSync(dirname(this.path), { recursive: true });
    for(let attempt=0;;attempt++){
      try{
        this.db = new DatabaseSync(this.path);
        // Set the wait policy before any pragma or migration that may need a lock.
        // Several benchmark personas may score in separate Node processes while
        // sharing this database. A judge result only needs a brief write lock,
        // so wait through overlapping checkpoints instead of failing a whole
        // query with SQLITE_BUSY after five seconds.
        this.db.exec('PRAGMA busy_timeout=60000; PRAGMA foreign_keys=ON;');
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
      CREATE TABLE IF NOT EXISTS memory_nodes(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), subject_id TEXT NOT NULL,
        observation_id TEXT NOT NULL, episode_id TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL, payload_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_edges(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), subject_id TEXT NOT NULL,
        edge_family TEXT NOT NULL, relation_type TEXT NOT NULL, from_memory_id TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
        to_memory_id TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE, status TEXT NOT NULL, confidence REAL NOT NULL,
        payload_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_graph_revisions(subject_id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS memory_graph_checkpoints(id INTEGER PRIMARY KEY AUTOINCREMENT, benchmark TEXT NOT NULL, subject_id TEXT NOT NULL,
        scope_key TEXT NOT NULL, session_no INTEGER NOT NULL, prefix_hash TEXT NOT NULL, memory_json TEXT NOT NULL, edge_json TEXT NOT NULL,
        progress_json TEXT, experiment_id TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(benchmark,subject_id,scope_key,session_no,prefix_hash));
      CREATE TABLE IF NOT EXISTS query_phase_checkpoints(manifest_hash TEXT NOT NULL, score_id TEXT NOT NULL, phase TEXT NOT NULL,
        payload_json TEXT NOT NULL, experiment_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(manifest_hash,score_id,phase));
      CREATE TABLE IF NOT EXISTS experiments(id TEXT PRIMARY KEY, benchmark TEXT NOT NULL, status TEXT NOT NULL, config_json TEXT NOT NULL,
        progress_json TEXT NOT NULL, results_json TEXT NOT NULL, version_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_scopes(subject_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS model_profiles(id TEXT PRIMARY KEY, name TEXT NOT NULL, config_json TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS model_assignments(component TEXT PRIMARY KEY, profile_id TEXT NOT NULL,
        updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS optimization_rounds(id TEXT PRIMARY KEY, status TEXT NOT NULL, target_code TEXT NOT NULL,
        component TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS matched_suites(id TEXT PRIMARY KEY, status TEXT NOT NULL, payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_memory_nodes_subject ON memory_nodes(subject_id,episode_id);
      CREATE INDEX IF NOT EXISTS idx_memory_edges_subject ON memory_edges(subject_id,edge_family,relation_type);
      CREATE INDEX IF NOT EXISTS idx_memory_edges_from ON memory_edges(from_memory_id);
      CREATE INDEX IF NOT EXISTS idx_memory_edges_to ON memory_edges(to_memory_id);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_memory_edge_semantics ON memory_edges(subject_id,from_memory_id,to_memory_id,edge_family,relation_type);
      CREATE INDEX IF NOT EXISTS idx_traces_run ON traces(run_id,ordinal);
      CREATE INDEX IF NOT EXISTS idx_experiments_created ON experiments(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_experiments_benchmark_created ON experiments(benchmark,created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_optimization_rounds_created ON optimization_rounds(created_at);
      CREATE INDEX IF NOT EXISTS idx_matched_suites_created ON matched_suites(created_at);
    `);
    if(this.db.prepare(`PRAGMA table_info(runs)`).all().some(x=>x.name==='checkpoint'))this.db.exec(`ALTER TABLE runs DROP COLUMN checkpoint`);
    this.db.exec(`INSERT OR IGNORE INTO memory_graph_revisions(subject_id,revision) SELECT DISTINCT subject_id,1 FROM memory_nodes`);
    // This schema is a hard cutover: runtime reads only memory_nodes and
    // memory_edges. Older tables, if present in an existing database, are not
    // imported, projected, rewritten, or exposed by any API.
  }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const value = fn(); this.db.exec('COMMIT'); return value; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  createRun(run) { this.db.prepare(`INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(run.id, run.subject_id, run.dataset, run.status, run.branch_kind, run.seed, j(run.config), j(run.version), run.created_at, run.updated_at, null, null); }
  saveTrace(runId, trace) { this.db.prepare(`INSERT OR REPLACE INTO traces(run_id,ordinal,component,status,input_json,output_json,gateway_json,error_json) VALUES(?,?,?,?,?,?,?,?)`).run(runId, trace.ordinal, trace.component, trace.status, j(trace.input), j(trace.output), j(trace.gateway), j(trace.error)); }
  commitMemory(runId, observation, memoryNodes, edges=[], options={}) { return this.transaction(() => {
    const run=this.db.prepare(`SELECT subject_id FROM runs WHERE id=?`).get(runId);if(!run)throw new Error(`Run ${runId} does not exist`);
    validateObservation(observation);for(const item of memoryNodes)validateMemoryNode(item);for(const item of edges)validateMemoryEdge(item);
    const subject=String(observation.subject_id);if(run.subject_id!==subject)throw new Error(`Run ${runId} and Observation belong to different patients`);
    if(options.expected_graph_revision!=null&&String(options.expected_graph_revision)!==this.memoryGraphRevisionFor(subject))throw new Error(`Memory Graph for ${subject} changed concurrently; retry this observation against the latest revision`);
    for(const item of memoryNodes)if(item.subject_id!==subject||item.observation_id!==observation.observation_id)throw new Error(`Memory Node ${item.memory_id} is not bound to the committed Observation and patient`);
    for(const item of edges)if(item.subject_id!==subject)throw new Error(`Memory Edge ${item.edge_id} belongs to another patient`);
    this.db.prepare(`INSERT INTO observations VALUES(?,?,?,?,?,?,?)`).run(observation.observation_id, runId, subject, observation.episode_id, observation.turn_id, observation.source_type, j(observation));
    const insertNode=this.db.prepare(`INSERT INTO memory_nodes(id,run_id,subject_id,observation_id,episode_id,status,version,payload_json) VALUES(?,?,?,?,?,?,?,?)`);memoryNodes.forEach(node=>insertNode.run(node.memory_id,runId,node.subject_id,node.observation_id,node.episode_id,node.status,node.version,j(node)));
    const nodeSubject=this.db.prepare(`SELECT subject_id FROM memory_nodes WHERE id=?`);for(const node of memoryNodes)for(const lineageId of memoryLineageIds(node))if(nodeSubject.get(lineageId)?.subject_id!==subject)throw new Error(`Memory Node ${node.memory_id} has missing or cross-patient lineage node ${lineageId}`);
    const insertEdge=this.db.prepare(`INSERT INTO memory_edges(id,run_id,subject_id,edge_family,relation_type,from_memory_id,to_memory_id,status,confidence,payload_json) VALUES(?,?,?,?,?,?,?,?,?,?)`);edges.forEach(edge=>{const from=nodeSubject.get(edge.from_memory_id),to=nodeSubject.get(edge.to_memory_id);if(!from||!to||from.subject_id!==subject||to.subject_id!==subject)throw new Error(`Memory Edge ${edge.edge_id} has a missing or cross-patient endpoint`);for(const memoryId of edge.support_memory_ids||[])if(nodeSubject.get(memoryId)?.subject_id!==subject)throw new Error(`Memory Edge ${edge.edge_id} has unresolved support Memory Node ${memoryId}`);insertEdge.run(edge.edge_id,runId,subject,edge.edge_family,edge.relation_type,edge.from_memory_id,edge.to_memory_id,edge.status,edge.confidence,j(edge));});
    if(memoryNodes.length||edges.length)this.bumpMemoryGraphRevision(subject);
    return{committed:true,subject_id:subject,observation_id:observation.observation_id,node_count:memoryNodes.length,edge_count:edges.length,graph_revision:this.memoryGraphRevisionFor(subject)};
  }); }
  completeRun(runId, final) { this.transaction(() => {
    this.db.prepare(`UPDATE runs SET status='completed',final_json=?,updated_at=? WHERE id=?`).run(j(final), new Date().toISOString(), runId);
  }); }
  failRun(runId, error) { this.db.prepare(`UPDATE runs SET status='failed',error_json=?,updated_at=? WHERE id=?`).run(j(error), new Date().toISOString(), runId); }
  setRunStatus(runId, status) { this.db.prepare(`UPDATE runs SET status=?,updated_at=? WHERE id=?`).run(status, new Date().toISOString(), runId); }
  listRuns(limit = 50) { return this.db.prepare(`SELECT id,subject_id,dataset,status,branch_kind,seed,created_at,updated_at,version_json,config_json FROM runs ORDER BY created_at DESC LIMIT ?`).all(limit).map(row => {const config=p(row.config_json);return {...row,phase:config?.phase||'conversation',config:undefined,config_json:undefined,version:p(row.version_json)}}); }
  getRun(id) { const row = this.db.prepare(`SELECT * FROM runs WHERE id=?`).get(id); if (!row) return null; const traces=this.db.prepare(`SELECT * FROM traces WHERE run_id=? ORDER BY ordinal`).all(id).map(t=>({ordinal:t.ordinal,component:t.component,status:t.status,input:p(t.input_json),output:p(t.output_json),gateway:p(t.gateway_json),error:p(t.error_json)})); return {...row,config:p(row.config_json),version:p(row.version_json),final:p(row.final_json),error:p(row.error_json),traces}; }
  memorySubjects() { return this.db.prepare(`SELECT n.subject_id,COUNT(*) AS node_count,MAX(n.rowid) AS latest_row,(SELECT COUNT(*) FROM memory_edges e WHERE e.subject_id=n.subject_id) AS edge_count FROM memory_nodes n GROUP BY n.subject_id ORDER BY latest_row DESC`).all().map(({subject_id,node_count,edge_count})=>({subject_id,node_count,edge_count})); }
  memoryGraphRevisionFor(subjectId) { const revision=this.db.prepare(`SELECT revision FROM memory_graph_revisions WHERE subject_id=?`).get(subjectId)?.revision||0,nodes=this.db.prepare(`SELECT COUNT(*) AS count,COALESCE(MAX(rowid),0) AS max_row FROM memory_nodes WHERE subject_id=?`).get(subjectId),edges=this.db.prepare(`SELECT COUNT(*) AS count,COALESCE(MAX(rowid),0) AS max_row FROM memory_edges WHERE subject_id=?`).get(subjectId);return`${revision}:${nodes.count}:${nodes.max_row}:${edges.count}:${edges.max_row}`; }
  bumpMemoryGraphRevision(subjectId) { this.db.prepare(`INSERT INTO memory_graph_revisions(subject_id,revision) VALUES(?,1) ON CONFLICT(subject_id) DO UPDATE SET revision=revision+1`).run(subjectId);return this.memoryGraphRevisionFor(subjectId); }
  memoryNodesFor(subjectId) { return this.db.prepare(`SELECT payload_json FROM memory_nodes WHERE subject_id=? ORDER BY rowid`).all(subjectId).map(r=>p(r.payload_json)); }
  memoryEdgesFor(subjectId) { return this.db.prepare(`SELECT payload_json FROM memory_edges WHERE subject_id=? ORDER BY rowid`).all(subjectId).map(r=>p(r.payload_json)); }
  memoryGraphFor(subjectId) { const nodes=this.memoryNodesFor(subjectId),edges=this.memoryEdgesFor(subjectId),by_family=Object.fromEntries(['BC','PE','PA','CS','CP','LO'].map(family=>[family,nodes.filter(node=>(node.families||[]).includes(family)).length])),byEpisode=new Map();for(const node of nodes){const episode=String(node.episode_id||'').trim();if(!episode)continue;const ids=byEpisode.get(episode)||[];ids.push(String(node.memory_id));byEpisode.set(episode,ids);}const episode_memberships=[...byEpisode].map(([episode_id,memory_ids])=>({episode_id,memory_ids})),hasLiteralProvenance=nodes.some(node=>node.construction_kind==='literal_provenance');return{version:hasLiteralProvenance?'careharness-memory-graph.v3-semantic-state-with-literal-provenance':'careharness-memory-graph.v2-semantic-state',subject_id:subjectId,nodes,edges,episode_memberships,summary:{node_count:nodes.length,...(hasLiteralProvenance?{semantic_node_count:nodes.filter(node=>node.construction_kind!=='literal_provenance').length,literal_provenance_count:nodes.filter(node=>node.construction_kind==='literal_provenance').length}:{}),edge_count:edges.length,episode_membership_count:episode_memberships.length,by_family,temporal_edge_count:edges.filter(edge=>edge.edge_family==='temporal').length,clinical_care_edge_count:edges.filter(edge=>edge.edge_family==='clinical_care').length,context_edge_count:edges.filter(edge=>edge.edge_family==='context'||edge.relation_type==='co_observed').length}}; }
  observationsForIds(ids=[]) { const get=this.db.prepare(`SELECT payload_json FROM observations WHERE id=?`),seen=new Set();return ids.filter(id=>typeof id==='string'&&id&&!seen.has(id)&&(seen.add(id),true)).map(id=>get.get(id)).filter(Boolean).map(row=>p(row.payload_json)); }
  clearMemory(subjectId) { if(typeof subjectId!=='string'||!subjectId.trim())throw new Error('subject_id is required');const subject=subjectId.trim();return this.transaction(()=>{const removed=this.db.prepare(`DELETE FROM memory_nodes WHERE subject_id=?`).run(subject).changes;if(removed)this.bumpMemoryGraphRevision(subject);this.db.prepare(`DELETE FROM memory_scopes WHERE subject_id=?`).run(subject);return removed;}); }
  saveMemoryScope(scope) { if(!scope?.subject_id)throw new Error('Memory scope subject_id is required');const now=new Date().toISOString(),value={...scope,updated_at:now};this.db.prepare(`INSERT INTO memory_scopes(subject_id,payload_json,updated_at) VALUES(?,?,?) ON CONFLICT(subject_id) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at`).run(scope.subject_id,j(value),now);return value; }
  memoryScope(subjectId) { const row=this.db.prepare(`SELECT payload_json FROM memory_scopes WHERE subject_id=?`).get(subjectId);if(row)return p(row.payload_json);const match=/^medmemory-persona-(\d+)(?:-(clean|with-noise))?$/.exec(subjectId),persona=match?.[1];if(!persona)return null;const nodes=this.memoryNodesFor(subjectId),sessions=nodes.map(node=>/^session-(\d+)$/.exec(node.episode_id)?.[1]).filter(Boolean).map(Number);if(!sessions.length)return null;const end=Math.max(...sessions),noise=match?.[2]?match[2]==='with-noise':nodes.some(node=>/^noise-/.test(node.episode_id)),memoryNamespace=noise?'with-noise':'clean',memoryRuns=new Set(this.db.prepare(`SELECT DISTINCT run_id FROM memory_nodes WHERE subject_id=?`).all(subjectId).map(item=>item.run_id)),experiments=this.db.prepare(`SELECT config_json,progress_json,results_json FROM experiments WHERE benchmark='medmemorybench' ORDER BY created_at DESC LIMIT 50`).all();let matched=null;for(const item of experiments){const config=p(item.config_json)||{},progress=p(item.progress_json)||{},windowEnd=Number(config.max_session??((config.start_session||1)+(config.session_count||1)-1));if(Number(config.persona_id||1)!==Number(persona)||Boolean(config.noise)!==noise||Number(config.start_session||1)!==1||windowEnd!==end||progress.completed+progress.failed!==progress.total||progress.total!==progress.available)continue;const allowed=new Set((p(item.results_json)||[]).filter(result=>result.status==='completed'&&result.run_id).map(result=>result.run_id));if(memoryRuns.size&&[...memoryRuns].every(id=>allowed.has(id))){matched=progress;break;}}return{subject_id:subjectId,logical_subject_id:`medmemory-persona-${persona}`,memory_namespace:memoryNamespace,benchmark:'medmemorybench',source_start_session:1,source_end_session:end,complete_through_session:end,noise,status:'inferred',inferred:true,observation_total:matched?.total??null,observation_succeeded:matched?.completed??null,observation_failed:matched?.failed??null}; }
  saveMemoryCheckpoint({benchmark,subject_id,scope_key,session_no,prefix_hash,experiment_id,progress=null}) { const nodes=this.db.prepare(`SELECT run_id,payload_json FROM memory_nodes WHERE subject_id=? ORDER BY rowid`).all(subject_id).map(row=>({run_id:row.run_id,node:p(row.payload_json)})),edges=this.db.prepare(`SELECT run_id,payload_json FROM memory_edges WHERE subject_id=? ORDER BY rowid`).all(subject_id).map(row=>({run_id:row.run_id,edge:p(row.payload_json)})),now=new Date().toISOString();this.db.prepare(`INSERT INTO memory_graph_checkpoints(benchmark,subject_id,scope_key,session_no,prefix_hash,memory_json,progress_json,experiment_id,created_at,edge_json) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(benchmark,subject_id,scope_key,session_no,prefix_hash) DO UPDATE SET memory_json=excluded.memory_json,edge_json=excluded.edge_json,progress_json=excluded.progress_json,experiment_id=excluded.experiment_id,created_at=excluded.created_at`).run(benchmark,subject_id,scope_key,session_no,prefix_hash,j(nodes),j(progress),experiment_id,now,j(edges));return{session_no,node_count:nodes.length,edge_count:edges.length,progress}; }
  getMemoryCheckpoint({benchmark,subject_id,scope_key,session_no,prefix_hash}) { const row=this.db.prepare(`SELECT * FROM memory_graph_checkpoints WHERE benchmark=? AND subject_id=? AND scope_key=? AND session_no=? AND prefix_hash=? ORDER BY id DESC LIMIT 1`).get(benchmark,subject_id,scope_key,session_no,prefix_hash);if(!row)return null;return{...row,nodes:p(row.memory_json)||[],edges:p(row.edge_json)||[],progress:p(row.progress_json)}; }
  saveQueryPhaseCheckpoint({manifest_hash,score_id,phase,payload,experiment_id}) { const now=new Date().toISOString();this.db.prepare(`INSERT INTO query_phase_checkpoints(manifest_hash,score_id,phase,payload_json,experiment_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(manifest_hash,score_id,phase) DO UPDATE SET payload_json=excluded.payload_json,experiment_id=excluded.experiment_id,updated_at=excluded.updated_at`).run(manifest_hash,String(score_id),phase,j(payload),experiment_id,now,now);return{manifest_hash,score_id:String(score_id),phase,experiment_id,updated_at:now}; }
  getQueryPhaseCheckpoint({manifest_hash,score_id,phase}) { const row=this.db.prepare(`SELECT * FROM query_phase_checkpoints WHERE manifest_hash=? AND score_id=? AND phase=?`).get(manifest_hash,String(score_id),phase);return row?{...row,payload:p(row.payload_json)}:null; }
  deleteQueryPhaseCheckpoint({manifest_hash,score_id,phase}) { return this.db.prepare(`DELETE FROM query_phase_checkpoints WHERE manifest_hash=? AND score_id=? AND phase=?`).run(manifest_hash,String(score_id),phase).changes; }
  restoreMemoryCheckpoint(checkpoint) { if(!checkpoint)throw new Error('Memory checkpoint is required');const subject=String(checkpoint.subject_id||''),nodes=Array.isArray(checkpoint.nodes)?checkpoint.nodes:[],edges=Array.isArray(checkpoint.edges)?checkpoint.edges:[],nodeIds=new Set(nodes.map(item=>String(item?.node?.memory_id||''))),runSubject=this.db.prepare(`SELECT subject_id FROM runs WHERE id=?`);if(!subject||nodeIds.has('')||nodeIds.size!==nodes.length)throw new Error('Memory checkpoint has invalid or duplicate Memory Nodes');for(const item of nodes){const node=item.node;validateMemoryNode(node);if(node.subject_id!==subject||runSubject.get(item.run_id)?.subject_id!==subject)throw new Error(`Checkpoint Memory Node ${node.memory_id} has a cross-patient or missing Run binding`);for(const lineageId of memoryLineageIds(node))if(!nodeIds.has(lineageId))throw new Error(`Checkpoint Memory Node ${node.memory_id} has missing lineage node ${lineageId}`);}for(const item of edges){const edge=item.edge;validateMemoryEdge(edge);if(edge.subject_id!==subject||runSubject.get(item.run_id)?.subject_id!==subject||!nodeIds.has(String(edge.from_memory_id))||!nodeIds.has(String(edge.to_memory_id)))throw new Error(`Checkpoint Memory Edge ${edge.edge_id} has a cross-patient, missing Run, or missing endpoint binding`);for(const memoryId of edge.support_memory_ids||[])if(!nodeIds.has(String(memoryId)))throw new Error(`Checkpoint Memory Edge ${edge.edge_id} has unresolved support Memory Node ${memoryId}`);}return this.transaction(()=>{const removed=this.db.prepare(`DELETE FROM memory_nodes WHERE subject_id=?`).run(subject).changes,insertNode=this.db.prepare(`INSERT INTO memory_nodes(id,run_id,subject_id,observation_id,episode_id,status,version,payload_json) VALUES(?,?,?,?,?,?,?,?)`);for(const item of nodes){const node=item.node;insertNode.run(node.memory_id,item.run_id,node.subject_id,node.observation_id,node.episode_id,node.status,node.version,j(node));}const insertEdge=this.db.prepare(`INSERT INTO memory_edges(id,run_id,subject_id,edge_family,relation_type,from_memory_id,to_memory_id,status,confidence,payload_json) VALUES(?,?,?,?,?,?,?,?,?,?)`);for(const item of edges){const edge=item.edge;insertEdge.run(edge.edge_id,item.run_id,edge.subject_id,edge.edge_family,edge.relation_type,edge.from_memory_id,edge.to_memory_id,edge.status,edge.confidence,j(edge));}const graph_revision=this.bumpMemoryGraphRevision(subject);return{removed,restored:nodes.length,restored_edges:edges.length,session_no:checkpoint.session_no,graph_revision};}); }
  deleteMemoryCheckpointsAfter({benchmark,subject_id,scope_key,session_no}) { return this.db.prepare(`DELETE FROM memory_graph_checkpoints WHERE benchmark=? AND subject_id=? AND scope_key=? AND session_no>?`).run(benchmark,subject_id,scope_key,session_no).changes; }
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
function memoryLineageIds(node){return[...(node?.version_chain||[]),node?.predecessor_memory_id,node?.successor_memory_id,node?.conflicts_with_memory_id].filter(Boolean).map(String);}
