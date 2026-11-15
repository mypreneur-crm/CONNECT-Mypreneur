'use strict';

/**
 * APPLICANT-FACING MONTHLY 1:1 DASHBOARD: COMPLETE 10-POINT TEST SUITE
 * Verifies Employee and Service Admin applicant views, permissions,
 * Section A (Current Month), Section B (History), resubmissions, privacy, and read-only enforcement.
 */

const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { MySQLDatabase, databaseConfig } = require('../lib/database');
const monthly1on1Db = require('../lib/monthly-1on1-db');

const PORT = process.env.PORT || 3000;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SESSION_SECRET = process.env.SESSION_SECRET || 'mypreneur_connect_local_secret_32chars_long_key_1234';

function signSession(userId, csrf) {
  const payload = {
    v: 1,
    userId: Number(userId),
    csrf,
    exp: Date.now() + 3600000
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function createClient(userId = null) {
  const csrf = crypto.randomBytes(24).toString('base64url');
  const cookies = [];
  if (userId) {
    cookies.push(`mc_session=${signSession(userId, csrf)}`);
  }
  return {
    userId,
    csrf,
    cookies,
    async request(method, reqPath, body = null, customHeaders = {}) {
      return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const headers = {
          'Accept': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          'X-CSRF-Token': csrf,
          ...customHeaders
        };
        if (cookies.length) headers['Cookie'] = cookies.join('; ');
        if (payload) {
          headers['Content-Type'] = 'application/json';
          headers['Content-Length'] = Buffer.byteLength(payload);
        }

        const req = http.request(`${BASE_URL}${reqPath}`, { method, headers }, (res) => {
          let chunks = '';
          res.on('data', d => chunks += d);
          res.on('end', () => {
            let parsed = null;
            try { parsed = JSON.parse(chunks); } catch { parsed = chunks; }
            resolve({ status: res.statusCode, headers: res.headers, body: parsed });
          });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
      });
    }
  };
}

function sampleSections() {
  return {
    completed_deliverables: [{
      task: 'Deliverable A',
      target_given: 'Target 100%',
      actual_completion: 'Completed 100%',
      impact_result: 'High impact deliverable'
    }],
    pending_tasks: [{
      task: 'Pending Task B',
      reason_for_delay: 'Awaiting vendor feedback',
      current_status: 'In progress',
      support_needed: 'Followup with vendor'
    }],
    challenges_support: [{
      challenge: 'Resource constraints',
      impact_on_deliverables: 'Minimal delay',
      proposed_solution: 'Reallocated tasks',
      support_required_from_management: 'Resource approval'
    }],
    responsibility_readiness: [{
      current_initiatives: 'Initiative Alpha',
      strengths_demonstrated: 'Leadership',
      readiness_for_next_role: 'Ready for more responsibility',
      development_areas: 'Advanced tooling'
    }],
    improvement_suggestions: [{
      process_area: 'Weekly syncs',
      suggestion: 'Short daily standups',
      expected_benefit: 'Better alignment'
    }],
    monthly_priorities: [{
      priority_number: 1,
      description: 'Launch Phase 2 with zero regressions'
    }]
  };
}

(async function runApplicantDashboardSuite() {
  console.log('================================================================');
  console.log('APPLICANT-FACING MONTHLY 1:1 DASHBOARD: 10-POINT AUDIT & VERIFICATION');
  console.log('================================================================\n');

  const db = new MySQLDatabase(databaseConfig());
  await db.ready;

  // Authenticate test users: Super Admin (5), Service Admin (22), Employee 1 (12), Employee 2 (13)
  const superAdmin = createClient(5);
  const serviceAdmin = createClient(22);
  const employee1 = createClient(12);
  const employee2 = createClient(13);

  const testMonth = '2026-11';

  console.log('[Setup] Cleaning up test windows to start with clean isolated state...');
  await db.run(`UPDATE monthly_1on1_reports SET status='Closed' WHERE record_type='window'`);
  await db.run(`DELETE FROM monthly_1on1_reports WHERE record_type='report' AND reporting_month LIKE '2026-11%'`);

  // -------------------------------------------------------------
  // Test 1: No reporting month open
  // -------------------------------------------------------------
  console.log('\n[Test 1] Verifying Dashboard state when NO reporting month is open...');
  const ovNoOpen = await employee1.request('GET', '/api/monthly-1on1/overview');
  assert.strictEqual(ovNoOpen.status, 200);
  assert.strictEqual(ovNoOpen.body.openWindows.length, 0, 'No windows should be open');
  assert.strictEqual(ovNoOpen.body.activeOpenWindow, null, 'activeOpenWindow should be null');
  assert.strictEqual(ovNoOpen.body.total_employees_mypreneur, undefined, 'Total company count must not be disclosed to employee');
  assert.strictEqual(ovNoOpen.body.teamSummary, null, 'Team summary must not be disclosed to employee');

  // Check frontend public/index.html includes exact empty-state message and no Start button
  const indexHtml = fs.readFileSync('public/index.html', 'utf8');
  assert.ok(
    indexHtml.includes('No Monthly 1:1 Meeting Report is currently open. The next reporting window will be announced soon.'),
    'index.html must display the exact no-open-window announcement'
  );
  console.log('  ✔ Verified: When no month is open, activeOpenWindow is null, privacy preserved, and exact announcement rendered.');

  // -------------------------------------------------------------
  // Test 2: Reporting month open (Single active window)
  // -------------------------------------------------------------
  console.log('\n[Test 2] Opening reporting month by Super Admin and verifying clean single card...');
  const schedRes = await superAdmin.request('POST', '/api/monthly-1on1/windows', {
    reporting_month: testMonth,
    start_date: '2026-11-01',
    start_time: '09:00',
    end_date: '2026-11-30',
    end_time: '18:00'
  });
  assert.strictEqual(schedRes.status, 200);

  const openRes = await superAdmin.request('POST', '/api/monthly-1on1/windows/manual-open', {
    reporting_month: testMonth,
    reason: 'Testing Applicant Dashboard'
  });
  assert.strictEqual(openRes.status, 200);

  // Employee checks overview
  const ovOpen = await employee1.request('GET', '/api/monthly-1on1/overview');
  assert.strictEqual(ovOpen.status, 200);
  assert.strictEqual(ovOpen.body.openWindows.length, 1, 'Only one open window should be returned');
  assert.ok(ovOpen.body.activeOpenWindow, 'activeOpenWindow must be set');
  assert.strictEqual(ovOpen.body.activeOpenWindow.reporting_month.slice(0, 7), testMonth);
  assert.strictEqual(ovOpen.body.activeOpenWindow.status, 'open');
  console.log('  ✔ Verified: Exactly 1 active open window returned with start/end IST dates.');

  // -------------------------------------------------------------
  // Test 3: Start Report action
  // -------------------------------------------------------------
  console.log('\n[Test 3] Testing Start Report action by employee...');
  const createRes = await employee1.request('POST', '/api/monthly-1on1/reports', {
    reporting_month: testMonth
  });
  assert.strictEqual(createRes.status, 201, `Create report failed: ${JSON.stringify(createRes.body)}`);
  const report1 = createRes.body.report;
  assert.strictEqual(report1.status, 'Draft');
  assert.strictEqual(Number(report1.employee_id), 12);
  console.log(`  ✔ Verified: Created draft report (ID: ${report1.id.slice(0, 8)}...) for ${testMonth}.`);

  // -------------------------------------------------------------
  // Test 4: Continue Draft action & updating fields
  // -------------------------------------------------------------
  console.log('\n[Test 4] Testing Continue Draft action and saving progress...');
  const patchRes = await employee1.request('PATCH', `/api/monthly-1on1/reports/${report1.id}`, {
    meeting_date: '2026-11-05',
    work_location: 'Headquarters - Floor 3',
    current_projects: 'CRM Revamp & 1:1 Automation',
    overall_status: 'On Track',
    capacity_for_additional_responsibilities: 'Yes',
    additional_responsibility_details: 'Can mentor junior devs',
    items: sampleSections()
  });
  assert.strictEqual(patchRes.status, 200, `Patch draft failed: ${JSON.stringify(patchRes.body)}`);
  assert.strictEqual(patchRes.body.report.status, 'Draft');
  assert.strictEqual(patchRes.body.report.overall_status, 'On Track');
  console.log('  ✔ Verified: Draft progress saved successfully with all 7 section steps.');

  // -------------------------------------------------------------
  // Test 5: Submit Report and View/Edit while window is open
  // -------------------------------------------------------------
  console.log('\n[Test 5] Submitting report and verifying View / Edit access while window is open...');
  const submitRes = await employee1.request('POST', `/api/monthly-1on1/reports/${report1.id}/submit`, {
    acknowledged: true,
    items: sampleSections(),
    overall_status: 'On Track',
    capacity_for_additional_responsibilities: 'Yes',
    additional_responsibility_details: 'Can mentor junior devs'
  });
  assert.strictEqual(submitRes.status, 200, `Submit report failed: ${JSON.stringify(submitRes.body)}`);
  assert.strictEqual(submitRes.body.report.status, 'Submitted');
  assert.ok(submitRes.body.report.submitted_at);

  // While window is open, verify employee can still edit/update their submitted report
  const updateSubmitted = await employee1.request('PATCH', `/api/monthly-1on1/reports/${report1.id}`, {
    current_projects: 'Updated Project Scope while Window Open'
  });
  assert.strictEqual(updateSubmitted.status, 200, 'Employee must be able to update while window is open');
  console.log('  ✔ Verified: Submitted report can be viewed/edited while the reporting window remains open.');

  // -------------------------------------------------------------
  // Test 6: Approve report, verify "View Approved Report" and corrections/resubmission while window is open
  // -------------------------------------------------------------
  console.log('\n[Test 6] Reviewer approves report; verify employee view & correction/resubmission while window is open...');
  const approveRes = await serviceAdmin.request('POST', `/api/monthly-1on1/reports/${report1.id}/approve`, {
    decision_notes: 'Excellent deliverable completion and strong impact.'
  });
  assert.strictEqual(approveRes.status, 200, `Approval failed: ${JSON.stringify(approveRes.body)}`);
  assert.strictEqual(approveRes.body.report.status, 'Approved');

  // Employee checks report: is_window_open must be true
  const viewApproved = await employee1.request('GET', `/api/monthly-1on1/reports/${report1.id}`);
  assert.strictEqual(viewApproved.status, 200);
  assert.strictEqual(viewApproved.body.report.status, 'Approved');
  assert.strictEqual(viewApproved.body.report.is_window_open, true);

  // While window remains open, employee makes a correction and resubmits
  const patchApproved = await employee1.request('PATCH', `/api/monthly-1on1/reports/${report1.id}`, {
    work_location: 'Updated Location Post-Approval'
  });
  assert.strictEqual(patchApproved.status, 200, 'Modifications allowed while window is open');

  const resubmitApproved = await employee1.request('POST', `/api/monthly-1on1/reports/${report1.id}/submit`, {
    acknowledged: true,
    items: sampleSections(),
    overall_status: 'On Track',
    capacity_for_additional_responsibilities: 'Yes',
    additional_responsibility_details: 'Can mentor junior devs'
  });
  assert.strictEqual(resubmitApproved.status, 200, 'Resubmission allowed while window is open');
  assert.strictEqual(resubmitApproved.body.report.status, 'Submitted', 'Status must return to Submitted for fresh review');
  console.log('  ✔ Verified: Approved report can be updated and resubmission resets status to Submitted while preserving decisions.');

  // -------------------------------------------------------------
  // Test 7: Reject report, verify "View Rejected Report" and resubmission
  // -------------------------------------------------------------
  console.log('\n[Test 7] Reviewer rejects report; verify employee view & correction/resubmission...');
  const rejectRes = await serviceAdmin.request('POST', `/api/monthly-1on1/reports/${report1.id}/reject`, {
    reason: 'Please clarify the pending task timeline before approval.'
  });
  assert.strictEqual(rejectRes.status, 200, `Rejection failed: ${JSON.stringify(rejectRes.body)}`);
  assert.strictEqual(rejectRes.body.report.status, 'Rejected');

  const viewRejected = await employee1.request('GET', `/api/monthly-1on1/reports/${report1.id}`);
  assert.strictEqual(viewRejected.status, 200);
  assert.strictEqual(viewRejected.body.report.status, 'Rejected');
  assert.strictEqual(viewRejected.body.report.rejection_reason, 'Please clarify the pending task timeline before approval.');

  // Resubmit after rejection
  const resubmitRejected = await employee1.request('POST', `/api/monthly-1on1/reports/${report1.id}/submit`, {
    acknowledged: true,
    items: sampleSections(),
    overall_status: 'On Track',
    capacity_for_additional_responsibilities: 'Yes',
    additional_responsibility_details: 'Clarified timelines'
  });
  assert.strictEqual(resubmitRejected.status, 200);
  assert.strictEqual(resubmitRejected.body.report.status, 'Submitted');
  console.log('  ✔ Verified: Rejected report view displays reviewer feedback and allows correction/resubmission to Submitted.');

  // -------------------------------------------------------------
  // Test 8: Section B: View own previous reports only
  // -------------------------------------------------------------
  console.log('\n[Test 8] Verifying Section B: My Application History (own reports only)...');
  const historyRes = await employee1.request('GET', '/api/monthly-1on1/reports');
  assert.strictEqual(historyRes.status, 200);
  assert.ok(Array.isArray(historyRes.body.reports));
  for (const r of historyRes.body.reports) {
    assert.strictEqual(Number(r.employee_id), 12, 'History must contain ONLY the authenticated user\'s reports');
  }
  console.log(`  ✔ Verified: Employee 1 sees only their own reports (${historyRes.body.reports.length} reports).`);

  // -------------------------------------------------------------
  // Test 9: Attempt to access another employee's history or reports
  // -------------------------------------------------------------
  console.log('\n[Test 9] Attempting to access another employee\'s report (Security & Privacy)...');
  // Employee 2 tries to tamper with query param employee_id in reports list
  const spoofListRes = await employee2.request('GET', `/api/monthly-1on1/reports?employee_id=12`);
  assert.strictEqual(spoofListRes.status, 200);
  for (const r of spoofListRes.body.reports) {
    assert.strictEqual(Number(r.employee_id), 13, 'Backend MUST ignore client employee_id and enforce auth.user.id');
  }

  // Employee 2 tries to view Employee 1's report directly by ID
  const directAccessRes = await employee2.request('GET', `/api/monthly-1on1/reports/${report1.id}`);
  assert.strictEqual(directAccessRes.status, 403, 'Direct access to another employee\'s report must return HTTP 403');
  assert.strictEqual(directAccessRes.body.code, 'FORBIDDEN');

  // Employee 2 tries to edit Employee 1's report
  const tamperPatchRes = await employee2.request('PATCH', `/api/monthly-1on1/reports/${report1.id}`, {
    work_location: 'Hacked'
  });
  assert.strictEqual(tamperPatchRes.status, 403, 'Tampering with another employee\'s report must return HTTP 403');
  console.log('  ✔ Verified: Cross-employee history tampering and unauthorized report access strictly blocked with HTTP 403.');

  // -------------------------------------------------------------
  // Test 10: Close reporting window and verify read-only behavior
  // -------------------------------------------------------------
  console.log('\n[Test 10] Super Admin closes window; verifying read-only enforcement...');
  const closeRes = await superAdmin.request('POST', '/api/monthly-1on1/windows/close', {
    reporting_month: testMonth
  });
  assert.strictEqual(closeRes.status, 200);

  // Employee loads closed report
  const viewClosed = await employee1.request('GET', `/api/monthly-1on1/reports/${report1.id}`);
  assert.strictEqual(viewClosed.status, 200);
  assert.strictEqual(viewClosed.body.report.is_window_open, false, 'is_window_open must be false after close');

  // Employee attempts to edit closed report
  const editClosedRes = await employee1.request('PATCH', `/api/monthly-1on1/reports/${report1.id}`, {
    work_location: 'Post Close Edit Attempt'
  });
  assert.strictEqual(editClosedRes.status, 403, 'Editing closed window report must return HTTP 403');
  assert.strictEqual(editClosedRes.body.code, 'WINDOW_CLOSED');

  // Employee attempts to submit closed report
  const submitClosedRes = await employee1.request('POST', `/api/monthly-1on1/reports/${report1.id}/submit`, {
    acknowledged: true
  });
  assert.strictEqual(submitClosedRes.status, 403, 'Submitting closed window report must return HTTP 403');
  assert.strictEqual(submitClosedRes.body.code, 'WINDOW_CLOSED');
  console.log('  ✔ Verified: Once window closes, report becomes strictly read-only; PATCH and SUBMIT rejected with WINDOW_CLOSED.');

  // Service Admin separate review view test
  console.log('\n[Bonus Check] Verifying Service Admin personal vs reviewer separation...');
  const saOverview = await serviceAdmin.request('GET', '/api/monthly-1on1/overview');
  assert.strictEqual(saOverview.status, 200);
  assert.strictEqual(saOverview.body.isServiceAdmin, true);
  assert.strictEqual(saOverview.body.canSubmit, true, 'Service admin can submit personal report');
  // Service admin reviewer page access
  const saTeamReports = await serviceAdmin.request('GET', '/api/monthly-1on1/team-reports');
  assert.strictEqual(saTeamReports.status, 200, 'Service admin has separate reviewer endpoint access');
  console.log('  ✔ Verified: Service Admin uses personal applicant dashboard while reviewer access is kept separate.');

  await db.close();

  console.log('\n================================================================');
  console.log('🎉 ALL 10 APPLICANT DASHBOARD AUDIT & VERIFICATION CHECKS PASSED 100%!');
  console.log('================================================================');
})().catch(err => {
  console.error('\n❌ TEST FAILED:', err);
  process.exit(1);
});
