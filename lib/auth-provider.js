'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');
let bcrypt = null;
try { bcrypt = require('bcryptjs'); } catch {}

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
    teamsTable: quoteIdentifier(env.AUTH_TEAMS_TABLE || 'teams', 'AUTH_TEAMS_TABLE'),
    loginHistoryTable: quoteIdentifier(env.AUTH_LOGIN_HISTORY_TABLE || 'login_history', 'AUTH_LOGIN_HISTORY_TABLE')
  });
}

function requiredList(env, name) {
  const values = String(env[name] || '')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
  if (!values.length) {
    const error = new Error(`Missing required access configuration: ${name}`);
    error.code = 'MISSING_ACCESS_CONFIG';
    throw error;
  }
  return new Set(values);
}

function accessConfig(env = process.env) {
  return Object.freeze({
    adminRoles: requiredList(env, 'PORTAL_ADMIN_ROLES'),
    salesAdminRoles: requiredList(env, 'PORTAL_SALES_ADMIN_ROLES'),
    operationsAdminRoles: requiredList(env, 'PORTAL_OPERATIONS_ADMIN_ROLES'),
    hrAdminRoles: requiredList(env, 'PORTAL_HR_ADMIN_ROLES'),
    digitalAdminRoles: requiredList(env, 'PORTAL_DIGITAL_ADMIN_ROLES'),
    salesTeams: requiredList(env, 'PORTAL_SALES_TEAMS'),
    operationsTeams: requiredList(env, 'PORTAL_OPERATIONS_TEAMS'),
    hrTeams: requiredList(env, 'PORTAL_HR_TEAMS'),
    digitalTeams: requiredList(env, 'PORTAL_DIGITAL_TEAMS')
  });
}

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function mapSourceTeam(sourceTeam, config) {
  const team = normalize(sourceTeam);
  if (!team) return null;
  if (config.salesTeams.has(team) || team.includes('sale')) return 'Sales Team';
  if (config.operationsTeams.has(team) || team.includes('operation') || team.includes('ops')) return 'Operations Team';
  if (config.hrTeams.has(team) || team.includes('hr') || team.includes('human')) return 'HR Team';
  if (config.digitalTeams.has(team) || team.includes('digital') || team.includes('tech') || team.includes('dev')) return 'Digital Team';
  return null;
}

