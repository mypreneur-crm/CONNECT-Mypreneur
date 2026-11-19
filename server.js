'use strict';
if (require('node:fs').existsSync('.env') && !process.env.DB_HOST) {
  try { require('node:process').loadEnvFile('.env'); } catch (e) {}
}

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const { MySQLDatabase, databaseConfig } = require('./lib/database');
const { LocalFileStore } = require('./lib/file-store');
const { initializeSchema } = require('./lib/schema');
const { DatabaseAuthProvider, hashScryptPassword } = require('./lib/auth-provider');
const { handleTaskApi } = require('./lib/tasks/task-routes');
const { ChatService } = require('./lib/chat/chat-service');
const { registerChatRoutes } = require('./lib/chat/chat-routes');
const monthly1on1Db = require('./lib/monthly-1on1-db');

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
const FILE_EXTENSIONS = new Set(['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.csv', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.zip']);

let db;
let fileStore;
let authProvider;
let dummyPasswordHash;
let server;
let sessionSecret;
let chatService;
let handleChatApi;
const loginAttempts = new Map();
const presenceMap = new Map();
let shuttingDown = false;

function nowIso() { return new Date().toISOString(); }
function addMs(iso, ms) { return new Date(new Date(iso).getTime() + ms).toISOString(); }
function randomToken(bytes = 32) { return crypto.randomBytes(bytes).toString('base64url'); }
function tokenHash(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function publicUser(row) {
  return {
    id: row.id,
    employeeId: row.employeeId || row.id,
    user: row.username,
    username: row.username,
    name: row.name,
    title: row.title,
    role: row.role,
    team: row.team || null,
    sourceRoles: row.sourceRoles || [],
    sourceTeam: row.sourceTeam || null,
    isSuperAdmin: monthly1on1Db.isSuperAdmin(row),
    isServiceAdmin: monthly1on1Db.isServiceAdmin(row),
    isExecutive: monthly1on1Db.isExecutiveLeadership(row)
  };
}

const MASTER_APP_SECRET = 'mypreneur_connect_master_app_secret_v1_2026_x89a';

function getEncryptionKey(secretOverride) {
  const secret = String(secretOverride || process.env.ENCRYPTION_SECRET || process.env.SESSION_SECRET || MASTER_APP_SECRET);
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

const ipLoginAttempts = new Map();
function ipLoginAllowed(ip) {
  const now = Date.now();
  const entry = ipLoginAttempts.get(ip);
  if (!entry) return true;
  if (now - entry.windowStarted >= LOGIN_WINDOW_MS) {
    ipLoginAttempts.delete(ip);
    return true;
  }
  return entry.count < 30;
}

function registerIpLoginAttempt(ip) {
  const now = Date.now();
  const entry = ipLoginAttempts.get(ip);
  if (!entry || now - entry.windowStarted >= LOGIN_WINDOW_MS) {
    ipLoginAttempts.set(ip, { count: 1, windowStarted: now });
  } else {
    entry.count += 1;
  }
}

async function loginAllowed(key, ip, username) {
  if (!ipLoginAllowed(ip)) return false;
  const now = Date.now();
  const row = loginAttempts.get(key);
  if (row && row.blockedUntil && row.blockedUntil > now) return false;
  if (row && now - row.windowStarted >= LOGIN_WINDOW_MS) {
    loginAttempts.delete(key);
  }

  // Database-backed rate limiting check (connect_login_attempts)
  if (db && db.ready) {
    try {
      const dbRow = await db.get(
        `SELECT failed_attempts, blocked_until FROM connect_login_attempts WHERE attempt_key=?`,
        [key]
      );
      if (dbRow && dbRow.blocked_until) {
        const blockedTime = new Date(dbRow.blocked_until).getTime();
        if (blockedTime > now) {
          loginAttempts.set(key, { failures: dbRow.failed_attempts, windowStarted: now, blockedUntil: blockedTime });
          return false;
        }
      }
    } catch {}
  }

  const current = loginAttempts.get(key);
  return !current || current.failures < MAX_LOGIN_FAILURES;
}

async function registerLoginFailure(key, ip, username) {
  const now = Date.now();
  const blockedUntilIso = new Date(now + LOGIN_BLOCK_MS).toISOString();
  let failures = 1;
  const mem = loginAttempts.get(key);
  if (mem && now - mem.windowStarted < LOGIN_WINDOW_MS) {
    failures = mem.failures + 1;
  }
  const isBlocked = failures >= MAX_LOGIN_FAILURES;
  loginAttempts.set(key, {
    failures,
    windowStarted: mem?.windowStarted || now,
    blockedUntil: isBlocked ? now + LOGIN_BLOCK_MS : null
  });

  if (db && db.ready) {
    try {
      const stamp = nowIso();
      await db.run(
        `INSERT INTO connect_login_attempts (attempt_key, ip_address, username, failed_attempts, blocked_until, last_attempt_at)
         VALUES (?, ?, ?, 1, ?, ?)
         ON DUPLICATE KEY UPDATE
           failed_attempts = failed_attempts + 1,
           blocked_until = IF(failed_attempts + 1 >= ?, ?, blocked_until),
           last_attempt_at = ?`,
        [key, String(ip || '').slice(0, 45), String(username || '').slice(0, 100), isBlocked ? blockedUntilIso : null, stamp, MAX_LOGIN_FAILURES, blockedUntilIso, stamp]
      );
    } catch {}
  }
}

async function clearLoginFailures(key) {
  loginAttempts.delete(key);
  if (db && db.ready) {
    try {
      await db.run(`DELETE FROM connect_login_attempts WHERE attempt_key=?`, [key]);
    } catch {}
  }
}

function cleanupLoginAttempts() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [key, row] of loginAttempts.entries()) {
    if (row.windowStarted < cutoff && (!row.blockedUntil || row.blockedUntil < Date.now())) loginAttempts.delete(key);
  }
}

const actionRateBuckets = new Map();
function checkActionRateLimit(key, maxCount = 30, windowMs = 60000) {
  const now = Date.now();
  const entry = actionRateBuckets.get(key) || { count: 0, resetAt: now + windowMs };
  if (now > entry.resetAt) {
    entry.count = 1;
    entry.resetAt = now + windowMs;
    actionRateBuckets.set(key, entry);
    return true;
  }
  entry.count += 1;
  actionRateBuckets.set(key, entry);
  return entry.count <= maxCount;
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

const SUPER_ADMIN_PIN = String(process.env.SUPER_ADMIN_PIN || '0987');

function signSuperAdminPinToken(userId) {
  const payload = { userId: Number(userId), role: 'super_admin', exp: Date.now() + (2 * 60 * 60 * 1000) };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', sessionSecret).update(`superpin:${encoded}`).digest('base64url');
  return `${encoded}.${sig}`;
}

function verifySuperAdminPinToken(token, expectedUserId) {
  if (!token) return false;
  const [encoded, sig, extra] = String(token).split('.');
  if (!encoded || !sig || extra) return false;
  const expectedSig = crypto.createHmac('sha256', sessionSecret).update(`superpin:${encoded}`).digest('base64url');
  let sigBuf, expBuf;
  try {
    sigBuf = Buffer.from(sig, 'base64url');
    expBuf = Buffer.from(expectedSig, 'base64url');
  } catch { return false; }
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return false;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!payload.exp || Number(payload.exp) <= Date.now()) return false;
    if (Number(payload.userId) !== Number(expectedUserId)) return false;
    return true;
  } catch { return false; }
}

function hasSuperAdminPinVerified(req, userId) {
  return true;
}

async function getAuth(req) {
  const token = parseCookies(req).mc_session;
  if (!token) return null;
  const session = verifySessionToken(token);
  if (!session) return null;
  const userRecord = await authProvider.findById(session.userId);
  if (!userRecord || !userRecord.active || !userRecord.portalAccess) return null;

  // Server-side session revocation check
  if (session.loginId) {
    const isRevoked = await authProvider.isSessionRevoked(session.loginId);
    if (isRevoked) return null;
  }

  const user = publicUser(userRecord);
  if (user && user.employeeId) {
    presenceMap.set(Number(user.employeeId), Date.now());
  }

  return { token, csrf: session.csrf, loginId: session.loginId || null, user };
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
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(), payment=(), usb=(), screen-wake-lock=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self' wss:; media-src 'self' blob: data:; img-src 'self' data: blob:; font-src 'self' https://fonts.gstatic.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; script-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
  if (NODE_ENV === 'production' || String(process.env.COOKIE_SECURE || '').toLowerCase() === 'true') {
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  }
  if (isApi) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
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
  const referer = req.headers.referer;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (!origin && !referer) return true;
  try {
    if (origin && new URL(origin).host !== host) return false;
    if (referer && new URL(referer).host !== host) return false;
    return true;
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
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.zip': 'application/zip'
  })[extension] || 'application/octet-stream';
}

function inspectUploadedContent(buffer, extension) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw Object.assign(new Error('Uploaded file is empty.'), { status: 400 });
  }

  // Reject Windows executables (PE/EXE/DLL)
  if (buffer.length >= 2 && buffer[0] === 0x4D && buffer[1] === 0x5A) {
    throw Object.assign(new Error('Executable files are strictly forbidden.'), { status: 400 });
  }

  // Check header text for malicious web shells / script tags
  const headerText = buffer.slice(0, 2048).toString('utf8').toLowerCase();
  if (
    headerText.includes('<script') ||
    headerText.includes('<?php') ||
    headerText.includes('<!doctype html') ||
    headerText.includes('<html') ||
    headerText.includes('<svg') ||
    headerText.includes('javascript:')
  ) {
    throw Object.assign(new Error('Uploaded file failed security validation.'), { status: 400 });
  }

  const ext = String(extension || '').toLowerCase();
  if (ext === '.pdf') {
    if (buffer.length < 5 || buffer[0] !== 0x25 || buffer[1] !== 0x50 || buffer[2] !== 0x44 || buffer[3] !== 0x46 || buffer[4] !== 0x2D) {
      throw Object.assign(new Error('Invalid PDF file signature.'), { status: 400 });
    }
  } else if (ext === '.png') {
    if (buffer.length < 8 || buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4E || buffer[3] !== 0x47 || buffer[4] !== 0x0D || buffer[5] !== 0x0A || buffer[6] !== 0x1A || buffer[7] !== 0x0A) {
      throw Object.assign(new Error('Invalid PNG file signature.'), { status: 400 });
    }
  } else if (ext === '.jpg' || ext === '.jpeg') {
    if (buffer.length < 3 || buffer[0] !== 0xFF || buffer[1] !== 0xD8 || buffer[2] !== 0xFF) {
      throw Object.assign(new Error('Invalid JPEG file signature.'), { status: 400 });
    }
  } else if (['.docx', '.xlsx', '.pptx'].includes(ext)) {
    if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4B || buffer[2] !== 0x03 || buffer[3] !== 0x04) {
      throw Object.assign(new Error('Invalid document file signature.'), { status: 400 });
    }
  } else if (['.doc', '.xls', '.ppt'].includes(ext)) {
    if (buffer.length < 8 || buffer[0] !== 0xD0 || buffer[1] !== 0xCF || buffer[2] !== 0x11 || buffer[3] !== 0xE0) {
      throw Object.assign(new Error('Invalid document file signature.'), { status: 400 });
    }
  }
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
  inspectUploadedContent(buffer, extension);
  return { name, type: safeMimeForName(name), buffer };
}

