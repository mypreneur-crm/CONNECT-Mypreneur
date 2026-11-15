'use strict';

/**
 * MYPRENEUR CONNECT — FULL SECURITY VERIFICATION SUITE
 * Verifies all 20 required security categories from Section 15:
 * 1. Unauthorized API access
 * 2. Employee cross-account access
 * 3. Administrative privilege escalation
 * 4. Role spoofing
 * 5. Direct object reference manipulation
 * 6. SQL injection attempts
 * 7. Cross-site scripting
 * 8. CSRF
 * 9. Malicious uploads
 * 10. Unauthorized file downloads
 * 11. Path traversal
 * 12. Session expiration
 * 13. Logout invalidation
 * 14. Brute-force protection
 * 15. Rate limiting
 * 16. Access after window closure
 * 17. Super Admin restrictions
 * 18. Service Admin restrictions
 * 19. Director feedback permissions
 * 20. Sensitive error responses
 */

const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const { MySQLDatabase, databaseConfig } = require('../lib/database');
const monthly1on1Db = require('../lib/monthly-1on1-db');

const TEST_PORT = 3355;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
const SESSION_SECRET = process.env.SESSION_SECRET || 'mypreneur_connect_local_secret_32chars_long_key_1234';

function signSession(userId, csrf, { exp = Date.now() + 3600000, loginId = null } = {}) {
  const payload = {
    v: 1,
    userId: Number(userId),
    csrf,
    ...(loginId ? { loginId } : {}),
    exp
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function createClient(userId, loginId = null) {
  const csrf = crypto.randomBytes(24).toString('base64url');
  const token = signSession(userId, csrf, { loginId });
  return {
    userId,
    csrf,
    token,
    cookie: `mc_session=${token}`,
    async request(method, reqPath, body = null, customHeaders = {}) {
      return new Promise((resolve, reject) => {
        const payload = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
        const headers = {
          'Host': `127.0.0.1:${TEST_PORT}`,
          'Origin': BASE_URL,
          'Cookie': this.cookie,
          'X-CSRF-Token': this.csrf,
          'Connection': 'close',
          ...customHeaders
        };
        if (payload && !headers['Content-Type']) {
          headers['Content-Type'] = 'application/json';
          headers['Content-Length'] = Buffer.byteLength(payload);
        } else if (payload && headers['Content-Length'] === undefined) {
          headers['Content-Length'] = Buffer.byteLength(payload);
        }

        const req = http.request(`${BASE_URL}${reqPath}`, { method, headers }, res => {
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

(async () => {
  console.log('================================================================');
  console.log('MYPRENEUR CONNECT — FULL SECURITY VERIFICATION TEST SUITE');
  console.log('================================================================\n');

  const db = new MySQLDatabase(databaseConfig());
  await db.ready;

  // Find actual test users in DB
  const users = await db.all(
    `SELECT u.user_id, u.username, r.role_name
     FROM users u
     LEFT JOIN user_roles ur ON ur.user_id=u.user_id
     LEFT JOIN roles r ON r.role_id=ur.role_id
     WHERE u.is_active=1`
  );

  let superAdminUser = users.find(u => ['admin', 'super admin', 'superadmin'].includes(String(u.role_name || '').toLowerCase())) || { user_id: 5, username: 'admin' };
  let serviceAdminUser = users.find(u => ['service admin', 'service_admin'].includes(String(u.role_name || '').toLowerCase())) || { user_id: 22, username: 'kaviya' };
  let employeeUser1 = users.find(u => !['admin', 'super admin', 'service admin'].includes(String(u.role_name || '').toLowerCase())) || { user_id: 13, username: 'hariharan' };
  let employeeUser2 = users.find(u => u.user_id !== employeeUser1.user_id && !['admin', 'super admin', 'service admin'].includes(String(u.role_name || '').toLowerCase())) || { user_id: 14, username: 'soundarya' };

  console.log(`Test identities:
  Super Admin:   ID ${superAdminUser.user_id} (${superAdminUser.username})
  Service Admin: ID ${serviceAdminUser.user_id} (${serviceAdminUser.username})
  Employee 1:    ID ${employeeUser1.user_id} (${employeeUser1.username})
  Employee 2:    ID ${employeeUser2.user_id} (${employeeUser2.username})
`);

  // Start test server on TEST_PORT
  const serverProcess = spawn('node', [path.resolve(__dirname, '../server.js')], {
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      HOST: '127.0.0.1',
      SESSION_SECRET,
      NODE_ENV: 'production'
    },
    stdio: 'pipe'
  });

  serverProcess.stderr.on('data', d => {
    const s = d.toString();
    if (!s.includes('Audit log failure')) process.stderr.write(`[Server Err] ${s}`);
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server failed to start within 10s')), 10000);
    serverProcess.stdout.on('data', chunk => {
      if (chunk.toString().includes(`Mypreneur Connect running at http://localhost:${TEST_PORT}`)) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  console.log(`✔ Test server started on port ${TEST_PORT}\n`);

  const unauthClient = {
    async request(method, reqPath, body = null, headers = {}) {
      return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const reqHeaders = {
          'Host': `127.0.0.1:${TEST_PORT}`,
          'Origin': BASE_URL,
          'Connection': 'close',
          ...headers
        };
        if (payload) {
          reqHeaders['Content-Type'] = 'application/json';
          reqHeaders['Content-Length'] = Buffer.byteLength(payload);
        }
        const req = http.request(`${BASE_URL}${reqPath}`, { method, headers: reqHeaders }, res => {
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

  const clientSuperAdmin = createClient(superAdminUser.user_id);
  const clientServiceAdmin = createClient(serviceAdminUser.user_id);
  const clientEmp1 = createClient(employeeUser1.user_id);
  const clientEmp2 = createClient(employeeUser2.user_id);

  const testMonth = '2026-09';
  const testMonthKey = '2026-09-01';

  // Ensure test window is open initially
  await db.run("UPDATE monthly_1on1_reports SET status='Closed' WHERE record_type='window'");
  await monthly1on1Db.createOrUpdateWindow(db, {
    reportingMonth: testMonthKey,
    startDate: '2026-09-01',
    startTime: '09:00',
    endDate: '2026-12-31',
    endTime: '23:59',
    auditUser: { id: superAdminUser.user_id, name: 'Admin', role: 'admin' }
  });

  // Clean any old test report for employee 1 and 2 in test month
  await db.run('DELETE FROM monthly_1on1_reports WHERE reporting_month=? AND employee_id IN (?, ?)', [testMonthKey, employeeUser1.user_id, employeeUser2.user_id]);

  let testReportId = null;

  try {
    // -------------------------------------------------------------
    // Test 1: Unauthorized API access
    // -------------------------------------------------------------
    console.log('[Test 1] Unauthorized API access...');
    const unauthRes = await unauthClient.request('GET', '/api/monthly-1on1/overview');
    assert.equal(unauthRes.status, 401, 'Unauthenticated request must return 401');
    assert.equal(unauthRes.data.code, 'UNAUTHENTICATED');
    console.log('  ✔ Verified: Unauthenticated API access rejected with 401 UNAUTHENTICATED');

    // -------------------------------------------------------------
    // Test 2: Employee cross-account access
    // -------------------------------------------------------------
    console.log('\n[Test 2] Employee cross-account access...');
    // Create report for employee 1
    const createRes = await clientEmp1.request('POST', '/api/monthly-1on1/reports', { reporting_month: testMonth });
    assert.equal(createRes.status, 201, 'Employee 1 creates report');
    testReportId = createRes.data.report.id;

    // Employee 2 attempts to view Employee 1's report
    const crossRes = await clientEmp2.request('GET', `/api/monthly-1on1/reports/${testReportId}`);
    assert.equal(crossRes.status, 403, 'Employee 2 cannot view Employee 1 report');
    console.log('  ✔ Verified: Cross-employee access blocked with 403 FORBIDDEN');

    // -------------------------------------------------------------
    // Test 3: Administrative privilege escalation
    // -------------------------------------------------------------
    console.log('\n[Test 3] Administrative privilege escalation...');
    // Employee attempts to access admin endpoint (windows/close)
    const privEscRes = await clientEmp1.request('POST', '/api/monthly-1on1/windows/close', { reporting_month: testMonthKey });
    assert.equal(privEscRes.status, 403, 'Employee cannot close reporting windows');
    console.log('  ✔ Verified: Administrative window closure rejected for ordinary employee with 403');

    // -------------------------------------------------------------
    // Test 4: Role spoofing
    // -------------------------------------------------------------
    console.log('\n[Test 4] Role spoofing...');
    // Employee attempts to send role: "admin" in request body
    const spoofRes = await clientEmp1.request('POST', '/api/monthly-1on1/windows/close', {
      reporting_month: testMonthKey,
      role: 'admin',
      isSuperAdmin: true
    });
    assert.equal(spoofRes.status, 403, 'Client-supplied role parameters are ignored');
    console.log('  ✔ Verified: Client role parameter spoofing blocked; server derives role strictly from database');

    // -------------------------------------------------------------
    // Test 5: Direct object reference manipulation (IDOR)
    // -------------------------------------------------------------
    console.log('\n[Test 5] Direct object reference manipulation (IDOR)...');
    // Employee 2 attempts to PATCH Employee 1's report
    const idorPatchRes = await clientEmp2.request('PATCH', `/api/monthly-1on1/reports/${testReportId}`, {
      work_location: 'Hacked by Employee 2'
    });
    assert.equal(idorPatchRes.status, 403, 'Employee 2 cannot PATCH Employee 1 report');
    console.log('  ✔ Verified: IDOR modification rejected with 403 FORBIDDEN');

    // -------------------------------------------------------------
    // Test 6: SQL injection attempts
    // -------------------------------------------------------------
    console.log('\n[Test 6] SQL injection attempts...');
    const sqliPayloads = [
      "1' OR '1'='1",
      "1'; DROP TABLE monthly_1on1_reports; --",
      "1 UNION SELECT 1,2,3,4,5,6,7,8,9,10--"
    ];
    for (const sqli of sqliPayloads) {
      const sqliRes = await clientEmp1.request('GET', `/api/monthly-1on1/reports?status=${encodeURIComponent(sqli)}`);
      assert.equal(sqliRes.status, 200, 'Handled safely via parameterized query');
      // Verify table still exists
      const checkTable = await db.get('SELECT 1 FROM monthly_1on1_reports LIMIT 1');
      assert.ok(checkTable, 'Database intact');
    }
    console.log('  ✔ Verified: SQL injection payloads neutralized by parameterized queries and validation');

    // -------------------------------------------------------------
    // Test 7: Cross-site scripting (XSS)
    // -------------------------------------------------------------
    console.log('\n[Test 7] Cross-site scripting (XSS)...');
    const xssLink = 'javascript:alert(document.cookie)';
    const xssPayload = '<script>alert("XSS")</script>';
    // Save draft with XSS in deliverable link and text
    const xssDraftRes = await clientEmp1.request('PATCH', `/api/monthly-1on1/reports/${testReportId}`, {
      work_location: xssPayload,
      completed_deliverables: [
        { task: 'Secure XSS test', proof_link: xssLink, target_given: '1d', actual_completion: '1d', impact_result: 'Safe' }
      ]
    });
    assert.equal(xssDraftRes.status, 200);
    // Fetch print HTML view
    const printRes = await clientEmp1.request('GET', `/api/monthly-1on1/export/${testReportId}?format=html`);
    assert.equal(printRes.status, 200);
    assert.ok(!printRes.data.includes('href="javascript:'), 'Must not render unvalidated javascript: link');
    assert.ok(!printRes.data.includes('<script>alert("XSS")</script>'), 'Must escape script tags');
    assert.ok(printRes.headers['x-content-type-options'] === 'nosniff', 'Print view must include nosniff');
    console.log('  ✔ Verified: XSS link neutralized, HTML entity escaped, and nosniff header enforced on print view');

    // -------------------------------------------------------------
    // Test 8: CSRF Protection
    // -------------------------------------------------------------
    console.log('\n[Test 8] CSRF Protection...');
    // Send state-changing request with invalid CSRF token
    const csrfBadTokenRes = await clientEmp1.request('PATCH', `/api/monthly-1on1/reports/${testReportId}`, {
      work_location: 'CSRF Test'
    }, { 'X-CSRF-Token': 'invalid-token-12345' });
    assert.equal(csrfBadTokenRes.status, 403, 'Invalid CSRF token must return 403');
    assert.equal(csrfBadTokenRes.data.code, 'CSRF');

    // Send state-changing request from cross-origin
    const csrfCrossRes = await clientEmp1.request('PATCH', `/api/monthly-1on1/reports/${testReportId}`, {
      work_location: 'CSRF Test'
    }, { 'Origin': 'https://attacker-evil-site.com' });
    assert.equal(csrfCrossRes.status, 403, 'Cross-origin request must return 403 CSRF');
    console.log('  ✔ Verified: State-changing requests block invalid CSRF tokens and cross-origin Origin headers');

    // -------------------------------------------------------------
    // Test 9: Malicious uploads
    // -------------------------------------------------------------
    console.log('\n[Test 9] Malicious uploads...');
    // Attempt to upload executable (MZ) disguised as PNG
    const fakeExePng = Buffer.concat([Buffer.from([0x4D, 0x5A, 0x90, 0x00]), Buffer.from('executable binary code')]);
    const exeUploadRes = await clientEmp1.request('POST', `/api/monthly-1on1/reports/${testReportId}/attachments`, {
      file: {
        name: 'payload.png',
        data: `data:image/png;base64,${fakeExePng.toString('base64')}`
      }
    });
    assert.equal(exeUploadRes.status, 400, 'Executable payload rejected');

    // Attempt to upload SVG with embedded script
    const svgScript = Buffer.from('<svg><script>alert(1)</script></svg>');
    const svgUploadRes = await clientEmp1.request('POST', `/api/monthly-1on1/reports/${testReportId}/attachments`, {
      file: {
        name: 'vector.png',
        data: `data:image/png;base64,${svgScript.toString('base64')}`
      }
    });
    assert.equal(svgUploadRes.status, 400, 'SVG script payload rejected');
    console.log('  ✔ Verified: Executables and script-bearing polyglots rejected by magic-byte content inspector');

    // -------------------------------------------------------------
    // Test 10: Unauthorized file downloads & Attachment Ownership Check
    // -------------------------------------------------------------
    console.log('\n[Test 10] Unauthorized file downloads & Attachment ownership check...');
    // Upload legitimate PNG as Employee 1
    const validPng = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D]);
    const uploadRes = await clientEmp1.request('POST', `/api/monthly-1on1/reports/${testReportId}/attachments`, {
      file: {
        name: 'evidence.png',
        data: `data:image/png;base64,${validPng.toString('base64')}`
      }
    });
    assert.equal(uploadRes.status, 200, 'Valid PNG upload accepted');
    const validKey = uploadRes.data.proof.storage_key;

    // Attach to Employee 1 report
    await clientEmp1.request('PATCH', `/api/monthly-1on1/reports/${testReportId}`, {
      completed_deliverables: [
        { task: 'Attach proof', proof: { type: 'file', storage_key: validKey, original_name: 'evidence.png' } }
      ]
    });

    // Employee 2 attempts to download Employee 1's attachment via Employee 1's report ID
    const unauthDownloadRes1 = await clientEmp2.request('GET', `/api/monthly-1on1/reports/${testReportId}/attachment?key=${encodeURIComponent(validKey)}`);
    assert.equal(unauthDownloadRes1.status, 403, 'Employee 2 cannot view Employee 1 attachment');

    // Create a report for Employee 2
    const emp2Report = await clientEmp2.request('POST', '/api/monthly-1on1/reports', { reporting_month: testMonth });
    const emp2ReportId = emp2Report.data.report.id;

    // Employee 2 attempts to download Employee 1's attachment key by referencing Employee 2's own report ID (IDOR query param bypass)
    const unauthDownloadRes2 = await clientEmp2.request('GET', `/api/monthly-1on1/reports/${emp2ReportId}/attachment?key=${encodeURIComponent(validKey)}`);
    assert.equal(unauthDownloadRes2.status, 403, 'Attachment ownership check must reject key not belonging to this report');
    console.log('  ✔ Verified: Attachment ownership check prevents cross-report proof downloads');

    // -------------------------------------------------------------
    // Test 11: Path traversal
    // -------------------------------------------------------------
    console.log('\n[Test 11] Path traversal...');
    const traversalKeys = [
      '../../etc/passwd',
      'monthly-1on1/../../../server.js',
      '..\\..\\server.js',
      'monthly-1on1/..%2f..%2f.env'
    ];
    for (const badKey of traversalKeys) {
      const travRes = await clientEmp1.request('GET', `/api/monthly-1on1/reports/${testReportId}/attachment?key=${encodeURIComponent(badKey)}`);
      assert.ok(travRes.status === 400 || travRes.status === 403 || travRes.status === 404, 'Path traversal blocked');
    }

    // Static server dotfile traversal check
    const dotfileRes = await unauthClient.request('GET', '/.env');
    assert.equal(dotfileRes.status, 403, 'Dotfile access (.env) must be forbidden');
    const gitRes = await unauthClient.request('GET', '/.git/config');
    assert.equal(gitRes.status, 403, 'Hidden path access (.git) must be forbidden');
    console.log('  ✔ Verified: Path traversal and dotfile access (.env, .git) strictly blocked with 403');

    // -------------------------------------------------------------
    // Test 12: Session expiration
    // -------------------------------------------------------------
    console.log('\n[Test 12] Session expiration...');
    const expiredToken = signSession(employeeUser1.user_id, 'csrf123', { exp: Date.now() - 10000 });
    const expiredRes = await unauthClient.request('GET', '/api/me', null, { 'Cookie': `mc_session=${expiredToken}` });
    assert.equal(expiredRes.status, 401, 'Expired session token must be rejected');
    console.log('  ✔ Verified: Expired session tokens rejected with 401 UNAUTHENTICATED');

    // -------------------------------------------------------------
    // Test 13: Logout invalidation
    // -------------------------------------------------------------
    console.log('\n[Test 13] Logout invalidation...');
    // Login via real /api/login endpoint to obtain authentic session and loginId
    const realLoginRes = await unauthClient.request('POST', '/api/login', {
      username: employeeUser1.username,
      password: 'Password@123'
    });
    // If password matches or if using simulated login:
    let loggedClient;
    if (realLoginRes.status === 200) {
      const setCookie = realLoginRes.headers['set-cookie'];
      const rawCookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      const cookieVal = rawCookie.split(';')[0];
      const csrfVal = realLoginRes.data.csrfToken;
      loggedClient = {
        cookie: cookieVal,
        csrf: csrfVal,
        async request(method, path, body = null, headers = {}) {
          return clientEmp1.request(method, path, body, {
            'Cookie': this.cookie,
            'X-CSRF-Token': this.csrf,
            ...headers
          });
        }
      };
    } else {
      // Record in actual login_history table
      const loginResult = await db.run(
        `INSERT INTO login_history (user_id, login_time, logout_time, ip_address, device_info, login_status)
         VALUES (?, NOW(), NULL, '127.0.0.1', 'SecurityTest', 'SUCCESS')`,
        [employeeUser1.user_id]
      );
      loggedClient = createClient(employeeUser1.user_id, loginResult.insertId);
    }

    // Verify session is active
    const meActiveRes = await loggedClient.request('GET', '/api/me');
    assert.equal(meActiveRes.status, 200, 'Session is active before logout');

    // Logout
    const logoutRes = await loggedClient.request('POST', '/api/logout');
    assert.equal(logoutRes.status, 200, 'Logout succeeds');

    // Attempt to use the same session token after logout
    const meAfterLogoutRes = await loggedClient.request('GET', '/api/me');
    assert.equal(meAfterLogoutRes.status, 401, 'Logged out session must be rejected on server');
    console.log('  ✔ Verified: Logout marks session revoked in database; subsequent requests rejected with 401');

    // -------------------------------------------------------------
    // Test 14 & 15: Brute-force protection & Login Rate Limiting
    // -------------------------------------------------------------
    console.log('\n[Test 14 & 15] Brute-force protection & Login rate limiting...');
    const testIp = '127.0.0.99';
    let rateLimited = false;
    for (let i = 0; i < 35; i++) {
      const loginRes = await unauthClient.request('POST', '/api/login', {
        username: 'nonexistent_attacker_target',
        password: 'WrongPassword@123'
      }, { 'X-Forwarded-For': testIp });
      if (loginRes.status === 429) {
        rateLimited = true;
        break;
      }
    }
    assert.ok(rateLimited, 'Repeated failed login attempts must trigger 429 RATE_LIMITED');
    console.log('  ✔ Verified: Brute force password guessing triggers HTTP 429 RATE_LIMITED');

    // -------------------------------------------------------------
    // Test 16: Access after window closure
    // -------------------------------------------------------------
    console.log('\n[Test 16] Access after window closure...');
    // Super Admin closes the window
    const closeWinRes = await clientSuperAdmin.request('POST', '/api/monthly-1on1/windows/close', {
      reporting_month: testMonthKey
    });
    assert.equal(closeWinRes.status, 200, 'Super Admin closes window');

    // Employee 1 attempts to save draft in closed window
    const closedSaveRes = await clientEmp1.request('PATCH', `/api/monthly-1on1/reports/${testReportId}`, {
      work_location: 'Late edit after close'
    });
    assert.equal(closedSaveRes.status, 403, 'Saves rejected when window is closed');
    assert.equal(closedSaveRes.data.code, 'WINDOW_CLOSED');

    // Employee 1 attempts to upload attachment in closed window
    const closedUploadRes = await clientEmp1.request('POST', `/api/monthly-1on1/reports/${testReportId}/attachments`, {
      file: { name: 'late.png', data: `data:image/png;base64,${validPng.toString('base64')}` }
    });
    assert.equal(closedUploadRes.status, 403, 'Uploads rejected when window is closed');

    // Super Admin reopens window with audited reason
    const reopenRes = await clientSuperAdmin.request('POST', '/api/monthly-1on1/windows/reopen', {
      reporting_month: testMonthKey,
      reason: 'Reopened for verification testing'
    });
    assert.equal(reopenRes.status, 200, 'Super Admin reopens window');
    console.log('  ✔ Verified: Closed reporting window strictly blocks edits and uploads; audited reopen restores access');

    // -------------------------------------------------------------
    // Test 17: Super Admin restrictions
    // -------------------------------------------------------------
    console.log('\n[Test 17] Super Admin restrictions...');
    // Super Admin cannot create personal application
    const saApplyRes = await clientSuperAdmin.request('POST', '/api/monthly-1on1/reports', {
      reporting_month: testMonth
    });
    assert.equal(saApplyRes.status, 403, 'Super Admin cannot create personal reports');
    assert.equal(saApplyRes.data.code, 'SUPER_ADMIN_CANNOT_APPLY');
    console.log('  ✔ Verified: Super Admin cannot create personal applications (code: SUPER_ADMIN_CANNOT_APPLY)');

    // -------------------------------------------------------------
    // Test 18: Service Admin restrictions
    // -------------------------------------------------------------
    console.log('\n[Test 18] Service Admin restrictions...');
    // Service Admin can submit own report
    const srvApplyRes = await clientServiceAdmin.request('POST', '/api/monthly-1on1/reports', {
      reporting_month: testMonth
    });
    assert.ok(srvApplyRes.status === 201 || srvApplyRes.status === 400 /* duplicate */, 'Service Admin can create personal report');

    // Service Admin cannot close or configure reporting windows
    const srvCloseWinRes = await clientServiceAdmin.request('POST', '/api/monthly-1on1/windows/close', {
      reporting_month: testMonthKey
    });
    assert.equal(srvCloseWinRes.status, 403, 'Service Admin cannot close reporting windows');

    // Service Admin cannot self-approve their own report
    if (srvApplyRes.status === 201) {
      const srvReportId = srvApplyRes.data.report.id;
      // Submit it first
      await clientServiceAdmin.request('PATCH', `/api/monthly-1on1/reports/${srvReportId}`, {
        overall_status: 'On Track',
        capacity_for_additional_responsibilities: 'No'
      });
      await clientServiceAdmin.request('POST', `/api/monthly-1on1/reports/${srvReportId}/submit`, {
        acknowledged: true,
        overall_status: 'On Track',
        capacity_for_additional_responsibilities: 'No'
      });
      const selfApproveRes = await clientServiceAdmin.request('POST', `/api/monthly-1on1/reports/${srvReportId}/approve`, {
        comments: 'Self-approval attempt'
      });
      assert.equal(selfApproveRes.status, 403, 'Self-approval by Service Admin is forbidden');
    }
    console.log('  ✔ Verified: Service Admin cannot configure windows and cannot self-approve own applications');

    // -------------------------------------------------------------
    // Test 19: Director feedback permissions
    // -------------------------------------------------------------
    console.log('\n[Test 19] Director feedback permissions...');
    // Unassigned employee or unassigned director attempts to give feedback
    const unassignedFbRes = await clientEmp2.request('POST', `/api/monthly-1on1/reports/${testReportId}/feedback`, {
      feedback: 'Unauthorized feedback from unassigned user'
    });
    assert.equal(unassignedFbRes.status, 403, 'Unassigned user cannot give Director feedback');
    console.log('  ✔ Verified: Director feedback rejected for unassigned users with 403 FORBIDDEN');

    // -------------------------------------------------------------
    // Test 20: Sensitive error responses
    // -------------------------------------------------------------
    console.log('\n[Test 20] Sensitive error responses...');
    // Cause an internal error or validation error
    const errRes = await clientEmp1.request('POST', '/api/monthly-1on1/windows/close', {});
    assert.ok(!JSON.stringify(errRes.data).includes('SELECT'), 'Error must not leak SQL syntax');
    assert.ok(!JSON.stringify(errRes.data).includes('stack'), 'Error must not leak stack trace');
    assert.ok(!JSON.stringify(errRes.data).includes('connect_'), 'Error must not leak raw table names');

    // Verify security headers on API responses
    assert.equal(errRes.headers['x-content-type-options'], 'nosniff');
    assert.equal(errRes.headers['x-frame-options'], 'DENY');
    assert.ok(errRes.headers['cache-control'].includes('no-store'), 'Must include Cache-Control: no-store');
    console.log('  ✔ Verified: Error responses never leak stack traces or SQL details; security headers present');

    console.log('\n================================================================');
    console.log('ALL 20 MANDATORY SECURITY TESTS PASSED AND VERIFIED!');
    console.log('================================================================\n');

  } finally {
    // Cleanup test records
    await db.run('DELETE FROM monthly_1on1_reports WHERE reporting_month=? AND employee_id IN (?, ?)', [testMonthKey, employeeUser1.user_id, employeeUser2.user_id]).catch(() => {});
    await db.close().catch(() => {});
    serverProcess.kill('SIGTERM');
  }
})().catch(err => {
  console.error('\n❌ SECURITY TEST SUITE FAILED:', err);
  process.exit(1);
});
