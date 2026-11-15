'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { MySQLDatabase, databaseConfig } = require('../lib/database');

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
    setCookie(cookieStr) {
      if (!cookieStr) return;
      const parts = cookieStr.split(';');
      const nameVal = parts[0].trim();
      this.cookies = this.cookies.filter(c => !c.startsWith(nameVal.split('=')[0] + '='));
      this.cookies.push(nameVal);
    },
    async request(method, reqPath, body = null, customHeaders = {}) {
      return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const headers = {
          'Host': `127.0.0.1:${PORT}`,
          'Origin': BASE_URL,
          'Cookie': this.cookies.join('; '),
          'X-CSRF-Token': this.csrf,
          'Connection': 'close',
          ...customHeaders
        };
        if (payload) {
          headers['Content-Type'] = 'application/json';
          headers['Content-Length'] = Buffer.byteLength(payload);
        }

        const req = http.request(`${BASE_URL}${reqPath}`, { method, headers }, res => {
          let raw = '';
          res.on('data', chunk => { raw += chunk; });
          res.on('end', () => {
            let data;
            try { data = JSON.parse(raw); } catch { data = raw; }
            if (res.headers['set-cookie']) {
              const sc = Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'] : [res.headers['set-cookie']];
              sc.forEach(c => this.setCookie(c));
            }
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

(async () => {
  console.log('================================================================');
  console.log('MYPRENEUR CONNECT: DATA OWNERSHIP, AUTH & ROLE PERMISSIONS TEST');
  console.log('================================================================\n');

  const db = new MySQLDatabase(databaseConfig());
  await db.ready;

  // Test identities
  const superAdmin = createClient(5);       // System Admin (admin)
  const serviceAdmin = createClient(22);    // Kaviya (service_admin)
  const emp1 = createClient(12);            // Ibrahimshah (member)
  const emp2 = createClient(13);            // Hariharan (member)

  const TEST_MONTH = '2026-12';
  const TEST_MONTH_KEY = '2026-12-01';

  try {
    // -------------------------------------------------------------
    // Setup: Clean existing test data & configure open window
    // -------------------------------------------------------------
    console.log('[Setup] Cleaning old test reports for 2026-12 and opening window...');
    await db.run('DELETE FROM monthly_1on1_reports WHERE reporting_month=? AND employee_id IN (12, 13, 22)', [TEST_MONTH_KEY]);

    const winConfigRes = await superAdmin.request('POST', '/api/monthly-1on1/windows', {
      reporting_month: TEST_MONTH_KEY,
      start_date: '2026-11-01',
      start_time: '00:00',
      end_date: '2026-12-31',
      end_time: '23:59'
    });
    assert.equal(winConfigRes.status, 200, 'Window configuration should succeed');
    console.log('  ✔ Window for 2026-12 is OPEN and active\n');

    // -------------------------------------------------------------
    // Test 1: Employee accessing their own application
    // -------------------------------------------------------------
    console.log('[Test 1] Employee accessing their own application...');
    const createEmp1Res = await emp1.request('POST', '/api/monthly-1on1/reports', {
      reporting_month: TEST_MONTH
    });
    assert.equal(createEmp1Res.status, 201, 'Emp1 creates new report');
    const emp1ReportId = createEmp1Res.data.report.id;

    const accessOwnRes = await emp1.request('GET', `/api/monthly-1on1/reports/${emp1ReportId}`);
    assert.equal(accessOwnRes.status, 200, 'Employee must be able to view their own application');
    assert.equal(accessOwnRes.data.report.id, emp1ReportId, 'Report ID must match');
    assert.equal(Number(accessOwnRes.data.report.employee_id), 12, 'Employee ID must be 12');
    console.log('  ✔ Verified: Employee successfully accessed their own application (HTTP 200)');

    // -------------------------------------------------------------
    // Test 2: Employee attempting to access another employee\'s application
    // -------------------------------------------------------------
    console.log('\n[Test 2] Employee attempting to access another employee\'s application...');
    // Emp 2 tries to access Emp 1's report
    const crossAccessRes = await emp2.request('GET', `/api/monthly-1on1/reports/${emp1ReportId}`);
    assert.equal(crossAccessRes.status, 403, 'Cross-employee access must return 403');
    assert.equal(crossAccessRes.data.code, 'FORBIDDEN', 'Error code must be FORBIDDEN');

    // Attempt parameter manipulation (?employee_id=12)
    const spoofParamRes = await emp2.request('GET', `/api/monthly-1on1/reports/${emp1ReportId}?employee_id=12`);
    assert.equal(spoofParamRes.status, 403, 'Parameter manipulation must not bypass ownership check');
    console.log('  ✔ Verified: Cross-employee access and parameter manipulation blocked with HTTP 403 FORBIDDEN');

    // -------------------------------------------------------------
    // Test 3: Employee attempting to access administrative endpoints
    // -------------------------------------------------------------
    console.log('\n[Test 3] Employee attempting to access administrative endpoints...');
    // a) Configure window
    const empConfigWinRes = await emp1.request('POST', '/api/monthly-1on1/windows', {
      reporting_month: '2026-01-01',
      start_date: '2026-01-01',
      start_time: '00:00',
      end_date: '2026-01-31',
      end_time: '23:59'
    });
    assert.equal(empConfigWinRes.status, 403, 'Employee cannot configure windows');

    // b) Close window
    const empCloseWinRes = await emp1.request('POST', '/api/monthly-1on1/windows/close', {
      reporting_month: TEST_MONTH_KEY
    });
    assert.equal(empCloseWinRes.status, 403, 'Employee cannot close windows');

    // c) Reopen window
    const empReopenWinRes = await emp1.request('POST', '/api/monthly-1on1/windows/reopen', {
      reporting_month: TEST_MONTH_KEY,
      reason: 'Unauthorized attempt'
    });
    assert.equal(empReopenWinRes.status, 403, 'Employee cannot reopen windows');

    // d) Access 12-month schedule admin endpoint
    const empYearRes = await emp1.request('GET', '/api/monthly-1on1/windows/year?year=2026');
    assert.equal(empYearRes.status, 403, 'Employee cannot access 12-month schedule');

    // e) Access team reports reviewer list
    const empTeamRes = await emp1.request('GET', '/api/monthly-1on1/team-reports');
    assert.equal(empTeamRes.status, 403, 'Employee cannot access team reviewer reports');
    console.log('  ✔ Verified: All administrative endpoints strictly blocked for ordinary employees with HTTP 403');

    // -------------------------------------------------------------
    // Test 4: Service Admin reviewing another employee
    // -------------------------------------------------------------
    console.log('\n[Test 4] Service Admin reviewing another employee...');
    // Emp1 fills deliverables and submits report
    const patchRes = await emp1.request('PATCH', `/api/monthly-1on1/reports/${emp1ReportId}`, {
      overall_status: 'On Track',
      capacity_for_additional_responsibilities: 'Yes',
      additional_responsibility_details: 'Can take on additional backend API optimization tasks.',
      work_location: 'Office'
    });
    assert.equal(patchRes.status, 200, 'Draft update succeeds');

    const submitRes = await emp1.request('POST', `/api/monthly-1on1/reports/${emp1ReportId}/submit`, {
      acknowledged: true,
      overall_status: 'On Track',
      capacity_for_additional_responsibilities: 'Yes',
      additional_responsibility_details: 'Can take on additional backend API optimization tasks.'
    });
    assert.equal(submitRes.status, 200, 'Emp1 submit succeeds');

    // Service Admin views team reports
    const srvTeamRes = await serviceAdmin.request('GET', '/api/monthly-1on1/team-reports');
    assert.equal(srvTeamRes.status, 200, 'Service Admin can access team reports');
    assert.ok(Array.isArray(srvTeamRes.data.reports), 'Reports array returned');

    // Service Admin starts review on emp1 report
    const srvStartRes = await serviceAdmin.request('POST', `/api/monthly-1on1/reports/${emp1ReportId}/start-review`);
    assert.equal(srvStartRes.status, 200, 'Service Admin starts review');

    // Service Admin saves manager feedback and approves
    const srvNotesRes = await serviceAdmin.request('PATCH', `/api/monthly-1on1/reports/${emp1ReportId}/notes`, {
      manager_notes: {
        key_observation: 'Strong performance across deliverables.',
        final_responsibility_assigned: 'Lead Q1 Project Reinvent initiative.',
        additional_comments: 'Keep up the good work.'
      }
    });
    assert.equal(srvNotesRes.status, 200, 'Service Admin can save manager notes');

    const srvApproveRes = await serviceAdmin.request('POST', `/api/monthly-1on1/reports/${emp1ReportId}/approve`, {
      comments: 'Approved by Service Admin'
    });
    assert.equal(srvApproveRes.status, 200, 'Service Admin can approve peer employee application');
    console.log('  ✔ Verified: Service Admin successfully reviewed, commented, and approved another employee\'s report');

    // -------------------------------------------------------------
    // Test 5: Service Admin attempting to approve themselves
    // -------------------------------------------------------------
    console.log('\n[Test 5] Service Admin attempting to approve themselves...');
    // Create application for Service Admin
    const srvCreateRes = await serviceAdmin.request('POST', '/api/monthly-1on1/reports', {
      reporting_month: TEST_MONTH
    });
    assert.equal(srvCreateRes.status, 201, 'Service Admin creates personal application');
    const srvReportId = srvCreateRes.data.report.id;

    // Submit Service Admin report
    await serviceAdmin.request('PATCH', `/api/monthly-1on1/reports/${srvReportId}`, {
      overall_status: 'On Track',
      capacity_for_additional_responsibilities: 'No'
    });
    const srvSubmitRes = await serviceAdmin.request('POST', `/api/monthly-1on1/reports/${srvReportId}/submit`, {
      acknowledged: true,
      overall_status: 'On Track',
      capacity_for_additional_responsibilities: 'No'
    });
    assert.equal(srvSubmitRes.status, 200, 'Service Admin submitted own report');

    // Attempt self-approval
    const selfApproveRes = await serviceAdmin.request('POST', `/api/monthly-1on1/reports/${srvReportId}/approve`, {
      comments: 'Self-approval attempt'
    });
    assert.equal(selfApproveRes.status, 403, 'Self-approval must return 403 FORBIDDEN');
    console.log('  ✔ Verified: Service Admin self-approval strictly blocked with HTTP 403 FORBIDDEN');

    // -------------------------------------------------------------
    // Test 6: Super Admin attempting to submit an application
    // -------------------------------------------------------------
    console.log('\n[Test 6] Super Admin attempting to submit an application...');
    const saApplyRes = await superAdmin.request('POST', '/api/monthly-1on1/reports', {
      reporting_month: TEST_MONTH
    });
    assert.equal(saApplyRes.status, 403, 'Super Admin application creation must return 403');
    assert.equal(saApplyRes.data.code, 'SUPER_ADMIN_CANNOT_APPLY', 'Error code must be SUPER_ADMIN_CANNOT_APPLY');
    console.log('  ✔ Verified: Super Admin blocked from submitting an application (HTTP 403 SUPER_ADMIN_CANNOT_APPLY)');

    // -------------------------------------------------------------
    // Test 7: Duplicate application creation
    // -------------------------------------------------------------
    console.log('\n[Test 7] Duplicate application creation...');
    // Emp 2 creates application
    const emp2Create1 = await emp2.request('POST', '/api/monthly-1on1/reports', {
      reporting_month: TEST_MONTH
    });
    assert.equal(emp2Create1.status, 201, 'Emp2 creates report');
    const emp2ReportId = emp2Create1.data.report.id;

    // Now attempt duplicate creation
    const emp2CreateDuplicate = await emp2.request('POST', '/api/monthly-1on1/reports', {
      reporting_month: TEST_MONTH
    });
    assert.equal(emp2CreateDuplicate.status, 400, 'Duplicate application must return 400');
    assert.ok(emp2CreateDuplicate.data.code === 'DUPLICATE' || emp2CreateDuplicate.data.code === 'DUPLICATE_REPORT', 'Code must be DUPLICATE or DUPLICATE_REPORT');
    console.log('  ✔ Verified: Duplicate application for same month blocked with HTTP 400 DUPLICATE_REPORT');

    // -------------------------------------------------------------
    // Test 8: Direct API editing after closing
    // -------------------------------------------------------------
    console.log('\n[Test 8] Direct API editing after closing...');
    // Super Admin manually closes the window
    const closeRes = await superAdmin.request('POST', '/api/monthly-1on1/windows/close', {
      reporting_month: TEST_MONTH_KEY
    });
    assert.equal(closeRes.status, 200, 'Window successfully closed');

    // Emp 2 attempts direct API PATCH
    const editClosedRes = await emp2.request('PATCH', `/api/monthly-1on1/reports/${emp2ReportId}`, {
      work_location: 'Late edit attempt after closure'
    });
    assert.equal(editClosedRes.status, 403, 'Edits on closed window must return 403');
    assert.equal(editClosedRes.data.code, 'WINDOW_CLOSED', 'Error code must be WINDOW_CLOSED');

    // Emp 2 attempts direct API submit
    const submitClosedRes = await emp2.request('POST', `/api/monthly-1on1/reports/${emp2ReportId}/submit`, {
      acknowledged: true
    });
    assert.equal(submitClosedRes.status, 403, 'Submissions on closed window must return 403');
    assert.equal(submitClosedRes.data.code, 'WINDOW_CLOSED', 'Error code must be WINDOW_CLOSED');
    console.log('  ✔ Verified: Direct API editing & submission strictly blocked after window closure (HTTP 403 WINDOW_CLOSED)');

    // -------------------------------------------------------------
    // Test 9: Data persistence after logout and login
    // -------------------------------------------------------------
    console.log('\n[Test 9] Data persistence after logout and login...');
    // Reopen window so Emp 2 can save test deliverable data
    await superAdmin.request('POST', '/api/monthly-1on1/windows/reopen', {
      reporting_month: TEST_MONTH_KEY,
      reason: 'Reopened for persistence verification'
    });

    const realLoginClient = createClient();
    // 1. Real login as Hariharan
    const loginRes = await realLoginClient.request('POST', '/api/login', {
      username: 'hariharan',
      password: 'Password@123'
    });
    assert.equal(loginRes.status, 200, 'Login as hariharan must succeed');
    const csrfToken = loginRes.data.csrfToken;
    realLoginClient.csrf = csrfToken;

    // 2. Save a specific unique deliverable into draft
    const uniqueTaskName = `Persistence Verification Task ${Date.now()}`;
    const saveDraftRes = await realLoginClient.request('PATCH', `/api/monthly-1on1/reports/${emp2ReportId}`, {
      work_location: 'Coimbatore Office',
      completed_deliverables: [
        {
          task: uniqueTaskName,
          target_given: '100% Data Accuracy',
          actual_completion: 'Completed with audit trail',
          impact_result: 'Zero defects'
        }
      ]
    });
    assert.equal(saveDraftRes.status, 200, 'Draft save must succeed');

    // 3. Logout
    const logoutRes = await realLoginClient.request('POST', '/api/logout');
    assert.equal(logoutRes.status, 200, 'Logout must succeed');

    // Verify session revoked
    const revokedCheck = await realLoginClient.request('GET', '/api/me');
    assert.equal(revokedCheck.status, 401, 'Logged-out session must return 401');

    // 4. Fresh login
    const freshClient = createClient();
    const freshLoginRes = await freshClient.request('POST', '/api/login', {
      username: 'hariharan',
      password: 'Password@123'
    });
    assert.equal(freshLoginRes.status, 200, 'Fresh login must succeed');
    freshClient.csrf = freshLoginRes.data.csrfToken;

    // 5. Fetch report again and verify unique deliverable is preserved
    const fetchPersistedRes = await freshClient.request('GET', `/api/monthly-1on1/reports/${emp2ReportId}`);
    assert.equal(fetchPersistedRes.status, 200, 'Report must be retrievable after fresh login');
    const deliverables = fetchPersistedRes.data.report.items?.completed_deliverables || fetchPersistedRes.data.report.sections?.completed_deliverables || [];
    assert.ok(deliverables.some(d => (d.data?.task === uniqueTaskName) || (d.task === uniqueTaskName)), 'Saved deliverable must persist intact across sessions');
    assert.equal(fetchPersistedRes.data.report.work_location, 'Coimbatore Office', 'Work location must persist');
    console.log('  ✔ Verified: Full draft data and deliverables persisted in database across logout and login');

    console.log('\n================================================================');
    console.log('🎉 ALL 9 DATA OWNERSHIP, AUTH & PERMISSION TESTS PASSED 100%!');
    console.log('================================================================');

    await db.close();
    process.exit(0);

  } catch (err) {
    console.error('\n❌ TEST FAILED:', err);
    if (db) await db.close();
    process.exit(1);
  }
})();