function resolvePortalAccess(roleNames, sourceTeam, config) {
  const roles = new Set((roleNames || []).map(normalize).filter(Boolean));

  // Explicitly deny Connect access for Super Admin roles
  if ([...roles].some(role => role === 'super.admin' || role === 'super_admin' || role === 'superadmin' || role === 'super admin' || role === 'admin')) {
    return null;
  }

  // Assign Connect Admin access exclusively to Service Admin roles
  if ([...roles].some(role => config.adminRoles.has(role))) {
    return { role: 'admin', team: null };
  }

  const memberTeam = mapSourceTeam(sourceTeam, config) || (sourceTeam ? sourceTeam + ' Team' : 'General Portal');
  return { role: 'member', team: memberTeam };
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

async function verifyBcryptPassword(password, encoded) {
  if (!bcrypt) return false;
  const compatible = String(encoded).replace(/^\$2y\$/, '$2b$');
  return bcrypt.compare(String(password), compatible);
}


class DatabaseAuthProvider {
  constructor(db, env = process.env) {
    this.db = db;
    this.schema = authSchemaConfig(env);
    this.access = accessConfig(env);
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
        COALESCE(t.team_name, e.designation) AS source_team,
        r.role_name AS source_role_name
      FROM ${t.usersTable} u
      LEFT JOIN ${t.employeesTable} e ON e.employee_id=u.employee_id
      LEFT JOIN ${t.teamsTable} t ON t.team_id=e.team_id
      LEFT JOIN ${t.userRolesTable} ur ON ur.user_id=u.user_id
      LEFT JOIN ${t.rolesTable} r ON r.role_id=ur.role_id
      WHERE ${whereClause}`;
  }

  toUser(rows, { requireAccess = true } = {}) {
    if (!rows || !rows.length) return null;
    const row = rows[0];
    const roleNames = rows.map(item => item.source_role_name).filter(Boolean);
    const access = resolvePortalAccess(roleNames, row.source_team, this.access);
    if (requireAccess && !access) return null;
    const employeeActive = !row.employee_status || String(row.employee_status).toUpperCase() === 'ACTIVE';
    return {
      id: Number(row.id),
      username: String(row.username),
      alt: row.alt || null,
      name: displayName(row),
      title: row.title || 'Team Member',
      role: access?.role || null,
      team: access?.team || null,
      active: Boolean(Number(row.active)) && employeeActive,
      passwordHash: String(row.password_hash || ''),
      sourceRoles: roleNames,
      sourceTeam: row.source_team || null,
      portalAccess: Boolean(access)
    };
  }

  async findByLogin(login, options = {}) {
    const value = String(login || '').trim();
    const rows = await this.db.all(this.baseQuery('LOWER(u.username)=LOWER(?) OR LOWER(e.email)=LOWER(?)'), [value, value]);
    return this.toUser(rows, options);
  }

  async findById(userId, options = {}) {
    const rows = await this.db.all(this.baseQuery('u.user_id=?'), [userId]);
    return this.toUser(rows, options);
  }

  async verifyPassword(password, storedHash) {
    const hash = String(storedHash || '').trim();
    if (!hash) return false;

    if (hash.startsWith('scrypt$')) return verifyScryptPassword(password, hash);
    if (/^\$2[aby]\$/.test(hash)) return verifyBcryptPassword(password, hash);

    // 32 hex characters -> MD5 hash
    if (/^[a-f0-9]{32}$/i.test(hash)) {
      const md5Hex = crypto.createHash('md5').update(String(password)).digest('hex');
      return md5Hex.toLowerCase() === hash.toLowerCase();
    }

    // 40 hex characters -> SHA-1 hash
    if (/^[a-f0-9]{40}$/i.test(hash)) {
      const sha1Hex = crypto.createHash('sha1').update(String(password)).digest('hex');
      return sha1Hex.toLowerCase() === hash.toLowerCase();
    }

    // 64 hex characters -> SHA-256 hash
    if (/^[a-f0-9]{64}$/i.test(hash)) {
      const actual = crypto.createHash('sha256').update(String(password)).digest();
      const expected = Buffer.from(hash, 'hex');
      return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    }

    // Direct plaintext fallback
    return password === hash;
  }

  async recordLogin({ userId = null, status, ipAddress = '', deviceInfo = '' }) {
    const result = await this.db.run(
      `INSERT INTO ${this.schema.loginHistoryTable}
       (user_id,login_time,logout_time,ip_address,device_info,login_status)
       VALUES (?,NOW(),NULL,?,?,?)`,
      [userId, String(ipAddress).slice(0, 50), String(deviceInfo).slice(0, 1000), status]
    );
    return result.insertId || null;
  }

  async recordLogout(loginId, userId) {
    if (!loginId) return;
    await this.db.run(
      `UPDATE ${this.schema.loginHistoryTable}
       SET logout_time=NOW()
       WHERE login_id=? AND user_id=? AND logout_time IS NULL`,
      [loginId, userId]
    );
  }

  async updateLastLogin(userId) {
    await this.db.run(`UPDATE ${this.schema.usersTable} SET last_login=NOW() WHERE user_id=?`, [userId]);
  }
}

module.exports = {
  DatabaseAuthProvider,
  authSchemaConfig,
  accessConfig,
  validateIdentifier,
  resolvePortalAccess,
  mapSourceTeam,
  hashScryptPassword,
  verifyScryptPassword,
  verifyBcryptPassword
};
