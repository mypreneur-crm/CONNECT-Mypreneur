'use strict';

const assert = require('node:assert');
const crypto = require('node:crypto');
const { MySQLDatabase, databaseConfig } = require('../lib/database');

async function runTest() {
  console.log('=== TEST: CEO ACCESS & DIRECTOR FEEDBACK VERIFICATION ===\n');
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

  // 1. Verify CEO account
  const ceoUser = await db.get("SELECT user_id, username FROM users WHERE username='ceo'");
  assert.ok(ceoUser, 'CEO user exists in DB');
  const ceoClient = await clientFor(ceoUser.user_id);
  console.log(`1. CEO User: ${ceoClient.user.name} (${ceoClient.user.username})`);
  console.log(`   isExecutive: ${ceoClient.user.isExecutive}, title: ${ceoClient.user.title}`);
  assert.strictEqual(ceoClient.user.isExecutive, true, 'CEO user must have isExecutive = true');

  // 2. CEO views all employee applications via team-reports
  const teamRes = await fetch(`${baseUrl}/api/monthly-1on1/team-reports`, {
    headers: { 'Cookie': ceoClient.cookie, 'Accept': 'application/json' }
  });
  assert.strictEqual(teamRes.status, 200, 'CEO can access /api/monthly-1on1/team-reports (200 OK)');
  const teamData = await teamRes.json();
  console.log(`2. CEO team-reports total applications: ${teamData.total}, summary:`, teamData.summary);
  assert.ok(Array.isArray(teamData.reports), 'Reports array returned to CEO');

  // 3. Employee (User 14 - Soundarya) submits or uses an existing report
  const empClient = await clientFor(14);
  console.log(`\n3. Employee User: ${empClient.user.name} (${empClient.user.username})`);
  let reportId;

  // Check if report already exists for 2026-11
  const existingRes = await fetch(`${baseUrl}/api/monthly-1on1/reports?year=2026&month=11`, {
    headers: { 'Cookie': empClient.cookie, 'Accept': 'application/json' }
  });
  const existingData = await existingRes.json();
  const existing = existingData.reports?.[0];

  if (existing) {
    reportId = existing.id;
    console.log(`   Using existing report ID: ${reportId}`);
  } else {
    const createRes = await fetch(`${baseUrl}/api/monthly-1on1/reports`, {
      method: 'POST',
      headers: {
        'Cookie': empClient.cookie,
        'X-CSRF-Token': empClient.csrfToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        reporting_month: '2026-11',
        work_location: 'Coimbatore Office',
        current_projects: 'CRM & Client Connect Portal',
        overall_status: 'On Track',
        capacity_for_additional_responsibilities: 'Yes',
        additional_responsibility_details: 'Ready to support leadership onboarding and QA reviews'
      })
    });
    const created = await createRes.json();
    reportId = created.report?.id;
    console.log(`   Created report ID: ${reportId}`);

    // Submit report
    await fetch(`${baseUrl}/api/monthly-1on1/reports/${reportId}/submit`, {
      method: 'POST',
      headers: {
        'Cookie': empClient.cookie,
        'X-CSRF-Token': empClient.csrfToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ acknowledge_truthful: true })
    });
  }

  // 4. CEO reviews report and records Section 6 Director Feedback
  console.log('\n4. CEO entering Section 6 Director Feedback...');
  const feedbackRes = await fetch(`${baseUrl}/api/monthly-1on1/reports/${reportId}/notes`, {
    method: 'PATCH',
    headers: {
      'Cookie': ceoClient.cookie,
      'X-CSRF-Token': ceoClient.csrfToken,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      manager_notes: {
        key_observation: 'Exceptional ownership on client deliverables and great team proactive alignment.',
        final_responsibility_assigned: 'Lead the customer success initiative for Q1 2027.',
        meeting_date: '2026-12-15',
        deadline: '2026-12-15',
        additional_comments: 'Keep up the remarkable momentum!'
      }
    })
  });
  assert.strictEqual(feedbackRes.status, 200, 'CEO saved Director feedback successfully');
  const fbData = await feedbackRes.json();
  console.log('   Saved Feedback Status:', fbData.report?.status);
  assert.strictEqual(fbData.report?.status, 'Completed', 'Report status marked as Completed upon feedback recording');

  // 5. Employee queries their history via GET /api/monthly-1on1/reports
  console.log('\n5. Employee fetching personal history with Director Feedback...');
  const empHistoryRes = await fetch(`${baseUrl}/api/monthly-1on1/reports?year=2026&month=11`, {
    headers: { 'Cookie': empClient.cookie, 'Accept': 'application/json' }
  });
  assert.strictEqual(empHistoryRes.status, 200, 'Employee fetched history');
  const empHistoryData = await empHistoryRes.json();
  const empReport = empHistoryData.reports.find(r => r.id === reportId);
  assert.ok(empReport, 'Submitted report found in employee history');
  console.log('   Report in history:', {
    id: empReport.id,
    month: empReport.reporting_month,
    status: empReport.status,
    hasManagerNotes: Boolean(empReport.manager_notes)
  });
  assert.ok(empReport.manager_notes, 'manager_notes present in employee history report');
  assert.strictEqual(empReport.manager_notes.key_observation, 'Exceptional ownership on client deliverables and great team proactive alignment.');
  assert.strictEqual(empReport.manager_notes.final_responsibility_assigned, 'Lead the customer success initiative for Q1 2027.');
  assert.strictEqual(empReport.manager_notes.meeting_date, '2026-12-15');
  assert.strictEqual(empReport.manager_notes.additional_comments, 'Keep up the remarkable momentum!');

  // 6. Verify Super Admin (User 5) CANNOT view all employee applications (still 403 Forbidden per rule)
  console.log('\n6. Checking Super Admin restriction...');
  const adminClient = await clientFor(5);
  const adminTeamRes = await fetch(`${baseUrl}/api/monthly-1on1/team-reports`, {
    headers: { 'Cookie': adminClient.cookie, 'Accept': 'application/json' }
  });
  assert.strictEqual(adminTeamRes.status, 403, 'Super Admin is forbidden from employee applications list');
  console.log('   ✔ Super Admin is strictly prevented from viewing all employee applications (403)');

  console.log('\n🎉 ALL CEO ACCESS & DIRECTOR FEEDBACK VERIFICATION TESTS PASSED 100%!');
  process.exit(0);
}

runTest().catch(err => {
  console.error('\n❌ TEST FAILED:', err);
  process.exit(1);
});
