'use strict';

const assert = require('node:assert');
const monthly1on1Db = require('../lib/monthly-1on1-db');
const { MySQLDatabase, databaseConfig } = require('../lib/database');

async function testAutomaticWindow() {
  console.log('=== TESTING AUTOMATIC MONTHLY CONNECT WINDOW SCHEDULE ===\n');

  // Test 1: Schedule Calculation Verification
  console.log('1. Verifying automatic calculation of 1 month full + 5 days next month...');
  const novAuto = monthly1on1Db.calculateAutomaticMonthWindow('2026-11');
  console.log('   November Window Start (IST):', novAuto.start_ist);
  console.log('   November Window End   (IST):', novAuto.end_ist);

  assert.strictEqual(novAuto.start_ist, '01 Nov 2026, 12:00 am IST', 'November must start on 01 Nov 12:00 am IST');
  assert.strictEqual(novAuto.end_ist, '05 Dec 2026, 11:59 pm IST', 'November must close on 05 Dec 11:59 pm IST');

  const decAuto = monthly1on1Db.calculateAutomaticMonthWindow('2026-12');
  console.log('   December Window Start (IST):', decAuto.start_ist);
  console.log('   December Window End   (IST):', decAuto.end_ist);
  assert.strictEqual(decAuto.start_ist, '01 Dec 2026, 12:00 am IST', 'December must start on 01 Dec 12:00 am IST');
  assert.strictEqual(decAuto.end_ist, '05 Jan 2027, 11:59 pm IST', 'December must close on 05 Jan 11:59 pm IST');
  console.log('   ✔ 1 month full + next month until date 5 calculation verified with 100% precision.');

  // Test 2: Automatic Lifecycle Evaluation across simulated dates
  console.log('\n2. Testing lifecycle states across simulated dates...');
  const db = new MySQLDatabase(databaseConfig());
  await db.ready;

  try {
    // 2a. On November 15, 2026 (mid-month): November is OPEN, October is CLOSED, December is UPCOMING
    monthly1on1Db.setSimulatedClock('2026-11-15T10:00:00+05:30');
    const novOnNov15 = await monthly1on1Db.getWindowForMonth(db, '2026-11-01');
    const octOnNov15 = await monthly1on1Db.getWindowForMonth(db, '2026-10-01');
    const decOnNov15 = await monthly1on1Db.getWindowForMonth(db, '2026-12-01');

    console.log(`   Simulated Date: 15 Nov 2026 -> Oct: ${octOnNov15.status}, Nov: ${novOnNov15.status}, Dec: ${decOnNov15.status}`);
    assert.strictEqual(novOnNov15.status, 'open', 'November must be OPEN on Nov 15');
    assert.strictEqual(octOnNov15.status, 'closed', 'October must be CLOSED on Nov 15 (past Nov 5)');
    assert.strictEqual(decOnNov15.status, 'upcoming', 'December must be UPCOMING on Nov 15 (before Dec 1)');

    // 2b. On December 3, 2026 (within the 1st to 5th day grace period): November is STILL OPEN!
    monthly1on1Db.setSimulatedClock('2026-12-03T14:30:00+05:30');
    const novOnDec3 = await monthly1on1Db.getWindowForMonth(db, '2026-11-01');
    console.log(`   Simulated Date: 03 Dec 2026 -> Nov: ${novOnDec3.status} (End: ${novOnDec3.end_ist})`);
    assert.strictEqual(novOnDec3.status, 'open', 'November must still be OPEN on Dec 3 (within Dec 1-5 window)');

    // 2c. On December 5, 2026 at 11:50 PM IST (10 mins before deadline): Still open!
    monthly1on1Db.setSimulatedClock('2026-12-05T23:50:00+05:30');
    const novOnDec5Night = await monthly1on1Db.getWindowForMonth(db, '2026-11-01');
    console.log(`   Simulated Date: 05 Dec 2026, 11:50 PM IST -> Nov: ${novOnDec5Night.status}`);
    assert.strictEqual(novOnDec5Night.status, 'open', 'November must still be OPEN on Dec 5 at 11:50 PM');

    // 2d. On December 6, 2026 at 00:01 AM IST (after 5th day): AUTOMATICALLY CLOSED!
    monthly1on1Db.setSimulatedClock('2026-12-06T00:01:00+05:30');
    const novOnDec6 = await monthly1on1Db.getWindowForMonth(db, '2026-11-01');
    console.log(`   Simulated Date: 06 Dec 2026, 00:01 AM IST -> Nov: ${novOnDec6.status}`);
    assert.strictEqual(novOnDec6.status, 'closed', 'November must be AUTOMATICALLY CLOSED starting Dec 6');

    // Test 3: Lockout enforcement — Employees cannot apply or edit once closed!
    console.log('\n3. Testing employee lockout on closed months...');
    const employeeUser = { id: 13, name: 'kaviya Karikalan', title: 'Support Executive', role: 'member' };

    // Attempting to create an application for November on Dec 6 should be rejected!
    let creationBlocked = false;
    try {
      await monthly1on1Db.createMonthly1on1Report(db, {
        employeeId: employeeUser.id,
        employeeName: employeeUser.name,
        reportingMonthInput: '2026-11-01',
        auditUser: employeeUser,
        skipWindowCheck: false
      });
    } catch (err) {
      creationBlocked = true;
      console.log('   Creation attempt on closed window correctly blocked with message:', err.message);
      assert.strictEqual(err.code, 'WINDOW_NOT_OPEN');
    }
    assert.strictEqual(creationBlocked, true, 'Creating report on closed month must be rejected');

    console.log('\n=== ALL AUTOMATIC WINDOW TESTS PASSED (100% SUCCESS) ===\n');
  } finally {
    // Reset simulated clock
    monthly1on1Db.setSimulatedClock(null);
    await db.close();
  }
}

testAutomaticWindow().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});

