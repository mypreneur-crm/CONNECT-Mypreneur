'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const { MySQLDatabase, databaseConfig } = require('./lib/database');
const { LocalFileStore } = require('./lib/file-store');
const { initializeSchema } = require('./lib/schema');
const { DatabaseAuthProvider, hashScryptPassword } = require('./lib/auth-provider');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const NODE_ENV = process.env.NODE_ENV || 'development';
const TRUST_PROXY = String(process.env.TRUST_PROXY || '').toLowerCase() === 'true';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(DATA_DIR, 'uploads'));
const MAX_FILE_BYTES = Number(process.env.MAX_FILE_BYTES || 3 * 1024 * 1024);
const MAX_JSON_BYTES = Math.max(MAX_FILE_BYTES * 2, Number(process.env.MAX_JSON_BYTES || 8 * 1024 * 1024));
const SESSION_MS = 12 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;
const MAX_LOGIN_FAILURES = 8;
const CATEGORIES = ['Policies', 'Sales Team', 'Operations Team', 'HR Team', 'Digital Team'];
const EVENT_TYPES = ['Online', 'Offline', 'Meeting'];
const FILE_EXTENSIONS = new Set(['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.csv', '.png', '.jpg', '.jpeg']);

let db;
let fileStore;
let authProvider;
let dummyPasswordHash;
let server;
let sessionSecret;
const loginAttempts = new Map();
let shuttingDown = false;

function nowIso() { return new Date().toISOString(); }
function addMs(iso, ms) { return new Date(new Date(iso).getTime() + ms).toISOString(); }
function randomToken(bytes = 32) { return crypto.randomBytes(bytes).toString('base64url'); }
function tokenHash(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function publicUser(row) {
  return {
    id: row.id,
    user: row.username,
    username: row.username,
    name: row.name,
    title: row.title,
    role: row.role,
    team: row.team || null
  };
}

const MASTER_APP_SECRET = 'mypreneur_connect_master_app_secret_v1_2026_x89a';

function getEncryptionKey(secretOverride) {
  const secret = String(secretOverride || MASTER_APP_SECRET);
  return crypto.createHash('sha256').update(secret).digest();
}

function encryptText(text) {
  if (!text) return '';
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(String(text), 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `enc:v1:${iv.toString('hex')}:${authTag}:${encrypted}`;
}

function decryptTextWithKey(key, ivHex, tagHex, encryptedHex) {
  try {
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(tagHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    return null;
  }
}

function decryptText(encoded) {
  if (!encoded) return '';
  const str = String(encoded);
  if (!str.startsWith('enc:v1:')) return str;
  const parts = str.split(':');
  if (parts.length !== 5) return str;
  const [, , ivHex, tagHex, encryptedHex] = parts;

  const candidateSecrets = [
    MASTER_APP_SECRET,
    sessionSecret,
    process.env.ENCRYPTION_SECRET,
    process.env.SESSION_SECRET,
    'mypreneur_connect_local_secret_32chars_long_key_1234'
  ].filter(Boolean);

  const uniqueSecrets = Array.from(new Set(candidateSecrets));

  for (const secret of uniqueSecrets) {
    const key = crypto.createHash('sha256').update(String(secret)).digest();
    const result = decryptTextWithKey(key, ivHex, tagHex, encryptedHex);
    if (result !== null) return result;
  }

  return '[Anonymous Feedback]';
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return String(forwarded).split(',')[0].trim();
  }
  return String(req.socket.remoteAddress || 'unknown').trim();
}

function loginAttemptKey(ip, username) {
  return crypto.createHash('sha256').update(`${ip}\n${username}`).digest('hex');
}

function loginAllowed(key) {
  const now = Date.now();
  const row = loginAttempts.get(key);
  if (!row) return true;
  if (row.blockedUntil && row.blockedUntil > now) return false;
  if (now - row.windowStarted >= LOGIN_WINDOW_MS) {
    loginAttempts.delete(key);
    return true;
  }
  return row.failures < MAX_LOGIN_FAILURES;
}

function registerLoginFailure(key) {
  const now = Date.now();
  const row = loginAttempts.get(key);
  if (!row || now - row.windowStarted >= LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { failures: 1, windowStarted: now, blockedUntil: null });
    return;
  }
  row.failures += 1;
  if (row.failures >= MAX_LOGIN_FAILURES) row.blockedUntil = now + LOGIN_BLOCK_MS;
  loginAttempts.set(key, row);
}

function clearLoginFailures(key) {
  loginAttempts.delete(key);
}

function cleanupLoginAttempts() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [key, row] of loginAttempts.entries()) {
    if (row.windowStarted < cutoff && (!row.blockedUntil || row.blockedUntil < Date.now())) loginAttempts.delete(key);
  }
}

function parseCookies(req) {
  const output = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try { output[key] = decodeURIComponent(value); } catch { output[key] = value; }
  }
  return output;
}

function signSessionPayload(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', sessionSecret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function verifySessionToken(token) {
  const [encoded, signature, extra] = String(token || '').split('.');
  if (!encoded || !signature || extra) return null;
  const expected = crypto.createHmac('sha256', sessionSecret).update(encoded).digest();
  let supplied;
  try { supplied = Buffer.from(signature, 'base64url'); } catch { return null; }
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (payload.v !== 1 || !Number.isInteger(payload.userId) || !payload.csrf || !payload.exp) return null;
    if (Number(payload.exp) <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

async function getAuth(req) {
  const token = parseCookies(req).mc_session;
  if (!token) return null;
  const session = verifySessionToken(token);
  if (!session) return null;
  const userRecord = await authProvider.findById(session.userId);
  if (!userRecord || !userRecord.active || !userRecord.portalAccess) return null;
  return { token, csrf: session.csrf, loginId: session.loginId || null, user: publicUser(userRecord) };
}

function canSeeCategory(user, category) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (category === 'Policies') return true;
  return category === user.team;
}

function canEditCategory(user, category) {
  return Boolean(user && user.role === 'admin');
}

function isAdmin(user) { return Boolean(user && user.role === 'admin'); }

function securityHeaders(res, isApi = false) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (isApi) res.setHeader('Cache-Control', 'no-store');
}

function sendJson(res, status, payload, extraHeaders = {}) {
  securityHeaders(res, true);
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders
  });
  res.end(body);
}

