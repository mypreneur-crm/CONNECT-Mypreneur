'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { MySQLDatabase, databaseConfig } = require('../lib/database');

const PORT = 3000;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SESSION_SECRET = process.env.SESSION_SECRET || 'mypreneur_connect_local_secret_32chars_long_key_1234';
const TEST_MONTH = '2026-12';

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

function createClient(userId) {
  const csrf = crypto.randomBytes(24).toString('base64url');
  const token = signSession(userId, csrf);
  return {
    userId,
    csrf,
    cookie: `mc_session=${token}`,
    async request(method, path, body = null, customHeaders = {}) {
      return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const headers = {
          'Host': `127.0.0.1:${PORT}`,
          'Origin': BASE_URL,
          'Cookie': this.cookie,
          'X-CSRF-Token': this.csrf,
          'Connection': 'close',
          ...customHeaders
        };
        if (payload) {
          headers['Content-Type'] = 'application/json';
          headers['Content-Length'] = Buffer.byteLength(payload);
        }

        const req = http.request(`${BASE_URL}${path}`, { method, headers }, res => {
          let raw = '';
          res.on('data', chunk => { raw += chunk; });
          res.on('end', () => {
            let data = null;
            try { data = JSON.parse(raw); } catch { data = raw; }
            resolve({ status: res.statusCode, headers: res.headers, data });
          });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
      });
    }
  };
}

