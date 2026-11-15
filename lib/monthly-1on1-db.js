'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

const VALID_1ON1_STATUSES = Object.freeze([
  'Draft',
  'Submitted',
  'Under Review',
  'Revision Requested',
  'Completed',
  'Approved',
  'Rejected'
]);

const VALID_1ON1_OVERALL_STATUSES = Object.freeze([
  'On Track',
  'Needs Attention',
  'Delayed',
  'At Risk'
]);

const VALID_1ON1_CAPACITY = Object.freeze([
  'Yes',
  'No',
  'Partially'
]);

const VALID_1ON1_SECTIONS = Object.freeze([
  'completed_deliverables',
  'pending_tasks',
  'challenges_support',
  'responsibility_readiness',
  'improvement_suggestions',
  'monthly_priorities'
]);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function nowIso() {
  return new Date().toISOString();
}

function isValidUuid(value) {
  return typeof value === 'string' && UUID_REGEX.test(value.trim());
}

/* ==========================================================================
   ROLE CAPABILITY HELPERS (RBAC)
   Strictly enforces Super Admin vs Service Admin vs Employee permissions
   ========================================================================== */

function isServiceAdmin(user) {
  if (!user) return false;
  if (user.isServiceAdmin) return true;
  if (user.role === 'service_admin') return true;
  if (Array.isArray(user.sourceRoles)) {
    return user.sourceRoles.some(r => {
      const s = String(r || '').toLowerCase().trim();
      return s === 'service admin' || s === 'service_admin' || s === 'service.admin';
    });
  }
  return false;
}

function isSuperAdmin(user) {
  if (!user) return false;
  if (user.isSuperAdmin) return true;
  if (isServiceAdmin(user)) return false;
  if (user.role === 'admin') return true;
  if (Array.isArray(user.sourceRoles)) {
    return user.sourceRoles.some(r => {
      const s = String(r || '').toLowerCase().trim();
      return s === 'admin' || s === 'super admin' || s === 'super_admin' || s === 'superadmin' || s === 'super.admin';
    });
  }
  return false;
}

function isExecutiveLeadership(user) {
  if (!user) return false;
  const rawRoles = process.env.PORTAL_EXECUTIVE_VIEW_ROLES || process.env.PORTAL_EXECUTIVE_ROLES || 'CEO,Director,Managing Director';
  const allowed = rawRoles.split(',').map(r => r.trim().toLowerCase()).filter(Boolean);

  const title = String(user.title || user.designation || user.role || '').toLowerCase().trim();
  const username = String(user.username || user.user || '').toLowerCase().trim();
  const sourceRoles = Array.isArray(user.sourceRoles)
    ? user.sourceRoles.map(r => String(r).toLowerCase().trim())
    : [];

  return allowed.some(role => title.includes(role) || username === role || username.includes(role) || sourceRoles.some(sr => sr.includes(role)));
}

function canConfigure1on1Window(user) {
  return isSuperAdmin(user) || isExecutiveLeadership(user);
}

function canReviewAll1on1Reports(user) {
  // Only CEO, Director, and Managing Director can view and review all employee reports.
  // Super Admin and Service Admin are strictly restricted from viewing all employee applications.
  return isExecutiveLeadership(user);
}

function canSubmit1on1(user) {
  if (!user) return false;
  return true;
}

function canView1on1Report(user, report) {
  if (!user || !report) return false;
  if (canReviewAll1on1Reports(user)) return true;
  return Number(report.employee_id) === Number(user.id);
}

function canEdit1on1Report(user, report, windowStatus = 'open') {
  if (!user || !report) return false;
  if (Number(report.employee_id) !== Number(user.id)) return false;
  if (report.status === 'Approved') return false;
  return windowStatus === 'open';
}

function canApproveOrReject1on1(user, report = null) {
  if (!user) return false;
  if (!canReviewAll1on1Reports(user)) return false;
  if (report && Number(report.employee_id) === Number(user.id)) return false;
  return true;
}

/* ==========================================================================
   TIMEZONE (Asia/Kolkata) & REPORTING WINDOW HELPERS
   ========================================================================== */

function parseIstToIso(dateStr, timeStr = '00:00') {
  const d = String(dateStr || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    const error = new Error(`Invalid date format: "${dateStr}". Expected YYYY-MM-DD.`);
    error.status = 400;
    throw error;
  }
  let t = String(timeStr || '00:00').trim();
  if (t.length === 5) t = `${t}:00`;
  if (!/^\d{2}:\d{2}:\d{2}$/.test(t)) {
    const error = new Error(`Invalid time format: "${timeStr}". Expected HH:MM or HH:MM:SS.`);
    error.status = 400;
    throw error;
  }
  const istString = `${d}T${t}+05:30`;
  const parsed = new Date(istString);
  if (isNaN(parsed.getTime())) {
    const error = new Error(`Invalid date/time for Asia/Kolkata: ${dateStr} ${timeStr}`);
    error.status = 400;
    throw error;
  }
  return parsed.toISOString();
}

function formatIsoToIst(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  }).format(d) + ' IST';
}

let simulatedTimeMs = null;

function setSimulatedClock(isoStringOrNull) {
  if (!isoStringOrNull) {
    simulatedTimeMs = null;
  } else {
    simulatedTimeMs = new Date(isoStringOrNull).getTime();
  }
}

function getEffectiveTimeMs(overrideNow = null) {
  if (overrideNow !== null && overrideNow !== undefined) {
    return new Date(overrideNow).getTime();
  }
  if (simulatedTimeMs !== null) {
    return simulatedTimeMs;
  }
  return Date.now();
}

function calculateWindowStatus(window, overrideNow = null) {
  if (!window || !window.window_start || !window.window_end) {
    return 'no_window';
  }
  const now = getEffectiveTimeMs(overrideNow);
  const start = new Date(window.window_start).getTime();
  const end = new Date(window.window_end).getTime();

  // 1. If past configured end date, it is always closed
  if (now > end) {
    return 'closed';
  }

  // 2. Manual close override: if status is Closed, it remains closed even if within start/end dates
  if (window.status === 'Closed' || window.status === 'closed') {
    return 'closed';
  }

  // 3. Manual open override: if explicitly marked Open and reopened_at is set, it remains open until end date or manual close
  if ((window.status === 'Open' || window.status === 'open') && window.reopened_at && new Date(window.reopened_at).getTime() <= now) {
    return 'open';
  }

  // 4. Automatic schedule evaluation:
  if (now < start) {
    return 'upcoming';
  }
  return 'open';
}

function isWindowPastEndDate(window, overrideNow = null) {
  if (!window || !window.window_end) return false;
  return getEffectiveTimeMs(overrideNow) > new Date(window.window_end).getTime();
}

/* ==========================================================================
   DIRECTOR ASSIGNMENT & ATTACHMENT INSPECTION
   ========================================================================== */

function getAssignedDirector(employeeId, env = process.env) {
  if (env.PORTAL_DIRECTOR_NAME) return String(env.PORTAL_DIRECTOR_NAME).trim();
  return 'Managing Director';
}

function inspectProofBuffer(buffer, originalName) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    const error = new Error('File buffer is empty.');
    error.status = 400;
    throw error;
  }
  if (buffer.length > 10 * 1024 * 1024) {
    const error = new Error('File exceeds the 10 MB limit.');
    error.status = 400;
    throw error;
  }

  const ext = path.extname(originalName || '').toLowerCase();
  const allowedExts = new Set(['.jpg', '.jpeg', '.png', '.webp', '.pdf']);
  if (!allowedExts.has(ext)) {
    const error = new Error('Unsupported file format. Only JPG, PNG, WEBP, and PDF files are permitted.');
    error.status = 400;
    throw error;
  }

  const headText = buffer.slice(0, 1024).toString('utf8').toLowerCase();
  if (headText.includes('<script') || headText.includes('<svg') || headText.includes('<html') || headText.includes('<?php')) {
    const error = new Error('File content failed security validation.');
    error.status = 400;
    throw error;
  }

  if (ext === '.pdf') {
    if (buffer.length < 5 || buffer[0] !== 0x25 || buffer[1] !== 0x50 || buffer[2] !== 0x44 || buffer[3] !== 0x46 || buffer[4] !== 0x2D) {
      const error = new Error('Invalid PDF file signature.');
      error.status = 400;
      throw error;
    }
    return { mimeType: 'application/pdf', extension: '.pdf' };
  }

  if (ext === '.png') {
    if (buffer.length < 8 || buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4E || buffer[3] !== 0x47 || buffer[4] !== 0x0D || buffer[5] !== 0x0A || buffer[6] !== 0x1A || buffer[7] !== 0x0A) {
      const error = new Error('Invalid PNG file signature.');
      error.status = 400;
      throw error;
    }
    return { mimeType: 'image/png', extension: '.png' };
  }

  if (ext === '.jpg' || ext === '.jpeg') {
    if (buffer.length < 3 || buffer[0] !== 0xFF || buffer[1] !== 0xD8 || buffer[2] !== 0xFF) {
      const error = new Error('Invalid JPEG file signature.');
      error.status = 400;
      throw error;
    }
    return { mimeType: 'image/jpeg', extension: '.jpg' };
  }

  if (ext === '.webp') {
    if (buffer.length < 12 ||
        buffer[0] !== 0x52 || buffer[1] !== 0x49 || buffer[2] !== 0x46 || buffer[3] !== 0x46 ||
        buffer[8] !== 0x57 || buffer[9] !== 0x45 || buffer[10] !== 0x42 || buffer[11] !== 0x50) {
      const error = new Error('Invalid WEBP file signature.');
      error.status = 400;
      throw error;
    }
    return { mimeType: 'image/webp', extension: '.webp' };
  }

  const error = new Error('Invalid file signature.');
  error.status = 400;
  throw error;
}

/**
 * Normalizes reporting month to the first day of the calendar month (YYYY-MM-01).
 * Supports YYYY-MM and YYYY-MM-DD input formats.
 */
function normalizeReportingMonth(dateInput) {
  if (!dateInput) {
    const error = new Error('reporting_month is required.');
    error.code = 'INVALID_MONTH';
    error.status = 400;
    throw error;
  }
  const raw = String(dateInput).trim().slice(0, 10);
  const match = raw.match(/^(\d{4})-(\d{2})(?:-\d{2})?$/);
  if (!match) {
    const error = new Error(`Invalid reporting_month format: "${dateInput}". Expected YYYY-MM or YYYY-MM-DD.`);
    error.code = 'INVALID_MONTH_FORMAT';
    error.status = 400;
    throw error;
  }
  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  if (year < 2020 || year > 2100 || month < 1 || month > 12) {
    const error = new Error(`reporting_month out of acceptable range: "${dateInput}".`);
    error.code = 'MONTH_OUT_OF_RANGE';
    error.status = 400;
    throw error;
  }
  return `${match[1]}-${match[2]}-01`;
}

/**
 * Validates a single repeatable item against its section schema.
 * Rejects unknown sections or invalid structures.
 */
