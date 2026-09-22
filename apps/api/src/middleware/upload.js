'use strict';

const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const env = require('../config/env');
const ApiError = require('../utils/ApiError');

const uploadRoot = path.resolve(__dirname, '..', '..', env.uploadDir);
if (!fs.existsSync(uploadRoot)) {
  fs.mkdirSync(uploadRoot, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadRoot),
  filename: (_req, file, cb) => {
    const safeBase = path
      .basename(file.originalname, path.extname(file.originalname))
      .replace(/[^a-zA-Z0-9-_]/g, '_')
      .slice(0, 60);
    const ext = path.extname(file.originalname).toLowerCase() || '.json';
    cb(null, `${Date.now()}_${uuidv4()}_${safeBase}${ext}`);
  },
});

const ALLOWED_MIME = new Set([
  'application/json',
  'text/json',
  'text/plain', // some browsers send this for .json
  'application/octet-stream', // fallback for raw uploads
]);

function fileFilter(_req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  const isJsonExt = ext === '.json';
  const isJsonMime = ALLOWED_MIME.has(file.mimetype);

  if (!isJsonExt) {
    return cb(ApiError.unsupportedMediaType('Only .json files are accepted.'));
  }
  if (!isJsonMime) {
    return cb(ApiError.unsupportedMediaType(`Unsupported MIME type: ${file.mimetype}`));
  }
  cb(null, true);
}

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: env.maxUploadSizeMb * 1024 * 1024,
    files: 1,
  },
});

module.exports = {
  upload,
  uploadRoot,
};