async function runTests() {
  console.log('--- STARTING 15-CHANGE VERIFICATION SUITE ---');

  // Clean test month in DB before running
  const db = new MySQLDatabase(databaseConfig());
  await db.run("DELETE FROM monthly_1on1_items WHERE report_id IN (SELECT id FROM monthly_1on1_reports WHERE reporting_month='2026-12-01')");
  await db.run("DELETE FROM monthly_1on1_reports WHERE reporting_month='2026-12-01'");

  // User 5 is Super Admin
  const superAdmin = createClient(5);
  // User 14 is employee (Soundarya)
  const employee = createClient(14);

  // 1. Check bootstrap (Regression)
  console.log('1. Verifying bootstrap and existing modules (Regression)...');
  const bootRes = await superAdmin.request('GET', '/api/bootstrap');
  assert.equal(bootRes.status, 200);
  assert.ok(bootRes.data.user);
  assert.ok(Array.isArray(bootRes.data.links));
  assert.ok(Array.isArray(bootRes.data.events));
  assert.ok(Array.isArray(bootRes.data.announcements));
  console.log('   ✓ Bootstrap passed with links, events, and announcements preserved.');

  // 2. CHANGE 1: Super Admin 12 months dashboard
  console.log('2. Verifying CHANGE 1: Super Admin 12 months dashboard...');
  const yearRes = await superAdmin.request('GET', '/api/monthly-1on1/windows/year?year=2026');
  assert.equal(yearRes.status, 200);
  assert.equal(yearRes.data.months.length, 12, 'Must return all 12 months');
  console.log('   ✓ Super Admin year endpoint returned 12 months for 2026.');

  // 3. Configure a reporting window for testing: 2026-12 (start date in past, end date in past -> remains OPEN)
  console.log(`3. Configuring window for ${TEST_MONTH} (start: 2026-10-01, end: 2026-10-20)...`);
  const cfgRes = await superAdmin.request('POST', '/api/monthly-1on1/windows', {
    reporting_month: TEST_MONTH,
    start_date: '2026-10-01',
    start_time: '09:00',
    end_date: '2026-10-20',
    end_time: '18:00'
  });
  assert.equal(cfgRes.status, 200);
  assert.equal(cfgRes.data.window.status, 'open', 'Passing end date must NOT close window automatically');
  console.log(`   ✓ Window ${TEST_MONTH} configured. End date has passed, but window is OPEN (No auto-close).`);

  // 4. CHANGE 2: Manual Close Button
  console.log(`4. Verifying CHANGE 2: Super Admin manual close...`);
  const closeRes = await superAdmin.request('POST', '/api/monthly-1on1/windows/close', {
    reporting_month: TEST_MONTH
  });
  assert.equal(closeRes.status, 200);
  assert.equal(closeRes.data.window.status, 'closed');
  assert.ok(closeRes.data.window.closed_at);
  console.log(`   ✓ Window ${TEST_MONTH} manually closed with audit timestamps.`);

  // 5. Verify Employee blocked while closed
  console.log('5. Verifying employee write blocked while window is closed...');
  const blockRes = await employee.request('POST', '/api/monthly-1on1/reports', {
    reporting_month: TEST_MONTH,
    meeting_date: '2026-12-10',
    work_location: 'Office'
  });
  assert.ok(blockRes.status === 403 || blockRes.status === 400, 'Employee must be blocked (403/400) when window is closed');
  console.log('   ✓ Employee write blocked on closed window (status 403 Forbidden).');

  // 6. Reopen Window
  console.log('6. Verifying Super Admin reopen window...');
  const reopenRes = await superAdmin.request('POST', '/api/monthly-1on1/windows/reopen', {
    reporting_month: TEST_MONTH,
    reason: 'Executive extension granted for team review'
  });
  assert.equal(reopenRes.status, 200);
  assert.equal(reopenRes.data.window.status, 'open');
  console.log(`   ✓ Window ${TEST_MONTH} reopened with audit reason.`);

  // 7. CHANGE 3: Super Admin cannot apply personally
  console.log('7. Verifying CHANGE 3: Super Admin personal application blocked...');
  const saAppRes = await superAdmin.request('POST', '/api/monthly-1on1/reports', {
    reporting_month: TEST_MONTH,
    meeting_date: '2026-12-10'
  });
  assert.equal(saAppRes.status, 403, 'Super Admin must not be able to create personal application');
  console.log('   ✓ Super Admin personal application correctly blocked by backend.');

  // 8. Employee creates report for TEST_MONTH
  console.log(`8. Employee creates report for ${TEST_MONTH}...`);
  const createEmpRes = await employee.request('POST', '/api/monthly-1on1/reports', {
    reporting_month: TEST_MONTH,
    meeting_date: '2026-12-10',
    work_location: 'Coimbatore Office',
    overall_status: 'On Track',
    capacity_for_additional_responsibilities: 'Partially',
    additional_responsibility_details: 'Can assist senior engineering team on architecture reviews.'
  });
  assert.ok(createEmpRes.status === 201 || createEmpRes.status === 200);
  const empReportId = createEmpRes.data.report.id;
  console.log(`   ✓ Employee report created with ID ${empReportId}.`);

  // 9. CHANGE 10: Dual Proof (link and document together)
  console.log('9. Verifying CHANGE 10: Dual proof (both link and document) on deliverable...');
  const saveItemsRes = await employee.request('PATCH', `/api/monthly-1on1/reports/${encodeURIComponent(empReportId)}`, {
    overall_status: 'On Track',
    meeting_date: '2026-12-15',
    work_location: 'Coimbatore Office',
    capacity_for_additional_responsibilities: 'Partially',
    additional_responsibility_details: 'Can assist senior engineering team on architecture reviews.',
    items: {
      completed_deliverables: [
        {
          task: 'Refactor reporting pipeline',
          target_given: 'Deliver monthly data accuracy',
          actual_completion: 'Completed with 100% tests',
          impact_result: 'Automated 12-month analytics',
          proof: {
            link: 'https://github.com/mypreneur/connect-updates',
            file: {
              storage_key: 'test_server_storage_key_123',
              original_name: 'deliverable_spec.pdf',
              mime_type: 'application/pdf',
              size: 1048576
            }
          }
        }
      ]
    }
  });
  assert.equal(saveItemsRes.status, 200);
  const cdItem = saveItemsRes.data.report.items.completed_deliverables[0];
  const proofData = cdItem.data ? cdItem.data.proof : cdItem.proof;
  assert.equal(proofData.link, 'https://github.com/mypreneur/connect-updates');
  assert.equal(proofData.file.original_name, 'deliverable_spec.pdf');
  console.log('   ✓ Dual proof (link + document) saved and validated.');

  // Submit report
  console.log('10. Employee submits report...');
  const submitRes = await employee.request('POST', `/api/monthly-1on1/reports/${encodeURIComponent(empReportId)}/submit`, {
    employee_acknowledged: true
  });
  assert.equal(submitRes.status, 200);
  assert.equal(submitRes.data.report.status, 'Submitted');
  console.log('   ✓ Report submitted successfully.');

  // 11. CHANGE 9: Director Feedback
  console.log('11. Verifying CHANGE 9: Director Feedback...');
  const feedbackRes = await superAdmin.request('POST', `/api/monthly-1on1/reports/${encodeURIComponent(empReportId)}/feedback`, {
    feedback: 'Excellent work on the deliverable. Strong execution.',
    recommendations: 'Focus on cross-training next month.',
    improvements: 'Improve turnaround on PR reviews.',
    remarks: 'Consistent high performer.',
    status: 'Submitted'
  });
  assert.equal(feedbackRes.status, 200);
  assert.equal(feedbackRes.data.report.director_feedback_by_id, 5);
  assert.ok(feedbackRes.data.report.director_feedback.feedback);
  console.log('   ✓ Director feedback recorded in director_feedback.');

  // 12. CHANGE 11: Manager Notes on Approval Modal
  console.log('12. Verifying CHANGE 11: Manager Notes on Approval...');
  const approveRes = await superAdmin.request('POST', `/api/monthly-1on1/reports/${encodeURIComponent(empReportId)}/approve`, {
    manager_notes: {
      key_observation: 'Demonstrated high technical proficiency.',
      final_responsibility_assigned: 'Assigned tech lead for module v2.',
      follow_up_date: '2026-12-01',
      additional_comments: 'Approved without reservations.'
    },
    comments: 'Approved without reservations.'
  });
  assert.equal(approveRes.status, 200);
  assert.equal(approveRes.data.report.status, 'Approved');
  const savedNotes = approveRes.data.report.manager_notes;
  assert.equal(savedNotes.key_observation, 'Demonstrated high technical proficiency.');
  assert.equal(savedNotes.final_responsibility_assigned, 'Assigned tech lead for module v2.');
  console.log('   ✓ Manager notes persisted in manager_notes on approval.');

  // 13. CHANGE 7 & 8: Headcount, Pending Denominator, and "See Who"
  console.log('13. Verifying CHANGE 7 & 8: Headcount metrics & "See Who" API...');
  const teamRes = await superAdmin.request('GET', `/api/monthly-1on1/team-reports?year=2026&month=12`);
  assert.equal(teamRes.status, 200);
  assert.ok(teamRes.data.summary.total_employees_mypreneur > 0, 'Total employees of Mypreneur must be positive');
  console.log(`   ✓ Total Employees of Mypreneur: ${teamRes.data.summary.total_employees_mypreneur}`);
  console.log(`   ✓ Pending Applications: ${teamRes.data.summary.pending_applications}`);

  const seeWhoRes = await superAdmin.request('GET', `/api/monthly-1on1/pending-employees?month=${TEST_MONTH}`);
  assert.equal(seeWhoRes.status, 200);
  assert.ok(Array.isArray(seeWhoRes.data.pending_employees));
  console.log(`   ✓ "See Who" returned ${seeWhoRes.data.count} pending employees.`);
  assert.equal(seeWhoRes.data.count, teamRes.data.summary.pending_applications, 'See Who count must exactly match Pending count');
  console.log('   ✓ See Who count exactly matches Pending Applications card count.');

  // 14. CHANGE 6: Employee History
  console.log('14. Verifying CHANGE 6: Employee History...');
  const overviewRes = await employee.request('GET', '/api/monthly-1on1/overview');
  assert.equal(overviewRes.status, 200);
  assert.ok(Array.isArray(overviewRes.data.history));
  assert.ok(overviewRes.data.history.length > 0);
  console.log(`   ✓ Employee history returned ${overviewRes.data.history.length} historical records.`);

  console.log('\n======================================================');
  console.log('ALL VERIFICATION SUITE TESTS PASSED SUCCESSFULLY (100%)');
  console.log('======================================================\n');
  process.exit(0);
}

runTests().catch(err => {
  console.error('TEST SUITE FAILED:', err);
  process.exit(1);
});
