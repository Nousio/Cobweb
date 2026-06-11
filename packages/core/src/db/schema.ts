export const schemaVersion = 2;

export const schemaSql = [
  `CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    root_path TEXT NOT NULL,
    canonical_path TEXT,
    source_type TEXT NOT NULL,
    provenance_json TEXT,
    paths_json TEXT,
    implicit_invocation INTEGER,
    self_contained INTEGER,
    trust_level TEXT,
    risk_level TEXT,
    content_hash TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS resources (
    id TEXT PRIMARY KEY,
    skill_id TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    path TEXT NOT NULL,
    is_external INTEGER NOT NULL,
    risk_flags_json TEXT,
    content_hash TEXT,
    FOREIGN KEY(skill_id) REFERENCES skills(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS methods (
    id TEXT PRIMARY KEY,
    skill_id TEXT NOT NULL,
    method_name TEXT NOT NULL,
    summary TEXT NOT NULL,
    trigger_terms_json TEXT NOT NULL,
    inputs_json TEXT NOT NULL,
    outputs_json TEXT NOT NULL,
    required_tools_json TEXT NOT NULL,
    start_section INTEGER NOT NULL,
    end_section INTEGER NOT NULL,
    extraction_confidence REAL NOT NULL,
    FOREIGN KEY(skill_id) REFERENCES skills(id) ON DELETE CASCADE
  )`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS skill_search_fts USING fts5(
    skill_id UNINDEXED,
    name,
    description,
    body,
    headings,
    method_summary,
    tokenize = 'unicode61'
  )`,
  `CREATE TABLE IF NOT EXISTS provider_installs (
    id TEXT PRIMARY KEY,
    skill_id TEXT NOT NULL,
    provider_name TEXT NOT NULL,
    install_path TEXT NOT NULL,
    projection_strategy TEXT NOT NULL,
    content_hash TEXT,
    drift INTEGER NOT NULL DEFAULT 0,
    last_sync_at TEXT,
    FOREIGN KEY(skill_id) REFERENCES skills(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS audit_results (
    id TEXT PRIMARY KEY,
    skill_id TEXT NOT NULL,
    risk_level TEXT NOT NULL,
    findings_json TEXT NOT NULL,
    audited_at TEXT NOT NULL,
    FOREIGN KEY(skill_id) REFERENCES skills(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS runtime_state (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
];

export const sqlitePragmas = [
  "PRAGMA journal_mode = WAL",
  "PRAGMA busy_timeout = 5000",
  "PRAGMA synchronous = NORMAL",
  "PRAGMA foreign_keys = ON",
];
