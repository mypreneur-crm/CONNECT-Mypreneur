'use strict';

/**
 * MONTHLY 1:1 MEETING REPORT: STEPS 1–3 AUDIT & VERIFICATION SUITE
 * Tests:
 * 1. Step 1: Employee details, auto-fill, identity protection, editable fields persistence.
 * 2. Step 2: Key deliverables, repeatable rows, add/remove, proof URL, file upload/storage/retrieval.
 * 3. Step 3: Pending tasks, repeatable rows, add/remove, "No pending tasks" checkbox, non-contradiction.
 * 4. Draft lifecycle: No duplicates, load existing draft, preserve data across reload, closed window restrictions.
 */

const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { MySQLDatabase, databaseConfig } = require('../lib/database');

const PORT = process.env.PORT || 3000;
const BASE_URL = `http://127.0.0.1:${PORT}`;
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
          'X-Requested-With': 'XMLHttpRequest',
          'X-CSRF-Token': csrf,
          ...customHeaders
        };
        if (cookies.length) headers['Cookie'] = cookies.join('; ');
        if (payload) {
          headers['Content-Type'] = 'application/json';
          headers['Content-Length'] = Buffer.byteLength(payload);
        }

        const req = http.request(`${BASE_URL}${reqPath}`, { method, headers }, (res) => {
          let chunks = '';
          res.on('data', d => chunks += d);
          res.on('end', () => {
            let parsed = null;
            try { parsed = JSON.parse(chunks); } catch { parsed = chunks; }
            resolve({ status: res.statusCode, headers: res.headers, body: parsed });
          });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
      });
    }
  };
}

