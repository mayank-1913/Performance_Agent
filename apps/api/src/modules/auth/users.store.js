'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { getDb } = require('../../config/db');

function rowToPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function findByUsername(username) {
  return getDb()
    .prepare('SELECT * FROM users WHERE username = ?')
    .get(username);
}

function findById(id) {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function listPublic() {
  return getDb()
    .prepare('SELECT * FROM users ORDER BY created_at ASC')
    .all()
    .map(rowToPublic);
}

function create({ username, password, role = 'user' }) {
  if (!username || !password) throw new Error('username and password are required');
  if (!['admin', 'user'].includes(role)) throw new Error('invalid role');
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const hash = bcrypt.hashSync(password, 10);
  getDb()
    .prepare(
      `INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
       VALUES (?,?,?,?,?,?)`
    )
    .run(id, username, hash, role, now, now);
  return rowToPublic(findById(id));
}

function update(id, { password, role }) {
  const existing = findById(id);
  if (!existing) return null;
  const hash = password ? bcrypt.hashSync(password, 10) : existing.password_hash;
  const newRole = role && ['admin', 'user'].includes(role) ? role : existing.role;
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `UPDATE users SET password_hash = ?, role = ?, updated_at = ? WHERE id = ?`
    )
    .run(hash, newRole, now, id);
  return rowToPublic(findById(id));
}

function remove(id) {
  const res = getDb().prepare('DELETE FROM users WHERE id = ?').run(id);
  return res.changes > 0;
}

function verifyPassword(user, password) {
  if (!user) return false;
  return bcrypt.compareSync(password, user.password_hash);
}

module.exports = {
  findByUsername,
  findById,
  listPublic,
  create,
  update,
  remove,
  verifyPassword,
  rowToPublic,
};
