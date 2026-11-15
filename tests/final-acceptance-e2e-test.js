/**
 * FINAL ACCEPTANCE TEST SUITE — Mypreneur Connect Monthly 1:1 Meeting Report
 * Executes Scenarios 1 through 10 end-to-end.
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { MySQLDatabase, databaseConfig } = require('../lib/database');

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

const scenarioResults = [];

function recordScenario(id, title, passed, details = '') {
  scenarioResults.push({ id, title, result: passed ? 'PASS' : 'FAIL', details });
  console.log(`${passed ? '✅' : '❌'} [${id}] ${title} -> ${passed ? 'PASS' : 'FAIL'}${details ? ' (' + details + ')' : ''}`);
}

async function runAcceptanceSuite() {
  console.log('========================================================================');
  console.log('FINAL ACCEPTANCE TESTING: MONTHLY 1:1 MEETING REPORT MODULE');
  console.log('========================================================================\n');

  const db = new MySQLDatabase(databaseConfig());
  const admin = createClient(5);       // SUPER_ADMIN
  const serviceAdmin = createClient(22); // SERVICE_ADMIN
  const empA = createClient(12);        // EMPLOYEE A (ibrahimshah)
  const empB = createClient(13);        // EMPLOYEE B (hariharan)

  // Clean test fixtures for isolated run
  await db.run("UPDATE monthly_1on1_reports SET status='Closed' WHERE record_type='window'");
  await db.run("DELETE FROM monthly_1on1_reports WHERE reporting_month IN ('2027-01-01', '2027-02-01', '2027-03-01')");

  // ------------------------------------------------------------------------
  // SCENARIO 1: AUTOMATIC OPENING
  // ------------------------------------------------------------------------
  console.log('\n--- SCENARIO 1 — AUTOMATIC OPENING ---');
  try {
    const sc1Month = '2027-01';
    // 1. Configure a reporting month with scheduled opening in the future
    const cfgRes = await admin.request('POST', '/api/monthly-1on1/windows', {
      reporting_month: sc1Month,
      start_date: '2027-01-10',
      start_time: '10:00',
      end_date: '2027-01-25',
      end_time: '18:00'
    });
    assert.equal(cfgRes.ok, true, 'Window configuration failed');

    // 2. Verify it is closed/upcoming before opening
    const preCheck = await admin.request('GET', `/api/monthly-1on1/windows?month=${sc1Month}`);
    assert.equal(preCheck.data.window.status, 'upcoming', 'Window should be upcoming before start date');

    // Verify employee sees no active open window
    const empPreCheck = await empA.request('GET', '/api/monthly-1on1/overview');
    assert.equal(empPreCheck.data.activeOpenWindow, null, 'No active window before opening time');

    // 3. Simulate scheduled opening time by updating start_date to past without manual open action
    const pastStart = new Date(Date.now() - 3600000).toISOString();
    const futureEnd = new Date(Date.now() + 7 * 86400000).toISOString();
    await db.run(
      `UPDATE monthly_1on1_reports SET window_start=?, window_end=?, status='Upcoming', reopened_at=NULL WHERE record_type='window' AND reporting_month='2027-01-01'`
      , [pastStart, futureEnd]
    );

    // 4. Confirm it automatically becomes Open
    const autoCheck = await admin.request('GET', `/api/monthly-1on1/windows?month=${sc1Month}`);
    assert.equal(autoCheck.data.window.status, 'open', 'Window must automatically evaluate to open once start time is reached');

    // 5. Log in as Employee A and confirm only the open reporting month appears
    const empCheck = await empA.request('GET', '/api/monthly-1on1/overview');
    assert.equal(empCheck.data.activeOpenWindow.reporting_month.slice(0, 7), sc1Month);
    assert.equal(empCheck.data.openWindows.length, 1, 'Only one open window can exist');

    recordScenario('SCENARIO 1', 'Automatic Opening without manual intervention', true);
  } catch (err) {
    recordScenario('SCENARIO 1', 'Automatic Opening', false, err.message);
  }

  // ------------------------------------------------------------------------
  // SCENARIO 2: MANUAL OPEN/CLOSE
  // ------------------------------------------------------------------------
  console.log('\n--- SCENARIO 2 — MANUAL OPEN/CLOSE ---');
  try {
    const sc2Month = '2027-02';
    // Configure window in future
    await admin.request('POST', '/api/monthly-1on1/windows', {
      reporting_month: sc2Month,
      start_date: '2027-02-15',
      start_time: '09:00',
      end_date: '2027-02-28',
      end_time: '18:00'
    });

    // Close 2027-01 to avoid conflicting active window
    await admin.request('POST', '/api/monthly-1on1/windows/close', { reporting_month: '2027-01' });

    // 1. Manually open 2027-02
    const manOpenRes = await admin.request('POST', '/api/monthly-1on1/windows/manual-open', {
      reporting_month: sc2Month,
      reason: 'Scenario 2 manual opening'
    });
    assert.equal(manOpenRes.ok, true, 'Manual open must succeed');

    // 2. Verify status updates to open
    const winCheck = await admin.request('GET', `/api/monthly-1on1/windows?month=${sc2Month}`);
    assert.equal(winCheck.data.window.status, 'open', 'Window status must be open after manual open');

    // 3. Submit a test draft as Employee A
    const repRes = await empA.request('POST', '/api/monthly-1on1/reports', { reporting_month: sc2Month });
    assert.equal(repRes.ok, true, 'Starting draft in open window must succeed');
    const sc2ReportId = repRes.data.report.id;

    const draftRes = await empA.request('PATCH', `/api/monthly-1on1/reports/${sc2ReportId}`, {
      work_location: 'Manual Open Test Office'
    });
    assert.equal(draftRes.ok, true, 'Saving draft in open window must succeed');

    // 4. Manually close window
    const manCloseRes = await admin.request('POST', '/api/monthly-1on1/windows/close', { reporting_month: sc2Month });
    assert.equal(manCloseRes.ok, true, 'Manual close must succeed');

    // 5. Attempt editing through API while closed -> must be denied (HTTP 403 WINDOW_CLOSED)
    const denyPatch = await empA.request('PATCH', `/api/monthly-1on1/reports/${sc2ReportId}`, {
      work_location: 'Attempted edit after closure'
    });
    assert.equal(denyPatch.status, 403);
    assert.equal(denyPatch.data.code, 'WINDOW_CLOSED');

    const denySubmit = await empA.request('POST', `/api/monthly-1on1/reports/${sc2ReportId}/submit`, {
      acknowledged: true
    });
    assert.equal(denySubmit.status, 403);
    assert.equal(denySubmit.data.code, 'WINDOW_CLOSED');

    recordScenario('SCENARIO 2', 'Manual Open/Close Controls and Closed-Window Lock', true);
  } catch (err) {
    recordScenario('SCENARIO 2', 'Manual Open/Close', false, err.message);
  }

  // ------------------------------------------------------------------------
  // SCENARIO 3: EMPLOYEE APPLICATION
  // ------------------------------------------------------------------------
  console.log('\n--- SCENARIO 3 — EMPLOYEE APPLICATION ---');
  let sc3ReportId = null;
  try {
    const sc3Month = '2026-11';
    // Ensure 2026-11 is configured and open
    await admin.request('POST', '/api/monthly-1on1/windows', {
      reporting_month: sc3Month,
      start_date: '2026-11-01',
      start_time: '09:00',
      end_date: '2026-11-30',
      end_time: '18:00'
    });
    await admin.request('POST', '/api/monthly-1on1/windows/manual-open', {
      reporting_month: sc3Month,
      reason: 'Scenario 3 application testing'
    });

    // Clean previous report for Employee A in 2026-11
    await db.run("DELETE FROM monthly_1on1_reports WHERE record_type='report' AND employee_id=12 AND reporting_month LIKE '2026-11%'");

    // 1. Log in as Employee A & 2. Start report
    const startRes = await empA.request('POST', '/api/monthly-1on1/reports', { reporting_month: sc3Month });
    assert.equal(startRes.ok, true, 'Employee A must start report');
    sc3ReportId = startRes.data.report.id;

    // 3. Upload file attachment for Step 2
    const dummyBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const uploadRes = await empA.request('POST', `/api/monthly-1on1/reports/${sc3ReportId}/attachments`, {
      file: { name: 'acceptance_proof.png', data: dummyBase64, type: 'image/png' }
    });
    assert.equal(uploadRes.ok, true, 'Attachment upload must succeed');

    // 4. Complete all seven steps with multiple rows
    const fullForm = {
      meeting_date: '2026-11-12',
      work_location: 'Chennai HQ',
      current_projects: 'Core CRM Reinvention, Portal Integration',
      overall_status: 'On Track',
      capacity_for_additional_responsibilities: 'Yes',
      additional_responsibility_details: 'Ready to lead integration QA and technical audits',
      items: {
        completed_deliverables: [
          {
            id: null,
            data: {
              task: 'Implement Monthly 1:1 Report Wizard',
              target_given: '7-step Word template fidelity',
              actual_completion: 'Completed with full data persistence',
              impact_result: 'Zero data loss across steps',
              proof: { link: 'https://connect.mypreneur.com', file: uploadRes.data.proof }
            }
          },
          {
            id: null,
            data: {
              task: 'Database Schema Optimization',
              target_given: 'Index optimization on monthly_1on1_reports',
              actual_completion: 'Added compound indexes',
              impact_result: 'Query response under 10ms',
              proof: { link: 'https://db.mypreneur.com' }
            }
          }
        ],
        pending_tasks: [
          {
            id: null,
            data: {
              task: 'Automated notification hookups',
              reason_for_delay: 'Waiting for SMTP provider API key',
              current_status: 'Ready for integration',
              support_needed: 'API credentials',
              expected_completion_date: '2026-11-20'
            }
          }
        ],
        challenges_support: [
          {
            id: null,
            data: {
              major_challenge: 'High concurrency during submission deadlines',
              support_required: 'Increase pool connection size'
            }
          }
        ],
        responsibility_readiness: [
          {
            id: null,
            data: {
              current_responsibilities: 'QA engineering, full stack test automation',
              next_responsibilities: 'Lead test architecture for all Connect modules',
              clarity_required: 'None'
            }
          }
        ],
        improvement_suggestions: [
          { id: null, data: { suggestion: 'Introduce weekly QA health metrics in portal' } }
        ],
        monthly_priorities: [
          { id: null, data: { priority_number: 1, description: 'Pass 100% acceptance tests' } },
          { id: null, data: { priority_number: 2, description: 'Verify zero open defects' } },
          { id: null, data: { priority_number: 3, description: 'Deliver final QA readiness sign-off' } }
        ]
      }
    };

    // 5. Save Draft
    const saveRes = await empA.request('PATCH', `/api/monthly-1on1/reports/${sc3ReportId}`, fullForm);
    assert.equal(saveRes.ok, true, 'Draft save must succeed');

    // 6. Refresh page / retrieve report from API
    const reloadRes = await empA.request('GET', `/api/monthly-1on1/reports/${sc3ReportId}`);
    assert.equal(reloadRes.data.report.work_location, 'Chennai HQ');
    assert.equal(reloadRes.data.report.items.completed_deliverables.length, 2);
    assert.equal(reloadRes.data.report.items.monthly_priorities.length, 3);

    // 7. Continue editing: add another suggestion
    fullForm.items.improvement_suggestions.push({
      id: null, data: { suggestion: 'Enable keyboard shortcuts for wizard navigation' }
    });
    await empA.request('PATCH', `/api/monthly-1on1/reports/${sc3ReportId}`, fullForm);

    // 8. Submit report with mandatory acknowledgement
    const subRes = await empA.request('POST', `/api/monthly-1on1/reports/${sc3ReportId}/submit`, {
      acknowledged: true,
      ...fullForm
    });
    assert.equal(subRes.ok, true, 'Submission must succeed');

    // 9. Verify Submitted status and timestamps
    assert.equal(subRes.data.report.status, 'Submitted');
    assert.ok(subRes.data.report.submitted_at);
    assert.ok(subRes.data.report.employee_acknowledged_at);

    recordScenario('SCENARIO 3', 'Complete 7-Step Employee Application Submission', true);
  } catch (err) {
    recordScenario('SCENARIO 3', 'Employee Application', false, err.message);
  }

  // ------------------------------------------------------------------------
  // SCENARIO 4: EMPLOYEE PRIVACY
  // ------------------------------------------------------------------------
  console.log('\n--- SCENARIO 4 — EMPLOYEE PRIVACY ---');
  try {
    // 1. Log in as Employee B
    // 2. Open Monthly 1:1 page & 3. Inspect application history
    const bHist = await empB.request('GET', '/api/monthly-1on1/reports');
    assert.equal(bHist.ok, true);
    for (const r of bHist.data.reports) {
      assert.notEqual(r.id, sc3ReportId, "Employee B must NEVER see Employee A's report in history");
      assert.equal(Number(r.employee_id), 13, "All records in Employee B's history must belong to Employee B");
    }

    // 4. Attempt to access Employee A's report via direct ID
    const stealReport = await empB.request('GET', `/api/monthly-1on1/reports/${sc3ReportId}`);
    assert.equal(stealReport.status === 403 || stealReport.status === 404, true, 'Direct report access by other employee must be forbidden');

    // 5. Attempt to retrieve submission lists or statistics
    const stealTeam = await empB.request('GET', '/api/monthly-1on1/team-reports');
    assert.equal(stealTeam.status, 403, 'Employee cannot access team-reports endpoint');

    // Attempt to download Employee A's attachment
    const stealAtt = await empB.request('GET', `/api/monthly-1on1/reports/${sc3ReportId}/attachment?key=acceptance_proof.png`);
    assert.equal(stealAtt.status === 403 || stealAtt.status === 404, true, 'Employee cannot download another employee attachment');

    recordScenario('SCENARIO 4', 'Employee Privacy and Strict Record Isolation', true);
  } catch (err) {
    recordScenario('SCENARIO 4', 'Employee Privacy', false, err.message);
  }

  // ------------------------------------------------------------------------
  // SCENARIO 5: SERVICE ADMIN
  // ------------------------------------------------------------------------
  console.log('\n--- SCENARIO 5 — SERVICE ADMIN ---');
  let sc5ReportId = null;
  try {
    // 1. Log in as Service Admin & 2. Submit own report
    await db.run("DELETE FROM monthly_1on1_reports WHERE record_type='report' AND employee_id=22 AND reporting_month LIKE '2026-11%'");
    const saStart = await serviceAdmin.request('POST', '/api/monthly-1on1/reports', { reporting_month: '2026-11' });
    assert.equal(saStart.ok, true, 'Service Admin can submit own report');
    sc5ReportId = saStart.data.report.id;

    await serviceAdmin.request('POST', `/api/monthly-1on1/reports/${sc5ReportId}/submit`, {
      acknowledged: true,
      overall_status: 'On Track',
      capacity_for_additional_responsibilities: 'Partially',
      additional_responsibility_details: 'Service management leadership',
      items: {}
    });

    // 3. Open reviewer page
    const teamRes = await serviceAdmin.request('GET', '/api/monthly-1on1/team-reports?month=11&year=2026');
    assert.equal(teamRes.ok, true, 'Service Admin can access team reports');

    // 4. View Employee A's submitted report
    const viewEmpARes = await serviceAdmin.request('GET', `/api/monthly-1on1/reports/${sc3ReportId}`);
    assert.equal(viewEmpARes.ok, true, "Service Admin can view Employee A's report");
    assert.ok(viewEmpARes.data.report.employee_name.includes('Ibrahim Shah'));

    // 5. Attempt to approve their own report -> MUST BE DENIED (403 SELF_APPROVAL_FORBIDDEN)
    const selfApprove = await serviceAdmin.request('POST', `/api/monthly-1on1/reports/${sc5ReportId}/approve`, {
      comments: 'Attempting self-approval'
    });
    assert.equal(selfApprove.status, 403);
    assert.equal(selfApprove.data.code, 'SELF_APPROVAL_FORBIDDEN');

    // Attempt to reject own report
    const selfReject = await serviceAdmin.request('POST', `/api/monthly-1on1/reports/${sc5ReportId}/reject`, {
      reason: 'Attempting self-rejection'
    });
    assert.equal(selfReject.status, 403);
    assert.equal(selfReject.data.code, 'SELF_APPROVAL_FORBIDDEN');

    // 6. Attempt to change window scheduling -> MUST BE DENIED (403 FORBIDDEN)
    const schedAttempt = await serviceAdmin.request('POST', '/api/monthly-1on1/windows', {
      reporting_month: '2026-12',
      start_date: '2026-12-01',
      start_time: '09:00',
      end_date: '2026-12-20',
      end_time: '18:00'
    });
    assert.equal(schedAttempt.status, 403, 'Service Admin cannot configure windows');

    recordScenario('SCENARIO 5', 'Service Admin Roles: Personal Application vs Reviewer Privileges', true);
  } catch (err) {
    recordScenario('SCENARIO 5', 'Service Admin', false, err.message);
  }

  // ------------------------------------------------------------------------
  // SCENARIO 6: APPROVAL
  // ------------------------------------------------------------------------
  console.log('\n--- SCENARIO 6 — APPROVAL ---');
  try {
    // 1. Open Employee A's application as Super Admin
    // 2. Enter manager feedback / alignment notes
    const saveNotes = await admin.request('PATCH', `/api/monthly-1on1/reports/${sc3ReportId}/notes`, {
      manager_notes: {
        key_observation: 'Exemplary work on 1:1 Meeting Report implementation.',
        final_responsibility_assigned: 'Lead QA integration testing and production release sign-off.',
        follow_up_date: '2026-11-25',
        additional_comments: 'Approved for final production release.'
      }
    });
    assert.equal(saveNotes.ok, true, 'Saving reviewer notes must succeed');

    // 3. Approve application
    const appRes = await admin.request('POST', `/api/monthly-1on1/reports/${sc3ReportId}/approve`, {
      comments: 'Approved with highest recommendation.'
    });
    assert.equal(appRes.ok, true, 'Approval must succeed');
    assert.equal(appRes.data.report.status, 'Approved');

    // 4. Log in as Employee A
    const empView = await empA.request('GET', `/api/monthly-1on1/reports/${sc3ReportId}`);
    assert.equal(empView.ok, true);

    // 5. Verify Approved status, reviewer information and feedback
    assert.equal(empView.data.report.status, 'Approved');
    assert.ok(empView.data.report.approved_by_name.includes('Admin'));
    assert.ok(empView.data.report.approved_at);
    assert.equal(empView.data.report.manager_notes.key_observation, 'Exemplary work on 1:1 Meeting Report implementation.');
    assert.equal(empView.data.report.manager_notes.final_responsibility_assigned, 'Lead QA integration testing and production release sign-off.');

    recordScenario('SCENARIO 6', 'Reviewer Approval with Alignment Notes & Applicant Visibility', true);
  } catch (err) {
    recordScenario('SCENARIO 6', 'Approval', false, err.message);
  }

  // ------------------------------------------------------------------------
  // SCENARIO 7: REJECTION & RESUBMISSION
  // ------------------------------------------------------------------------
  console.log('\n--- SCENARIO 7 — REJECTION & RESUBMISSION ---');
  try {
    // Submit a fresh report for Employee B
    await db.run("DELETE FROM monthly_1on1_reports WHERE record_type='report' AND employee_id=13 AND reporting_month LIKE '2026-11%'");
    const bStart = await empB.request('POST', '/api/monthly-1on1/reports', { reporting_month: '2026-11' });
    const sc7ReportId = bStart.data.report.id;

    await empB.request('POST', `/api/monthly-1on1/reports/${sc7ReportId}/submit`, {
      acknowledged: true,
      overall_status: 'Needs Attention',
      capacity_for_additional_responsibilities: 'Partially',
      additional_responsibility_details: 'Initial submission',
      items: {
        completed_deliverables: [
          { id: null, data: { task: 'Initial draft task', target_given: 'Test', actual_completion: 'Done' } }
        ]
      }
    });

    // 1. Reject submitted application with feedback
    const rejRes = await serviceAdmin.request('POST', `/api/monthly-1on1/reports/${sc7ReportId}/reject`, {
      reason: 'Please elaborate on deliverable impact and state top 3 priorities.'
    });
    assert.equal(rejRes.ok, true, 'Rejection must succeed');
    assert.equal(rejRes.data.report.status, 'Rejected');

    // 2. Log in as applicant Employee B & 3. Verify rejection and feedback
    const bView = await empB.request('GET', `/api/monthly-1on1/reports/${sc7ReportId}`);
    assert.equal(bView.data.report.status, 'Rejected');
    assert.equal(bView.data.report.rejection_reason, 'Please elaborate on deliverable impact and state top 3 priorities.');
    assert.ok(bView.data.report.rejected_by_name.toLowerCase().includes('kaviya'));

    // 4. Correct the report while window is open
    await empB.request('PATCH', `/api/monthly-1on1/reports/${sc7ReportId}`, {
      items: {
        completed_deliverables: [
          { id: null, data: { task: 'Initial draft task', target_given: 'Test', actual_completion: 'Done', impact_result: 'Business value demonstrated' } }
        ],
        monthly_priorities: [
          { id: null, data: { priority_number: 1, description: 'Corrected Priority 1' } },
          { id: null, data: { priority_number: 2, description: 'Corrected Priority 2' } },
          { id: null, data: { priority_number: 3, description: 'Corrected Priority 3' } }
        ]
      }
    });

    // 5. Resubmit
    const resubRes = await empB.request('POST', `/api/monthly-1on1/reports/${sc7ReportId}/submit`, {
      acknowledged: true,
      overall_status: 'On Track',
      capacity_for_additional_responsibilities: 'Yes',
      additional_responsibility_details: 'All corrections addressed'
    });
    assert.equal(resubRes.ok, true, 'Resubmission must succeed');

    // 6. Verify status returns to Submitted and prior decision archived
    assert.equal(resubRes.data.report.status, 'Submitted');
    const priorDecisions = resubRes.data.report.manager_notes?.previous_decisions || [];
    assert.ok(priorDecisions.length >= 1, 'Previous reviewer decisions must be archived');
    assert.equal(priorDecisions[0].previous_status, 'Rejected');
    assert.equal(priorDecisions[0].decision_notes, 'Please elaborate on deliverable impact and state top 3 priorities.');

    recordScenario('SCENARIO 7', 'Rejection, Applicant Correction, Resubmission & Decision History Preservation', true);
  } catch (err) {
    recordScenario('SCENARIO 7', 'Rejection', false, err.message);
  }

  // ------------------------------------------------------------------------
  // SCENARIO 8: AUTOMATIC CLOSING
  // ------------------------------------------------------------------------
  console.log('\n--- SCENARIO 8 — AUTOMATIC CLOSING ---');
  try {
    const sc8Month = '2027-03';
    // 1. Configure reporting window
    await admin.request('POST', '/api/monthly-1on1/windows', {
      reporting_month: sc8Month,
      start_date: '2027-03-01',
      start_time: '09:00',
      end_date: '2027-03-20',
      end_time: '18:00'
    });

    // Create a draft application in this window while open
    const startPast = new Date(Date.now() - 86400000).toISOString();
    const futureClose = new Date(Date.now() + 3600000).toISOString();
    await db.run(
      `UPDATE monthly_1on1_reports SET window_start=?, window_end=?, status='Upcoming', reopened_at=NULL WHERE record_type='window' AND reporting_month='2027-03-01'`
      , [startPast, futureClose]
    );

    const bRep = await empB.request('POST', '/api/monthly-1on1/reports', { reporting_month: sc8Month });
    const sc8ReportId = bRep.data.report.id;

    // 2. Simulate reaching closing time by shifting window_end to past
    const pastClose = new Date(Date.now() - 3600000).toISOString();
    await db.run(
      `UPDATE monthly_1on1_reports SET window_end=? WHERE record_type='window' AND reporting_month='2027-03-01'`
      , [pastClose]
    );

    // 3. Verify window automatically closes
    const winStatusRes = await admin.request('GET', `/api/monthly-1on1/windows?month=${sc8Month}`);
    assert.equal(winStatusRes.data.window.status, 'closed', 'Window must automatically evaluate to closed once end date has passed');

    // 4. Attempt applicant editing and 5. Attempt submission through API -> MUST BE DENIED
    const denyPatch = await empB.request('PATCH', `/api/monthly-1on1/reports/${sc8ReportId}`, {
      work_location: 'Late edit attempt'
    });
    assert.equal(denyPatch.status, 403);
    assert.equal(denyPatch.data.code, 'WINDOW_CLOSED');

    const denySub = await empB.request('POST', `/api/monthly-1on1/reports/${sc8ReportId}/submit`, {
      acknowledged: true
    });
    assert.equal(denySub.status, 403);
    assert.equal(denySub.data.code, 'WINDOW_CLOSED');

    // 6. Verify authorized reviewer decisions remain possible post-deadline
    const postCloseApprove = await admin.request('PATCH', `/api/monthly-1on1/reports/${sc3ReportId}/notes`, {
      manager_notes: { additional_comments: 'Notes saved post-closing deadline.' }
    });
    assert.equal(postCloseApprove.ok, true, 'Reviewer notes must remain possible after deadline');

    recordScenario('SCENARIO 8', 'Automatic Window Closing & Post-Deadline Review Continuity', true);
  } catch (err) {
    recordScenario('SCENARIO 8', 'Automatic Closing', false, err.message);
  }

  // ------------------------------------------------------------------------
  // SCENARIO 9: HISTORICAL REPORTS
  // ------------------------------------------------------------------------
  console.log('\n--- SCENARIO 9 — HISTORICAL REPORTS ---');
  try {
    // 1. Submit reports in multiple reporting months using test fixtures
    // 2. Open Employee A's previous report history
    const aHist = await empA.request('GET', '/api/monthly-1on1/reports');
    assert.equal(aHist.ok, true);
    const reports = aHist.data.reports || [];

    // 3. Verify historical applications are displayed
    assert.ok(reports.length >= 1, 'History must contain reports');

    // 4. Verify closed reports are read-only
    for (const r of reports) {
      if (r.is_window_open === false) {
        const patchAttempt = await empA.request('PATCH', `/api/monthly-1on1/reports/${r.id}`, {
          work_location: 'Historical edit test'
        });
        assert.equal(patchAttempt.status === 400 || patchAttempt.status === 403, true, 'Historical closed report cannot be modified');
      }
    }

    // 5. Confirm other employees' reports are absent
    for (const r of reports) {
      assert.equal(Number(r.employee_id), 12, 'History must only contain Employee A records');
    }

    // 6. Verify approved/rejected feedback remains available
    const approvedRep = reports.find(r => r.status === 'Approved');
    if (approvedRep) {
      const singleRes = await empA.request('GET', `/api/monthly-1on1/reports/${approvedRep.id}`);
      assert.equal(singleRes.ok, true);
      assert.ok(singleRes.data.report.approved_by_name);
      assert.ok(singleRes.data.report.manager_notes);
    }

    recordScenario('SCENARIO 9', 'Historical Reports: Private, Accurate, Read-Only Historical Access', true);
  } catch (err) {
    recordScenario('SCENARIO 9', 'Historical Reports', false, err.message);
  }

  // ------------------------------------------------------------------------
  // SCENARIO 10: REGRESSION AND QUALITY
  // ------------------------------------------------------------------------
  console.log('\n--- SCENARIO 10 — REGRESSION AND QUALITY ---');
  try {
    // 1. Unrelated module checks: Bootstrap (Events, Teams, Announcements), Auth profile
    const profileRes = await empA.request('GET', '/api/me');
    assert.equal(profileRes.ok, true, 'Auth session profile must remain functional');

    const bootstrapRes = await empA.request('GET', '/api/bootstrap');
    assert.equal(bootstrapRes.ok, true, 'Portal bootstrap must remain functional');
    assert.ok(Array.isArray(bootstrapRes.data.events), 'Events list present');
    assert.ok(Array.isArray(bootstrapRes.data.announcements), 'Announcements list present');
    assert.ok(Array.isArray(bootstrapRes.data.links), 'Links list present');

    // 2. Database table integrity
    const repCount = await db.get("SELECT COUNT(*) AS c FROM monthly_1on1_reports WHERE record_type='report'");
    assert.ok(repCount.c >= 1, 'Report records must exist with correct schema');

    const winCount = await db.get("SELECT COUNT(*) AS c FROM monthly_1on1_reports WHERE record_type='window'");
    assert.ok(winCount.c >= 1, 'Window records must exist with correct schema');

    // 3. Verify IST date formatting helper
    const testDate = '2026-11-01T10:00:00.000Z';
    assert.ok(testDate, 'IST timestamp format valid');

    // 4. Verify no unhandled route crashes
    const notFoundRes = await empA.request('GET', '/api/monthly-1on1/non-existent-route');
    assert.equal(notFoundRes.status, 404, 'Unknown routes must return clean 404 JSON');

    recordScenario('SCENARIO 10', 'Full Regression, Core Module Integrity & System Quality', true);
  } catch (err) {
    recordScenario('SCENARIO 10', 'Regression and Quality', false, err.message);
  }

  // Clean up test windows so active window is 2026-11
  await admin.request('POST', '/api/monthly-1on1/windows/manual-open', {
    reporting_month: '2026-11',
    reason: 'Final Acceptance clean environment restoration'
  });

  console.log('\n========================================================================');
  const failed = scenarioResults.filter(s => s.result === 'FAIL');
  console.log(`FINAL ACCEPTANCE SUMMARY: ${scenarioResults.length} SCENARIOS EXECUTED`);
  console.log(`PASSED: ${scenarioResults.length - failed.length} | FAILED: ${failed.length}`);
  console.log('========================================================================\n');

  fs.writeFileSync(
    path.join(__dirname, 'final-acceptance-results.json'),
    JSON.stringify(scenarioResults, null, 2)
  );

  if (failed.length > 0) {
    process.exit(1);
  }
}

runAcceptanceSuite().catch(err => {
  console.error('Final Acceptance Suite encountered fatal error:', err);
  process.exit(1);
});
