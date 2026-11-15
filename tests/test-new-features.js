'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'mypreneur_connect_local_secret_32chars_long_key_1234';

function signSession(userId, csrf) {
  const payload = { v: 1, userId: Number(userId), csrf, exp: Date.now() + 3600000 };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function createClient(userId = null) {
  const csrf = crypto.randomBytes(24).toString('base64url');
  const cookies = [];
  if (userId) cookies.push(`mc_session=${signSession(userId, csrf)}`);

  return {
    userId,
    csrf,
    cookies,
    async request(method, reqPath, body = null, customHeaders = {}) {
      return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const headers = {
          'Accept': 'application/json',
          'x-csrf-token': csrf,
          ...customHeaders
        };
        if (cookies.length) headers['Cookie'] = cookies.join('; ');
        if (payload) {
          headers['Content-Type'] = 'application/json';
          headers['Content-Length'] = Buffer.byteLength(payload);
        }

        const req = http.request({
          hostname: '127.0.0.1',
          port: PORT,
          path: reqPath,
          method,
          headers
        }, (res) => {
          let chunks = [];
          res.on('data', chunk => chunks.push(chunk));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            let data = null;
            try { data = JSON.parse(raw); } catch(e) { data = raw; }
            resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, data });
          });
        });

        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
      });
    }
  };
}

async function run() {
  console.log('========================================================================');
  console.log('TESTING 3 NEW FEATURES IN MONTHLY CONNECT');
  console.log('========================================================================\n');

  // 1. Static frontend checks on index.html
  const indexPath = path.join(__dirname, '..', 'public', 'index.html');
  const indexHtml = fs.readFileSync(indexPath, 'utf8');

  // Feature 3: Rename to Monthly Connect
  assert.ok(
    indexHtml.includes('label:"Monthly Connect"') && indexHtml.includes('id:"monthly1on1"'),
    'Sidebar menu label must be Monthly Connect'
  );
  assert.ok(
    indexHtml.includes(`: route === 'monthly1on1' ? 'Monthly Connect'`),
    'Document title mapped to Monthly Connect'
  );
  console.log('✅ Feature 3 (Rename): Sidebar menu and route title are "Monthly Connect"');

  // Feature 1: Work Location dropdown
  assert.ok(indexHtml.includes('<select id="m1_work_location"'), 'm1_work_location must be <select>');
  assert.ok(indexHtml.includes('value="Work From Office"'), 'Must have Work From Office option');
  assert.ok(indexHtml.includes('value="Work From Home"'), 'Must have Work From Home option');
  console.log('✅ Feature 1 (Work Location): Dropdown with Work From Office & Work From Home present');

  // Feature 2: Steps 2-6 optional and NO "(Optional)" text
  assert.ok(!indexHtml.includes('2. Completed Deliverables (Optional)'), 'No (Optional) on Step 2');
  assert.ok(!indexHtml.includes('3. Pending Tasks (Optional)'), 'No (Optional) on Step 3');
  assert.ok(!indexHtml.includes('4. Challenges & Support (Optional)'), 'No (Optional) on Step 4');
  assert.ok(!indexHtml.includes('5. Project Reinvent (Optional)'), 'No (Optional) on Step 5');
  assert.ok(!indexHtml.includes('6. Suggestions & Commit (Optional)'), 'No (Optional) on Step 6');
  assert.ok(!indexHtml.includes('Capacity for Additional Responsibilities (Optional)'), 'No (Optional) on Capacity');
  console.log('✅ Feature 2 (Optional steps): Steps 2-6 do NOT mention "Optional" in labels');

  // 2. End-to-end API test with server
  const admin = createClient(5);  // Super Admin
  const emp = createClient(13);   // Employee B
  const testMonth = '2026-11';

  // Create initial report draft
  let reportId;
  const draft1 = await emp.request('POST', '/api/monthly-1on1/reports', {
    reporting_month: testMonth
  });

  if (draft1.ok) {
    reportId = draft1.data.report.id;
    console.log('✅ Created report draft with ID:', reportId);
  } else {
    console.log('Draft creation response:', draft1.data);
    const repList = await emp.request('GET', '/api/monthly-1on1/reports');
    console.log('Employee reports list:', repList.data);
    const existing = repList.data.reports && repList.data.reports.find(r => r.reporting_month.startsWith('2026-11'));
    if (existing) {
      reportId = existing.id;
      console.log('✅ Found existing report:', reportId, 'status:', existing.status);
    } else {
      throw new Error('No existing report found for 2026-11');
    }
  }

  // Update draft with Work From Home
  const patch1 = await emp.request('PATCH', `/api/monthly-1on1/reports/${reportId}`, {
    work_location: 'Work From Home',
    overall_status: 'On Track'
  });
  assert.ok(patch1.ok, `Failed to update work_location to Work From Home: ${JSON.stringify(patch1.data)}`);
  assert.equal(patch1.data.report.work_location, 'Work From Home');
  console.log('✅ Saved draft with Work Location = "Work From Home"');

  // Update draft with Work From Office and completely BLANK steps 2-6
  const updateRes = await emp.request('PATCH', `/api/monthly-1on1/reports/${reportId}`, {
    work_location: 'Work From Office',
    overall_status: 'On Track',
    // Steps 2-6 completely empty:
    completed_deliverables: [],
    pending_tasks: [],
    no_pending_tasks: false,
    challenges_support: [],
    no_major_challenges: false,
    capacity_for_additional_responsibilities: null,
    additional_responsibility_details: '',
    improvement_suggestions: [],
    monthly_priorities: []
  });
  assert.ok(updateRes.ok, `Draft update failed: ${JSON.stringify(updateRes.data)}`);
  assert.equal(updateRes.data.report.work_location, 'Work From Office');
  console.log('✅ Updated report to Work Location = "Work From Office" and left Steps 2-6 blank');

  // Submit the report with steps 2-6 completely blank
  const submitRes = await emp.request('POST', `/api/monthly-1on1/reports/${reportId}/submit`, {
    acknowledged: true,
    signature_data: 'Authenticated via Connect credentials'
  });
  assert.ok(submitRes.ok, `Submission failed: ${JSON.stringify(submitRes.data)}`);
  assert.equal(submitRes.data.report.status, 'Submitted');
  assert.equal(submitRes.data.report.work_location, 'Work From Office');
  console.log('✅ Successfully submitted Monthly Connect report with Steps 2-6 completely blank');

  // Read report print view and verify title
  const printRes = await emp.request('GET', `/api/monthly-1on1/export/${reportId}?format=html`, null, {
    'Accept': 'text/html'
  });
  assert.ok(printRes.ok, `Print view request failed: ${printRes.status}`);
  assert.ok(printRes.data.includes('MONTHLY CONNECT UPDATE TEMPLATE'), 'Print view title has MONTHLY CONNECT');
  assert.ok(printRes.data.includes('Monthly Connect Report'), 'Print view banner has Monthly Connect Report');
  console.log('✅ Print template successfully displays "MONTHLY CONNECT UPDATE TEMPLATE"');

  console.log('\n========================================================================');
  console.log('ALL 3 NEW FEATURES VERIFIED AND PASSING 100%!');
  console.log('========================================================================\n');
}

run().catch(err => {
  console.error('Test execution error:', err);
  process.exit(1);
});
