'use strict';

/**
 * Phase 9 — ownership helpers shared by every protected module.
 *
 * - `isAdmin(req)` is the single source of truth for "ADMIN sees everything".
 * - `canSee(req, record)` returns false when a USER is reaching for a
 *   resource owned by someone else. Admins pass through unconditionally.
 * - `assertCanSee` throws a 404 — not a 403 — so we never leak the fact
 *   that a resource with that id exists for a different owner. This is the
 *   standard IDOR mitigation and matches the "404 or 403 according to
 *   existing security convention" guidance in the spec. The one place we
 *   DO return 403 is attempts to perform a destructive action (DELETE),
 *   because the destructive route is already role-gated and the client
 *   needs an unambiguous "forbidden" to render the right message.
 * - `ownerIdFor(req)` is what controllers stamp on new rows at write time.
 *   USER rows get the authenticated user's id; ADMIN rows also get the
 *   admin's own id so ADMIN-created resources remain attributable (useful
 *   later for audit logging) without changing visibility semantics.
 */

const ApiError = require('../../utils/ApiError');

function isAdmin(req) {
  return req?.user?.role === 'admin';
}

function ownerIdFor(req) {
  return req?.user?.id || null;
}

function canSee(req, record) {
  if (!record) return false;
  if (isAdmin(req)) return true;
  const owner = record.ownerUserId ?? record.owner_user_id ?? null;
  // Records with no owner (legacy, pre-migration or system-owned) are
  // visible to admins only. backfillOwners() runs at boot so this branch
  // is defence-in-depth for freshly-written rows.
  if (owner == null) return false;
  return owner === req?.user?.id;
}

function assertCanSee(req, record, notFoundMessage = 'Not found') {
  if (!record) throw ApiError.notFound(notFoundMessage);
  if (!canSee(req, record)) throw ApiError.notFound(notFoundMessage);
  return record;
}

module.exports = { isAdmin, ownerIdFor, canSee, assertCanSee };
