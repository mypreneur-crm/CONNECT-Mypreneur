'use strict';

const assert = require('node:assert');
const http = require('node:http');
const { MySQLDatabase, databaseConfig } = require('../lib/database');
const monthly1on1Db = require('../lib/monthly-1on1-db');
const { rewritePortalTables } = require('../lib/table-names');

async function runManagerReviewTestSuite() {
  console.log('=== STARTING MONTHLY 1:1 MANAGER REVIEW & FINAL ALIGNMENT TEST ===\n');

  const baseUrl = process.env.TEST_URL || 'http://localhost:3000';
  const db = new MySQLDatabase(databaseConfig());
  await db.get('SELECT 1');

  async function apiRequest(endpoint, { method = 'GET', body = null, cookie = '', csrfToken = '' } = {}) {
    const url = new URL(endpoint, baseUrl);
    const headers = { 'Accept': 'application/json' };
    if (cookie) headers['Cookie'] = cookie;
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
    let payload = null;
    if (body) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(url, { method, headers, body: payload });
    const isJson = (res.headers.get('content-type') || '').includes('application/json');
    const data = isJson ? await res.json().catch(() => ({})) : {};
    return { status: res.status, data, headers: res.headers };
  }

  const crypto = require('node:crypto');
  const SESSION_SECRET = process.env.SESSION_SECRET || 'mypreneur_connect_local_secret_32chars_long_key_1234';

  function signSession(userId, csrf) {
    const payload = { v: 1, userId: Number(userId), csrf, exp: Date.now() + 3600000 };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto.createHmac('sha256', SESSION_SECRET).update(encoded).digest('base64url');
    return `${encoded}.${signature}`;
  }

  async function createTestClient(userId) {
    const csrfToken = crypto.randomBytes(24).toString('base64url');
    const token = signSession(userId, csrfToken);
    const cookie = `mc_session=${token}`;
    const boot = await apiRequest('/api/bootstrap', { cookie, csrfToken });
    assert.strictEqual(boot.status, 200, `Bootstrap failed for user ${userId}`);
    return {
      user: boot.data.user,
      csrfToken,
      cookie
    };
  }

  console.log('1. Authenticating test users...');
  const admin = await createTestClient(5);
  const employee = await createTestClient(13);
  console.log(`   Admin: ${admin.user.name} (Role: ${admin.user.role})`);
  console.log(`   Employee: ${employee.user.name} (ID: ${employee.user.id}, Team: ${employee.user.team})`);

  console.log('\n2. Testing Manager Dashboard summary cards and filters...');
  const teamRepRes = await apiRequest('/api/monthly-1on1/team-reports?year=2026', {
    cookie: admin.cookie
  });
  assert.strictEqual(teamRepRes.status, 200);
  assert.ok(teamRepRes.data.summary, 'Summary object must be returned');
  const summary = teamRepRes.data.summary;
  console.log('   Dashboard Summary Cards:', summary);
  assert.ok(typeof summary.total_team_members === 'number', 'total_team_members must be number');
  assert.ok(typeof summary.submitted === 'number', 'submitted must be number');
  assert.ok(typeof summary.pending_submission === 'number', 'pending_submission must be number');
  assert.ok(typeof summary.under_review === 'number', 'under_review must be number');
  assert.ok(typeof summary.completed === 'number', 'completed must be number');

  console.log('\n3. Testing Reviewer Listing API...');
  const revRes = await apiRequest('/api/monthly-1on1/reviewers', { cookie: admin.cookie });
  assert.strictEqual(revRes.status, 200);
  assert.ok(Array.isArray(revRes.data.reviewers), 'Reviewers list must be an array');
  console.log(`   Found ${revRes.data.reviewers.length} eligible reviewers`);

  console.log('\n4. Setting up employee report for Manager Review testing...');
  const testMonth = '2026-08';
  // Clear any existing test report for 2026-08
  await db.run(
    rewritePortalTables('DELETE FROM monthly_1on1_items WHERE report_id IN (SELECT id FROM monthly_1on1_reports WHERE employee_id=? AND reporting_month=?)'),
    [employee.user.id, `${testMonth}-01`]
  );
  await db.run(
    rewritePortalTables('DELETE FROM monthly_1on1_reports WHERE employee_id=? AND reporting_month=?'),
    [employee.user.id, `${testMonth}-01`]
  );

  // Ensure window is open for test month
  await db.run(rewritePortalTables("UPDATE monthly_1on1_reports SET status='Closed' WHERE record_type='window'"));
  await db.run(
    rewritePortalTables("UPDATE monthly_1on1_reports SET status='Open', window_start='2026-08-01T00:00:00.000Z', window_end='2026-12-31T23:59:59.000Z', closed_at=NULL WHERE record_type='window' AND reporting_month=?"),
    [`${testMonth}-01`]
  );

  // Employee creates draft
  const createRes = await apiRequest('/api/monthly-1on1/reports', {
    method: 'POST',
    cookie: employee.cookie,
    csrfToken: employee.csrfToken,
    body: {
      reporting_month: testMonth,
      work_location: 'Chennai HQ',
      current_projects: 'Manager Review E2E Testing'
    }
  });
  assert.strictEqual(createRes.status, 201, `Create report failed: ${JSON.stringify(createRes.data)}`);
  const reportId = createRes.data.report.id;
  console.log(`   Created test report ID: ${reportId}`);

  // Employee adds items
  await apiRequest(`/api/monthly-1on1/reports/${reportId}`, {
    method: 'PATCH',
    cookie: employee.cookie,
    csrfToken: employee.csrfToken,
    body: {
      overall_status: 'On Track',
      capacity_for_additional_responsibilities: 'Yes',
      additional_responsibility_details: 'Can mentor junior developers',
      completed_deliverables: [
        { task: 'Manager dashboard design', target_given: '100%', actual_completion: '100%', impact_result: 'High', proof_link: 'https://connect.internal/doc1' }
      ],
      pending_tasks: [
        { task: 'Edge cases validation', reason_for_delay: 'None', current_status: 'In progress', support_needed: 'Reviewer alignment', expected_completion_date: '2026-11-20' }
      ],
      challenges_support: [
        { major_challenge: 'Cross-browser rendering', support_required: 'QA testing device' }
      ],
      responsibility_readiness: [
        { current_responsibilities: 'Core portal dev', next_responsibilities: 'Architecture review', clarity_required: 'Next quarter roadmap' }
      ],
      improvement_suggestions: [
        { suggestion: 'Automate weekly backup check' }
      ],
      monthly_priorities: [
        { priority_number: 1, description: 'Finalize manager alignment module' },
        { priority_number: 2, description: 'Complete test suite' },
        { priority_number: 3, description: 'Deploy to production' }
      ]
    }
  });

  // Employee submits report
  const submitRes = await apiRequest(`/api/monthly-1on1/reports/${reportId}/submit`, {
    method: 'POST',
    cookie: employee.cookie,
    csrfToken: employee.csrfToken,
    body: { acknowledged: true, employee_acknowledged: true }
  });
  assert.strictEqual(submitRes.status, 200, `Submit failed: ${JSON.stringify(submitRes.data)}`);
  assert.strictEqual(submitRes.data.report.status, 'Submitted');
  console.log('   Report successfully submitted by employee.');

  console.log('\n5. Verifying Access Rules & Security:');
  console.log('   a) Employee self-review attempt must be blocked (403)...');
  const selfRevRes = await apiRequest(`/api/monthly-1on1/reports/${reportId}/start-review`, {
    method: 'POST',
    cookie: employee.cookie,
    csrfToken: employee.csrfToken
  });
  assert.strictEqual(selfRevRes.status, 403, 'Self-review must be forbidden');
  console.log('      Blocked self-review (403 Forbidden).');

  console.log('   b) Employee self-finalization attempt must be blocked (403)...');
  const selfFinRes = await apiRequest(`/api/monthly-1on1/reports/${reportId}/finalize`, {
    method: 'POST',
    cookie: employee.cookie,
    csrfToken: employee.csrfToken,
    body: { reviewer_acknowledged: true, key_observation: 'Self review' }
  });
  assert.strictEqual(selfFinRes.status, 403, 'Self-finalization must be forbidden');
  console.log('      Blocked self-finalization (403 Forbidden).');

  console.log('   c) Assigning authorized manager via HR/Admin assignment flow...');
  const assignRes = await apiRequest(`/api/monthly-1on1/reports/${reportId}/assign-reviewer`, {
    method: 'POST',
    cookie: admin.cookie,
    csrfToken: admin.csrfToken,
    body: { reviewer_id: admin.user.id }
  });
  assert.strictEqual(assignRes.status, 200);
  assert.strictEqual(Number(assignRes.data.report.reviewer_id), Number(admin.user.id));
  console.log(`      Assigned reviewer ID #${admin.user.id} (${assignRes.data.report.reviewer_name})`);

  console.log('\n6. Testing Review Action: Start Review...');
  const startRevRes = await apiRequest(`/api/monthly-1on1/reports/${reportId}/start-review`, {
    method: 'POST',
    cookie: admin.cookie,
    csrfToken: admin.csrfToken
  });
  assert.strictEqual(startRevRes.status, 200);
  assert.strictEqual(startRevRes.data.report.status, 'Under Review');
  console.log('   Status transitioned to Under Review.');

  console.log('\n7. Testing Review Action: Save Manager Notes (Section 6)...');
  const saveNotesRes = await apiRequest(`/api/monthly-1on1/reports/${reportId}/notes`, {
    method: 'PATCH',
    cookie: admin.cookie,
    csrfToken: admin.csrfToken,
    body: {
      key_observation: 'Strong technical delivery and proactive problem solving.',
      final_responsibility_assigned: 'Lead Project Reinvent architectural enhancements.',
      follow_up_date: '2026-11-28',
      additional_comments: 'Regular touchpoint scheduled bi-weekly.'
    }
  });
  assert.strictEqual(saveNotesRes.status, 200);
  const mn = saveNotesRes.data.report.manager_notes;
  assert.strictEqual(mn.key_observation, 'Strong technical delivery and proactive problem solving.');
  assert.strictEqual(mn.final_responsibility_assigned, 'Lead Project Reinvent architectural enhancements.');
  assert.strictEqual(mn.follow_up_date, '2026-11-28');
  assert.strictEqual(saveNotesRes.data.report.status, 'Under Review', 'Report remains in Under Review during draft notes save');
  console.log('   Manager notes saved in manager_notes_json successfully.');

  console.log('\n8. Testing Review Action: Request Revision...');
  // Missing reason validation
  const invalidRevReq = await apiRequest(`/api/monthly-1on1/reports/${reportId}/request-revision`, {
    method: 'POST',
    cookie: admin.cookie,
    csrfToken: admin.csrfToken,
    body: { reason: '' }
  });
  assert.strictEqual(invalidRevReq.status, 400, 'Empty reason must return 400');

  // Valid revision request
  const validRevReq = await apiRequest(`/api/monthly-1on1/reports/${reportId}/request-revision`, {
    method: 'POST',
    cookie: admin.cookie,
    csrfToken: admin.csrfToken,
    body: { reason: 'Please elaborate on the impact metrics for completed deliverable #1.' }
  });
  assert.strictEqual(validRevReq.status, 200);
  assert.strictEqual(validRevReq.data.report.status, 'Revision Requested');
  assert.strictEqual(validRevReq.data.report.revision_reason, 'Please elaborate on the impact metrics for completed deliverable #1.');
  console.log('   Status changed to Revision Requested with revision reason saved.');

  console.log('\n9. Testing Employee Resubmission (preserving answers & editing)...');
  // Check employee can load their report with previous answers intact
  const reloadRes = await apiRequest(`/api/monthly-1on1/reports/${reportId}`, { cookie: employee.cookie });
  assert.strictEqual(reloadRes.status, 200);
  assert.ok(reloadRes.data.report.items.completed_deliverables.length > 0, 'Previous answers must be preserved');

  // Employee updates deliverable impact
  await apiRequest(`/api/monthly-1on1/reports/${reportId}`, {
    method: 'PATCH',
    cookie: employee.cookie,
    csrfToken: employee.csrfToken,
    body: {
      completed_deliverables: [
        { task: 'Manager dashboard design', target_given: '100%', actual_completion: '100%', impact_result: 'Accelerated quarterly review cycle by 40%', proof_link: 'https://connect.internal/doc1' }
      ]
    }
  });

  // Employee resubmits
  const resubmitRes = await apiRequest(`/api/monthly-1on1/reports/${reportId}/submit`, {
    method: 'POST',
    cookie: employee.cookie,
    csrfToken: employee.csrfToken,
    body: { acknowledged: true, employee_acknowledged: true }
  });
  assert.strictEqual(resubmitRes.status, 200);
  assert.strictEqual(resubmitRes.data.report.status, 'Submitted');
  console.log('   Employee successfully edited and resubmitted report.');

  console.log('\n10. Testing Manager Finalization with Acknowledgement...');
  // Manager starts review again
  await apiRequest(`/api/monthly-1on1/reports/${reportId}/start-review`, {
    method: 'POST',
    cookie: admin.cookie,
    csrfToken: admin.csrfToken
  });

  // Finalize without acknowledgement must fail
  const unackFinalize = await apiRequest(`/api/monthly-1on1/reports/${reportId}/finalize`, {
    method: 'POST',
    cookie: admin.cookie,
    csrfToken: admin.csrfToken,
    body: {
      reviewer_acknowledged: false,
      key_observation: 'Completed all revisions.'
    }
  });
  assert.strictEqual(unackFinalize.status, 400, 'Reviewer acknowledgement must be required');

  // Finalize without key observation must fail
  const emptyKeyObsFinalize = await apiRequest(`/api/monthly-1on1/reports/${reportId}/finalize`, {
    method: 'POST',
    cookie: admin.cookie,
    csrfToken: admin.csrfToken,
    body: {
      reviewer_acknowledged: true,
      key_observation: ''
    }
  });
  assert.strictEqual(emptyKeyObsFinalize.status, 400, 'Key observation must be required');

  // Valid finalization
  const finalizeRes = await apiRequest(`/api/monthly-1on1/reports/${reportId}/finalize`, {
    method: 'POST',
    cookie: admin.cookie,
    csrfToken: admin.csrfToken,
    body: {
      reviewer_acknowledged: true,
      key_observation: 'Excellent updates provided. Clear goals set for next month.',
      final_responsibility: 'Lead Project Reinvent sprint execution.',
      follow_up_date: '2026-11-30',
      additional_comments: 'Final alignment confirmed.'
    }
  });
  assert.strictEqual(finalizeRes.status, 200);
  const finalReport = finalizeRes.data.report;
  assert.strictEqual(finalReport.status, 'Completed');
  assert.ok(finalReport.completed_at, 'completed_at must be populated');
  assert.ok(finalReport.reviewer_acknowledged_at, 'reviewer_acknowledged_at must be populated');
  assert.strictEqual(Number(finalReport.reviewer_id), Number(admin.user.id));
  assert.strictEqual(finalReport.reviewer_name, admin.user.name);
  console.log('   Report finalized: Status=Completed, Reviewer Ack recorded.');

  console.log('\n11. Verifying Finalized Report is Locked (Read-Only)...');
  const lockedEditAttempt = await apiRequest(`/api/monthly-1on1/reports/${reportId}`, {
    method: 'PATCH',
    cookie: employee.cookie,
    csrfToken: employee.csrfToken,
    body: { overall_status: 'Needs Attention' }
  });
  assert.strictEqual(lockedEditAttempt.status, 400, 'Edits to completed report must be rejected');
  console.log('   Finalized report is strictly read-only and locked.');

  console.log('\n12. Verifying Electronic Acknowledgements & Notes Visibility...');
  // Employee loads completed report
  const empViewFinal = await apiRequest(`/api/monthly-1on1/reports/${reportId}`, { cookie: employee.cookie });
  assert.strictEqual(empViewFinal.status, 200);
  const rFinal = empViewFinal.data.report;
  assert.ok(rFinal.employee_acknowledged_at, 'Employee acknowledgement timestamp visible');
  assert.ok(rFinal.reviewer_acknowledged_at, 'Reviewer acknowledgement timestamp visible');
  assert.strictEqual(rFinal.manager_notes.key_observation, 'Excellent updates provided. Clear goals set for next month.');
  console.log(`   Employee Acknowledgement: ${rFinal.employee_name} (${rFinal.employee_acknowledged_at})`);
  console.log(`   Reviewer Acknowledgement: ${rFinal.reviewer_name} (${rFinal.reviewer_acknowledged_at})`);
  console.log('   Final manager notes are visible to the employee.');

  console.log('\n13. Verifying Complete Audit Trail...');
  const auditRows = await db.all(
    rewritePortalTables('SELECT action, entity_id, user_id, created_at FROM audit_logs WHERE entity="monthly_1on1" AND entity_id=? ORDER BY created_at ASC'),
    [reportId]
  );
  const actions = auditRows.map(a => a.action);
  console.log('   Recorded Audit Actions for Report:', actions);
  assert.ok(actions.includes('MONTHLY_1ON1_CREATED'), 'Must include CREATED');
  assert.ok(actions.includes('MONTHLY_1ON1_SUBMITTED'), 'Must include SUBMITTED');
  assert.ok(actions.includes('MONTHLY_1ON1_REVIEW_STARTED'), 'Must include REVIEW_STARTED');
  assert.ok(actions.includes('MONTHLY_1ON1_REVISION_REQUESTED'), 'Must include REVISION_REQUESTED');
  assert.ok(actions.includes('MONTHLY_1ON1_RESUBMITTED'), 'Must include RESUBMITTED');
  assert.ok(actions.includes('MONTHLY_1ON1_COMPLETED'), 'Must include COMPLETED');

  // Clean up test report
  await db.run(rewritePortalTables('DELETE FROM monthly_1on1_items WHERE report_id=?'), [reportId]);
  await db.run(rewritePortalTables('DELETE FROM monthly_1on1_reports WHERE id=?'), [reportId]);
  await db.run(rewritePortalTables('DELETE FROM audit_logs WHERE entity="monthly_1on1" AND entity_id=?'), [reportId]);
  await db.close();

  console.log('\n=== ALL 13 MANAGER REVIEW & FINAL ALIGNMENT VERIFICATION CHECKS PASSED! ===');
}

runManagerReviewTestSuite().catch(err => {
  console.error('\nTest failed with error:', err);
  process.exit(1);
});
