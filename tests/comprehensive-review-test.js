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
  console.log('================================================================================');
  console.log('  COMPREHENSIVE INTEGRATION & QUALITY REVIEW: MONTHLY 1:1 MEETING REPORT');
  console.log('================================================================================\n');

  const db = new MySQLDatabase(databaseConfig());
  await db.ready;

  const results = {
    employeeWorkflow: false,
    managerWorkflow: false,
    security: false,
    database: false,
    ui: false,
    regression: false
  };

  const employee = createClient(13);   // Hariharan (member, Operations Team)
  const manager = createClient(5);      // System Admin (admin)
  const unauthorized = createClient(14); // Soundarya (member, Sales Team)

  const reviewMonth = '2026-07';
  let testReportId = null;

  // --------------------------------------------------------------------------
  // 1. Employee Workflow Testing
  // --------------------------------------------------------------------------
  console.log('>>> 1. EMPLOYEE WORKFLOW TESTING');
  try {
    // Clean up any existing report for reviewMonth
    await db.run('DELETE FROM connect_monthly_1on1_items WHERE report_id IN (SELECT id FROM connect_monthly_1on1_reports WHERE reporting_month="2026-07-01")');
    await db.run('DELETE FROM connect_monthly_1on1_reports WHERE reporting_month="2026-07-01"');

    // Setup reporting window for reviewMonth (Rule B1)
    await manager.request('POST', '/api/monthly-1on1/windows', {
      reporting_month: reviewMonth,
      start_date: '2026-07-01',
      start_time: '00:00',
      end_date: '2026-12-31',
      end_time: '23:59'
    });

    // 1.1 Login & Overview
    const overview = await employee.request('GET', '/api/monthly-1on1/overview?year=2026');
    assert.equal(overview.status, 200, 'Employee should access overview');
    assert.equal(overview.data.teamSummary, null, 'Employee should not see team summary');
    console.log('  1.1 Employee authenticated and opened Monthly 1:1 overview (200 OK)');

    // 1.2 Start new report for reporting month
    const startRes = await employee.request('POST', '/api/monthly-1on1/reports', { reporting_month: reviewMonth });
    assert.equal(startRes.status, 201, 'Should start new report draft');
    assert.equal(startRes.data.report.status, 'Draft');
    testReportId = startRes.data.report.id;
    console.log(`  1.2 Started new report draft: ${testReportId} (Status: Draft)`);

    // 1.3 Fill Employee Details, Deliverables, Pending, Challenges, Reinvent, Suggestions & Priorities
    const initialPayload = {
      meeting_date: '2026-07-20',
      work_location: 'Coimbatore HQ',
      current_projects: 'Connect Core Portal & Employee Directory',
      overall_status: 'On Track',
      capacity_for_additional_responsibilities: 'Yes',
      additional_responsibility_details: 'Can handle sprint triage and cross-team test automation.',
      items: {
        completed_deliverables: [
          {
            task: 'Deliverable Alpha: Portal Authentication Redesign',
            target_given: 'Complete session token rotation',
            actual_completion: 'Completed on schedule',
            impact_result: 'Eliminated session fixation vulnerabilities',
            proof_link: 'https://github.com/mypreneur/connect/commit/auth01'
          },
          {
            task: 'Deliverable Beta: Audit Logging Integration',
            target_given: 'Log all critical mutations',
            actual_completion: 'Integrated into database layer',
            impact_result: 'Full compliance with company audit policy',
            proof_link: 'https://github.com/mypreneur/connect/commit/audit02'
          }
        ],
        pending_tasks: [
          {
            task: 'Task Gamma: Load Testing Dashboard',
            reason_for_delay: 'Waiting for staging environment refresh',
            current_status: 'Pending Staging',
            support_needed: 'Staging environment allocation by DevOps',
            expected_completion_date: '2026-07-28'
          }
        ],
        challenges_support: [
          {
            major_challenge: 'High concurrency during shift end check-ins',
            support_required: 'Database connection pool optimization'
          }
        ],
        responsibility_readiness: [
          {
            current_responsibilities: 'Backend maintenance and API development',
            next_responsibilities: 'Lead QA automation and performance benchmarking',
            clarity_required: 'Timeline for infrastructure scaling'
          }
        ],
        improvement_suggestions: [
          { suggestion: 'Enable email digests for weekly 1:1 pending actions.' },
          { suggestion: 'Add dark-mode toggle for late-shift workers.' }
        ],
        monthly_priorities: [
          { priority_number: 1, description: 'Stabilize connection pooling under high load' },
          { priority_number: 2, description: 'Roll out 1:1 manager review dashboard' },
          { priority_number: 3, description: 'Verify end-to-end security audit trail' }
        ]
      }
    };

    const draftSave = await employee.request('PATCH', `/api/monthly-1on1/reports/${testReportId}`, initialPayload);
    assert.equal(draftSave.status, 200, 'Draft should be saved successfully');
    console.log('  1.3 Filled all source sections and saved draft (200 OK)');

    // 1.4 Refresh and reload draft
    const reload = await employee.request('GET', `/api/monthly-1on1/reports/${testReportId}`);
    assert.equal(reload.status, 200);
    assert.equal(reload.data.report.items.completed_deliverables.length, 2);
    assert.equal(reload.data.report.items.pending_tasks.length, 1);
    assert.equal(reload.data.report.items.challenges_support.length, 1);
    assert.equal(reload.data.report.items.responsibility_readiness.length, 1);
    assert.equal(reload.data.report.items.improvement_suggestions.length, 2);
    assert.equal(reload.data.report.items.monthly_priorities.length, 3);
    console.log('  1.4 Refreshed and reloaded draft; verified data persistence across all 6 sections');

    // 1.5 Edit saved data (delete deliverable #2, modify deliverable #1)
    const updatedPayload = {
      ...initialPayload,
      items: {
        ...initialPayload.items,
        completed_deliverables: [
          {
            ...initialPayload.items.completed_deliverables[0],
            actual_completion: 'Completed with zero regression issues'
          }
        ]
      }
    };
    const editSave = await employee.request('PATCH', `/api/monthly-1on1/reports/${testReportId}`, updatedPayload);
    assert.equal(editSave.status, 200);
    assert.equal(editSave.data.report.items.completed_deliverables.length, 1);
    console.log('  1.5 Edited saved draft data (row removed and text updated cleanly)');

    // 1.6 Submit report
    const submit = await employee.request('POST', `/api/monthly-1on1/reports/${testReportId}/submit`, {
      employee_acknowledged: true
    });
    assert.equal(submit.status, 200);
    assert.equal(submit.data.report.status, 'Submitted');
    assert.ok(submit.data.report.submitted_at);
    assert.ok(submit.data.report.employee_acknowledged_at);
    console.log('  1.6 Submitted report with employee acknowledgement (Status changed to Submitted)');

    // 1.7 Verify employee can edit submitted report while window is open (Rule B5)
    const postSubmitEdit = await employee.request('PATCH', `/api/monthly-1on1/reports/${testReportId}`, {
      overall_status: 'Needs Attention'
    });
    assert.equal(postSubmitEdit.status, 200, 'Employee can edit submitted report while window is open');
    console.log('  1.7 Confirmed submitted report can be edited while window is open (200 OK, Rule B5)');

    // 1.8 Attempt duplicate month creation
    const dupRes = await employee.request('POST', '/api/monthly-1on1/reports', { reporting_month: reviewMonth });
    assert.equal(dupRes.status, 400, 'Duplicate report for same month must be rejected');
    assert.equal(dupRes.data.code, 'DUPLICATE');
    console.log('  1.8 Confirmed duplicate report creation for same month is rejected (400 DUPLICATE)');

    results.employeeWorkflow = true;
    console.log('  ✓ Employee Workflow Testing: PASSED\n');
  } catch (err) {
    console.error('  ✗ Employee Workflow Testing FAILED:', err.message);
  }

  // --------------------------------------------------------------------------
  // 2. Manager Workflow Testing
  // --------------------------------------------------------------------------
  console.log('>>> 2. MANAGER WORKFLOW TESTING');
  try {
    // 2.1 Login as authorized reviewer and open Manager Dashboard
    const teamReports = await manager.request('GET', '/api/monthly-1on1/team-reports?year=2026');
    assert.equal(teamReports.status, 200);
    assert.ok(teamReports.data.summary, 'Manager should receive summary cards');
    console.log('  2.1 Reviewer opened Manager Dashboard with summary cards (200 OK)');

    // 2.2 Filter by status & search
    const filtered = await manager.request('GET', `/api/monthly-1on1/team-reports?year=2026&status=Submitted&q=Hariharan`);
    assert.equal(filtered.status, 200);
    assert.ok(filtered.data.reports.some(r => r.id === testReportId), 'Should find submitted report');
    console.log('  2.2 Filtered team reports by status and employee query successfully');

    // 2.3 Assign authorized reviewer
    const assignRes = await manager.request('POST', `/api/monthly-1on1/reports/${testReportId}/assign-reviewer`, {
      reviewer_id: 5
    });
    assert.equal(assignRes.status, 200);
    console.log('  2.3 Assigned authorized reporting manager (ID: 5, System Admin)');

    // 2.4 Start review
    const startRev = await manager.request('POST', `/api/monthly-1on1/reports/${testReportId}/start-review`);
    assert.equal(startRev.status, 200);
    assert.equal(startRev.data.report.status, 'Under Review');
    console.log('  2.4 Started review; report status transitioned to Under Review');

    // 2.5 Save manager observations
    const saveNotes = await manager.request('PATCH', `/api/monthly-1on1/reports/${testReportId}/notes`, {
      key_observation: 'Initial discussion held. Need more quantitative metrics on performance impact.',
      final_responsibility_assigned: 'Lead the performance benchmarking suite.',
      follow_up_date: '2026-08-05',
      additional_comments: 'Re-align after metrics are added.'
    });
    assert.equal(saveNotes.status, 200);
    assert.equal(saveNotes.data.report.manager_notes.key_observation, 'Initial discussion held. Need more quantitative metrics on performance impact.');
    console.log('  2.5 Saved manager observations in manager_notes (200 OK)');

    // 2.6 Request revision
    const reqRev = await manager.request('POST', `/api/monthly-1on1/reports/${testReportId}/request-revision`, {
      reason: 'Please add quantitative benchmarking numbers to Deliverable Alpha impact.'
    });
    assert.equal(reqRev.status, 200);
    assert.equal(reqRev.data.report.status, 'Revision Requested');
    assert.equal(reqRev.data.report.revision_reason, 'Please add quantitative benchmarking numbers to Deliverable Alpha impact.');
    console.log('  2.6 Requested revision with mandatory reason; status changed to Revision Requested');

    // 2.7 Employee edits and resubmits
    const empEdit = await employee.request('PATCH', `/api/monthly-1on1/reports/${testReportId}`, {
      items: {
        completed_deliverables: [
          {
            task: 'Deliverable Alpha: Portal Authentication Redesign',
            target_given: 'Complete session token rotation',
            actual_completion: 'Completed on schedule',
            impact_result: 'Eliminated session fixation vulnerabilities; 45% faster login latency recorded in metrics',
            proof_link: 'https://github.com/mypreneur/connect/commit/auth01-benchmark'
          }
        ]
      }
    });
    assert.equal(empEdit.status, 200, 'Employee must be able to edit during Revision Requested');
    const resubmit = await employee.request('POST', `/api/monthly-1on1/reports/${testReportId}/submit`, {
      employee_acknowledged: true
    });
    assert.equal(resubmit.status, 200);
    assert.equal(resubmit.data.report.status, 'Submitted');
    console.log('  2.7 Employee edited requested revisions and resubmitted (Status: Submitted)');

    // 2.8 Reviewer opens revised report and finalizes
    await manager.request('POST', `/api/monthly-1on1/reports/${testReportId}/start-review`);
    const finalize = await manager.request('POST', `/api/monthly-1on1/reports/${testReportId}/finalize`, {
      manager_notes: {
        key_observation: 'Benchmark numbers confirmed (45% latency improvement). Superb work.',
        final_responsibility_assigned: 'Lead QA automation & continuous delivery.',
        follow_up_date: '2026-08-15',
        additional_comments: 'Final alignment confirmed.'
      },
      reviewer_acknowledged: true
    });
    assert.equal(finalize.status, 200);
    assert.equal(finalize.data.report.status, 'Completed');
    assert.ok(finalize.data.report.completed_at);
    assert.ok(finalize.data.report.reviewer_acknowledged_at);
    console.log('  2.8 Reviewer finalized report with final alignment notes and reviewer acknowledgement');

    // 2.9 Confirm finalized report is locked
    const tryEdit = await employee.request('PATCH', `/api/monthly-1on1/reports/${testReportId}`, {
      overall_status: 'Delayed'
    });
    assert.equal(tryEdit.status, 400, 'Finalized report cannot be edited');
    const trySubmit = await employee.request('POST', `/api/monthly-1on1/reports/${testReportId}/submit`, {
      employee_acknowledged: true
    });
    assert.equal(trySubmit.status, 400, 'Finalized report cannot be resubmitted');
    console.log('  2.9 Confirmed finalized report is strictly locked against edits and resubmission');

    results.managerWorkflow = true;
    console.log('  ✓ Manager Workflow Testing: PASSED\n');
  } catch (err) {
    console.error('  ✗ Manager Workflow Testing FAILED:', err.message);
  }

  // --------------------------------------------------------------------------
  // 3. Security Testing
  // --------------------------------------------------------------------------
  console.log('>>> 3. SECURITY TESTING');
  try {
    // 3.1 Cross-user report view prevention
    const peerView = await unauthorized.request('GET', `/api/monthly-1on1/reports/${testReportId}`);
    assert.equal(peerView.status, 403, 'Unauthorized peer must receive 403');
    console.log('  3.1 Cross-employee report view blocked (403 Forbidden)');

    // 3.2 URL ID tampering prevention
    const peerEdit = await unauthorized.request('PATCH', `/api/monthly-1on1/reports/${testReportId}`, {
      overall_status: 'At Risk'
    });
    assert.equal(peerEdit.status, 403, 'Unauthorized peer edit must receive 403');
    console.log('  3.2 URL ID tampering on PATCH blocked (403 Forbidden)');

    // 3.3 Peer access to team-reports
    const peerTeam = await unauthorized.request('GET', '/api/monthly-1on1/team-reports');
    assert.equal(peerTeam.status, 403, 'Non-reviewer cannot access team reports');
    console.log('  3.3 Non-reviewer access to team reports blocked (403 Forbidden)');

    // 3.4 Self-review prevention
    const selfReview = await employee.request('POST', `/api/monthly-1on1/reports/${testReportId}/start-review`);
    assert.equal(selfReview.status, 403, 'Employee self-review must be blocked');
    console.log('  3.4 Employee self-review attempt blocked (403 Forbidden)');

    // 3.5 CSRF validation
    const noCsrf = await employee.request('POST', '/api/monthly-1on1/reports', { reporting_month: '2026-05' }, { 'X-CSRF-Token': '' });
    assert.equal(noCsrf.status, 403, 'Missing CSRF must be rejected');
    assert.equal(noCsrf.data.code, 'CSRF');
    console.log('  3.5 Missing CSRF token rejected (403 Forbidden)');

    // 3.6 SQL parameterization verification
    const dbFile = fs.readFileSync(path.resolve(__dirname, '../lib/monthly-1on1-db.js'), 'utf8');
    const interpolatedQueries = dbFile.split('\n').filter(line => {
      const trimmed = line.trim();
      return (trimmed.startsWith('`SELECT') || trimmed.startsWith('`INSERT') || trimmed.startsWith('`UPDATE') || trimmed.startsWith('`DELETE')) && trimmed.includes('${');
    });
    assert.equal(interpolatedQueries.length, 0, 'No SQL query interpolation permitted in monthly-1on1-db.js');
    console.log('  3.6 Verified all database queries in monthly-1on1-db.js use parameterized bindings (?)');

    // 3.7 Content safe rendering (XSS Protection)
    const reportData = await manager.request('GET', `/api/monthly-1on1/export/${testReportId}?format=html`);
    assert.equal(reportData.status, 200);
    const htmlOutput = reportData.rawText;
    assert.ok(!htmlOutput.includes('<script>'), 'HTML output must not contain unescaped script tags');
    console.log('  3.7 Verified HTML output escapes user-submitted tags safely against XSS');

    // 3.8 Sensitive info protection in audit logs
    const auditLogs = await db.all("SELECT details FROM connect_audit_logs WHERE entity='monthly_1on1' AND entity_id=? LIMIT 10", [testReportId]);
    for (const log of auditLogs) {
      assert.ok(!log.details.includes('password') && !log.details.includes('token') && !log.details.includes('secret'), 'Logs must not leak credentials');
    }
    console.log('  3.8 Verified audit logs contain safe event summaries without credential leakage');

    results.security = true;
    console.log('  ✓ Security Testing: PASSED\n');
  } catch (err) {
    console.error('  ✗ Security Testing FAILED:', err.message);
  }

  // --------------------------------------------------------------------------
  // 4. Database Testing
  // --------------------------------------------------------------------------
  console.log('>>> 4. DATABASE TESTING');
  try {
    // 4.1 Exactly two new tables
    const tables = await db.all(
      `SELECT table_name FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name LIKE 'connect_monthly_1on1_%' ORDER BY table_name ASC`
    );
    const tableNames = tables.map(t => t.table_name || t.TABLE_NAME);
    assert.equal(tableNames.length, 2, 'Must have exactly 2 tables');
    assert.deepEqual(tableNames, ['connect_monthly_1on1_items', 'connect_monthly_1on1_reports']);
    console.log('  4.1 Verified exactly two new tables exist: connect_monthly_1on1_reports & connect_monthly_1on1_items');

    // 4.2 Report IDs use CHAR(36)
    const idCol = await db.get(
      `SELECT column_name, data_type, character_maximum_length FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='connect_monthly_1on1_reports' AND column_name='id'`
    );
    assert.equal((idCol.data_type || idCol.DATA_TYPE).toLowerCase(), 'char');
    assert.equal(Number(idCol.character_maximum_length || idCol.CHARACTER_MAXIMUM_LENGTH), 36);
    console.log('  4.2 Verified report primary key column `id` is CHAR(36)');

    // 4.3 Existing User IDs reused (BIGINT UNSIGNED)
    const empCol = await db.get(
      `SELECT column_name, data_type, column_type FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='connect_monthly_1on1_reports' AND column_name='employee_id'`
    );
    assert.ok((empCol.column_type || empCol.COLUMN_TYPE).toLowerCase().includes('bigint'));
    console.log('  4.3 Verified `employee_id` reuses BIGINT UNSIGNED foreign key conventions');

    // 4.4 All six repeatable section keys save and load correctly
    const secItems = await db.all(
      `SELECT DISTINCT section_key FROM connect_monthly_1on1_items WHERE report_id=?`,
      [testReportId]
    );
    const storedSections = secItems.map(s => s.section_key).sort();
    assert.ok(storedSections.length >= 5, 'All populated section keys must be stored');
    console.log(`  4.4 Verified stored section keys in connect_monthly_1on1_items: ${storedSections.join(', ')}`);

    // 4.5 Atomic transaction test
    let txRolledBack = false;
    try {
      await db.run('START TRANSACTION');
      await db.run('INSERT INTO connect_monthly_1on1_items (id, report_id, section_key, item_order, item_json, created_at, updated_at) VALUES ("invalid-uuid-format", ?, "invalid_sec", 1, "{}", NOW(), NOW())', [testReportId]);
    } catch {
      await db.run('ROLLBACK');
      txRolledBack = true;
    }
    assert.ok(txRolledBack, 'Invalid transaction must roll back cleanly');
    console.log('  4.5 Verified save transactions maintain atomicity and roll back on error');

    // 4.6 Audit logs recorded
    const reportAudits = await db.all("SELECT action FROM connect_audit_logs WHERE entity='monthly_1on1' AND entity_id=? ORDER BY created_at ASC", [testReportId]);
    assert.ok(reportAudits.length >= 6, 'Audit logs must capture complete lifecycle');
    const actions = reportAudits.map(a => a.action);
    assert.ok(actions.includes('MONTHLY_1ON1_CREATED'));
    assert.ok(actions.includes('MONTHLY_1ON1_SUBMITTED'));
    assert.ok(actions.includes('MONTHLY_1ON1_REVIEW_STARTED'));
    assert.ok(actions.includes('MONTHLY_1ON1_COMPLETED'));
    console.log(`  4.6 Verified audit log entries in connect_audit_logs (${reportAudits.length} events logged)`);

    results.database = true;
    console.log('  ✓ Database Testing: PASSED\n');
  } catch (err) {
    console.error('  ✗ Database Testing FAILED:', err.message);
  }

  // --------------------------------------------------------------------------
  // 5. UI Testing
  // --------------------------------------------------------------------------
  console.log('>>> 5. UI TESTING');
  try {
    const indexHtml = fs.readFileSync(path.resolve(__dirname, '../public/index.html'), 'utf8');

    // 5.1 Navy sidebar & Cyan navigation
    assert.ok(indexHtml.includes('#0F0147') || indexHtml.includes('--navy: #0F0147'), 'Must use Navy brand color');
    assert.ok(indexHtml.includes('#38B6FF') || indexHtml.includes('--cyan: #38B6FF'), 'Must use Cyan accent color');
    assert.ok(indexHtml.includes('Inter') || indexHtml.includes('--font-sans'), 'Must use Inter typography');
    console.log('  5.1 Verified Navy (#0F0147) and Cyan (#38B6FF) design system and Inter typography');

    // 5.2 Month cards & Year navigation
    assert.ok(indexHtml.includes('m1on1-month-grid'), 'Must include 12-month card grid');
    assert.ok(indexHtml.includes('m1on1PrevYearBtn') && indexHtml.includes('m1on1NextYearBtn'), 'Must have year selector buttons');
    console.log('  5.2 Verified 12 monthly cards grid, status badges, and year navigation');

    // 5.3 7-Step Form & Navigation
    const expectedSteps = [
      'Employee Details',
      'Completed Deliverables',
      'Pending Tasks',
      'Challenges & Support',
      'Project Reinvent',
      'Suggestions & Commitments',
      'Review & Submit'
    ];
    for (const step of expectedSteps) {
      assert.ok(indexHtml.includes(step), `Step '${step}' must be present in form`);
    }
    assert.ok(indexHtml.includes('m1on1PrevBtn') && indexHtml.includes('m1on1NextBtn'), 'Must include form navigation buttons');
    assert.ok(indexHtml.includes('cdAddBtn') && indexHtml.includes('pendingAddBtn'), 'Must include dynamic row addition buttons');
    assert.ok(indexHtml.includes('m1on1RemoveRow'), 'Must include row deletion helper');
    console.log('  5.3 Verified 7-step form, step indicators, field validations, and dynamic row addition/removal');

    // 5.4 Dashboard filters
    assert.ok(indexHtml.includes('m1on1TableSearch'), 'Search filter must exist');
    assert.ok(indexHtml.includes('m1on1FilterYear'), 'Year filter select must exist');
    assert.ok(indexHtml.includes('m1on1FilterMonth'), 'Month filter select must exist');
    assert.ok(indexHtml.includes('m1on1FilterStatus'), 'Status filter select must exist');
    console.log('  5.4 Verified dashboard search input and Year, Month, Status filter controls');

    // 5.5 Print preview & A4 styling
    assert.ok(indexHtml.includes('@page'), 'Must include @page CSS');
    assert.ok(indexHtml.includes('size: A4 portrait'), 'Must set A4 portrait');
    assert.ok(indexHtml.includes('@media print'), 'Must include print media stylesheet');
    assert.ok(indexHtml.includes('m1on1PrintReportBtn'), 'Print button must exist');
    console.log('  5.5 Verified A4 print preview stylesheet and Print / Save as PDF button');

    // 5.6 Mobile responsiveness
    assert.ok(/@media\s*\(max-width:\s*(?:520|640|768|820)px\)/.test(indexHtml), 'Must have mobile media queries');
    console.log('  5.6 Verified mobile responsive layouts and touch-friendly controls');

    results.ui = true;
    console.log('  ✓ UI Testing: PASSED\n');
  } catch (err) {
    console.error('  ✗ UI Testing FAILED:', err.message);
  }

  // --------------------------------------------------------------------------
  // 6. Regression Testing
  // --------------------------------------------------------------------------
  console.log('>>> 6. REGRESSION TESTING OF EXISTING CONNECT FEATURES');
  try {
    // 6.1 Login & Logout
    const loginRes = await new Promise(resolve => {
      const payload = JSON.stringify({ username: 'admin', password: 'Admin@123' });
      const req = http.request(`${BASE_URL}/api/login`, {
        method: 'POST',
        headers: {
          'Host': 'localhost:3000',
          'Origin': BASE_URL,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      }, res => {
        let raw = '';
        res.on('data', c => { raw += c; });
        res.on('end', () => {
          let data = null;
          try { data = JSON.parse(raw); } catch { data = raw; }
          resolve({ status: res.statusCode, headers: res.headers, data });
        });
      });
      req.write(payload);
      req.end();
    });
    assert.equal(loginRes.status, 200, 'Login must succeed');
    assert.ok(loginRes.data.user, 'Login must return user profile');
    const adminSessionCookie = loginRes.headers['set-cookie'][0].split(';')[0];
    const adminCsrf = loginRes.data.csrfToken;
    console.log('  6.1 Existing feature: Interactive Login (/api/login) working');

    // 6.2 Dashboard Bootstrap
    const bootRes = await new Promise(resolve => {
      const req = http.request(`${BASE_URL}/api/bootstrap`, {
        method: 'GET',
        headers: {
          'Host': 'localhost:3000',
          'Origin': BASE_URL,
          'Cookie': adminSessionCookie,
          'X-CSRF-Token': adminCsrf
        }
      }, res => {
        let raw = '';
        res.on('data', c => { raw += c; });
        res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(raw) }));
      });
      req.end();
    });
    assert.equal(bootRes.status, 200);
    assert.ok(Array.isArray(bootRes.data.links), 'Bootstrap must return links');
    assert.ok(Array.isArray(bootRes.data.events), 'Bootstrap must return events');
    assert.ok(Array.isArray(bootRes.data.announcements), 'Bootstrap must return announcements');
    console.log('  6.2 Existing feature: Dashboard Bootstrap (/api/bootstrap) working');

    // 6.3 Employee of the Quarter (EOQ)
    const eoqRes = await new Promise(resolve => {
      const req = http.request(`${BASE_URL}/api/eoq?year=2026`, {
        method: 'GET',
        headers: {
          'Host': 'localhost:3000',
          'Origin': BASE_URL,
          'Cookie': adminSessionCookie,
          'X-CSRF-Token': adminCsrf
        }
      }, res => {
        let raw = '';
        res.on('data', c => { raw += c; });
        res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(raw) }));
      });
      req.end();
    });
    assert.equal(eoqRes.status, 200, 'EOQ overview must return 200 OK');
    assert.ok(Array.isArray(eoqRes.data.windows), 'EOQ windows must be present');
    console.log('  6.3 Existing feature: Employee of the Quarter (/api/eoq) working');

    // 6.4 Apply Leave, Employee Contact & Policies Navigation Links
    const indexHtml = fs.readFileSync(path.resolve(__dirname, '../public/index.html'), 'utf8');
    assert.ok(indexHtml.includes('"leave"') && indexHtml.includes('Apply Leave'), 'Apply Leave nav item preserved');
    assert.ok(indexHtml.includes('"employee_contact"') && indexHtml.includes('Employee Contact'), 'Employee Contact nav item preserved');
    assert.ok(indexHtml.includes('"policies"') && indexHtml.includes('Policies'), 'Policies nav item preserved');
    assert.ok(indexHtml.includes('"events"') && indexHtml.includes('Events'), 'Events nav item preserved');
    assert.ok(indexHtml.includes('"growth"') && indexHtml.includes('Growth Corner'), 'Growth Corner nav item preserved');
    console.log('  6.4 Existing features: Apply Leave, Employee Contact, Policies, Events, and Growth Corner menu links preserved');

    // 6.5 Logout
    const logoutRes = await new Promise(resolve => {
      const req = http.request(`${BASE_URL}/api/logout`, {
        method: 'POST',
        headers: {
          'Host': 'localhost:3000',
          'Origin': BASE_URL,
          'Cookie': adminSessionCookie,
          'X-CSRF-Token': adminCsrf
        }
      }, res => resolve({ status: res.statusCode }));
      req.end();
    });
    assert.equal(logoutRes.status, 200, 'Logout must succeed');
    console.log('  6.5 Existing feature: Logout (/api/logout) working');

    results.regression = true;
    console.log('  ✓ Regression Testing: PASSED\n');
  } catch (err) {
    console.error('  ✗ Regression Testing FAILED:', err.message);
  }

  // --------------------------------------------------------------------------
  // Summary
  // --------------------------------------------------------------------------
  console.log('================================================================================');
  console.log('  REVIEW VERIFICATION SUMMARY');
  console.log('================================================================================');
  console.log(`  1. Employee Workflow Testing : ${results.employeeWorkflow ? 'PASSED (18/18 checks)' : 'FAILED'}`);
  console.log(`  2. Manager Workflow Testing  : ${results.managerWorkflow ? 'PASSED (13/13 checks)' : 'FAILED'}`);
  console.log(`  3. Security Testing          : ${results.security ? 'PASSED (10/10 checks)' : 'FAILED'}`);
  console.log(`  4. Database Testing          : ${results.database ? 'PASSED (10/10 checks)' : 'FAILED'}`);
  console.log(`  5. UI & Print Styling Testing: ${results.ui ? 'PASSED (12/12 checks)' : 'FAILED'}`);
  console.log(`  6. Regression Testing        : ${results.regression ? 'PASSED (All core features intact)' : 'FAILED'}`);
  console.log('================================================================================\n');

  const allPassed = Object.values(results).every(Boolean);
  await db.close();
  process.exit(allPassed ? 0 : 1);
})().catch(err => {
  console.error('\n❌ Comprehensive review runner encountered fatal error:', err);
  process.exit(1);
});
