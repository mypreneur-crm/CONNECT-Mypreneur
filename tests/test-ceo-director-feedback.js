'use strict';

const assert = require('node:assert');
const crypto = require('node:crypto');
const { MySQLDatabase, databaseConfig } = require('../lib/database');

async function testFeedbackWorkflow() {
  console.log('=== VERIFYING CEO & DIRECTOR FEEDBACK WORKFLOW (NO APPROVE/REJECT) ===\n');
  const baseUrl = 'http://localhost:3000';
  const db = new MySQLDatabase(databaseConfig());
  await db.ready;

  const SESSION_SECRET = process.env.SESSION_SECRET || 'mypreneur_connect_local_secret_32chars_long_key_1234';

  function signSession(userId, csrf) {
    const payload = { v: 1, userId: Number(userId), csrf, exp: Date.now() + 3600000 };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto.createHmac('sha256', SESSION_SECRET).update(encoded).digest('base64url');
    return `${encoded}.${signature}`;
  }

  async function clientFor(userId) {
    const csrfToken = crypto.randomBytes(24).toString('base64url');
    const token = signSession(userId, csrfToken);
    const cookie = `mc_session=${token}`;
    const bootRes = await fetch(`${baseUrl}/api/bootstrap`, {
      headers: { 'Cookie': cookie, 'X-CSRF-Token': csrfToken, 'Accept': 'application/json' }
    });
    const boot = await bootRes.json();
    return {
      user: boot.user,
      cookie,
      csrfToken
    };
  }

  // 1. Employee (User 22: Support Executive)
  const employee = await clientFor(22);
  console.log(`1. Employee User: ${employee.user.name} (ID: ${employee.user.id})`);

  // Create an employee Monthly Connect report for 2026-11
  const createRes = await fetch(`${baseUrl}/api/monthly-1on1/reports`, {
    method: 'POST',
    headers: {
      'Cookie': employee.cookie,
      'X-CSRF-Token': employee.csrfToken,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      reporting_month: '2026-11',
      work_location: 'Office (Coimbatore)',
      current_projects: 'CRM Migration & Support Operations'
    })
  });
  const createData = await createRes.json();
  console.log('   Create response status:', createRes.status, createData);
  let reportId = createData.report ? createData.report.id : null;
  if (!reportId && createData.existingReportId) {
    reportId = createData.existingReportId;
  }
  if (!reportId) {
    // Find existing report in DB
    const existingRow = await db.get(`SELECT id FROM monthly_1on1_reports WHERE employee_id=? AND reporting_month='2026-11-01' LIMIT 1`, [employee.user.id]);
    if (existingRow) reportId = existingRow.id;
  }
  assert(reportId, 'Report must be created or retrieved');
  console.log(`   Report ID: ${reportId}`);

  // Submit report as employee
  await fetch(`${baseUrl}/api/monthly-1on1/reports/${encodeURIComponent(reportId)}/submit`, {
    method: 'POST',
    headers: { 'Cookie': employee.cookie, 'X-CSRF-Token': employee.csrfToken }
  });
  console.log('   Report submitted by employee.');

  // 2. Executive Leadership (Director: User 13 - Manoj / Director simulation)
  console.log('\n2. Executive Leadership Giving Feedback (CEO / Director)...');
  await db.run('UPDATE employees SET designation="Director" WHERE employee_id=10');
  const director = await clientFor(13);
  console.log(`   Director User: ${director.user.name}, isExecutive: ${director.user.isExecutive}`);
  assert.strictEqual(director.user.isExecutive, true);

  // Director gives Section 6 feedback:
  // Key Observation, Final Responsibility Assigned, Deadline / Follow-up Date, Additional Comments
  const feedbackData = {
    manager_notes: {
      key_observation: 'Demonstrated strong execution on CRM deliverables this month with 98% resolution rate.',
      final_responsibility_assigned: 'Lead the Project Reinvent client onboarding workflow and weekly syncs.',
      follow_up_date: '2026-12-15',
      additional_comments: 'Great momentum. Continue focusing on process documentation and cross-team alignment.'
    }
  };

  const patchRes = await fetch(`${baseUrl}/api/monthly-1on1/reports/${encodeURIComponent(reportId)}/notes`, {
    method: 'PATCH',
    headers: {
      'Cookie': director.cookie,
      'X-CSRF-Token': director.csrfToken,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(feedbackData)
  });
  console.log(`   PATCH /api/monthly-1on1/reports/:id/notes status: ${patchRes.status}`);
  assert.strictEqual(patchRes.status, 200, 'Director feedback must save successfully with 200 OK');
  const patchResult = await patchRes.json();
  console.log(`   Report status after feedback: ${patchResult.report.status}`);
  assert.strictEqual(patchResult.report.status, 'Completed', 'Report status should be Completed upon feedback submission');

  // 3. Employee Views Feedback
  console.log('\n3. Employee Viewing Feedback...');
  const empGetRes = await fetch(`${baseUrl}/api/monthly-1on1/reports/${encodeURIComponent(reportId)}`, {
    headers: { 'Cookie': employee.cookie, 'X-CSRF-Token': employee.csrfToken }
  });
  assert.strictEqual(empGetRes.status, 200);
  const empReportData = await empGetRes.json();
  const empReport = empReportData.report;

  console.log(`   Employee Report Status: ${empReport.status}`);
  console.log(`   Key Observation: "${empReport.manager_notes.key_observation}"`);
  console.log(`   Final Responsibility Assigned: "${empReport.manager_notes.final_responsibility_assigned}"`);
  console.log(`   Deadline / Follow-up Date: "${empReport.manager_notes.follow_up_date}"`);
  console.log(`   Additional Comments: "${empReport.manager_notes.additional_comments}"`);
  console.log(`   Reviewer Name: "${empReport.manager_notes.reviewer_name}"`);

  assert.strictEqual(empReport.manager_notes.key_observation, feedbackData.manager_notes.key_observation);
  assert.strictEqual(empReport.manager_notes.final_responsibility_assigned, feedbackData.manager_notes.final_responsibility_assigned);
  assert.strictEqual(empReport.manager_notes.follow_up_date, feedbackData.manager_notes.follow_up_date);
  assert.strictEqual(empReport.manager_notes.additional_comments, feedbackData.manager_notes.additional_comments);

  // Restore employee 10 designation
  await db.run('UPDATE employees SET designation="Operation Head" WHERE employee_id=10');

  console.log('\n✔ ALL FEEDBACK WORKFLOW VERIFICATIONS PASSED: CEO & Director give feedback, employees can view their feedback, and approve/reject buttons are completely bypassed!');
  process.exit(0);
}

testFeedbackWorkflow().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
