'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  try {
    if (typeof process.loadEnvFile === 'function') {
      process.loadEnvFile(envPath);
    } else {
      const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
          const idx = trimmed.indexOf('=');
          const key = trimmed.slice(0, idx).trim();
          const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
          if (key && process.env[key] === undefined) {
            process.env[key] = val;
          }
        }
      }
    }
  } catch (e) {}
}

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
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (category === 'Policies') return user.role === 'hr_admin';
  return (user.role === 'team_admin' || user.role === 'hr_admin') && category === user.team;
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
  const name = path.basename(cleanText(file.name, 180, true));
  const extension = path.extname(name).toLowerCase();
  if (!FILE_EXTENSIONS.has(extension)) throw Object.assign(new Error('This file type is not allowed.'), { status: 400 });
  const data = String(file.data || '');
  const match = data.match(/^data:([^;,]*);base64,([A-Za-z0-9+/=\r\n]+)$/);
  if (!match) throw Object.assign(new Error('The uploaded document could not be read.'), { status: 400 });
  const buffer = Buffer.from(match[2].replace(/[\r\n]/g, ''), 'base64');
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

async function bootstrapPayload(auth) {
  const [links, eventRows, announcementRows] = await Promise.all([
    listVisibleLinks(auth.user),
    db.all(`SELECT id,title,date,time,type,location,notes,created_at,updated_at
      FROM events ORDER BY date ASC,time ASC,created_at ASC`),
    db.all(`SELECT id,title,date,time,body,kind,link,file_name,file_type,file_size,author,created_at,updated_at
      FROM announcements ORDER BY date DESC,time DESC,created_at DESC`)
  ]);
  return {
    user: auth.user,
    csrfToken: auth.csrf,
    links,
    events: eventRows.map(serializeEvent),
    announcements: announcementRows.map(serializeAnnouncement),
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
      return sendError(res, 401, 'Invalid username, password, role, or team assignment.', 'INVALID_CREDENTIALS');
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
