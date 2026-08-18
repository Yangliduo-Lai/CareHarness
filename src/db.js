import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sanitizeSecrets } from './schema.js';

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
      CREATE TABLE IF NOT EXISTS states(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), subject_id TEXT NOT NULL,
        family TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL, payload_json TEXT NOT NULL);
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
      CREATE INDEX IF NOT EXISTS idx_states_subject ON states(subject_id,family); CREATE INDEX IF NOT EXISTS idx_traces_run ON traces(run_id,ordinal);
    `);
    if(this.db.prepare(`PRAGMA table_info(runs)`).all().some(x=>x.name==='checkpoint'))this.db.exec(`ALTER TABLE runs DROP COLUMN checkpoint`);
    if(this.db.prepare(`PRAGMA table_info(states)`).all().some(x=>x.name==='entity'))this.db.exec(`ALTER TABLE states DROP COLUMN entity`);
    if(!this.db.prepare(`PRAGMA table_info(memory_checkpoints)`).all().some(x=>x.name==='progress_json'))this.db.exec(`ALTER TABLE memory_checkpoints ADD COLUMN progress_json TEXT`);
    // Historical payloads are normalized lazily by the read APIs. Rewriting every
    // JSON payload here made startup proportional to the entire database and, for
    // large experiment histories, loaded several gigabytes through Statement.all().
    this.db.exec(`DROP TABLE IF EXISTS relations`);
  }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const value = fn(); this.db.exec('COMMIT'); return value; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  createRun(run) { this.db.prepare(`INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(run.id, run.subject_id, run.dataset, run.status, run.branch_kind, run.seed, j(run.config), j(run.version), run.created_at, run.updated_at, null, null); }
  saveTrace(runId, trace) { this.db.prepare(`INSERT OR REPLACE INTO traces(run_id,ordinal,component,status,input_json,output_json,gateway_json,error_json) VALUES(?,?,?,?,?,?,?,?)`).run(runId, trace.ordinal, trace.component, trace.status, j(trace.input), j(trace.output), j(trace.gateway), j(trace.error)); }
  commitMemory(runId, observation, evidence, states) { this.transaction(() => {
    this.db.prepare(`INSERT INTO observations VALUES(?,?,?,?,?,?,?)`).run(observation.observation_id, runId, observation.subject_id, observation.episode_id, observation.turn_id, observation.source_type, j(observation));
    const ei = this.db.prepare(`INSERT INTO evidence VALUES(?,?,?,?,?)`); evidence.forEach(x => ei.run(x.evidence_id, runId, x.subject_id, x.observation_id, j(x)));
    const si = this.db.prepare(`INSERT INTO states VALUES(?,?,?,?,?,?,?)`); states.forEach(x => si.run(x.state_id, runId, x.subject_id, x.family, x.status, x.version, j(x)));
  }); }
  completeRun(runId, final) { this.transaction(() => {
    this.db.prepare(`UPDATE runs SET status='completed',final_json=?,updated_at=? WHERE id=?`).run(j(final), new Date().toISOString(), runId);
  }); }
  failRun(runId, error) { this.db.prepare(`UPDATE runs SET status='failed',error_json=?,updated_at=? WHERE id=?`).run(j(error), new Date().toISOString(), runId); }
  setRunStatus(runId, status) { this.db.prepare(`UPDATE runs SET status=?,updated_at=? WHERE id=?`).run(status, new Date().toISOString(), runId); }
  listRuns(limit = 50) { return this.db.prepare(`SELECT id,subject_id,dataset,status,branch_kind,seed,created_at,updated_at,version_json,config_json FROM runs ORDER BY created_at DESC LIMIT ?`).all(limit).map(row => {const config=p(row.config_json);return {...row,phase:config?.phase||'conversation',config:undefined,config_json:undefined,version:p(row.version_json)}}); }
  getRun(id) { const row = this.db.prepare(`SELECT * FROM runs WHERE id=?`).get(id); if (!row) return null; const traces=this.db.prepare(`SELECT * FROM traces WHERE run_id=? ORDER BY ordinal`).all(id).map(t=>cleanLegacy({ordinal:t.ordinal,component:t.component,status:t.status,input:p(t.input_json),output:p(t.output_json),gateway:p(t.gateway_json),error:p(t.error_json)})); return {...row,config:p(row.config_json),version:p(row.version_json),final:cleanLegacy(p(row.final_json)),error:p(row.error_json),traces}; }
  memorySubjects() { return this.db.prepare(`SELECT subject_id,COUNT(*) AS state_count,MAX(rowid) AS latest_row FROM states GROUP BY subject_id ORDER BY latest_row DESC`).all().map(({subject_id,state_count})=>({subject_id,state_count})); }
  statesFor(subjectId) { return this.db.prepare(`SELECT payload_json FROM states WHERE subject_id=? ORDER BY rowid`).all(subjectId).map(r=>cleanMemory(p(r.payload_json))); }
  evidenceFor(subjectId) { return this.db.prepare(`SELECT payload_json FROM evidence WHERE subject_id=? ORDER BY rowid`).all(subjectId).map(r=>cleanMemory(p(r.payload_json))); }
  observationsForIds(ids=[]) { const get=this.db.prepare(`SELECT payload_json FROM observations WHERE id=?`),seen=new Set();return ids.filter(id=>typeof id==='string'&&id&&!seen.has(id)&&(seen.add(id),true)).map(id=>get.get(id)).filter(Boolean).map(row=>cleanMemory(p(row.payload_json))); }
  clearMemory(subjectId) { if(typeof subjectId!=='string'||!subjectId.trim())throw new Error('subject_id is required');const subject=subjectId.trim();return this.transaction(()=>{const removed=this.db.prepare(`DELETE FROM states WHERE subject_id=?`).run(subject).changes;this.db.prepare(`DELETE FROM memory_state_scopes WHERE subject_id=?`).run(subject);return removed;}); }
  saveMemoryStateScope(scope) { if(!scope?.subject_id)throw new Error('State scope subject_id is required');const now=new Date().toISOString(),value={...scope,updated_at:now};this.db.prepare(`INSERT INTO memory_state_scopes(subject_id,payload_json,updated_at) VALUES(?,?,?) ON CONFLICT(subject_id) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at`).run(scope.subject_id,j(value),now);return value; }
  memoryStateScope(subjectId) { const row=this.db.prepare(`SELECT payload_json FROM memory_state_scopes WHERE subject_id=?`).get(subjectId);if(row)return p(row.payload_json);const match=/^medmemory-persona-(\d+)(?:-(clean|with-noise))?$/.exec(subjectId),persona=match?.[1];if(!persona)return null;const states=this.statesFor(subjectId),sessions=states.map(state=>/^session-(\d+)$/.exec(state.episode_id)?.[1]).filter(Boolean).map(Number);if(!sessions.length)return null;const end=Math.max(...sessions),noise=match?.[2]?match[2]==='with-noise':states.some(state=>/^noise-/.test(state.episode_id)),memoryNamespace=noise?'with-noise':'clean',stateRuns=new Set(this.db.prepare(`SELECT DISTINCT run_id FROM states WHERE subject_id=?`).all(subjectId).map(item=>item.run_id)),experiments=this.db.prepare(`SELECT config_json,progress_json,results_json FROM experiments WHERE benchmark='medmemorybench' ORDER BY created_at DESC LIMIT 50`).all();let matched=null;for(const item of experiments){const config=p(item.config_json)||{},progress=p(item.progress_json)||{},windowEnd=Number(config.max_session??((config.start_session||1)+(config.session_count||1)-1));if(Number(config.persona_id||1)!==Number(persona)||Boolean(config.noise)!==noise||Number(config.start_session||1)!==1||windowEnd!==end||progress.completed+progress.failed!==progress.total||progress.total!==progress.available)continue;const allowed=new Set((p(item.results_json)||[]).filter(result=>result.status==='completed'&&result.run_id).map(result=>result.run_id));if(stateRuns.size&&[...stateRuns].every(id=>allowed.has(id))){matched=progress;break;}}return{subject_id:subjectId,logical_subject_id:`medmemory-persona-${persona}`,memory_namespace:memoryNamespace,benchmark:'medmemorybench',source_start_session:1,source_end_session:end,complete_through_session:end,noise,status:'inferred',inferred:true,observation_total:matched?.total??null,observation_succeeded:matched?.completed??null,observation_failed:matched?.failed??null}; }
  saveMemoryCheckpoint({benchmark,subject_id,scope_key,session_no,prefix_hash,experiment_id,progress=null}) { const states=this.db.prepare(`SELECT run_id,payload_json FROM states WHERE subject_id=? ORDER BY rowid`).all(subject_id).map(row=>({run_id:row.run_id,state:cleanMemory(p(row.payload_json))})),now=new Date().toISOString();this.db.prepare(`INSERT INTO memory_checkpoints(benchmark,subject_id,scope_key,session_no,prefix_hash,state_json,progress_json,experiment_id,created_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(benchmark,subject_id,scope_key,session_no,prefix_hash) DO UPDATE SET state_json=excluded.state_json,progress_json=excluded.progress_json,experiment_id=excluded.experiment_id,created_at=excluded.created_at`).run(benchmark,subject_id,scope_key,session_no,prefix_hash,j(states),j(progress),experiment_id,now);return{session_no,state_count:states.length,progress}; }
  getMemoryCheckpoint({benchmark,subject_id,scope_key,session_no,prefix_hash}) { const row=this.db.prepare(`SELECT * FROM memory_checkpoints WHERE benchmark=? AND subject_id=? AND scope_key=? AND session_no=? AND prefix_hash=? ORDER BY id DESC LIMIT 1`).get(benchmark,subject_id,scope_key,session_no,prefix_hash);return row&&{...row,states:p(row.state_json),progress:p(row.progress_json)}; }
  restoreMemoryCheckpoint(checkpoint) { if(!checkpoint)throw new Error('Memory checkpoint is required');return this.transaction(()=>{const removed=this.db.prepare(`DELETE FROM states WHERE subject_id=?`).run(checkpoint.subject_id).changes,insert=this.db.prepare(`INSERT INTO states(id,run_id,subject_id,family,status,version,payload_json) VALUES(?,?,?,?,?,?,?)`);for(const item of checkpoint.states){const state=cleanMemory(item.state);insert.run(state.state_id,item.run_id,state.subject_id,state.family,state.status,state.version,j(state));}return{removed,restored:checkpoint.states.length,session_no:checkpoint.session_no};}); }
  deleteMemoryCheckpointsAfter({benchmark,subject_id,scope_key,session_no}) { return this.db.prepare(`DELETE FROM memory_checkpoints WHERE benchmark=? AND subject_id=? AND scope_key=? AND session_no>?`).run(benchmark,subject_id,scope_key,session_no).changes; }
  saveModelProfile(profile) { this.db.prepare(`INSERT INTO model_profiles(id,name,config_json,created_at,updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,config_json=excluded.config_json,updated_at=excluded.updated_at`).run(profile.id, profile.name, j(profile.config), profile.created_at, profile.updated_at); }
  listModelProfiles() { return this.db.prepare(`SELECT * FROM model_profiles ORDER BY created_at`).all().map(row=>({id:row.id,name:row.name,config:p(row.config_json),created_at:row.created_at,updated_at:row.updated_at})); }
  getModelProfile(id) { const row=this.db.prepare(`SELECT * FROM model_profiles WHERE id=?`).get(id); return row&&{id:row.id,name:row.name,config:p(row.config_json),created_at:row.created_at,updated_at:row.updated_at}; }
  deleteModelProfile(id) { return this.db.prepare(`DELETE FROM model_profiles WHERE id=?`).run(id).changes > 0; }
  replaceModelAssignments(assignments) { const now=new Date().toISOString(),stmt=this.db.prepare(`INSERT INTO model_assignments(component,profile_id,updated_at) VALUES(?,?,?) ON CONFLICT(component) DO UPDATE SET profile_id=excluded.profile_id,updated_at=excluded.updated_at`); this.transaction(()=>{this.db.exec('DELETE FROM model_assignments');Object.entries(assignments).forEach(([component,profileId])=>stmt.run(component,profileId,now));}); }
  saveModelAssignments(assignments) { const now=new Date().toISOString(),stmt=this.db.prepare(`INSERT INTO model_assignments(component,profile_id,updated_at) VALUES(?,?,?) ON CONFLICT(component) DO UPDATE SET profile_id=excluded.profile_id,updated_at=excluded.updated_at`); this.transaction(()=>Object.entries(assignments).forEach(([component,profileId])=>stmt.run(component,profileId,now))); }
  modelAssignments() { return Object.fromEntries(this.db.prepare(`SELECT component,profile_id FROM model_assignments`).all().map(row=>[row.component,row.profile_id])); }
  close() { this.db.close(); }
}
const j = value => JSON.stringify(sanitizeSecrets(value ?? null));
const p = value => value ? JSON.parse(value) : null;
const isDatabaseBusy=error=>error?.errcode===5||/database is (?:locked|busy)/i.test(String(error?.message||''));
const sleepSync=milliseconds=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,milliseconds);
const REMOVED_MEMORY_FIELDS=new Set(['derived','normalization','speaker','normalized_entity','numbers','relation_hints','checkpoint','entity','relations','operation_reason','derived_from']);
function cleanMemory(value){return cleanLegacy(value);}
function cleanLegacy(value,parent=''){if(Array.isArray(value))return value.map(item=>cleanLegacy(item,parent));if(!value||typeof value!=='object')return value;return Object.fromEntries(Object.entries(value).filter(([key])=>!REMOVED_MEMORY_FIELDS.has(key)&&!(parent==='families'&&key==='reason')).map(([key,item])=>[key,cleanLegacy(item,key)]));}
