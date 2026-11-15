'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const path = require('node:path');

const { MySQLDatabase, databaseConfig } = require('../lib/database');

const TEST_PORT = 3344;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
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
    cookies: [`mc_session=${token}`],
    get cookie() {
      return this.cookies.join('; ');
    },
    setCookie(str) {
      if (!str) return;
      const nv = str.split(';')[0].trim();
      this.cookies = this.cookies.filter(c => !c.startsWith(nv.split('=')[0] + '='));
      this.cookies.push(nv);
    },
    async request(method, path, body = null, customHeaders = {}) {
      return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const headers = {
          'Host': `127.0.0.1:${TEST_PORT}`,
          'Origin': BASE_URL,
          'Cookie': this.cookie,
          'X-CSRF-Token': this.csrf,
          'Connection': 'close',
          ...customHeaders
        };
        if (payload) {
          headers['Content-Type'] = 'application/json';
          headers['Content-Length'] = Buffer.byteLength(payload);
        }

        const req = http.request(`${BASE_URL}${path}`, { method, headers }, res => {
          let raw = '';
          res.on('data', chunk => { raw += chunk; });
          res.on('end', () => {
            let data = null;
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
  console.log('--- Starting Monthly 1:1 API End-to-End Integration Tests ---');

  // Verify DB connection & clean up any stale test records
  const db = new MySQLDatabase(databaseConfig());
  await db.ready;
  await db.run('DELETE FROM connect_monthly_1on1_items WHERE report_id IN (SELECT id FROM connect_monthly_1on1_reports WHERE reporting_month="2026-09-01")');
  await db.run('DELETE FROM connect_monthly_1on1_reports WHERE reporting_month="2026-09-01"');

  // Spawn server on TEST_PORT
  const serverProcess = spawn(
    process.execPath,
    ['--env-file=.env', 'server.js'],
    {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, PORT: String(TEST_PORT), HOST: '127.0.0.1' },
      stdio: ['pipe', 'pipe', 'pipe']
    }
  );

  serverProcess.stderr.on('data', d => {
    const msg = d.toString();
    if (!msg.includes('ECONNRESET')) console.error('Server err:', msg);
  });

  // Wait for server to be responsive
  await new Promise((resolve, reject) => {
    let retries = 0;
    const interval = setInterval(() => {
      const check = http.get(`${BASE_URL}/api/session`, { headers: { Connection: 'close' } }, res => {
        res.resume();
        clearInterval(interval);
        resolve();
      });
      check.on('error', () => {
        retries++;
        if (retries > 30) {
          clearInterval(interval);
          reject(new Error('Server failed to start on test port'));
        }
      });
    }, 200);
  });
  console.log('Test server started on port', TEST_PORT);

  try {
    // Clients
    const employee = createClient(13); // Hariharan (member, Operations Team)
    const manager = createClient(5);    // Admin (System Admin, role admin)
    const unauthorized = createClient(14); // Soundarya (member, Sales Team)

    let testReportId = null;
    let initialUpdatedAt = null;

    // 1. GET /api/monthly-1on1/overview
    console.log('1. Testing GET /api/monthly-1on1/overview...');
    const unauthOverview = await (new Promise((resolve, reject) => {
      const req = http.get(`${BASE_URL}/api/monthly-1on1/overview`, { headers: { Connection: 'close' } }, res => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
    }));
    assert.equal(unauthOverview, 401, 'Anonymous request must return 401');

    const empOverview = await employee.request('GET', '/api/monthly-1on1/overview?year=2026');
    assert.equal(empOverview.status, 200);
    assert.equal(Array.isArray(empOverview.data.reports), true);
    assert.equal(empOverview.data.teamSummary, null, 'Employee should not see team summary');

    const mgrOverview = await manager.request('GET', '/api/monthly-1on1/overview?year=2026');
    assert.equal(mgrOverview.status, 200);
    assert.ok(mgrOverview.data.teamSummary !== null, 'Authorized manager should receive team summary');

    // 2. GET /api/monthly-1on1/reports
    console.log('2. Testing GET /api/monthly-1on1/reports...');
    const listBefore = await employee.request('GET', '/api/monthly-1on1/reports');
    assert.equal(listBefore.status, 200);
    assert.equal(Array.isArray(listBefore.data.reports), true);

    // 3. POST /api/monthly-1on1/reports
    console.log('3. Testing POST /api/monthly-1on1/reports (CSRF & creation)...');
    // Setup window for 2026-09 first
    await db.run("UPDATE monthly_1on1_reports SET status='Closed' WHERE record_type='window'");
    const winRes = await manager.request('POST', '/api/monthly-1on1/windows', {
      reporting_month: '2026-09',
      start_date: '2026-09-01',
      start_time: '00:00',
      end_date: '2026-12-31',
      end_time: '23:59'
    });
    assert.equal(winRes.status, 200, 'Window setup for 2026-09 must succeed');

    // 3a. Missing CSRF
    const missingCsrf = await employee.request('POST', '/api/monthly-1on1/reports', { reporting_month: '2026-09' }, { 'X-CSRF-Token': '' });
    assert.equal(missingCsrf.status, 403, 'Missing CSRF must be rejected');
    assert.equal(missingCsrf.data.code, 'CSRF');

    // 3b. Successful creation
    const created = await employee.request('POST', '/api/monthly-1on1/reports', { reporting_month: '2026-09' });
    assert.equal(created.status, 201);
    assert.ok(created.data.report.id);
    assert.equal(created.data.report.status, 'Draft');
    assert.equal(created.data.report.employee_id, 13);
    assert.equal(created.data.report.reporting_month, '2026-09-01');
    testReportId = created.data.report.id;
    initialUpdatedAt = created.data.report.updated_at;

    // 3c. Duplicate creation rejection
    const duplicate = await employee.request('POST', '/api/monthly-1on1/reports', { reporting_month: '2026-09' });
    assert.equal(duplicate.status, 400);
    assert.equal(duplicate.data.code, 'DUPLICATE');

    // 4. GET /api/monthly-1on1/reports/:id
    console.log('4. Testing GET /api/monthly-1on1/reports/:id...');
    // 4a. Owner access
    const ownerGet = await employee.request('GET', `/api/monthly-1on1/reports/${testReportId}`);
    assert.equal(ownerGet.status, 200);
    assert.equal(ownerGet.data.report.id, testReportId);

    // 4b. Unauthorized member access
    const unauthGet = await unauthorized.request('GET', `/api/monthly-1on1/reports/${testReportId}`);
    assert.equal(unauthGet.status, 403, 'Unauthorized user must be denied view access');

    // 4c. Authorized manager access
    const mgrGet = await manager.request('GET', `/api/monthly-1on1/reports/${testReportId}`);
    assert.equal(mgrGet.status, 200, 'Authorized manager can view report');

    // 5. PATCH /api/monthly-1on1/reports/:id
    console.log('5. Testing PATCH /api/monthly-1on1/reports/:id (Draft & concurrency)...');
    // 5a. Unauthorized member edit attempt
    const unauthEdit = await unauthorized.request('PATCH', `/api/monthly-1on1/reports/${testReportId}`, {
      work_location: 'Remote'
    });
    assert.equal(unauthEdit.status, 403, 'Unauthorized user cannot edit employee draft');

    // 5b. Stale edit conflict (expected_updated_at mismatch)
    const conflictEdit = await employee.request('PATCH', `/api/monthly-1on1/reports/${testReportId}`, {
      work_location: 'Coimbatore Hub',
      expected_updated_at: '2020-01-01T00:00:00.000Z'
    });
    assert.equal(conflictEdit.status, 409, 'Stale concurrent update must return 409 Conflict');
    assert.equal(conflictEdit.data.code, 'STALE_DATA_CONFLICT');

    // 5c. Valid draft update with sections
    const sampleItems = {
      completed_deliverables: [
        { task: 'Integrated 1:1 reports backend', target_given: '7 days', actual_completion: '5 days', impact_result: 'Enabled monthly feedback loop', proof_link: 'https://example.com/pr/1' }
      ],
      pending_tasks: [
        { task: 'Prepare slide deck for review', reason_for_delay: 'Awaiting design feedback', current_status: '70% complete', support_needed: 'Design assets', expected_completion_date: '2026-10-30' }
      ],
      challenges_support: [
        { major_challenge: 'Schema synchronization across environments', support_required: 'Database admin review' }
      ],
      responsibility_readiness: [
        { current_responsibilities: 'Core portal development', next_responsibilities: 'System architecture & mentoring', clarity_required: 'Q4 milestones' }
      ],
      improvement_suggestions: [
        { suggestion: 'Automate weekly reminder digests for pending 1:1 items' }
      ],
      monthly_priorities: [
        { priority_number: 1, description: 'Complete monthly 1:1 portal feature rollout' }
      ]
    };

    const draftUpdated = await employee.request('PATCH', `/api/monthly-1on1/reports/${testReportId}`, {
      meeting_date: '2026-09-28',
      work_location: 'Coimbatore Office',
      current_projects: 'Project Reinvent Portal',
      overall_status: 'On Track',
      capacity_for_additional_responsibilities: 'Yes',
      additional_responsibility_details: 'Ready to mentor junior engineers',
      items: sampleItems,
      expected_updated_at: initialUpdatedAt
    });
    assert.equal(draftUpdated.status, 200);
    assert.equal(draftUpdated.data.report.overall_status, 'On Track');
    assert.equal(draftUpdated.data.report.items.completed_deliverables.length, 1);
    assert.equal(draftUpdated.data.report.items.monthly_priorities[0].data.priority_number, 1);

    // 6. POST /api/monthly-1on1/reports/:id/submit
    console.log('6. Testing POST /api/monthly-1on1/reports/:id/submit...');
    // 6a. Unauthorized submit
    const unauthSubmit = await unauthorized.request('POST', `/api/monthly-1on1/reports/${testReportId}/submit`, { acknowledged: true });
    assert.equal(unauthSubmit.status, 403, 'Unauthorized user cannot submit another user report');

    // 6b. Missing acknowledgement
    const noAckSubmit = await employee.request('POST', `/api/monthly-1on1/reports/${testReportId}/submit`, { acknowledged: false });
    assert.equal(noAckSubmit.status, 400);
    assert.equal(noAckSubmit.data.code, 'ACKNOWLEDGEMENT_REQUIRED');

    // 6c. Valid employee submission
    const submitted = await employee.request('POST', `/api/monthly-1on1/reports/${testReportId}/submit`, { acknowledged: true });
    assert.equal(submitted.status, 200);
    assert.equal(submitted.data.report.status, 'Submitted');
    assert.ok(submitted.data.report.submitted_at);
    assert.ok(submitted.data.report.employee_acknowledged_at);

    // 6d. Can edit draft while submitted when window is open (Rule B5)
    const editWhileSubmitted = await employee.request('PATCH', `/api/monthly-1on1/reports/${testReportId}`, { work_location: 'Remote Office' });
    assert.equal(editWhileSubmitted.status, 200, 'Can edit report while Submitted if window is open (Rule B5)');
    assert.equal(editWhileSubmitted.data.report.work_location, 'Remote Office');

    // 7. POST /api/monthly-1on1/reports/:id/start-review
    console.log('7. Testing POST /api/monthly-1on1/reports/:id/start-review (Self-review prevention)...');
    // 7a. Self-review attempt by employee
    const selfReview = await employee.request('POST', `/api/monthly-1on1/reports/${testReportId}/start-review`, {});
    assert.equal(selfReview.status, 403, 'Self-review must be strictly forbidden');

    // 7b. Unauthorized member attempt
    const unauthReview = await unauthorized.request('POST', `/api/monthly-1on1/reports/${testReportId}/start-review`, {});
    assert.equal(unauthReview.status, 403, 'Unauthorized member cannot start review');

    // 7c. Authorized manager starts review
    const startReview = await manager.request('POST', `/api/monthly-1on1/reports/${testReportId}/start-review`, {});
    assert.equal(startReview.status, 200);
    assert.equal(startReview.data.report.status, 'Under Review');
    assert.equal(startReview.data.report.reviewer_id, 5);

    // 8. Manager notes saving in progress
    console.log('8. Testing saving manager review notes (PATCH .../notes and PATCH .../:id)...');
    // 8a. Self-review note save forbidden
    const selfNotes = await employee.request('PATCH', `/api/monthly-1on1/reports/${testReportId}/notes`, {
      key_observation: 'Self review'
    });
    assert.equal(selfNotes.status, 403, 'Self-saving manager notes must be rejected');

    // 8b. Manager saves notes via /notes
    const mgrNotesSaved = await manager.request('PATCH', `/api/monthly-1on1/reports/${testReportId}/notes`, {
      key_observation: 'Demonstrated high technical ownership and timely deliveries',
      final_responsibility_assigned: 'Lead full-stack module rollouts',
      follow_up_date: '2026-10-15',
      additional_comments: 'Good progress across all objectives'
    });
    assert.equal(mgrNotesSaved.status, 200);
    assert.equal(mgrNotesSaved.data.report.manager_notes.key_observation, 'Demonstrated high technical ownership and timely deliveries');
    assert.equal(mgrNotesSaved.data.report.manager_notes.follow_up_date, '2026-10-15');

    // 8c. Manager saves notes via PATCH /reports/:id
    const mgrPatchSaved = await manager.request('PATCH', `/api/monthly-1on1/reports/${testReportId}`, {
      manager_notes: {
        key_observation: 'Updated observation: Outstanding execution',
        final_responsibility_assigned: 'Lead full-stack module rollouts',
        follow_up_date: '2026-10-20',
        additional_comments: 'Ready for next challenge'
      }
    });
    assert.equal(mgrPatchSaved.status, 200);
    assert.equal(mgrPatchSaved.data.report.manager_notes.key_observation, 'Updated observation: Outstanding execution');

    // 9. POST /api/monthly-1on1/reports/:id/request-revision
    console.log('9. Testing POST /api/monthly-1on1/reports/:id/request-revision...');
    // 9a. Reason required
    const noReasonRev = await manager.request('POST', `/api/monthly-1on1/reports/${testReportId}/request-revision`, { reason: '   ' });
    assert.equal(noReasonRev.status, 400);

    // 9b. Self-revision request forbidden
    const selfRev = await employee.request('POST', `/api/monthly-1on1/reports/${testReportId}/request-revision`, { reason: 'Self request' });
    assert.equal(selfRev.status, 403);

    // 9c. Authorized revision request
    const revRequested = await manager.request('POST', `/api/monthly-1on1/reports/${testReportId}/request-revision`, {
      reason: 'Please add metrics for the deliverable impact'
    });
    assert.equal(revRequested.status, 200);
    assert.equal(revRequested.data.report.status, 'Revision Requested');
    assert.equal(revRequested.data.report.revision_reason, 'Please add metrics for the deliverable impact');

    // 10. Resubmission workflow
    console.log('10. Testing edit and resubmit workflow...');
    // Employee edits during Revision Requested
    const employeeRevised = await employee.request('PATCH', `/api/monthly-1on1/reports/${testReportId}`, {
      work_location: 'Coimbatore Campus',
      items: {
        ...sampleItems,
        completed_deliverables: [
          { task: 'Integrated 1:1 reports backend', target_given: '7 days', actual_completion: '5 days', impact_result: 'Reduced review turnaround by 40%', proof_link: 'https://example.com/pr/1' }
        ]
      }
    });
    assert.equal(employeeRevised.status, 200);

    // Employee resubmits
    const resubmitted = await employee.request('POST', `/api/monthly-1on1/reports/${testReportId}/submit`, { acknowledged: true });
    assert.equal(resubmitted.status, 200);
    assert.equal(resubmitted.data.report.status, 'Submitted');

    // Manager starts review again
    const reviewResumed = await manager.request('POST', `/api/monthly-1on1/reports/${testReportId}/start-review`, {});
    assert.equal(reviewResumed.status, 200);
    assert.equal(reviewResumed.data.report.status, 'Under Review');

    // 11. POST /api/monthly-1on1/reports/:id/finalize
    console.log('11. Testing POST /api/monthly-1on1/reports/:id/finalize...');
    // 11a. Missing acknowledgement
    const noAckFinalize = await manager.request('POST', `/api/monthly-1on1/reports/${testReportId}/finalize`, {
      reviewer_acknowledged: false
    });
    assert.equal(noAckFinalize.status, 400);

    // 11b. Self-approval attempt
    const selfFinalize = await employee.request('POST', `/api/monthly-1on1/reports/${testReportId}/finalize`, {
      reviewer_acknowledged: true
    });
    assert.equal(selfFinalize.status, 403, 'Self-approval must be rejected with 403');

    // 11c. Authorized manager finalizes
    const finalized = await manager.request('POST', `/api/monthly-1on1/reports/${testReportId}/finalize`, {
      reviewer_acknowledged: true,
      key_observation: 'Metrics clarified. Exemplary work.',
      final_responsibility_assigned: 'Lead technical mentorship',
      follow_up_date: '2026-11-01',
      additional_comments: 'Finalized successfully.'
    });
    assert.equal(finalized.status, 200);
    assert.equal(finalized.data.report.status, 'Completed');
    assert.ok(finalized.data.report.completed_at);
    assert.ok(finalized.data.report.reviewer_acknowledged_at);
    assert.equal(finalized.data.report.manager_notes.key_observation, 'Metrics clarified. Exemplary work.');

    // 11d. Cannot edit completed report
    const editCompleted = await employee.request('PATCH', `/api/monthly-1on1/reports/${testReportId}`, { work_location: 'Anywhere' });
    assert.equal(editCompleted.status, 400, 'Cannot edit completed report');

    // 12. POST /api/monthly-1on1/reports/:id/reopen
    console.log('12. Testing POST /api/monthly-1on1/reports/:id/reopen...');
    // 12a. Unauthorized member reopen attempt
    const unauthReopen = await employee.request('POST', `/api/monthly-1on1/reports/${testReportId}/reopen`, { reason: 'Want to change something' });
    assert.equal(unauthReopen.status, 403, 'Employee cannot self-reopen completed report');

    // 12b. Manager reopens with reason
    const reopened = await manager.request('POST', `/api/monthly-1on1/reports/${testReportId}/reopen`, {
      reason: 'Reopened to include updated quarterly targets'
    });
    assert.equal(reopened.status, 200);
    assert.equal(reopened.data.report.status, 'Revision Requested');
    assert.ok(reopened.data.report.revision_reason.includes('updated quarterly targets'));

    // Resubmit and re-finalize to leave database clean in Completed state
    await employee.request('POST', `/api/monthly-1on1/reports/${testReportId}/submit`, { acknowledged: true });
    await manager.request('POST', `/api/monthly-1on1/reports/${testReportId}/start-review`, {});
    await manager.request('POST', `/api/monthly-1on1/reports/${testReportId}/finalize`, {
      reviewer_acknowledged: true,
      key_observation: 'Completed final round'
    });

    // 13. GET /api/monthly-1on1/team-reports
    console.log('13. Testing GET /api/monthly-1on1/team-reports...');
    const empTeamReports = await employee.request('GET', '/api/monthly-1on1/team-reports');
    assert.equal(empTeamReports.status, 403, 'Regular member must not access team reports');

    // Super Admin accesses team reports directly without PIN (PIN removed per user specification)
    const mgrTeamReports = await manager.request('GET', '/api/monthly-1on1/team-reports?year=2026');
    assert.equal(mgrTeamReports.status, 200, 'Super Admin accesses directly without PIN');
    assert.ok(Array.isArray(mgrTeamReports.data.reports));
    assert.ok(mgrTeamReports.data.total >= 1);

    // 14. GET /api/monthly-1on1/export/:id
    console.log('14. Testing GET /api/monthly-1on1/export/:id...');
    const unauthExport = await unauthorized.request('GET', `/api/monthly-1on1/export/${testReportId}`);
    assert.equal(unauthExport.status, 403, 'Unauthorized user cannot export another user report');

    const empExport = await employee.request('GET', `/api/monthly-1on1/export/${testReportId}`);
    assert.equal(empExport.status, 200);
    assert.equal(empExport.data.report.id, testReportId);

    const mgrExport = await manager.request('GET', `/api/monthly-1on1/export/${testReportId}`);
    assert.equal(mgrExport.status, 200);
    assert.equal(mgrExport.data.report.id, testReportId);

    // 15. Verify Audit Logs
    console.log('15. Verifying connect_audit_logs entries...');
    const auditLogs = await db.all(
      `SELECT action, entity_id FROM connect_audit_logs WHERE entity='monthly_1on1' AND entity_id=? ORDER BY id ASC`,
      [testReportId]
    );
    const loggedActions = auditLogs.map(l => l.action);
    console.log('Logged audit actions:', loggedActions);

    for (const requiredAction of [
      'MONTHLY_1ON1_CREATED',
      'MONTHLY_1ON1_SUBMITTED',
      'MONTHLY_1ON1_REVIEW_STARTED',
      'MONTHLY_1ON1_REVISION_REQUESTED',
      'MONTHLY_1ON1_RESUBMITTED',
      'MONTHLY_1ON1_COMPLETED',
      'MONTHLY_1ON1_REOPENED'
    ]) {
      assert.ok(loggedActions.includes(requiredAction), `Missing audit action: ${requiredAction}`);
    }

    console.log('\nAll 15 Monthly 1:1 API end-to-end integration tests PASSED successfully!\n');

  } finally {
    // Cleanup test data
    await db.run('DELETE FROM connect_monthly_1on1_items WHERE report_id IN (SELECT id FROM connect_monthly_1on1_reports WHERE reporting_month="2026-09-01")');
    await db.run('DELETE FROM connect_monthly_1on1_reports WHERE reporting_month="2026-09-01"');
    await db.close().catch(() => {});

    // Terminate server
    serverProcess.kill('SIGTERM');
    await new Promise(resolve => {
      serverProcess.on('close', resolve);
      setTimeout(resolve, 1500);
    });
  }
})().catch(err => {
  console.error('Integration test failed:', err);
  process.exit(1);
});
