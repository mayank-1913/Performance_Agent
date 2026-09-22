'use strict';

/**
 * SQLite-backed scripts store. Generated K6 source code stays on disk under
 * storage/scripts/<id>.js. The DB row holds metadata only.
 */

const { getDb } = require('../../config/db');

function rowToRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    collectionId: row.collection_id,
    environmentId: row.environment_id,
    fileName: row.file_name,
    filePath: row.file_path,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
    auth: row.auth_json ? JSON.parse(row.auth_json) : null,
    injectAuthToken: !!row.inject_auth_token,
    loadProfile: row.load_profile_json ? JSON.parse(row.load_profile_json) : null,
    expectedEnvVars: row.expected_env_vars_json
      ? JSON.parse(row.expected_env_vars_json)
      : [],
    requestCount: row.request_count,
    totalCollectionRequests: row.total_collection_requests,
    selection: row.selection_json ? JSON.parse(row.selection_json) : null,
    selectedRequests: row.selected_requests_json
      ? JSON.parse(row.selected_requests_json)
      : null,
    sanitization: row.sanitization_json ? JSON.parse(row.sanitization_json) : null,
    authFlow: row.auth_flow_json ? JSON.parse(row.auth_flow_json) : null,
  };
}

function add(record) {
  if (!record?.id) throw new Error('scripts.store.add: id is required');
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO scripts (
         id, collection_id, environment_id, file_name, file_path, size_bytes,
         created_at, auth_json, inject_auth_token, load_profile_json,
         expected_env_vars_json, request_count, total_collection_requests,
         selection_json, selected_requests_json, sanitization_json, auth_flow_json
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      record.id,
      record.collectionId ?? null,
      record.environmentId ?? null,
      record.fileName ?? null,
      record.filePath ?? null,
      record.sizeBytes ?? null,
      record.createdAt || new Date().toISOString(),
      record.auth ? JSON.stringify(record.auth) : null,
      record.injectAuthToken ? 1 : 0,
      record.loadProfile ? JSON.stringify(record.loadProfile) : null,
      record.expectedEnvVars ? JSON.stringify(record.expectedEnvVars) : null,
      record.requestCount ?? null,
      record.totalCollectionRequests ?? null,
      record.selection ? JSON.stringify(record.selection) : null,
      record.selectedRequests ? JSON.stringify(record.selectedRequests) : null,
      record.sanitization ? JSON.stringify(record.sanitization) : null,
      record.authFlow ? JSON.stringify(record.authFlow) : null
    );
  return get(record.id);
}

function get(id) {
  const row = getDb().prepare('SELECT * FROM scripts WHERE id = ?').get(id);
  return rowToRecord(row);
}

function listByCollection(collectionId) {
  return getDb()
    .prepare(
      'SELECT * FROM scripts WHERE collection_id = ? ORDER BY created_at DESC'
    )
    .all(collectionId)
    .map(rowToRecord);
}

function list() {
  return getDb()
    .prepare('SELECT * FROM scripts ORDER BY created_at DESC')
    .all()
    .map(rowToRecord);
}

function remove(id) {
  const res = getDb().prepare('DELETE FROM scripts WHERE id = ?').run(id);
  return res.changes > 0;
}

/** Null out environment references when an environment is deleted. */
function clearEnvironmentReferences(environmentId) {
  const res = getDb()
    .prepare('UPDATE scripts SET environment_id = NULL WHERE environment_id = ?')
    .run(environmentId);
  return res.changes;
}

module.exports = {
  add,
  get,
  list,
  listByCollection,
  remove,
  clearEnvironmentReferences,
};
