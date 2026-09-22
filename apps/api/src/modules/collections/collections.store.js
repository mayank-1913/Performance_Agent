'use strict';

/**
 * SQLite-backed collections store. Raw Postman JSON is written to
 * storage/collections-raw/<id>.json so the DB stays metadata-only.
 *
 * The existing callers expect each record to expose `record.raw` (the parsed
 * Postman collection object). We keep that contract by reading the raw file
 * lazily and caching the parsed object.
 */

const fs = require('fs');
const path = require('path');
const { getDb } = require('../../config/db');

const RAW_DIR = path.resolve(__dirname, '..', '..', '..', 'storage', 'collections-raw');
fs.mkdirSync(RAW_DIR, { recursive: true });

const _rawCache = new Map();

function readRaw(rawPath) {
  if (!rawPath) return null;
  if (_rawCache.has(rawPath)) return _rawCache.get(rawPath);
  if (!fs.existsSync(rawPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(rawPath, 'utf-8'));
    _rawCache.set(rawPath, parsed);
    return parsed;
  } catch {
    return null;
  }
}

function rowToRecord(row) {
  if (!row) return null;
  const rec = {
    id: row.id,
    originalName: row.original_name,
    storedName: row.stored_name,
    filePath: row.file_path,
    mimetype: row.mimetype,
    sizeBytes: row.size_bytes,
    uploadedAt: row.uploaded_at,
    summary: row.summary_json ? JSON.parse(row.summary_json) : null,
    auth: row.auth_json ? JSON.parse(row.auth_json) : null,
    _rawPath: row.raw_path || null,
  };
  Object.defineProperty(rec, 'raw', {
    get() {
      return readRaw(rec._rawPath);
    },
    enumerable: true,
  });
  return rec;
}

function add(record) {
  if (!record?.id) throw new Error('collections.store.add: id is required');
  // Persist the raw collection JSON to disk; never store it in the DB.
  let rawPath = record._rawPath || null;
  if (record.raw && !rawPath) {
    rawPath = path.join(RAW_DIR, `${record.id}.json`);
    fs.writeFileSync(rawPath, JSON.stringify(record.raw), 'utf-8');
    _rawCache.set(rawPath, record.raw);
  }
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO collections (
         id, original_name, stored_name, file_path, mimetype, size_bytes,
         uploaded_at, summary_json, auth_json, raw_path
       ) VALUES (?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      record.id,
      record.originalName ?? null,
      record.storedName ?? null,
      record.filePath ?? null,
      record.mimetype ?? null,
      record.sizeBytes ?? null,
      record.uploadedAt || new Date().toISOString(),
      record.summary ? JSON.stringify(record.summary) : null,
      record.auth ? JSON.stringify(record.auth) : null,
      rawPath
    );
  return get(record.id);
}

function get(id) {
  const row = getDb().prepare('SELECT * FROM collections WHERE id = ?').get(id);
  return rowToRecord(row);
}

function list() {
  return getDb()
    .prepare('SELECT * FROM collections ORDER BY uploaded_at DESC')
    .all()
    .map(rowToRecord);
}

function remove(id) {
  const existing = get(id);
  if (!existing) return false;
  if (existing._rawPath && fs.existsSync(existing._rawPath)) {
    try {
      fs.unlinkSync(existing._rawPath);
    } catch {
      /* ignore */
    }
    _rawCache.delete(existing._rawPath);
  }
  const res = getDb().prepare('DELETE FROM collections WHERE id = ?').run(id);
  return res.changes > 0;
}

module.exports = { add, get, list, remove };
