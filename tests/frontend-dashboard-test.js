'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const BASE_URL = 'http://127.0.0.1:3000';

function makeRequest(method, urlPath, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE_URL);
    const req = http.request(url, { method, headers: { ...headers, Connection: 'close' } }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: json || data });
      });
    });
    req.on('error', reject);
    if (body) {
      if (typeof body === 'string') req.write(body);
      else req.write(JSON.stringify(body));
    }
    req.end();
  });
}

(async () => {
  console.log('--- Starting Monthly 1:1 Frontend Dashboard Verification Test ---');

  // 1. Verify index.html content
  console.log('1. Checking public/index.html content...');
  const indexHtml = fs.readFileSync(path.resolve(__dirname, '../public/index.html'), 'utf8');

  // Verify Sidebar
  assert.ok(indexHtml.includes('"monthly1on1"') && indexHtml.includes('"Monthly 1:1 Meeting Report"') && indexHtml.includes('"clipboard"'), 'Sidebar must include Monthly 1:1 Meeting Report item');
  assert.ok(indexHtml.includes('clipboard:\'<rect x="8" y="2" width="8" height="4" rx="1"/>'), 'Clipboard icon SVG must be defined');

  // Verify Header & Subtitle
  assert.ok(indexHtml.includes('Monthly 1:1 Meeting Report'), 'Title must be present');
  assert.ok(indexHtml.includes('Track your deliverables, challenges, responsibilities and monthly performance discussions.'), 'Exact subtitle must be present');

  // Verify Year Navigation
  assert.ok(indexHtml.includes('id="m1on1PrevYearBtn"'), 'Previous year button must exist');
  assert.ok(indexHtml.includes('id="m1on1YearDisplay"'), 'Year display must exist');
  assert.ok(indexHtml.includes('id="m1on1NextYearBtn"'), 'Next year button must exist');

  // Verify 12 Monthly Cards Status & Action Mapping
  assert.ok(indexHtml.includes('MONTHS_FULL.map'), 'Must map over all 12 months');
  assert.ok(indexHtml.includes('Not Started'), 'Must handle Not Started');
  assert.ok(indexHtml.includes('Start Report'), 'Action Start Report must be mapped');
  assert.ok(indexHtml.includes('Continue Report'), 'Action Continue Report must be mapped for Draft');
  assert.ok(indexHtml.includes('View Report'), 'Action View Report must be mapped for Submitted');
  assert.ok(indexHtml.includes('View Status'), 'Action View Status must be mapped for Under Review');
  assert.ok(indexHtml.includes('Edit & Resubmit'), 'Action Edit & Resubmit must be mapped for Revision Requested');
  assert.ok(indexHtml.includes('View Final Report'), 'Action View Final Report must be mapped for Completed');

  // Verify My Monthly 1:1 Reports Table
  assert.ok(indexHtml.includes('My Monthly 1:1 Reports'), 'Table heading must be present');
  assert.ok(indexHtml.includes('id="m1on1TableSearch"'), 'Search input must exist');
  assert.ok(indexHtml.includes('id="m1on1FilterYear"'), 'Year filter select must exist');
  assert.ok(indexHtml.includes('id="m1on1FilterMonth"'), 'Month filter select must exist');
  assert.ok(indexHtml.includes('id="m1on1FilterStatus"'), 'Status filter select must exist');
  assert.ok(indexHtml.includes('id="m1on1ResetFiltersBtn"'), 'Reset filters button must exist');

  // Verify Table Columns
  const requiredColumns = [
    'Report ID',
    'Reporting Month',
    'Employee',
    'Department',
    'Reviewer',
    'Meeting Date',
    'Submitted Date',
    'Status',
    'Action'
  ];
  for (const col of requiredColumns) {
    assert.ok(indexHtml.includes(col), `Table column '${col}' must be present`);
  }

  // 2. HTTP Server verification
  console.log('2. Verifying HTTP Server on http://localhost:3000...');
  const homeRes = await makeRequest('GET', '/');
  assert.equal(homeRes.status, 200, 'Home page must return 200 OK');

  // 3. Login
  console.log('3. Authenticating as admin via /api/login...');
  const loginRes = await makeRequest('POST', '/api/login', { 'Content-Type': 'application/json' }, {
    username: 'admin',
    password: 'Admin@123'
  });
  assert.equal(loginRes.status, 200, 'Login must succeed');
  assert.ok(loginRes.body.user, 'Login must return user');
  const setCookie = loginRes.headers['set-cookie'];
  assert.ok(setCookie, 'Login must return session cookie');
  const sessionCookie = Array.isArray(setCookie) ? setCookie[0].split(';')[0] : setCookie.split(';')[0];
  const csrfToken = loginRes.body.csrfToken;

  const authHeaders = {
    'Cookie': sessionCookie,
    'X-CSRF-Token': csrfToken
  };

  // 4. Test /api/bootstrap
  console.log('4. Testing /api/bootstrap with session...');
  const bootRes = await makeRequest('GET', '/api/bootstrap', authHeaders);
  assert.equal(bootRes.status, 200);
  assert.equal(bootRes.body.user.username, 'admin');

  // 5. Test /api/monthly-1on1/overview
  console.log('5. Testing /api/monthly-1on1/overview?year=2026...');
  const overviewRes = await makeRequest('GET', '/api/monthly-1on1/overview?year=2026', authHeaders);
  assert.equal(overviewRes.status, 200);
  assert.equal(overviewRes.body.year, 2026);
  assert.ok(Array.isArray(overviewRes.body.reports));

  // 6. Test /api/monthly-1on1/reports with search and filters
  console.log('6. Testing /api/monthly-1on1/reports with search and filters...');
  const reportsRes = await makeRequest('GET', '/api/monthly-1on1/reports?year=2026&status=all&q=', authHeaders);
  assert.equal(reportsRes.status, 200);
  assert.ok(Array.isArray(reportsRes.body.reports));
  assert.equal(typeof reportsRes.body.total, 'number');
  assert.equal(reportsRes.body.page, 1);

  // 7. Test search filter
  console.log('7. Testing text search query...');
  const searchRes = await makeRequest('GET', '/api/monthly-1on1/reports?q=Admin', authHeaders);
  assert.equal(searchRes.status, 200);
  assert.ok(Array.isArray(searchRes.body.reports));

  console.log('\nAll frontend dashboard verification checks PASSED successfully!');
})();
