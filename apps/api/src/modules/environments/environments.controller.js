'use strict';

const fs = require('fs/promises');
const { v4: uuidv4 } = require('uuid');
const ApiError = require('../../utils/ApiError');
const logger = require('../../config/logger');
const store = require('./environments.store');
const { maskToken } = require('../../utils/secrets');
const { validateEnvironment, SECRET_KEY_RE } = require('./environments.validator');

function summarize(parsed, variables) {
  const enabled = variables.filter((v) => v.enabled);
  const tokenVars = enabled.filter((v) => v.secret);
  return {
    name: parsed.name || 'Untitled',
    variableCount: enabled.length,
    tokenVarCount: tokenVars.length,
    tokenVarKeys: tokenVars.map((v) => v.key),
  };
}

function publicValues(parsed) {
  const values = Array.isArray(parsed.values) ? parsed.values : [];
  return values
    .filter((v) => v && v.enabled !== false && v.key)
    .map((v) => {
      const key = String(v.key);
      const isSecret = SECRET_KEY_RE.test(key) || v.type === 'secret';
      const value = v.value == null ? '' : String(v.value);
      return {
        key,
        value: isSecret ? maskToken(value) : value,
        secret: isSecret,
        hasValue: value.length > 0,
      };
    });
}

function publicView(record) {
  if (!record) return null;
  const { raw, ...safe } = record;
  return {
    ...safe,
    values: publicValues(raw),
  };
}

async function uploadEnvironment(req, res, next) {
  if (!req.file) {
    return next(ApiError.badRequest('No file uploaded. Expected field "environment".'));
  }
  const { path: filePath, originalname, size, mimetype } = req.file;

  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      await fs.unlink(filePath).catch(() => {});
      return next(ApiError.badRequest('File is not valid JSON.'));
    }

    const validation = validateEnvironment(parsed);
    if (!validation.valid) {
      await fs.unlink(filePath).catch(() => {});
      return next(
        new ApiError(400, 'Invalid Postman environment.', {
          code: 'INVALID_ENVIRONMENT',
          details: { issues: validation.issues },
        })
      );
    }

    const record = {
      id: uuidv4(),
      originalName: originalname,
      mimetype,
      sizeBytes: size,
      uploadedAt: new Date().toISOString(),
      summary: summarize(parsed, validation.variables),
      validation: { issues: validation.issues, variables: validation.variables },
      raw: parsed, // kept in memory only
    };
    store.add(record);

    logger.info('Environment uploaded', {
      id: record.id,
      name: record.summary.name,
      variableCount: record.summary.variableCount,
      tokenVarCount: record.summary.tokenVarCount,
      issues: validation.issues.length,
    });

    res.status(201).json({ success: true, data: publicView(record) });
  } catch (err) {
    next(err);
  }
}

function listEnvironments(_req, res) {
  res.json({ success: true, data: store.list().map(publicView) });
}

function getEnvironment(req, res, next) {
  const record = store.get(req.params.id);
  if (!record) return next(ApiError.notFound('Environment not found'));
  res.json({ success: true, data: publicView(record) });
}

/**
 * Permanently delete an uploaded environment. Does not delete any collection.
 * Clears environment_id references on generated scripts so future runs no
 * longer associate with the removed environment. Active runs are untouched.
 */
function deleteEnvironment(req, res, next) {
  try {
    const record = store.get(req.params.id);
    if (!record) return next(ApiError.notFound('Environment not found'));

    const scriptsStore = require('../scripts/scripts.store');
    const clearedScripts = scriptsStore.clearEnvironmentReferences(record.id);
    const ok = store.remove(record.id);
    if (!ok) return next(ApiError.notFound('Environment not found'));

    logger.info('Environment deleted', {
      id: record.id,
      name: record.summary?.name || record.originalName,
      clearedScriptReferences: clearedScripts,
    });

    res.json({
      success: true,
      data: {
        id: record.id,
        name: record.summary?.name || record.originalName,
        clearedScriptReferences: clearedScripts,
      },
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  uploadEnvironment,
  listEnvironments,
  getEnvironment,
  deleteEnvironment,
};
