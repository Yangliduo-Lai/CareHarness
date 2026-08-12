import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sanitizeSecrets } from './schema.js';

export class Store {
  constructor(path = process.env.CAREHARNESS_DB_PATH || './data/careharness.sqlite') {
    this.path = path === ':memory:' ? path : resolve(path); if (this.path !== ':memory:') mkdirSync(dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path); this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;'); this.migrate();
  }
  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, subject_id TEXT NOT NULL, dataset TEXT NOT NULL, checkpoint TEXT,
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
        family TEXT NOT NULL, entity TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL, payload_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS relations(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), source_id TEXT NOT NULL,
        target_id TEXT NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS experiments(id TEXT PRIMARY KEY, benchmark TEXT NOT NULL, status TEXT NOT NULL, config_json TEXT NOT NULL,
        progress_json TEXT NOT NULL, results_json TEXT NOT NULL, version_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_states_subject ON states(subject_id,family); CREATE INDEX IF NOT EXISTS idx_traces_run ON traces(run_id,ordinal);
    `);
  }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const value = fn(); this.db.exec('COMMIT'); return value; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  createRun(run) { this.db.prepare(`INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(run.id, run.subject_id, run.dataset, String(run.checkpoint ?? ''), run.status, run.branch_kind, run.seed, j(run.config), j(run.version), run.created_at, run.updated_at, null, null); }
  saveTrace(runId, trace) { this.db.prepare(`INSERT OR REPLACE INTO traces(run_id,ordinal,component,status,input_json,output_json,gateway_json,error_json) VALUES(?,?,?,?,?,?,?,?)`).run(runId, trace.ordinal, trace.component, trace.status, j(trace.input), j(trace.output), j(trace.gateway), j(trace.error)); }
  commitPipeline(runId, observation, evidence, states, relations, final) { this.transaction(() => {
    this.db.prepare(`INSERT INTO observations VALUES(?,?,?,?,?,?,?)`).run(observation.observation_id, runId, observation.subject_id, observation.episode_id, observation.turn_id, observation.source_type, j(observation));
    const ei = this.db.prepare(`INSERT INTO evidence VALUES(?,?,?,?,?)`); evidence.forEach(x => ei.run(x.evidence_id, runId, x.subject_id, x.observation_id, j(x)));
    const si = this.db.prepare(`INSERT INTO states VALUES(?,?,?,?,?,?,?,?)`); states.forEach(x => si.run(x.state_id, runId, x.subject_id, x.family, x.entity, x.status, x.version, j(x)));
    const ri = this.db.prepare(`INSERT INTO relations VALUES(?,?,?,?,?,?)`); relations.forEach(x => ri.run(x.relation_id, runId, x.source_id, x.target_id, x.type, j(x)));
    this.db.prepare(`UPDATE runs SET status='completed',final_json=?,updated_at=? WHERE id=?`).run(j(final), new Date().toISOString(), runId);
  }); }
  failRun(runId, error) { this.db.prepare(`UPDATE runs SET status='failed',error_json=?,updated_at=? WHERE id=?`).run(j(error), new Date().toISOString(), runId); }
  listRuns(limit = 50) { return this.db.prepare(`SELECT id,subject_id,dataset,checkpoint,status,branch_kind,seed,created_at,updated_at,version_json FROM runs ORDER BY created_at DESC LIMIT ?`).all(limit).map(row => ({...row, version: p(row.version_json)})); }
  getRun(id) { const row = this.db.prepare(`SELECT * FROM runs WHERE id=?`).get(id); if (!row) return null; const traces=this.db.prepare(`SELECT * FROM traces WHERE run_id=? ORDER BY ordinal`).all(id).map(t=>({ordinal:t.ordinal,component:t.component,status:t.status,input:p(t.input_json),output:p(t.output_json),gateway:p(t.gateway_json),error:p(t.error_json)})); return {...row,config:p(row.config_json),version:p(row.version_json),final:p(row.final_json),error:p(row.error_json),traces}; }
  statesFor(subjectId) { return this.db.prepare(`SELECT payload_json FROM states WHERE subject_id=? ORDER BY rowid`).all(subjectId).map(r=>p(r.payload_json)); }
  close() { this.db.close(); }
}
const j = value => JSON.stringify(sanitizeSecrets(value ?? null));
const p = value => value ? JSON.parse(value) : null;