async function audit(user, action, entity, entityId, details = '') {
  if (!db || !db.ready) return;
  try {
    await db.run(
      `INSERT INTO audit_logs (user_id, action, entity, entity_id, details, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        user?.id ? Number(user.id) : null,
        String(action || '').slice(0, 80),
        String(entity || '').slice(0, 80),
        entityId ? String(entityId).slice(0, 100) : null,
        String(details || '').slice(0, 1000),
        nowIso()
      ]
    );
  } catch (err) {
    console.error('Audit log failure:', err.message);
  }
}

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

function isExecutiveLeadership(user) {
  return monthly1on1Db.isExecutiveLeadership(user);
}

function canNominateOthers(user) {
  return Boolean(user && (isAdmin(user) || isExecutiveLeadership(user)));
}

function canViewAllApplications(user) {
  return isAdmin(user) || isExecutiveLeadership(user);
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
  const isSecure = NODE_ENV === 'production' || String(process.env.COOKIE_SECURE || '').toLowerCase() === 'true';
  const attributes = [
    `mc_session=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_MS / 1000)}`
  ];
  if (isSecure) attributes.push('Secure');
  return attributes.join('; ');
}

function clearCookie() {
  const isSecure = NODE_ENV === 'production' || String(process.env.COOKIE_SECURE || '').toLowerCase() === 'true';
  const attributes = ['mc_session=', 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (isSecure) attributes.push('Secure');
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
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  const ext = path.extname(row.file_name || row.file_storage_key || '').toLowerCase();
  const isInlineAllowed = ['.png', '.jpg', '.jpeg', '.pdf'].includes(ext);
  const disposition = isInlineAllowed ? 'inline' : 'attachment';
  const safeName = String(row.file_name || 'document').replace(/["\r\n\\]/g, '_');
  res.writeHead(200, {
    'Content-Type': row.file_type || 'application/octet-stream',
    'Content-Length': stat.size,
    'Content-Disposition': `${disposition}; filename="${safeName}"`,
    'Cache-Control': 'private, no-store, no-cache, must-revalidate',
    'Pragma': 'no-cache'
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
    registerIpLoginAttempt(ip);
    if (!await loginAllowed(attemptKey, ip, username)) return sendError(res, 429, 'Too many sign-in attempts. Try again later.', 'RATE_LIMITED');

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
      await registerLoginFailure(attemptKey, ip, username);
      await authProvider.recordLogin({
        userId: row?.id || null,
        status: 'FAILED',
        ipAddress: ip,
        deviceInfo: req.headers['user-agent'] || ''
      });

      // Resistant to account enumeration: generic error message always
      return sendError(res, 401, 'Invalid username or password.', 'INVALID_CREDENTIALS');
    }

    await clearLoginFailures(attemptKey);
    await authProvider.updateLastLogin(row.id);

    // Transparently upgrade legacy password hashes (MD5, SHA-1, plaintext) to modern scrypt
    if (row.passwordHash && !row.passwordHash.startsWith('scrypt$') && !/^\$2[aby]\$/.test(row.passwordHash)) {
      authProvider.upgradePasswordHash(row.id, password).catch(err => {
        console.warn('Transparent password upgrade deferred:', err.message);
      });
    }

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
    const empId = auth.user.employeeId || auth.user.id;
    if (chatService && empId) {
      await chatService.updatePresence(empId, 'OFFLINE').catch(() => {});
    }
    if (empId) presenceMap.delete(Number(empId));
    await authProvider.recordLogout(auth.loginId, auth.user.id);
    const isSecure = NODE_ENV === 'production' || String(process.env.COOKIE_SECURE || '').toLowerCase() === 'true';
    const clearPinCookie = `mc_super_pin=; Path=/; HttpOnly; SameSite=Lax${isSecure ? '; Secure' : ''}; Max-Age=0`;
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': [clearCookie(), clearPinCookie] });
  }

  if (pathname.startsWith('/api/tasks')) {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    return await handleTaskApi(req, res, url, auth, db);
  }

  if (pathname.startsWith('/api/chat/')) {
    if (handleChatApi) {
      const handled = await handleChatApi(req, res, url);
      if (handled) return;
    }
  }

  if (method === 'POST' && pathname === '/api/auth/verify-super-admin-pin') {
    const auth = await requireAuth(req, res, { csrf: true });
    if (!auth) return;
    if (!monthly1on1Db.isSuperAdmin(auth.user)) {
      return sendError(res, 403, 'PIN verification is only required for Super Admin.', 'FORBIDDEN');
    }
    const body = await readJson(req);
    const pin = String(body.pin || '').trim();
    const pinBuf = Buffer.from(pin);
    const expectedBuf = Buffer.from(SUPER_ADMIN_PIN);
    if (!pin || pinBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(pinBuf, expectedBuf)) {
      return sendError(res, 401, 'Invalid Super Admin PIN. Access denied.', 'INVALID_PIN');
    }
    const pinToken = signSuperAdminPinToken(auth.user.id);
    const isSecure = NODE_ENV === 'production' || String(process.env.COOKIE_SECURE || '').toLowerCase() === 'true';
    return sendJson(res, 200, { ok: true, pinToken }, {
      'Set-Cookie': `mc_super_pin=${encodeURIComponent(pinToken)}; Path=/; HttpOnly; SameSite=Lax${isSecure ? '; Secure' : ''}; Max-Age=7200`
    });
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

  /* ============ EMPLOYEE CONTACTS & DIRECTORY ============ */

  if (method === 'POST' && pathname === '/api/presence/heartbeat') {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    if (auth.user && auth.user.employeeId) {
      presenceMap.set(Number(auth.user.employeeId), Date.now());
      if (chatService) chatService.updatePresence(auth.user.employeeId, 'ONLINE');
    }
    return sendJson(res, 200, { ok: true, timestamp: Date.now() });
  }

  if (method === 'GET' && pathname === '/api/contacts') {
    const auth = await requireAuth(req, res);
    if (!auth) return;

    const tUsers = authProvider.schema.usersTable;
    const tEmployees = authProvider.schema.employeesTable;
    const tTeams = authProvider.schema.teamsTable;
    const today = new Date().toISOString().slice(0, 10);

    // 1. Fetch active employees
    const employees = await db.all(`
      SELECT 
        e.employee_id,
        e.employee_code,
        e.first_name,
        e.last_name,
        e.email,
        e.phone,
        e.designation,
        e.booking_link,
        COALESCE(t.team_name, 'General') AS department,
        e.status AS emp_status,
        u.user_id,
        u.username,
        u.is_active AS user_active,
        u.last_login
      FROM ${tEmployees} e
      LEFT JOIN ${tTeams} t ON e.team_id = t.team_id
      LEFT JOIN ${tUsers} u ON u.employee_id = e.employee_id
      WHERE (e.status IS NULL OR UPPER(e.status) = 'ACTIVE')
        AND e.employee_id != 1
        AND NOT (LOWER(COALESCE(e.first_name, '')) = 'super' AND LOWER(COALESCE(e.last_name, '')) = 'admin')
        AND LOWER(COALESCE(u.username, '')) != 'admin'
      ORDER BY t.team_name ASC, e.first_name ASC
    `);

    // 2. Query today's approved leaves (do not leak private reason into directory; exclude PERMISSION)
    let activeLeaves = [];
    try {
      activeLeaves = await db.all(`
        SELECT employee_id, leave_duration, status
        FROM leaves
        WHERE ? BETWEEN start_date AND end_date
          AND UPPER(status) = 'APPROVED'
          AND UPPER(leave_duration) != 'PERMISSION'
      `, [today]);
    } catch (e) {}
    const leaveMap = new Map();
    for (const l of activeLeaves) {
      leaveMap.set(Number(l.employee_id), l);
    }

    // 3. Query active task timers
    let activeTimers = [];
    try {
      activeTimers = await db.all(`
        SELECT DISTINCT employee_id
        FROM connect_task_time_entries
        WHERE end_time IS NULL
      `);
    } catch (e) {}
    const timerSet = new Set(activeTimers.map(t => Number(t.employee_id)));

    // 4. Query today's attendance
    let todayAtt = [];
    try {
      todayAtt = await db.all(`
        SELECT employee_id, check_in, check_out, status
        FROM attendance
        WHERE date = ?
      `, [today]);
    } catch (e) {}
    const attMap = new Map();
    for (const a of todayAtt) {
      attMap.set(Number(a.employee_id), a);
    }

    const now = Date.now();
    const chatPresence = chatService ? await chatService.getAllPresence() : {};
    const stats = { total: employees.length, online: 0, away: 0, on_leave: 0, offline: 0 };

    const contacts = employees.map(emp => {
      const empId = Number(emp.employee_id);
      const fullName = [emp.first_name, emp.last_name].filter(Boolean).join(' ').trim() || emp.username || `Employee #${empId}`;
      const empCode = emp.employee_code || `MYP-${String(empId).padStart(4, '0')}`;
      const cp = chatPresence[empId];
      const lastSeenMs = cp ? cp.last_heartbeat : (presenceMap.get(empId) || (emp.user_id ? presenceMap.get(Number(emp.user_id)) : 0));
      const isTimerActive = timerSet.has(empId);
      const leaveInfo = leaveMap.get(empId);
      const attInfo = attMap.get(empId);

      let status = 'OFFLINE';
      let statusLabel = 'Offline';
      let statusNote = '';

      // Live presence requires an active heartbeat or portal interaction within the last 60 seconds
      const isHeartbeatActive = Boolean(lastSeenMs && (now - lastSeenMs <= 60 * 1000));
      const isCheckedIn = Boolean(attInfo && (attInfo.check_in || ['PRESENT', 'WFH', 'LATE'].includes(String(attInfo.status || '').toUpperCase())));

      // An employee is only ON_LEAVE if they have an approved leave (or attendance ON_LEAVE) AND are NOT checked in or active in portal
      const isActuallyOnLeave = Boolean(
        (leaveInfo || (attInfo && String(attInfo.status || '').toUpperCase() === 'ON_LEAVE')) &&
        !isCheckedIn &&
        !isHeartbeatActive
      );

      if (isActuallyOnLeave) {
        status = 'ON_LEAVE';
        statusLabel = 'On Leave';
        statusNote = (leaveInfo && leaveInfo.leave_duration === 'HALF_DAY') ? 'Half Day Leave' : 'On Leave';
        stats.on_leave++;
      } else if (isHeartbeatActive && cp && cp.status === 'AWAY') {
        status = 'AWAY';
        statusLabel = 'Away';
        statusNote = cp.custom_status || 'Away';
        stats.away++;
      } else if (isHeartbeatActive) {
        status = 'ONLINE';
        statusLabel = 'Online';
        statusNote = isTimerActive ? 'Working on Task' : (cp && cp.custom_status ? cp.custom_status : 'Active in Portal');
        stats.online++;
      } else {
        status = 'OFFLINE';
        statusLabel = 'Offline';
        statusNote = isCheckedIn ? (attInfo?.status === 'WFH' ? 'Working from Home' : 'Present in Office') : (emp.last_login ? `Last login: ${emp.last_login}` : 'Offline');
        stats.offline++;
      }

      return {
        id: empId,
        user_id: emp.user_id ? Number(emp.user_id) : null,
        name: fullName,
        first_name: emp.first_name || '',
        last_name: emp.last_name || '',
        employee_code: empCode,
        department: emp.department || 'General',
        designation: emp.designation || 'Team Member',
        email: emp.email || '',
        phone: emp.phone || '',
        booking_link: emp.booking_link || '',
        status,
        status_label: statusLabel,
        status_note: statusNote
      };
    });

    const departments = ['All', ...new Set(contacts.map(c => c.department).filter(Boolean))];

    return sendJson(res, 200, { contacts, departments, stats });
  }

  if (method === 'POST' && pathname === '/api/contacts/share') {
    const auth = await requireAuth(req, res, { csrf: true });
    if (!auth) return;
    const body = await readJson(req);
    const toEmployeeId = Number(body.to_employee_id);
    const messageType = body.message_type === 'link' ? 'link' : 'message';
    const content = cleanText(body.content, 2000);
    const linkUrl = cleanText(body.link_url, 2048);
    const linkTitle = cleanText(body.link_title, 255);

    if (!toEmployeeId || (!content && !linkUrl)) {
      return sendError(res, 400, 'Recipient and content/link are required.', 'VALIDATION_ERROR');
    }

    const id = randomToken(16);
    const stamp = nowIso();
    const senderEmployeeId = auth.user.employeeId || null;

    try {
      await db.run(`
        INSERT INTO connect_employee_messages 
          (id, from_user_id, from_employee_id, to_employee_id, message_type, content, link_url, link_title, is_read, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
      `, [id, auth.user.id, senderEmployeeId, toEmployeeId, messageType, content || linkTitle || linkUrl, linkUrl || null, linkTitle || null, stamp]);
    } catch (e) {
      console.error('[EmployeeContacts] Error saving message:', e.message);
    }

    return sendJson(res, 201, { ok: true, id, message: 'Shared successfully!' });
  }

  if (method === 'GET' && pathname === '/api/contacts/messages') {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const empId = Number(url.searchParams.get('employee_id'));
    if (!empId) return sendJson(res, 200, { messages: [] });

    let rows = [];
    try {
      rows = await db.all(`
        SELECT m.*, u.username AS from_username
        FROM connect_employee_messages m
        LEFT JOIN ${authProvider.schema.usersTable} u ON u.user_id = m.from_user_id
        WHERE (m.from_user_id = ? AND m.to_employee_id = ?)
           OR (m.from_employee_id = ? AND m.to_employee_id = ?)
        ORDER BY m.created_at ASC
        LIMIT 50
      `, [auth.user.id, empId, empId, auth.user.employeeId || auth.user.id]);
    } catch (e) {
      rows = [];
    }

    return sendJson(res, 200, { messages: rows || [] });
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
    let userCanViewAll = canViewAllApplications(auth.user);
    let pinRequired = false;



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
      pinRequired,
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
    const auth = await requireAuth(req, res, { csrf: true });
    if (!auth) return;
    if (!isAdmin(auth.user) && !canViewAllApplications(auth.user)) {
      return sendError(res, 403, 'You do not have permission to configure nomination windows.', 'FORBIDDEN');
    }
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

    const isOwnApp = Number(appRow.submitted_by_id) === Number(auth.user.id) || Number(appRow.nominated_employee_id) === Number(auth.user.id);
    if (!canViewAllApplications(auth.user) && !isOwnApp) {
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
    const auth = await requireAuth(req, res, { csrf: true });
    if (!auth) return;
    if (!canViewAllApplications(auth.user)) {
      return sendError(res, 403, 'Only executive leadership can review EOQ applications.', 'FORBIDDEN');
    }
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
  /* ============ MONTHLY 1:1 MEETING REPORT ============ */

  const VALID_1ON1_STATUSES = monthly1on1Db.VALID_1ON1_STATUSES;
  const VALID_1ON1_SECTIONS = monthly1on1Db.VALID_1ON1_SECTIONS;

  function can1on1Review(user) {
    return monthly1on1Db.canReviewAll1on1Reports(user);
  }
  function can1on1AdminAction(user) {
    return monthly1on1Db.canReviewAll1on1Reports(user);
  }

  /* GET /api/monthly-1on1/windows — get reporting window for a given month */
  if (method === 'GET' && pathname === '/api/monthly-1on1/windows') {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const month = url.searchParams.get('month') || new Date().toISOString().slice(0, 7);
    try {
      const windowInfo = await monthly1on1Db.getWindowForMonth(db, month);
      return sendJson(res, 200, { window: windowInfo });
    } catch (err) {
      return sendError(res, 400, err.message, 'VALIDATION');
    }
  }

  /* POST /api/monthly-1on1/windows — Super Admin only: configure reporting window */
  if (method === 'POST' && pathname === '/api/monthly-1on1/windows') {
    const auth = await requireAuth(req, res, { csrf: true });
    if (!auth) return;
    if (!monthly1on1Db.canConfigure1on1Window(auth.user)) {
      return sendError(res, 403, 'Only Super Admin is authorized to configure reporting windows.', 'FORBIDDEN');
    }

    const body = await readJson(req);
    try {
      const windowInfo = await monthly1on1Db.createOrUpdateWindow(db, {
        reportingMonth: body.reporting_month,
        startDate: body.start_date,
        startTime: body.start_time,
        endDate: body.end_date,
        endTime: body.end_time,
        auditUser: auth.user
      });
      return sendJson(res, 200, { window: windowInfo });
    } catch (err) {
      return sendError(res, err.status || 400, err.message, err.code || 'VALIDATION');
    }
  }

  /* GET /api/monthly-1on1/windows/year — Super Admin: all 12 months for a year with window configuration and counts */
  if (method === 'GET' && pathname === '/api/monthly-1on1/windows/year') {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    if (!monthly1on1Db.canConfigure1on1Window(auth.user)) {
      return sendError(res, 403, 'Only Super Admin can access the 12-month window dashboard.', 'FORBIDDEN');
    }
    const yearParam = Number(url.searchParams.get('year') || new Date().getFullYear());
    const selectedYear = (yearParam >= 2020 && yearParam <= 2100) ? yearParam : new Date().getFullYear();

    // Calculate total expected applicants (active employees excluding Super Admin)
    let totalEligibleApplicants = 0;
    try {
      const allEmps = await getEmployeesList(db);
      totalEligibleApplicants = allEmps.filter(e => !['admin'].includes(e.role) && !monthly1on1Db.isSuperAdmin(e)).length;
      if (totalEligibleApplicants === 0) totalEligibleApplicants = allEmps.length;
    } catch {
      totalEligibleApplicants = 1;
    }

    // Get aggregated stats by month for that year
    const statsRows = await db.all(
      `SELECT
         MONTH(reporting_month) AS month_num,
         COUNT(CASE WHEN status IN ('Submitted', 'Under Review', 'Completed', 'Approved', 'Rejected') THEN 1 END) AS submitted,
         COUNT(CASE WHEN status='Approved' THEN 1 END) AS approved,
         COUNT(CASE WHEN status='Rejected' THEN 1 END) AS rejected
       FROM monthly_1on1_reports
       WHERE record_type='report' AND YEAR(reporting_month)=? AND employee_id > 0
       GROUP BY MONTH(reporting_month)`,
      [selectedYear]
    );

    const statsMap = {};
    for (const row of statsRows || []) {
      statsMap[Number(row.month_num)] = {
        submitted: Number(row.submitted || 0),
        approved: Number(row.approved || 0),
        rejected: Number(row.rejected || 0)
      };
    }

    const MONTH_NAMES = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'
    ];

    const months = [];
    for (let m = 1; m <= 12; m++) {
      const monthStr = String(m).padStart(2, '0');
      const monthKey = `${selectedYear}-${monthStr}-01`;
      const win = await monthly1on1Db.getWindowForMonth(db, monthKey);
      const mStats = statsMap[m] || { submitted: 0, approved: 0, rejected: 0 };
      const pending = Math.max(0, totalEligibleApplicants - mStats.submitted);

      months.push({
        month: m,
        month_name: MONTH_NAMES[m - 1],
        reporting_month: monthKey,
        year: selectedYear,
        window: win,
        stats: {
          submitted: mStats.submitted,
          approved: mStats.approved,
          rejected: mStats.rejected,
          pending: pending
        }
      });
    }

    return sendJson(res, 200, {
      year: selectedYear,
      total_eligible_applicants: totalEligibleApplicants,
      months
    });
  }

  /* POST /api/monthly-1on1/windows/close — Super Admin manual close */
  if (method === 'POST' && pathname === '/api/monthly-1on1/windows/close') {
    const auth = await requireAuth(req, res, { csrf: true });
    if (!auth) return;
    if (!monthly1on1Db.canConfigure1on1Window(auth.user)) {
      return sendError(res, 403, 'Only Super Admin is authorized to close reporting windows.', 'FORBIDDEN');
    }
    const body = await readJson(req);
    try {
      const windowInfo = await monthly1on1Db.closeWindow(db, {
        reportingMonth: body.reporting_month,
        adminUser: auth.user
      });
      return sendJson(res, 200, { ok: true, window: windowInfo });
    } catch (err) {
      return sendError(res, err.status || 400, err.message, err.code || 'VALIDATION');
    }
  }

  /* POST /api/monthly-1on1/windows/manual-open & /open — Super Admin manual open */
  if (method === 'POST' && (pathname === '/api/monthly-1on1/windows/manual-open' || pathname === '/api/monthly-1on1/windows/open')) {
    const auth = await requireAuth(req, res, { csrf: true });
    if (!auth) return;
    if (!monthly1on1Db.canConfigure1on1Window(auth.user)) {
      return sendError(res, 403, 'Only Super Admin is authorized to open reporting windows.', 'FORBIDDEN');
    }
    const body = await readJson(req);
    try {
      const windowInfo = await monthly1on1Db.manualOpenWindow(db, {
        reportingMonth: body.reporting_month,
        adminUser: auth.user,
        reason: cleanText(body.reason, 1000) || 'Manually opened by Super Admin'
      });
      return sendJson(res, 200, { ok: true, window: windowInfo });
    } catch (err) {
      return sendError(res, err.status || 400, err.message, err.code || 'VALIDATION');
    }
  }

  /* POST /api/monthly-1on1/windows/reopen — Super Admin explicit reopen */
  if (method === 'POST' && pathname === '/api/monthly-1on1/windows/reopen') {
    const auth = await requireAuth(req, res, { csrf: true });
    if (!auth) return;
    if (!monthly1on1Db.canConfigure1on1Window(auth.user)) {
      return sendError(res, 403, 'Only Super Admin is authorized to reopen reporting windows.', 'FORBIDDEN');
    }
    const body = await readJson(req);
    try {
      const windowInfo = await monthly1on1Db.reopenWindow(db, {
        reportingMonth: body.reporting_month,
        adminUser: auth.user,
        reason: cleanText(body.reason, 1000, true)
      });
      return sendJson(res, 200, { ok: true, window: windowInfo });
    } catch (err) {
      return sendError(res, err.status || 400, err.message, err.code || 'VALIDATION');
    }
  }

  /* GET /api/monthly-1on1/pending-employees — Super Admin & Service Admin "See Who" list */
  if (method === 'GET' && pathname === '/api/monthly-1on1/pending-employees') {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    if (!monthly1on1Db.canReviewAll1on1Reports(auth.user)) {
      return sendError(res, 403, 'Only Super Admin and Service Admin can access the pending employees list.', 'FORBIDDEN');
    }

    const yearParam = Number(url.searchParams.get('year') || new Date().getFullYear());
    const monthParam = url.searchParams.get('month');
    let monthKey;
    if (monthParam && monthParam.includes('-')) {
      monthKey = monthly1on1Db.normalizeReportingMonth(monthParam);
    } else {
      const mNum = Math.max(1, Math.min(12, Number(monthParam || new Date().getMonth() + 1)));
      monthKey = `${yearParam}-${String(mNum).padStart(2, '0')}-01`;
    }

    // 1. Get all active employees, excluding Super Admin
    let allEmps = [];
    try {
      allEmps = await getEmployeesList(db);
    } catch {
      allEmps = [];
    }
    const expectedApplicants = allEmps.filter(e => !['admin'].includes(e.role) && !monthly1on1Db.isSuperAdmin(e));

    // 2. Fetch existing reports for that month
    const existingReports = await db.all(
      `SELECT employee_id, status FROM monthly_1on1_reports WHERE record_type='report' AND reporting_month=?`,
      [monthKey]
    );

    const reportStatusByEmpId = new Map();
    for (const r of existingReports || []) {
      reportStatusByEmpId.set(Number(r.employee_id), r.status);
    }

    // 3. Classify each expected applicant
    const pendingList = [];
    for (const emp of expectedApplicants) {
      const st = reportStatusByEmpId.get(Number(emp.id));
      if (!st) {
        pendingList.push({
          id: emp.id,
          name: emp.name,
          employee_code: emp.employee_code || `EMP-${String(emp.id).padStart(4, '0')}`,
          department: emp.department || 'General',
          designation: emp.designation || 'Team Member',
          reporting_month: monthKey,
          application_status: 'Not Started'
        });
      } else if (st === 'Draft') {
        pendingList.push({
          id: emp.id,
          name: emp.name,
          employee_code: emp.employee_code || `EMP-${String(emp.id).padStart(4, '0')}`,
          department: emp.department || 'General',
          designation: emp.designation || 'Team Member',
          reporting_month: monthKey,
          application_status: 'Draft Not Submitted'
        });
      }
      // Submitted, Under Review, Completed, Approved, Rejected are received
    }

    return sendJson(res, 200, {
      ok: true,
      reporting_month: monthKey,
      total_expected: expectedApplicants.length,
      pending_count: pendingList.length,
      count: pendingList.length,
      employees: pendingList,
      pending_employees: pendingList
    });
  }

  /* GET /api/monthly-1on1/overview — dashboard overview for the current user */
  if (method === 'GET' && pathname === '/api/monthly-1on1/overview') {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const yearParam = Number(url.searchParams.get('year') || new Date().getFullYear());
    const selectedYear = (yearParam >= 2020 && yearParam <= 2100) ? yearParam : new Date().getFullYear();
    const currentMonthStr = new Date().toISOString().slice(0, 7);

    // Current window info
    const currentWindow = await monthly1on1Db.getWindowForMonth(db, currentMonthStr);

    // Find the single active open reporting window (enforcing single open window rule)
    const activeOpenWindow = await monthly1on1Db.getActiveOpenWindow(db);
    const openWindows = activeOpenWindow ? [activeOpenWindow] : [];

    let reports = [];
    let history = [];
    if (monthly1on1Db.canSubmit1on1(auth.user)) {
      reports = await db.all(
        `SELECT id, reporting_month, status, submitted_at, meeting_date, reviewer_name, reviewer_id, director_name, updated_at
         FROM monthly_1on1_reports
         WHERE employee_id=? AND YEAR(reporting_month)=? AND record_type='report'
         ORDER BY reporting_month ASC`,
        [auth.user.id, selectedYear]
      );

      // Complete history for My Monthly 1:1 Application History (all months)
      const allHistoryRows = await db.all(
        `SELECT id, reporting_month, status, submitted_at, meeting_date, reviewer_name, reviewer_id, director_name,
                director_feedback_json, director_feedback_at, director_feedback_by_name, approved_at, rejected_at, decision_notes, rejection_reason, revision_reason, updated_at, created_at
         FROM monthly_1on1_reports
         WHERE employee_id=? AND record_type='report'
         ORDER BY reporting_month DESC`,
        [auth.user.id]
      );
      history = (allHistoryRows || []).map(r => ({
        id: r.id,
        reporting_month: r.reporting_month,
        status: r.status,
        submitted_at: r.submitted_at || '',
        created_at: r.created_at || '',
        updated_at: r.updated_at || '',
        decision_notes: r.decision_notes || '',
        rejection_reason: r.rejection_reason || '',
        revision_reason: r.revision_reason || '',
        approved_at: r.approved_at || '',
        rejected_at: r.rejected_at || '',
        director_feedback_status: (r.approved_at || r.rejected_at || r.decision_notes || r.rejection_reason || r.director_feedback_at) ? 'Feedback Available' : 'Pending Review',
        director_feedback_at: r.director_feedback_at || '',
        director_feedback_by_name: r.director_feedback_by_name || ''
      }));
    }

    // Only authorized reviewers receive team statistics or total company counts
    const isReviewer = monthly1on1Db.canReviewAll1on1Reports(auth.user);
    let totalEmployeesOfMypreneur = undefined;
    let teamSummary = null;

    if (isReviewer) {
      try {
        const allEmps = await getEmployeesList(db);
        totalEmployeesOfMypreneur = allEmps.length;
      } catch {
        totalEmployeesOfMypreneur = 0;
      }

      const statsRow = await db.get(
        `SELECT
           COUNT(DISTINCT employee_id) AS total_active_employees,
           COUNT(CASE WHEN status='Submitted' THEN 1 END) AS submitted,
           COUNT(CASE WHEN status='Draft' THEN 1 END) AS draft,
           COUNT(CASE WHEN status='Under Review' THEN 1 END) AS under_review,
           COUNT(CASE WHEN status='Completed' THEN 1 END) AS completed,
           COUNT(CASE WHEN status='Approved' THEN 1 END) AS approved,
           COUNT(CASE WHEN status='Rejected' THEN 1 END) AS rejected,
           COUNT(CASE WHEN status='Revision Requested' THEN 1 END) AS revision_requested
         FROM monthly_1on1_reports
         WHERE YEAR(reporting_month)=? AND record_type='report' AND employee_id > 0`,
        [selectedYear]
      );

      teamSummary = {
        total_employees_mypreneur: totalEmployeesOfMypreneur,
        total_team_members: totalEmployeesOfMypreneur,
        submitted: Number(statsRow?.submitted || 0),
        draft: Number(statsRow?.draft || 0),
        under_review: Number(statsRow?.under_review || 0),
        completed: Number(statsRow?.completed || 0),
        approved: Number(statsRow?.approved || 0),
        rejected: Number(statsRow?.rejected || 0),
        revision_requested: Number(statsRow?.revision_requested || 0)
      };
    }

    return sendJson(res, 200, {
      year: selectedYear,
      window: currentWindow,
      activeOpenWindow: activeOpenWindow || null,
      openWindows,
      total_employees_mypreneur: isReviewer ? totalEmployeesOfMypreneur : undefined,
      canSubmit: monthly1on1Db.canSubmit1on1(auth.user),
      isSuperAdmin: monthly1on1Db.isSuperAdmin(auth.user),
      isServiceAdmin: monthly1on1Db.isServiceAdmin(auth.user),
      reports: (reports || []).map(r => ({
        id: r.id,
        reporting_month: r.reporting_month,
        status: r.status,
        submitted_at: r.submitted_at || '',
        meeting_date: r.meeting_date || null,
        reviewer_name: r.reviewer_name || '',
        director_name: r.director_name || 'Director',
        updated_at: r.updated_at
      })),
      history,
      teamSummary
    });
  }

  /* GET /api/monthly-1on1/reports — list employee reports */
  if (method === 'GET' && pathname === '/api/monthly-1on1/reports') {
    const auth = await requireAuth(req, res);
    if (!auth) return;

    if (!monthly1on1Db.canSubmit1on1(auth.user)) {
      return sendJson(res, 200, { reports: [], total: 0, page: 1, limit: 20 });
    }

    const year = Number(url.searchParams.get('year') || 0);
    const month = Number(url.searchParams.get('month') || 0);
    const status = url.searchParams.get('status') || '';
    const q = String(url.searchParams.get('q') || '').trim();
    const page = Math.max(1, Number(url.searchParams.get('page') || 1));
    const limit = 20;
    const offset = (page - 1) * limit;

    let whereClause = `WHERE employee_id=? AND record_type='report'`;
    const params = [auth.user.id];
    if (year) { whereClause += ' AND YEAR(reporting_month)=?'; params.push(year); }
    if (month) { whereClause += ' AND MONTH(reporting_month)=?'; params.push(month); }
    if (status && VALID_1ON1_STATUSES.includes(status)) { whereClause += ' AND status=?'; params.push(status); }
    if (q) {
      whereClause += ' AND (id LIKE ? OR employee_name LIKE ? OR department LIKE ? OR reviewer_name LIKE ?)';
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }

    const rows = await db.all(
      `SELECT id, employee_id, employee_name, department, reviewer_name, director_name, reporting_month, meeting_date, submitted_at, status, updated_at, manager_notes_json, decision_notes, rejection_reason
       FROM monthly_1on1_reports ${whereClause}
       ORDER BY reporting_month DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    const countRow = await db.get(`SELECT COUNT(*) AS total FROM monthly_1on1_reports ${whereClause}`, params);
    const reports = (rows || []).map(r => {
      let notes = null;
      try {
        notes = r.manager_notes_json ? (typeof r.manager_notes_json === 'string' ? JSON.parse(r.manager_notes_json) : r.manager_notes_json) : null;
      } catch (e) {}
      return {
        ...r,
        manager_notes: notes
      };
    });
    return sendJson(res, 200, { reports, total: Number(countRow?.total || 0), page, limit });
  }

  /* POST /api/monthly-1on1/reports — create new report (draft) */
  if (method === 'POST' && pathname === '/api/monthly-1on1/reports') {
    const auth = await requireAuth(req, res, { csrf: true });
    if (!auth) return;

    // Super Admin must not apply or submit personal reports
    if (!monthly1on1Db.canSubmit1on1(auth.user)) {
      return sendError(res, 403, 'Super Admin is an administrative role and cannot create or submit personal Monthly 1:1 reports.', 'SUPER_ADMIN_CANNOT_APPLY');
    }

    if (!checkActionRateLimit('report_create:' + auth.user.id, 15, 60000)) {
      return sendError(res, 429, 'Too many report requests. Please wait a moment.', 'RATE_LIMITED');
    }

    const body = await readJson(req);

    let reportingMonth;
    try {
      reportingMonth = monthly1on1Db.normalizeReportingMonth(body.reporting_month);
    } catch (e) {
      return sendError(res, 400, 'Please select a valid reporting month (YYYY-MM).', 'VALIDATION');
    }

    // Verify reporting window is open for this month
    const windowInfo = await monthly1on1Db.getWindowForMonth(db, reportingMonth);
    if (windowInfo.status !== 'open') {
      return sendError(res, 403, `Reporting window for ${reportingMonth} is currently ${windowInfo.status}. Reports can only be created while the window is Open.`, 'WINDOW_NOT_OPEN');
    }

    const profile = await getEmployeeProfile(db, auth.user.id);
    try {
      const report = await monthly1on1Db.createMonthly1on1Report(db, {
        employeeId: auth.user.id,
        employeeName: auth.user.name || profile?.name || auth.user.username,
        department: profile?.department || auth.user.team || '',
        employeeRole: profile?.designation || auth.user.title || '',
        reportingMonthInput: reportingMonth,
        auditUser: auth.user
      });
      return sendJson(res, 201, { report });
    } catch (err) {
      if (err.code === 'DUPLICATE_REPORT') {
        return sendError(res, 400, 'A report already exists for this month. You may continue editing your draft or view your submitted report.', 'DUPLICATE');
      }
      return sendError(res, err.status || 400, err.message, err.code || 'VALIDATION');
    }
  }

  /* GET /api/monthly-1on1/reports/:id */
  match = pathname.match(/^\/api\/monthly-1on1\/reports\/([^/]+)$/);
  if (match && method === 'GET') {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const reportId = decodeURIComponent(match[1]);
    const report = await monthly1on1Db.getMonthly1on1ReportById(db, reportId);
    if (!report || report.record_type === 'window') return sendError(res, 404, 'Report not found.', 'NOT_FOUND');

    if (!monthly1on1Db.canUserAccessReport(auth.user, report, 'view')) {
      return sendError(res, 403, 'You do not have permission to view this report.', 'FORBIDDEN');
    }

    const windowInfo = await monthly1on1Db.getWindowForMonth(db, report.reporting_month);
    return sendJson(res, 200, {
      report: {
        ...report,
        is_window_open: windowInfo.status === 'open',
        window_start_ist: windowInfo.start_ist,
        window_end_ist: windowInfo.end_ist
      }
    });
  }

  /* PATCH /api/monthly-1on1/reports/:id — save draft or edits */
  if (match && method === 'PATCH') {
    const auth = await requireAuth(req, res, { csrf: true });
    if (!auth) return;
    const reportId = decodeURIComponent(match[1]);
    const report = await monthly1on1Db.getMonthly1on1ReportById(db, reportId);
    if (!report || report.record_type === 'window') return sendError(res, 404, 'Report not found.', 'NOT_FOUND');

    const isOwner = Number(report.employee_id) === Number(auth.user.id);
    const body = await readJson(req);

    if (isOwner) {
      if (!monthly1on1Db.canSubmit1on1(auth.user)) {
        return sendError(res, 403, 'Super Admin cannot modify personal reports.', 'FORBIDDEN');
      }

// Approved report modifications allowed while reporting window remains open

      // Check reporting window
      const windowInfo = await monthly1on1Db.getWindowForMonth(db, report.reporting_month);
      if (windowInfo.status !== 'open') {
        return sendError(res, 403, `Reporting window for ${report.reporting_month} is closed. Modifications are no longer permitted.`, 'WINDOW_CLOSED');
      }

      try {
        const headerUpdates = {};
        if (body.meeting_date !== undefined) headerUpdates.meeting_date = body.meeting_date;
        if (body.work_location !== undefined) headerUpdates.work_location = cleanText(body.work_location, 180);
        if (body.current_projects !== undefined) headerUpdates.current_projects = cleanText(body.current_projects, 5000);
        if (body.overall_status !== undefined) headerUpdates.overall_status = body.overall_status;
        if (body.capacity_for_additional_responsibilities !== undefined) headerUpdates.capacity_for_additional_responsibilities = body.capacity_for_additional_responsibilities;
        if (body.additional_responsibility_details !== undefined) headerUpdates.additional_responsibility_details = cleanText(body.additional_responsibility_details, 5000);

        const sections = body.items || {
          completed_deliverables: body.completed_deliverables,
          pending_tasks: body.pending_tasks,
          challenges_support: body.challenges_support,
          responsibility_readiness: body.responsibility_readiness,
          improvement_suggestions: body.improvement_suggestions,
          monthly_priorities: body.monthly_priorities
        };

        const updated = await monthly1on1Db.saveMonthly1on1Draft(db, {
          reportId,
          headerUpdates,
          sections,
          expectedUpdatedAt: body.expected_updated_at || body.updated_at || null,
          auditUser: auth.user
        });
        return sendJson(res, 200, { report: updated });
      } catch (err) {
        return sendError(res, err.status || 400, err.message, err.code || 'VALIDATION');
      }
    }

    // Reviewer saving manager notes (Service Admin or Super Admin)
    if (monthly1on1Db.canReviewAll1on1Reports(auth.user)) {
      try {
        const notes = body.manager_notes || body;
        const updated = await monthly1on1Db.saveMonthly1on1ReviewNotes(db, {
          reportId,
          managerNotes: {
            key_observation: cleanText(notes.key_observation, 5000),
            final_responsibility_assigned: cleanText(notes.final_responsibility_assigned || notes.final_responsibility, 5000),
            meeting_date: validDate(notes.meeting_date) ? notes.meeting_date : (validDate(notes.deadline) ? notes.deadline : (validDate(notes.follow_up_date) ? notes.follow_up_date : null)),
            follow_up_date: validDate(notes.meeting_date) ? notes.meeting_date : (validDate(notes.deadline) ? notes.deadline : (validDate(notes.follow_up_date) ? notes.follow_up_date : null)),
            deadline: validDate(notes.meeting_date) ? notes.meeting_date : (validDate(notes.deadline) ? notes.deadline : (validDate(notes.follow_up_date) ? notes.follow_up_date : null)),
            additional_comments: cleanText(notes.additional_comments, 5000)
          },
          reviewerId: auth.user.id,
          auditUser: auth.user
        });
        return sendJson(res, 200, { report: updated });
      } catch (err) {
        return sendError(res, err.status || 400, err.message, err.code || 'VALIDATION');
      }
    }

    return sendError(res, 403, 'You do not have permission to edit this report.', 'FORBIDDEN');
  }

  /* POST /api/monthly-1on1/reports/:id/attachments — upload deliverable proof (image/PDF) */
  match = pathname.match(/^\/api\/monthly-1on1\/reports\/([^/]+)\/attachments$/);
  if (match && method === 'POST') {
    const auth = await requireAuth(req, res, { csrf: true });
    if (!auth) return;
    const reportId = decodeURIComponent(match[1]);
    const report = await monthly1on1Db.getMonthly1on1ReportById(db, reportId);
    if (!report || report.record_type === 'window') return sendError(res, 404, 'Report not found.', 'NOT_FOUND');

    const isOwner = Number(report.employee_id) === Number(auth.user.id);
    if (!isOwner && !monthly1on1Db.canReviewAll1on1Reports(auth.user)) {
      return sendError(res, 403, 'You do not have permission to upload attachments for this report.', 'FORBIDDEN');
    }

    if (report.status === 'Approved') {
      return sendError(res, 400, 'Approved reports cannot accept new attachments.', 'REPORT_APPROVED');
    }

    // Window must be open for uploads
    const windowInfo = await monthly1on1Db.getWindowForMonth(db, report.reporting_month);
    if (windowInfo.status !== 'open') {
      return sendError(res, 403, `Reporting window for ${report.reporting_month} is closed. Attachments cannot be uploaded after the window has closed.`, 'WINDOW_CLOSED');
    }

    if (!checkActionRateLimit('proof_upload:' + auth.user.id, 20, 60000)) {
      return sendError(res, 429, 'Upload rate limit exceeded. Please wait a minute.', 'RATE_LIMITED');
    }

    const body = await readJson(req);
    let parsedFile;
    try {
      parsedFile = parseDataFile(body.file, true);
    } catch (e) {
      return sendError(res, 400, e.message || 'Invalid file payload.', 'INVALID_FILE');
    }

    // Max 10MB per deliverable attachment
    const MAX_PROOF_BYTES = 10 * 1024 * 1024;
    if (parsedFile.buffer.length > MAX_PROOF_BYTES) {
      return sendError(res, 400, 'File is too large. Maximum deliverable attachment size is 10 MB.', 'FILE_TOO_LARGE');
    }

    // Server-side magic-byte content inspection
    let inspection;
    try {
      inspection = monthly1on1Db.inspectProofBuffer(parsedFile.buffer, parsedFile.name);
    } catch (err) {
      return sendError(res, 400, err.message || 'Unsupported file type. Only JPG, PNG, WEBP images and PDF documents are allowed.', 'INVALID_FILE_TYPE');
    }

    // Store outside web root using safe random name in monthly-1on1 category
    const saved = await fileStore.save('monthly-1on1', parsedFile.name, parsedFile.buffer);

    return sendJson(res, 200, {
      ok: true,
      proof: {
        type: 'file',
        original_name: parsedFile.name,
        storage_key: saved.storageKey || saved.key,
        mime_type: inspection.mimeType,
        size: parsedFile.buffer.length
      }
    });
  }

  /* GET /api/monthly-1on1/reports/:id/attachment — secure download/preview of deliverable proof */
  match = pathname.match(/^\/api\/monthly-1on1\/reports\/([^/]+)\/attachment$/);
  if (match && method === 'GET') {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const reportId = decodeURIComponent(match[1]);
    const report = await monthly1on1Db.getMonthly1on1ReportById(db, reportId);
    if (!report || report.record_type === 'window') return sendError(res, 404, 'Report not found.', 'NOT_FOUND');

    if (!monthly1on1Db.canUserAccessReport(auth.user, report, 'view')) {
      return sendError(res, 403, 'You do not have permission to view attachments for this report.', 'FORBIDDEN');
    }

    const storageKey = url.searchParams.get('key');
    if (!storageKey || !storageKey.startsWith('monthly-1on1/')) {
      return sendError(res, 400, 'Invalid attachment storage key.', 'INVALID_KEY');
    }

    // Verify attachment ownership: key must belong to this specific report
    let keyBelongsToReport = false;
    if (report.items && typeof report.items === 'object') {
      const itemsJson = JSON.stringify(report.items);
      if (itemsJson.includes(storageKey)) {
        keyBelongsToReport = true;
      }
    }
    if (!keyBelongsToReport) {
      return sendError(res, 403, 'Access denied. The specified attachment does not belong to this report.', 'FORBIDDEN');
    }

    try {
      const stat = await fileStore.stat(storageKey);
      if (!stat.isFile()) return sendError(res, 404, 'Attachment file not found.', 'NOT_FOUND');

      const mime = safeMimeForName(storageKey);
      const isPdfOrImage = mime.startsWith('image/') || mime === 'application/pdf';
      const disposition = isPdfOrImage ? 'inline' : 'attachment';
      const filename = path.basename(storageKey);

      securityHeaders(res, false);
      // Strict Content Security Policy on preview to prevent untrusted files from running scripts under trusted origin
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, max-age=86400');
      res.setHeader('Content-Type', mime || 'application/octet-stream');
      res.setHeader('Content-Length', stat.size);
      res.setHeader('Content-Disposition', `${disposition}; filename="${encodeURIComponent(filename)}"`);

      if (req.method === 'HEAD') return res.end();
      const stream = fileStore.createReadStream(storageKey);
      stream.on('error', err => {
        if (!res.headersSent) sendError(res, 500, 'Failed to stream attachment.', 'SERVER_ERROR');
      });
      return stream.pipe(res);
    } catch (err) {
      return sendError(res, 404, 'Attachment file not found.', 'NOT_FOUND');
    }
  }

  /* POST /api/monthly-1on1/reports/:id/submit */
  match = pathname.match(/^\/api\/monthly-1on1\/reports\/([^/]+)\/submit$/);
  if (match && method === 'POST') {
    const auth = await requireAuth(req, res, { csrf: true });
    if (!auth) return;

    if (!monthly1on1Db.canSubmit1on1(auth.user)) {
      return sendError(res, 403, 'Super Admin cannot submit personal Monthly 1:1 reports.', 'FORBIDDEN');
    }

    const reportId = decodeURIComponent(match[1]);
    const report = await monthly1on1Db.getMonthly1on1ReportById(db, reportId);
    if (!report || report.record_type === 'window') return sendError(res, 404, 'Report not found.', 'NOT_FOUND');
    if (Number(report.employee_id) !== Number(auth.user.id)) return sendError(res, 403, 'You can only submit your own report.', 'FORBIDDEN');

// Resubmission of approved reports allowed while window remains open

    // Verify reporting window is open
    const windowInfo = await monthly1on1Db.getWindowForMonth(db, report.reporting_month);
    if (windowInfo.status !== 'open') {
      return sendError(res, 403, `Reporting window for ${report.reporting_month} is closed. Submissions are no longer permitted.`, 'WINDOW_CLOSED');
    }

    const body = await readJson(req);
    try {
      const updated = await monthly1on1Db.submitMonthly1on1Report(db, {
        reportId,
        acknowledged: Boolean(body.acknowledged || body.employee_acknowledged),
        sections: body.items || {
          completed_deliverables: body.completed_deliverables,
          pending_tasks: body.pending_tasks,
          challenges_support: body.challenges_support,
          responsibility_readiness: body.responsibility_readiness,
          improvement_suggestions: body.improvement_suggestions,
          monthly_priorities: body.monthly_priorities
        },
        headerUpdates: {
          meeting_date: body.meeting_date,
          work_location: body.work_location,
          current_projects: body.current_projects,
          overall_status: body.overall_status,
          capacity_for_additional_responsibilities: body.capacity_for_additional_responsibilities,
          additional_responsibility_details: body.additional_responsibility_details
        },
        auditUser: auth.user
      });
      return sendJson(res, 200, { report: updated });
    } catch (err) {
      return sendError(res, err.status || 400, err.message, err.code || 'VALIDATION');
    }
  }

  /* POST /api/monthly-1on1/reports/:id/approve — Super Admin or Service Admin only */
  match = pathname.match(/^\/api\/monthly-1on1\/reports\/([^/]+)\/approve$/);
  if (match && method === 'POST') {
    const auth = await requireAuth(req, res, { csrf: true });
    if (!auth) return;
    if (!monthly1on1Db.canApproveOrReject1on1(auth.user)) {
      return sendError(res, 403, 'Only Super Admin and Service Admin are authorized to approve reports.', 'FORBIDDEN');
    }

    const reportId = decodeURIComponent(match[1]);
    const body = await readJson(req);
    const feedbackText = cleanText(body.manager_feedback || body.comments, 5000);
    try {
      const updated = await monthly1on1Db.approveMonthly1on1Report(db, {
        reportId,
        adminUser: auth.user,
        comments: feedbackText,
        managerNotes: body.manager_notes || (feedbackText ? { additional_comments: feedbackText } : null)
      });
      return sendJson(res, 200, { report: updated });
    } catch (err) {
      return sendError(res, err.status || 400, err.message, err.code || 'VALIDATION');
    }
  }

  /* POST /api/monthly-1on1/reports/:id/reject — Super Admin or Service Admin only (requires reason) */
  match = pathname.match(/^\/api\/monthly-1on1\/reports\/([^/]+)\/reject$/);
  if (match && method === 'POST') {
    const auth = await requireAuth(req, res, { csrf: true });
    if (!auth) return;
    if (!monthly1on1Db.canApproveOrReject1on1(auth.user)) {
      return sendError(res, 403, 'Only Super Admin and Service Admin are authorized to reject reports.', 'FORBIDDEN');
    }

    const reportId = decodeURIComponent(match[1]);
    const body = await readJson(req);
    const reason = cleanText(body.manager_feedback || body.reason, 2000, true);
    if (!reason) {
      return sendError(res, 400, 'Manager feedback or rejection reason is required.', 'REJECTION_REASON_REQUIRED');
    }

    try {
      const updated = await monthly1on1Db.rejectMonthly1on1Report(db, {
        reportId,
        adminUser: auth.user,
        reason,
        comments: cleanText(body.comments || body.manager_feedback, 5000)
      });
      return sendJson(res, 200, { report: updated });
    } catch (err) {
      return sendError(res, err.status || 400, err.message, err.code || 'VALIDATION');
    }
  }

  /* POST /api/monthly-1on1/reports/:id/feedback — Director / Admin feedback */
  match = pathname.match(/^\/api\/monthly-1on1\/reports\/([^/]+)\/feedback$/);
  if (match && method === 'POST') {
    const auth = await requireAuth(req, res, { csrf: true });
    if (!auth) return;

    const reportId = decodeURIComponent(match[1]);
    const body = await readJson(req);
    const feedbackText = cleanText(body.feedback, 5000, true);
    if (!feedbackText) {
      return sendError(res, 400, 'Director feedback content is required.', 'FEEDBACK_REQUIRED');
    }

    try {
      const updated = await monthly1on1Db.saveDirectorFeedback(db, {
        reportId,
        directorUser: auth.user,
        feedback: feedbackText,
        recommendations: cleanText(body.recommendations, 5000),
        improvements: cleanText(body.improvements, 5000),
        remarks: cleanText(body.remarks, 5000)
      });
      return sendJson(res, 200, { ok: true, report: updated });
    } catch (err) {
      return sendError(res, err.status || 400, err.message, err.code || 'VALIDATION');
    }
  }

  /* POST /api/monthly-1on1/reports/:id/start-review */
  match = pathname.match(/^\/api\/monthly-1on1\/reports\/([^/]+)\/start-review$/);
  if (match && method === 'POST') {
    const auth = await requireAuth(req, res, { csrf: true });
    if (!auth) return;
    const reportId = decodeURIComponent(match[1]);
    const report = await monthly1on1Db.getMonthly1on1ReportById(db, reportId);
    if (!report || report.record_type === 'window') return sendError(res, 404, 'Report not found.', 'NOT_FOUND');

    if (!monthly1on1Db.canReviewAll1on1Reports(auth.user)) {
      return sendError(res, 403, 'You do not have permission to review this report.', 'FORBIDDEN');
    }

    try {
      const updated = await monthly1on1Db.startMonthly1on1Review(db, {
        reportId,
        reviewerId: auth.user.id,
        reviewerName: auth.user.name,
        auditUser: auth.user
      });
      return sendJson(res, 200, { report: updated });
    } catch (err) {
      return sendError(res, err.status || 400, err.message, err.code || 'VALIDATION');
    }
  }

  /* PATCH /api/monthly-1on1/reports/:id/notes — save review notes in progress */
  match = pathname.match(/^\/api\/monthly-1on1\/reports\/([^/]+)\/notes$/);
  if (match && method === 'PATCH') {
    const auth = await requireAuth(req, res, { csrf: true });
    if (!auth) return;
    const reportId = decodeURIComponent(match[1]);
    const report = await monthly1on1Db.getMonthly1on1ReportById(db, reportId);
    if (!report || report.record_type === 'window') return sendError(res, 404, 'Report not found.', 'NOT_FOUND');

    if (!monthly1on1Db.canReviewAll1on1Reports(auth.user)) {
      return sendError(res, 403, 'You do not have permission to update notes on this report.', 'FORBIDDEN');
    }

    const body = await readJson(req);
    const notes = body.manager_notes || body;
    try {
      const updated = await monthly1on1Db.saveMonthly1on1ReviewNotes(db, {
        reportId,
        managerNotes: {
          key_observation: cleanText(notes.key_observation, 5000),
          final_responsibility_assigned: cleanText(notes.final_responsibility_assigned || notes.final_responsibility, 5000),
          meeting_date: validDate(notes.meeting_date) ? notes.meeting_date : (validDate(notes.deadline) ? notes.deadline : (validDate(notes.follow_up_date) ? notes.follow_up_date : null)),
          follow_up_date: validDate(notes.meeting_date) ? notes.meeting_date : (validDate(notes.deadline) ? notes.deadline : (validDate(notes.follow_up_date) ? notes.follow_up_date : null)),
          deadline: validDate(notes.meeting_date) ? notes.meeting_date : (validDate(notes.deadline) ? notes.deadline : (validDate(notes.follow_up_date) ? notes.follow_up_date : null)),
          additional_comments: cleanText(notes.additional_comments, 5000)
        },
        reviewerId: auth.user.id,
        auditUser: auth.user
      });
      return sendJson(res, 200, { report: updated });
    } catch (err) {
      return sendError(res, err.status || 400, err.message, err.code || 'VALIDATION');
    }
  }

  /* POST /api/monthly-1on1/reports/:id/request-revision */
  match = pathname.match(/^\/api\/monthly-1on1\/reports\/([^/]+)\/request-revision$/);
  if (match && method === 'POST') {
    const auth = await requireAuth(req, res, { csrf: true });
    if (!auth) return;
    const reportId = decodeURIComponent(match[1]);
    const report = await monthly1on1Db.getMonthly1on1ReportById(db, reportId);
    if (!report || report.record_type === 'window') return sendError(res, 404, 'Report not found.', 'NOT_FOUND');

    if (!monthly1on1Db.canReviewAll1on1Reports(auth.user)) {
      return sendError(res, 403, 'You do not have permission to request revision for this report.', 'FORBIDDEN');
    }

    const body = await readJson(req);
    try {
      const updated = await monthly1on1Db.requestMonthly1on1Revision(db, {
        reportId,
        reason: cleanText(body.reason, 2000, true),
        auditUser: auth.user
      });
      return sendJson(res, 200, { report: updated });
    } catch (err) {
      return sendError(res, err.status || 400, err.message, err.code || 'VALIDATION');
    }
  }

  /* POST /api/monthly-1on1/reports/:id/finalize */
  match = pathname.match(/^\/api\/monthly-1on1\/reports\/([^/]+)\/finalize$/);
  if (match && method === 'POST') {
    const auth = await requireAuth(req, res, { csrf: true });
    if (!auth) return;
    const reportId = decodeURIComponent(match[1]);
    const report = await monthly1on1Db.getMonthly1on1ReportById(db, reportId);
    if (!report || report.record_type === 'window') return sendError(res, 404, 'Report not found.', 'NOT_FOUND');

    if (!monthly1on1Db.canReviewAll1on1Reports(auth.user)) {
      return sendError(res, 403, 'You do not have permission to finalize this report.', 'FORBIDDEN');
    }

    const body = await readJson(req);
    const notes = body.manager_notes || body;
    try {
      const updated = await monthly1on1Db.finalizeMonthly1on1Report(db, {
        reportId,
        managerNotes: {
          key_observation: cleanText(notes.key_observation, 5000),
          final_responsibility_assigned: cleanText(notes.final_responsibility_assigned || notes.final_responsibility, 5000),
          meeting_date: validDate(notes.meeting_date) ? notes.meeting_date : (validDate(notes.deadline) ? notes.deadline : (validDate(notes.follow_up_date) ? notes.follow_up_date : null)),
          follow_up_date: validDate(notes.meeting_date) ? notes.meeting_date : (validDate(notes.deadline) ? notes.deadline : (validDate(notes.follow_up_date) ? notes.follow_up_date : null)),
          deadline: validDate(notes.meeting_date) ? notes.meeting_date : (validDate(notes.deadline) ? notes.deadline : (validDate(notes.follow_up_date) ? notes.follow_up_date : null)),
          additional_comments: cleanText(notes.additional_comments, 5000)
        },
        reviewerAcknowledged: Boolean(body.reviewer_acknowledged),
        reviewerId: auth.user.id,
        reviewerName: auth.user.name,
        auditUser: auth.user
      });
      return sendJson(res, 200, { report: updated });
    } catch (err) {
      return sendError(res, err.status || 400, err.message, err.code || 'VALIDATION');
    }
  }

  /* POST /api/monthly-1on1/reports/:id/reopen */
  match = pathname.match(/^\/api\/monthly-1on1\/reports\/([^/]+)\/reopen$/);
  if (match && method === 'POST') {
    const auth = await requireAuth(req, res, { csrf: true });
    if (!auth) return;
    const reportId = decodeURIComponent(match[1]);
    const report = await monthly1on1Db.getMonthly1on1ReportById(db, reportId);
    if (!report || report.record_type === 'window') return sendError(res, 404, 'Report not found.', 'NOT_FOUND');

    if (!monthly1on1Db.canReviewAll1on1Reports(auth.user)) {
      return sendError(res, 403, 'You do not have permission to reopen this report.', 'FORBIDDEN');
    }

    const body = await readJson(req);
    try {
      const updated = await monthly1on1Db.reopenMonthly1on1Report(db, {
        reportId,
        reason: cleanText(body.reason, 2000, true),
        auditUser: auth.user
      });
      return sendJson(res, 200, { report: updated });
    } catch (err) {
      return sendError(res, err.status || 400, err.message, err.code || 'VALIDATION');
    }
  }

  /* GET /api/monthly-1on1/team-reports — Admin view: Only Super Admin and Service Admin */
  if (method === 'GET' && pathname === '/api/monthly-1on1/team-reports') {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    if (!monthly1on1Db.canReviewAll1on1Reports(auth.user)) {
      return sendError(res, 403, 'Access denied. Only Super Admin and Service Admin are authorized to access the Administrative Dashboard.', 'FORBIDDEN');
    }



    const year = Number(url.searchParams.get('year') || new Date().getFullYear());
    const month = Number(url.searchParams.get('month') || 0);
    const status = url.searchParams.get('status') || '';
    const q = (url.searchParams.get('q') || '').trim();
    const department = (url.searchParams.get('department') || '').trim();
    const page = Math.max(1, Number(url.searchParams.get('page') || 1));
    const limit = 20;
    const offset = (page - 1) * limit;

    // Draft reports must remain private to respective employees only
    let baseScope = `WHERE record_type='report' AND employee_id > 0 AND status != 'Draft'`;
    const baseParams = [];
    if (year) { baseScope += ' AND YEAR(reporting_month)=?'; baseParams.push(year); }
    if (month) { baseScope += ' AND MONTH(reporting_month)=?'; baseParams.push(month); }
    if (department) { baseScope += ' AND department=?'; baseParams.push(department); }

    // Summary calculation for all eligible employees
    const statsRow = await db.get(
      `SELECT
         COUNT(DISTINCT employee_id) AS distinct_employees,
         COUNT(CASE WHEN status='Submitted' THEN 1 END) AS submitted,
         COUNT(CASE WHEN status='Draft' THEN 1 END) AS draft,
         COUNT(CASE WHEN status='Under Review' THEN 1 END) AS under_review,
         COUNT(CASE WHEN status='Completed' THEN 1 END) AS completed,
         COUNT(CASE WHEN status='Approved' THEN 1 END) AS approved,
         COUNT(CASE WHEN status='Rejected' THEN 1 END) AS rejected,
         COUNT(CASE WHEN status='Revision Requested' THEN 1 END) AS revision_requested
       FROM monthly_1on1_reports ${baseScope}`,
      baseParams
    );

    // Headcount metric: Total Employees of Mypreneur (all active employees)
    // Pending denominator: Expected applicants (active employees excluding Super Admin)
    let totalEmployeesOfMypreneur = 0;
    let totalExpectedApplicants = 0;
    try {
      const allEmps = await getEmployeesList(db);
      totalEmployeesOfMypreneur = allEmps.length;
      totalExpectedApplicants = allEmps.filter(e => !['admin'].includes(e.role) && !monthly1on1Db.isSuperAdmin(e)).length;
      if (totalExpectedApplicants === 0) totalExpectedApplicants = totalEmployeesOfMypreneur;
    } catch {
      totalEmployeesOfMypreneur = Math.max(Number(statsRow?.distinct_employees || 0), 1);
      totalExpectedApplicants = totalEmployeesOfMypreneur;
    }

    const approvedCount = Number(statsRow?.approved || 0);
    const rejectedCount = Number(statsRow?.rejected || 0);
    const submittedCount = Number(statsRow?.submitted || 0);
    const completedCount = Number(statsRow?.completed || 0);
    const underReviewCount = Number(statsRow?.under_review || 0);
    const revisionCount = Number(statsRow?.revision_requested || 0);

    const totalSubmittedApplications = submittedCount + underReviewCount + completedCount + approvedCount + rejectedCount;
    const pendingApplications = Math.max(0, totalExpectedApplicants - totalSubmittedApplications);
    const submissionRate = totalExpectedApplicants > 0 ? Math.min(100, Math.round((totalSubmittedApplications / totalExpectedApplicants) * 100)) : 0;

    const summary = {
      total_employees_mypreneur: totalEmployeesOfMypreneur,
      total_eligible_employees: totalEmployeesOfMypreneur, // Compatibility alias
      total_expected_applicants: totalExpectedApplicants,
      applications_submitted: totalSubmittedApplications,
      pending_applications: pendingApplications,
      approved_applications: approvedCount,
      rejected_applications: rejectedCount,
      submission_percentage: submissionRate,
      under_review: underReviewCount,
      revision_requested: revisionCount,
      // Compatibility aliases
      total_team_members: totalEmployeesOfMypreneur,
      submitted: totalSubmittedApplications,
      pending_submission: pendingApplications,
      completed: approvedCount + completedCount
    };

    let whereClause = baseScope;
    const filterParams = [...baseParams];
    if (status && VALID_1ON1_STATUSES.includes(status)) {
      whereClause += ' AND status=?';
      filterParams.push(status);
    }
    if (q) {
      whereClause += ' AND (employee_name LIKE ? OR department LIKE ?)';
      filterParams.push(`%${q}%`, `%${q}%`);
    }

    const rows = await db.all(
      `SELECT id, employee_id, employee_name, department, reviewer_id, reviewer_name, director_name, reporting_month, meeting_date, submitted_at, approved_at, approved_by_name, rejected_at, rejected_by_name, rejection_reason, overall_status, status, updated_at, manager_notes_json
       FROM monthly_1on1_reports ${whereClause}
       ORDER BY reporting_month DESC, submitted_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      filterParams
    );
    const countRow = await db.get(`SELECT COUNT(*) AS total FROM monthly_1on1_reports ${whereClause}`, filterParams);
    const reports = (rows || []).map(r => {
      let notes = null;
      try {
        notes = r.manager_notes_json ? (typeof r.manager_notes_json === 'string' ? JSON.parse(r.manager_notes_json) : r.manager_notes_json) : null;
      } catch (e) {}
      return {
        ...r,
        manager_notes: notes
      };
    });
    return sendJson(res, 200, {
      reports,
      total: Number(countRow?.total || 0),
      page,
      limit,
      summary
    });
  }

  /* GET /api/monthly-1on1/reviewers — eligible managers/admins for assignment */
  if (method === 'GET' && pathname === '/api/monthly-1on1/reviewers') {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    if (!monthly1on1Db.canReviewAll1on1Reports(auth.user)) return sendError(res, 403, 'Forbidden.', 'FORBIDDEN');

    const tUsers = authProvider.schema.usersTable;
    const tEmployees = authProvider.schema.employeesTable;

    const rows = await db.all(
      `SELECT u.user_id AS id
       FROM ${tUsers} u
       LEFT JOIN ${tEmployees} e ON e.employee_id=u.employee_id
       WHERE u.is_active=1 AND (e.status IS NULL OR UPPER(e.status)='ACTIVE')`
    );

    const reviewers = [];
    for (const r of (rows || [])) {
      try {
        const u = await authProvider.findById(r.id);
        if (u && monthly1on1Db.canReviewAll1on1Reports(u)) {
          reviewers.push({
            id: u.id,
            name: u.name,
            username: u.username,
            role: u.role,
            team: u.team
          });
        }
      } catch {}
    }
    reviewers.sort((a, b) => a.name.localeCompare(b.name));
    return sendJson(res, 200, { reviewers });
  }

  /* POST /api/monthly-1on1/reports/:id/assign-reviewer — assign/reassign manager */
  match = pathname.match(/^\/api\/monthly-1on1\/reports\/([^/]+)\/assign-reviewer$/);
  if (match && method === 'POST') {
    const auth = await requireAuth(req, res, { csrf: true });
    if (!auth) return;
    if (!monthly1on1Db.canReviewAll1on1Reports(auth.user)) {
      return sendError(res, 403, 'Only Super Admin and Service Admin can assign or reassign reporting managers.', 'FORBIDDEN');
    }

    const reportId = decodeURIComponent(match[1]);
    const body = await readJson(req);
    const reviewerId = body.reviewer_id ? Number(body.reviewer_id) : null;
    let reviewerName = '';

    if (reviewerId) {
      const userRecord = await authProvider.findById(reviewerId);
      if (!userRecord) return sendError(res, 404, 'Reviewer user not found.', 'NOT_FOUND');
      reviewerName = userRecord.name;
    }

    try {
      const updated = await monthly1on1Db.assignMonthly1on1Reviewer(db, {
        reportId,
        reviewerId,
        reviewerName,
        auditUser: auth.user
      });
      return sendJson(res, 200, { report: updated });
    } catch (err) {
      return sendError(res, err.status || 400, err.message, err.code || 'VALIDATION');
    }
  }

  /* GET /api/monthly-1on1/export/:id — printable report */
  match = pathname.match(/^\/api\/monthly-1on1\/export\/([^/]+)$/);
  if (match && method === 'GET') {
    const auth = await requireAuth(req, res);
    if (!auth) return;
    const reportId = decodeURIComponent(match[1]);
    const report = await monthly1on1Db.getMonthly1on1ReportById(db, reportId);
    if (!report || report.record_type === 'window') return sendError(res, 404, 'Report not found.', 'NOT_FOUND');

    if (!monthly1on1Db.canUserAccessReport(auth.user, report, 'view')) {
      return sendError(res, 403, 'Access denied.', 'FORBIDDEN');
    }

    const format = url.searchParams.get('format');
    const acceptHeader = req.headers['accept'] || '';
    const wantsHtml = format === 'html' || (acceptHeader.includes('text/html') && !acceptHeader.includes('application/json') && format !== 'json');

    if (wantsHtml) {
      securityHeaders(res, false);
      const html = monthly1on1Db.renderMonthly1on1PrintHtml(report);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache'
      });
      res.end(html);
      return;
    }

    return sendJson(res, 200, { report });
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

  // Explicitly block all dotfiles and hidden paths (.env, .git, .htaccess, etc.)
  const segments = relative.split('/');
  if (segments.some(seg => seg.startsWith('.') && seg !== '.' && seg !== '..')) {
    return sendError(res, 403, 'Access to hidden resources is forbidden.', 'FORBIDDEN');
  }

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
  res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self' wss:; media-src 'self' blob: data:; img-src 'self' data: blob:; font-src 'self' https://fonts.gstatic.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; script-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
  res.writeHead(200, {
    'Content-Type': staticMime(file),
    'Content-Length': stat.size,
    'Cache-Control': (file.endsWith('.html') || file.endsWith('.js') || file.endsWith('.css')) ? 'no-cache, no-store, must-revalidate, max-age=0' : 'public, max-age=3600'
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
  chatService = new ChatService(db, fileStore);
  handleChatApi = registerChatRoutes({ db, fileStore, chatService, requireAuth, sendJson, sendError, readJson, cleanText, securityHeaders });


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
        const isDbError = Boolean(error.code && (String(error.code).startsWith('ER_') || error.code === 'PROTOCOL_CONNECTION_LOST'));
        const safeMessage = (status >= 500 || isDbError)
          ? 'Server error. Please try again.'
          : (error.message || 'Validation error.');
        sendError(res, isDbError ? 500 : status, safeMessage, status >= 500 || isDbError ? 'SERVER_ERROR' : (error.code || 'VALIDATION'));
      } else {
        res.end();
      }
    }
  });

  server.headersTimeout = 65000;
  server.requestTimeout = 60000;
  server.keepAliveTimeout = 61000;

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
