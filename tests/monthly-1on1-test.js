'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  VALID_1ON1_STATUSES,
  VALID_1ON1_OVERALL_STATUSES,
  VALID_1ON1_CAPACITY,
  VALID_1ON1_SECTIONS,
  isValidUuid,
  normalizeReportingMonth,
  validateSectionItem,
  createMonthly1on1Report,
  getMonthly1on1ReportById,
  saveMonthly1on1Draft,
  submitMonthly1on1Report,
  startMonthly1on1Review,
  requestMonthly1on1Revision,
  finalizeMonthly1on1Report
} = require('../lib/monthly-1on1-db');

console.log('Testing Monthly 1:1 Database Layer...');

// 1. Check constants
assert.deepEqual(VALID_1ON1_SECTIONS, [
  'completed_deliverables',
  'pending_tasks',
  'challenges_support',
  'responsibility_readiness',
  'improvement_suggestions',
  'monthly_priorities'
]);
assert.equal(VALID_1ON1_SECTIONS.length, 6);

// 2. Test month normalization
assert.equal(normalizeReportingMonth('2026-10'), '2026-10-01');
assert.equal(normalizeReportingMonth('2026-05-15'), '2026-05-01');
assert.equal(normalizeReportingMonth('2026-01-01'), '2026-01-01');
assert.throws(() => normalizeReportingMonth(''), { code: 'INVALID_MONTH' });
assert.throws(() => normalizeReportingMonth('invalid-date'), { code: 'INVALID_MONTH_FORMAT' });
assert.throws(() => normalizeReportingMonth('2026-13'), { code: 'MONTH_OUT_OF_RANGE' });

// 3. Test UUID validation
assert.equal(isValidUuid(crypto.randomUUID()), true);
assert.equal(isValidUuid('invalid-uuid'), false);
assert.equal(isValidUuid(''), false);

// 4. Test section item validation
// 4a. completed_deliverables
const cd = validateSectionItem('completed_deliverables', {
  task: 'Build 1on1 Report',
  target_given: '10 days',
  actual_completion: 'Completed on time',
  impact_result: 'High impact on alignment',
  proof_link: 'https://example.com/proof'
});
assert.equal(cd.task, 'Build 1on1 Report');
assert.equal(cd.proof_link, 'https://example.com/proof');

// 4b. pending_tasks
const pt = validateSectionItem('pending_tasks', {
  task: 'Mobile responsive styling',
  reason_for_delay: 'Design pending',
  current_status: 'In progress',
  support_needed: 'Design tokens',
  expected_completion_date: '2026-11-05'
});
assert.equal(pt.task, 'Mobile responsive styling');
assert.equal(pt.expected_completion_date, '2026-11-05');

// 4c. challenges_support
const cs = validateSectionItem('challenges_support', {
  major_challenge: 'Database latency',
  support_required: 'Index optimization'
});
assert.equal(cs.major_challenge, 'Database latency');

// 4d. responsibility_readiness
const rr = validateSectionItem('responsibility_readiness', {
  current_responsibilities: 'Core portal features',
  next_responsibilities: 'Lead full-stack rollout',
  clarity_required: 'API contracts'
});
assert.equal(rr.current_responsibilities, 'Core portal features');

// 4e. improvement_suggestions
const is = validateSectionItem('improvement_suggestions', {
  suggestion: 'Automate weekly digest reports'
});
assert.equal(is.suggestion, 'Automate weekly digest reports');

// 4f. monthly_priorities
const mp = validateSectionItem('monthly_priorities', {
  priority_number: 1,
  description: 'Deliver Project Reinvent 1:1 reports'
});
assert.equal(mp.priority_number, 1);
assert.equal(mp.description, 'Deliver Project Reinvent 1:1 reports');
assert.throws(() => validateSectionItem('monthly_priorities', { priority_number: 5 }), { code: 'INVALID_PRIORITY_NUMBER' });

// 4g. Unsupported section key
assert.throws(() => validateSectionItem('unsupported_section', {}), { code: 'INVALID_SECTION_KEY' });
assert.throws(() => validateSectionItem('completed_deliverables', null), { code: 'INVALID_ITEM_DATA' });