function sendError(res, status, message, code = 'ERROR') {
  sendJson(res, status, { error: message, code });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let rejected = false;
    req.on('data', chunk => {
      if (rejected) return;
      size += chunk.length;
      if (size > MAX_JSON_BYTES) {
        rejected = true;
        reject(Object.assign(new Error('Request body is too large.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected) return;
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(Object.assign(new Error('Invalid JSON body.'), { status: 400 }));
      }
    });
    req.on('error', error => { if (!rejected) reject(error); });
  });
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

async function requireAuth(req, res, { csrf = false, admin = false } = {}) {
  const auth = await getAuth(req);
  if (!auth) {
    sendError(res, 401, 'Your session has expired. Please sign in again.', 'UNAUTHENTICATED');
    return null;
  }
  if (admin && !isAdmin(auth.user)) {
    sendError(res, 403, 'You do not have permission to perform this action.', 'FORBIDDEN');
    return null;
  }
  if (csrf) {
    if (!sameOrigin(req)) {
      sendError(res, 403, 'Cross-site request blocked.', 'CSRF');
      return null;
    }
    const supplied = String(req.headers['x-csrf-token'] || '');
    const expected = String(auth.csrf || '');
    const suppliedBuffer = Buffer.from(supplied);
    const expectedBuffer = Buffer.from(expected);
    if (!supplied || suppliedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)) {
      sendError(res, 403, 'Security token is missing or invalid. Refresh and try again.', 'CSRF');
      return null;
    }
  }
  return auth;
}

function cleanText(value, max, required = false) {
  const text = String(value ?? '').trim();
  if (required && !text) throw Object.assign(new Error('A required field is missing.'), { status: 400 });
  if (text.length > max) throw Object.assign(new Error(`Text exceeds the ${max} character limit.`), { status: 400 });
  return text;
}

function validDate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')); }
function validUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function safeMimeForName(name) {
  const extension = path.extname(name).toLowerCase();
  return ({
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.txt': 'text/plain; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg'
  })[extension] || 'application/octet-stream';
}

function parseDataFile(file, required = true) {
  if (!file) {
    if (required) throw Object.assign(new Error('Please choose a document.'), { status: 400 });
    return null;
  }
  const rawName = String(file?.name || 'document').trim();
  const name = path.basename(cleanText(rawName, 180, true));
  const extension = path.extname(name).toLowerCase();
  if (!extension || !FILE_EXTENSIONS.has(extension)) {
    throw Object.assign(new Error('This file type is not allowed.'), { status: 400 });
  }
  const data = String(file?.data || '').trim();
  const commaIndex = data.indexOf(',');
  if (!data.startsWith('data:') || commaIndex === -1 || !data.slice(0, commaIndex).toLowerCase().includes(';base64')) {
    throw Object.assign(new Error('The uploaded document could not be read.'), { status: 400 });
  }
  const base64Str = data.slice(commaIndex + 1).replace(/[\s]/g, '');
  const buffer = Buffer.from(base64Str, 'base64');
  if (!buffer.length || buffer.length > MAX_FILE_BYTES) {
    throw Object.assign(new Error(`Documents must be ${Math.floor(MAX_FILE_BYTES / 1024 / 1024)} MB or smaller.`), { status: 400 });
  }
  return { name, type: safeMimeForName(name), buffer };
}

async function audit() { /* Existing system owns audit and login-history data. */ }

function serializeLink(row) {
  return {
    id: row.id,
    title: row.title,
    url: row.url,
    category: row.category,
    source: row.source,
    file: row.file_name ? { name: row.file_name, type: row.file_type || 'application/octet-stream', size: Number(row.file_size || 0) } : null,
    description: row.description,
    status: row.status,
    open_type: row.open_type,
    pinned: Boolean(row.pinned),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function serializeEvent(row) {
  return {
    id: row.id,
    title: row.title,
    date: row.date,
    time: row.time,
    type: row.type,
    location: row.location,
    notes: row.notes,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function serializeAnnouncement(row) {
  return {
    id: row.id,
    title: row.title,
    date: row.date,
    time: row.time,
    body: row.body,
    kind: row.kind,
    link: row.link,
    file: row.file_name ? { name: row.file_name, type: row.file_type || 'application/octet-stream', size: Number(row.file_size || 0) } : null,
    author: row.author,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

async function listVisibleLinks(user) {
  const rows = await db.all(`SELECT id,title,url,category,source,file_name,file_type,file_size,description,status,open_type,pinned,created_at,updated_at
    FROM links ORDER BY pinned DESC,created_at DESC`);
  return rows
    .filter(row => canSeeCategory(user, row.category) && (canEditCategory(user, row.category) || row.status === 'active'))
    .map(serializeLink);
}

function serializeFeedback(row) {
  return {
    id: row.id,
    strengths: decryptText(row.strengths),
    improvements: decryptText(row.improvements),
    suggestions: decryptText(row.suggestions),
    is_read: Number(row.is_read || 0),
    created_at: row.created_at
  };
}

function isExecutiveManager(user) {
  if (!user) return false;
  const name = String(user.name || '').toLowerCase();
  const username = String(user.username || '').toLowerCase();
  return (
    name.includes('suresh') ||
    name.includes('radhakrishnan') ||
    name.includes('manoj') ||
    name.includes('kombissan') ||
    username.includes('suresh') ||
    username.includes('manoj')
  );
}

function canNominateOthers(user) {
  return Boolean(user && (isAdmin(user) || isExecutiveManager(user)));
}

function canViewAllApplications(user) {
  return Boolean(user && (isAdmin(user) || isExecutiveManager(user)));
}

function safeJsonParse(str, fallback = null) {
  if (!str) return fallback;
  try {
    return typeof str === 'object' ? str : JSON.parse(str);
  } catch {
    return fallback;
  }
}

function serializeEoqWindow(row) {
  return {
    id: row.id,
    year: Number(row.year),
    quarter: row.quarter,
    status: row.status,
    start_time: row.start_time || '',
    end_time: row.end_time || '',
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function serializeEoqNomination(row) {
  return {
    id: row.id,
    year: Number(row.year),
    quarter: row.quarter,
    role: row.role,
    nominated_employee_id: Number(row.nominated_employee_id),
    nominated_employee_name: row.nominated_employee_name,
    submitted_by_id: Number(row.submitted_by_id),
    submitted_by_name: row.submitted_by_name,
    file: row.file_name ? { name: row.file_name, type: row.file_type || 'application/octet-stream', size: Number(row.file_size || 0) } : null,
    created_at: row.created_at
  };
}

function serializeEoqApplication(row) {
  if (!row) return null;
  const evidenceList = safeJsonParse(row.evidence_json, []);
  if (row.file_name && !evidenceList.some(e => e.file_name === row.file_name)) {
    evidenceList.unshift({
      id: row.id,
      file_name: row.file_name,
      file_type: row.file_type || 'application/octet-stream',
      file_size: Number(row.file_size || 0),
      file_storage_key: row.file_storage_key || '',
      description: 'Main Nomination Document',
      created_at: row.created_at
    });
  }
  return {
    id: row.id,
    app_code: row.app_code || `EOQ-${row.year}-${row.quarter}-001`,
    year: Number(row.year),
    quarter: row.quarter,
    nomination_type: row.role === 'Manager' ? 'Manager' : 'Self',
    role: row.role || 'Employee',
    nominee: {
      id: Number(row.nominated_employee_id || 0),
      name: row.nominated_employee_name || '',
      employee_code: `EMP-${String(row.nominated_employee_id || 0).padStart(4, '0')}`,
      department: '',
      designation: ''
    },
    submitted_by: {
      id: Number(row.submitted_by_id || 0),
      name: row.submitted_by_name || ''
    },
    before_after: safeJsonParse(row.before_after_json, []),
    achievement_details: row.achievement_details || '',
    benefits: safeJsonParse(row.benefits_json, { items: [], other_text: '' }),
    skills_values: safeJsonParse(row.skills_values_json, { items: [], other_text: '' }),
    status: row.status || 'Submitted',
    submitted_at: row.submitted_at || row.created_at || '',
    reopen_reason: row.reopen_reason || '',
    manager_comments: row.manager_comments || '',
    reviewed_by: row.reviewed_by_name ? { id: Number(row.reviewed_by_id || 0), name: row.reviewed_by_name, at: row.reviewed_at } : null,
    evidence: evidenceList.map(e => ({
      id: e.id,
      file_name: e.file_name,
      file_type: e.file_type || 'application/octet-stream',
      file_size: Number(e.file_size || 0),
      description: e.description || '',
      created_at: e.created_at
    })),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

async function generateNextEoqAppCode(db, year, quarter) {
  const prefix = `EOQ-${year}-${quarter}-`;
  const row = await db.get(
    `SELECT app_code FROM eoq_nominations WHERE year=? AND quarter=? AND app_code LIKE ? ORDER BY app_code DESC LIMIT 1`,
    [year, quarter, `${prefix}%`]
  );
  let nextSeq = 1;
  if (row?.app_code) {
    const parts = row.app_code.split('-');
    const lastNum = parseInt(parts[parts.length - 1], 10);
    if (!isNaN(lastNum)) nextSeq = lastNum + 1;
  }
  return `${prefix}${String(nextSeq).padStart(3, '0')}`;
}

async function getEmployeesList(db) {
  const tUsers = authProvider.schema.usersTable;
  const tEmployees = authProvider.schema.employeesTable;
  const tTeams = authProvider.schema.teamsTable;

  const rows = await db.all(
    `SELECT 
       u.user_id AS id,
       u.username,
       e.first_name,
       e.last_name,
       e.designation,
       COALESCE(t.team_name, e.designation) AS department
     FROM ${tUsers} u
     LEFT JOIN ${tEmployees} e ON e.employee_id=u.employee_id
     LEFT JOIN ${tTeams} t ON t.team_id=e.team_id
     WHERE u.is_active=1 AND (e.status IS NULL OR UPPER(e.status)='ACTIVE')
     ORDER BY e.first_name ASC, u.username ASC`
  );
  return (rows || []).map(r => ({
    id: Number(r.id),
    name: [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || r.username,
    employee_code: `EMP-${String(r.id).padStart(4, '0')}`,
    department: r.department || 'General',
    designation: r.designation || 'Team Member'
  }));
}

async function getEmployeeProfile(db, userId) {
  const tUsers = authProvider.schema.usersTable;
  const tEmployees = authProvider.schema.employeesTable;
  const tTeams = authProvider.schema.teamsTable;

  const row = await db.get(
    `SELECT 
       u.user_id AS id,
       u.username,
       e.first_name,
       e.last_name,
       e.designation,
       COALESCE(t.team_name, e.designation) AS department,
       e.email
     FROM ${tUsers} u
     LEFT JOIN ${tEmployees} e ON e.employee_id=u.employee_id
     LEFT JOIN ${tTeams} t ON t.team_id=e.team_id
     WHERE u.user_id=?`,
    [userId]
  );
  if (!row) return null;
  const name = [row.first_name, row.last_name].filter(Boolean).join(' ').trim() || row.username;
  return {
    id: Number(row.id),
    name: name,
    employee_code: `EMP-${String(row.id).padStart(4, '0')}`,
    department: row.department || 'General',
    designation: row.designation || 'Team Member',
    doj: ''
  };
}

async function generateNextEoqAppCode(db, year, quarter) {
  const prefix = `EOQ-${year}-${quarter}-`;
  const row = await db.get(
    `SELECT app_code FROM eoq_nominations WHERE year=? AND quarter=? AND app_code LIKE ? ORDER BY created_at DESC, app_code DESC LIMIT 1`,
    [year, quarter, `${prefix}%`]
  );
  let seq = 1;
  if (row && row.app_code) {
    const match = row.app_code.match(/-(\d+)$/);
    if (match) {
      seq = parseInt(match[1], 10) + 1;
    }
  }
  return `${prefix}${String(seq).padStart(3, '0')}`;
}

async function bootstrapPayload(auth) {
  const [links, eventRows, announcementRows, feedbackRows] = await Promise.all([
    listVisibleLinks(auth.user),
    db.all(`SELECT id,title,date,time,type,location,notes,created_at,updated_at
      FROM events ORDER BY date ASC,time ASC,created_at ASC`),
    db.all(`SELECT id,title,date,time,body,kind,link,file_name,file_type,file_size,author,created_at,updated_at
      FROM announcements ORDER BY date DESC,time DESC,created_at DESC`),
    db.all(`SELECT id,strengths,improvements,suggestions,is_read,created_at
      FROM annonymous_message WHERE to_user_id=? ORDER BY created_at DESC`, [auth.user.id])
  ]);
  return {
    user: auth.user,
    csrfToken: auth.csrf,
    links,
    events: eventRows.map(serializeEvent),
    announcements: announcementRows.map(serializeAnnouncement),
    feedback: (feedbackRows || []).map(serializeFeedback),
    categories: CATEGORIES,
    serverTime: nowIso()
  };
}

function loginCookie(token) {
  const attributes = [
    `mc_session=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_MS / 1000)}`
  ];
  if (NODE_ENV === 'production') attributes.push('Secure');
  return attributes.join('; ');
}

function clearCookie() {
  const attributes = ['mc_session=', 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (NODE_ENV === 'production') attributes.push('Secure');
  return attributes.join('; ');
}

async function removeStoredFileQuietly(storageKey) {
  if (!storageKey) return;
  try { await fileStore.remove(storageKey); } catch (error) { console.warn('Unable to remove stored file:', error.message); }
}

async function sendStoredFile(res, row) {
  if (!row?.file_storage_key) return sendError(res, 404, 'Document not found.', 'NOT_FOUND');
  let stat;
  try {
    stat = await fileStore.stat(row.file_storage_key);
  } catch (error) {
    if (error.code === 'ENOENT') return sendError(res, 404, 'Document not found.', 'NOT_FOUND');
    throw error;
  }
  if (!stat.isFile()) return sendError(res, 404, 'Document not found.', 'NOT_FOUND');

  securityHeaders(res, false);
  const safeName = String(row.file_name || 'document').replace(/["\r\n]/g, '_');
  res.writeHead(200, {
    'Content-Type': row.file_type || 'application/octet-stream',
    'Content-Length': stat.size,
    'Content-Disposition': `inline; filename="${safeName}"`,
    'Cache-Control': 'private, no-store'
  });
  const stream = fileStore.createReadStream(row.file_storage_key);
  stream.on('error', error => {
    console.error('File stream error:', error);
    if (!res.headersSent) sendError(res, 500, 'Unable to open the document.', 'FILE_ERROR');
    else res.destroy(error);
  });
  stream.pipe(res);
}

async function handleApi(req, res, url) {
  const method = req.method || 'GET';
  const pathname = url.pathname;

  if (method === 'GET' && pathname === '/api/health') {
    await db.get('SELECT 1 AS ok');
    return sendJson(res, 200, { ok: true, engine: 'MariaDB/MySQL', fileStorage: 'filesystem', time: nowIso() });
  }

  if (method === 'POST' && pathname === '/api/login') {
    if (!sameOrigin(req)) return sendError(res, 403, 'Cross-site request blocked.', 'CSRF');
    const body = await readJson(req);
    const username = cleanText(body.username, 180, true).toLowerCase();
    const password = String(body.password || '').trim();
    if (!password) return sendError(res, 400, 'Please enter both username and password.', 'VALIDATION');

    const ip = clientIp(req);
    const attemptKey = loginAttemptKey(ip, username);
    cleanupLoginAttempts();
    if (!loginAllowed(attemptKey)) return sendError(res, 429, 'Too many sign-in attempts. Try again later.', 'RATE_LIMITED');

    let row = null;
    try {
      row = await authProvider.findByLogin(username, { requireAccess: false });
    } catch (error) {
      if (!['CONFLICTING_PORTAL_ROLES', 'ROLE_TEAM_MISMATCH'].includes(error.code)) throw error;
    }
    const passwordMatches = row
      ? await authProvider.verifyPassword(password, row.passwordHash)
      : await authProvider.verifyPassword(password, dummyPasswordHash);
    const ok = Boolean(row && row.active && row.portalAccess && passwordMatches);

    if (!ok) {
      registerLoginFailure(attemptKey);
      await authProvider.recordLogin({
        userId: row?.id || null,
        status: 'FAILED',
        ipAddress: ip,
        deviceInfo: req.headers['user-agent'] || ''
      });

      let errorMsg = 'Invalid username, password, or account status.';
      if (!row) {
        errorMsg = `Username '${username}' was not found in the database.`;
      } else if (!passwordMatches) {
        errorMsg = `Incorrect password for '${username}'.`;
      } else if (!row.active) {
        errorMsg = `User account '${username}' is set to INACTIVE in the database.`;
      }

      return sendError(res, 401, errorMsg, 'INVALID_CREDENTIALS');
    }

    clearLoginFailures(attemptKey);
    await authProvider.updateLastLogin(row.id);
    const loginId = await authProvider.recordLogin({
      userId: row.id,
      status: 'SUCCESS',
      ipAddress: ip,
      deviceInfo: req.headers['user-agent'] || ''
    });
    const csrf = randomToken(24);
    const token = signSessionPayload({
      v: 1,
      userId: row.id,
      loginId,
      csrf,
      iat: Date.now(),
      exp: Date.now() + SESSION_MS
    });
    return sendJson(res, 200, { user: publicUser(row), csrfToken: csrf }, { 'Set-Cookie': loginCookie(token) });
  }

  if (method === 'POST' && pathname === '/api/logout') {
    const auth = await requireAuth(req, res, { csrf: true });
    if (!auth) return;
    await authProvider.recordLogout(auth.loginId, auth.user.id);
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearCookie() });
  }

  if (method === 'GET' && pathname === '/api/bootstrap') {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    return sendJson(res, 200, await bootstrapPayload(auth));
  }

  if (method === 'GET' && pathname === '/api/me') {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    return sendJson(res, 200, { user: auth.user, csrfToken: auth.csrf });
  }

  if (method === 'POST' && pathname === '/api/links') {
    const auth = await requireAuth(req, res, { csrf: true });
    if (!auth) return;
    const body = await readJson(req);
    const category = cleanText(body.category, 80, true);
    if (!CATEGORIES.includes(category) || !canEditCategory(auth.user, category)) {
      return sendError(res, 403, 'You cannot add links to this category.', 'FORBIDDEN');
    }
    const title = cleanText(body.title, 120, true);
    const source = body.source === 'file' ? 'file' : 'link';
    const description = cleanText(body.description, 300);
    const status = body.status === 'inactive' ? 'inactive' : 'active';
    const openType = body.open_type === 'same' ? 'same' : 'new';
    let urlValue = '';
    let file = null;
    let saved = null;

    if (source === 'link') {
      urlValue = cleanText(body.url, 2048, true);
      if (!validUrl(urlValue)) return sendError(res, 400, 'Please enter a valid http or https URL.', 'VALIDATION');
    } else {
      file = parseDataFile(body.file, true);
      saved = await fileStore.save('links', file.name, file.buffer);
    }

    const id = crypto.randomUUID();
    const stamp = nowIso();
    try {
      await db.run(`INSERT INTO links
        (id,title,url,category,source,file_name,file_type,file_size,file_storage_key,description,status,open_type,created_by,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
        id, title, urlValue, category, source,
        file?.name || null, file?.type || null, saved?.size || null, saved?.storageKey || null,
        description, status, openType, auth.user.id, stamp, stamp
      ]);
    } catch (error) {
      await removeStoredFileQuietly(saved?.storageKey);
      throw error;
    }
    await audit(auth.user, 'create', 'link', id, category);
    const row = await db.get(`SELECT id,title,url,category,source,file_name,file_type,file_size,description,status,open_type,pinned,created_at,updated_at
      FROM links WHERE id=?`, [id]);
    return sendJson(res, 201, { link: serializeLink(row) });
  }

  let match = pathname.match(/^\/api\/links\/([^/]+)$/);
  if (match && method === 'PUT') {
    const auth = await requireAuth(req, res, { csrf: true });
    if (!auth) return;
    const id = decodeURIComponent(match[1]);
    const existing = await db.get('SELECT * FROM links WHERE id=?', [id]);
    if (!existing) return sendError(res, 404, 'Link not found.', 'NOT_FOUND');
    const body = await readJson(req);
    const category = cleanText(body.category, 80, true);
    if (!CATEGORIES.includes(category) || !canEditCategory(auth.user, existing.category) || !canEditCategory(auth.user, category)) {
      return sendError(res, 403, 'You cannot edit this link.', 'FORBIDDEN');
    }
    const title = cleanText(body.title, 120, true);
    const description = cleanText(body.description, 300);
    const status = body.status === 'inactive' ? 'inactive' : 'active';
    const openType = body.open_type === 'same' ? 'same' : 'new';
    let urlValue = existing.url;
    let fileName = existing.file_name;
    let fileType = existing.file_type;
    let fileSize = existing.file_size;
    let storageKey = existing.file_storage_key;
    let replacement = null;

    if (existing.source === 'link') {
      urlValue = cleanText(body.url, 2048, true);
      if (!validUrl(urlValue)) return sendError(res, 400, 'Please enter a valid http or https URL.', 'VALIDATION');
    } else if (body.file) {
      const file = parseDataFile(body.file, true);
      replacement = await fileStore.save('links', file.name, file.buffer);
      fileName = file.name;
      fileType = file.type;
      fileSize = replacement.size;
      storageKey = replacement.storageKey;
    }

    const stamp = nowIso();
    try {
      await db.run(`UPDATE links SET title=?,url=?,category=?,file_name=?,file_type=?,file_size=?,file_storage_key=?,description=?,status=?,open_type=?,updated_at=?
        WHERE id=?`, [title, urlValue, category, fileName, fileType, fileSize, storageKey, description, status, openType, stamp, id]);
    } catch (error) {
      await removeStoredFileQuietly(replacement?.storageKey);
      throw error;
    }
    if (replacement && existing.file_storage_key !== replacement.storageKey) await removeStoredFileQuietly(existing.file_storage_key);
    await audit(auth.user, 'update', 'link', id, category);
    const row = await db.get(`SELECT id,title,url,category,source,file_name,file_type,file_size,description,status,open_type,pinned,created_at,updated_at
      FROM links WHERE id=?`, [id]);
    return sendJson(res, 200, { link: serializeLink(row) });
  }

  if (match && method === 'PATCH') {
    const auth = await requireAuth(req, res, { csrf: true });
    if (!auth) return;
    const id = decodeURIComponent(match[1]);
    const existing = await db.get('SELECT * FROM links WHERE id=?', [id]);
    if (!existing) return sendError(res, 404, 'Link not found.', 'NOT_FOUND');
    if (!canEditCategory(auth.user, existing.category)) return sendError(res, 403, 'You cannot change this link.', 'FORBIDDEN');
    const body = await readJson(req);
    const hasStatus = Object.prototype.hasOwnProperty.call(body, 'status');
    const hasPinned = Object.prototype.hasOwnProperty.call(body, 'pinned');
    if (!hasStatus && !hasPinned) return sendError(res, 400, 'No supported link change was provided.', 'VALIDATION');
    if (hasStatus && !['active', 'inactive'].includes(body.status)) return sendError(res, 400, 'Invalid status.', 'VALIDATION');
    if (hasPinned && typeof body.pinned !== 'boolean') return sendError(res, 400, 'Pinned must be true or false.', 'VALIDATION');
    const nextStatus = hasStatus ? body.status : existing.status;
    const nextPinned = hasPinned ? (body.pinned ? 1 : 0) : Number(existing.pinned || 0);
    const stamp = nowIso();
    await db.run('UPDATE links SET status=?,pinned=?,updated_at=? WHERE id=?', [nextStatus, nextPinned, stamp, id]);
    const action = hasPinned && !hasStatus ? (nextPinned ? 'pin' : 'unpin') : 'status';
    await audit(auth.user, action, 'link', id, hasPinned && !hasStatus ? String(Boolean(nextPinned)) : nextStatus);
    const row = await db.get(`SELECT id,title,url,category,source,file_name,file_type,file_size,description,status,open_type,pinned,created_at,updated_at
      FROM links WHERE id=?`, [id]);
    return sendJson(res, 200, { link: serializeLink(row) });
  }

  if (match && method === 'DELETE') {
    const auth = await requireAuth(req, res, { csrf: true });
    if (!auth) return;
    const id = decodeURIComponent(match[1]);
    const existing = await db.get('SELECT * FROM links WHERE id=?', [id]);
    if (!existing) return sendError(res, 404, 'Link not found.', 'NOT_FOUND');
    if (!canEditCategory(auth.user, existing.category)) return sendError(res, 403, 'You cannot delete this link.', 'FORBIDDEN');
    await db.run('DELETE FROM links WHERE id=?', [id]);
    await removeStoredFileQuietly(existing.file_storage_key);
    await audit(auth.user, 'delete', 'link', id, existing.category);
    return sendJson(res, 200, { ok: true });
  }

  match = pathname.match(/^\/api\/links\/([^/]+)\/file$/);
  if (match && method === 'GET') {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const id = decodeURIComponent(match[1]);
    const row = await db.get(`SELECT id,category,status,file_name,file_type,file_storage_key
      FROM links WHERE id=? AND source='file'`, [id]);
    if (!row) return sendError(res, 404, 'Document not found.', 'NOT_FOUND');
    if (!canSeeCategory(auth.user, row.category) || (!canEditCategory(auth.user, row.category) && row.status !== 'active')) {
      return sendError(res, 403, 'You cannot access this document.', 'FORBIDDEN');
    }
    return sendStoredFile(res, row);
  }

  if (method === 'POST' && pathname === '/api/events') {
    const auth = await requireAuth(req, res, { csrf: true, admin: true });
    if (!auth) return;
    const body = await readJson(req);
    const title = cleanText(body.title, 120, true);
    const date = cleanText(body.date, 10, true);
    if (!validDate(date)) return sendError(res, 400, 'Please choose a valid event date.', 'VALIDATION');
    const type = EVENT_TYPES.includes(body.type) ? body.type : 'Meeting';
    const id = crypto.randomUUID();
    const stamp = nowIso();
    await db.run(`INSERT INTO events(id,title,date,time,type,location,notes,created_by,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, [id, title, date, cleanText(body.time, 80), type, cleanText(body.location, 240), cleanText(body.notes, 300), auth.user.id, stamp, stamp]);
    await audit(auth.user, 'create', 'event', id, date);
    return sendJson(res, 201, { event: serializeEvent(await db.get('SELECT * FROM events WHERE id=?', [id])) });
  }

  match = pathname.match(/^\/api\/events\/([^/]+)$/);
  if (match && method === 'PUT') {
    const auth = await requireAuth(req, res, { csrf: true, admin: true });
    if (!auth) return;
    const id = decodeURIComponent(match[1]);
    if (!await db.get('SELECT 1 AS found FROM events WHERE id=?', [id])) return sendError(res, 404, 'Event not found.', 'NOT_FOUND');
    const body = await readJson(req);
    const title = cleanText(body.title, 120, true);
    const date = cleanText(body.date, 10, true);
    if (!validDate(date)) return sendError(res, 400, 'Please choose a valid event date.', 'VALIDATION');
    const type = EVENT_TYPES.includes(body.type) ? body.type : 'Meeting';
    const stamp = nowIso();
    await db.run('UPDATE events SET title=?,date=?,time=?,type=?,location=?,notes=?,updated_at=? WHERE id=?', [
      title, date, cleanText(body.time, 80), type, cleanText(body.location, 240), cleanText(body.notes, 300), stamp, id
    ]);
    await audit(auth.user, 'update', 'event', id, date);
    return sendJson(res, 200, { event: serializeEvent(await db.get('SELECT * FROM events WHERE id=?', [id])) });
  }

  if (match && method === 'DELETE') {
    const auth = await requireAuth(req, res, { csrf: true, admin: true });
    if (!auth) return;
    const id = decodeURIComponent(match[1]);
    if (!await db.get('SELECT 1 AS found FROM events WHERE id=?', [id])) return sendError(res, 404, 'Event not found.', 'NOT_FOUND');
    await db.run('DELETE FROM events WHERE id=?', [id]);
    await audit(auth.user, 'delete', 'event', id);
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'POST' && pathname === '/api/announcements') {
    const auth = await requireAuth(req, res, { csrf: true, admin: true });
    if (!auth) return;
    const body = await readJson(req);
    const title = cleanText(body.title, 140, true);
    const date = cleanText(body.date, 10, true);
    if (!validDate(date)) return sendError(res, 400, 'Please choose a valid announcement date.', 'VALIDATION');
    const kind = ['none', 'link', 'file'].includes(body.kind) ? body.kind : 'none';
    const message = cleanText(body.body, 600);
    let link = '';
    let file = null;
    let saved = null;
    if (kind === 'none' && !message) return sendError(res, 400, 'Add a message, link, or document.', 'VALIDATION');
    if (kind === 'link') {
      link = cleanText(body.link, 2048, true);
      if (!validUrl(link)) return sendError(res, 400, 'Please enter a valid URL.', 'VALIDATION');
    }
    if (kind === 'file') {
      file = parseDataFile(body.file, true);
      saved = await fileStore.save('announcements', file.name, file.buffer);
    }
    const id = crypto.randomUUID();
    const stamp = nowIso();
    try {
      await db.run(`INSERT INTO announcements
        (id,title,date,time,body,kind,link,file_name,file_type,file_size,file_storage_key,author,created_by,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
        id, title, date, cleanText(body.time, 10), message, kind, link,
        file?.name || null, file?.type || null, saved?.size || null, saved?.storageKey || null,
        auth.user.name, auth.user.id, stamp, stamp
      ]);
    } catch (error) {
      await removeStoredFileQuietly(saved?.storageKey);
      throw error;
    }
    await audit(auth.user, 'create', 'announcement', id, date);
    const row = await db.get(`SELECT id,title,date,time,body,kind,link,file_name,file_type,file_size,author,created_at,updated_at
      FROM announcements WHERE id=?`, [id]);
    return sendJson(res, 201, { announcement: serializeAnnouncement(row) });
  }

  match = pathname.match(/^\/api\/announcements\/([^/]+)$/);
  if (match && method === 'PUT') {
    const auth = await requireAuth(req, res, { csrf: true, admin: true });
    if (!auth) return;
    const id = decodeURIComponent(match[1]);
    const existing = await db.get('SELECT * FROM announcements WHERE id=?', [id]);
    if (!existing) return sendError(res, 404, 'Announcement not found.', 'NOT_FOUND');
    const body = await readJson(req);
    const title = cleanText(body.title, 140, true);
    const date = cleanText(body.date, 10, true);
    if (!validDate(date)) return sendError(res, 400, 'Please choose a valid announcement date.', 'VALIDATION');
    const kind = ['none', 'link', 'file'].includes(body.kind) ? body.kind : 'none';
    const message = cleanText(body.body, 600);
    let link = '';
    let fileName = null;
    let fileType = null;
    let fileSize = null;
    let storageKey = null;
    let replacement = null;
    if (kind === 'none' && !message) return sendError(res, 400, 'Add a message, link, or document.', 'VALIDATION');
    if (kind === 'link') {
      link = cleanText(body.link, 2048, true);
      if (!validUrl(link)) return sendError(res, 400, 'Please enter a valid URL.', 'VALIDATION');
    }
    if (kind === 'file') {
      if (body.file) {
        const file = parseDataFile(body.file, true);
        replacement = await fileStore.save('announcements', file.name, file.buffer);
        fileName = file.name;
        fileType = file.type;
        fileSize = replacement.size;
        storageKey = replacement.storageKey;
      } else if (existing.kind === 'file' && existing.file_storage_key) {
        fileName = existing.file_name;
        fileType = existing.file_type;
        fileSize = existing.file_size;
        storageKey = existing.file_storage_key;
      } else {
        return sendError(res, 400, 'Please choose a document.', 'VALIDATION');
      }
    }
    const stamp = nowIso();
    try {
      await db.run(`UPDATE announcements SET title=?,date=?,time=?,body=?,kind=?,link=?,file_name=?,file_type=?,file_size=?,file_storage_key=?,author=?,updated_at=?
        WHERE id=?`, [title, date, cleanText(body.time, 10), message, kind, link, fileName, fileType, fileSize, storageKey, auth.user.name, stamp, id]);
    } catch (error) {
      await removeStoredFileQuietly(replacement?.storageKey);
      throw error;
    }
    if (existing.file_storage_key && existing.file_storage_key !== storageKey) await removeStoredFileQuietly(existing.file_storage_key);
    await audit(auth.user, 'update', 'announcement', id, date);
    const row = await db.get(`SELECT id,title,date,time,body,kind,link,file_name,file_type,file_size,author,created_at,updated_at
      FROM announcements WHERE id=?`, [id]);
    return sendJson(res, 200, { announcement: serializeAnnouncement(row) });
  }

  if (match && method === 'DELETE') {
    const auth = await requireAuth(req, res, { csrf: true, admin: true });
    if (!auth) return;
    const id = decodeURIComponent(match[1]);
    const existing = await db.get('SELECT * FROM announcements WHERE id=?', [id]);
    if (!existing) return sendError(res, 404, 'Announcement not found.', 'NOT_FOUND');
    await db.run('DELETE FROM announcements WHERE id=?', [id]);
    await removeStoredFileQuietly(existing.file_storage_key);
    await audit(auth.user, 'delete', 'announcement', id);
    return sendJson(res, 200, { ok: true });
  }

  match = pathname.match(/^\/api\/announcements\/([^/]+)\/file$/);
  if (match && method === 'GET') {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const id = decodeURIComponent(match[1]);
    const row = await db.get(`SELECT file_name,file_type,file_storage_key
      FROM announcements WHERE id=? AND kind='file'`, [id]);
    if (!row) return sendError(res, 404, 'Document not found.', 'NOT_FOUND');
    return sendStoredFile(res, row);
  }

  /* ============ ANONYMOUS GROWTH CORNER ============ */

  if (method === 'GET' && pathname === '/api/feedback') {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const rows = await db.all(`SELECT id,strengths,improvements,suggestions,is_read,created_at
      FROM annonymous_message WHERE to_user_id=? ORDER BY created_at DESC`, [auth.user.id]);
    return sendJson(res, 200, { feedback: (rows || []).map(serializeFeedback) });
  }

  if (method === 'POST' && pathname === '/api/feedback') {
    const auth = await requireAuth(req, res, { csrf: true });
    if (!auth) return;
    const body = await readJson(req);
    const toUserId = Number(body.to_user_id);
    if (!Number.isInteger(toUserId) || toUserId < 1) {
      return sendError(res, 400, 'Please select an employee to send feedback to.', 'VALIDATION');
    }
    const strengths = cleanText(body.strengths, 5000, true);
    const improvements = cleanText(body.improvements, 5000, true);
    const suggestions = cleanText(body.suggestions, 5000, true);
    const id = crypto.randomUUID();
    const stamp = nowIso();
    const encStrengths = encryptText(strengths);
    const encImprovements = encryptText(improvements);
    const encSuggestions = encryptText(suggestions);
    await db.run(`INSERT INTO annonymous_message (id,to_user_id,strengths,improvements,suggestions,is_read,created_at)
      VALUES (?,?,?,?,?,0,?)`, [id, toUserId, encStrengths, encImprovements, encSuggestions, stamp]);
    return sendJson(res, 201, { ok: true });
  }

  if (method === 'GET' && pathname === '/api/employees/active') {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const t = authProvider.schema;
    const rows = await db.all(`SELECT u.user_id AS id, u.username,
        e.first_name, e.last_name, e.designation AS title
      FROM ${t.usersTable} u
      LEFT JOIN ${t.employeesTable} e ON e.employee_id=u.employee_id
      WHERE u.is_active=1 AND (e.status IS NULL OR UPPER(e.status)='ACTIVE')
      ORDER BY e.first_name ASC, e.last_name ASC, u.username ASC`);
    const list = rows.map(r => ({
      id: Number(r.id),
      name: [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || r.username,
      title: r.title || ''
    })).filter(r => r.id !== auth.user.id);
    return sendJson(res, 200, { employees: list });
  }

  match = pathname.match(/^\/api\/feedback\/([^/]+)\/read$/);
  if (match && (method === 'PATCH' || method === 'POST')) {
    const auth = await requireAuth(req, res, { csrf: true });
    if (!auth) return;
    const id = decodeURIComponent(match[1]);
    await db.run(`UPDATE annonymous_message SET is_read=1 WHERE id=? AND to_user_id=?`, [id, auth.user.id]);
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'PATCH' && pathname === '/api/feedback/read') {
    const auth = await requireAuth(req, res, { csrf: true });
    if (!auth) return;
    await db.run(`UPDATE annonymous_message SET is_read=1 WHERE to_user_id=? AND is_read=0`, [auth.user.id]);
    return sendJson(res, 200, { ok: true });
  }

  /* ============ EMPLOYEE OF THE QUARTER (DIGITAL APPLICATION SYSTEM) ============ */

  /* ============ EMPLOYEE OF THE QUARTER (DIGITAL APPLICATION SYSTEM) ============ */

  if (method === 'GET' && pathname === '/api/eoq') {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const yearParam = Number(url.searchParams.get('year') || 2026);
    const selectedYear = (yearParam >= 2026 && yearParam <= 2100) ? yearParam : 2026;

    const windowRows = await db.all(
      `SELECT id,year,quarter,status,start_time,end_time,created_at,updated_at FROM eoq_windows WHERE year=? ORDER BY quarter ASC`,
      [selectedYear]
    );

    const userCanNominate = canNominateOthers(auth.user);
    const userCanViewAll = canViewAllApplications(auth.user);

    let appRows = [];
    if (userCanViewAll) {
      appRows = await db.all(
        `SELECT * FROM eoq_nominations WHERE year=? ORDER BY created_at DESC`,
        [selectedYear]
      );
    } else {
      appRows = await db.all(
        `SELECT * FROM eoq_nominations WHERE year=? AND (submitted_by_id=? OR nominated_employee_id=?) ORDER BY created_at DESC`,
        [selectedYear, auth.user.id, auth.user.id]
      );
    }

    const applications = appRows.map(r => serializeEoqApplication(r));
    const userProfile = await getEmployeeProfile(db, auth.user.id);
    const employees = userCanNominate ? await getEmployeesList(db) : [];

    return sendJson(res, 200, {
      year: selectedYear,
      windows: (windowRows || []).map(serializeEoqWindow),
      applications: applications,
      userCanNominateOthers: userCanNominate,
      userCanViewAll: userCanViewAll,
      userProfile: userProfile,
      employees: employees
    });
  }

  if (method === 'GET' && pathname === '/api/eoq/employees') {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    if (!canNominateOthers(auth.user)) {
      return sendError(res, 403, 'Normal employees can only nominate themselves.', 'FORBIDDEN');
    }
    const employees = await getEmployeesList(db);
    return sendJson(res, 200, { employees });
  }

  if (method === 'POST' && pathname === '/api/eoq/window') {
    const auth = await requireAuth(req, res, { csrf: true, admin: true });
    if (!auth) return;
    const body = await readJson(req);
    const year = Number(body.year);
    if (!year || year < 2026 || year > 2100) return sendError(res, 400, 'Invalid year selected.', 'VALIDATION');
    const quarter = cleanText(body.quarter, 10, true);
    if (!['Q1', 'Q2', 'Q3', 'Q4'].includes(quarter)) return sendError(res, 400, 'Invalid quarter selected.', 'VALIDATION');
    const status = ['upcoming', 'open', 'closed'].includes(body.status) ? body.status : 'upcoming';
    const startTime = cleanText(body.start_time, 35);
    const endTime = cleanText(body.end_time, 35);
    const stamp = nowIso();

    const existing = await db.get(`SELECT id FROM eoq_windows WHERE year=? AND quarter=?`, [year, quarter]);
    let windowId = existing?.id;
    if (existing) {
      await db.run(`UPDATE eoq_windows SET status=?, start_time=?, end_time=?, updated_at=? WHERE id=?`, [status, startTime, endTime, stamp, windowId]);
    } else {
      windowId = crypto.randomUUID();
      await db.run(`INSERT INTO eoq_windows (id, year, quarter, status, start_time, end_time, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
        [windowId, year, quarter, status, startTime, endTime, stamp, stamp]);
    }

    const row = await db.get(`SELECT id,year,quarter,status,start_time,end_time,created_at,updated_at FROM eoq_windows WHERE id=?`, [windowId]);
    return sendJson(res, 200, { window: serializeEoqWindow(row) });
  }

  match = pathname.match(/^\/api\/eoq\/applications\/([^/]+)$/);
  if (match && method === 'GET') {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const appId = decodeURIComponent(match[1]);
    const appRow = await db.get(`SELECT * FROM eoq_nominations WHERE id=?`, [appId]);
    if (!appRow) return sendError(res, 404, 'Application not found.', 'NOT_FOUND');

    if (!canViewAllApplications(auth.user) &&
        Number(appRow.submitted_by_id) !== Number(auth.user.id) &&
        Number(appRow.nominated_employee_id) !== Number(auth.user.id)) {
      return sendError(res, 403, 'You do not have permission to view this application.', 'FORBIDDEN');
    }

    return sendJson(res, 200, { application: serializeEoqApplication(appRow) });
  }

  if (method === 'POST' && (pathname === '/api/eoq/applications' || pathname === '/api/eoq/nominations')) {
    const auth = await requireAuth(req, res, { csrf: true });
    if (!auth) return;
    const body = await readJson(req);

    const year = Number(body.year);
    if (!year || year < 2026 || year > 2100) return sendError(res, 400, 'Invalid year.', 'VALIDATION');
    const quarter = cleanText(body.quarter, 10, true);
    if (!['Q1', 'Q2', 'Q3', 'Q4'].includes(quarter)) return sendError(res, 400, 'Invalid quarter.', 'VALIDATION');

    const nominationType = (body.nomination_type === 'Manager' || body.role === 'Manager') ? 'Manager' : 'Employee';

    if (nominationType === 'Manager' && !canNominateOthers(auth.user)) {
      return sendError(res, 403, 'Normal employees are only permitted to nominate themselves.', 'FORBIDDEN');
    }

    let nomineeProfile = null;
    if (nominationType === 'Employee') {
      nomineeProfile = await getEmployeeProfile(db, auth.user.id);
    } else {
      const nomineeId = Number(body.nominee_id || body.nominated_employee_id);
      if (!nomineeId) return sendError(res, 400, 'Please select an employee to nominate.', 'VALIDATION');
      nomineeProfile = await getEmployeeProfile(db, nomineeId);
      if (!nomineeProfile) return sendError(res, 400, 'Selected nominee profile not found.', 'VALIDATION');
    }

    const submitterProfile = await getEmployeeProfile(db, auth.user.id);
    const isSubmit = body.action === 'submit';

    if (isSubmit && !isAdmin(auth.user)) {
      const windowRow = await db.get(`SELECT status FROM eoq_windows WHERE year=? AND quarter=?`, [year, quarter]);
      if (!windowRow || windowRow.status !== 'open') {
        return sendError(res, 400, 'Nomination window for this quarter is currently closed.', 'CLOSED');
      }
    }

    if (isSubmit) {
      const existing = await db.get(
        `SELECT id FROM eoq_nominations WHERE year=? AND quarter=? AND nominated_employee_id=? AND status NOT IN ('Draft', 'Reopened for Editing')`,
        [year, quarter, nomineeProfile.id]
      );
      if (existing) {
        return sendError(res, 400, `A submitted nomination already exists for ${nomineeProfile.name} in ${quarter} ${year}.`, 'DUPLICATE');
      }
    }

    const appId = crypto.randomUUID();
    const stamp = nowIso();
    const status = isSubmit ? 'Submitted' : 'Draft';
    const appCode = isSubmit ? await generateNextEoqAppCode(db, year, quarter) : `DRAFT-${appId.slice(0, 8)}`;

    const beforeAfterJson = JSON.stringify(Array.isArray(body.before_after) ? body.before_after : []);
    const achievementDetails = cleanText(body.achievement_details, 10000);
    const benefitsJson = JSON.stringify(body.benefits || { items: [], other_text: '' });
    const skillsValuesJson = JSON.stringify(body.skills_values || { items: [], other_text: '' });

    let fileName = null, fileType = null, fileSize = null, fileStorageKey = null;
    let evidenceJson = '[]';

    if (body.file) {
      const mainFile = parseDataFile(body.file, true);
      const saved = await fileStore.save('eoq', mainFile.name, mainFile.buffer);
      fileName = mainFile.name;
      fileType = mainFile.type;
      fileSize = saved.size;
      fileStorageKey = saved.storageKey;
      evidenceJson = JSON.stringify([{
        id: crypto.randomUUID(),
        file_name: mainFile.name,
        file_type: mainFile.type,
        file_size: saved.size,
        file_storage_key: saved.storageKey,
        description: 'Uploaded Nomination Document',
        created_at: stamp
      }]);
    }

    await db.run(
      `INSERT INTO eoq_nominations
        (id, app_code, year, quarter, role, nominated_employee_id, nominated_employee_name, submitted_by_id, submitted_by_name, file_name, file_type, file_size, file_storage_key, before_after_json, achievement_details, benefits_json, skills_values_json, evidence_json, status, submitted_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        appId, appCode, year, quarter, nominationType, nomineeProfile.id, nomineeProfile.name,
        submitterProfile.id, submitterProfile.name,
        fileName, fileType, fileSize, fileStorageKey,
        beforeAfterJson, achievementDetails, benefitsJson, skillsValuesJson, evidenceJson,
        status, isSubmit ? stamp : '', stamp, stamp
      ]
    );

    const row = await db.get(`SELECT * FROM eoq_nominations WHERE id=?`, [appId]);
    return sendJson(res, 201, { application: serializeEoqApplication(row), nomination: serializeEoqNomination(row) });
  }

  match = pathname.match(/^\/api\/eoq\/applications\/([^/]+)$/);
  if (match && method === 'PUT') {
    const auth = await requireAuth(req, res, { csrf: true });
    if (!auth) return;
    const appId = decodeURIComponent(match[1]);
    const appRow = await db.get(`SELECT * FROM eoq_nominations WHERE id=?`, [appId]);
    if (!appRow) return sendError(res, 404, 'Application not found.', 'NOT_FOUND');

    if (!isAdmin(auth.user) && Number(appRow.submitted_by_id) !== Number(auth.user.id)) {
      return sendError(res, 403, 'You do not have permission to edit this application.', 'FORBIDDEN');
    }

    if (!isAdmin(auth.user)) {
      const windowRow = await db.get(`SELECT status FROM eoq_windows WHERE year=? AND quarter=?`, [appRow.year, appRow.quarter]);
      if (!windowRow || windowRow.status !== 'open') {
        return sendError(res, 400, 'Nomination window for this quarter is currently closed.', 'CLOSED');
      }
    }

    const body = await readJson(req);
    const beforeAfterJson = JSON.stringify(Array.isArray(body.before_after) ? body.before_after : []);
    const achievementDetails = cleanText(body.achievement_details, 10000);
    const benefitsJson = JSON.stringify(body.benefits || { items: [], other_text: '' });
    const skillsValuesJson = JSON.stringify(body.skills_values || { items: [], other_text: '' });
    const stamp = nowIso();

    await db.run(
      `UPDATE eoq_nominations 
       SET before_after_json=?, achievement_details=?, benefits_json=?, skills_values_json=?, updated_at=?
       WHERE id=?`,
      [beforeAfterJson, achievementDetails, benefitsJson, skillsValuesJson, stamp, appId]
    );

    const updatedRow = await db.get(`SELECT * FROM eoq_nominations WHERE id=?`, [appId]);
    return sendJson(res, 200, { application: serializeEoqApplication(updatedRow) });
  }

  match = pathname.match(/^\/api\/eoq\/applications\/([^/]+)$/);
  if (match && method === 'DELETE') {
    const auth = await requireAuth(req, res, { csrf: true });
    if (!auth) return;
    const appId = decodeURIComponent(match[1]);
    const appRow = await db.get(`SELECT * FROM eoq_nominations WHERE id=?`, [appId]);
    if (!appRow) return sendError(res, 404, 'Application not found.', 'NOT_FOUND');

    if (!isAdmin(auth.user) && Number(appRow.submitted_by_id) !== Number(auth.user.id)) {
      return sendError(res, 403, 'You do not have permission to delete this application.', 'FORBIDDEN');
    }

    if (!isAdmin(auth.user)) {
      const windowRow = await db.get(`SELECT status FROM eoq_windows WHERE year=? AND quarter=?`, [appRow.year, appRow.quarter]);
      if (!windowRow || windowRow.status !== 'open') {
        return sendError(res, 400, 'Nomination window for this quarter is currently closed.', 'CLOSED');
      }
    }

    if (appRow.file_storage_key) {
      await removeStoredFileQuietly(appRow.file_storage_key);
    }
    const evidenceList = safeJsonParse(appRow.evidence_json, []);
    for (const ev of evidenceList) {
      if (ev.file_storage_key) await removeStoredFileQuietly(ev.file_storage_key);
    }
    await db.run(`DELETE FROM eoq_nominations WHERE id=?`, [appId]);

    return sendJson(res, 200, { ok: true });
  }

  match = pathname.match(/^\/api\/eoq\/applications\/([^/]+)\/evidence$/);
  if (match && method === 'POST') {
    const auth = await requireAuth(req, res, { csrf: true });
    if (!auth) return;
    const appId = decodeURIComponent(match[1]);
    const appRow = await db.get(`SELECT * FROM eoq_nominations WHERE id=?`, [appId]);
    if (!appRow) return sendError(res, 404, 'Application not found.', 'NOT_FOUND');

    if (!isAdmin(auth.user) && Number(appRow.submitted_by_id) !== Number(auth.user.id)) {
      return sendError(res, 403, 'You do not have permission to add evidence to this application.', 'FORBIDDEN');
    }

    if (!isAdmin(auth.user)) {
      const windowRow = await db.get(`SELECT status FROM eoq_windows WHERE year=? AND quarter=?`, [appRow.year, appRow.quarter]);
      if (!windowRow || windowRow.status !== 'open') {
        return sendError(res, 400, 'Nomination window for this quarter is currently closed.', 'CLOSED');
      }
    }

    const body = await readJson(req);
    const file = parseDataFile(body.file, true);
    const description = cleanText(body.description, 300);
    const saved = await fileStore.save('eoq', file.name, file.buffer);

    const evId = crypto.randomUUID();
    const stamp = nowIso();

    const evidenceList = safeJsonParse(appRow.evidence_json, []);
    evidenceList.push({
      id: evId,
      file_name: file.name,
      file_type: file.type,
      file_size: saved.size,
      file_storage_key: saved.storageKey,
      description: description,
      created_at: stamp
    });

    await db.run(`UPDATE eoq_nominations SET evidence_json=?, updated_at=? WHERE id=?`, [JSON.stringify(evidenceList), stamp, appId]);

    return sendJson(res, 201, { evidence: evidenceList });
  }

  match = pathname.match(/^\/api\/eoq\/applications\/([^/]+)\/evidence\/([^/]+)$/);
  if (match && method === 'DELETE') {
    const auth = await requireAuth(req, res, { csrf: true });
    if (!auth) return;
    const appId = decodeURIComponent(match[1]);
    const evId = decodeURIComponent(match[2]);
    const appRow = await db.get(`SELECT * FROM eoq_nominations WHERE id=?`, [appId]);
    if (!appRow) return sendError(res, 404, 'Application not found.', 'NOT_FOUND');

    if (!isAdmin(auth.user) && Number(appRow.submitted_by_id) !== Number(auth.user.id)) {
      return sendError(res, 403, 'You do not have permission to modify evidence.', 'FORBIDDEN');
    }

    if (!isAdmin(auth.user)) {
      const windowRow = await db.get(`SELECT status FROM eoq_windows WHERE year=? AND quarter=?`, [appRow.year, appRow.quarter]);
      if (!windowRow || windowRow.status !== 'open') {
        return sendError(res, 400, 'Nomination window for this quarter is currently closed.', 'CLOSED');
      }
    }

    let evidenceList = safeJsonParse(appRow.evidence_json, []);
    const target = evidenceList.find(e => e.id === evId);
    if (target?.file_storage_key) {
      await removeStoredFileQuietly(target.file_storage_key);
    }
    evidenceList = evidenceList.filter(e => e.id !== evId);
    await db.run(`UPDATE eoq_nominations SET evidence_json=?, updated_at=? WHERE id=?`, [JSON.stringify(evidenceList), nowIso(), appId]);

    return sendJson(res, 200, { ok: true });
  }

  match = pathname.match(/^\/api\/eoq\/evidence\/([^/]+)\/file$/);
  if (match && method === 'GET') {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const targetId = decodeURIComponent(match[1]);
    
    let appRow = await db.get(`SELECT * FROM eoq_nominations WHERE id=?`, [targetId]);
    let targetEv = null;

    if (appRow && appRow.file_storage_key) {
      targetEv = { file_name: appRow.file_name, file_type: appRow.file_type, file_storage_key: appRow.file_storage_key };
    } else {
      const allRows = await db.all(`SELECT * FROM eoq_nominations WHERE evidence_json IS NOT NULL`);
      for (const r of allRows) {
        const list = safeJsonParse(r.evidence_json, []);
        const found = list.find(e => e.id === targetId);
        if (found) {
          appRow = r;
          targetEv = found;
          break;
        }
      }
    }

    if (!appRow || !targetEv) return sendError(res, 404, 'Evidence file not found.', 'NOT_FOUND');

    if (!canViewAllApplications(auth.user) &&
        Number(appRow.submitted_by_id) !== Number(auth.user.id) &&
        Number(appRow.nominated_employee_id) !== Number(auth.user.id)) {
      return sendError(res, 403, 'You do not have permission to view this evidence file.', 'FORBIDDEN');
    }

    return sendStoredFile(res, targetEv);
  }

  match = pathname.match(/^\/api\/eoq\/applications\/([^/]+)\/submit$/);
  if (match && method === 'POST') {
    const auth = await requireAuth(req, res, { csrf: true });
    if (!auth) return;
    const appId = decodeURIComponent(match[1]);
    const appRow = await db.get(`SELECT * FROM eoq_nominations WHERE id=?`, [appId]);
    if (!appRow) return sendError(res, 404, 'Application not found.', 'NOT_FOUND');

    if (!isAdmin(auth.user) && Number(appRow.submitted_by_id) !== Number(auth.user.id)) {
      return sendError(res, 403, 'You do not have permission to submit this application.', 'FORBIDDEN');
    }

    if (!['Draft', 'Reopened for Editing'].includes(appRow.status)) {
      return sendError(res, 400, `Application cannot be submitted because its status is already ${appRow.status}.`, 'INVALID_STATUS');
    }

    if (!isAdmin(auth.user)) {
      const windowRow = await db.get(`SELECT status FROM eoq_windows WHERE year=? AND quarter=?`, [appRow.year, appRow.quarter]);
      if (!windowRow || windowRow.status !== 'open') {
        return sendError(res, 400, 'Nomination window for this quarter is currently closed.', 'CLOSED');
      }
    }

    const existingSubmitted = await db.get(
      `SELECT id FROM eoq_nominations WHERE year=? AND quarter=? AND nominated_employee_id=? AND status NOT IN ('Draft', 'Reopened for Editing') AND id != ?`,
      [appRow.year, appRow.quarter, appRow.nominated_employee_id, appId]
    );
    if (existingSubmitted) {
      return sendError(res, 400, `A submitted nomination already exists for this employee in ${appRow.quarter} ${appRow.year}.`, 'DUPLICATE');
    }

    const stamp = nowIso();
    const isReopened = appRow.status === 'Reopened for Editing';
    const newStatus = isReopened ? 'Resubmitted' : 'Submitted';

    let appCode = appRow.app_code;
    if (!appCode || appCode.startsWith('DRAFT-')) {
      appCode = await generateNextEoqAppCode(db, appRow.year, appRow.quarter);
    }

    await db.run(
      `UPDATE eoq_nominations 
       SET status=?, app_code=?, submitted_at=?, updated_at=?
       WHERE id=?`,
      [newStatus, appCode, stamp, stamp, appId]
    );

    const updatedRow = await db.get(`SELECT * FROM eoq_nominations WHERE id=?`, [appId]);
    return sendJson(res, 200, { application: serializeEoqApplication(updatedRow) });
  }

  match = pathname.match(/^\/api\/eoq\/applications\/([^/]+)\/reopen$/);
  if (match && method === 'POST') {
    const auth = await requireAuth(req, res, { csrf: true, admin: true });
    if (!auth) return;
    const appId = decodeURIComponent(match[1]);
    const body = await readJson(req);
    const reason = cleanText(body.reason, 2000, true);
    if (!reason) return sendError(res, 400, 'A reason for reopening the application is required.', 'VALIDATION');

    const appRow = await db.get(`SELECT * FROM eoq_nominations WHERE id=?`, [appId]);
    if (!appRow) return sendError(res, 404, 'Application not found.', 'NOT_FOUND');

    const stamp = nowIso();
    await db.run(
      `UPDATE eoq_nominations 
       SET status='Reopened for Editing', reopen_reason=?, updated_at=?
       WHERE id=?`,
      [reason, stamp, appId]
    );

    const updatedRow = await db.get(`SELECT * FROM eoq_nominations WHERE id=?`, [appId]);
    return sendJson(res, 200, { application: serializeEoqApplication(updatedRow) });
  }

  match = pathname.match(/^\/api\/eoq\/applications\/([^/]+)\/review$/);
  if (match && method === 'POST') {
    const auth = await requireAuth(req, res, { csrf: true, admin: true });
    if (!auth) return;
    const appId = decodeURIComponent(match[1]);
    const body = await readJson(req);

    const decision = ['Approved', 'Not Approved', 'Under Review'].includes(body.decision) ? body.decision : 'Approved';
    const comments = cleanText(body.manager_comments, 5000);
    const appRow = await db.get(`SELECT * FROM eoq_nominations WHERE id=?`, [appId]);
    if (!appRow) return sendError(res, 404, 'Application not found.', 'NOT_FOUND');

    const stamp = nowIso();
    await db.run(
      `UPDATE eoq_nominations 
       SET status=?, manager_comments=?, reviewed_by_id=?, reviewed_by_name=?, reviewed_at=?, updated_at=?
       WHERE id=?`,
      [decision, comments, auth.user.id, auth.user.name, stamp, stamp, appId]
    );

    const updatedRow = await db.get(`SELECT * FROM eoq_nominations WHERE id=?`, [appId]);
    return sendJson(res, 200, { application: serializeEoqApplication(updatedRow) });
  }

  return sendError(res, 404, 'API route not found.', 'NOT_FOUND');
}

function staticMime(file) {
  const extension = path.extname(file).toLowerCase();
  return ({
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
  })[extension] || 'application/octet-stream';
}

async function serveStatic(req, res, url) {
  let relative;
  try { relative = decodeURIComponent(url.pathname); } catch { return sendError(res, 400, 'Invalid URL.', 'VALIDATION'); }
  if (relative === '/') relative = '/index.html';
  const publicRoot = path.resolve(PUBLIC_DIR);
  const resolved = path.resolve(publicRoot, '.' + relative);
  if (resolved !== path.join(publicRoot, 'index.html') && !resolved.startsWith(publicRoot + path.sep)) {
    return sendError(res, 403, 'Forbidden.', 'FORBIDDEN');
  }

  let file = resolved;
  let stat;
  try {
    stat = await fs.promises.stat(file);
    if (!stat.isFile()) throw Object.assign(new Error('Not a file'), { code: 'ENOENT' });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    file = path.join(publicRoot, 'index.html');
    stat = await fs.promises.stat(file);
  }

  securityHeaders(res, false);
  res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self' https://fonts.gstatic.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; script-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
  res.writeHead(200, {
    'Content-Type': staticMime(file),
    'Content-Length': stat.size,
    'Cache-Control': file.endsWith('.html') ? 'no-cache' : 'public, max-age=3600'
  });
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(file);
  stream.on('error', error => res.destroy(error));
  stream.pipe(res);
}

async function start() {
  await fs.promises.mkdir(DATA_DIR, { recursive: true });
  fileStore = new LocalFileStore(UPLOAD_DIR);
  await fileStore.init();
  db = new MySQLDatabase(databaseConfig());
  await db.ready;
  await initializeSchema(db);
  sessionSecret = String(process.env.SESSION_SECRET || '');
  if (sessionSecret.length < 32) {
    const error = new Error('SESSION_SECRET must be at least 32 characters.');
    error.code = 'MISSING_SESSION_SECRET';
    throw error;
  }
  authProvider = new DatabaseAuthProvider(db);
  dummyPasswordHash = await hashScryptPassword(randomToken(24));


  server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (!['GET', 'HEAD'].includes(req.method || 'GET')) return sendError(res, 405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
      return await serveStatic(req, res, url);
    } catch (error) {
      const status = Number(error.status) || 500;
      if (status >= 500) console.error(error);
      if (!res.headersSent) {
        sendError(res, status, status >= 500 ? 'Server error. Please try again.' : error.message, status >= 500 ? 'SERVER_ERROR' : 'VALIDATION');
      } else {
        res.end();
      }
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, resolve);
  });
  console.log(`Mypreneur Connect running at http://localhost:${PORT}`);
  console.log('MariaDB connection established. Users, roles, teams, and login history are database-managed.');
  console.log(`Protected file storage: ${UPLOAD_DIR}`);
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\nReceived ${signal}. Closing Mypreneur Connect...`);
  if (server) await new Promise(resolve => server.close(resolve));
  if (db) await db.close().catch(error => console.error('Database close error:', error));
}

process.on('SIGINT', () => shutdown('SIGINT').finally(() => process.exit(0)));
process.on('SIGTERM', () => shutdown('SIGTERM').finally(() => process.exit(0)));

start().catch(async error => {
  console.error('\nUnable to start Mypreneur Connect.');
  console.error(error.message);
  if (error.code === 'MISSING_DATABASE_CONFIG' || error.code === 'INVALID_DATABASE_CONFIG') {
    console.error('\nAdd correct DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, and DB_NAME values in Hostinger Environment Variables.');
  }
  if (error.code === 'MISSING_ACCESS_CONFIG') {
    console.error('\nAdd the PORTAL_* role and team environment variables supplied in DEPLOYMENT.txt.');
  }
  if (error.code === 'MISSING_SESSION_SECRET') {
    console.error('\nAdd a random SESSION_SECRET of at least 32 characters in the hosting environment.');
  }
  if (error.code === 'INVALID_AUTH_SCHEMA') {
    console.error('\nCheck the AUTH_* table-name environment variables.');
  }
  if (db) await db.close().catch(() => {});
  process.exitCode = 1;
});