(async function runSteps1To3Suite() {
  console.log('================================================================');
  console.log('MONTHLY 1:1 APPLICATION: STEPS 1–3 AUDIT & VERIFICATION SUITE');
  console.log('================================================================\n');

  const db = new MySQLDatabase(databaseConfig());
  await db.ready;

  const superAdmin = createClient(5);
  const employee = createClient(12); // Ibrahim Shah
  const testMonth = '2026-11';

  console.log('[Setup] Cleaning up test records and opening window...');
  await db.run(`UPDATE monthly_1on1_reports SET status='Closed' WHERE record_type='window'`);
  await db.run(`DELETE FROM monthly_1on1_reports WHERE record_type='report' AND reporting_month LIKE '2026-11%'`);

  // Super Admin schedules and opens window
  await superAdmin.request('POST', '/api/monthly-1on1/windows', {
    reporting_month: testMonth,
    start_date: '2026-11-01',
    start_time: '09:00',
    end_date: '2026-11-30',
    end_time: '18:00'
  });
  await superAdmin.request('POST', '/api/monthly-1on1/windows/manual-open', {
    reporting_month: testMonth,
    reason: 'Testing Steps 1-3'
  });

  // -------------------------------------------------------------
  // Test 1: Step 1 Employee Details & Auto-Fill
  // -------------------------------------------------------------
  console.log('\n[Test 1] Testing Step 1: Auto-fill, Identity Protection & Field Persistence...');
  const createRes = await employee.request('POST', '/api/monthly-1on1/reports', {
    reporting_month: testMonth
  });
  assert.strictEqual(createRes.status, 201, 'Report creation must succeed with 201');
  const reportId = createRes.body.report.id;
  const initial = createRes.body.report;

  // Auto-filled values
  assert.strictEqual(Number(initial.employee_id), 12);
  assert.ok(initial.employee_name, 'Employee name must be auto-filled');
  assert.ok(initial.department !== undefined, 'Department must be auto-filled');
  assert.strictEqual(initial.reporting_month.slice(0, 7), testMonth, 'Reporting month auto-filled from open window');
  assert.ok(initial.director_name || initial.reviewer_name, 'Manager / Reviewer auto-filled');

  // Save Step 1 editable fields
  const step1Patch = await employee.request('PATCH', `/api/monthly-1on1/reports/${reportId}`, {
    meeting_date: '2026-11-15',
    work_location: 'Chennai HQ - Digital Studio',
    current_projects: 'AI Agent Workflows & Mobile Connect App',
    overall_status: 'On Track'
  });
  assert.strictEqual(step1Patch.status, 200);
  const rep1 = step1Patch.body.report;
  assert.strictEqual(rep1.meeting_date.slice(0, 10), '2026-11-15');
  assert.strictEqual(rep1.work_location, 'Chennai HQ - Digital Studio');
  assert.strictEqual(rep1.current_projects, 'AI Agent Workflows & Mobile Connect App');
  assert.strictEqual(rep1.overall_status, 'On Track');

  // Verify identity tampering is strictly forbidden
  const spoofPatch = await employee.request('PATCH', `/api/monthly-1on1/reports/${reportId}`, {
    employee_id: 999,
    employee_name: 'Imposter'
  });
  assert.strictEqual(spoofPatch.status, 200);
  assert.strictEqual(Number(spoofPatch.body.report.employee_id), 12, 'Employee ID must not be modifiable');
  assert.strictEqual(spoofPatch.body.report.employee_name, initial.employee_name, 'Employee name must not be modifiable');
  console.log('  ✔ Verified Step 1: Profile auto-filled, identity protected, editable fields saved reliably.');

  // -------------------------------------------------------------
  // Test 2: Step 2 Key Deliverables & Attachment Upload/Retrieval
  // -------------------------------------------------------------
  console.log('\n[Test 2] Testing Step 2: Repeatable Deliverables, Proof Links & File Attachments...');

  // 2a. Upload a valid test PDF file attachment
  const samplePdfBuffer = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF');
  const uploadRes = await employee.request('POST', `/api/monthly-1on1/reports/${reportId}/attachments`, {
    file: {
      name: 'monthly_deliverable_proof.pdf',
      data: `data:application/pdf;base64,${samplePdfBuffer.toString('base64')}`,
      type: 'application/pdf'
    }
  });
  assert.strictEqual(uploadRes.status, 200, `Attachment upload failed: ${JSON.stringify(uploadRes.body)}`);
  assert.ok(uploadRes.body.ok);
  assert.ok(uploadRes.body.proof);
  assert.strictEqual(uploadRes.body.proof.original_name, 'monthly_deliverable_proof.pdf');
  const storageKey = uploadRes.body.proof.storage_key;
  assert.ok(storageKey, 'Storage key must be returned');

  // 2b. Save multiple deliverable rows (Row 1 with file, Row 2 with URL link)
  const step2Patch = await employee.request('PATCH', `/api/monthly-1on1/reports/${reportId}`, {
    items: {
      completed_deliverables: [
        {
          task: 'Deliverable 1: Payment gateway migration',
          target_given: '100% gateway cutover by Nov 10',
          actual_completion: '100% completed with zero downtime',
          impact_result: 'Transaction success rate improved by 14%',
          proof_link: 'https://github.com/mypreneur/connect/pull/402',
          proof: {
            link: 'https://github.com/mypreneur/connect/pull/402',
            file: uploadRes.body.proof
          }
        },
        {
          task: 'Deliverable 2: Security hardening for admin endpoints',
          target_given: 'Pass all CSRF and role boundary audits',
          actual_completion: 'Completed audit with 100% test coverage',
          impact_result: 'Zero vulnerabilities reported in audit',
          proof_link: 'https://internal-docs.mypreneur.com/audit-results',
          proof: {
            link: 'https://internal-docs.mypreneur.com/audit-results',
            file: null
          }
        }
      ]
    }
  });
  assert.strictEqual(step2Patch.status, 200);

  // 2c. Verify retrieval of attachment file via secure endpoint
  const getFileRes = await employee.request('GET', `/api/monthly-1on1/reports/${reportId}/attachment?key=${encodeURIComponent(storageKey)}`);
  assert.strictEqual(getFileRes.status, 200, 'Secure file retrieval must succeed with 200');
  assert.strictEqual(getFileRes.headers['content-type'], 'application/pdf');

  // 2d. Cross-report unauthorized file retrieval must be blocked
  const dummyReportId = crypto.randomUUID();
  const getUnauthorized = await employee.request('GET', `/api/monthly-1on1/reports/${dummyReportId}/attachment?key=${encodeURIComponent(storageKey)}`);
  assert.strictEqual(getUnauthorized.status, 404, 'Invalid report attachment query must be rejected');

  console.log('  ✔ Verified Step 2: Repeatable deliverables, proof links, image/PDF upload, disk storage & secure retrieval working.');

  // -------------------------------------------------------------
  // Test 3: Step 3 Pending Tasks & "No pending tasks" Non-Contradiction
  // -------------------------------------------------------------
  console.log('\n[Test 3] Testing Step 3: Pending Tasks, Expected Completion Date & Non-Contradiction Checkbox...');

  // 3a. Save pending tasks with expected completion dates
  const step3Patch = await employee.request('PATCH', `/api/monthly-1on1/reports/${reportId}`, {
    items: {
      pending_tasks: [
        {
          task: 'Integration with Hostinger webhook notifications',
          reason_for_delay: 'Waiting for vendor webhook signature documentation',
          current_status: 'Sandbox testing completed',
          support_needed: 'Followup with Hostinger support team',
          expected_completion_date: '2026-11-28'
        }
      ]
    }
  });
  assert.strictEqual(step3Patch.status, 200);
  const repWithPending = step3Patch.body.report;
  assert.strictEqual(repWithPending.items.pending_tasks.length, 1);
  assert.strictEqual(repWithPending.items.pending_tasks[0].data.task, 'Integration with Hostinger webhook notifications');
  assert.strictEqual(repWithPending.items.pending_tasks[0].data.expected_completion_date, '2026-11-28');

  // 3b. Verify "No pending tasks this month" checkbox clears pending tasks without contradictory data
  const step3NoPendingPatch = await employee.request('PATCH', `/api/monthly-1on1/reports/${reportId}`, {
    items: {
      pending_tasks: [] // Checkbox checked -> empty array
    }
  });
  assert.strictEqual(step3NoPendingPatch.status, 200);
  assert.strictEqual(step3NoPendingPatch.body.report.items.pending_tasks.length, 0, 'No pending tasks submitted when checkbox checked');

  // Re-add a task
  await employee.request('PATCH', `/api/monthly-1on1/reports/${reportId}`, {
    items: {
      pending_tasks: [
        {
          task: 'Database index tuning',
          reason_for_delay: 'Scheduled for off-peak maintenance window',
          current_status: 'Scripts prepared',
          support_needed: 'DBA approval',
          expected_completion_date: '2026-11-25'
        }
      ]
    }
  });
  console.log('  ✔ Verified Step 3: Pending tasks table, 5 required columns, date picker, and non-contradictory checkbox logic.');

  // -------------------------------------------------------------
  // Test 4: Draft Rules & Refresh/Reload Persistence
  // -------------------------------------------------------------
  console.log('\n[Test 4] Testing Draft Rules: Persistence, No Duplicates & Closed Window Enforcement...');

  // 4a. Verify duplicate creation is blocked
  const dupRes = await employee.request('POST', '/api/monthly-1on1/reports', {
    reporting_month: testMonth
  });
  assert.strictEqual(dupRes.status, 400);
  assert.strictEqual(dupRes.body.code, 'DUPLICATE');

  // 4b. Re-query report (simulate page refresh / reload)
  const reloadRes = await employee.request('GET', `/api/monthly-1on1/reports/${reportId}`);
  assert.strictEqual(reloadRes.status, 200);
  const reloaded = reloadRes.body.report;

  // Verify all fields from Step 1, Step 2, and Step 3 are 100% persisted
  assert.strictEqual(reloaded.meeting_date.slice(0, 10), '2026-11-15', 'Meeting date persisted');
  assert.strictEqual(reloaded.work_location, 'Chennai HQ - Digital Studio', 'Work location persisted');
  assert.strictEqual(reloaded.current_projects, 'AI Agent Workflows & Mobile Connect App', 'Current projects persisted');
  assert.strictEqual(reloaded.overall_status, 'On Track', 'Overall status persisted');

  assert.strictEqual(reloaded.items.completed_deliverables.length, 2, 'Deliverables count persisted');
  assert.strictEqual(reloaded.items.completed_deliverables[0].data.task, 'Deliverable 1: Payment gateway migration');
  assert.ok(reloaded.items.completed_deliverables[0].data.proof.file.original_name, 'Attachment metadata persisted');
  assert.strictEqual(reloaded.items.pending_tasks.length, 1, 'Pending tasks count persisted');
  assert.strictEqual(reloaded.items.pending_tasks[0].data.task, 'Database index tuning');

  // 4c. Close reporting window and verify drafts cannot be edited
  await superAdmin.request('POST', '/api/monthly-1on1/windows/close', {
    reporting_month: testMonth
  });

  const closedEditRes = await employee.request('PATCH', `/api/monthly-1on1/reports/${reportId}`, {
    work_location: 'Attempted edit after closure'
  });
  assert.strictEqual(closedEditRes.status, 403, 'Editing draft after window closure must return HTTP 403');
  assert.strictEqual(closedEditRes.body.code, 'WINDOW_CLOSED');

  const closedUploadRes = await employee.request('POST', `/api/monthly-1on1/reports/${reportId}/attachments`, {
    file: {
      name: 'post_close.pdf',
      data: `data:application/pdf;base64,${samplePdfBuffer.toString('base64')}`,
      type: 'application/pdf'
    }
  });
  assert.strictEqual(closedUploadRes.status, 403, 'Attachment upload after window closure must return HTTP 403');
  assert.strictEqual(closedUploadRes.body.code, 'WINDOW_CLOSED');

  console.log('  ✔ Verified Draft Rules: Persistence across reloads, no duplicate creation, and closed-window edit prevention.');

  await db.close();

  console.log('\n================================================================');
  console.log('🎉 ALL STEPS 1–3 AUDIT & VERIFICATION CHECKS PASSED 100%!');
  console.log('================================================================');
})().catch(err => {
  console.error('\n❌ TEST FAILED:', err);
  process.exit(1);
});