// 5. Mock DB transaction and lifecycle test
(async () => {
  const reportsTable = new Map();
  const itemsTable = new Map();

  const mockDb = {
    sql(s) { return s; },
    async get(sql, params = []) {
      const norm = sql.replace(/\s+/g, ' ');
      if (norm.includes('FROM monthly_1on1_reports WHERE employee_id=? AND reporting_month=?')) {
        for (const r of reportsTable.values()) {
          if (r.employee_id === params[0] && r.reporting_month === params[1]) return r;
        }
        return undefined;
      }
      if (norm.includes('FROM monthly_1on1_reports WHERE id=?')) {
        return reportsTable.get(params[0]) || undefined;
      }
      return undefined;
    },
    async all(sql, params = []) {
      const normalized = sql.replace(/\s+/g, ' ');
      if (normalized.includes('FROM monthly_1on1_items WHERE report_id=?')) {
        const res = [];
        for (const it of itemsTable.values()) {
          if (it.report_id === params[0]) res.push(it);
        }
        return res;
      }
      return [];
    },
    async run(sql, params = []) {
      const norm = sql.replace(/\s+/g, ' ');
      if (norm.includes('INSERT INTO monthly_1on1_reports')) {
        const [id, employee_id, employee_name, reviewer_id, reviewer_name, director_name, department, employee_role, reporting_month, work_location, current_projects, overall_status, capacity_for_additional_responsibilities, additional_responsibility_details, created_at, updated_at] = params;
        reportsTable.set(id, {
          id, employee_id, employee_name, reviewer_id, reviewer_name, director_name, department, employee_role,
          reporting_month, meeting_date: null, work_location, current_projects, overall_status,
          capacity_for_additional_responsibilities, additional_responsibility_details,
          status: 'Draft', submitted_at: '', revision_reason: null, manager_notes_json: null,
          employee_acknowledged_at: '', reviewer_acknowledged_at: '', completed_at: '',
          created_at, updated_at
        });
        return { affectedRows: 1 };
      }
      if (norm.includes("SET status='Submitted'")) {
        const [submitted_at, employee_acknowledged_at, updated_at, id] = params;
        const row = reportsTable.get(id);
        if (row) {
          row.status = 'Submitted';
          row.submitted_at = submitted_at;
          row.employee_acknowledged_at = employee_acknowledged_at;
          row.updated_at = updated_at;
        }
        return { affectedRows: 1 };
      }
      if (norm.includes("SET status='Under Review'")) {
        const [reviewer_id, reviewer_name, updated_at, id] = params;
        const row = reportsTable.get(id);
        if (row) {
          row.status = 'Under Review';
          row.reviewer_id = reviewer_id;
          row.reviewer_name = reviewer_name;
          row.updated_at = updated_at;
        }
        return { affectedRows: 1 };
      }
      if (norm.includes("SET status='Revision Requested'")) {
        const [revision_reason, updated_at, id] = params;
        const row = reportsTable.get(id);
        if (row) {
          row.status = 'Revision Requested';
          row.revision_reason = revision_reason;
          row.updated_at = updated_at;
        }
        return { affectedRows: 1 };
      }
      if (norm.includes("SET status='Completed'")) {
        const [manager_notes_json, reviewer_id, reviewer_name, reviewer_acknowledged_at, completed_at, updated_at, id] = params;
        const row = reportsTable.get(id);
        if (row) {
          row.status = 'Completed';
          row.manager_notes_json = manager_notes_json;
          row.reviewer_id = reviewer_id;
          row.reviewer_name = reviewer_name;
          row.reviewer_acknowledged_at = reviewer_acknowledged_at;
          row.completed_at = completed_at;
          row.updated_at = updated_at;
        }
        return { affectedRows: 1 };
      }
      return { affectedRows: 1 };
    },
    pool: {
      async getConnection() {
        return {
          async beginTransaction() {},
          async commit() {},
          async rollback() {},
          release() {},
          async execute(sql, params) {
            if (sql.includes('UPDATE monthly_1on1_reports')) {
              const [meeting_date, work_location, current_projects, overall_status, capacity_for_additional_responsibilities, additional_responsibility_details, updated_at, id] = params;
              const row = reportsTable.get(id);
              if (row) {
                row.meeting_date = meeting_date;
                row.work_location = work_location;
                row.current_projects = current_projects;
                row.overall_status = overall_status;
                row.capacity_for_additional_responsibilities = capacity_for_additional_responsibilities;
                row.additional_responsibility_details = additional_responsibility_details;
                row.updated_at = updated_at;
              }
            } else if (sql.includes('DELETE FROM monthly_1on1_items')) {
              const [report_id, section_key] = params;
              for (const [k, v] of Array.from(itemsTable.entries())) {
                if (v.report_id === report_id && v.section_key === section_key) itemsTable.delete(k);
              }
            } else if (sql.includes('INSERT INTO monthly_1on1_items')) {
              const [id, report_id, section_key, item_order, item_json, created_at, updated_at] = params;
              itemsTable.set(id, { id, report_id, section_key, item_order, item_json, created_at, updated_at });
            }
          }
        };
      }
    }
  };

  // Test report creation
  const created = await createMonthly1on1Report(mockDb, {
    employeeId: 101,
    employeeName: 'Alice Developer',
    department: 'Digital Team',
    employeeRole: 'Software Engineer',
    reportingMonthInput: '2026-10'
  });
  assert.ok(created.id);
  assert.equal(created.employee_id, 101);
  assert.equal(created.reporting_month, '2026-10-01');
  assert.equal(created.status, 'Draft');

  // Test duplicate prevention
  await assert.rejects(
    async () => {
      await createMonthly1on1Report(mockDb, {
        employeeId: 101,
        employeeName: 'Alice Developer',
        reportingMonthInput: '2026-10-15'
      });
    },
    { code: 'DUPLICATE_REPORT' }
  );

  // Test saving draft with existing item ID retention
  const fixedItemId = crypto.randomUUID();
  const draftSaved = await saveMonthly1on1Draft(mockDb, {
    reportId: created.id,
    headerUpdates: {
      meeting_date: '2026-10-25',
      work_location: 'Office',
      current_projects: '1on1 System',
      overall_status: 'On Track',
      capacity_for_additional_responsibilities: 'Yes',
      additional_responsibility_details: 'Can mentor interns'
    },
    sections: {
      completed_deliverables: [
        { id: fixedItemId, data: { task: 'Feature A', impact_result: 'Done' } },
        { id: null, data: { task: 'Feature B', impact_result: 'Done' } }
      ]
    }
  });

  assert.equal(draftSaved.overall_status, 'On Track');
  assert.equal(draftSaved.items.completed_deliverables.length, 2);
  assert.equal(draftSaved.items.completed_deliverables[0].id, fixedItemId); // Original ID retained!
  assert.notEqual(draftSaved.items.completed_deliverables[1].id, null); // New UUID generated!

  // Test submitting report
  const submitted = await submitMonthly1on1Report(mockDb, {
    reportId: created.id,
    acknowledged: true
  });
  assert.equal(submitted.status, 'Submitted');
  assert.ok(submitted.employee_acknowledged_at);

  // Test start review
  const underReview = await startMonthly1on1Review(mockDb, {
    reportId: created.id,
    reviewerId: 202,
    reviewerName: 'Bob Manager'
  });
  assert.equal(underReview.status, 'Under Review');
  assert.equal(underReview.reviewer_name, 'Bob Manager');

  // Test request revision
  const revision = await requestMonthly1on1Revision(mockDb, {
    reportId: created.id,
    reason: 'Please elaborate on deliverables impact'
  });
  assert.equal(revision.status, 'Revision Requested');
  assert.equal(revision.revision_reason, 'Please elaborate on deliverables impact');

  // Resubmit
  await submitMonthly1on1Report(mockDb, { reportId: created.id, acknowledged: true });
  await startMonthly1on1Review(mockDb, { reportId: created.id, reviewerId: 202, reviewerName: 'Bob Manager' });

  // Test finalize report
  const completed = await finalizeMonthly1on1Report(mockDb, {
    reportId: created.id,
    managerNotes: {
      key_observation: 'Excellent work and responsibility',
      final_responsibility: 'Lead module Q4',
      follow_up_date: '2026-11-20',
      additional_comments: 'Great progress'
    },
    reviewerAcknowledged: true,
    reviewerId: 202,
    reviewerName: 'Bob Manager'
  });
  assert.equal(completed.status, 'Completed');
  assert.equal(completed.manager_notes.key_observation, 'Excellent work and responsibility');
  assert.ok(completed.completed_at);

  console.log('All Monthly 1:1 database layer unit tests passed successfully!');
})().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
