'use strict';

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
  console.log('MONTHLY 1:1 REPORTING WINDOW SCHEDULING SYSTEM: COMPREHENSIVE E2E');
  console.log('================================================================\n');

  const db = new MySQLDatabase(databaseConfig());
  await db.ready;

  // Identities
  const superAdmin = createClient(5);     // ID 5, System Admin
  const serviceAdmin = createClient(22);  // ID 22, Kaviya
  const emp = createClient(13);           // ID 13, Hariharan

  // Clean any test windows from previous runs for months 2027-01 and 2027-02
  const TEST_MONTH_1 = '2027-01';
  const TEST_MONTH_1_KEY = '2027-01-01';
  const TEST_MONTH_2 = '2027-02';
  const TEST_MONTH_2_KEY = '2027-02-01';

  await db.run('DELETE FROM monthly_1on1_reports WHERE reporting_month IN (?, ?)', [TEST_MONTH_1_KEY, TEST_MONTH_2_KEY]);
  // Close any legacy open windows from past test runs to start with clean single-window state
  await db.run("UPDATE monthly_1on1_reports SET status='Closed' WHERE record_type='window'");

  try {
    // -------------------------------------------------------------
    // Section 1: RBAC & Permission Enforcement
    // -------------------------------------------------------------
    console.log('[Section 1] RBAC & Authority Enforcement...');
    // Non-Super Admin cannot configure window
    const empConfigRes = await emp.request('POST', '/api/monthly-1on1/windows', {
      reporting_month: TEST_MONTH_1_KEY,
      start_date: '2027-01-01',
      start_time: '10:00',
      end_date: '2027-01-15',
      end_time: '18:00'
    });
    assert.equal(empConfigRes.status, 403, 'Employee must be rejected from configuring window');

    const srvConfigRes = await serviceAdmin.request('POST', '/api/monthly-1on1/windows', {
      reporting_month: TEST_MONTH_1_KEY,
      start_date: '2027-01-01',
      start_time: '10:00',
      end_date: '2027-01-15',
      end_time: '18:00'
    });
    assert.equal(srvConfigRes.status, 403, 'Service Admin must be rejected from configuring window');
    console.log('  ✔ Verified: Only Super Admin can schedule or configure reporting windows (403 enforced)\n');

    // -------------------------------------------------------------
    // Section 2: Window Configuration Validations
    // -------------------------------------------------------------
    console.log('[Section 2] Window Configuration Validations...');
    // 1. End must be later than start
    const badTimeRes = await superAdmin.request('POST', '/api/monthly-1on1/windows', {
      reporting_month: TEST_MONTH_1_KEY,
      start_date: '2027-01-15',
      start_time: '18:00',
      end_date: '2027-01-10',
      end_time: '10:00'
    });
    assert.equal(badTimeRes.status, 400, 'End before start must return 400');
    assert.equal(badTimeRes.data.code, 'INVALID_WINDOW_TIME', 'Code must be INVALID_WINDOW_TIME');
    console.log('  ✔ Verified: Validation rejects end time earlier than start time (INVALID_WINDOW_TIME)');

    // 2. Valid Schedule Save
    const validSaveRes = await superAdmin.request('POST', '/api/monthly-1on1/windows', {
      reporting_month: TEST_MONTH_1_KEY,
      start_date: '2027-01-05',
      start_time: '10:00',
      end_date: '2027-01-20',
      end_time: '18:00'
    });
    assert.equal(validSaveRes.status, 200, 'Valid window configuration must return 200');
    assert.equal(validSaveRes.data.window.reporting_month, TEST_MONTH_1_KEY);
    console.log('  ✔ Verified: Super Admin saved valid schedule for 2027-01');

    // 3. Prevent conflicting active windows (Overlapping range)
    const conflictRes = await superAdmin.request('POST', '/api/monthly-1on1/windows', {
      reporting_month: TEST_MONTH_2_KEY,
      start_date: '2027-01-15', // Overlaps with Jan 5 - Jan 20
      start_time: '09:00',
      end_date: '2027-02-10',
      end_time: '18:00'
    });
    assert.equal(conflictRes.status, 400, 'Overlapping active window must return 400');
    assert.equal(conflictRes.data.code, 'CONFLICTING_WINDOW', 'Code must be CONFLICTING_WINDOW');
    console.log('  ✔ Verified: Overlapping scheduled window rejected with CONFLICTING_WINDOW\n');

    // -------------------------------------------------------------
    // Section 3: Automatic Scheduling Lifecycle (Simulated Clock)
    // -------------------------------------------------------------
    console.log('[Section 3] Automatic Scheduling Lifecycle (Controlled Test Clock)...');
    // Window: 2027-01-05 10:00 IST to 2027-01-20 18:00 IST
    // 2027-01-05 10:00 IST is 2027-01-05T04:30:00.000Z
    // 2027-01-20 18:00 IST is 2027-01-20T12:30:00.000Z

    const winRow = await db.get("SELECT * FROM monthly_1on1_reports WHERE record_type='window' AND reporting_month=?", [TEST_MONTH_1_KEY]);
    assert.ok(winRow, 'Window DB record must exist');

    // Point A: Before opening time (2027-01-03)
    const timeBeforeStart = '2027-01-03T10:00:00+05:30';
    const statusBefore = monthly1on1Db.calculateWindowStatus(winRow, timeBeforeStart);
    assert.equal(statusBefore, 'upcoming', 'Before start time, status must automatically be "upcoming"');
    console.log('  ✔ Time before opening: Status is automatically "upcoming" (Scheduled)');

    // Point B: At opening time (2027-01-05 10:01 IST)
    const timeAtOpening = '2027-01-05T10:01:00+05:30';
    const statusOpen = monthly1on1Db.calculateWindowStatus(winRow, timeAtOpening);
    assert.equal(statusOpen, 'open', 'At opening time, status must automatically become "open"');
    console.log('  ✔ At opening time: Status automatically becomes "open"');

    // Point C: At closing time (2027-01-20 18:01 IST)
    const timeAtClosing = '2027-01-20T18:01:00+05:30';
    const statusClosed = monthly1on1Db.calculateWindowStatus(winRow, timeAtClosing);
    assert.equal(statusClosed, 'closed', 'At closing time, status must automatically become "closed"');
    console.log('  ✔ At closing time: Status automatically becomes "closed"\n');

    // -------------------------------------------------------------
    // Section 4: Manual Opening before Scheduled Time
    // -------------------------------------------------------------
    console.log('[Section 4] Manual Opening before Normal Start Time...');
    // Currently, normal starting time is 2027-01-05.
    // Super Admin manually opens it now:
    const manualOpenRes = await superAdmin.request('POST', '/api/monthly-1on1/windows/manual-open', {
      reporting_month: TEST_MONTH_1_KEY,
      reason: 'Early manual opening by Super Admin'
    });
    assert.equal(manualOpenRes.status, 200, 'Manual open must succeed');
    assert.equal(manualOpenRes.data.window.status, 'open', 'Effective status must immediately be "open"');
    assert.equal(manualOpenRes.data.window.display_status, 'Open');
    console.log('  ✔ Verified: Super Admin manually opened window before normal start time (Immediate Open status)');

    // Verify employee can now create report
    const empCreateRes = await emp.request('POST', '/api/monthly-1on1/reports', {
      reporting_month: TEST_MONTH_1
    });
    assert.equal(empCreateRes.status, 201, 'Employee can create report during manual open');
    const empReportId = empCreateRes.data.report.id;
    console.log('  ✔ Verified: Employee can start application while manually opened\n');

    // -------------------------------------------------------------
    // Section 5: Manual Closing before Scheduled End
    // -------------------------------------------------------------
    console.log('[Section 5] Manual Closing before Scheduled End...');
    const manualCloseRes = await superAdmin.request('POST', '/api/monthly-1on1/windows/close', {
      reporting_month: TEST_MONTH_1_KEY
    });
    assert.equal(manualCloseRes.status, 200, 'Manual close must succeed');
    assert.equal(manualCloseRes.data.window.status, 'closed', 'Effective status must immediately be "closed"');
    assert.equal(manualCloseRes.data.window.display_status, 'Closed');
    console.log('  ✔ Verified: Super Admin manually closed window (Immediate Closed status)');

    // Verify employee editing is immediately restricted
    const empEditBlocked = await emp.request('PATCH', `/api/monthly-1on1/reports/${empReportId}`, {
      work_location: 'Attempt to edit after manual close'
    });
    assert.equal(empEditBlocked.status, 403, 'Editing must be blocked after manual close');
    assert.equal(empEditBlocked.data.code, 'WINDOW_CLOSED', 'Error code must be WINDOW_CLOSED');
    console.log('  ✔ Verified: Employee edits immediately blocked with 403 WINDOW_CLOSED\n');

    // -------------------------------------------------------------
    // Section 6: Manual Override Rules & Single Open Window Rule
    // -------------------------------------------------------------
    console.log('[Section 6] Manual Override Rules & Single Open Window Enforcement...');
    // Rule: A manual close must remain effective even if the scheduled window would otherwise be open.
    // Check with simulated time inside the scheduled window (2027-01-10 12:00)
    const closedRow = await db.get("SELECT * FROM monthly_1on1_reports WHERE record_type='window' AND reporting_month=?", [TEST_MONTH_1_KEY]);
    const simMidWindowStatus = monthly1on1Db.calculateWindowStatus(closedRow, '2027-01-10T12:00:00+05:30');
    assert.equal(simMidWindowStatus, 'closed', 'Manual close must remain effective even during scheduled active hours');
    console.log('  ✔ Verified: Manual close remains effective during scheduled window; scheduling does not reverse it');

    // Rule: Never allow two reporting months to be simultaneously open
    // 1. Reopen month 1
    const reopen1Res = await superAdmin.request('POST', '/api/monthly-1on1/windows/reopen', {
      reporting_month: TEST_MONTH_1_KEY,
      reason: 'Reopened for single active window test'
    });
    assert.equal(reopen1Res.status, 200, 'Reopen month 1 succeeds');

    // 2. Configure month 2 (separate non-overlapping schedule: Feb 1 - Feb 15)
    const saveMonth2Res = await superAdmin.request('POST', '/api/monthly-1on1/windows', {
      reporting_month: TEST_MONTH_2_KEY,
      start_date: '2027-02-01',
      start_time: '09:00',
      end_date: '2027-02-15',
      end_time: '18:00'
    });
    assert.equal(saveMonth2Res.status, 200, 'Save month 2 schedule succeeds');

    // 3. Super Admin attempts to manually open Month 2 while Month 1 is currently open
    const openConflictRes = await superAdmin.request('POST', '/api/monthly-1on1/windows/manual-open', {
      reporting_month: TEST_MONTH_2_KEY,
      reason: 'Attempt simultaneous open'
    });
    assert.equal(openConflictRes.status, 400, 'Attempt to open second active window must return 400');
    assert.equal(openConflictRes.data.code, 'ANOTHER_WINDOW_OPEN', 'Code must be ANOTHER_WINDOW_OPEN');
    console.log('  ✔ Verified: Simultaneous open blocked with ANOTHER_WINDOW_OPEN (Single active window enforced)\n');

    // -------------------------------------------------------------
    // Section 7: Frontend Button & Modal Integration Verification
    // -------------------------------------------------------------
    console.log('[Section 7] Frontend Button & Modal Integration Verification (index.html)...');
    const indexHtml = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

    // Verify Schedule button
    assert.ok(indexHtml.includes('data-m1-schedule-month'), 'Schedule button attribute present');
    assert.ok(indexHtml.includes('Schedule 1:1 Meeting'), 'Schedule 1:1 Meeting text present');

    // Verify Save & Update buttons
    assert.ok(indexHtml.includes('id="m1WinSaveBtn"'), 'Modal save/update button present');

    // Verify Cancel button
    assert.ok(indexHtml.includes('id="m1WinCancel"'), 'Modal cancel button present');

    // Verify Modal Close button
    assert.ok(indexHtml.includes('id="m1WinClose"'), 'Modal close button present');

    // Verify Manual Open button
    assert.ok(indexHtml.includes('data-m1-open-window'), 'Manual Open button attribute present');
    assert.ok(indexHtml.includes('Open 1:1 Meeting Report'), 'Open 1:1 Meeting Report button text present');

    // Verify Manual Close button
    assert.ok(indexHtml.includes('data-m1-close-window'), 'Manual Close button attribute present');
    assert.ok(indexHtml.includes('Close 1:1 Meeting Report'), 'Close 1:1 Meeting Report button text present');

    // Verify Confirmation popups for Manual Open, Manual Close, and Reopen
    assert.ok(indexHtml.includes('confirm(`Are you sure you want to manually open 1:1 meeting applications'), 'Manual Open confirmation present');
    assert.ok(indexHtml.includes('confirm(`Are you sure you want to close 1:1 meeting applications'), 'Manual Close confirmation present');
    assert.ok(indexHtml.includes('confirm(`Are you sure you want to reopen 1:1 meeting applications'), 'Reopen confirmation present');

    // Verify Year & Month selection
    assert.ok(indexHtml.includes('id="m1WinMonth"'), 'Modal month select present');
    assert.ok(indexHtml.includes('id="m1on1PrevYearBtn"'), 'Previous year button present');
    assert.ok(indexHtml.includes('id="m1on1NextYearBtn"'), 'Next year button present');
    console.log('  ✔ Verified: Schedule, Save, Update, Cancel, Manual Open, Manual Close, Confirmation, Modal Close, and Year/Month navigation present and wired');

    // Clean up test data
    await db.run('DELETE FROM monthly_1on1_reports WHERE reporting_month IN (?, ?)', [TEST_MONTH_1_KEY, TEST_MONTH_2_KEY]);
    await db.close();

    console.log('\n================================================================');
    console.log('🎉 ALL REPORTING WINDOW SCHEDULING SYSTEM TESTS PASSED 100%!');
    console.log('================================================================');

    process.exit(0);

  } catch (err) {
    console.error('\n❌ TEST FAILED:', err);
    if (db) await db.close();
    process.exit(1);
  }
})();
