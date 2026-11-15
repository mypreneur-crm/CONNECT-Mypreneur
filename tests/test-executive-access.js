'use strict';

const assert = require('node:assert');
const crypto = require('node:crypto');
const monthly1on1Db = require('../lib/monthly-1on1-db');

async function testExecutiveAccess() {
  console.log('=== TEST EXECUTIVE ACCESS (CEO & DIRECTOR EXCLUSIVITY) ===\n');

  // Test 1: Helper unit verification
  console.log('1. Testing isExecutiveLeadership unit checks...');
  
  const ceoUser = { id: 101, username: 'suresh', name: 'Suresh R', title: 'CEO', role: 'member' };
  const mdUser = { id: 102, username: 'suresh_md', name: 'Suresh R', title: 'Managing Director', role: 'member' };
  const dirUser = { id: 103, username: 'manoj', name: 'Manoj', title: 'Director', role: 'member' };
  const superAdmin = { id: 5, username: 'admin', name: 'System Admin', title: 'Administrator', role: 'admin', isSuperAdmin: true };
  const serviceAdmin = { id: 15, username: 'kaviya', name: 'Kaviya', title: 'HR', role: 'service_admin', isServiceAdmin: true };
  const regularEmployee = { id: 13, username: 'kaviyak', name: 'Kaviya Karikalan', title: 'Support Executive', role: 'member' };

  assert.strictEqual(monthly1on1Db.isExecutiveLeadership(ceoUser), true, 'CEO must be recognized as executive');
  assert.strictEqual(monthly1on1Db.isExecutiveLeadership(mdUser), true, 'Managing Director must be recognized as executive');
  assert.strictEqual(monthly1on1Db.isExecutiveLeadership(dirUser), true, 'Director must be recognized as executive');
  
  assert.strictEqual(monthly1on1Db.isExecutiveLeadership(superAdmin), false, 'Super Admin (Administrator) must NOT be executive');
  assert.strictEqual(monthly1on1Db.isExecutiveLeadership(serviceAdmin), false, 'Service Admin must NOT be executive');
  assert.strictEqual(monthly1on1Db.isExecutiveLeadership(regularEmployee), false, 'Regular Employee must NOT be executive');
  console.log('   ✔ isExecutiveLeadership correctly identifies only CEO, Director, and Managing Director.');

  // Test 2: Monthly Connect permissions
  console.log('\n2. Testing Monthly Connect review permissions...');
  assert.strictEqual(monthly1on1Db.canReviewAll1on1Reports(ceoUser), true, 'CEO can review all reports');
  assert.strictEqual(monthly1on1Db.canReviewAll1on1Reports(dirUser), true, 'Director can review all reports');
  assert.strictEqual(monthly1on1Db.canReviewAll1on1Reports(superAdmin), false, 'Super Admin CANNOT review all reports');
  assert.strictEqual(monthly1on1Db.canReviewAll1on1Reports(serviceAdmin), false, 'Service Admin CANNOT review all reports');
  assert.strictEqual(monthly1on1Db.canReviewAll1on1Reports(regularEmployee), false, 'Regular Employee CANNOT review all reports');
  console.log('   ✔ canReviewAll1on1Reports strictly blocks Super Admin, Service Admin, and Regular Employees.');

  // Test 3: Report view access guard
  console.log('\n3. Testing individual report access guard...');
  const employeeReport = { id: 'rep-001', employee_id: 13, status: 'Submitted' };
  
  // Owner can view own report
  assert.strictEqual(monthly1on1Db.canUserAccessReport(regularEmployee, employeeReport, 'view'), true, 'Owner can view own report');
  // CEO and Director can view any employee report
  assert.strictEqual(monthly1on1Db.canUserAccessReport(ceoUser, employeeReport, 'view'), true, 'CEO can view employee report');
  assert.strictEqual(monthly1on1Db.canUserAccessReport(dirUser, employeeReport, 'view'), true, 'Director can view employee report');
  // Super Admin & Service Admin CANNOT view employee report
  assert.strictEqual(monthly1on1Db.canUserAccessReport(superAdmin, employeeReport, 'view'), false, 'Super Admin CANNOT view other employee report');
  assert.strictEqual(monthly1on1Db.canUserAccessReport(serviceAdmin, employeeReport, 'view'), false, 'Service Admin CANNOT view other employee report');
  console.log('   ✔ canUserAccessReport allows CEO/Director & owner, and strictly denies Super Admin / Service Admin.');

  console.log('\n=== ALL EXECUTIVE ACCESS CHECKS PASSED (100%) ===\n');
}

testExecutiveAccess().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});

