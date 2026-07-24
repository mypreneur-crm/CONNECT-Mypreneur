'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scryptAsync = promisify(crypto.scrypt);

function validateIdentifier(value, envName) {
  const identifier = String(value || '').trim();
  if (!/^[A-Za-z0-9_]{1,64}$/.test(identifier)) {
    const error = new Error(`${envName} must contain only letters, numbers, and underscores.`);
    error.code = 'INVALID_AUTH_SCHEMA';
    throw error;
  }
  return identifier;
}

function quoteIdentifier(value, envName) {
  return `\`${validateIdentifier(value, envName)}\``;
}

function authSchemaConfig(env = process.env) {
  return Object.freeze({
    usersTable: quoteIdentifier(env.AUTH_USERS_TABLE || 'users', 'AUTH_USERS_TABLE'),
    employeesTable: quoteIdentifier(env.AUTH_EMPLOYEES_TABLE || 'employees', 'AUTH_EMPLOYEES_TABLE'),
    userRolesTable: quoteIdentifier(env.AUTH_USER_ROLES_TABLE || 'user_roles', 'AUTH_USER_ROLES_TABLE'),
    rolesTable: quoteIdentifier(env.AUTH_ROLES_TABLE || 'roles', 'AUTH_ROLES_TABLE'),
    teamsTable: quoteIdentifier(env.AUTH_TEAMS_TABLE || 'teams', 'AUTH_TEAMS_TABLE')
  });
}

function resolvePortalAccess(roleRows) {
  const active = (roleRows || [])
    .filter(row => Number(row.mapping_active ?? 1) === 1 && row.portal_role)
    .map(row => ({
      sourceRole: String(row.source_role_name || row.role_name || '').trim(),
      role: String(row.portal_role),
      team: row.portal_team || null
    }));

  if (!active.length) return null;

  const priority = { admin: 4, hr_admin: 3, team_admin: 2, member: 1 };
  active.sort((a, b) => (priority[b.role] || 0) - (priority[a.role] || 0));
  const top = active[0];
  const samePriority = active.filter(item => (priority[item.role] || 0) === (priority[top.role] || 0));
  const teams = new Set(samePriority.map(item => item.team).filter(Boolean));
  if (teams.size > 1) {
    const error = new Error('User has conflicting Connect role mappings for multiple teams.');
    error.code = 'CONFLICTING_PORTAL_ROLES';
    throw error;
  }

  return { role: top.role, team: top.team || null, sourceRoles: active.map(item => item.sourceRole) };
}

function displayName(row) {
  const combined = [row.first_name, row.last_name].filter(Boolean).join(' ').trim();
  return combined || row.username;
}

async function hashScryptPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scryptAsync(String(password), salt, 64);
  return `scrypt$${salt}$${Buffer.from(derived).toString('hex')}`;
}

async function verifyScryptPassword(password, encoded) {
  const parts = String(encoded).split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, expectedHex] = parts;
  if (!/^[a-f0-9]{32}$/i.test(salt) || !/^[a-f0-9]{128}$/i.test(expectedHex)) return false;
  const actual = Buffer.from(await scryptAsync(String(password), salt, 64));
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

class DatabaseAuthProvider {
  constructor(db, env = process.env) {
    this.db = db;
    this.schema = authSchemaConfig(env);
    this.allowLegacySha256 = String(env.ALLOW_LEGACY_SHA256_PASSWORDS || '').toLowerCase() === 'true';
  }

  baseQuery(whereClause) {
    const t = this.schema;
    return `
      SELECT
        u.user_id AS id,
        u.username,
        u.password_hash,
        u.is_active AS active,
        e.email AS alt,
        e.first_name,
        e.last_name,
        e.designation AS title,
        e.status AS employee_status,
        t.team_name AS source_team,
        r.role_name AS source_role_name,
        rm.portal_role,
        rm.portal_team,
        rm.active AS mapping_active
      FROM ${t.usersTable} u
      LEFT JOIN ${t.employeesTable} e ON e.employee_id=u.employee_id
      LEFT JOIN ${t.teamsTable} t ON t.team_id=e.team_id
      LEFT JOIN ${t.userRolesTable} ur ON ur.user_id=u.user_id
      LEFT JOIN ${t.rolesTable} r ON r.role_id=ur.role_id
      LEFT JOIN role_mappings rm ON UPPER(rm.source_role_name)=UPPER(r.role_name) AND rm.active=1
      WHERE ${whereClause}`;
  }

  toUser(rows) {
    if (!rows || !rows.length) return null;
    const row = rows[0];
    const access = resolvePortalAccess(rows);
    if (!access) return null;
    const employeeActive = !row.employee_status || String(row.employee_status).toUpperCase() === 'ACTIVE';
    return {
      id: Number(row.id),
      username: String(row.username),
      alt: row.alt || null,
      name: displayName(row),
      title: row.title || 'Team Member',
      role: access.role,
      team: access.team,
      active: Boolean(Number(row.active)) && employeeActive,
      passwordHash: String(row.password_hash || ''),
      sourceRoles: access.sourceRoles
    };
  }

  async findByLogin(login) {
    const value = String(login || '').trim();
    const rows = await this.db.all(this.baseQuery('LOWER(u.username)=LOWER(?) OR LOWER(e.email)=LOWER(?)'), [value, value]);
    return this.toUser(rows);
  }

  async findById(userId) {
    const rows = await this.db.all(this.baseQuery('u.user_id=?'), [userId]);
    return this.toUser(rows);
  }

  async verifyPassword(password, storedHash) {
    const hash = String(storedHash || '').trim();
    if (!hash) return false;

    if (hash.startsWith('scrypt$')) {
      return verifyScryptPassword(password, hash);
    }

    if (/^[a-f0-9]{64}$/i.test(hash)) {
      if (!this.allowLegacySha256) return false;
      const actual = crypto.createHash('sha256').update(String(password)).digest();
      const expected = Buffer.from(hash, 'hex');
      return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    }

    return false;
  }

  async countMappedRoles() {
    return Number((await this.db.get('SELECT COUNT(*) AS count FROM role_mappings WHERE active=1'))?.count || 0);
  }
}

module.exports = {
  DatabaseAuthProvider,
  authSchemaConfig,
  validateIdentifier,
  resolvePortalAccess,
  hashScryptPassword,
  verifyScryptPassword
};
