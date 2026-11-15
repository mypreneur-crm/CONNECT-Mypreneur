'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { MySQLDatabase, databaseConfig } = require('../lib/database');
const monthly1on1Db = require('../lib/monthly-1on1-db');

const BASE_URL = 'http://localhost:3000';
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
          'Host': 'localhost:3000',
          'Origin': BASE_URL,
          'Cookie': this.cookie,
          'X-CSRF-Token': this.csrf,
          'Connection': 'close',
          ...customHeaders
        };
        if (payload && !headers['Content-Type']) {
          headers['Content-Type'] = 'application/json';
          headers['Content-Length'] = Buffer.byteLength(payload);
        }

        const req = http.request(`${BASE_URL}${path}`, { method, headers }, res => {
          let raw = '';
          res.on('data', chunk => { raw += chunk; });
          res.on('end', () => {
            let data = null;
            try { data = JSON.parse(raw); } catch { data = raw; }
            resolve({ status: res.statusCode, headers: res.headers, data, rawText: raw });
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
  console.log('=== STARTING MONTHLY 1:1 FINAL REPORT VIEW & PRINT / SAVE AS PDF TEST ===\n');

  const db = new MySQLDatabase(databaseConfig());
  await db.ready;

  // Authenticated test users
  const employee = createClient(13);   // Hariharan (member, Operations Team)
  const manager = createClient(5);      // System Admin (admin)
  const unauthorized = createClient(14); // Soundarya (member, Sales Team)

  console.log('1. Setting up test report for Report View and Print verification...');
  const testMonth = '2026-08';
  // Clean up any previous test report for this month
  await db.run('DELETE FROM connect_monthly_1on1_items WHERE report_id IN (SELECT id FROM connect_monthly_1on1_reports WHERE reporting_month="2026-08-01")');
  await db.run('DELETE FROM connect_monthly_1on1_reports WHERE reporting_month="2026-08-01" AND record_type="report"');
  await manager.request('POST', '/api/monthly-1on1/windows', {
    reporting_month: testMonth,
    start_date: '2026-08-01',
    start_time: '00:00',
    end_date: '2026-12-31',
    end_time: '23:59'
  });

  const createRes = await employee.request('POST', '/api/monthly-1on1/reports', { reporting_month: testMonth });
  if (createRes.status !== 201) {
    console.error('Create failed:', createRes.data);
  }
  assert.equal(createRes.status, 201, 'Should create new report draft');
  const reportId = createRes.data.report.id;
  console.log(`   Created test report ID: ${reportId}`);

  // Save full set of items across all sections
  console.log('2. Populating full source-template dataset...');
  const saveRes = await employee.request('PATCH', `/api/monthly-1on1/reports/${reportId}`, {
    meeting_date: '2026-11-15',
    work_location: 'Coimbatore Office / Hybrid',
    current_projects: 'Project Reinvent Automation & Client Migration Portal',
    overall_status: 'On Track',
    capacity_for_additional_responsibilities: 'Yes',
    additional_responsibility_details: 'Can mentor junior associates and assist cross-functional testing in QA.',
    items: {
      completed_deliverables: [
        {
          task: 'Database schema migration for 1:1 reports',
          target_given: 'Deploy 2 tables without extra schemas',
          actual_completion: 'Completed 100% on schedule with full index coverage',
          impact_result: 'Enabled robust 1:1 report persistence and audit trails',
          proof_link: 'https://github.com/mypreneur/connect/pull/42'
        }
      ],
      pending_tasks: [
        {
          task: 'Automated end-to-end PDF export integration',
          reason_for_delay: 'Waiting for layout specification sign-off',
          current_status: 'In Progress (85% completed)',
          support_needed: 'Sign-off on Word template field ordering',
          expected_completion_date: '2026-11-20'
        }
      ],
      challenges_support: [
        {
          major_challenge: 'Balancing client production support with Reinvent feature milestones',
          support_required: 'Dedicated 2-hour daily sprint focus block'
        }
      ],
      responsibility_readiness: [
        {
          current_responsibilities: 'Core backend engineering and database optimizations',
          next_responsibilities: 'Lead QA automation and continuous delivery workflows',
          clarity_required: 'Deployment cadence for upcoming quarterly release'
        }
      ],
      improvement_suggestions: [
        { suggestion: 'Implement automated daily reminders for pending manager reviews.' },
        { suggestion: 'Add one-click export button directly to employee dashboard table.' }
      ],
      monthly_priorities: [
        { priority_number: 1, description: 'Finalize 1:1 printable report view and PDF generator' },
        { priority_number: 2, description: 'Execute comprehensive cross-role access security tests' },
        { priority_number: 3, description: 'Complete documentation and deployment checklist' }
      ]
    }
  });
  assert.equal(saveRes.status, 200, 'Should save draft successfully');

  console.log('3. Submitting report by employee...');
  const submitRes = await employee.request('POST', `/api/monthly-1on1/reports/${reportId}/submit`, {
    employee_acknowledged: true
  });
  assert.equal(submitRes.status, 200, 'Should submit report successfully');
  assert.equal(submitRes.data.report.status, 'Submitted');

  // Verify Security: Unauthorized access must be blocked
  console.log('4. Testing Access Control & Security...');
  console.log('   a) Unauthorized user attempt to export/view report (must return 403 Forbidden)...');
  const unauthRes = await unauthorized.request('GET', `/api/monthly-1on1/export/${reportId}?format=html`);
  assert.equal(unauthRes.status, 403, 'Unauthorized user must receive 403 Forbidden');
  console.log('      Blocked unauthorized user access (403 Forbidden).');

  console.log('   b) Anonymous unauthenticated request (must return 401)...');
  const anonRes = await new Promise(resolve => {
    http.get(`${BASE_URL}/api/monthly-1on1/export/${reportId}?format=html`, { headers: { Connection: 'close' } }, res => {
      res.resume();
      resolve(res.statusCode);
    });
  });
  assert.equal(anonRes, 401, 'Anonymous request must return 401 Unauthorized');
  console.log('      Blocked anonymous request (401 Unauthorized).');

  // Test Incomplete Report View & HTML Print Generation
  console.log('\n5. Testing Incomplete Report HTML Print & View...');
  const incompHtmlRes = await employee.request('GET', `/api/monthly-1on1/export/${reportId}?format=html`);
  assert.equal(incompHtmlRes.status, 200);
  assert.ok(incompHtmlRes.headers['content-type'].includes('text/html'), 'Content-Type must be text/html');
  const incompHtml = incompHtmlRes.rawText;

  // Title checks
  assert.ok(incompHtml.includes('MONTHLY 1:1 UPDATE TEMPLATE'), 'Must contain main report title');
  assert.ok(incompHtml.includes('Project Reinvent — Responsibility, Deliverables &amp; Readiness Review') ||
            incompHtml.includes('Project Reinvent — Responsibility, Deliverables & Readiness Review'), 'Must contain subtitle');

  // Incomplete status watermark / banner check
  assert.ok(incompHtml.includes('DOCUMENT NOT FINALIZED'), 'Incomplete report must prominently show NOT FINALIZED banner');
  assert.ok(incompHtml.includes('SUBMITTED'), 'Must show current status in incomplete banner');

  // Exact Word template field order verification
  console.log('   Verifying Employee Details field order:');
  const fieldNames = [
    'Employee Name',
    'Department / Role',
    'Reporting Month',
    'Manager / Reviewer',
    'Meeting Date',
    'Work Location',
    'Current Projects Handled',
    'Overall Status'
  ];
  let lastIndex = 0;
  for (const fn of fieldNames) {
    const idx = incompHtml.indexOf(fn);
    assert.ok(idx > -1, `Field "${fn}" must be present in Employee Details`);
    assert.ok(idx >= lastIndex, `Field "${fn}" must appear in correct Word template order`);
    lastIndex = idx;
    console.log(`      ✓ ${fn}`);
  }

  // Section 1 Columns check
  console.log('   Verifying Section 1. Key Deliverables Completed Last Month (5 columns):');
  const sec1Cols = ['Deliverable / Task', 'Target Given', 'Actual Completion', 'Impact / Result', 'Proof / Link'];
  sec1Cols.forEach(col => {
    assert.ok(incompHtml.includes(col) || (col === 'Proof / Link' && incompHtml.includes('Proof / Attachment')), `Section 1 must include column: ${col}`);
    console.log(`      ✓ ${col}`);
  });

  // Section 2 Columns check
  console.log('   Verifying Section 2. Pending Tasks / Delayed Items (5 columns):');
  const sec2Cols = ['Task', 'Reason for Delay', 'Current Status', 'Support Needed', 'Expected Completion Date'];
  sec2Cols.forEach(col => {
    assert.ok(incompHtml.includes(col), `Section 2 must include column: ${col}`);
    console.log(`      ✓ ${col}`);
  });

  // Section 3 Columns check
  console.log('   Verifying Section 3. Challenges & Support Required (2 columns):');
  const sec3Cols = ['Major Challenges Faced', 'Support Required from Management / Team'];
  sec3Cols.forEach(col => {
    assert.ok(incompHtml.includes(col), `Section 3 must include column: ${col}`);
    console.log(`      ✓ ${col}`);
  });

  // Section 4 Columns check + Capacity
  console.log('   Verifying Section 4. Project Reinvent — Responsibility & Readiness:');
  const sec4Cols = ['Current Responsibilities', 'Responsibilities You Can Take Next', 'Areas Where You Need Clarity'];
  sec4Cols.forEach(col => {
    assert.ok(incompHtml.includes(col), `Section 4 must include column: ${col}`);
    console.log(`      ✓ ${col}`);
  });
  assert.ok(incompHtml.includes('Capacity for Additional Responsibilities'), 'Must display Capacity for Additional Responsibilities');
  assert.ok(incompHtml.includes('Responsibility areas employee can handle'), 'Must display Responsibility areas employee can handle');

  // Section 5 check
  console.log('   Verifying Section 5. Suggestions & Commitment for This Month:');
  assert.ok(incompHtml.includes('5. Suggestions &amp; Commitment for This Month') || incompHtml.includes('5. Suggestions & Commitment for This Month'));
  assert.ok(incompHtml.includes('Suggestions for Improvement'));
  assert.ok(incompHtml.includes('Top 3 Priorities for This Month'));
  assert.ok(incompHtml.includes('Priority 1:'));
  assert.ok(incompHtml.includes('Priority 2:'));
  assert.ok(incompHtml.includes('Priority 3:'));

  // Section 6 incomplete check
  console.log('   Verifying Section 6 shows pending review status for incomplete report:');
  assert.ok(incompHtml.includes('6. Manager Notes / Final Alignment'));
  assert.ok(incompHtml.includes('Pending Manager Review') || incompHtml.includes('Pending review'), 'Incomplete report must indicate pending manager alignment');

  // Acknowledgements incomplete check
  console.log('   Verifying Acknowledgements for incomplete report:');
  assert.ok(incompHtml.includes('Acknowledgements'));
  assert.ok(incompHtml.includes('Employee Acknowledgement'));
  assert.ok(incompHtml.includes('Reviewer Acknowledgement'));
  assert.ok(incompHtml.includes('Pending Final Review') || incompHtml.includes('Final Review Pending'));

  // Manager Review & Finalization Flow
  console.log('\n6. Conducting Manager Review and Finalization...');
  // Assign reviewer #5
  await manager.request('POST', `/api/monthly-1on1/reports/${reportId}/assign-reviewer`, { reviewer_id: 5 });
  // Start review
  await manager.request('POST', `/api/monthly-1on1/reports/${reportId}/start-review`);
  // Finalize report
  const finRes = await manager.request('POST', `/api/monthly-1on1/reports/${reportId}/finalize`, {
    manager_notes: {
      key_observation: 'Exemplary execution on the Connect data persistence layer.',
      final_responsibility_assigned: 'Lead the continuous integration pipeline for Reinvent.',
      follow_up_date: '2026-12-01',
      additional_comments: 'Recommend for quarterly performance commendation.'
    },
    reviewer_acknowledged: true
  });
  assert.equal(finRes.status, 200, 'Should finalize report successfully');
  assert.equal(finRes.data.report.status, 'Completed');
  console.log('   Report finalized with manager notes and reviewer acknowledgement.');

  // Test Finalized Report View & HTML Print Generation
  console.log('\n7. Testing Finalized Report HTML Print & View...');
  const finHtmlRes = await employee.request('GET', `/api/monthly-1on1/export/${reportId}?format=html`);
  assert.equal(finHtmlRes.status, 200);
  const finHtml = finHtmlRes.rawText;

  // Finalized status checks
  assert.ok(finHtml.includes('FINALIZED &amp; COMPLETED REPORT') || finHtml.includes('FINALIZED & COMPLETED REPORT'), 'Must show completed banner');
  assert.ok(!finHtml.includes('DOCUMENT NOT FINALIZED'), 'Completed report must NOT show incomplete banner');

  // Manager Notes checks in Section 6
  console.log('   Verifying Section 6 Manager Notes:');
  assert.ok(finHtml.includes('Key Observation'));
  assert.ok(finHtml.includes('Exemplary execution on the Connect data persistence layer.'));
  assert.ok(finHtml.includes('Final Responsibility Assigned'));
  assert.ok(finHtml.includes('Lead the continuous integration pipeline for Reinvent.'));
  assert.ok(finHtml.includes('Deadline / Follow-up Date'));
  assert.ok(finHtml.includes('Additional Comments'));
  assert.ok(finHtml.includes('Recommend for quarterly performance commendation.'));

  // Acknowledgements checks
  console.log('   Verifying Acknowledgements for completed report:');
  assert.ok(finHtml.includes('Hariharan'));
  assert.ok(finHtml.includes('Director') || finHtml.includes('System Admin'));
  assert.ok(finHtml.includes('Reviewer Alignment Verified') || finHtml.includes('Reviewer identity & alignment verified') || finHtml.includes('Reviewer identity verified'));
  assert.ok(finHtml.includes('Portal Electronic Record') || finHtml.includes('Authenticated electronic'));

  // Print Styling Verification
  console.log('\n8. Verifying Professional Print Styling Rules...');
  assert.ok(finHtml.includes('@page'), 'Must include @page CSS rule');
  assert.ok(finHtml.includes('size: A4 portrait') || finHtml.includes('size:A4 portrait'), 'Must specify A4 portrait layout');
  assert.ok(finHtml.includes('@media print'), 'Must include @media print block');
  assert.ok(finHtml.includes('no-print'), 'Toolbar must be marked with .no-print');
  assert.ok(finHtml.includes('page-break-inside: avoid') || finHtml.includes('break-inside: avoid'), 'Must avoid breaking inside table rows');
  assert.ok(finHtml.includes('page-break-after: avoid') || finHtml.includes('break-after: avoid'), 'Must avoid separating headings from tables');
  assert.ok(finHtml.includes('border-collapse: collapse'), 'Must collapse table borders');
  assert.ok(finHtml.includes('word-break: break-word'), 'Must prevent content cut-off');
  console.log('   ✓ A4 portrait layout configured');
  console.log('   ✓ Toolbar and interactive buttons hidden in print');
  console.log('   ✓ Table border collapse and readable typography configured');
  console.log('   ✓ Page-break protection on table rows, headings and cards verified');

  // Verify API JSON format compatibility
  console.log('\n9. Verifying API JSON Format Compatibility...');
  const jsonRes = await employee.request('GET', `/api/monthly-1on1/export/${reportId}`);
  assert.equal(jsonRes.status, 200);
  assert.equal(typeof jsonRes.data, 'object');
  assert.equal(jsonRes.data.report.id, reportId);
  assert.equal(jsonRes.data.report.status, 'Completed');
  console.log('   ✓ /api/monthly-1on1/export/:id returns clean JSON for API clients');

  // Verify public/index.html frontend on-screen view elements
  console.log('\n10. Verifying public/index.html UI components...');
  const indexHtml = fs.readFileSync(path.resolve(__dirname, '../public/index.html'), 'utf8');
  assert.ok(indexHtml.includes('MONTHLY 1:1 UPDATE TEMPLATE'), 'index.html must contain report title');
  assert.ok(indexHtml.includes('Project Reinvent — Responsibility, Deliverables &amp; Readiness Review'), 'index.html must contain subtitle');
  assert.ok(indexHtml.includes('m1on1ReadBackBtn'), 'index.html must contain Back to Dashboard button');
  assert.ok(indexHtml.includes('m1on1PrintReportBtn'), 'index.html must contain Print / Save as PDF button');
  assert.ok(indexHtml.includes('DOCUMENT NOT FINALIZED'), 'index.html must support incomplete document banner');
  assert.ok(indexHtml.includes('FINALIZED &amp; COMPLETED REPORT'), 'index.html must support finalized report banner');
  assert.ok(indexHtml.includes('Capacity for Additional Responsibilities'), 'index.html must show capacity field');
  assert.ok(indexHtml.includes('Responsibility areas employee can handle'), 'index.html must show responsibility areas');
  assert.ok(indexHtml.includes('@page'), 'index.html must contain @page print styling');
  assert.ok(indexHtml.includes('size: A4 portrait'), 'index.html must specify A4 portrait print format');
  console.log('   ✓ All required UI elements and print stylesheets verified in public/index.html');

  console.log('\n=== ALL 10 MONTHLY 1:1 REPORT VIEW & PRINT / PDF VERIFICATION CHECKS PASSED! ===');
  await db.close();
  process.exit(0);
})().catch(err => {
  console.error('\n❌ Test failed:', err);
  process.exit(1);
});
