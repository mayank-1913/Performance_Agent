'use strict';

/**
 * SQLite-backed environments store. Raw Postman environment JSON is kept on
 * disk under storage/environments-raw/<id>.json. Sensitive values inside the
 * raw file are still readable in process memory only when callers need them
 * (auth detection, generation). DB columns hold masked summaries only.
 */

const fs = require('fs');
const path = require('path');
const { getDb } = require('../../config/db');

const RAW_DIR = path.resolve(__dirname, '..', '..', '..', 'storage', 'environments-raw');
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
    mimetype: row.mimetype,
    sizeBytes: row.size_bytes,
    uploadedAt: row.uploaded_at,
    summary: row.summary_json ? JSON.parse(row.summary_json) : null,
    validation: row.validation_json ? JSON.parse(row.validation_json) : null,
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
  if (!record?.id) throw new Error('environments.store.add: id is required');
  let rawPath = record._rawPath || null;
  if (record.raw && !rawPath) {
    rawPath = path.join(RAW_DIR, `${record.id}.json`);
    fs.writeFileSync(rawPath, JSON.stringify(record.raw), 'utf-8');
    _rawCache.set(rawPath, record.raw);
  }
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO environments (
         id, original_name, mimetype, size_bytes, uploaded_at,
         summary_json, validation_json, raw_path
       ) VALUES (?,?,?,?,?,?,?,?)`
    )
    .run(
      record.id,
      record.originalName ?? null,
      record.mimetype ?? null,
      record.sizeBytes ?? null,
      record.uploadedAt || new Date().toISOString(),
      record.summary ? JSON.stringify(record.summary) : null,
      record.validation ? JSON.stringify(record.validation) : null,
      rawPath
    );
  return get(record.id);
}

function get(id) {
  const row = getDb().prepare('SELECT * FROM environments WHERE id = ?').get(id);
  return rowToRecord(row);
}

function list() {
  return getDb()
    .prepare('SELECT * FROM environments ORDER BY uploaded_at DESC')
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
  const res = getDb().prepare('DELETE FROM environments WHERE id = ?').run(id);
  return res.changes > 0;
}

module.exports = { add, get, list, remove };
