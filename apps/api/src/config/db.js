'use strict';

/**
 * SQLite layer for the Performance Agent.
 *
 * - File lives at storage/database.sqlite (auto-created).
 * - Migrations are applied on first call to `getDb()`.
 * - `better-sqlite3` is synchronous, which fits this app well: short-lived
 *   queries on the hot path, no async-fanout concerns.
 *
 * Storage policy:
 * - DB stores ONLY metadata, paths, summaries, load profile, threshold counts.
 * - Raw token values, secrets, HTML reports, parsed metrics JSON, run logs,
 *   raw collection JSON, K6 outputs all stay on the filesystem.
 * - The `env_snapshot` column on `runs` holds an ALREADY MASKED env map
 *   (envInjector.maskEnv has run before insert).
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const env = require('./env');
const logger = require('./logger');

const DEFAULT_DB_PATH = path.resolve(__dirname, '..', '..', 'storage', 'database.sqlite');

let _db = null;

function getDb() {
  if (_db) return _db;
  const dbPath = env.dbPath || DEFAULT_DB_PATH;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  migrate(_db);
  seedAdmin(_db);
  logger.info('SQLite ready', { path: dbPath });
  return _db;
}

/* ------------------------------------------------------------------ */
/*  Schema                                                              */
/* ------------------------------------------------------------------ */

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS schema_meta (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS users (
     id            TEXT PRIMARY KEY,
     username      TEXT NOT NULL UNIQUE,
     password_hash TEXT NOT NULL,
     role          TEXT NOT NULL CHECK(role IN ('admin','user')),
     created_at    TEXT NOT NULL,
     updated_at    TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS collections (
     id             TEXT PRIMARY KEY,
     original_name  TEXT,
     stored_name    TEXT,
     file_path      TEXT,
     mimetype       TEXT,
     size_bytes     INTEGER,
     uploaded_at    TEXT NOT NULL,
     summary_json   TEXT,            -- JSON string: { name, schema, requestCount, folderCount }
     auth_json      TEXT,            -- JSON string: detectAuth(...) output
     raw_path       TEXT             -- absolute path to the raw Postman JSON on disk
   )`,

  `CREATE TABLE IF NOT EXISTS environments (
     id              TEXT PRIMARY KEY,
     original_name   TEXT,
     mimetype        TEXT,
     size_bytes      INTEGER,
     uploaded_at     TEXT NOT NULL,
     summary_json    TEXT,           -- masked summary
     validation_json TEXT,           -- issues + variables (values are masked here)
     raw_path        TEXT            -- absolute path to the raw env JSON
   )`,

  `CREATE TABLE IF NOT EXISTS scripts (
     id                          TEXT PRIMARY KEY,
     collection_id               TEXT,
     environment_id              TEXT,
     file_name                   TEXT,
     file_path                   TEXT,
     size_bytes                  INTEGER,
     created_at                  TEXT NOT NULL,
     auth_json                   TEXT,
     inject_auth_token           INTEGER NOT NULL DEFAULT 0,
     load_profile_json           TEXT,
     expected_env_vars_json      TEXT,
     request_count               INTEGER,
     total_collection_requests   INTEGER,
     selection_json              TEXT,
     selected_requests_json      TEXT,
     sanitization_json           TEXT,
     auth_flow_json              TEXT
   )`,

  `CREATE TABLE IF NOT EXISTS reports (
     id                          TEXT PRIMARY KEY,
     run_id                      TEXT NOT NULL UNIQUE,
     script_id                   TEXT,
     status                      TEXT NOT NULL,

     collection_id               TEXT,
     collection_name             TEXT,

     started_at                  TEXT NOT NULL,
     ended_at                    TEXT,
     duration_ms                 INTEGER,
     exit_code                   INTEGER,
     error                       TEXT,

     load_profile_json           TEXT,
     selection_json              TEXT,
     selected_requests_json      TEXT,
     request_count               INTEGER,
     total_collection_requests   INTEGER,

     auth_flow_json              TEXT,
     env_snapshot_json           TEXT,           -- already masked

     display_method              TEXT NOT NULL,
     display_api_name            TEXT NOT NULL,

     metrics_json                TEXT,           -- headline numbers (totalRequests, p95, ...)
     thresholds_json             TEXT,           -- { passed, failed, total }

     -- Filesystem locations (DB never stores HTML / metrics blobs themselves)
     artifacts_dir               TEXT,
     summary_export_path         TEXT,
     metrics_json_path           TEXT,
     parsed_summary_path         TEXT,
     report_html_path            TEXT,
     log_file_path               TEXT,
     script_file_path            TEXT,

     created_at                  TEXT NOT NULL,
     updated_at                  TEXT NOT NULL
   )`,

  `CREATE INDEX IF NOT EXISTS idx_reports_started_at ON reports (started_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_reports_status     ON reports (status)`,
  `CREATE INDEX IF NOT EXISTS idx_reports_collection ON reports (collection_id)`,
];

function migrate(db) {
  db.exec(SCHEMA_STATEMENTS.join(';\n'));
  db.prepare(
    'INSERT OR REPLACE INTO schema_meta(key,value) VALUES(?,?)'
  ).run('version', '1');
}

/* ------------------------------------------------------------------ */
/*  Admin seed                                                          */
/* ------------------------------------------------------------------ */

function seedAdmin(db) {
  const row = db.prepare('SELECT COUNT(*) AS n FROM users').get();
  if (row.n > 0) return;

  const username = env.adminUsername || 'admin';
  const password = env.adminPassword || 'admin';
  const hash = bcrypt.hashSync(password, 10);
  const now = new Date().toISOString();
  const id = require('crypto').randomUUID();
  db.prepare(
    `INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
     VALUES (@id, @username, @password_hash, 'admin', @now, @now)`
  ).run({ id, username, password_hash: hash, now });
  logger.warn(
    'Seeded default admin user. Set ADMIN_USERNAME and ADMIN_PASSWORD in .env, then restart to override.',
    { username }
  );
}

module.exports = { getDb };