function validateSectionItem(sectionKey, itemData) {
  if (!VALID_1ON1_SECTIONS.includes(sectionKey)) {
    const error = new Error(`Unsupported section key: "${sectionKey}".`);
    error.code = 'INVALID_SECTION_KEY';
    error.status = 400;
    throw error;
  }
  if (!itemData || typeof itemData !== 'object' || Array.isArray(itemData)) {
    const error = new Error(`Item data for section "${sectionKey}" must be an object.`);
    error.code = 'INVALID_ITEM_DATA';
    error.status = 400;
    throw error;
  }

  const sanitized = {};
  switch (sectionKey) {
    case 'completed_deliverables':
      sanitized.task = String(itemData.task || '').trim().slice(0, 5000);
      sanitized.target_given = String(itemData.target_given || '').trim().slice(0, 5000);
      sanitized.actual_completion = String(itemData.actual_completion || '').trim().slice(0, 5000);
      sanitized.impact_result = String(itemData.impact_result || '').trim().slice(0, 5000);
      let pLink = String(itemData.proof_link || itemData.proof?.link || (itemData.proof?.type === 'link' ? itemData.proof.url : '') || '').trim().slice(0, 2048);
      let pFile = null;

      if (itemData.proof && typeof itemData.proof === 'object') {
        const fileCandidate = itemData.proof.file || (itemData.proof.type === 'file' ? itemData.proof : null);
        if (fileCandidate && typeof fileCandidate === 'object' && fileCandidate.storage_key) {
          pFile = {
            type: 'file',
            original_name: String(fileCandidate.original_name || '').slice(0, 255),
            storage_key: String(fileCandidate.storage_key || '').slice(0, 255),
            mime_type: String(fileCandidate.mime_type || '').slice(0, 100),
            size: Number(fileCandidate.size || 0)
          };
        }
        if (!pLink && (itemData.proof.link || itemData.proof.url)) {
          pLink = String(itemData.proof.link || itemData.proof.url).trim().slice(0, 2048);
        }
      }

      sanitized.proof_link = (pLink && /^https?:\/\//i.test(pLink)) ? pLink : '';
      sanitized.proof = {
        link: sanitized.proof_link || null,
        file: pFile || null
      };
      if (!sanitized.proof.link && !sanitized.proof.file) {
        sanitized.proof = null;
      }
      break;

    case 'pending_tasks':
      sanitized.task = String(itemData.task || '').trim().slice(0, 5000);
      sanitized.reason_for_delay = String(itemData.reason_for_delay || '').trim().slice(0, 5000);
      sanitized.current_status = String(itemData.current_status || '').trim().slice(0, 5000);
      sanitized.support_needed = String(itemData.support_needed || '').trim().slice(0, 5000);
      sanitized.expected_completion_date = String(itemData.expected_completion_date || '').trim().slice(0, 30);
      break;

    case 'challenges_support':
      sanitized.major_challenge = String(itemData.major_challenge || '').trim().slice(0, 5000);
      sanitized.support_required = String(itemData.support_required || '').trim().slice(0, 5000);
      break;

    case 'responsibility_readiness':
      sanitized.current_responsibilities = String(itemData.current_responsibilities || '').trim().slice(0, 5000);
      sanitized.next_responsibilities = String(itemData.next_responsibilities || '').trim().slice(0, 5000);
      sanitized.clarity_required = String(itemData.clarity_required || '').trim().slice(0, 5000);
      break;

    case 'improvement_suggestions':
      sanitized.suggestion = String(itemData.suggestion || '').trim().slice(0, 5000);
      break;

    case 'monthly_priorities':
      const pNum = Number(itemData.priority_number);
      if (![1, 2, 3].includes(pNum)) {
        const error = new Error('Priority number must be 1, 2, or 3.');
        error.code = 'INVALID_PRIORITY_NUMBER';
        error.status = 400;
        throw error;
      }
      sanitized.priority_number = pNum;
      sanitized.description = String(itemData.description || '').trim().slice(0, 5000);
      break;
  }

  return sanitized;
}

/**
 * Audit logger writing to audit_logs (rewritten via table rewriter to connect_audit_logs).
 * Safe execution: errors do not break user workflow.
 */
async function log1on1Audit(db, { userId = null, action, reportId = null, details = '' }) {
  try {
    await db.run(
      `INSERT INTO audit_logs (user_id, action, entity, entity_id, details, created_at)
       VALUES (?, ?, 'monthly_1on1', ?, ?, ?)`,
      [userId || null, String(action).slice(0, 80), reportId ? String(reportId).slice(0, 100) : null, String(details || '').slice(0, 950), nowIso()]
    );
  } catch (e) {
    // Non-blocking by design
  }
}

function isDirectorRole(user) {
  if (!user) return false;
  const userTitle = String(user.title || user.designation || '').toLowerCase();
  if (userTitle.includes('director')) return true;
  if (Array.isArray(user.sourceRoles) && user.sourceRoles.some(r => String(r).toLowerCase().includes('director'))) return true;
  return false;
}

function canDirectorGiveFeedback(user, report) {
  if (!user || !report) return false;
  if (canReviewAll1on1Reports(user)) return true;
  if (!isDirectorRole(user)) return false;

  const userName = String(user.name || '').trim().toLowerCase();
  const userLogin = String(user.username || '').trim().toLowerCase();
  const dirName = String(report.director_name || '').trim().toLowerCase();
  const revName = String(report.reviewer_name || '').trim().toLowerCase();
  const reviewerId = Number(report.reviewer_id || 0);

  if (reviewerId && reviewerId === Number(user.id)) return true;
  if (userName && dirName && dirName !== 'managing director' && dirName !== 'director' && dirName.includes(userName)) return true;
  if (userLogin && dirName && dirName !== 'managing director' && dirName !== 'director' && dirName.includes(userLogin)) return true;
  if (userName && revName && revName.includes(userName)) return true;
  if (userLogin && revName && revName.includes(userLogin)) return true;

  const userTitle = String(user.title || user.designation || '').toLowerCase();
  if (dirName === 'managing director' && userTitle.includes('managing director')) return true;

  return false;
}

function canUserAccessReport(user, report, action = 'view') {
  if (!user || !report) return false;
  const isOwner = Number(report.employee_id) === Number(user.id);
  const isAuthorizedReviewer = canReviewAll1on1Reports(user);

  if (action === 'view') {
    if (isOwner) return true;
    if (isAuthorizedReviewer) return true;
    if (canDirectorGiveFeedback(user, report)) return true;
    return false;
  }

  if (action === 'edit' || action === 'submit') {
    return isOwner;
  }

  if (action === 'review' || action === 'finalize' || action === 'reopen' || action === 'approve' || action === 'reject') {
    // Strictly forbid self-approval or self-decision
    if (isOwner) return false;
    if (isAuthorizedReviewer) return true;
    return false;
  }

  return false;
}

/**
 * Creates a new monthly 1:1 report header.
 * Enforces one report per employee per calendar month.
 */
async function createMonthly1on1Report(db, {
  employeeId,
  employeeName,
  reviewerId = null,
  reviewerName = '',
  department = '',
  employeeRole = '',
  reportingMonthInput,
  workLocation = '',
  currentProjects = '',
  overallStatus = null,
  capacity = null,
  additionalDetails = '',
  auditUser = null,
  skipWindowCheck = false
}) {
  if (!employeeId || !Number.isInteger(Number(employeeId))) {
    const error = new Error('Valid employee_id is required.');
    error.code = 'INVALID_EMPLOYEE_ID';
    error.status = 400;
    throw error;
  }

  const reportingMonth = normalizeReportingMonth(reportingMonthInput);

  // Check window status if required (enforced for user-driven operations)
  if (!skipWindowCheck && auditUser) {
    const win = await getWindowForMonth(db, reportingMonth);
    if (win.status !== 'open') {
      let msg = 'Reporting window is not open for this month.';
      if (win.status === 'no_window') msg = `Reporting window has not been opened yet for ${reportingMonth.slice(0, 7)}.`;
      if (win.status === 'upcoming') msg = `Reporting window for ${reportingMonth.slice(0, 7)} will open on ${win.start_ist}.`;
      if (win.status === 'closed') msg = `Reporting window for ${reportingMonth.slice(0, 7)} closed on ${win.end_ist}.`;
      const error = new Error(msg);
      error.code = 'WINDOW_NOT_OPEN';
      error.status = 400;
      throw error;
    }
  }

  // Check unique month constraint before insert
  const existing = await db.get(
    `SELECT id FROM monthly_1on1_reports WHERE employee_id=? AND reporting_month=? AND record_type='report'`,
    [employeeId, reportingMonth]
  );
  if (existing) {
    const error = new Error(`A report already exists for employee ${employeeId} for month ${reportingMonth}.`);
    error.code = 'DUPLICATE_REPORT';
    error.status = 400;
    throw error;
  }

  const reportId = crypto.randomUUID();
  const stamp = nowIso();
  const directorName = getAssignedDirector(employeeId);

  await db.run(
    `INSERT INTO monthly_1on1_reports (
      id, record_type, employee_id, employee_name, reviewer_id, reviewer_name,
      director_name, department, employee_role, reporting_month, meeting_date,
      work_location, current_projects, overall_status,
      capacity_for_additional_responsibilities, additional_responsibility_details,
      status, submitted_at, revision_reason, manager_notes_json,
      employee_acknowledged_at, reviewer_acknowledged_at, completed_at,
      created_at, updated_at
    ) VALUES (
      ?, 'report', ?, ?, ?, ?,
      ?, ?, ?, ?, NULL,
      ?, ?, ?,
      ?, ?,
      'Draft', '', NULL, NULL,
      '', '', '',
      ?, ?
    )`,
    [
      reportId,
      Number(employeeId),
      String(employeeName || '').slice(0, 180),
      reviewerId ? Number(reviewerId) : null,
      String(reviewerName || '').slice(0, 180),
      directorName,
      String(department || '').slice(0, 120),
      String(employeeRole || '').slice(0, 120),
      reportingMonth,
      String(workLocation || '').slice(0, 180),
      String(currentProjects || ''),
      overallStatus && VALID_1ON1_OVERALL_STATUSES.includes(overallStatus) ? overallStatus : null,
      capacity && VALID_1ON1_CAPACITY.includes(capacity) ? capacity : null,
      String(additionalDetails || ''),
      stamp,
      stamp
    ]
  );

  await log1on1Audit(db, {
    userId: auditUser?.id || employeeId,
    action: 'MONTHLY_1ON1_CREATED',
    reportId,
    details: `Employee: ${employeeName || employeeId}, Month: ${reportingMonth}`
  });

  return getMonthly1on1ReportById(db, reportId);
}

/**
 * Loads a full report including its grouped items, preserving original item IDs.
 */
async function getMonthly1on1ReportById(db, reportId) {
  if (!isValidUuid(reportId)) {
    return null;
  }

  const report = await db.get(
    `SELECT * FROM monthly_1on1_reports WHERE id=?`,
    [reportId]
  );
  if (!report) return null;

  const itemRows = await db.all(
    `SELECT id, section_key, item_order, item_json, created_at, updated_at
     FROM monthly_1on1_items
     WHERE report_id=?
     ORDER BY section_key ASC, item_order ASC`,
    [reportId]
  );

  const items = {};
  for (const s of VALID_1ON1_SECTIONS) {
    items[s] = [];
  }

  for (const row of itemRows || []) {
    let parsed = {};
    try {
      parsed = JSON.parse(row.item_json);
    } catch {
      parsed = {};
    }
    if (!items[row.section_key]) {
      items[row.section_key] = [];
    }
    items[row.section_key].push({
      id: row.id,
      order: Number(row.item_order),
      data: parsed,
      created_at: row.created_at,
      updated_at: row.updated_at
    });
  }

  let managerNotes = null;
  if (report.manager_notes_json) {
    try {
      managerNotes = JSON.parse(report.manager_notes_json);
    } catch {
      managerNotes = null;
    }
  }

  let directorFeedback = null;
  if (report.director_feedback_json) {
    try {
      directorFeedback = JSON.parse(report.director_feedback_json);
    } catch {
      directorFeedback = null;
    }
  }

  return {
    id: report.id,
    record_type: report.record_type || 'report',
    employee_id: Number(report.employee_id),
    employee_name: report.employee_name || '',
    reviewer_id: report.reviewer_id ? Number(report.reviewer_id) : null,
    reviewer_name: report.reviewer_name || '',
    director_name: report.director_name || 'Managing Director',
    department: report.department || '',
    employee_role: report.employee_role || '',
    reporting_month: report.reporting_month || '',
    meeting_date: report.meeting_date || null,
    work_location: report.work_location || '',
    current_projects: report.current_projects || '',
    overall_status: report.overall_status || null,
    capacity_for_additional_responsibilities: report.capacity_for_additional_responsibilities || null,
    additional_responsibility_details: report.additional_responsibility_details || '',
    status: report.status || 'Draft',
    submitted_at: report.submitted_at || '',
    revision_reason: report.revision_reason || '',
    manager_notes: managerNotes,
    director_feedback: directorFeedback,
    director_feedback_at: report.director_feedback_at || '',
    director_feedback_by_id: report.director_feedback_by_id ? Number(report.director_feedback_by_id) : null,
    director_feedback_by_name: report.director_feedback_by_name || '',
    employee_acknowledged_at: report.employee_acknowledged_at || '',
    reviewer_acknowledged_at: report.reviewer_acknowledged_at || '',
    completed_at: report.completed_at || '',
    window_start: report.window_start || null,
    window_end: report.window_end || null,
    closed_at: report.closed_at || null,
    closed_by_id: report.closed_by_id ? Number(report.closed_by_id) : null,
    closed_by_name: report.closed_by_name || null,
    reopened_at: report.reopened_at || null,
    reopened_by_id: report.reopened_by_id ? Number(report.reopened_by_id) : null,
    reopened_by_name: report.reopened_by_name || null,
    window_reopen_reason: report.window_reopen_reason || null,
    approved_at: report.approved_at || '',
    approved_by_id: report.approved_by_id ? Number(report.approved_by_id) : null,
    approved_by_name: report.approved_by_name || '',
    rejected_at: report.rejected_at || '',
    rejected_by_id: report.rejected_by_id ? Number(report.rejected_by_id) : null,
    rejected_by_name: report.rejected_by_name || '',
    rejection_reason: report.rejection_reason || '',
    decision_notes: report.decision_notes || '',
    manager_feedback: (managerNotes && (managerNotes.additional_comments || managerNotes.manager_feedback)) || report.decision_notes || '',
    created_at: report.created_at,
    updated_at: report.updated_at,
    items
  };
}

/**
 * Saves report draft header and items in a single database transaction.
 * Retains existing item UUIDs when editing; generates new UUIDs only for new items.
 * Prevents stale concurrent overwrites when expectedUpdatedAt is supplied.
 */
async function saveMonthly1on1Draft(db, {
  reportId,
  headerUpdates = {},
  sections = {},
  expectedUpdatedAt = null,
  auditUser = null
}) {
  if (!isValidUuid(reportId)) {
    const error = new Error('Invalid report UUID.');
    error.code = 'INVALID_REPORT_ID';
    error.status = 400;
    throw error;
  }

  const existingReport = await db.get(
    `SELECT id, employee_id, status, reporting_month, meeting_date, work_location, current_projects, overall_status, capacity_for_additional_responsibilities, additional_responsibility_details, updated_at FROM monthly_1on1_reports WHERE id=?`,
    [reportId]
  );
  if (!existingReport) {
    const error = new Error('Report not found.');
    error.code = 'NOT_FOUND';
    error.status = 404;
    throw error;
  }

  // Check window status if reporting month exists
  if (existingReport.reporting_month) {
    const win = await getWindowForMonth(db, existingReport.reporting_month);
    if (win.status === 'closed') {
      const error = new Error(`The reporting window for ${existingReport.reporting_month.slice(0, 7)} closed on ${win.end_ist}. Edits are no longer accepted.`);
      error.code = 'WINDOW_CLOSED';
      error.status = 400;
      throw error;
    }
  }

  // Editing allowed if Draft, Revision Requested, Submitted, Under Review, Rejected, or Approved (while window is open)
  if (!['Draft', 'Revision Requested', 'Submitted', 'Under Review', 'Rejected', 'Approved'].includes(existingReport.status)) {
    const error = new Error(`Cannot edit report in status "${existingReport.status}".`);
    error.code = 'INVALID_STATUS';
    error.status = 400;
    throw error;
  }

  // Prevent stale concurrent edits
  if (expectedUpdatedAt && existingReport.updated_at && expectedUpdatedAt !== existingReport.updated_at) {
    const error = new Error('Conflict: this report has been modified by another session. Please reload to avoid overwriting changes.');
    error.code = 'STALE_DATA_CONFLICT';
    error.status = 409;
    throw error;
  }

  const stamp = nowIso();

  // Validate and prepare header fields (preserve existing if undefined)
  const meetingDate = headerUpdates.meeting_date !== undefined
    ? (headerUpdates.meeting_date ? String(headerUpdates.meeting_date).slice(0, 10) : null)
    : (existingReport.meeting_date ? String(existingReport.meeting_date).slice(0, 10) : null);

  const workLocation = headerUpdates.work_location !== undefined
    ? String(headerUpdates.work_location || '').slice(0, 180)
    : (existingReport.work_location || '');

  const currentProjects = headerUpdates.current_projects !== undefined
    ? String(headerUpdates.current_projects || '')
    : (existingReport.current_projects || '');

  const overallStatus = headerUpdates.overall_status !== undefined
    ? (headerUpdates.overall_status && VALID_1ON1_OVERALL_STATUSES.includes(headerUpdates.overall_status) ? headerUpdates.overall_status : null)
    : existingReport.overall_status;

  const capacity = headerUpdates.capacity_for_additional_responsibilities !== undefined
    ? (headerUpdates.capacity_for_additional_responsibilities && VALID_1ON1_CAPACITY.includes(headerUpdates.capacity_for_additional_responsibilities) ? headerUpdates.capacity_for_additional_responsibilities : null)
    : existingReport.capacity_for_additional_responsibilities;

  const additionalDetails = headerUpdates.additional_responsibility_details !== undefined
    ? String(headerUpdates.additional_responsibility_details || '')
    : (existingReport.additional_responsibility_details || '');

  // Pre-validate all section items before touching the database
  const validatedSections = {};
  for (const [sectionKey, itemsArray] of Object.entries(sections || {})) {
    if (!VALID_1ON1_SECTIONS.includes(sectionKey)) continue;
    if (!Array.isArray(itemsArray)) continue;

    validatedSections[sectionKey] = itemsArray.map((it, order) => {
      const originalId = it && isValidUuid(it.id) ? it.id : crypto.randomUUID();
      const rawData = it && it.data ? it.data : (it || {});
      const cleanData = validateSectionItem(sectionKey, rawData);
      return {
        id: originalId,
        order,
        json: JSON.stringify(cleanData)
      };
    });
  }

  // Execute header and items update in a single transaction
  const connection = await db.pool.getConnection();
  try {
    await connection.beginTransaction();

    // 1. Update header
    await connection.execute(
      db.sql(
        `UPDATE monthly_1on1_reports
         SET meeting_date=?, work_location=?, current_projects=?, overall_status=?,
             capacity_for_additional_responsibilities=?, additional_responsibility_details=?,
             updated_at=?
         WHERE id=?`
      ),
      [meetingDate, workLocation, currentProjects, overallStatus, capacity, additionalDetails, stamp, reportId]
    );

    // 2. Replace section items (preserving valid item IDs)
    for (const [sectionKey, items] of Object.entries(validatedSections)) {
      await connection.execute(
        db.sql(`DELETE FROM monthly_1on1_items WHERE report_id=? AND section_key=?`),
        [reportId, sectionKey]
      );

      for (const item of items) {
        await connection.execute(
          db.sql(
            `INSERT INTO monthly_1on1_items (id, report_id, section_key, item_order, item_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          ),
          [item.id, reportId, sectionKey, item.order, item.json, stamp, stamp]
        );
      }
    }

    await connection.commit();
  } catch (error) {
    try {
      await connection.rollback();
    } catch {}
    throw error;
  } finally {
    connection.release();
  }

  await log1on1Audit(db, {
    userId: auditUser?.id || existingReport.employee_id,
    action: 'MONTHLY_1ON1_UPDATED',
    reportId,
    details: `Draft updated with ${Object.keys(validatedSections).length} sections`
  });

  return getMonthly1on1ReportById(db, reportId);
}

/**
 * Submits the report. Ensures overall status and acknowledgement are present.
 */
async function submitMonthly1on1Report(db, {
  reportId,
  acknowledged,
  sections = {},
  headerUpdates = {},
  auditUser = null
}) {
  if (!isValidUuid(reportId)) {
    const error = new Error('Invalid report UUID.');
    error.code = 'INVALID_REPORT_ID';
    error.status = 400;
    throw error;
  }
  if (!acknowledged) {
    const error = new Error('Employee acknowledgement is required before submission.');
    error.code = 'ACKNOWLEDGEMENT_REQUIRED';
    error.status = 400;
    throw error;
  }

  // Save latest sections and headerUpdates if supplied
  if ((sections && Object.keys(sections).length > 0) || (headerUpdates && Object.keys(headerUpdates).length > 0)) {
    await saveMonthly1on1Draft(db, { reportId, headerUpdates, sections, auditUser });
  }

  const report = await db.get(
    `SELECT * FROM monthly_1on1_reports WHERE id=?`,
    [reportId]
  );
  if (!report) {
    const error = new Error('Report not found.');
    error.code = 'NOT_FOUND';
    error.status = 404;
    throw error;
  }
  // Enforce window status check directly in database submission layer
  if (report.reporting_month) {
    const win = await getWindowForMonth(db, report.reporting_month);
    if (win.status === 'closed') {
      const error = new Error(`The reporting window for ${report.reporting_month.slice(0, 7)} is closed. Submissions are no longer accepted.`);
      error.code = 'WINDOW_CLOSED';
      error.status = 400;
      throw error;
    }
  }

  if (!['Draft', 'Revision Requested', 'Submitted', 'Under Review', 'Rejected', 'Approved'].includes(report.status)) {
    const error = new Error(`Cannot submit a report in status "${report.status}".`);
    error.code = 'INVALID_STATUS';
    error.status = 400;
    throw error;
  }
  if (!report.overall_status) {
    const error = new Error('Please select an Overall Status before submitting.');
    error.code = 'OVERALL_STATUS_REQUIRED';
    error.status = 400;
    throw error;
  }
  // Steps 2 through 6 are optional; can be filled or left blank without blocking submission.

  const stamp = nowIso();
  const isResubmission = report.status === 'Revision Requested' || report.status === 'Rejected' || report.status === 'Submitted' || report.status === 'Approved';

  // Preserve previous reviewer decisions into manager_notes_json if resubmitting an already reviewed/decided report
  let mgrNotes = {};
  try {
    mgrNotes = typeof report.manager_notes_json === 'string' ? JSON.parse(report.manager_notes_json) : (report.manager_notes_json || {});
  } catch (_) { mgrNotes = {}; }
  if (!Array.isArray(mgrNotes.previous_decisions)) {
    mgrNotes.previous_decisions = [];
  }
  if (report.status === 'Approved' || report.status === 'Rejected' || report.decision_notes || report.rejection_reason) {
    mgrNotes.previous_decisions.push({
      previous_status: report.status,
      decision_notes: report.decision_notes || report.rejection_reason || '',
      decided_by_name: report.approved_by_name || report.rejected_by_name || report.reviewer_name || '',
      decided_by_id: report.approved_by_id || report.rejected_by_id || report.reviewer_id || null,
      decided_at: report.approved_at || report.rejected_at || report.updated_at || '',
      resubmitted_at: stamp
    });
  }

  await db.run(
    `UPDATE monthly_1on1_reports
     SET status='Submitted', submitted_at=?, employee_acknowledged_at=?, updated_at=?,
         manager_notes_json=?
     WHERE id=?`,
    [stamp, stamp, stamp, JSON.stringify(mgrNotes), reportId]
  );

  const action = isResubmission ? 'MONTHLY_1ON1_RESUBMITTED' : 'MONTHLY_1ON1_SUBMITTED';
  await log1on1Audit(db, {
    userId: auditUser?.id || report.employee_id,
    action,
    reportId,
    details: `Month: ${report.reporting_month}`
  });

  return getMonthly1on1ReportById(db, reportId);
}

/**
 * Reviewer begins review on a submitted report.
 * Strictly prevents self-review.
 */
async function startMonthly1on1Review(db, {
  reportId,
  reviewerId,
  reviewerName,
  auditUser = null
}) {
  if (!isValidUuid(reportId)) {
    const error = new Error('Invalid report UUID.');
    error.code = 'INVALID_REPORT_ID';
    error.status = 400;
    throw error;
  }

  const report = await db.get(
    `SELECT id, status, employee_id FROM monthly_1on1_reports WHERE id=?`,
    [reportId]
  );
  if (!report) {
    const error = new Error('Report not found.');
    error.code = 'NOT_FOUND';
    error.status = 404;
    throw error;
  }
  if (report.status !== 'Submitted') {
    const error = new Error(`Report must be in "Submitted" status to start review. Current status: "${report.status}".`);
    error.code = 'INVALID_STATUS';
    error.status = 400;
    throw error;
  }

  // Prevent self-review
  if (Number(report.employee_id) === Number(reviewerId)) {
    const error = new Error('Self-review or self-approval is not permitted.');
    error.code = 'SELF_APPROVAL_FORBIDDEN';
    error.status = 403;
    throw error;
  }

  const stamp = nowIso();
  await db.run(
    `UPDATE monthly_1on1_reports
     SET status='Under Review', reviewer_id=?, reviewer_name=?, updated_at=?
     WHERE id=?`,
    [reviewerId ? Number(reviewerId) : null, String(reviewerName || '').slice(0, 180), stamp, reportId]
  );

  await log1on1Audit(db, {
    userId: auditUser?.id || reviewerId,
    action: 'MONTHLY_1ON1_REVIEW_STARTED',
    reportId,
    details: `Reviewer: ${reviewerName}`
  });

  return getMonthly1on1ReportById(db, reportId);
}

/**
 * Saves intermediate manager notes while review is in progress without finalizing.
 */
async function saveMonthly1on1ReviewNotes(db, {
  reportId,
  managerNotes = {},
  reviewerId,
  auditUser = null
}) {
  if (!isValidUuid(reportId)) {
    const error = new Error('Invalid report UUID.');
    error.code = 'INVALID_REPORT_ID';
    error.status = 400;
    throw error;
  }

  const report = await db.get(
    `SELECT id, status, employee_id, reviewer_id, manager_notes_json FROM monthly_1on1_reports WHERE id=?`,
    [reportId]
  );
  if (!report) {
    const error = new Error('Report not found.');
    error.code = 'NOT_FOUND';
    error.status = 404;
    throw error;
  }
  if (!['Submitted', 'Under Review', 'Completed', 'Approved', 'Rejected'].includes(report.status)) {
    const error = new Error(`Cannot save review notes when status is "${report.status}".`);
    error.code = 'INVALID_STATUS';
    error.status = 400;
    throw error;
  }

  // Prevent self-review notes
  if (Number(report.employee_id) === Number(reviewerId)) {
    const error = new Error('Self-review or self-approval is not permitted.');
    error.code = 'SELF_APPROVAL_FORBIDDEN';
    error.status = 403;
    throw error;
  }

  const stamp = nowIso();
  let existingNotes = {};
  try {
    if (report.manager_notes_json) {
      existingNotes = typeof report.manager_notes_json === 'string' ? JSON.parse(report.manager_notes_json) : report.manager_notes_json;
    }
  } catch (e) {}

  const deadlineVal = managerNotes.meeting_date || managerNotes.deadline || managerNotes.follow_up_date || managerNotes.deadline_followup_date || null;
  const packedNotes = {
    ...existingNotes,
    key_observation: String(managerNotes.key_observation || '').trim().slice(0, 5000),
    final_responsibility_assigned: String(managerNotes.final_responsibility_assigned || managerNotes.final_responsibility || '').trim().slice(0, 5000),
    meeting_date: deadlineVal ? String(deadlineVal).slice(0, 10) : null,
    follow_up_date: deadlineVal ? String(deadlineVal).slice(0, 10) : null,
    deadline: deadlineVal ? String(deadlineVal).slice(0, 10) : null,
    additional_comments: String(managerNotes.additional_comments || '').trim().slice(0, 5000),
    last_saved_at: stamp,
    reviewer_id: reviewerId ? Number(reviewerId) : null,
    reviewer_name: auditUser?.name || existingNotes.reviewer_name || ''
  };

  const reviewerName = auditUser?.name || existingNotes.reviewer_name || '';
  await db.run(
    `UPDATE monthly_1on1_reports
     SET manager_notes_json=?, meeting_date=?, reviewer_id=?, reviewer_name=?, status='Completed', updated_at=?
     WHERE id=?`,
    [JSON.stringify(packedNotes), deadlineVal ? String(deadlineVal).slice(0, 10) : null, reviewerId ? Number(reviewerId) : null, reviewerName, stamp, reportId]
  );

  await log1on1Audit(db, {
    userId: auditUser?.id || reviewerId,
    action: 'MONTHLY_1ON1_NOTES_SAVED',
    reportId,
    details: `Review notes saved by ${auditUser?.name || reviewerId}`
  });

  return getMonthly1on1ReportById(db, reportId);
}

/**
 * Reviewer requests revision from employee with mandatory reason.
 * Strictly prevents self-review.
 */
async function requestMonthly1on1Revision(db, {
  reportId,
  reason,
  auditUser = null
}) {
  if (!isValidUuid(reportId)) {
    const error = new Error('Invalid report UUID.');
    error.code = 'INVALID_REPORT_ID';
    error.status = 400;
    throw error;
  }
  const cleanReason = String(reason || '').trim();
  if (!cleanReason) {
    const error = new Error('A revision reason is required.');
    error.code = 'REASON_REQUIRED';
    error.status = 400;
    throw error;
  }

  const report = await db.get(
    `SELECT id, status, employee_id FROM monthly_1on1_reports WHERE id=?`,
    [reportId]
  );
  if (!report) {
    const error = new Error('Report not found.');
    error.code = 'NOT_FOUND';
    error.status = 404;
    throw error;
  }
  if (report.status !== 'Under Review') {
    const error = new Error(`Report must be "Under Review" to request revision. Current status: "${report.status}".`);
    error.code = 'INVALID_STATUS';
    error.status = 400;
    throw error;
  }

  // Prevent self-review
  if (auditUser && Number(report.employee_id) === Number(auditUser.id)) {
    const error = new Error('Self-review or self-approval is not permitted.');
    error.code = 'SELF_APPROVAL_FORBIDDEN';
    error.status = 403;
    throw error;
  }

  const stamp = nowIso();
  await db.run(
    `UPDATE monthly_1on1_reports
     SET status='Revision Requested', revision_reason=?, updated_at=?
     WHERE id=?`,
    [cleanReason, stamp, reportId]
  );

  await log1on1Audit(db, {
    userId: auditUser?.id,
    action: 'MONTHLY_1ON1_REVISION_REQUESTED',
    reportId,
    details: `Reason: ${cleanReason.slice(0, 100)}`
  });

  return getMonthly1on1ReportById(db, reportId);
}

/**
 * Reviewer completes and finalizes report with alignment notes and acknowledgement.
 * Stores key_observation, final_responsibility_assigned, follow_up_date, additional_comments.
 * Strictly prevents self-approval.
 */
async function finalizeMonthly1on1Report(db, {
  reportId,
  managerNotes = {},
  reviewerAcknowledged,
  reviewerId,
  reviewerName,
  auditUser = null
}) {
  if (!isValidUuid(reportId)) {
    const error = new Error('Invalid report UUID.');
    error.code = 'INVALID_REPORT_ID';
    error.status = 400;
    throw error;
  }
  if (!reviewerAcknowledged) {
    const error = new Error('Reviewer acknowledgement is required to finalize report.');
    error.code = 'ACKNOWLEDGEMENT_REQUIRED';
    error.status = 400;
    throw error;
  }

  const report = await db.get(
    `SELECT id, status, employee_id FROM monthly_1on1_reports WHERE id=?`,
    [reportId]
  );
  if (!report) {
    const error = new Error('Report not found.');
    error.code = 'NOT_FOUND';
    error.status = 404;
    throw error;
  }
  if (report.status !== 'Under Review') {
    const error = new Error(`Report must be "Under Review" to finalize. Current status: "${report.status}".`);
    error.code = 'INVALID_STATUS';
    error.status = 400;
    throw error;
  }

  // Prevent self-approval
  if (Number(report.employee_id) === Number(reviewerId)) {
    const error = new Error('Self-review or self-approval is not permitted.');
    error.code = 'SELF_APPROVAL_FORBIDDEN';
    error.status = 403;
    throw error;
  }

  const keyObs = String(managerNotes.key_observation || '').trim();
  if (!keyObs) {
    const error = new Error('Key observation is required to finalize report.');
    error.code = 'VALIDATION';
    error.status = 400;
    throw error;
  }

  const stamp = nowIso();
  const packedNotes = {
    key_observation: String(managerNotes.key_observation || '').trim().slice(0, 5000),
    final_responsibility_assigned: String(managerNotes.final_responsibility_assigned || managerNotes.final_responsibility || '').trim().slice(0, 5000),
    follow_up_date: managerNotes.follow_up_date ? String(managerNotes.follow_up_date).slice(0, 10) : null,
    additional_comments: String(managerNotes.additional_comments || '').trim().slice(0, 5000),
    reviewer_name: reviewerName || '',
    reviewer_id: reviewerId || null,
    finalized_at: stamp
  };

  await db.run(
    `UPDATE monthly_1on1_reports
     SET status='Completed', manager_notes_json=?, reviewer_id=?, reviewer_name=?,
         reviewer_acknowledged_at=?, completed_at=?, updated_at=?
     WHERE id=?`,
    [
      JSON.stringify(packedNotes),
      reviewerId ? Number(reviewerId) : null,
      String(reviewerName || '').slice(0, 180),
      stamp,
      stamp,
      stamp,
      reportId
    ]
  );

  await log1on1Audit(db, {
    userId: auditUser?.id || reviewerId,
    action: 'MONTHLY_1ON1_COMPLETED',
    reportId,
    details: `Reviewer: ${reviewerName}`
  });

  return getMonthly1on1ReportById(db, reportId);
}

/**
 * Reopens a completed report for updates/amendments.
 * Requires an authorized manager/admin and a valid reason.
 */
async function reopenMonthly1on1Report(db, {
  reportId,
  reason,
  auditUser = null
}) {
  if (!isValidUuid(reportId)) {
    const error = new Error('Invalid report UUID.');
    error.code = 'INVALID_REPORT_ID';
    error.status = 400;
    throw error;
  }
  const cleanReason = String(reason || '').trim();
  if (!cleanReason) {
    const error = new Error('A reopen reason is required.');
    error.code = 'REASON_REQUIRED';
    error.status = 400;
    throw error;
  }

  const report = await db.get(
    `SELECT id, status, employee_id FROM monthly_1on1_reports WHERE id=?`,
    [reportId]
  );
  if (!report) {
    const error = new Error('Report not found.');
    error.code = 'NOT_FOUND';
    error.status = 404;
    throw error;
  }
  if (report.status !== 'Completed') {
    const error = new Error(`Only Completed reports can be reopened. Current status: "${report.status}".`);
    error.code = 'INVALID_STATUS';
    error.status = 400;
    throw error;
  }

  // Prevent self-reopen without authorization
  if (auditUser && Number(report.employee_id) === Number(auditUser.id) && auditUser.role !== 'admin') {
    const error = new Error('Self-approval or self-reopening is not permitted.');
    error.code = 'SELF_APPROVAL_FORBIDDEN';
    error.status = 403;
    throw error;
  }

  const stamp = nowIso();
  await db.run(
    `UPDATE monthly_1on1_reports
     SET status='Revision Requested', revision_reason=?, completed_at='', updated_at=?
     WHERE id=?`,
    [`Reopened: ${cleanReason}`, stamp, reportId]
  );

  await log1on1Audit(db, {
    userId: auditUser?.id,
    action: 'MONTHLY_1ON1_REOPENED',
    reportId,
    details: `Reopen reason: ${cleanReason.slice(0, 100)}`
  });

  return getMonthly1on1ReportById(db, reportId);
}

/**
 * Approves a report. Only Super Admin or Service Admin can approve.
 * Strictly prevents self-approval.
 */
async function approveMonthly1on1Report(db, {
  reportId,
  adminUser,
  comments = '',
  managerNotes = null
}) {
  if (!isValidUuid(reportId)) {
    const error = new Error('Invalid report UUID.');
    error.code = 'INVALID_REPORT_ID';
    error.status = 400;
    throw error;
  }
  if (!canReviewAll1on1Reports(adminUser)) {
    const error = new Error('Only Super Admin and Service Admin can approve reports.');
    error.code = 'FORBIDDEN';
    error.status = 403;
    throw error;
  }

  const report = await db.get(
    `SELECT id, status, employee_id, manager_notes_json FROM monthly_1on1_reports WHERE id=? AND record_type='report'`,
    [reportId]
  );
  if (!report) {
    const error = new Error('Report not found.');
    error.code = 'NOT_FOUND';
    error.status = 404;
    throw error;
  }

  // Prevent self-approval
  if (Number(report.employee_id) === Number(adminUser.id)) {
    const error = new Error('Self-approval is strictly forbidden.');
    error.code = 'SELF_APPROVAL_FORBIDDEN';
    error.status = 403;
    throw error;
  }

  if (!['Submitted', 'Under Review'].includes(report.status)) {
    const error = new Error(`Report must be in "Submitted" or "Under Review" status to be approved. Current status: "${report.status}".`);
    error.code = 'INVALID_STATUS';
    error.status = 400;
    throw error;
  }

  const stamp = nowIso();
  let packedNotesJson = report.manager_notes_json;
  if (managerNotes && typeof managerNotes === 'object') {
    let prev = {};
    try { if (report.manager_notes_json) prev = JSON.parse(report.manager_notes_json); } catch(e){}
    const merged = {
      ...prev,
      key_observation: String(managerNotes.key_observation || prev.key_observation || '').trim().slice(0, 5000),
      final_responsibility_assigned: String(managerNotes.final_responsibility_assigned || managerNotes.final_responsibility || prev.final_responsibility_assigned || '').trim().slice(0, 5000),
      follow_up_date: managerNotes.follow_up_date ? String(managerNotes.follow_up_date).slice(0, 10) : (prev.follow_up_date || null),
      additional_comments: String(managerNotes.additional_comments || comments || prev.additional_comments || '').trim().slice(0, 5000),
      approved_by: adminUser.name || 'Admin',
      approved_at: stamp
    };
    packedNotesJson = JSON.stringify(merged);
  }

  await db.run(
    `UPDATE monthly_1on1_reports
     SET status='Approved', approved_at=?, approved_by_id=?, approved_by_name=?, decision_notes=?, manager_notes_json=?, updated_at=?
     WHERE id=?`,
    [stamp, Number(adminUser.id), String(adminUser.name || 'Admin').slice(0, 180), String(comments || '').slice(0, 5000), packedNotesJson, stamp, reportId]
  );

  await log1on1Audit(db, {
    userId: adminUser.id,
    action: 'MONTHLY_1ON1_APPROVED',
    reportId,
    details: `Approved by: ${adminUser.name} (${adminUser.role})`
  });

  return getMonthly1on1ReportById(db, reportId);
}

/**
 * Rejects a report with mandatory reason.
 * Only Super Admin or Service Admin can reject.
 * Strictly prevents self-rejection.
 */
async function rejectMonthly1on1Report(db, {
  reportId,
  adminUser,
  reason,
  comments = ''
}) {
  if (!isValidUuid(reportId)) {
    const error = new Error('Invalid report UUID.');
    error.code = 'INVALID_REPORT_ID';
    error.status = 400;
    throw error;
  }
  if (!canReviewAll1on1Reports(adminUser)) {
    const error = new Error('Only Super Admin and Service Admin can reject reports.');
    error.code = 'FORBIDDEN';
    error.status = 403;
    throw error;
  }

  const cleanReason = String(reason || '').trim();
  if (!cleanReason) {
    const error = new Error('A rejection reason is required.');
    error.code = 'REJECTION_REASON_REQUIRED';
    error.status = 400;
    throw error;
  }

  const report = await db.get(
    `SELECT id, status, employee_id FROM monthly_1on1_reports WHERE id=? AND record_type='report'`,
    [reportId]
  );
  if (!report) {
    const error = new Error('Report not found.');
    error.code = 'NOT_FOUND';
    error.status = 404;
    throw error;
  }

  // Prevent self-rejection
  if (Number(report.employee_id) === Number(adminUser.id)) {
    const error = new Error('Self-approval or self-rejection is strictly forbidden.');
    error.code = 'SELF_APPROVAL_FORBIDDEN';
    error.status = 403;
    throw error;
  }

  if (!['Submitted', 'Under Review'].includes(report.status)) {
    const error = new Error(`Report must be in "Submitted" or "Under Review" status to be rejected. Current status: "${report.status}".`);
    error.code = 'INVALID_STATUS';
    error.status = 400;
    throw error;
  }

  const stamp = nowIso();
  const finalDecisionNotes = comments ? `${cleanReason}\n${comments}` : cleanReason;
  await db.run(
    `UPDATE monthly_1on1_reports
     SET status='Rejected', rejected_at=?, rejected_by_id=?, rejected_by_name=?, rejection_reason=?, decision_notes=?, updated_at=?
     WHERE id=?`,
    [stamp, Number(adminUser.id), String(adminUser.name || 'Admin').slice(0, 180), cleanReason, finalDecisionNotes, stamp, reportId]
  );

  await log1on1Audit(db, {
    userId: adminUser.id,
    action: 'MONTHLY_1ON1_REJECTED',
    reportId,
    details: `Rejected by: ${adminUser.name} (${adminUser.role}), Reason: ${cleanReason.slice(0, 200)}`
  });

  return getMonthly1on1ReportById(db, reportId);
}

/**
 * Creates or updates reporting window for a given month.
 * Strictly Super Admin only.
 */
async function createOrUpdateWindow(db, {
  reportingMonth,
  startDate,
  startTime,
  endDate,
  endTime,
  auditUser = null
}) {
  if (auditUser && !canConfigure1on1Window(auditUser)) {
    const error = new Error('Only Super Admin is authorized to configure reporting windows.');
    error.code = 'SUPER_ADMIN_REQUIRED';
    error.status = 403;
    throw error;
  }

  const normMonth = normalizeReportingMonth(reportingMonth);
  const startIso = parseIstToIso(startDate, startTime);
  const endIso = parseIstToIso(endDate, endTime);

  if (new Date(endIso).getTime() <= new Date(startIso).getTime()) {
    const error = new Error('End time must be strictly later than start time.');
    error.code = 'INVALID_WINDOW_TIME';
    error.status = 400;
    throw error;
  }

  // Prevent conflicting active windows: Never allow two reporting months to be simultaneously open
  const otherWindows = await db.all(
    `SELECT id, reporting_month, status, window_start, window_end FROM monthly_1on1_reports WHERE record_type='window' AND reporting_month != ? AND employee_id=0`,
    [normMonth]
  );
  const myStart = new Date(startIso).getTime();
  const myEnd = new Date(endIso).getTime();

  for (const other of otherWindows || []) {
    if (other.window_start && other.window_end && other.status !== 'Closed') {
      const oStart = new Date(other.window_start).getTime();
      const oEnd = new Date(other.window_end).getTime();
      if (Math.max(myStart, oStart) < Math.min(myEnd, oEnd)) {
        const oMonth = String(other.reporting_month).slice(0, 7);
        const error = new Error(`Conflicting active window: Reporting window for ${oMonth} is already scheduled during this period (${formatIsoToIst(other.window_start)} - ${formatIsoToIst(other.window_end)}). Never allow two reporting months to be simultaneously open for applicants.`);
        error.code = 'CONFLICTING_WINDOW';
        error.status = 400;
        throw error;
      }
    }
  }

  const existing = await db.get(
    `SELECT id FROM monthly_1on1_reports WHERE record_type='window' AND reporting_month=? AND employee_id=0`,
    [normMonth]
  );

  const stamp = nowIso();
  let windowId = existing ? existing.id : crypto.randomUUID();

  const confId = auditUser?.id ? Number(auditUser.id) : null;
  const confName = auditUser?.name ? String(auditUser.name).slice(0, 180) : 'Super Admin';

  if (existing) {
    await db.run(
      `UPDATE monthly_1on1_reports
       SET window_start=?, window_end=?, status='Open', reviewer_id=?, reviewer_name=?,
           closed_at=NULL, closed_by_id=NULL, closed_by_name=NULL,
           reopened_at=NULL, reopened_by_id=NULL, reopened_by_name=NULL, window_reopen_reason=NULL,
           updated_at=?
       WHERE id=?`,
      [startIso, endIso, confId, confName, stamp, windowId]
    );
  } else {
    await db.run(
      `INSERT INTO monthly_1on1_reports (
        id, record_type, employee_id, employee_name, reviewer_id, reviewer_name, reporting_month,
        window_start, window_end, status, created_at, updated_at
      ) VALUES (?, 'window', 0, 'Window Configuration', ?, ?, ?, ?, ?, 'Open', ?, ?)`,
      [windowId, confId, confName, normMonth, startIso, endIso, stamp, stamp]
    );
  }

  await log1on1Audit(db, {
    userId: auditUser?.id || null,
    action: 'MONTHLY_1ON1_WINDOW_CHANGED',
    reportId: windowId,
    details: `Month: ${normMonth}, Start: ${startIso}, End: ${endIso}`
  });

  return getWindowForMonth(db, normMonth);
}

/**
 * Super Admin manually closes a reporting window.
 * Authoritative closure mechanism.
 */
async function closeWindow(db, { reportingMonth, adminUser }) {
  if (!canConfigure1on1Window(adminUser)) {
    const error = new Error('Only Super Admin is authorized to close reporting windows.');
    error.code = 'SUPER_ADMIN_REQUIRED';
    error.status = 403;
    throw error;
  }
  const normMonth = normalizeReportingMonth(reportingMonth);
  const existing = await db.get(
    `SELECT id, window_start, window_end FROM monthly_1on1_reports WHERE record_type='window' AND reporting_month=? AND employee_id=0`,
    [normMonth]
  );
  if (!existing) {
    const error = new Error(`Reporting window for ${normMonth.slice(0, 7)} has not been configured.`);
    error.code = 'WINDOW_NOT_CONFIGURED';
    error.status = 400;
    throw error;
  }

  const stamp = nowIso();
  await db.run(
    `UPDATE monthly_1on1_reports
     SET status='Closed', closed_at=?, closed_by_id=?, closed_by_name=?, updated_at=?
     WHERE id=?`,
    [stamp, Number(adminUser.id), String(adminUser.name || 'Super Admin').slice(0, 180), stamp, existing.id]
  );

  await log1on1Audit(db, {
    userId: adminUser.id,
    action: 'MONTHLY_1ON1_WINDOW_CLOSED',
    reportId: existing.id,
    details: `Month: ${normMonth} closed manually by ${adminUser.name}`
  });

  return getWindowForMonth(db, normMonth);
}

/**
 * Super Admin manually opens a reporting window before its normal start time or reopens it.
 * Enforces: Never allow two reporting months to be simultaneously open for applicants.
 */
async function manualOpenWindow(db, { reportingMonth, adminUser, reason = 'Manually opened by Super Admin' }) {
  if (!canConfigure1on1Window(adminUser)) {
    const error = new Error('Only Super Admin is authorized to open reporting windows.');
    error.code = 'SUPER_ADMIN_REQUIRED';
    error.status = 403;
    throw error;
  }
  const normMonth = normalizeReportingMonth(reportingMonth);
  const existing = await db.get(
    `SELECT id, window_start, window_end, status FROM monthly_1on1_reports WHERE record_type='window' AND reporting_month=? AND employee_id=0`,
    [normMonth]
  );
  if (!existing || !existing.window_start || !existing.window_end) {
    const error = new Error(`Reporting window for ${normMonth.slice(0, 7)} has not been configured with start and end dates.`);
    error.code = 'WINDOW_NOT_CONFIGURED';
    error.status = 400;
    throw error;
  }

  // Prevent conflicting active windows: check if another month is already open
  const otherWindows = await db.all(
    `SELECT id, reporting_month, status, window_start, window_end, reopened_at FROM monthly_1on1_reports WHERE record_type='window' AND reporting_month != ? AND employee_id=0`,
    [normMonth]
  );
  for (const other of otherWindows || []) {
    if (calculateWindowStatus(other) === 'open') {
      const oMonth = String(other.reporting_month).slice(0, 7);
      const error = new Error(`Cannot open window: Reporting window for ${oMonth} is currently active and open. Never allow two reporting months to be simultaneously open for applicants. Please close the active window first.`);
      error.code = 'ANOTHER_WINDOW_OPEN';
      error.status = 400;
      throw error;
    }
  }

  const stamp = nowIso();
  const nowMs = Date.now();
  let updatedEnd = existing.window_end;
  if (nowMs >= new Date(existing.window_end).getTime()) {
    // If end date has already passed, extend end date by 7 days so it is validly open
    updatedEnd = new Date(nowMs + 7 * 24 * 3600 * 1000).toISOString();
  }

  await db.run(
    `UPDATE monthly_1on1_reports
     SET status='Open', window_end=?, reopened_at=?, reopened_by_id=?, reopened_by_name=?, window_reopen_reason=?,
         closed_at=NULL, closed_by_id=NULL, closed_by_name=NULL, updated_at=?
     WHERE id=?`,
    [updatedEnd, stamp, Number(adminUser.id), String(adminUser.name || 'Super Admin').slice(0, 180), String(reason || 'Manually opened by Super Admin').slice(0, 1000), stamp, existing.id]
  );

  await log1on1Audit(db, {
    userId: adminUser.id,
    action: 'MONTHLY_1ON1_WINDOW_OPENED',
    reportId: existing.id,
    details: `Month: ${normMonth} manually opened by ${adminUser.name}. Reason: ${reason}`
  });

  return getWindowForMonth(db, normMonth);
}

/**
 * Super Admin explicitly reopens a closed reporting window with audit reason.
 */
async function reopenWindow(db, { reportingMonth, adminUser, reason = '' }) {
  if (!canConfigure1on1Window(adminUser)) {
    const error = new Error('Only Super Admin is authorized to reopen reporting windows.');
    error.code = 'SUPER_ADMIN_REQUIRED';
    error.status = 403;
    throw error;
  }
  const cleanReason = String(reason || '').trim();
  if (!cleanReason) {
    const error = new Error('A reason is required to reopen a closed reporting window.');
    error.code = 'REOPEN_REASON_REQUIRED';
    error.status = 400;
    throw error;
  }
  return manualOpenWindow(db, { reportingMonth, adminUser, reason: cleanReason });
}

/**
 * Saves Director feedback on an assigned employee report.
 */
async function saveDirectorFeedback(db, {
  reportId,
  directorUser,
  feedback,
  recommendations = '',
  improvements = '',
  remarks = ''
}) {
  if (!isValidUuid(reportId)) {
    const error = new Error('Invalid report UUID.');
    error.code = 'INVALID_REPORT_ID';
    error.status = 400;
    throw error;
  }

  const report = await db.get(
    `SELECT id, employee_id, employee_name, director_name, reviewer_name, status, reporting_month FROM monthly_1on1_reports WHERE id=? AND record_type='report'`,
    [reportId]
  );
  if (!report) {
    const error = new Error('Report not found.');
    error.code = 'NOT_FOUND';
    error.status = 404;
    throw error;
  }

  if (!canDirectorGiveFeedback(directorUser, report)) {
    const error = new Error('Only the assigned Director or authorized administrators can provide Director feedback.');
    error.code = 'FORBIDDEN';
    error.status = 403;
    throw error;
  }

  const cleanFeedback = String(feedback || '').trim();
  if (!cleanFeedback) {
    const error = new Error('Director feedback content is required.');
    error.code = 'FEEDBACK_REQUIRED';
    error.status = 400;
    throw error;
  }

  const stamp = nowIso();
  const feedbackObj = {
    feedback: cleanFeedback.slice(0, 5000),
    recommendations: String(recommendations || '').trim().slice(0, 5000),
    improvements: String(improvements || '').trim().slice(0, 5000),
    remarks: String(remarks || '').trim().slice(0, 5000),
    director_id: Number(directorUser.id),
    director_name: String(directorUser.name || directorUser.username || 'Director').slice(0, 180),
    submitted_at: stamp,
    updated_at: stamp
  };

  await db.run(
    `UPDATE monthly_1on1_reports
     SET director_feedback_json=?, director_feedback_at=?, director_feedback_by_id=?, director_feedback_by_name=?, updated_at=?
     WHERE id=?`,
    [JSON.stringify(feedbackObj), stamp, Number(directorUser.id), feedbackObj.director_name, stamp, reportId]
  );

  await log1on1Audit(db, {
    userId: directorUser.id,
    action: 'MONTHLY_1ON1_DIRECTOR_FEEDBACK_SAVED',
    reportId,
    details: `Director feedback saved by ${feedbackObj.director_name} for report #${reportId.slice(0, 8)}`
  });

  return getMonthly1on1ReportById(db, reportId);
}

/**
 * Retrieves the reporting window for a month with calculated status and IST strings.
 */
/**
 * Calculates the automatic monthly connect application window:
 * 1 full month (1st of month at 00:00:00 IST) + 5 days of next month (until 5th of next month at 23:59:59 IST).
 * After the 5th day of the next month, the window automatically closes.
 */
function calculateAutomaticMonthWindow(reportingMonthInput) {
  const norm = normalizeReportingMonth(reportingMonthInput);
  const year = parseInt(norm.slice(0, 4), 10);
  const month = parseInt(norm.slice(5, 7), 10);

  const startDateStr = `${year}-${String(month).padStart(2, '0')}-01`;
  const windowStart = parseIstToIso(startDateStr, '00:00:00');

  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const endDateStr = `${nextYear}-${String(nextMonth).padStart(2, '0')}-05`;
  const windowEnd = parseIstToIso(endDateStr, '23:59:59');

  return {
    window_start: windowStart,
    window_end: windowEnd,
    start_ist: formatIsoToIst(windowStart),
    end_ist: formatIsoToIst(windowEnd)
  };
}

/**
 * Returns reporting window configuration for a given month.
 * Automatically applies the 1 month full + next month until date 5 schedule by default.
 */
async function getWindowForMonth(db, reportingMonthInput) {
  const normMonth = normalizeReportingMonth(reportingMonthInput);
  const auto = calculateAutomaticMonthWindow(normMonth);

  const row = await db.get(
    `SELECT id, reporting_month, status, window_start, window_end, reviewer_id, reviewer_name, closed_at, closed_by_id, closed_by_name, reopened_at, reopened_by_id, reopened_by_name, window_reopen_reason, created_at, updated_at
     FROM monthly_1on1_reports
     WHERE record_type='window' AND reporting_month=? AND employee_id=0
     LIMIT 1`,
    [normMonth]
  );

  // If no DB row exists, apply the automatic default schedule (1st of month to 5th of next month 23:59:59 IST)
  if (!row) {
    const windowObj = {
      window_start: auto.window_start,
      window_end: auto.window_end,
      status: 'Scheduled'
    };
    const status = calculateWindowStatus(windowObj);
    const now = getEffectiveTimeMs();
    const isPastEndDate = now > new Date(auto.window_end).getTime();

    let displayStatus = 'Not Configured';
    if (status === 'upcoming') displayStatus = 'Scheduled';
    else if (status === 'open') displayStatus = 'Open';
    else if (status === 'closed') displayStatus = 'Closed';

    return {
      id: null,
      reporting_month: normMonth,
      window_start: auto.window_start,
      window_end: auto.window_end,
      status,
      display_status: displayStatus,
      start_ist: auto.start_ist,
      end_ist: auto.end_ist,
      isPastEndDate,
      is_automatic: true,
      configured_by_id: null,
      configured_by_name: 'Automatic Schedule (1st to 5th Next Month)',
      closed_at: null,
      closed_by_name: null,
      reopened_at: null,
      reopened_by_name: null,
      window_reopen_reason: null,
      created_at: null,
      updated_at: null
    };
  }

  // Row exists: use custom start/end if provided, otherwise fallback to automatic window
  const windowStart = row.window_start || auto.window_start;
  const windowEnd = row.window_end || auto.window_end;
  const windowObj = {
    ...row,
    window_start: windowStart,
    window_end: windowEnd
  };

  const status = calculateWindowStatus(windowObj);
  const now = getEffectiveTimeMs();
  const end = new Date(windowEnd).getTime();
  const isPastEndDate = now > end;

  let displayStatus = 'Not Configured';
  if (status === 'upcoming') displayStatus = 'Scheduled';
  else if (status === 'open') displayStatus = 'Open';
  else if (status === 'closed') displayStatus = 'Closed';

  return {
    id: row.id,
    reporting_month: normMonth,
    window_start: windowStart,
    window_end: windowEnd,
    status,
    display_status: displayStatus,
    start_ist: formatIsoToIst(windowStart),
    end_ist: formatIsoToIst(windowEnd),
    isPastEndDate,
    is_automatic: !row.window_start || !row.window_end,
    configured_by_id: row.reviewer_id || null,
    configured_by_name: row.reviewer_name || null,
    closed_at: row.closed_at || null,
    closed_by_name: row.closed_by_name || null,
    reopened_at: row.reopened_at || null,
    reopened_by_name: row.reopened_by_name || null,
    window_reopen_reason: row.window_reopen_reason || null,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

/**
 * Returns the active open window if one exists.
 * Evaluates previous month (if within days 1-5 grace period) and current month automatically.
 */
async function getActiveOpenWindow(db) {
  const nowMs = getEffectiveTimeMs();
  const now = new Date(nowMs);
  
  // Current month string in IST: YYYY-MM
  const istDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const curY = parseInt(istDate.slice(0, 4), 10);
  const curM = parseInt(istDate.slice(5, 7), 10);
  const currentMonthStr = `${curY}-${String(curM).padStart(2, '0')}-01`;

  // Previous month:
  const prevM = curM === 1 ? 12 : curM - 1;
  const prevY = curM === 1 ? curY - 1 : curY;
  const prevMonthStr = `${prevY}-${String(prevM).padStart(2, '0')}-01`;

  // 1. If we are in days 1-5 of current month, previous month is still open for employees:
  const prevWin = await getWindowForMonth(db, prevMonthStr);
  if (prevWin && prevWin.status === 'open') {
    return prevWin;
  }

  // 2. Next check current month:
  const curWin = await getWindowForMonth(db, currentMonthStr);
  if (curWin && curWin.status === 'open') {
    return curWin;
  }

  // 3. Fallback to any explicitly opened DB window:
  const openWindowRows = await db.all(
    `SELECT reporting_month FROM monthly_1on1_reports WHERE record_type='window' AND employee_id=0 AND status != 'Closed' ORDER BY reporting_month DESC`
  );
  for (const ow of openWindowRows || []) {
    const win = await getWindowForMonth(db, ow.reporting_month);
    if (win && win.status === 'open') {
      return win;
    }
  }
  return null;
}

/**
 * Assigns or reassigns an authorized reviewer for a report.
 * Strictly prevents an employee from being assigned as their own reviewer.
 */
async function assignMonthly1on1Reviewer(db, {
  reportId,
  reviewerId,
  reviewerName,
  auditUser = null
}) {
  if (!isValidUuid(reportId)) {
    const error = new Error('Invalid report UUID.');
    error.code = 'INVALID_REPORT_ID';
    error.status = 400;
    throw error;
  }
  const report = await db.get(
    `SELECT id, employee_id, reporting_month FROM monthly_1on1_reports WHERE id=?`,
    [reportId]
  );
  if (!report) {
    const error = new Error('Report not found.');
    error.code = 'NOT_FOUND';
    error.status = 404;
    throw error;
  }

  if (reviewerId && Number(reviewerId) === Number(report.employee_id)) {
    const error = new Error('An employee cannot be assigned as their own reviewer.');
    error.code = 'SELF_REVIEW_FORBIDDEN';
    error.status = 400;
    throw error;
  }

  const stamp = nowIso();
  await db.run(
    `UPDATE monthly_1on1_reports
     SET reviewer_id=?, reviewer_name=?, updated_at=?
     WHERE id=?`,
    [reviewerId ? Number(reviewerId) : null, String(reviewerName || '').trim().slice(0, 180), stamp, reportId]
  );

  await log1on1Audit(db, {
    userId: auditUser?.id,
    action: 'MONTHLY_1ON1_REVIEWER_ASSIGNED',
    reportId,
    details: `Assigned reviewer: ${reviewerName} (ID: ${reviewerId})`
  });

  return getMonthly1on1ReportById(db, reportId);
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatReportDate(dateStr) {
  if (!dateStr) return '—';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return String(dateStr);
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch {
    return String(dateStr);
  }
}

function formatReportStamp(stampStr) {
  if (!stampStr) return '—';
  try {
    const d = new Date(stampStr);
    if (isNaN(d.getTime())) return String(stampStr);
    return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
  } catch {
    return String(stampStr);
  }
}

function formatReportingMonthLabel(monthStr) {
  if (!monthStr) return '—';
  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const parts = String(monthStr).slice(0, 7).split('-');
  const m = parseInt(parts[1], 10);
  if (m >= 1 && m <= 12) {
    return `${MONTHS[m - 1]} ${parts[0]}`;
  }
  return String(monthStr);
}

/**
 * Generates pristine standalone HTML matching the source Word template layout and field order.
 * Optimized for clean A4 printing, page-breaks, and document viewing.
 */
function renderMonthly1on1PrintHtml(report) {
  if (!report) return '<!DOCTYPE html><html><body><p>Report not found.</p></body></html>';
  const r = report;
  const items = r.items || {};
  const mn = r.manager_notes || {};
  const isCompleted = r.status === 'Completed';
  const monthLabel = formatReportingMonthLabel(r.reporting_month);

  const renderTable = (arr, columns) => {
    if (!arr || !arr.length) {
      return '<div class="empty-field">None recorded.</div>';
    }
    const headers = columns.map(([label]) => `<th>${escapeHtml(label)}</th>`).join('');
    const rows = arr.map((item, rowIdx) => {
      const data = item.data || item;
      const cells = columns.map(([label, key]) => {
        if (key === 'proof_link') {
          const proof = data.proof;
          const linksHtml = [];
          const pUrl = (proof && (proof.link || (proof.type === 'link' ? proof.url : ''))) || data.proof_link || '';
          const pFile = proof && (proof.file || (proof.type === 'file' ? proof : null));
          if (pUrl && /^https?:\/\//i.test(pUrl.trim())) {
            linksHtml.push(`<a href="${escapeHtml(pUrl.trim())}" target="_blank" rel="noopener noreferrer" style="color:#0284C7;text-decoration:underline;">🔗 ${escapeHtml(pUrl.trim())}</a>`);
          } else if (pUrl) {
            linksHtml.push(`<span style="color:#64748B;">🔗 ${escapeHtml(pUrl.trim())}</span>`);
          }
          if (pFile && pFile.storage_key) {
            linksHtml.push(`<a href="/api/monthly-1on1/reports/${encodeURIComponent(r.id)}/attachment?key=${encodeURIComponent(pFile.storage_key || '')}" target="_blank" rel="noopener noreferrer" style="color:#0284C7;text-decoration:underline;">📎 ${escapeHtml(pFile.original_name || 'Attached Document')}</a>`);
          }
          if (linksHtml.length) {
            return `<td>${linksHtml.join('<br>')}</td>`;
          }
          return '<td><span class="empty-field">None</span></td>';
        }
        return `<td>${escapeHtml(String(data[key] || '—'))}</td>`;
      }).join('');
      return `<tr>${cells}</tr>`;
    }).join('');
    return `<table class="report-table"><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table>`;
  };

  const suggestions = items.improvement_suggestions || [];
  const priorities = items.monthly_priorities || [];

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Monthly Connect Update — ${escapeHtml(r.employee_name)} — ${escapeHtml(monthLabel)}</title>
  <style>
    /* CSS Reset & Core Document Styles */
    *, *::before, *::after {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    html, body {
      background: #FFFFFF;
      color: #0F172A;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-size: 10pt;
      line-height: 1.45;
      -webkit-font-smoothing: antialiased;
    }
    .page-container {
      max-width: 860px;
      margin: 0 auto;
      padding: 24px 28px;
    }
    
    /* Top Action Bar for Screen Viewing */
    .screen-toolbar {
      position: sticky;
      top: 0;
      background: #0F0147;
      color: #FFFFFF;
      padding: 10px 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 24px;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(15, 1, 71, 0.15);
      z-index: 100;
    }
    .toolbar-info {
      font-size: 13px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .toolbar-actions {
      display: flex;
      gap: 10px;
      align-items: center;
    }
    .toolbar-btn {
      cursor: pointer;
      border: none;
      padding: 7px 14px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 700;
      transition: opacity 0.15s ease;
    }
    .toolbar-btn:hover {
      opacity: 0.9;
    }
    .btn-print {
      background: #38B6FF;
      color: #0F0147;
    }
    .btn-close {
      background: rgba(255, 255, 255, 0.18);
      color: #FFFFFF;
    }

    /* Document Header */
    .doc-header {
      border-bottom: 2.5px solid #0F0147;
      padding-bottom: 12px;
      margin-bottom: 14px;
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
    }
    .doc-titles {
      flex: 1;
    }
    .doc-main-title {
      font-size: 18pt;
      font-weight: 800;
      color: #0F0147;
      letter-spacing: 0.5px;
      line-height: 1.2;
    }
    .doc-sub-title {
      font-size: 11pt;
      font-weight: 700;
      color: #475569;
      margin-top: 4px;
    }
    .doc-meta-badge {
      text-align: right;
    }
    .reporting-month-tag {
      font-size: 13pt;
      font-weight: 800;
      color: #0F0147;
    }

    /* Status Banners */
    .status-banner {
      padding: 10px 14px;
      border-radius: 6px;
      margin-bottom: 16px;
      font-size: 9.5pt;
      line-height: 1.4;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border: 1.5px solid transparent;
    }
    .status-banner.finalized, .status-banner.approved {
      background: #ECFDF5;
      border-color: #10B981;
      color: #065F46;
    }
    .status-banner.incomplete {
      background: #FFFBEB;
      border-color: #F59E0B;
      color: #92400E;
    }
    .status-banner.rejected {
      background: #FEF2F2;
      border-color: #EF4444;
      color: #991B1B;
    }
    .status-banner-title {
      font-weight: 800;
      font-size: 10.5pt;
    }
    .status-tag {
      display: inline-block;
      padding: 3px 10px;
      border-radius: 12px;
      font-size: 8.5pt;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .status-tag.finalized, .status-tag.approved {
      background: #D1FAE5;
      color: #065F46;
      border: 1px solid #10B981;
    }
    .status-tag.incomplete {
      background: #FEF3C7;
      color: #92400E;
      border: 1px solid #F59E0B;
    }
    .status-tag.rejected {
      background: #FEE2E2;
      color: #991B1B;
      border: 1px solid #EF4444;
    }

    /* Section Headings */
    .section-heading {
      font-size: 11.5pt;
      font-weight: 800;
      color: #0F0147;
      border-bottom: 1.5px solid #CBD5E1;
      padding-bottom: 4px;
      margin-top: 16px;
      margin-bottom: 8px;
      page-break-after: avoid;
      break-after: avoid;
    }
    .sub-heading {
      font-size: 9.5pt;
      font-weight: 700;
      color: #0F0147;
      margin-top: 8px;
      margin-bottom: 4px;
    }

    /* Tables */
    .report-table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 12px;
      font-size: 9.5pt;
      page-break-inside: auto;
    }
    .report-table th {
      background: #F8FAFC;
      border: 1px solid #CBD5E1;
      color: #0F0147;
      font-weight: 700;
      font-size: 9pt;
      padding: 6px 8px;
      text-align: left;
      vertical-align: bottom;
    }
    .report-table td {
      border: 1px solid #CBD5E1;
      padding: 6px 8px;
      vertical-align: top;
      word-break: break-word;
      overflow-wrap: break-word;
    }
    .report-table tr {
      page-break-inside: avoid;
      break-inside: avoid;
    }

    /* Employee Details Grid / Table */
    .details-table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 14px;
      font-size: 9.5pt;
    }
    .details-table td {
      border: 1px solid #CBD5E1;
      padding: 6px 10px;
      vertical-align: top;
    }
    .details-label {
      width: 25%;
      background: #F8FAFC;
      font-weight: 700;
      color: #334155;
      font-size: 9pt;
    }
    .details-value {
      width: 25%;
      color: #0F172A;
      font-weight: 600;
    }

    .empty-field {
      color: #64748B;
      font-style: italic;
      font-size: 9pt;
      padding: 4px 0;
    }

    /* Suggestions & Priorities */
    .list-item {
      padding: 4px 0;
      font-size: 9.5pt;
      border-bottom: 1px solid #F1F5F9;
    }
    .priority-item {
      padding: 4px 0;
      font-size: 9.5pt;
    }
    .priority-item b {
      color: #0F0147;
    }

    /* Manager Notes Block */
    .manager-notes-block {
      border: 1px solid #CBD5E1;
      border-radius: 6px;
      padding: 10px 12px;
      background: #FFFFFF;
      margin-bottom: 12px;
    }
    .manager-note-row {
      margin-bottom: 8px;
    }
    .manager-note-row:last-child {
      margin-bottom: 0;
    }
    .manager-note-row b {
      display: block;
      color: #334155;
      font-size: 8.5pt;
      text-transform: uppercase;
      margin-bottom: 2px;
    }
    .manager-note-row span, .manager-note-row div {
      font-size: 9.5pt;
      color: #0F172A;
      white-space: pre-wrap;
    }

    /* Acknowledgements Block */
    .ack-block {
      border: 1.5px solid #CBD5E1;
      border-radius: 6px;
      padding: 12px;
      margin-top: 14px;
      page-break-inside: avoid;
      break-inside: avoid;
      background: #F8FAFC;
    }
    .ack-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin-bottom: 10px;
    }
    .ack-card {
      background: #FFFFFF;
      border: 1px solid #CBD5E1;
      border-radius: 6px;
      padding: 10px;
    }
    .ack-role {
      font-size: 8pt;
      font-weight: 700;
      color: #64748B;
      text-transform: uppercase;
      margin-bottom: 2px;
    }
    .ack-name {
      font-size: 10.5pt;
      font-weight: 800;
      color: #0F0147;
    }
    .ack-date {
      font-size: 8.5pt;
      color: #334155;
      margin-top: 4px;
    }
    .ack-status {
      font-size: 8.5pt;
      font-weight: 700;
      margin-top: 3px;
    }
    .ack-status.verified {
      color: #059669;
    }
    .ack-status.pending {
      color: #D97706;
    }
    .ack-disclaimer {
      font-size: 8pt;
      color: #64748B;
      line-height: 1.35;
      padding-top: 6px;
      border-top: 1px solid #E2E8F0;
    }

    /* Print Styles */
    @media print {
      @page {
        size: A4 portrait;
        margin: 12mm 12mm 14mm 12mm;
      }
      .no-print, .screen-toolbar {
        display: none !important;
      }
      .page-container {
        max-width: 100% !important;
        padding: 0 !important;
        margin: 0 !important;
      }
      body {
        background: #FFFFFF !important;
        color: #000000 !important;
        font-size: 9.5pt !important;
      }
      .report-table th, .details-table .details-label {
        background: #F8FAFC !important;
        -webkit-print-color-adjust: exact !important;
        print-color-adjust: exact !important;
      }
      .status-banner {
        -webkit-print-color-adjust: exact !important;
        print-color-adjust: exact !important;
      }
      .section-heading {
        page-break-after: avoid !important;
        break-after: avoid !important;
      }
      .report-table tr, .ack-block, .manager-notes-block {
        page-break-inside: avoid !important;
        break-inside: avoid !important;
      }
    }
  </style>
</head>
<body>
  <div class="screen-toolbar no-print">
    <div class="toolbar-info">
      <span>Monthly Connect Report</span> ·
      <span>${escapeHtml(r.employee_name)}</span> ·
      <span>${escapeHtml(monthLabel)}</span>
      <span class="status-tag ${r.status === 'Approved' || isCompleted ? 'approved' : (r.status === 'Rejected' ? 'rejected' : 'incomplete')}">${escapeHtml(r.status)}</span>
    </div>
    <div class="toolbar-actions">
      <button class="toolbar-btn btn-print" onclick="window.print()">🖨️ Print / Save as PDF</button>
      <button class="toolbar-btn btn-close" onclick="window.close()">✕ Close</button>
    </div>
  </div>

  <div class="page-container">
    <!-- Document Header -->
    <header class="doc-header">
      <div class="doc-titles">
        <h1 class="doc-main-title">MONTHLY CONNECT UPDATE TEMPLATE</h1>
        <div class="doc-sub-title">Project Reinvent — Responsibility, Deliverables &amp; Readiness Review</div>
      </div>
      <div class="doc-meta-badge">
        <div class="reporting-month-tag">${escapeHtml(monthLabel)}</div>
      </div>
    </header>

    <!-- Status Banner -->
    ${r.status === 'Approved' ? `
    <div class="status-banner approved">
      <div>
        <div class="status-banner-title">✅ APPROVED REPORT</div>
        <div>This report has been reviewed and approved by <b>${escapeHtml(r.approved_by_name || 'Admin')}</b> on ${escapeHtml(formatReportStamp(r.approved_at))}.</div>
        ${r.decision_notes ? `<div style="margin-top:4px;font-style:italic;">"${escapeHtml(r.decision_notes)}"</div>` : ''}
      </div>
      <span class="status-tag approved">Approved</span>
    </div>` : (r.status === 'Rejected' ? `
    <div class="status-banner rejected">
      <div>
        <div class="status-banner-title">❌ REJECTED REPORT</div>
        <div>Report was rejected by <b>${escapeHtml(r.rejected_by_name || 'Admin')}</b> on ${escapeHtml(formatReportStamp(r.rejected_at))}.</div>
        <div style="margin-top:4px;"><b>Reason:</b> ${escapeHtml(r.rejection_reason || 'Rejection reason provided.')}</div>
      </div>
      <span class="status-tag rejected">Rejected</span>
    </div>` : (isCompleted ? `
    <div class="status-banner finalized">
      <div>
        <div class="status-banner-title">✅ FINALIZED &amp; COMPLETED REPORT</div>
        <div>All deliverables reviewed, manager alignment documented, and electronic acknowledgements verified.</div>
      </div>
      <span class="status-tag finalized">Completed</span>
    </div>` : `
    <div class="status-banner incomplete">
      <div>
        <div class="status-banner-title">⚠️ DOCUMENT NOT FINALIZED — CURRENT STATUS: ${escapeHtml(r.status.toUpperCase())}</div>
        <div>This report is currently in ${escapeHtml(r.status)} status and pending administrative approval.</div>
      </div>
      <span class="status-tag incomplete">${escapeHtml(r.status)}</span>
    </div>`))}

    <!-- Employee Details (Word Template Order with Director designation) -->
    <h2 class="section-heading">Employee Details</h2>
    <table class="details-table">
      <tr>
        <td class="details-label">Employee Name</td>
        <td class="details-value">${escapeHtml(r.employee_name || '—')}</td>
        <td class="details-label">Department / Role</td>
        <td class="details-value">${escapeHtml(r.department || '—')}${r.employee_role ? ' · ' + escapeHtml(r.employee_role) : ''}</td>
      </tr>
      <tr>
        <td class="details-label">Reporting Month</td>
        <td class="details-value">${escapeHtml(monthLabel)}</td>
        <td class="details-label">Manager / Reviewer: Director</td>
        <td class="details-value">${escapeHtml(r.director_name || r.reviewer_name || 'Director')}</td>
      </tr>
      <tr>
        <td class="details-label">Meeting Date</td>
        <td class="details-value">${r.meeting_date ? escapeHtml(formatReportDate(r.meeting_date)) : '—'}</td>
        <td class="details-label">Work Location</td>
        <td class="details-value">${escapeHtml(r.work_location || '—')}</td>
      </tr>
      <tr>
        <td class="details-label">Current Projects Handled</td>
        <td class="details-value" colspan="3">${escapeHtml(r.current_projects || '—')}</td>
      </tr>
      <tr>
        <td class="details-label">Overall Status</td>
        <td class="details-value" colspan="3">${escapeHtml(r.overall_status || '—')}</td>
      </tr>
    </table>

    <!-- 1. Key Deliverables Completed Last Month -->
    <h2 class="section-heading">1. Key Deliverables Completed Last Month</h2>
    ${renderTable(items.completed_deliverables, [
      ['Deliverable / Task', 'task'],
      ['Target Given', 'target_given'],
      ['Actual Completion', 'actual_completion'],
      ['Impact / Result', 'impact_result'],
      ['Proof / Attachment (Optional)', 'proof_link']
    ])}

    <!-- 2. Pending Tasks / Delayed Items -->
    <h2 class="section-heading">2. Pending Tasks / Delayed Items</h2>
    ${renderTable(items.pending_tasks, [
      ['Task', 'task'],
      ['Reason for Delay', 'reason_for_delay'],
      ['Current Status', 'current_status'],
      ['Support Needed', 'support_needed'],
      ['Expected Completion Date', 'expected_completion_date']
    ])}

    <!-- 3. Challenges & Support Required -->
    <h2 class="section-heading">3. Challenges & Support Required</h2>
    ${renderTable(items.challenges_support, [
      ['Major Challenges Faced', 'major_challenge'],
      ['Support Required from Management / Team', 'support_required']
    ])}

    <!-- 4. Project Reinvent — Responsibility & Readiness -->
    <h2 class="section-heading">4. Project Reinvent — Responsibility & Readiness</h2>
    ${renderTable(items.responsibility_readiness, [
      ['Current Responsibilities', 'current_responsibilities'],
      ['Responsibilities You Can Take Next', 'next_responsibilities'],
      ['Areas Where You Need Clarity', 'clarity_required']
    ])}
    <div style="margin-top: 6px; margin-bottom: 12px; font-size: 9.5pt;">
      <div style="margin-bottom: 4px;"><b>Capacity for Additional Responsibilities:</b> ${escapeHtml(r.capacity_for_additional_responsibilities || '—')}</div>
      <div><b>Responsibility areas employee can handle:</b> ${escapeHtml(r.additional_responsibility_details || '—')}</div>
    </div>

    <!-- 5. Suggestions & Commitment for This Month -->
    <h2 class="section-heading">5. Suggestions & Commitment for This Month</h2>
    <div class="sub-heading">Suggestions for Improvement</div>
    ${suggestions.length ? suggestions.map((it, i) => `
      <div class="list-item">${i + 1}. ${escapeHtml((it.data || it).suggestion || '')}</div>
    `).join('') : '<div class="empty-field">None recorded.</div>'}

    <div class="sub-heading" style="margin-top: 10px;">Top 3 Priorities for This Month</div>
    ${[1, 2, 3].map(n => {
      const p = priorities.find(it => (it.data?.priority_number || it.priority_number) === n);
      return `<div class="priority-item"><b>Priority ${n}:</b> ${p ? escapeHtml((p.data || p).description || '') : '—'}</div>`;
    }).join('')}

    <!-- 6. Manager Notes / Final Alignment -->
    <h2 class="section-heading">6. Manager Notes / Final Alignment</h2>
    ${(isCompleted || mn.key_observation || mn.final_responsibility_assigned || mn.final_responsibility) ? `
    <div class="manager-notes-block">
      <div class="manager-note-row">
        <b>Key Observation</b>
        <div>${escapeHtml(mn.key_observation || '—')}</div>
      </div>
      <div class="manager-note-row">
        <b>Final Responsibility Assigned</b>
        <div>${escapeHtml(mn.final_responsibility_assigned || mn.final_responsibility || '—')}</div>
      </div>
      <div class="manager-note-row">
        <b>Meeting Date</b>
        <span>${(mn.meeting_date || mn.follow_up_date || mn.deadline) ? escapeHtml(formatReportDate(mn.meeting_date || mn.follow_up_date || mn.deadline)) : '—'}</span>
      </div>
      <div class="manager-note-row">
        <b>Additional Comments</b>
        <div>${escapeHtml(mn.additional_comments || '—')}</div>
      </div>
    </div>` : `
    <div class="empty-field">⚠️ Pending Manager Review and Final Alignment. Notes will be documented once the 1:1 meeting is conducted and finalized.</div>`}

    <!-- Director Feedback -->
    ${r.director_feedback && r.director_feedback.feedback ? `
    <h2 class="section-heading">Director Feedback</h2>
    <div class="manager-notes-block" style="background:#F0FDF4;border:1px solid #86EFAC;">
      <div style="font-size:9pt;color:#065F46;margin-bottom:6px;">
        Feedback submitted by <b>${escapeHtml(r.director_feedback.director_name || r.director_name || 'Director')}</b> on ${r.director_feedback_at ? escapeHtml(formatReportStamp(r.director_feedback_at)) : '—'}
      </div>
      <div class="manager-note-row">
        <b>Director Feedback</b>
        <div>${escapeHtml(r.director_feedback.feedback || '—')}</div>
      </div>
      ${r.director_feedback.recommendations ? `
      <div class="manager-note-row">
        <b>Recommendations</b>
        <div>${escapeHtml(r.director_feedback.recommendations)}</div>
      </div>` : ''}
      ${r.director_feedback.improvements ? `
      <div class="manager-note-row">
        <b>Areas for Improvement</b>
        <div>${escapeHtml(r.director_feedback.improvements)}</div>
      </div>` : ''}
      ${r.director_feedback.remarks ? `
      <div class="manager-note-row">
        <b>Additional Remarks</b>
        <div>${escapeHtml(r.director_feedback.remarks)}</div>
      </div>` : ''}
    </div>` : ''}

    <!-- Acknowledgements -->
    <h2 class="section-heading">Acknowledgements</h2>
    <div class="ack-block">
      <div class="ack-grid">
        <div class="ack-card">
          <div class="ack-role">Employee Acknowledgement</div>
          <div class="ack-name">${escapeHtml(r.employee_name || '—')}</div>
          <div class="ack-date">Date: <b>${r.employee_acknowledged_at ? escapeHtml(formatReportStamp(r.employee_acknowledged_at)) : (r.submitted_at ? escapeHtml(formatReportStamp(r.submitted_at)) : 'Pending Submission')}</b></div>
          <div class="ack-status ${r.submitted_at ? 'verified' : 'pending'}">${r.submitted_at ? '✓ Authenticated via Connect Credentials' : '○ Submission Pending'}</div>
        </div>
        <div class="ack-card">
          <div class="ack-role">Manager / Reviewer: Director (Reviewer Acknowledgement)</div>
          <div class="ack-name">${escapeHtml(r.director_name || r.reviewer_name || 'Director')}</div>
          <div class="ack-date">Date: <b>${r.approved_at ? escapeHtml(formatReportStamp(r.approved_at)) : (isCompleted ? (r.completed_at ? escapeHtml(formatReportStamp(r.completed_at)) : '—') : 'Pending Final Review')}</b></div>
          <div class="ack-status ${r.status === 'Approved' || isCompleted ? 'verified' : 'pending'}">${r.status === 'Approved' ? '✓ Administrative Approval Verified' : (isCompleted ? '✓ Reviewer Alignment Verified' : '○ Final Review Pending')}</div>
        </div>
      </div>
      <div class="ack-disclaimer">
        <b>Portal Electronic Record:</b> Authenticated electronic acknowledgements recorded via Mypreneur Connect. These entries verify internal 1:1 meeting completion and mutual alignment under company policy and do not constitute legally certified digital signatures.
      </div>
    </div>
  </div>
</body>
</html>`;
}

module.exports = {
  VALID_1ON1_STATUSES,
  VALID_1ON1_OVERALL_STATUSES,
  VALID_1ON1_CAPACITY,
  VALID_1ON1_SECTIONS,
  isValidUuid,
  normalizeReportingMonth,
  validateSectionItem,
  log1on1Audit,
  canUserAccessReport,
  createMonthly1on1Report,
  getMonthly1on1ReportById,
  saveMonthly1on1Draft,
  saveMonthly1on1ReviewNotes,
  submitMonthly1on1Report,
  startMonthly1on1Review,
  requestMonthly1on1Revision,
  finalizeMonthly1on1Report,
  reopenMonthly1on1Report,
  assignMonthly1on1Reviewer,
  renderMonthly1on1PrintHtml,
  // New RBAC & Window Capabilities
  isExecutiveLeadership,
  isSuperAdmin,
  isServiceAdmin,
  canConfigure1on1Window,
  canReviewAll1on1Reports,
  canSubmit1on1,
  canView1on1Report,
  canEdit1on1Report,
  canApproveOrReject1on1,
  // Timezone & Window Utilities
  calculateAutomaticMonthWindow,
  parseIstToIso,
  formatIsoToIst,
  calculateWindowStatus,
  getWindowForMonth,
  getActiveOpenWindow,
  createOrUpdateWindow,
  closeWindow,
  reopenWindow,
  manualOpenWindow,
  setSimulatedClock,
  getEffectiveTimeMs,
  isWindowPastEndDate,
  // Approval / Rejection
  approveMonthly1on1Report,
  rejectMonthly1on1Report,
  // Director feedback & resolution
  canDirectorGiveFeedback,
  saveDirectorFeedback,
  // Proof inspection & Director resolution
  inspectProofBuffer,
  getAssignedDirector
};

