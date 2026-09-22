'use strict';

const fs = require('fs/promises');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const ApiError = require('../../utils/ApiError');
const logger = require('../../config/logger');
const store = require('./collections.store');
const environmentsStore = require('../environments/environments.store');
const { parse } = require('../../lib/postman/parser');
const { detectAuth } = require('../../lib/postman/authDetector');
const { sanitizeParsedCollection } = require('../../lib/postman/authSanitizer');
const { buildTree } = require('../../lib/postman/tree');
const {
  resolveVariables,
  publicResolution,
  extractCollectionVariables,
  extractEnvironmentVariables,
} = require('../../lib/postman/variableResolver');

function looksLikePostmanV21(parsed) {
  return (
    parsed &&
    typeof parsed === 'object' &&
    parsed.info &&
    typeof parsed.info.name === 'string' &&
    Array.isArray(parsed.item)
  );
}

function summarize(parsed) {
  const countItems = (items) => {
    let total = 0;
    for (const it of items || []) {
      if (Array.isArray(it.item)) total += countItems(it.item);
      else if (it.request) total += 1;
    }
    return total;
  };

  return {
    name: parsed.info?.name || 'Untitled',
    schema: parsed.info?.schema || null,
    requestCount: countItems(parsed.item),
    folderCount: (parsed.item || []).filter((i) => Array.isArray(i.item)).length,
  };
}

async function uploadCollection(req, res, next) {
  if (!req.file) {
    return next(ApiError.badRequest('No file uploaded. Expected field "collection".'));
  }

  const { path: filePath, originalname, size, mimetype } = req.file;

  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      // cleanup invalid file, then reject
      await fs.unlink(filePath).catch(() => {});
      return next(ApiError.badRequest('File is not valid JSON.'));
    }

    if (!looksLikePostmanV21(parsed)) {
      await fs.unlink(filePath).catch(() => {});
      return next(
        ApiError.badRequest(
          'Not a valid Postman collection. Expected "info.name" and "item" array.'
        )
      );
    }

    const record = {
      id: uuidv4(),
      originalName: originalname,
      storedName: path.basename(filePath),
      filePath,
      mimetype,
      sizeBytes: size,
      uploadedAt: new Date().toISOString(),
      summary: summarize(parsed),
      raw: parsed,
    };

    // Auth detection (without environment for now)
    const parsedNorm = sanitizeParsedCollection(parse(parsed)).parsed;
    const auth = detectAuth(parsedNorm, null);
    record.auth = auth;

    store.add(record);

    logger.info('Collection uploaded', {
      id: record.id,
      name: record.summary.name,
      authMode: auth.mode,
    });

    // Don't leak the raw collection back to the client; return summary + auth.
    res.status(201).json({
      success: true,
      data: {
        id: record.id,
        originalName: record.originalName,
        storedName: record.storedName,
        mimetype: record.mimetype,
        sizeBytes: record.sizeBytes,
        uploadedAt: record.uploadedAt,
        summary: record.summary,
        auth,
      },
    });
  } catch (err) {
    next(err);
  }
}

function publicView(record) {
  if (!record) return null;
  // Hide internal-only fields (raw collection, absolute filesystem path)
  const { raw, filePath, ...safe } = record;
  return safe;
}

function listCollections(_req, res) {
  res.json({ success: true, data: store.list().map(publicView) });
}

function getCollection(req, res, next) {
  const record = store.get(req.params.id);
  if (!record) return next(ApiError.notFound('Collection not found'));
  res.json({ success: true, data: publicView(record) });
}

/**
 * Re-run auth detection against an optional environment.
 * Used by the UI to react to env selection without regenerating the script.
 */
function authCheck(req, res, next) {
  const record = store.get(req.params.id);
  if (!record) return next(ApiError.notFound('Collection not found'));

  const environmentId = req.query.environmentId || req.body?.environmentId || null;
  let environmentRaw = null;
  if (environmentId) {
    const envRec = environmentsStore.get(String(environmentId));
    if (!envRec) return next(ApiError.notFound('Environment not found'));
    environmentRaw = envRec.raw;
  }

  const parsedNorm = sanitizeParsedCollection(parse(record.raw)).parsed;
  const auth = detectAuth(parsedNorm, environmentRaw);

  // Phase 1: run the resolver against the (optional) environment. The UI
  // uses this to distinguish "genuinely unresolved" from "resolvable
  // without an environment" — a collection that already defines every
  // variable it references must NOT produce a false-positive warning when
  // no environment file is selected.
  const variableResolution = resolveVariables({
    collectionVariables: extractCollectionVariables(record.raw),
    environmentVariables: environmentRaw
      ? extractEnvironmentVariables(environmentRaw)
      : null,
    runtimeOverrides: null,
    referencedVars: parsedNorm.referencedVars,
  });

  res.json({
    success: true,
    data: {
      collectionId: record.id,
      environmentId: environmentId || null,
      auth,
      variableResolution: publicResolution(variableResolution),
    },
  });
}

/**
 * Returns a hierarchical tree view of the collection so the UI can render a
 * checkbox tree for selective execution. Each request includes its stable
 * `requestIndex`, which is the canonical selection ID used by `/scripts/generate`.
 */
function getTree(req, res, next) {
  const record = store.get(req.params.id);
  if (!record) return next(ApiError.notFound('Collection not found'));

  const parsedNorm = sanitizeParsedCollection(parse(record.raw)).parsed;
  const tree = buildTree(record.raw, parsedNorm);

  res.json({
    success: true,
    data: {
      collectionId: record.id,
      ...tree,
    },
  });
}

/**
 * Delete a collection: removes the DB row, the on-disk raw JSON, and the
 * uploaded original file (if it still exists). Best-effort on the filesystem
 * pieces — failures are logged but do not block the manifest delete.
 */
async function deleteCollection(req, res, next) {
  try {
    const record = store.get(req.params.id);
    if (!record) return next(ApiError.notFound('Collection not found'));

    const filesToTry = [record.filePath].filter(Boolean);
    const failed = [];
    for (const p of filesToTry) {
      try {
        await fs.unlink(p);
      } catch (err) {
        if (err.code !== 'ENOENT') failed.push({ path: p, error: err.message });
      }
    }

    const ok = store.remove(record.id);
    if (!ok) return next(ApiError.notFound('Collection not found'));

    logger.info('Collection deleted', {
      id: record.id,
      name: record.summary?.name,
      failedFiles: failed.length,
    });

    res.json({
      success: true,
      data: { id: record.id, failedFiles: failed },
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  uploadCollection,
  listCollections,
  getCollection,
  authCheck,
  getTree,
  deleteCollection,
};
