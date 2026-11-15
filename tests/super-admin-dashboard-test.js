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
  console.log('SUPER ADMIN MONTHLY 1:1 DASHBOARD: VERIFICATION & AUDIT SUITE');
  console.log('================================================================\n');

  const db = new MySQLDatabase(databaseConfig());
  await db.ready;

  const superAdmin = createClient(5);     // ID 5, System Admin
  const serviceAdmin = createClient(22);  // ID 22, Kaviya
  const emp = createClient(13);           // ID 13, Hariharan

  try {
    // -------------------------------------------------------------
    // Test 1: DOM Inspection & Main Dashboard Structure
    // -------------------------------------------------------------
    console.log('[Test 1] Inspecting Main Dashboard Structure in public/index.html...');
    const indexHtml = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

    // Title
    assert.ok(indexHtml.includes('Monthly 1:1 Meeting Report'), 'Main Title must be present');

    // Subtitle
    assert.ok(indexHtml.includes('Track your deliverables, challenges, responsibilities and monthly performance discussions.'), 'Subtitle must be present');

    // Year Navigation
    assert.ok(indexHtml.includes('id="m1on1PrevYearBtn"'), 'Previous year button must exist');
    assert.ok(indexHtml.includes('id="m1on1YearDisplay"'), 'Selected year display must exist');
    assert.ok(indexHtml.includes('id="m1on1NextYearBtn"'), 'Next year button must exist');
    assert.ok(indexHtml.includes('class="year-tabs"'), 'Year tabs must exist');

    // 12-Month Responsive Grid CSS
    assert.ok(indexHtml.includes('.m1on1-month-grid{display:grid;grid-template-columns:repeat(4,1fr)'), 'Desktop layout must be 4 columns');
    assert.ok(indexHtml.includes('@media(max-width:820px){.m1on1-month-grid{grid-template-columns:repeat(2,1fr)}}'), 'Tablet layout must be 2 columns');
    assert.ok(indexHtml.includes('@media(max-width:520px){.m1on1-month-grid{grid-template-columns:1fr}}'), 'Mobile layout must be 1 column');

    // Month Cards: Month and year, status badges, dates, actions
    assert.ok(indexHtml.includes('OPEN'), 'OPEN status badge must be present');
    assert.ok(indexHtml.includes('CLOSED'), 'CLOSED status badge must be present');
    assert.ok(indexHtml.includes('NOT SCHEDULED'), 'NOT SCHEDULED status badge must be present');
    assert.ok(indexHtml.includes('Opening Date:'), 'Opening Date label must be present');
    assert.ok(indexHtml.includes('Closing Date:'), 'Closing Date label must be present');
    assert.ok(indexHtml.includes('Schedule 1:1 Meeting Report'), 'Schedule 1:1 Meeting Report button must be present');
    assert.ok(indexHtml.includes('Open 1:1 Meeting Report'), 'Open 1:1 Meeting Report button must be present');
    assert.ok(indexHtml.includes('Close 1:1 Meeting Report'), 'Close 1:1 Meeting Report button must be present');

    // Disabled state
    assert.ok(indexHtml.includes('disabled style="opacity:0.5;cursor:not-allowed"') || indexHtml.includes('opacity:0.5;cursor:not-allowed" disabled'), 'Disabled button state must be styled to prevent broken clicks');
    console.log('  ✔ Verified: Title, year navigation, 4-column responsive grid, status badges, and action buttons present in index.html');

    // -------------------------------------------------------------
    // Test 2: Dashboard Restrictions
    // -------------------------------------------------------------
    console.log('\n[Test 2] Verifying Dashboard Restrictions (Super Admin Clean View)...');
    // Ensure Super Admin main dashboard does NOT contain employee application tables or stats
    assert.ok(!indexHtml.includes('Super Admin Control Center'), 'Super Admin Control Center widget removed from main dashboard');
    assert.ok(indexHtml.includes('All Employee Applications'), 'Separate review link/button present');
    console.log('  ✔ Verified: Super Admin main dashboard contains only reporting window scheduling; review is on separate page');

    // -------------------------------------------------------------
    // Test 3: Year Navigation & 12-Month Schedule API
    // -------------------------------------------------------------
    console.log('\n[Test 3] Verifying Year Navigation & 12 Months API...');
    for (const year of [2025, 2026, 2027]) {
      const yearRes = await superAdmin.request('GET', `/api/monthly-1on1/windows/year?year=${year}`);
      assert.equal(yearRes.status, 200, `Year ${year} API must return 200`);
      assert.equal(yearRes.data.year, year, `Returned year must match ${year}`);
      assert.equal(yearRes.data.months.length, 12, `Must return exactly 12 months for year ${year}`);
      assert.equal(yearRes.data.months[0].month_name, 'January');
      assert.equal(yearRes.data.months[11].month_name, 'December');
    }
    console.log('  ✔ Verified: All 12 months returned for 2025, 2026, and 2027 in exact chronological order');

    // -------------------------------------------------------------
    // Test 4: Authorization Enforcement (Only Super Admin can access scheduling)
    // -------------------------------------------------------------
    console.log('\n[Test 4] Verifying Authorization Enforcement...');
    const empYearAccess = await emp.request('GET', '/api/monthly-1on1/windows/year?year=2026');
    assert.equal(empYearAccess.status, 403, 'Employee must not be able to access 12-month schedule API');

    const srvYearAccess = await serviceAdmin.request('GET', '/api/monthly-1on1/windows/year?year=2026');
    assert.equal(srvYearAccess.status, 403, 'Service Admin must not be able to access 12-month schedule API');
    console.log('  ✔ Verified: Non-Super Admin access strictly blocked with HTTP 403');

    // -------------------------------------------------------------
    // Test 5: Schedule Modal & Save/Update Operations
    // -------------------------------------------------------------
    console.log('\n[Test 5] Verifying Modal Schedule Configuration & Status Update...');
    const TEST_MONTH = '2026-05-01';

    // Close any active windows first
    await db.run("UPDATE monthly_1on1_reports SET status='Closed' WHERE record_type='window'");

    // Super Admin schedules May 2026
    const scheduleRes = await superAdmin.request('POST', '/api/monthly-1on1/windows', {
      reporting_month: TEST_MONTH,
      start_date: '2026-05-01',
      start_time: '09:00',
      end_date: '2026-05-20',
      end_time: '18:00'
    });
    assert.equal(scheduleRes.status, 200, 'Schedule save must succeed');
    assert.equal(scheduleRes.data.window.reporting_month, TEST_MONTH);
    assert.ok(scheduleRes.data.window.start_ist.includes('May 2026'), 'Start date formatted in IST');
    assert.ok(scheduleRes.data.window.end_ist.includes('May 2026'), 'End date formatted in IST');

    // Verify GET /api/monthly-1on1/windows populates modal details
    const fetchModalData = await superAdmin.request('GET', `/api/monthly-1on1/windows?month=2026-05`);
    assert.equal(fetchModalData.status, 200);
    assert.ok(fetchModalData.data.window.window_start, 'Existing schedule start populated');
    assert.ok(fetchModalData.data.window.window_end, 'Existing schedule end populated');
    console.log('  ✔ Verified: Schedule modal populated existing details and saved values to database');

    // -------------------------------------------------------------
    // Test 6: Manual Open & Status Turning Green
    // -------------------------------------------------------------
    console.log('\n[Test 6] Verifying Manual Open Control & Status...');
    const manualOpenRes = await superAdmin.request('POST', '/api/monthly-1on1/windows/manual-open', {
      reporting_month: TEST_MONTH,
      reason: 'Manual opening test'
    });
    assert.equal(manualOpenRes.status, 200, 'Manual open succeeds');
    assert.equal(manualOpenRes.data.window.status, 'open', 'Effective status must be "open"');
    assert.equal(manualOpenRes.data.window.display_status, 'Open');
    console.log('  ✔ Verified: Manual Open applied immediately; status turns green (OPEN)');

    // -------------------------------------------------------------
    // Test 7: Manual Close & Status Turning Red
    // -------------------------------------------------------------
    console.log('\n[Test 7] Verifying Manual Close Control & Status...');
    const manualCloseRes = await superAdmin.request('POST', '/api/monthly-1on1/windows/close', {
      reporting_month: TEST_MONTH
    });
    assert.equal(manualCloseRes.status, 200, 'Manual close succeeds');
    assert.equal(manualCloseRes.data.window.status, 'closed', 'Effective status must be "closed"');
    assert.equal(manualCloseRes.data.window.display_status, 'Closed');
    console.log('  ✔ Verified: Manual Close applied immediately; status turns red (CLOSED)');

    // -------------------------------------------------------------
    // Test 8: Refreshing and Data Persistence
    // -------------------------------------------------------------
    console.log('\n[Test 8] Verifying Dates and Statuses Persist After Page Refresh / Re-query...');
    const reQueryRes = await superAdmin.request('GET', `/api/monthly-1on1/windows/year?year=2026`);
    assert.equal(reQueryRes.status, 200);
    const mayData = reQueryRes.data.months.find(m => m.month === 5);
    assert.ok(mayData, 'May data must exist');
    assert.equal(mayData.window.status, 'closed', 'May status must persist as closed');
    assert.ok(mayData.window.start_ist, 'May start date must persist');
    assert.ok(mayData.window.end_ist, 'May end date must persist');
    console.log('  ✔ Verified: Dates and statuses persist accurately across queries and page reloads');

    await db.close();

    console.log('\n================================================================');
    console.log('🎉 ALL SUPER ADMIN DASHBOARD VERIFICATION CHECKS PASSED 100%!');
    console.log('================================================================');

    process.exit(0);
  } catch (err) {
    console.error('\n❌ TEST FAILED:', err);
    if (db) await db.close();
    process.exit(1);
  }
})();

