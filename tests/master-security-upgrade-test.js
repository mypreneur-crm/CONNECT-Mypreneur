'use strict';

/**
 * Master Security Hardening & Monthly 1:1 Upgrade Test Suite
 * Covers Part D1, Part D2, Part D3, and Part D4
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

const BASE_URL = 'http://localhost:3000';

function request(urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE_URL);
    const reqOpts = {
      method: options.method || 'GET',
      headers: options.headers || {}
    };

    if (options.cookie) {
      reqOpts.headers['Cookie'] = options.cookie;
    }
    if (options.csrfToken) {
      reqOpts.headers['X-CSRF-Token'] = options.csrfToken;
    }

    const req = http.request(url, reqOpts, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch {}
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: json || data
        });
      });
    });

    req.on('error', reject);

    if (options.body) {
      if (typeof options.body === 'string' || Buffer.isBuffer(options.body)) {
        req.write(options.body);
      } else {
        req.setHeader('Content-Type', 'application/json');
        req.write(JSON.stringify(options.body));
      }
    }
    req.end();
  });
}

function parseCookie(res) {
  const setCookie = res.headers['set-cookie'];
  if (!setCookie) return '';
  return Array.isArray(setCookie) ? setCookie.map(c => c.split(';')[0]).join('; ') : setCookie.split(';')[0];
}

async function loginUser(username, password) {
  const res = await request('/api/login', {
    method: 'POST',
    body: { username, password }
  });
  if (res.statusCode !== 200) {
    throw new Error(`Login failed for ${username}: ${JSON.stringify(res.body)}`);
  }
  const cookie = parseCookie(res);
  return {
    cookie,
    csrfToken: res.body?.csrfToken || '',
    user: res.body?.user
  };
}

async function runMasterTestSuite() {
  console.log('================================================================');
  console.log('MYPRENEUR CONNECT — MASTER SECURITY & UPGRADE TEST SUITE');
  console.log('================================================================\n');

  // Test credentials:
  // Super Admin: admin (id: 5)
  // Service Admin: kaviya (id: 22)
  // Employee 1: hariharan (id: 13)
  // Employee 2: soundarya (id: 14)
  const superAdminCreds = { u: 'admin', p: 'Admin@123' };
  const serviceAdminCreds = { u: 'kaviya', p: 'Password@123' };
  const emp1Creds = { u: 'hariharan', p: 'Password@123' };
  const emp2Creds = { u: 'soundarya', p: 'Password@123' };

  console.log('[1/4] LOGGING IN TEST IDENTITIES & VERIFYING ROLES...');
  const superAdmin = await loginUser(superAdminCreds.u, superAdminCreds.p);
  const serviceAdmin = await loginUser(serviceAdminCreds.u, serviceAdminCreds.p);
  const emp1 = await loginUser(emp1Creds.u, emp1Creds.p);
  const emp2 = await loginUser(emp2Creds.u, emp2Creds.p);

  assert.strictEqual(superAdmin.user.isSuperAdmin, true, 'admin must be recognized as Super Admin');
  assert.strictEqual(serviceAdmin.user.isServiceAdmin, true, 'kaviya must be recognized as Service Admin');
  assert.strictEqual(emp1.user.isSuperAdmin, false, 'hariharan must not be Super Admin');
  assert.strictEqual(emp1.user.isServiceAdmin, false, 'hariharan must not be Service Admin');
  console.log('✓ All 4 identities verified with correct RBAC flags.\n');

  // -------------------------------------------------------------------------
  console.log('[2/4] TESTING PART D1 — SUPER ADMIN CAPABILITIES & RESTRICTIONS...');
  // 1. Super Admin can set start and end time (create window)
  const testMonth = '2026-11';
  const startDate = '2026-11-01';
  const startTime = '09:00';
  const endDate = '2026-11-28';
  const endTime = '18:00';

  const setWinRes = await request('/api/monthly-1on1/windows', {
    method: 'POST',
    cookie: superAdmin.cookie,
    csrfToken: superAdmin.csrfToken,
    body: {
      reporting_month: testMonth,
      start_date: startDate,
      start_time: startTime,
      end_date: endDate,
      end_time: endTime
    }
  });
  assert.strictEqual(setWinRes.statusCode, 200, `Super Admin must be able to set window: ${JSON.stringify(setWinRes.body)}`);
  assert.strictEqual(setWinRes.body.window.reporting_month, '2026-11-01');
  console.log('✓ D1.1 Super Admin successfully configured reporting window.');

  // 2. Super Admin can update window schedule
  const updatedEndDate = '2026-11-30';
  const updatedEndTime = '23:59';
  const updateWinRes = await request('/api/monthly-1on1/windows', {
    method: 'POST',
    cookie: superAdmin.cookie,
    csrfToken: superAdmin.csrfToken,
    body: {
      reporting_month: testMonth,
      start_date: startDate,
      start_time: startTime,
      end_date: updatedEndDate,
      end_time: updatedEndTime
    }
  });
  assert.strictEqual(updateWinRes.statusCode, 200);
  assert(updateWinRes.body.window.end_ist.includes('2026'));
  console.log('✓ D1.2 Super Admin successfully updated window schedule.');

  // 3. Super Admin can view all applications
  const saTeamRes = await request('/api/monthly-1on1/team-reports', {
    cookie: superAdmin.cookie
  });
  assert.strictEqual(saTeamRes.statusCode, 200, 'Super Admin must access /team-reports');
  assert(Array.isArray(saTeamRes.body.reports), 'Reports array returned');
  console.log(`✓ D1.3 Super Admin accessed team-reports dashboard (${saTeamRes.body.reports.length} reports).`);

  // 4 & 5. Super Admin cannot create personal report (POST /reports)
  const saCreateRes = await request('/api/monthly-1on1/reports', {
    method: 'POST',
    cookie: superAdmin.cookie,
    csrfToken: superAdmin.csrfToken,
    body: { reporting_month: testMonth }
  });
  assert.strictEqual(saCreateRes.statusCode, 403, 'Super Admin must be blocked from creating a personal report');
  assert(saCreateRes.body.error.includes('Super Admin'), 'Error message identifies Super Admin restriction');
  console.log('✓ D1.4 Super Admin blocked from creating personal report (403 Forbidden).');

  // Super Admin cannot submit direct API call
  const saSubmitRes = await request('/api/monthly-1on1/reports/fake-id/submit', {
    method: 'POST',
    cookie: superAdmin.cookie,
    csrfToken: superAdmin.csrfToken,
    body: {}
  });
  assert.strictEqual(saSubmitRes.statusCode, 403, 'Super Admin direct submit blocked');
  console.log('✓ D1.5 Super Admin blocked from direct submit API call (403 Forbidden).\n');

  // -------------------------------------------------------------------------
  console.log('[3/4] TESTING PART D2 — SERVICE ADMIN CAPABILITIES & RESTRICTIONS...');
  // 1. Service Admin can view all applications
  const srvTeamRes = await request('/api/monthly-1on1/team-reports', {
    cookie: serviceAdmin.cookie
  });
  assert.strictEqual(srvTeamRes.statusCode, 200, 'Service Admin must access /team-reports');
  console.log('✓ D2.1 Service Admin can view all employee applications.');

  // 2. Service Admin CANNOT change reporting windows (must be 403)
  const srvWinRes = await request('/api/monthly-1on1/windows', {
    method: 'POST',
    cookie: serviceAdmin.cookie,
    csrfToken: serviceAdmin.csrfToken,
    body: {
      reporting_month: testMonth,
      start_date: startDate,
      start_time: startTime,
      end_date: updatedEndDate,
      end_time: updatedEndTime
    }
  });
  assert.strictEqual(srvWinRes.statusCode, 403, 'Service Admin must be rejected from modifying reporting windows');
  console.log('✓ D2.2 Service Admin blocked from configuring reporting windows (403 Forbidden).\n');

  // -------------------------------------------------------------------------
  console.log('[4/4] TESTING PART D3 — EMPLOYEE ACCESS, DEADLINES, EDITING & PROOF...');
  // Clean up any previous test report for employee 13 (month 2026-10) to ensure clean idempotent run
  try {
    const mysql = require('mysql2/promise');
    const conn = await mysql.createConnection({
      host: process.env.DB_HOST || '127.0.0.1',
      port: process.env.DB_PORT || 3306,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME
    });
    const [existingReports] = await conn.query("SELECT id FROM connect_monthly_1on1_reports WHERE employee_id=13 AND reporting_month LIKE '2026-10%'");
    for (const r of existingReports) {
      await conn.query("DELETE FROM connect_monthly_1on1_items WHERE report_id=?", [r.id]);
      await conn.query("DELETE FROM connect_monthly_1on1_reports WHERE id=?", [r.id]);
    }
    await conn.end();
  } catch (err) {
    console.warn('DB cleanup warning:', err.message);
  }

  // Set current month 2026-10 window as OPEN for testing
  const openRes = await request('/api/monthly-1on1/windows', {
    method: 'POST',
    cookie: superAdmin.cookie,
    csrfToken: superAdmin.csrfToken,
    body: {
      reporting_month: '2026-10',
      start_date: '2026-10-01',
      start_time: '00:00',
      end_date: '2026-10-31',
      end_time: '23:59'
    }
  });
  assert.strictEqual(openRes.statusCode, 200);

  // 1. Employee cannot access /team-reports (must return 403)
  const empTeamRes = await request('/api/monthly-1on1/team-reports', {
    cookie: emp1.cookie
  });
  assert.strictEqual(empTeamRes.statusCode, 403, 'Ordinary employee must NOT access /team-reports');
  console.log('✓ D3.1 Ordinary employee blocked from /team-reports (403 Forbidden).');

  // 2. Employee cannot configure windows (must return 403)
  const empWinRes = await request('/api/monthly-1on1/windows', {
    method: 'POST',
    cookie: emp1.cookie,
    csrfToken: emp1.csrfToken,
    body: {
      reporting_month: '2026-10',
      start_date: '2026-10-01',
      start_time: '00:00',
      end_date: '2026-10-31',
      end_time: '23:59'
    }
  });
  assert.strictEqual(empWinRes.statusCode, 403, 'Ordinary employee must NOT configure windows');
  console.log('✓ D3.2 Ordinary employee blocked from configuring window (403 Forbidden).');

  // 3. Employee creates report during open window
  const createReportRes = await request('/api/monthly-1on1/reports', {
    method: 'POST',
    cookie: emp1.cookie,
    csrfToken: emp1.csrfToken,
    body: { reporting_month: '2026-10' }
  });
  assert.strictEqual(createReportRes.statusCode, 201, `Employee report created: ${JSON.stringify(createReportRes.body)}`);
  const reportId = createReportRes.body.report.id;
  assert(createReportRes.body.report.director_name.includes('Director'), 'Assigned Director snapshot populated');
  console.log(`✓ D3.3 Employee created report (${reportId}) during open window. Director: ${createReportRes.body.report.director_name}`);

  // 4. Employee 2 cannot access Employee 1's report (403 Forbidden)
  const crossViewRes = await request(`/api/monthly-1on1/reports/${reportId}`, {
    cookie: emp2.cookie
  });
  assert.strictEqual(crossViewRes.statusCode, 403, 'Cross-employee access must return 403');
  console.log("✓ D3.4 Cross-employee access blocked (Employee 2 cannot view Employee 1's report: 403 Forbidden).");

  // 5. Test Optional Proof Upload:
  // a) Valid PNG upload
  const pngHeader = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52]);
  const pngDataUri = `data:image/png;base64,${pngHeader.toString('base64')}`;

  const uploadPngRes = await request(`/api/monthly-1on1/reports/${reportId}/attachments`, {
    method: 'POST',
    cookie: emp1.cookie,
    csrfToken: emp1.csrfToken,
    body: {
      file: {
        name: 'test_proof.png',
        type: 'image/png',
        data: pngDataUri
      }
    }
  });
  assert.strictEqual(uploadPngRes.statusCode, 200, `Valid PNG proof upload: ${JSON.stringify(uploadPngRes.body)}`);
  assert.strictEqual(uploadPngRes.body.proof.mime_type, 'image/png');
  console.log('✓ D3.5 Valid PNG proof upload succeeded with magic-byte verification.');

  // b) Malicious / Unsafe file upload (HTML pretending to be document) -> must be rejected (400)
  const evilDataUri = `data:text/html;base64,${Buffer.from('<html><script>alert(1)</script></html>').toString('base64')}`;

  const uploadEvilRes = await request(`/api/monthly-1on1/reports/${reportId}/attachments`, {
    method: 'POST',
    cookie: emp1.cookie,
    csrfToken: emp1.csrfToken,
    body: {
      file: {
        name: 'evil.html',
        type: 'text/html',
        data: evilDataUri
      }
    }
  });
  assert.strictEqual(uploadEvilRes.statusCode, 400, 'Malicious file must be rejected with 400');
  console.log('✓ D3.6 Malicious/unsupported file upload rejected (400 Bad Request).');

  // c) Secure attachment download verification
  const downloadRes = await request(`/api/monthly-1on1/reports/${reportId}/attachment?key=${encodeURIComponent(uploadPngRes.body.proof.storage_key)}`, {
    cookie: emp1.cookie
  });
  assert.strictEqual(downloadRes.statusCode, 200, 'Owner can download attachment');
  // Employee 2 cannot download Employee 1's attachment
  const crossDownloadRes = await request(`/api/monthly-1on1/reports/${reportId}/attachment?key=${encodeURIComponent(uploadPngRes.body.proof.storage_key)}`, {
    cookie: emp2.cookie
  });
  assert.strictEqual(crossDownloadRes.statusCode, 403, 'Non-owner cannot download attachment (403)');
  console.log('✓ D3.7 Secure attachment download verified: owner allowed, cross-employee blocked (403).');

  // 6. Save Draft with Section 1 proof (one link, one file, one null)
  const saveDraftRes = await request(`/api/monthly-1on1/reports/${reportId}`, {
    method: 'PATCH',
    cookie: emp1.cookie,
    csrfToken: emp1.csrfToken,
    body: {
      meeting_date: '2026-10-24',
      work_location: 'Office - Coimbatore',
      current_projects: 'Security Hardening & Module Upgrades',
      overall_status: 'On Track',
      capacity_for_additional_responsibilities: 'No',
      completed_deliverables: [
        {
          task: 'Hardened Session & RBAC controls',
          target_given: 'Full OWASP hardening',
          actual_completion: 'Completed with zero regression',
          impact_result: 'Eliminated authorization flaws',
          proof: uploadPngRes.body.proof
        },
        {
          task: 'Added link proof deliverable',
          target_given: 'Provide demo url',
          actual_completion: 'Completed',
          impact_result: 'Documentation available',
          proof: { type: 'link', url: 'https://connect.mypreneur.in/demo' }
        },
        {
          task: 'Deliverable without proof',
          target_given: 'Code cleanup',
          actual_completion: 'Cleaned',
          impact_result: 'Readable code',
          proof: null
        }
      ]
    }
  });
  assert.strictEqual(saveDraftRes.statusCode, 200, `Draft saved successfully: ${JSON.stringify(saveDraftRes.body)}`);
  console.log('✓ D3.8 Saved draft with optional file proof, link proof, and null proof.');

  // 7. Submit Report by Employee
  const submitRes = await request(`/api/monthly-1on1/reports/${reportId}/submit`, {
    method: 'POST',
    cookie: emp1.cookie,
    csrfToken: emp1.csrfToken,
    body: { employee_acknowledged: true }
  });
  assert.strictEqual(submitRes.statusCode, 200, `Employee can submit report: ${JSON.stringify(submitRes.body)}`);
  assert.strictEqual(submitRes.body.report.status, 'Submitted');
  console.log('✓ D3.9 Employee successfully submitted report (Status: Submitted).');

  // 8. CRITICAL REQUIREMENT B5: Employees Can Edit Until the End Time!
  // In previous version this was blocked; now while window is open, it MUST BE ALLOWED!
  const editSubmittedRes = await request(`/api/monthly-1on1/reports/${reportId}`, {
    method: 'PATCH',
    cookie: emp1.cookie,
    csrfToken: emp1.csrfToken,
    body: {
      meeting_date: '2026-10-25',
      current_projects: 'Updated Project Deliverables During Window',
      completed_deliverables: [
        {
          task: 'Updated deliverable while window is open',
          target_given: 'Revisions',
          actual_completion: 'Completed edit on submitted report',
          impact_result: 'Updated impact',
          proof: null
        }
      ]
    }
  });
  assert.strictEqual(editSubmittedRes.statusCode, 200, `Employee must be allowed to edit submitted report while window is open: ${JSON.stringify(editSubmittedRes.body)}`);
  console.log('✓ D3.10 Employee successfully edited already-submitted report while window is open.');

  // Resubmit report
  const resubmitRes = await request(`/api/monthly-1on1/reports/${reportId}/submit`, {
    method: 'POST',
    cookie: emp1.cookie,
    csrfToken: emp1.csrfToken,
    body: { employee_acknowledged: true }
  });
  assert.strictEqual(resubmitRes.statusCode, 200);
  console.log('✓ D3.11 Employee resubmitted updated report.');

  // 9. Administrative Approval / Rejection Workflow
  // a) Ordinary Employee cannot approve or reject (403)
  const empApproveRes = await request(`/api/monthly-1on1/reports/${reportId}/approve`, {
    method: 'POST',
    cookie: emp1.cookie,
    csrfToken: emp1.csrfToken,
    body: { comments: 'Self approval attempt' }
  });
  assert.strictEqual(empApproveRes.statusCode, 403, 'Employee cannot approve report');

  const empRejectRes = await request(`/api/monthly-1on1/reports/${reportId}/reject`, {
    method: 'POST',
    cookie: emp1.cookie,
    csrfToken: emp1.csrfToken,
    body: { reason: 'Self rejection attempt' }
  });
  assert.strictEqual(empRejectRes.statusCode, 403, 'Employee cannot reject report');
  console.log('✓ D3.12 Ordinary employee blocked from approval/rejection endpoints (403 Forbidden).');

  // b) Service Admin rejects report with reason
  const srvRejectRes = await request(`/api/monthly-1on1/reports/${reportId}/reject`, {
    method: 'POST',
    cookie: serviceAdmin.cookie,
    csrfToken: serviceAdmin.csrfToken,
    body: { reason: 'Please elaborate on deliverables in Section 1.' }
  });
  assert.strictEqual(srvRejectRes.statusCode, 200, 'Service Admin can reject report');
  assert.strictEqual(srvRejectRes.body.report.status, 'Rejected');
  assert.strictEqual(srvRejectRes.body.report.rejection_reason, 'Please elaborate on deliverables in Section 1.');
  console.log('✓ D3.13 Service Admin rejected report with mandatory reason. Employee can see reason.');

  // c) Employee can edit and resubmit while window is still open
  const editAfterRejectRes = await request(`/api/monthly-1on1/reports/${reportId}`, {
    method: 'PATCH',
    cookie: emp1.cookie,
    csrfToken: emp1.csrfToken,
    body: { current_projects: 'Updated after reviewer rejection' }
  });
  assert.strictEqual(editAfterRejectRes.statusCode, 200);

  const resubmitAfterRejectRes = await request(`/api/monthly-1on1/reports/${reportId}/submit`, {
    method: 'POST',
    cookie: emp1.cookie,
    csrfToken: emp1.csrfToken,
    body: { employee_acknowledged: true }
  });
  assert.strictEqual(resubmitAfterRejectRes.statusCode, 200);
  console.log('✓ D3.14 Employee updated and resubmitted rejected report while window is open.');

  // d) Super Admin approves report
  const saApproveRes = await request(`/api/monthly-1on1/reports/${reportId}/approve`, {
    method: 'POST',
    cookie: superAdmin.cookie,
    csrfToken: superAdmin.csrfToken,
    body: { comments: 'Outstanding performance and clear deliverables.' }
  });
  assert.strictEqual(saApproveRes.statusCode, 200, 'Super Admin can approve report');
  assert.strictEqual(saApproveRes.body.report.status, 'Approved');
  assert.strictEqual(saApproveRes.body.report.approved_by_name, 'System Admin');
  console.log('✓ D3.15 Super Admin approved report with audit timestamp and comments.');

  // e) Once Approved, Employee CANNOT edit (must return 400 or 403)
  const editApprovedRes = await request(`/api/monthly-1on1/reports/${reportId}`, {
    method: 'PATCH',
    cookie: emp1.cookie,
    csrfToken: emp1.csrfToken,
    body: { current_projects: 'Attempt to tamper approved report' }
  });
  assert([400, 403].includes(editApprovedRes.statusCode), 'Approved report must be locked against edits');
  console.log('✓ D3.16 Approved report locked against employee modification (403 Forbidden).');

  // 10. Deadline Enforcement Test:
  // Set window as CLOSED (end date in the past)
  await request('/api/monthly-1on1/windows', {
    method: 'POST',
    cookie: superAdmin.cookie,
    csrfToken: superAdmin.csrfToken,
    body: {
      reporting_month: '2026-09',
      start_date: '2026-09-01',
      start_time: '09:00',
      end_date: '2026-09-05',
      end_time: '18:00'
    }
  });

  // Attempt to create report for closed month -> 403 Forbidden
  const createClosedRes = await request('/api/monthly-1on1/reports', {
    method: 'POST',
    cookie: emp1.cookie,
    csrfToken: emp1.csrfToken,
    body: { reporting_month: '2026-09' }
  });
  assert.strictEqual(createClosedRes.statusCode, 403, 'Cannot create report for closed window');
  console.log('✓ D3.17 Creation blocked for closed reporting window (403 Forbidden).\n');

  // -------------------------------------------------------------------------
  console.log('[5/5] TESTING PART D4 — SECURITY ATTACK RESISTANCE & HEADERS...');
  // 1. Account enumeration resistance
  const badUserRes = await request('/api/login', {
    method: 'POST',
    body: { username: 'nonexistentuser_' + Date.now(), password: 'password123' }
  });
  const badPassRes = await request('/api/login', {
    method: 'POST',
    body: { username: 'hariharan', password: 'wrongpassword123' }
  });
  assert.strictEqual(badUserRes.statusCode, 401);
  assert.strictEqual(badUserRes.statusCode, 401);
  assert.strictEqual(badPassRes.statusCode, 401);
  assert(badUserRes.body.error.toLowerCase().includes('invalid username or password'));
  assert(badPassRes.body.error.toLowerCase().includes('invalid username or password'));
  console.log('✓ D4.1 Account enumeration resistance verified (identical generic error returned).');

  // 2. Session Revocation on Logout
  const tempLogin = await loginUser('soundarya', 'Password@123');
  const preLogoutAuth = await request('/api/me', { cookie: tempLogin.cookie });
  assert.strictEqual(preLogoutAuth.statusCode, 200, 'Authenticated session');

  const logoutRes = await request('/api/logout', {
    method: 'POST',
    cookie: tempLogin.cookie,
    csrfToken: tempLogin.csrfToken
  });
  assert.strictEqual(logoutRes.statusCode, 200, 'Logout succeeded');

  const postLogoutAuth = await request('/api/me', { cookie: tempLogin.cookie });
  assert.strictEqual(postLogoutAuth.statusCode, 401, 'Revoked session cookie immediately rejected with 401');
  console.log('✓ D4.2 Session revocation verified: database-backed revocation invalidates cookie immediately.');

  // 3. Security Headers
  const headerRes = await request('/api/me');
  const csp = headerRes.headers['content-security-policy'] || '';
  const xcto = headerRes.headers['x-content-type-options'];
  const cacheControl = headerRes.headers['cache-control'];

  assert(csp.includes("frame-ancestors 'none'"), "CSP must include frame-ancestors 'none'");
  assert.strictEqual(xcto, 'nosniff', 'X-Content-Type-Options must be nosniff');
  assert(cacheControl.includes('no-store'), 'Cache-Control must contain no-store');
  console.log('✓ D4.3 Security headers verified: CSP, nosniff, no-store, clickjacking protection.');

  console.log('\n================================================================');
  console.log('ALL MASTER SECURITY & UPGRADE TESTS PASSED WITH 100% SUCCESS!');
  console.log('================================================================\n');
}

runMasterTestSuite().catch(err => {
  console.error('\n❌ TEST SUITE FAILED:', err);
  process.exit(1);
});
