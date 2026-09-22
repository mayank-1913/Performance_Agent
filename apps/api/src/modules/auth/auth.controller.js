'use strict';

const ApiError = require('../../utils/ApiError');
const logger = require('../../config/logger');
const usersStore = require('./users.store');
const { signToken } = require('./auth.middleware');

function login(req, res, next) {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      throw ApiError.badRequest('username and password are required');
    }
    const user = usersStore.findByUsername(String(username));
    if (!user || !usersStore.verifyPassword(user, String(password))) {
      // Generic error: no user enumeration.
      throw ApiError.unauthorized('Invalid credentials');
    }
    const token = signToken(user);
    logger.info('Login OK', { username: user.username, role: user.role });
    res.json({
      success: true,
      data: {
        token,
        user: usersStore.rowToPublic(user),
      },
    });
  } catch (err) {
    next(err);
  }
}

function me(req, res) {
  res.json({ success: true, data: { user: req.user } });
}

function listUsers(_req, res) {
  res.json({ success: true, data: usersStore.listPublic() });
}

function createUser(req, res, next) {
  try {
    const { username, password, role } = req.body || {};
    if (!username || !password) {
      throw ApiError.badRequest('username and password are required');
    }
    if (usersStore.findByUsername(String(username))) {
      throw ApiError.badRequest('username already exists');
    }
    const out = usersStore.create({
      username: String(username),
      password: String(password),
      role: role === 'admin' ? 'admin' : 'user',
    });
    res.status(201).json({ success: true, data: out });
  } catch (err) {
    next(err);
  }
}

function updateUser(req, res, next) {
  try {
    const { id } = req.params;
    const { password, role } = req.body || {};
    const out = usersStore.update(id, { password, role });
    if (!out) throw ApiError.notFound('User not found');
    res.json({ success: true, data: out });
  } catch (err) {
    next(err);
  }
}

function deleteUser(req, res, next) {
  try {
    const { id } = req.params;
    if (req.user?.id === id) {
      throw ApiError.badRequest('Cannot delete your own account');
    }
    const ok = usersStore.remove(id);
    if (!ok) throw ApiError.notFound('User not found');
    res.json({ success: true, data: { id } });
  } catch (err) {
    next(err);
  }
}

module.exports = { login, me, listUsers, createUser, updateUser, deleteUser };
