'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const BASE_URL = 'http://127.0.0.1:3000';
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
    async request(method, urlPath, body = null) {
      return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const headers = {
          'Host': '127.0.0.1:3000',
          'Origin': BASE_URL,
          'Cookie': this.cookie,
          'X-CSRF-Token': this.csrf,
          'Connection': 'close'
        };
        if (payload) {
          headers['Content-Type'] = 'application/json';
          headers['Content-Length'] = Buffer.byteLength(payload);
        }

        const req = http.request(`${BASE_URL}${urlPath}`, { method, headers }, res => {
          let raw = '';
          res.on('data', chunk => { raw += chunk; });
          res.on('end', () => {
            let data = null;
            try { data = JSON.parse(raw); } catch { data = raw; }
            resolve({ status: res.statusCode, headers: res.headers, body: data });
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
  console.log('=== STARTING COMPLETE MONTHLY 1:1 FORM E2E TEST ===\n');

  // --- PART 1: HTML TEMPLATE & STRUCTURE VALIDATION ---
  console.log('1. Verifying public/index.html 7-step structure and exact wording...');
  const indexHtml = fs.readFileSync(path.resolve(__dirname, '../public/index.html'), 'utf8');

  // 7-step definitions
  const steps = [
    'Employee Details',
    'Completed Deliverables',
    'Pending Tasks',
    'Challenges & Support',
    'Project Reinvent',
    'Suggestions & Commitments',
    'Review & Submit'
  ];
  for (const step of steps) {
    assert.ok(indexHtml.includes(step), `Step "${step}" must be present in index.html`);
  }

  // Step 1: Employee Details
  assert.ok(indexHtml.includes('MONTHLY 1:1 UPDATE TEMPLATE'), 'Header MONTHLY 1:1 UPDATE TEMPLATE must exist');
  assert.ok(indexHtml.includes('Project Reinvent — Responsibility, Deliverables &amp; Readiness Review') ||
            indexHtml.includes('Project Reinvent — Responsibility, Deliverables & Readiness Review'), 'Subtitle must exist');
  assert.ok(indexHtml.includes('Prepare clear, specific updates for the monthly 1:1 meeting. Cover completed work, pending items, challenges, support required, and your readiness for Project Reinvent responsibilities.'), 'Exact purpose text must exist');
  assert.ok(indexHtml.includes('Employee Name'), 'Employee Name field label must exist');
  assert.ok(indexHtml.includes('Department / Role'), 'Department / Role field label must exist');
  assert.ok(indexHtml.includes('Reporting Month'), 'Reporting Month field label must exist');
  assert.ok(indexHtml.includes('Manager / Reviewer'), 'Manager / Reviewer field label must exist');
  assert.ok(indexHtml.includes('Meeting Date'), 'Meeting Date field label must exist');
  assert.ok(indexHtml.includes('Work Location'), 'Work Location field label must exist');
  assert.ok(indexHtml.includes('Current Projects Handled'), 'Current Projects Handled field label must exist');
  assert.ok(indexHtml.includes('Overall Status *'), 'Overall Status field label must exist');
  assert.ok(indexHtml.includes('On Track') && indexHtml.includes('Needs Attention') && indexHtml.includes('Delayed') && indexHtml.includes('At Risk'), 'Overall Status options must exist');

  // Step 2: Completed Deliverables
  assert.ok(indexHtml.includes('1. KEY DELIVERABLES COMPLETED LAST MONTH'), 'Section 1 heading must exist');
  assert.ok(indexHtml.includes('Deliverable / Task'), 'Deliverable / Task column must exist');
  assert.ok(indexHtml.includes('Target Given'), 'Target Given column must exist');
  assert.ok(indexHtml.includes('Actual Completion'), 'Actual Completion column must exist');
  assert.ok(indexHtml.includes('Impact / Result'), 'Impact / Result column must exist');
  assert.ok(indexHtml.includes('Proof / Attachment') || indexHtml.includes('Proof / Link'), 'Proof / Attachment column must exist');
  assert.ok(indexHtml.includes('cdAddBtn'), 'Add Deliverable button must exist');

  // Step 3: Pending Tasks
  assert.ok(indexHtml.includes('2. PENDING TASKS / DELAYED ITEMS'), 'Section 2 heading must exist');
  assert.ok(indexHtml.includes('Reason for Delay'), 'Reason for Delay column must exist');
  assert.ok(indexHtml.includes('Current Status'), 'Current Status column must exist');
  assert.ok(indexHtml.includes('Support Needed'), 'Support Needed column must exist');
  assert.ok(indexHtml.includes('Expected Completion'), 'Expected Completion column must exist');
  assert.ok(indexHtml.includes('noPendingChk'), 'No pending tasks checkbox must exist');
  assert.ok(indexHtml.includes('pendingAddBtn'), 'Add Pending Task button must exist');

  // Step 4: Challenges & Support
  assert.ok(indexHtml.includes('3. CHALLENGES &amp; SUPPORT REQUIRED') || indexHtml.includes('3. CHALLENGES & SUPPORT REQUIRED'), 'Section 3 heading must exist');
  assert.ok(indexHtml.includes('Major Challenges Faced'), 'Major Challenges column must exist');
  assert.ok(indexHtml.includes('Support Required from Management / Team'), 'Support Required column must exist');
  assert.ok(indexHtml.includes('noChallengeChk'), 'No major challenges checkbox must exist');
  assert.ok(indexHtml.includes('challengeAddBtn'), 'Add Challenge button must exist');

  // Step 5: Project Reinvent
  assert.ok(indexHtml.includes('4. PROJECT REINVENT — RESPONSIBILITY &amp; READINESS') || indexHtml.includes('4. PROJECT REINVENT — RESPONSIBILITY & READINESS'), 'Section 4 heading must exist');
  assert.ok(indexHtml.includes('Current Responsibilities'), 'Current Responsibilities column must exist');
  assert.ok(indexHtml.includes('Responsibilities You Can Take Next'), 'Next responsibilities column must exist');
  assert.ok(indexHtml.includes('Areas Where You Need Clarity'), 'Clarity required column must exist');
  assert.ok(indexHtml.includes('Capacity for Additional Responsibilities *'), 'Capacity label must exist');
  assert.ok(indexHtml.includes('If yes or partially, mention the responsibility areas you can handle: *'), 'Conditional capacity question must exist');

  // Step 6: Suggestions & Commitment
  assert.ok(indexHtml.includes('5. SUGGESTIONS &amp; COMMITMENT FOR THIS MONTH') || indexHtml.includes('5. SUGGESTIONS & COMMITMENT FOR THIS MONTH'), 'Section 5 heading must exist');
  assert.ok(indexHtml.includes('A. Suggestions for Improvement'), 'Subheading A must exist');
  assert.ok(indexHtml.includes('B. Top 3 Priorities for This Month'), 'Subheading B must exist');
  assert.ok(indexHtml.includes('m1_priority_${n}') && indexHtml.includes('[1, 2, 3].map(n =>'), 'Exactly 3 priority slots must be mapped');

  // Step 7: Review & Submit
  assert.ok(indexHtml.includes('7. REVIEW &amp; SUBMIT'), 'Step 7 heading must exist');
  assert.ok(indexHtml.includes('m1on1BackEditBtn'), 'Back to Edit button must exist');
  assert.ok(indexHtml.includes('m1on1ReviewDraftBtn'), 'Save Draft button must exist on review step');
  assert.ok(indexHtml.includes('m1on1SubmitBtn'), 'Submit Report button must exist');
  assert.ok(indexHtml.includes('I confirm that the information submitted in this monthly report is accurate to the best of my knowledge.'), 'Acknowledgement text must be exact');

  // --- PART 2: CLIENT INITIALIZATION ---
  console.log('2. Initializing authenticated clients...');
  const employee = createClient(13); // Hariharan (member, user 13)
  const reviewer = createClient(5);  // Admin (admin, user 5)

  // Verify session
  const sessRes = await employee.request('GET', '/api/bootstrap');
  assert.equal(sessRes.status, 200, 'Employee bootstrap check must return 200');
  assert.equal(sessRes.body.user.id, 13);
  console.log(`   Authenticated as ${sessRes.body.user.name} (${sessRes.body.user.role})`);

  // --- PART 3: CREATING A REPORT FOR UNIQUE MONTH ---
  const { MySQLDatabase, databaseConfig } = require('../lib/database');
  const db = new MySQLDatabase(databaseConfig());
  await db.ready;
  const testMonth = '2026-06';
  await db.run('DELETE FROM connect_monthly_1on1_items WHERE report_id IN (SELECT id FROM connect_monthly_1on1_reports WHERE reporting_month="2026-06-01" AND employee_id=13)');
  await db.run('DELETE FROM connect_monthly_1on1_reports WHERE reporting_month="2026-06-01" AND employee_id=13');

  await reviewer.request('POST', '/api/monthly-1on1/windows', {
    reporting_month: testMonth,
    start_date: '2026-06-01',
    start_time: '00:00',
    end_date: '2026-12-31',
    end_time: '23:59'
  });

  console.log(`3. Setting up monthly report for ${testMonth}...`);
  let reportId;
  const createRes = await employee.request('POST', '/api/monthly-1on1/reports', {
    reporting_month: testMonth
  });
  assert.equal(createRes.status, 201, 'Should create new report for 2026-06');
  reportId = createRes.body.report.id;
  console.log('   Created new report:', reportId);

  // --- PART 4: ENTERING ALL SOURCE FIELDS & MULTIPLE DELIVERABLES ---
  console.log('4. Entering all source fields with multiple deliverables and saving draft...');
  const deliverables = [
    {
      task: 'Migrate User Authentication to Session DB',
      target_given: 'Complete before Nov 10',
      actual_completion: 'Completed on Nov 8 with 100% test coverage',
      impact_result: 'Eliminated session desync issues across instances',
      proof_link: 'https://github.com/mypreneur/connect/commit/auth-session-db'
    },
    {
      task: 'Build Monthly 1:1 Update Template UI',
      target_given: 'Deliver responsive 7-step wizard',
      actual_completion: 'Implemented full 7-step wizard matching Word template',
      impact_result: 'Enabled structured monthly 1:1 reviews organization-wide',
      proof_link: 'https://github.com/mypreneur/connect/pull/42'
    },
    {
      task: 'Optimize MySQL schema indices for reporting tables',
      target_given: 'Reduce query latency below 50ms',
      actual_completion: 'Added compound indexes on employee_id and reporting_month',
      impact_result: 'Average query response dropped from 120ms to 18ms',
      proof_link: 'https://github.com/mypreneur/connect/commit/idx-opt'
    }
  ];

  const pendingTasks = [
    {
      task: 'Mobile App Notification Push Service',
      reason_for_delay: 'Waiting for APNS certificate renewal from Apple Dev account',
      current_status: 'Implementation ready, blocked on cert upload',
      support_needed: 'DevOps lead assistance for Apple Developer account access',
      expected_completion_date: '2026-11-25'
    }
  ];

  const challenges = [
    {
      major_challenge: 'Intermittent third-party webhook delays during peak loads',
      support_required: 'Infra team assistance to set up an asynchronous Redis queue'
    }
  ];

  const responsibilities = [
    {
      current_responsibilities: 'Core backend API development and database architecture',
      next_responsibilities: 'Lead architecture review for Project Reinvent microservices',
      clarity_required: 'Project Reinvent timeline expectations for Q1 2027'
    }
  ];

  const suggestions = [
    { suggestion: 'Introduce weekly 15-minute cross-team syncs to identify blockers early' },
    { suggestion: 'Automate Docker builds in staging CI pipeline' }
  ];

  const priorities = [
    { priority_number: 1, description: 'Finalize Project Reinvent Monthly 1:1 production deployment' },
    { priority_number: 2, description: 'Conduct knowledge sharing session for team leads' },
    { priority_number: 3, description: 'Address technical debt in session cache invalidation' }
  ];

  // Save full draft
  const draftRes1 = await employee.request('PATCH', `/api/monthly-1on1/reports/${reportId}`, {
    meeting_date: '2026-11-15',
    work_location: 'Coimbatore HQ & Remote',
    current_projects: 'Mypreneur Connect & Project Reinvent',
    overall_status: 'On Track',
    capacity_for_additional_responsibilities: 'Yes',
    additional_responsibility_details: 'Ready to take on tech lead responsibilities for new integrations',
    items: {
      completed_deliverables: deliverables,
      pending_tasks: pendingTasks,
      challenges_support: challenges,
      responsibility_readiness: responsibilities,
      improvement_suggestions: suggestions,
      monthly_priorities: priorities
    }
  });
  assert.equal(draftRes1.status, 200, 'Saving full draft must succeed');
  assert.equal(draftRes1.body.report.status, 'Draft');
  assert.equal(draftRes1.body.report.items.completed_deliverables.length, 3, 'Must have 3 deliverables');
  assert.equal(draftRes1.body.report.items.pending_tasks.length, 1, 'Must have 1 pending task');
  assert.equal(draftRes1.body.report.items.monthly_priorities.length, 3, 'Must have exactly 3 priorities');

  // --- PART 5: DELETING ROWS ---
  console.log('5. Deleting a row (removing deliverable #2) and saving draft...');
  const trimmedDeliverables = [deliverables[0], deliverables[2]]; // remove deliverable 1
  const draftRes2 = await employee.request('PATCH', `/api/monthly-1on1/reports/${reportId}`, {
    items: {
      completed_deliverables: trimmedDeliverables
    }
  });
  assert.equal(draftRes2.status, 200, 'Draft update after row deletion must succeed');
  assert.equal(draftRes2.body.report.items.completed_deliverables.length, 2, 'Should now have 2 deliverables');
  assert.equal(draftRes2.body.report.items.completed_deliverables[0].data.task, deliverables[0].task);
  assert.equal(draftRes2.body.report.items.completed_deliverables[1].data.task, deliverables[2].task);

  // --- PART 6: RELOADING DRAFTS & RESUMING DATA ENTRY ---
  console.log('6. Reloading draft from server and verifying data persistence...');
  const reloadRes = await employee.request('GET', `/api/monthly-1on1/reports/${reportId}`);
  assert.equal(reloadRes.status, 200, 'Reloading draft must return 200 OK');
  const loadedReport = reloadRes.body.report;
  assert.equal(loadedReport.meeting_date, '2026-11-15');
  assert.equal(loadedReport.work_location, 'Coimbatore HQ & Remote');
  assert.equal(loadedReport.current_projects, 'Mypreneur Connect & Project Reinvent');
  assert.equal(loadedReport.overall_status, 'On Track');
  assert.equal(loadedReport.capacity_for_additional_responsibilities, 'Yes');
  assert.equal(loadedReport.additional_responsibility_details, 'Ready to take on tech lead responsibilities for new integrations');
  assert.equal(loadedReport.items.completed_deliverables.length, 2);
  assert.equal(loadedReport.items.monthly_priorities.length, 3);

  // Restore deliverable #2 for complete submission
  await employee.request('PATCH', `/api/monthly-1on1/reports/${reportId}`, {
    items: { completed_deliverables: deliverables }
  });

  // --- PART 7: VALIDATION ERRORS ---
  console.log('7. Testing validation error cases on submission...');

  // 7a. Submission without acknowledgement
  const noAckRes = await employee.request('POST', `/api/monthly-1on1/reports/${reportId}/submit`, {
    acknowledged: false
  });
  assert.equal(noAckRes.status, 400, 'Must reject submission without acknowledgement');
  assert.ok(noAckRes.body.error.includes('acknowledgement'), 'Error must mention acknowledgement');

  // 7b. Submission without overall status
  await employee.request('PATCH', `/api/monthly-1on1/reports/${reportId}`, { overall_status: null });
  const noStatusRes = await employee.request('POST', `/api/monthly-1on1/reports/${reportId}/submit`, {
    acknowledged: true
  });
  assert.equal(noStatusRes.status, 400, 'Must reject submission without overall status');
  assert.ok(noStatusRes.body.error.includes('Overall Status'), 'Error must mention Overall Status');

  // Restore overall status
  await employee.request('PATCH', `/api/monthly-1on1/reports/${reportId}`, { overall_status: 'On Track' });

  // 7c. Submission with capacity Yes but missing explanation
  await employee.request('PATCH', `/api/monthly-1on1/reports/${reportId}`, {
    capacity_for_additional_responsibilities: 'Yes',
    additional_responsibility_details: ''
  });
  const noDetailsRes = await employee.request('POST', `/api/monthly-1on1/reports/${reportId}/submit`, {
    acknowledged: true
  });
  assert.equal(noDetailsRes.status, 400, 'Must reject submission when capacity is Yes and explanation is missing');
  assert.ok(noDetailsRes.body.error.includes('responsibility areas') || noDetailsRes.body.error.includes('responsibilities'), 'Error must mention responsibility details');

  // Restore valid explanation
  await employee.request('PATCH', `/api/monthly-1on1/reports/${reportId}`, {
    capacity_for_additional_responsibilities: 'Yes',
    additional_responsibility_details: 'Ready to take on tech lead responsibilities for new integrations'
  });

  // --- PART 8: SUBMITTING A COMPLETE REPORT ---
  console.log('8. Submitting complete report with employee acknowledgement...');
  const submitRes = await employee.request('POST', `/api/monthly-1on1/reports/${reportId}/submit`, {
    acknowledged: true
  });
  assert.equal(submitRes.status, 200, 'Submission must succeed');
  assert.equal(submitRes.body.report.status, 'Submitted');
  assert.ok(submitRes.body.report.submitted_at, 'Server submitted_at must be recorded');
  assert.ok(submitRes.body.report.employee_acknowledged_at, 'Server employee_acknowledged_at must be recorded');

  // --- PART 9: PREVENTING DUPLICATE MONTH CREATION ---
  console.log('9. Verifying duplicate report creation for same month is blocked...');
  const dupCreate = await employee.request('POST', '/api/monthly-1on1/reports', {
    reporting_month: testMonth
  });
  assert.equal(dupCreate.status, 400, 'Duplicate report creation for same month must be rejected');
  assert.ok(dupCreate.body.error.toLowerCase().includes('already exists') || dupCreate.body.error.toLowerCase().includes('duplicate'));

  // --- PART 10: EDITING & RESUBMISSION WHILE WINDOW IS OPEN (RULE B5) ---
  console.log('10. Verifying edits and resubmission are permitted while window is open (Rule B5)...');
  const editWhileSubmitted = await employee.request('PATCH', `/api/monthly-1on1/reports/${reportId}`, {
    work_location: 'Updated Location while window is open'
  });
  assert.equal(editWhileSubmitted.status, 200, 'Edits must succeed while window is open under Rule B5');
  assert.equal(editWhileSubmitted.body.report.work_location, 'Updated Location while window is open');

  const resubmitWhileOpen = await employee.request('POST', `/api/monthly-1on1/reports/${reportId}/submit`, {
    acknowledged: true
  });
  assert.equal(resubmitWhileOpen.status, 200, 'Resubmission must succeed while window is open under Rule B5');
  assert.equal(resubmitWhileOpen.body.report.status, 'Submitted');

  // --- PART 11: REVIEWER REQUESTS REVISION ---
  console.log('11. Reviewer requests revision; testing employee edit capability...');
  // Reviewer starts review
  const startRev = await reviewer.request('POST', `/api/monthly-1on1/reports/${reportId}/start-review`);
  assert.equal(startRev.status, 200, 'Start review must succeed');
  assert.equal(startRev.body.report.status, 'Under Review');

  // Reviewer requests revision
  const reqRev = await reviewer.request('POST', `/api/monthly-1on1/reports/${reportId}/request-revision`, {
    reason: 'Please add more detail on the Redis queue architecture for challenges.'
  });
  assert.equal(reqRev.status, 200, 'Revision request must succeed');
  assert.equal(reqRev.body.report.status, 'Revision Requested');
  assert.equal(reqRev.body.report.revision_reason, 'Please add more detail on the Redis queue architecture for challenges.');

  // Employee can edit the report after revision request
  const editAfterRevision = await employee.request('PATCH', `/api/monthly-1on1/reports/${reportId}`, {
    items: {
      challenges_support: [
        {
          major_challenge: 'Intermittent third-party webhook delays during peak loads',
          support_required: 'Infra team assistance to set up an asynchronous Redis queue with BullMQ and worker clustering.'
        }
      ]
    }
  });
  assert.equal(editAfterRevision.status, 200, 'Editing must succeed when status is Revision Requested');
  assert.ok(editAfterRevision.body.report.items.challenges_support[0].data.support_required.includes('BullMQ'));

  // --- PART 12: RESUBMITTING AND APPROVING REPORT (LOCKED ONCE APPROVED) ---
  console.log('12. Resubmitting changes and approving report...');
  const resubmitRes = await employee.request('POST', `/api/monthly-1on1/reports/${reportId}/submit`, {
    acknowledged: true
  });
  assert.equal(resubmitRes.status, 200, 'Resubmission must succeed');
  assert.equal(resubmitRes.body.report.status, 'Submitted');

  // Reviewer approves the report
  const approveRes = await reviewer.request('POST', `/api/monthly-1on1/reports/${reportId}/approve`, {
    decision_notes: 'Approved with excellence.'
  });
  assert.equal(approveRes.status, 200, 'Approval must succeed');
  assert.equal(approveRes.body.report.status, 'Approved');

  // Edits blocked after approval
  const editBlockedAfterApproval = await employee.request('PATCH', `/api/monthly-1on1/reports/${reportId}`, {
    work_location: 'Trying to change while approved'
  });
  assert.equal(editBlockedAfterApproval.status, 400, 'Edits must be blocked when report is Approved');
  assert.ok(editBlockedAfterApproval.body.error.toLowerCase().includes('approved') || editBlockedAfterApproval.body.error.toLowerCase().includes('closed'));

  // Submissions blocked after approval
  const submitBlockedAfterApproval = await employee.request('POST', `/api/monthly-1on1/reports/${reportId}/submit`, {
    acknowledged: true
  });
  assert.equal(submitBlockedAfterApproval.status, 400, 'Submissions must be blocked when report is Approved');

  console.log('13. Verifying audit trail and final approved report status...');
  assert.equal(approveRes.body.report.status, 'Approved');
  assert.ok(approveRes.body.report.approved_at, 'Server approved_at must be recorded');
  assert.equal(approveRes.body.report.approved_by_id, 5, 'Approved by ID must be reviewer');

  console.log('\n=== ALL 12 COMPLETION CHECKS PASSED SUCCESSFULLY! ===\n');
  await db.close();
  process.exit(0);
})();
